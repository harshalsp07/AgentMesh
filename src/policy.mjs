// policy.mjs — .mesh/policy.yaml engine. Enforced at the boundary, never in prompts.
// Minimal YAML parser sized to our known schema (no dependency).
import { readFileSync, existsSync } from 'node:fs';
import { matchAny } from './store.mjs';

export const DEFAULT_POLICY = {
  version: 1,
  paths: { protected: ['infra/**', '.github/**', '**/*.pem'], generated: ['src/gen/**', '**/*.lock', 'pnpm-lock.yaml'] },
  blast_radius: { max_files_per_changeset: 40, max_deleted_lines: 400 },
  commands: { deny: ['rm -rf /*', 'git push --force*', 'git reset --hard*', 'DROP TABLE*'], require_approval: ['npm publish', 'terraform apply*'] },
  network: { egress_allow: ['registry.npmjs.org', 'pypi.org', 'api.anthropic.com'] },
  budgets: { per_lane: { tokens: 2000000, wall_minutes: 180 } },
  landing: { default: 'approve-to-land', auto: ['docs/**', '**/*.test.*'] },
};

// tiny indent-based parser for the policy schema only
export function parsePolicyYaml(text) {
  const policy = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  const lines = String(text).split('\n');
  let section = null, sub = null;
  const curList = () => {
    if (section === 'paths' && sub) return policy.paths[sub];
    if (section === 'commands' && sub) return policy.commands[sub];
    if (section === 'network' && sub === 'egress_allow') return policy.network.egress_allow;
    if (section === 'landing' && sub === 'auto') return policy.landing.auto;
    return null;
  };
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim() || line.trim() === 'version: 1') continue;
    const indent = line.match(/^\s*/)[0].length;
    const t = line.trim();
    if (indent === 0 && t.endsWith(':')) { section = t.slice(0, -1); sub = null; continue; }
    if (indent === 2 && t.endsWith(':')) { sub = t.slice(0, -1); continue; }
    if (indent === 2 && t.includes(':')) {
      const [k, ...rest] = t.split(':');
      const v = rest.join(':').trim();
      if (section === 'blast_radius') {
        if (k.trim() === 'max_files_per_changeset') policy.blast_radius.max_files_per_changeset = +v;
        if (k.trim() === 'max_deleted_lines') policy.blast_radius.max_deleted_lines = +v;
      }
      if (section === 'landing' && k.trim() === 'default') policy.landing.default = v;
      if (section === 'budgets' && k.trim() === 'per_lane') { /* nested one level deeper, handled below */ }
      continue;
    }
    if (t.startsWith('- ')) {
      let item = t.slice(2).trim().replace(/^["']|["']$/g, '');
      // budgets.per_lane: { tokens: X, wall_minutes: Y } inline form
      if (section === 'budgets') {
        const m = item.match(/(\w+):\s*(\d+)/g);
        if (m) for (const kv of m) { const [k, v] = kv.split(':').map((s) => s.trim()); policy.budgets.per_lane[k] = +v; }
        continue;
      }
      const lst = curList();
      if (lst) lst.push(item);
      continue;
    }
    if (section === 'budgets' && t.includes('tokens:')) {
      const m = t.match(/tokens:\s*(\d+)/); if (m) policy.budgets.per_lane.tokens = +m[1];
      const w = t.match(/wall_minutes:\s*(\d+)/); if (w) policy.budgets.per_lane.wall_minutes = +w[1];
    }
  }
  return policy;
}

export function loadPolicy(dir = '.mesh') {
  const f = `${dir}/policy.yaml`;
  if (!existsSync(f)) return JSON.parse(JSON.stringify(DEFAULT_POLICY));
  try { return parsePolicyYaml(readFileSync(f, 'utf8')); } catch { return JSON.parse(JSON.stringify(DEFAULT_POLICY)); }
}

export const isProtected = (p, path) => matchAny(p.paths.protected, path);
export const isGenerated = (p, path) => matchAny(p.paths.generated, path);
export function checkBlastRadius(p, { files = 0, deletedLines = 0 }) {
  if (files > p.blast_radius.max_files_per_changeset) return `blast radius: ${files} files > max ${p.blast_radius.max_files_per_changeset}`;
  if (deletedLines > p.blast_radius.max_deleted_lines) return `blast radius: ${deletedLines} deleted lines > max ${p.blast_radius.max_deleted_lines}`;
  return null;
}
export function checkCommand(p, cmd) {
  const c = String(cmd);
  if (p.commands.deny.some((d) => d.endsWith('*') ? c.startsWith(d.slice(0, -1)) : c === d)) return { verdict: 'deny', reason: `command denied by policy: ${c}` };
  if (p.commands.require_approval.some((d) => d.endsWith('*') ? c.startsWith(d.slice(0, -1)) : c === d || c.startsWith(d.replace(/\*$/, '')))) return { verdict: 'approval', reason: `command needs approval: ${c}` };
  return { verdict: 'allow' };
}
export const checkEgress = (p, host) => p.network.egress_allow.some((a) => String(host).endsWith(a)) ? null : `egress denied: ${host} not in allowlist`;
export function landingMode(p, path) {
  if (matchAny(p.landing.auto, path)) return 'auto-land';
  if (isProtected(p, path)) return 'approve-and-pair';
  return p.landing.default || 'approve-to-land';
}
