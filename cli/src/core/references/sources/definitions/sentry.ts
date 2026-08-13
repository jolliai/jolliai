import type { SourceDefinition } from "../../SourceDefinition.js";
import { SENTRY_TOOL_NAMES, SENTRY_TOOL_PREFIXES } from "../SentryNormalize.js";

/**
 * Every captured tool under every accepted prefix.
 *
 * DERIVED, not hand-written, and that is a correctness measure rather than tidiness:
 * `validateDefinition` deliberately does not deep-validate `match`, so a typo in a
 * literal allow-list entry, or a prefix list that drifts from `SentryNormalize`'s,
 * disables that tool or that whole spelling with no error anywhere. Crossing the two
 * exported lists removes both drift paths at once, and the result is still plain data —
 * the "no functions live here" rule in `SourceDefinition.ts` is about op values in a
 * pipe, not about how a literal array is built.
 */
const EXACT_TOOL_NAMES: ReadonlyArray<string> = SENTRY_TOOL_PREFIXES.flatMap((prefix) =>
	SENTRY_TOOL_NAMES.map((tool) => `${prefix}${tool}`),
);

/**
 * `<hostname>/<issueId>`. Both halves are validated in the normalizer against anchored
 * patterns; this restates the SHAPE so a later normalizer change cannot silently widen
 * the identity without a failing test.
 */
const NATIVE_ID = "^[A-Za-z0-9.-]{1,253}/[A-Za-z0-9_-]{1,128}$";

/**
 * The title `normalizeSentry` SYNTHESIZES when the prose harvest recovered no description:
 * `Issue <shortId or argument id>`, both of which are `[A-Za-z0-9_-]{1,128}`.
 *
 * Declared for the reason figma declares one, and this source hits it HARDER: figma needs a
 * pasted link to be absent, while here a second, ordinary observation of the SAME issue
 * routinely carries no issue prose at all. `analyze_issue_with_seer` returns root-cause
 * analysis — "file locations, line numbers, concrete code fixes" per its own tool
 * description, not the issue detail — so it harvests nothing; the Kimi parser supplies no
 * raw text by contract; and an oversized result leaves only an offload pointer. All three
 * re-derive `Issue 7665509682` for a row already labelled
 * `JAVASCRIPT-NEXTJS-1 · TypeError: …`, and `writeReferenceMarkdown` overwrites a row
 * wholesale — so without this the good label is lost from the markdown, from the plans.json
 * row the sidebar renders, and from the archived `CommitSummary.references` the archiver
 * re-reads. The Seer path is the one the definition most wants to capture, which is exactly
 * why it must not be the one that degrades the row.
 *
 * The flag also keeps the STORED URL, and here that half is vacuous rather than wrong: this
 * url is a pure function of the nativeId (`https://<host>/issues/<id>`), and the nativeId IS
 * the merge key, so the stored and incoming urls are necessarily identical. That is the
 * difference `SourceDefinition.titleFallbackPattern` asks a second declarer to state — for
 * figma the url regresses with the title, for sentry it cannot move at all.
 */
const SYNTHESIZED_TITLE = "^Issue [A-Za-z0-9_-]{1,128}$";

/**
 * The POOREST member of {@link SYNTHESIZED_TITLE}'s family: `Issue <machine id>`, the
 * shape synthesized when NO prose was recovered at all.
 *
 * The two synthesized arms are not interchangeable, and the two-sided keep-the-prior test
 * could not tell them apart. `Issue JAVASCRIPT-NEXTJS-1` means the prose heading WAS
 * harvested — the short id is Sentry's canonical, stable handle and the `issue-id` field
 * exists to carry it — while `Issue 7665509682` means nothing was. Both matched
 * `SYNTHESIZED_TITLE`, so `!re.test(prior)` was false and the second overwrote the first,
 * dropping the short id, project and culprit along with the label (the harvested set moves
 * wholesale, by design). Ranking them makes a no-prose re-observation yield.
 *
 * All-digits rather than "not a short id": a Sentry issue URL's id and the `issueId` /
 * `resourceId` arguments are the numeric machine id, while a harvested short id always
 * carries its project prefix and a `-`. Note the reverse does NOT hold — a model may pass
 * a SHORT id as `issueId`, so a poorest-arm title can look like the richer one; that is
 * why this ranks within the family instead of replacing `SYNTHESIZED_TITLE` with it.
 */
const SYNTHESIZED_TITLE_NO_PROSE = "^Issue [0-9]{1,128}$";

/**
 * sentry — track-only Sentry issue references. Records WHICH production issue was
 * consulted while a commit was being written. Track-only because an error report is the
 * INPUT to the work, not a statement about the code: feeding a stacktrace into the
 * summarize prompt reads as a reason for the change.
 *
 * Arguments-derived. See `SentryNormalize.ts` for the capture that forces it, the
 * numeric-vs-short-id identity split, why the prose harvest is display-only, and the
 * excluded-tool rationale.
 *
 * `exact`, not `acceptSuffix`. A suffix rule would work for either tool name TODAY, but
 * this namespace mixes reads with a dispatcher (`execute_sentry_tool`), a write
 * (`update_issue`) and five enumerations — and an arguments-derived source has no second
 * line of defence, because it ignores the payload that would otherwise void a stray tool
 * on shape. A denylist would start miscapturing the moment Sentry ships another tool;
 * an allow-list cannot drift that way.
 *
 * No Codex match rule: no real Codex envelope has been captured, and a fabricated
 * invocation name silently never matches. Claude-only, like figma and vercel. Kimi is
 * reachable for free through the generic `mcp__sentry__` prefix, and degrades cleanly —
 * that parser passes no raw result text, so the title falls back to `Issue <id>`.
 */
export const sentryDefinition: SourceDefinition = {
	id: "sentry",
	label: "Sentry",
	icon: "bug",
	// Diagnostic input, not intent: archived and displayed, never in the LLM block.
	trackOnly: true,
	argumentsDerived: true,
	// NOT accumulating, and the contrast with figma is the point: figma's identity is an
	// ACT on a file (thirty node lookups are thirty facts about one file), while an issue
	// is an ENTITY — re-reading it describes the same thing, so the later read should
	// win. linear/jira's shape. This is also what makes a re-observed title safely
	// overwrite the row instead of appending to it.
	//
	// Overwrite is right only while the re-observation recovered as much as the stored one
	// did. It often has not — see {@link SYNTHESIZED_TITLE}.
	titleFallbackPattern: SYNTHESIZED_TITLE,
	titleFallbackPoorestPattern: SYNTHESIZED_TITLE_NO_PROSE,
	match: {
		claude: {
			prefixes: [...SENTRY_TOOL_PREFIXES],
			exact: EXACT_TOOL_NAMES,
		},
	},
	// The normalizer emits a flat canonical object; there is nothing to descend.
	wrapperKeys: [],
	reference: {
		// Arguments-only, by design. The prose names the short id, but harvesting it into
		// the identity would split one issue across two rows depending on whether that
		// best-effort parse happened to succeed. See the normalizer header.
		nativeId: { pipe: [{ op: "path", path: "nativeId" }], require: NATIVE_ID },
		// Carried in the normalizer output: it is the error description, a short id, or a
		// synthesized fallback, and that three-arm choice is not expressible in the DSL.
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		// REQUIRED, not optional: the normalizer always produces one — it is a pure
		// function of the validated host and id — so the auto-generated track-only note
		// promising a link is true for every row this source can emit.
		//
		// The `require` is a restatement, not the defence. The defence is that the url is
		// REBUILT from `URL.hostname` rather than read through, so no string that parses
		// to a different host can reach here.
		//
		// `i` because URL hosts are case-insensitive and a mixed-case one must not
		// silently void the reference (the asana / monday / vercel precedent).
		url: {
			pipe: [{ op: "path", path: "url" }],
			require: "^https://(?:[A-Za-z0-9-]{1,63}\\.)*sentry\\.io/issues/[A-Za-z0-9_-]{1,128}$",
			requireFlags: "i",
		},
		description: { pipe: [{ op: "path", path: "detail" }], optional: true },
	},
	// Every field carries something the TITLE does not — the rule vercel had to learn,
	// and it binds here for the same reason: the hover card renders a value WITHOUT its
	// label, so a field repeating the title is a bare duplicate string.
	//
	// With the title being the error description, both of these are genuinely new.
	// `shortId` earns its place twice over: it is the STABLE handle. The title is
	// prose-derived and will change if Sentry regroups or re-describes the issue, so this
	// is what lets a reader recognise the row across that change — while `nativeId`, the
	// thing dedupe actually keys on, stays argument-derived and never moves.
	//
	// Both are absent when the prose harvest missed; the scalar coercion drops them, so a
	// Kimi-captured row simply shows none (vercel's null-`framework` precedent).
	//
	// `status` is deliberately absent: it is the only fact here that can become FALSE, and
	// a field is rendered without a label or a timestamp, so it would read as a live claim.
	// See the harvest-pattern comment in `SentryNormalize`.
	fields: [
		{ key: "issue-id", label: "Issue", icon: "bug", pipe: [{ op: "path", path: "shortId" }] },
		{ key: "project", label: "Project", icon: "symbol-property", pipe: [{ op: "path", path: "project" }] },
	],
	// `false`, like github: the nativeId contains a `/`. The store rewrites it to
	// [^\w.-]→- plus an 8-char hash, which also keeps two hosts' same-numbered issues
	// apart.
	storage: { nativeIdPathSafe: false },
	// DECLARED BUT UNREACHABLE: both prompt-block call sites skip a track-only definition
	// before rendering, so no `sentry-issues` block is ever emitted. Recorded for
	// completeness per specs 255 / 154 — not observable behaviour.
	render: {
		wrapperTag: "sentry-issues",
		itemTag: "issue",
		bodyTag: "content",
		maxCharsPerReference: 2000,
		maxTotalChars: 8000,
	},
};
