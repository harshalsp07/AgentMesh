// demo-share.mjs — whiteboard + voice, end to end through the hub HTTP API.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = '7794';
const HUB = `http://localhost:${PORT}`;
const env = { ...process.env, MESH_PORT: PORT, MESH_DIR: '.mesh-demoshare' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('✓', m); };
const post = (p, b) => fetch(`${HUB}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

rmSync('.mesh-demoshare', { recursive: true, force: true });
const hub = spawn('node', ['src/hub.mjs'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
const t0 = Date.now();
while (Date.now() - t0 < 8000) {
  try { const r = await fetch(`${HUB}/health`); if (r.ok) break; } catch {}
  await sleep(200);
}
try {
  // two teammates sketch the auth rename on the board; backend links the code ref
  const s1 = await post('/api/board/op', { actor: 'maya', op: { op: 'add', shape: { type: 'note', x: 100, y: 100, text: 'move /api/auth -> /api/v2/auth?', color: 'yellow' } } });
  assert(s1.ok, 'sticky lands on the shared board');
  const s2 = await post('/api/board/op', { actor: 'leo', op: { op: 'add', shape: { type: 'note', x: 320, y: 100, text: 'UI migrates after ghost client', color: 'blue', codeRef: 'src/ui/auth/Login.tsx' } } });
  assert(s2.ok && s2.shape.codeRef, 'sticky carries a code ref (board <-> code linked)');
  const mv = await post('/api/board/op', { actor: 'maya', op: { op: 'update', id: s1.shape.id, patch: { x: 120 } } });
  assert(mv.ok && mv.shape.v === 2, 'concurrent move converges (LWW version)');
  const ex = await (await fetch(`${HUB}/api/board-export`)).json();
  assert(ex.shapes.length === 2, `tldraw-compatible export holds ${ex.shapes.length} shapes`);
  // voice: join, exchange an offer, leave — signaling only, never logged
  assert((await post('/api/voice-join', { actor: 'maya' })).peers.includes('maya'), 'maya joins voice');
  await post('/api/voice-join', { actor: 'leo' });
  assert((await post('/api/voice-signal', { from: 'maya', to: 'leo', type: 'offer', data: { sdp: 'v=0/fake' } })).ok, 'SDP offer trickles via hub mailbox');
  const sig = await (await fetch(`${HUB}/api/voice-signal?actor=leo`)).json();
  assert(sig.signals.length === 1 && sig.peers.length === 2, 'leo receives the offer; room shows 2 peers');
  await post('/api/voice-leave', { actor: 'maya' });
  const ov = await (await fetch(`${HUB}/api/overview`)).json();
  assert(ov.board.shapes === 2 && ov.voice.length === 1, 'overview feeds canvas+TUI+extension (board 2, voice 1)');
  assert((await (await fetch(`${HUB}/verify`)).json()).ok, 'durable log intact (voice never touches it)');
  console.log('SHARE ALL ASSERTIONS PASSED');
} finally {
  hub.kill();
  await sleep(300);
}
