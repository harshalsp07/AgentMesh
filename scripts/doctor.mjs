// doctor.mjs — mesh doctor: ports, driver, network, versions, board.
import { existsSync } from 'node:fs';
const HUB = process.env.MESH_HUB || 'http://localhost:7777';
const out = { node: process.version, hub: false, board: null, liveblocks: 'hub-fallback', files: {}, driver: null, network: {}, versions: {} };
try { const r = await fetch(`${HUB}/health`); out.hub = r.ok; } catch { out.hub = false; }
if (out.hub) {
  try {
    const b = await (await fetch(`${HUB}/api/board`)).json();
    out.board = { shapes: Object.keys(b.shapes || {}).length, seq: b.seq ?? null };
  } catch { out.board = { error: 'board unreachable' }; }
  try {
    const a = await (await fetch(`${HUB}/api/liveblocks-auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    out.liveblocks = a.ok ? 'cloud-ready' : 'hub-fallback';
  } catch { out.liveblocks = 'hub-fallback'; }
}
for (const f of ['.env.example', 'site/board-tldraw.js', 'docs/BOARD.md', '.agents/skills/ui-unslop/SKILL.md']) {
  out.files[f] = existsSync(new URL(`../${f}`, import.meta.url));
}
try {
  const { detectDriver } = await import('../src/drivers.mjs');
  out.driver = detectDriver();
} catch (e) { out.driver = `error: ${e.message}`; }
for (const host of ['registry.npmjs.org', 'api.anthropic.com']) {
  try { const r = await fetch(`https://${host}`, { method: 'HEAD' }); out.network[host] = r.status; }
  catch (e) { out.network[host] = `unreachable (${e.cause?.code || e.message})`; }
}
try { const { execFileSync } = await import('node:child_process'); out.versions.git = execFileSync('git', ['--version'], { stdio: 'pipe' }).toString().trim(); }
catch { out.versions.git = 'missing'; }
console.log(JSON.stringify(out, null, 2));
