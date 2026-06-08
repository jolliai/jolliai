/**
 * Claude producer binding — resolves a Claude Code MCP tool name to its source
 * (and a normalize step). Claude talks to each vendor's OWN MCP server, whose
 * payloads were the model for the canonical adapter shape, so `normalize` is
 * identity today; it is written explicitly so that, when Claude later diverges
 * (e.g. a search tool returning partial entities), the hook is already here.
 *
 * Recognition carries BOTH concerns that used to live on the adapter:
 *   - source recognition (which MCP prefix → which source), and
 *   - **tool-level business scope** — notably Notion only accepts `notion-fetch`
 *     and excludes `notion-search`/`update`/`write`. That allowlist is NOT source
 *     recognition; it must live here because the purified adapter no longer sees
 *     the tool name.
 */

import type { SourceId } from "../../../../Types.js";

export interface ClaudeBinding {
	readonly sourceId: SourceId;
	normalize(business: unknown): unknown;
}

interface Rule {
	readonly prefix: string;
	readonly sourceId: SourceId;
	/** Extra tool-level scope check beyond the prefix (business range), if any. */
	readonly accept?: (name: string) => boolean;
}

const RULES: readonly Rule[] = [
	{ prefix: "mcp__github__", sourceId: "github" },
	{ prefix: "mcp__claude_ai_Atlassian__", sourceId: "jira" },
	{ prefix: "mcp__linear__", sourceId: "linear" },
	// Notion: prefix matches all notion tools; only `notion-fetch` is in business
	// scope (search/update/write deliberately excluded).
	{ prefix: "mcp__claude_ai_Notion__", sourceId: "notion", accept: (name) => name.endsWith("notion-fetch") },
];

const identity = (business: unknown): unknown => business;

/** Tool-name prefixes for the envelope's cheap per-line substring pre-filter. */
export const CLAUDE_TOOL_PREFIXES: ReadonlyArray<string> = RULES.map((r) => r.prefix);

/**
 * Resolve a Claude MCP tool name to its binding, or null if the tool is not a
 * recognised in-scope reference source.
 */
export function claudeBindingForToolName(name: string): ClaudeBinding | null {
	for (const rule of RULES) {
		if (!name.startsWith(rule.prefix)) continue;
		// The four prefixes are mutually exclusive, so a prefix match means no other
		// rule can match — returning null here on an `accept` miss (rather than
		// continuing) is safe. If an overlapping prefix is ever added, revisit this.
		if (rule.accept !== undefined && !rule.accept(name)) return null;
		return { sourceId: rule.sourceId, normalize: identity };
	}
	return null;
}
