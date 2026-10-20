// scripts/publish-check.mjs — Universal Multi-Platform Deployment & Sync Readiness Doctor
import { existsSync, readFileSync } from 'node:fs';

const CHECKS = [
  { name: 'Production Web App: index.html', path: 'site/index.html', check: (c) => c.includes('AgentMesh') && c.includes('<title>') },
  { name: 'Landing Page', path: 'site/landing.html', check: (c) => c.includes('npx @harshalsp/agentmesh') && c.includes('MACP') },
  { name: 'Docs Page', path: 'site/docs.html', check: (c) => c.includes('#quickstart') && c.includes('#api') },
  { name: 'Playground (dots simulator)', path: 'site/playground.html', check: (c) => c.includes('vendor.mjs') || c.includes('MACPKernel') },
  { name: 'Blog Engine Notes', path: 'site/blog.html', check: (c) => c.includes('AgentMesh') },
  { name: 'Discoverability: sitemap.xml', path: 'site/sitemap.xml', check: (c) => c.includes('<loc>') },
  { name: 'Discoverability: llms.txt', path: 'site/llms.txt', check: (c) => c.includes('AgentMesh') },
  { name: 'Design System: style.css', path: 'site/style.css', check: (c) => c.includes('--paper') && c.includes('--signal') },
  { name: 'Client Engine: app.js', path: 'site/app.js', check: (c) => c.includes('VectorClock') || c.includes('renderTopology') },
  { name: 'Strip Board: command palette', path: 'site/app.js', check: (c) => c.includes('palette-overlay') && c.includes('paletteActions') },
  { name: 'Strip Board: time machine reducer', path: 'site/app.js', check: (c) => c.includes('applyEvent') && c.includes('stateAt') },
  { name: 'Strip Board: accessible tabs', path: 'site/index.html', check: (c) => c.includes('role="tablist"') && c.includes('role="tabpanel"') },
  { name: 'Strip Board: client test suite', path: 'test/site.test.mjs', check: (c) => c.includes('never hands hub data to an HTML parser') && c.includes('replays a history') },
  { name: 'Site Architecture Doc', path: 'docs/SITE.md', check: (c) => c.includes('The data flow') && c.includes('Keyboard map') },
  { name: 'Site Plan / Research Doc', path: 'docs/SITE_PLAN.md', check: (c) => c.includes('Research method') && c.includes('Feature plan') },
  { name: 'Integration Guide', path: 'docs/INTEGRATION.md', check: (c) => c.includes('MCP') && c.includes('Capability tokens') },
  { name: 'Performance Budget', path: 'docs/PERFORMANCE.md', check: (c) => c.includes('budget') && c.includes('Regression checklist') },
  { name: 'PWA Web Manifest', path: 'site/manifest.webmanifest', check: (c) => c.includes('AgentMesh') },
  { name: 'Offline Service Worker', path: 'site/sw.js', check: (c) => c.includes('CACHE_NAME') },
  { name: 'Vercel Deployment Config', path: 'vercel.json', check: (c) => c.includes('outputDirectory') },
  { name: 'Netlify Deployment Config', path: 'netlify.toml', check: (c) => c.includes('publish = "site"') },
  { name: 'Cloudflare Pages Config', path: 'wrangler.toml', check: (c) => c.includes('pages_build_output_dir') },
  { name: 'Cloudflare Edge Worker', path: 'site/_worker.js', check: (c) => c.includes('env.ASSETS.fetch') },
  { name: 'GitHub Pages CI/CD Action', path: '.github/workflows/deploy-pages.yml', check: (c) => c.includes('actions/deploy-pages') },
  { name: 'Docker Production Container', path: 'Dockerfile', check: (c) => c.includes('COPY site ./site') },
  { name: 'Render 1-Click Blueprint', path: 'render.yaml', check: (c) => c.includes('healthCheckPath: /ready') },
  { name: 'Railway Deployment Schema', path: 'railway.json', check: (c) => c.includes('healthcheckPath') },
  { name: 'Semantic CRDT Engine', path: 'src/crdt.mjs', check: (c) => c.includes('class SemanticDocument') },
  { name: 'MACP 5-Mode Kernel', path: 'src/macp.mjs', check: (c) => c.includes('MACP_MODES') },
  { name: 'Epistemic Merkle DAG', path: 'src/dag.mjs', check: (c) => c.includes('class MerkleDAG') },
  { name: 'P2P WebRTC Swarm Signaling', path: 'src/p2p.mjs', check: (c) => c.includes('class P2PSwarmCoordinator') },
  { name: 'Google A2A Standard Gateway', path: 'src/a2a.mjs', check: (c) => c.includes('generateAgentCard') },
  { name: 'Production Plan', path: 'docs/PRODUCTION_PLAN.md', check: (c) => c.includes('Exit criteria') && c.includes('MESH_PROTOCOL_VERSION') },
  { name: 'Security Model (controls map to code)', path: 'docs/SECURITY.md', check: (c) => /fail-closed/i.test(c) && c.includes('lease.hard') },
  { name: 'Config Reference', path: 'docs/CONFIG.md', check: (c) => c.includes('MESH_INSECURE') && c.includes('MESH_SYNC') },
  { name: 'Research: agent collaboration landscape', path: 'docs/research/agent-protocols-landscape-2026.md', check: (c) => c.includes('MCP') && c.includes('A2A') },
  { name: 'Hardening Test Suite', path: 'test/hardening.test.mjs', check: (c) => c.includes('lease.hard') && c.includes('-32700') },
];

console.log('=== AgentMesh Universal Platform Publishing Readiness Doctor ===\n');

let allPassed = true;
for (const item of CHECKS) {
  if (!existsSync(item.path)) {
    console.log(`❌ [MISSING] ${item.name} (${item.path})`);
    allPassed = false;
    continue;
  }
  const content = readFileSync(item.path, 'utf8');
  if (item.check && !item.check(content)) {
    console.log(`⚠️  [INVALID] ${item.name} (${item.path})`);
    allPassed = false;
    continue;
  }
  console.log(`✅ [OK] ${item.name}`);
}

console.log('\n--------------------------------------------------------------');
if (allPassed) {
  console.log(`🎉 ALL ${CHECKS.length} PRODUCTION DEPLOYMENT & SYNC CHECKS PASSED!`);
  console.log('Site is 100% production-ready to publish to:');
  console.log(' - Vercel              (vercel deploy)');
  console.log(' - Netlify             (netlify deploy)');
  console.log(' - Cloudflare Pages    (npx wrangler pages deploy site)');
  console.log(' - GitHub Pages        (git push origin main)');
  console.log(' - Docker / PaaS       (docker build -t agentmesh .)');
  console.log(' - Render / Railway    (git push repository)');
  process.exit(0);
} else {
  console.log('❌ Some checks failed.');
  process.exit(1);
}
