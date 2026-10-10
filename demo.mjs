// demo.mjs — the /api/auth drift scenario end-to-end through real MCP stdio bridges.
// Asserts: (1) breaking change reaches consumer as tier-1 on next tool call,
// (2) lease overlap warns the wanderer, (3) hash chain verifies, (4) context file exists.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.MESH_PORT || '7790';
const HUB = `http://localhost:${PORT}`;
const env = { ...process.env, MESH_PORT: PORT, MESH_HUB: HUB, MESH_DIR: '.mesh-demo' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) { console.error(`ASSERT FAIL: ${msg}`); process.exitCode = 1; throw new Error(msg); } };

rmSync('.mesh-demo', { recursive: true, force: true });

const hub = spawn('node', [join(here, 'src/hub.mjs')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
const ready = Date.now();
while (Date.now() - ready < 8000) {
  try { const r = await fetch(`${HUB}/health`); if (r.ok) break; } catch {}
  await sleep(200);
}

function agent(name) {
  const p = spawn('node', [join(here, 'src/bridge.mjs')], { env: { ...env, MESH_ACTOR: name }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let n = 0;
  createInterface({ input: p.stdout }).on('line', (l) => { try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch {} });
  const rpc = (method, params) => new Promise((r) => { const id = ++n; pending.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name2, args = {}) => (await rpc('tools/call', { name: name2, arguments: args })).result.content[0].text;
  return { rpc, tool, stop: () => p.kill() };
}

try {
  const ui = agent('ui-agent'), be = agent('backend-agent'), db = agent('db-agent');

  console.log('initialize ->', (await ui.rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo);
  console.log('tools      ->', (await ui.rpc('tools/list')).result.tools.map((t) => t.name).join(', '));

  console.log('\n[1] ui-agent declares intent (uses the old endpoint)');
  const r1 = await ui.tool('mesh_declare_intent', { goal: 'Build login screen', paths: ['src/ui/auth/**'], uses: ['api:POST /api/auth'] });
  console.log(r1);
  assert(r1.includes('"ok":true'), 'ui intent should be accepted');

  console.log('\n[2] backend-agent declares a BREAKING change to that endpoint');
  const r2 = await be.tool('mesh_declare_intent', { goal: 'Move auth to /api/v2/auth', paths: ['src/api/auth/**'], contracts: ['api:POST /api/auth'], effect: 'breaking' });
  console.log(r2);
  assert(r2.includes('"ok":true'), 'backend intent should be accepted');

  console.log('\n[3] ui-agent calls its next tool and receives the delta (push emulated by piggyback)');
  const r3 = await ui.tool('mesh_status');
  console.log(r3);
  assert(r3.includes('BREAKING') && r3.includes('api:POST /api/auth'), 'ui-agent must get tier-1 BREAKING delta');
  console.log('✓ drift detected on next tool call');

  console.log('\n[4] db-agent starts editing inside backend-agent lease -> overlap warning');
  const r4 = await db.tool('mesh_declare_intent', { goal: 'Add token table', paths: ['src/api/auth/token.ts'] });
  console.log(r4);
  assert(r4.includes('OVERLAP'), 'db-agent must get OVERLAP warning');
  console.log('✓ overlap forecast works');

  console.log('\n[5] hard-lease boundary block');
  const r5 = await be.tool('mesh_declare_intent', { goal: 'Hold lockfile', paths: ['pnpm-lock.yaml'], hard: true });
  assert(r5.includes('"ok":true'), 'hard lease setup');
  // drain backend inbox so next assertion is clean
  await be.tool('mesh_inbox');
  const wanderer = agent('wanderer');
  const r6 = await wanderer.tool('mesh_declare_intent', { goal: 'Bump dep', paths: ['pnpm-lock.yaml'] });
  console.log(r6);
  assert(r6.includes('blocked by hard lease'), 'hard-leased write must be refused at boundary');
  console.log('✓ hard lease enforced (tier-0 block)');
  wanderer.stop();

  console.log('\n[6] integrity check of the hash-chained log');
  const v = await (await fetch(`${HUB}/verify`)).json();
  console.log(v);
  assert(v.ok === true && v.events >= 5, 'hash chain must verify');

  console.log('\n[7] .mesh-demo/context/ui-agent.md on disk (what Cursor/Codex read via rules file)');
  const ctx = readFileSync('.mesh-demo/context/ui-agent.md', 'utf8');
  console.log(ctx);
  assert(ctx.includes('PROPOSED CHANGE'), 'context file must carry proposed contract');

  console.log('\nALL ASSERTIONS PASSED');
  [ui, be, db].forEach((a) => a.stop());
} finally {
  hub.kill();
  await sleep(300);
}
