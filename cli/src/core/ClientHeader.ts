/**
 * `x-jolli-client` header value, build-time bundler-injected.
 *
 * Resolution chain:
 *  - kind: `__JOLLI_CLIENT_KIND__` defined by vite (CLI build → `"cli"`) and
 *    by esbuild (VSCode build → `"vscode-plugin"`).
 *  - version: `__PKG_VERSION__` defined by both bundlers; under VS Code this
 *    is the extension version (the surface the user installed and would
 *    upgrade), not the inlined CLI package version.
 *
 * This module is inlined into both bundles, so a hook installed by the
 * VS Code plugin correctly self-identifies as `vscode-plugin/<vscode-version>`.
 *
 * Tests stub the globals via `vi.stubGlobal`.
 *
 * Why a dedicated file: this constant is needed by every Jolli backend
 * client (LlmClient, the new sync BackendClient, etc.). Pulling all of
 * LlmClient in just for the header forces a much larger import surface;
 * a one-liner module keeps coupling minimal.
 */

export const JOLLI_CLIENT_HEADER =
	typeof __JOLLI_CLIENT_KIND__ !== "undefined" && typeof __PKG_VERSION__ !== "undefined"
		? `${__JOLLI_CLIENT_KIND__}/${__PKG_VERSION__}`
		: /* v8 ignore start -- fallback for an unbundled execution (no `define:` plugin); the vitest config defines both globals so this branch is unreachable from unit tests */
			"cli/dev";
/* v8 ignore stop */

/**
 * Build-time client kind (`__JOLLI_CLIENT_KIND__`), resolved safely.
 *
 * The global is a bundler `define:` (vite for the CLI build, esbuild for the
 * VS Code / plugin builds). Under an unbundled execution — `tsx src/Cli.ts`,
 * i.e. `npm run cli` in development — no `define:` ran, so a *bare* reference
 * to `__JOLLI_CLIENT_KIND__` throws `ReferenceError`. `typeof` never throws,
 * so every runtime read must go through this guard rather than touching the
 * global directly. Mirrors `JOLLI_CLIENT_HEADER` above.
 */
export function resolveClientKind(): typeof __JOLLI_CLIENT_KIND__ {
	/* v8 ignore next -- the vitest config defines the global, so the `: "cli"` fallback is unreachable from unit tests */
	return typeof __JOLLI_CLIENT_KIND__ !== "undefined" ? __JOLLI_CLIENT_KIND__ : "cli";
}

/** True when this bundle is the Claude Code plugin's CLI. Never throws unbundled. */
export function isClaudePluginBuild(): boolean {
	return resolveClientKind() === "claude-plugin";
}

/**
 * Every client kind that denotes an AI-host plugin's embedded CLI.
 *
 * A set rather than an `||` chain so adding a host is one entry — the chain form had
 * already gone stale by the time a third plugin shipped, and the failure is silent:
 * the bundle just inherits standalone-CLI behavior. Deliberately NOT derived from
 * `PLUGIN_HOSTS` in `core/localagent/PluginDefaults`, even though the literals
 * coincide: that table is keyed by install SOURCE TAG and pulls in the config stack,
 * while this module is a leaf the push client depends on.
 *
 * That the literals coincide is nonetheless load-bearing — `SessionStartHook` resolves
 * a skill invocation by looking a CLIENT KIND up in that source-tag table — so this is
 * exported for `ClientHeader.test.ts` to assert against `PLUGIN_HOST_SOURCE_TAGS`.
 * Duplicating the list is the deliberate choice; letting the two copies drift is not.
 */
export const PLUGIN_BUNDLE_KINDS: ReadonlySet<string> = new Set(["claude-plugin", "codex-plugin", "cursor-plugin"]);

/**
 * Whether a client kind denotes an AI-host plugin's embedded CLI rather than a
 * standalone install.
 *
 * Split from {@link isPluginBundleBuild} so the classification is reachable in tests:
 * `__JOLLI_CLIENT_KIND__` is a bundler `define:` fixed to `"cli"` under vitest, so a
 * predicate that reads it can only ever be observed returning false. Keeping the
 * decision in a pure function over the kind lets every arm be pinned.
 */
export function isPluginBundleKind(kind: typeof __JOLLI_CLIENT_KIND__): boolean {
	return PLUGIN_BUNDLE_KINDS.has(kind);
}

/**
 * True when this bundle is ANY AI-host plugin's embedded CLI, not a standalone
 * install.
 *
 * Distinct from {@link isClaudePluginBuild} on purpose: use this one for decisions
 * that follow from "this CLI is embedded in a plugin and exposes only a fixed
 * command surface" (see the discovery gate in PluginLoader), and the Claude-specific
 * predicate only for decisions about Claude's own assets. A new plugin host must be
 * added to {@link isPluginBundleKind}, or it silently inherits standalone-CLI
 * behavior — the exact bug this predicate exists to prevent.
 */
export function isPluginBundleBuild(): boolean {
	return isPluginBundleKind(resolveClientKind());
}
