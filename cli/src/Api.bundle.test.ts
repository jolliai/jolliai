/// <reference types="node" />
/**
 * Regression guard for the `parseJolliApiKey` / `parseBaseUrl` re-export
 * pattern in {@link Api.ts}.
 *
 * Vite's lib-mode tree-shaker drops pure `export { … } from "…"` re-exports
 * from the entry bundle when nothing inside the entry consumes them. The
 * current source goes through an `import` binding + a named `export const`
 * to defeat that, but if a future Vite/Rollup upgrade restores the old
 * elision behavior or otherwise drops the names from `dist/Api.js`, the
 * only place that would fail is the downstream plugins that import
 * `@jolli.ai/cli`. This test catches that drift at the host's CI boundary
 * by inspecting the actual built bundle.
 *
 * Skipped automatically when `dist/Api.js` is absent (e.g. during
 * `vitest --watch` before a build has run).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Test file is at cli/src/Api.bundle.test.ts; bundle is at cli/dist/Api.js.
const distPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "Api.js");
const distContent = ((): string | null => {
	try {
		return readFileSync(distPath, "utf-8");
	} catch {
		return null;
	}
})();

describe("Api.js bundle", () => {
	it.skipIf(distContent === null)("exposes parseJolliApiKey as a named export", () => {
		// Minified ESM may rename internals (parseJolliApiKey$1, etc.) but the
		// public export object MUST contain the original name. The closing
		// `export { … }` block of the bundle is the authoritative surface.
		expect(distContent).toMatch(/\bparseJolliApiKey\b/u);
	});

	it.skipIf(distContent === null)("exposes parseBaseUrl as a named export", () => {
		expect(distContent).toMatch(/\bparseBaseUrl\b/u);
	});

	it.skipIf(distContent === null)("declares both helpers in the final `export { … }` block", () => {
		// Belt-and-suspenders: not only do the names appear somewhere in the
		// bundle, they're listed in a closing export object. This catches the
		// case where Vite emits the identifier internally but omits it from
		// the public surface — exactly the regression the workaround in
		// Api.ts is guarding against.
		// Match e.g. `export { … parseBaseUrl … parseJolliApiKey … }` (any order,
		// any internal aliasing like `parseJolliApiKey$1 as parseJolliApiKey`).
		const exportBlock = /export\s*\{[^}]*\bparseJolliApiKey\b[^}]*\}/u;
		const exportBlockAlt = /export\s*\{[^}]*\bparseBaseUrl\b[^}]*\}/u;
		expect(distContent).toMatch(exportBlock);
		expect(distContent).toMatch(exportBlockAlt);
	});

	it.skipIf(distContent === null)(
		"exposes parseJolliApiKey and parseBaseUrl as callable functions (subprocess import)",
		() => {
			// End-to-end check: a clean Node process actually dynamic-imports the
			// built bundle and confirms both exports resolve to functions at
			// runtime. Source-text greps above catch tree-shaking regressions;
			// this catches the subtler case where the name is emitted but bound
			// to `undefined` (or anything non-callable).
			const distUrl = pathToFileURL(distPath).href;
			const script = `import(${JSON.stringify(distUrl)})
				.then((m) => {
					const ok = typeof m.parseJolliApiKey === "function" && typeof m.parseBaseUrl === "function";
					process.exit(ok ? 0 : 1);
				})
				.catch((err) => {
					process.stderr.write(String(err && err.stack ? err.stack : err));
					process.exit(2);
				});`;
			// JOLLI_DISABLE_LOG_FILE is the dedicated stable contract Logger
			// reads to short-circuit its write queue. We use it here rather
			// than VITEST so this regression probe doesn't depend on Logger
			// keeping its VITEST check — a Logger refactor that drops the
			// VITEST short-circuit must not start writing debug.log lines
			// from a subprocess that's only meant to validate bundle exports.
			const result = spawnSync(process.execPath, ["-e", script], {
				encoding: "utf-8",
				timeout: 15000,
				env: { ...process.env, JOLLI_DISABLE_LOG_FILE: "1" },
			});
			if (result.status !== 0) {
				// Surface child stderr/stdout so a failure here is debuggable.
				throw new Error(
					`subprocess exit=${result.status} signal=${result.signal}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
				);
			}
			expect(result.status).toBe(0);
		},
		20000,
	);
});
