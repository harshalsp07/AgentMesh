// test/share.test.mjs — whiteboard ops + tldraw round-trip + voice signaling (ephemeral).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { rmSafe, claimPort } from './cleanup.mjs';
import { applyBoardOp, loadBoard, exportTldraw, importTldraw, voiceJoin, voiceSignal, voiceDrain, voiceSweep } from '../src/share.mjs';

const PORT = '7783';
const HUB = `http://localhost:${PORT}`;
const DIR = '.mesh-test-share';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;
const post = (path, body) => fetch(`${HUB}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

before(async () => {
  await claimPort('7783');
  rmSync(DIR, { recursive: true, force: true });
  hub = spawn('node', ['src/hub.mjs'], { env: { ...process.env, MESH_PORT: PORT, MESH_DIR: DIR }, stdio: ['ignore', 'ignore', 'inherit'] });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try { const r = await fetch(`${HUB}/health`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('hub did not start');
});
after(() => { hub.kill(); rmSafe(DIR); });

describe('board store', () => {
  it('add/update/delete validate and fail closed', () => {
    const a = applyBoardOp(DIR, 'maya', { op: 'add', shape: { type: 'note', x: 10, y: 20, text: 'plan', codeRef: 'src/api/auth.ts' } });
    assert.equal(a.ok, true);
    assert.equal(a.shape.v, 1);
    assert.equal(applyBoardOp(DIR, 'x', { op: 'add', shape: { type: 'bogus', x: 0, y: 0 } }).ok, false);
    assert.equal(applyBoardOp(DIR, 'x', { op: 'add', shape: { type: 'draw', x: 0, y: 0, points: [] } }).ok, false);
    const big = applyBoardOp(DIR, 'x', { op: 'add', shape: { type: 'note', x: 0, y: 0, text: 'z'.repeat(501) } });
    assert.equal(big.ok, false);
    const u = applyBoardOp(DIR, 'maya', { op: 'update', id: a.shape.id, patch: { x: 30 } });
    assert.equal(u.shape.v, 2); // LWW version bumps
    assert.equal(applyBoardOp(DIR, 'x', { op: 'delete', id: 'nope' }).ok, false);
    assert.equal(applyBoardOp(DIR, 'maya', { op: 'delete', id: a.shape.id }).ok, true);
  });
  it('tldraw export/import round-trips shapes', () => {
    applyBoardOp(DIR, 'a', { op: 'add', shape: { type: 'note', x: 1, y: 2, text: 'hello' } });
    applyBoardOp(DIR, 'a', { op: 'add', shape: { type: 'draw', x: 0, y: 0, points: [[0, 0], [5, 5]] } });
    const ex = exportTldraw(DIR);
    assert.ok(ex.shapes.length >= 2 && ex.tldraw.startsWith('best-effort'));
    rmSync(DIR + '/board.json');
    const im = importTldraw(DIR, 'b', ex);
    assert.ok(im.added >= 2);
    assert.ok(Object.keys(loadBoard(DIR).shapes).length >= 2);
  });
  it('voice signaling is ephemeral (never in the durable log)', () => {
    const peers = {}, mail = {};
    assert.equal(voiceJoin(peers, 'ann').peers.length, 1);
    assert.equal(voiceSignal(mail, peers, { from: 'ann', to: 'ghost', type: 'offer', data: {} }).ok, false);
    voiceJoin(peers, 'bob');
    assert.equal(voiceSignal(mail, peers, { from: 'ann', to: 'bob', type: 'offer', data: { sdp: 'x' } }).ok, true);
    assert.equal(voiceSignal(mail, peers, { from: 'ann', to: 'bob', type: 'bogus', data: {} }).ok, false);
    assert.equal(voiceDrain(mail, 'bob').length, 1);
    assert.equal(voiceDrain(mail, 'bob').length, 0); // drained
    voiceSweep(peers, mail, Date.now() + 61000);
    assert.equal(Object.keys(peers).length, 0); // TTL swept
  });
});

describe('board + voice over HTTP', () => {
  it('board ops sync + persist; voice join/signal/leave', async () => {
    const s = await post('/api/board/op', { actor: 'ann', op: { op: 'add', shape: { type: 'note', x: 5, y: 5, text: 'kickoff' } } });
    assert.equal(s.ok, true);
    const b = await (await fetch(`${HUB}/api/board`)).json();
    assert.ok(b.shapes[s.shape.id]);
    assert.ok(existsSync(DIR + '/board.json'));
    const bad = await post('/api/board/op', { actor: 'ann', op: { op: 'add', shape: { type: 'nope', x: 0, y: 0 } } });
    assert.equal(bad.ok, false);
    const ex = await (await fetch(`${HUB}/api/board-export`)).json();
    assert.ok(ex.shapes.length >= 1);
    const j = await post('/api/voice-join', { actor: 'ann' });
    assert.deepEqual(j.peers, ['ann']);
    await post('/api/voice-join', { actor: 'bob' });
    assert.equal((await post('/api/voice-signal', { from: 'ann', to: 'bob', type: 'offer', data: { sdp: 'v=0' } })).ok, true);
    const d = await (await fetch(`${HUB}/api/voice-signal?actor=bob`)).json();
    assert.equal(d.signals.length, 1);
    await post('/api/voice-leave', { actor: 'ann' });
    const ov = await (await fetch(`${HUB}/api/overview`)).json();
    assert.ok(ov.board.shapes >= 1);
    assert.deepEqual(ov.voice.map((p) => p.actor), ['bob']);
    const v = await (await fetch(`${HUB}/verify`)).json();
    assert.equal(v.ok, true); // voice signals never touch the durable log
  });
});
