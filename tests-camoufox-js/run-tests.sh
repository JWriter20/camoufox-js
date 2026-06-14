#!/usr/bin/env bash
# camoufox-js test runner.
#
# Pulls microsoft/playwright at the tag matching the installed
# playwright-core package, then runs both that upstream suite and our
# camoufox-js-specific tests against the Camoufox binary.
#
# Usage:
#   ./run-tests.sh --executable-path /path/to/camoufox [options]
#
# Options:
#   --executable-path PATH    Path to Camoufox binary (required unless
#                             CAMOUFOX_EXECUTABLE_PATH is set)
#   --headful                 Disable headless mode (needs DISPLAY or xvfb-run)
#   --camoufox-only           Skip the upstream Playwright suite, only run
#                             tests-camoufox-js/*.test.ts via vitest
#   --upstream-only           Skip the camoufox-js-specific tests, only run
#                             upstream microsoft/playwright suite
#   -g EXPR                   Forwarded to `playwright test --grep`
#   -j N                      Worker count (forwarded as --workers, default: 4)
#   --                        Anything after `--` is forwarded verbatim to
#                             `playwright test` (upstream) and `vitest` (ours)
#   --help                    Show this message
#
# Environment:
#   CAMOUFOX_EXECUTABLE_PATH  Same as --executable-path
#   PLAYWRIGHT_TAG            Override the upstream tag (default: derived
#                             from installed playwright-core)
#   UPSTREAM_CACHE_DIR        Where to store the cloned upstream
#                             (default: tests-camoufox-js/.upstream-cache)
#   PWTEST_REPORTER           Override the upstream reporter (default: list)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------- arg parsing ----------
EXEC_PATH="${CAMOUFOX_EXECUTABLE_PATH:-}"
HEADFUL=0
CAMOUFOX_ONLY=0
UPSTREAM_ONLY=0
GREP=""
WORKERS="${PWTEST_WORKERS:-4}"
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --executable-path)
            EXEC_PATH="$2"; shift 2 ;;
        --headful)
            HEADFUL=1; shift ;;
        --camoufox-only)
            CAMOUFOX_ONLY=1; shift ;;
        --upstream-only)
            UPSTREAM_ONLY=1; shift ;;
        -g|--grep)
            GREP="$2"; shift 2 ;;
        -j|--workers)
            WORKERS="$2"; shift 2 ;;
        --)
            shift; PASSTHROUGH+=("$@"); break ;;
        --help|-h)
            sed -n '2,/^set -/p' "$0" | sed 's/^# \?//; /^set -/d'
            exit 0 ;;
        *)
            PASSTHROUGH+=("$1"); shift ;;
    esac
done

if [[ -z "$EXEC_PATH" ]]; then
    echo "ERROR: --executable-path required (or set CAMOUFOX_EXECUTABLE_PATH)" >&2
    exit 1
fi
if [[ ! -x "$EXEC_PATH" ]]; then
    echo "ERROR: $EXEC_PATH is not an executable" >&2
    exit 1
fi
EXEC_PATH="$(cd "$(dirname "$EXEC_PATH")" && pwd)/$(basename "$EXEC_PATH")"
export CAMOUFOX_EXECUTABLE_PATH="$EXEC_PATH"
# Upstream's tests/library/playwright.config.ts already reads FFPATH and
# wires it into firefox launchOptions.executablePath — no fork patching
# of the upstream config needed.
export FFPATH="$EXEC_PATH"

PARENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------- resolve upstream tag ----------
TAG="${PLAYWRIGHT_TAG:-}"
if [[ -z "$TAG" ]]; then
    PLAYWRIGHT_CORE_PKG="$PARENT_DIR/node_modules/playwright-core/package.json"
    if [[ ! -f "$PLAYWRIGHT_CORE_PKG" ]]; then
        echo "ERROR: $PLAYWRIGHT_CORE_PKG not found. Run \`pnpm install\` first." >&2
        exit 1
    fi
    VERSION=$(node -p "require('$PLAYWRIGHT_CORE_PKG').version")
    TAG="v$VERSION"
fi
echo "==> Targeting upstream microsoft/playwright@$TAG"

CACHE_DIR="${UPSTREAM_CACHE_DIR:-$SCRIPT_DIR/.upstream-cache}"
UPSTREAM_DIR="$CACHE_DIR/$TAG"
if [[ ! -d "$UPSTREAM_DIR/node_modules" || ! -f "$UPSTREAM_DIR/packages/playwright/lib/program.js" ]]; then
    echo "==> Upstream cache missing or incomplete; running setup.sh..."
    bash "$SCRIPT_DIR/setup.sh"
fi

# ---------- assemble known-failures grep-invert ----------
# Each non-empty, non-comment line is treated as a literal title fragment.
# We OR them into a single ECMAScript regex passed to --grep-invert.
KF_FILE="$SCRIPT_DIR/known-failures-$TAG.txt"
GREP_INVERT=""
if [[ -f "$KF_FILE" ]]; then
    PATTERNS=()
    while IFS= read -r line; do
        line="${line%%#*}"
        # trim trailing whitespace
        line="${line%"${line##*[![:space:]]}"}"
        # trim leading whitespace
        line="${line#"${line%%[![:space:]]*}"}"
        [[ -z "$line" ]] && continue
        # Escape regex metacharacters so each line is treated as a literal.
        escaped=$(node -e 'process.stdout.write(process.argv[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))' "$line")
        PATTERNS+=("$escaped")
    done < "$KF_FILE"
    if (( ${#PATTERNS[@]} > 0 )); then
        # Join with | for alternation.
        GREP_INVERT=$(IFS='|'; echo "${PATTERNS[*]}")
    fi
fi

# ---------- run upstream Playwright suite ----------
UPSTREAM_RC=0
if [[ $CAMOUFOX_ONLY -eq 0 ]]; then
    echo "==> Running upstream Playwright suite against Camoufox..."
    UPSTREAM_ARGS=(
        test
        --config=tests/library/playwright.config.ts
        --project=firefox-library
        --project=firefox-page
        --workers="$WORKERS"
        --reporter="${PWTEST_REPORTER:-list}"
        # Upstream's CI uses retries=3 to mask network/timing flakes; mirror that.
        --retries=3
    )
    if [[ -n "$GREP" ]]; then
        UPSTREAM_ARGS+=(--grep "$GREP")
    fi
    if [[ -n "$GREP_INVERT" ]]; then
        UPSTREAM_ARGS+=(--grep-invert "$GREP_INVERT")
    fi
    if [[ $HEADFUL -eq 1 ]]; then
        UPSTREAM_ARGS+=(--headed)
    fi
    UPSTREAM_ARGS+=("${PASSTHROUGH[@]}")

    # Disable browser auto-downloads inside the upstream tree at run time too,
    # in case any test triggers a download via the test runner's own logic.
    # Invoke packages/playwright/cli.js directly — the workspace's
    # node_modules/.bin/playwright is bound to @playwright/experimental-ct-react,
    # not to the main test runner. (Inside the upstream repo, npm scripts work
    # because npm resolves `playwright` against the workspace package; from
    # outside the repo we go straight to the cli.js path.)
    #
    # NODE_OPTIONS=--require=...camoufox-fixture.cjs monkey-patches
    # BrowserType.prototype.launch in every worker so firefox.launch(...)
    # calls flow through camoufox-js's launchOptions() — which generates a
    # firefox-only fingerprint via fingerprint-generator and injects the
    # stock Firefox UA / fonts / screen / etc. into the spawn config. Same
    # spoofing pipeline real consumers use; without this, upstream tests
    # would see the binary's compile-time UA token "Camoufox/<v>".
    if [[ ! -d "$PARENT_DIR/dist" ]]; then
        echo "==> camoufox-js dist/ missing; running pnpm build..." >&2
        (cd "$PARENT_DIR" && pnpm build) || { echo "build failed"; exit 1; }
    fi
    FIXTURE_PATH="$SCRIPT_DIR/camoufox-fixture.cjs"
    pushd "$UPSTREAM_DIR" >/dev/null
    CAMOUFOX_JS_DIST="$PARENT_DIR/dist" \
    NODE_OPTIONS="--require=$FIXTURE_PATH ${NODE_OPTIONS:-}" \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
        node packages/playwright/cli.js "${UPSTREAM_ARGS[@]}" \
        || UPSTREAM_RC=$?
    popd >/dev/null
fi

# ---------- run camoufox-js-specific tests ----------
CF_RC=0
if [[ $UPSTREAM_ONLY -eq 0 ]]; then
    echo "==> Running camoufox-js-specific tests..."
    VITEST_ARGS=(run --config "$SCRIPT_DIR/vitest.config.ts")
    if [[ -n "$GREP" ]]; then
        VITEST_ARGS+=(-t "$GREP")
    fi
    VITEST_ARGS+=("${PASSTHROUGH[@]}")
    (
        cd "$SCRIPT_DIR"
        pnpm exec vitest "${VITEST_ARGS[@]}"
    ) || CF_RC=$?
fi

# ---------- exit code ----------
if [[ $UPSTREAM_RC -ne 0 || $CF_RC -ne 0 ]]; then
    echo "FAILED — upstream rc=$UPSTREAM_RC, camoufox-js rc=$CF_RC"
    exit 1
fi
echo "OK"
