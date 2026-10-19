// tasks.mjs — P3: shared cross-harness task board with ATOMIC claims.
// Why: every orchestrator stops at "some kanban rows". Here a task is a mesh object:
// a claim is one event (the hub reduce is single-threaded), dependencies block claiming,
// WIP limits borrow collab.mjs, and every transition lands in the event log.
import { loadJson, saveJson, appendJsonl, loadJsonl, ulid } from './store.mjs';
import { join } from 'node:path';

const file = (root) => join(root, 'tasks.json');
const opsFile = (root) => join(root, 'tasks.ops.jsonl');

export function loadTasks(root) {
  const d = loadJson(file(root), { tasks: {}, seq: 0 });
  if (!d.tasks) d.tasks = {};
  return d;
}
function save(root, d) { saveJson(file(root), d); }
function logOp(root, op) { appendJsonl(opsFile(root), { id: `t-${ulid('')}`, t: Date.now(), ...op }); }

// create: title required; paths = scope hint for collision-aware claiming; deps = ids
export function createTask(root, { title, by = 'human', paths = [], deps = [], repo = '', priority = 0, note = '' }) {
  if (title == null || !String(title).trim()) return { ok: false, error: 'title required' };
  if (deps.some((d) => d === '_self')) return { ok: false, error: 'self-dep' };
  const d = loadTasks(root);
  const id = `task-${++d.seq}`;
  for (const dep of deps) {
    if (!d.tasks[dep]) return { ok: false, error: `unknown dep ${dep}` };
    if (dep === id) return { ok: false, error: 'self-dep' };
  }
  // cycle check: can this new node reach itself? (deps are edges task -> dep)
  if (hasCycle(d.tasks, id, deps)) return { ok: false, error: 'dependency cycle' };
  d.tasks[id] = {
    id, title: String(title).slice(0, 300), by, paths: (paths || []).map(String).slice(0, 20),
    deps: (deps || []).slice(0, 20), repo: String(repo || ''), priority: +priority || 0,
    status: 'pending', owner: null, created: Date.now(), attempts: 0, note: String(note || '').slice(0, 500), done: null,
  };
  save(root, d);
  logOp(root, { kind: 'task.create', id, title: d.tasks[id].title, by });
  return { ok: true, task: d.tasks[id] };
}

function hasCycle(tasks, id, deps) {
  const seen = new Set();
  const stack = [...deps];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === id) return true; // cycle: new task is referenced by one of its deps
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(tasks[cur]?.deps || []));
  }
  return false;
}

function depsDone(tasks, t) { return (t.deps || []).every((dep) => tasks[dep]?.status === 'done'); }

// claim: atomic because callers are single-threaded (hub reduce / CLI). No lost claims.
export function claimTask(root, { id, actor, wip = 2 }) {
  const d = loadTasks(root);
  const t = d.tasks[id];
  if (!t) return { ok: false, error: `unknown task ${id}` };
  if (t.status === 'done') return { ok: false, error: `task ${id} already done` };
  if (t.status === 'in-progress' && t.owner && t.owner !== actor) return { ok: false, error: `task ${id} held by ${t.owner}` };
  if (!depsDone(d.tasks, t)) return { ok: false, error: `task ${id} is blocked by unfinished deps` };
  if (t.status === 'pending') {
    const mine = Object.values(d.tasks).filter((x) => x.owner === actor && x.status === 'in-progress');
    if (mine.length >= wip) return { ok: false, error: `wip limit: ${actor} holds ${mine.length}/${wip} tasks in progress`, wip: mine.length };
    t.status = 'in-progress';
    t.owner = actor;
    t.attempts += 1;
    save(root, d);
    logOp(root, { kind: 'task.claim', id, actor, attempt: t.attempts });
    return { ok: true, task: t, first: true };
  }
  // re-claiming own in-progress task returns it harmlessly (crash resume)
  return { ok: true, task: t, first: false };
}

export function setTask(root, { id, actor, status, note = '' }) {
  const d = loadTasks(root);
  const t = d.tasks[id];
  if (!t) return { ok: false, error: `unknown task ${id}` };
  if (!['pending', 'in-progress', 'done', 'blocked'].includes(status)) return { ok: false, error: 'status must be pending|in-progress|done|blocked' };
  if (status === 'done' && t.status === 'done') return { ok: false, error: `task ${id} already done` };
  if (status === 'done' && !depsDone(d.tasks, t)) return { ok: false, error: `task ${id} has unfinished deps` };
  const before = t.status;
  t.status = status;
  if (status === 'done') { t.done = { by: actor || t.owner || 'system', t: Date.now(), note: String(note).slice(0, 500) }; t.owner = actor || t.owner; }
  if (status === 'pending') { t.owner = null; }
  if (note) t.note = String(note).slice(0, 500);
  save(root, d);
  logOp(root, { kind: 'task.set', id, actor, from: before, to: status });
  return { ok: true, task: t };
}

export function listTasks(root, { owner = '', status = '', repo = '' } = {}) {
  const d = loadTasks(root);
  let out = Object.values(d.tasks);
  if (owner) out = out.filter((t) => t.owner === owner);
  if (status) out = out.filter((t) => t.status === status);
  if (repo) out = out.filter((t) => !t.repo || t.repo === repo);
  return out.map((t) => ({ ...t, readyToClaim: t.status === 'pending' && depsDone(d.tasks, t) }));
}

// board stats for the observatory
export function taskStats(root) {
  const d = loadTasks(root);
  const c = { pending: 0, 'in-progress': 0, done: 0, blocked: 0, created: d.seq };
  for (const t of Object.values(d.tasks)) c[t.status] = (c[t.status] || 0) + 1;
  return c;
}

export const taskOpsLog = (root) => loadJsonl(opsFile(root));
