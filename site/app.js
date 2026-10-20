// site/app.js — AgentMesh Strip Board client.
//
// Design contract (see docs/SITE_PLAN.md):
//   * Zero dependencies, zero build step, plain ES2020. The hub serves a fixed
//     allow-list of static files (src/hub.mjs), so the whole app must stay in
//     index.html + style.css + app.js.
//   * One EventSource. Events feed a *pure* reducer; the reducer output is
//     reconciled into the DOM by key. Requests are debounced and coalesced:
//     a burst of N events costs 1 request, not N*4.
//   * Panels that are not visible issue no network requests at all.
//   * Nothing from the hub is ever interpolated as HTML. All dynamic text goes
//     through textContent / setAttribute.
//
// Sections: 0 utils · 1 store+reducer · 2 net · 3 views · 4 features · 5 board
//            6 voice · 7 wiring/boot

(function () {
  'use strict';

  /* ===================================================================== *
   * §0  Utilities
   * ===================================================================== */

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const on = (target, type, fn, opts) => target && target.addEventListener(type, fn, opts);
  const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
  const nowMs = () => performance.now();

  /**
   * Safe element factory.
   *
   * There is deliberately NO `html` option: hub-supplied text can only ever
   * reach the DOM through `textContent` / `setAttribute`, never through an
   * HTML parser. That makes the client immune to markup injection from a
   * compromised hub or a hostile peer agent (a peer can write anything into an
   * intent `goal`).
   */
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(3)) {
      if (kid == null || kid === false) continue;
      node.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const node = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(3)) {
      if (kid == null || kid === false) continue;
      node.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  /** Bounded FIFO buffer. Everything unbounded in the old client is one of these. */
  function ring(cap) {
    const buf = [];
    return {
      cap,
      get length() { return buf.length; },
      push(v) { buf.push(v); if (buf.length > cap) buf.splice(0, buf.length - cap); return v; },
      toArray() { return buf.slice(); },
      at(i) { return buf[i]; },
      clear() { buf.length = 0; },
      forEach(fn) { buf.forEach(fn); },
    };
  }

  function debounce(fn, wait, maxWait) {
    let t = 0, m = 0;
    const run = () => { clearTimeout(t); clearTimeout(m); t = 0; m = 0; fn(); };
    return function () {
      if (!t && maxWait) m = setTimeout(run, maxWait);
      clearTimeout(t);
      t = setTimeout(run, wait);
    };
  }

  function fmtAge(ms) {
    if (!Number.isFinite(ms)) return '—';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`;
    return `${Math.floor(h / 24)}d${h % 24}h`;
  }

  function fmtAgo(ts) {
    if (!ts) return 'never';
    return fmtAge(Date.now() - ts);
  }

  /**
   * Keyed DOM reconciliation. Reuses nodes, patches in place, and only moves a
   * node when its position actually changed. This is what keeps a 500-event
   * burst under the long-task threshold.
   */
  function reconcile(container, items, keyFn, create, update) {
    if (!container) return;
    const map = new Map();
    const unkeyed = [];
    for (const child of container.children) {
      const k = child.dataset && child.dataset.k;
      if (k != null) map.set(k, child);
      else unkeyed.push(child); // stale placeholders (empty states, seed rows)
    }
    for (const node of unkeyed) node.remove();
    let cursor = container.firstChild;
    for (const item of items) {
      const k = String(keyFn(item, cursor));
      let node = map.get(k);
      if (node) { map.delete(k); update(node, item); }
      else { node = create(item); node.dataset.k = k; }
      if (cursor === node) cursor = cursor.nextSibling;
      else container.insertBefore(node, cursor);
    }
    for (const node of map.values()) node.remove();
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const ta = el('textarea', { class: 'sr-only' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch { return false; }
  }

  /* ===================================================================== *
   * §1  Store + pure reducer
   * ===================================================================== */

  const RING_CAP = 500;
  const LS = {
    hub: 'mesh_hub_url',
    pinned: 'mesh_hub_pinned',
    token: 'mesh_token',
    tokenAlt: 'mesh_auth_token', // legacy key kept in sync so nothing else breaks
    actor: 'mesh_actor',
  };

  /**
   * Location flags.
   *
   * The hub routes on `req.url.split('/')[1]`, which keeps the query string —
   * so `/?hud=1` 404s on the hub (it also 404s the documented
   * `?board=tldraw` deep link). To stay deployable on the hub *today* the site
   * reads its flags from the **hash**, which is never sent to the server:
   *
   *   #topo&hud=1        -> topo desk, performance HUD on
   *   #board&board=tldraw-> board desk, open the tldraw canvas
   *
   * The query string is still honoured as a fallback for static hosts
   * (Cloudflare Pages / Vercel / Netlify) where `/` routing is correct.
   */
  function parseLocation() {
    const flags = {};
    const raw = (location.hash || '').replace(/^#/, '');
    const parts = raw.split('&').filter(Boolean);
    const tab = parts.shift() || '';
    for (const p of parts) {
      const i = p.indexOf('=');
      if (i > 0) flags[p.slice(0, i)] = p.slice(i + 1);
      else flags[p] = '1';
    }
    try {
      const q = new URLSearchParams(location.search);
      for (const [k, v] of q) if (!(k in flags)) flags[k] = v;
    } catch { /* no search */ }
    return { tab, flags };
  }

  function locationTab() {
    const { tab } = parseLocation();
    return tab;
  }

  function locationFlags() {
    return parseLocation().flags;
  }

  function writeLocation(tab) {
    const flags = state.flags || {};
    const extra = Object.keys(flags).map((k) => `${k}=${flags[k]}`).join('&');
    const hash = extra ? `#${tab}&${extra}` : `#${tab}`;
    try {
      const url = new URL(location.href);
      if (url.hash !== hash) { url.hash = hash; history.replaceState(null, '', url); }
    } catch { /* no history */ }
  }

  const DEFAULT_HUB = (() => {
    try {
      if (location.port === '7777') return location.origin;
      const saved = localStorage.getItem(LS.hub);
      if (saved) return saved;
      return 'http://localhost:7777';
    } catch { return 'http://localhost:7777'; }
  })();

  const state = {
    hubUrl: DEFAULT_HUB,
    hubUrlExplicit: '',        // a URL an operator chose
    hubUrlPinned: false,       // …and whether they chose it on purpose
    token: '',
    actor: 'browser',
    connected: false,
    connecting: false,
    seq: 0,
    trunk: '—',
    ov: null,                 // last authoritative /api/overview payload
    panels: { crdt: null, macp: null, dag: null, tasks: null, board: null, metrics: null, health: null },
    panelSeq: { crdt: -1, macp: -1, dag: -1, tasks: -1, board: -1 },
    activeTab: 'topo',
    flags: {},
    seenTabs: new Set(['topo']),
    scrubbing: null,          // seq we are rewound to, or null for live
    events: ring(RING_CAP),
    eventCount: 0,
    agents: [
      { id: 'antigravity-ui', name: 'Antigravity UI Lead', role: 'UI & Frontend Architecture', host: 'Laptop 1 (Antigravity IDE)', provider: 'Google Antigravity', model: 'IDE Agent', status: 'active', task: 'Observatory & UI components' },
      { id: 'codex-backend', name: 'Codex Core Dev', role: 'Backend & Event Bus Engine', host: 'Laptop 2 (Codex / Cursor)', provider: 'OpenAI Codex', model: 'Cursor / CLI', status: 'active', task: 'API routes & AST contracts' },
      { id: 'contract-auditor', name: 'Contract Steward', role: 'AST Invariants & Verification', host: 'LAN / Automated Test Harness', provider: 'AgentMesh AST', model: 'AST-L4', status: 'idle', task: 'Guarding breaking changes' },
    ],
    boardShapes: [],
    boardSeq: 0,
    boardCodeRef: '',
    tldrawMounted: false,
    focusActor: null,
    selectedShapeId: null,
    currentTool: 'pen',
    boardColor: '#ff4d00',
    audioCtx: null,
    mediaStream: null,
    analyser: null,
    animFrameId: null,
    isMicConnected: false,
    isMuted: false,
    hudOn: false,
    inboxOpen: false,
    inboxTab: 'requests',
    collide: null,
    paletteOpen: false,
    paletteIndex: 0,
    paletteItems: [],
    drawerReturnFocus: null,
    lastFocus: null,
    perf: { requests: 0, reqWindow: [], latency: 0, render: 0, longtask: 0, reconnects: 0, domNodes: 0 },
  };

  /* --- the reducer --------------------------------------------------- */

  function emptyMirror() {
    return { intents: [], requests: [], pins: [], decisions: [], tasks: {}, crdt: {}, macp: {}, presence: {}, build: {} };
  }

  /**
   * Pure-ish reducer over hub events. Mutates `m` in place; callers clone
   * first when they need an independent snapshot. This is the only place
   * that knows what an event *means*, which is what makes the Time Machine
   * possible: replaying events through it reconstructs any past state.
   */
  function applyEvent(m, evt) {
    const kind = evt && evt.kind;
    const p = (evt && evt.payload) || {};
    switch (kind) {
      case 'intent.declared':
        if (p && p.id) {
          // The actor lives on the event, not the payload: the hub emits
          // `intent.declared` with the intent as the payload and the declaring
          // agent as the event actor.
          const rec = { ...p, actor: p.actor || evt.actor };
          const i = m.intents.findIndex((x) => x.id === p.id);
          if (i >= 0) m.intents[i] = rec; else m.intents.push(rec);
        }
        break;
      case 'intent.released':
        m.intents = m.intents.filter((x) => x.id !== p.id);
        break;
      case 'request.created':
        if (p && p.id) m.requests.push({ id: p.id, to: p.to, text: p.text, status: p.status || 'queued', from: evt.actor });
        break;
      case 'request.accepted':
      case 'request.declined': {
        const r = m.requests.find((x) => x.id === p.id);
        if (r) r.status = kind === 'request.accepted' ? 'working' : 'declined';
        break;
      }
      case 'message.posted':
        if (p && p.node && p.say) m.pins.push({ id: p.id || `pin-${evt.seq}`, node: p.node, text: p.say, actor: evt.actor });
        break;
      case 'task.created':
        if (p && p.id) m.tasks[p.id] = { id: p.id, title: p.title, paths: p.paths || [], status: 'pending', owner: null, by: evt.actor, created: evt.t };
        break;
      case 'task.claimed': {
        const t = m.tasks[p.id];
        if (t) { t.status = 'in-progress'; t.owner = p.actor; }
        break;
      }
      case 'task.pending':
      case 'task.in-progress':
      case 'task.done':
      case 'task.blocked': {
        const t = m.tasks[p.id];
        const status = kind.slice('task.'.length);
        if (t) { t.status = status; t.note = p.note || t.note; if (status === 'done') t.owner = p.actor || t.owner; }
        else if (p.id) m.tasks[p.id] = { id: p.id, status, title: p.id, owner: p.actor || null, created: evt.t };
        break;
      }
      case 'crdt.symbol_updated':
        if (p && p.key) m.crdt[p.key] = { key: p.key, value: p.value, actor: evt.actor, lamport: p.lamport };
        break;
      case 'macp.session_created':
        if (p && p.id) m.macp[p.id] = { id: p.id, mode: p.mode, status: 'active', initiator: evt.actor, title: '', votes: {} };
        break;
      case 'macp.vote_cast': {
        const s = m.macp[p.id];
        if (s) { s.votes = s.votes || {}; s.votes[evt.actor] = { vote: p.vote }; }
        break;
      }
      case 'presence':
        m.presence[evt.actor] = { ...p, seen: evt.t, away: false };
        break;
      case 'build.status':
        m.build[evt.actor] = { done: !!p.done, note: p.note || '', ts: evt.t };
        break;
      default:
        break;
    }
    return m;
  }

  function cloneMirror(m) {
    return {
      intents: m.intents.slice(),
      requests: m.requests.slice(),
      pins: m.pins.slice(),
      decisions: m.decisions.slice(),
      tasks: { ...m.tasks },
      crdt: { ...m.crdt },
      macp: JSON.parse(JSON.stringify(m.macp)),
      presence: { ...m.presence },
      build: { ...m.build },
    };
  }

  // Events are retained; the oldest retained event's predecessor state lives in
  // `mirrorBase` so a full replay is always possible without the whole log.
  let mirrorBase = emptyMirror();

  function ingestEvent(evt, opts) {
    if (!evt || !evt.kind) return;
    const history = !!(opts && opts.history);
    state.events.push(evt);
    if (state.events.length >= RING_CAP) {
      const dropped = state.events.at(0);
      applyEvent(mirrorBase, dropped);
    }
    if (history) return;   // replayed history must not trigger a sync or spam the console
    state.eventCount++;
    markDirty(scopeOfEvent(evt.kind));
    // A peer drew on the board: pull its op (debounced) instead of reloading.
    if (evt.kind === 'board.op') scheduleBoardPull();
    scheduleSync();   // one coalesced refresh per burst of events
    renderEventLine(evt);
  }

  /**
   * Seed the Time Machine from the hub's event log so scrubbing works the
   * moment the board opens, not only after the next mutation. The hub already
   * keeps a hash-chained log with a replay endpoint (`/api/events?limit=N`).
   */
  async function seedHistory(limit) {
    try {
      const d = await net.get('/api/events?limit=' + (limit || 200));
      const list = (d && d.events) || [];
      list.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      for (const e of list) ingestEvent(e, { history: true });
      updateTimeMachine();
      return list.length;
    } catch {
      return 0;
    }
  }

  /** Map an event kind to the view scopes it can affect. */
  function scopeOfEvent(kind) {
    if (!kind) return 'overview';
    if (kind.startsWith('intent.') || kind === 'policy.denied') return 'topo';
    if (kind.startsWith('request.') || kind === 'message.posted') return 'swarm';
    if (kind.startsWith('task.')) return 'tasks';
    if (kind.startsWith('crdt.')) return 'crdt';
    if (kind.startsWith('macp.')) return 'macp';
    if (kind.startsWith('board.')) return 'board';
    if (kind === 'presence' || kind === 'build.status') return 'presence';
    return 'overview';
  }

  /**
   * Reconstruct the mesh as it was at `seq`. This is the Time Machine.
   * Pure: clone the base, fold the events up to `seq`.
   */
  function stateAt(seq) {
    const m = cloneMirror(mirrorBase);
    for (const evt of state.events.toArray()) {
      if (evt.seq > seq) break;
      applyEvent(m, evt);
    }
    return m;
  }

  /* ===================================================================== *
   * §2  Net
   * ===================================================================== */

  const net = {
    base: () => state.hubUrl.replace(/\/+$/, ''),
    token: () => state.token || '',

    headers(extra) {
      const h = Object.assign({ 'content-type': 'application/json' }, extra || {});
      if (state.token) h.authorization = 'Bearer ' + state.token;
      return h;
    },

    async request(path, opts) {
      // Never build a URL before the hub has been discovered: the pre-discovery
      // default would send the request to the wrong host.
      if (hubReadyResolve) await hubReady;
      const o = opts || {};
      const url = /^https?:/.test(path) ? path : net.base() + path;
      const started = nowMs();
      state.perf.requests++;
      state.perf.reqWindow.push(started);
      try {
        const res = await fetch(url, {
          method: o.method || 'GET',
          headers: net.headers(o.headers),
          body: o.body ? JSON.stringify(o.body) : undefined,
          signal: o.signal,
          mode: o.mode,
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        if (!res.ok) {
          const err = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      } finally {
        state.perf.latency = nowMs() - started;
      }
    },

    get(path, opts) { return net.request(path, Object.assign({}, opts, { method: 'GET' })); },
    post(path, body, opts) { return net.request(path, Object.assign({}, opts, { method: 'POST', body })); },
  };

  /* --- EventSource ---------------------------------------------------- */

  let sse = null;

  // Resolved once the hub URL is known. Every hub request waits on it so a
  // request can never be addressed to the pre-discovery default.
  let hubReadyResolve = null;
  const hubReady = new Promise((r) => { hubReadyResolve = r; });
  function markHubReady() {
    if (hubReadyResolve) { hubReadyResolve(); hubReadyResolve = null; }
  }

  function sseUrl() {
    const b = net.base();
    // EventSource cannot set headers; the hub accepts ?token= for /events.
    return state.token ? `${b}/events?token=${encodeURIComponent(state.token)}` : `${b}/events`;
  }

  function openStream() {
    closeStream();
    try {
      sse = new EventSource(sseUrl());
    } catch {
      sse = null;
      return;
    }
    sse.onopen = () => {
      setHubStatus('live');
      pushEventLine({ kind: 'mesh.connected', actor: 'hub', payload: { say: 'SSE stream established' } });
    };
    sse.onmessage = (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch { return; }
      ingestEvent(data);
    };
    sse.onerror = () => {
      state.perf.reconnects++;
      setHubStatus('retry');
    };
  }

  function closeStream() {
    if (sse) { try { sse.close(); } catch { /* already closed */ } sse = null; }
  }

  /* --- overview sync: debounced + coalesced ---------------------------- */

  const dirty = new Set();
  let overviewInFlight = false;
  let overviewQueued = false;

  function markDirty(scope) {
    dirty.add(scope || 'overview');
    scheduleRender();
  }

  // Trailing debounce with a ceiling: a burst of N events costs ONE request.
  const forceSync = debounce(() => { void pullOverview(); }, 120, 900);

  function scheduleSync() { forceSync(); }

  async function pullOverview() {
    if (!state.connected) return null;
    if (overviewInFlight) { overviewQueued = true; return null; }
    overviewInFlight = true;
    try {
      const data = await net.get('/api/overview');
      applyOverview(data);
      return data;
    } catch {
      setHubStatus('error');
      return null;
    } finally {
      overviewInFlight = false;
      if (overviewQueued) { overviewQueued = false; void pullOverview(); }
    }
  }

  function applyOverview(d) {
    if (!d) return;
    const changed = d.seq !== state.seq;
    state.ov = d;
    state.seq = d.seq || 0;
    state.trunk = d.trunk || '—';
    markDirty('overview');
    if (changed) {
      // A server-side seq bump invalidates lazily-fetched panels.
      state.panelSeq.crdt = -1;
      state.panelSeq.macp = -1;
      state.panelSeq.dag = -1;
      state.panelSeq.tasks = -1;
    }
  }

  /** Lazily fetch a panel the first time its tab is opened; cache until seq moves. */
  async function ensurePanel(name, force) {
    if (!state.connected) return null;
    if (!force && state.panels[name] != null && state.panelSeq[name] === state.seq) return state.panels[name];
    if (name === 'crdt') state.panelSeq.crdt = -1;
    try {
      const path = { crdt: '/api/crdt', macp: '/api/macp', dag: '/api/dag', tasks: '/api/tasks', board: '/api/board' }[name];
      if (!path) return null;
      const data = await net.get(path);
      state.panels[name] = data;
      state.panelSeq[name] = state.seq;
      markDirty(name);
      return data;
    } catch {
      return null;
    }
  }

  /* ===================================================================== *
   * §3  Views
   * ===================================================================== */

  let renderQueued = false;

  /**
   * Schedule one render.
   *
   * `requestAnimationFrame` is *paused* in background tabs and hidden frames
   * (MDN, "Using requestAnimationFrame"). A board that only renders on rAF
   * silently freezes the moment the operator switches tabs — which is exactly
   * when you want the mesh to keep up. So rAF is raced against a short timer:
   * the frame path gives us frame-aligned painting, the timer guarantees the
   * board still updates while hidden.
   */
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    let fired = false;
    const once = () => {
      if (fired) return;
      fired = true;
      renderQueued = false;
      flushRender();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(once);
    setTimeout(once, 120);
  }

  function flushRender() {
    const t0 = nowMs();
    const scopes = new Set(dirty);
    dirty.clear();

    if (scopes.has('overview') || scopes.has('topo') || scopes.has('swarm') || scopes.has('presence')) {
      renderReadout();
      renderTopology();
      renderStrips();
      renderRoster();
      renderRequests();
      renderOps();
      renderPresenceLamps();
    }
    if (scopes.has('crdt')) renderCrdt();
    if (scopes.has('macp')) renderMacp();
    if (scopes.has('dag')) renderDag();
    if (scopes.has('board')) renderBoard();
    if (scopes.has('health')) renderHealth();
    renderFocusChip();
    // Only the visible desk pays for its own detail fetch.
    if (state.activeTab === 'swarm') { renderTasks(); void ensurePanel('tasks'); }
    if (state.inboxOpen) renderInbox();

    state.perf.render = nowMs() - t0;
    state.perf.domNodes = document.getElementsByTagName('*').length;
    updateHud();
  }

  /* --- readout -------------------------------------------------------- */

  function renderReadout() {
    const ov = state.ov;
    const set = (id, v) => { const n = $(id); if (n) n.textContent = v; };
    set('metric-seq', `#${state.seq}`);
    set('metric-trunk', state.trunk);
    set('metric-agents', String((ov && ov.roster ? ov.roster.length : 0) || state.agents.length));
    const intents = currentIntents();
    set('metric-intents', `${intents.length} active`);
    const collisions = currentCollisions();
    const cs = $('metric-collision-sub');
    if (cs) {
      cs.textContent = collisions.length ? `⚠ ${collisions.length} CONFLICT` : 'NO CONFLICTS';
      cs.classList.toggle('hot', collisions.length > 0);
    }
    const seg = $('metric-intents-seg');
    if (seg) seg.classList.toggle('hot', collisions.length > 0);
    const t = (ov && ov.tasks) || {};
    const total = (t.pending || 0) + (t['in-progress'] || 0) + (t.blocked || 0) + (t.done || 0);
    set('metric-tasks', `${t.done || 0}/${total}`);
    set('metric-latency', state.perf.latency ? `${Math.round(state.perf.latency)}ms` : '—');

    const banner = $('collision-alert-banner');
    if (banner) {
      if (collisions.length) {
        banner.style.display = '';
        banner.textContent = `⚠ CONFLICT ON THE BOARD: ${collisions.map((c) => `@${c.a} × @${c.b} overlap (${c.grade})`).join(' · ')}. Settle it in MACP before merging.`;
      } else {
        banner.style.display = 'none';
      }
    }
    const topoTab = $('tab-btn-topo');
    if (topoTab) topoTab.classList.toggle('alert', collisions.length > 0);
    const stripCount = $('strip-count');
    if (stripCount) stripCount.textContent = `${intents.length} strip${intents.length === 1 ? '' : 's'} · leases with AST collision forecast`;

    const inboxCount = $('inbox-count');
    if (inboxCount) {
      const n = openRequestCount();
      inboxCount.textContent = String(n);
      inboxCount.hidden = n === 0;
    }
  }

  function currentIntents() {
    if (state.scrubbing != null) return stateAt(state.scrubbing).intents;
    return (state.ov && state.ov.intents) || [];
  }

  function currentCollisions() {
    if (state.scrubbing != null) return computeCollisions(currentIntents());
    return (state.ov && state.ov.collisions) || [];
  }

  function openRequestCount() {
    if (state.scrubbing != null) return stateAt(state.scrubbing).requests.filter((r) => r.status === 'queued').length;
    const ov = state.ov;
    if (!ov) return 0;
    return (ov.openReqs || []).length;
  }

  /** Local O(n²) overlap forecast — mirrors the hub's grade vocabulary. */
  function computeCollisions(intents) {
    const out = [];
    const norm = (p) => String(p || '').replace(/\*\*$/, '').replace(/^\.\//, '');
    for (let i = 0; i < intents.length; i++) {
      for (let j = i + 1; j < intents.length; j++) {
        const a = intents[i], b = intents[j];
        if (!a || !b) continue;
        const pa = (a.paths || []).map(norm);
        const pb = (b.paths || []).map(norm);
        let hit = false, contradictory = false;
        for (const x of pa) {
          for (const y of pb) {
            if (!x || !y) continue;
            if (x === y || x.startsWith(y) || y.startsWith(x)) { hit = true; }
            else if (x.includes('*') || y.includes('*')) { hit = true; }
          }
        }
        if (a.effect === 'breaking' && b.effect === 'breaking') contradictory = true;
        if (hit) out.push({ a: a.actor, b: b.actor, grade: contradictory ? 'contradictory' : 'overlapping' });
      }
    }
    return out;
  }

  /* --- topology ------------------------------------------------------- */

  const TOPO_W = 960, TOPO_H = 480;
  const MAX_TOPO_ACTORS = 28;    // keep the ring readable
  const MAX_TOPO_COLLISIONS = 24; // keep the SVG small

  const COLLISION_RANK = { contradictory: 0, overlapping: 1, adjacent: 2, none: 3 };

  function renderTopology() {
    const root = $('topology-svg');
    if (!root) return;
    const intents = currentIntents();
    const presence = (state.ov && state.ov.presence) || {};
    const roster = (state.ov && state.ov.roster) || [];

    // Actors: hub + everyone seen in presence + everyone holding an intent.
    const actors = new Map();
    const addActor = (id, label, kind) => {
      if (!id) return;
      if (!actors.has(id)) actors.set(id, { id, label: label || id, kind: kind || 'agent', intents: 0, away: false });
    };
    addActor('hub', 'HUB', 'hub');
    for (const r of roster) addActor(r.actor, r.actor, 'agent');
    for (const id of Object.keys(presence)) addActor(id, id, 'agent');
    for (const it of intents) addActor(it.actor, it.actor, 'agent');

    let list = Array.from(actors.values());
    // Focus mode (`f`): collapse the graph to one agent and its neighbours.
    if (state.focusActor) {
      const keep = new Set(['hub', state.focusActor]);
      for (const c of currentCollisions()) {
        if (c.a === state.focusActor) keep.add(c.b);
        if (c.b === state.focusActor) keep.add(c.a);
      }
      list = list.filter((a) => keep.has(a.id));
    }
    // Keep the hub plus the busiest actors; the ring must stay legible.
    if (list.length > MAX_TOPO_ACTORS) {
      const hub = list.filter((a) => a.kind === 'hub');
      const rest = list.filter((a) => a.kind !== 'hub')
        .sort((a, b) => (b.intents || 0) - (a.intents || 0) || a.id.localeCompare(b.id))
        .slice(0, MAX_TOPO_ACTORS - hub.length);
      list = hub.concat(rest);
    }
    const cx = TOPO_W / 2, cy = TOPO_H / 2;
    const radius = Math.min(TOPO_W, TOPO_H) * 0.36;
    list.forEach((a, i) => {
      if (a.kind === 'hub') { a.x = cx; a.y = cy; return; }
      const ang = (i / Math.max(1, list.length - 1)) * Math.PI * 2 - Math.PI / 2;
      a.x = cx + Math.cos(ang) * radius;
      a.y = cy + Math.sin(ang) * radius * 0.78;
      a.intents = intents.filter((x) => x && x.actor === a.id).length;
      const p = presence[a.id];
      a.away = !!(p && p.away);
    });

    const allCollisions = currentCollisions();
    const collisions = allCollisions.slice()
      .sort((a, b) => (COLLISION_RANK[a.grade] ?? 3) - (COLLISION_RANK[b.grade] ?? 3))
      .slice(0, MAX_TOPO_COLLISIONS);
    const collided = new Set();
    for (const c of collisions) { collided.add(c.a); collided.add(c.b); }

    // Conduits: hub → actor, plus actor → actor for collisions.
    const items = [];
    for (const a of list) {
      if (a.kind === 'hub') continue;
      const hot = collided.has(a.id);
      items.push({
        key: `line:${a.id}`,
        node: svg('line', { x1: cx, y1: cy, class: hot ? 'topo-line hot' : 'topo-line' }),
        patch: (n) => { n.setAttribute('x2', a.x.toFixed(1)); n.setAttribute('y2', a.y.toFixed(1)); },
      });
    }
    for (const c of collisions) {
      const a = list.find((x) => x.id === c.a), b = list.find((x) => x.id === c.b);
      if (!a || !b) continue;
      items.push({
        key: `collide:${c.a}:${c.b}`,
        node: svg('line', { class: 'topo-line collide' }),
        patch: (n) => {
          n.setAttribute('x1', a.x.toFixed(1)); n.setAttribute('y1', a.y.toFixed(1));
          n.setAttribute('x2', b.x.toFixed(1)); n.setAttribute('y2', b.y.toFixed(1));
        },
      });
    }
    items.push({ key: 'hub', node: svg('circle', { cx, cy, r: 26, class: 'topo-hub' }), patch: () => {} });
    items.push({ key: 'hub-label', node: svg('text', { x: cx, y: cy + 5, class: 'topo-hub-label', text: 'HUB' }), patch: () => {} });

    for (const a of list) {
      if (a.kind === 'hub') continue;
      const g = svg('g', {
        class: 'topo-node' + (collided.has(a.id) ? ' collided' : '') + (a.away ? ' away' : ''),
        'data-act': 'topo-agent',
        'data-agent': a.id,
        tabindex: '0',
        role: 'button',
        'aria-label': `${a.label}, ${a.intents} active intent${a.intents === 1 ? '' : 's'}`,
      });
      g.appendChild(svg('circle', { cx: a.x.toFixed(1), cy: a.y.toFixed(1), r: 14, class: 'topo-dot' }));
      g.appendChild(svg('title', { text: `${a.label} — ${a.intents} intent(s)` }));
      g.appendChild(svg('text', { x: a.x.toFixed(1), y: (a.y + 30).toFixed(1), class: 'topo-label', text: a.label }));
      items.push({
        key: `agent:${a.id}`,
        node: g,
        patch: (n) => {
          const dot = n.querySelector('.topo-dot');
          const label = n.querySelector('.topo-label');
          if (dot) { dot.setAttribute('cx', a.x.toFixed(1)); dot.setAttribute('cy', a.y.toFixed(1)); }
          if (label) { label.setAttribute('x', a.x.toFixed(1)); label.setAttribute('y', (a.y + 30).toFixed(1)); label.textContent = a.label; }
          n.setAttribute('class', 'topo-node' + (collided.has(a.id) ? ' collided' : '') + (a.away ? ' away' : ''));
          n.setAttribute('aria-label', `${a.label}, ${a.intents} active intent${a.intents === 1 ? '' : 's'}`);
        },
      });
    }

    // Overflow marker: the graph is deliberately capped, say so out loud.
    const hiddenCollisions = allCollisions.length - collisions.length;
    const hiddenActors = actors.size - list.length;
    if (hiddenCollisions > 0 || hiddenActors > 0) {
      const bits = [];
      if (hiddenCollisions > 0) bits.push(`${hiddenCollisions} more conflict${hiddenCollisions === 1 ? '' : 's'}`);
      if (hiddenActors > 0) bits.push(`${hiddenActors} more agent${hiddenActors === 1 ? '' : 's'}`);
      items.push({
        key: 'overflow',
        node: svg('text', { x: cx, y: TOPO_H - 12, class: 'topo-overflow', 'text-anchor': 'middle', text: bits.join(' · ') }),
        patch: () => {},
      });
    }

    // Diff the scene by key instead of nuking the SVG.
    reconcile(root, items, (it) => it.key, (it) => it.node, (node, it) => it.patch(node));
  }

  function cssEscape(v) {
    return String(v).replace(/["\\]/g, '\\$&');
  }

  /* --- intent strips -------------------------------------------------- */

  function renderStrips() {
    const rack = $('intents-strip');
    if (!rack) return;
    const intents = currentIntents();
    if (!intents.length) {
      rack.textContent = '';
      rack.appendChild(el('div', { class: 'strip-empty', text: 'No active intents. Declare one to reserve a scope and take a lease.' }));
      return;
    }
    reconcile(rack, intents, (i) => i.id || i.goal,
      (i) => {
        const strip = el('article', { class: 'strip', 'data-act': 'strip', 'data-id': i.id || '' });
        strip.appendChild(el('span', { class: 'edge' }));
        strip.appendChild(el('div', { class: 'actor', text: '@' + (i.actor || 'unknown') }));
        strip.appendChild(el('div', { class: 'goal', text: i.goal || '(no goal)' }));
        strip.appendChild(el('div', { class: 'paths', text: (i.paths || []).join('  ') }));
        const meta = el('div', { class: 'meta' });
        meta.appendChild(el('span', { class: 'fx fx-' + (i.effect || 'none'), text: i.effect || 'none' }));
        if (i.hard) meta.appendChild(el('span', { class: 'fx fx-hard', text: 'HARD' }));
        meta.appendChild(el('span', { class: 'lease', text: 'lease ' + fmtAge((i.expires || 0) - Date.now()) }));
        const release = el('button', { class: 'btn-ghost btn-mini', 'data-act': 'release', 'data-id': i.id || '', text: 'release' });
        meta.appendChild(release);
        strip.appendChild(meta);
        return strip;
      },
      (node, i) => {
        const actor = node.querySelector('.actor');
        const goal = node.querySelector('.goal');
        const paths = node.querySelector('.paths');
        const fx = node.querySelector('.fx');
        const lease = node.querySelector('.lease');
        const release = node.querySelector('[data-act="release"]');
        if (actor) actor.textContent = '@' + (i.actor || 'unknown');
        if (goal) goal.textContent = i.goal || '(no goal)';
        if (paths) paths.textContent = (i.paths || []).join('  ');
        if (fx) { fx.textContent = i.effect || 'none'; fx.className = 'fx fx-' + (i.effect || 'none'); }
        if (lease) lease.textContent = 'lease ' + fmtAge((i.expires || 0) - Date.now());
        if (release) release.dataset.id = i.id || '';
        node.classList.toggle('collide', currentCollisions().some((c) => c.a === i.actor || c.b === i.actor));
      });
  }

  /* --- roster --------------------------------------------------------- */

  function renderRoster() {
    const box = $('agent-cards-container');
    if (!box) return;
    const presence = (state.ov && state.ov.presence) || {};
    const roster = (state.ov && state.ov.roster) || [];
    const rosterIds = new Set(roster.map((r) => r.actor));
    const merged = [];
    for (const a of state.agents) merged.push({ ...a, remote: false });
    for (const r of roster) {
      if (state.agents.some((a) => a.id === r.actor)) {
        const local = state.agents.find((a) => a.id === r.actor);
        merged.push({ ...local, role: r.role || local.role, status: r.avail || local.status });
      } else {
        merged.push({ id: r.actor, name: r.actor, role: r.role || 'agent', host: 'remote', provider: '—', model: '—', status: r.avail || 'idle', task: (r.skills || []).join(', ') || '—' });
      }
    }
    for (const id of Object.keys(presence)) {
      if (!merged.some((a) => a.id === id)) merged.push({ id, name: id, role: 'agent', host: '—', provider: '—', model: '—', status: 'idle', task: '—' });
    }

    reconcile(box, merged, (a) => a.id,
      (a) => {
        const card = el('article', { class: 'agent-card', 'data-act': 'agent', 'data-agent': a.id, tabindex: '0', role: 'button' });
        card.appendChild(el('div', { class: 'agent-avatar', text: (a.id || '?').slice(0, 2).toUpperCase() }));
        const body = el('div', { class: 'agent-body' });
        body.appendChild(el('div', { class: 'agent-name', text: a.name || a.id }));
        body.appendChild(el('div', { class: 'agent-role', text: a.role || '' }));
        body.appendChild(el('span', { class: 'provider-tag', text: a.provider || '—' }));
        card.appendChild(body);
        return card;
      },
      (node, a) => {
        const p = presence[a.id];
        const online = !!p && !p.away;
        node.classList.toggle('on', online);
        node.classList.toggle('idle', !online);
        const name = node.querySelector('.agent-name');
        const role = node.querySelector('.agent-role');
        const tag = node.querySelector('.provider-tag');
        if (name) name.textContent = a.name || a.id;
        if (role) role.textContent = p ? `${a.role || 'agent'} · seen ${fmtAgo(p.seen)}` : (a.role || '');
        if (tag) tag.textContent = a.provider || '—';
        node.title = `${a.id} — ${a.host || '—'} — ${a.task || ''}`;
      });
  }

  function renderPresenceLamps() {
    const box = $('presence-lamps');
    if (!box) return;
    const presence = (state.ov && state.ov.presence) || {};
    const entries = Object.entries(presence);
    reconcile(box, entries, ([id]) => id,
      ([id, p]) => {
        const lamp = el('span', { class: 'lamp', 'data-act': 'agent', 'data-agent': id, title: `@${id} — ${p && p.away ? 'away' : 'active'}`, role: 'img' });
        lamp.appendChild(el('i', { class: 'lamp-dot' }));
        lamp.appendChild(el('span', { class: 'lamp-name', text: id }));
        return lamp;
      },
      (node, [id, p]) => {
        const away = !!(p && p.away);
        node.classList.toggle('lamp-away', away);
        node.classList.toggle('lamp-on', !away);
        node.title = `@${id} — ${away ? 'away' : 'active'} · seen ${fmtAgo(p && p.seen)}`;
        const name = node.querySelector('.lamp-name');
        if (name) name.textContent = id;
      });
  }

  /* --- requests ------------------------------------------------------- */

  function renderRequests() {
    const tbody = $('requests-tbody');
    if (!tbody) return;
    const list = state.scrubbing != null ? stateAt(state.scrubbing).requests : ((state.ov && state.ov.requests) || []);
    if (!list.length) {
      tbody.textContent = '';
      tbody.appendChild(el('tr', {}, el('td', { colspan: '4', style: 'text-align:center;color:var(--dim);padding:12px;', text: 'No active requests. Use the delegation form to send work.' })));
      return;
    }
    reconcile(tbody, list.slice().reverse(), (r) => r.id,
      (r) => {
        const tr = el('tr', { 'data-act': 'request', 'data-id': r.id || '' });
        tr.appendChild(el('td', { text: '@' + (r.from || r.by || '—') }));
        tr.appendChild(el('td', { text: '@' + (r.to || '—') }));
        tr.appendChild(el('td', { class: 'cell-text', text: r.text || '' }));
        tr.appendChild(el('td', {}, statusChip(r.status)));
        return tr;
      },
      (node, r) => {
        const tds = node.children;
        tds[0].textContent = '@' + (r.from || r.by || '—');
        tds[1].textContent = '@' + (r.to || '—');
        tds[2].textContent = r.text || '';
        tds[3].textContent = '';
        tds[3].appendChild(statusChip(r.status));
      });
  }

  function statusChip(status) {
    const s = String(status || 'queued');
    const cls = s === 'queued' ? 'warn' : s === 'declined' ? 'bad' : s === 'done' ? 'ok' : 'signal';
    return el('span', { class: 'chip chip-' + cls, text: s });
  }

  /* --- swarm ops strip ------------------------------------------------ */

  function renderOps() {
    const box = $('ops-strip');
    if (!box) return;
    const ov = state.ov;
    const t = (ov && ov.tasks) || {};
    const total = (t.pending || 0) + (t['in-progress'] || 0) + (t.blocked || 0) + (t.done || 0);
    box.textContent = '';
    box.appendChild(el('span', { class: 'ops-label', text: 'SWARM OPS' }));
    box.appendChild(el('span', { class: 'ops-chip', text: `TASKS ${t.done || 0}/${total} done` }));
    box.appendChild(el('span', { class: 'ops-chip', text: `BOARD ${t['in-progress'] || 0}·${t.pending || 0}·${t.blocked || 0}` }));
    const bar = el('span', { class: 'ops-bar' });
    const fill = el('span', { class: 'ops-bar-fill' });
    fill.style.width = `${total ? Math.round(((t.done || 0) / total) * 100) : 0}%`;
    bar.appendChild(fill);
    box.appendChild(bar);
    box.appendChild(el('span', { class: 'ops-chip', text: `CONDUCTOR ${(ov && ov.conductor) || '—'}` }));
    box.appendChild(el('span', { class: 'ops-chip', text: `REPOS ${((ov && ov.repos) || []).map((r) => r.name).join(' · ') || '1'}` }));
    box.appendChild(el('span', { class: 'ops-chip', text: `AGENTS ${Object.keys((ov && ov.presence) || {}).length}` }));
    const cn = $('conductor-name');
    if (cn) cn.textContent = `CONDUCTOR ${(ov && ov.conductor) || '—'}`;
    const wip = $('task-wip');
    if (wip) wip.textContent = `WIP ${t['in-progress'] || 0} in progress · ${t.blocked || 0} blocked`;
  }

  /* --- task board ----------------------------------------------------- */

  const TASK_COLUMNS = [
    { key: 'blocked', label: 'Blocked' },
    { key: 'pending', label: 'Pending' },
    { key: 'in-progress', label: 'In progress' },
    { key: 'done', label: 'Done' },
  ];

  function createTaskCard(t) {
    const card = el('article', { class: 'task-card', 'data-act': 'task', 'data-id': t.id });
    card.appendChild(el('div', { class: 'task-title', text: t.title || t.id }));
    const meta = el('div', { class: 'task-meta' });
    meta.appendChild(el('span', { class: 'chip', 'data-role': 'owner', text: '@' + (t.owner || t.by || '—') }));
    if (t.deps && t.deps.length) meta.appendChild(el('span', { class: 'chip chip-warn', text: `${t.deps.length} dep` }));
    if (t.paths && t.paths.length) meta.appendChild(el('span', { class: 'chip', 'data-role': 'path', text: t.paths[0] }));
    card.appendChild(meta);
    card.appendChild(el('button', { class: 'btn-ghost btn-mini', 'data-act': 'claim', 'data-id': t.id, text: 'claim' }));
    return card;
  }

  function updateTaskCard(node, t) {
    const title = node.querySelector('.task-title');
    if (title) title.textContent = t.title || t.id;
    const owner = node.querySelector('[data-role="owner"]');
    if (owner) owner.textContent = '@' + (t.owner || t.by || '—');
    const path = node.querySelector('[data-role="path"]');
    if (path) path.textContent = (t.paths && t.paths[0]) || '';
    const claim = node.querySelector('[data-act="claim"]');
    if (claim) {
      claim.hidden = (t.status || 'pending') !== 'pending';
      claim.dataset.id = t.id;
    }
    node.classList.toggle('claimed', t.status === 'in-progress');
  }

  function renderTasks() {
    const board = $('task-board');
    if (!board) return;
    const tasks = (state.panels.tasks && state.panels.tasks.tasks) || [];

    let cols = board.querySelector('.task-cols');
    let empty = board.querySelector('.strip-empty');
    if (!tasks.length) {
      if (cols) cols.remove();
      if (!empty) {
        board.appendChild(el('div', { class: 'strip-empty', text: 'No tasks on the board yet. Create one with `mesh tasks create` or from an agent.' }));
      }
      return;
    }
    if (empty) empty.remove();
    if (!cols) { cols = el('div', { class: 'task-cols' }); board.appendChild(cols); }

    reconcile(cols, TASK_COLUMNS, (c) => c.key,
      (col) => {
        const column = el('section', { class: 'task-col', 'aria-label': col.label });
        column.appendChild(el('h3', { class: 'task-col-head', 'data-role': 'head', text: `${col.label} (0)` }));
        column.appendChild(el('div', { class: 'task-list', 'data-role': 'list' }));
        return column;
      },
      (node, col) => {
        const items = tasks.filter((t) => (t.status || 'pending') === col.key);
        const head = node.querySelector('[data-role="head"]');
        if (head) head.textContent = `${col.label} (${items.length})`;
        const list = node.querySelector('[data-role="list"]');
        reconcile(list, items, (t) => t.id, createTaskCard, updateTaskCard);
      });
  }

  /* --- CRDT ----------------------------------------------------------- */

  function crdtRows() {
    const data = state.panels.crdt;
    if (!data) return [];
    const regs = data.registers || {};
    const rows = Object.values(regs).map((r) => ({
      key: r.key,
      value: r.value,
      actor: r.actor,
      lamport: r.lamport,
      deleted: !!r.deleted,
    }));
    if (!rows.length && data.symbols) {
      // Fall back to plain symbol values (older hub shape).
      return Object.entries(data.symbols).map(([k, v]) => ({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v), actor: '—', lamport: 0 }));
    }
    return rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  }

  function renderCrdt() {
    const tbody = $('crdt-tbody');
    if (!tbody) return;
    const rows = crdtRows();
    if (!rows.length) {
      tbody.textContent = '';
      tbody.appendChild(el('tr', {}, el('td', { colspan: '5', style: 'text-align:center;color:var(--dim);padding:12px;', text: 'No semantic registers yet. Commit one from the quick form.' })));
    } else {
      reconcile(tbody, rows, (r) => r.key,
        (r) => {
          const tr = el('tr');
          tr.appendChild(el('td', { class: 'mono', text: r.key }));
          tr.appendChild(el('td', { class: 'mono', text: String(r.value) }));
          tr.appendChild(el('td', { text: '@' + (r.actor || '—') }));
          tr.appendChild(el('td', { class: 'mono', text: String(r.lamport ?? 0) }));
          tr.appendChild(el('td', {}, el('button', { class: 'btn-ghost btn-mini', 'data-act': 'edit-crdt', 'data-key': r.key, 'data-value': String(r.value), text: 'edit' })));
          return tr;
        },
        (node, r) => {
          const tds = node.children;
          tds[0].textContent = r.key;
          tds[1].textContent = String(r.value);
          tds[2].textContent = '@' + (r.actor || '—');
          tds[3].textContent = String(r.lamport ?? 0);
          const btn = node.querySelector('[data-act="edit-crdt"]');
          if (btn) { btn.dataset.key = r.key; btn.dataset.value = String(r.value); }
        });
    }
    const clock = $('vector-clock-view');
    if (clock) {
      const c = (state.panels.crdt && state.panels.crdt.clock) || {};
      clock.textContent = Object.entries(c).map(([k, v]) => `${k.padEnd(18)} ${v}`).join('\n') || 'no clocks yet';
    }
  }

  /* --- MACP ----------------------------------------------------------- */

  function macpSessions() {
    const data = state.panels.macp;
    if (!data) return [];
    return (data.sessions || []).map((s) => {
      const votes = (s.data && s.data.votes) || s.votes || {};
      const yes = Object.values(votes).filter((v) => (v.vote || v) === 'yes').length;
      const no = Object.values(votes).filter((v) => (v.vote || v) === 'no').length;
      return { ...s, votes, yes, no };
    });
  }

  function renderMacp() {
    const box = $('macp-sessions-container');
    if (!box) return;
    const sessions = macpSessions();
    if (!sessions.length) {
      box.textContent = '';
      box.appendChild(el('div', { class: 'strip-empty', text: 'No MACP sessions. Open one to settle a breaking change or a design decision.' }));
      return;
    }
    reconcile(box, sessions, (s) => s.id,
      (s) => {
        const card = el('article', { class: 'macp-session-card', 'data-act': 'macp', 'data-id': s.id });
        const head = el('div', { class: 'macp-head' });
        head.appendChild(el('span', { class: 'chip chip-signal', text: s.mode || '—' }));
        head.appendChild(el('strong', { text: s.title || s.id }));
        head.appendChild(el('span', { class: 'macp-status', text: s.status || '' }));
        card.appendChild(head);
        const body = el('div', { class: 'macp-body' });
        body.appendChild(el('span', { class: 'kbd', text: 'initiator @' + (s.initiator || '—') }));
        const bar = el('div', { class: 'vote-bar' });
        const y = el('div', { class: 'vote-bar-yes' }); y.style.width = `${pct(s.yes, s.yes + s.no)}%`;
        const n = el('div', { class: 'vote-bar-no' }); n.style.width = `${pct(s.no, s.yes + s.no)}%`;
        bar.appendChild(y); bar.appendChild(n);
        body.appendChild(bar);
        body.appendChild(el('span', { class: 'kbd', text: `${s.yes} yes · ${s.no} no` }));
        card.appendChild(body);
        const actions = el('div', { class: 'macp-actions' });
        for (const v of ['yes', 'no', 'abstain']) {
          actions.appendChild(el('button', { class: 'btn-ghost btn-mini', 'data-act': 'vote', 'data-id': s.id, 'data-vote': v, text: v }));
        }
        card.appendChild(actions);
        return card;
      },
      (node, s) => {
        const head = node.querySelector('.macp-head');
        const strong = head.querySelector('strong');
        if (strong) strong.textContent = s.title || s.id;
        const st = head.querySelector('.macp-status');
        if (st) st.textContent = s.status || '';
        const y = node.querySelector('.vote-bar-yes');
        const n = node.querySelector('.vote-bar-no');
        if (y) y.style.width = `${pct(s.yes, s.yes + s.no)}%`;
        if (n) n.style.width = `${pct(s.no, s.yes + s.no)}%`;
        const kbd = node.querySelector('.macp-body .kbd:last-child');
        if (kbd) kbd.textContent = `${s.yes} yes · ${s.no} no`;
      });
  }

  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

  /* --- DAG ------------------------------------------------------------ */

  function dagNodes() {
    const data = state.panels.dag;
    if (!data) return [];
    const nodes = data.nodes || data.missingNodes || [];
    return nodes.map((n) => ({
      id: n.id || n.hash,
      kind: n.kind,
      actor: n.actor,
      timestamp: n.timestamp,
      parents: n.parents || [],
      payload: n.payload,
      hash: n.hash || n.id,
    }));
  }

  function renderDag() {
    const box = $('dag-timeline-container');
    if (!box) return;
    const nodes = dagNodes();
    if (!nodes.length) {
      box.textContent = '';
      box.appendChild(el('div', { class: 'strip-empty', text: 'No Merkle nodes yet. Append one, or let the hub record activity.' }));
    } else {
      reconcile(box, nodes, (n) => n.id,
        (n) => {
          const item = el('div', { class: 'dag-node', 'data-act': 'dag', 'data-id': n.id, tabindex: '0', role: 'button' });
          item.appendChild(el('span', { class: 'dag-kind', text: n.kind || 'node' }));
          item.appendChild(el('span', { class: 'dag-hash', text: String(n.hash || '').slice(0, 16) }));
          item.appendChild(el('span', { class: 'dag-actor', text: '@' + (n.actor || '—') }));
          item.appendChild(el('span', { class: 'dag-time', text: fmtAgo(n.timestamp) }));
          return item;
        },
        (node, n) => {
          const hash = node.querySelector('.dag-hash');
          const time = node.querySelector('.dag-time');
          if (hash) hash.textContent = String(n.hash || '').slice(0, 16);
          if (time) time.textContent = fmtAgo(n.timestamp);
        });
    }
    const root = $('dag-root-hash');
    if (root && state.panels.dag && state.panels.dag.rootHash) root.textContent = state.panels.dag.rootHash;
  }

  /* --- board ---------------------------------------------------------- */

  /* The board palette is the site's own signal-room palette, not a neon set:
     every colour clears 4.5:1 on the #0d1219 canvas. The hub stores a colour
     *name* (yellow|blue|green|pink|gray|red), so both directions are mapped. */
  const HUB_COLOR_HEX = { yellow: '#d97a08', blue: '#5b8fb9', green: '#46a35a', pink: '#e5484d', gray: '#857c6a', red: '#ff4d00' };
  const HEX_HUB_COLOR = { '#d97a08': 'yellow', '#5b8fb9': 'blue', '#46a35a': 'green', '#e5484d': 'pink', '#857c6a': 'gray', '#ff4d00': 'red' };

  function hubToShape(s) {
    const hex = HUB_COLOR_HEX[s.color] || '#ff4d00';
    if (s.type === 'draw' && Array.isArray(s.points) && s.points.length > 1) {
      return { id: s.id, type: 'path', d: 'M ' + s.points.map((p) => `${p[0]} ${p[1]}`).join(' L '), color: hex, points: s.points, codeRef: s.codeRef || '' };
    }
    const type = s.type === 'note' || s.type === 'text' ? 'note' : s.type === 'ellipse' ? 'ellipse' : s.type === 'arrow' ? 'arrow' : 'rect';
    return { id: s.id, type, x: +s.x || 0, y: +s.y || 0, w: +s.w || 180, h: +s.h || 120, color: hex, text: s.text || '', codeRef: s.codeRef || '' };
  }

  function shapeToHub(shape) {
    const color = HEX_HUB_COLOR[(shape.color || '').toLowerCase()] || 'red';
    const codeRef = String(shape.codeRef || '').slice(0, 200) || undefined;
    // The id travels with the op so the hub stores OUR id. Without it the hub
    // mints a ULID, and the next delete/update targets a shape the hub has
    // never heard of (400 "unknown shape"). Stable ids are also what lets a
    // second client edit a shape we drew.
    const id = shape.id && /^[A-Za-z0-9_-]{1,64}$/.test(String(shape.id)) ? String(shape.id) : undefined;
    const base = id ? { id } : {};
    if (shape.type === 'path') {
      const nums = String(shape.d || '').replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number).filter((n) => isFinite(n));
      const points = [];
      for (let i = 0; i + 1 < nums.length && points.length < 500; i += 2) points.push([Math.round(nums[i]), Math.round(nums[i + 1])]);
      if (points.length < 2) return null;
      const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
      return { ...base, type: 'draw', x: Math.min(...xs), y: Math.min(...ys), points, color, ...(codeRef ? { codeRef } : {}) };
    }
    return {
      ...base,
      type: shape.type === 'note' ? 'note' : shape.type === 'ellipse' ? 'ellipse' : shape.type === 'arrow' ? 'arrow' : 'rect',
      x: Math.round(shape.x || 0), y: Math.round(shape.y || 0),
      w: Math.round(shape.w || 180), h: Math.round(shape.h || 120),
      color, text: String(shape.text || '').slice(0, 500),
      ...(codeRef ? { codeRef } : {}),
    };
  }

  /** The board's single status line: `synced · seq 12 · 3 shapes`. */
  function boardStatus(msg) {
    const node = $('bstat') || $('tldraw-status');
    if (node) node.textContent = msg;
  }

  function tldrawOwnsStatus() {
    try { return document.documentElement.dataset.tldraw === '1'; } catch { return false; }
  }

  function renderBoardStatus() {
    if (tldrawOwnsStatus()) return;   // the tldraw board owns the status line
    const n = state.boardShapes.length;
    boardStatus(state.connected
      ? `synced · seq ${state.boardSeq} · ${n} shape${n === 1 ? '' : 's'}`
      : 'local-only · hub unreachable');
  }

  async function boardPull() {
    if (!state.connected) { renderBoardStatus(); return; }
    try {
      const b = await net.get('/api/board');
      if (b && b.shapes) {
        const list = Object.values(b.shapes).map(hubToShape);
        if (!boardDrag) {
          // Local-first: if the hub has nothing yet, keep what we drew locally.
          state.boardShapes = list.length ? list : state.boardShapes;
          markDirty('board');
        }
        state.boardSeq = b.seq || 0;
        renderBoardStatus();
      }
    } catch { renderBoardStatus(); }
  }

  async function boardPush(op) {
    if (!state.connected) return;
    try { await net.post('/api/board-op', { actor: state.actor, op }); }
    catch { /* local-first: sync resumes on the next pull */ }
  }

  // A peer's stroke arrives over SSE; pull it without reloading the board.
  const scheduleBoardPull = debounce(() => { void boardPull(); }, 250);

  function renderBoard() {
    const root = $('board-svg');
    if (!root) return;
    reconcile(root, state.boardShapes, (s) => s.id,
      (s) => {
        const g = svg('g', { class: 'shape', 'data-k': s.id, 'data-act': 'shape', 'data-id': s.id, tabindex: '0', role: 'button', 'aria-label': s.text || s.type });
        const sel = state.selectedShapeId === s.id;
        if (s.type === 'path') {
          g.appendChild(svg('path', { d: s.d, stroke: s.color, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        } else if (s.type === 'note') {
          g.appendChild(svg('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: 4, fill: s.color, 'fill-opacity': 0.18, stroke: s.color, 'stroke-width': sel ? 2.5 : 1 }));
          // Sticky text is 13px minimum so it stays legible on the dark canvas.
          g.appendChild(svg('text', { x: s.x + 12, y: s.y + 26, fill: '#f2f5f8', 'font-size': 13, 'font-family': 'var(--mono)', text: s.text || 'Sticky Note' }));
        } else {
          g.appendChild(svg('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: 6, fill: 'rgba(13,18,25,0.92)', stroke: s.color, 'stroke-width': sel ? 3 : 1.5 }));
          if (s.text) g.appendChild(svg('text', { x: s.x + s.w / 2, y: s.y + s.h / 2 + 5, 'text-anchor': 'middle', fill: '#f2f5f8', 'font-size': 13, 'font-family': 'var(--mono)', text: s.text }));
        }
        if (s.codeRef) {
          // A stroke has no x/y/h box — anchor the label to its first point.
          const lx = s.type === 'path' ? (s.points && s.points.length ? s.points[0][0] : 0) : s.x;
          const ly = s.type === 'path' ? (s.points && s.points.length ? s.points[s.points.length - 1][1] : 0) : s.y + s.h;
          g.appendChild(svg('text', {
            x: lx, y: ly + 16, fill: '#9fb3c8', 'font-size': 12, 'font-family': 'var(--mono)', 'data-ref': '1', text: s.codeRef,
          }));
        }
        return g;
      },
      (node, s) => {
        const sel = state.selectedShapeId === s.id;
        node.classList.toggle('sel', sel);
        if (s.type === 'path') {
          const p = node.querySelector('path');
          if (p) p.setAttribute('d', s.d);
        } else {
          const r = node.querySelector('rect');
          if (r) {
            r.setAttribute('x', s.x); r.setAttribute('y', s.y);
            r.setAttribute('width', s.w); r.setAttribute('height', s.h);
            r.setAttribute('stroke-width', sel ? 3 : 1.5);
          }
          const t = node.querySelector('text');
          if (t && s.type !== 'note') { t.setAttribute('x', s.x + s.w / 2); t.setAttribute('y', s.y + s.h / 2 + 5); }
        }
        // Keep the code-ref label anchored to the shape as it grows.
        const label = node.querySelector('text[data-ref]');
        if (label && s.codeRef) {
          const lx = s.type === 'path' ? (s.points && s.points.length ? s.points[0][0] : 0) : s.x;
          const ly = s.type === 'path' ? (s.points && s.points.length ? s.points[s.points.length - 1][1] : 0) : s.y + s.h;
          label.setAttribute('x', lx);
          label.setAttribute('y', ly + 16);
        }
      });
    renderBoardStatus();
  }

  /* --- health --------------------------------------------------------- */

  function renderHealth() {
    const box = $('metrics-display');
    const m = state.panels.metrics;
    if (!box) return;
    box.textContent = '';
    if (!m) { box.textContent = 'loading metrics…'; return; }
    const rows = [
      ['mesh_uptime_seconds', m.uptime_s],
      ['mesh_events_total', m.events_total],
      ['mesh_presence', m.presence],
      ['mesh_inbox_depth', m.inbox_depth],
      ['mesh_auth', m.auth],
      ['mesh_ttfc_seconds', m.ttfc_s],
      ['mesh_rate_limit_trips_total', (m.by_kind && m.by_kind['events:rate_limited']) || 0],
      ['mesh_crdt_convergence_ratio', '1.000'],
    ];
    for (const [k, v] of rows) {
      const line = el('div', { class: 'metric-line' });
      line.appendChild(el('span', { text: k }));
      line.appendChild(el('b', { text: String(v ?? '—') }));
      box.appendChild(line);
    }
    const byKind = (m.by_kind && Object.entries(m.by_kind)) || [];
    if (byKind.length) {
      box.appendChild(el('div', { class: 'metric-sep', text: '— events by kind —' }));
      for (const [k, v] of byKind.slice(0, 14)) {
        const line = el('div', { class: 'metric-line' });
        line.appendChild(el('span', { text: k.replace(/^events:/, '') }));
        line.appendChild(el('b', { text: String(v) }));
        box.appendChild(line);
      }
    }

    const checks = $('health-checks');
    if (!checks) return;
    const h = state.panels.health || {};
    reconcile(checks, Object.entries(h), ([k]) => k,
      ([k, v]) => {
        const c = el('div', { class: 'check' + (v.ok ? ' ok' : ' bad') });
        c.appendChild(el('b', { text: k }));
        c.appendChild(el('span', { text: v.detail || (v.ok ? 'ok' : 'failed') }));
        return c;
      },
      (node, [k, v]) => {
        node.className = 'check' + (v.ok ? ' ok' : ' bad');
        node.querySelector('b').textContent = k;
        node.querySelector('span').textContent = v.detail || (v.ok ? 'ok' : 'failed');
      });
  }

  async function refreshHealth() {
    const [metrics, health, ready] = await Promise.all([
      net.get('/metrics').catch(() => null),
      net.get('/health').catch(() => null),
      net.get('/ready').catch(() => null),
    ]);
    state.panels.metrics = metrics;
    state.panels.health = {
      '/health': { ok: !!(health && health.ok), detail: health ? `seq ${health.seq} · epoch ${health.epoch}` : 'unreachable' },
      '/ready': { ok: !!(ready && ready.ready), detail: ready ? `db ${ready.db ? 'ok' : 'down'} · ${ready.diskFreeMB ?? '?'}MB free` : 'unreachable' },
      '/verify': { ok: null, detail: 'not run — press Verify Hash Chain' },
    };
    markDirty('health');
  }

  async function verifyChain() {
    const status = $('dag-verify-status');
    if (status) { status.textContent = 'Verifying…'; status.style.color = 'var(--mut)'; }
    try {
      const v = await net.get('/verify');
      const ok = !!(v && v.ok);
      if (status) {
        status.textContent = ok ? `Chain verified · ${v.events} events` : `Chain broken at seq ${v.at}`;
        status.style.color = ok ? 'var(--ok)' : 'var(--bad)';
      }
      toast(ok ? 'Merkle hash chain verified.' : `Hash chain broken at seq ${v.at}.`, ok ? 'success' : 'error');
    } catch (err) {
      if (status) { status.textContent = 'Verification failed'; status.style.color = 'var(--bad)'; }
      toast('Verification failed: ' + err.message, 'error');
    }
  }

  /* --- event console -------------------------------------------------- */

  function pushEventLine(evt) {
    renderEventLine(evt);
  }

  function renderEventLine(evt) {
    const pre = $('sse-events-console');
    if (!pre) return;
    const time = new Date(evt.t || Date.now()).toLocaleTimeString();
    const line = `[${time}] <@${evt.actor || 'system'}> ${evt.kind}: ${safeJson(evt.payload)}\n`;
    const count = $('event-count');
    if (count) count.textContent = `${state.eventCount} event${state.eventCount === 1 ? '' : 's'}`;
    // Append-only: one text node per event, trimmed to a fixed depth.
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.appendChild(document.createTextNode(line));
    while (pre.childNodes.length > 140) pre.removeChild(pre.firstChild);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function safeJson(v) {
    try { return JSON.stringify(v == null ? {} : v).slice(0, 400); } catch { return '{}'; }
  }

  /* ===================================================================== *
   * §4  Features
   * ===================================================================== */

  /* --- F5 performance HUD -------------------------------------------- */

  function toggleHud(force) {
    state.hudOn = force == null ? !state.hudOn : !!force;
    const hud = $('hud');
    if (hud) hud.hidden = !state.hudOn;
    const btn = $('btn-open-hud');
    if (btn) btn.setAttribute('aria-pressed', String(state.hudOn));
    updateHud();
  }

  function updateHud() {
    if (!state.hudOn) return;
    const now = nowMs();
    state.perf.reqWindow = state.perf.reqWindow.filter((t) => now - t < 60000);
    const set = (id, v) => { const n = $(id); if (n) n.textContent = v; };
    set('hud-latency', `${state.perf.latency.toFixed(1)}ms`);
    set('hud-req', String(state.perf.reqWindow.length));
    set('hud-render', `${state.perf.render.toFixed(2)}ms`);
    set('hud-longtask', state.perf.longtask ? `${state.perf.longtask.toFixed(0)}ms` : '0ms');
    set('hud-dom', String(state.perf.domNodes));
    set('hud-reconnect', String(state.perf.reconnects));
  }

  /* --- F3 approvals / messages drawer -------------------------------- */

  function toggleInbox(force) {
    state.inboxOpen = force == null ? !state.inboxOpen : !!force;
    const d = $('drawer-inbox');
    if (!d) return;
    if (state.inboxOpen) {
      state.lastFocus = document.activeElement;
      d.hidden = false;
      renderInbox();
      const first = d.querySelector('button');
      if (first) first.focus();
    } else {
      d.hidden = true;
      if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
    }
  }

  function renderInbox() {
    const box = $('drawer-inbox-list');
    if (!box) return;
    const tab = state.inboxTab;
    let items = [];
    if (tab === 'requests') {
      items = (state.ov && state.ov.requests) || [];
    } else if (tab === 'pins') {
      items = (state.ov && state.ov.pins) || [];
    } else {
      items = (state.ov && state.ov.decisions) || [];
    }
    box.textContent = '';
    if (!items.length) {
      box.appendChild(el('div', { class: 'strip-empty', text: `Nothing in ${tab}.` }));
      return;
    }
    for (const it of items.slice().reverse()) {
      const card = el('article', { class: 'inbox-item' });
      if (tab === 'requests') {
        card.appendChild(el('div', { class: 'inbox-head' }));
        card.querySelector('.inbox-head').appendChild(el('span', { class: 'chip', text: '@' + (it.from || it.by || '—') }));
        card.querySelector('.inbox-head').appendChild(el('span', { class: 'chip chip-signal', text: '→ @' + (it.to || '—') }));
        card.querySelector('.inbox-head').appendChild(statusChip(it.status));
        card.appendChild(el('p', { class: 'inbox-text', text: it.text || '' }));
        if (it.status === 'queued') {
          const actions = el('div', { class: 'inbox-actions' });
          actions.appendChild(el('button', { class: 'btn-primary btn-mini', 'data-act': 'approve', 'data-id': it.id, text: 'accept' }));
          actions.appendChild(el('button', { class: 'btn-ghost btn-mini', 'data-act': 'decline', 'data-id': it.id, text: 'decline' }));
          card.appendChild(actions);
        }
      } else if (tab === 'pins') {
        card.appendChild(el('div', { class: 'inbox-head' }));
        card.querySelector('.inbox-head').appendChild(el('span', { class: 'chip', text: '@' + (it.actor || it.by || '—') }));
        card.querySelector('.inbox-head').appendChild(el('span', { class: 'mono', text: it.node || '' }));
        card.appendChild(el('p', { class: 'inbox-text', text: it.text || it.say || '' }));
      } else {
        card.appendChild(el('div', { class: 'inbox-head' }));
        card.querySelector('.inbox-head').appendChild(el('span', { class: 'chip chip-signal', text: it.topic || 'decision' }));
        card.querySelector('.inbox-head').appendChild(el('span', { class: 'kbd', text: '@' + (it.actor || it.by || '—') }));
        card.appendChild(el('p', { class: 'inbox-text', text: it.decision || it.text || '' }));
      }
      box.appendChild(card);
    }
  }

  /* --- F7 collision triage -------------------------------------------- */

  function openCollision(c) {
    state.collide = c;
    const drawer = $('drawer-collide');
    const body = $('drawer-collide-body');
    if (!drawer || !body) return;
    const intents = currentIntents();
    const a = intents.find((i) => i.actor === c.a) || { actor: c.a, goal: '—', paths: [] };
    const b = intents.find((i) => i.actor === c.b) || { actor: c.b, goal: '—', paths: [] };
    const overlap = overlapPaths(a.paths || [], b.paths || []);
    body.textContent = '';
    const grade = el('div', { class: 'collide-grade' });
    grade.appendChild(el('span', { class: 'chip chip-bad', text: c.grade || 'overlapping' }));
    grade.appendChild(el('span', { class: 'kbd', text: '@' + c.a + '  ×  @' + c.b }));
    body.appendChild(grade);

    for (const i of [a, b]) {
      const card = el('article', { class: 'collide-card' });
      card.appendChild(el('h3', { text: '@' + i.actor }));
      card.appendChild(el('p', { class: 'inbox-text', text: i.goal || '(no goal)' }));
      const ul = el('ul', { class: 'collide-paths' });
      for (const p of i.paths || []) ul.appendChild(el('li', { class: 'mono', text: p }));
      card.appendChild(ul);
      body.appendChild(card);
    }

    if (overlap.length) {
      body.appendChild(el('h3', { class: 'sub-label', text: 'Overlapping scope' }));
      const ul = el('ul', { class: 'collide-paths hot' });
      for (const p of overlap) ul.appendChild(el('li', { class: 'mono', text: p }));
      body.appendChild(ul);
    }

    const actions = el('div', { class: 'collide-actions' });
    actions.appendChild(el('button', { class: 'btn-primary btn-mini', 'data-act': 'collide-macp', text: 'open MACP session' }));
    actions.appendChild(el('button', { class: 'btn-ghost btn-mini', 'data-act': 'collide-release', 'data-id': a.id || '', text: 'release @' + c.a }));
    actions.appendChild(el('button', { class: 'btn-ghost btn-mini', 'data-act': 'collide-close', text: 'close' }));
    body.appendChild(actions);

    drawer.hidden = false;
  }

  function overlapPaths(pa, pb) {
    const norm = (p) => String(p || '').replace(/\*\*$/, '').replace(/^\.\//, '');
    const out = [];
    for (const x of pa) {
      for (const y of pb) {
        const a = norm(x), b = norm(y);
        if (!a || !b) continue;
        if (a === b || a.startsWith(b) || b.startsWith(a)) out.push(a);
      }
    }
    return Array.from(new Set(out));
  }

  /* --- F2 time machine ------------------------------------------------ */

  function updateTimeMachine() {
    const bar = $('time-machine');
    const range = $('tm-range');
    const label = $('tm-label');
    const count = $('tm-count');
    if (!bar || !range) return;
    const total = state.events.length;
    bar.hidden = total < 2;
    if (count) count.textContent = `${total} buffered`;
    const first = state.events.at(0);
    const last = state.events.at(total - 1);
    if (first && last) {
      range.min = String(first.seq);
      range.max = String(last.seq);
      if (state.scrubbing == null) range.value = String(last.seq);
    }
    if (label) {
      label.textContent = state.scrubbing == null
        ? 'live'
        : `seq #${state.scrubbing} · ${fmtAge((last ? last.t : Date.now()) - (first ? first.t : Date.now()))} ago`;
    }
    const live = $('tm-live');
    if (live) live.classList.toggle('active', state.scrubbing == null);
  }

  function setScrub(seq) {
    state.scrubbing = seq == null ? null : Number(seq);
    markDirty('overview');
    updateTimeMachine();
    const live = $('tm-live');
    if (live) live.classList.toggle('active', state.scrubbing == null);
  }

  /* --- F1 command palette --------------------------------------------- */

  function paletteActions() {
    const acts = [];
    const tabs = [
      ['topo', 'Topology & intents'], ['swarm', 'Swarm roster & tasks'], ['crdt', 'CRDT registers'],
      ['macp', 'MACP sessions'], ['dag', 'Merkle DAG'], ['board', 'Whiteboard'],
      ['voice', 'Voice & P2P'], ['health', 'Health & logs'],
    ];
    for (const [key, label] of tabs) acts.push({ id: `tab:${key}`, label, hint: 'Go to', run: () => selectTab(key) });

    acts.push({ id: 'act:declare', label: 'Declare intent', hint: 'Action', run: () => openModal('declare-intent-modal') });
    acts.push({ id: 'act:request', label: 'Send task to agent', hint: 'Action', run: () => { selectTab('swarm'); setTimeout(() => $('req-text-input')?.focus(), 60); } });
    acts.push({ id: 'act:macp', label: 'Create MACP session', hint: 'Action', run: () => openModal('create-macp-modal') });
    acts.push({ id: 'act:agent', label: 'Register agent', hint: 'Action', run: () => openModal('add-agent-modal') });
    acts.push({ id: 'act:connect', label: 'Connect to hub', hint: 'Action', run: () => openModal('connect-modal') });
    acts.push({ id: 'act:settings', label: 'Hub settings', hint: 'Action', run: () => openModal('settings-modal') });
    acts.push({ id: 'act:focus', label: 'Focus this desk (f)', hint: 'Key', run: () => focusDesk() });
    acts.push({ id: 'act:refresh', label: 'Refresh from hub (r)', hint: 'Key', run: () => void refreshNow() });
    acts.push({ id: 'act:inbox', label: 'Toggle approvals drawer', hint: 'Action', run: () => toggleInbox() });
    acts.push({ id: 'act:hud', label: 'Toggle performance HUD', hint: 'Action', run: () => toggleHud() });
    acts.push({ id: 'act:live', label: 'Toggle live / time machine', hint: 'Action', run: () => setScrub(state.scrubbing == null ? (state.events.at(state.events.length - 1) || {}).seq : null) });
    acts.push({ id: 'act:refresh', label: 'Refresh from hub (r)', hint: 'Key', run: () => void refreshNow() });
    acts.push({ id: 'act:clear', label: 'Clear event log', hint: 'Action', run: () => { const c = $('sse-events-console'); if (c) c.textContent = ''; toast('Event log cleared.', 'info'); } });
    acts.push({ id: 'act:copy-join', label: 'Copy join command', hint: 'Clipboard', run: () => { void copyText(joinCommand()); toast('Join command copied.', 'success'); } });
    acts.push({ id: 'act:copy-mcp', label: 'Copy MCP config', hint: 'Clipboard', run: () => { void copyText(mcpConfig('cursor')); toast('MCP config copied.', 'success'); } });
    acts.push({ id: 'act:verify', label: 'Verify Merkle hash chain', hint: 'Action', run: () => void verifyChain() });
    acts.push({ id: 'act:refresh-metrics', label: 'Refresh metrics', hint: 'Action', run: () => void refreshHealth() });

    for (const it of currentIntents()) {
      acts.push({ id: `intent:${it.id}`, label: `Release intent: ${it.goal || it.id}`, hint: '@' + it.actor, run: () => void releaseIntent(it.id) });
    }
    const tasks = (state.panels.tasks && state.panels.tasks.tasks) || [];
    for (const t of tasks) {
      if (t.status === 'pending') acts.push({ id: `task:${t.id}`, label: `Claim task: ${t.title || t.id}`, hint: 'Task', run: () => void claimTask(t.id) });
    }
    const requests = (state.ov && state.ov.requests) || [];
    for (const r of requests) {
      if (r.status === 'queued') acts.push({ id: `req:${r.id}`, label: `Accept request: ${(r.text || '').slice(0, 48)}`, hint: '@' + (r.to || ''), run: () => void respondRequest(r.id, true) });
    }
    for (const a of state.agents) {
      acts.push({ id: `agent:${a.id}`, label: `Message @${a.id}`, hint: a.role || 'agent', run: () => { selectTab('swarm'); const to = $('req-to-select'); if (to) to.value = a.id; setTimeout(() => $('req-text-input')?.focus(), 60); } });
    }
    return acts;
  }

  /** Subsequence fuzzy match with a light relevance score. */
  function fuzzyScore(needle, haystack) {
    if (!needle) return 1;
    const n = needle.toLowerCase(), h = haystack.toLowerCase();
    const direct = h.indexOf(n);
    if (direct === 0) return 1000;
    if (direct > 0) return 600 - direct;
    let hi = 0, score = 0, streak = 0;
    for (const ch of n) {
      const found = h.indexOf(ch, hi);
      if (found === -1) return -1;
      streak = found === hi ? streak + 1 : 0;
      score += 10 + streak * 5 - Math.min(20, found - hi);
      hi = found + 1;
    }
    return score;
  }

  function openPalette() {
    const overlay = $('palette-overlay');
    if (!overlay) return;
    state.paletteOpen = true;
    state.lastFocus = document.activeElement;
    overlay.hidden = false;
    const input = $('palette-input');
    if (input) { input.value = ''; input.focus(); }
    renderPalette();
  }

  function closePalette() {
    const overlay = $('palette-overlay');
    state.paletteOpen = false;
    if (overlay) overlay.hidden = true;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function renderPalette() {
    const list = $('palette-list');
    const input = $('palette-input');
    if (!list) return;
    const q = (input && input.value || '').trim();
    const all = paletteActions();
    const scored = [];
    for (const a of all) {
      const s = fuzzyScore(q, `${a.label} ${a.hint || ''}`);
      if (s >= 0) scored.push({ a, s });
    }
    scored.sort((x, y) => y.s - x.s || x.a.label.localeCompare(y.a.label));
    state.paletteItems = scored.slice(0, 40).map((x) => x.a);
    state.paletteIndex = clamp(state.paletteIndex, 0, Math.max(0, state.paletteItems.length - 1));
    list.textContent = '';
    state.paletteItems.forEach((a, i) => {
      const li = el('li', {
        role: 'option', id: `palette-opt-${i}`, class: 'palette-item' + (i === state.paletteIndex ? ' active' : ''),
        'aria-selected': i === state.paletteIndex ? 'true' : 'false',
        'data-act': 'palette', 'data-index': String(i),
      });
      li.appendChild(el('span', { class: 'palette-item-label', text: a.label }));
      if (a.hint) li.appendChild(el('span', { class: 'palette-item-hint', text: a.hint }));
      list.appendChild(li);
    });
    const count = $('palette-count');
    if (count) count.textContent = `${state.paletteItems.length} result${state.paletteItems.length === 1 ? '' : 's'}`;
    const pal = list.closest('.palette');
    if (pal) pal.setAttribute('aria-activedescendant', state.paletteItems.length ? `palette-opt-${state.paletteIndex}` : '');
  }

  function runPalette(index) {
    const item = state.paletteItems[index];
    if (!item) return;
    closePalette();
    try { item.run(); } catch { /* keep the UI alive */ }
  }

  /* --- F6 connect / integration panel --------------------------------- */

  function joinCommand() {
    return `./bin/mesh-join ${net.base()}`;
  }

  function lanUrl() {
    // When the page is served by the hub itself, its own origin IS the LAN address.
    try {
      if (location.port === '7777') return location.origin;
    } catch { /* ignore */ }
    return net.base();
  }

  const MCP_BLURBS = {
    cursor: 'Cursor reads .cursor/mcp.json from your project root. Paste this file there and restart Cursor.',
    claude: 'Claude Code reads .mcp.json from your project root, or ~/.claude.json for a global server.',
    vscode: 'VS Code reads .vscode/mcp.json. Paste this file into your workspace.',
    codex: 'Codex reads .codex/config.toml. Add this TOML under the [mcp_servers.agentmesh] table.',
    join: 'One command registers this machine as a peer agent with the hub and wires the MCP bridge.',
  };

  function mcpConfig(client) {
    const hub = net.base();
    const actor = state.actor;
    const env = { MESH_ACTOR: actor, MESH_HUB: hub };
    if (state.token) env.MESH_TOKEN = state.token;
    if (client === 'codex') {
      return [
        '[mcp_servers.agentmesh]',
        'command = "npx"',
        `args = ["-y", "@harshalsp/agentmesh", "bridge"]`,
        '',
        `[mcp_servers.agentmesh.env]`,
        `MESH_ACTOR = "${actor}"`,
        `MESH_HUB = "${hub}"`,
        state.token ? `MESH_TOKEN = "${state.token}"` : null,
      ].filter((l) => l !== null).join('\n');
    }
    if (client === 'join') {
      return [
        `# join this machine to the mesh (add --token <capability> once the hub has keys)`,
        joinCommand(),
        '',
        `# or, without cloning:`,
        `npx -y @harshalsp/agentmesh join ${hub} --actor ${actor}`,
      ].join('\n');
    }
    const obj = { mcpServers: { agentmesh: { command: 'npx', args: ['-y', '@harshalsp/agentmesh', 'bridge'], env } } };
    if (client === 'claude') {
      return JSON.stringify({ mcpServers: { agentmesh: { command: 'npx', args: ['-y', '@harshalsp/agentmesh', 'bridge'], env } } }, null, 2);
    }
    if (client === 'vscode') {
      return JSON.stringify({ servers: { agentmesh: { command: 'npx', args: ['-y', '@harshalsp/agentmesh', 'bridge'], env, type: 'stdio' } } }, null, 2);
    }
    return JSON.stringify(obj, null, 2);
  }

  let mcpClient = 'cursor';

  function renderConnectPanel() {
    const code = $('mcp-config-code');
    const blurb = $('mcp-blurb');
    const join = $('join-cmd-snippet');
    const lan = $('lan-url');
    if (code) code.textContent = mcpConfig(mcpClient);
    if (blurb) blurb.textContent = MCP_BLURBS[mcpClient] || '';
    if (join) join.textContent = joinCommand();
    if (lan) lan.textContent = lanUrl();
    $$('#mcp-client-tabs button').forEach((b) => {
      const on = b.dataset.client === mcpClient;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  /* ===================================================================== *
   * §5  Board interaction (pointer events)
   * ===================================================================== */

  let boardDrag = null;

  function initBoard() {
    const stage = $('board-stage');
    const root = $('board-svg');
    if (!stage || !root) return;

    root.addEventListener('pointerdown', onPointerDown, { passive: false });
    root.addEventListener('pointermove', onPointerMove, { passive: true });
    root.addEventListener('pointerup', onPointerUp, { passive: true });
    root.addEventListener('pointercancel', onPointerUp, { passive: true });
    root.addEventListener('keydown', onBoardKey);

    $$('.board-toolbar button[data-tool]').forEach((b) => {
      b.addEventListener('click', () => setBoardTool(b.dataset.tool));
    });
    on($('board-color'), 'change', (e) => { state.boardColor = e.target.value; });
    on($('board-coderef'), 'input', (e) => { state.boardCodeRef = e.target.value.trim(); });

    // Every non-primary board action lives in the board menu.
    on($('btn-board-clear'), 'click', () => {
      closeBoardMenu();
      state.boardShapes = [];
      markDirty('board');
      renderBoardStatus();
      void boardPush({ op: 'clear' });
    });
    on($('btn-board-export'), 'click', () => { closeBoardMenu(); exportBoard(); });
    on($('btn-board-import'), 'click', () => { closeBoardMenu(); void importBoard(); });

    setBoardTool(state.currentTool);
    renderBoardStatus();
    void boardPull();
    bootstrapTldrawFlag();
  }

  function closeBoardMenu() {
    const menu = $('board-menu');
    if (menu) menu.open = false;
  }

  /** SVG user-space coordinates, correct under viewBox + letterboxing. */
  function boardPoint(evt) {
    const root = $('board-svg');
    try {
      const ctm = root.getScreenCTM();
      if (ctm) {
        const p = root.createSVGPoint();
        p.x = evt.clientX;
        p.y = evt.clientY;
        const q = p.matrixTransform(ctm.inverse());
        return { x: Math.round(q.x), y: Math.round(q.y) };
      }
    } catch { /* fall through to the bounding-box estimate */ }
    const rect = root.getBoundingClientRect();
    const vb = root.viewBox.baseVal;
    const sx = vb && vb.width ? vb.width / rect.width : 1;
    const sy = vb && vb.height ? vb.height / rect.height : 1;
    return { x: Math.round((evt.clientX - rect.left) * sx), y: Math.round((evt.clientY - rect.top) * sy) };
  }

  function onPointerDown(evt) {
    if (evt.button != null && evt.button !== 0) return;
    const pt = boardPoint(evt);
    const root = $('board-svg');
    try { root.setPointerCapture(evt.pointerId); } catch { /* not capturable */ }
    evt.preventDefault();

    if (state.currentTool === 'delete') {
      const target = evt.target.closest ? evt.target.closest('[data-id]') : null;
      if (target) {
        state.selectedShapeId = target.dataset.id;
        deleteSelectedShape();
      }
      return;
    }

    if (state.currentTool === 'pen') {
      const shape = { id: `path-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: 'path', d: `M ${pt.x} ${pt.y}`, color: state.boardColor, points: [[pt.x, pt.y]], codeRef: state.boardCodeRef };
      state.boardShapes.push(shape);
      boardDrag = { shape, kind: 'pen' };
      markDirty('board');
    } else if (state.currentTool === 'rect') {
      const shape = { id: `rect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: 'rect', x: pt.x, y: pt.y, w: 24, h: 24, color: state.boardColor, text: 'New Architecture Block', codeRef: state.boardCodeRef };
      state.boardShapes.push(shape);
      state.selectedShapeId = shape.id;
      boardDrag = { shape, kind: 'rect', ox: pt.x, oy: pt.y };
      markDirty('board');
    } else if (state.currentTool === 'note') {
      const shape = { id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: 'note', x: pt.x, y: pt.y, w: 180, h: 100, color: state.boardColor, text: 'Engineering Note', codeRef: state.boardCodeRef };
      state.boardShapes.push(shape);
      state.selectedShapeId = shape.id;
      markDirty('board');
      editNote(shape);
    } else {
      // select tool: pick the shape under the cursor
      const target = evt.target.closest ? evt.target.closest('[data-id]') : null;
      state.selectedShapeId = target ? target.dataset.id : null;
      markDirty('board');
    }
  }

  function onPointerMove(evt) {
    if (!boardDrag) return;
    const pt = boardPoint(evt);
    if (boardDrag.kind === 'pen') {
      const shape = boardDrag.shape;
      const last = shape.points[shape.points.length - 1];
      if (last && Math.abs(last[0] - pt.x) < 2 && Math.abs(last[1] - pt.y) < 2) return;
      shape.points.push([pt.x, pt.y]);
      shape.d += ` L ${pt.x} ${pt.y}`;
      // Patch the live path only — no scene rebuild during a stroke.
      const node = $('board-svg').querySelector(`[data-k="${cssEscape(shape.id)}"] path`);
      if (node) node.setAttribute('d', shape.d);
    } else if (boardDrag.kind === 'rect') {
      const shape = boardDrag.shape;
      shape.w = Math.max(24, Math.abs(pt.x - boardDrag.ox));
      shape.h = Math.max(24, Math.abs(pt.y - boardDrag.oy));
      shape.x = Math.min(pt.x, boardDrag.ox);
      shape.y = Math.min(pt.y, boardDrag.oy);
      const node = $('board-svg').querySelector(`[data-k="${cssEscape(shape.id)}"] rect`);
      if (node) {
        node.setAttribute('x', shape.x); node.setAttribute('y', shape.y);
        node.setAttribute('width', shape.w); node.setAttribute('height', shape.h);
      }
    }
  }

  function onPointerUp() {
    if (!boardDrag) return;
    const shape = boardDrag.shape;
    boardDrag = null;
    if (shape && (shape.type === 'path' || shape.type === 'rect')) {
      const hub = shapeToHub(shape);
      if (hub) { void boardPush({ op: 'add', shape: hub }); }
    }
    markDirty('board');
  }

  function onBoardKey(evt) {
    const node = evt.target.closest ? evt.target.closest('[data-id]') : null;
    if (!node) return;
    const id = node.dataset.id;
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      state.selectedShapeId = id;
      markDirty('board');
    } else if (evt.key === 'Delete' || evt.key === 'Backspace') {
      evt.preventDefault();
      state.selectedShapeId = id;
      deleteSelectedShape();
    }
  }

  function setBoardTool(tool) {
    state.currentTool = tool;
    $$('.board-toolbar button[data-tool]').forEach((b) => {
      const on = b.dataset.tool === tool;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));   // tool buttons are real toggles
    });
    const stage = $('board-stage');
    if (stage) stage.dataset.tool = tool;
  }

  function deleteSelectedShape() {
    if (!state.selectedShapeId) { toast('No shape selected.', 'warning'); return; }
    const doomed = state.selectedShapeId;
    state.boardShapes = state.boardShapes.filter((s) => s.id !== doomed);
    state.selectedShapeId = null;
    markDirty('board');
    renderBoardStatus();
    void boardPush({ op: 'delete', id: doomed });
  }

  function exportBoard() {
    const blob = new Blob([JSON.stringify(state.boardShapes, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'agentmesh-board.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Exported board to JSON file.', 'success');
  }

  async function importBoard() {
    const text = await promptText('Paste board JSON shapes:');
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        state.boardShapes = parsed;
        markDirty('board');
        toast('Imported board shapes.', 'success');
      }
    } catch {
      toast('Invalid JSON format.', 'error');
    }
  }

  async function editNote(shape) {
    const text = await promptText('Note text:', shape.text || 'Engineering Note');
    if (text == null) return;
    shape.text = String(text).slice(0, 500);
    markDirty('board');
    // `update` takes a patch, not a whole shape.
    const hub = shapeToHub(shape);
    if (hub) {
      const { id, ...patch } = hub;
      void boardPush({ op: 'update', id: shape.id, patch });
    }
  }

  /** Promise-based replacement for prompt()/alert() — focusable, Escape-aware. */
  function promptText(message, initial) {
    return new Promise((resolve) => {
      const existing = $('prompt-modal');
      if (existing) existing.remove();
      const overlay = el('div', { class: 'modal-overlay open', id: 'prompt-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': message });
      const input = el('input', { type: 'text', id: 'prompt-input', value: initial == null ? '' : String(initial) });
      const card = el('div', { class: 'modal-card' });
      card.appendChild(el('h3', { text: message }));
      card.appendChild(el('div', { class: 'form-group' }, input));
      const row = el('div', { style: 'display:flex;justify-content:flex-end;gap:10px;margin-top:20px;' });
      const cancel = el('button', { class: 'btn-ghost', text: 'Cancel' });
      const ok = el('button', { class: 'btn-primary', text: 'OK' });
      row.appendChild(cancel); row.appendChild(ok);
      card.appendChild(row);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      input.focus();
      input.select();
      const done = (v) => { overlay.remove(); resolve(v); };
      cancel.addEventListener('click', () => done(null));
      ok.addEventListener('click', () => done(input.value));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      });
    });
  }

  function bootstrapTldrawFlag() {
    // Flags come from the hash first (hub-safe), then the query string.
    const flags = state.flags || {};
    const useTldraw = flags.board === 'tldraw';
    if (!useTldraw) return;
    const syncBtn = $('btn-board-tldraw-sync');
    const loadBtn = $('btn-board-tldraw-load');
    if (syncBtn) syncBtn.removeAttribute('hidden');
    if (loadBtn) loadBtn.removeAttribute('hidden');
    boardStatus('tldraw · loading…');
    const s = document.createElement('script');
    s.src = './board-tldraw.js';
    s.onload = () => { try { window.AgentMeshBoardTldraw && window.AgentMeshBoardTldraw.mount(); } catch { /* ignore */ } };
    s.onerror = () => boardStatus('tldraw failed to load · legacy board');
    document.head.appendChild(s);
  }
  /* ===================================================================== *
   * §6  Voice
   * ===================================================================== */

  async function toggleMicrophone() {
    const btn = $('btn-toggle-mic');
    const muteBtn = $('btn-mute-mic');
    const statusText = $('local-voice-status');

    if (state.isMicConnected) {
      if (state.mediaStream) state.mediaStream.getTracks().forEach((t) => t.stop());
      if (state.animFrameId) cancelAnimationFrame(state.animFrameId);
      if (state.audioCtx) { try { await state.audioCtx.close(); } catch { /* ignore */ } }
      state.isMicConnected = false;
      state.audioCtx = null; state.mediaStream = null; state.analyser = null;
      if (btn) btn.textContent = '🎤 Connect Microphone';
      if (muteBtn) muteBtn.disabled = true;
      if (statusText) statusText.textContent = 'Microphone Idle';
      const fill = $('vu-meter-fill');
      if (fill) fill.style.width = '0%';
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      state.mediaStream = stream;
      state.audioCtx = ctx;
      state.analyser = analyser;
      state.isMicConnected = true;
      if (btn) btn.textContent = '⏹ Disconnect Microphone';
      if (muteBtn) muteBtn.disabled = false;
      if (statusText) statusText.textContent = 'Microphone Live';
      const data = new Uint8Array(analyser.frequencyBinCount);
      const fill = $('vu-meter-fill');
      const loop = () => {
        if (!state.analyser) return;
        state.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / data.length);
        if (fill) fill.style.width = `${clamp(Math.round(rms * 260), 0, 100)}%`;
        state.animFrameId = requestAnimationFrame(loop);
      };
      state.animFrameId = requestAnimationFrame(loop);
    } catch (err) {
      if (statusText) statusText.textContent = 'Microphone blocked';
      toast('Microphone unavailable: ' + err.message, 'warning');
    }
  }

  function toggleMute() {
    if (!state.mediaStream) return;
    state.isMuted = !state.isMuted;
    state.mediaStream.getAudioTracks().forEach((t) => { t.enabled = !state.isMuted; });
    const btn = $('btn-mute-mic');
    if (btn) btn.textContent = state.isMuted ? 'Unmute' : 'Mute';
    const statusText = $('local-voice-status');
    if (statusText) statusText.textContent = state.isMuted ? 'Microphone Muted' : 'Microphone Live';
  }

  /* ===================================================================== *
   * §7  Actions (writes)
   * ===================================================================== */

  async function declareIntent(actor, goal, paths, effect) {
    const pathList = String(paths || '').split(',').map((s) => s.trim()).filter(Boolean);
    const payload = { goal: String(goal || '').slice(0, 500), paths: pathList, effect: effect || 'none' };
    try {
      const res = await net.post('/cmd', { actor, kind: 'intent.declare', payload });
      if (res && res.ok === false) throw new Error(res.error || 'declare failed');
      toast(`Lease acquired for ${pathList.join(', ')}`, 'success');
      scheduleSync();
    } catch (err) {
      toast('Declare failed: ' + err.message, 'error');
    }
  }

  async function releaseIntent(id) {
    if (!id) return;
    try {
      await net.post('/cmd', { actor: state.actor, kind: 'intent.release', payload: { id } });
      toast('Intent released.', 'info');
      scheduleSync();
    } catch (err) {
      toast('Release failed: ' + err.message, 'error');
    }
  }

  async function sendAgentRequest() {
    const from = $('req-from-select')?.value || state.actor;
    const to = $('req-to-select')?.value || 'codex-backend';
    const text = $('req-text-input')?.value || '';
    if (!text.trim()) { toast('Request text is required.', 'warning'); return; }
    try {
      const res = await net.post('/api/request', { actor: from, to, text: text.slice(0, 2000) });
      if (res && res.ok === false) throw new Error(res.error || 'request failed');
      toast(`Task sent to @${to}.`, 'success');
      const ta = $('req-text-input');
      if (ta) ta.value = '';
      scheduleSync();
    } catch (err) {
      toast('Request failed: ' + err.message, 'error');
    }
  }

  async function respondRequest(id, accept) {
    try {
      const res = await net.post('/api/request-respond', { actor: state.actor, id, accept });
      if (res && res.ok === false) throw new Error(res.error || 'respond failed');
      toast(accept ? 'Request accepted.' : 'Request declined.', accept ? 'success' : 'info');
      scheduleSync();
    } catch (err) {
      toast('Could not update request: ' + err.message, 'error');
    }
  }

  async function mutateCrdtSymbol(key, value) {
    try {
      const res = await net.post('/api/crdt', { actor: state.actor, action: 'set', key, value });
      if (res && res.ok === false) throw new Error(res.error || 'crdt commit failed');
      toast('CRDT delta committed.', 'success');
      state.panelSeq.crdt = -1;
      await ensurePanel('crdt', true);
    } catch (err) {
      toast('CRDT commit failed: ' + err.message, 'error');
    }
  }

  async function createMacpSession(mode, title, initiator) {
    try {
      const res = await net.post('/api/macp', { action: 'create', mode, title, initiator });
      if (res && res.ok === false) throw new Error(res.error || 'session failed');
      toast('MACP session opened.', 'success');
      closeModal('create-macp-modal');
      state.panelSeq.macp = -1;
      await ensurePanel('macp', true);
    } catch (err) {
      toast('MACP session failed: ' + err.message, 'error');
    }
  }

  async function castMacpVote(id, vote) {
    try {
      const res = await net.post('/api/macp', { action: 'vote', id, vote });
      if (res && res.ok === false) throw new Error(res.error || 'vote failed');
      toast(`Vote "${vote}" recorded.`, 'success');
      state.panelSeq.macp = -1;
      await ensurePanel('macp', true);
    } catch (err) {
      toast('Vote failed: ' + err.message, 'error');
    }
  }

  async function claimTask(id) {
    try {
      const res = await net.post('/api/tasks', { action: 'claim', id, actor: state.actor });
      if (res && res.ok === false) throw new Error(res.error || 'claim failed');
      toast('Task claimed.', 'success');
      state.panelSeq.tasks = -1;
      await ensurePanel('tasks', true);
    } catch (err) {
      toast('Claim failed: ' + err.message, 'error');
    }
  }

  async function appendDagNode(kind, payloadText) {
    try {
      const res = await net.post('/api/dag', { action: 'append', kind: kind || 'thought', payload: payloadText ? { memo: payloadText } : {}, actor: state.actor });
      if (res && res.ok === false) throw new Error(res.error || 'append failed');
      toast('Merkle node appended.', 'success');
      state.panelSeq.dag = -1;
      await ensurePanel('dag', true);
    } catch (err) {
      toast('Append failed: ' + err.message, 'error');
    }
  }

  /* ===================================================================== *
   * §7  Wiring
   * ===================================================================== */

  function setHubStatus(mode) {
    const badge = $('hub-status-badge');
    const text = $('hub-status-text');
    if (!badge || !text) return;
    badge.classList.remove('live', 'standalone', 'alert');
    if (mode === 'live') {
      badge.classList.add('live');
      text.textContent = `Hub Online: ${net.base().replace(/https?:\/\//, '')}`;
    } else if (mode === 'retry') {
      badge.classList.add('standalone');
      text.textContent = 'Hub: Reconnecting…';
    } else if (mode === 'error') {
      badge.classList.add('alert');
      text.textContent = 'Hub: Unreachable';
    } else {
      badge.classList.add('standalone');
      text.textContent = 'Standalone Mode (Local)';
    }
  }

  /** One cheap probe: does a hub live at this origin? */
  async function probeHub(url) {
    try {
      const res = await fetch(url.replace(/\/+$/, '') + '/health', {
        signal: AbortSignal.timeout(2500),
        cache: 'no-store',
      });
      if (!res.ok) return false;
      const d = await res.json().catch(() => ({}));
      return !!d.ok;
    } catch {
      return false;
    }
  }

  /**
   * Find the hub.
   *
   * 1. An operator-pinned URL always wins — that is an explicit choice.
   * 2. Otherwise this page's own origin first: the site is usually served *by*
   *    the hub, so same-origin is both the fastest and the most likely answer,
   *    and it costs no CORS round trip.
   * 3. Then a previously saved URL, then the default loopback port.
   *
   * The first candidate that answers /health wins. Nothing is pinned unless
   * the operator chose it, so a URL left behind by an older build can never
   * hijack the board.
   */
  async function resolveHubUrl() {
    const cands = [];
    const push = (u) => { if (u && !cands.includes(u)) cands.push(u.replace(/\/+$/, '')); };
    if (state.hubUrlPinned && state.hubUrlExplicit) return state.hubUrlExplicit;
    try { if (/^https?:$/.test(location.protocol)) push(location.origin); } catch { /* no location */ }
    push(state.hubUrlExplicit);
    push('http://localhost:7777');
    for (const c of cands) {
      if (await probeHub(c)) return c;
    }
    return state.hubUrlExplicit || cands[cands.length - 1] || 'http://localhost:7777';
  }

  async function connectHub(url, token) {
    const explicit = typeof url === 'string' && url.trim();
    const target = explicit ? url.trim() : await resolveHubUrl();
    state.hubUrl = target.replace(/\/+$/, '');
    markHubReady();
    if (explicit) {
      state.hubUrlExplicit = state.hubUrl;
      state.hubUrlPinned = true;
      try {
        localStorage.setItem(LS.hub, state.hubUrl);
        localStorage.setItem(LS.pinned, '1');
      } catch { /* private mode */ }
    }
    if (token != null) state.token = String(token).trim();
    state.connecting = true;
    try {
      localStorage.setItem(LS.token, state.token);
      localStorage.setItem(LS.tokenAlt, state.token); // keep the legacy key in sync
      localStorage.setItem(LS.actor, state.actor);
    } catch { /* private mode */ }

    setHubStatus('retry');
    try {
      await net.get('/health', { signal: AbortSignal.timeout(3000) });
      state.connected = true;
      setHubStatus('live');
      openStream();
      await pullOverview();
      await ensurePanel('tasks', true);
      void seedHistory(200);
      void boardPull();
      renderConnectPanel();
      scheduleSync();
      return true;
    } catch {
      state.connected = false;
      closeStream();
      setHubStatus('offline');
      return false;
    } finally {
      state.connecting = false;
    }
  }

  /* --- tabs ----------------------------------------------------------- */

  function selectTab(key) {
    const btn = $(`tab-btn-${key}`);
    if (!btn) return;
    for (const b of $$('#navigation-tabs [role="tab"]')) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const p of $$('.view-panel')) {
      const on = p.id === `view-${key}`;
      p.classList.toggle('active', on);
      p.hidden = !on;
    }
    state.activeTab = key;
    state.seenTabs.add(key);
    writeLocation(key);

    // The desk's scope is now live: paint it even if no event has arrived yet.
    markDirty('overview');
    markDirty({ topo: 'topo', swarm: 'swarm', crdt: 'crdt', macp: 'macp', dag: 'dag', board: 'board', voice: 'presence', health: 'health' }[key] || 'overview');

    // Lazy-load the panels this desk needs. Hidden desks cost nothing.
    if (key === 'crdt') void ensurePanel('crdt');
    if (key === 'macp') void ensurePanel('macp');
    if (key === 'dag') void ensurePanel('dag');
    if (key === 'tasks' || key === 'swarm') void ensurePanel('tasks');
    if (key === 'board') void boardPull();
    if (key === 'health') void refreshHealth();
    if (key === 'swarm') renderConnectPanel();
    scheduleRender();
  }

  function initTabs() {
    const tabs = $$('#navigation-tabs [role="tab"]');
    tabs.forEach((btn, i) => {
      on(btn, 'click', () => selectTab(btn.dataset.tab));
      on(btn, 'keydown', (e) => {
        const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
        if (!(e.key in keys)) return;
        e.preventDefault();
        let next;
        if (keys[e.key] === 'first') next = 0;
        else if (keys[e.key] === 'last') next = tabs.length - 1;
        else next = (i + keys[e.key] + tabs.length) % tabs.length;
        tabs[next].focus();
        selectTab(tabs[next].dataset.tab);
      });
    });
    const initial = locationTab();
    selectTab($(`tab-btn-${initial}`) ? initial : 'topo');

    // Deep links: #swarm, #board&board=tldraw, ...
    on(window, 'hashchange', () => {
      const next = locationTab();
      if (next && next !== state.activeTab && $(`tab-btn-${next}`)) selectTab(next);
    });
  }

  /* --- modals --------------------------------------------------------- */

  let modalReturnFocus = null;

  function openModal(id) {
    const m = $(id);
    if (!m) return;
    modalReturnFocus = document.activeElement;
    m.hidden = false;
    m.classList.add('open');
    document.body.classList.add('modal-open');
    const focusable = m.querySelector('input, select, textarea, button:not([data-close])');
    if (focusable) focusable.focus();
    m._trap = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(id); return; }
      if (e.key !== 'Tab') return;
      const nodes = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', m)
        .filter((n) => n.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    m.addEventListener('keydown', m._trap);
  }

  function closeModal(id) {
    const m = $(id);
    if (!m) return;
    m.hidden = true;
    m.classList.remove('open');
    if (!$('.modal-overlay.open')) document.body.classList.remove('modal-open');
    if (m._trap) { m.removeEventListener('keydown', m._trap); m._trap = null; }
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  }

  function initModals() {
    $$('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(overlay.id);
      });
    });
  }

  /* --- toasts --------------------------------------------------------- */

  function toast(msg, type) {
    const c = $('toast-container');
    if (!c) return;
    const kind = type === 'error' ? 'bad' : type === 'success' ? 'ok' : type === 'warning' ? 'warn' : 'info';
    const el2 = el('div', { class: `toast ${kind}`, role: type === 'error' ? 'alert' : 'status', text: String(msg) });
    c.appendChild(el2);
    setTimeout(() => {
      el2.style.opacity = '0';
      el2.style.transform = 'translateX(20px)';
      el2.style.transition = 'all 0.3s ease';
      setTimeout(() => el2.remove(), 300);
    }, 4000);
  }

  /* --- delegated actions ---------------------------------------------- */

  function initDelegation() {
    on(document, 'click', (e) => {
      const target = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!target) return;
      const act = target.dataset.act;
      switch (act) {
        case 'release': e.preventDefault(); void releaseIntent(target.dataset.id); break;
        case 'strip': e.preventDefault(); openModal('declare-intent-modal'); break;
        case 'request': e.preventDefault(); toggleInbox(); break;
        case 'approve': e.preventDefault(); void respondRequest(target.dataset.id, true); break;
        case 'decline': e.preventDefault(); void respondRequest(target.dataset.id, false); break;
        case 'edit-crdt': e.preventDefault(); openEditCrdt(target.dataset.key, target.dataset.value); break;
        case 'vote': e.preventDefault(); void castMacpVote(target.dataset.id, target.dataset.vote); break;
        case 'claim': e.preventDefault(); void claimTask(target.dataset.id); break;
        case 'dag': e.preventDefault(); openDagInspector(target.dataset.id); break;
        case 'agent': e.preventDefault(); openAgent(target.dataset.agent); break;
        case 'topo-agent': e.preventDefault(); openAgent(target.dataset.agent); break;
        case 'shape': e.preventDefault(); state.selectedShapeId = target.dataset.id; markDirty('board'); break;
        case 'palette': e.preventDefault(); runPalette(Number(target.dataset.index)); break;
        case 'collide-macp': e.preventDefault(); openModal('create-macp-modal'); break;
        case 'collide-release': e.preventDefault(); void releaseIntent(target.dataset.id); break;
        case 'collide-close': e.preventDefault(); { const d = $('drawer-collide'); if (d) d.hidden = true; break; }
        case 'focus-agent': e.preventDefault(); toggleFocusActor(target.dataset.agent); break;
        default: break;
      }
    });

    // Collisions are clickable from the readout.
    on($('metric-collision-sub'), 'click', () => {
      const c = currentCollisions()[0];
      if (c) openCollision(c);
    });
  }

  function openAgent(actorId) {
    if (!actorId) return;
    const intents = currentIntents().filter((i) => i.actor === actorId);
    const ov = state.ov;
    const presence = (ov && ov.presence && ov.presence[actorId]) || null;
    const body = $('drawer-collide-body');
    const drawer = $('drawer-collide');
    if (!body || !drawer) return;
    body.textContent = '';
    body.appendChild(el('h3', { text: '@' + actorId }));
    body.appendChild(el('p', { class: 'inbox-text', text: presence ? `last seen ${fmtAgo(presence.seen)}${presence.away ? ' · away' : ' · active'}` : 'no presence signal yet' }));
    const ul = el('ul', { class: 'collide-paths' });
    if (!intents.length) ul.appendChild(el('li', { text: 'no active intents' }));
    for (const i of intents) {
      ul.appendChild(el('li', { class: 'mono', text: `${i.goal || ''} — ${(i.paths || []).join(', ')}` }));
    }
    body.appendChild(ul);
    const actions = el('div', { class: 'collide-actions' });
    actions.appendChild(el('button', { class: 'btn-ghost btn-mini', 'data-act': 'focus-agent', 'data-agent': actorId, text: 'focus (f)' }));
    actions.appendChild(el('button', { class: 'btn-ghost btn-mini', 'data-act': 'collide-close', text: 'close' }));
    body.appendChild(actions);
    drawer.hidden = false;
  }

  function openEditCrdt(key, value) {
    const m = $('edit-crdt-modal');
    if (!m) return;
    const k = $('edit-crdt-key');
    const v = $('edit-crdt-value');
    if (k) k.textContent = key || '';
    if (v) v.value = value == null ? '' : String(value);
    openModal('edit-crdt-modal');
  }

  function openDagInspector(id) {
    const node = dagNodes().find((n) => n.id === id);
    const body = $('inspect-dag-body');
    if (body) body.textContent = node ? JSON.stringify(node, null, 2) : 'node not found';
    openModal('inspect-dag-modal');
  }

  /* --- keyboard -------------------------------------------------------- */

  /**
   * The canonical keyboard map (shared with the canvas at src/canvas.html):
   *   1-8  switch desk        f  focus        r  refresh
   * plus the board-only extras: ⌘K palette, i inbox, p HUD, l live/time-machine.
   */
  const DESK_KEYS = ['topo', 'swarm', 'crdt', 'macp', 'dag', 'board', 'voice', 'health'];

  function initKeyboard() {
    on(document, 'keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

      // Ctrl/Cmd+K and "?" open the palette.
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        state.paletteOpen ? closePalette() : openPalette();
        return;
      }
      if (e.key === 'Escape') {
        if (state.paletteOpen) { e.preventDefault(); closePalette(); return; }
        const open = $('.modal-overlay.open');
        if (open) { e.preventDefault(); closeModal(open.id); return; }
        if (state.inboxOpen) { e.preventDefault(); toggleInbox(false); return; }
        const cd = $('drawer-collide');
        if (cd && !cd.hidden) { e.preventDefault(); cd.hidden = true; return; }
      }
      if (typing) return;
      // A modal owns the keyboard while it is open.
      if ($('.modal-overlay.open') || state.paletteOpen) return;

      // 1-8 switch desk.
      if (e.key >= '1' && e.key <= '8') {
        e.preventDefault();
        selectTab(DESK_KEYS[Number(e.key) - 1]);
        return;
      }
      // f = focus, r = refresh.
      if (e.key === 'f') { e.preventDefault(); focusDesk(); return; }
      if (e.key === 'r') { e.preventDefault(); refreshNow(); return; }

      if (e.key === '?') { e.preventDefault(); openPalette(); return; }
      if (e.key === 'p') { e.preventDefault(); toggleHud(); return; }
      if (e.key === 'i') { e.preventDefault(); toggleInbox(); return; }
      if (e.key === 'l') {
        e.preventDefault();
        const last = state.events.at(state.events.length - 1);
        setScrub(state.scrubbing == null ? (last ? last.seq : null) : null);
      }
    });

    // Palette navigation.
    on($('palette-input'), 'keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); state.paletteIndex = clamp(state.paletteIndex + 1, 0, state.paletteItems.length - 1); renderPalette(); scrollPaletteIntoView(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); state.paletteIndex = clamp(state.paletteIndex - 1, 0, state.paletteItems.length - 1); renderPalette(); scrollPaletteIntoView(); }
      else if (e.key === 'Enter') { e.preventDefault(); runPalette(state.paletteIndex); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });
    on($('palette-input'), 'input', () => { state.paletteIndex = 0; renderPalette(); });
    on($('palette-overlay'), 'click', (e) => { if (e.target.id === 'palette-overlay') closePalette(); });

    on($('tm-range'), 'input', (e) => { setScrub(Number(e.target.value)); });
    on($('tm-live'), 'click', () => { setScrub(null); });

    on($('btn-open-hud'), 'click', () => toggleHud());
    on($('btn-open-inbox'), 'click', () => toggleInbox());
    on($('btn-close-inbox'), 'click', () => toggleInbox(false));
    on($('btn-close-collide'), 'click', () => { const d = $('drawer-collide'); if (d) d.hidden = true; });
    on($('btn-open-palette'), 'click', () => openPalette());

    $$('#mcp-client-tabs [role="tab"]').forEach((b) => {
      on(b, 'click', () => { mcpClient = b.dataset.client; renderConnectPanel(); });
      on(b, 'keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const tabs = $$('#mcp-client-tabs [role="tab"]');
        const i = tabs.indexOf(b);
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        mcpClient = next.dataset.client;
        renderConnectPanel();
      });
    });

    $$('#drawer-inbox [role="tab"]').forEach((b) => {
      on(b, 'click', () => {
        state.inboxTab = b.dataset.inbox;
        $$('#drawer-inbox [role="tab"]').forEach((x) => {
          const on2 = x === b;
          x.classList.toggle('active', on2);
          x.setAttribute('aria-selected', String(on2));
          x.tabIndex = on2 ? 0 : -1;
        });
        renderInbox();
      });
    });
  }

  function scrollPaletteIntoView() {
    const node = $(`palette-opt-${state.paletteIndex}`);
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }

  /**
   * `f` — focus the current desk.
   *
   * On TOPO it toggles focus mode: the graph collapses to one agent and its
   * neighbours, which is how you read a busy mesh without losing the thread.
   * Elsewhere it moves the caret to whatever that desk is for.
   */
  function focusDesk() {
    if (state.activeTab === 'topo') { toggleFocusActor(); return; }
    const focusers = {
      swarm: 'req-text-input',
      crdt: 'quick-crdt-key',
      macp: 'macp-title',
      dag: 'btn-verify-dag-chain',
      board: 'board-coderef',
      voice: 'btn-toggle-mic',
      health: 'btn-refresh-metrics',
    };
    const id = focusers[state.activeTab];
    const node = id ? $(id) : null;
    if (node && node.focus) node.focus();
    else openPalette();
  }

  function toggleFocusActor(actorId) {
    const next = actorId != null ? actorId : (state.focusActor ? null : firstActorId());
    state.focusActor = next || null;
    markDirty('topo');
    renderFocusChip();
    return state.focusActor;
  }

  function firstActorId() {
    const presence = (state.ov && state.ov.presence) || {};
    const ids = Object.keys(presence);
    if (ids.length) return ids[0];
    const intents = currentIntents();
    return intents.length ? intents[0].actor : null;
  }

  function renderFocusChip() {
    const seg = $('metric-focus-seg');
    if (!seg) return;
    if (state.focusActor) {
      seg.hidden = false;
      seg.textContent = `FOCUS @${state.focusActor}`;
      seg.classList.add('focused');
    } else {
      seg.hidden = true;
      seg.classList.remove('focused');
    }
  }

  /** `r` — refresh the current desk from the hub. */
  async function refreshNow() {
    await pullOverview();
    if (state.activeTab === 'board') await boardPull();
    if (state.activeTab === 'health') await refreshHealth();
    const panel = { crdt: 'crdt', macp: 'macp', dag: 'dag', swarm: 'tasks', board: 'board' }[state.activeTab];
    if (panel) await ensurePanel(panel, true);
    markDirty('overview');
    toast('Refreshed from hub.', 'info');
  }

  /* --- settings -------------------------------------------------------- */

  function loadSettings() {
    try {
      state.token = localStorage.getItem(LS.token) || localStorage.getItem(LS.tokenAlt) || '';
      state.actor = localStorage.getItem(LS.actor) || 'browser';
      state.hubUrlExplicit = (localStorage.getItem(LS.hub) || '').replace(/\/+$/, '');
      state.hubUrlPinned = localStorage.getItem(LS.pinned) === '1';
    } catch { /* private mode */ }
    const hub = $('setting-hub-url');
    const tok = $('setting-mesh-token');
    if (hub) hub.value = state.hubUrlExplicit || state.hubUrl;
    if (tok) tok.value = state.token;
  }

  function saveSettings() {
    const url = $('setting-hub-url')?.value || state.hubUrl;
    const tok = $('setting-mesh-token')?.value || '';
    closeModal('settings-modal');
    void connectHub(url, tok);
    toast('Mesh network settings saved.', 'success');
  }

  /* --- selects that depend on the roster ------------------------------- */

  function fillActorSelects() {
    const ids = new Set(state.agents.map((a) => a.id));
    for (const r of ((state.ov && state.ov.roster) || [])) ids.add(r.actor);
    for (const id of Object.keys((state.ov && state.ov.presence) || {})) ids.add(id);
    const list = Array.from(ids);
    for (const [selId, def] of [['declare-actor', state.actor], ['macp-initiator', state.actor]]) {
      const sel = $(selId);
      if (!sel) continue;
      const prev = sel.value;
      sel.textContent = '';
      for (const id of list) sel.appendChild(el('option', { value: id, text: '@' + id }));
      sel.value = list.includes(prev) ? prev : (list.includes(def) ? def : (list[0] || ''));
    }
    for (const [selId, def] of [['req-from-select', state.actor], ['req-to-select', 'codex-backend']]) {
      const sel = $(selId);
      if (!sel) continue;
      const prev = sel.value;
      sel.textContent = '';
      for (const id of list.length ? list : ['codex-backend', 'antigravity-ui']) {
        sel.appendChild(el('option', { value: id, text: '@' + id }));
      }
      sel.value = prev || def;
    }
  }

  /* --- cross-tab sync (F10) -------------------------------------------- */

  let channel = null;
  function initChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      channel = new BroadcastChannel('agentmesh');
      channel.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === 'seq' && state.connected && typeof msg.seq === 'number' && msg.seq > state.seq) {
          void pullOverview();
        }
      };
    } catch { /* unsupported */ }
  }

  function broadcastSeq() {
    if (!channel) return;
    try { channel.postMessage({ type: 'seq', seq: state.seq, url: state.hubUrl }); } catch { /* ignore */ }
  }

  /* --- service worker -------------------------------------------------- */

  function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    on(navigator.serviceWorker, 'error', () => { /* ignore */ });
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  }

  /* --- perf observer --------------------------------------------------- */

  function initPerfObserver() {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const types = PerformanceObserver.supportedEntryTypes || [];
      if (types.includes('longtask')) {
        const po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > state.perf.longtask) state.perf.longtask = entry.duration;
          }
          if (state.hudOn) updateHud();
        });
        po.observe({ entryTypes: ['longtask'] });
      }
    } catch { /* unsupported */ }
  }

  /* --- boot ------------------------------------------------------------ */

  function boot() {
    loadSettings();
    state.flags = locationFlags();
    initTabs();
    initModals();
    initDelegation();
    initKeyboard();
    initBoard();
    initChannel();
    initPerfObserver();
    initServiceWorker();
    fillActorSelects();
    renderConnectPanel();
    updateTimeMachine();

    // HUD can be armed from the URL (#topo&hud=1) for profiling.
    if (state.flags.hud === '1' || state.flags.hud === 'true') toggleHud(true);

    // Static wiring for the header/panel controls that have no dynamic data.
    on($('btn-open-declare-modal'), 'click', () => openModal('declare-intent-modal'));
    on($('btn-topo-declare'), 'click', () => openModal('declare-intent-modal'));
    on($('btn-cancel-declare'), 'click', () => closeModal('declare-intent-modal'));
    on($('btn-submit-declare'), 'click', () => {
      const actor = $('declare-actor')?.value || state.actor;
      const goal = $('declare-goal')?.value || '';
      const paths = $('declare-paths')?.value || '';
      const effect = $('declare-effect')?.value || 'none';
      if (!goal.trim() || !paths.trim()) { toast('Goal and paths are required.', 'warning'); return; }
      void declareIntent(actor, goal, paths, effect);
      closeModal('declare-intent-modal');
    });

    on($('btn-open-settings'), 'click', () => openModal('settings-modal'));
    on($('btn-close-settings'), 'click', () => closeModal('settings-modal'));
    on($('btn-save-settings'), 'click', saveSettings);
    on($('btn-configure-providers'), 'click', () => openModal('settings-modal'));
    on($('btn-quick-mesh-actors'), 'click', () => selectTab('swarm'));
    on($('btn-connect-hub'), 'click', () => openModal('connect-modal'));
    on($('hub-status-badge'), 'click', () => openModal('connect-modal'));
    on($('btn-modal-cancel'), 'click', () => closeModal('connect-modal'));
    on($('btn-modal-save'), 'click', () => {
      const url = $('input-hub-url')?.value || state.hubUrl;
      const tok = $('input-hub-token')?.value || '';
      closeModal('connect-modal');
      void connectHub(url, tok);
    });

    on($('btn-add-agent'), 'click', () => openModal('add-agent-modal'));
    on($('btn-cancel-agent'), 'click', () => closeModal('add-agent-modal'));
    on($('btn-submit-agent'), 'click', () => {
      const id = ($('new-agent-id')?.value || '').trim().toLowerCase();
      const role = ($('new-agent-role')?.value || '').trim();
      const provider = $('new-agent-provider')?.value || 'gemini';
      const model = ($('new-agent-model')?.value || '').trim() || modelFor(provider);
      if (!id || !role) { toast('Agent ID and role required.', 'warning'); return; }
      state.agents.push({ id, name: role, role, provider, model, status: 'idle', task: 'Initialized' });
      fillActorSelects();
      markDirty('swarm');
      closeModal('add-agent-modal');
      toast(`Added agent @${id} powered by ${provider}/${model}`, 'success');
    });

    on($('btn-send-agent-request'), 'click', () => void sendAgentRequest());
    on($('preset-req-1'), 'click', () => { const t = $('req-text-input'); if (t) t.value = 'Please expose GET /api/v1/topology in src/hub.mjs returning active peers array'; });
    on($('preset-req-2'), 'click', () => { const t = $('req-text-input'); if (t) t.value = 'Please review AST contract changes for OpenAPI v3 schema in contracts/api.json'; });
    on($('btn-copy-join-cmd'), 'click', () => { void copyText(joinCommand()).then((ok) => toast(ok ? 'Join command copied to clipboard!' : `Command: ${joinCommand()}`, ok ? 'success' : 'info')); });
    on($('btn-copy-mcp'), 'click', () => { void copyText(mcpConfig(mcpClient)).then((ok) => toast(ok ? 'MCP config copied to clipboard!' : 'Copy failed — select the text manually.', ok ? 'success' : 'warning')); });
    on($('btn-copy-lan'), 'click', () => { void copyText(lanUrl()).then((ok) => toast(ok ? 'LAN address copied.' : 'Copy failed.', ok ? 'success' : 'warning')); });

    on($('btn-quick-commit-crdt'), 'click', () => {
      const k = $('quick-crdt-key')?.value?.trim();
      const v = $('quick-crdt-val')?.value?.trim();
      if (!k || !v) { toast('Symbol key and value are required.', 'warning'); return; }
      void mutateCrdtSymbol(k, v);
      $('quick-crdt-key').value = '';
      $('quick-crdt-val').value = '';
    });
    on($('btn-open-mutate-crdt'), 'click', () => { $('quick-crdt-key')?.focus(); });

    on($('btn-open-create-macp'), 'click', () => openModal('create-macp-modal'));
    on($('btn-cancel-macp'), 'click', () => closeModal('create-macp-modal'));
    on($('btn-submit-macp'), 'click', () => {
      const mode = $('macp-mode')?.value || 'decision';
      const title = $('macp-title')?.value || '';
      const initiator = $('macp-initiator')?.value || state.actor;
      if (!title.trim()) { toast('Session title is required.', 'warning'); return; }
      void createMacpSession(mode, title, initiator);
    });

    on($('btn-cancel-crdt'), 'click', () => closeModal('edit-crdt-modal'));
    on($('btn-save-crdt'), 'click', () => {
      const key = $('edit-crdt-key')?.textContent || '';
      const value = $('edit-crdt-value')?.value || '';
      closeModal('edit-crdt-modal');
      if (key) void mutateCrdtSymbol(key, value);
    });
    on($('btn-close-inspect-dag'), 'click', () => closeModal('inspect-dag-modal'));

    on($('btn-open-append-dag'), 'click', async () => {
      const memo = await promptText('Merkle node memo:', 'checkpoint');
      if (memo == null) return;
      void appendDagNode('thought', memo);
    });

    on($('btn-toggle-mic'), 'click', () => void toggleMicrophone());
    on($('btn-mute-mic'), 'click', () => toggleMute());

    on($('btn-refresh-topo'), 'click', () => { void pullOverview(); toast('Refreshed topology graph.', 'info'); });
    on($('btn-refresh-metrics'), 'click', () => void refreshHealth());
    on($('btn-run-checks'), 'click', () => void refreshHealth());
    on($('btn-refresh-tasks'), 'click', () => void ensurePanel('tasks', true));
    on($('btn-clear-events'), 'click', () => { const c = $('sse-events-console'); if (c) c.textContent = ''; toast('Events log cleared.', 'info'); });
    on($('btn-verify-dag-chain'), 'click', () => void verifyChain());

    // Connect to the hub (auto-discovering it unless the operator pinned one).
    void connectHub(null, state.token);

    // Keep the roster selects fresh as presence arrives.
    setInterval(() => { fillActorSelects(); updateTimeMachine(); broadcastSeq(); }, 5000);

    // Expose a small, stable surface for scripts and tests.
    window.AgentMeshApp = {
      state,
      net,
      selectTab,
      openPalette,
      closePalette,
      toggleHud,
      toggleInbox,
      setScrub,
      focusDesk,
      refreshNow,
      toggleFocusActor,
      renderBoardStatus,
      pullOverview,
      ingestEvent,
      seedHistory,
      stateAt,
      resolveHubUrl,
      probeHub,
      applyEvent,
      reconcile,
      releaseIntent,
      sendAgentRequest,
      castMacpVote,
      claimTask,
      mutateCrdtSymbol,
      createMacpSession,
      quickPromptAgent: (agentId) => {
        selectTab('swarm');
        const to = $('req-to-select');
        if (to) to.value = agentId;
        setTimeout(() => $('req-text-input')?.focus(), 60);
      },
      editCrdtSymbol: (key, val) => openEditCrdt(key, val),
      inspectDagNode: (id) => openDagInspector(id),
      toast,
    };
  }

  function modelFor(provider) {
    return ({
      gemini: 'gemini-2.5-flash', anthropic: 'claude-3-7-sonnet', openai: 'gpt-4o', ollama: 'llama3.3',
      deepseek: 'deepseek-chat', openrouter: 'anthropic/claude-3.5-sonnet', groq: 'llama-3.3-70b-versatile',
      mistral: 'codestral-latest', xai: 'grok-2-latest',
    })[provider] || 'gemini-2.5-flash';
  }

  if (document.readyState === 'loading') on(document, 'DOMContentLoaded', boot);
  else boot();

})();
