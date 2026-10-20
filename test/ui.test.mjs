// test/ui.test.mjs — every UI reads the same /api/overview; agent tools are real now.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { killChild, rmSafe, claimPort } from './cleanup.mjs';
import { createRequire } from 'node:module';

const PORT = '7782';
const HUB = `http://localhost:${PORT}`;
const DIR = '.mesh-test-ui';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;
const post = (path, body) => fetch(`${HUB}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

before(async () => {
  await claimPort('7782');
  rmSync(DIR, { recursive: true, force: true });
  hub = spawn('node', ['src/hub.mjs'], { env: { ...process.env, MESH_PORT: PORT, MESH_DIR: DIR }, stdio: ['ignore', 'ignore', 'inherit'] });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try { const r = await fetch(`${HUB}/health`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('hub did not start');
});
after(async () => { killChild(hub); await rmSafe(DIR); });

describe('hub UI api', () => {
  it('overview has every panel in one poll; events capped', async () => {
    const ov = await (await fetch(`${HUB}/api/overview`)).json();
    for (const k of ['trunk', 'queue', 'contracts', 'lanes', 'roster', 'requests', 'pins', 'decisions', 'collisions', 'intents', 'presence']) assert.ok(k in ov, `missing ${k}`);
    const ev = await (await fetch(`${HUB}/api/events?limit=5`)).json();
    assert.ok(ev.events.length <= 5);
    const ev2 = await (await fetch(`${HUB}/api/events?limit=99999`)).json();
    assert.ok(ev2.events.length <= 500);
  });
  it('request -> approval inbox -> accept; pin + decision recorded; validation 400s', async () => {
    const r = await post('/api/request', { actor: 'leo', to: 'be-agent', text: 'expose createdAt' });
    assert.equal(r.status, 'queued');
    const inbox = await (await fetch(`${HUB}/api/approvals?owner=be-agent`)).json();
    assert.ok(inbox.inbox.some((x) => x.id === r.id));
    const acc = await post('/api/request-respond', { actor: 'be-agent', id: r.id, accept: true });
    assert.equal(acc.status, 'working');
    assert.ok(acc.childIntent);
    const pin = await post('/api/pin', { actor: 'leo', node: 'src/api/posts.ts', text: 'race?' });
    assert.ok(pin.id);
    const dec = await post('/api/decision', { actor: 'referee', topic: 't', decision: 'd' });
    assert.ok(dec.id);
    const bad = await post('/api/request', { actor: 'x' });
    assert.equal(bad.ok, false);
    const ov = await (await fetch(`${HUB}/api/overview`)).json();
    assert.ok(ov.requests.length >= 1 && ov.pins.length >= 1 && ov.decisions.length >= 1);
  });
  it('collisions appear in overview when intents overlap', async () => {
    await post('/cmd', { actor: 'a1', kind: 'intent.declare', payload: { goal: 'g1', paths: ['src/api/auth/**'] } });
    await post('/cmd', { actor: 'a2', kind: 'intent.declare', payload: { goal: 'g2', paths: ['src/api/auth/token.ts'] } });
    const ov = await (await fetch(`${HUB}/api/overview`)).json();
    assert.ok(ov.collisions.some((c) => c.grade === 'overlapping'));
  });
});

describe('clients', () => {
  it('bridge exposes mesh_request + mesh_pin as real tools', async () => {
    const b = spawn('node', ['src/bridge.mjs'], { env: { ...process.env, MESH_ACTOR: 'uitest', MESH_HUB: HUB }, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = [];
    b.stdout.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean)));
    const ask = (msg) => new Promise((res) => {
      const id = Math.random();
      const check = setInterval(() => {
        const i = lines.findIndex((l) => { try { return JSON.parse(l).id === id; } catch { return false; } });
        if (i >= 0) { clearInterval(check); res(JSON.parse(lines.splice(i, 1)[0])); }
      }, 50);
      b.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...msg }) + '\n');
    });
    const tools = (await ask({ method: 'tools/list' })).result.tools.map((t) => t.name);
    assert.ok(tools.includes('mesh_request') && tools.includes('mesh_pin'));
    // regression: a missing brace once swallowed every new tool below mesh_crdt_set —
    // the full tool surface must stay visible (task board, bot, memory, build status)
    for (const t of ['mesh_task_create', 'mesh_task_claim', 'mesh_bot', 'mesh_memory_set', 'mesh_build_status', 'mesh_declare_intent']) {
      assert.ok(tools.includes(t), `tool ${t} missing from tools/list (${tools.length} exposed)`);
    }
    assert.equal(tools.length >= 19, true, `expected >=19 top-level tools, got ${tools.length}`);
    const out = (await ask({ method: 'tools/call', params: { name: 'mesh_request', arguments: { to: 'be-agent', text: 'hi via mcp' } } })).result.content[0].text;
    assert.match(out, /request req-/);
    b.kill();
  });
  it('extension loads without vscode; diagnostics map collisions to files', () => {
    const req = createRequire(import.meta.url);
    const ext = req('../extension/extension.js');
    assert.equal(typeof ext.activate, 'function');
    const diags = ext.collisionDiagnostics({ collisions: [{ a: 'x', b: 'y', grade: 'overlapping' }], intents: [{ actor: 'x', paths: ['src/api/a.ts'] }, { actor: 'y', paths: ['src/api/a.ts'] }] });
    assert.ok(diags['src/api/a.ts'] && diags['src/api/a.ts'][0].severity === 'warning');
  });
  it('extension + tui + canvas pass syntax; tui degrades without TTY', () => {
    execFileSync(process.execPath, ['--check', 'extension/extension.js'], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', 'src/tui.mjs'], { stdio: 'pipe' });
    assert.ok(existsSync('src/canvas.html'));
    const out = execFileSync(process.execPath, ['src/tui.mjs'], { env: { ...process.env, MESH_HUB: HUB }, stdio: 'pipe', timeout: 15000 }).toString();
    assert.match(out, /trunk/);
  });
});
