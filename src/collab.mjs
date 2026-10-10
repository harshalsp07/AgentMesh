// collab.mjs — collaboration layer: the best of team + agent teamwork in one place.
// Roster, availability, requests w/ owner approval, spatial pins, decision records,
// digests/standups, handoff capsules, pairing + negotiation, WIP limits, quiet hours,
// toast budgets, health metrics, invites + newcomer briefs. Zero deps, file-backed.
import { shortHash, loadJson, saveJson, ulid } from './store.mjs';

const file = (root) => `${root}/collab.json`;
export const WIP_DEFAULT = 2;
export const TOAST_CAP = 3;
export const TOAST_WINDOW_MS = 10 * 60_000;

export function loadCollab(root) {
  return loadJson(file(root), {
    roster: {}, requests: [], pins: [], decisions: [],
    pairs: [], negotiations: [], standups: {}, toasts: {}, Capsules: [],
  });
}
function save(root, c) { saveJson(file(root), c); }

// ---- roster: who is here, what they can do, when they can be interrupted ----
export function join(root, { actor, role = 'human', skills = [], tz = 'UTC', owner = null, trust = [] }) {
  const c = loadCollab(root);
  c.roster[actor] = { actor, role, skills, tz, owner, trust, avail: 'available', joined: Date.now() };
  save(root, c);
  const code = shortHash(actor + Date.now()).slice(0, 6).toUpperCase();
  return { ok: true, actor, invite: { code, link: `mesh://join/${code}`, qr: `MESH:${code}:${actor}` } };
}
export function setAvailability(root, actor, avail) {
  const c = loadCollab(root);
  if (!c.roster[actor]) return { ok: false, error: 'unknown actor' };
  if (!['available', 'focus', 'dnd', 'away', 'offline'].includes(avail)) return { ok: false, error: 'bad availability' };
  c.roster[actor].avail = avail;
  save(root, c);
  return { ok: true, actor, avail };
}
// dnd/focus never get toasts; they get digests. Returns delivery mode.
export const deliveryFor = (avail) => (avail === 'dnd' || avail === 'focus' ? 'digest' : 'toast');

// ---- requests: @agent asks with owner approval; trusted teammates skip it ----
export function createRequest(root, { from, to, text, ref = null }) {
  const c = loadCollab(root);
  const id = ulid('req-');
  const trusted = (c.roster[to]?.trust || []).includes(from);
  const r = {
    id, from, to, text: String(text).slice(0, 200), ref,
    status: trusted ? 'working' : 'queued', // trusted skip: straight to working
    childIntent: trusted ? ulid('in-') : null, t: Date.now(), sla_min: 30,
  };
  c.requests.push(r);
  save(root, c);
  return { ...r, approved: trusted, note: trusted ? 'trusted: approval skipped' : 'in owner approval inbox' };
}
export function respondRequest(root, { id, by, accept, reason = '' }) {
  const c = loadCollab(root);
  const r = c.requests.find((x) => x.id === id);
  if (!r) return { ok: false, error: 'unknown request' };
  if (c.roster[r.to]?.owner && by !== c.roster[r.to].owner && by !== r.to) return { ok: false, error: 'only the owner approves' };
  r.status = accept ? 'working' : 'declined';
  if (accept && !r.childIntent) r.childIntent = ulid('in-');
  if (!accept) r.reason = reason.slice(0, 140);
  r.decidedBy = by;
  save(root, c);
  return { ok: true, id, status: r.status, childIntent: r.childIntent || null };
}
export function completeRequest(root, id) {
  const c = loadCollab(root);
  const r = c.requests.find((x) => x.id === id);
  if (!r) return { ok: false, error: 'unknown request' };
  r.status = 'done';
  save(root, c);
  return { ok: true, id, statusChip: chip(id, 'done') };
}
export const chip = (id, status) => ({ queued: 'queued', working: 'working', done: 'done', declined: 'declined' }[status] || status);
export const inboxFor = (root, owner) => {
  const c = loadCollab(root);
  return c.requests.filter((r) => r.to === owner && r.status === 'queued');
};

// ---- WIP limits: stop starting, start finishing ----
export function checkWip(root, actor, activeCount, limit = WIP_DEFAULT) {
  if (activeCount >= limit) return { ok: false, reason: `WIP limit: ${actor} has ${activeCount}/${limit} active intents; finish or park one first` };
  return { ok: true };
}

// ---- spatial pins: sticky notes agents actually read (typed + routed by scope) ----
export function addPin(root, { actor, node, text }) {
  const c = loadCollab(root);
  const pin = { id: ulid('pin-'), actor, node, text: String(text).slice(0, 280), t: Date.now() };
  c.pins.push(pin);
  save(root, c);
  return pin;
}
// recipients: actors whose intent scope touches the pin's file/contract
export function routePin(pin, intents = []) {
  const file = String(pin.node).split('@').pop().split(':').pop();
  return intents.filter((i) => i.actor !== pin.actor && (
    (i.paths || []).some((p) => file.startsWith(p.replace(/\*+$/, '').replace(/\/$/, '')) || p.replace(/\*+$/, '').startsWith(file)) ||
    (i.contracts || []).includes(pin.node) || (i.uses || []).includes(pin.node)
  )).map((i) => i.actor);
}

// ---- decisions: one-line record for every contract change (the Referee writes these) ----
export function recordDecision(root, { actor, topic, decision, contract = null }) {
  const c = loadCollab(root);
  const d = { id: ulid('dec-'), actor, topic, decision: String(decision).slice(0, 200), contract, t: Date.now() };
  c.decisions.push(d);
  save(root, c);
  return d;
}

// ---- digest (every 10 min, 5 lines) + standup ----
export function digest(root, { landed = [], proposed = [], blocked = [], collisions = [] } = {}) {
  const c = loadCollab(root);
  const lines = [];
  if (landed.length) lines.push(`landed: ${landed.slice(0, 2).join(', ')}`);
  if (proposed.length) lines.push(`proposed: ${proposed.slice(0, 2).join(', ')}`);
  if (blocked.length) lines.push(`blocked: ${blocked.slice(0, 2).join(', ')}`);
  if (collisions.length) lines.push(`collisions: ${collisions.slice(0, 2).join(', ')}`);
  const recent = c.decisions.slice(-2).map((d) => `${d.topic}: ${d.decision}`);
  if (recent.length) lines.push(`decided: ${recent.join('; ')}`);
  return lines.slice(0, 5);
}
export function standup(root, actor, { doing = '', done = '', blocked = '' } = {}) {
  const c = loadCollab(root);
  c.standups[actor] = { doing, done, blocked, t: Date.now() };
  save(root, c);
  return [`${actor} — doing: ${doing || '—'}`, `done: ${done || '—'}`, `blocked: ${blocked || '—'}`].join('\n');
}

// ---- handoff capsules: finish in one tool, continue in another ----
export function exportCapsule(root, { actor, intent, decisions = [], constraints = [], files = [], verdicts = [] }) {
  const c = loadCollab(root);
  const cap = { id: ulid('cap-'), actor, intent, decisions, constraints, files, verdicts, t: Date.now() };
  c.Capsules.push(cap);
  save(root, c);
  return cap;
}
export function importCapsule(root, id) {
  const c = loadCollab(root);
  const cap = c.Capsules.find((x) => x.id === id);
  if (!cap) return { ok: false, error: 'unknown capsule' };
  const brief = [
    `intent: ${cap.intent}`,
    `decisions: ${cap.decisions.join('; ') || '—'}`,
    `constraints: ${cap.constraints.join('; ') || '—'}`,
    `files: ${cap.files.join(', ') || '—'}`,
    `last verdicts: ${cap.verdicts.join(', ') || '—'}`,
    `from: ${cap.actor} (read-only; verify before continuing)`,
  ].join('\n');
  return { ok: true, brief };
}

// ---- pairing + negotiation ladder (scratch lane, 2 rounds, then human) ----
export function startPair(root, { a, b, lease }) {
  const c = loadCollab(root);
  const pair = { id: ulid('pair-'), a, b, lease, scratch: `scratch-${shortHash(a + b + Date.now()).slice(0, 6)}`, t: Date.now(), active: true };
  c.pairs.push(pair);
  save(root, c);
  return pair;
}
export function negotiate(root, { a, b, topic }) {
  const c = loadCollab(root);
  let n = c.negotiations.find((x) => x.a === a && x.b === b && x.topic === topic && !x.resolved);
  if (!n) { n = { id: ulid('neg-'), a, b, topic, rounds: 0, resolved: false }; c.negotiations.push(n); }
  n.rounds++;
  if (n.rounds > 2) return { escalate: true, to: 'human', reason: `2 failed rounds on "${topic}"; human decides`, id: n.id };
  save(root, c);
  return { escalate: false, round: n.rounds, scratch: `scratch-${n.id.slice(-6)}`, note: `round ${n.rounds}/2 in scratch lane` };
}

// ---- quiet hours + toast budget: batch, don't ping ----
export function shouldToast(root, human, nowMs = Date.now()) {
  const c = loadCollab(root);
  const prefs = c.roster[human] || {};
  // quiet hours: prefs.quiet = [startHour, endHour] in their tz (UTC-approx for MVP)
  if (prefs.quiet) {
    const h = new Date(nowMs).getUTCHours();
    const [s, e] = prefs.quiet;
    const inQuiet = s <= e ? (h >= s && h < e) : (h >= s || h < e);
    if (inQuiet) return { toast: false, mode: 'digest', reason: 'quiet hours; batched into digest' };
  }
  const log = (c.toasts[human] || []).filter((t) => nowMs - t < TOAST_WINDOW_MS);
  if (log.length >= TOAST_CAP) return { toast: false, mode: 'digest', reason: `${TOAST_CAP} toasts/10min cap; extra batched` };
  log.push(nowMs);
  c.toasts[human] = log;
  save(root, c);
  return { toast: true, mode: 'toast' };
}
export function setQuiet(root, human, startHour, endHour) {
  const c = loadCollab(root);
  c.roster[human] = { ...(c.roster[human] || { actor: human }), quiet: [startHour, endHour] };
  save(root, c);
  return { ok: true };
}

// ---- health: is collaboration working? track precision, drift time, waste ----
export function health({ tp = 0, fp = 0, driftTimes = [], wastedMin = 0, queueWait = [], interventions = 0 } = {}) {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    alertPrecision: +precision.toFixed(2),
    trusted: precision >= 0.9,
    meanDriftDetectMin: +avg(driftTimes).toFixed(1),
    wastedAgentMin: wastedMin,
    meanQueueWaitMin: +avg(queueWait).toFixed(1),
    humanInterventions: interventions,
    note: precision < 0.9 ? 'precision <0.9: keep cross-lane advisory, tune forecast' : 'warnings trusted',
  };
}
// newcomer brief: repo map + live work + contracts + decisions in ~30 lines
export function newcomerBrief({ modules = [], intents = [], contracts = [], decisions = [] }) {
  const out = ['# Newcomer brief (generated, verify before acting)'];
  out.push(`modules: ${modules.slice(0, 8).join(', ') || '—'}`);
  out.push('## Live work');
  out.push(...(intents.slice(0, 8).map((i) => `- ${i.actor}: ${i.goal} (${(i.paths || []).join(', ')})`) || ['- quiet']));
  out.push('## Contracts changing');
  out.push(...(contracts.filter((x) => x.status === 'proposed').slice(0, 5).map((x) => `- ${x.id} (${x.proposed_by?.diff})`) || ['- none']));
  out.push('## Recent decisions');
  out.push(...(decisions.slice(-5).map((d) => `- ${d.topic}: ${d.decision}`) || ['- none']));
  return out.join('\n');
}
