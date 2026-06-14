import { defineConfig } from "vitest/config";

// Scope vitest to camoufox-js's own *.test.ts files only.
// Without this, vitest's default glob matches *.spec.ts inside the upstream
// playwright clone at .upstream-cache/v<TAG>/tests/, which fails with
// transform errors (those specs use upstream's monorepo tsconfig + the
// @playwright/test runner, not vitest).
export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		exclude: ["**/.upstream-cache/**", "**/node_modules/**"],
	},
});
