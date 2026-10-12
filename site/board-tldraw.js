// board-tldraw.js — open-source whiteboard embed for AgentMesh.
// Lazy-loaded only when ?board=tldraw. Uses tldraw (MIT) via esm.sh CDN,
// React 18 pinned to match the liveblocks example. No build step.
//
// Sync chain: Liveblocks cloud (if /api/liveblocks-auth ok) → hub ops
// (POST /api/board-op, /api/board-import, GET /api/board) → local-only.
// v1: tldraw store is local; "Sync to hub" pushes a snapshot (clear+import,
// debounced autosave). Incoming hub board.op events trigger a status bump,
// not a destructive reload — user pulls via "Load from hub".
(function () {
  const PIN = { react: '18.2.0', 'react-dom': '18.2.0', tldraw: '3.0.3' };
  const st = { mounted: false, editor: null, saveTimer: 0, seq: null, mode: 'hub' };

  function $(id) { return document.getElementById(id); }
  function status(msg) {
    const el = $('tldraw-status') || $('bstat');
    if (el) el.textContent = msg;
  }
  function hubBase() {
    try {
      const u = new URL(localStorage.getItem('mesh_hub_url') || location.origin);
      return u.origin;
    } catch { return location.origin; }
  }
  function authH() {
    const t = (localStorage.getItem('mesh_token') || '').trim();
    return t ? { authorization: 'Bearer ' + t } : {};
  }
  function actor() { return localStorage.getItem('mesh_actor') || 'browser'; }

  function ensureImportMap() {
    if (document.querySelector('script[data-mesh-tldraw]')) return;
    const m = document.createElement('script');
    m.type = 'importmap';
    m.setAttribute('data-mesh-tldraw', '1');
    m.textContent = JSON.stringify({
      imports: {
        react: `https://esm.sh/react@${PIN.react}`,
        'react-dom': `https://esm.sh/react-dom@${PIN['react-dom']}`,
        'react-dom/client': `https://esm.sh/react-dom@${PIN['react-dom']}/client`,
        tldraw: `https://esm.sh/tldraw@${PIN.tldraw}?external=react,react-dom`,
        'tldraw/tldraw.css': `https://esm.sh/tldraw@${PIN.tldraw}/tldraw.css`,
      },
    });
    document.head.appendChild(m);
  }

  async function probeLiveblocks() {
    try {
      const r = await fetch(`${hubBase()}/api/liveblocks-auth`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authH() },
        body: JSON.stringify({ room: 'mesh-board', user: actor() }),
      });
      const j = await r.json().catch(() => ({}));
      st.mode = j.ok ? 'cloud-ready' : 'hub';
      return j;
    } catch { st.mode = 'hub'; return { ok: false, fallback: 'hub' }; }
  }

  async function loadHubBoard() {
    try {
      const r = await fetch(`${hubBase()}/api/board`);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // hub shapes (share.mjs: note|rect|ellipse|arrow|text|draw) → tldraw createShapes args
  function hubToTldraw(shapesObj) {
    const out = [];
    for (const s of Object.values(shapesObj || {})) {
      const id = `shape:${String(s.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`;
      if (s.type === 'draw' && Array.isArray(s.points) && s.points.length > 1) {
        out.push({
          id, type: 'draw', x: +s.x || 0, y: +s.y || 0,
          props: { color: mapColor(s.color), segments: [{ points: s.points.slice(0, 500).map(([x, y]) => ({ x: +x || 0, y: +y || 0 })) }] },
        });
      } else if (s.type === 'note' || s.type === 'text') {
        out.push({ id, type: 'note', x: +s.x || 0, y: +s.y || 0, props: { color: mapColor(s.color), text: String(s.text || '').slice(0, 500) } });
      } else {
        out.push({
          id, type: 'geo', x: +s.x || 0, y: +s.y || 0,
          props: { geo: s.type === 'ellipse' ? 'ellipse' : 'rectangle', color: mapColor(s.color), text: String(s.text || '').slice(0, 500), w: +s.w || 180, h: +s.h || 120 },
        });
      }
    }
    return out.slice(0, 500);
  }

  function mapColor(c) {
    const m = { yellow: 'yellow', blue: 'blue', green: 'green', pink: 'red', gray: 'grey', red: 'red' };
    return m[c] || 'yellow';
  }

  // tldraw editor snapshot → hub import doc (share.mjs importTldraw shape)
  function editorToHubDoc(editor) {
    const shapes = [];
    try {
      const recs = editor.store.allRecords().filter((r) => r.typeName === 'shape');
      for (const r of recs.slice(0, 1000)) {
        const p = r.props || {};
        const isDraw = r.type === 'draw';
        shapes.push({
          type: isDraw ? 'draw' : r.type === 'note' ? 'note' : 'rect',
          x: Math.round(r.x || 0), y: Math.round(r.y || 0),
          w: Math.round(p.w || 180), h: Math.round(p.h || 120),
          color: 'yellow', text: String(p.text || '').slice(0, 500),
          ...(isDraw && p.segments?.[0]?.points ? { points: p.segments[0].points.slice(0, 200).map((pt) => [Math.round(pt.x || 0), Math.round(pt.y || 0)]) } : {}),
        });
      }
    } catch { /* best-effort */ }
    return { shapes };
  }

  async function pushToHub(editor, opts = {}) {
    const base = hubBase();
    const doc = editorToHubDoc(editor);
    if (!doc.shapes.length && !opts.allowEmpty) { status('tldraw · nothing to sync'); return; }
    status('tldraw · syncing…');
    try {
      await fetch(`${base}/api/board-op`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authH() },
        body: JSON.stringify({ actor: actor(), op: { op: 'clear' } }),
      });
      const r = await fetch(`${base}/api/board-import`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authH() },
        body: JSON.stringify({ actor: actor(), doc }),
      });
      const j = await r.json().catch(() => ({}));
      status(`tldraw · ${st.mode} · synced ${j.added ?? doc.shapes.length} shapes`);
    } catch { status('tldraw · hub unreachable · local-only'); }
  }

  function scheduleAutosave(editor) {
    clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(() => pushToHub(editor), 2000);
  }

  async function mount() {
    if (st.mounted) return true;
    const stage = $('board-stage');
    const legacy = $('board-svg');
    if (!stage) return false;
    ensureImportMap();
    status('tldraw · loading open-source canvas…');

    let root = $('tldraw-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'tldraw-root';
      root.setAttribute('role', 'application');
      root.setAttribute('aria-label', 'AgentMesh whiteboard (tldraw)');
      root.style.cssText = 'width:100%;height:60vh;border:1px solid var(--line);border-radius:8px;overflow:hidden';
      stage.appendChild(root);
    }
    // CSS for tldraw (injected once, non-blocking on failure)
    if (!document.querySelector('link[data-mesh-tldraw-css]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.setAttribute('data-mesh-tldraw-css', '1');
      l.href = `https://esm.sh/tldraw@${PIN.tldraw}/tldraw.css`;
      document.head.appendChild(l);
    }

    try {
      const [{ createElement }, { createRoot }, { Tldraw }] = await Promise.all([
        import('react'), import('react-dom/client'), import('tldraw'),
      ]).then(([React, Client, Tl]) => [React, Client, Tl]);
      const React = await import('react');
      const e = React.createElement;

      if (legacy) legacy.style.display = 'none';
      root.style.display = 'block';

      const auth = await probeLiveblocks();
      const hub = await loadHubBoard();
      if (hub && typeof hub.seq === 'number') { st.seq = hub.seq; }
      const initial = hub && hub.shapes ? hubToTldraw(hub.shapes) : [];

      const onMount = (editor) => {
        st.editor = editor;
        try {
          if (initial.length) editor.createShapes(initial.slice(0, 200));
        } catch { /* empty start is fine */ }
        status(`tldraw · ${st.mode} · ${initial.length} from hub · edits autosave`);
        try {
          editor.store.listen(() => scheduleAutosave(editor), { scope: 'document' });
        } catch { /* older tldraw: manual Sync button only */ }
      };

      createRoot(root).render(e(Tldraw, { autoFocus: true, onMount }));
      st.mounted = true;

      // Wire Sync / Load buttons if present
      const syncBtn = $('btn-board-tldraw-sync');
      if (syncBtn) syncBtn.onclick = () => st.editor && pushToHub(st.editor, { allowEmpty: true });
      const loadBtn = $('btn-board-tldraw-load');
      if (loadBtn) loadBtn.onclick = async () => {
        const h = await loadHubBoard();
        if (h && h.shapes && st.editor) {
          try { st.editor.createShapes(hubToTldraw(h.shapes).slice(0, 200)); status(`tldraw · loaded ${Object.keys(h.shapes).length} from hub`); } catch { status('tldraw · load failed'); }
        }
      };
      if (!auth.ok) status(`tldraw · hub mode · ${initial.length} from hub · ${auth.hint || 'no key, LAN-fast'}`);
      return true;
    } catch (err) {
      if (legacy) legacy.style.display = '';
      root.style.display = 'none';
      status('tldraw CDN failed · legacy board · check network');
      return false;
    }
  }

  function shouldUseTldraw() {
    try { return new URLSearchParams(location.search).get('board') === 'tldraw'; } catch { return false; }
  }

  window.AgentMeshBoardTldraw = { mount, shouldUseTldraw, pushToHub: () => st.editor && pushToHub(st.editor, { allowEmpty: true }) };
})();
