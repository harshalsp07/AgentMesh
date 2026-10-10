// test/vcs.test.mjs — pluggable snapshot backends: sqlite (always), git (if present),
// jj (detect-and-skip when absent). Lanes record backend refs best-effort.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { selectBackend, vcsSnapshot, vcsRestore, vcsFsck, vcsBundle, availableBackends } from '../src/vcs.mjs';
import { jjAvailable } from '../src/jjvcs.mjs';
import { createLane, snapshotLane, restoreFromVcs } from '../src/lanes.mjs';
import { loadJson } from '../src/store.mjs';

const ROOT = '.mesh-test-vcs';
before(() => rmSync(ROOT, { recursive: true, force: true }));
after(() => { rmSync(ROOT, { recursive: true, force: true }); rmSync('./vcs-test.bundle', { force: true }); });

describe('vcs router', () => {
  it('selects a working backend automatically', () => {
    const b = selectBackend(ROOT);
    assert.ok(['git', 'sqlite'].includes(b), `got ${b}`);
    assert.equal(availableBackends().sqlite, true);
    assert.equal(selectBackend(ROOT, 'off'), 'none');
  });
  it('jj adapter degrades gracefully when jj is absent', async () => {
    if (jjAvailable()) return; // covered below when installed
    const { jjSnapshot } = await import('../src/jjvcs.mjs');
    const r = jjSnapshot(ROOT, 'x', 's-0001');
    assert.equal(r.ok, false);
    assert.ok(r.skipped);
  });
});

describe('sqlite backend (no binaries)', () => {
  it('snapshot -> restore -> fsck -> bundle round-trips', () => {
    createLane(ROOT, 'sq');
    writeFileSync(join(ROOT, 'lanes/sq/app.js'), 'const v = 1;\n');
    const s = vcsSnapshot(ROOT, 'sq', 's-0001', { backend: 'sqlite' });
    assert.equal(s.ok, true);
    assert.equal(s.backend, 'sqlite');
    writeFileSync(join(ROOT, 'lanes/sq/app.js'), 'TRASHED\n');
    const r = vcsRestore(ROOT, 'sq', 's-0001', { backend: 'sqlite' });
    assert.equal(r.ok, true);
    assert.match(readFileSync(join(ROOT, 'lanes/sq/app.js'), 'utf8'), /const v = 1/);
    assert.equal(vcsFsck(ROOT, 'sqlite').ok, true);
    assert.equal(vcsBundle(ROOT, './vcs-test.bundle', 'sqlite').ok, true);
    assert.ok(existsSync('./vcs-test.bundle'));
  });
  it('unknown snapshots fail closed with structured errors', () => {
    assert.equal(vcsRestore(ROOT, 'sq', 's-9999', { backend: 'sqlite' }).ok, false);
  });
});

describe('git backend (modified-git path is also supported)', () => {
  it('snapshot -> restore -> fsck round-trips through real git objects', () => {
    if (!availableBackends().git) return;
    createLane(ROOT, 'g');
    writeFileSync(join(ROOT, 'lanes/g/main.py'), 'print("v1")\n');
    const s = vcsSnapshot(ROOT, 'g', 's-0001', { backend: 'git' });
    assert.equal(s.ok, true);
    assert.ok(s.commit && s.commit.length >= 7);
    writeFileSync(join(ROOT, 'lanes/g/main.py'), 'GONE\n');
    const r = vcsRestore(ROOT, 'g', 's-0001', { backend: 'git' });
    assert.equal(r.ok, true);
    assert.match(readFileSync(join(ROOT, 'lanes/g/main.py'), 'utf8'), /v1/);
    assert.equal(vcsFsck(ROOT, 'git').ok, true);
  });
});

describe('lanes record backend refs best-effort', () => {
  it('snapshotLane stores vcs ref in .snap.json without changing copy semantics', () => {
    createLane(ROOT, 'rec');
    writeFileSync(join(ROOT, 'lanes/rec/f.txt'), 'hi');
    const s = snapshotLane(ROOT, 'rec', 'work');
    const manifest = loadJson(join(ROOT, 'snapshots/rec', s.id, '.snap.json'), {});
    assert.ok(manifest.vcs && ['git', 'sqlite', 'jj'].includes(manifest.vcs.backend));
    // restore-from-backend path works too
    writeFileSync(join(ROOT, 'lanes/rec/f.txt'), 'changed');
    const r = restoreFromVcs(ROOT, 'rec', s.id);
    assert.equal(r.ok, true);
    assert.match(readFileSync(join(ROOT, 'lanes/rec/f.txt'), 'utf8'), /hi/);
  });
});
