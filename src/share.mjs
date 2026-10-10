// share.mjs — shared whiteboard + voice signaling. Zero deps.
// Board: operation-synced shapes (LWW per shape version), persisted to board.json,
// replayable like everything else. Shape model mirrors tldraw closely enough that
// export/import round-trips with real tldraw (best-effort, labeled as such).
// Voice: the hub is signaling-only (SDP + ICE mailbox, 60s TTL, never in the durable
// log); browsers build a P2P WebRTC audio mesh — no server media, works for 3-5 peers.
import { loadJson, saveJson, ulid } from './store.mjs';

const file = (root) => `${root}/board.json`;
const MAX_SHAPES = 2000, MAX_POINTS = 500, MAX_TEXT = 500;
const TYPES = ['note', 'rect', 'ellipse', 'arrow', 'text', 'draw'];
const COLORS = ['yellow', 'blue', 'green', 'pink', 'gray', 'red'];

export function loadBoard(root) { return loadJson(file(root), { shapes: {}, seq: 0 }); }
function save(root, b) { saveJson(file(root), b); }
const okId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''));

function checkShape(s) {
  if (!s || typeof s !== 'object') return 'shape object required';
  if (!TYPES.includes(s.type)) return `type must be one of ${TYPES.join('|')}`;
  for (const k of ['x', 'y']) if (typeof s[k] !== 'number' || !isFinite(s[k])) return `${k} must be a number`;
  if (s.text && String(s.text).length > MAX_TEXT) return `text > ${MAX_TEXT} chars`;
  if (s.color && !COLORS.includes(s.color)) return `color must be one of ${COLORS.join('|')}`;
  if (s.type === 'draw') {
    if (!Array.isArray(s.points) || !s.points.length) return 'draw needs points';
    if (s.points.length > MAX_POINTS) return `draw > ${MAX_POINTS} points (simplify the stroke)`;
  }
  if (s.codeRef && typeof s.codeRef !== 'string') return 'codeRef must be a string';
  return null;
}
export function applyBoardOp(root, actor, op = {}) {
  const b = loadBoard(root);
  if (op.op === 'add') {
    if (Object.keys(b.shapes).length >= MAX_SHAPES) return { ok: false, error: `board full (${MAX_SHAPES} shapes); delete or clear` };
    const s = { id: op.shape?.id && okId(op.shape.id) ? op.shape.id : ulid('sh-'), type: 'note', x: 50, y: 50, w: 180, h: 120, color: 'yellow', text: '', ...(op.shape || {}), by: actor, t: Date.now(), v: 1 };
    const err = checkShape(s);
    if (err) return { ok: false, error: err };
    b.shapes[s.id] = s; b.seq++;
    save(root, b);
    return { ok: true, shape: s, seq: b.seq };
  }
  if (op.op === 'update') {
    const cur = b.shapes[op.id];
    if (!cur) return { ok: false, error: 'unknown shape' };
    const next = { ...cur, ...(op.patch || {}), id: cur.id, by: cur.by, v: cur.v + 1, t: Date.now() };
    const err = checkShape(next);
    if (err) return { ok: false, error: err };
    b.shapes[op.id] = next; b.seq++;
    save(root, b);
    return { ok: true, shape: next, seq: b.seq };
  }
  if (op.op === 'delete') {
    if (!b.shapes[op.id]) return { ok: false, error: 'unknown shape' };
    delete b.shapes[op.id]; b.seq++;
    save(root, b);
    return { ok: true, id: op.id, seq: b.seq };
  }
  if (op.op === 'clear') {
    b.shapes = {}; b.seq++;
    save(root, b);
    return { ok: true, cleared: true, seq: b.seq };
  }
  return { ok: false, error: 'op must be add|update|delete|clear' };
}
// tldraw-v2-ish export (best-effort): notes/text/rects/ellipses/draw map 1:1, arrows as draw
export function exportTldraw(root) {
  const b = loadBoard(root);
  const shapes = Object.values(b.shapes).map((s) => ({
    id: `shape:${s.id}`, typeName: 'shape', type: s.type === 'note' ? 'note' : s.type === 'draw' ? 'draw' : 'geo',
    x: s.x, y: s.y,
    props: s.type === 'draw' ? { segments: [{ points: (s.points || []).map(([x, y]) => ({ x, y })) }], color: s.color }
      : { text: s.text || '', color: s.color, geo: s.type === 'note' ? 'rectangle' : s.type === 'text' ? undefined : s.type, w: s.w, h: s.h },
    meta: { meshBy: s.by, meshCodeRef: s.codeRef || null },
  }));
  return { tldraw: 'best-effort v2-ish', shapes };
}
export function importTldraw(root, actor, doc = {}) {
  const list = Array.isArray(doc.shapes) ? doc.shapes.slice(0, MAX_SHAPES) : [];
  let added = 0;
  for (const t of list) {
    const type = t.type === 'draw' ? 'draw' : t.type === 'note' || t.type === 'text' ? 'note' : ['rect', 'ellipse', 'arrow'].includes(t.geo) ? t.geo : 'rect';
    const shape = {
      type, x: +t.x || 0, y: +t.y || 0, w: +t.props?.w || 180, h: +t.props?.h || 120,
      color: COLORS.includes(t.props?.color) ? t.props.color : 'yellow',
      text: String(t.props?.text || '').slice(0, MAX_TEXT),
      points: type === 'draw' ? (t.props?.segments?.[0]?.points || []).slice(0, MAX_POINTS).map((p) => [+p.x || 0, +p.y || 0]) : undefined,
    };
    const r = applyBoardOp(root, actor, { op: 'add', shape });
    if (r.ok) added++;
  }
  return { ok: true, added };
}

// ---- voice signaling: ephemeral mailbox, swept every 10s, never persisted ----
export function voiceJoin(peers, actor, info = {}) {
  peers[actor] = { actor, name: info.name || actor, muted: !!info.muted, t: Date.now(), seen: Date.now() };
  return { ok: true, peers: Object.keys(peers) };
}
export function voiceLeave(peers, mail, actor) {
  delete peers[actor]; delete mail[actor];
  return { ok: true };
}
export function voiceHeartbeat(peers, actor) { if (peers[actor]) peers[actor].seen = Date.now(); }
export function voiceSignal(mail, peers, { from, to, type, data }) {
  if (!['offer', 'answer', 'ice'].includes(type)) return { ok: false, error: 'type must be offer|answer|ice' };
  if (!peers[from] || !peers[to]) return { ok: false, error: 'both peers must have joined voice' };
  if (JSON.stringify(data || '').length > 20000) return { ok: false, error: 'signal payload too large' };
  (mail[to] ||= []).push({ from, type, data, t: Date.now() });
  while (mail[to].length > 50) mail[to].shift();
  return { ok: true };
}
export function voiceDrain(mail, actor) { return (mail[actor] || []).splice(0); }
export function voiceSweep(peers, mail, nowMs = Date.now()) {
  for (const [a, p] of Object.entries(peers)) {
    if (nowMs - p.seen > 60000) { delete peers[a]; delete mail[a]; }
  }
}
