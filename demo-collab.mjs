// demo-collab.mjs — best-for-collaboration flows, all asserted.
import { rmSync } from 'node:fs';
import { join as rosterJoin, createRequest, respondRequest, completeRequest, inboxFor, addPin, routePin, recordDecision, digest, standup, exportCapsule, importCapsule, startPair, negotiate, checkWip, shouldToast, setQuiet, setAvailability, health, newcomerBrief, deliveryFor } from './src/collab.mjs';

const ROOT = '.mesh-democollab';
rmSync(ROOT, { recursive: true, force: true });
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('✓', m); };

// 1. roster + availability: dnd/focus get digests, never toasts
rosterJoin(ROOT, { actor: 'maya', role: 'human', skills: ['backend'] });
rosterJoin(ROOT, { actor: 'be-agent', role: 'agent', owner: 'maya', skills: ['api'] });
rosterJoin(ROOT, { actor: 'ui-agent', role: 'agent', owner: 'leo', skills: ['ui'] });
setAvailability(ROOT, 'maya', 'focus');
assert(deliveryFor('focus') === 'digest', 'focus mode: digest, not toast (quiet defaults)');
setAvailability(ROOT, 'maya', 'available');

// 2. requests: stranger -> approval inbox; trusted -> skip straight to working
const r1 = createRequest(ROOT, { from: 'leo', to: 'be-agent', text: 'please expose createdAt on /posts' });
assert(r1.status === 'queued', 'stranger request waits in owner approval inbox');
assert(inboxFor(ROOT, 'be-agent').length === 1, 'owner sees 1 approval');
const acc = respondRequest(ROOT, { id: r1.id, by: 'maya', accept: true });
assert(acc.status === 'working' && acc.childIntent, 'accept creates child intent of sender');
const done = completeRequest(ROOT, r1.id);
assert(done.statusChip === 'done', 'status chip tracks queued→working→done');
rosterJoin(ROOT, { actor: 'sam', role: 'human', trust: [] });
const r2 = createRequest(ROOT, { from: 'maya', to: 'ui-agent', text: 'tweak button' });
assert(r2.status === 'queued', 'untrusted still queues (no bypass)');

// 3. spatial pin routes to scope owners only
const pin = addPin(ROOT, { actor: 'maya', node: 'src/api/auth/login.ts', text: 'race here?' });
const got = routePin(pin, [
  { actor: 'be-agent', paths: ['src/api/auth/**'] },
  { actor: 'ui-agent', paths: ['src/ui/**'] },
]);
assert(got.includes('be-agent') && !got.includes('ui-agent'), 'pin reaches scope owner only (agents actually read it)');

// 4. decisions + 5-line digest + standup
recordDecision(ROOT, { actor: 'referee', topic: 'auth rename', decision: 'keep /api/auth until UI migrates' });
const d = digest(ROOT, { landed: ['chg-1'], proposed: ['chg-2'], collisions: ['auth overlap'] });
assert(d.length <= 5, `digest capped at 5 lines (${d.length})`);
const st = standup(ROOT, 'maya', { doing: 'review', done: 'auth gate', blocked: '' });
assert(st.includes('doing:'), 'standup: doing/done/blocked');

// 5. handoff capsule: hit a rate limit in one tool, finish in another
const cap = exportCapsule(ROOT, { actor: 'maya', intent: 'auth v2', decisions: ['keep old route'], constraints: ['no breaking UI'], files: ['src/api/auth.ts'], verdicts: ['T1 pass'] });
const imp = importCapsule(ROOT, cap.id);
assert(imp.ok && imp.brief.includes('read-only'), 'capsule imports as read-only brief (portable context)');

// 6. pairing + negotiation ladder escalates to human after 2 rounds
startPair(ROOT, { a: 'ann', b: 'bob', lease: 'src/shared/**' });
negotiate(ROOT, { a: 'ann', b: 'bob', topic: 'helper name' });
negotiate(ROOT, { a: 'ann', b: 'bob', topic: 'helper name' });
const esc = negotiate(ROOT, { a: 'ann', b: 'bob', topic: 'helper name' });
assert(esc.escalate && esc.to === 'human', 'negotiation escalates after 2 failed rounds (never modal, never infinite)');

// 7. WIP limits + quiet hours + toast cap
assert(!checkWip(ROOT, 'be-agent', 2).ok, 'WIP 2/2 blocks new intent (finish first)');
assert(checkWip(ROOT, 'be-agent', 1).ok, 'WIP 1/2 allows');
setQuiet(ROOT, 'leo', 22, 7);
assert(!shouldToast(ROOT, 'leo', Date.UTC(2026, 0, 1, 23)).toast, 'quiet hours batch into digest');
rosterJoin(ROOT, { actor: 'pinged', role: 'human' });
shouldToast(ROOT, 'pinged'); shouldToast(ROOT, 'pinged'); shouldToast(ROOT, 'pinged');
assert(!shouldToast(ROOT, 'pinged').toast, 'toast cap 3/10min, extras batched');

// 8. health: precision gates trust
const h = health({ tp: 9, fp: 1 });
assert(h.alertPrecision === 0.9 && h.trusted, 'precision ≥0.9 keeps warnings trusted');
assert(!health({ tp: 5, fp: 5 }).trusted, 'noisy warnings stay advisory until tuned');
const brief = newcomerBrief({ modules: ['Frontend'], intents: [{ actor: 'x', goal: 'y', paths: [] }], contracts: [], decisions: [] });
assert(brief.includes('Newcomer brief'), 'newcomer brief onboards in ~30 lines');
console.log('COLLAB ALL ASSERTIONS PASSED');
