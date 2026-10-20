// bridge.mjs — MCP stdio bridge (newline-delimited JSON-RPC 2.0) -> hub HTTP.
// Every tool result is prefixed with a <mesh-delta> header drained from /inbox/<actor>.
//
// Hardening (P0):
//   * JSON-RPC 2.0 compliant: -32700 parse error, -32601 method not found,
//     -32602 invalid params, -32603 internal error.
//   * Tool failures are reported with `isError: true` so an agent can tell a
//     failure from a successful result that happens to contain the word "error".
//   * Every hub call has a timeout — a hung hub can no longer hang the IDE.
//   * `server/discover` is implemented (MCP 2026-07-28 requires it) and the
//     stateless `_meta` version negotiation is echoed for new clients.
import { createInterface } from 'node:readline';

const ACTOR = process.env.MESH_ACTOR || 'agent';
const HUB = (process.env.MESH_HUB || 'http://localhost:7777').replace(/\/$/, '');
const TOKEN = process.env.MESH_TOKEN || '';
const authH = () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});
const HUB_TIMEOUT_MS = +(process.env.MESH_TIMEOUT_MS || 15000);

if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/.test(ACTOR)) {
  console.error(`warn: MESH_ACTOR=${JSON.stringify(ACTOR)} looks unusual; continuing`);
}

// Every hub call goes through here: attaches the capability token and a timeout.
const hubFetch = (url, opts = {}) => fetch(url, {
  ...opts,
  signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || HUB_TIMEOUT_MS),
  headers: { ...authH(), ...(opts.headers || {}) },
});

const post = (kind, payload) =>
  hubFetch(`${HUB}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, kind, payload }) }).then((r) => r.json());
const str = { type: 'string' };
const strs = { type: 'array', items: str };

const TOOLS = {
  mesh_declare_intent: {
    description: 'Declare what you are about to change BEFORE editing. Returns overlap / breaking-change / service / symbol warnings.',
    inputSchema: { type: 'object', required: ['goal', 'paths'], properties: { goal: str, paths: strs, contracts: strs, uses: strs, services: { type: 'array', items: str, description: 'ports/dbs/env this work needs, e.g. ["port:3000","db:shared"]' }, symbols: { type: 'array', items: str, description: 'function/class ids you will touch' }, effect: { enum: ['none', 'additive', 'breaking'] } } },
    run: (a) => post('intent.declare', a),
  },
  mesh_release: {
    description: 'Release an intent when work is proposed or abandoned.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: str } },
    run: (a) => post('intent.release', a),
  },
  mesh_status: {
    description: 'Show your current fact sheet: your work, contracts you use, neighbours.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      await post('presence', { verb: 'reading', focus: '-' }).catch(() => ({}));
      const r = await hubFetch(`${HUB}/context/${ACTOR}`);
      return await r.text();
    },
  },
  mesh_inbox: {
    description: 'Drain unseen Tier-1/Tier-2 messages without touching presence.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await hubFetch(`${HUB}/inbox/${ACTOR}`, { headers: { ...authH() } })).text(),
  },
  mesh_request: {
    description: 'Ask another actor for work (@agent). Lands in owner approval inbox unless trusted; returns status chip.',
    inputSchema: { type: 'object', required: ['to', 'text'], properties: { to: str, text: str, ref: str } },
    run: async (a) => {
      const r = await hubFetch(`${HUB}/api/request`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, to: a.to, text: a.text, ref: a.ref }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? `request ${r.id} → @${a.to}: status ${r.status} (${r.approved === false || r.status === 'queued' ? 'awaiting owner approval' : r.note || 'tracked'}). Chips: queued→working→done/declined.` : `request failed: ${r.error}`;
    },
  },
  mesh_board_post: {
    description: 'Post a sticky to the shared whiteboard (visible to the whole room). Use for proposals too big for chat.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: str, color: str, codeRef: str } },
    run: async (a) => {
      const r = await hubFetch(`${HUB}/api/board/op`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, op: { op: 'add', shape: { type: 'note', x: 80 + Math.floor(Math.random() * 600), y: 80 + Math.floor(Math.random() * 300), text: a.text, color: a.color, codeRef: a.codeRef } } }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? `sticky ${r.shape.id} on the board (seq ${r.seq}).` : `board post failed: ${r.error}`;
    },
  },
  mesh_pin: {
    description: 'Drop a spatial pin on a node/file/contract so owners whose scope touches it get it.',
    inputSchema: { type: 'object', required: ['node', 'text'], properties: { node: str, text: str } },
    run: async (a) => {
      const r = await hubFetch(`${HUB}/api/pin`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, node: a.node, text: a.text }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? `pin ${r.id} on ${a.node} recorded and routed to scope owners.` : `pin failed: ${r.error}`;
    },
  },
  mesh_roster: {
    description: 'List all active agents, their declared scopes, lanes, and active leases across machines.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const r = await hubFetch(`${HUB}/api/overview`, { headers: { ...authH() } }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) return `failed to fetch mesh roster: ${r.error}`;
      const agents = r.presence ? Object.entries(r.presence).map(([id, p]) => `@${id} (focus: ${p.focus || '-'}, verb: ${p.verb || 'active'})`).join(', ') : 'none';
      const intents = (r.intents || []).map((it) => `[${it.id}] @${it.actor} -> ${it.goal} (${it.paths.join(', ')})`).join('\n') || 'none';
      return `CONNECTED PEERS: ${agents}\n\nACTIVE INTENTS & LEASES:\n${intents}`;
    },
  },
  mesh_vote: {
    description: 'Cast a vote in an active MACP decision or quorum session (e.g. approving a contract or trunk merge).',
    inputSchema: { type: 'object', required: ['id', 'vote'], properties: { id: str, vote: str, weight: { type: 'number' }, rationale: str } },
    run: async (a) => {
      const r = await hubFetch(`${HUB}/api/macp`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ action: 'vote', id: a.id, actor: ACTOR, vote: a.vote, weight: a.weight || 1, rationale: a.rationale || '' }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? `MACP vote '${a.vote}' recorded for session ${a.id} (status: ${r.session?.status}, outcome: ${JSON.stringify(r.session?.outcome || null)})` : `MACP vote failed: ${r.error}`;
    },
  },
  mesh_propose_contract: {
    description: 'Propose a contract change or create an MACP negotiation session with peer agents across laptops.',
    inputSchema: { type: 'object', required: ['title'], properties: { title: str, mode: { enum: ['decision', 'proposal', 'quorum'] }, participants: strs, spec: str } },
    run: async (a) => {
      const r = await hubFetch(`${HUB}/api/macp`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ action: 'create', initiator: ACTOR, mode: a.mode || 'proposal', title: a.title, participants: a.participants || [ACTOR], data: { spec: a.spec || '' } }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? `MACP session created: ${r.session?.id} (${r.session?.mode}) - "${r.session?.title}". Awaiting peer input.` : `failed to propose contract: ${r.error}`;
    },
  },
  mesh_crdt_set: {
    description: 'Update a shared AST symbol, config key, or contract node in the Delta-State Semantic CRDT.',
    inputSchema: { type: 'object', required: ['key', 'value'], properties: { key: str, value: str } },
    run: async (a) => {
      const r = await hubFetch(`${HUB}/api/crdt`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ action: 'set', actor: ACTOR, key: a.key, value: a.value }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? `CRDT symbol ${a.key} updated to "${a.value}" (Lamport: ${r.op?.lamport})` : `CRDT update failed: ${r.error}`;
    },
  },
  mesh_build_status: {
     description: 'Report your done/not-done status for the current build gate (pm build).',
     inputSchema: { type: 'object', properties: { done: { type: 'boolean' }, note: str } },
     run: async (a) => {
       const r = await hubFetch(`${HUB}/api/build-status`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, done: !!a.done, note: a.note || '' }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
       return r.ok ? `build status reported: ${a.done ? 'DONE' : 'NOT DONE'}${a.note ? ' — ' + a.note : ''}` : `build status failed: ${r.error}`;
     },
   },
  mesh_task_create: {
    description: 'Create a task on the shared cross-harness board (scoped to paths so claiming is collision-aware).',
    inputSchema: { type: 'object', required: ['title'], properties: { title: str, paths: strs, deps: strs, note: str } },
    run: (a) => hubFetch(`${HUB}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, action: 'create', title: a.title, paths: a.paths || [], deps: a.deps || [], note: a.note || '' }) }).then((x) => x.json()).then((r) => r.ok ? `task ${r.task.id} created (${r.task.status})` : `task create failed: ${r.error}`),
  },
  mesh_task_list: {
    description: 'List tasks on the shared board you could claim (deps + WIP respected).',
    inputSchema: { type: 'object', properties: { status: { enum: ['pending', 'in-progress', 'done', 'blocked'] } } },
    run: (a) => hubFetch(`${HUB}/api/tasks${a?.status ? `?status=${a.status}` : ''}`, { headers: { ...authH() } }).then((x) => x.json()).then((r) => r.ok ? (r.tasks.map((t) => `${t.id} [${t.status}] ${t.title}${t.readyToClaim ? ' ⚡ready' : ''}`).join('\n') || '(no tasks)') : `failed: ${r.error}`),
  },
  mesh_task_claim: {
    description: 'Atomically claim a task (others who claim the same task get a 409, deterministically).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: str, wip: { type: 'number' } } },
    run: (a) => hubFetch(`${HUB}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, action: 'claim', id: a.id, wip: a.wip }) }).then((x) => x.json()).then((r) => r.ok ? `claimed ${a.id}: ${r.task.title} (in progress)` : `claim failed: ${r.error}`),
  },
  mesh_task_set: {
    description: 'Update a task status: in-progress | done | blocked (done requires deps to be done).',
    inputSchema: { type: 'object', required: ['id', 'status'], properties: { id: str, status: { enum: ['pending', 'in-progress', 'done', 'blocked'] }, note: str } },
    run: (a) => hubFetch(`${HUB}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, action: 'set', id: a.id, status: a.status, note: a.note }) }).then((x) => x.json()).then((r) => r.ok ? `${a.id} → ${r.task.status}` : `set failed: ${r.error}`),
  },
  mesh_bot: {
    description: 'Summon the Conductor: mesh-native agent (scout → dispatch → referee → harness). dry-run by default.',
    inputSchema: { type: 'object', required: ['action'], properties: { action: { enum: ['status', 'run'] }, goal: str, tasksInput: { type: 'array', items: { type: 'object' } }, budgetCoins: { type: 'number' } } },
    run: (a) => a.action === 'status'
      ? hubFetch(`${HUB}/api/bot`, { headers: { ...authH() } }).then((x) => x.json()).then((r) => JSON.stringify(r).slice(0, 900))
      : hubFetch(`${HUB}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, goal: a.goal || '', dry: true, tasksInput: a.tasksInput, budgetCoins: a.budgetCoins }) }).then((x) => x.json()).then((r) => r.ok ? `conductor ${r.run.id}: ${r.run.phases.map((p) => p.name).join('→')} · tasks ${r.tasks.map((t) => t.id).join(', ')}${r.harness ? ` · harness ${r.harness.cli || 'printer mode'}` : ''}` : `bot run failed: ${r.error}`),
  },
  mesh_memory_get: {
    description: "Read this repo's long-term memory (conventions, gotchas, decisions learned by the Conductor).",
    inputSchema: { type: 'object', properties: { key: str } },
    run: (a) => hubFetch(`${HUB}/api/memory?key=${encodeURIComponent(a?.key || '')}&actor=${ACTOR}`, { headers: { ...authH() } }).then((x) => x.json()).then((r) => r.ok ? (r.memory || '(memory empty — mesh_memory_set seeds it)') : `failed: ${r.error}`),
  },
  mesh_memory_set: {
    description: 'Append a learned convention to repo memory (visible to every harness on the mesh).',
    inputSchema: { type: 'object', required: ['text'], properties: { text: str } },
    run: (a) => hubFetch(`${HUB}/api/memory`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, text: a.text }) }).then((x) => x.json()).then((r) => r.ok ? `memory entry saved (${r.bytes} bytes total)` : `failed: ${r.error}`),
  },
 };

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

// MCP revisions this bridge understands. The 2026-07-28 revision removed
// protocol-level sessions and the initialize handshake; older clients still
// send it, so we answer both and advertise the newest we speak.
const SUPPORTED_PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'agentmesh', version: '1.2.0' };
const META = () => ({
  'io.modelcontextprotocol/protocolVersion': '2025-06-18',
  'io.modelcontextprotocol/serverInfo': SERVER_INFO,
});

// A tool result that reports a failure must be distinguishable from a success.
// The tool bodies return human-readable strings, so failures are detected from
// an explicit list of prefixes rather than a loose substring match.
const FAIL_PREFIX = /^(request failed|board post failed|pin failed|MACP vote failed|failed to propose|CRDT update failed|build status failed|task create failed|claim failed|set failed|bot run failed|failed to fetch|failed:)/i;
const isFailure = (out) => {
  if (out && typeof out === 'object' && out.ok === false) return true;
  if (typeof out !== 'string') return false;
  return FAIL_PREFIX.test(out.trim());
};

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined;
  try {
    if (method === 'initialize') {
      // Legacy handshake. New clients (2026-07-28) skip this and negotiate
      // per request via _meta; we still answer for older clients.
      const want = params?.protocolVersion;
      const proto = SUPPORTED_PROTOCOLS.includes(want) ? want : '2025-06-18';
      if (!isNotification) send({
        id,
        result: {
          protocolVersion: proto,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          _meta: META(),
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return; // notification
    if (method === 'server/discover') {
      // REQUIRED by MCP 2026-07-28 (SEP-2575): servers must implement it.
      if (!isNotification) send({ id, result: { tools: Object.keys(TOOLS).sort(), serverInfo: SERVER_INFO, _meta: META() } });
      return;
    }
    if (method === 'ping') { if (!isNotification) send({ id, result: {} }); return; }
    if (method === 'tools/list') {
      // Deterministic ordering keeps prompt-cache hit rates up.
      const tools = Object.keys(TOOLS).sort().map((name) => ({
        name, description: TOOLS[name].description, inputSchema: TOOLS[name].inputSchema,
      }));
      if (!isNotification) send({ id, result: { tools, _meta: META() } });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const tool = TOOLS[name];
      if (!tool) { if (!isNotification) send({ id, error: { code: -32602, message: `unknown tool ${name}` } }); return; }
      const args = params?.arguments ?? {};
      if (tool.inputSchema?.required) {
        const missing = tool.inputSchema.required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
        if (missing.length) {
          if (!isNotification) send({ id, error: { code: -32602, message: `missing required argument(s): ${missing.join(', ')}` } });
          return;
        }
      }
      const out = await tool.run(args);
      const delta = await hubFetch(`${HUB}/inbox/${ACTOR}`).then((r) => r.text()).catch(() => '');
      const body = typeof out === 'string' ? out : JSON.stringify(out);
      const text = (delta ? `<mesh-delta>\n${delta}</mesh-delta>\n` : '') + body;
      const failed = isFailure(out);
      if (!isNotification) {
        send({
          id,
          result: {
            content: [{ type: 'text', text }],
            isError: failed,
            ...(failed ? {} : { structuredContent: { ok: true, tool: name } }),
            _meta: META(),
          },
        });
      }
      return;
    }
    // Unknown method: JSON-RPC requires -32601, not an empty result.
    if (!isNotification) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    if (!isNotification) send({ id, error: { code: -32603, message: String(e?.message || e) } });
  }
}

// Serialize handling so responses are emitted in request order, and surface
// parse errors as -32700 instead of dropping them on stderr.
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.trim()) return;
  chain = chain.then(async () => {
    let msg;
    try { msg = JSON.parse(l); }
    catch (e) {
      send({ id: null, error: { code: -32700, message: `Parse error: ${String(e?.message || e)}` } });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      send({ id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request: expected {jsonrpc,method,id}' } });
      return;
    }
    await handle(msg);
  });
});
// On stdin close we must DRAIN the pending chain before exiting, and we must
// not truncate stdout: `process.exit()` discards buffered pipe writes, which
// made the client see a short stream and unable to tell it from a crash.
const finish = () => {
  try { process.stdout.write('', () => process.exit(0)); }
  catch { process.exit(0); }
  setTimeout(() => process.exit(0), 2000).unref(); // safety net
};
process.stdin.on('close', () => { chain.then(finish, finish); });
