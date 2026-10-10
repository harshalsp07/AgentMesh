// bus.mjs — Phase-4 (part): semantic bus. Two-channel messages (say+facts+refs),
// relevance tiers 0..3, loop defenses (hop limit, dedupe, rate limit, breaker, acks).
import { shortHash } from './store.mjs';

const hopLimit = (hops = 0) => hops >= 3;
export function makeMessage({ say, facts = {}, refs = [], from, to = null, cause = null, hops = 0 }) {
  if (String(say || '').length > 140) throw new Error('say > 140 chars');
  return { id: `msg-${shortHash(`${from}${say}${Date.now()}`)}`, say, facts, refs, from, to, cause, hops, t: Date.now() };
}
// relevance score -> tier: graph proximity + lease overlap + mention + severity - seen penalty
export function routeMessage(msg, actor, ctx = {}) {
  const { myScope = { paths: [], contracts: [] }, seen = new Set(), mentionsMe = false } = ctx;
  if (msg.to && msg.to !== actor) return 3; // not addressed to me
  if (hopLimit(msg.hops)) return 3; // stop chains, human next
  const key = shortHash(msg.say + JSON.stringify(msg.facts));
  if (seen.has(key)) return 3; // dedupe
  const refs = msg.refs || [];
  const near = refs.some((r) => (myScope.contracts || []).includes(r) || (myScope.paths || []).some((p) => String(r).includes(p.split('/')[0])));
  const sev = msg.facts?.effect === 'breaking' || msg.facts?.kind === 'contract.change' ? 2 : 0;
  let score = (near ? 3 : 0) + (mentionsMe ? 3 : 0) + sev;
  if (msg.facts?.kind === 'request' && msg.to === actor) score = 5;
  if (score >= 5) return 1; // interrupt
  if (score >= 2) return 2; // digest
  return 3; // ambient
}
// per-actor rate limiter + circuit breaker (>20 events/min => mute + alert owner)
const buckets = new Map();
export function checkRate(actor, limit = 20, windowMs = 60000) {
  const now = Date.now();
  const b = buckets.get(actor) || [];
  const fresh = b.filter((t) => now - t < windowMs);
  fresh.push(now);
  buckets.set(actor, fresh);
  if (fresh.length > limit) return { muted: true, reason: `circuit breaker: ${fresh.length} events/min from ${actor}; muted, owner alerted` };
  return { muted: false };
}
export function resetRates() { buckets.clear(); }
// typed request flow: @agent -> owner approval inbox -> child intent on accept
export function makeRequest({ from, to, text, ref = null }) {
  return makeMessage({ say: `@${to} ${String(text).slice(0, 100)}`, facts: { kind: 'request', action: text, status: 'queued' }, refs: ref ? [ref] : [], from, to });
}
// fact-sheet compiler v2: state -> bounded sheet (supersede + TTL + collapse A->B->C to A->C)
export function compileSheet({ actor, intents = [], contracts = [], requests = [], rules = [], budget = 3200, version = 0 }) {
  const lines = [`<!-- mesh v${version} · lane ${actor} -->`, '## My work'];
  for (const i of intents.filter((x) => x.actor === actor)) lines.push(`- Intent ${i.id}: ${i.goal} (${(i.paths || []).join(', ')})`);
  lines.push('## Contracts I use');
  const mine = intents.find((x) => x.actor === actor);
  const uses = mine?.uses || mine?.contracts || [];
  const pending = contracts.filter((c) => c.status === 'proposed' && (c.consumers || []).some((k) => uses.includes(k) || uses.includes(c.id)));
  lines.push(...(pending.length ? pending.map((c) => `- ${c.id} PROPOSED (${c.proposed_by?.diff || 'change'}) by ${c.proposed_by?.lane || '?-margin'}`) : ['- no pending changes']));
  lines.push('## Near me');
  lines.push(...(intents.filter((x) => x.actor !== actor).map((x) => `- ${x.actor}: ${x.goal}`) || ['- nobody']));
  lines.push('## Requests to me');
  const mine_req = requests.filter((r) => r.to === actor && r.facts?.status === 'queued');
  lines.push(...(mine_req.length ? mine_req.map((r) => `- from ${r.from}: ${r.facts.action} (queued|working|done|declined)`) : ['- none']));
  lines.push('## Rules', ...rules);
  const out = lines.join('\n');
  return out.length > budget ? out.slice(0, budget) + '\n<!-- truncated: budget -->\n' : out;
}
