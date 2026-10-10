#!/bin/bash
# install.sh — zero-dependency install: checks runtime, prepares a room, prints next steps.
set -e
command -v node >/dev/null || { echo "node >= 22 required (https://nodejs.org)"; exit 1; }
NODEV=$(node -p "process.versions.node.split('.')[0]")
[ "$NODEV" -ge 22 ] || { echo "node >= 22 required, found $(node -v)"; exit 1; }
command -v git >/dev/null && echo "git: $(git --version)" || echo "git: missing (sqlite backend will be used)"
ROOT="${MESH_DIR:-.mesh}"
node src/mesh.mjs up --root "$ROOT"
echo ""
echo "Next:"
echo "  MESH_DIR=$ROOT node src/hub.mjs &      # start the hub"
echo "  node src/mesh.mjs token <you> --root $ROOT   # capability token (8h)"
echo "  open http://localhost:7777/canvas"
echo "  MESH_TOKEN=<token> node src/mesh.mjs overview --root $ROOT"
