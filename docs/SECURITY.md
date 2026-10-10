# Security — threat model → controls (all implemented, all tested)

| Threat | Control | Where |
|---|---|---|
| Rogue / hijacked agent | Capability tokens: ed25519, actor-bound, scoped, 8 h expiry; owner approval for `@agent` requests | `src/auth.mjs`, hub `guard()`, `test/prod.test.mjs` |
| Impersonation | Token actor must equal body actor (403 otherwise) | hub `checkAuth()` |
| Destructive shell | Deny-list + approval shims on PATH; real binary never execs on deny (exit 126/125) | `src/shims.mjs`, `mesh run` |
| Malicious dependency | Steward flow (`mesh dep`), scratch-dir resolve, egress allowlist | `src/drivers.mjs`, `src/policy.mjs` |
| Secret leakage | T0 secret scan + bus redaction; secrets live in VM tmpfs/env, excluded from snapshots manifest | `src/harness.mjs`, `src/store.mjs` |
| Prompt injection | Messages are data; only approved addressed `request`s cause work; provenance tags | `src/bus.mjs` |
| Log tampering | SQLite + hash chain, `/verify`; bundles replicated to standby/host | `src/db.mjs`, hub `/verify` |
| DoS / runaway agent | 100 writes/min/actor (429), 1 MB bodies (413), per-lane budgets, retry cap 3, circuit breaker 20/min | hub guards, `src/policy.mjs`, `src/bus.mjs` |
| Network stranger | Short-lived room tokens + fingerprint (`mesh up` prints `MESH-KEY:…`); mTLS/WireGuard overlay for LAN; hub warns on non-loopback without auth | `mesh up`, hub boot check |
| Stale hub writes | Epoch persisted in SQLite; `MESH_EPOCH` fencing; standby promoted under epoch+1 | hub boot, `src/failover.mjs` |

## Key rotation
`mesh keygen` writes fresh `keys/hub.*` (back up the old `.key` first if you need a grace window); reissue tokens (`mesh token …`); restart hub. Revocation = stop issuing + restart (tokens are stateless, max 8 h life).

## Secret purge (explicit, human-only)
Snapshots are immutable by design, so purging is a deliberate act: `mesh audit <path>` to find holders, rotate the secret at the source, then delete the `.mesh/snapshots/**` copies containing it and run `mesh vcs fsck`. Document the purge in the decision log (`mesh decide record`).
