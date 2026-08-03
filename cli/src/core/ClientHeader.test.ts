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
import {
	isClaudePluginBuild,
	isPluginBundleBuild,
	isPluginBundleKind,
	JOLLI_CLIENT_HEADER,
	resolveClientKind,
} from "./ClientHeader.js";

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

describe("isPluginBundleKind", () => {
	// Every plugin host must be recognized here. A host missing from this predicate
	// silently inherits standalone-CLI behavior — e.g. PluginLoader would let the
	// plugin's fixed-surface CLI scan the global npm root and warn about host-CLI
	// plugins it never uses.
	it("recognizes every embedded plugin bundle", () => {
		expect(isPluginBundleKind("claude-plugin")).toBe(true);
		expect(isPluginBundleKind("codex-plugin")).toBe(true);
	});

	it("rejects the standalone install kinds", () => {
		expect(isPluginBundleKind("cli")).toBe(false);
		expect(isPluginBundleKind("vscode-plugin")).toBe(false);
		expect(isPluginBundleKind("intellij-plugin")).toBe(false);
	});
});

describe("isPluginBundleBuild", () => {
	it("returns false in the CLI build / vitest", () => {
		expect(isPluginBundleBuild()).toBe(false);
	});
});
