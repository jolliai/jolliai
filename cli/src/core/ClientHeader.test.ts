/**
 * Tests for `ClientHeader` — the bundler-injected `x-jolli-client` header.
 *
 * The vitest config (`vite.config.ts`) provides `__JOLLI_CLIENT_KIND__` /
 * `__PKG_VERSION__` via `define:` exactly as the production CLI / VSCode
 * bundles do, so the constant resolves to `<kind>/<version>` at test time
 * just like in production. The "cli/dev" unbundled fallback is annotated
 * with `v8 ignore`.
 */

import { describe, expect, it } from "vitest";
import { isClaudePluginBuild, JOLLI_CLIENT_HEADER, resolveClientKind } from "./ClientHeader.js";

describe("JOLLI_CLIENT_HEADER", () => {
	it("resolves to <kind>/<version> from bundler-injected globals", () => {
		// Format is `<kind>/<version>` with kind matching the build's
		// `__JOLLI_CLIENT_KIND__` definition. Don't pin the exact version
		// (it bumps every release) — pin the shape and the kind prefix.
		expect(JOLLI_CLIENT_HEADER).toMatch(/^cli\/.+/);
		expect(JOLLI_CLIENT_HEADER).not.toBe("cli/dev");
	});
});

describe("resolveClientKind", () => {
	it("returns the bundler-defined kind (cli in the CLI build / vitest)", () => {
		expect(resolveClientKind()).toBe("cli");
	});
});

describe("isClaudePluginBuild", () => {
	it("returns false in the CLI build / vitest", () => {
		expect(isClaudePluginBuild()).toBe(false);
	});
});
