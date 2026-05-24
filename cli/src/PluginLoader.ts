/// <reference types="node" />
/**
 * PluginLoader — discovery and dynamic loading of CLI plugins.
 *
 * A plugin is an npm package whose name appears in the {@link KNOWN_PLUGINS}
 * allow-list. The loader walks the local `node_modules` (including hoisted
 * parents, for pnpm/Yarn-workspaces-style monorepos) and the cached global
 * npm root looking for matching packages; for each found, it:
 *
 *   1. Reads `package.json` and checks `peerDependencies["@jolli.ai/cli"]`
 *      against the host CLI version using the `semver` library — any range
 *      syntax (`^`, `~`, `>=`, `||`, …) is supported.
 *   2. Dynamic-imports the package's `main` entry (default `./dist/Plugin.js`).
 *   3. Calls the module's exported `register(ctx)` with a {@link PluginContext}.
 *   4. Snapshots the full top-level namespace (every existing command's name
 *      AND aliases) and intercepts `program.command`, `program.addCommand`,
 *      and the returned command's `.alias()` / `.aliases()` for the duration
 *      of `register()` so collisions are recorded and skipped instead of
 *      throwing — a plugin that collides on one entry still gets to register
 *      its remaining entries.
 *
 * Failure modes are all non-fatal: any thrown error becomes a warning and the
 * loader moves on, so a broken plugin never prevents the host CLI from running.
 *
 * Environment variables:
 *   JOLLI_NO_PLUGINS=1          — short-circuit the loader entirely
 *   JOLLI_NO_PLUGIN_WARNINGS=1  — suppress warnings (skipping still happens)
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { satisfies } from "semver";
import type { PluginContext, PluginRegister } from "./Api.js";
import { getGlobalConfigDir } from "./core/SessionTracker.js";
import { createLogger } from "./Logger.js";
import { execFileAsyncHidden } from "./util/Subprocess.js";

const log = createLogger("PluginLoader");

/** Allow-list of plugin package names. Pattern matching is intentionally avoided. */
const KNOWN_PLUGINS: ReadonlyArray<string> = ["@jolli.ai/cli-pro"];

/**
 * Path to the `npm root -g` cache file. Lazy-resolved on each call so a
 * future change to `getGlobalConfigDir()` (e.g. reading an env var at call
 * time instead of process start) is not frozen by module-load order.
 */
function getNpmRootCacheFile(): string {
	return join(getGlobalConfigDir(), "global-root");
}

/** Cache TTL: 6 hours. Long enough to avoid the subprocess on most invocations,
 *  short enough that an `npm install -g`-induced move is picked up the same day. */
const NPM_ROOT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Timeout for the `npm root -g` subprocess, to avoid hanging on broken PATH. */
const NPM_ROOT_TIMEOUT_MS = 5000;

/**
 * Options for {@link loadPlugins}. All fields are for test injection — the
 * production caller passes nothing.
 */
export interface LoadPluginsOptions {
	/** Replace the discovered roots with these. Used by tests to point at fixtures. */
	rootsOverride?: ReadonlyArray<string>;
	/** Replace the {@link KNOWN_PLUGINS} allow-list. Used by tests with fake package names. */
	allowlistOverride?: ReadonlyArray<string>;
	/** Custom resolver for the global npm root. Returning `null` means "not available". */
	getGlobalRoot?: () => Promise<string | null>;
	/**
	 * Override for the user's home directory, used as the fallback upper bound
	 * of the upward `node_modules` walk when no `.git` ancestor is found.
	 * Test-only injection point — production callers leave this unset and the
	 * loader uses `os.homedir()`.
	 */
	homedirOverride?: string;
}

/**
 * Options for {@link getNpmRootGlobal}. Production callers pass nothing.
 */
export interface NpmRootGlobalOptions {
	/** Path to the cache file. Defaults to `<globalConfigDir>/global-root`. */
	cacheFile?: string;
	/** TTL for cache freshness in ms. Defaults to {@link NPM_ROOT_CACHE_TTL_MS}. */
	ttlMs?: number;
	/** Subprocess wrapper. Defaults to {@link runNpmRootGlobal}. */
	runNpm?: () => Promise<string | null>;
}

/**
 * Discover and load all plugins. Always non-throwing — failures become warnings.
 *
 * Wire-in point in `Api.ts main()`: call this after all builtin command
 * registrations and before `program.parseAsync(...)`.
 */
export async function loadPlugins(program: Command, cliVersion: string, opts?: LoadPluginsOptions): Promise<void> {
	if (process.env.JOLLI_NO_PLUGINS === "1") {
		log.debug("JOLLI_NO_PLUGINS=1 — skipping plugin discovery");
		return;
	}

	const allowlist = opts?.allowlistOverride ?? KNOWN_PLUGINS;
	const roots = await resolveRoots(opts);
	const found = discoverPlugins(roots, allowlist);

	for (const plugin of found) {
		await loadOnePlugin(program, cliVersion, plugin);
	}
}

interface FoundPlugin {
	name: string;
	dir: string;
}

/**
 * Resolve the list of `node_modules` roots to scan for plugin packages.
 * Order matters: earlier entries take precedence on duplicate names.
 *
 * Walks upward from `process.cwd()` collecting every `node_modules` along the
 * way, then appends the cached global npm root. The walk is bounded — it does
 * **not** climb to the filesystem root, because a `jolli` invocation from a
 * world-writable directory (`/tmp/…`) must not pick up a hoisted package some
 * other user dropped into an ancestor `node_modules/`. The boundary is:
 *
 *   1. The nearest ancestor of `cwd` containing a `.git` entry (the project
 *      root) — preserves the monorepo case where plugins are hoisted to the
 *      workspace root.
 *   2. Otherwise, the user's home directory — keeps user-level installs
 *      reachable, but the walk never crosses out of `~`.
 *   3. If `cwd` is outside the boundary (e.g. `/tmp/foo` with HOME=`/Users/x`),
 *      the local walk is skipped entirely and only the global npm root is
 *      consulted.
 *
 * Cost is one synchronous `existsSync` per path segment between cwd and the
 * boundary — typically 5–15 stat calls. The bound is the path depth itself,
 * so there is no risk of unbounded I/O.
 */
async function resolveRoots(opts?: LoadPluginsOptions): Promise<ReadonlyArray<string>> {
	if (opts?.rootsOverride) return opts.rootsOverride;

	const result: string[] = [];
	const cwd = process.cwd();
	const fsRoot = parsePath(cwd).root;
	const home = opts?.homedirOverride ?? homedir();

	const findGitRoot = (start: string): string | null => {
		let dir = start;
		while (true) {
			if (existsSync(join(dir, ".git"))) return dir;
			if (dir === fsRoot) return null;
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	};
	const boundary = findGitRoot(cwd) ?? home;

	const isWithinBoundary = (path: string): boolean => {
		const rel = relative(boundary, path);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	};

	let dir = cwd;
	while (isWithinBoundary(dir)) {
		const candidate = join(dir, "node_modules");
		if (existsSync(candidate) && !result.includes(candidate)) {
			result.push(candidate);
		}
		if (dir === boundary) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	const globalRootResolver = opts?.getGlobalRoot ?? (() => getNpmRootGlobal());
	const globalRoot = await globalRootResolver();
	if (globalRoot && existsSync(globalRoot) && !result.includes(globalRoot)) {
		result.push(globalRoot);
	}

	return result;
}

/**
 * Walk the given roots and return the first matching directory per allow-listed name.
 */
function discoverPlugins(roots: ReadonlyArray<string>, allowlist: ReadonlyArray<string>): FoundPlugin[] {
	const found: FoundPlugin[] = [];
	for (const name of allowlist) {
		for (const root of roots) {
			const dir = join(root, name);
			if (existsSync(join(dir, "package.json"))) {
				found.push({ name, dir });
				break;
			}
		}
	}
	return found;
}

/**
 * Load a single plugin: validate peerDep, dynamic-import, call register, prune conflicts.
 * All errors are caught and warned — never thrown to the caller.
 *
 * The entire function body is wrapped in a top-level try/catch so that
 * unanticipated throws (e.g. `pkg.main` being a non-string, which would
 * crash `resolve()` / `pathToFileURL()` with `TypeError`) cannot escape and
 * take down the CLI. Each known failure mode still emits its own
 * site-specific warning before returning; the outer catch only fires for
 * the surprises.
 */
async function loadOnePlugin(program: Command, cliVersion: string, plugin: FoundPlugin): Promise<void> {
	const { name, dir } = plugin;

	try {
		let pkg: { main?: string; peerDependencies?: Record<string, string> };
		try {
			const pkgRaw = await readFile(join(dir, "package.json"), "utf-8");
			pkg = JSON.parse(pkgRaw);
		} catch (err) {
			warn(`failed to read ${name}/package.json: ${(err as Error).message}`);
			return;
		}

		const peerRange = pkg.peerDependencies?.["@jolli.ai/cli"];
		if (peerRange && !satisfies(cliVersion, peerRange, { includePrerelease: true })) {
			warn(`${name} requires @jolli.ai/cli ${peerRange}, but ${cliVersion} is installed — skipping`);
			return;
		}

		// `pkg.main` is typed as `string | undefined` but JSON.parse can hand
		// us anything (number, array, object, …). Validate before passing to
		// node:path APIs that throw TypeError on non-string input.
		const rawMain = pkg.main;
		if (rawMain !== undefined && typeof rawMain !== "string") {
			warn(`${name} package.json "main" is ${typeof rawMain}, expected string — skipping`);
			return;
		}
		const entryRelative = rawMain ?? "./dist/Plugin.js";
		const entryAbs = resolve(dir, entryRelative);
		// Defense in depth: a hostile or buggy `package.json` could set `main` to
		// `"../../../etc/passwd"` or an absolute path elsewhere on disk. The
		// allow-list already gates which packages we look at, but it costs
		// nothing to require the resolved entry stays inside the plugin's own
		// directory before we hand the path to `import()`.
		const entryRel = relative(dir, entryAbs);
		if (entryRel.startsWith("..") || isAbsolute(entryRel)) {
			warn(`${name} entry ${entryRelative} resolves outside plugin directory — skipping`);
			return;
		}
		if (!existsSync(entryAbs)) {
			warn(`${name} entry ${entryRelative} not found at ${entryAbs} — skipping`);
			return;
		}

		// Note: there is a TOCTOU window between this `existsSync` and the
		// `import()` below — a sufficiently fast attacker could swap the entry
		// file in that window. The same race applies to the `package.json`
		// read above (line ~220) and to every other file check the loader
		// performs: anyone who can write to the plugin directory already
		// controls what the loader executes, so the races add no incremental
		// privilege. We accept all of them.
		//
		// Do NOT replace this with a stat+open pattern (it doesn't close the
		// race for ESM `import()`) or remove the existsSync (the warning's
		// specificity for "missing entry" matters for debugging).
		let mod: { register?: PluginRegister };
		try {
			mod = await import(pathToFileURL(entryAbs).href);
		} catch (err) {
			warn(`${name} failed to load: ${(err as Error).message}`);
			return;
		}

		if (typeof mod.register !== "function") {
			warn(`${name} has no exported "register" function — skipping`);
			return;
		}

		// Snapshot the full occupied top-level namespace — primary names AND
		// every alias of every existing command. Commander's _registerCommand
		// rejects a new command whose name OR any alias collides with any
		// existing command's name OR any of its aliases (see knownBy() in
		// commander/lib/command.js), so checking only primary names would let
		// the new "ignore the collision and keep going" guard fail open the
		// moment a builtin like recall reserves an alias such as "context".
		const occupiedNames = new Set<string>();
		for (const c of program.commands) {
			occupiedNames.add(c.name());
			for (const a of c.aliases()) occupiedNames.add(a);
		}

		const ctx: PluginContext = {
			program,
			cliVersion,
			logger: createLogger(`plugin:${name}`),
		};

		const blockedNames = new Set<string>();
		const restoreCommand = patchProgramCommand(program, occupiedNames, blockedNames);
		try {
			await mod.register(ctx);
		} catch (err) {
			warn(`${name} register() threw: ${(err as Error).message}`);
		} finally {
			restoreCommand();
		}

		if (blockedNames.size > 0) {
			const conflictMsg = `tried to register conflicting builtin command(s): ${[...blockedNames].join(", ")} — ignored`;
			warn(`${name} ${conflictMsg}`);
			// Also surface to the plugin's own logger so the message appears
			// under the `plugin:<name>` namespace in debug.log — gives plugin
			// authors a single grep they can run to find their own diagnostics
			// without sifting through host-level warnings.
			ctx.logger.warn(conflictMsg);
		}
	} catch (err) {
		// Safety net: anything that wasn't caught at a more specific site
		// (e.g. malformed JSON yielding pkg.main as an array, a buggy fs
		// implementation throwing on existsSync) lands here so loadPlugins
		// keeps iterating and the CLI keeps running.
		warn(`${name} unexpected loader error: ${(err as Error).message}`);
	}
}

/**
 * Monkey-patch `program.command` and `program.addCommand` for the duration of
 * a plugin's `register()` call.
 *
 * Commander v13's `.command(name, ...)`, `.addCommand(cmd)`, and `.alias(x)`
 * all throw on a name/alias collision with any existing sibling command
 * (`_registerCommand` and `Command.prototype.alias` both consult both name
 * and aliases when checking), which would tear down the rest of the plugin's
 * registration. We intercept every path that could throw:
 *
 *   - `.command(nameAndArgs, ...)` — if the leading token collides with the
 *     occupied namespace, we record the conflict and return a throwaway
 *     `Command` so chained calls (`.description().alias().action()`) don't
 *     crash. The throwaway is never attached to `program`.
 *   - `.addCommand(cmd, ...)` — if `cmd.name()` OR any of `cmd.aliases()`
 *     collides, we record the conflict and return `program` itself (the same
 *     return shape Commander uses for chaining) without attaching the
 *     subcommand.
 *   - `.alias(x)` / `.aliases([x, y])` on a command returned from
 *     `.command(...)` — if any new alias collides with the occupied
 *     namespace, we record the collision and skip just that alias. The
 *     subsequent chained calls (`.description().action()`) still see the
 *     same Command instance, so registration of the rest of the plugin
 *     keeps going.
 *
 * Non-conflicting calls flow through to the real implementations, and every
 * successful registration extends `occupiedNames` so a *later* plugin command
 * in the same `register()` call cannot accidentally re-collide with names
 * the same plugin just claimed.
 *
 * Returns a `restore` thunk; callers must invoke it (in a `finally`) so the
 * builtin behavior comes back after the plugin's registration completes.
 *
 * Scope: this patch only protects the **top-level** command namespace
 * (children of `program`). A plugin can still reach into an existing
 * builtin and attach sub-subcommands via e.g.
 * `ctx.program.commands[0].addCommand(...)`. That is deliberately not
 * intercepted — sub-subcommands cannot collide with another builtin's
 * top-level name, and recursively patching every Command instance would
 * add complexity without protecting anything that matters in practice.
 */
function patchProgramCommand(program: Command, occupiedNames: Set<string>, blockedNames: Set<string>): () => void {
	type CommandMethod = Command["command"];
	type AddCommandMethod = Command["addCommand"];
	const programInternal = program as unknown as { command: CommandMethod; addCommand: AddCommandMethod };
	// Record whether each method was originally an own-property of `program`
	// or inherited from the prototype. Restore branches on this so we do the
	// right thing even if some other layer had already assigned own-properties
	// before we patched (e.g. nested loader invocations, or a future test
	// scaffold) — assignment shadows the prototype, plain `delete` would lose
	// the outer layer.
	// `Object.hasOwn` is ES2022; the project still targets ES2020 in tsconfig.
	// `getOwnPropertyDescriptor` gives the same own-property check on every
	// supported runtime and side-steps biome's noPrototypeBuiltins rule.
	const hadOwnCommand = Object.getOwnPropertyDescriptor(programInternal, "command") !== undefined;
	const hadOwnAddCommand = Object.getOwnPropertyDescriptor(programInternal, "addCommand") !== undefined;
	const origCommand = programInternal.command;
	const origAddCommand = programInternal.addCommand;

	const patchedCommand = function (this: Command, nameAndArgs: string, ...rest: unknown[]): Command {
		// Commander accepts strings like "build <input>" or "auth login [opts]";
		// we extract the leading token as the command name to check.
		const baseName = String(nameAndArgs).split(/[\s<[]/u)[0];
		// Short-circuit when there's no name to check (e.g. plugin passed "" or
		// a leading whitespace). Lets Commander surface its own error rather
		// than us accidentally pruning on an empty match if "" ever ends up in
		// occupiedNames.
		if (baseName && occupiedNames.has(baseName)) {
			blockedNames.add(baseName);
			// Patch the throwaway too — a plugin that chains
			// `.command('context').alias('still-conflicting')` would otherwise
			// hit unpatched Commander code and throw mid-chain.
			//
			// Pass independent empty sets so aliases chained onto the
			// throwaway don't leak into the real namespace. Sharing
			// occupiedNames here would make `.command("enable").alias("foo")`
			// (where "enable" conflicts) record "foo" as occupied, causing a
			// later legitimate `.command("foo")` on the same plugin to be
			// mis-flagged as a conflict and silently dropped.
			return patchCommandAliasMethods(new Command(), new Set<string>(), new Set<string>());
		}
		const newCmd = (origCommand as (this: Command, ...args: unknown[]) => Command).call(this, nameAndArgs, ...rest);
		if (baseName) occupiedNames.add(baseName);
		return patchCommandAliasMethods(newCmd, occupiedNames, blockedNames);
	} as CommandMethod;

	const patchedAddCommand = function (this: Command, cmd: Command, ...rest: unknown[]): Command {
		const baseName = cmd?.name?.();
		// Use a permissive existence check on cmd.aliases — a future test fixture
		// or unusual subclass could omit it; Commander's prototype guarantees it
		// in practice but we don't want a TypeError to crash the loader either.
		const cmdAliases = typeof cmd?.aliases === "function" ? cmd.aliases() : [];
		const conflicts: string[] = [];
		if (baseName && occupiedNames.has(baseName)) conflicts.push(baseName);
		for (const a of cmdAliases) {
			if (occupiedNames.has(a)) conflicts.push(a);
		}
		if (conflicts.length > 0) {
			for (const c of conflicts) blockedNames.add(c);
			return this;
		}
		const result = (origAddCommand as (this: Command, ...args: unknown[]) => Command).call(this, cmd, ...rest);
		if (baseName) occupiedNames.add(baseName);
		for (const a of cmdAliases) occupiedNames.add(a);
		return result;
	} as AddCommandMethod;

	programInternal.command = patchedCommand;
	programInternal.addCommand = patchedAddCommand;

	return () => {
		if (hadOwnCommand) {
			programInternal.command = origCommand;
		} else {
			delete (programInternal as { command?: CommandMethod }).command;
		}
		if (hadOwnAddCommand) {
			programInternal.addCommand = origAddCommand;
		} else {
			delete (programInternal as { addCommand?: AddCommandMethod }).addCommand;
		}
	};
}

/**
 * Replace `cmd.alias` (and `cmd.aliases`, the array setter) on a single
 * Command instance so that conflicting aliases get recorded and skipped
 * rather than thrown.
 *
 * We patch only the instance, not the prototype, so the change is scoped to
 * commands the plugin loader created during this `register()` call. The
 * getter forms (`cmd.alias()` and `cmd.aliases()` with no args) delegate to
 * Commander's originals unchanged so existing read patterns keep working.
 */
function patchCommandAliasMethods(cmd: Command, occupiedNames: Set<string>, blockedNames: Set<string>): Command {
	type AliasMethod = Command["alias"];
	type AliasesMethod = Command["aliases"];
	const origAlias = cmd.alias.bind(cmd) as AliasMethod;
	const origAliases = cmd.aliases.bind(cmd) as AliasesMethod;

	const patchedAlias = function (this: Command, alias?: string): Command | string {
		// No-arg form is the getter — Commander returns _aliases[0]. Pass through.
		if (alias === undefined) return (origAlias as () => string)();
		if (occupiedNames.has(alias)) {
			blockedNames.add(alias);
			return this;
		}
		const result = (origAlias as (a: string) => Command).call(this, alias);
		occupiedNames.add(alias);
		return result;
	} as AliasMethod;

	const patchedAliases = function (this: Command, aliases?: readonly string[]): Command | string[] {
		// No-arg form is the getter — Commander returns the _aliases array. Pass through.
		if (aliases === undefined) return (origAliases as () => string[])();
		// Manually iterate and route each through patchedAlias so we get
		// per-alias skip behavior rather than Commander's prototype iteration
		// (which would still call our `cmd.alias`, but going through
		// patchedAlias directly is the more explicit invariant).
		for (const a of aliases) {
			(patchedAlias as (this: Command, a: string) => Command).call(this, a);
		}
		return this;
	} as AliasesMethod;

	(cmd as unknown as { alias: AliasMethod; aliases: AliasesMethod }).alias = patchedAlias;
	(cmd as unknown as { alias: AliasMethod; aliases: AliasesMethod }).aliases = patchedAliases;
	return cmd;
}

/**
 * Emit a plugin warning. Suppressed when `JOLLI_NO_PLUGIN_WARNINGS=1`.
 * Goes through the standard CLI logger so the debug.log still records it.
 */
function warn(msg: string): void {
	if (process.env.JOLLI_NO_PLUGIN_WARNINGS === "1") {
		log.debug(`[silenced] ${msg}`);
		return;
	}
	log.warn(msg);
}

/**
 * Get the global npm root, caching the result on disk.
 *
 * Cache hit (≤ TTL old): returns the cached path without spawning npm.
 * Cache miss or expired: runs `npm root -g` and writes the result.
 * Subprocess failure (npm missing, timeout, etc.): returns null.
 *
 * Exported with options to support direct unit testing of cache behavior
 * without touching the real `~/.jolli/jollimemory/global-root` file.
 */
export async function getNpmRootGlobal(opts?: NpmRootGlobalOptions): Promise<string | null> {
	const cacheFile = opts?.cacheFile ?? getNpmRootCacheFile();
	const ttlMs = opts?.ttlMs ?? NPM_ROOT_CACHE_TTL_MS;
	const runNpm = opts?.runNpm ?? runNpmRootGlobal;

	try {
		const st = await stat(cacheFile);
		const ageMs = Date.now() - st.mtimeMs;
		if (ageMs < ttlMs) {
			const cached = (await readFile(cacheFile, "utf-8")).trim();
			if (cached.length > 0) return cached;
		}
	} catch {
		/* cache miss — fall through */
	}

	const root = await runNpm();
	if (root) {
		try {
			await mkdir(dirname(cacheFile), { recursive: true });
			await writeFile(cacheFile, root, "utf-8");
		} catch (err) {
			log.debug("failed to write npm-root cache: %s", (err as Error).message);
		}
	}
	return root;
}

/**
 * Run `npm root -g` with a hard timeout. Returns null on any failure.
 *
 * Coverage-ignored: the only side-effect is spawning a subprocess, which is
 * impractical to unit-test deterministically without injecting a fake npm
 * binary onto PATH. Behavior is exercised through manual e2e testing.
 */
/* v8 ignore start */
async function runNpmRootGlobal(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsyncHidden("npm", ["root", "-g"], { timeout: NPM_ROOT_TIMEOUT_MS });
		const trimmed = stdout.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}
/* v8 ignore stop */
