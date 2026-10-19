// bot.mjs — the Conductor: AgentMesh's own first-class agent ("our dot", not theirs).
// Roles: scout (project map) · dispatcher (goal -> scoped tasks) · referee (overlap
// arbitration) · reviewer (fresh-context verification) · shepherd (briefs) · keeper
// (repo memory). Budgeted autonomy: every run has a coin budget + wall clock spent
// per phase; deterministic phases work even with no coding CLI installed; harness
// phases drive whichever headless CLI exists (Claude/Codex/Grok/OpenCode).
//
// Served three ways: `mesh bot run`, MCP `mesh_bot`, POST /api/bot.
import { existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createTask, claimTask, setTask, listTasks, loadTasks } from './tasks.mjs';
import { loadRegistry } from './contracts.mjs';
import { loadCollab, newcomerBrief } from './collab.mjs';
import { forecast, scopeOfIntent } from './graph.mjs';
import { runT2 } from './harness.mjs';
import { loadJson, saveJson, appendJsonl } from './store.mjs';
import { spawnSync } from 'node:child_process';

const DIR = (root) => join(root, 'bots');
const REPO = (root, repoPath = null) => repoPath || (dirname(root) === root ? root : dirname(root));

// ---------- run ledger ----------
export function startRun(root, { goal, actor = 'conductor', dry = true, budgetCoins = 20, budgetMin = 10 } = {}) {
  mkdirSync(DIR(root), { recursive: true });
  const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const run = {
    id, actor, goal: String(goal || '').slice(0, 500), dry: !!dry,
    budget: { coins: budgetCoins, spent: 0 }, started: Date.now(), deadline: Date.now() + budgetMin * 60_000,
    phases: [], tasks: [], status: 'running',
  };
  saveRun(root, run);
  appendJsonl(join(root, 'bots', `${id}.jsonl`), { t: Date.now(), event: 'run.start', goal: run.goal, dry: run.dry });
  return run;
}
function saveRun(root, run) { mkdirSync(DIR(root), { recursive: true }); saveJson(join(DIR(root), `${run.id}.json`), run); }
export function loadRun(root, id) { return loadJson(join(DIR(root), `${id}.json`), null); }
export function listRuns(root, n = 10) {
  try {
    return readdirSync(DIR(root)).filter((f) => f.endsWith('.json'))
      .map((f) => loadJson(join(DIR(root), f), null)).filter(Boolean).slice(-n);
  } catch { return []; }
}
function phase(root, run, name, coins, out) {
  run.phases.push({ name, t: Date.now(), coins, ...(out && typeof out === 'object' ? out : { out }) });
  run.budget.spent += coins;
  saveRun(root, run);
  appendJsonl(join(root, 'bots', `${run.id}.jsonl`), { t: Date.now(), event: `phase.${name}`, out });
}

// ---------- role: SCOUT — the project map, before any model is asked anything ----------
export function scout(storeRoot, { repoPath = null, budget = 2 } = {}) {
  const repo = REPO(storeRoot, repoPath);
  const files = [];
  const SKIP = new Set(['node_modules', '.git', '.mesh', '.agents', 'dist', 'build', '.github']);
  const walk = (d) => {
    if (!existsSync(d) || files.length > 800) return;
    for (const e of readdirSync(d)) {
      if (SKIP.has(e)) continue;
      const f = join(d, e);
      let st; try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) walk(f);
      else files.push({ file: relative(repo, f).replaceAll('\\', '/'), size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(repo);
  files.sort((a, b) => b.mtime - a.mtime);
  const byDir = {};
  for (const { file, size } of files.slice(0, 800)) {
    const dir = file.split('/').slice(0, 2).join('/') || '(root)';
    byDir[dir] = byDir[dir] || { count: 0, bytes: 0 };
    byDir[dir].count++; byDir[dir].bytes += size;
  }
  const dirs = Object.entries(byDir).map(([dir, v]) => ({ dir, ...v })).sort((a, b) => b.count - a.count).slice(0, 12);
  const reg = loadRegistry(storeRoot);
  let scripts = null;
  try { scripts = Object.keys(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))?.scripts || {}).slice(0, 12); } catch {}
  return { dirs, contracts: Object.values(reg.nodes || {}).slice(0, 20).map((c) => ({ id: c.id, status: c.status })), scripts, note: files.length > 800 ? `survey truncated (${files.length} files)` : 'full survey' };
}

// ---------- role: DISPATCHER — goal -> scoped tasks on the shared board ----------
const PATHY = /[A-Za-z0-9_./-]+\.(m?js|ts|tsx|py|md|html|css|json)/g;
export function dispatch(storeRoot, run, { tasksInput = null, by = 'conductor' } = {}) {
  const specs = [];
  if (Array.isArray(tasksInput) && tasksInput.length) {
    for (const t of tasksInput.slice(0, 8)) if (t?.title) specs.push({ title: String(t.title), paths: t.paths || [], note: t.note || '' });
  } else {
    const mentioned = (run.goal.match(PATHY) || []).slice(0, 6);
    if (mentioned.length >= 2) {
      for (const f of mentioned) specs.push({ title: `Update ${f} for: ${run.goal}`, paths: [f] });
      specs.push({ title: `Review + verify all changes for: ${run.goal}`, paths: mentioned });
    } else if (/review|audit|research/.test((run.goal || '').toLowerCase())) {
      specs.push({ title: `Survey the codebase for: ${run.goal}`, paths: ['src/**'] }, { title: `Write findings for: ${run.goal}`, paths: [] });
    } else {
      specs.push(
        { title: `Investigate scope for: ${run.goal}`, paths: ['src/**'], note: 'guided by the scout map' },
        { title: `Implement the best slice for: ${run.goal}`, paths: [], note: 'clarify scope after investigation' },
        { title: `Review + verify (fresh context) for: ${run.goal}`, paths: [], note: 'never self-review' },
      );
    }
  }
  const created = [];
  for (const s of specs) {
    const r = createTask(storeRoot, { title: s.title, by, paths: s.paths, note: s.note });
    if (r.ok) created.push({ id: r.task.id, title: r.task.title, paths: s.paths });
  }
  // chain tasks so lanes never collide: each depends on the previous one
  for (let i = 1; i < created.length; i++) addDep(storeRoot, created[i].id, created[i - 1].id);
  return { tasks: created, note: 'tasks on the shared board with mesh scopes + chained deps' };
}
function addDep(storeRoot, id, depId) {
  const d = loadTasks(storeRoot);
  if (d.tasks[id] && d.tasks[depId] && id !== depId) {
    d.tasks[id].deps = [...new Set([...(d.tasks[id].deps || []), depId])];
    saveJson(join(storeRoot, 'tasks.json'), d);
  }
}

// ---------- role: REFEREE — overlap arbitration plan (advisory) ----------
export function referee(intents = []) {
  const findings = [];
  for (let i = 0; i < intents.length; i++) for (let j = i + 1; j < intents.length; j++) {
    const g = forecast(scopeOfIntent(intents[i]), scopeOfIntent(intents[j]));
    if (g !== 'none') findings.push({ a: intents[i].actor, b: intents[j].actor, grade: g });
  }
  return {
    findings, plan: findings.map((f) => ({ ...f, resolution: 'temporal sequencing: later intent re-bases onto the earlier lane first; breaking pairs -> MACP proposal mode (partition scopes)' })),
    note: findings.length ? `${findings.length} overlap(s) — sequencing plan ready` : 'no overlap; referee idle',
  };
}

// ---------- role: REVIEWER — fresh-context verification of a lane ----------
export function reviewer(storeRoot, lane, { actor = 'conductor' } = {}) {
  const laneDir = join(storeRoot, 'lanes', lane);
  if (!existsSync(laneDir)) return { ok: false, error: `no lane ${lane}` };
  const t2 = runT2(laneDir, { contracts: null });
  const proposals = Object.values(loadRegistry(storeRoot).nodes || {}).filter((c) => c.status === 'proposed');
  return {
    ok: true, lane,
    checklist: [
      'fresh-context: verify the diff claims, not its appearance (no author bias)',
      'contracts: proposed changes gate landing via quorum when breaking',
      'regression: T1 suite on the lane before any trunk drain',
    ],
    harnessT2: t2, proposedContracts: proposals.map((c) => c.id),
  };
}

// ---------- role: SHEPHERD — briefs newcomers from live mesh state ----------
export function shepherd(storeRoot) {
  const col = loadCollab(storeRoot);
  const inProgress = listTasks(storeRoot, { status: 'in-progress' }).slice(0, 8).map((t) => ({ id: t.id, actor: t.owner, goal: t.title, paths: t.paths }));
  return newcomerBrief({
    modules: hotDirs(storeRoot),
    intents: inProgress,
    contracts: Object.values(loadRegistry(storeRoot).nodes || {}).slice(0, 10).map((c) => c.id),
    decisions: (col.decisions || []).slice(-5),
  });
}
function hotDirs(storeRoot) {
  try { return scout(storeRoot).dirs.map((d) => d.dir); } catch { return []; }
}

// ---------- role: KEEPER — repo memory (bounded, portable, plain markdown) ----------
export function memoryGet(storeRoot, key = '') {
  try {
    const md = readFileSync(join(storeRoot, 'memory.md'), 'utf8');
    if (!key) return md.slice(0, 4000);
    const idx = md.indexOf(key);
    return idx < 0 ? null : md.slice(Math.max(0, idx - 400), idx + 1600);
  } catch { return null; }
}
export function memorySet(storeRoot, actor, text) {
  mkdirSync(storeRoot, { recursive: true });
  let body = '';
  try { body = readFileSync(join(storeRoot, 'memory.md'), 'utf8'); } catch {}
  const entry = `- [${new Date().toISOString()}] @${actor}: ${String(text || '').replace(/\n/g, ' ').slice(0, 500)}`;
  let out = body ? `${body.replace(/\n+$/, '')}\n${entry}\n` : `# mesh memory (plain markdown; last 200 entries)\n\n${entry}\n`;
  const lines = out.split('\n').filter(Boolean);
  if (out.split('\n').length > 205) out = lines.slice(-200).join('\n') + '\n';
  writeFileSync(join(storeRoot, 'memory.md'), out.slice(0, 32_000));
  return { ok: true, bytes: out.length };
}

// ---------- harness driver: which headless coding CLIs can the Conductor drive ----------
export const CLI_SPECS = [
  { cli: 'claude', name: 'Claude Code', vendor: 'anthropic' },
  { cli: 'codex', name: 'OpenAI Codex', vendor: 'openai' },
  { cli: 'grok', name: 'Grok Build', vendor: 'xai' },
  { cli: 'opencode', name: 'OpenCode', vendor: 'opencode' },
];
export function detectHarnesses() {
  const found = [];
  for (const spec of CLI_SPECS) {
    try {
      const r = spawnSync(spec.cli, ['--version'], { timeout: 2500, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
      if (!r.error || r.status === 0) found.push({ ...spec, version: String(r.stdout || '').trim().split('\n')[0].slice(0, 40) });
    } catch {}
  }
  return found;
}
export function buildPrompt(task) {
  return [
    `You are a peer agent inside an AgentMesh. Task: ${task.title}`,
    `Scope hint (paths): ${(task.paths || []).join(', ') || 'src/**'}`,
    'Protocol: BEFORE touching any file, call the MCP tool mesh_declare_intent with your scope, then read mesh_status.',
    'Never merge to trunk yourself. Keep the changeset small; everything is reversible via mesh undo.',
  ].join('\n');
}
// spawn one headless CLI for one task. Env makes the child its own mesh actor.
export function spawnHarnessTask(storeRoot, task, { cli = null, timeout = 120_000, hub = null } = {}) {
  const found = detectHarnesses();
  const pick = cli ? found.find((h) => h.cli === cli) : found[0];
  const prompt = buildPrompt(task);
  if (!pick) return { cli: null, ok: false, code: 127, prompt, promptHint: 'no headless CLI found — paste this prompt into any harness manually' };
  const env = { ...process.env, MESH_ACTOR: `bot-${pick.cli}`, MESH_HUB: hub || process.env.MESH_HUB || 'http://localhost:7777' };
  const r = spawnSync(pick.cli, ['-p', prompt], { cwd: REPO(storeRoot), env, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' });
  return { cli: pick.cli, name: pick.name, ok: r.status === 0, code: r.status ?? 1, stdout: (r.stdout || '').slice(-4000), stderr: (r.stderr || '').slice(-1200), prompt: prompt.slice(0, 600) };
}

// ---------- full run: orchestrate phases under the budget ----------
export async function runBot(storeRoot, {
  goal, dry = true, tasksInput = null, spawner = null, budgetCoins = 20, budgetMin = 10, repoPath = null,
} = {}) {
  const run = startRun(storeRoot, { goal, dry, budgetCoins, budgetMin });
  const budget = () => { if (run.budget.spent >= run.budget.coins) throw new Error('budget exhausted'); };
  try {
    budget();
    const sc = scout(storeRoot, { repoPath });
    phase(storeRoot, run, 'scout', 1, { dirs: sc.dirs.map((d) => d.dir), contracts: sc.contracts.length, scripts: sc.scripts });

    budget();
    const dsp = dispatch(storeRoot, run, { tasksInput });
    run.tasks = dsp.tasks.map((t) => t.id);
    phase(storeRoot, run, 'dispatch', dry ? 1 : 2, { tasks: dsp.tasks, chained: dsp.tasks.length > 1 });

    // referee over already-live intents (drivers/CLI claim paths could overlap)
    let harness = null;
    if (!dry && run.tasks.length) {
      budget();
      const first = dsp.tasks[0];
      const out = typeof spawner === 'function' ? spawner(storeRoot, first, {}) : spawnHarnessTask(storeRoot, first, {});
      harness = { cli: out.cli || null, ok: out.ok ?? false, code: out.code ?? null, promptHint: out.promptHint || null, stderr: (out.stderr || '').slice(0, 300) };
      phase(storeRoot, run, 'harness', 6, harness);
    }
    budget();
    phase(storeRoot, run, 'referee', 1, referee([]).note);

    // report: ledger + task states (claims are evidence; review is human-gated)
    const states = listTasks(storeRoot).filter((t) => run.tasks.includes(t.id)).map((t) => ({ id: t.id, status: t.status, owner: t.owner, paths: t.paths }));
    run.status = 'done';
    phase(storeRoot, run, 'report', 0, { taskStates: states, harness });
    appendJsonl(join(storeRoot, 'bots', `${run.id}.jsonl`), { t: Date.now(), event: 'run.done', tasks: states.length });
    return { ok: true, run, tasks: states, harness };
  } catch (e) {
    run.status = 'failed';
    phase(storeRoot, run, 'failed', 0, { error: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e), run };
  }
}

// ---------- surface shape ----------
export function botStatus(storeRoot) {
  const runs = listRunFiles(storeRoot).slice(-5);
  const counts = { pending: 0, 'in-progress': 0, done: 0, blocked: 0 };
  try { for (const t of Object.values(loadTasks(storeRoot).tasks)) counts[t.status] = (counts[t.status] || 0) + 1; } catch {}
  return { ok: true, name: 'conductor', roles: ['scout', 'dispatcher', 'referee', 'reviewer', 'shepherd', 'keeper'], runs, taskCounts: counts, defaults: { budgetCoins: 20, budgetMin: 10 } };
}
function listRunFiles(root) {
  try { return readdirSync(DIR(root)).filter((f) => f.endsWith('.json')).map((f) => loadJson(join(DIR(root), f), null)).filter(Boolean); }
  catch { return []; }
}
