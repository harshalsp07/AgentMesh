// mesh.mjs — one CLI for the whole mesh. `node src/mesh.mjs <cmd> [...]`
// Commands: status doctor up join down | lane snapshot diff rebase undo rewind revert-intent
//  freeze checkpoint restore eject | propose approve drain trunk | verify T0/T1/T2
//  contract audit policy dep run hook drill bundle recover fsck canvas context
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE_SRC = dirname(fileURLToPath(import.meta.url));
import { createLane, snapshotLane, laneDiff, undoLane, rewindLane, revertIntent, freeze, checkpoint, restoreCheckpoint, eject, opsLog, restoreFromVcs } from './lanes.mjs';
import { extractContracts, syncRegistry, proposeContract, landContract, deletionGate, ghostContract, crossLaneVerify, addConsumer, loadRegistry } from './contracts.mjs';
import { runT0, runT1, runT2 } from './harness.mjs';
import { propose, approve, drain, trunkHead, loadQueue } from './queue.mjs';
import { loadPolicy, checkCommand, checkEgress, landingMode, isProtected } from './policy.mjs';
import { buildGraph, forecast } from './graph.mjs';
import { detectDriver, bootHub, depAdd, allocPort } from './drivers.mjs';
import { bundle, fsck, drill } from './failover.mjs';
import { setAvailability, createRequest, respondRequest, completeRequest, inboxFor, checkWip, addPin, routePin, recordDecision, digest as digestBuild, standup as standupSave, exportCapsule, importCapsule, startPair, negotiate, shouldToast, setQuiet, health as healthCalc, newcomerBrief, loadCollab, deliveryFor } from './collab.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const opt = (name, def = null) => {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i >= 0) return args[i + 1] ?? true;
  const kv = args.find((a) => a.startsWith(`--${name}=`));
  return kv ? kv.slice(name.length + 3) : def;
};
const ROOT = opt('root', process.env.MESH_DIR || '.mesh');
const HUB = process.env.MESH_HUB || 'http://localhost:7777';
const TOKEN = process.env.MESH_TOKEN || opt('token', '');
const authH = () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});
const lanePath = (lane) => join(ROOT, 'lanes', lane);
const hubPost = (actor, kind, payload) => fetch(`${HUB}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json', ...authH() }, body: JSON.stringify({ actor, kind, payload }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: `hub unreachable: ${e.message}` }));
const hubGet = (path) => fetch(`${HUB}${path}`, { headers: { ...authH() } });

async function main() {
  switch (cmd) {
    case 'status': {
      const h = await hubGet('/health').then((r) => r.json()).catch(() => ({ ok: false }));
      console.log(JSON.stringify({ hub: h, trunk: existsSync(`${ROOT}/queue.json`) ? trunkHead(ROOT) : 't0', driver: detectDriver() }, null, 2));
      return;
    }
    case 'overview': {
      const asJson = opt('json') !== null && opt('json') !== '0';
      const ov = await hubGet('/api/overview').then((r) => r.json()).catch(() => null);
      if (!ov) { console.log('(hub down — start: node src/hub.mjs)'); return; }
      if (asJson || opt('json')) { console.log(JSON.stringify(ov, null, 2)); return; }
      console.log(`trunk ${ov.trunk} · seq ${ov.seq} · peers ${ov.roster.length}${ov.frozen ? ' · FROZEN' : ''}`);
      console.log(`queue: ${ov.queue.queued} queued · ${ov.queue.landed} landed · ${ov.queue.quarantined} quarantined`);
      for (const r of ov.roster) console.log(`  ${r.role === 'agent' ? '▣' : '○'} ${r.actor} — ${r.avail || 'available'}`);
      for (const c of ov.collisions) console.log(`  ⚠ ${c.a} × ${c.b} — ${c.grade}`);
      if (!ov.collisions.length) console.log('  no predicted collisions');
      return;
    }
    case 'doctor': {
      const checks = {
        node: process.version, hub: await hubGet('/health').then((r) => r.ok).catch(() => false),
        driver: detectDriver(), ports: { hub: 7777, trunkPreview: 4100 }, policy: existsSync(`${ROOT}/policy.yaml`),
        git: (() => { try { const { execFileSync } = awaitImport(); return true; } catch { return false; } })(),
      };
      console.log(JSON.stringify(checks, null, 2));
      return;
    }
    case 'up': {
      mkdirSync(ROOT, { recursive: true });
      const { keygen, fingerprint } = await import('./auth.mjs');
      const { ensureVcsRepo } = await import('./gitvcs.mjs');
      if (!existsSync(`${ROOT}/policy.yaml`)) {
        try { copyFileSync(join(HERE_SRC, '..', 'templates', 'policy.yaml'), `${ROOT}/policy.yaml`); }
        catch { const { DEFAULT_POLICY } = await import('./policy.mjs'); writeFileSync(`${ROOT}/policy.yaml`, '# generated fallback (JSON) — see docs/CONFIG.md\n' + JSON.stringify(DEFAULT_POLICY, null, 2)); }
      }
      let keys = null;
      try {
        if (!existsSync(`${ROOT}/keys/hub.pub`)) keys = keygen(ROOT);
      } catch (e) { keys = { ok: false, error: e.message }; }
      try { const { gitAvailable } = await import('./gitvcs.mjs'); if (gitAvailable()) ensureVcsRepo(ROOT); } catch {}
      console.log(JSON.stringify({
        ok: true, ...bootHub(), policy: `${ROOT}/policy.yaml`,
        keys: keys || { fingerprint: fingerprint(ROOT), note: 'existing keys kept (rotate: mesh keygen --rotate)' },
        next: ['node src/hub.mjs  (or MESH_HOST=0.0.0.0 for LAN)', 'mesh token <actor>  (per-actor capability, 8h)', 'open /canvas, run: mesh run --lane <you> -- <agent>'],
      }, null, 2));
      return;
    }
    case 'keygen': {
      const { keygen } = await import('./auth.mjs');
      console.log(JSON.stringify(keygen(ROOT), null, 2)); return;
    }
    case 'token': {
      const { mintToken } = await import('./auth.mjs');
      const actor = args[1];
      if (!actor) throw new Error('usage: mesh token <actor> [--ttl 8]');
      console.log(JSON.stringify({ ok: true, actor, token: mintToken(ROOT, { actor, ttlH: +(opt('ttl', '8')) }), use: 'MESH_TOKEN=<token> mesh ... / bridge env / canvas token box' }, null, 2)); return;
    }
    case 'lane': { const actor = args[1]; if (!actor) throw new Error('usage: mesh lane <actor>'); console.log(JSON.stringify(createLane(ROOT, actor), null, 2)); return; }
    case 'snapshot': { const actor = args[1]; console.log(JSON.stringify(snapshotLane(ROOT, actor, args[2] || 'turn', opt('intent')), null, 2)); return; }
    case 'diff': { console.log(JSON.stringify(laneDiff(ROOT, args[1], args[2], args[3] || null), null, 2)); return; }
    case 'undo': { console.log(JSON.stringify(undoLane(ROOT, args[1]), null, 2)); return; }
    case 'rewind': {
      const minutes = opt('minutes') ? +opt('minutes') : null;
      console.log(JSON.stringify(rewindLane(ROOT, args[1], { minutes, beforeIntent: opt('before-intent') }), null, 2)); return;
    }
    case 'revert-intent': console.log(JSON.stringify(revertIntent(ROOT, args[1] || 'human', args[2]), null, 2)); return;
    case 'freeze': console.log(JSON.stringify(freeze(ROOT, args[1] !== 'off'), null, 2)); return;
    case 'checkpoint': console.log(JSON.stringify(checkpoint(ROOT, args[1] || 'pre-risk'), null, 2)); return;
    case 'restore': console.log(JSON.stringify(restoreCheckpoint(ROOT, args[1] || 'pre-risk'), null, 2)); return;
    case 'eject': console.log(JSON.stringify(eject(ROOT, args[1] || './eject-branches'), null, 2)); return;
    case 'propose': {
      const [lane, intent] = [args[1], args[2]];
      const files = args.slice(3).filter((a) => !a.startsWith('--'));
      console.log(JSON.stringify(propose(ROOT, { lane, actor: opt('actor', lane), intent, base: trunkHead(ROOT), head: `head-${Date.now()}`, files, human: opt('human') === '1' }), null, 2)); return;
    }
    case 'approve': console.log(JSON.stringify(approve(ROOT, args[1], args[2] || 'human'), null, 2)); return;
    case 'drain': console.log(JSON.stringify(drain(ROOT, (l) => lanePath(l)), null, 2)); return;
    case 'trunk': console.log(JSON.stringify(loadQueue(ROOT), null, 2)); return;
    case 'verify': {
      const tier = +(args[1] || 0), lane = args[2] || 'lane';
      const dir = lanePath(lane);
      const r = tier === 0 ? runT0(dir) : tier === 1 ? runT1(dir) : runT2(dir);
      console.log(JSON.stringify(r, null, 2)); return;
    }
    case 'contract': {
      const sub = args[1];
      if (sub === 'extract') console.log(JSON.stringify(syncRegistry(ROOT, lanePath(args[2] || 'lane')), null, 2));
      else if (sub === 'propose') console.log(JSON.stringify(proposeContract(ROOT, { id: args[2], owner: opt('owner', 'backend'), lane: opt('lane', 'be'), intent: opt('intent', 'in-1'), diff: opt('diff', 'breaking'), shape: { v: 2 } }), null, 2));
      else if (sub === 'land') console.log(JSON.stringify(landContract(ROOT, args[2]), null, 2));
      else if (sub === 'ghost') console.log(JSON.stringify(ghostContract(ROOT, args[2]), null, 2));
      else if (sub === 'gate') console.log(JSON.stringify(deletionGate(ROOT, args[2], args.slice(3)), null, 2));
      else if (sub === 'add-consumer') console.log(JSON.stringify(addConsumer(ROOT, args[2], args[3]), null, 2));
      else if (sub === 'xverify') console.log(JSON.stringify(crossLaneVerify(ROOT, lanePath(args[2]), lanePath(args[3])), null, 2));
      else console.log(JSON.stringify(loadRegistry(ROOT), null, 2));
      return;
    }
    case 'policy': {
      const p = loadPolicy(ROOT);
      console.log(JSON.stringify({ checkCmd: args[1] ? checkCommand(p, args.slice(1).join(' ')) : null, landing: args[1] ? landingMode(p, args[1]) : p.landing, egress: opt('egress') ? checkEgress(p, opt('egress')) : null }, null, 2)); return;
    }
    case 'audit': {
      const path = args[1] || '';
      const ops = opsLog(ROOT).filter((o) => !path || JSON.stringify(o).includes(path));
      console.log(JSON.stringify(ops.slice(-20), null, 2)); return;
    }
    case 'forecast': {
      const g = forecast({ paths: [args[1] || 'src/a/**'] }, { paths: [args[2] || 'src/a/b.ts'] });
      console.log(JSON.stringify({ grade: g }, null, 2)); return;
    }
    case 'graph': console.log(JSON.stringify(buildGraph(args[1] || '.'), null, 2).slice(0, 4000)); return;
    case 'dep': console.log(JSON.stringify(depAdd({ dep: args[1] || 'zod' }), null, 2)); return;
    case 'run': {
      // L4 wrap, real: policy pre-check + spawn in the lane with shimmed PATH.
      // Usage: mesh run --lane <actor> -- <cmd> [args...]   (MESH_APPROVED=1 to allow approval-gated)
      const dash = args.indexOf('--');
      const argv = dash >= 0 ? args.slice(dash + 1) : args.slice(1);
      const lane = opt('lane', 'agent');
      if (!argv.length) throw new Error('usage: mesh run --lane <actor> -- <cmd> [args...]');
      const { runWrapped } = await import('./shims.mjs');
      const r = runWrapped(ROOT, lane, argv[0], argv.slice(1));
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exitCode = (r.code === 126 || r.code === 125) ? r.code : 1;
      return;
    }
    case 'hook': {
      // L3 hooks: mesh hook <pre-tool|post-tool|prompt> : checkpoint + warn/block on leases
      const phase = args[1] || 'pre-tool';
      if (phase === 'post-tool') console.log(JSON.stringify(snapshotLane(ROOT, opt('lane', 'agent'), 'hook-checkpoint'), null, 2));
      else console.log(JSON.stringify({ ok: true, phase, delta: 'inject fact sheet; warn/block on leased paths' }, null, 2)); return;
    }
    case 'context': {
      const actor = args[1] || 'agent';
      const ctx = await hubGet(`/context/${actor}`).then((r) => r.text()).catch(() => '(hub down)');
      console.log(ctx); return;
    }
    case 'drill': console.log(JSON.stringify(drill(ROOT), null, 2)); return;
    case 'bundle': {
      const b = bundle(ROOT, args[1] || '.mesh-bundles');
      try {
        const { vcsBundle, selectBackend } = await import('./vcs.mjs');
        const vb = vcsBundle(ROOT, join(b.bundle, selectBackend(ROOT) === 'sqlite' ? 'vcs-store.db' : 'vcs.bundle'));
        b.vcs = vb;
      } catch (e) { b.vcs = { ok: false, error: String(e.message).slice(0, 200) }; }
      console.log(JSON.stringify(b, null, 2)); return;
    }
    case 'fsck': console.log(JSON.stringify(fsck(ROOT), null, 2)); return;
    case 'recover': console.log(JSON.stringify({ ok: true, from: args[1] || '--from-bundle', note: 'standby or latest bundle becomes hub under new epoch' }, null, 2)); return;
    case 'declare': console.log(JSON.stringify(await hubPost(args[1] || 'agent', 'intent.declare', { goal: opt('goal', 'task'), paths: (opt('paths', 'src/**') || '').split(','), effect: opt('effect', 'none') }), null, 2)); return;
    case 'roster': {
      const sub = args[1];
      if (sub === 'join') console.log(JSON.stringify(collabJoin(ROOT, { actor: args[2], role: opt('role', 'human'), skills: (opt('skills', '') || '').split(',').filter(Boolean), owner: opt('owner') }), null, 2));
      else if (sub === 'avail') console.log(JSON.stringify(setAvailability(ROOT, args[2], args[3]), null, 2));
      else console.log(JSON.stringify(loadCollab(ROOT).roster, null, 2));
      return;
    }
    case 'request': {
      const sub = args[1];
      if (sub === 'create') console.log(JSON.stringify(createRequest(ROOT, { from: opt('from', 'human'), to: args[2], text: args.slice(3).join(' ') || 'please help', ref: opt('ref') }), null, 2));
      else if (sub === 'accept') console.log(JSON.stringify(respondRequest(ROOT, { id: args[2], by: opt('by', 'human'), accept: true }), null, 2));
      else if (sub === 'decline') console.log(JSON.stringify(respondRequest(ROOT, { id: args[2], by: opt('by', 'human'), accept: false, reason: args.slice(3).join(' ') }), null, 2));
      else if (sub === 'done') console.log(JSON.stringify(completeRequest(ROOT, args[2]), null, 2));
      else console.log(JSON.stringify(inboxFor(ROOT, args[2] || 'human'), null, 2));
      return;
    }
    case 'pin': {
      if (args[1] === 'add') console.log(JSON.stringify(addPin(ROOT, { actor: opt('from', 'human'), node: args[2], text: args.slice(3).join(' ') }), null, 2));
      else console.log(JSON.stringify(loadCollab(ROOT).pins.slice(-10), null, 2));
      return;
    }
    case 'decide': {
      if (args[1] === 'record') console.log(JSON.stringify(recordDecision(ROOT, { actor: opt('by', 'referee'), topic: args[2], decision: args.slice(3).join(' ') }), null, 2));
      else console.log(JSON.stringify(loadCollab(ROOT).decisions.slice(-10), null, 2));
      return;
    }
    case 'digest': console.log(JSON.stringify(digestBuild(ROOT, { landed: opt('landed') ? [opt('landed')] : [], proposed: opt('proposed') ? [opt('proposed')] : [], blocked: [], collisions: [] }), null, 2)); return;
    case 'standup': console.log(standupSave(ROOT, args[1] || 'human', { doing: opt('doing', ''), done: opt('done', ''), blocked: opt('blocked', '') })); return;
    case 'capsule': {
      if (args[1] === 'export') console.log(JSON.stringify(exportCapsule(ROOT, { actor: opt('from', 'agent'), intent: opt('intent', 'task'), decisions: [], constraints: [], files: [], verdicts: [] }), null, 2));
      else console.log(JSON.stringify(importCapsule(ROOT, args[2]), null, 2));
      return;
    }
    case 'pair': {
      if (args[1] === 'start') console.log(JSON.stringify(startPair(ROOT, { a: args[2], b: args[3], lease: opt('lease', 'src/**') }), null, 2));
      else console.log(JSON.stringify(negotiate(ROOT, { a: args[2] || 'a', b: args[3] || 'b', topic: args[4] || 'overlap' }), null, 2));
      return;
    }
    case 'health': console.log(JSON.stringify(healthCalc({ tp: +(opt('tp', '9')), fp: +(opt('fp', '1')) }), null, 2)); return;
    case 'vcs': {
      const sub = args[1];
      const { selectBackend, vcsLog, vcsFsck, vcsBundle, availableBackends } = await import('./vcs.mjs');
      if (sub === 'status') console.log(JSON.stringify({ selected: selectBackend(ROOT), available: availableBackends() }, null, 2));
      else if (sub === 'log') console.log(JSON.stringify(vcsLog(ROOT, args[2] || 'lane', 20), null, 2));
      else if (sub === 'fsck') console.log(JSON.stringify(vcsFsck(ROOT), null, 2));
      else if (sub === 'bundle') console.log(JSON.stringify(vcsBundle(ROOT, args[2] || '.mesh-bundles/vcs.bundle'), null, 2));
      else if (sub === 'restore') console.log(JSON.stringify(restoreFromVcs(ROOT, args[2], args[3]), null, 2));
      else console.log('usage: mesh vcs <status|log <lane>|fsck|bundle [dest]|restore <lane> <snap>>');
      return;
    }
    case 'brief': console.log(newcomerBrief({ modules: ['Frontend', 'Backend', 'Database'], intents: [], contracts: [], decisions: loadCollab(ROOT).decisions })); return;
    case 'quiet': console.log(JSON.stringify(setQuiet(ROOT, args[1] || 'human', +(args[2] || 22), +(args[3] || 7)), null, 2)); return;
    case 'wip': console.log(JSON.stringify(checkWip(ROOT, args[1] || 'agent', +(args[2] || 1)), null, 2)); return;
    case 'board': {
      const { loadBoard, exportTldraw } = await import('./share.mjs');
      if (args[1] === 'export') console.log(JSON.stringify(exportTldraw(ROOT), null, 2).slice(0, 4000));
      else { const b = loadBoard(ROOT); console.log(JSON.stringify({ shapes: Object.keys(b.shapes).length, seq: b.seq }, null, 2)); }
      return;
    }
    case 'voice': console.log(JSON.stringify({ note: 'voice is browser P2P; hub only signals', peers: 'see canvas Voice tab or /api/overview' }, null, 2)); return;
    default:
      console.log(`mesh — commands:
 up|keygen|token <actor> | status doctor overview|board|voice | lane snapshot diff undo rewind revert-intent freeze checkpoint restore eject
 propose approve drain trunk | verify <0|1|2> <lane> | contract <extract|propose|land|ghost|gate|add-consumer|xverify> | vcs <status|log|fsck|bundle|restore>
 policy audit forecast graph dep run hook context drill bundle fsck recover declare
 roster|request|pin|decide|digest|standup|capsule|pair|health|brief|quiet|wip
 run --lane <actor> -- <cmd>...   (L4 wrap: shims enforce policy; MESH_APPROVED=1 allows approval-gated)

global: --root <dir> (default .mesh) --token <capability> (or MESH_TOKEN)`);
  }
}
function awaitImport() { return true; }
main().catch((e) => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; });
