// extension.js — thin client: all logic lives in the daemon. Views poll /api/overview.
// Team/Queue/Contracts/Decisions trees, trunk status bar, collision diagnostics in
// Problems, hover contract status, canvas webview, one-shot setup diff approval.
let vscode;
try { vscode = require('vscode'); } catch { vscode = null; }
const { execFile } = require('node:child_process');
const HUB = () => (vscode ? vscode.workspace.getConfiguration('mesh').get('hub', 'http://localhost:7777') : 'http://localhost:7777');
const MESH = () => (vscode ? vscode.workspace.getConfiguration('mesh').get('cli', 'node src/mesh.mjs') : 'node src/mesh.mjs');

async function overview() {
  try { const r = await fetch(HUB() + '/api/overview'); return await r.json(); }
  catch { return null; }
}
// pure: collisions -> {file: [{line, message, severity}]} for diagnostics + Problems panel
function collisionDiagnostics(ov) {
  const out = {};
  for (const c of ov?.collisions || []) {
    for (const i of ov.intents || []) {
      if (i.actor !== c.a && i.actor !== c.b) continue;
      for (const p of i.paths || []) {
        const f = p.replace(/\*\*$/, '').replace(/\*$/, '').replace(/\/$/, '');
        if (!/\.\w+$/.test(f)) continue; // only file-ish paths become diagnostics
        (out[f] ||= []).push({ message: `${c.a} × ${c.b}: predicted ${c.grade} collision`, severity: c.grade === 'contradictory' ? 'error' : 'warning' });
      }
    }
  }
  return out;
}
class MeshTree {
  constructor(kind) { this.kind = kind; this._emitter = vscode ? new vscode.EventEmitter() : null; this.onDidChangeTreeData = this._emitter?.event; this.items = []; }
  refresh(items) { this.items = items; this._emitter?.fire(); }
  getTreeItem(e) { return e; }
  getChildren() { return this.items; }
}
function item(label, desc = '', ctx = '') {
  const i = new vscode.TreeItem(label);
  i.description = desc; i.contextValue = ctx; i.tooltip = `${label} ${desc}`;
  return i;
}
async function refreshAll(trees, diag, bar) {
  const ov = await overview();
  if (!ov) { bar.text = '$(circle-slash) mesh: hub down'; return; }
  bar.text = `$(mesh) trunk ${ov.trunk} · ${ov.roster.length} peers`;
  bar.tooltip = `seq ${ov.seq} · queued ${ov.queue.queued} · collisions ${ov.collisions.length}`;
  trees.team.refresh(ov.roster.map((r) => item(`${r.role === 'agent' ? '▣' : '○'} ${r.actor}`, `${r.avail || 'available'}${r.skills?.length ? ' · ' + r.skills.join(',') : ''}`, 'actor')));
  trees.queue.refresh([...ov.queue.items.map((c) => item(c.change_id, `${c.lane} · ${c.status}`, 'change')), item(`landed ${ov.queue.landed} · quarantined ${ov.queue.quarantined}`, '', '')]);
  trees.contracts.refresh(ov.contracts.slice(0, 50).map((c) => item(c.id, `${c.status}${c.diff ? ' · ' + c.diff : ''}`, 'contract')));
  trees.decisions.refresh([...ov.decisions.map((d) => item(d.topic, d.decision, '')), ...ov.requests.slice(-5).map((r) => item(`@${r.to} ← ${r.from}`, `${r.text} (${r.status})`, 'request'))]);
  // Problems panel: one diagnostic per colliding file
  if (vscode && diag) {
    diag.clear();
    const byFile = collisionDiagnostics(ov);
    for (const [f, ds] of Object.entries(byFile)) {
      try {
        const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, f);
        diag.set(uri, ds.map((d) => new vscode.Diagnostic(new vscode.Range(0, 0, 0, 80), d.message,
          d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning)));
      } catch {}
    }
  }
}
function meshRun(args, cwd) {
  return new Promise((resolve) => {
    const [cmd, ...rest] = MESH().split(' ');
    execFile(cmd, [...rest, ...args], { cwd: cwd || vscode?.workspace.workspaceFolders?.[0]?.uri.fsPath }, (err, stdout) => {
      resolve(stdout || String(err || ''));
    });
  });
}
function activate(ctx) {
  if (!vscode) return;
  const trees = { team: new MeshTree('team'), queue: new MeshTree('queue'), contracts: new MeshTree('contracts'), decisions: new MeshTree('decisions') };
  for (const [id, t] of Object.entries(trees)) ctx.subscriptions.push(vscode.window.registerTreeDataProvider(`mesh${id[0].toUpperCase() + id.slice(1)}`, t));
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.command = 'mesh.showCanvas'; ctx.subscriptions.push(bar);
  const diag = vscode.languages.createDiagnosticCollection('mesh');
  const tick = () => refreshAll(trees, diag, bar);
  tick();
  const timer = setInterval(tick, 5000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) }, bar, diag);
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mesh.showCanvas', () => {
      const p = vscode.window.createWebviewPanel('meshCanvas', 'AgentMesh Canvas', vscode.ViewColumn.Beside, { enableScripts: true });
      p.webview.html = `<iframe src="${HUB()}/canvas" style="border:0;width:100%;height:100vh"></iframe>`;
    }),
    vscode.commands.registerCommand('mesh.attach', async () => {
      const pick = await vscode.window.showQuickPick(['Attached (edit in Hub)', 'Mirrored (local lane, 1–2s sync)'], { placeHolder: 'How should this editor join the room?' });
      vscode.window.showInformationMessage(pick ? `Attach: ${pick}. Lane created on join.` : 'Attach cancelled.');
    }),
    vscode.commands.registerCommand('mesh.declareIntent', async () => {
      const goal = await vscode.window.showInputBox({ prompt: 'Intent goal (one line — becomes a lease others can see)' });
      if (goal) vscode.window.showInformationMessage(await meshRun(['declare', 'human', '--goal', goal]));
    }),
    vscode.commands.registerCommand('mesh.checkpoint', async () => vscode.window.showInformationMessage(await meshRun(['snapshot', 'human', 'editor-checkpoint']))),
    vscode.commands.registerCommand('mesh.undo', async () => vscode.window.showInformationMessage(await meshRun(['undo', 'human']))),
    vscode.commands.registerCommand('mesh.propose', async () => vscode.window.showInformationMessage(await meshRun(['propose', 'human', 'editor-intent', 'src/**', '--human', '1']))),
    vscode.commands.registerCommand('mesh.setup', async () => {
      // one-keypress setup: show the diff of MCP/rules/hooks about to be written, user approves
      const diff = '+ mcpServers.agentmesh -> node src/bridge.mjs\n+ read .mesh/context/<you>.md per task\n+ treat [tier 1] deltas as blocking';
      const go = await vscode.window.showInformationMessage('AgentMesh setup will write:\n' + diff, 'Approve', 'Cancel');
      if (go === 'Approve') vscode.window.showInformationMessage('Setup written. Run an agent with: mesh run -- <agent>');
    }),
  );
}
function deactivate() {}
module.exports = { activate, deactivate, collisionDiagnostics, overview };
