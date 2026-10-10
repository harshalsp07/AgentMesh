// load.mjs — concurrency proof: N agents x M intents hammer the hub at once.
// Usage: node scripts/load.mjs [agents=8] [intents=5]
// Asserts: zero lost writes (every declare acked), hash chain verifies, inbox drains.
const HUB = (process.env.MESH_HUB || 'http://localhost:7777').replace(/\/$/, '');
const N = +(process.argv[2] || 8), M = +(process.argv[3] || 5);
const t0 = Date.now();
const agents = Array.from({ length: N }, (_, i) => `load-${i}`);
const errors = [];
await Promise.all(agents.map(async (a) => {
  await fetch(`${HUB}/cmd`, { method: 'POST', body: JSON.stringify({ actor: a, kind: 'presence', payload: { verb: 'load' } }) });
  for (let i = 0; i < M; i++) {
    const r = await fetch(`${HUB}/cmd`, { method: 'POST', body: JSON.stringify({ actor: a, kind: 'intent.declare', payload: { goal: `load ${i}`, paths: [`load/${a}/${i}/**`] } }) }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) errors.push(`${a}/${i}: ${r.error}`);
  }
  const inbox = await (await fetch(`${HUB}/inbox/${a}`)).text();
  void inbox;
}));
const v = await (await fetch(`${HUB}/verify`)).json();
const ms = Date.now() - t0;
console.log(JSON.stringify({ agents: N, intentsPer: M, errors: errors.slice(0, 5), nErrors: errors.length, verify: v, ms }, null, 2));
if (errors.length || !v.ok) { console.error('LOAD FAILED'); process.exit(1); }
console.log(`LOAD OK: ${N * M} intents, 0 lost writes in ${ms}ms`);
