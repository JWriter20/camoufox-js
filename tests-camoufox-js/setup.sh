#!/usr/bin/env bash
# Set up the upstream microsoft/playwright clone used by run-tests.sh.
#
# Two layers of deps:
#   1. The camoufox-js package's own `playwright-core` pin (driven by
#      `package.json` in the parent directory). That version is the single
#      source of truth — it determines which upstream tag we clone, and
#      which protocol surface we test against.
#   2. The full devDeps of microsoft/playwright at that tag. Upstream's
#      spec files import from `tests/config/`, `@playwright/test`, etc.;
#      the only reliable way to satisfy those imports is to `npm ci` in
#      the upstream tree. Browser downloads are skipped — we run firefox
#      via FFPATH=<camoufox-binary>.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------- resolve the upstream tag from installed playwright-core ----------
TAG="${PLAYWRIGHT_TAG:-}"
if [[ -z "$TAG" ]]; then
    PARENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    PLAYWRIGHT_CORE_PKG="$PARENT_DIR/node_modules/playwright-core/package.json"
    if [[ ! -f "$PLAYWRIGHT_CORE_PKG" ]]; then
        echo "ERROR: $PLAYWRIGHT_CORE_PKG not found." >&2
        echo "Run \`pnpm install\` in $PARENT_DIR first." >&2
        exit 1
    fi
    VERSION=$(node -p "require('$PLAYWRIGHT_CORE_PKG').version")
    TAG="v$VERSION"
fi
echo "==> Targeting upstream microsoft/playwright@$TAG"

# ---------- clone upstream ----------
CACHE_DIR="${UPSTREAM_CACHE_DIR:-$SCRIPT_DIR/.upstream-cache}"
UPSTREAM_DIR="$CACHE_DIR/$TAG"
FRESH_CLONE=0
if [[ ! -d "$UPSTREAM_DIR/tests/library" ]]; then
    echo "==> Fetching upstream microsoft/playwright@$TAG into $UPSTREAM_DIR..."
    rm -rf "$UPSTREAM_DIR"
    mkdir -p "$UPSTREAM_DIR"
    curl -sL "https://api.github.com/repos/microsoft/playwright/tarball/$TAG" \
        | tar -xz --strip-components=1 -C "$UPSTREAM_DIR"
    if [[ ! -d "$UPSTREAM_DIR/tests/library" ]]; then
        echo "ERROR: upstream tarball did not contain tests/library/" >&2
        exit 1
    fi
    FRESH_CLONE=1
else
    echo "==> Using cached upstream at $UPSTREAM_DIR"
fi

# ---------- apply our patches to upstream test sources ----------
# Patches in upstream-patches/v<TAG>/*.patch are applied with -p1 from
# inside $UPSTREAM_DIR. They rewrite specific upstream specs to match
# Camoufox's stealth-by-design surface (e.g. navigator.webdriver=false)
# so the tests run as real green assertions instead of being deselected
# via known-failures-v<TAG>.txt. Applied only on a fresh clone — patches
# are baked into the cache after that, so re-running setup.sh is cheap.
PATCH_DIR="$SCRIPT_DIR/upstream-patches/$TAG"
if [[ $FRESH_CLONE -eq 1 && -d "$PATCH_DIR" ]]; then
    echo "==> Applying upstream-patches/$TAG/*.patch..."
    for patch in "$PATCH_DIR"/*.patch; do
        [[ -f "$patch" ]] || continue
        echo "    - $(basename "$patch")"
        (cd "$UPSTREAM_DIR" && patch -p1 --no-backup-if-mismatch < "$patch") \
            || { echo "ERROR: failed to apply $patch" >&2; exit 1; }
    done
elif [[ -d "$PATCH_DIR" ]]; then
    echo "==> Patches in $PATCH_DIR already applied (cache reused)."
fi

# ---------- install upstream devDeps ----------
# Skip browser downloads — upstream's postinstall would otherwise fetch
# Chromium/WebKit/Firefox builds we don't run. Tests targeted at firefox
# pick up the camoufox binary via FFPATH at run time.
if [[ ! -d "$UPSTREAM_DIR/node_modules" ]]; then
    echo "==> Installing upstream devDeps (this is large; one-time per tag)..."
    (
        cd "$UPSTREAM_DIR"
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
        PLAYWRIGHT_SKIP_BROWSER_GC=1 \
            npm ci --no-audit --no-fund --prefer-offline
    )
else
    echo "==> Upstream devDeps already installed in $UPSTREAM_DIR/node_modules"
fi

# ---------- build upstream packages ----------
# packages/playwright/cli.js requires ./lib/program, which is generated
# by `npm run build` (transpiles TS sources in src/ → lib/). Without this
# step the test runner fails to load.
if [[ ! -f "$UPSTREAM_DIR/packages/playwright/lib/program.js" ]]; then
    echo "==> Building upstream packages (transpiling TS → lib/)..."
    (
        cd "$UPSTREAM_DIR"
        npm run build
    )
else
    echo "==> Upstream packages already built"
fi

echo "==> Setup complete. Run ./run-tests.sh --executable-path /path/to/camoufox"
