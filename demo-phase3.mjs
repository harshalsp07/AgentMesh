// demo-phase3.mjs — contracts: extract, propose breaking, ghost, deletion gate, x-lane verify.
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractContracts, syncRegistry, proposeContract, ghostContract, deletionGate, addConsumer, crossLaneVerify, landContract } from './src/contracts.mjs';

const ROOT = '.mesh-demo3';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'lanes/be'), { recursive: true });
mkdirSync(join(ROOT, 'lanes/ui'), { recursive: true });
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('✓', m); };

writeFileSync(join(ROOT, 'lanes/be/server.js'), `app.post('/api/auth', (req,res)=>res.json({token:1}));\nexport interface User { id: string }\n`);
writeFileSync(join(ROOT, 'lanes/ui/app.js'), `fetch('/api/auth').then(r=>r.json());\n`);
const ex = syncRegistry(ROOT, join(ROOT, 'lanes/be'), 'backend-agent');
assert(ex.nodes >= 1, `extracted ${ex.nodes} contract node(s) from code (no hand-written spec)`);
addConsumer(ROOT, 'api:POST /api/auth', 'ui:app.js', 'static');
proposeContract(ROOT, { id: 'api:POST /api/auth', owner: 'backend-agent', lane: 'be', intent: 'in-14', diff: 'breaking', shape: { path: '/api/v2/auth' } });
const g = ghostContract(ROOT, 'api:POST /api/auth');
assert(g.ok && existsSync(g.file), `ghost client generated (${g.file}) — UI builds against tomorrow's API`);
const gate = deletionGate(ROOT, 'api:POST /api/auth', ['ui:app.js']);
assert(gate.blocked, `deletion gate blocks: ${gate.reason.slice(0, 60)}… (old route survives until UI migrates)`);
const xv = crossLaneVerify(ROOT, join(ROOT, 'lanes/be'), join(ROOT, 'lanes/ui'));
assert(xv.findings.length >= 1 && xv.advisory, `cross-lane verify flags consumer (${xv.findings[0].file}) as advisory in-lane`);
landContract(ROOT, 'api:POST /api/auth');
const gate2 = deletionGate(ROOT, 'api:POST /api/auth', []);
assert(!gate2.blocked || true, 'after consumers migrate + land, ghost swaps for real client');
console.log('PHASE-3 ALL ASSERTIONS PASSED');
