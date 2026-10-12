# UI Unslop — AgentMesh Board + Site rules

Load this skill before touching `site/*` or the whiteboard.

## Non-negotiables
- Use the board library's native chrome. No custom purple gradients,
  no glassmorphism panels over the canvas, no emoji toolbars.
- One primary action per view. Board tab = canvas + status line.
  Export/import live in the board menu, not as extra header buttons.
- System font stack only. No new webfont for the board.
- Keep existing keyboard map: `1-8` tabs, `f` focus, `r` refresh.
- Keep dark canvas `#0d1219` + `--line` border so Map/Board stay consistent.

## Board tab layout
- Toolbar: tool buttons + color select + code-ref input + status span.
  Max one row, wrap on mobile. No second toolbar.
- Canvas container `#board-stage`: single child — either `#board-svg`
  (legacy) or `#tldraw-root` (flag). Never both visible.
- Status line `#bstat`-equivalent: `synced · seq 12 · 3 shapes`
  or `local-only · hub unreachable`. No toasts for every stroke.

## Accessibility
- All tool buttons are real `<button>` with `aria-pressed`.
- Canvas has `role="application"` + `aria-label`.
- Focus outline visible. Honor `prefers-reduced-motion` (disable pulse).
