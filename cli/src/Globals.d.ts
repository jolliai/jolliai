/** Injected by vite `define` at build time from package.json version. */
declare const __PKG_VERSION__: string;

/**
 * Injected at build time as the @jolli.ai/cli package's version, regardless of
 * which bundler produced the binary.
 *
 * Differs from `__PKG_VERSION__` under the VSCode bundle: there the inlined CLI
 * is shipped with the VSCode plugin, and `__PKG_VERSION__` reports the VSCode
 * extension's version (used for dist-path comparison against `dist-paths/vscode`).
 * `__CLI_PKG_VERSION__` always tracks `cli/package.json` so consumers that want
 * the npm package version (e.g. `jolli export-prompt --output` manifest) get
 * the right number even after CLI / VSCode versions diverge.
 */
declare const __CLI_PKG_VERSION__: string;

/**
 * Surface kind sent in the `x-jolli-client` header alongside the surface's
 * version: wire format is `<__JOLLI_CLIENT_KIND__>/<__PKG_VERSION__>`. The
 * kind mirrors `ClientInfo` in vscode/intellij — `"cli"`, `"vscode-plugin"`,
 * or `"intellij-plugin"` — and lets the server route min-version gating to
 * the right surface. Without this, vscode-bundled hooks would self-identify
 * as `cli` and trip the wrong gate (a vscode-only user would be told to
 * upgrade a CLI they never installed, or worse, slip past the upgrade prompt
 * entirely because the version number reflects the surface, not the bundled
 * CLI code).
 *
 * The version half of the wire identity is already covered by `__PKG_VERSION__`
 * (which each bundler defines as the surface's own version), so we don't
 * also inject a separate `__JOLLI_CLIENT_VERSION__` — that would be a
 * structural duplicate.
 */
declare const __JOLLI_CLIENT_KIND__: "cli" | "vscode-plugin" | "intellij-plugin";
