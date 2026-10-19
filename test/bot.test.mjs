// test/bot.test.mjs â€” the Conductor: run ledger, dispatcher, referee, memory, budget,
// fake-cli harness spawner. Everything deterministic â€” no network, no real CLIs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runBot, botStatus, scout, memoryGet, memorySet, referee, buildPrompt, loadRun, listRuns } from '../src/bot.mjs';
import { listTasks } from '../src/tasks.mjs';

const ROOT = '.mesh-test-bot';
const FAKE_REPO = () => join(ROOT, 'probe'); // scoped repo for the scout: fast + hermetic
before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(FAKE_REPO(), 'src', 'bot'), { recursive: true });
  writeFileSync(join(FAKE_REPO(), 'src', 'bot', 'roles.mjs'), 'export const r = 1;\n');
  writeFileSync(join(FAKE_REPO(), 'package.json'), JSON.stringify({ name: 'probe', scripts: { test: 'node --test' } }));
});
after(() => { rmSync(ROOT, { recursive: true, force: true }); rmSync(join(ROOT, '..', 'mesh-test-sentinel.ts'), { force: true }); });

describe('conductor', () => {
  it('dry run: scout -> dispatcher (chained tasks) -> referee -> report, all under budget', async () => {
    const r = await runBot(ROOT, { goal: 'Ship checkout redesign for site/index.html and site/style.css', dry: true, repoPath: FAKE_REPO() });
    assert.equal(r.ok, true);
    assert.equal(r.run.status, 'done');
    assert.ok(r.run.phases.map((p) => p.name).join('â†’').includes('scout'));
    assert.ok(r.run.phases.length >= 4);
    // dispatcher split on the two mentioned files + review chained after
    assert.ok(r.tasks.length >= 2);
    const ids = r.tasks.map((t) => t.id);
    const all = listTasks(ROOT);
    const first = all.find((t) => t.id === ids[0]);
    assert.equal(first.status, 'pending'); // dry run claims nothing
    const last = all.find((t) => t.id === ids[ids.length - 1]);
    assert.ok(last.deps.length >= 1, 'chained review depends on the previous task');
    assert.ok(r.run.budget.spent < r.run.budget.coins);
    assert.ok(existsSync(join(ROOT, 'bots')), 'run ledger lives at .mesh/bots');
  });

  it('run ledger is durable + inspectable; botStatus reflects it', async () => {
    const runs = listRuns(ROOT);
    assert.ok(runs.length >= 1);
    const re = loadRun(ROOT, runs[runs.length - 1].id);
    assert.equal(re.goal.includes('checkout'), true);
    const st = botStatus(ROOT);
    assert.equal(st.ok, true);
    assert.equal(st.name, 'conductor');
    assert.ok(st.runs.length >= 1);
    assert.ok(st.taskCounts.done === 0); // dry run does not complete tasks
  });

  it('explicit tasksInput flows through; live harness uses the injected spawner', async () => {
    const fakeSpawn = (root, task) => ({ cli: 'fake', ok: true, code: 0, stdout: 'did the thing', prompt: buildPrompt(task) });
    const r = await runBot(ROOT, { goal: 'refactor auth flow', dry: false, tasksInput: [{ title: 'Refactor src/auth.mjs', paths: ['src/auth.mjs'] }], spawner: fakeSpawn, repoPath: FAKE_REPO() });
    assert.equal(r.ok, true);
    assert.equal(r.harness.cli, 'fake');
    assert.ok(r.run.phases.some((p) => p.name === 'harness'));
    const t = listTasks(ROOT).find((x) => x.title.includes('Refactor src/auth.mjs'));
    assert.ok(t, 'task created from tasksInput');
  });

  it('budget exhaustion fails soft with a structured error (never hangs)', async () => {
    const r = await runBot(ROOT, { goal: 'tiny', dry: true, budgetCoins: 0, budgetMin: 1, repoPath: FAKE_REPO() });
    assert.equal(r.ok, false);
    assert.match(String(r.error || r.run?.error), /budget/);
    assert.equal(r.run.status, 'failed');
  });

  it('scout builds the project map (hot dirs first) without touching node_modules', () => {
    const sc = scout(ROOT, { repoPath: FAKE_REPO() });
    assert.ok(sc.dirs.length >= 1);
    assert.ok(sc.dirs.every((d) => !d.dir.includes('node_modules')));
    assert.ok(sc.dirs.some((d) => d.dir.startsWith('src')));
  });

  it('referee produces a sequencing plan for overlapping scopes, silence otherwise', () => {
    const a = { actor: 'a', paths: ['src/api/**'], symbols: ['signin'], contracts: [] };
    const b = { actor: 'b', paths: ['src/api/auth.ts'], symbols: ['signin'], contracts: [] };
    const rf = referee([a, b]);
    assert.ok(rf.findings.length >= 1);
    assert.match(rf.plan[0].resolution, /sequencing/);
    const calm = referee([a, { actor: 'c', paths: ['docs/**'], symbols: [], contracts: [] }]);
    assert.equal(calm.findings.length, 0);
  });

  it('keeper memory: set â†’ get â†’ context window fetch â†’ bounded file', () => {
    const w = memorySet(ROOT, 'conductor', 'payments: percentages are integers; never floats');
    assert.equal(w.ok, true);
    assert.ok(memoryGet(ROOT, 'payments').includes('percentages are integers'));
    assert.ok(memoryGet(ROOT).includes('@conductor'));
    for (let i = 0; i < 210; i++) memorySet(ROOT, 'spam', `entry ${i} x`.repeat(8));
    const md = memoryGet(ROOT);
    assert.ok(md.length <= 4200, 'memory read stays bounded');
  });
});
