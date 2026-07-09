/**
 * Claude producer binding — shared constants for the Claude Code MCP/CLI
 * envelope.
 *
 * Source recognition (which MCP prefix → which source, and tool-level business
 * scope like Notion's `notion-fetch`-only allowlist) now lives in
 * `SourceDefinition.match.claude` and is resolved by the
 * `SourceDefinitionRegistry` directly inside `ClaudeEnvelopeParser` — see
 * `registry.match("claude", name)` there. This module keeps only the two
 * constants the envelope's cheap per-line substring pre-filter needs.
 */

import { getRegistry } from "../../SourceDefinitionRegistry.js";

/**
 * Tool whose `input.command` carries a shell command line. Claude runs CLI
 * fallbacks (e.g. `gh issue view … --json`) through `Bash`; its stdout is fed to
 * the agent-neutral CLI registry. `BashOutput` (the background-shell poller) is
 * deliberately NOT here — it has no `command` input.
 */
export const CLAUDE_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["Bash"]);

/**
 * Tool-name prefixes for the envelope's cheap per-line substring pre-filter.
 * Derived from the `SourceDefinitionRegistry` so match identity has a single
 * source of truth. De-duplicated: two definitions can share the same MCP
 * prefix (e.g. zoom-meeting and zoom-doc both live under
 * `mcp__claude_ai_Zoom_for_Claude__`, disambiguated later by `acceptSuffix`),
 * and this list only feeds a `.some()` pre-filter, so a repeated needle would
 * be redundant rather than incorrect — dedupe keeps it a clean prefix set.
 */
export const CLAUDE_TOOL_PREFIXES: ReadonlyArray<string> = [
	...new Set(
		getRegistry()
			.all()
			.flatMap((d) => d.match.claude?.prefixes ?? []),
	),
];
