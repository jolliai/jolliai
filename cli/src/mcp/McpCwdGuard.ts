/**
 * The plugin-bundle cwd guard, as a LEAF module.
 *
 * Kept as its own module purely for import cost: the proxy has to answer "should
 * this directory be served at all?" before it does anything, and reaching into
 * [`McpServer.ts`](McpServer.ts) for the answer would pull the storage stack, the
 * search index and the push client into a process whose whole job is to forward
 * bytes. `McpServer` re-exports it, so it remains one rule with one definition.
 *
 * That definition lives one level down, in
 * [`core/PluginBundlePaths`](../core/PluginBundlePaths.ts), because the MCP server is
 * not the only caller: the Cursor plugin bootstrap needs the identical predicate —
 * Cursor runs a plugin hook with the PLUGIN ROOT as its cwd, so the bootstrap must
 * refuse it rather than install this repo's git hooks into the bundle it was launched
 * from. A hook reaching into `mcp/` for that would be the wrong dependency direction,
 * so the markers sit in `core/` and this file is the mcp-side alias. It stays a
 * re-export rather than being deleted so the proxy's import path is unaffected.
 */

export { isPluginBundleCwd } from "../core/PluginBundlePaths.js";
