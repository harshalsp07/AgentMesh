// contracts.mjs — Phase-3: registry, diff classify, ghost clients, deletion gate, x-lane verify.
// Adapters are regex-based (deterministic); a model may propose a rule once, human approves.
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { shortHash, atomicWrite, loadJson, saveJson } from './store.mjs';

const regFile = (root) => join(root, 'contracts.json');
export function loadRegistry(root) { return loadJson(regFile(root), { nodes: {} }); }
function saveRegistry(root, r) { saveJson(regFile(root), r); }

// extract contracts from a lane dir: routes, zod, prisma, env, exported types
export function extractContracts(laneDir) {
  const found = {};
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      if (['node_modules', '.git', '.mesh'].includes(e)) continue;
      const f = join(d, e);
      if (statSync(f).isDirectory()) { walk(f); continue; }
      if (!/\.(m?js|ts|tsx|py|prisma|env)$/.test(e)) continue;
      let src = ''; try { src = readFileSync(f, 'utf8'); } catch { continue; }
      const rel = relative(laneDir, f);
      for (const m of src.matchAll(/(?:app|router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)) {
        const id = `api:${m[1].toUpperCase()} ${m[2]}`;
        (found[id] ||= { id, type: 'http', files: [] }).files.push(rel);
        found[id].shape = found[id].shape || m[0].slice(0, 120);
      }
      for (const m of src.matchAll(/export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/g)) {
        const id = `schema:${m[1]}`;
        (found[id] ||= { id, type: 'schema', files: [] }).files.push(rel);
      }
      if (/model\s+\w+\s*\{/.test(src) && f.endsWith('.prisma'))
        for (const m of src.matchAll(/model\s+(\w+)\s*\{/g)) {
          const id = `db:${m[1]}`;
          (found[id] ||= { id, type: 'db', files: [] }).files.push(rel);
        }
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        const id = `env:${m[1]}`;
        (found[id] ||= { id, type: 'env', files: [] }).files.push(rel);
      }
    }
  };
  walk(laneDir);
  for (const n of Object.values(found)) n.version = shortHash(JSON.stringify([n.id, n.files, n.shape || '']));
  return found;
}

export function syncRegistry(root, laneDir, owner = 'system') {
  const reg = loadRegistry(root);
  const found = extractContracts(laneDir);
  for (const [id, c] of Object.entries(found)) {
    const prev = reg.nodes[id];
    reg.nodes[id] = {
      id, type: c.type, owner: prev?.owner || owner, version: c.version,
      status: prev?.status || 'stable', consumers: prev?.consumers || [], files: c.files,
    };
  }
  saveRegistry(root, reg);
  return { nodes: Object.keys(found).length };
}

// classify proposed vs stable: breaking | additive | internal
export function classifyDiff(oldShape, newShape) {
  const o = JSON.stringify(oldShape || {}), n = JSON.stringify(newShape || {});
  if (o === n) return 'internal';
  const removed = String(o).length > String(n).length && !String(n).includes(String(oldShape?.path || ' unlikely '));
  // heuristic: removed keys / renamed path / dropped required field => breaking
  if (/DELETE|DROP|remove|rename/i.test(n + o) || removed) return 'breaking';
  if (String(n).length >= String(o).length) return 'additive';
  return 'breaking';
}

export function proposeContract(root, { id, owner, lane, intent, diff, shape }) {
  const reg = loadRegistry(root);
  const prev = reg.nodes[id] || { id, type: 'http', owner, version: shortHash(id), status: 'stable', consumers: [] };
  reg.nodes[id] = { ...prev, status: 'proposed', proposed_by: { intent, lane, diff, shape } };
  saveRegistry(root, reg);
  // notify consumers: mark them; hub inbox wiring happens in mesh CLI via /cmd presence
  return { ok: true, id, diff };
}
export function landContract(root, id) {
  const reg = loadRegistry(root);
  const n = reg.nodes[id];
  if (!n) return { ok: false, error: 'unknown contract' };
  n.status = 'stable';
  if (n.proposed_by?.shape) n.version = shortHash(JSON.stringify(n.proposed_by.shape));
  delete n.proposed_by;
  saveRegistry(root, reg);
  return { ok: true, id };
}
// deletion gate: block breaking removal while consumers still reference it
export function deletionGate(root, id, liveRefs = [], runtimeSeenMin = 0) {
  const reg = loadRegistry(root);
  const n = reg.nodes[id];
  if (!n) return { blocked: false };
  const consumers = [...(n.consumers || []).map((c) => c.ref), ...liveRefs];
  if (consumers.length > 0) return { blocked: true, reason: `deletion blocked: ${consumers.length} consumer(s) still reference ${id}`, consumers };
  if (runtimeSeenMin > 0) return { blocked: true, reason: `deletion blocked: runtime traffic to ${id} seen in last ${runtimeSeenMin}m` };
  return { blocked: false };
}
// ghost client: typed stub + mocks for the proposed version, clearly marked
export function ghostContract(root, id) {
  const reg = loadRegistry(root);
  const n = reg.nodes[id];
  if (!n?.proposed_by) return { ok: false, error: 'no proposed version' };
  const dir = join(root, 'ghost');
  mkdirSync(dir, { recursive: true });
  const safe = id.replace(/[^A-Za-z0-9]+/g, '_');
  const body = `// GHOST — proposed ${id} (${n.proposed_by.diff}). DO NOT IMPORT IN PROD.\n// Generated by AgentMesh; replaced by the real client on land.\n// intent ${n.proposed_by.intent} lane ${n.proposed_by.lane}\nexport const __ghost = ${JSON.stringify(id)};\nexport async function callGhost(...args) { return { __ghost: true, id: ${JSON.stringify(id)}, args }; }\n`;
  writeFileSync(join(dir, `${safe}.ts`), body);
  return { ok: true, file: join(dir, `${safe}.ts`) };
}
// speculative cross-lane verify: ephemeral overlay check, advisory in-lane / blocking at integration
export function crossLaneVerify(root, producerLaneDir, consumerLaneDir, { budgetMs = 30000 } = {}) {
  const t0 = Date.now();
  const prod = extractContracts(producerLaneDir);
  const cons = extractContracts(consumerLaneDir);
  const findings = [];
  // consumer references a contract the producer changed/removed?
  const srcFiles = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (statSync(f).isDirectory()) { if (!['node_modules', '.git'].includes(e)) walk(f); continue; }
      if (/\.(m?js|tsx?)$/.test(e)) { try { srcFiles.push({ f, src: readFileSync(f, 'utf8') }); } catch {} }
    }
  };
  walk(consumerLaneDir);
  for (const pid of Object.keys(prod)) {
    const path = pid.replace(/^api:\w+\s+/, '');
    for (const { f, src } of srcFiles) {
      if (path !== '/' && src.includes(path)) findings.push({ file: relative(consumerLaneDir, f), message: `references ${pid} which has a proposed change`, action: 'check ghost client or migrate' });
    }
  }
  void budgetMs;
  return { ok: findings.length === 0, findings: findings.slice(0, 20), ms: Date.now() - t0, advisory: true };
}
export function addConsumer(root, id, ref, source = 'static') {
  const reg = loadRegistry(root);
  const n = reg.nodes[id] || { id, type: 'http', owner: 'unknown', version: shortHash(id), status: 'stable', consumers: [] };
  if (!n.consumers.some((c) => c.ref === ref)) n.consumers.push({ ref, source });
  reg.nodes[id] = n; saveRegistry(root, reg);
  return { ok: true };
}
