#!/bin/bash
set -e
prism_root="$(cd "$(dirname "$0")" && pwd)"
cd "$prism_root"

# Use a normal Node 24 installation, or the existing Codex-managed runtime on this Mac.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" != 24 ] || ! command -v pnpm >/dev/null 2>&1; then
  prism_runtime="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
  if [ -x "$prism_runtime/node/bin/node" ]; then
    export PATH="$prism_runtime/node/bin:$prism_runtime/bin/fallback:$PATH"
  fi
fi
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" != 24 ] || ! command -v pnpm >/dev/null 2>&1; then
  echo 'PRISM requires Node.js 24 and pnpm 11. Install them, then run this launcher again.'
  exit 1
fi
if [ ! -d node_modules ]; then
  pnpm install --frozen-lockfile
fi
export PRISM_OPEN_BROWSER="${PRISM_OPEN_BROWSER:-1}"
exec node scripts/dev.mjs
