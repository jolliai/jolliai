/// <reference types="node" />
/**
 * Tests for {@link PluginLoader}.
 *
 * Fixtures are written to a per-test temp directory and torn down after each
 * test. Fixture packages live under the generic `@test-fixtures` scope and
 * declare a fixture-only `jolliPluginId` — never any production-scope name or
 * the real plugin's ID — so test code reads cleanly without implying anything
 * about the real plugin packages.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHelpGroup } from "./commands/HelpGroups.js";
import type { KnownPlugin } from "./KnownPlugins.js";
import { KNOWN_PLUGINS } from "./KnownPlugins.js";
import { setSilentConsole } from "./Logger.js";
import { findNodeModulesRoot, getNpmRootGlobal, inspectPlugins, loadPlugins } from "./PluginLoader.js";
import { symlinksSupported } from "./testUtils/symlinkSupport.js";

// The npm-link / symlink-layout case needs a real symlink, which requires
// SeCreateSymbolicLinkPrivilege on Windows; skip it on an unprivileged account.
const itIfSymlinks = symlinksSupported ? it : it.skip;

const FIXTURE_NAME = "@test-fixtures/example-plugin";
const FIXTURE_SCOPE = "@test-fixtures";
/** Opaque random string used as the fixture's `jolliPluginId`. Has no relation to any production ID. */
const FIXTURE_ID = "00000000-test-4f1d-9000-fixtureplgnid";

/**
 * Write a fixture plugin package into `<tempDir>/node_modules/<name>/`.
 * Returns the `node_modules` root that can be passed as `rootsOverride`.
 *
 * By default the fixture declares {@link FIXTURE_ID} as its `jolliPluginId`.
 * Pass `pluginId: null` to omit the field entirely (used to verify discovery
 * skips packages without an ID) or `pluginId: <value>` to declare a specific
 * (possibly non-string) value.
 */
async function writeFixture(
	tempDir: string,
	opts: {
		name?: string;
		version?: string;
		peerVersion?: string;
		pluginSource?: string;
		mainPath?: string;
		brokenPackageJson?: boolean;
		pluginId?: string | number | null;
	},
): Promise<string> {
	const name = opts.name ?? FIXTURE_NAME;
	const pkgDir = join(tempDir, "node_modules", name);
	await mkdir(join(pkgDir, "dist"), { recursive: true });

	if (opts.brokenPackageJson) {
		await writeFile(join(pkgDir, "package.json"), "{ not valid json", "utf-8");
	} else {
		const pkg: Record<string, unknown> = {
			name,
			version: opts.version ?? "0.1.0",
			// Critical: dynamic import of `.js` requires ESM resolution, which the
			// nearest package.json's `"type": "module"` provides.
			type: "module",
			main: opts.mainPath ?? "./dist/Plugin.js",
		};
		if (opts.pluginId === undefined) {
			pkg.jolliPluginId = FIXTURE_ID;
		} else if (opts.pluginId !== null) {
			pkg.jolliPluginId = opts.pluginId;
		}
		if (opts.peerVersion) {
			pkg.peerDependencies = { "@jolli.ai/cli": opts.peerVersion };
		}
		await writeFile(join(pkgDir, "package.json"), JSON.stringify(pkg), "utf-8");
	}

	if (opts.pluginSource !== undefined) {
		const entry = opts.mainPath ?? "./dist/Plugin.js";
		const entryPath = join(pkgDir, entry);
		await mkdir(dirname(entryPath), { recursive: true });
		await writeFile(entryPath, opts.pluginSource, "utf-8");
	}

	return join(tempDir, "node_modules");
}

describe("loadPlugins peer-range matching", () => {
	// Verifies that the move to the `semver` library accepts the full range
	// grammar, not just the caret form. Each test writes a fixture that exports
	// a single `plugin-loaded` command and asserts whether the loader attached
	// it given the peerDep declaration.
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "plugin-loader-peer-test-"));
		// Defensive: if a prior test file (e.g. Api.test.ts) ever shares a
		// worker with this one, a leaked JOLLI_NO_PLUGINS=1 would short-circuit
		// loadPlugins() at PluginLoader.ts L98 and every peer-range assertion
		// below would pass without actually exercising the loader.
		delete process.env.JOLLI_NO_PLUGINS;
		delete process.env.JOLLI_NO_PLUGIN_WARNINGS;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function loadWithPeer(peerVersion: string, cliVersion: string): Promise<boolean> {
		const root = await writeFixture(tempDir, {
			peerVersion,
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-loaded').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, cliVersion, {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		return program.commands.some((c) => c.name() === "plugin-loaded");
	}

	it("accepts caret ranges", async () => {
		expect(await loadWithPeer("^1.2.0", "1.5.3")).toBe(true);
		expect(await loadWithPeer("^1.2.0", "2.0.0")).toBe(false);
	});

	it("accepts tilde ranges", async () => {
		expect(await loadWithPeer("~1.2.0", "1.2.9")).toBe(true);
		expect(await loadWithPeer("~1.2.0", "1.3.0")).toBe(false);
	});

	it("accepts comparator ranges", async () => {
		expect(await loadWithPeer(">=1.0.0", "1.0.0")).toBe(true);
		expect(await loadWithPeer(">=1.0.0", "5.7.8")).toBe(true);
		expect(await loadWithPeer(">=2.0.0", "1.99.99")).toBe(false);
	});

	it("accepts disjunction (||) ranges", async () => {
		expect(await loadWithPeer("^1.0.0 || ^2.0.0", "1.5.0")).toBe(true);
		expect(await loadWithPeer("^1.0.0 || ^2.0.0", "2.7.3")).toBe(true);
		expect(await loadWithPeer("^1.0.0 || ^2.0.0", "3.0.0")).toBe(false);
	});

	it("accepts wildcard (*) ranges", async () => {
		expect(await loadWithPeer("*", "0.0.1")).toBe(true);
		expect(await loadWithPeer("*", "99.0.0")).toBe(true);
	});

	it("handles 0.y.z caret semantics", async () => {
		expect(await loadWithPeer("^0.100.0", "0.100.5")).toBe(true);
		expect(await loadWithPeer("^0.100.0", "0.101.0")).toBe(false);
	});

	it("rejects when the cli version is invalid", async () => {
		expect(await loadWithPeer("^1.0.0", "not-a-version")).toBe(false);
	});

	it("rejects when the range is invalid", async () => {
		// semver.satisfies returns false (does not throw) for unparseable ranges.
		expect(await loadWithPeer("not-a-range", "1.0.0")).toBe(false);
	});

	it("includes prereleases so a prerelease cli still loads ^x ranges", async () => {
		// satisfies(..., { includePrerelease: true }) allows a prerelease CLI to
		// match a non-prerelease range — useful during release-candidate testing.
		expect(await loadWithPeer("^1.0.0", "1.5.0-rc.1")).toBe(true);
	});
});

describe("loadPlugins", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "plugin-loader-test-"));
		// Mirror the peer-range block: clear both opt-out envs before each
		// test, so the loader actually runs even if an earlier file in the
		// same worker left JOLLI_NO_PLUGINS=1 behind.
		delete process.env.JOLLI_NO_PLUGINS;
		delete process.env.JOLLI_NO_PLUGIN_WARNINGS;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		delete process.env.JOLLI_NO_PLUGINS;
		delete process.env.JOLLI_NO_PLUGIN_WARNINGS;
	});

	it("loads a valid plugin and registers its commands", async () => {
		const root = await writeFixture(tempDir, {
			peerVersion: "^0.100.0",
			pluginSource: "export const register = (ctx) => { ctx.program.command('plugin-hello').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-hello")).toBeDefined();
	});

	it("silently does nothing when no fixture is present", async () => {
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [join(tempDir, "node_modules")],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("skips when peerDep does not satisfy the CLI version", async () => {
		const root = await writeFixture(tempDir, {
			peerVersion: "^99.0.0",
			pluginSource: "export const register = (ctx) => { ctx.program.command('plugin-hello').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("loads when peerDep declaration is absent", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-no-peer').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-no-peer")).toBeDefined();
	});

	it("recovers when Plugin.js throws on import", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: "throw new Error('boom from plugin top-level');",
		});
		const program = new Command();
		program.command("enable").action(() => {});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(1);
		expect(program.commands[0].name()).toBe("enable");
	});

	it("recovers when register() throws", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: "export const register = () => { throw new Error('register failed'); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("stringifies a non-Error throw from register() without losing the diagnostic", async () => {
		// Plugins are untrusted code. `throw "boom"` and `throw null` would
		// otherwise render as `(err as Error).message === undefined`, leaving
		// the operator with no signal for why the plugin was skipped.
		const root = await writeFixture(tempDir, {
			pluginSource: "export const register = () => { throw 'bare-string register failure'; };",
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				rootsOverride: [root],
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
			});
			expect(program.commands).toHaveLength(0);
			const calls = warnSpy.mock.calls.flat().join(" ");
			expect(calls).toContain("bare-string register failure");
			expect(calls).not.toContain("undefined");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("skips plugin missing the register export", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: "export const somethingElse = () => {};",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("prunes conflicting builtin commands but keeps unique ones", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				ctx.program.command('enable').action(() => {});
				ctx.program.command('plugin-unique').action(() => {});
			};`,
		});
		const program = new Command();
		program.command("enable").action(() => {});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const names = program.commands.map((c) => c.name());
		expect(names.filter((n) => n === "enable")).toHaveLength(1);
		expect(names).toContain("plugin-unique");
	});

	it("prunes conflicting addCommand() calls but keeps unique ones", async () => {
		// addCommand(cmd) is the other path Commander v13 offers for attaching
		// subcommands; it throws on duplicate name just like .command(). The
		// loader must intercept it identically. The fixture pulls the Command
		// constructor off ctx.program so it can construct freestanding subcommands
		// without needing to resolve `commander` from its temp-dir location.
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				const Cmd = ctx.program.constructor;
				ctx.program.addCommand(new Cmd("enable"));
				ctx.program.addCommand(new Cmd("plugin-via-add"));
			};`,
		});
		const program = new Command();
		program.command("enable").action(() => {});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const names = program.commands.map((c) => c.name());
		expect(names.filter((n) => n === "enable")).toHaveLength(1);
		expect(names).toContain("plugin-via-add");
	});

	it("blocks a plugin command whose primary name collides with a builtin alias", async () => {
		// Mirrors the real recall/context case: a builtin has registered
		// `recall` with alias `context`, and a plugin tries to claim `context`
		// as a primary name. Without the alias-aware guard, Commander's
		// _registerCommand would throw inside register() and the subsequent
		// `plugin-after-conflict` command would never get registered.
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				ctx.program.command('context').action(() => {});
				ctx.program.command('plugin-after-conflict').action(() => {});
			};`,
		});
		const program = new Command();
		program
			.command("recall")
			.alias("context")
			.action(() => {});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const names = program.commands.map((c) => c.name());
		expect(names).toContain("recall");
		expect(names).not.toContain("context");
		// Crucially, registration after the collision kept going:
		expect(names).toContain("plugin-after-conflict");
	});

	it("skips a plugin alias that collides with a builtin name without dropping the command", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				ctx.program.command('plugin-foo').alias('enable').action(() => {});
				ctx.program.command('plugin-after-conflict').action(() => {});
			};`,
		});
		const program = new Command();
		program.command("enable").action(() => {});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const names = program.commands.map((c) => c.name());
		expect(names).toContain("plugin-foo");
		expect(names).toContain("plugin-after-conflict");
		const fooCmd = program.commands.find((c) => c.name() === "plugin-foo");
		expect(fooCmd?.aliases()).not.toContain("enable");
	});

	it("skips a plugin alias that collides with a builtin alias", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				ctx.program.command('plugin-foo').alias('context').action(() => {});
				ctx.program.command('plugin-after-conflict').action(() => {});
			};`,
		});
		const program = new Command();
		program
			.command("recall")
			.alias("context")
			.action(() => {});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const names = program.commands.map((c) => c.name());
		expect(names).toContain("plugin-foo");
		expect(names).toContain("plugin-after-conflict");
		const fooCmd = program.commands.find((c) => c.name() === "plugin-foo");
		expect(fooCmd?.aliases()).not.toContain("context");
	});

	it("skips colliding entries inside .aliases([...]) but keeps the safe ones", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				ctx.program.command('plugin-foo').aliases(['safe-alias', 'enable']).action(() => {});
				ctx.program.command('plugin-after-conflict').action(() => {});
			};`,
		});
		const program = new Command();
		program.command("enable").action(() => {});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const names = program.commands.map((c) => c.name());
		expect(names).toContain("plugin-foo");
		expect(names).toContain("plugin-after-conflict");
		const fooCmd = program.commands.find((c) => c.name() === "plugin-foo");
		expect(fooCmd?.aliases()).toContain("safe-alias");
		expect(fooCmd?.aliases()).not.toContain("enable");
	});

	it("blocks addCommand() when the payload's aliases collide", async () => {
		// addCommand pre-checks both name and aliases — a payload whose name is
		// fine but whose alias collides must still be rejected, otherwise
		// Commander throws inside _registerCommand and the rest of register
		// stops.
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				const Cmd = ctx.program.constructor;
				const c = new Cmd('plugin-via-add');
				c.alias('enable');
				ctx.program.addCommand(c);
				ctx.program.command('plugin-after-conflict').action(() => {});
			};`,
		});
		const program = new Command();
		program.command("enable").action(() => {});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const names = program.commands.map((c) => c.name());
		expect(names).toContain("enable");
		expect(names).not.toContain("plugin-via-add");
		expect(names).toContain("plugin-after-conflict");
	});

	it("does not let an ignored conflicting command's aliases pollute the namespace", async () => {
		// `.command("enable")` collides with a builtin and is dropped entirely.
		// Aliases chained onto the dropped command must NOT leak into the
		// occupied-name set, otherwise a later legitimate `.command("safe-later")`
		// on the same plugin would be mis-flagged as a conflict and silently
		// skipped. Regression test for the throwaway-shares-occupiedNames bug.
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
					ctx.program.command('enable').alias('safe-later').action(() => {});
					ctx.program.command('safe-later').action(() => {});
					ctx.program.command('after').action(() => {});
				};`,
		});
		const program = new Command();
		program.command("enable").action(() => {});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const names = program.commands.map((c) => c.name());
		expect(names.filter((n) => n === "enable")).toHaveLength(1);
		expect(names).toContain("safe-later");
		expect(names).toContain("after");
	});

	it("blocks a later plugin command that reuses an earlier plugin command's alias", async () => {
		// Same-register self-collision: the plugin's first command claims
		// `shared-alias`; the second command would throw on the same alias if
		// occupiedNames weren't updated as the first command registered. This
		// guards against the old beforeNames snapshot's blind spot.
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				ctx.program.command('plugin-first').alias('shared-alias').action(() => {});
				ctx.program.command('plugin-second').alias('shared-alias').action(() => {});
				ctx.program.command('plugin-third').action(() => {});
			};`,
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const names = program.commands.map((c) => c.name());
		expect(names).toContain("plugin-first");
		expect(names).toContain("plugin-second");
		expect(names).toContain("plugin-third");
		const first = program.commands.find((c) => c.name() === "plugin-first");
		const second = program.commands.find((c) => c.name() === "plugin-second");
		expect(first?.aliases()).toContain("shared-alias");
		expect(second?.aliases()).not.toContain("shared-alias");
	});

	it("delegates the no-arg alias() / aliases() getters to Commander unchanged", async () => {
		// Make sure the instance-level patch on alias/aliases doesn't shadow
		// the read-only getter forms — plugins (and Commander itself) call
		// the no-arg variants to read existing values.
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				const c = ctx.program.command('plugin-getter-check').alias('the-only-one');
				if (c.alias() !== 'the-only-one') throw new Error('alias() getter regressed');
				if (!c.aliases().includes('the-only-one')) throw new Error('aliases() getter regressed');
			};`,
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-getter-check")).toBeDefined();
	});

	it("does not leak alias/aliases patches onto program when a plugin uses the executable-subcommand form", async () => {
		// Commander's `.command(name, "description")` (executable subcommand
		// form) returns `this` (the program), not a new sub-command — see
		// commander/lib/command.js `if (desc) return this`. Without the
		// `newCmd === this` guard in patchedCommand, loadPlugins would call
		// patchCommandAliasMethods(program, …), permanently overwriting
		// program.alias / program.aliases with patched versions whose closures
		// hold per-register Sets — the restoreCommand thunk only restores
		// program.command / program.addCommand, not alias/aliases.
		const program = new Command();
		const origAliasDescriptor = Object.getOwnPropertyDescriptor(program, "alias");
		const origAliasesDescriptor = Object.getOwnPropertyDescriptor(program, "aliases");
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				// Two-arg form triggers Commander's "executable subcommand" return-this path.
				ctx.program.command('plugin-executable-form', 'an executable plugin sub-command');
			};`,
		});
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		// After loadPlugins returns, program.alias and program.aliases must be
		// exactly what Commander gave us — neither patched into own-properties
		// nor changed by the loader.
		expect(Object.getOwnPropertyDescriptor(program, "alias")).toEqual(origAliasDescriptor);
		expect(Object.getOwnPropertyDescriptor(program, "aliases")).toEqual(origAliasesDescriptor);
	});

	it("preserves partially registered commands when register throws", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: `export const register = (ctx) => {
				ctx.program.command('plugin-first').action(() => {});
				throw new Error('halfway');
			};`,
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		// register() partially completed before throwing; the early command stays
		expect(program.commands.find((c) => c.name() === "plugin-first")).toBeDefined();
	});

	it("skips a plugin with malformed package.json and leaves a debug breadcrumb", async () => {
		const root = await writeFixture(tempDir, { brokenPackageJson: true });
		// The loader can't tell from an unparseable manifest whether this is the
		// allow-listed plugin, so it must NOT warn (noisy for unrelated broken
		// packages in the scope) — but it must leave a debug breadcrumb so a real
		// plugin shipping a corrupt manifest doesn't vanish without trace.
		// `log.debug` routes through `console.error` (Logger.ts), and a warn
		// would route through `console.warn`. Debug is suppressed from the
		// console by default (`_silentConsole`), so flip it off for this test to
		// observe the breadcrumb.
		setSilentConsole(false);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				rootsOverride: [root],
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
			});
			expect(program.commands).toHaveLength(0);

			const debugCalls = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(debugCalls).toContain("invalid package.json");
			expect(debugCalls).toContain(`${FIXTURE_SCOPE}/example-plugin`);
			// Not surfaced as a user-facing warning.
			expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("package.json");
		} finally {
			errSpy.mockRestore();
			warnSpy.mockRestore();
			setSilentConsole(true);
		}
	});

	it("skips a scope entry whose package.json parses to a non-object", async () => {
		// Valid JSON that is NOT an object — `[]`, `null`, `42` — is a distinct
		// path from the malformed-JSON case above (which throws inside
		// JSON.parse). The explicit non-object guard must reject it before any
		// field access, so a future refactor can't accidentally read `.main`
		// off an array. JSON.parse("[]") yields an array, hitting Array.isArray.
		const pkgDir = join(tempDir, "node_modules", FIXTURE_SCOPE, "array-pkg");
		await mkdir(pkgDir, { recursive: true });
		await writeFile(join(pkgDir, "package.json"), "[]", "utf-8");
		const program = new Command();
		const { loaded } = await loadPlugins(program, "0.100.0", {
			rootsOverride: [join(tempDir, "node_modules")],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(loaded).toBeInstanceOf(Set);
		expect(program.commands).toHaveLength(0);
	});

	it("skips a plugin whose entry file is missing", async () => {
		// peerVersion present + no pluginSource → no Plugin.js written
		const root = await writeFixture(tempDir, { peerVersion: "^0.100.0" });
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("skips a plugin whose package.main is a non-string (and does not crash the loader)", async () => {
		// JSON.parse can hand us literally anything for `pkg.main` (number,
		// array, object). node:path's resolve() throws TypeError on non-string
		// input, which used to escape loadOnePlugin and take down the CLI.
		// The loader must instead warn and move on.
		const pkgDir = join(tempDir, "node_modules", FIXTURE_NAME);
		await mkdir(pkgDir, { recursive: true });
		await writeFile(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: FIXTURE_NAME,
				version: "0.1.0",
				type: "module",
				main: 12345,
				jolliPluginId: FIXTURE_ID,
			}),
			"utf-8",
		);
		const program = new Command();
		const { loaded } = await loadPlugins(program, "0.100.0", {
			rootsOverride: [join(tempDir, "node_modules")],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(loaded).toBeInstanceOf(Set);
		expect(program.commands).toHaveLength(0);
	});

	it("skips a plugin whose package.main escapes the plugin directory", async () => {
		// Defense in depth: a hostile package.json setting `main` to
		// `"../../../etc/passwd"` or any other out-of-tree path must be
		// rejected before the loader hands the path to import(). The fixture
		// only writes the package.json — we deliberately do NOT create a
		// file at the escaping path, so the test would `mkdir /etc` if the
		// guard ever regressed and tried to materialize the entry.
		const escapingMain = "../../../../../../../../../../etc/passwd";
		const pkgDir = join(tempDir, "node_modules", FIXTURE_NAME);
		await mkdir(pkgDir, { recursive: true });
		await writeFile(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: FIXTURE_NAME,
				version: "0.1.0",
				type: "module",
				main: escapingMain,
				jolliPluginId: FIXTURE_ID,
			}),
			"utf-8",
		);
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [join(tempDir, "node_modules")],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("honors JOLLI_NO_PLUGINS=1", async () => {
		process.env.JOLLI_NO_PLUGINS = "1";
		const root = await writeFixture(tempDir, {
			peerVersion: "^0.100.0",
			pluginSource: "export const register = (ctx) => { ctx.program.command('plugin-hello').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("respects JOLLI_NO_PLUGIN_WARNINGS=1 in failure paths", async () => {
		process.env.JOLLI_NO_PLUGIN_WARNINGS = "1";
		const root = await writeFixture(tempDir, {
			peerVersion: "^99.0.0",
			pluginSource: "export const register = () => {};",
		});
		const program = new Command();
		// Should not throw; suppression branch is exercised
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("uses getGlobalRoot when no cwd node_modules contains the plugin", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-via-global').action(() => {}); };",
		});

		// chdir to a clean dir so cwd/node_modules is empty
		const cleanCwd = await mkdtemp(join(tmpdir(), "clean-cwd-"));
		const origCwd = process.cwd();
		process.chdir(cleanCwd);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => root,
			});
			expect(program.commands.find((c) => c.name() === "plugin-via-global")).toBeDefined();
		} finally {
			process.chdir(origCwd);
			await rm(cleanCwd, { recursive: true, force: true });
		}
	});

	it("does not crash when getGlobalRoot returns null", async () => {
		const cleanCwd = await mkdtemp(join(tmpdir(), "clean-cwd-"));
		const origCwd = process.cwd();
		process.chdir(cleanCwd);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => null,
			});
			expect(program.commands).toHaveLength(0);
		} finally {
			process.chdir(origCwd);
			await rm(cleanCwd, { recursive: true, force: true });
		}
	});

	it("discovers a plugin via the self-install root when getGlobalRoot returns null", async () => {
		// The Windows-regression case (JOLLI-1694): `npm root -g` is unavailable
		// (subprocess timeout / stripped PATH), so the global resolver yields
		// null. The running CLI's own node_modules — the sibling-of-the-host
		// layout a global `npm install -g` produces — must still surface the
		// plugin. Here `getSelfInstallRoot` stands in for the import.meta.url
		// walk and points at the fixture's node_modules root.
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-via-self').action(() => {}); };",
		});
		const cleanCwd = await mkdtemp(join(tmpdir(), "clean-cwd-"));
		const origCwd = process.cwd();
		process.chdir(cleanCwd);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => null,
				getSelfInstallRoot: () => root,
			});
			expect(program.commands.find((c) => c.name() === "plugin-via-self")).toBeDefined();
		} finally {
			process.chdir(origCwd);
			await rm(cleanCwd, { recursive: true, force: true });
		}
	});

	it("does not crash when getSelfInstallRoot returns null", async () => {
		const cleanCwd = await mkdtemp(join(tmpdir(), "clean-cwd-"));
		const origCwd = process.cwd();
		process.chdir(cleanCwd);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => null,
				getSelfInstallRoot: () => null,
			});
			expect(program.commands).toHaveLength(0);
		} finally {
			process.chdir(origCwd);
			await rm(cleanCwd, { recursive: true, force: true });
		}
	});

	it("deduplicates when the self-install root and global root point at the same location", async () => {
		// A standard global install: both resolvers return the same node_modules.
		// The plugin must register exactly once, not twice.
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-self-dedup').action(() => {}); };",
		});
		const cleanCwd = await mkdtemp(join(tmpdir(), "clean-cwd-"));
		const origCwd = process.cwd();
		process.chdir(cleanCwd);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getSelfInstallRoot: () => root,
				getGlobalRoot: async () => root,
			});
			expect(program.commands.filter((c) => c.name() === "plugin-self-dedup")).toHaveLength(1);
		} finally {
			process.chdir(origCwd);
			await rm(cleanCwd, { recursive: true, force: true });
		}
	});

	it("deduplicates when cwd and global root point at the same location", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: "export const register = (ctx) => { ctx.program.command('plugin-once').action(() => {}); };",
		});
		const origCwd = process.cwd();
		process.chdir(tempDir);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => root,
			});
			expect(program.commands.filter((c) => c.name() === "plugin-once")).toHaveLength(1);
		} finally {
			process.chdir(origCwd);
		}
	});

	it("discovers a plugin hoisted to a parent node_modules", async () => {
		// Mimics a monorepo layout: the plugin lives in the workspace-root's
		// node_modules, while cwd is a nested package directory whose own
		// node_modules does not contain the plugin. The loader's upward walk
		// must traverse parents to find it.
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-hoisted').action(() => {}); };",
		});
		// Anchor tempDir as a project so the loader's upward walk doesn't
		// short-circuit at HOME. Adding `.git` is the realistic case
		// (workspace roots are git repos); `homedirOverride: tempDir` would
		// also work but tests the boundary fallback rather than the primary
		// git-root case.
		await mkdir(join(tempDir, ".git"), { recursive: true });
		const nestedPkg = join(tempDir, "packages", "nested");
		await mkdir(join(nestedPkg, "node_modules"), { recursive: true });
		const origCwd = process.cwd();
		process.chdir(nestedPkg);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => null,
			});
			expect(program.commands.find((c) => c.name() === "plugin-hoisted")).toBeDefined();
			// Sanity: the hoisted root really was the temp's node_modules
			expect(existsSync(join(root, FIXTURE_NAME))).toBe(true);
		} finally {
			process.chdir(origCwd);
		}
	});

	it("does not climb past the git-root boundary", async () => {
		// Security boundary: a plugin sitting in node_modules ABOVE the
		// current project's .git anchor must not be discovered, even if the
		// path technically exists. Otherwise a `jolli` run inside one
		// project could pick up a hoisted-but-untrusted package from a
		// sibling tree above it.
		// Layout:
		//   tempDir/node_modules/@test-fixtures/example-plugin   ← above .git
		//   tempDir/inner/.git                                   ← project root
		//   tempDir/inner/sub/                                   ← cwd
		const aboveRoot = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-above-git').action(() => {}); };",
		});
		const projectRoot = join(tempDir, "inner");
		await mkdir(join(projectRoot, ".git"), { recursive: true });
		const cwdDir = join(projectRoot, "sub");
		await mkdir(cwdDir, { recursive: true });
		const origCwd = process.cwd();
		process.chdir(cwdDir);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => null,
			});
			expect(program.commands.find((c) => c.name() === "plugin-above-git")).toBeUndefined();
			// Sanity: fixture exists on disk but is intentionally outside the boundary.
			expect(existsSync(join(aboveRoot, FIXTURE_NAME))).toBe(true);
		} finally {
			process.chdir(origCwd);
		}
	});

	it("skips the local walk entirely when cwd is outside HOME and not in a git repo", async () => {
		// A `jolli` run from `/tmp/foo` (no `.git` anywhere on the cwd's
		// path, and outside the user's HOME) should not scan any local
		// node_modules — only the global npm root, if present. Without
		// this guard a malicious user could drop an allow-listed package
		// into a parent `node_modules/` of a world-writable directory and
		// hijack any `jolli` invocation made from there.
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-outside-home').action(() => {}); };",
		});
		const origCwd = process.cwd();
		process.chdir(tempDir);
		try {
			const program = new Command();
			// homedirOverride points somewhere entirely unrelated to tempDir,
			// so isWithinBoundary returns false for the cwd from the start
			// and the loop body never runs.
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => null,
				homedirOverride: "/nonexistent/home/path",
			});
			expect(program.commands.find((c) => c.name() === "plugin-outside-home")).toBeUndefined();
			// Sanity: the package really is on disk; the loader chose not to look there.
			expect(existsSync(join(root, FIXTURE_NAME))).toBe(true);
		} finally {
			process.chdir(origCwd);
		}
	});

	it("uses HOME as the boundary when no .git ancestor exists", async () => {
		// When the cwd isn't in a git repo but IS inside HOME, the walk
		// should still find a plugin anywhere up to and including HOME's
		// node_modules — covers user-level installs without a project.
		await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-via-home').action(() => {}); };",
		});
		// macOS resolves the `/var/folders/...` from `os.tmpdir()` to
		// `/private/var/folders/...` when `process.cwd()` is read after
		// `chdir`. The loader's `relative()` boundary check then sees the
		// homedirOverride and the resolved cwd as living in different
		// trees and skips the walk. Resolve to the real path here so the
		// comparison matches what production sees (where HOME and cwd
		// share a real-path prefix). Realpath the fixture path too so
		// the `existsSync` sanity check uses the same shape.
		const realTempDir = await realpath(tempDir);
		const nested = join(realTempDir, "deeply", "nested", "dir");
		await mkdir(nested, { recursive: true });
		const origCwd = process.cwd();
		process.chdir(nested);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => null,
				homedirOverride: realTempDir,
			});
			expect(program.commands.find((c) => c.name() === "plugin-via-home")).toBeDefined();
			expect(existsSync(join(realTempDir, "node_modules", FIXTURE_NAME))).toBe(true);
		} finally {
			process.chdir(origCwd);
		}
	});

	it("skips a plugin whose package.json omits jolliPluginId", async () => {
		const root = await writeFixture(tempDir, {
			pluginId: null,
			pluginSource: "export const register = (ctx) => { ctx.program.command('plugin-no-id').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-no-id")).toBeUndefined();
	});

	it("skips a plugin whose jolliPluginId is not in the allowlist", async () => {
		const root = await writeFixture(tempDir, {
			pluginId: "some-other-id-not-on-the-allowlist",
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-wrong-id').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-wrong-id")).toBeUndefined();
	});

	it("skips a plugin whose jolliPluginId is not a string", async () => {
		// JSON.parse can hand us any type — number, array, object — for the field.
		// The loader must reject non-string IDs rather than coerce or crash.
		const root = await writeFixture(tempDir, {
			pluginId: 12345,
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-numeric-id').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-numeric-id")).toBeUndefined();
	});

	it("ignores non-directory entries inside a scope folder", async () => {
		// Stray files (.DS_Store, .package-lock.json, etc.) sometimes live next
		// to scoped package directories. The discovery loop must skip them
		// rather than try to read a package.json inside them.
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-with-stray-file').action(() => {}); };",
		});
		await writeFile(join(root, FIXTURE_SCOPE, ".DS_Store"), "junk", "utf-8");
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-with-stray-file")).toBeDefined();
	});

	it("ignores a scope entry that lacks a package.json", async () => {
		// A directory under the scope without a package.json is not a package —
		// silently skip it so the loop doesn't crash on the missing file.
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-near-empty-dir').action(() => {}); };",
		});
		await mkdir(join(root, FIXTURE_SCOPE, "incomplete-package"), { recursive: true });
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-near-empty-dir")).toBeDefined();
	});

	it("survives a scope path that exists but is not a directory", async () => {
		// existsSync(scopeDir) is true but readdir throws ENOTDIR. The discovery
		// loop must catch and move on to the next scope/root rather than letting
		// the error escape.
		const nodeModules = join(tempDir, "node_modules");
		await mkdir(nodeModules, { recursive: true });
		await writeFile(join(nodeModules, FIXTURE_SCOPE), "this is a file, not a scope dir", "utf-8");
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [nodeModules],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands).toHaveLength(0);
	});

	itIfSymlinks("discovers a plugin installed as a symlink (npm link / workspace layout)", async () => {
		// Dirent.isDirectory() returns false for a symlink-to-directory under
		// `withFileTypes: true`, so without the isSymbolicLink() fallback the
		// loader would silently miss `npm link`, yarn workspaces, and pnpm's
		// non-isolated installs.
		const realPkgRoot = join(tempDir, "real-source", "example-plugin");
		await mkdir(join(realPkgRoot, "dist"), { recursive: true });
		await writeFile(
			join(realPkgRoot, "package.json"),
			JSON.stringify({
				name: "@test-fixtures/example-plugin",
				version: "0.1.0",
				type: "module",
				main: "./dist/Plugin.js",
				jolliPluginId: FIXTURE_ID,
			}),
			"utf-8",
		);
		await writeFile(
			join(realPkgRoot, "dist", "Plugin.js"),
			"export const register = (ctx) => { ctx.program.command('plugin-via-symlink').action(() => {}); };",
			"utf-8",
		);

		const nodeModules = join(tempDir, "node_modules");
		await mkdir(join(nodeModules, FIXTURE_SCOPE), { recursive: true });
		await symlink(realPkgRoot, join(nodeModules, FIXTURE_SCOPE, "example-plugin"), "dir");

		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [nodeModules],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-via-symlink")).toBeDefined();
	});

	it("picks deterministically and warns when two packages in the same scope claim the same ID", async () => {
		// Two packages in the same scope+root declaring the same jolliPluginId
		// is the rename-mid-migration scenario the design accepts. The loader
		// must (a) deterministically pick the lexicographically first name,
		// regardless of readdir's filesystem-dependent order, and (b) emit a
		// warn so the user notices the collision and can clean up.
		const root = await writeFixture(tempDir, {
			name: `${FIXTURE_SCOPE}/a-plugin`,
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-from-a').action(() => {}); };",
		});
		// Second package with the same ID, lexicographically later.
		const zDir = join(root, FIXTURE_SCOPE, "z-plugin");
		await mkdir(join(zDir, "dist"), { recursive: true });
		await writeFile(
			join(zDir, "package.json"),
			JSON.stringify({
				name: `${FIXTURE_SCOPE}/z-plugin`,
				version: "0.1.0",
				type: "module",
				main: "./dist/Plugin.js",
				jolliPluginId: FIXTURE_ID,
			}),
			"utf-8",
		);
		await writeFile(
			join(zDir, "dist", "Plugin.js"),
			"export const register = (ctx) => { ctx.program.command('plugin-from-z').action(() => {}); };",
			"utf-8",
		);

		// Capture console.warn to assert the collision warn. The loader's
		// `warn()` helper routes through createLogger("PluginLoader").warn,
		// which calls console.warn (see Logger.ts:229) unless
		// JOLLI_NO_PLUGIN_WARNINGS is set.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				rootsOverride: [root],
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
			});
			expect(program.commands.find((c) => c.name() === "plugin-from-a")).toBeDefined();
			expect(program.commands.find((c) => c.name() === "plugin-from-z")).toBeUndefined();

			// Assert both the loser's name and the winner's name appear in the
			// warning — without those names, a user looking at debug.log can't
			// tell which package to uninstall.
			const calls = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(calls).toContain("z-plugin");
			expect(calls).toContain("a-plugin");
			expect(calls).toContain(FIXTURE_ID);
			// And the warning names the exact root, not just "the same scope" —
			// a user with one `node_modules` per workspace package needs to know
			// which root to clean up.
			expect(calls).toContain(root);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("skips a duplicate plugin ID found in a later root (first root wins, silently)", async () => {
		// The same jolliPluginId present in two GENUINELY DISTINCT roots is
		// normal hoisting — a project-local copy shadowing the global npm root.
		// `seenAcrossRoots` makes the first root in priority order win and the
		// second is skipped silently (no warn — unlike the same-scope collision
		// above). Without the cross-root dedupe the loader would re-run the same
		// plugin's register() and the second pass would collide on its own
		// command names.
		const rootOne = join(tempDir, "root-one", "node_modules");
		const rootTwo = join(tempDir, "root-two", "node_modules");
		for (const [root, cmd] of [
			[rootOne, "plugin-root-one"],
			[rootTwo, "plugin-root-two"],
		] as const) {
			const pkgDir = join(root, FIXTURE_SCOPE, "example-plugin");
			await mkdir(join(pkgDir, "dist"), { recursive: true });
			await writeFile(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: FIXTURE_NAME,
					version: "0.1.0",
					type: "module",
					main: "./dist/Plugin.js",
					jolliPluginId: FIXTURE_ID,
				}),
				"utf-8",
			);
			await writeFile(
				join(pkgDir, "dist", "Plugin.js"),
				`export const register = (ctx) => { ctx.program.command('${cmd}').action(() => {}); };`,
				"utf-8",
			);
		}

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				rootsOverride: [rootOne, rootTwo],
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
			});
			// First root wins; the second root's copy is skipped.
			expect(program.commands.find((c) => c.name() === "plugin-root-one")).toBeDefined();
			expect(program.commands.find((c) => c.name() === "plugin-root-two")).toBeUndefined();
			// Cross-root hoisting is the expected case — no collision warning.
			const calls = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(calls).not.toContain(FIXTURE_ID);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("uses the default allowlist and scopes when no override is provided", async () => {
		// Without overrides the loader uses the production allowlist and scopes.
		// The fixture lives under @test-fixtures with a fixture-only ID, so it
		// matches neither — the loader must ignore it.
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('should-not-load').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			getGlobalRoot: async () => null,
		});
		expect(program.commands.find((c) => c.name() === "should-not-load")).toBeUndefined();
	});

	it("defaults to ./dist/Plugin.js when package.json omits `main`", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource:
				"export const register = (ctx) => { ctx.program.command('plugin-default-main').action(() => {}); };",
		});
		// Strip `main` from the package.json that writeFixture produced
		const pkgPath = join(root, FIXTURE_NAME, "package.json");
		const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
		delete pkg.main;
		await writeFile(pkgPath, JSON.stringify(pkg), "utf-8");

		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(program.commands.find((c) => c.name() === "plugin-default-main")).toBeDefined();
	});

	it("ignores a returned global root that does not exist on disk", async () => {
		const cleanCwd = await mkdtemp(join(tmpdir(), "clean-cwd-"));
		const origCwd = process.cwd();
		process.chdir(cleanCwd);
		try {
			const program = new Command();
			await loadPlugins(program, "0.100.0", {
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
				getGlobalRoot: async () => "/definitely/not/a/real/path/anywhere",
			});
			expect(program.commands).toHaveLength(0);
		} finally {
			process.chdir(origCwd);
			await rm(cleanCwd, { recursive: true, force: true });
		}
	});

	it("reports a plugin's ID in the loaded set once its register() runs", async () => {
		// P1: the returned set must reflect plugins that actually registered —
		// `registerMissingStubs` keys its stub fallback off this set.
		const root = await writeFixture(tempDir, {
			peerVersion: "^0.100.0",
			pluginSource: "export const register = (ctx) => { ctx.program.command('plugin-ok').action(() => {}); };",
		});
		const program = new Command();
		const { loaded } = await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_ID],
			scopesOverride: [FIXTURE_SCOPE],
		});
		expect(loaded.has(FIXTURE_ID)).toBe(true);
	});

	it("omits a discovered plugin from the loaded set when its register() throws", async () => {
		// P1: a discovered-but-broken plugin must drop out of the loaded set so
		// the caller falls back to its stub instead of treating it as live.
		const root = await writeFixture(tempDir, {
			peerVersion: "^0.100.0",
			pluginSource: "export const register = () => { throw new Error('register boom'); };",
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const program = new Command();
			const { loaded } = await loadPlugins(program, "0.100.0", {
				rootsOverride: [root],
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
			});
			expect(loaded.has(FIXTURE_ID)).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("omits a discovered plugin from the loaded set when its peer range rejects the CLI", async () => {
		// P1: peer-mismatch is another not-loaded path that must still surface
		// the stub fallback rather than masking it.
		const root = await writeFixture(tempDir, {
			peerVersion: "^99.0.0",
			pluginSource: "export const register = (ctx) => { ctx.program.command('plugin-x').action(() => {}); };",
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const program = new Command();
			const { loaded } = await loadPlugins(program, "0.100.0", {
				rootsOverride: [root],
				allowlistOverride: [FIXTURE_ID],
				scopesOverride: [FIXTURE_SCOPE],
			});
			expect(loaded.has(FIXTURE_ID)).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("tags commands a known plugin registers with its help group", async () => {
		// P2: help grouping is by provenance, not name. A known plugin that
		// declares a `helpGroup` has every command it registers tagged so the
		// formatter buckets them correctly even when the command name is generic.
		// The ID is resolved from KNOWN_PLUGINS (not hardcoded) because the group
		// mapping is keyed off the production registry.
		const known = KNOWN_PLUGINS.find((p) => p.helpGroup);
		if (!known) throw new Error("expected a known plugin with a helpGroup");
		const root = await writeFixture(tempDir, {
			peerVersion: "^0.100.0",
			pluginId: known.id,
			pluginSource: "export const register = (ctx) => { ctx.program.command('init').action(() => {}); };",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [known.id],
			scopesOverride: [FIXTURE_SCOPE],
		});
		const cmd = program.commands.find((c) => c.name() === "init");
		expect(cmd).toBeDefined();
		expect(cmd && getHelpGroup(cmd)).toBe(known.helpGroup);
	});
});

describe("getNpmRootGlobal", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "npm-root-cache-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("returns cached value when within TTL", async () => {
		const cacheFile = join(tempDir, "cache");
		await writeFile(cacheFile, "/cached/path", "utf-8");
		let ranSubprocess = false;
		const result = await getNpmRootGlobal({
			cacheFile,
			runNpm: async () => {
				ranSubprocess = true;
				return "/should-not-be-used";
			},
		});
		expect(result).toBe("/cached/path");
		expect(ranSubprocess).toBe(false);
	});

	it("runs subprocess and writes cache on cache miss", async () => {
		const cacheFile = join(tempDir, "cache");
		const result = await getNpmRootGlobal({
			cacheFile,
			runNpm: async () => "/fresh/path",
		});
		expect(result).toBe("/fresh/path");
		// Cache was written
		const stCache = await stat(cacheFile);
		expect(stCache.isFile()).toBe(true);
	});

	it("re-runs subprocess when cache is expired", async () => {
		const cacheFile = join(tempDir, "cache");
		await writeFile(cacheFile, "/stale/path", "utf-8");
		// Set mtime far in the past
		const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
		await utimes(cacheFile, longAgo, longAgo);

		const result = await getNpmRootGlobal({
			cacheFile,
			ttlMs: 60 * 60 * 1000, // 1 hour
			runNpm: async () => "/refreshed/path",
		});
		expect(result).toBe("/refreshed/path");
	});

	it("ignores empty cache file content", async () => {
		const cacheFile = join(tempDir, "cache");
		await writeFile(cacheFile, "   \n  ", "utf-8");
		const result = await getNpmRootGlobal({
			cacheFile,
			runNpm: async () => "/fallback/path",
		});
		expect(result).toBe("/fallback/path");
	});

	it("returns null when subprocess returns null and no cache exists", async () => {
		const cacheFile = join(tempDir, "cache");
		const result = await getNpmRootGlobal({
			cacheFile,
			runNpm: async () => null,
		});
		expect(result).toBeNull();
	});

	it("tolerates cache-write failure silently", async () => {
		// Point cache at a path that mkdir cannot create (parent is a file, not a dir)
		const blocker = join(tempDir, "blocker");
		await writeFile(blocker, "I am a file, not a directory", "utf-8");
		const cacheFile = join(blocker, "cache");
		const result = await getNpmRootGlobal({
			cacheFile,
			runNpm: async () => "/runtime/path",
		});
		// Still returns the runtime path even if cache write fails
		expect(result).toBe("/runtime/path");
	});
});

describe("inspectPlugins", () => {
	// inspectPlugins maps each KNOWN_PLUGINS entry to a three-state diagnostic
	// (absent / incompatible / ok), reusing the same discovery + peer-range
	// logic as loadPlugins so the visibility layer never disagrees with what
	// the loader actually does.
	let tempDir: string;

	const KNOWN: ReadonlyArray<KnownPlugin> = [
		{
			id: FIXTURE_ID,
			packageName: FIXTURE_NAME,
			installHint: "npm install -g @test-fixtures/example-plugin",
		},
	];

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "plugin-inspect-test-"));
		delete process.env.JOLLI_NO_PLUGINS;
		delete process.env.JOLLI_NO_PLUGIN_WARNINGS;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("reports absent for a known plugin not installed on disk", async () => {
		const diagnostics = await inspectPlugins("1.0.0", {
			rootsOverride: [join(tempDir, "node_modules")],
			scopesOverride: [FIXTURE_SCOPE],
			knownPluginsOverride: KNOWN,
		});
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			id: FIXTURE_ID,
			packageName: FIXTURE_NAME,
			state: "absent",
		});
		expect(diagnostics[0].installedVersion).toBeUndefined();
	});

	it("reports ok with the installed version for a compatible plugin", async () => {
		const root = await writeFixture(tempDir, { version: "0.4.2", peerVersion: ">=1.0.0" });
		const diagnostics = await inspectPlugins("1.5.0", {
			rootsOverride: [root],
			scopesOverride: [FIXTURE_SCOPE],
			knownPluginsOverride: KNOWN,
		});
		expect(diagnostics[0]).toMatchObject({
			state: "ok",
			installedVersion: "0.4.2",
			peerRange: ">=1.0.0",
		});
	});

	it("reports incompatible when the peer range excludes the cli version", async () => {
		const root = await writeFixture(tempDir, { version: "0.4.2", peerVersion: ">=2.0.0" });
		const diagnostics = await inspectPlugins("1.0.0", {
			rootsOverride: [root],
			scopesOverride: [FIXTURE_SCOPE],
			knownPluginsOverride: KNOWN,
		});
		expect(diagnostics[0]).toMatchObject({
			state: "incompatible",
			installedVersion: "0.4.2",
			peerRange: ">=2.0.0",
		});
	});

	it("treats a plugin with no peerDependencies as ok", async () => {
		const root = await writeFixture(tempDir, { version: "1.2.3" });
		const diagnostics = await inspectPlugins("0.0.1", {
			rootsOverride: [root],
			scopesOverride: [FIXTURE_SCOPE],
			knownPluginsOverride: KNOWN,
		});
		expect(diagnostics[0]).toMatchObject({ state: "ok", installedVersion: "1.2.3" });
		expect(diagnostics[0].peerRange).toBeUndefined();
	});

	it("defaults to the production KNOWN_PLUGINS list when none is injected", async () => {
		// With an empty root and the real allow-list, every known plugin is absent.
		const diagnostics = await inspectPlugins("1.0.0", {
			rootsOverride: [join(tempDir, "node_modules")],
		});
		expect(diagnostics).toHaveLength(KNOWN_PLUGINS.length);
		expect(diagnostics.every((d) => d.state === "absent")).toBe(true);
		expect(diagnostics.map((d) => d.packageName)).toEqual(KNOWN_PLUGINS.map((p) => p.packageName));
	});

	it("reports every known plugin absent when JOLLI_NO_PLUGINS=1, even if installed", async () => {
		// The loader short-circuits discovery under the kill-switch, so nothing is
		// loadable; the diagnostic must agree (never claim an on-disk plugin ok)
		// or doctor/version-check would disagree with what loadPlugins does.
		const root = await writeFixture(tempDir, { version: "0.4.2", peerVersion: ">=1.0.0" });
		process.env.JOLLI_NO_PLUGINS = "1";
		const diagnostics = await inspectPlugins("1.5.0", {
			rootsOverride: [root],
			scopesOverride: [FIXTURE_SCOPE],
			knownPluginsOverride: KNOWN,
		});
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ id: FIXTURE_ID, state: "absent" });
		expect(diagnostics[0].installedVersion).toBeUndefined();
	});
});

describe("loadPlugins diagnostics", () => {
	// loadPlugins computes its PluginDiagnostic snapshot from the same single
	// discovery walk it uses to load, so the hot path (checkVersionMismatch) can
	// reuse it instead of re-scanning the filesystem.
	let tempDir: string;

	const KNOWN: ReadonlyArray<KnownPlugin> = [
		{
			id: FIXTURE_ID,
			packageName: FIXTURE_NAME,
			installHint: "npm install -g @test-fixtures/example-plugin",
		},
	];

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "plugin-load-diag-test-"));
		delete process.env.JOLLI_NO_PLUGINS;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("returns diagnostics alongside the loaded set from one discovery", async () => {
		const root = await writeFixture(tempDir, {
			version: "0.4.2",
			peerVersion: "^0.100.0",
			pluginSource: "export const register = (ctx) => { ctx.program.command('diag-ok').action(() => {}); };",
		});
		const program = new Command();
		const { loaded, diagnostics } = await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			scopesOverride: [FIXTURE_SCOPE],
			knownPluginsOverride: KNOWN,
		});
		expect(loaded.has(FIXTURE_ID)).toBe(true);
		const entry = diagnostics.find((d) => d.id === FIXTURE_ID);
		expect(entry).toMatchObject({ state: "ok", installedVersion: "0.4.2", peerRange: "^0.100.0" });
	});

	it("returns an all-absent diagnostic snapshot when JOLLI_NO_PLUGINS=1", async () => {
		process.env.JOLLI_NO_PLUGINS = "1";
		const program = new Command();
		const { loaded, diagnostics } = await loadPlugins(program, "0.100.0", {
			rootsOverride: [join(tempDir, "node_modules")],
		});
		expect(loaded.size).toBe(0);
		expect(diagnostics).toHaveLength(KNOWN_PLUGINS.length);
		expect(diagnostics.every((d) => d.state === "absent")).toBe(true);
	});
});

describe("findNodeModulesRoot", () => {
	// Pure walk used by the self-install discovery root (JOLLI-1694). Inputs use
	// forward slashes, which both `path.posix` (CI runners) and `path.win32`
	// (Windows) accept as separators, so the assertions hold on either host.

	it("returns the directory itself when it is named node_modules", () => {
		expect(findNodeModulesRoot("/usr/lib/node_modules")).toBe("/usr/lib/node_modules");
	});

	it("returns the nearest node_modules ancestor of a globally-installed CLI path", () => {
		// The shape a global `npm install -g @jolli.ai/cli` produces.
		expect(findNodeModulesRoot("/usr/local/lib/node_modules/@jolli.ai/cli/dist")).toBe(
			"/usr/local/lib/node_modules",
		);
	});

	it("returns the closest node_modules when several are nested", () => {
		expect(findNodeModulesRoot("/a/node_modules/x/node_modules/@jolli.ai/cli/dist")).toBe(
			"/a/node_modules/x/node_modules",
		);
	});

	it("returns null when no node_modules ancestor exists (tsx dev run)", () => {
		expect(findNodeModulesRoot("/Users/dev/workspace/jolliai/cli/src")).toBeNull();
	});

	it("returns null at the filesystem root", () => {
		expect(findNodeModulesRoot("/")).toBeNull();
	});
});
