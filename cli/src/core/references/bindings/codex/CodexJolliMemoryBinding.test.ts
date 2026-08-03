import { describe, expect, it } from "vitest";
import { CLAUDE_TOOL_PREFIX } from "../../sources/JolliMemoryNormalize.js";
import type { CodexNormalizeEnv } from "./CodexBinding.js";
import { jolliMemoryCodexBinding } from "./CodexJolliMemoryBinding.js";

const binding = jolliMemoryCodexBinding;
const canonical = (raw: string) => (binding.canonicalToolName as (r: string) => string)(raw);

/** The scan-wide fields are always supplied by the parser; only `toolName` varies per call. */
const env = (toolName: string): CodexNormalizeEnv => ({ permalinks: new Map(), toolName });

describe("jolliMemoryCodexBinding", () => {
	it("is registered under the jollimemory source id", () => {
		expect(binding.id).toBe("jollimemory");
	});

	// Codex reports the BARE tool name; persisting it verbatim would make
	// `sourceToolName` differ from the same lookup captured under Claude.
	it("maps each bare Codex tool name back onto its Claude spelling", () => {
		expect(canonical("recall")).toBe(`${CLAUDE_TOOL_PREFIX}recall`);
		expect(canonical("search")).toBe(`${CLAUDE_TOOL_PREFIX}search`);
		expect(canonical("get_decision_timeline")).toBe(`${CLAUDE_TOOL_PREFIX}get_decision_timeline`);
	});

	it("distinguishes the three tools by env.toolName, ignoring the business payload", () => {
		const business = { irrelevant: true };
		expect(binding.normalize(business, {}, env("recall"))).toMatchObject({ tool: "recall" });
		expect(binding.normalize(business, { query: "orphan branch" }, env("search"))).toMatchObject({
			tool: "search",
			query: "orphan branch",
		});
		expect(binding.normalize(business, { slug: "storage-mode" }, env("get_decision_timeline"))).toMatchObject({
			tool: "get_decision_timeline",
			query: "storage-mode",
		});
	});

	it("accepts the Claude-prefixed spelling of the tool name too", () => {
		expect(binding.normalize({}, {}, env(`${CLAUDE_TOOL_PREFIX}recall`))).toMatchObject({
			tool: "recall",
		});
	});

	// Only the `mcp_tool_call_end` fallback carries an `invocation`, so a caller
	// that never resolved one passes no env at all. With no tool name there is
	// nothing to identify, so the reference must be voided rather than guessed.
	it("voids the reference when no env (or no toolName) is supplied", () => {
		expect(binding.normalize({})).toBeNull();
		expect(binding.normalize({}, {})).toBeNull();
		expect(binding.normalize({}, {}, { permalinks: new Map() } as CodexNormalizeEnv)).toBeNull();
	});

	it("voids a tool this source does not own", () => {
		expect(binding.normalize({}, {}, env("list_branches"))).toBeNull();
	});
});
