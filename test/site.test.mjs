// test/site.test.mjs — contract tests for the Strip Board client.
//
// The browser code has no build step and no test framework, so these tests
// assert the *contract* between the three static assets and the hub:
//   1. every DOM id app.js binds to exists in index.html
//   2. the client never hands hub data to an HTML parser (XSS by construction)
//   3. the reducer is pure and can replay history (Time Machine)
//   4. the payload stays inside the performance budget
//   5. the hub still serves the board and its assets
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, closeHub } from '../src/hub.mjs';

const PORT = 7787;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

const html = readFileSync('site/index.html', 'utf8');
const app = readFileSync('site/app.js', 'utf8');
const css = readFileSync('site/style.css', 'utf8');
const sw = readFileSync('site/sw.js', 'utf8');

let server = null;

/** ids created at runtime by app.js rather than shipped in index.html */
const RUNTIME_IDS = new Set(['prompt-modal', 'prompt-input']);
/** ids app.js looks up defensively — the board prefers #bstat, #tldraw-status is legacy */
const OPTIONAL_IDS = new Set(['tldraw-status']);

describe('site: static contract', () => {
  it('ships every asset the hub allow-lists', () => {
    for (const f of ['index.html', 'app.js', 'style.css', 'sw.js', 'manifest.webmanifest', 'board-tldraw.js']) {
      assert.ok(existsSync(`site/${f}`), `site/${f} missing`);
    }
  });

  it('every element id app.js binds to exists in index.html', () => {
    const used = new Set();
    for (const m of app.matchAll(/\$\(\s*'([a-zA-Z0-9_-]+)'\s*\)/g)) used.add(m[1]);
    for (const m of app.matchAll(/getElementById\(\s*'([a-zA-Z0-9_-]+)'\s*\)/g)) used.add(m[1]);
    // ids that are generated at runtime
    for (const m of app.matchAll(/\$\(\s*`([a-zA-Z0-9_-]*\$\{[^}]+\}[a-zA-Z0-9_-]*)`\s*\)/g)) {
      assert.match(m[1], /\$\{/, 'templated id must be dynamic');
    }
    const missing = [];
    for (const id of used) {
      if (RUNTIME_IDS.has(id) || OPTIONAL_IDS.has(id)) continue;
      if (!new RegExp(`id="${id}"`).test(html)) missing.push(id);
    }
    assert.deepEqual(missing, [], `app.js references ids that index.html does not define: ${missing.join(', ')}`);
  });

  it('never hands hub data to an HTML parser', () => {
    assert.ok(!/innerHTML\s*=/.test(app), 'app.js must not assign innerHTML');
    assert.ok(!/outerHTML\s*=/.test(app), 'app.js must not assign outerHTML');
    assert.ok(!/insertAdjacentHTML/.test(app), 'app.js must not use insertAdjacentHTML');
    assert.ok(!/document\.write/.test(app), 'app.js must not use document.write');
    assert.ok(!/\beval\s*\(/.test(app), 'app.js must not use eval');
    assert.ok(!/new Function\s*\(/.test(app), 'app.js must not use new Function');
    // no inline event-handler attributes are generated
    assert.ok(!/onclick=/.test(app.replace(/\/\*[\s\S]*?\*\//g, '')), 'app.js must not build inline handlers');
  });

  it('declares accessible tabs', () => {
    assert.match(html, /role="tablist"/);
    assert.match(html, /role="tab"/);
    assert.match(html, /role="tabpanel"/);
    assert.match(html, /aria-selected="true"/);
    assert.match(html, /aria-controls="view-topo"/);
    assert.match(html, /class="skip-link"/);
    assert.match(html, /class="sr-only"/);
  });

  it('keeps the strip-board design system (no glass, no webfonts)', () => {
    assert.match(css, /--paper:/);
    assert.match(css, /--signal:/);
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, ''); // ignore the design notes
    assert.ok(!/backdrop-filter/.test(rules), 'no glassmorphism');
    assert.ok(!/@font-face/.test(rules), 'no webfonts — the board must work offline');
    assert.ok(!/url\(\s*['"]?https?:/.test(rules), 'no remote CSS assets');
    assert.ok(!/@import/.test(rules), 'no remote CSS imports');
  });

  it('registers a service worker that never caches live data', () => {
    assert.match(app, /serviceWorker\.register/);
    assert.match(sw, /CACHE_NAME/);
    assert.match(sw, /\/api\//, 'the SW must exclude /api/*');
    assert.match(sw, /\/events/, 'the SW must exclude the SSE stream');
  });

  it('uses one EventSource and never polls on a timer for mesh state', () => {
    const sources = app.match(/new EventSource\(/g) || [];
    assert.equal(sources.length, 1, 'exactly one EventSource');
    // The only timer-driven refresh is the 5s housekeeping tick; mesh state
    // arrives over SSE and is reconciled by the reducer.
    const intervals = app.match(/setInterval\(/g) || [];
    assert.equal(intervals.length, 1, `expected exactly one setInterval, found ${intervals.length}`);
    assert.match(app, /setInterval\([\s\S]{0,400}?\}, 5000\);/, 'the only interval must be the 5s housekeeping tick');
    assert.ok(!/setInterval\([\s\S]{0,200}?\/api\//.test(app), 'no interval may poll an API endpoint');
  });
});

describe('site: performance budget', () => {
  it('keeps the total static payload small', () => {
    const bytes = (p) => readFileSync(p).length;
    const total = bytes('site/index.html') + bytes('site/app.js') + bytes('site/style.css');
    assert.ok(total < 220 * 1024, `static payload ${(total / 1024).toFixed(1)} KB exceeds the 220 KB budget`);
  });

  it('never re-fetches a panel that is not on screen', () => {
    // lazy panels are fetched from selectTab(), not from the render loop
    assert.match(app, /ensurePanel\('crdt'\)/);
    assert.match(app, /ensurePanel\('macp'\)/);
    assert.match(app, /ensurePanel\('dag'\)/);
    assert.match(app, /ensurePanel\('tasks'\)/);
  });

  it('coalesces event-driven refreshes into one request', () => {
    assert.match(app, /debounce\(\(\) => \{ void pullOverview\(\); \}, 120, 900\)/);
    assert.match(app, /overviewInFlight/);
    assert.match(app, /overviewQueued/);
  });

  it('renders on a timer as well as rAF (rAF pauses in background tabs)', () => {
    assert.match(app, /requestAnimationFrame\(once\)/);
    assert.match(app, /setTimeout\(once, 120\)/);
  });
});

describe('site: board contract (ui-unslop)', () => {
  const boardSection = html.slice(html.indexOf('id="view-board"'), html.indexOf('id="view-voice"'));

  it('keeps the canonical keyboard map: 1-8 desks, f focus, r refresh', () => {
    assert.match(app, /e\.key >= '1' && e\.key <= '8'/, '1-8 must switch desks');
    assert.match(app, /e\.key === 'f'/, 'f must focus');
    assert.match(app, /e\.key === 'r'/, 'r must refresh');
    assert.match(app, /DESK_KEYS = \['topo', 'swarm', 'crdt', 'macp', 'dag', 'board', 'voice', 'health'\]/);
    // the old chord is gone: one way to switch desks
    assert.ok(!/pendingChord/.test(app), 'the g-chord must not come back');
  });

  it('gives #board-stage exactly one child', () => {
    const stage = boardSection.slice(boardSection.indexOf('id="board-stage"'));
    const open = stage.indexOf('>', stage.indexOf('id="board-stage"'));
    const close = stage.indexOf('</div>', open);
    const inner = stage.slice(open + 1, close);
    const children = inner.match(/<[a-zA-Z]/g) || [];
    assert.equal(children.length, 1, `#board-stage must hold one child, found ${children.length}`);
    assert.match(inner, /id="board-svg"/);
  });

  it('has one toolbar with tools, colour, code ref and the status line', () => {
    const toolbars = boardSection.match(/class="board-toolbar"/g) || [];
    assert.equal(toolbars.length, 1, 'exactly one board toolbar');
    assert.match(boardSection, /id="board-color"/);
    assert.match(boardSection, /id="board-coderef"/);
    assert.match(boardSection, /id="bstat"/);
    assert.match(boardSection, /role="toolbar"/);
    // no second strip of board chrome
    assert.ok(!/id="tldraw-status"/.test(html), 'the board has exactly one status line');
  });

  it('puts export, import and clear in the board menu, not in the header', () => {
    assert.match(boardSection, /class="board-menu"/);
    assert.match(boardSection, /id="btn-board-export"/);
    assert.match(boardSection, /id="btn-board-import"/);
    assert.match(boardSection, /id="btn-board-clear"/);
    // they must live inside the <details class="board-menu">
    const menu = boardSection.slice(boardSection.indexOf('class="board-menu"'));
    const menuEnd = menu.indexOf('</details>');
    const panel = menu.slice(0, menuEnd);
    for (const id of ['btn-board-export', 'btn-board-import', 'btn-board-clear']) {
      assert.ok(panel.includes(`id="${id}"`), `${id} must live in the board menu`);
    }
    // ...and must not also be loose buttons in the card header
    const header = boardSection.slice(boardSection.indexOf('card-header'), boardSection.indexOf('class="board-toolbar"'));
    const outsideMenu = header.replace(/<details[\s\S]*?<\/details>/g, '');
    assert.ok(!/btn-board-(export|import|clear)/.test(outsideMenu), 'board actions must not be header buttons');
  });

  it('makes every tool a real button with aria-pressed', () => {
    const tools = boardSection.match(/<button[^>]*data-tool="[a-z]+"[^>]*>/g) || [];
    assert.ok(tools.length >= 4, `expected the tool buttons, found ${tools.length}`);
    for (const t of tools) {
      assert.match(t, /aria-pressed="(true|false)"/, `tool button must carry aria-pressed: ${t}`);
      assert.match(t, /type="button"/);
    }
  });

  it('gives the canvas an application role and a label', () => {
    assert.match(boardSection, /id="board-svg"[^>]*role="application"/);
    assert.match(boardSection, /id="board-svg"[^>]*aria-label="[^"]+"/);
  });

  it('uses the shared dark canvas and the line border', () => {
    assert.match(css, /\.board-stage\s*\{[^}]*background:\s*#0d1219/s);
    assert.match(css, /\.board-stage\s*\{[^}]*border:\s*1px solid var\(--line\)/s);
    assert.match(css, /\.topology-stage\s*\{[^}]*background:\s*#0d1219/s);
  });

  it('has no emoji in the board toolbar and no webfont', () => {
    const toolbar = boardSection.slice(boardSection.indexOf('class="board-toolbar"'), boardSection.indexOf('id="board-stage"'));
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(toolbar), 'the toolbar must not use emoji');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/@font-face/.test(rules));
  });

  it('keeps sticky text legible on the dark canvas', () => {
    assert.match(app, /'font-size': 13/, 'sticky text must be at least 13px');
  });

  it('honours prefers-reduced-motion', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe('site: reducer is pure and replayable', () => {
  // The reducer is exercised through the same code path the browser uses.
  // A minimal DOM shim is enough because the reducer never touches the DOM.
  const load = () => {
    const src = app;
    const noop = () => {};
    const mkEl = () => ({
      setAttribute: noop, appendChild: noop, addEventListener: noop, remove: noop, insertBefore: noop,
      classList: { add: noop, remove: noop, toggle: noop },
      style: {}, dataset: {}, children: [], firstChild: null, nextSibling: null,
      querySelector: () => null, querySelectorAll: () => [], textContent: '', innerHTML: '', hidden: false,
    });
    const doc = {
      readyState: 'complete',
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: mkEl,
      createElementNS: mkEl,
      body: { appendChild: noop, classList: { add: noop, remove: noop } },
      addEventListener: noop,
      activeElement: null,
      getElementsByTagName: () => [],
      createTextNode: (t) => ({ textContent: t }),
    };
    const loc = { origin: 'http://localhost:7777', protocol: 'http:', port: '7777', hash: '', search: '', href: 'http://localhost:7777/' };
    const win = { addEventListener: noop, AgentMeshApp: undefined };
    win.document = doc;
    const ls = { getItem: () => null, setItem: noop, removeItem: noop, length: 0, key: () => null };
    const nav = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } };
    const fetchStub = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true }),
      text: async () => '',
      clone() { return this; },
    });
    const ES = function () { this.close = noop; };

    const fn = new Function(
      'window', 'document', 'localStorage', 'navigator', 'location', 'performance',
      'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'fetch', 'console', 'AbortSignal', 'EventSource', 'Blob', 'URL', 'BroadcastChannel',
      'PerformanceObserver', 'crypto', 'history',
      `${src}\n; return window.AgentMeshApp;`,
    );
    return fn(
      win, doc, ls, nav, loc,
      { now: () => Date.now() },
      (cb) => setTimeout(cb, 0), setTimeout, clearTimeout, () => 0, clearInterval,
      fetchStub, console, AbortSignal, ES, function Blob() {}, URL, undefined, undefined,
      { getRandomValues: (a) => a }, { replaceState: noop },
    );
  };

  it('exposes the reducer on the public surface', () => {
    const api = load();
    assert.equal(typeof api.applyEvent, 'function');
    assert.equal(typeof api.stateAt, 'function');
  });

  it('applies intent lifecycle events deterministically', () => {
    const api = load();
    const m = { intents: [], requests: [], pins: [], decisions: [], tasks: {}, crdt: {}, macp: {}, presence: {}, build: {} };
    api.applyEvent(m, { seq: 1, kind: 'intent.declared', actor: 'alice', payload: { id: 'in-1', goal: 'g', paths: ['a/**'] } });
    assert.equal(m.intents.length, 1);
    assert.equal(m.intents[0].actor, 'alice');
    api.applyEvent(m, { seq: 2, kind: 'intent.released', actor: 'alice', payload: { id: 'in-1' } });
    assert.equal(m.intents.length, 0);
  });

  it('tracks task transitions and presence', () => {
    const api = load();
    const m = { intents: [], requests: [], pins: [], decisions: [], tasks: {}, crdt: {}, macp: {}, presence: {}, build: {} };
    api.applyEvent(m, { seq: 1, kind: 'task.created', actor: 'a', t: 1, payload: { id: 't1', title: 'x' } });
    assert.equal(m.tasks.t1.status, 'pending');
    api.applyEvent(m, { seq: 2, kind: 'task.claimed', actor: 'b', payload: { id: 't1', actor: 'b' } });
    assert.equal(m.tasks.t1.status, 'in-progress');
    assert.equal(m.tasks.t1.owner, 'b');
    api.applyEvent(m, { seq: 3, kind: 'presence', actor: 'c', t: 9, payload: { verb: 'editing' } });
    assert.equal(m.presence.c.seen, 9);
  });

  it('replays a history into a past snapshot (Time Machine)', () => {
    const api = load();
    const st = api.state;
    const mk = (seq, kind, actor, payload) => ({ seq, kind, actor, payload, t: seq * 1000 });
    api.ingestEvent(mk(1, 'intent.declared', 'alice', { id: 'in-1', goal: 'first' }), { history: true });
    api.ingestEvent(mk(2, 'intent.declared', 'bob', { id: 'in-2', goal: 'second' }), { history: true });
    api.ingestEvent(mk(3, 'intent.released', 'alice', { id: 'in-1' }), { history: true });

    const at1 = api.stateAt(1);
    const at2 = api.stateAt(2);
    const at3 = api.stateAt(3);
    assert.equal(at1.intents.length, 1, 'at seq 1 only the first intent exists');
    assert.equal(at2.intents.length, 2, 'at seq 2 both intents exist');
    assert.equal(at3.intents.length, 1, 'at seq 3 the first intent was released');
  });

  it('bounds the event buffer', () => {
    const api = load();
    for (let i = 1; i <= 900; i++) {
      api.ingestEvent({ seq: i, kind: 'intent.declared', actor: 'x', payload: { id: `in-${i}` } }, { history: true });
    }
    assert.ok(api.state.events.length <= 500, `buffer grew to ${api.state.events.length}`);
  });
});

describe('site: hub serving', () => {
  before(async () => {
    server = createServer().listen(PORT, HOST);
    await new Promise((r) => setTimeout(r, 150));
  });
  after(async () => { if (server) await closeHub(server); });

  it('serves the board with the strip-board identity', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /AgentMesh/);
    assert.match(body, /STRIP BOARD/);
    assert.match(body, /id="navigation-tabs"/);
  });

  it('serves app.js and style.css with the right MIME types', async () => {
    const js = await fetch(`${BASE}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const cssRes = await fetch(`${BASE}/style.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type'), /text\/css/);
  });

  it('serves the service worker and the manifest', async () => {
    assert.equal((await fetch(`${BASE}/sw.js`)).status, 200);
    const man = await fetch(`${BASE}/manifest.webmanifest`);
    assert.equal(man.status, 200);
    const json = await man.json();
    assert.equal(json.theme_color, '#0c0d10');
    assert.ok(!/�/.test(JSON.stringify(json)), 'manifest must be valid UTF-8');
  });

  it('exposes the endpoints the client reads', async () => {
    for (const p of ['/api/overview', '/api/crdt', '/api/macp', '/api/dag', '/api/tasks', '/api/board', '/metrics', '/health', '/ready']) {
      const res = await fetch(`${BASE}${p}`);
      assert.equal(res.status, 200, `${p} should be 200`);
      const body = await res.json();
      assert.equal(body.ok, true, `${p} should report ok`);
    }
  });

  it('serves an event log the Time Machine can replay', async () => {
    const res = await fetch(`${BASE}/api/events?limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length <= 10);
  });
});
