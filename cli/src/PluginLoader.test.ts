/// <reference types="node" />
/**
 * Tests for {@link PluginLoader}.
 *
 * Fixtures are written to a per-test temp directory and torn down after each
 * test. Fixture package names use the generic `@test-fixtures/example-plugin`
 * scope — never `@jolli.ai/cli-pro` — so test code reads cleanly without
 * implying anything about the real plugin packages.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNpmRootGlobal, loadPlugins } from "./PluginLoader.js";

const FIXTURE_NAME = "@test-fixtures/example-plugin";

/**
 * Write a fixture plugin package into `<tempDir>/node_modules/<name>/`.
 * Returns the `node_modules` root that can be passed as `rootsOverride`.
 */
async function writeFixture(
	tempDir: string,
	opts: {
		name?: string;
		peerVersion?: string;
		pluginSource?: string;
		mainPath?: string;
		brokenPackageJson?: boolean;
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
			version: "0.1.0",
			// Critical: dynamic import of `.js` requires ESM resolution, which the
			// nearest package.json's `"type": "module"` provides.
			type: "module",
			main: opts.mainPath ?? "./dist/Plugin.js",
		};
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
		});
		expect(program.commands.find((c) => c.name() === "plugin-hello")).toBeDefined();
	});

	it("silently does nothing when no fixture is present", async () => {
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [join(tempDir, "node_modules")],
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("skips plugin missing the register export", async () => {
		const root = await writeFixture(tempDir, {
			pluginSource: "export const somethingElse = () => {};",
		});
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
		});
		expect(program.commands.find((c) => c.name() === "plugin-getter-check")).toBeDefined();
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
			allowlistOverride: [FIXTURE_NAME],
		});
		// register() partially completed before throwing; the early command stays
		expect(program.commands.find((c) => c.name() === "plugin-first")).toBeDefined();
	});

	it("skips a plugin with malformed package.json", async () => {
		const root = await writeFixture(tempDir, { brokenPackageJson: true });
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_NAME],
		});
		expect(program.commands).toHaveLength(0);
	});

	it("skips a plugin whose entry file is missing", async () => {
		// peerVersion present + no pluginSource → no Plugin.js written
		const root = await writeFixture(tempDir, { peerVersion: "^0.100.0" });
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [root],
			allowlistOverride: [FIXTURE_NAME],
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
			JSON.stringify({ name: FIXTURE_NAME, version: "0.1.0", type: "module", main: 12345 }),
			"utf-8",
		);
		const program = new Command();
		await expect(
			loadPlugins(program, "0.100.0", {
				rootsOverride: [join(tempDir, "node_modules")],
				allowlistOverride: [FIXTURE_NAME],
			}),
		).resolves.toBeUndefined();
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
			JSON.stringify({ name: FIXTURE_NAME, version: "0.1.0", type: "module", main: escapingMain }),
			"utf-8",
		);
		const program = new Command();
		await loadPlugins(program, "0.100.0", {
			rootsOverride: [join(tempDir, "node_modules")],
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
			allowlistOverride: [FIXTURE_NAME],
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
				allowlistOverride: [FIXTURE_NAME],
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
				allowlistOverride: [FIXTURE_NAME],
				getGlobalRoot: async () => null,
			});
			expect(program.commands).toHaveLength(0);
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
				allowlistOverride: [FIXTURE_NAME],
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
				allowlistOverride: [FIXTURE_NAME],
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
				allowlistOverride: [FIXTURE_NAME],
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
				allowlistOverride: [FIXTURE_NAME],
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
				allowlistOverride: [FIXTURE_NAME],
				getGlobalRoot: async () => null,
				homedirOverride: realTempDir,
			});
			expect(program.commands.find((c) => c.name() === "plugin-via-home")).toBeDefined();
			expect(existsSync(join(realTempDir, "node_modules", FIXTURE_NAME))).toBe(true);
		} finally {
			process.chdir(origCwd);
		}
	});

	it("uses the default allowlist when no override is provided", async () => {
		// FIXTURE_NAME is not in the production allowlist, so it must be ignored.
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
			allowlistOverride: [FIXTURE_NAME],
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
				allowlistOverride: [FIXTURE_NAME],
				getGlobalRoot: async () => "/definitely/not/a/real/path/anywhere",
			});
			expect(program.commands).toHaveLength(0);
		} finally {
			process.chdir(origCwd);
			await rm(cleanCwd, { recursive: true, force: true });
		}
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
