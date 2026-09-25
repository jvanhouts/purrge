#!/usr/bin/env bash
# Manage the `purrge` on your PATH.
#
#   bun run cli update  → point `purrge` at this working tree, so edits apply at once
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"

case "${1:-}" in
  update)
    # A global install (e.g. from GitHub) would win again on the next `bun add -g`.
    if [ -e "${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/purrge" ]; then
      echo "→ removing the global purrge install"
      bun remove -g purrge >/dev/null
    fi
    chmod +x "$REPO/src/index.ts"
    mkdir -p "$BIN_DIR"
    ln -sfn "$REPO/src/index.ts" "$BIN_DIR/purrge"
    echo "✓ purrge → $REPO/src/index.ts (v$("$BIN_DIR/purrge" --version))"
    ;;
  *)
    echo "usage: bun run cli update" >&2
    exit 1
    ;;
esac
