import { describe, expect, it } from "vitest";
import { getRegistry } from "../../SourceDefinitionRegistry.js";
import { extractRef } from "../../SourceEngine.js";
import { normalizeJolliMemory } from "../JolliMemoryNormalize.js";
import { jolliMemoryDefinition } from "./jollimemory.js";

const AT = "2026-07-28T03:51:52.048Z";
const SEARCH = "mcp__jollimemory__search";

describe("jolliMemoryDefinition", () => {
	it("is track-only, arguments-derived, and accumulating", () => {
		expect(jolliMemoryDefinition.trackOnly).toBe(true);
		expect(jolliMemoryDefinition.argumentsDerived).toBe(true);
		expect(jolliMemoryDefinition.accumulateBody).toBe(true);
	});

	it("declares no url spec at all", () => {
		// Not an unsatisfiable url spec — genuinely absent, because there is no external
		// destination. `extractRef` must therefore never void on url, and the UI must not
		// offer an open-in-browser affordance (Step 4).
		expect(jolliMemoryDefinition.reference.url).toBeUndefined();
	});

	it("extracts one reference per tool from the normalized arguments payload", () => {
		const ref = extractRef(
			jolliMemoryDefinition,
			{ tool: "search", title: "Search", query: "queue worker lock" },
			SEARCH,
			AT,
		);
		expect(ref).not.toBeNull();
		expect(ref?.source).toBe("jollimemory");
		expect(ref?.nativeId).toBe("search");
		expect(ref?.title).toBe("Search");
		expect(ref?.description).toBe("queue worker lock");
		// mapKey is `<source>:<tool>`, so repeated searches accumulate under one key
		// while a recall lands on its own.
		expect(ref?.mapKey).toBe("jollimemory:search");
		expect(ref?.url).toBeUndefined();
	});

	it("gives each captured tool its own mapKey", () => {
		const keys = (["recall", "search", "get_decision_timeline"] as const).map(
			(tool) =>
				extractRef(
					jolliMemoryDefinition,
					normalizeJolliMemory({ branch: "b", query: "q", slug: "s" }, tool),
					tool,
					AT,
				)?.mapKey,
		);
		expect(keys).toEqual(["jollimemory:recall", "jollimemory:search", "jollimemory:get_decision_timeline"]);
	});

	it("voids a payload whose tool is outside the captured three", () => {
		// Defends the `nativeId` require against a payload that reached extraction with
		// an unexpected tool — the require is also what keeps nativeId path-safe.
		expect(
			extractRef(jolliMemoryDefinition, { tool: "list_branches", title: "List", query: "x" }, SEARCH, AT),
		).toBeNull();
		expect(
			extractRef(jolliMemoryDefinition, { tool: "search_remote_repo", title: "S", query: "x" }, SEARCH, AT),
		).toBeNull();
		// A traversal-shaped tool cannot slip through to the filesystem path.
		expect(
			extractRef(jolliMemoryDefinition, { tool: "../../etc/passwd", title: "x", query: "x" }, SEARCH, AT),
		).toBeNull();
	});

	it("voids a payload with no tool or no title", () => {
		expect(extractRef(jolliMemoryDefinition, { title: "Search", query: "x" }, SEARCH, AT)).toBeNull();
		expect(extractRef(jolliMemoryDefinition, { tool: "search", query: "x" }, SEARCH, AT)).toBeNull();
		expect(extractRef(jolliMemoryDefinition, { tool: "search", title: "", query: "x" }, SEARCH, AT)).toBeNull();
	});

	it("keeps the reference when the query is absent (description optional)", () => {
		const ref = extractRef(
			jolliMemoryDefinition,
			{ tool: "recall", title: "Recall" },
			"mcp__jollimemory__recall",
			AT,
		);
		expect(ref?.nativeId).toBe("recall");
		expect(ref?.description).toBeUndefined();
	});

	describe("registry matching", () => {
		it("matches exactly the three captured tools", () => {
			const r = getRegistry();
			expect(r.match("claude", "mcp__jollimemory__recall")?.id).toBe("jollimemory");
			expect(r.match("claude", "mcp__jollimemory__search")?.id).toBe("jollimemory");
			expect(r.match("claude", "mcp__jollimemory__get_decision_timeline")?.id).toBe("jollimemory");
		});

		it("does not match a sibling whose name merely extends a captured one", () => {
			// The whole reason `MatchClaude.exact` exists: these share the `…__search`
			// startsWith-prefix and must not be captured.
			const r = getRegistry();
			expect(r.match("claude", "mcp__jollimemory__search_remote_articles")).toBeUndefined();
			expect(r.match("claude", "mcp__jollimemory__search_remote_repo")).toBeUndefined();
		});

		it("does not match any other tool on the same server", () => {
			const r = getRegistry();
			for (const name of ["list_branches", "list_spaces", "push_memory", "status", "get_pr_description"]) {
				expect(r.match("claude", `mcp__jollimemory__${name}`)).toBeUndefined();
			}
		});

		it("matches the three BARE tool names on the Codex invocation path", () => {
			// Codex models a local MCP server as bare tool names — captured from a live
			// rollout 2026-07-28, never inferred (this replaced the hard gate that used to
			// assert match.codex was absent). The registry resolves the no-namespace case
			// through `invocationTools`, scoped by the event's `invocation.server`.
			const r = getRegistry();
			for (const tool of ["recall", "search", "get_decision_timeline"]) {
				expect(r.match("codex", tool, undefined, "jollimemory")?.id).toBe("jollimemory");
			}
		});

		it("excludes sibling tools on the Codex path by construction", () => {
			// `invocationTools` is tested with Array.includes — exact, unlike Claude's
			// startsWith prefixes which needed a separate `exact` allow-list. So the
			// `search_*` siblings that forced that allow-list cannot leak in here.
			const r = getRegistry();
			for (const tool of ["search_remote_articles", "search_remote_repo", "list_branches", "status"]) {
				expect(r.match("codex", tool, undefined, "jollimemory")).toBeUndefined();
			}
		});

		it("does not claim another local MCP server's identically-named bare tool", () => {
			// THE reason `invocationServer` exists. `recall` / `search` are names any
			// locally-registered server may expose, and the invocation-path lookup is one
			// flat scan over every definition with no other qualifier — so a foreign
			// server's `search` would otherwise resolve here and its query text would be
			// persisted as a Jolli Memory lookup.
			const r = getRegistry();
			for (const server of ["some-docs-server", "claude-mem", "codex_apps"]) {
				for (const tool of ["recall", "search", "get_decision_timeline"]) {
					expect(r.match("codex", tool, undefined, server)).toBeUndefined();
				}
			}
		});

		it("fails closed when the event reported no server at all", () => {
			// A serverless event cannot be attributed, and mis-attributing is worse than
			// missing one. Every real `mcp_tool_call_end` carries `invocation.server`.
			const r = getRegistry();
			for (const tool of ["recall", "search", "get_decision_timeline"]) {
				expect(r.match("codex", tool)).toBeUndefined();
			}
		});

		it("leaves server-qualified sources matchable without a server", () => {
			// Every connector-app source is self-scoping (`asana.get_task`), declares no
			// `invocationServer`, and must keep matching exactly as before — the new scope
			// can only ever reject, never widen.
			const r = getRegistry();
			expect(r.match("codex", "asana.get_task")?.id).toBe("asana");
			expect(r.match("codex", "asana.get_task", undefined, "codex_apps")?.id).toBe("asana");
		});
	});
});
