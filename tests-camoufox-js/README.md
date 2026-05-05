# camoufox-js Test Harness

Mirrors `camoufox/tests-camoufox/` for the JS port. camoufox-js does
**not** maintain its own copy of the Playwright test suite. Instead,
the runner pulls upstream tests from
[microsoft/playwright](https://github.com/microsoft/playwright) at the
tag matching the installed `playwright-core` package, and runs them
against the Camoufox binary. camoufox-js-specific tests live in this
directory only.

## Quick start

```bash
# One-time setup (clones upstream playwright + installs deps)
bash setup.sh

# Run upstream Playwright suite against a Camoufox binary
./run-tests.sh --executable-path /path/to/camoufox

# Skip the upstream suite, only run camoufox-js-specific tests
./run-tests.sh --executable-path /path/to/camoufox --camoufox-only

# Skip the camoufox-js-specific tests, only run upstream
./run-tests.sh --executable-path /path/to/camoufox --upstream-only
```

Add `--headful` to disable headless mode (requires a real X server or
xvfb-run); the default is headless.

## What runs

Three layers, in order, identical in spirit to `tests-camoufox/`:

1. **Upstream Playwright tests** — `microsoft/playwright` at the tag
   matching the installed `playwright-core` package. Cloned on first
   run into `.upstream-cache/v<version>/` (gitignored). These exercise
   the standard Playwright API surface: pages, frames, network,
   tracing, etc. They are the core "is this binary a working
   Firefox-with-Juggler?" check.

   Pointed at the Camoufox binary via the `FFPATH` environment
   variable, which upstream's
   `tests/library/playwright.config.ts` already reads (no fork
   patching needed). Restricted to the firefox projects via
   `--project=firefox-*`.

2. **camoufox-js-specific tests** — `*.test.ts` files in this
   directory, run via `vitest`. These cover things that *aren't* in
   upstream:
   - Stealth: launch arg vs. fingerprint conflicts (locale, UA,
     timezone, screen, hardware concurrency).
   - xvfb / virtual display launching (`headless: "virtual"`).
   - WebGL / WebRTC blocking.
   - Persistent context, custom window size, fingerprint diversity.

3. **camoufox-js fixture (`camoufox-fixture.cjs`)** — a small Node
   `--require` shim wired into the upstream run via `NODE_OPTIONS`.
   Monkey-patches `BrowserType.prototype.launch` /
   `launchPersistentContext` so every `firefox.launch(...)` flows
   through camoufox-js's own `launchOptions(...)` pipeline. That
   means the upstream suite exercises the same fingerprint-driven
   spawn path real consumers use: a firefox-only fingerprint from
   `fingerprint-generator`, with stock Firefox UA / fonts / screen /
   etc. injected via `CAMOU_CONFIG`. Without this, upstream tests
   would see the binary's compile-time UA token (`Camoufox/<v>`) and
   the `should have sane user agent`-style specs would fail.

   The fixture only patches the firefox `BrowserType`; chromium /
   webkit launches pass through untouched. It does **not** override
   `navigator.webdriver` — that's stealth-by-design (always false
   under camoufox), so any upstream test asserting webdriver=true
   stays in `known-failures-v<version>.txt`.

## Version resolution

The upstream tag is whatever the *installed* `playwright-core` package
reports as its version:

```bash
node -p "require('playwright-core/package.json').version"
# → "1.59.1"
```

To bump:
1. Edit `package.json` to upgrade `playwright-core` (and
   `local-requirements.json` here, if used).
2. Re-run `pnpm install`.
3. Re-run the suite. The runner will download
   `microsoft/playwright@v1.60.x` into a fresh cache directory.
4. Triage any new failures; if they're real Camoufox regressions add
   them to the per-version known-failures list (see below).

## Patching upstream tests (per upstream tag)

`upstream-patches/v<version>/*.patch` are unified diffs applied (with
`patch -p1`) to the cloned upstream tree on first download. Use these
to **rewrite** an upstream test whose assertion is the wrong expectation
for Camoufox's stealth surface — e.g. `navigator.webdriver=true` becomes
`=false`, since stealth-by-design always returns `false` and we want
that to be a real green assertion, not a deselect.

Workflow:
1. Identify the upstream spec + line where the assertion lives in the
   `.upstream-cache/v<version>/` clone.
2. Drop a unified diff into `upstream-patches/v<version>/<name>.patch`.
   Header lines `--- a/...` / `+++ b/...` paths are relative to the
   upstream tree root (`$UPSTREAM_DIR`).
3. `rm -rf .upstream-cache && bash setup.sh` to verify it applies.
4. Re-run the suite — the test should now pass against Camoufox.

Prefer **patching over deselecting** whenever Camoufox's behavior is
correct and upstream is asserting the wrong shape. Reserve
`known-failures-v<version>.txt` for genuine bugs and tests we can't
turn green another way.

## Known failures (per upstream tag)

`known-failures-v<version>.txt` files in this directory list tests
that are expected to fail for a given upstream tag — typically real
Camoufox bugs we haven't fixed yet, or upstream tests that depend on
Chromium/WebKit-only behaviour. The runner translates each line into
a `--grep-invert` regex pattern.

When a fix lands and a test goes green, *delete* its line from the
known-failures file rather than amending it. The list should only
shrink.

## Why we don't vendor

Same reason as the python harness: vendoring upstream specs into the
fork repo causes years of drift (assertions for removed APIs, missing
tests that lived upstream, constant `_impl` import breakage on every
upstream release). The version-pinned-clone approach gets all of that
for free in exchange for a one-time download per Playwright bump.
