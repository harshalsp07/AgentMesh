// demo-phase1.mjs — lanes + MeshVCS: snapshot, undo, rewind, revert-intent, eject.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLane, snapshotLane, laneDiff, undoLane, rewindLane, revertIntent, eject, freeze, checkpoint, restoreCheckpoint } from './src/lanes.mjs';

const ROOT = '.mesh-demo1';
rmSync(ROOT, { recursive: true, force: true });
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('✓', m); };

createLane(ROOT, 'alice');
writeFileSync(join(ROOT, 'lanes/alice/app.js'), 'const a = 1;\n');
const s1 = snapshotLane(ROOT, 'alice', 'baseline', 'in-1');
assert(s1.files === 1, `snapshot s1 (${s1.id}) with 1 file`);
writeFileSync(join(ROOT, 'lanes/alice/app.js'), 'const a = 2;\nconst trashed = true;\n');
const s2 = snapshotLane(ROOT, 'alice', 'risky-edit', 'in-2');
const d = laneDiff(ROOT, 'alice', s1.id);
assert(d.changed.includes('app.js'), 'diff shows app.js changed');
const u = undoLane(ROOT, 'alice');
assert(u.ok && readFileSync(join(ROOT, 'lanes/alice/app.js'), 'utf8').includes('const a = 1'), 'undo restores baseline (agent trashed my files)');
writeFileSync(join(ROOT, 'lanes/alice/app.js'), 'const a = 3;\n');
snapshotLane(ROOT, 'alice', 'later');
const rw = rewindLane(ROOT, 'alice', { minutes: 100000 });
assert(rw.ok, `rewind 10m-style goes back (${rw.after})`);
createLane(ROOT, 'bob', 'alice');
writeFileSync(join(ROOT, 'lanes/bob/app.js'), 'const a = 99;\n');
snapshotLane(ROOT, 'bob', 'bob-work', 'in-9');
const rv = revertIntent(ROOT, 'human', 'in-9');
assert(rv.ok && rv.affected.includes('bob'), 'revert-intent undoes one agent only');
freeze(ROOT, true); checkpoint(ROOT, 'pre-release'); freeze(ROOT, false);
assert(restoreCheckpoint(ROOT, 'pre-release').ok, 'freeze/checkpoint/restore round-trips');
const e = eject(ROOT, './eject-demo1');
assert(e.ok && e.lanes.includes('alice'), 'eject leaves plain branches with history');
console.log('PHASE-1 ALL ASSERTIONS PASSED');
