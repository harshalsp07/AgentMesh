// hub.mjs — AgentMesh Phase-0 hub (hardened PoC). Zero dependencies.
// Event-sourced core: log + presence + intents/leases + router + fact sheets.
// Improvements over the design-doc prototype:
//  - reloads events.jsonl on boot (no lost writes across restarts)
//  - HLC-ish clock + epoch fencing stub + hash-chain /verify
//  - input validation with structured errors
//  - heartbeat renews leases, background sweeper expires them
//  - inbox capped + deduped, fact sheet char-budgeted (~800 tokens)
//  - hard-lease block enforced at the boundary (not in prompts)
//  - /health, /state, /verify, SSE /events for canvas
import http from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './store.mjs';
import { createRequest, respondRequest, addPin, recordDecision, inboxFor, loadCollab } from './collab.mjs';
import { forecast, scopeOfIntent } from './graph.mjs';
import { loadBoard, applyBoardOp, exportTldraw, importTldraw, voiceJoin, voiceLeave, voiceHeartbeat, voiceSignal, voiceDrain, voiceSweep } from './share.mjs';
import { openDb, dbAppendEvent, dbEvents, dbEventsSince, dbMaxSeq, dbVerify, kvGet, kvSet, metricIncr, metricAll, dbCheckpoint } from './db.mjs';
import { authEnforced, readPub, verifyToken, scopeAllows } from './auth.mjs';
import { SemanticDocument } from './crdt.mjs';
import { MACPKernel } from './macp.mjs';
import { MerkleDAG } from './dag.mjs';
import { P2PSwarmCoordinator } from './p2p.mjs';
import { generateAgentCard, handleA2ARpc } from './a2a.mjs';
import { createTask, claimTask, setTask, listTasks, taskStats } from './tasks.mjs';
import { botStatus, runBot } from './bot.mjs';
import { exportAudit, verifyAudit } from './audit.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));

export const PORT = +process.env.MESH_PORT || 7777;
export const HOST = process.env.MESH_HOST || '127.0.0.1';
export const DIR = process.env.MESH_DIR || '.mesh';

// --- fail-closed bind policy ---------------------------------------------
// A hub reachable from the network with no capability auth is an open write API
// for every agent on the LAN. Previously this only printed a warning, so the
// shipped Docker image (MESH_HOST=0.0.0.0, no keys) served an unauthenticated
// world-writable hub. Now a non-loopback bind REFUSES to start unless auth is
// enforced, or the operator explicitly opts out with MESH_INSECURE=1.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);
const isLoopbackBind = () => LOOPBACK.has(String(HOST).toLowerCase());

export const crdtDoc = new SemanticDocument('global-mesh');
export const macpKernel = new MACPKernel(DIR);
export const merkleDag = new MerkleDAG(DIR);
export const p2pSwarm = new P2PSwarmCoordinator();
const TTL = 300_000; // 5 min lease
const INBOX_CAP = 50;
const SHEET_BUDGET_CHARS = 3200; // ~800 tokens
const DELTA_BUDGET_CHARS = 1200; // ~300 tokens
const BODY_LIMIT = 1024 * 1024; // 1 MB
const RATE_LIMIT = 100; // writes/min/actor before 429
const BOOT_T = Date.now();

mkdirSync(`${DIR}/context`, { recursive: true });

// P5: multi-repo mesh v0 — one hub, several repos. MESH_REPOS="name:path,name:path".
// Intents/tasks may carry `repo:<name>`; the hub only tags events, repos stay on disk.
const S = { seq: 0, prev: '0', epoch: 1, intents: {}, presence: {}, inbox: {}, buildStatus: {}, repos: parseRepos(process.env.MESH_REPOS) };
function parseRepos(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => {
    const i = s.indexOf(':');
    return i > 0 ? { name: s.slice(0, i).trim().slice(0, 32), dir: s.slice(i + 1).trim() } : null;
  }).filter(Boolean).slice(0, 24);
}
const log = [];
const db = openDb(DIR); // durable store: SQLite is the source of truth; JSONL stays as export
const subs = new Set();
const voice = { peers: {}, mail: {} }; // ephemeral signaling only: never persisted, 60s TTL
const rates = new Map(); // actor -> [timestamps] for 429 guard
try { S.epoch = +(kvGet(db, 'epoch', process.env.MESH_EPOCH || '1')) || 1; } catch {}
if (process.env.MESH_EPOCH) { try { kvSet(db, 'epoch', String(S.epoch)); } catch {} }
let hlcLast = 0, hlcSeq = 0;

function hlc() {
  const now = Date.now();
  if (now > hlcLast) { hlcLast = now; hlcSeq = 0; } else hlcSeq++;
  return `${hlcLast}:${String(hlcSeq).padStart(4, '0')}:hub`;
}
const hashOf = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);

// ---- boot: SQLite first; legacy JSONL imported once when the DB is empty ----
(function load() {
  let rows = [];
  try { rows = dbEvents(db); } catch {}
  if (!rows.length && existsSync(`${DIR}/events.jsonl`)) {
    for (const line of readFileSync(`${DIR}/events.jsonl`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        dbAppendEvent(db, { ...e, payload: typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload });
      } catch {}
    }
    try { rows = dbEvents(db); } catch {}
  }
  for (const e of rows) {
    log.push(e); S.seq = Math.max(S.seq, e.seq); S.prev = e.hash;
    try { reduce(e, true); } catch {}
  }
  // The seq counter must reflect the HIGHEST seq in the store, not the last row
  // replayed. If replay is ever truncated (or rows are pruned) the counter would
  // restart below existing primary keys and every new event would be silently
  // dropped on INSERT conflict.
  try { S.seq = Math.max(S.seq, dbMaxSeq(db)); } catch {}
  // The chain head must also be the last stored hash, or the next event links to
  // a stale predecessor and /verify reports a chain break.
  try { const last = db.prepare(`SELECT hash FROM events ORDER BY seq DESC LIMIT 1`).get(); if (last?.hash) S.prev = last.hash; } catch {}
})();

// path scope overlap: "src/api/**" overlaps "src/api/auth/**"
const pre = (p) => String(p).replace(/\*+$/, '');
const overlap = (a = [], b = []) => a.some((x) => b.some((y) => pre(x).startsWith(pre(y)) || pre(y).startsWith(pre(x))));
const meet = (a = [], b = []) => {
  const setB = new Set(b.map(String));
  return a.map(String).filter((x) => setB.has(x));
};
const normStrs = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 50) : []);

function validateDeclare(p) {
  if (!p || typeof p.goal !== 'string' || !p.goal.trim()) return 'goal (non-empty string) is required';
  if (!Array.isArray(p.paths) || !p.paths.length) return 'paths (non-empty array) is required';
  if (p.effect && !['none', 'additive', 'breaking'].includes(p.effect)) return 'effect must be none|additive|breaking';
  if (p.services && !Array.isArray(p.services)) return 'services must be an array (e.g. ["port:3000","db:shared"])';
  if (p.symbols && !Array.isArray(p.symbols)) return 'symbols must be an array of function/class ids';
  return null;
}

function emit(actor, kind, payload) {
  const e = { seq: ++S.seq, t: Date.now(), hlc: hlc(), epoch: S.epoch, actor, kind, payload, prev: S.prev };
  e.hash = hashOf(e);
  S.prev = e.hash; log.push(e);
  // The DB insert is the durable write. If it fails we must NOT pretend the
  // event happened: a silently-lost event breaks the hash chain vs. the JSONL
  // mirror. Record the failure loudly instead of swallowing it.
  try { dbAppendEvent(db, e); metricIncr(db, `events:${kind}`); metricIncr(db, 'events:total'); }
  catch (err) {
    try { appendFileSync(`${DIR}/hub.log`, JSON.stringify({ t: Date.now(), level: 'error', msg: 'event append failed', seq: e.seq, kind, error: String(err && err.message) }) + '\n'); } catch {}
  }
  try { appendFileSync(`${DIR}/events.jsonl`, JSON.stringify(e) + '\n'); } catch { /* disk full? SQLite still holds it */ }
  reduce(e); renderContexts();
  // SSE frame carries the event id so a reconnecting client can resume with
  // Last-Event-ID. Slow consumers are dropped rather than allowed to grow the
  // hub's heap without bound.
  const frame = `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
  for (const s of subs) {
    try {
      if (s.writableLength > 4 * 1024 * 1024) { try { s.destroy(); } catch {} subs.delete(s); continue; }
      s.write(frame);
    } catch { subs.delete(s); }
  }
  return e;
}
// access log with rotation (best-effort; never breaks a request)
function accessLog(method, url, status, ms) {
  try {
    const f = `${DIR}/hub.log`;
    try { if (statSync(f).size > 5 * 1024 * 1024) { try { renameSync(f, f + '.1'); } catch {} } } catch {}
    appendFileSync(f, JSON.stringify({ t: Date.now(), method, url: String(url).slice(0, 200), status, ms }) + '\n');
  } catch {}
}
// per-actor write guard: 429 past RATE_LIMIT/min (DoS guard; behavior policing stays in bus)
function checkRate(actor) {
  const now = Date.now();
  const b = (rates.get(actor) || []).filter((t) => now - t < 60000);
  b.push(now);
  rates.set(actor, b);
  return b.length > RATE_LIMIT ? { limited: true, retryAfter: Math.ceil((b[0] + 60000 - now) / 1000) } : { limited: false };
}
// capability auth: enforced automatically once keys exist (mesh up) or MESH_AUTH=1.
// Reads stay open (canvas works); every POST needs a token bound to its actor+scope.
function checkAuth(req, actor, scope) {
  // Cache the verified token on the request so later handlers can make
  // additional scope decisions (e.g. "may this actor take a hard lease?")
  // without re-verifying the signature.
  req._mesh = req._mesh || { scopes: [] };
  if (!authEnforced(DIR)) { req._mesh.scopes = ['*']; return null; }
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.headers['x-mesh-token'] ? String(req.headers['x-mesh-token']) : '');
  if (!tok) return { ok: false, error: 'auth required: set Authorization: Bearer <token> (mesh token <actor>)' };
  let pub;
  try { pub = readPub(DIR); } catch { return { ok: false, error: 'hub keys missing' }; }
  const v = verifyToken(pub, tok, Date.now(), { dir: DIR });
  if (!v.ok) return v;
  if (v.actor !== actor) return { ok: false, error: `token is for ${v.actor}, not ${actor}` };
  if (!scopeAllows(v.scope, scope)) return { ok: false, error: `token lacks scope ${scope}` };
  req._mesh.scopes = Array.isArray(v.scope) ? v.scope : [String(v.scope)];
  req._mesh.actor = v.actor;
  req._mesh.jti = v.jti;
  return null;
}

function reduce(e, replay = false) {
  const p = e.payload;
  if (e.kind === 'intent.declared') S.intents[p.id] = { ...p, actor: e.actor, expires: e.t + TTL };
  if (e.kind === 'intent.released') delete S.intents[p.id];
  if (e.kind === 'presence') {
    S.presence[e.actor] = { ...p, seen: e.t };
    for (const i of Object.values(S.intents)) if (i.actor === e.actor) i.expires = e.t + TTL;
  }
  if (!replay) void 0;
}
const live = () => {
  const now = Date.now();
  return Object.values(S.intents).filter((i) => i.expires > now);
};

function tell(to, tier, say) {
  const q = (S.inbox[to] ||= []);
  const key = hashOf({ tier, say });
  if (q.some((m) => m.key === key)) return; // content-hash dedupe
  q.push({ tier, say, key, t: Date.now() });
  while (q.length > INBOX_CAP) q.shift();
}

// Tier 1 interrupt (blocking/drift), Tier 2 digest, else ambient (canvas only)
function route(e) {
  if (e.kind !== 'intent.declared') return { blocked: false };
  const mine = e.payload;
  for (const other of live().filter((i) => i.actor !== e.actor)) {
    const shared = meet(mine.contracts, other.uses);
    const drift = mine.effect === 'breaking' && shared.length > 0;
    const clash = overlap(mine.paths, other.paths);
    const symHit = meet(mine.symbols || [], other.symbols || []).length > 0;
    const svcHit = meet(mine.services || [], other.services || []).length > 0;
    if (drift) {
      tell(other.actor, 1, `BREAKING: ${shared.join(', ')} is being changed by ${e.actor} (intent ${mine.id}: ${mine.goal}).`);
      tell(e.actor, 2, `${other.actor} still uses ${shared.join(', ')}; keep the old version until they migrate.`);
    } else if (svcHit) {
      tell(e.actor, 1, `SERVICE OVERLAP: ${(mine.services || []).filter((s) => (other.services || []).includes(s)).join(', ')} claimed by ${other.actor} (intent ${other.id}) — pick another port or share via the mesh.`);
      tell(other.actor, 2, `${e.actor} is claiming a service you use: ${mine.goal}`);
    } else if (symHit) {
      tell(e.actor, 1, `SYMBOL LEASE: ${meet(mine.symbols || [], other.symbols || []).join(', ')} also declared by ${other.actor} (intent ${other.id}).`);
    } else if (clash) {
      // Hard-lease block is enforced by the caller before emit; here we only warn for soft overlap.
      tell(e.actor, 1, `OVERLAP: ${other.actor} already holds ${other.paths.join(', ')} (intent ${other.id}).`);
      tell(other.actor, 2, `${e.actor} is starting work near ${mine.paths.join(', ')}.`);
    }
  }
  return { blocked: false };
}

function sheet(actor) {
  const me = live().filter((i) => i.actor === actor);
  const others = live().filter((i) => i.actor !== actor);
  const uses = me.flatMap((i) => i.uses || []);
  const pending = others.filter((i) => i.effect === 'breaking' && meet(i.contracts, uses).length > 0);
  const lines = [
    `<!-- mesh v${S.seq} · actor ${actor} · epoch ${S.epoch} -->`,
    '## My work',
    ...(me.length ? me.map((i) => `- Intent ${i.id}: ${i.goal} (lease ${i.paths.join(', ')})`) : ['- (no active intent)']),
    '## Contracts I use',
    ...(pending.length
      ? pending.map((i) => `- ${meet(i.contracts, uses).join(', ')} PROPOSED CHANGE (breaking) by ${i.actor}, intent ${i.id}`)
      : ['- no pending changes']),
    ...(me.some((i) => (i.services || []).length) ? [`## Services I claim`, ...me.filter((i) => (i.services || []).length).map((i) => `- ${i.id}: ${(i.services || []).join(', ')}`)] : []),
    '## Near me',
    ...(others.length ? others.map((i) => `- ${i.actor}: ${i.goal} (${i.paths.join(', ')})`) : ['- nobody']),
    '',
  ];
  let out = lines.join('\n');
  if (out.length > SHEET_BUDGET_CHARS) out = out.slice(0, SHEET_BUDGET_CHARS) + '\n<!-- truncated: budget 800 tokens -->\n';
  return out;
}

function renderContexts() {
  const actors = new Set([...Object.keys(S.presence), ...Object.values(S.intents).map((i) => i.actor), ...Object.keys(S.inbox)]);
  for (const a of actors) {
    try {
      const f = `${DIR}/context/${a}.md`;
      atomicWrite(f, sheet(a));
    } catch { /* read-only fs? skip */ }
  }
}

// background sweeper: expire leases, re-render so stale leases vanish
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, i] of Object.entries(S.intents)) {
    if (i.expires <= now) { delete S.intents[id]; changed = true; }
  }
  for (const [a, p] of Object.entries(S.presence)) {
    if (now - p.seen > 15_000) S.presence[a] = { ...p, away: true };
  }
  voiceSweep(voice.peers, voice.mail, now);
  if (changed) renderContexts();
}, 10_000).unref();

// SSE keep-alive: idle proxies (nginx 60s, Cloudflare) drop a silent stream.
// A comment frame every 25s keeps the connection alive without polluting the
// event log.
setInterval(() => {
  for (const s of subs) { try { s.write(`: ping ${Date.now()}\n\n`); } catch { subs.delete(s); } }
}, 25_000).unref();

// WAL checkpoint: without a periodic checkpoint the -wal file grows without
// bound during a long-running hub (it was only truncated at shutdown).
setInterval(() => { try { dbCheckpoint(db); } catch {} }, 60_000).unref();

const readBody = (req, res) => new Promise((resolve) => {
  let b = '', tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return; // drain-discard the rest so the client can still read the 413
    b += c;
    if (b.length > BODY_LIMIT) {
      tooBig = true;
      try { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'body > 1MB' })); } catch {}
      resolve(null);
      req.resume(); // keep the socket healthy; no RST race with undici
    }
  });
  req.on('end', () => {
    if (tooBig) return resolve(null);
    try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({ __badJson: true }); }
  });
});
const body = readBody;

// decode query params of a raw request url ('/api/tasks?owner=x' -> {owner:'x'})
const urlParams = (raw) => {
  try {
    const i = String(raw).indexOf('?');
    return i < 0 ? {} : Object.fromEntries(new URLSearchParams(String(raw).slice(i + 1)));
  } catch { return {}; }
};

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Mesh-Actor, X-Mesh-Token');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const json = (o, c = 200) => {
      try {
        res.writeHead(c, { 'content-type': 'application/json', 'x-mesh-seq': String(S.seq), 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify(o));
      } catch {}
      accessLog(req.method, req.url, c, Date.now() - t0);
    };
    const guard = (actor, scope) => {
      if (!actor || typeof actor !== 'string') { json({ ok: false, error: 'actor (string) is required' }, 400); return false; }
      const a = checkAuth(req, actor, scope);
      if (a) { json(a, /lacks scope|not /.test(a.error) ? 403 : 401); return false; }
      const r = checkRate(actor);
      if (r.limited) {
        try { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(r.retryAfter) }); res.end(JSON.stringify({ ok: false, error: 'rate limited: 100 writes/min', retryAfter: r.retryAfter })); } catch {}
        accessLog(req.method, req.url, 429, Date.now() - t0);
        return false;
      }
      return true;
    };
    const [, route0, who] = (req.url || '/').split('/');
    try {
      if (req.method === 'POST' && route0 === 'cmd') {
        const p = await readBody(req, res);
        if (!p) return; // 413 already sent
        if (p.__badJson) return json({ ok: false, error: 'invalid JSON' }, 400);
        const { actor, kind, payload } = p;
        if (kind === 'intent.declare') {
          if (!guard(actor, 'intent.declare')) return;
          const err = validateDeclare(payload);
          if (err) return json({ ok: false, error: err }, 400);
          const paths = normStrs(payload.paths);
          const contracts = normStrs(payload.contracts);
          const uses = normStrs(payload.uses);
          const services = normStrs(payload.services);
          const symbols = normStrs(payload.symbols);
          // A hard lease blocks every peer that touches the scope, so it is a
          // denial-of-service lever. It requires an explicit capability scope
          // when auth is enforced. (Unauthenticated dev mode keeps the old
          // behaviour so local single-user flows are unaffected.)
          const wantsHard = payload.hard === true;
          if (wantsHard && !scopeAllows(req._mesh?.scopes || [], 'lease.hard'))
            return json({ ok: false, error: 'token lacks scope lease.hard' }, 403);
          // Boundary enforcement: hard lease blocks overlapping writes
          const blocker = live().find((i) => i.hard && i.actor !== actor && (overlap(paths, i.paths) || meet(services, i.services || []).length > 0));
          if (blocker) {
            emit(actor, 'policy.denied', { reason: 'hard-lease', by: blocker.actor, intent: blocker.id });
            return json({ ok: false, error: `blocked by hard lease of ${blocker.actor} (intent ${blocker.id})`, tier: 0 }, 409);
          }
          // The id is SERVER-ASSIGNED. It used to be spread from the client
          // payload AFTER the server id, so a caller could overwrite another
          // actor's intent entry (paths, hard flag and all) — a cross-actor
          // lease hijack. The server id now always wins.
          const id = `in-${S.seq + 1}`;
          const e = emit(actor, 'intent.declared', {
            ...payload,
            id,
            effect: payload.effect || 'none',
            paths, contracts, uses, services, symbols,
            hard: wantsHard,
          });
          route(e);
          return json({ ok: true, intent: id, seq: e.seq });
        }
        if (kind === 'intent.release') {
          if (!guard(actor, 'intent.release')) return;
          if (!payload?.id) return json({ ok: false, error: 'id is required' }, 400);
          emit(actor, 'intent.released', { id: String(payload.id) });
          return json({ ok: true });
        }
        if (kind === 'presence') {
          if (!guard(actor, 'presence')) return;
          emit(actor, 'presence', payload || {}); return json({ ok: true });
        }
        return json({ ok: false, error: 'unknown command' }, 400);
      }
      if (route0 === 'inbox') {
        const q = (S.inbox[who] || []).splice(0);
        const text = q.map((m) => `[tier ${m.tier}] ${m.say}\n`).join('');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(text.slice(0, DELTA_BUDGET_CHARS));
        return;
      }
      if (route0 === 'context') { res.writeHead(200, { 'content-type': 'text/markdown' }); res.end(sheet(who)); return; }
      if (!route0 || route0 === 'canvas' || route0 === 'index.html') {
        try {
          const siteFile = join(HERE, '..', 'site', 'index.html');
          const fileToRead = existsSync(siteFile) ? siteFile : join(HERE, 'canvas.html');
          const html = readFileSync(fileToRead, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(html);
        } catch { res.writeHead(404).end(); }
        return;
      }
      if (['style.css', 'app.js', 'board-tldraw.js', 'manifest.webmanifest', 'sw.js'].includes(route0)) {
        try {
          const f = join(HERE, '..', 'site', route0);
          const ctype = route0.endsWith('.css') ? 'text/css' : route0.endsWith('.js') ? 'application/javascript' : 'application/manifest+json';
          const content = readFileSync(f, 'utf8');
          res.writeHead(200, { 'content-type': ctype });
          res.end(content);
        } catch { res.writeHead(404).end(); }
        return;
      }
      if (route0 === 'a2a') {
        if (who === 'agent-card.json') {
          return json(generateAgentCard(`http://${req.headers.host || 'localhost:' + PORT}`));
        }
        if (who === 'rpc' && req.method === 'POST') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          // A2A is a peer-to-peer surface, so it is authenticated like any other
          // write path. Mutating methods are bound to the acting agent; read
          // methods only need a valid capability token.
          const MUTATING = new Set(['agent.macp.propose']);
          if (MUTATING.has(p.method)) {
            if (!guard(p.params?.actor, 'macp')) return;
          } else if (authEnforced(DIR)) {
            const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            let pub = null; try { pub = readPub(DIR); } catch {}
            const v = pub ? verifyToken(pub, tok, Date.now(), { dir: DIR }) : { ok: false, error: 'hub keys missing' };
            if (!v.ok) return json({ ok: false, error: v.error || 'auth required' }, 401);
          }
          const r = handleA2ARpc(p, { macpKernel, crdtDoc, merkleDag, hubState: { roster: loadCollab(DIR).roster, intents: live(), seq: S.seq } });
          return json(r);
        }
      }
      if (route0 === 'health') return json({ ok: true, seq: S.seq, epoch: S.epoch, intents: live().length });
      if (route0 === 'state') {
        let trunk = null, contracts = 0, lanes = 0, collab = null;
        try { trunk = JSON.parse(readFileSync(`${DIR}/queue.json`, 'utf8')).trunk; } catch {}
        try { contracts = Object.keys(JSON.parse(readFileSync(`${DIR}/contracts.json`, 'utf8')).nodes || {}).length; } catch {}
        try { lanes = Object.keys(JSON.parse(readFileSync(`${DIR}/lanes.json`, 'utf8')).lanes || {}).length; } catch {}
        try { collab = JSON.parse(readFileSync(`${DIR}/collab.json`, 'utf8')); } catch {}
        const roster = collab ? Object.values(collab.roster || {}).map((r) => ({ actor: r.actor, role: r.role, avail: r.avail, skills: r.skills })) : [];
        const openReqs = collab ? (collab.requests || []).filter((r) => r.status === 'queued').length : 0;
        const decisions = collab ? (collab.decisions || []).slice(-5) : [];
        return json({ ok: true, seq: S.seq, prev: S.prev, trunk, contracts, lanes, roster, openReqs, decisions, intents: live(), presence: S.presence });
      }
      if (route0 === 'verify') return json(dbVerify(db, hashOf));
      if (route0 === 'metrics') {
        const byKind = metricAll(db);
        let ttfc = null;
        try { ttfc = kvGet(db, 'ttfc_ms') ? Math.round(+kvGet(db, 'ttfc_ms') / 1000) : null; } catch {}
        return json({
          ok: true, uptime_s: Math.floor((Date.now() - BOOT_T) / 1000),
          events_total: byKind['events:total'] || log.length,
          by_kind: Object.fromEntries(Object.entries(byKind).filter(([k]) => k.startsWith('events:') && k !== 'events:total')),
          presence: Object.keys(S.presence).length,
          inbox_depth: Object.values(S.inbox).reduce((n, q) => n + q.length, 0),
          auth: authEnforced(DIR) ? 'enforced' : 'open',
          ttfc_s: ttfc,
          tasks: taskStats(DIR),
          conductor: botStatus(DIR).name,
        });
      }
      if (route0 === 'ready') {
        let diskFreeMB = null;
        try { const st = statfsSync(DIR); diskFreeMB = Math.floor(st.bfree * st.bsize / 1048576); } catch {}
        return json({ ok: true, ready: true, seq: S.seq, epoch: S.epoch, db: existsSync(`${DIR}/mesh.db`), diskFreeMB });
      }
      if (route0 === 'events') {
        // SSE is a read stream but it carries intent paths, task text and pin
        // text, so it is authenticated when auth is enforced. EventSource cannot
        // set headers, so the token may also be passed as ?token=.
        if (authEnforced(DIR)) {
          const q = new URL(req.url || '/', 'http://x');
          const t = q.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
          let pub; try { pub = readPub(DIR); } catch { pub = null; }
          const v = pub ? verifyToken(pub, t, Date.now(), { dir: DIR }) : { ok: false };
          if (!v.ok) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'auth required for /events' })); return; }
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        subs.add(res);
        // Resume support: the browser sends Last-Event-ID on reconnect.
        const lastId = +(req.headers['last-event-id'] || 0);
        if (lastId > 0) {
          try {
            for (const e of dbEventsSince(db, lastId, 500))
              res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          } catch {}
        }
        res.write(`: connected seq=${S.seq}\n\n`);
        req.on('close', () => subs.delete(res));
        return;
      }
      // ---- UI API: one poll for every client (canvas, TUI, extension) ----
      if (route0 === 'api') {
        const parts = ((req.url || '/').split('?')[0]).split('/').filter(Boolean).slice(1);
        const api = parts.join('-'); // /api/board/op -> board-op, /api/overview -> overview
        const read = (f, fb) => { try { return JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')); } catch { return fb; } };
        if (req.method === 'GET' && api === 'overview') {
          const liveIntents = live();
          const collisions = [];
          for (let i = 0; i < liveIntents.length; i++) for (let j = i + 1; j < liveIntents.length; j++) {
            const g = forecast(scopeOfIntent(liveIntents[i]), scopeOfIntent(liveIntents[j]));
            if (g !== 'none') collisions.push({ a: liveIntents[i].actor, b: liveIntents[j].actor, grade: g });
          }
          const q = read('queue.json', { trunk: 't0', queued: [], landed: [], quarantined: [] });
          const reg = read('contracts.json', { nodes: {} });
          const lanes = read('lanes.json', { lanes: {}, frozen: false, trunk: 't0' });
          const col = read('collab.json', { roster: {}, requests: [], pins: [], decisions: [], pairs: [] });
          const board = read('board.json', { shapes: {}, seq: 0 });
          return json({
            ok: true, seq: S.seq, epoch: S.epoch, trunk: q.trunk,
            board: { shapes: Object.keys(board.shapes || {}).length, seq: board.seq || 0 },
            voice: Object.values(voice.peers).map((p) => ({ actor: p.actor, muted: p.muted })),
            queue: { queued: q.queued.length, landed: q.landed.length, quarantined: q.quarantined.length, items: q.queued.slice(0, 10) },
            contracts: Object.values(reg.nodes || {}).map((n) => ({ id: n.id, status: n.status, diff: n.proposed_by?.diff || null, lane: n.proposed_by?.lane || null })),
            lanes: Object.entries(lanes.lanes || {}).map(([a, l]) => ({ actor: a, head: l.head, snaps: (l.snaps || []).length })),
            frozen: !!lanes.frozen,
            roster: Object.values(col.roster || {}).map((r) => ({ actor: r.actor, role: r.role, avail: r.avail, skills: r.skills || [] })),
            requests: (col.requests || []).slice(-10),
            openReqs: (col.requests || []).filter((r) => r.status === 'queued'),
            pins: (col.pins || []).slice(-10),
            decisions: (col.decisions || []).slice(-5),
            pairs: (col.pairs || []).filter((p) => p.active),
            tasks: taskStats(DIR),
            conductor: botStatus(DIR).name,
            repos: S.repos,
            collisions, intents: liveIntents, presence: S.presence,
             buildStatus: S.buildStatus,
           });
        }
        if (req.method === 'GET' && api === 'events') {
          const m = (req.url || '').match(/limit=(\d+)/);
          const n = Math.min(+(m?.[1] || 100), 500);
          return json({ ok: true, events: log.slice(-n) });
        }
        if (req.method === 'GET' && api === 'approvals') {
          const m = (req.url || '').match(/owner=([^&]+)/);
          return json({ ok: true, inbox: inboxFor(DIR, m?.[1] ? decodeURIComponent(m[1]) : 'human') });
        }
        if (req.method === 'POST' && api === 'request') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor, to, text, ref } = p;
          if (!guard(actor, 'request')) return;
          if (!to || !text) return json({ ok: false, error: 'to, text required' }, 400);
          const r = createRequest(DIR, { from: actor, to, text, ref });
          emit(actor, 'request.created', { id: r.id, to, text: r.text, status: r.status });
          // TTFC (time-to-first-collaboration): first request between two DISTINCT actors.
          try { if (!kvGet(db, 'ttfc_ms')) kvSet(db, 'ttfc_ms', String(Date.now() - BOOT_T)); } catch {}
          return json({ ok: true, ...r });
        }
        if (req.method === 'POST' && api === 'request-respond') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor, id, accept, reason } = p;
          if (!guard(actor, 'request')) return;
          const r = respondRequest(DIR, { id, by: actor, accept: !!accept, reason: reason || '' });
          if (!r.ok) return json(r, 400);
          emit(actor, accept ? 'request.accepted' : 'request.declined', { id });
          return json(r);
        }
        if (req.method === 'POST' && api === 'pin') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor, node, text } = p;
          if (!guard(actor, 'pin')) return;
          if (!node || !text) return json({ ok: false, error: 'node, text required' }, 400);
          const pin = addPin(DIR, { actor, node, text });
          emit(actor, 'message.posted', { say: `pin on ${node}`, refs: [node] });
          return json({ ok: true, ...pin });
        }
        if (req.method === 'POST' && api === 'decision') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor, topic, decision } = p;
          if (!guard(actor, 'decision')) return;
          if (!topic || !decision) return json({ ok: false, error: 'topic, decision required' }, 400);
          const d = recordDecision(DIR, { actor, topic, decision });
          emit(actor, 'message.posted', { say: `${topic}: ${decision}` });
          return json({ ok: true, ...d });
        }
        if (req.method === 'GET' && api === 'collab') return json({ ok: true, ...loadCollab(DIR) });
        // ---- shared board: ops sync every client live via board.op SSE ----
        if (req.method === 'GET' && api === 'board') return json({ ok: true, ...loadBoard(DIR) });
        if (req.method === 'GET' && api === 'board-export') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="mesh-board.tldraw.json"' });
          res.end(JSON.stringify(exportTldraw(DIR)));
          return;
        }
        if (req.method === 'POST' && api === 'board-op') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor, op } = p;
          if (!guard(actor, 'board')) return;
          if (!op) return json({ ok: false, error: 'op required' }, 400);
          const r = applyBoardOp(DIR, actor, op);
          if (!r.ok) return json(r, 400);
          emit(actor, 'board.op', { op: op.op, id: r.shape?.id || r.id || null, seq: r.seq });
          return json(r);
        }
        if (req.method === 'POST' && api === 'board-import') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor, doc } = p;
          if (!guard(actor, 'board')) return;
          if (!doc) return json({ ok: false, error: 'doc required' }, 400);
          const r = importTldraw(DIR, actor, doc);
          emit(actor, 'board.op', { op: 'import', added: r.added });
          return json(r);
        }
        // ---- liveblocks-auth stub: cloud presence opt-in, hub ops are default ----
        // Client calls this only in ?board=tldraw cloud mode. Empty key =
        // { ok:false, fallback:"hub" } so the board keeps working on LAN.
        if (api === 'liveblocks-auth') {
          const key = process.env.LIVEBLOCKS_SECRET_KEY || '';
          if (!key) return json({ ok: false, fallback: 'hub', hint: 'Set LIVEBLOCKS_SECRET_KEY to enable cloud presence; hub ops work without it.' });
          if (req.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);
          // Full Liveblocks token mint needs the @liveblocks/node SDK (not a
          // zero-dep). Return capability descriptor so the client can decide.
          return json({ ok: true, mode: 'bring-your-token', hint: 'POST {room, user} with a Liveblocks secret to mint here after adding @liveblocks/node.' });
        }
        // ---- voice: signaling-only; media stays P2P between browsers ----
        if (req.method === 'POST' && api === 'voice-join') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor, name, muted } = p;
          if (!guard(actor, 'voice')) return;
          return json(voiceJoin(voice.peers, actor, { name, muted }));
        }
        if (req.method === 'POST' && api === 'voice-leave') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor } = p;
          if (!guard(actor, 'voice')) return;
          return json(voiceLeave(voice.peers, voice.mail, actor));
        }
        if (req.method === 'POST' && api === 'voice-hb') {
          const p = await readBody(req, res);
          if (!p) return;
          if (p.__badJson) return json({ ok: false, error: 'invalid JSON' }, 400);
          if (!p.actor) return json({ ok: false, error: 'actor required' }, 400);
          if (!guard(p.actor, 'voice')) return;
          voiceHeartbeat(voice.peers, p.actor);
          return json({ ok: true });
        }
        if (req.method === 'POST' && api === 'voice-signal') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          if (!guard(p.from, 'voice')) return;
          const r = voiceSignal(voice.mail, voice.peers, p);
          return json(r.ok ? r : r, r.ok ? 200 : 400);
        }
        if (req.method === 'GET' && api === 'voice-signal') {
          const m = (req.url || '').match(/actor=([^&]+)/);
          const actor = m?.[1] ? decodeURIComponent(m[1]) : null;
          if (!actor) return json({ ok: false, error: 'actor required' }, 400);
          // Draining another actor's signaling mailbox has a side effect.
          if (!guard(actor, 'voice')) return;
          voiceHeartbeat(voice.peers, actor);
          return json({ ok: true, signals: voiceDrain(voice.mail, actor), peers: Object.keys(voice.peers) });
        }
        // ---- build gate: block until every connected agent reports done ----
        if (req.method === 'POST' && api === 'build-status') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor, done, note } = p;
          if (!guard(actor, 'build')) return;
          S.buildStatus[actor] = { done: !!done, note: String(note || ''), ts: Date.now() };
          emit(actor, 'build.status', { done: !!done, note: String(note || '') });
          return json({ ok: true });
        }
        if (req.method === 'POST' && api === 'build-gate') {
          const p = await readBody(req, res);
          if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
          const { actor, timeout } = p;
          if (!guard(actor, 'build')) return;
          const deadline = Date.now() + Math.min(+(timeout || 60000), 120000);
          const connected = () => Object.keys(S.presence).filter((a) => Date.now() - (S.presence[a].seen || 0) < 15000);
          while (Date.now() < deadline) {
            const agents = connected();
            const allDone = agents.length > 0 && agents.every((a) => S.buildStatus[a]?.done);
            if (allDone) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          const agents = connected();
          const statuses = agents.map((a) => ({ actor: a, done: !!S.buildStatus[a]?.done, note: S.buildStatus[a]?.note || '', ts: S.buildStatus[a]?.ts || null }));
          const timedOut = !agents.every((a) => S.buildStatus[a]?.done);
          const abort = statuses.some((s) => !s.done);
          return json({ ok: !abort, abort, timedOut, agents: statuses });
        }
        if (req.method === 'GET' && api === 'build-status') {
          return json({ ok: true, statuses: S.buildStatus });
        }
        // ---- Next-Gen Synchronization API (CRDT, MACP, DAG, P2P) ----
        if (api === 'crdt') {
          if (req.method === 'GET') return json({ ok: true, ...crdtDoc.toJSON() });
          if (req.method === 'POST') {
            const p = await readBody(req, res);
            if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
            if (!guard(p.actor, 'crdt')) return;
            if (p.action === 'set' && p.key && p.actor) {
              const resu = crdtDoc.setSymbol(p.key, p.value, p.actor);
              emit(p.actor, 'crdt.symbol_updated', { key: p.key, value: p.value, lamport: resu.op.lamport });
              return json({ ok: true, ...resu });
            }
            if (p.action === 'delta' && p.delta) {
              const resu = crdtDoc.applyDelta(p.delta);
              return json({ ok: true, ...resu });
            }
            return json({ ok: false, error: 'action (set|delta) required' }, 400);
          }
        }
        if (api === 'macp') {
          if (req.method === 'GET') {
            const m = (req.url || '').match(/mode=([^&]+)/);
            return json({ ok: true, sessions: macpKernel.listSessions(m ? { mode: m[1] } : {}) });
          }
          if (req.method === 'POST') {
            const p = await readBody(req, res);
            if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
            if (!guard(p.actor || p.initiator, 'macp')) return;
            if (p.action === 'create') {
              const sess = macpKernel.createSession({ ...p, mode: p.mode || 'proposal' });
              emit(p.initiator || 'anonymous', 'macp.session_created', { id: sess.id, mode: sess.mode });
              return json({ ok: true, session: sess.toJSON() });
            }
            if (p.action === 'vote' && p.id && p.actor) {
              const sess = macpKernel.getSession(p.id);
              if (!sess) return json({ ok: false, error: 'session not found' }, 404);
              sess.castVote(p.actor, p.vote, p.weight || 1, p.rationale || '');
              macpKernel.save();
              emit(p.actor, 'macp.vote_cast', { id: p.id, vote: p.vote });
              return json({ ok: true, session: sess.toJSON() });
            }
            if (p.action === 'negotiate' && p.id && p.actor) {
              const sess = macpKernel.getSession(p.id);
              if (!sess) return json({ ok: false, error: 'session not found' }, 404);
              sess.advanceNegotiation(p.actor, p.proposal || {});
              macpKernel.save();
              emit(p.actor, 'macp.negotiation_advanced', { id: p.id, round: sess.data.rounds?.length });
              return json({ ok: true, session: sess.toJSON() });
            }
            return json({ ok: false, error: 'action (create|vote|negotiate) required' }, 400);
          }
        }
        if (api === 'dag') {
          if (req.method === 'GET') return json({ ok: true, ...merkleDag.syncDiff() });
          if (req.method === 'POST') {
            const p = await readBody(req, res);
            if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
            if (!guard(p.actor, 'dag')) return;
            if (p.action === 'append' && p.actor && p.kind) {
              const node = merkleDag.append(p.actor, p.kind, p.payload, p.parents, p.metadata);
              return json({ ok: true, node: node.toJSON(), rootHash: merkleDag.getRootHash() });
            }
            if (p.action === 'merge' && Array.isArray(p.nodes)) {
              return json({ ok: true, ...merkleDag.mergeNodes(p.nodes) });
            }
            return json({ ok: false, error: 'action (append|merge) required' }, 400);
          }
        }
        if (api === 'p2p') {
          if (req.method === 'GET') {
            const m = (req.url || '').match(/actor=([^&]+)/);
            const actor = m?.[1] ? decodeURIComponent(m[1]) : null;
            // Draining another actor's signaling mailbox is a read that has a
            // side effect, so it is scoped like the write it mirrors.
            if (actor && !guard(actor, 'p2p')) return;
            if (actor) return json({ ok: true, signals: p2pSwarm.drainSignals(actor) });
            return json({ ok: true, peers: p2pSwarm.listPeers() });
          }
          if (req.method === 'POST') {
            const p = await readBody(req, res);
            if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
            if (!guard(p.actor || p.from, 'p2p')) return;
            if (p.action === 'join' && p.actor) return json(p2pSwarm.join(p.actor, p.metadata || {}));
            if (p.action === 'leave' && p.actor) return json(p2pSwarm.leave(p.actor));
            if (p.action === 'signal' && p.from && p.to && p.type) return json(p2pSwarm.sendSignal(p.from, p.to, p.type, p.data));
            return json({ ok: false, error: 'action (join|leave|signal) required' }, 400);
          }
        }
        // ---- P3: shared task board (atomic claims; single-threaded reduce) ----
        if (api === 'tasks') {
          if (req.method === 'GET') {
            const q = urlParams(req.url);
            return json({ ok: true, tasks: listTasks(DIR, { owner: q.owner || '', status: q.status || '', repo: q.repo || '' }), stats: taskStats(DIR) });
          }
          if (req.method === 'POST') {
            const p = await readBody(req, res);
            if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
            const { actor, action, id, title, paths, deps, status, note, wip } = p;
            if (!guard(actor, 'tasks')) return;
            if (action === 'create') {
              const r = createTask(DIR, { title, by: actor, paths, deps, repo: p.repo || '' });
              if (!r.ok) return json(r, 400);
              emit(actor, 'task.created', { id: r.task.id, title: r.task.title, paths: r.task.paths });
              return json(r);
            }
            if (action === 'claim') {
              const r = claimTask(DIR, { id, actor, wip: +wip || 2 });
              if (!r.ok) return json(r, 409);
              emit(actor, 'task.claimed', { id, actor });
              return json(r);
            }
            if (action === 'set') {
              const r = setTask(DIR, { id, actor, status, note });
              if (!r.ok) return json(r, 400);
              emit(actor, `task.${status}`, { id, actor, note: r.task?.note || '' });
              return json(r);
            }
            return json({ ok: false, error: 'action (create|claim|set) required' }, 400);
          }
        }
        // ---- P1: the Conductor (our first-class bot) ----
        if (api === 'bot') {
          if (req.method === 'GET') return json(botStatus(DIR));
          if (req.method === 'POST') {
            const p = await readBody(req, res);
            if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
            const { actor, goal, dry, tasksInput, budgetCoins, budgetMin, spawner } = p;
            if (!guard(actor, 'bot')) return;
            if (!goal) return json({ ok: false, error: 'goal required' }, 400);
            // live CLIs stay an operator choice (policy); hub-level runs are dry by default
            const r = await runBot(DIR, { goal, dry: !(dry === false && process.env.MESH_BOT_LIVE === '1'), tasksInput, budgetCoins: +budgetCoins || 20, budgetMin: +budgetMin || 10, ...(typeof spawner === 'string' ? { spawnerName: spawner } : {}) });
            emit(actor, r.ok ? 'bot.run_done' : 'bot.run_failed', { id: r.run?.id, status: r.run?.status, error: r.error || null });
            return json(r);
          }
        }
        // ---- P6: verifiable audit export (hash chain + merkle root) ----
        if (api === 'memory') {
          const p0 = urlParams(req.url);
          if (req.method === 'GET') {
            const actor = p0.actor ? decodeURIComponent(p0.actor) : 'system';
            if (!guard(actor, 'memory')) return;
            try { const { memoryGet } = await import('./bot.mjs'); const md = memoryGet(DIR, p0.key || ''); return json({ ok: true, key: p0.key || null, memory: md }); }
            catch (e) { return json({ ok: false, error: String(e?.message || e) }, 500); }
          }
          if (req.method === 'POST') {
            const p = await readBody(req, res);
            if (!p || p.__badJson) return p ? json({ ok: false, error: 'invalid JSON' }, 400) : undefined;
            if (!guard(p.actor, 'memory')) return;
            if (!p.text) return json({ ok: false, error: 'text required' }, 400);
            const { memorySet } = await import('./bot.mjs');
            const r = memorySet(DIR, p.actor, p.text);
            emit(p.actor, 'memory.set', { bytes: r.bytes });
            return json(r);
          }
        }
        // ---- P6: verifiable audit export (hash chain + merkle root) ----
        if (api === 'audit') {
          if (req.method === 'GET') {
            const q = urlParams(req.url);
            if (!guard(q.actor ? decodeURIComponent(q.actor) : 'system', 'audit')) return;
            const from = +(q.from || 0);
            const to = +(q.to || Date.now());
            const a = exportAudit(log, { from, to });
            return json({ ok: true, merkleRoot: a.merkleRoot, summary: a.summary, events: a.events.length, bundle: a });
          }
        }
        return json({ ok: false, error: 'unknown api' }, 404);
      }
      res.writeHead(404).end();
    } catch (e) {
      json({ ok: false, error: String(e?.message || e) }, 500);
    }
  });
  return server;
}

export function closeHub(server) {
  return new Promise((resolve) => {
    try {
      for (const s of subs) { try { s.end(); } catch {} }
      subs.clear();
      server.close(() => { try { dbCheckpoint(db); db.close(); } catch {} resolve(); });
      setTimeout(() => { try { db.close(); } catch {} resolve(); }, 2000).unref();
    } catch { resolve(); }
  });
}

if (process.argv[1] && process.argv[1].endsWith('hub.mjs')) {
  // Fail closed: a hub bound to a non-loopback interface with no capability
  // auth is an open, world-writable coordination API for everyone on the LAN.
  // Previously this only printed a warning, so the shipped Docker image
  // (MESH_HOST=0.0.0.0, no keys) served an unauthenticated hub. Now it
  // refuses to start unless the operator explicitly accepts the risk.
  if (!isLoopbackBind() && !authEnforced(DIR) && process.env.MESH_INSECURE !== '1') {
    console.error([
      '',
      'REFUSING TO START: the hub is bound to a non-loopback interface without auth.',
      '',
      `  MESH_HOST=${HOST}  MESH_DIR=${DIR}`,
      '',
      'A network-reachable AgentMesh hub without capability tokens lets any host',
      'on the network declare intents, take leases, vote and mutate shared state.',
      '',
      'Fix it (pick one):',
      '  1. mesh keygen && mesh token <actor>     # enable ed25519 capability auth',
      '  2. MESH_HOST=127.0.0.1                  # loopback only, tunnel for remote access',
      '  3. MESH_INSECURE=1                      # trusted LAN only — you accept the risk',
      '',
      'See docs/SECURITY.md.',
      '',
    ].join('\n'));
    process.exit(78); // EX_CONFIG
  }
  const server = createServer().listen(PORT, HOST, () => console.error(`hub listening on ${HOST}:${PORT} (dir=${DIR}, auth=${authEnforced(DIR) ? 'enforced' : 'open'})`));
  if (!isLoopbackBind() && !authEnforced(DIR))
    console.error('WARN: hub on a non-loopback interface WITHOUT auth (MESH_INSECURE=1) — see docs/SECURITY.md');
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => { await closeHub(server); process.exit(0); });
  }
}
