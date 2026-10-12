# Board — whiteboard in AgentMesh

Two canvases, one hub sync. Default works on LAN with zero keys.

## Legacy board (default)
- `site/app.js` → `initBoard()` renders `#board-svg`.
- Every finished stroke/block = one `POST /api/board-op {add}`.
  Clear/delete = one op. No per-mousemove traffic.
- Incoming `board.op` SSE → debounced `GET /api/board` pull (500ms).
- Hub persists `board.json` (`src/share.mjs`): LWW per shape,
  caps 2000 shapes / 500 pts / 500 chars. Export = tldraw-ish JSON.

## tldraw board (`?board=tldraw`) — open-source, not custom
- Open `http://<hub>:7777/?board=tldraw`, go to tab 6.
- `site/board-tldraw.js` lazy-loads `tldraw@3.0.3` + React 18 via
  esm.sh importmap. No build step, no first-paint cost.
- Same hub sync: autosave pushes snapshot (clear+import, 2s debounce),
  "Sync to hub" / "Load from hub" buttons. CDN failure → legacy SVG.
- Code refs: hub `codeRef` ↔ tldraw shape `meta.meshCodeRef`.

## Cloud presence (opt-in)
- `POST /api/liveblocks-auth` → `{ok:false, fallback:"hub"}` when
  `LIVEBLOCKS_SECRET_KEY` is empty. Board keeps working.
- Set the key (see `.env.example`) to enable cloud presence later;
  hub ops remain the LAN-fast default. Throttle presence ~16ms,
  storage on snapshot only.

## Verify
- `node scripts/publish-check.mjs`, `npm test`
- Two browsers, same hub: draw in one → appears in other <1s (SSE).
- `curl localhost:7777/api/board`, `curl localhost:7777/api/board-export`
