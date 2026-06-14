#!/usr/bin/env bash
# camoufox-js service tester — convenience wrapper.
#
# Mirrors camoufox/service-tester/run_tests.sh: handles install + build of
# the parent camoufox-js package, the local service-tester package, and
# downloads the camoufox browser binary if not already cached.
#
# Usage:
#   ./run_tests.sh [options]
#
# Forwards every option to dist/run_tests.js — see --help there.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# 1. Build camoufox-js (../). Required because run_tests imports from ../../dist.
if [[ ! -f "$PARENT_DIR/dist/index.js" ]]; then
    echo "==> Building camoufox-js (parent package)..."
    (cd "$PARENT_DIR" && pnpm install --silent && pnpm build)
fi

# 2. Install service-tester deps (esbuild + impit + playwright-core).
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
    echo "==> Installing service-tester dependencies..."
    pnpm install --silent
fi

# 3. Compile run_tests.ts → dist/.
if [[ ! -f "$SCRIPT_DIR/dist/run_tests.js" || -n "$(find src -name '*.ts' -newer dist/run_tests.js -print -quit 2>/dev/null)" ]]; then
    echo "==> Building service-tester..."
    pnpm build >/dev/null
fi

# 4. Ensure the camoufox browser binary is available. The TS API
#    (`Camoufox()`) auto-downloads on first launch, but doing it eagerly
#    here gives a clear progress message before the parallel browsers
#    spawn in the runner.
if ! find "$HOME/.cache/camoufox-v"* -maxdepth 1 -name camoufox -executable 2>/dev/null | grep -q .; then
    echo "==> Fetching camoufox browser binary..."
    node -e "import('$PARENT_DIR/dist/pkgman.js').then(m => m.camoufoxPath(true))" \
        || { echo "ERROR: failed to fetch camoufox binary" >&2; exit 1; }
fi

# 5. Run.
exec node dist/run_tests.js "$@"
