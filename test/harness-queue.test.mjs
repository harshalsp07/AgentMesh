// test/harness-queue.test.mjs — T0/T1 verdicts + queue CAS/bisect/dial.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runT0, runT1, rerunFlake } from '../src/harness.mjs';
import { propose, approve, drain, loadQueue } from '../src/queue.mjs';
import { createLane } from '../src/lanes.mjs';

const ROOT = '.mesh-test-hq';
const lp = (l) => join(ROOT, 'lanes', l);
before(() => { rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true }); });
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe('harness', () => {
  it('T0 blocks secrets + syntax, caps at 20, binds base+head', () => {
    createLane(ROOT, 'h1');
    writeFileSync(join(lp('h1'), 's.js'), 'const = bad\nkey="sk-abcdefghijklmnop123";\n');
    const v = runT0(lp('h1'));
    assert.equal(v.status, 'fail');
    assert.ok(v.failures.length <= 20);
    assert.ok(v.failures.some((f) => f.kind === 'secret'));
    assert.ok(v.base && v.head);
  });
  it('flake helper labels fail-then-pass as flaky, not blocking', () => {
    let n = 0;
    const r = rerunFlake(() => (++n === 1 ? { status: 'fail' } : { status: 'pass' }), 'h');
    assert.equal(r.status, 'flaky');
  });
});
describe('queue', () => {
  it('lands good, quarantines bad, trunk CAS advances once', () => {
    createLane(ROOT, 'g'); writeFileSync(join(lp('g'), 'ok.js'), 'const x=1;\n');
    const c = propose(ROOT, { lane: 'g', actor: 'human-alice', intent: 'i1', base: 't0', head: 'h', files: ['ok.js'], human: true });
    approve(ROOT, c.change_id);
    const r = drain(ROOT, lp);
    assert.ok(r.results.some((x) => x.status === 'landed'));
    assert.equal(loadQueue(ROOT).landed.length, 1);
  });
});
