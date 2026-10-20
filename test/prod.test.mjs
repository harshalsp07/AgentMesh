// test/prod.test.mjs — production gates: restart durability, auth, shims, merge,
// rate limits, metrics. Everything here must hold on a real deployment.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { killChild, rmSafe, claimPort } from './cleanup.mjs';
import { keygen, mintToken } from '../src/auth.mjs';
import { buildShims, decide } from '../src/shims.mjs';
import { threeWayMerge } from '../src/merge.mjs';

const PORT = '7784';
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = '.mesh-test-prod';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;
const startHub = () => spawn('node', ['src/hub.mjs'], { env: { ...process.env, MESH_PORT: PORT, MESH_DIR: DIR }, stdio: ['ignore', 'ignore', 'inherit'] });
const waitUp = async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try { const r = await fetch(`${HUB}/health`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('hub did not start');
};
const cmd = (actor, kind, payload, token = null) => fetch(`${HUB}/cmd`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ actor, kind, payload }),
}).then((r) => r.json().then((b) => ({ status: r.status, body: b })));

before(async () => { await claimPort('7784');
  rmSync(DIR, { recursive: true, force: true }); hub = startHub(); await waitUp(); });
after(async () => { killChild(hub); await rmSafe(DIR); });

describe('durability', () => {
  it('survives a kill -9 style restart with log intact (SQLite source of truth)', async () => {
    await cmd('persist-a', 'intent.declare', { goal: 'durable work', paths: ['src/durable/**'] });
    const before = await (await fetch(`${HUB}/verify`)).json();
    assert.equal(before.ok, true);
    hub.kill('SIGKILL');
    await sleep(500);
    hub = startHub(); await waitUp();
    const after = await (await fetch(`${HUB}/verify`)).json();
    assert.equal(after.ok, true);
    assert.equal(after.events, before.events);
    const st = await (await fetch(`${HUB}/state`)).json();
    assert.ok(st.intents.some((i) => i.actor === 'persist-a'));
    assert.ok(existsSync(`${DIR}/mesh.db`));
  });
});

describe('auth', () => {
  it('open without keys; 401/403/200 with keys', async () => {
    // no keys in this DIR yet -> open
    const open = await cmd('anon', 'presence', {});
    assert.equal(open.body.ok, true);
    keygen(DIR);
    const good = mintToken(DIR, { actor: 'op' });
    const stale = mintToken(DIR, { actor: 'op', ttlH: -1 });
    assert.equal((await cmd('op', 'presence', {}, null)).body.ok, false); // 401, no token
    assert.equal((await cmd('op', 'presence', {}, 'garbage')).body.ok, false);
    assert.equal((await cmd('mallory', 'presence', {}, good)).body.error, 'token is for op, not mallory'); // 403 impersonation
    assert.match((await cmd('op', 'presence', {}, stale)).body.error, /expired/);
    assert.equal((await cmd('op', 'presence', { verb: 'authed' }, good)).body.ok, true);
  });
});

describe('shims + merge', () => {
  it('deny refuses before exec; approval needs MESH_APPROVED; allow passes through', () => {
    buildShims(DIR, new URL('../src/', import.meta.url).pathname);
    assert.equal(decide(DIR, 'rm -rf /*').verdict, 'deny');
    assert.equal(decide(DIR, 'npm publish x').verdict, 'approval');
    assert.equal(decide(DIR, 'echo hi').verdict, 'allow');
    const env = { ...process.env, PATH: `${join(process.cwd(), DIR, 'shims')}${delimiter}${process.env.PATH}` };
    const denied = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'rm -rf /'], { env, encoding: 'utf8' }) // cmd resolves the .cmd shim via PATHEXT
      : spawnSync('rm', ['-rf', '/'], { env, encoding: 'utf8' });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr + denied.stdout, /denied/);
  });
  it('three-way merge: clean auto-merges, divergent becomes a conflict object', () => {
    const base = 'a\nb\nc\n';
    const clean = threeWayMerge({ base, ours: 'a\nB\nc\n', theirs: base });
    assert.equal(clean.ok, true);
    assert.match(clean.merged, /B/);
    const clash = threeWayMerge({ base, ours: 'a\nOURS\nc\n', theirs: 'a\nTHEIRS\nc\n' });
    assert.equal(clash.ok, false);
    assert.ok(clash.conflict);
  });
});

describe('guards + observability', () => {
  it('100+ writes/min from one actor trips 429; metrics + ready stay honest', async () => {
    // fresh actor to isolate the bucket (auth is on in DIR now — mint first)
    const tok = mintToken(DIR, { actor: 'flooder' });
    let limited = 0;
    for (let i = 0; i < 110; i++) {
      const r = await cmd('flooder', 'presence', { n: i }, tok);
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0, 'expected some 429s past 100/min');
    const m = await (await fetch(`${HUB}/metrics`)).json();
    assert.ok(m.uptime_s >= 0 && m.events_total > 0 && m.auth === 'enforced');
    const rdy = await (await fetch(`${HUB}/ready`)).json();
    assert.equal(rdy.ready, true);
    assert.equal(rdy.db, true);
  });
  it('oversize bodies get 413, bad JSON gets 400', async () => {
    const tok = mintToken(DIR, { actor: 'big' });
    const big = await fetch(`${HUB}/cmd`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ actor: 'big', kind: 'presence', payload: { blob: 'x'.repeat(2 * 1024 * 1024) } }),
    });
    assert.equal(big.status, 413);
    const bad = await fetch(`${HUB}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
  });
});
