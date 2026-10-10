// tui.mjs — terminal dashboard for SSH-only setups. Same /api/overview as the canvas.
// `node src/tui.mjs` (MESH_HUB or http://localhost:7777). Keys: q quit, r refresh, 1-4 panels.
const HUB = (process.env.MESH_HUB || 'http://localhost:7777').replace(/\/$/, '');
const C = { reset: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m' };
let tab = 0, ov = null, err = '';
const tabs = ['Team', 'Queue', 'Contracts', 'Decisions'];
async function poll() {
  try { ov = await (await fetch(`${HUB}/api/overview`)).json(); err = ''; }
  catch (e) { err = `hub unreachable (${HUB}) — run: node src/hub.mjs`; }
}
function line(s = '') { return s.slice(0, process.stdout.columns - 1); }
function render() {
  const W = process.stdout.columns || 80;
  let out = '\x1b[2J\x1b[H';
  out += `${C.b}AgentMesh${C.reset} ${C.dim}${HUB}${C.reset}  trunk=${C.g}${ov?.trunk || '?'}${C.reset} seq=${ov?.seq ?? '?'}${ov?.frozen ? ` ${C.r}FROZEN${C.reset}` : ''}\n`;
  out += tabs.map((t, i) => (i === tab ? `${C.b}[${t}]${C.reset}` : ` ${t} `)).join('') + `${C.dim}   q quit · r refresh · 1-4 tabs${C.reset}\n`;
  out += '─'.repeat(W) + '\n';
  if (err) out += `${C.r}${err}${C.reset}\n`;
  else if (tab === 0) {
    for (const r of ov.roster) out += line(`${C.c}●${C.reset} ${r.actor} ${C.dim}${r.role} · ${r.avail || 'available'}${(r.skills || []).length ? ' · ' + r.skills.join(',') : ''}${C.reset}\n`);
    for (const i of ov.intents || []) out += line(`  ${C.dim}↳ ${i.actor}: ${i.goal} (${(i.paths || []).join(',')})${C.reset}\n`);
    for (const c of ov.collisions || []) out += line(`  ${C.r}⚠ ${c.a} × ${c.b} — ${c.grade}${C.reset}\n`);
    if (!ov.roster.length) out += `${C.dim}(empty room — mesh roster join <name>)${C.reset}\n`;
  } else if (tab === 1) {
    for (const q of ov.queue.items || []) out += line(` ${q.change_id} ${q.lane} ${q.status === 'landed' ? C.g : C.y}${q.status}${C.reset}\n`);
    out += `${C.dim}queued ${ov.queue.queued} · landed ${ov.queue.landed} · quarantined ${ov.queue.quarantined}${C.reset}\n`;
    for (const l of ov.lanes || []) out += line(` ${l.actor}: head ${l.head || '—'} · ${l.snaps} snaps\n`);
  } else if (tab === 2) {
    for (const c of (ov.contracts || []).slice(0, 20)) out += line(` ${c.status === 'stable' ? C.g : C.y}${c.status}${C.reset} ${c.id} ${c.diff ? `(${c.diff})` : ''}\n`);
    if (!(ov.contracts || []).length) out += `${C.dim}(none — mesh contract extract <lane>)${C.reset}\n`;
  } else {
    for (const d of ov.decisions || []) out += line(` • ${d.topic}: ${d.decision}\n`);
    for (const r of (ov.requests || []).slice(-5)) out += line(` @${r.to} ← ${r.from}: ${r.text} ${C.dim}(${r.status})${C.reset}\n`);
  }
  process.stdout.write(out);
}
export async function runTui({ cycles = Infinity } = {}) {
  if (!process.stdin.isTTY) { await poll(); console.log(JSON.stringify({ trunk: ov?.trunk, roster: ov?.roster?.length || 0, collisions: ov?.collisions || [], err: err || undefined }, null, 2)); return; }
  process.stdin.setRawMode(true);
  process.stdin.on('data', (k) => {
    const s = k.toString();
    if (s === 'q' || s === '\x03') { process.stdout.write('\x1b[0m\x1b[2J\x1b[H'); process.exit(0); }
    if (s === 'r') poll().then(render);
    if (s >= '1' && s <= '4') { tab = +s - 1; render(); }
  });
  for (let i = 0; i < cycles; i++) { await poll(); render(); await new Promise((r) => setTimeout(r, 4000)); }
}
if (process.argv[1] && process.argv[1].endsWith('tui.mjs')) runTui();
