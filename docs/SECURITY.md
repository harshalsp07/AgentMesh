# Security — threat model, controls, and what is *actually* enforced

> **Read this before exposing the hub to a network.** Every row below names the code that
> implements it. Rows marked **planned** are in `docs/PRODUCTION_PLAN.md`, not shipped.
> `test/hardening.test.mjs` and `test/trust.test.mjs` assert the shipped rows.

## 1. The trust model in one paragraph

AgentMesh assumes **agents are semi-trusted**: they may be buggy, confused, or prompt-injected.
A network stranger is **untrusted**. A human operator is **trusted** but may be absent. The hub
therefore treats an agent's *messages* as data and an agent's *assertions* as unverified, while
making an agent's *actions* attributable and revocable. The hub is a protocol kernel, not a
supervisor: it enforces mechanical invariants (leases, dependency order, quorum, fences) and leaves
judgement to humans and to the verification harness.

## 2. Controls

| Threat | Control | Where | Status |
|---|---|---|---|
| Network stranger writes state | **Fail-closed bind**: a non-loopback bind without auth refuses to start (exit 78) | `hub.mjs` boot check | ✅ shipped |
| Network stranger writes state | ed25519 capability tokens on **every** write route; actor-bound; scoped; 8 h TTL | `src/auth.mjs`, hub `guard()` | ✅ shipped |
| Unauthenticated write routes | `/api/crdt`, `/api/macp`, `/api/dag`, `/api/p2p` POST and `/a2a/rpc` are guarded (they were open) | `src/hub.mjs` | ✅ shipped |
| Event-stream leak | `/events` requires a token when auth is enforced (the stream carries intent paths, task text and pins) | `src/hub.mjs` | ✅ shipped |
| Impersonation | Token actor must equal the body actor (403 otherwise) | hub `checkAuth()` | ✅ shipped |
| Lease hijack | **Intent ids are server-assigned**; a client-supplied `payload.id` is ignored | `src/hub.mjs` | ✅ shipped |
| Lease denial-of-service | A hard lease (which blocks peers) requires the `lease.hard` scope | `src/hub.mjs`, `src/auth.mjs` | ✅ shipped |
| Privilege creep | Per-capability scopes + prefix wildcards (`tasks.*`); the default set is enumerated in `src/auth.mjs` | `src/auth.mjs` | ✅ shipped |
| Leaked capability | `jti` revocation list (`.mesh/auth/revoked.json`) checked on every verification | `src/auth.mjs` | ✅ shipped |
| Destructive shell | Deny-list + approval shims on `PATH`; the real binary never execs on deny (exit 126/125) | `src/shims.mjs`, `mesh run` | ✅ shipped |
| Secret leakage | T0 secret scan + redaction; secrets excluded from snapshot manifests | `src/harness.mjs`, `src/store.mjs` | ✅ shipped |
| Log tampering | SQLite + hash chain, `/verify`; `user_version` migrations; `synchronous=FULL` | `src/db.mjs` | ✅ shipped |
| Silent event loss | Unbounded log replay + `dbMaxSeq` recovery (the old 100 k cap dropped events) | `src/db.mjs`, `src/hub.mjs` | ✅ shipped |
| Write corruption under concurrency | Durable atomic writes: unique scratch file, `fsync`, rename with Windows retry | `src/store.mjs` | ✅ shipped |
| MCP client confusion | JSON-RPC compliant error codes; tool failures carry `isError: true`; per-call timeouts | `src/bridge.mjs` | ✅ shipped |
| Runaway agent | 100 writes/min/actor (429), 1 MB bodies (413), per-lane budgets, retry cap 3 | hub guards, `src/policy.mjs` | ✅ shipped |
| Prompt injection between agents | Agent messages are data, never authority. Approvals are **planned** as out-of-band, signed, per-task, revocable artefacts | `docs/PRODUCTION_PLAN.md` §Phase 4 | 🟡 planned |
| Credential reach from a lane | **Planned**: tokens never enter a lane or tool payload; a proxy fetches on the agent's behalf | Phase 4 | 🟡 planned |
| Policy that does not apply | **Planned**: real YAML + enforced `blast_radius`, `egress_allow`, `generated`, `budgets.per_lane` (the shipped `templates/policy.yaml` is largely ignored today) | Phase 3 | 🔴 open |
| Stale standby writing | **Planned**: real epoch fencing on every write (the epoch is currently stamped, never checked) | Phase 4 | 🔴 open |
| Multi-tenant bleed | **Planned**: rooms as tenant boundaries | Phase 4 | 🔴 open |

## 3. Scope reference

`mesh token <actor>` mints a token with the default scope set:

```
intent.declare  intent.release  presence   request   pin      decision
board            voice           tasks      bot       memory   audit
build            lease.hard      crdt       macp      dag      p2p
```

- `*` grants everything — mint sparingly.
- `tasks.*` grants `tasks` and any `tasks.<sub>`.
- `build` is required by `mesh build` / `mesh_build_status`.
- `lease.hard` is required to take a hard lease that blocks peers.
- `crdt` / `macp` / `dag` / `p2p` gate the four sync write surfaces.

Verification order is **signature → expiry → revocation → actor binding → scope** (401 vs 403).

## 4. Key rotation and revocation

```bash
mesh keygen --rotate          # new keypair; the old pair is archived as hub-rotated-<ts>.*
mesh token <actor>            # reissue (old tokens stop verifying)
mesh audit export --out a.json # Merkle-rooted, hash-chained bundle
```

> **Honest limitation:** rotation regenerates the keypair, so **every outstanding token stops
> verifying immediately** — there is no dual-pubkey grace window yet. Plan one before you need it
> (Phase 1/5). Revocation is by `jti` and is instant; the list is a JSON file read on every
> verification (a SQLite table with an index is scheduled).

## 5. Secret purge (explicit, human-only)

Snapshots are immutable by design, so purging is a deliberate act: `mesh audit <path>` to find
holders, rotate the secret at the source, then delete the `.mesh/snapshots/**` copies containing it
and run `mesh vcs fsck`. Document the purge in the decision log (`mesh decide record`).

## 6. Running the hub safely

```bash
mesh up                          # creates keys -> auth is enforced from here on
node src/hub.mjs                 # loopback only (default)
MESH_HOST=0.0.0.0 node src/hub.mjs   # LAN: allowed, because keys now exist
```

If you bind to a LAN interface **without** keys, the hub exits 78 and prints the three ways to fix
it. `MESH_INSECURE=1` is the explicit opt-out for a trusted network; it prints a warning on every
start. **Do not use it on a network you do not control.**
