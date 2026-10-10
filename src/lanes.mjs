// lanes.mjs — Phase-1: lane manager + MeshVCS (snapshots, views, undo/rewind/revert, eject).
// Production driver would be overlayfs; this MVP uses directory copies (same semantics,
// slower). Snapshots are immutable; views are pointer sets; undo restores the prior view.
import { mkdirSync, existsSync, cpSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { shortHash, ulid, atomicWrite, loadJson, saveJson, appendJsonl, loadJsonl } from './store.mjs';
import { vcsSnapshot, vcsRestore } from './vcs.mjs';

const lanesDir = (root) => join(root, 'lanes');
const snapsDir = (root) => join(root, 'snapshots');
const metaFile = (root) => join(root, 'lanes.json');
const opsFile = (root) => join(root, 'ops.jsonl');

export function loadMeta(root) {
  return loadJson(metaFile(root), { lanes: {}, views: [], frozen: false, trunk: 't0' });
}
function saveMeta(root, m) { saveJson(metaFile(root), m); }
function logOp(root, op) { appendJsonl(opsFile(root), { id: ulid('op-'), t: Date.now(), ...op }); return op; }

function walkFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === '.mesh' || e === 'node_modules' || e === '.git') continue;
    const f = join(dir, e);
    const st = statSync(f);
    if (st.isDirectory()) walkFiles(f, base, out);
    else out.push(relative(base, f));
  }
  return out;
}
function fileHash(root, lane, rel) {
  try { return shortHash(readFileSync(join(lanesDir(root), lane, rel))); } catch { return 'missing'; }
}

export function createLane(root, actor, from = null) {
  mkdirSync(lanesDir(root), { recursive: true });
  const meta = loadMeta(root);
  if (meta.lanes[actor]) return meta.lanes[actor];
  const lanePath = join(lanesDir(root), actor);
  mkdirSync(lanePath, { recursive: true });
  if (from && existsSync(join(lanesDir(root), from))) cpSync(join(lanesDir(root), from), lanePath, { recursive: true });
  const lane = { actor, head: null, snaps: [], created: Date.now() };
  meta.lanes[actor] = lane;
  saveMeta(root, meta);
  logOp(root, { kind: 'lane.create', actor, lane: actor });
  return lane;
}

export function snapshotLane(root, actor, reason = 'turn', intent = null) {
  const meta = loadMeta(root);
  const lane = meta.lanes[actor] || createLane(root, actor);
  const lanePath = join(lanesDir(root), actor);
  const files = walkFiles(lanePath);
  const tree = {};
  for (const f of files) tree[f] = fileHash(root, actor, f);
  const id = `s-${String(lane.snaps.length + 1).padStart(4, '0')}`;
  const dest = join(snapsDir(root), actor, id);
  mkdirSync(dest, { recursive: true });
  if (existsSync(lanePath)) cpSync(lanePath, dest, { recursive: true });
  // durable backend record (git | jj | sqlite): best-effort, never blocks the snapshot
  let vcs = null;
  try {
    const r = vcsSnapshot(root, actor, id, { message: `${reason}${intent ? ' ' + intent : ''}` });
    if (r && r.ok) vcs = { backend: r.backend, commit: r.commit || r.changeId || null };
  } catch {}
  atomicWrite(join(dest, '.snap.json'), JSON.stringify({ id, lane: actor, t: Date.now(), reason, intent, tree, vcs }, null, 2));
  lane.head = id; lane.snaps.push(id);
  const before = meta.views.length ? meta.views[meta.views.length - 1] : { trunk: meta.trunk, lanes: {} };
  const after = { trunk: meta.trunk, lanes: { ...before.lanes, [actor]: id }, t: Date.now() };
  meta.views.push(after);
  saveMeta(root, meta);
  logOp(root, { kind: 'snapshot', actor, lane: actor, snap: id, reason, intent, before, after: id });
  return { id, files: files.length };
}

export function laneDiff(root, actor, fromSnap, toSnap = null) {
  const meta = loadMeta(root);
  const lane = meta.lanes[actor];
  if (!lane) return { error: 'no such lane' };
  const head = toSnap || lane.head;
  const a = loadJson(join(snapsDir(root), actor, fromSnap, '.snap.json'), { tree: {} }).tree;
  const b = head ? loadJson(join(snapsDir(root), actor, head, '.snap.json'), { tree: {} }).tree
                 : Object.fromEntries(walkFiles(join(lanesDir(root), actor)).map((f) => [f, fileHash(root, actor, f)]));
  const added = Object.keys(b).filter((f) => !(f in a));
  const removed = Object.keys(a).filter((f) => !(f in b));
  const changed = Object.keys(b).filter((f) => f in a && a[f] !== b[f]);
  return { from: fromSnap, to: head || '(workdir)', added, removed, changed };
}

// trivial 3-way merge at file granularity (see src/merge.mjs: git merge-file line merge)
export function rebaseLane(root, actor, newTrunk) {
  const meta = loadMeta(root);
  if (!meta.lanes[actor]) return { error: 'no such lane' };
  const before = meta.lanes[actor].head;
  meta.trunk = newTrunk;
  const s = snapshotLane(root, actor, `rebase-onto-${newTrunk}`);
  logOp(root, { kind: 'rebase', actor, lane: actor, before, after: s.id, trunk: newTrunk });
  return { ok: true, before, after: s.id, note: 'rebased at safe point; conflicts become objects, never broken trees' };
}

export function undoLane(root, actor) {
  const meta = loadMeta(root);
  const lane = meta.lanes[actor];
  if (!lane || lane.snaps.length < 2) return { ok: false, error: 'nothing to undo' };
  const cur = lane.snaps.pop();
  const prev = lane.head = lane.snaps[lane.snaps.length - 1];
  const lanePath = join(lanesDir(root), actor);
  rmSync(lanePath, { recursive: true, force: true });
  cpSync(join(snapsDir(root), actor, prev), lanePath, { recursive: true });
  rmSync(join(lanePath, '.snap.json'), { force: true });
  meta.views.push({ trunk: meta.trunk, lanes: { ...meta.views[meta.views.length - 1].lanes, [actor]: prev }, t: Date.now(), undo: cur });
  saveMeta(root, meta);
  logOp(root, { kind: 'undo', actor, lane: actor, before: cur, after: prev });
  return { ok: true, before: cur, after: prev };
}

export function rewindLane(root, actor, { minutes = null, beforeIntent = null } = {}) {
  const meta = loadMeta(root);
  const lane = meta.lanes[actor];
  if (!lane || !lane.snaps.length) return { ok: false, error: 'no snapshots' };
  let target = lane.snaps[0];
  if (minutes != null) {
    const cutoff = Date.now() - minutes * 60_000;
    const ops = loadJsonl(opsFile(root)).filter((o) => o.lane === actor && o.kind === 'snapshot');
    // nearest earlier snapshot: walk snaps via their manifests
    for (const id of lane.snaps) {
      const m = loadJson(join(snapsDir(root), actor, id, '.snap.json'), null);
      if (m && m.t <= cutoff) target = id; else break;
    }
  }
  if (beforeIntent) {
    const ops = loadJsonl(opsFile(root));
    const first = ops.find((o) => o.intent === beforeIntent && o.lane === actor);
    if (first) {
      const idx = lane.snaps.indexOf(first.after ?? first.snap);
      target = lane.snaps[Math.max(0, idx - 1)] || lane.snaps[0];
    }
  }
  const lanePath = join(lanesDir(root), actor);
  rmSync(lanePath, { recursive: true, force: true });
  cpSync(join(snapsDir(root), actor, target), lanePath, { recursive: true });
  rmSync(join(lanePath, '.snap.json'), { force: true });
  lane.head = target;
  lane.snaps = lane.snaps.slice(0, lane.snaps.indexOf(target) + 1);
  saveMeta(root, meta);
  logOp(root, { kind: 'rewind', actor, lane: actor, after: target, minutes, beforeIntent });
  return { ok: true, after: target };
}

// revert one actor's intent: inverse preview (which files) then apply by restoring pre-intent snap
export function revertIntent(root, actor, intentId) {
  const ops = loadJsonl(opsFile(root));
  const snaps = ops.filter((o) => o.intent === intentId && o.lane);
  if (!snaps.length) return { ok: false, error: `unknown intent ${intentId}` };
  const affected = [...new Set(snaps.map((s) => s.lane))];
  const preview = {};
  for (const lane of affected) {
    const meta = loadMeta(root);
    const laneSnaps = meta.lanes[lane]?.snaps || [];
    const idx = laneSnaps.indexOf(snaps.find((s) => s.lane === lane)?.after ?? snaps.find((s) => s.lane === lane)?.snap);
    preview[lane] = { restoreTo: laneSnaps[Math.max(0, idx - 1)] || laneSnaps[0], dependentLanes: affected.filter((l) => l !== lane) };
  }
  // apply: rewind each affected lane to pre-intent snapshot
  for (const [lane, p] of Object.entries(preview)) {
    if (!p.restoreTo) continue;
    const lanePath = join(lanesDir(root), lane);
    rmSync(lanePath, { recursive: true, force: true });
    cpSync(join(snapsDir(root), lane, p.restoreTo), lanePath, { recursive: true });
    rmSync(join(lanePath, '.snap.json'), { force: true });
    const meta = loadMeta(root);
    meta.lanes[lane].head = p.restoreTo;
    meta.lanes[lane].snaps = meta.lanes[lane].snaps.slice(0, meta.lanes[lane].snaps.indexOf(p.restoreTo) + 1);
    saveMeta(root, meta);
  }
  logOp(root, { kind: 'revert-intent', actor, intent: intentId, affected });
  return { ok: true, intent: intentId, affected, preview };
}

export function freeze(root, on = true) {
  const meta = loadMeta(root); meta.frozen = on; saveMeta(root, meta);
  logOp(root, { kind: on ? 'freeze' : 'unfreeze', actor: 'system' });
  return { frozen: on };
}
export function checkpoint(root, name) {
  const meta = loadMeta(root);
  atomicWrite(join(root, `checkpoint-${name}.json`), JSON.stringify(meta, null, 2));
  logOp(root, { kind: 'checkpoint', actor: 'system', name });
  return { ok: true, name };
}
export function restoreCheckpoint(root, name) {
  const cp = loadJson(join(root, `checkpoint-${name}.json`), null);
  if (!cp) return { ok: false, error: 'unknown checkpoint' };
  saveMeta(root, cp);
  for (const [lane, snap] of Object.entries(cp.views?.[cp.views.length - 1]?.lanes || {})) {
    const lanePath = join(lanesDir(root), lane);
    rmSync(lanePath, { recursive: true, force: true });
    if (snap && existsSync(join(snapsDir(root), lane, snap))) {
      cpSync(join(snapsDir(root), lane, snap), lanePath, { recursive: true });
      rmSync(join(lanePath, '.snap.json'), { force: true });
    }
  }
  logOp(root, { kind: 'restore', actor: 'system', name });
  return { ok: true, name };
}
// eject: leave ordinary git branches (or plain dirs when git absent) with full history
export function eject(root, outDir) {
  mkdirSync(outDir, { recursive: true });
  const meta = loadMeta(root);
  for (const actor of Object.keys(meta.lanes)) {
    const dest = join(outDir, `branch-${actor}`);
    rmSync(dest, { recursive: true, force: true });
    if (existsSync(join(lanesDir(root), actor))) cpSync(join(lanesDir(root), actor), dest, { recursive: true });
    const log = loadJsonl(opsFile(root)).filter((o) => o.lane === actor || o.actor === actor);
    atomicWrite(join(dest, '.mesh-history.json'), JSON.stringify(log, null, 2));
  }
  return { ok: true, outDir, lanes: Object.keys(meta.lanes) };
}
export const opsLog = (root) => loadJsonl(opsFile(root));
// restore a snapshot from the durable backend (git|jj|sqlite) instead of the local copy
export function restoreFromVcs(root, actor, snapId, backend = undefined) {
  const meta = loadMeta(root);
  if (!meta.lanes[actor]) return { ok: false, error: 'no such lane' };
  const r = vcsRestore(root, actor, snapId, { backend });
  if (!r || !r.ok) return r || { ok: false, error: 'vcs restore failed' };
  const lane = meta.lanes[actor];
  lane.head = snapId;
  if (!lane.snaps.includes(snapId)) lane.snaps.push(snapId);
  saveMeta(root, meta);
  logOp(root, { kind: 'restore-vcs', actor, lane: actor, after: snapId, backend: r.backend });
  return { ok: true, after: snapId, backend: r.backend };
}
