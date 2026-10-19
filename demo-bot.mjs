// demo-bot.mjs — the Conductor (P1), all asserted, dry-only: scout → dispatcher →
// referee → keeper, tasks chained, budget respected. No CLI driving, no network.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runBot, botStatus, scout, referee, memorySet, memoryGet, listRuns, loadRun } from './src/bot.mjs';
import { listTasks, claimTask, setTask, taskStats } from './src/tasks.mjs';

const ROOT = '.mesh-demobot';
rmSync(ROOT, { recursive: true, force: true });
// tiny fake repo so scout scans in milliseconds
const repo = join(ROOT, 'probe');
await import('node:fs').then((fs) => {
  fs.mkdirSync(join(repo, 'src', 'api'), { recursive: true });
  fs.writeFileSync(join(repo, 'src', 'api', 'fees.mjs'), 'export const rate = 1;\n');
  fs.writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'probe', scripts: { test: 'node --test' } }));
});
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('✓', m); };

// 1. scout: project map without node_modules
const sc = scout(ROOT, { repoPath: repo });
assert(sc.dirs.length >= 1 && sc.dirs.every((d) => !d.dir.includes('node_modules')), 'scout maps hot dirs, skips node_modules');
assert((sc.dirs[0]?.count ?? 0) >= 1, 'scout counts files per dir');

// 2. conductor dry run: goal → chained tasks + report, under budget
const r = await runBot(ROOT, { goal: 'Ship the checkout fee API in src/api/fees.mjs and display fees on site/index.html', dry: true, repoPath: repo });
assert(r.ok === true, 'dry run completes ok');
assert(r.run.status === 'done', 'run status done');
assert(r.run.phases.some((p) => p.name === 'scout') && r.run.phases.some((p) => p.name === 'dispatch'), 'phases include scout + dispatch');
assert(r.tasks.length >= 2, `dispatcher split the goal (${r.tasks.length} tasks)`);
const board = listTasks(ROOT);
const lastTask = board.find((t) => t.id === r.tasks[r.tasks.length - 1].id);
assert(lastTask.deps.length >= 1, 'review task is chained behind the implementation');
assert(r.run.budget.spent < r.run.budget.coins, `budget respected (${r.run.budget.spent}/${r.run.budget.coins} coins)`);

// 3. humans/agents pick up the tasks the Conductor planned
const ids = r.tasks.map((t) => t.id);
const c1 = claimTask(ROOT, { id: ids[0], actor: 'codex-backend' });
assert(c1.ok === true, 'agent claims the first planned task atomically');
assert(setTask(ROOT, { id: ids[0], actor: 'codex-backend', status: 'done' }).ok === true, 'task completes');

// 4. referee: overlapping intents produce a plan, not a crash
const rf = referee([
  { actor: 'ui-agent', paths: ['site/**'], symbols: ['renderFee'], contracts: [] },
  { actor: 'be-agent', paths: ['site/**'], symbols: ['renderFee'], contracts: [] },
]);
assert(rf.findings.length >= 1 && /sequencing/i.test(rf.plan[0].resolution), 'referee sequences overlapping scopes');

// 5. keeper memory is plain markdown
memorySet(ROOT, 'conductor', 'fees are integers, never floats');
assert(memoryGet(ROOT, 'fees').includes('integers'), 'keeper memory get works');
const st = botStatus(ROOT);
assert(st.ok === true && st.runs.length >= 1, 'bot status reflects the ledger');
assert(taskStats(ROOT).done === 1, 'board stats show the completed task');
const re = loadRun(ROOT, listRuns(ROOT)[0].id);
assert(re.phases.length >= 4, 'run ledger is durable and replayable');

console.log(`\nconductor demo ok — run ${re.id}: ${re.phases.map((p) => p.name).join(' → ')}`);
rmSync(ROOT, { recursive: true, force: true });
