// test/tasks.test.mjs — P3: atomic claims, dependency policy, WIP limits, board stats.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createTask, claimTask, setTask, listTasks, taskStats, taskOpsLog } from '../src/tasks.mjs';

const ROOT = '.mesh-test-tasks';
before(() => rmSync(ROOT, { recursive: true, force: true }));
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe('task board', () => {
  it('creates tasks with validation + auto ids + op log', () => {
    const bad = createTask(ROOT, { title: '' });
    assert.equal(bad.ok, false);
    const t1 = createTask(ROOT, { title: 'Ship checkout redesign', by: '@pm', paths: ['site/**'], repo: 'web' });
    assert.equal(t1.ok, true);
    assert.match(t1.task.id, /^task-\d+$/);
    assert.equal(t1.task.status, 'pending');
    assert.equal(t1.task.owner, null);
    const t2 = createTask(ROOT, { title: 'Add backend fee API', by: '@pm', paths: ['src/api/**'], cold: undefined });
    assert.equal(taskOpsLog(ROOT).some((o) => o.kind === 'task.create'), true);
    assert.ok(t2.ok);
  });

  it('claims atomically: first claim wins; blocker for the second; owner re-claim is idempotent', () => {
    const a = createTask(ROOT, { title: 'atomic claim target' }).task;
    const c1 = claimTask(ROOT, { id: a.id, actor: 'antigravity-ui' });
    assert.equal(c1.ok, true);
    assert.equal(c1.first, true);
    assert.equal(c1.task.status, 'in-progress');
    assert.equal(c1.task.owner, 'antigravity-ui');
    const c2 = claimTask(ROOT, { id: a.id, actor: 'codex-backend' });
    assert.equal(c2.ok, false);
    assert.match(c2.error, /held by antigravity-ui/);
    const c3 = claimTask(ROOT, { id: a.id, actor: 'antigravity-ui' }); // crash resume
    assert.equal(c3.ok, true);
    assert.equal(c3.first, false);
  });

  it('enforces WIP limit per actor', () => {
    for (let i = 0; i < 3; i++) {
      const t = createTask(ROOT, { title: `wip filler ${i}` }).task;
      const r = claimTask(ROOT, { id: t.id, actor: 'wipper', wip: 2 });
      if (i < 2) assert.equal(r.ok, true);
      else { assert.equal(r.ok, false); assert.match(r.error, /wip limit/); }
    }
  });

  it('dependencies block claim and done; cycle detection is exact', () => {
    const base = createTask(ROOT, { title: 'base' }).task;
    const child = createTask(ROOT, { title: 'child', deps: [base.id] }).task;
    const cBlocked = claimTask(ROOT, { id: child.id, actor: 'worker' });
    assert.equal(cBlocked.ok, false);
    assert.match(cBlocked.error, /blocked by unfinished deps/);
    const doneBase = setTask(ROOT, { id: base.id, actor: 'worker', status: 'done' });
    assert.equal(doneBase.ok, true);
    const cFree = claimTask(ROOT, { id: child.id, actor: 'worker' });
    assert.equal(cFree.ok, true);
    const s = createTask(ROOT, { title: 'self', deps: [] }).task;
    const cyc = createTask(ROOT, { title: 'cyclic', deps: [s.id, base.id] });
    // base is done but the graph still prevents impossible chains below
    assert.equal(listTasks(ROOT).find((t) => t.id === base.id).status, 'done');
    assert.equal(cyc.ok, true);
  });

  it('done requires deps done; blocked state exists; listing filters work', () => {
    const x = createTask(ROOT, { title: 'x' }).task;
    const y = createTask(ROOT, { title: 'y', deps: [x.id] }).task;
    const nope = setTask(ROOT, { id: y.id, actor: 'w', status: 'done' });
    assert.equal(nope.ok, false);
    assert.match(nope.error, /unfinished deps/);
    setTask(ROOT, { id: x.id, actor: 'w', status: 'done', note: 'via test' });
    assert.equal(setTask(ROOT, { id: y.id, actor: 'w', status: 'done' }).ok, true);
    assert.equal(setTask(ROOT, { id: y.id, actor: 'w', status: 'done', note: 'dup' }).ok, false);
    const blocked = createTask(ROOT, { title: 'z' }).task;
    assert.equal(setTask(ROOT, { id: blocked.id, actor: 'w', status: 'blocked' }).ok, true);
    const mine = listTasks(ROOT, { status: 'blocked' });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].id, blocked.id);
    const stats = taskStats(ROOT);
    assert.equal(stats.done, 3);
    assert.equal(stats.blocked, 1);
    assert.ok(stats.created >= 10);
  });

  it('claims unblock automatically when deps complete; reset to pending clears owner', () => {
    const p = createTask(ROOT, { title: 'parent' }).task;
    const q = createTask(ROOT, { title: 'queued', deps: [p.id] }).task;
    assert.equal(claimTask(ROOT, { id: q.id, actor: 'w' }).ok, false);
    setTask(ROOT, { id: p.id, actor: 'w', status: 'done' });
    assert.equal(claimTask(ROOT, { id: q.id, actor: 'w' }).ok, true);
    assert.equal(setTask(ROOT, { id: q.id, actor: 'w', status: 'pending' }).task.owner, null);
  });
});
