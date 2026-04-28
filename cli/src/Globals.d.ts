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
