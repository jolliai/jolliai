/**
 * Figma is an arguments-derived source, and for a stronger reason than context7:
 * the identity is not merely absent from the RESULT FORMAT, it is absent from the
 * result entirely. Verified against a real 2026-08-11 capture — `fileKey` appears in
 * 7 of 7 tool_use inputs and 0 of 7 results, including the 908 KB `get_metadata` XML.
 * Figma returns CONTENT (generated code, a node tree, a PNG url); content does not
 * carry its own provenance. Only the CALL knows which file was asked for.
 *
 * Identity is the FILE, not the node. A design walkthrough hits dozens of nodes, and
 * a node-level nativeId would emit one Context row per node; the file-level id plus
 * `accumulateBody` keeps it at one row per file whose body collects what was looked
 * at — the same act-not-entity shape `JolliMemoryNormalize` uses for its tools.
 *
 * This module owns the tool identity (prefixes + captured tool names); `figmaDefinition`
 * imports both and derives its `exact` allow-list from them, so the two cannot drift.
 * That matters because `validateDefinition` deliberately does not deep-validate `match`
 * — a typo in a hand-written allow-list entry is silent.
 */
import type { FigmaLink } from "../FigmaLink.js";
import { isObject } from "../guards.js";

/**
 * Claude namespace prefixes for the Figma MCP server.
 *
 * TWO spellings, because this segment is the user's own MCP registration NAME rather
 * than anything Figma controls: the capture reads `mcp__Figma__` because that is the
 * key in this user's config, while `claude mcp add figma …` produces `mcp__figma__`.
 * Recognition is a case-SENSITIVE `startsWith` with no normalization anywhere in the
 * chain, so a single spelling silently captures nothing on half the installs. Same
 * split linear already carries for `mcp__linear__` / `mcp__claude_ai_Linear__`.
 *
 * Named `FIGMA_`, not `CLAUDE_`: `bindings/claude/index.ts` already exports a
 * `CLAUDE_TOOL_PREFIXES`, which is the registry-derived list of EVERY source's
 * prefixes. The repo's convention is plural for that global list and singular
 * (`JolliMemoryNormalize.CLAUDE_TOOL_PREFIX`) for one source's own constant; this is
 * one source's own constant that happens to hold two values.
 *
 * **No `mcp__claude_ai_Figma__`, and that is a finding rather than an omission.** Eight
 * definitions carry that shape (asana, confluence, jira, monday, notion, slack, both
 * zooms) and linear/vercel carry it alongside a generic spelling, so its absence here
 * reads at a glance like the drift this module is built to prevent. It is not: that
 * namespace belongs to claude.ai's own first-party connector directory, and Figma has no
 * entry in it — a registry search for "figma"/"design" returns nothing (checked
 * 2026-08-11). Figma's MCP is a server the USER registers, which is exactly why the two
 * spellings above are the two that exist. Adding a third would be a fabricated
 * invocation name, and a fabricated name silently never matches — the same failure mode
 * `figmaDefinition` cites for declining a `match.codex` (spec 154's record of jira's
 * `atlassian_rovo.getJiraIssue`). If Figma ever ships as a claude.ai connector, add the
 * prefix pinned to a REAL capture of its tool naming, the way linear's was.
 *
 * `mcp__figma-dev-mode-mcp-server__` — the recommended registration name for Figma's
 * local desktop Dev Mode server — is likewise absent on purpose, not overlooked. That
 * server infers the file from the canvas selection instead of taking a `fileKey`, so
 * `normalizeFigma` voids every call from it (see the `fileKey === undefined` branch);
 * declaring the prefix would buy recognition of calls that cannot produce a reference.
 */
export const FIGMA_TOOL_PREFIXES = ["mcp__Figma__", "mcp__figma__"] as const;

/**
 * Display labels for the captured tools, describing WHAT was done to the file. Carried
 * in the normalizer output so the definition reads a plain `path` op rather than a
 * regex ladder over the tool name.
 *
 * The key set is also the source of truth for `figmaDefinition`'s `exact` allow-list
 * (crossed with the prefixes above) AND a second, independent capture gate here — the
 * same belt-and-braces jollimemory uses, except the two sides are now derived from one
 * list rather than kept in sync by hand.
 *
 * This is exactly the server's own declared "Read designs FROM Figma into code" group
 * plus `get_variable_defs`. Everything else on the server is a WRITE (`use_figma`,
 * `create_new_file`, `generate_figma_design`, `upload_assets`, `add_code_connect_map`)
 * or an enumeration (`get_libraries`, `search_design_system`, `list_shader_*`).
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
	get_metadata: "Read structure",
	get_screenshot: "Viewed screenshot",
	get_variable_defs: "Read variables",
	get_figjam: "Read FigJam board",
	get_design_context: "Read design context",
};

/** Bare names of the captured tools. Consumed by `figmaDefinition` to build its
 *  `exact` allow-list, so adding a tool here extends capture in one edit. */
export const FIGMA_TOOL_NAMES: ReadonlyArray<string> = Object.keys(TOOL_LABELS);

/**
 * Own-key names of {@link TOOL_LABELS}. The capture gate goes through this set (own
 * enumerable keys only) so a prototype-chain name can never resolve a label — the same
 * closed-registry boundary as `SourceEngine`'s `TRANSFORM_NAMES` and
 * `McpBusinessNormalize`'s `CONTEXT_NORMALIZER_IDS`.
 *
 * A bare `TOOL_LABELS[name]` lookup answers `Object.prototype.toString` for the name
 * `"toString"`, so the `label === undefined` void below would NOT fire and the tool
 * would be captured with `function toString() { [native code] }` as its detail. The
 * Claude path cannot reach that today — `figmaDefinition.exact` is a closed allow-list
 * — but `normalizeFigma` deliberately accepts BARE tool names for a future Codex/Kimi
 * binding, and that caller is exactly the one with no allow-list in front of it.
 *
 * A `Set` rather than `Object.hasOwn`: this package targets ES2020 (`cli/tsconfig.json`),
 * where `Object.hasOwn` is not in lib.
 */
const CAPTURED_TOOL_NAMES: ReadonlySet<string> = new Set(FIGMA_TOOL_NAMES);

/**
 * Strip whichever known prefix is present, else return the name verbatim (a future
 * Codex binding delivers bare tool names).
 *
 * Deliberately an explicit prefix list rather than a `lastIndexOf("__")` trick: an
 * MCP server name may itself contain underscores — `mcp__claude_ai_Zoom_for_Claude__`
 * is a shipping example — so delimiter-hunting is not safe here.
 */
function bareToolName(toolName: string): string {
	for (const prefix of FIGMA_TOOL_PREFIXES) {
		if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
	}
	return toolName;
}

/**
 * Recorded when a tool is called with no `nodeId`.
 *
 * Not a defensive branch: `get_metadata` is the ONE tool of the five whose schema
 * omits `nodeId` from `required`, and its own description says "when omitted, the tool
 * returns a list of the top-level pages" — which is verbatim what the captured call
 * answered. A literal placeholder, like jollimemory's `(current branch)`: honest beats
 * voiding, because dropping the call would lose the fact that the file was consulted.
 */
export const WHOLE_FILE_DETAIL = "(whole file)";

/**
 * Universal file link, built from the file key alone.
 *
 * `/file/` is deliberate and MUST NOT be "corrected" to a per-type path. Four of the
 * five captured tools DO pin the file type in their own schema — get_metadata,
 * get_variable_defs and get_design_context are design-only, get_figjam is board-only —
 * so tool-name dispatch looks workable at first glance. It is not: get_screenshot
 * explicitly "works on Figma design files (`/design/`), FigJam boards (`/board/`), and
 * Figma Slides (`/slides/`)", and the capture calls exactly that tool on a FigJam
 * board. A file reached only through get_screenshot has no recoverable type, so a
 * dispatch table needs a fallback anyway — and this is that fallback. One shape that
 * is always right beats four that are usually right plus a guess.
 *
 * `/file/` is the legacy universal path that redirects to whichever type the file
 * actually is; verified live 2026-08-11 against a real FigJam key. NOT separately
 * verified for a BRANCH key or a Figma Make key.
 *
 * **When those two reach here** — the earlier wording said "only when no link was
 * harvested for them", which describes when this FUNCTION is called and was read as a
 * guarantee it does not make. Accurately: this form is produced whenever *the current
 * observation* harvested no link for the key, which happens on a resumed session that
 * pastes nothing as readily as on a first sighting. What keeps it from *replacing* an
 * already-stored verified link is a separate rule one layer down —
 * `ReferenceStore.mergeIntoExisting` keeps the stored title and url when the incoming
 * title is the synthesized fallback, which is exactly the condition under which this
 * fallback url was built. So an established branch row keeps its
 * `/design/<parent>/branch/<branch>/<slug>` link, and the unverified form only ever
 * stands as a row's url when NO observation of that key has carried a link. Before that
 * rule existed, a single link-less scan did overwrite the verified path with this one.
 */
export function figmaFileUrl(fileKey: string): string {
	return `https://www.figma.com/file/${fileKey}`;
}

export interface FigmaLookup {
	/** Figma file key — becomes `nativeId`, so one reference accumulates per FILE. */
	readonly fileKey: string;
	/** The harvested link's file name when there is one, else a synthesized label. */
	readonly title: string;
	/** Always present: the harvested canonical link, or the universal `/file/` form. */
	readonly url: string;
	/** What was done, this call. Accumulates across calls via `accumulateBody`. */
	readonly detail: string;
}

function readString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** `Figma file bJRNYiLo` — used when no harvested link supplied the real name.
 *  Truncated because a full 22-char base62 key reads as noise in a sidebar row, and
 *  the row's link resolves the ambiguity in one click. */
function synthesizedTitle(fileKey: string): string {
	return `Figma file ${fileKey.slice(0, 8)}`;
}

/**
 * Longest node id kept in a detail line.
 *
 * Sized off the schema, not off the common case. All five tools declare
 * `nodeId` as `^(?:\d+[:-]\d+|[IT]\d+[:-]\d+(?:;\d+[:-]\d+)*)$` — so a plain node is
 * `474:2318` (~9 chars) but an INSTANCE node chains one `;<int>:<int>` segment per
 * level of component nesting, with no bound in the pattern. At ~10 chars a segment,
 * 256 covers ~25 levels of nesting; a tighter cap would silently truncate a real deep
 * instance id into one that still LOOKS like a node id. This only exists to stop a
 * malformed value from dominating the 20-entry accumulated body.
 */
const MAX_NODE_ID_LEN = 256;

/**
 * Flatten a `nodeId` into something safe to embed in an accumulated-body entry.
 *
 * `detail` does not stay a bare string: `ReferenceStore.formatAccumulatedEntry` wraps it
 * as ``- `<detail>` — <timestamp>`` and the parser that reads it back is LINE-ANCHORED
 * (`/^- `(.+)` — (\S+)$/`). `nodeId` is copied verbatim out of the model's own tool_use
 * input and is never validated by anything upstream — an `argumentsDerived` source does
 * not read the result that would have carried the server's rejection — so a newline in
 * it splits one entry across two lines. Measured: the first half then parses as a stray
 * and the second half as an entry whose text is whatever followed, permanently mangling
 * that file's body on the next merge.
 *
 * Collapsing whitespace (rather than voiding) keeps the honest-beats-voiding rule the
 * rest of this module follows: a weird node id still records that the file was consulted.
 */
function sanitizeNodeId(nodeId: string): string {
	return nodeId.replace(/\s+/g, " ").trim().slice(0, MAX_NODE_ID_LEN);
}

/**
 * Build the Figma reference shape from a tool call. Returns null — voiding the
 * reference — when the tool is outside the captured set or `fileKey` is unreadable.
 *
 * `links` is OPTIONAL and affects DISPLAY ONLY. A producer that has not wired the
 * harvest (Codex, Kimi) omits it and every reference still gets a working url from the
 * file key alone; only the title falls back. That is the same degradation a Claude
 * transcript with no pasted link already takes, so no producer needs a special case.
 */
export function normalizeFigma(
	toolInput: unknown,
	toolName: string,
	links?: ReadonlyMap<string, FigmaLink>,
): FigmaLookup | null {
	const bare = bareToolName(toolName);
	if (!CAPTURED_TOOL_NAMES.has(bare)) return null;
	const label = TOOL_LABELS[bare];
	if (!isObject(toolInput)) return null;

	const fileKey = readString(toolInput.fileKey);
	// Required by all five schemas on the REMOTE server. The desktop Dev Mode server
	// exposes these same five tool names (Figma's tool reference marks none of them
	// remote-only) but infers the file from the canvas selection instead of taking a
	// fileKey — so this branch is reachable the moment someone registers the local
	// server under a matching name. No capture of that envelope exists, so we void:
	// recording nothing beats recording a file we cannot name.
	//
	// NOTE: for a branch link this value IS the branchKey — four tool schemas say so
	// explicitly — which is why a branch and its parent are two distinct references.
	if (fileKey === undefined) return null;

	// An all-whitespace nodeId sanitizes to "" and is then treated as absent, so the
	// detail reads as the whole-file call it effectively was rather than trailing a
	// dangling "· node ".
	const rawNodeId = readString(toolInput.nodeId);
	const nodeId = rawNodeId === undefined ? undefined : readString(sanitizeNodeId(rawNodeId));
	const detail = nodeId === undefined ? `${label} ${WHOLE_FILE_DETAIL}` : `${label} · node ${nodeId}`;

	const link = links?.get(fileKey);
	return {
		fileKey,
		title: link?.name ?? synthesizedTitle(fileKey),
		// Prefer the harvested link: it carries the readable slug, lands on the right
		// type with no redirect hop, keeps a branch's full path, and does not depend on
		// Figma keeping the legacy `/file/` path alive.
		url: link?.url ?? figmaFileUrl(fileKey),
		detail,
	};
}
