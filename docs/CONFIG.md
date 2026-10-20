# Config — every knob in one place

## Env vars (hub + CLI + MCP bridge)

| Var | Default | Meaning |
|---|---|---|
| `MESH_DIR` | `.mesh` | Room state dir (db, logs, lanes, keys, shims) |
| `MESH_PORT` | `7777` | Hub HTTP port |
| `MESH_HOST` | `127.0.0.1` | Bind address. A non-loopback bind **requires** auth — the hub refuses to start (exit 78) otherwise |
| `MESH_INSECURE` | unset | `1` allows an unauthenticated non-loopback bind (trusted LAN only; warns on every start) |
| `MESH_AUTH` | off unless keys exist | `1` forces token auth even before keys exist |
| `MESH_TOKEN` | — | Capability token for the CLI, the MCP bridge and the canvas |
| `MESH_EPOCH` | persisted, default `1` | Fencing epoch (a standby must run a higher epoch than the primary it replaces) |
| `MESH_SYNC` | `FULL` | SQLite durability: `FULL` fsyncs every event, `NORMAL` is faster but can lose the tail on power loss |
| `MESH_TIMEOUT_MS` | `15000` | Per-call timeout for every hub request made by the MCP bridge |
| `MESH_VCS` | `auto` | Snapshot backend: `git` \| `jj` \| `sqlite` \| `off` |
| `MESH_REPOS` | — | Multi-repo mesh: `name:path,name:path` |
| `MESH_HUB` | `http://localhost:7777` | Hub URL for the CLI, the bridge and the TUI |
| `MESH_ACTOR` | `agent` | Actor identity used by the bridge |
| `LIVEBLOCKS_SECRET_KEY` | — | Optional cloud presence for the tldraw board (hub ops are used when empty) |

> The hub does **not** read `.env` itself. Use `set -a; . ./.env; set +a` (or your process manager).
> See `.env.example`.

## `policy.yaml` (created by `mesh up`)

| Key | Effect |
|---|---|
| `paths.protected` | approve-and-pair before touching |
| `paths.generated` | mesh-owned, hard-leased |
| `blast_radius` | max files / deleted lines per changeset |
| `commands.deny` / `commands.require_approval` | shell policy at the `PATH` shim |
| `network.egress_allow` | outbound allowlist |
| `budgets.per_lane` | tokens and wall minutes per lane |
| `landing.default` / `landing.auto` | how changes reach the trunk |

> **Known gap (Phase 3):** the current hand-rolled YAML parser ignores inline arrays, so most of the
> shipped `templates/policy.yaml` is inert, and `blast_radius`, `egress_allow`, `generated` and
> `budgets.per_lane` are not yet enforced at the boundary. `mesh policy lint` (Phase 3) will fail CI
> on an unparseable policy.

## Tokens

`mesh token <actor> [--ttl 8]` → a signed capability token `{actor, scope, exp, jti}`.
The default scope set is listed in `docs/SECURITY.md` §3.

```bash
mesh token alice                       # default scopes
mesh token bob --scope tasks,requests  # (planned: --scope flag)
```

**Verification order:** signature → expiry → revocation → actor binding → scope (401 vs 403).

## Rooms (planned, Phase 4)

`MESH_ROOM` / `X-Mesh-Room` will scope a request to one tenant. Today there is exactly one room per
hub: one `.mesh` directory, one event store, one board, one task board.
