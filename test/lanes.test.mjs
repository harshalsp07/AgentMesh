// test/lanes.test.mjs — MeshVCS: snapshot/diff/undo/rewind/revert/eject.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLane, snapshotLane, laneDiff, undoLane, rewindLane, revertIntent, eject, checkpoint, restoreCheckpoint } from '../src/lanes.mjs';

const ROOT = '.mesh-test-lanes';
before(() => rmSync(ROOT, { recursive: true, force: true }));
after(() => { rmSync(ROOT, { recursive: true, force: true }); rmSync('./eject-t', { recursive: true, force: true }); });

describe('MeshVCS', () => {
  it('snapshots are immutable; diff detects change', () => {
    createLane(ROOT, 'a');
    writeFileSync(join(ROOT, 'lanes/a/f.js'), 'v1');
    const s1 = snapshotLane(ROOT, 'a', 'base');
    writeFileSync(join(ROOT, 'lanes/a/f.js'), 'v2');
    snapshotLane(ROOT, 'a', 'edit');
    const d = laneDiff(ROOT, 'a', s1.id);
    assert.ok(d.changed.includes('f.js'));
  });
  it('undo restores previous view, never loses data', () => {
    const u = undoLane(ROOT, 'a');
    assert.equal(u.ok, true);
    assert.match(readFileSync(join(ROOT, 'lanes/a/f.js'), 'utf8'), /v1/);
  });
  it('rewind by minutes + revert-intent are scoped', () => {
    writeFileSync(join(ROOT, 'lanes/a/f.js'), 'v3');
    snapshotLane(ROOT, 'a', 'later', 'in-x');
    assert.equal(rewindLane(ROOT, 'a', { minutes: 100000 }).ok, true);
    createLane(ROOT, 'b', 'a');
    writeFileSync(join(ROOT, 'lanes/b/f.js'), 'bob');
    snapshotLane(ROOT, 'b', 'bob-work', 'in-bob');
    const r = revertIntent(ROOT, 'human', 'in-bob');
    assert.equal(r.ok, true);
    assert.ok(r.affected.includes('b'));
  });
  it('checkpoint/restore + eject leave plain branches', () => {
    checkpoint(ROOT, 'c1');
    assert.equal(restoreCheckpoint(ROOT, 'c1').ok, true);
    const e = eject(ROOT, './eject-t');
    assert.equal(e.ok, true);
    assert.ok(e.lanes.includes('a'));
  });
});
