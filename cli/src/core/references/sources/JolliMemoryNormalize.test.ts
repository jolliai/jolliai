import { describe, expect, it } from "vitest";
import { CURRENT_BRANCH_QUERY, normalizeJolliMemory } from "./JolliMemoryNormalize.js";

// Argument names are pinned against the MCP server's own TOOL_DEFINITIONS
// (cli/src/mcp/McpServer.ts): recall takes an optional `branch`, search a required
// `query`, get_decision_timeline a required `slug`. The inputs below are the shapes
// real transcripts carry.
const RECALL = "mcp__jollimemory__recall";
const SEARCH = "mcp__jollimemory__search";
const TIMELINE = "mcp__jollimemory__get_decision_timeline";

describe("normalizeJolliMemory", () => {
	describe("recall", () => {
		it("uses the branch argument as the query", () => {
			expect(normalizeJolliMemory({ branch: "feature/x" }, RECALL)).toEqual({
				tool: "recall",
				title: "Recall",
				query: "feature/x",
			});
		});

		it("falls back to a literal placeholder for a bare recall()", () => {
			// The real transcript shape for a bare recall is `input: {}` — identical to
			// list_branches(), which is precisely why dispatch is on the tool name.
			expect(normalizeJolliMemory({}, RECALL)).toEqual({
				tool: "recall",
				title: "Recall",
				query: CURRENT_BRANCH_QUERY,
			});
		});

		it("still records the act when the input is unreadable, rather than voiding", () => {
			// recall() takes no arguments, so an absent/garbage input is indistinguishable
			// from a legitimate bare call. Voiding would discard the one fact worth keeping.
			for (const input of [undefined, null, "not-an-object", 42, [], { branch: 42 }, { branch: "" }]) {
				expect(normalizeJolliMemory(input, RECALL)).toEqual({
					tool: "recall",
					title: "Recall",
					query: CURRENT_BRANCH_QUERY,
				});
			}
		});
	});

	describe("search", () => {
		it("uses the query argument", () => {
			expect(normalizeJolliMemory({ query: "queue worker lock", limit: 15 }, SEARCH)).toEqual({
				tool: "search",
				title: "Search",
				query: "queue worker lock",
			});
		});

		it("voids when query is absent, empty, or non-string", () => {
			// Unlike recall, `query` is required by the tool schema — without it there is
			// no act to describe.
			expect(normalizeJolliMemory({}, SEARCH)).toBeNull();
			expect(normalizeJolliMemory({ query: "" }, SEARCH)).toBeNull();
			expect(normalizeJolliMemory({ query: 42 }, SEARCH)).toBeNull();
			expect(normalizeJolliMemory(undefined, SEARCH)).toBeNull();
			expect(normalizeJolliMemory("not-an-object", SEARCH)).toBeNull();
		});
	});

	describe("get_decision_timeline", () => {
		it("uses the slug argument", () => {
			expect(normalizeJolliMemory({ slug: "config-driven-mcp-sources" }, TIMELINE)).toEqual({
				tool: "get_decision_timeline",
				title: "Decision timeline",
				query: "config-driven-mcp-sources",
			});
		});

		it("voids when slug is absent or unusable", () => {
			expect(normalizeJolliMemory({}, TIMELINE)).toBeNull();
			expect(normalizeJolliMemory({ slug: "" }, TIMELINE)).toBeNull();
			expect(normalizeJolliMemory(undefined, TIMELINE)).toBeNull();
		});
	});

	describe("tools deliberately out of scope", () => {
		it("voids list_branches even though its input is byte-identical to a bare recall", () => {
			// THE disambiguation case. Both are `{}`; only the name distinguishes them.
			expect(normalizeJolliMemory({}, "mcp__jollimemory__list_branches")).toBeNull();
		});

		it("voids the search_* siblings whose names extend a captured tool", () => {
			// These are why `MatchClaude.exact` exists — `mcp__jollimemory__search` is a
			// startsWith-prefix of both. The normalizer is the second, independent gate.
			expect(normalizeJolliMemory({ query: "x" }, "mcp__jollimemory__search_remote_articles")).toBeNull();
			expect(normalizeJolliMemory({ query: "x" }, "mcp__jollimemory__search_remote_repo")).toBeNull();
		});

		it("voids the Space, workflow, and status tools", () => {
			for (const name of ["list_spaces", "push_memory", "bind_space", "status", "queue_status", "get_workflow"]) {
				expect(normalizeJolliMemory({}, `mcp__jollimemory__${name}`)).toBeNull();
			}
		});

		it("voids an entirely unknown tool name", () => {
			expect(normalizeJolliMemory({ query: "x" }, "mcp__something_else__search")).toBeNull();
			expect(normalizeJolliMemory({}, "")).toBeNull();
		});
	});

	it("accepts a bare (un-prefixed) tool name", () => {
		// The Claude path always passes the prefixed form; keeping the bare form working
		// means the Codex path can reuse this untouched once its real names are captured.
		expect(normalizeJolliMemory({ query: "orphan branch" }, "search")).toEqual({
			tool: "search",
			title: "Search",
			query: "orphan branch",
		});
	});
});
