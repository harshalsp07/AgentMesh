# Board A11y + Perf — tldraw embed rules

Applies to `?board=tldraw` work in `site/board-tldraw.*`.

## Loading
- Lazy-load tldraw only on the Board tab via `?board=tldraw`.
  Never on first paint. `importmap` → `esm.sh`, pinned versions.
- If CDN / WebGL fails, fall back to legacy `#board-svg` with a
  one-line notice. Board must never blank-screen.

## Sync budget
- Hub ops are the default path (LAN, no key). Debounce snapshot
  pushes to ≥1000ms. Apply incoming `board.op` SSE without full reload.
- Liveblocks is opt-in only (key set). Throttle presence to ~16ms,
  storage writes on snapshot only — never per-pointermove.

## Input
- `touch-action: none` on canvas. Pointer events, not mouse-only.
- Color contrast on `#0d1219`: text ≥ 4.5:1. Sticky text ≥ 13px.
- Every stroke is an op: `add/update/delete/clear` with stable ids.
  Cap: 2000 shapes, 500 points/stroke (mirror `src/share.mjs`).
