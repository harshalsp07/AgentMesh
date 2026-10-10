// doctor.mjs — mesh doctor: ports, driver, network, versions.
const HUB = process.env.MESH_HUB || 'http://localhost:7777';
const out = { node: process.version, hub: false, driver: null, network: {}, versions: {} };
try { const r = await fetch(`${HUB}/health`); out.hub = r.ok; } catch { out.hub = false; }
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
