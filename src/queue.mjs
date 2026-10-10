// queue.mjs — Phase-2: the only road to trunk. Propose -> T0/T1 -> queue ->
// speculative stack T2 -> CAS on trunk head -> trunk.moved. Bisect on failure.
import { shortHash, loadJson, saveJson } from './store.mjs';
import { loadPolicy, landingMode } from './policy.mjs';
import { runT0, runT1, runT2 } from './harness.mjs';

const qFile = (root) => `${root}/queue.json`;
export function loadQueue(root) { return loadJson(qFile(root), { trunk: 't0', queued: [], landed: [], quarantined: [], approvals: {} }); }
function saveQ(root, q) { saveJson(qFile(root), q); }

export function propose(root, { lane, actor, intent, base, head, files = [], human = false, hotfix = false }) {
  const q = loadQueue(root);
  const change_id = `chg-${shortHash(`${lane}${intent}${Date.now()}`)}`;
  const cs = { change_id, lane, actor, intent, base, head, files, status: 'proposed', human, hotfix, age: Date.now(), verdicts: [], retries: 0 };
  q.queued.push(cs);
  // priority: human before agent, then age; hotfix jumps only with approval
  q.queued.sort((a, b) => {
    if (!!a.hotfix !== !!b.hotfix) return a.hotfix ? (q.approvals[a.change_id] ? -1 : 1) : 1;
    if (!!a.human !== !!b.human) return a.human ? -1 : 1;
    return a.age - b.age;
  });
  saveQ(root, q);
  return cs;
}
export function approve(root, change_id, by = 'human') {
  const q = loadQueue(root);
  q.approvals[change_id] = { by, t: Date.now() };
  saveQ(root, q);
  return { ok: true };
}

// policy dial: auto-land / approve-to-land / approve-and-pair
export function landingDecision(root, changeset) {
  const policy = loadPolicy(root.replace(/\/lanes\/.*/, '').replace(/$/, '') || '.mesh');
  const modes = (changeset.files || ['src/x']).map((f) => landingMode(policy, f));
  if (modes.includes('approve-and-pair')) return { mode: 'approve-and-pair', needsHuman: true };
  if (modes.includes('approve-to-land')) return { mode: 'approve-to-land', needsHuman: !changeset.human };
  return { mode: 'auto-land', needsHuman: false };
}

// drain the queue: batch <=4, speculative stack, CAS, bisect culprit on failure
export function drain(root, laneDirOf, { batch = 4 } = {}) {
  const q = loadQueue(root);
  const results = [];
  const take = q.queued.filter((c) => c.status === 'proposed').slice(0, batch);
  if (!take.length) return { drained: 0, results };
  // speculative stack: trunk + each ahead
  let stackHead = q.trunk;
  for (const cs of take) {
    const dir = laneDirOf(cs.lane);
    const t0 = runT0(dir, { changed: cs.files });
    const t1 = runT1(dir, { changed: cs.files });
    cs.verdicts.push(t0.id, t1.id);
    const decision = landingDecision(root, cs);
    if (decision.needsHuman && !q.approvals[cs.change_id]) {
      cs.status = 'proposed'; results.push({ change_id: cs.change_id, status: 'awaiting-approval', mode: decision.mode });
      continue;
    }
    if (t0.status === 'fail' || t1.status === 'fail') {
      cs.retries++;
      if (cs.retries >= 3) { cs.status = 'quarantined'; q.quarantined.push({ ...cs, reason: '3 retries exhausted; escalated to human' }); }
      results.push({ change_id: cs.change_id, status: cs.status, verdicts: cs.verdicts.slice(-2) });
      continue;
    }
    cs.status = 'verifying';
    const t2 = runT2(dir);
    cs.verdicts.push(t2.id);
    if (t2.status === 'fail') {
      // bisect: single culprit here (one cs); quarantine it, others continue
      cs.status = 'quarantined';
      q.quarantined.push({ ...cs, reason: t2.failures[0]?.message || 'T2 failed' });
      results.push({ change_id: cs.change_id, status: 'quarantined', reason: 'bisected as culprit' });
      continue;
    }
    // CAS on trunk head
    const expected = stackHead;
    if (q.trunk !== expected && stackHead !== q.trunk) { results.push({ change_id: cs.change_id, status: 'retry', reason: 'trunk moved; re-verify' }); continue; }
    stackHead = shortHash(stackHead + cs.change_id);
    q.trunk = stackHead;
    cs.status = 'landed'; cs.head = stackHead;
    q.landed.push(cs);
    results.push({ change_id: cs.change_id, status: 'landed', trunk: q.trunk });
  }
  q.queued = q.queued.filter((c) => !['landed', 'quarantined'].includes(c.status));
  saveQ(root, q);
  return { drained: take.length, trunk: q.trunk, results, moved: results.some((r) => r.status === 'landed') };
}
export const trunkHead = (root) => loadQueue(root).trunk;
