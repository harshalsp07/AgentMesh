// bridge.mjs — MCP stdio bridge (newline-delimited JSON-RPC 2.0) -> hub HTTP.
// Every tool result is prefixed with a <mesh-delta> header drained from /inbox/<actor>.
// Fixes vs doc prototype: handles notifications (no id -> no reply), unknown-method
// errors per JSON-RPC, env validation, graceful stdin close.
import { createInterface } from 'node:readline';

const ACTOR = process.env.MESH_ACTOR || 'agent';
const HUB = (process.env.MESH_HUB || 'http://localhost:7777').replace(/\/$/, '');
const TOKEN = process.env.MESH_TOKEN || '';
const authH = () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});

if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/.test(ACTOR)) {
  console.error(`warn: MESH_ACTOR=${JSON.stringify(ACTOR)} looks unusual; continuing`);
}

const post = (kind, payload) =>
  fetch(`${HUB}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, kind, payload }) }).then((r) => r.json());
const str = { type: 'string' };
const strs = { type: 'array', items: str };

const TOOLS = {
  mesh_declare_intent: {
    description: 'Declare what you are about to change BEFORE editing. Returns overlap / breaking-change warnings.',
    inputSchema: { type: 'object', required: ['goal', 'paths'], properties: { goal: str, paths: strs, contracts: strs, uses: strs, effect: { enum: ['none', 'additive', 'breaking'] } } },
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
      const r = await fetch(`${HUB}/context/${ACTOR}`);
      return await r.text();
    },
  },
  mesh_inbox: {
    description: 'Drain unseen Tier-1/Tier-2 messages without touching presence.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await fetch(`${HUB}/inbox/${ACTOR}`, { headers: { ...authH() } })).text(),
  },
  mesh_request: {
    description: 'Ask another actor for work (@agent). Lands in owner approval inbox unless trusted; returns status chip.',
    inputSchema: { type: 'object', required: ['to', 'text'], properties: { to: str, text: str, ref: str } },
    run: async (a) => {
      const r = await fetch(`${HUB}/api/request`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, to: a.to, text: a.text, ref: a.ref }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? `request ${r.id} → @${a.to}: status ${r.status} (${r.approved === false || r.status === 'queued' ? 'awaiting owner approval' : r.note || 'tracked'}). Chips: queued→working→done/declined.` : `request failed: ${r.error}`;
    },
  },
  mesh_board_post: {
    description: 'Post a sticky to the shared whiteboard (visible to the whole room). Use for proposals too big for chat.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: str, color: str, codeRef: str } },
    run: async (a) => {
      const r = await fetch(`${HUB}/api/board/op`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, op: { op: 'add', shape: { type: 'note', x: 80 + Math.floor(Math.random() * 600), y: 80 + Math.floor(Math.random() * 300), text: a.text, color: a.color, codeRef: a.codeRef } } }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? `sticky ${r.shape.id} on the board (seq ${r.seq}).` : `board post failed: ${r.error}`;
    },
  },
  mesh_pin: {
    description: 'Drop a spatial pin on a node/file/contract so owners whose scope touches it get it.',
    inputSchema: { type: 'object', required: ['node', 'text'], properties: { node: str, text: str } },
    run: async (a) => {
      const r = await fetch(`${HUB}/api/pin`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor: ACTOR, node: a.node, text: a.text }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? `pin ${r.id} on ${a.node} recorded and routed to scope owners.` : `pin failed: ${r.error}`;
    },
  },
};

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  try {
    if (method === 'initialize') {
      if (!isNotification) send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentmesh', version: '0.1.0' } } });
      return;
    }
    if (method === 'tools/list') {
      if (!isNotification) send({ id, result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
      return;
    }
    if (method === 'tools/call') {
      const tool = TOOLS[params?.name];
      if (!tool) { if (!isNotification) send({ id, error: { code: -32602, message: `unknown tool ${params?.name}` } }); return; }
      const out = await tool.run(params?.arguments ?? {});
      const delta = await (await fetch(`${HUB}/inbox/${ACTOR}`, { headers: { ...authH() } })).text().catch(() => '');
      const text = (delta ? `<mesh-delta>\n${delta}</mesh-delta>\n` : '') + (typeof out === 'string' ? out : JSON.stringify(out));
      if (!isNotification) send({ id, result: { content: [{ type: 'text', text }] } });
      return;
    }
    // ping / cancelled / unknown: reply with empty result so clients don't hang
    if (!isNotification) send({ id, result: {} });
  } catch (e) {
    if (!isNotification) send({ id, error: { code: -32603, message: String(e?.message || e) } });
  }
}

createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.trim()) return;
  try { handle(JSON.parse(l)); } catch (e) { console.error('bad JSON-RPC line:', String(e?.message || e)); }
});
process.stdin.on('close', () => process.exit(0));
