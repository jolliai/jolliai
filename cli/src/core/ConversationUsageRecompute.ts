/**
 * ConversationUsageRecompute
 *
 * DERIVES a committed memory's conversation token / cost figures from the sessions
 * still stored in the transcripts each node owns, rather than adjusting them by a
 * delta. Rewrites `conversationTokens`, `conversationTokenBreakdown`,
 * `conversationModels`, `estimatedCostUsd` and `pricesAsOf` per node.
 *
 * Why a derivation exists alongside {@link subtractDetachedUsage}'s subtraction:
 *
 *  - **Detach's failure window is otherwise unrecoverable.** Detach writes the
 *    transcript files first and the summary second (the reverse ordering is worse —
 *    see `handleConversationDetach`). If the summary write fails, the sessions are
 *    already gone from the files and the subtrahend was only readable while they
 *    were still in them: a retry finds nothing to remove, so the figures stay
 *    permanently high by the detached conversation's share. A derivation needs no
 *    subtrahend — it reads whatever is left — so it can run after the fact.
 *  - **A stored aggregate can disagree with the stored per-session split.**
 *    Subtraction can only nudge the aggregate by a delta; a derivation replaces it
 *    with the sum of what the transcripts actually record, so any drift between the
 *    two is resolved in favour of the per-session evidence.
 *
 * What it deliberately does NOT repair: the pre-dedup inflated history (memories
 * whose aggregate counted one response once per transcript line, median 2.13× across
 * the corpus). `StoredSession.usage` and the per-`message.id` de-duplication landed in
 * the SAME change, so a transcript that carries per-session usage was written by a
 * de-duplicating reader by construction, and every inflated memory predates the field
 * entirely — its sessions carry no `usage`, so the forward-only gate below skips the
 * node and the inflated figure is preserved rather than corrected. Repairing that
 * corpus needs per-session `usage` backfilled onto those legacy transcripts first;
 * this module then derives from it like any other evidence.
 *
 * Being a derivation, it is IDEMPOTENT: running it on already-correct figures
 * returns the same tree by reference. That is what lets one routine serve both the
 * post-failure self-heal and a one-off backfill.
 *
 * Attribution is per NODE and resolved structurally by
 * {@link resolveTranscriptOwnership} — a consolidated root's `transcripts` array is
 * a tree-wide index, not an ownership record, and the tree aggregation in
 * `SummaryTree.ts` walks root AND children, so summing a child's sessions into the
 * root would double-count them on every surface.
 *
 * **Forward-only, and conservative about evidence.** A node is left EXACTLY as-is
 * whenever the evidence for it is anything less than complete:
 *   - a session in an owned transcript carries no `usage` (a pre-v5 file, or a
 *     source that reports none) — the sum would be short, so deriving would destroy
 *     usage the memory legitimately has;
 *   - an owned id is missing from the supplied evidence (unreadable file, caller
 *     didn't read it) — summing the rest silently under-reports;
 *   - the id has no single owner (nothing claims it, or sibling claimants do).
 * Those ids are reported in `skipped` so callers can surface them. A stale figure
 * with a trace beats an invented one that reads as settled truth.
 *
 * CALLER CONTRACT: `sessionsByTranscriptId` must be COMPLETE for the tree — one
 * entry per transcript id the caller resolved, with an EMPTY array for an id whose
 * file is known to be absent (e.g. detach deleted a transcript that became empty).
 * Never map an id you failed to read to `[]`: that is indistinguishable from "the
 * file is gone" and would strip usage the memory still has. Leave it out instead
 * and its owner is skipped.
 *
 * "Complete for the tree" means the ids from {@link resolveTranscriptIdsForUsage},
 * NOT `getTranscriptIds`: attribution is per node, so a caller that only reads the
 * root's index leaves every child-listed id unread, and this module then skips
 * exactly the child that needed repairing.
 *
 * Skill figures (`SkillCommitRef.usageBySession`) are deliberately NOT touched
 * here. Their per-session split is an explicit map, so correcting one is a key
 * deletion that `subtractDetachedUsage` already applies idempotently at every node;
 * re-deriving it would mean pruning keys not seen in the transcript files, which is
 * only safe when the evidence covers the WHOLE tree — an amend hoists a child's
 * skills onto the root, so a key legitimately absent from the root's own files
 * would look detached.
 */

import type { CommitSummary, ConversationTokenBreakdown, ModelTokenUsage } from "../Types.js";
import { estimateCostUsd, PRICES_AS_OF } from "./Pricing.js";
import { collectListedTranscriptIds } from "./SummaryTree.js";
import { resolveTranscriptOwnership } from "./TranscriptOwnership.js";

/** One stored session's recorded usage, as read back off a stored transcript. */
export interface RecomputeSession {
	readonly usage?: ConversationTokenBreakdown;
	readonly usageByModel?: ReadonlyArray<ModelTokenUsage>;
}

/** A session that passed the forward-only gate, so its `usage` is known present. */
interface AttributedSession extends RecomputeSession {
	readonly usage: ConversationTokenBreakdown;
}

export interface ConversationUsageRecomputeResult {
	/** The summary with derived figures. Same reference when nothing changed. */
	readonly summary: CommitSummary;
	/** True when at least one node's figures were rewritten. */
	readonly changed: boolean;
	/**
	 * Transcript ids whose owning node could not be derived — unattributable, or
	 * backed by evidence that was incomplete (see the module header). The figures
	 * for those nodes are untouched; callers should surface this rather than let a
	 * stale bar read as a settled measurement.
	 */
	readonly skipped: ReadonlyArray<string>;
}

/** The five usage fields this module owns, as a spreadable group. */
type UsageFields = Partial<
	Pick<
		CommitSummary,
		"conversationTokens" | "conversationTokenBreakdown" | "conversationModels" | "estimatedCostUsd" | "pricesAsOf"
	>
>;

/**
 * Sums one node's owned sessions into the usage fields it should carry.
 *
 * The per-model split is emitted whenever ANY session reported models, which is
 * exactly what `conversationUsageFields` does at write time (QueueWorker): both
 * sum the buckets that exist and price those. Matching it is what makes this
 * function idempotent on a healthy memory — gating the split on EVERY session
 * having reported models would delete a legitimately partial `conversationModels` /
 * `estimatedCostUsd` the write path had stored, on the first press of the recompute
 * button. A partial split does mean the cost covers only the sessions that reported
 * a model; that under-statement is a property of the stored evidence, identical on
 * both paths, and the meter labels the figure as an estimate.
 *
 * Cost is always re-derived from the models (never scaled from the previous figure),
 * so an unpriced model yields tokens with no cost.
 */
function deriveUsageFields(sessions: ReadonlyArray<AttributedSession>): UsageFields {
	let input = 0;
	let output = 0;
	let cached = 0;
	const byModel = new Map<string, ModelTokenUsage>();
	for (const session of sessions) {
		input += session.usage.input;
		output += session.usage.output;
		cached += session.usage.cached;
		for (const m of session.usageByModel ?? []) {
			const prev = byModel.get(m.model);
			byModel.set(
				m.model,
				prev
					? {
							...prev,
							input: prev.input + m.input,
							output: prev.output + m.output,
							cached: prev.cached + m.cached,
						}
					: { ...m },
			);
		}
	}

	const total = input + output + cached;
	// Strip the whole group rather than store zeros: the display contract is
	// "absent means this memory reports no usage", and a stored 0 renders as a real
	// measurement of nothing (see conversationUsageFields in QueueWorker).
	if (total === 0) return {};

	const models = [...byModel.values()];
	const { totalUsd } = models.length > 0 ? estimateCostUsd(models) : { totalUsd: 0 };
	return {
		conversationTokens: total,
		conversationTokenBreakdown: { input, output, cached },
		...(models.length > 0 && { conversationModels: models }),
		...(totalUsd > 0 && { estimatedCostUsd: totalUsd, pricesAsOf: PRICES_AS_OF }),
	};
}

/**
 * The forward-only gate: true when EVERY session carries a recorded `usage`. A type
 * guard so the summing pass below is statically bound to gated input — one missing
 * `usage` makes the whole node unusable, never a partial sum.
 */
function hasCompleteUsage(sessions: ReadonlyArray<RecomputeSession>): sessions is ReadonlyArray<AttributedSession> {
	return sessions.every((s) => s.usage !== undefined);
}

/**
 * Canonical form of the five usage fields, so "did this change" is decided on the
 * VALUES rather than on object identity or per-model ordering (which follows the
 * order sessions were read in, not anything meaningful).
 */
function usageFingerprint(fields: UsageFields): string {
	const models = [...(fields.conversationModels ?? [])]
		// Byte-order sort: `localeCompare` would reorder under a non-English locale
		// and turn an unchanged node into a rewrite (see the generated-artifact rule).
		.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
		.map((m) => [m.model, m.provider, m.input, m.output, m.cached]);
	// Every object is projected to a positional tuple before serializing — never
	// stringified whole. A stored breakdown is JSON parsed off disk, so its KEY ORDER
	// is whatever the writer used; `JSON.stringify(breakdown)` would then differ from
	// the derived `{input, output, cached}` on values that are equal, and the node
	// would be rewritten on every pass (an orphan-branch write per button press,
	// against a module whose contract is idempotence).
	const breakdown = fields.conversationTokenBreakdown;
	return JSON.stringify([
		fields.conversationTokens ?? null,
		breakdown ? [breakdown.input, breakdown.output, breakdown.cached] : null,
		models,
		fields.estimatedCostUsd ?? null,
		fields.pricesAsOf ?? null,
	]);
}

/** Replaces a node's usage group with `fields`, or returns it unchanged. */
function applyUsageFields(node: CommitSummary, fields: UsageFields): CommitSummary {
	const current: UsageFields = {
		...(node.conversationTokens !== undefined && { conversationTokens: node.conversationTokens }),
		...(node.conversationTokenBreakdown !== undefined && {
			conversationTokenBreakdown: node.conversationTokenBreakdown,
		}),
		...(node.conversationModels !== undefined && { conversationModels: node.conversationModels }),
		...(node.estimatedCostUsd !== undefined && { estimatedCostUsd: node.estimatedCostUsd }),
		...(node.pricesAsOf !== undefined && { pricesAsOf: node.pricesAsOf }),
	};
	if (usageFingerprint(current) === usageFingerprint(fields)) return node;

	// Strip first, then re-add: a node that keeps e.g. `estimatedCostUsd` while the
	// derived figures carry none would otherwise hold a cost belonging to sessions
	// that are no longer there.
	const {
		conversationTokens: _t,
		conversationTokenBreakdown: _b,
		conversationModels: _m,
		estimatedCostUsd: _c,
		pricesAsOf: _p,
		...withoutUsage
	} = node;
	return { ...withoutUsage, ...fields };
}

/**
 * Derives every node's conversation usage from the transcripts it owns.
 *
 * @param summary - The memory tree to correct (never mutated).
 * @param sessionsByTranscriptId - The evidence: transcript id → the sessions that
 *   file currently holds, with `[]` for an id whose file is known to be absent.
 *   Must be complete for the tree — see the CALLER CONTRACT in the module header.
 */
export function recomputeConversationUsage(
	summary: CommitSummary,
	sessionsByTranscriptId: ReadonlyMap<string, ReadonlyArray<RecomputeSession>>,
): ConversationUsageRecomputeResult {
	// Interest spans the ids the tree LISTS as well as the ids the caller read: a
	// listed id missing from the evidence must still resolve to an owner, because
	// that owner is exactly the node whose figures cannot be derived.
	const interest = new Set<string>(sessionsByTranscriptId.keys());
	for (const id of collectListedTranscriptIds(summary)) interest.add(id);
	if (interest.size === 0) return { summary, changed: false, skipped: [] };

	const { ownerById, unresolved } = resolveTranscriptOwnership(summary, interest);
	const skipped = new Set<string>(unresolved);

	// Group the owned ids per node, keyed by node identity — `walk` below sees the
	// very objects the resolver recorded, since it reads children off the input tree.
	const idsByOwner = new Map<CommitSummary, string[]>();
	for (const [id, owner] of ownerById) {
		const bucket = idsByOwner.get(owner);
		if (bucket) bucket.push(id);
		else idsByOwner.set(owner, [id]);
	}

	// Decide per node before rewriting anything, so a node with one unusable id is
	// skipped whole rather than derived from its readable ids alone.
	const fieldsByOwner = new Map<CommitSummary, UsageFields>();
	for (const [owner, ids] of idsByOwner) {
		const sessions: AttributedSession[] = [];
		let usable = true;
		for (const id of ids) {
			const stored = sessionsByTranscriptId.get(id);
			if (stored === undefined || !hasCompleteUsage(stored)) {
				usable = false;
				skipped.add(id);
				continue;
			}
			sessions.push(...stored);
		}
		if (!usable) continue;
		fieldsByOwner.set(owner, deriveUsageFields(sessions));
	}

	let changed = false;
	const walk = (node: CommitSummary): CommitSummary => {
		const fields = fieldsByOwner.get(node);
		const withOwn = fields !== undefined ? applyUsageFields(node, fields) : node;
		if (withOwn !== node) changed = true;

		const children = node.children;
		if (!children || children.length === 0) return withOwn;
		const nextChildren = children.map(walk);
		// Rebuild the children array only when a descendant actually changed, so an
		// untouched subtree keeps its identity and callers can compare by reference.
		return nextChildren.some((c, i) => c !== children[i]) ? { ...withOwn, children: nextChildren } : withOwn;
	};

	const next = fieldsByOwner.size > 0 ? walk(summary) : summary;
	return { summary: next, changed, skipped: [...skipped] };
}
