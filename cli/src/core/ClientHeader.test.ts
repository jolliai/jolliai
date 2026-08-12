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
	PLUGIN_BUNDLE_KINDS,
	resolveClientKind,
} from "./ClientHeader.js";
import { PLUGIN_HOST_SOURCE_TAGS, pluginSkillInvocation } from "./localagent/PluginDefaults.js";

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
		expect(isPluginBundleKind("cursor-plugin")).toBe(true);
	});

	/*
	 * The self-maintaining half, and the reason the explicit list above is not enough.
	 *
	 * A new plugin declares its kind in its own `scripts/build.mjs` and nothing forces
	 * a matching entry here — the `define:` runs at bundle time, so neither `tsc` nor
	 * any existing test notices. `cursor-plugin` shipped that way: its bundle was
	 * classified as a standalone install, which let PluginLoader scan the global npm
	 * root and warn about host-CLI plugins that surface never uses.
	 *
	 * So derive the expectation from the build scripts instead of restating it: every
	 * kind any plugin build defines must be recognized, and a fourth plugin is covered
	 * the moment its build script exists.
	 */
	it("recognizes every kind the plugin build scripts actually define", async () => {
		const { readFile } = await import("node:fs/promises");
		const { dirname, join, resolve } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

		const kinds: string[] = [];
		for (const plugin of ["claude-plugin", "codex-plugin", "cursor-plugin"]) {
			const script = await readFile(join(repoRoot, plugin, "plugins", "jolli", "scripts", "build.mjs"), "utf-8");
			const match = /__JOLLI_CLIENT_KIND__:\s*JSON\.stringify\("([^"]+)"\)/u.exec(script);
			expect(match?.[1], `${plugin} build.mjs must define __JOLLI_CLIENT_KIND__`).toBeDefined();
			kinds.push(match?.[1] as string);
		}

		expect(kinds).toHaveLength(3);
		for (const kind of kinds) {
			expect(isPluginBundleKind(kind as typeof __JOLLI_CLIENT_KIND__), `${kind} not recognized`).toBe(true);
		}
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

/*
 * The two lists are duplicated ON PURPOSE — this module is a leaf the push client
 * depends on, and `PLUGIN_HOSTS` pulls in the config stack — but for a plugin BUNDLE
 * the compile-time client kind and the install source tag are the same string, and
 * that coincidence is load-bearing: `SessionStartHook` resolves both the setup
 * reminder and the recall hint by looking a CLIENT KIND up in the source-tag table.
 *
 * Nothing type-checks that (both sides are plain strings), and a miss is silent in the
 * worst way — the host still works, it just stops telling the user how to invoke its
 * own skills. That is the exact bug the table replaced: the hardcoded ladders in
 * `loginReminderText` and `formatRecallSuggestion` stopped at two hosts, so a Cursor
 * user got no setup reminder at all and a recall hint naming the bare CLI.
 */
describe("plugin bundle kinds and plugin host source tags stay in lockstep", () => {
	it("names the same set of hosts", () => {
		expect([...PLUGIN_BUNDLE_KINDS].sort()).toEqual([...PLUGIN_HOST_SOURCE_TAGS].sort());
	});

	it("resolves a skill invocation for every bundle kind", () => {
		for (const kind of PLUGIN_BUNDLE_KINDS) {
			expect(pluginSkillInvocation(kind, "init"), `${kind} has no skill invocation form`).toBeDefined();
		}
	});
});
