/**
 * DetachedUsageSubtraction
 *
 * Corrects a committed memory's conversation token/cost figures after the user
 * detaches a conversation from it.
 *
 * Detach rewrites the stored transcript files (dropping one `source:sessionId`)
 * but the summary carries only the POST-merge aggregate — `conversationTokens`,
 * `conversationTokenBreakdown`, `conversationModels`, `estimatedCostUsd`. Those
 * are sums over every session that fed the commit, with no record of which
 * session contributed what, so there is nothing to subtract from them unless the
 * per-session split was persisted at write time. It now is, on
 * `StoredSession.usage` / `.usageByModel`, and this module applies it.
 *
 * Attribution is per NODE, not per tree: an amend/squash root and its children
 * each carry their own token fields, so a session detached from a child must be
 * subtracted from that child — subtracting at the root would corrupt a node that
 * never carried those tokens while leaving the one that did untouched (and the
 * tree aggregation in `SummaryTree.ts` walks both).
 *
 * `summary.transcripts` is NOT that per-node ownership record, which is why
 * ownership is resolved by {@link resolveOwners} rather than read off the field.
 * The array means two different things depending on where it sits:
 *   - on a leaf — the ids whose sessions this node's token fields cover;
 *   - on a consolidated root — the tree-wide authoritative INDEX. Amend
 *     (`QueueWorker`'s `amendTranscripts` = inherited ∪ delta), rebase-pick
 *     (`migrateOneToOne`) and squash (`mergeManyToOne`, union over children) all
 *     re-list every descendant id at the root so `getTranscriptIds` finds every
 *     file — while the root's token fields cover its DELTA only (amend/pick), or
 *     nothing at all (squash).
 * A node therefore OWNS an id only when no descendant claims it, and each id must
 * be subtracted exactly once, at that owner.
 *
 * Deliberately forward-only. A node with no `transcripts` array (pre-v5), a
 * removed session with no stored `usage` (written before the field existed, or a
 * source that reports no usage), and an id with no single owner are all reported
 * as unattributable and left EXACTLY as-is. Guessing a subtrahend — splitting the
 * aggregate evenly, zeroing the node, or subtracting from every node that lists
 * the id — would replace a known-stale number with an invented one.
 *
 * One case ownership resolution deliberately does NOT special-case: a v5-MIGRATED
 * legacy tree, where `upgradeOneSummary` puts every descendant commit hash on the
 * root's `transcripts` and leaves the children without the field at all — so the
 * root is the sole claimant of an id whose sessions a child counted. Nothing is
 * mis-subtracted in practice because those transcript files predate
 * `StoredSession.usage` (migration rewrites the schema, not transcript content), so
 * every session there is unattributable and the subtrahend is zero. If a path ever
 * backfills `usage` onto legacy transcripts, attribute by `commitHash` here first.
 */

import type {
	CommitSummary,
	ConversationTokenBreakdown,
	ModelTokenUsage,
	SkillCommitRef,
	SkillUsage,
} from "../Types.js";
import { estimateCostUsd, PRICES_AS_OF } from "./Pricing.js";

/** One detached session's persisted attribution, as read back off the stored transcript. */
export interface DetachedSessionUsage {
	readonly usage?: ConversationTokenBreakdown;
	readonly usageByModel?: ReadonlyArray<ModelTokenUsage>;
	/**
	 * `<source>:<sessionId>` — this session's identity, used to correct per-skill
	 * figures (see {@link subtractSkillUsage}).
	 *
	 * Optional and independent of `usage`: a skill split can be corrected for a
	 * session whose commit-level share was never recorded, and vice versa. Absent
	 * means the skill figures are left as they are, the same forward-only stance the
	 * aggregate path takes toward a memory with no stored per-session usage.
	 */
	readonly sessionKey?: string;
}

export interface DetachedUsageSubtractionResult {
	/** The summary with corrected figures. Same reference when nothing changed. */
	readonly summary: CommitSummary;
	/** True when at least one node's figures were rewritten. */
	readonly changed: boolean;
	/**
	 * Transcript ids whose detached sessions could not be FULLY attributed — any of:
	 * no node in the tree claims the id, none of its removed sessions carried a
	 * stored `usage`, or only some of them did (a partial subtraction still leaves
	 * the figure wrong, so it is reported too). Callers should surface/log this: the
	 * memory's token bar stays stale or short, and that is a known limitation rather
	 * than a silent miscount. An id can appear here while `changed` is true — the
	 * partial case corrects part of the total and reports the rest.
	 */
	readonly unattributed: ReadonlyArray<string>;
}

/**
 * Finds, for each id of interest, the node(s) that OWN it — list it and have no
 * descendant that lists it. See the header on why the field alone can't say this.
 *
 * Post-order so a node only becomes an owner once its whole subtree has had the
 * chance to claim the id. The returned set is what the caller's subtree claimed,
 * restricted to `interest` so an unrelated tree-wide index costs nothing to walk.
 *
 * Sibling claimants both land in the list (neither is the other's descendant, so
 * there is no deepest one); the caller treats that ambiguity as unattributable
 * rather than subtracting twice.
 */
function resolveOwners(
	node: CommitSummary,
	interest: ReadonlySet<string>,
	owners: Map<string, CommitSummary[]>,
): Set<string> {
	const claimedBelow = new Set<string>();
	for (const child of node.children ?? []) {
		for (const id of resolveOwners(child, interest, owners)) claimedBelow.add(id);
	}
	const claimed = new Set(claimedBelow);
	for (const id of node.transcripts ?? []) {
		if (!interest.has(id)) continue;
		claimed.add(id);
		if (claimedBelow.has(id)) continue;
		const existing = owners.get(id);
		if (existing) existing.push(node);
		else owners.set(id, [node]);
	}
	return claimed;
}

/**
 * Sums the segments of every detached session recorded against one transcript id.
 *
 * `fullyAttributable` is false as soon as ONE removed session carries no stored
 * `usage`, not only when they all do. A partial sum is a silent under-subtraction:
 * the caller would subtract the sessions it can account for, leave the rest in the
 * total, and report nothing — the exact "stale bar with no trace" this module's
 * header rules out. Reporting the id makes the shortfall visible instead.
 */
function sumRemoved(removed: ReadonlyArray<DetachedSessionUsage>): {
	breakdown: ConversationTokenBreakdown;
	byModel: Map<string, ModelTokenUsage>;
	fullyAttributable: boolean;
} {
	let input = 0;
	let output = 0;
	let cached = 0;
	let missing = 0;
	const byModel = new Map<string, ModelTokenUsage>();
	for (const r of removed) {
		if (!r.usage) {
			missing++;
			continue;
		}
		input += r.usage.input;
		output += r.usage.output;
		cached += r.usage.cached;
		for (const m of r.usageByModel ?? []) {
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
	return { breakdown: { input, output, cached }, byModel, fullyAttributable: missing === 0 };
}

/**
 * Subtracts one node's share and re-derives its cost. Returns the same reference
 * when the node carries no usage to correct.
 *
 * Every segment is floored at 0. A subtrahend can legitimately exceed the stored
 * value: the node may have been written before the per-line de-duplication fix,
 * so its aggregate is inflated while the detached session's `usage` is not. A
 * floor keeps that from producing a negative bar; it does not make the remaining
 * figure exact, which is why over-subtraction collapses the node to "no usage"
 * rather than to a fabricated remainder.
 */
function subtractFromNode(node: CommitSummary, removed: ReadonlyArray<DetachedSessionUsage>): CommitSummary {
	const { breakdown: sub, byModel: subByModel } = sumRemoved(removed);
	if (sub.input + sub.output + sub.cached === 0) return node;
	if (!node.conversationTokens) return node;

	// Strip the whole group rather than store zeros: the display contract is
	// "absent means this memory reports no usage", and a stored 0 would render as
	// a real measurement of nothing (see conversationUsageFields in QueueWorker).
	const {
		conversationTokens: _t,
		conversationTokenBreakdown: _b,
		conversationModels: _m,
		estimatedCostUsd: _c,
		pricesAsOf: _p,
		...withoutUsage
	} = node;

	// Remaining per-model split and the cost re-derived from it. Computed for BOTH
	// node shapes below, not just the breakdown one: `conversationModels` /
	// `estimatedCostUsd` are independent of `conversationTokenBreakdown`, so a node
	// that carries a cost but no breakdown would otherwise have that cost silently
	// deleted by the strip above and never restored.
	//
	// Cost is re-derived from the remaining models, never scaled from the old
	// figure: the detached session may have run a different (or unpriced) model than
	// the ones left behind, so a proportional adjustment would be wrong.
	const models: ModelTokenUsage[] = [];
	for (const m of node.conversationModels ?? []) {
		const s = subByModel.get(m.model);
		const remaining: ModelTokenUsage = s
			? {
					...m,
					input: Math.max(0, m.input - s.input),
					output: Math.max(0, m.output - s.output),
					cached: Math.max(0, m.cached - s.cached),
				}
			: m;
		if (remaining.input + remaining.output + remaining.cached > 0) models.push(remaining);
	}
	const { totalUsd } = estimateCostUsd(models);
	const costFields = {
		...(models.length > 0 && { conversationModels: models }),
		...(totalUsd > 0 && { estimatedCostUsd: totalUsd, pricesAsOf: PRICES_AS_OF }),
	};

	// Scalar-only node (an older memory that recorded `conversationTokens` but no
	// per-segment split): subtract from the scalar and leave the breakdown absent,
	// which is the "total-only degrade" the meter already renders as a single
	// full-width segment. Treating the missing breakdown as zeros would compute a
	// remaining total of 0 and wipe usage the memory legitimately still has.
	const subTotal = sub.input + sub.output + sub.cached;
	if (!node.conversationTokenBreakdown) {
		const remaining = Math.max(0, node.conversationTokens - subTotal);
		if (remaining === 0) return withoutUsage;
		return { ...withoutUsage, conversationTokens: remaining, ...costFields };
	}

	const own = node.conversationTokenBreakdown;
	const input = Math.max(0, own.input - sub.input);
	const output = Math.max(0, own.output - sub.output);
	const cached = Math.max(0, own.cached - sub.cached);
	const total = input + output + cached;
	if (total === 0) return withoutUsage;

	return {
		...withoutUsage,
		conversationTokens: total,
		conversationTokenBreakdown: { input, output, cached },
		...costFields,
	};
}

/**
 * Drops the detached sessions from every skill's per-session split and re-totals.
 *
 * **Deliberately applied to EVERY node, not just the owning one** — the opposite of
 * how the aggregate figures are handled, and for a structural reason rather than
 * convenience. `conversationTokens` is a scalar sum with no record of who
 * contributed what, so subtracting it at two nodes would remove the same tokens
 * twice; that is what {@link resolveOwners} exists to prevent. A skill's
 * `usageBySession` is an explicit map, so correcting it is a key DELETION —
 * idempotent, and impossible to over-apply.
 *
 * That difference is not just permission, it is a requirement: amend hoists a
 * child's skills onto the root, so one session's contribution is genuinely recorded
 * in both places and both records are stale until each is corrected. Owner
 * resolution would fix exactly one of them.
 *
 * A row whose split empties out keeps its identity and loses only its figure. The
 * skill did run — the invocation count says so — and what a detach removes is the
 * evidence of what it cost. An absent `usage` states that; a zero would claim the
 * skill was free, and deleting the row would claim it never ran.
 */
function subtractSkillUsage(node: CommitSummary, detachedKeys: ReadonlySet<string>): CommitSummary {
	if (node.skills === undefined || node.skills.length === 0 || detachedKeys.size === 0) return node;

	let touched = false;
	const next: SkillCommitRef[] = node.skills.map((ref): SkillCommitRef => {
		// Forward-only: a row written before the split existed has nothing to subtract,
		// and inventing a subtrahend is what the aggregate path already refuses to do.
		if (ref.usageBySession === undefined) return ref;
		const remaining: Record<string, SkillUsage> = {};
		let dropped = false;
		for (const [key, usage] of Object.entries(ref.usageBySession)) {
			if (detachedKeys.has(key)) {
				dropped = true;
				continue;
			}
			remaining[key] = usage;
		}
		if (!dropped) return ref;
		touched = true;

		const { usage: _u, usageBySession: _s, ...withoutUsage } = ref;
		const keys = Object.keys(remaining);
		if (keys.length === 0) return withoutUsage;

		let input = 0;
		let cached = 0;
		let output = 0;
		let estimated = false;
		for (const key of keys) {
			input += remaining[key].input;
			cached += remaining[key].cached;
			output += remaining[key].output;
			if (remaining[key].confidence !== "attributed") estimated = true;
		}
		// Confidence is re-derived, not carried over: dropping the only estimated
		// session leaves a total that really is fully attributed, and keeping the old
		// label would understate what we now know.
		return {
			...withoutUsage,
			usage: { input, cached, output, confidence: estimated ? "estimated" : ("attributed" as const) },
			usageBySession: remaining,
		};
	});

	return touched ? { ...node, skills: next } : node;
}

/**
 * Applies `removedByTranscriptId` across the summary tree, subtracting each id's
 * share exactly once — at the single node that OWNS it (see {@link resolveOwners}
 * and the module header on why a node listing an id doesn't mean it owns it).
 *
 * @param removedByTranscriptId - Detached sessions keyed by the id of the stored
 *   transcript they were removed from (the same id space as
 *   `CommitSummary.transcripts`).
 */
export function subtractDetachedUsage(
	summary: CommitSummary,
	removedByTranscriptId: ReadonlyMap<string, ReadonlyArray<DetachedSessionUsage>>,
): DetachedUsageSubtractionResult {
	if (removedByTranscriptId.size === 0) {
		return { summary, changed: false, unattributed: [] };
	}
	const unattributed = new Set<string>();
	let changed = false;

	// Resolve ownership over the WHOLE tree before touching anything, then apply.
	// Two passes rather than one because a node cannot tell whether it owns an id
	// until its descendants have been inspected, and a consolidated root is visited
	// first.
	const owners = new Map<string, CommitSummary[]>();
	resolveOwners(summary, new Set(removedByTranscriptId.keys()), owners);

	// Skill correction is keyed on session identity, not on transcript ownership, so
	// it is collected across the whole removal map at once. See subtractSkillUsage
	// for why it may — and must — be applied at every node.
	const detachedKeys = new Set<string>();
	for (const sessions of removedByTranscriptId.values()) {
		for (const session of sessions) {
			if (session.sessionKey !== undefined) detachedKeys.add(session.sessionKey);
		}
	}

	// Keyed by node identity — `walk` below receives the very objects `resolveOwners`
	// recorded, since it reads children off the untouched input tree.
	const byOwner = new Map<CommitSummary, DetachedSessionUsage[]>();
	for (const [id, sessions] of removedByTranscriptId) {
		const claimants = owners.get(id) ?? [];
		// Zero claimants: the summary and the transcript files disagree about what
		// belongs to this memory. More than one: ambiguous ownership (see
		// `resolveOwners`). Neither is guessable, so report and correct nothing.
		if (claimants.length !== 1) {
			unattributed.add(id);
			continue;
		}
		if (!sumRemoved(sessions).fullyAttributable) unattributed.add(id);
		const bucket = byOwner.get(claimants[0]);
		if (bucket) bucket.push(...sessions);
		else byOwner.set(claimants[0], [...sessions]);
	}

	const walk = (node: CommitSummary): CommitSummary => {
		const removed = byOwner.get(node);
		const withAggregate = removed !== undefined ? subtractFromNode(node, removed) : node;
		// Applied to every node, unconditionally on ownership — a key deletion cannot
		// double-subtract, and amend genuinely records one session at several nodes.
		const withOwn = subtractSkillUsage(withAggregate, detachedKeys);
		if (withOwn !== node) changed = true;

		const children = node.children;
		if (!children || children.length === 0) return withOwn;
		const nextChildren = children.map(walk);
		// Rebuild the children array only when a descendant actually changed, so an
		// untouched subtree keeps its identity and callers can compare by reference.
		return nextChildren.some((c, i) => c !== children[i]) ? { ...withOwn, children: nextChildren } : withOwn;
	};

	// Walk when EITHER correction has work to do: a memory can carry skill figures
	// with no aggregate figure to fix, and skipping the walk would silently leave the
	// skill numbers stale while reporting changed: false.
	const next = byOwner.size > 0 || detachedKeys.size > 0 ? walk(summary) : summary;
	return { summary: next, changed, unattributed: [...unattributed] };
}
