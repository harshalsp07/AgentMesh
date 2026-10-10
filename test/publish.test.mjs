// test/publish.test.mjs — Comprehensive tests for Universal Platform Publishing & Sync Endpoints
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, closeHub } from '../src/hub.mjs';

const TEST_PORT = 7786;
const TEST_HOST = '127.0.0.1';
let server = null;

describe('Multi-Platform Publishing Artifacts', () => {
  it('validates all required deployment configuration files', () => {
    assert.ok(existsSync('site/index.html'), 'site/index.html must exist');
    assert.ok(existsSync('site/style.css'), 'site/style.css must exist');
    assert.ok(existsSync('site/app.js'), 'site/app.js must exist');
    assert.ok(existsSync('site/manifest.webmanifest'), 'site/manifest.webmanifest must exist');
    assert.ok(existsSync('site/sw.js'), 'site/sw.js must exist');

    assert.ok(existsSync('vercel.json'), 'vercel.json must exist');
    assert.ok(existsSync('netlify.toml'), 'netlify.toml must exist');
    assert.ok(existsSync('wrangler.toml'), 'wrangler.toml must exist');
    assert.ok(existsSync('site/_worker.js'), 'site/_worker.js must exist');
    assert.ok(existsSync('.github/workflows/deploy-pages.yml'), 'deploy-pages.yml must exist');
    assert.ok(existsSync('Dockerfile'), 'Dockerfile must exist');
    assert.ok(existsSync('render.yaml'), 'render.yaml must exist');
    assert.ok(existsSync('railway.json'), 'railway.json must exist');
  });
});

describe('Hub HTTP Serving & CORS Integration', () => {
  before(async () => {
    server = createServer().listen(TEST_PORT, TEST_HOST);
    await new Promise((r) => setTimeout(r, 100));
  });

  after(async () => {
    if (server) await closeHub(server);
  });

  it('serves production web app at / with HTML content', async () => {
    const res = await fetch(`http://${TEST_HOST}:${TEST_PORT}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.ok(body.includes('AgentMesh'));
    assert.ok(body.includes('heading-topo'));
  });

  it('serves static CSS and JS assets with correct MIME types', async () => {
    const resCss = await fetch(`http://${TEST_HOST}:${TEST_PORT}/style.css`);
    assert.equal(resCss.status, 200);
    assert.match(resCss.headers.get('content-type'), /text\/css/);

    const resJs = await fetch(`http://${TEST_HOST}:${TEST_PORT}/app.js`);
    assert.equal(resJs.status, 200);
    assert.match(resJs.headers.get('content-type'), /application\/javascript/);
  });

  it('serves Google A2A Agent Card at /a2a/agent-card.json', async () => {
    const res = await fetch(`http://${TEST_HOST}:${TEST_PORT}/a2a/agent-card.json`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'AgentMesh Swarm Coordinator');
    assert.ok(data.capabilities.includes('semantic_crdt_sync'));
  });

  it('handles CORS OPTIONS preflight request with proper headers', async () => {
    const res = await fetch(`http://${TEST_HOST}:${TEST_PORT}/api/crdt`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('exposes /api/crdt, /api/macp, and /api/dag with valid JSON', async () => {
    const resCrdt = await fetch(`http://${TEST_HOST}:${TEST_PORT}/api/crdt`);
    assert.equal(resCrdt.status, 200);
    const dataCrdt = await resCrdt.json();
    assert.ok(dataCrdt.ok);

    const resMacp = await fetch(`http://${TEST_HOST}:${TEST_PORT}/api/macp`);
    assert.equal(resMacp.status, 200);
    const dataMacp = await resMacp.json();
    assert.ok(dataMacp.ok);

    const resDag = await fetch(`http://${TEST_HOST}:${TEST_PORT}/api/dag`);
    assert.equal(resDag.status, 200);
    const dataDag = await resDag.json();
    assert.ok(dataDag.ok);
  });
});
