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
		: /* v8 ignore next -- fallback for an unbundled execution (no `define:` plugin); the vitest config defines both globals so this branch is unreachable from unit tests */
			"cli/dev";
