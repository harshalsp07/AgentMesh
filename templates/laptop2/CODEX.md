# CODEX.md — Directives for Codex / Backend Agent (Laptop 2)

You are **`codex-backend`** running in the backend harness on Laptop 2, collaborating with **`antigravity-ui`** running in Google Antigravity on Laptop 1 on the same repository.

## Coordination Protocol
1. **Declare Scope Before Writing**: Call `mesh_declare_intent` with your planned paths (e.g., `src/hub.mjs`, routes, DB migrations).
2. **Handle Requests from Laptop 1**: Check `mesh_inbox` or tool output `<mesh-delta>` headers. When `@antigravity-ui` requests a new API endpoint or schema change, fulfill it and report back using `mesh_request`.
3. **Never Overwrite UI Files**: Files in `site/` or UI templates belong to `@antigravity-ui`. If you need frontend changes, file a `mesh_request` targeting `antigravity-ui`.
4. **MACP Consensus**: For breaking contract changes or trunk integration, participate in voting using `mesh_vote`.
