import { normalizeContext7 } from "../../sources/Context7Normalize.js";
import type { CodexNormalizer } from "./CodexBinding.js";

/**
 * Local-MCP context7 calls match via the FALLBACK path (mcp_tool_call_end,
 * invocation.tool = "query-docs", invocation.arguments carries libraryId); the
 * codex_apps connector variant matches via PRIMARY. Either way the business
 * payload is ignored — the reference is built from the arguments.
 */
export const context7CodexBinding: CodexNormalizer = {
	id: "context7",
	canonicalToolName: "mcp__context7__query-docs",
	normalize: (_business, toolInput) => normalizeContext7(toolInput),
};
