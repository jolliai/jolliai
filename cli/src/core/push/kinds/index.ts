/**
 * The built-in context kinds, consumed by `ContextKindRegistry`.
 *
 * **`CONTEXT_KIND_DEFINITIONS` is the single place a new pushable context kind is
 * registered.** Adding one is a definition in this file; the push loop, batch
 * assembly, URL write-back, `PushExecutor` and the VS Code orchestrator are all
 * generic over this list and need no change.
 *
 * A directory scan would remove even the registration line, but esbuild (which
 * inlines `cli/src/**` into the VS Code extension and the Claude plugin bundles)
 * has no glob-import, so a static list is the floor for a bundler to see the
 * dependency at all.
 *
 * **Order is user-visible**: it is the order attachments are pushed within one
 * summary. plan → note → reference preserves the historical sequence, so pushed
 * articles keep appearing in the order they always have; skill is appended last
 * because it describes HOW the work happened rather than what it was about — the
 * same ordering every Context surface uses.
 */

import type {
	CommitSummary,
	NoteReference,
	PlanReference,
	ReferenceCommitRef,
	SkillCommitRef,
} from "../../../Types.js";
import { readReferenceMarkdownFromString } from "../../references/ReferenceStore.js";
import { skillsAggregateKey } from "../../SkillsAggregateMarkdown.js";
import {
	buildNotePushTitle,
	buildPlanPushTitle,
	buildReferencePushTitle,
	buildSkillsPushTitle,
} from "../../SummaryFormat.js";
import { buildReferencePushMarkdown, buildSkillsPushMarkdown } from "../../SummaryMarkdownBuilder.js";
import { readNoteFromBranch, readPlanFromBranch, readReferenceFromBranch } from "../../SummaryStore.js";
import { type ContextKindDefinition, defineContextKind } from "../ContextKindDefinition.js";
import { byUpdatedAtDesc, latestPlanPerName } from "../PlanGrouping.js";

/**
 * `plan` — the only kind that needs `reduce` and `tiebreak`: a plan is archived as
 * one snapshot per commit (`<slug>-<hash8>`), so one summary can legitimately carry
 * several revisions of the same plan, and same-named snapshots share an identical
 * server push identity. Both come straight from `PlanGrouping`, so the per-summary
 * reduction and the cross-commit winner rule cannot disagree about which snapshot
 * is "latest" — a disagreement would push one slug but weave the URL against
 * another, dropping the plan's markdown link.
 */
const planDefinition: ContextKindDefinition<PlanReference> = {
	docType: "plan",
	field: "plans",
	entryKey: "slug",
	// `stripArchiveSuffix` rather than a bespoke transform so this stays the same
	// rule as `planBaseKey` / `RefMerge.baseKeyOf.plan`.
	baseKey: { fields: ["slug"], stripArchiveSuffix: true },
	recency: "updatedAt",
	docIdField: "jolliPlanDocId",
	docUrlField: "jolliPlanDocUrl",
	title: (plan, summary) => buildPlanPushTitle(summary, plan.title),
	// A plan's body lives on the orphan branch; empty/unreadable means skip, which
	// is what returning undefined signals.
	body: async (plan, ctx) => (await readPlanFromBranch(plan.slug, ctx.cwd, ctx.storage)) || undefined,
	reduce: latestPlanPerName,
	// Slug-ascending on an equal-`updatedAt` tie, matching byUpdatedAtDesc's own
	// tiebreak so determinism holds across repeated runs.
	tiebreak: (a, b) => byUpdatedAtDesc(a, b),
};

/**
 * `note` — keyed by exact `id`, with **no** `stripArchiveSuffix`. Deliberately
 * unlike `RefMerge.baseKeyOf.note`, which does strip: the push path has always
 * deduped notes on the exact id, and a note id is already unique per note, so
 * stripping here would merge two distinct notes whose ids happen to differ only by
 * a trailing `-<8 hex>`.
 *
 * The only kind whose body can come from the item itself: a note may carry
 * `content` inline, and only falls back to the orphan-branch copy when it does not.
 */
const noteDefinition: ContextKindDefinition<NoteReference> = {
	docType: "note",
	field: "notes",
	entryKey: "id",
	baseKey: { fields: ["id"] },
	recency: "updatedAt",
	docIdField: "jolliNoteDocId",
	docUrlField: "jolliNoteDocUrl",
	title: (note, summary) => buildNotePushTitle(summary, note.title),
	body: async (note, ctx) => {
		// A snippet's body is stored INLINE ONLY, so it must never fall back to the
		// orphan branch: a snippet arriving without content is schema drift (legacy or
		// corrupt data), and reading whatever the branch holds for that id in its place
		// would publish the wrong text under the note's title. Skip instead — the
		// caller logs it. Markdown notes are the opposite: they always read the branch.
		if (note.format === "snippet") return note.content || undefined;
		return (await readNoteFromBranch(note.id, ctx.cwd, ctx.storage)) || undefined;
	},
};

/**
 * `reference` — two things set it apart:
 *
 *  - **Its identity fields differ.** `entryKey` is the per-commit `archivedKey`
 *    (`<source>:<nativeId>-<shortHash>`) while `baseKey` is the stable
 *    `<source>:<nativeId>`, so the same ticket referenced on many commits pushes
 *    to ONE Space article, yet only the commit entry that actually pushed receives
 *    the woven URL.
 *  - **It has no on-disk working file.** The local `.md` is deleted at commit
 *    time, so the body is SYNTHESIZED from the value snapshot and the
 *    orphan-branch archive. A missing or unparseable archive yields a header-only
 *    article — never a skip and never a failed push, which is why `body` here
 *    always returns a string.
 */
const referenceDefinition: ContextKindDefinition<ReferenceCommitRef> = {
	docType: "reference",
	field: "references",
	entryKey: "archivedKey",
	baseKey: { fields: ["source", "nativeId"] },
	recency: "referencedAt",
	docIdField: "jolliReferenceDocId",
	docUrlField: "jolliReferenceDocUrl",
	// `ref-N`, not `reference-N`: the batch clientKey is echoed by the server and is
	// the payload of the `{{jolli:doc:<clientKey>}}` placeholder contract. Keeping the
	// historical value means the registry rewrite changed nothing on the wire.
	clientKeyPrefix: "ref",
	// Auto-extracted context: a failed reference push never aborts a strict share
	// (see ContextKindDefinition.bestEffortPush).
	bestEffortPush: true,
	title: (ref) => buildReferencePushTitle(ref),
	body: async (ref, ctx) => {
		// Read the archived body from the orphan-branch snapshot so the pushed article
		// carries the SAME content VS Code shows locally (the local `.md` is deleted at
		// commit time; the orphan-branch snapshot is the system of record). Missing/
		// unparseable → header-only, never a failed push.
		const storedMd = await readReferenceFromBranch(ref.source, ref.archivedKey, ctx.cwd, ctx.storage);
		const description = storedMd
			? (readReferenceMarkdownFromString(storedMd)?.description ?? undefined)
			: undefined;
		return buildReferencePushMarkdown(ref, description);
	},
};

/**
 * The synthetic item the skill kind pushes: one commit's whole skill set, under a
 * commit-level identity.
 *
 * It extends `SkillCommitRef` only so the definition stays typed against its own
 * item type; **no field of it is a real ref's**. `archivedKey` is the commit-level
 * `skills--<hash8>`, matching the Memory Bank file name for the same data, and there
 * is deliberately no `jolliDocId` on it — this kind is `docScope: "summary"`, so the
 * published id lives on `CommitSummary.jolliSkillsDocId` and the engine never reads
 * one off this object.
 *
 * That combination is the whole fix. Borrowing a representative ref's `archivedKey`
 * (as the first cut did) made the aggregate's identity depend on which skills the
 * commit happened to hold, and put a commit-level docId inside `mergeSkillRef`'s
 * per-ref fold — see `ContextKindDocState` for the two failures that produced.
 *
 * Never stored: it exists only between `itemsToPush` and the push call.
 */
interface AggregatedSkillRef extends SkillCommitRef {
	readonly aggregatedSkills: ReadonlyArray<SkillCommitRef>;
}

/**
 * Collapses a commit's skill refs into the single aggregate article it publishes.
 *
 * **Why one article per commit.** Every local surface shows a commit's skills as
 * ONE artifact — the Memory Bank writes `skills--<hash8>.md`, and the Context
 * section renders one unlinked "Skills used" row (see `SummaryMarkdownBuilder`).
 * Pushing one article per skill meant a commit whose Context listed a single
 * `skill.md` arrived at the backend as six documents. The decomposition was never
 * a product decision; it fell out of the engine being item-per-document.
 *
 * The identity is derived from the COMMIT, not from any ref, so it is stable no
 * matter how the skill set changes between pushes — a squash that folds three refs
 * into one, or a skill entered after the first push, leaves it untouched.
 */
function aggregateSkillRefs(
	refs: ReadonlyArray<SkillCommitRef>,
	summary: CommitSummary,
): ReadonlyArray<SkillCommitRef> {
	if (refs.length === 0) return refs;
	// Sorted so the body's detail list and the pushed content are byte-stable across
	// runs; `buildSkillsTable` does its own ordering for the table itself.
	const ordered = [...refs].sort((a, b) =>
		a.archivedKey < b.archivedKey ? -1 : a.archivedKey > b.archivedKey ? 1 : 0,
	);
	// The legacy per-ref doc fields are dropped rather than spread through: this kind
	// is summary-scoped, so an id riding on the synthetic item would be a second,
	// stale answer to "which article is this?" that a future reader could act on.
	const { jolliDocId: _legacyId, jolliDocUrl: _legacyUrl, ...carrier } = ordered[0];
	const hash8 = summary.commitHash.substring(0, 8);
	const aggregated: AggregatedSkillRef = {
		...carrier,
		archivedKey: skillsAggregateKey(hash8),
		aggregatedSkills: ordered,
	};
	return [aggregated];
}

/** The set an aggregate carries, or the lone ref itself when a caller hands over a plain one. */
function aggregatedSkillsOf(ref: SkillCommitRef): ReadonlyArray<SkillCommitRef> {
	const carried = (ref as AggregatedSkillRef).aggregatedSkills;
	return Array.isArray(carried) && carried.length > 0 ? carried : [ref];
}

/**
 * `skill` — agent-skill usage recorded on a commit, and the odd one out in three ways:
 *
 *  - it publishes ONE article for many items (see `aggregate`), because that is what
 *    every local surface already shows;
 *  - therefore its published id/URL live on the COMMIT (`docScope: "summary"`), not
 *    on any item — see `ContextKindDocState` for what went wrong when they rode on a
 *    representative ref;
 *  - and it does not dedupe across commits (see `baseKey`).
 */
const skillDefinition: ContextKindDefinition<SkillCommitRef> = {
	docType: "skill",
	field: "skills",
	// `archivedKey`, which on the pushed item is the aggregate's own commit-level
	// `skills--<hash8>` (see `aggregateSkillRefs`), never a single skill's archive id.
	entryKey: "archivedKey",
	// **Per-commit identity, unlike every other kind** — equal to `entryKey`, so the
	// article belongs to one commit and is never shared with another.
	//
	// It used to be the registry mapKey `<source>:<skill>`, which collapsed a skill
	// used across many commits into ONE article. That could only ever report
	// CUMULATIVE figures (a single document cannot show four commits' separate
	// increments), while VS Code renders the same record per commit from
	// `summary.skills` — so one commit's memory showed two different token totals
	// depending on which surface you looked at, and the article's was the larger.
	//
	// A skill is not a plan or a reference: those are one artifact revised over time,
	// so collapsing revisions is right. A skill record is a MEASUREMENT of one
	// commit's work, and measurements from different commits are different facts, not
	// revisions of one. `buildSkillsPushTitle` names the article by the commit's
	// `hash8` so the per-commit articles are distinguishable in a flat branch folder.
	baseKey: { fields: ["archivedKey"] },
	// Only reached now for the one case where the SAME archivedKey appears on two
	// summaries: a squash root carries its children's hoisted refs and keeps the
	// children, so a ref can be met from both ends (see `mergeSkillRefs`). Newest
	// `lastUsedAt` wins, which keeps that collapsing to a single article.
	recency: "lastUsedAt",
	// **The published id/URL belong to the COMMIT, not to a skill.** The names are
	// overridden because the summary-scope defaults would be `jolliDocId`/`jolliDocUrl`
	// — the memory article's own fields — and taking them would overwrite it.
	docScope: "summary",
	docIdField: "jolliSkillsDocId",
	docUrlField: "jolliSkillsDocUrl",
	// Auto-extracted context, exactly like `reference`: a skill record is captured
	// from a transcript, never attached by the user. So a failed skill push must not
	// abort a strict live share — without this, one transient failure would throw
	// AttachmentPushError and kill the whole share over metadata about HOW the work
	// happened.
	bestEffortPush: true,
	// `linksInMarkdown: false`: the Context section renders skills as ONE unlinked
	// aggregate row (see SummaryMarkdownBuilder), so there is no site in the summary
	// body for a per-skill URL — and therefore no placeholder to mint in a batch push.
	linksInMarkdown: false,
	// The ONLY kind that publishes one article for many items — see
	// `aggregateSkillRefs`, and `docScope` above for where its id then lives.
	aggregate: aggregateSkillRefs,
	// Named for the commit, not for a skill: the article covers all of them.
	title: (_ref, summary) => buildSkillsPushTitle(summary),
	// The only kind whose body needs no storage read: every figure it prints is on
	// the refs themselves. It used to read the orphan-branch snapshot for the
	// CUMULATIVE counters and the verbatim invocation list, both of which are gone
	// (see `buildSkillsPushMarkdown`). Still `async` because the contract is.
	body: async (ref) => buildSkillsPushMarkdown(aggregatedSkillsOf(ref)),
};

/** Cross-commit dedup key for a reference: its stable `<source>:<nativeId>` (Reference.mapKey). */
export function referenceBaseKey(ref: ReferenceCommitRef): string {
	return `${ref.source}:${ref.nativeId}`;
}

export const CONTEXT_KIND_DEFINITIONS = [
	defineContextKind(planDefinition),
	defineContextKind(noteDefinition),
	defineContextKind(referenceDefinition),
	defineContextKind(skillDefinition),
] as const;
