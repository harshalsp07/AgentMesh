// demo-phase2.mjs — harness tiers + integration queue (CAS, bisect, human dial).
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runT0, runT1 } from './src/harness.mjs';
import { propose, approve, drain, loadQueue } from './src/queue.mjs';
import { createLane, snapshotLane } from './src/lanes.mjs';

const ROOT = '.mesh-demo2';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('✓', m); };
const lanePath = (l) => join(ROOT, 'lanes', l);

// good lane
createLane(ROOT, 'good'); writeFileSync(join(lanePath('good'), 'ok.js'), 'const x = 1;\n');
snapshotLane(ROOT, 'good', 'work');
// bad lane: syntax error + secret
createLane(ROOT, 'bad'); writeFileSync(join(lanePath('bad'), 'bad.js'), 'const = BROKEN\nconst k = "sk-abcdefghijklmnop123456";\n');
snapshotLane(ROOT, 'bad', 'work');

const t0bad = runT0(lanePath('bad'));
assert(t0bad.status === 'fail' && t0bad.failures.some((f) => f.kind === 'secret'), `T0 flags secret (${t0bad.failures.map((f) => f.kind).join(',')})`);
assert(t0bad.failures.length <= 20, 'verdict capped at 20 lines');
const t1good = runT1(lanePath('good'), { changed: ['ok.js'] });
assert(t1good.status === 'pass', 'T1 passes clean lane');

const cs1 = propose(ROOT, { lane: 'good', actor: 'alice', intent: 'in-1', base: 't0', head: 'h1', files: ['ok.js'], human: true });
approve(ROOT, cs1.change_id, 'alice'); // human dial: approve-to-land needs approval unless human author... approved anyway
const r1 = drain(ROOT, lanePath);
assert(r1.results.some((r) => r.status === 'landed'), `good changeset lands (trunk=${r1.trunk})`);
const cs2 = propose(ROOT, { lane: 'bad', actor: 'bot', intent: 'in-2', base: r1.trunk, head: 'h2', files: ['bad.js'] });
approve(ROOT, cs2.change_id);
const r2 = drain(ROOT, lanePath);
const bad = r2.results.find((r) => r.change_id === cs2.change_id);
assert(['quarantined', 'proposed'].includes(bad.status) && bad.status !== 'landed', `bad changeset never lands (${bad.status}, retries->quarantine/awaiting-approval)`);
assert(loadQueue(ROOT).landed.length === 1, 'trunk advanced exactly once (CAS, one writer)');
console.log('PHASE-2 ALL ASSERTIONS PASSED');
