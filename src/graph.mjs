// graph.mjs — symbol + dependency graph (regex/tree-sitter-lite, zero-dep).
// Nodes at 4 zoom levels; edges static (imports) + runtime (traffic log).
// Forecast grades: none | adjacent | overlapping | contradictory.
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { matchAny } from './store.mjs';

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (['node_modules', '.git', '.mesh', '.mesh-demo', '.mesh-test', 'snapshots', 'lanes'].includes(e)) continue;
    const f = join(dir, e);
    const st = statSync(f);
    if (st.isDirectory()) { if (st.size !== undefined) walk(f, out); }
    else if (/\.(m?js|ts|tsx|py|go|rs|java)$/.test(e)) out.push(f);
  }
  return out;
}

export function buildGraph(cwd = '.') {
  const files = walk(cwd);
  const nodes = []; // {id, kind: module|file|symbol|contract, file, symbol?}
  const edges = []; // {from, to, kind: import|call|contract, runtime?}
  const modules = new Set();
  for (const f of files) {
    const rel = relative(cwd, f);
    const mod = rel.split('/').slice(0, 2).join('/');
    modules.add(mod);
    nodes.push({ id: `file:${rel}`, kind: 'file', file: rel, module: mod });
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    // imports
    for (const m of src.matchAll(/(?:import\s+[^'"]*from\s*['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)|from\s+(\S+)\s+import)/g)) {
      const dep = m[1] || m[2] || m[3];
      if (dep && dep.startsWith('.')) edges.push({ from: `file:${rel}`, to: `dep:${dep}`, kind: 'import' });
    }
    // exported symbols
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/g))
      nodes.push({ id: `symbol:${m[1]}@${rel}`, kind: 'symbol', file: rel, symbol: m[1] });
    // http routes: Express/Nest/FastAPI-ish
    for (const m of src.matchAll(/(?:app|router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g))
      nodes.push({ id: `api:${m[1].toUpperCase()} ${m[2]}`, kind: 'contract', file: rel });
    for (const m of src.matchAll(/@(?:app|router)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g))
      nodes.push({ id: `api:${m[1].toUpperCase()} ${m[2]}`, kind: 'contract', file: rel });
    // zod schemas
    for (const m of src.matchAll(/(?:z\.object|zod\.object)\(/g)) nodes.push({ id: `schema:Zod@${rel}`, kind: 'contract', file: rel });
  }
  for (const m of modules) nodes.push({ id: `module:${m}`, kind: 'module', file: m });
  return { nodes: nodes.slice(0, 2000), edges: edges.slice(0, 5000), truncated: nodes.length > 2000 };
}

// scope: {paths[], symbols[], contracts[]} — intersect at 3 levels
export function forecast(myScope = {}, otherScope = {}) {
  const pathHit = (myScope.paths || []).some((a) => (otherScope.paths || []).some((b) =>
    a.replace(/\*+$/, '') === b.replace(/\*+$/, '') || a.replace(/\*+$/, '').startsWith(b.replace(/\*+$/, '')) || b.replace(/\*+$/, '').startsWith(a.replace(/\*+$/, ''))));
  const symHit = (myScope.symbols || []).some((s) => (otherScope.symbols || []).includes(s));
  const contractHit = (myScope.contracts || []).some((c) => (otherScope.contracts || []).includes(c));
  const deletes = myScope.deletes === true || otherScope.deletes === true;
  if ((symHit || contractHit) && deletes) return 'contradictory';
  if (symHit || contractHit) return 'overlapping';
  if (pathHit) {
    // same file (deep common prefix) = overlapping; same module, different files = adjacent
    const strip = (p) => String(p).replace(/\*+$/, '').replace(/\/$/, '').split('/').filter(Boolean);
    const pairs = (myScope.paths || []).flatMap((a) => (otherScope.paths || []).map((b) => [strip(a), strip(b)]));
    const deep = pairs.some(([a, b]) => {
      const common = a.filter((seg, i) => b[i] === seg).length;
      return common >= 3 || a.join('/') === b.join('/') || a.join('/').startsWith(b.join('/')) || b.join('/').startsWith(a.join('/'));
    });
    if (!deep) {
      const mod = (p) => String(p).split('/').filter(Boolean).slice(0, 2).join('/');
      const adj = (myScope.paths || []).some((a) => (otherScope.paths || []).some((b) => mod(a) === mod(b)));
      return adj ? 'adjacent' : 'overlapping';
    }
    return 'overlapping';
  }
  return 'none';
}
export const scopeOfIntent = (intent = {}) => ({ paths: intent.paths || [], symbols: intent.symbols || [], contracts: intent.contracts || [] });
