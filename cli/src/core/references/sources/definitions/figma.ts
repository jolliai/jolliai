import type { SourceDefinition } from "../../SourceDefinition.js";
import { FIGMA_TOOL_NAMES, FIGMA_TOOL_PREFIXES } from "../FigmaNormalize.js";

/**
 * Figma's own declared file-key grammar, verbatim from all five tool schemas.
 *
 * This `require` is the ONLY thing keeping a malformed key out — a transcript records
 * the `tool_use` block the model emitted, whether or not the server accepted it, and an
 * arguments-derived source never reads the result that would have carried the error.
 * So the choice here is "void a malformed key" versus "store a junk reference", and
 * voiding wins. (Do not restate this as "the client validates first": it does not
 * validate what reaches us.)
 *
 * Word chars only, so the key is also path-safe as its own file stem.
 */
const FILE_KEY = "^[0-9a-zA-Z]{22,128}$";

/**
 * Every captured tool under every accepted prefix.
 *
 * DERIVED, not hand-written, and that is a correctness measure rather than tidiness:
 * `validateDefinition` deliberately does not deep-validate `match` ("does not (yet)
 * deep-validate `match`/`storage`/`render` beyond presence"), so a typo in a literal
 * allow-list entry, or a prefix list that drifts from `FigmaNormalize`'s, disables that
 * tool or that whole spelling with no error anywhere. Crossing the two exported lists
 * removes all three drift paths at once, and the result is still plain data — the
 * "no functions live here" rule in `SourceDefinition.ts` is about op values in a pipe,
 * not about how a literal array is built.
 */
const EXACT_TOOL_NAMES: ReadonlyArray<string> = FIGMA_TOOL_PREFIXES.flatMap((prefix) =>
	FIGMA_TOOL_NAMES.map((tool) => `${prefix}${tool}`),
);

/**
 * figma — track-only design-file references. Records WHICH Figma file was consulted
 * while a commit was being written, and what was looked at inside it. Track-only
 * because a design file is the INPUT to the work, not a statement about the code:
 * feeding a screenshot lookup into the summarize prompt reads as a reason for the
 * change. The issue asks for exactly this — "just save as references for tracking, no
 * real UI design screenshots and assets".
 *
 * Arguments-derived, and the clearest case in the catalog: `fileKey` appears in 7 of 7
 * captured tool_use inputs and 0 of 7 results. Figma returns content — generated code,
 * a node XML tree, a PNG url — and content carries no provenance. There is nothing to
 * read from the payload even when it parses (6 of 7 do not: two are oversized-offload
 * pointers, two are a JSON block concatenated with a prose block, one is prose, one is
 * XML).
 *
 * Identity is the FILE (`accumulateBody` collects what was viewed), so a walkthrough
 * over thirty nodes stays ONE Context row instead of thirty.
 *
 * `exact`, not `acceptSuffix`, for two independent reasons:
 *   - Mechanical: `acceptSuffix` is a single string; the captured tools share no
 *     common suffix, and two prefix spellings double the set.
 *   - Safety: this namespace mixes reads with WRITES (`use_figma`, `create_new_file`,
 *     `generate_figma_design`, `upload_assets`, `add_code_connect_map`) and
 *     enumerations (`list_shader_*`, `search_design_system`), whose arguments are
 *     shape-identical to the reads' — `add_code_connect_map` carries a `nodeId` too.
 *     Every other source can let a stray tool through because a wrong payload shape
 *     voids it downstream; a source that ignores its payload has no such second line
 *     of defence.
 *
 * No Codex match rule: no real Codex envelope has been captured, and a fabricated
 * invocation name silently never matches (the bug spec 154 records for jira's
 * `atlassian_rovo.getJiraIssue`). Claude-only for now, joining zoom-doc and vercel. Kimi
 * is reachable for free — it resolves generic `mcp__<server>__` prefixes, and both
 * spellings qualify.
 */
export const figmaDefinition: SourceDefinition = {
	id: "figma",
	label: "Figma",
	icon: "symbol-color",
	// Design input, not intent: archived and displayed, never in the LLM block.
	trackOnly: true,
	argumentsDerived: true,
	// The identity is an ACT on a file, not an entity: two lookups in one file are two
	// facts, and keeping only the last would discard the walkthrough.
	accumulateBody: true,
	// Matches `FigmaNormalize.synthesizedTitle` — `Figma file <first 8 of the key>`. The
	// only source that needs this, because the only one whose title is harvested from
	// role:user text rather than read from the payload: a later session that pastes a
	// slug-less deep link (`…/design/KEY?node-id=…`) re-derives this label, and without
	// the rule it would overwrite an already-stored real name. `[0-9a-zA-Z]` because a
	// file key is base62, `{1,8}` rather than exactly 8 because `normalizeFigma` accepts
	// bare tool names from a future Codex/Kimi binding and does not itself enforce the
	// 22-char floor `nativeId`'s `require` does.
	titleFallbackPattern: "^Figma file [0-9a-zA-Z]{1,8}$",
	match: {
		claude: {
			// The prefix segment is the user's own MCP registration NAME. Our capture
			// shows `Figma` because that is this user's config key; `claude mcp add figma`
			// yields `mcp__figma__`. Matching is a case-SENSITIVE startsWith with no
			// normalization anywhere, so both spellings are declared — the same split
			// linear carries. `exact` below keeps the capture set from widening.
			prefixes: [...FIGMA_TOOL_PREFIXES],
			exact: EXACT_TOOL_NAMES,
		},
	},
	wrapperKeys: [],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "fileKey" }], require: FILE_KEY },
		// Carried in the normalizer output: it is either a harvested file name or a
		// synthesized fallback, and that choice is not expressible in the DSL.
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		// REQUIRED, not optional: the normalizer always produces one, because the
		// universal `/file/<fileKey>` form is a pure function of the id. That is also why
		// the auto-generated "only the query and the Figma link are recorded" note is
		// TRUE for every row this source can emit — a url spec that were optional would
		// make that note promise a link some rows do not have.
		url: { pipe: [{ op: "path", path: "url" }], require: "^https://www\\.figma\\.com/" },
		description: { pipe: [{ op: "path", path: "detail" }], optional: true },
	},
	// No display fields. The title is the file, the url is the link and the body is the
	// trace; a field repeating any of them would render as a bare duplicate string (the
	// hover card omits field labels).
	fields: [],
	// A file key is base62, and the `require` above pins it to exactly that.
	storage: { nativeIdPathSafe: true },
	// Dead configuration, as for context7 and jollimemory: a track-only source never
	// reaches a block builder. Present because the DSL requires it.
	render: {
		wrapperTag: "figma-files",
		itemTag: "file",
		bodyTag: "content",
		maxCharsPerReference: 2000,
		maxTotalChars: 8000,
	},
};
