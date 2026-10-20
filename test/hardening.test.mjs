// test/hardening.test.mjs — P0 production-hardening gates.
//
// These are the invariants that were silently broken before: unauthenticated
// write routes, client-controlled intent ids, a missing 'build' scope, a
// non-atomic/fragile write path, and a truncated event replay. Each test here
// fails on the pre-hardening code.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { killChild, rmSafe, claimPort } from './cleanup.mjs';
import { atomicWrite } from '../src/store.mjs';
import { keygen, mintToken, scopeAllows, SCOPES } from '../src/auth.mjs';
import { openDb, dbAppendEvent, dbEvents, dbMaxSeq, dbUserVersion, dbEventsSince } from '../src/db.mjs';

// Port must be unique across the suite: node --test runs files in parallel, and
// two suites sharing a port means one suite silently talks to the other's hub
// (which is how the 7789 collision hid a 401 for several minutes).
const PORT = '7786';
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = '.mesh-test-hardening';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;

const startHub = (extraEnv = {}) => spawn('node', ['src/hub.mjs'], {
  env: { ...process.env, MESH_PORT: PORT, MESH_DIR: DIR, ...extraEnv },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const waitUp = async (timeout = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${HUB}/health`); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('hub did not start');
};
const post = (path, body, token = null) => fetch(`${HUB}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

before(async () => {
  rmSync(DIR, { recursive: true, force: true });
  // Fail loudly if another suite already owns this port.
  await claimPort(PORT);
  hub = startHub();
  await waitUp();
});
after(async () => { killChild(hub); await rmSafe(DIR); });

// ---------------------------------------------------------------- store.mjs
describe('atomicWrite (durability + concurrency)', () => {
  it('writes a complete file and leaves no scratch files behind', () => {
    const dir = join(DIR, 'aw-1');
    rmSync(dir, { recursive: true, force: true });
    atomicWrite(join(dir, 'a.json'), JSON.stringify({ n: 1 }));
    assert.equal(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).n, 1);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], `scratch files left behind: ${leftovers.join(', ')}`);
  });

  it('survives concurrent writers to the SAME target without corrupting it', async () => {
    const dir = join(DIR, 'aw-2');
    rmSync(dir, { recursive: true, force: true });
    const target = join(dir, 'shared.json');
    // Two processes racing on one path is the classic lost-update bug: the old
    // implementation used a fixed `path + '.tmp'` so the writers interleaved.
    const writers = Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
      const code = `import {atomicWrite} from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
        const big = 'x'.repeat(200000);
        atomicWrite(${JSON.stringify(target)}, JSON.stringify({ w: ${i}, big }));`;
      const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${i} failed: ${err}`))));
    }));
    await Promise.all(writers);
    const raw = readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw); // must be valid JSON, not interleaved bytes
    assert.equal(parsed.big.length, 200000);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  });

  it('overwrites an existing file in place (not an append or a no-op)', () => {
    const dir = join(DIR, 'aw-3');
    rmSync(dir, { recursive: true, force: true });
    const target = join(dir, 'v.json');
    atomicWrite(target, JSON.stringify({ v: 1 }));
    atomicWrite(target, JSON.stringify({ v: 2 }));
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).v, 2);
  });
});

// ----------------------------------------------------------------- auth.mjs
describe('capability scopes', () => {
  it('supports exact, global and prefix-wildcard scopes', () => {
    assert.equal(scopeAllows(['tasks'], 'tasks'), true);
    assert.equal(scopeAllows(['*'], 'anything'), true);
    assert.equal(scopeAllows(['tasks.*'], 'tasks.claim'), true);
    assert.equal(scopeAllows(['tasks.*'], 'tasks'), true);
    assert.equal(scopeAllows(['tasks'], 'audit'), false);
  });

  it('the default token scope includes build (it used to 403)', () => {
    assert.ok(SCOPES.includes('build'), 'build scope missing from the default set');
    assert.ok(SCOPES.includes('lease.hard'));
    assert.ok(SCOPES.includes('crdt') && SCOPES.includes('macp') && SCOPES.includes('dag') && SCOPES.includes('p2p'));
  });
});

// ------------------------------------------------------------------- db.mjs
describe('event store', () => {
  it('records a user_version for forward-only migrations', () => {
    const db = openDb(join(DIR, 'db-1'));
    assert.ok(dbUserVersion(db) >= 1);
    db.close();
  });

  it('replays the FULL log (the old 100k cap silently dropped later events)', () => {
    const db = openDb(join(DIR, 'db-2'));
    let prev = '0';
    for (let i = 1; i <= 250; i++) {
      const e = { seq: i, t: Date.now(), hlc: '1:0:hub', epoch: 1, actor: 'a', kind: 'ping', payload: { i }, prev, hash: `h${i}` };
      dbAppendEvent(db, e);
      prev = e.hash;
    }
    const rows = dbEvents(db);
    assert.equal(rows.length, 250, 'replay truncated the log');
    assert.equal(dbMaxSeq(db), 250);
    assert.equal(dbEventsSince(db, 248).length, 2);
    db.close();
  });
});

// ------------------------------------------------------------------ hub.mjs
describe('hub authorization boundaries', () => {
  it('rejects unauthenticated writes once keys exist', async () => {
    keygen(DIR);
    const tok = mintToken(DIR, { actor: 'op' });
    // These five routes were open to ANY LAN host before hardening.
    for (const [route, body, scope] of [
      ['/api/crdt', { action: 'set', actor: 'op', key: 'k', value: 'v' }, 'crdt'],
      ['/api/macp', { action: 'create', initiator: 'op', mode: 'proposal', title: 't' }, 'macp'],
      ['/api/dag', { action: 'append', actor: 'op', kind: 'k' }, 'dag'],
      ['/api/p2p', { action: 'join', actor: 'op' }, 'p2p'],
    ]) {
      const anon = await post(route, body);
      assert.equal(anon.body.ok, false, `${route} accepted an unauthenticated write`);
      assert.equal(anon.status, 401, `${route} should answer 401, got ${anon.status}`);
      const authed = await post(route, body, tok);
      assert.equal(authed.body.ok, true, `${route} rejected a valid token: ${JSON.stringify(authed.body)}`);
    }
  });

  it('rejects a token issued for a different actor', async () => {
    const tok = mintToken(DIR, { actor: 'someone-else' });
    const r = await post('/api/crdt', { action: 'set', actor: 'op', key: 'k', value: 'v' }, tok);
    assert.equal(r.body.ok, false);
  });

  it('the server assigns the intent id — a client cannot hijack another actor lease', async () => {
    const tok = mintToken(DIR, { actor: 'op' });
    const first = await post('/cmd', {
      actor: 'op', kind: 'intent.declare',
      payload: { goal: 'first', paths: ['src/alpha/**'] },
    }, tok);
    assert.equal(first.body.ok, true);
    const realId = first.body.intent;

    // Attempt to overwrite op's intent by supplying a crafted id.
    const hijack = await post('/cmd', {
      actor: 'attacker', kind: 'intent.declare',
      payload: { goal: 'hijack', paths: ['src/beta/**'], id: realId },
    }, mintToken(DIR, { actor: 'attacker' }));
    assert.equal(hijack.body.ok, true);
    assert.notEqual(hijack.body.intent, realId, 'server let the client choose the intent id');

    const state = await (await fetch(`${HUB}/state`)).json();
    const owned = state.intents.find((i) => i.id === realId);
    assert.ok(owned, 'the original intent vanished');
    assert.equal(owned.actor, 'op', 'another actor overwrote the intent entry');
    assert.deepEqual(owned.paths, ['src/alpha/**'], 'another actor rewrote the intent scope');
  });

  it('a hard lease requires the lease.hard scope', async () => {
    const noLease = mintToken(DIR, { actor: 'op', scope: ['intent.declare'] });
    const r = await post('/cmd', {
      actor: 'op', kind: 'intent.declare',
      payload: { goal: 'lock it', paths: ['src/locked/**'], hard: true },
    }, noLease);
    assert.equal(r.body.ok, false);
    assert.match(String(r.body.error), /lease\.hard/);
  });

  it('SSE requires a token when auth is enforced', async () => {
    const anon = await fetch(`${HUB}/events`, { headers: { accept: 'text/event-stream' } });
    assert.equal(anon.status, 401, 'the event stream was open to anyone');
    await anon.text().catch(() => {});
  });
});

// ------------------------------------------------------------------ bridge
describe('MCP bridge JSON-RPC compliance', () => {
  // The hub in this file has keys (enforced auth), so the bridge needs a token.
  let bridgeToken = '';
  before(() => { keygen(DIR); bridgeToken = mintToken(DIR, { actor: 'tester' }); });
  const runBridge = (lines) => {
    const p = spawnSync(process.execPath, ['src/bridge.mjs'], {
      input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      env: { ...process.env, MESH_ACTOR: 'tester', MESH_HUB: HUB, MESH_TOKEN: bridgeToken },
      encoding: 'utf8',
      timeout: 20000,
    });
    return (p.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  };

  it('answers an unknown method with -32601, not an empty result', () => {
    const out = runBridge([{ jsonrpc: '2.0', id: 1, method: 'no/such/method' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].error.code, -32601);
  });

  it('answers a malformed line with -32700 (parse error)', () => {
    const p = spawnSync(process.execPath, ['src/bridge.mjs'], {
      input: '{not json at all\n', env: { ...process.env, MESH_ACTOR: 'tester', MESH_HUB: HUB }, encoding: 'utf8', timeout: 20000,
    });
    const out = (p.stdout || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(out[0].error.code, -32700);
  });

  it('rejects a call with missing required arguments using -32602', () => {
    const out = runBridge([{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mesh_declare_intent', arguments: { goal: 'x' } } }]);
    assert.equal(out[0].error.code, -32602);
    assert.match(out[0].error.message, /paths/);
  });

  it('lists tools in a deterministic order and implements server/discover', () => {
    const out = runBridge([
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { jsonrpc: '2.0', id: 4, method: 'server/discover' },
    ]);
    const list = out.find((o) => o.id === 3);
    const discover = out.find((o) => o.id === 4);
    assert.ok(list.result.tools.length >= 19);
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(names, [...names].sort(), 'tools/list must be deterministic for prompt caching');
    assert.ok(discover.result.tools.length >= 19, 'server/discover (MCP 2026-07-28) is missing');
  });

  it('answers EVERY request in a batch before stdin closes (no truncated stream)', () => {
    // Regression: the bridge used to exit on stdin close while responses were
    // still in flight, so a client saw a short stream and could not tell it
    // from a crash. It also truncated buffered stdout via process.exit().
    const out = runBridge([
      { jsonrpc: '2.0', id: 11, method: 'ping' },
      { jsonrpc: '2.0', id: 12, method: 'ping' },
      { jsonrpc: '2.0', id: 13, method: 'ping' },
      { jsonrpc: '2.0', id: 14, method: 'server/discover' },
    ]);
    const ids = out.map((o) => o.id).sort();
    assert.deepEqual(ids, [11, 12, 13, 14], `only ${out.length} of 4 responses came back`);
  });

  it('marks a failing tool call with isError so an agent can tell it from success', () => {
    const ok = runBridge([
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'mesh_declare_intent', arguments: { goal: 'g', paths: ['x/**'] } } },
    ]);
    assert.equal(ok.find((o) => o.id === 21).result.isError, false, 'a successful call was flagged as an error');

    // Now break it: a claim for a task that does not exist must be an error.
    const bad = runBridge([
      { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'mesh_task_claim', arguments: { id: 'task-does-not-exist' } } },
    ]);
    const r = bad.find((o) => o.id === 22);
    assert.equal(r.result.isError, true, 'a failing tool call was reported as a success');
  });
});

// ---------------------------------------------------------- fail-closed bind
describe('network bind policy', () => {
  it('refuses to start on a non-loopback bind without auth', () => {
    const p = spawnSync(process.execPath, ['src/hub.mjs'], {
      env: { ...process.env, MESH_HOST: '0.0.0.0', MESH_PORT: '7791', MESH_DIR: join(DIR, 'insecure') },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(p.status, 78, 'the hub started open on a network interface');
    assert.match(p.stderr, /REFUSING TO START/);
    assert.match(p.stderr, /MESH_INSECURE/);
  });
});
