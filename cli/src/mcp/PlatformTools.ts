/**
 * Activation gate for the manifest-driven Jolli-platform MCP tools.
 *
 * The `jolli mcp` server registers backend-defined platform tools only when
 * this gate is open; otherwise it stays git-memory-only and never contacts the
 * backend for a tool manifest. The feature is **on by default** (matching the
 * other `*Enabled` config keys): an unset config flag counts as enabled, so the
 * gate is open unless the config flag `mcpPlatformToolsEnabled` is explicitly
 * `false`, OR — regardless of the config value — the escape-hatch env var
 * `JOLLI_MCP_PLATFORM_TOOLS` is exactly `"1"` (which still force-enables for
 * CI / debugging without touching config.json — same strict `=== "1"` shape as
 * the other CLI env gates). The manifest fetch is best-effort, so defaulting on
 * degrades silently to "no platform tools" when no key is configured.
 */

import type { JolliMemoryConfig } from "../Types.js";

/** Env var that force-enables the platform tools without a config write. */
export const PLATFORM_TOOLS_ENV_FLAG = "JOLLI_MCP_PLATFORM_TOOLS";

/**
 * Returns true when the manifest-driven Jolli-platform tools should be
 * registered. On by default: enabled unless the config flag is explicitly
 * `false`, or force-enabled when the env flag is the literal `"1"` (the env
 * flag wins even over an explicit `false`). `env` is injectable so the decision
 * is unit-testable without mutating `process.env`.
 */
export function isPlatformToolsEnabled(
	config: Pick<JolliMemoryConfig, "mcpPlatformToolsEnabled">,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return config.mcpPlatformToolsEnabled !== false || env[PLATFORM_TOOLS_ENV_FLAG] === "1";
}
