# Config — every knob in one place

## Env vars (hub + CLI)
| Var | Default | Meaning |
|---|---|---|
| `MESH_DIR` | `.mesh` | Room state dir (db, logs, lanes, keys, shims) |
| `MESH_PORT` | `7777` | Hub HTTP port |
| `MESH_HOST` | `127.0.0.1` | Bind address; `0.0.0.0` only with auth (hub warns otherwise) |
| `MESH_AUTH` | off unless keys exist | `1` forces token auth even without keys |
| `MESH_EPOCH` | persisted, default `1` | Fencing epoch; standby promotes under epoch+1 |
| `MESH_TOKEN` | — | Capability token for CLI/bridge (`mesh token <actor>`) |
| `MESH_APPROVED` | — | `1` allows approval-gated commands in `mesh run` after human review |
| `MESH_VCS` | `auto` | Snapshot backend: `git` \| `jj` \| `sqlite` \| `off` |
| `MESH_HUB` | `http://localhost:7777` | Hub URL for CLI/bridge/TUI |

## `policy.yaml` (created by `mesh up`, enforced at the boundary)
`paths.protected` (approve-and-pair) / `paths.generated` (mesh-owned, hard-leased),
`blast_radius` (max files / deleted lines per changeset), `commands.deny` /
`commands.require_approval`, `network.egress_allow`, `budgets.per_lane`
(tokens, wall minutes), `landing.default` + `landing.auto` (auto-land paths).

## Tokens
`mesh token <actor> [--ttl 8]` → `{actor, scope, exp}` signed by the hub key.
Default scope covers intents, presence, requests, pins, decisions, board, voice.
Scope `*` = admin (mint sparingly). Verify: hub checks signature → expiry → actor
binding → scope, in that order (401 vs 403).
