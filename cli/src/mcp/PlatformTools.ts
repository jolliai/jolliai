/**
 * Activation gate for the manifest-driven Jolli-platform MCP tools.
 *
 * The `jolli mcp` server registers backend-defined platform tools only when
 * this gate is open; otherwise it stays git-memory-only and never contacts the
 * backend for a tool manifest. The feature is opt-in (off by default): the
 * config flag `mcpPlatformToolsEnabled` must be explicitly `true`, OR the
 * escape-hatch env var `JOLLI_MCP_PLATFORM_TOOLS` must be exactly `"1"` (for
 * CI / debugging without touching config.json — same strict `=== "1"` shape as
 * the other CLI env gates).
 */

import type { JolliMemoryConfig } from "../Types.js";

/** Env var that force-enables the platform tools without a config write. */
export const PLATFORM_TOOLS_ENV_FLAG = "JOLLI_MCP_PLATFORM_TOOLS";

/**
 * Returns true when the manifest-driven Jolli-platform tools should be
 * registered. Opt-in: the config flag must be `true`, or the env flag must be
 * the literal `"1"`. `env` is injectable so the decision is unit-testable
 * without mutating `process.env`.
 */
export function isPlatformToolsEnabled(
	config: Pick<JolliMemoryConfig, "mcpPlatformToolsEnabled">,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return config.mcpPlatformToolsEnabled === true || env[PLATFORM_TOOLS_ENV_FLAG] === "1";
}
