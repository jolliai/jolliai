import type { SourceDefinition } from "../../SourceDefinition.js";

/**
 * jollimemory — track-only references recording that Jolli's OWN memory was
 * consulted while working on a commit. The first self-referential source: the
 * system being referenced is this repo's memory, not a remote service.
 *
 * Three tools are captured — `recall`, `search`, `get_decision_timeline` — and
 * nothing else on the server. The reference is built from the ARGUMENTS via
 * `JolliMemoryNormalize` (hence `argumentsDerived`), which also sidesteps
 * `recall`'s very large results; `trackOnly` keeps the whole thing out of the block
 * fed to the memory-decision LLM, so recalling memory can never feed itself.
 *
 * Two ways this source breaks with every other one:
 *
 *   - **No `reference.url`.** There is no external destination at all. This is
 *     deliberately different from a url spec that fails to resolve (Slack's missing
 *     permalink), which still voids the reference — there, the link exists and we
 *     failed to find it.
 *   - **`accumulateBody`.** Its identity is an ACT, not an entity: `nativeId` is the
 *     tool, so one reference per tool accumulates the queries asked since the last
 *     commit instead of the newest overwriting the rest.
 */
export const jolliMemoryDefinition: SourceDefinition = {
	id: "jollimemory",
	label: "Jolli Memory",
	icon: "history",
	trackOnly: true,
	argumentsDerived: true,
	accumulateBody: true,
	match: {
		claude: {
			// The prefix stays the bare namespace: `CLAUDE_TOOL_PREFIXES` derives the
			// envelope's cheap per-line substring pre-filter from it.
			prefixes: ["mcp__jollimemory__"],
			// …and `exact` narrows that namespace to the captured three. A prefix match is
			// `startsWith`, so `mcp__jollimemory__search` also captures
			// `search_remote_articles` / `search_remote_repo`; `denySuffixes` could
			// enumerate today's siblings but would silently start miscapturing the day a
			// new `search_*` tool ships. An allow-list cannot drift that way.
			exact: ["mcp__jollimemory__recall", "mcp__jollimemory__search", "mcp__jollimemory__get_decision_timeline"],
		},
		// Captured verbatim from a live Codex rollout (2026-07-28) — never inferred.
		// Jolli is a LOCAL MCP server there, which Codex shapes differently again:
		// `function_call.name` is the BARE tool with no namespace, so it matches none of
		// the parser's four line needles and the request line is dropped outright. Only
		// `invocationTools` below ever fires, via the `mcp_tool_call_end` fallback.
		codex: {
			namespaceSuffix: "jollimemory",
			// Recorded for completeness and forward-safety: these are the real bare names,
			// so if Codex ever surfaces a namespace on the request line this path is
			// already correct. It cannot fire today (see above).
			functionCallNames: ["recall", "search", "get_decision_timeline"],
			// The live path. Unlike Claude's `prefixes` (a `startsWith` test that needed a
			// separate `exact` allow-list to stop capturing `search_remote_*`), the registry
			// tests these with `Array.includes` — exact by construction, so naming only the
			// wanted three is itself the exclusion.
			invocationTools: ["recall", "search", "get_decision_timeline"],
			// The first definition to need this, because it is the first whose
			// `invocationTools` are BARE. Every connector-app source is self-scoping — its
			// entries read `asana.get_task`, `atlassian_rovo.fetch` — but `recall` and
			// `search` are names ANY locally-registered MCP server may expose, and the
			// invocation-path lookup is one flat scan across every definition. Without this
			// pin, a foreign local server's `search` would resolve here and its query text
			// would be persisted as a Jolli Memory lookup. The value is the server name the
			// live rollout reported in `invocation.server` (2026-07-28), the same string
			// `~/.codex/config.toml` registers us under.
			invocationServer: "jollimemory",
		},
	},
	wrapperKeys: [],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "tool" }], require: "^(recall|search|get_decision_timeline)$" },
		// The display label is carried in the normalizer output, so this is a plain read
		// rather than a regex ladder mapping tool name → title.
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		// url: deliberately absent — see the header.
		description: { pipe: [{ op: "path", path: "query" }], optional: true },
	},
	fields: [],
	// `recall` / `search` / `get_decision_timeline` contain no path-unsafe byte, and
	// the `require` above pins them to exactly that closed set.
	storage: { nativeIdPathSafe: true },
	// Dead configuration, as for context7: a track-only source never reaches a block
	// builder. Present because the DSL requires it.
	render: {
		wrapperTag: "jolli-memory-lookups",
		itemTag: "lookup",
		bodyTag: "queries",
		maxCharsPerReference: 2000,
		maxTotalChars: 6000,
	},
};
