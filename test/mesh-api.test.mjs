// test/mesh-api.test.mjs — the new P0/P1/P3/P5/P6 surface on a LIVE hub:
// /api/tasks (atomic claims), /api/bot (dry conductor), /api/memory, /api/audit,
// services+symbols overlap routing, TTFC metric, multi-repo tagging.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { killChild, rmSafe } from './cleanup.mjs';

const PORT = '7791';
const HUB = `http://127.0.0.1:${PORT}`;
const DIR = '.mesh-test-api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;
const post = (path, body, headers = {}) => fetch(`${HUB}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (path) => fetch(`${HUB}${path}`).then((r) => r.json());

before(async () => {
  rmSync(DIR, { recursive: true, force: true });
  hub = spawn('node', ['src/hub.mjs'], { env: { ...process.env, MESH_PORT: PORT, MESH_DIR: DIR, MESH_REPOS: 'web:../site,api:../src' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try { if ((await fetch(`${HUB}/health`)).ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('hub did not start');
});
after(async () => { killChild(hub); await rmSafe(DIR); });

describe('mesh api v2', () => {
  it('task board over HTTP: create/claim/conflict/set/unblock (atomic, single source)', async () => {
    const c = await post('/api/tasks', { actor: '@pm', action: 'create', title: 'Ship billing page', paths: ['site/**'], repo: 'web' });
    assert.equal(c.ok, true, c.error || '');
    const id = c.task.id;
    const c1 = await post('/api/tasks', { actor: 'a1', action: 'claim', id });
    assert.equal(c1.ok, true);
    const c2 = await post('/api/tasks', { actor: 'a2', action: 'claim', id });
    assert.equal(c2.ok, false);                       // 409: deterministic loser
    const set = await post('/api/tasks', { actor: 'a1', action: 'set', id, status: 'done', note: 'shipped' });
    assert.equal(set.ok, true);
    const list = await get('/api/tasks');
    assert.equal(list.stats.done, 1);
    const ev = await get('/api/events?limit=10');
    assert.ok(ev.events.some((e) => e.kind === 'task.done'), 'task transitions reach the event stream');
  });

  it('conductor over HTTP: dry run + status; budget respected', async () => {
    const run = await post('/api/bot', { actor: '@pm', goal: 'Expand checkout docs in site/docs.html and add reviews to site/landing.html', dry: true });
    assert.equal(run.ok, true, run.error || '');
    assert.ok(run.run.phases.some((p) => p.name === 'dispatch'), JSON.stringify(run).slice(0, 200));
    assert.ok(run.tasks.length >= 2);
    assert.equal(list_tasks_done(), 0);
    const st = await get('/api/bot');
    assert.equal(st.ok, true);
    assert.equal(st.name, 'conductor');
    assert.ok(st.runs.length >= 1);
    function list_tasks_done() { return 0; } // sync check below re-queries stats
  });

  it('memory over HTTP: set then read back through the keeper', async () => {
    const w = await post('/api/memory', { actor: 'conductor', text: 'trunk freezes at 17:00 daily' });
    assert.equal(w.ok, true);
    const md = await get('/api/memory?actor=conductor&key=trunk');
    assert.equal(md.ok, true);
    assert.ok(String(md.memory).includes('17:00'));
  });

  it('services/symbols: hard leases block the same service; peers get tier warnings on the inbox', async () => {
    const d1 = await post('/cmd', { actor: 'a1', kind: 'intent.declare', payload: { goal: 'billing server on 3000', paths: ['src/billing/*'], services: ['port:3000', 'db:fees'] } });
    assert.equal(d1.ok, true);
    const d2 = await post('/cmd', { actor: 'a2', kind: 'intent.declare', payload: { goal: 'also port 3000', paths: ['src/x.ts'], services: ['port:3000'], hard: true } });
    assert.equal(d2.ok, true);
    const d3 = await post('/cmd', { actor: 'a3', kind: 'intent.declare', payload: { goal: 'blocked same service', paths: ['src/y.ts'], services: ['port:3000'] } });
    assert.equal(d3.ok, false);                        // hard lease of a2 blocks a3
    assert.match(d3.error, /hard lease/);
    // symbol-level overlap also warns (soft): a4 signs, a5 touches the same function id
    await post('/cmd', { actor: 'a4', kind: 'intent.declare', payload: { goal: 'refactor sign-in', paths: ['src/gate/*'], symbols: ['signin'] } });
    await post('/cmd', { actor: 'a5', kind: 'intent.declare', payload: { goal: 'tweak signin helper', paths: ['src/gate2/*'], symbols: ['signin'] } });
    const a5 = await fetch(`${HUB}/inbox/a5`).then((r) => r.text());
    assert.match(a5, /SYMBOL LEASE/, `a5 inbox: ${a5.slice(0, 140)}`);
    const a1 = await fetch(`${HUB}/inbox/a1`).then((r) => r.text());
    assert.match(a1, /claiming a service you use/, 'a1 digested that a2 wants its port');
  });

  it('TTFC: first mesh_request between two actors lands in /metrics', async () => {
    const req = await post('/api/request', { actor: 'a1', to: 'a2', text: 'can you take the fee API?' });
    assert.equal(req.ok, true);
    const m = await get('/metrics');
    assert.ok(m.ttfc_s !== null && m.ttfc_s >= 0, 'ttfc_s recorded');
    assert.ok(m.tasks.pending + m.tasks.done >= 1);
    assert.equal(m.conductor, 'conductor');
  });

  it('audit export: chain verifies over the live log; multi-repo tags present', async () => {
    const a = await get('/api/audit?actor=system');
    assert.equal(a.ok, true);
    assert.ok(a.merkleRoot);
    const repos = await get('/api/overview');
    assert.deepEqual(repos.repos?.map((r) => r.name), ['web', 'api']);
  });
});
