// test/init.test.mjs — P0: `mesh init` into a foreign repo is fast, idempotent,
// detects existing client configs, and never clobbers unrelated server entries.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { init, deriveActor } from '../src/init.mjs';

const ROOT = '.mesh-test-init';
before(() => rmSync(ROOT, { recursive: true, force: true }));
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe('mesh init (TTFC)', () => {
  it('empty repo: writes canonical antigravity config + rules + AGENTS.md, skips unused clients', () => {
    mkdirSync(join(ROOT, 'pkg'), { recursive: true });
    writeFileSync(join(ROOT, 'pkg', 'package.json'), JSON.stringify({ name: '@acme/store' }));
    const r = init(join(ROOT, 'pkg'), { hub: 'http://192.168.1.20:7777' });
    assert.equal(r.ok, true);
    assert.equal(r.actor, 'store-agent'); // derived from package name, scope stripped
    // canonical config: npx-run bridge pointed at the given hub
    const cfg = JSON.parse(readFileSync(join(ROOT, 'pkg', '.agents', 'mcp_config.json'), 'utf8'));
    const e = cfg.mcpServers.agentmesh;
    assert.equal(e.command, 'npx');
    assert.deepEqual(e.args, ['-y', '@harshalsp/agentmesh', 'bridge']);
    assert.equal(e.env.MESH_HUB, 'http://192.168.1.20:7777');
    assert.equal(e.env.MESH_ACTOR, 'store-agent');
    assert.ok(existsSync(join(ROOT, 'pkg', '.agents', 'rules', 'agentmesh.md')));
    assert.ok(existsSync(join(ROOT, 'pkg', 'AGENTS.md')));
    // untouched clients were NOT invented
    assert.ok(r.skipped.some((s) => s.client === 'cursor'));
    assert.ok(!existsSync(join(ROOT, 'pkg', '.cursor', 'mcp.json')));
  });

  it('repo with .cursor/mcp.json: detected + merged WITHOUT clobbering existing server', () => {
    mkdirSync(join(ROOT, 'pkg', '.cursor'), { recursive: true });
    writeFileSync(join(ROOT, 'pkg', '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['-y', '@x/playwright'] } } }));
    const r = init(join(ROOT, 'pkg'), {});
    assert.ok(r.detected.includes('cursor'));
    const cur = JSON.parse(readFileSync(join(ROOT, 'pkg', '.cursor', 'mcp.json'), 'utf8'));
    assert.ok(cur.mcpServers.playwright, 'existing server preserved');
    assert.equal(cur.mcpServers.agentmesh.command, 'npx', 'agentmesh merged in');
  });

  it('idempotent: second init does not duplicate or grow the config', () => {
    before2();
    function before2() {
      init(join(ROOT, 'pkg'), {});
    }
    const a = JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'pkg', '.agents', 'mcp_config.json'), 'utf8')));
    init(join(ROOT, 'pkg'), {});
    const b = JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'pkg', '.agents', 'mcp_config.json'), 'utf8')));
    assert.equal(a, b);
    const md = readFileSync(join(ROOT, 'pkg', 'AGENTS.md'), 'utf8');
    assert.equal((md.match(/## AgentMesh/g) || []).length, 1, 'AGENTS.md hookup is append-once');
  });

  it('root-map style configs (opencode.json) are supported too', () => {
    const r = init(join(ROOT, 'pkg'), { force: true });
    const oc = JSON.parse(readFileSync(join(ROOT, 'pkg', 'opencode.json'), 'utf8'));
    assert.ok(oc.mcp?.agentmesh || oc.agentmesh, 'opencode entry written');
    assert.ok(r.files.includes('opencode.json'));
  });

  it('deriveActor falls back to the directory name on non-node repos', () => {
    assert.equal(deriveActor('C:\\work\\my-cool-site'), 'my-cool-site-agent');
    assert.match(deriveActor(ROOT), /-agent$/);
  });
});
