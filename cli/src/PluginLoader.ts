/// <reference types="node" />
/**
 * PluginLoader — discovery and dynamic loading of CLI plugins.
 *
 * A plugin is an npm package that declares a stable, opaque random string in
 * its `package.json` under `jolliPluginId`. The loader scans well-known scope
 * directories ({@link PLUGIN_SCOPES}) inside each `node_modules` root and only
 * loads packages whose declared ID is in {@link KNOWN_PLUGIN_IDS}. Package
 * names are intentionally **not** used for gating — names can change as the
 * plugin ecosystem evolves, and binding the host CLI to a specific name would
 * also leak that name (and any commercial-product hint it carries) into the
 * open-source codebase.
 *
 * For each matching candidate the loader walks the local `node_modules`
 * (including hoisted parents, for pnpm/Yarn-workspaces-style monorepos) and
 * the cached global npm root; the first match per ID wins:
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
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
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

/**
 * Allow-list of plugin IDs. Each entry is an opaque random string that the
 * matching plugin embeds in its own `package.json` as `jolliPluginId`. IDs are
 * stable for the lifetime of a plugin: a plugin author can rename, re-scope,
 * or re-publish their package without touching this list.
 *
 * IDs are not secrets — they are bundled in the plugin's package.json and
 * visible to anyone who installs it. The security boundary is still the scope
 * restriction in {@link PLUGIN_SCOPES} plus npm's own ownership controls on
 * the scopes we trust. Random IDs just make the allow-list flexible across
 * package renames.
 */
const KNOWN_PLUGIN_IDS: ReadonlyArray<string> = ["c56530c4-3f2f-467f-a4a4-db4d44c79c1c"];

/**
 * Scope directories the loader scans under each `node_modules` root. Bounding
 * discovery to known scopes keeps the per-invocation I/O cost predictable
 * (one `readdir` per scope per root) and limits the surface area to scopes
 * whose npm ownership we control.
 */
const PLUGIN_SCOPES: ReadonlyArray<string> = ["@jolli.ai"];

/** Path to the `npm root -g` cache file under the global config dir. */
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
	/** Replace the {@link KNOWN_PLUGIN_IDS} allow-list. Used by tests with fake IDs. */
	allowlistOverride?: ReadonlyArray<string>;
	/** Replace the {@link PLUGIN_SCOPES} scan set. Used by tests that fixture under a different scope. */
	scopesOverride?: ReadonlyArray<string>;
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

	const allowlist = opts?.allowlistOverride ?? KNOWN_PLUGIN_IDS;
	const scopes = opts?.scopesOverride ?? PLUGIN_SCOPES;
	const roots = await resolveRoots(opts);
	const found = await discoverPlugins(roots, scopes, allowlist);

	for (const plugin of found) {
		await loadOnePlugin(program, cliVersion, plugin);
	}
}

/**
 * Subset of a plugin's `package.json` that the loader consumes after discovery.
 * Typed loosely (`main` as `unknown`) because `JSON.parse` will hand us
 * whatever the file contained — `loadOnePlugin` does its own runtime check
 * before passing the value to `node:path` APIs that throw on non-string input.
 */
interface PluginPackageJson {
	main?: unknown;
	peerDependencies?: Record<string, string>;
}

interface FoundPlugin {
	/** Full package name (e.g. `@scope/name`) — used in diagnostics, not for gating. */
	name: string;
	dir: string;
	/** The `jolliPluginId` declared by the plugin; already verified to be in the allow-list. */
	pluginId: string;
	/** The plugin's parsed `package.json`. Carried from discovery so the loader does not re-read it. */
	pkg: PluginPackageJson;
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
 * Walk the given roots, scan each known scope directory, and return the first
 * matching package directory per allow-listed plugin ID.
 *
 * A package matches when its `package.json` declares a string `jolliPluginId`
 * field whose value appears in `allowlist`. Packages without the field, with a
 * non-string value, or with an ID not on the list are silently skipped — at
 * discovery time we deliberately stay quiet because we are iterating over
 * arbitrary user-installed packages and a missing field is the normal case.
 * Loader-level diagnostics (peerDep mismatch, malformed main, register-throws,
 * etc.) still fire in {@link loadOnePlugin} once an allow-listed candidate is
 * identified.
 *
 * Ordering: roots are walked in priority order (earlier wins); within a root,
 * scopes are walked in the order supplied; within a scope, entries are sorted
 * lexicographically so the "first match wins" rule is deterministic across
 * filesystems (`readdir`'s native order is inode-allocation on ext4,
 * undefined on APFS, and varies per FS — relying on it would make duplicate-
 * ID outcomes flap between machines and CI runners).
 *
 * Duplicate-ID handling: a plugin hoisted to the project root takes precedence
 * over the same ID present in the global npm root (normal hoisting — silent).
 * But two packages declaring the same ID inside the same scope+root is a
 * misconfiguration we warn about (most often: a rename mid-migration where
 * both old and new package names ended up installed). The lexicographically
 * first one wins, the rest are skipped with a warning so the user can clean
 * up.
 */
async function discoverPlugins(
	roots: ReadonlyArray<string>,
	scopes: ReadonlyArray<string>,
	allowlist: ReadonlyArray<string>,
): Promise<FoundPlugin[]> {
	const found: FoundPlugin[] = [];
	const seenAcrossRoots = new Set<string>();

	for (const root of roots) {
		for (const scope of scopes) {
			const scopeDir = join(root, scope);
			if (!existsSync(scopeDir)) continue;

			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(scopeDir, { withFileTypes: true });
			} catch {
				// Scope directory exists but is unreadable (permissions, race, …).
				// Treat as if absent — silently skip so a single broken root does
				// not block discovery in the other roots.
				continue;
			}

			// Sort for deterministic "first match wins". Without this, two packages
			// declaring the same ID would race on the underlying filesystem order.
			// Plain `<`/`>` is a byte-order comparison (not locale-sensitive), so
			// the winner is the same regardless of the runner's `LC_COLLATE` —
			// `localeCompare(b.name)` without a fixed locale would otherwise
			// reorder names containing case or punctuation between machines.
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

			// Per-scope+root dedupe. Used to detect two packages claiming the same
			// ID at the same depth (the unstable-migration case the comment above
			// describes); cross-root duplicates are handled silently by
			// `seenAcrossRoots` because that's normal hoisting.
			const seenInThisScope = new Map<string, string>();

			for (const entry of entries) {
				// Accept real directories and symlinks (npm link, yarn workspaces,
				// pnpm's non-isolated layouts all surface plugins as symlinks; the
				// downstream `existsSync(pkgPath)` follows them and broken links
				// fall out there). Anything else — stray files, sockets — is
				// filtered cheaply here so we don't spend a stat on existsSync.
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				const dir = join(scopeDir, entry.name);
				const pkgPath = join(dir, "package.json");
				if (!existsSync(pkgPath)) continue;

				let pluginId: string | undefined;
				let pkg: PluginPackageJson = {};
				try {
					const pkgRaw = await readFile(pkgPath, "utf-8");
					const parsed: unknown = JSON.parse(pkgRaw);
					// `JSON.parse` can return null, primitives, or arrays — none
					// of which can legitimately be a `package.json`. Reject these
					// before reading fields so a later refactor that drops the
					// `!pluginId` short-circuit can't accidentally read `.main`
					// off a string or array.
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						continue;
					}
					const pkgObj = parsed as PluginPackageJson & { jolliPluginId?: unknown };
					if (typeof pkgObj.jolliPluginId === "string") {
						pluginId = pkgObj.jolliPluginId;
					}
					pkg = pkgObj;
				} catch (err) {
					// Malformed package.json. We can't tell from a manifest we
					// failed to read/parse whether this is the allow-listed plugin
					// (the `jolliPluginId` check below is what decides that, and we
					// never got that far), so a user-facing WARNING would be noisy —
					// it'd fire for any unrelated package sharing the scope with a
					// broken manifest. But staying entirely silent means a real
					// plugin shipping a corrupt manifest vanishes with zero trace,
					// which is harder to diagnose than the old by-name loading.
					// Compromise: leave a debug breadcrumb (only surfaced with
					// debug logging on) recording the path + parse error, matching
					// the symlink-forensics `log.debug` pattern below. Then skip.
					log.debug(
						`skipping ${scope}/${entry.name}: unreadable/invalid package.json (${
							err instanceof Error ? err.message : String(err)
						})`,
					);
					continue;
				}

				if (!pluginId || !allowlist.includes(pluginId)) continue;

				// Symlink forensics: when an allow-listed plugin is mounted via a
				// symlink that resolves outside the originally-walked roots
				// (npm link to a sibling checkout, ad-hoc `ln -s`, …), record
				// a debug breadcrumb so the indirection shows up in debug.log.
				// We do NOT refuse to load — a user who can place a symlink
				// under their own `@jolli.ai/` scope already has the write
				// privilege required to drop a real package there, and a
				// blanket refusal would break `npm link` / yarn workspaces.
				// `realpath` is async + can throw on broken links; both
				// outcomes are benign — fall back to `dir` silently.
				if (entry.isSymbolicLink()) {
					try {
						const real = await realpath(dir);
						const insideAnyRoot = roots.some((r) => {
							const rel = relative(r, real);
							return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
						});
						if (!insideAnyRoot) {
							log.debug(
								`plugin symlink ${scope}/${entry.name} resolves to ${real}, outside walked roots — loading anyway (see SECURITY.md)`,
							);
						}
					} catch (err) {
						// realpath threw (broken link, permission-denied parent, …).
						// Downstream existsSync already followed the link to verify
						// the package.json exists, so loading proceeds. Record the
						// audit gap so the indirection still leaves a breadcrumb
						// in debug.log even when the resolved target is unknown.
						//
						// Coverage-ignored: reaching this requires a symlink whose
						// `package.json` is reachable via `existsSync` yet whose
						// `realpath` rejects (EACCES on a parent, mid-walk ELOOP).
						// That can't be constructed on a real filesystem without
						// mocking `node:fs`, and the handler is a non-behavioral
						// debug breadcrumb — same rationale as `runNpmRootGlobal`.
						/* v8 ignore start */
						log.debug(
							`plugin symlink ${scope}/${entry.name} realpath failed (${errMessage(err)}) — loading without audit trail`,
						);
						/* v8 ignore stop */
					}
				}

				const earlierName = seenInThisScope.get(pluginId);
				if (earlierName !== undefined) {
					warn(
						`${scope}/${entry.name} declares jolliPluginId ${pluginId}, already claimed by ${scope}/${earlierName} in ${root} — skipping`,
					);
					continue;
				}
				seenInThisScope.set(pluginId, entry.name);

				if (seenAcrossRoots.has(pluginId)) continue;
				seenAcrossRoots.add(pluginId);

				found.push({ name: `${scope}/${entry.name}`, dir, pluginId, pkg });
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
	const { name, dir, pkg } = plugin;

	try {
		const peerRange = pkg.peerDependencies?.["@jolli.ai/cli"];
		if (peerRange && !satisfies(cliVersion, peerRange, { includePrerelease: true })) {
			warn(`${name} requires @jolli.ai/cli ${peerRange}, but ${cliVersion} is installed — skipping`);
			return;
		}

		// `pkg.main` is typed as `unknown` because `JSON.parse` can hand us
		// anything (number, array, object, …). Validate before passing to
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
		// file in that window. The same race applies to every file check the
		// loader performs (discovery's `package.json` read, this `existsSync`,
		// etc.): anyone who can write to the plugin directory already controls
		// what the loader executes, so the races add no incremental privilege.
		// We accept all of them.
		//
		// Do NOT replace this with a stat+open pattern (it doesn't close the
		// race for ESM `import()`) or remove the existsSync (the warning's
		// specificity for "missing entry" matters for debugging).
		let mod: { register?: PluginRegister };
		try {
			mod = await import(pathToFileURL(entryAbs).href);
		} catch (err) {
			warn(`${name} failed to load: ${errMessage(err)}`);
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
			warn(`${name} register() threw: ${errMessage(err)}`);
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
		warn(`${name} unexpected loader error: ${errMessage(err)}`);
	}
}

/**
 * Stringify an unknown thrown value for diagnostic warnings. Plugins are
 * untrusted code — `throw "boom"` and `throw null` would otherwise render as
 * `(err as Error).message === undefined`, losing the only signal the operator
 * has for tracking down a misbehaving plugin.
 */
function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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
 * Scope: this patch covers exactly the four collision throws Commander
 * raises when a plugin registers a NEW top-level command — `.command(...)`,
 * `.addCommand(...)`, and the returned command's `.alias(...)` / `.aliases(...)`.
 * Anything else a plugin reaches for through `ctx.program.commands[]` is
 * deliberately not intercepted, including:
 *
 *   - attaching sub-subcommands under an existing builtin
 *     (`ctx.program.commands[0].addCommand(...)`);
 *   - replacing or wrapping a builtin's action handler
 *     (`ctx.program.commands.find(c => c.name() === "enable").action(...)`);
 *   - adding aliases to an already-registered builtin
 *     (`ctx.program.commands[i].alias("...")`).
 *
 * Allow-listed plugins live inside the same `node_modules/@jolli.ai/` trust
 * boundary as the host CLI — see SECURITY.md "Operational guidance". They
 * are treated as co-maintainers of the program namespace, not as a sandbox.
 * The collision interception above is purely an ergonomics gate so a NEW
 * command that happens to overlap a builtin name doesn't tear down the
 * rest of the plugin's registration; it is **not** a privilege boundary
 * against arbitrary mutation of program-attached commands.
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
		// Commander's `.command(name, description)` (the executable-subcommand
		// form) returns `this` instead of a freshly-created sub-command — see
		// `if (desc) return this;` in commander/lib/command.js. If we ran
		// `patchCommandAliasMethods(this, …)` we'd install own-properties for
		// `alias` and `aliases` directly on `program`, and `restoreCommand`
		// below only restores `command` / `addCommand`, so those alias patches
		// would leak past `register()` (holding stale `occupiedNames` /
		// `blockedNames` closures forever). Skip the alias patch when Commander
		// returned `this`; chained `.alias()` on the executable form would call
		// into program-level methods anyway, where collisions are Commander's
		// own job to surface.
		if (newCmd === this) return newCmd;
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
