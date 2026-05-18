/**
 * ContextCompiler — Compiles task context from Jolli Memory's orphan branch data.
 *
 * Collects summaries, plans, and decisions for a given branch and renders them
 * into a structured Markdown document suitable for LLM context injection.
 *
 * Every commit deserves a Memory. Every memory deserves a Recall.
 */

import { createLogger } from "../Logger.js";
import type { CommitSummary, SummaryIndexEntry } from "../Types.js";
import { filterToBranchHeads } from "./HeadEntryFilter.js";
import { extractBaseSlug } from "./PlanSlug.js";
import type { SearchHit } from "./Search.js";
import { collectAllNotesWithHosts, collectAllPlansWithHosts, getDisplayDate } from "./SummaryFormat.js";
import { buildHit } from "./SummaryProjection.js";
import {
	getCatalogWithLazyBuild,
	getIndex,
	getSummary,
	readNoteFromBranch,
	readPlanFromBranch,
} from "./SummaryStore.js";
import { collectAllTopics, resolveDiffStats } from "./SummaryTree.js";

const log = createLogger("ContextCompiler");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContextOptions {
	readonly branch: string;
	readonly depth?: number;
	readonly tokenBudget?: number;
	readonly includeTranscripts?: boolean;
	readonly includePlans?: boolean;
	/** Include notes in the context output. Defaults to the value of `includePlans`. */
	readonly includeNotes?: boolean;
}

export interface ContextStats {
	readonly topicCount: number;
	readonly planCount: number;
	readonly noteCount: number;
	readonly decisionCount: number;
	readonly topicTokens: number;
	readonly planTokens: number;
	readonly noteTokens: number;
	readonly decisionTokens: number;
	readonly transcriptTokens: number;
	readonly totalTokens: number;
}

export interface CompiledContext {
	readonly branch: string;
	readonly period: { readonly start: string; readonly end: string };
	readonly commitCount: number;
	readonly totalFilesChanged: number;
	readonly totalInsertions: number;
	readonly totalDeletions: number;
	readonly summaries: ReadonlyArray<CommitSummary>;
	readonly plans: ReadonlyArray<{ slug: string; title: string; content: string }>;
	readonly notes: ReadonlyArray<{ id: string; title: string; content: string }>;
	readonly keyDecisions: ReadonlyArray<{ text: string; commitHash: string }>;
	readonly stats: ContextStats;
}

/**
 * Branch-scoped plan / note body shipped at the top of {@link RecallPayload}.
 *
 * `slug` (plan) / `id` (note) is the **canonical key** also used by every
 * matching {@link SearchHit.plans}/`notes` stub on `commits[]`, so a stub-to-body
 * lookup never fails for a kept commit.
 *
 * `content` may be omitted when budget enforcement strips bodies in the order
 * documented at {@link buildRecallPayload}. The slug+title pair still serves
 * as a citation anchor when content is absent.
 */
export interface RecallPayloadPlan {
	readonly slug: string;
	readonly title: string;
	readonly content?: string;
}
export interface RecallPayloadNote {
	readonly id: string;
	readonly title: string;
	readonly content?: string;
}

/**
 * Structured output of `jolli recall --format json`.
 *
 * Replaces the prior `ContextOutput` (which shipped a single pre-rendered
 * markdown blob). The shift to structured fields is the same data discipline
 * that jolli-search already validated: the skill-template LLM produces a
 * grounded, citation-anchored answer instead of paraphrasing a markdown blob.
 */
export interface RecallPayload {
	readonly type: "recall";
	readonly branch: string;
	readonly period: { readonly start: string; readonly end: string };
	readonly commitCount: number;
	readonly totalFilesChanged: number;
	readonly totalInsertions: number;
	readonly totalDeletions: number;
	/** Per-commit projection — same shape jolli-search ships from Phase 2. */
	readonly commits: ReadonlyArray<SearchHit>;
	/** Branch-scoped, deduplicated plan bodies. Slug is the canonical base slug. */
	readonly plans: ReadonlyArray<RecallPayloadPlan>;
	/** Branch-scoped, deduplicated note bodies. Id is the canonical key. */
	readonly notes: ReadonlyArray<RecallPayloadNote>;
	readonly stats: ContextStats;
	readonly estimatedTokens: number;
	/** Set when budget enforcement removed at least one field (or commit). */
	readonly truncated?: boolean;
}

export interface BranchCatalogEntry {
	readonly branch: string;
	readonly commitCount: number;
	readonly period: { readonly start: string; readonly end: string };
	readonly commitMessages: ReadonlyArray<string>;
	/**
	 * Aggregated topic titles for all root commits on this branch, deduplicated
	 * and ordered as encountered (oldest commit first within the branch).
	 *
	 * Sourced from `catalog.json` via {@link getCatalogWithLazyBuild}. Provides
	 * higher-signal inputs than `commitMessages` (which often degrade to "wip" /
	 * "address review") for the LLM that performs semantic branch matching in
	 * recall's catalog mode. Absent when no catalog data exists for the branch.
	 */
	readonly topicTitles?: ReadonlyArray<string>;
}

export interface BranchCatalog {
	readonly type: "catalog";
	readonly query?: string;
	readonly branches: ReadonlyArray<BranchCatalogEntry>;
}

// ─── Token estimation ────────────────────────────────────────────────────────

// Re-exported from TokenEstimator so existing callers / tests keep working
// while new modules (e.g. LocalSearchProvider) can depend on the smaller
// utility module directly without pulling in ContextCompiler's surface.
export { estimateTokens } from "./TokenEstimator.js";

import { estimateTokens } from "./TokenEstimator.js";

// ─── Branch catalog ──────────────────────────────────────────────────────────

/**
 * Lists all branches with Jolli Memory records, aggregated from index.json
 * (and optionally enriched with topic titles from catalog.json).
 *
 * Reads index.json for branch / period / commitMessages, then enriches each
 * `BranchCatalogEntry` with `topicTitles` aggregated from `catalog.json`.
 * The catalog read goes through {@link getCatalogWithLazyBuild} so missing
 * entries (e.g. data written by IntelliJ which does not maintain catalog.json)
 * are reconciled on the fly.
 *
 * Slightly slower than the bare index read but still bounded — catalog.json
 * is sized for /jolli-search and easily fits in memory.
 */
export async function listBranchCatalog(cwd?: string): Promise<BranchCatalog> {
	const index = await getIndex(cwd);
	if (!index) {
		return { type: "catalog", branches: [] };
	}

	// One entry per (branch, live-tip-version) via v4 Hoist heads (parent==null —
	// see HeadEntryFilter for the invariant). Earlier amend/squash versions live
	// on as children and are intentionally excluded: the branch catalog anchors
	// LLM context on what `git log` currently shows, not on every historical
	// version that has been superseded.
	const headEntries = filterToBranchHeads(index.entries);

	const branchMap = new Map<string, SummaryIndexEntry[]>();
	for (const entry of headEntries) {
		const list = branchMap.get(entry.branch);
		if (list) {
			list.push(entry);
		} else {
			branchMap.set(entry.branch, [entry]);
		}
	}

	// Build hash → topic titles map from catalog.json so we can enrich each
	// branch entry without N additional file reads.
	const catalog = await getCatalogWithLazyBuild(cwd);
	const titlesByHash = new Map<string, string[]>();
	for (const cat of catalog.entries) {
		const titles = (cat.topics ?? []).map((t) => t.title).filter((t) => t.length > 0);
		if (titles.length > 0) {
			titlesByHash.set(cat.commitHash, titles);
		}
	}

	const branches: BranchCatalogEntry[] = [];
	for (const [branch, entries] of branchMap) {
		const sorted = entries.sort(
			(a, b) => new Date(getDisplayDate(a)).getTime() - new Date(getDisplayDate(b)).getTime(),
		);

		// Aggregate topic titles for this branch in commit order, deduplicated.
		const seen = new Set<string>();
		const topicTitles: string[] = [];
		for (const e of sorted) {
			const titles = titlesByHash.get(e.commitHash);
			if (!titles) continue;
			for (const title of titles) {
				if (!seen.has(title)) {
					seen.add(title);
					topicTitles.push(title);
				}
			}
		}

		branches.push({
			branch,
			commitCount: entries.length,
			period: {
				start: getDisplayDate(sorted[0]),
				end: getDisplayDate(sorted[sorted.length - 1]),
			},
			commitMessages: sorted.map((e) => e.commitMessage),
			...(topicTitles.length > 0 && { topicTitles }),
		});
	}

	// Sort branches by most recent activity
	branches.sort((a, b) => new Date(b.period.end).getTime() - new Date(a.period.end).getTime());

	return { type: "catalog", branches };
}

// ─── Plan / note collection ──────────────────────────────────────────────────

/**
 * Per-summary plan candidate enriched with the host commit's hash. The host
 * hash is the commit (root or nested child) where the reference lives — used
 * by {@link extractBaseSlug} to peel any `-<shortHash>` archive suffix.
 */
interface PlanCandidate {
	readonly originalSlug: string;
	readonly baseSlug: string;
	readonly title: string;
	readonly hostCommitHash: string;
	/** Activity date carried by the summary that owned this candidate. */
	readonly commitDate: string;
	readonly generatedAt: string;
}

/**
 * Collects plan references across the whole tree (root + nested children) of
 * each summary, computing the canonical **base slug** for each via
 * {@link extractBaseSlug}. Recursion mirrors what {@link buildHit} does for
 * SearchHit stubs, so a plan referenced from a v3-legacy nested child surfaces
 * in both the SearchHit stub list AND the top-level payload — a stub never
 * dangles.
 */
function collectPlanCandidates(summaries: ReadonlyArray<CommitSummary>): ReadonlyArray<PlanCandidate> {
	const out: PlanCandidate[] = [];
	for (const summary of summaries) {
		for (const { planRef, hostCommitHash } of collectAllPlansWithHosts(summary)) {
			out.push({
				originalSlug: planRef.slug,
				baseSlug: extractBaseSlug(planRef.slug, hostCommitHash),
				title: planRef.title,
				hostCommitHash,
				commitDate: summary.commitDate,
				generatedAt: summary.generatedAt,
			});
		}
	}
	return out;
}

/**
 * Deduplicates plan candidates by canonical **base slug**, keeping the one
 * with the latest activity per group.
 *
 * After this step, `payload.plans[].slug` (canonical) matches every
 * `commits[].plans[].slug` stub on a 1:1 basis — the lookup never fails.
 */
function deduplicatePlans(candidates: ReadonlyArray<PlanCandidate>): ReadonlyArray<PlanCandidate> {
	const baseSlugMap = new Map<string, PlanCandidate>();

	for (const plan of candidates) {
		const existing = baseSlugMap.get(plan.baseSlug);
		if (!existing || new Date(getDisplayDate(plan)).getTime() > new Date(getDisplayDate(existing)).getTime()) {
			baseSlugMap.set(plan.baseSlug, plan);
		}
	}

	return [...baseSlugMap.values()];
}

// ─── Core compilation ────────────────────────────────────────────────────────

/**
 * Default token budget for recall output (`jolli recall --format json` and
 * `--full` markdown). 20K leaves ~90% of a 200K-context model free for the
 * surrounding conversation. Lower than the historical 50K so the trim loop
 * engages on medium branches (20+ commits) — older `response` / `trigger`
 * fields drop oldest-first before they bloat the LLM's context. Users who
 * want the old behaviour can pass `--budget 50000`.
 */
export const DEFAULT_TOKEN_BUDGET = 20000;

/**
 * Commit-count threshold above which `buildRecallPayload` automatically
 * drops `topic.response` from every kept commit. Below or equal to this,
 * full `response` survives so short branches keep their narrative detail.
 *
 * Measured: `response` is consistently the longest topic field (~500–800
 * bytes typical) while contributing the least unique signal — `decisions`
 * already captures "why", `recap` captures "what at the commit level".
 * Branches past this size are being used for "remind me of the shape",
 * not "walk me through the implementation".
 *
 * No opt-out: this is a policy trim. Use `jolli view --commit <hash>` to
 * inspect a single commit's full stored topic content when needed.
 */
export const RECALL_LARGE_BRANCH_THRESHOLD = 8;

/**
 * Compiles task context for a branch from Jolli Memory's orphan branch data.
 */
export async function compileTaskContext(options: ContextOptions, cwd?: string): Promise<CompiledContext> {
	const { branch, depth, includePlans = true, includeNotes = includePlans } = options;

	const index = await getIndex(cwd);
	if (!index) {
		return emptyContext(branch);
	}

	// Step 1: Filter to v4 Hoist heads (parent==null — see HeadEntryFilter) on
	// the requested branch. Heads are the live tips of commit history — what
	// `git log` currently shows — and serve as the narrative anchors for LLM
	// context. Superseded versions live as children and are excluded so the
	// model isn't fed multiple variants of the same logical commit.
	let headEntries = filterToBranchHeads(index.entries.filter((e) => e.branch === branch));

	// Step 2: Sort by activity date (oldest first for narrative).
	// Uses getDisplayDate so amended old commits surface as recent activity.
	headEntries = [...headEntries].sort(
		(a, b) => new Date(getDisplayDate(a)).getTime() - new Date(getDisplayDate(b)).getTime(),
	);

	// Step 3: Apply depth limit
	if (depth !== undefined && depth > 0 && headEntries.length > depth) {
		headEntries = headEntries.slice(-depth);
	}

	if (headEntries.length === 0) {
		return emptyContext(branch);
	}

	// Step 4: Load full summaries
	const summaries: CommitSummary[] = [];
	for (const entry of headEntries) {
		const summary = await getSummary(entry.commitHash, cwd);
		if (summary) {
			summaries.push(summary);
		} else {
			log.warn("Failed to load summary for commit %s, skipping", entry.commitHash.substring(0, 8));
		}
	}

	if (summaries.length === 0) {
		return emptyContext(branch);
	}

	// Step 5: Collect key decisions from all topics
	const keyDecisions: { text: string; commitHash: string }[] = [];
	for (const summary of summaries) {
		const topics = collectAllTopics(summary);
		for (const topic of topics) {
			if (topic.decisions && topic.decisions.trim().length > 0) {
				keyDecisions.push({
					text: topic.decisions,
					commitHash: summary.commitHash,
				});
			}
		}
	}

	// Step 6: Load and deduplicate plans.
	//
	// Walk each summary tree (root + nested children) so v3-legacy / IntelliJ-
	// squash data with plans stashed in children doesn't get silently dropped —
	// matches the recursion in `buildHit`'s plan-stub projection so every stub
	// resolves to a top-level plan entry. Slug is normalized to its canonical
	// **base slug** (archive suffix peeled) so pre-archive and post-archive
	// commits referencing the same plan collapse to one entry.
	const plans: { slug: string; title: string; content: string }[] = [];
	if (includePlans) {
		const planCandidates = collectPlanCandidates(summaries);
		const deduplicated = deduplicatePlans(planCandidates);
		for (const plan of deduplicated) {
			// Read by the **original** slug (the path on disk at archive time);
			// expose the **base slug** so SearchHit stubs match without knowing
			// which archived suffix happens to be on disk.
			const content = await readPlanFromBranch(plan.originalSlug, cwd);
			if (content) {
				plans.push({ slug: plan.baseSlug, title: plan.title, content });
			} else {
				log.warn("Plan %s referenced but not found in orphan branch", plan.originalSlug);
			}
		}
	}

	// Step 6b: Load and deduplicate notes.
	// Same recursion rationale as plans (cover v3-legacy nested-child notes).
	// Notes have no archive-suffix mechanism, so id is the natural canonical key.
	const notes: { id: string; title: string; content: string }[] = [];
	if (includeNotes) {
		const seenIds = new Set<string>();
		for (const summary of summaries) {
			for (const { noteRef } of collectAllNotesWithHosts(summary)) {
				if (seenIds.has(noteRef.id)) continue;
				seenIds.add(noteRef.id);
				// Snippets carry their content inline; markdown notes read from orphan branch
				if (noteRef.format === "snippet" && noteRef.content) {
					notes.push({ id: noteRef.id, title: noteRef.title, content: noteRef.content });
				} else {
					const content = await readNoteFromBranch(noteRef.id, cwd);
					if (content) {
						notes.push({ id: noteRef.id, title: noteRef.title, content });
					} else {
						log.warn("Note %s referenced but not found in orphan branch", noteRef.id);
					}
				}
			}
		}
	}

	// Step 7: Aggregate stats.
	// Horizontal (cross-commit) sum: each summary contributes its own real diff; sum
	// gives the total work for the branch. Uses resolveDiffStats() so each commit's
	// contribution is the persisted real `git diff` (new data) or the best available
	// fallback (legacy). This is different from vertical (tree) recursion, which is
	// what we eliminated — the outer sum here is the correct semantics.
	let totalFilesChanged = 0;
	let totalInsertions = 0;
	let totalDeletions = 0;
	for (const summary of summaries) {
		const stats = resolveDiffStats(summary);
		totalFilesChanged += stats.filesChanged;
		totalInsertions += stats.insertions;
		totalDeletions += stats.deletions;
	}

	const period = {
		start: getDisplayDate(summaries[0]),
		end: getDisplayDate(summaries[summaries.length - 1]),
	};

	// Step 8: Compute token stats
	const topicTokens = estimateTokens(summaries.map((s) => renderSummarySection(s)).join("\n"));
	const planTokens = estimateTokens(plans.map((p) => p.content).join("\n"));
	const noteTokens = estimateTokens(notes.map((n) => n.content).join("\n"));
	const decisionTokens = estimateTokens(keyDecisions.map((d) => d.text).join("\n"));

	return {
		branch,
		period,
		commitCount: summaries.length,
		totalFilesChanged,
		totalInsertions,
		totalDeletions,
		summaries,
		plans,
		notes,
		keyDecisions,
		stats: {
			topicCount: summaries.reduce((acc, s) => acc + collectAllTopics(s).length, 0),
			planCount: plans.length,
			noteCount: notes.length,
			decisionCount: keyDecisions.length,
			topicTokens,
			planTokens,
			noteTokens,
			decisionTokens,
			transcriptTokens: 0,
			totalTokens: topicTokens + planTokens + noteTokens + decisionTokens,
		},
	};
}

// ─── Markdown rendering ──────────────────────────────────────────────────────

// ─── Structured payload (jolli recall --format json) ────────────────────────

/**
 * Projects a {@link CompiledContext} into the structured {@link RecallPayload}
 * shape consumed by the `/jolli-recall` skill template, applying budget
 * enforcement at the **field** level.
 *
 * Trim order (oldest commit first within each step):
 *   1. drop `topic.response` (longest field, lowest signal)
 *   2. drop `topic.trigger`
 *   3. drop `plans[].content` (keep slug + title as a citation anchor)
 *   4. drop `notes[].content`
 *   5. drop the entire oldest commit from `commits[]` (with its decisions)
 *
 * Type contract: every {@link SearchHit} that survives in `commits[]` carries
 * `decisions` on every topic and full identity fields. When the budget is so
 * tight that decisions can't fit, the commit is removed wholesale rather than
 * shipped without decisions — the skill template can rely on "all kept hits
 * are complete".
 */
export function buildRecallPayload(ctx: CompiledContext, tokenBudget?: number): RecallPayload {
	const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;

	let plans: RecallPayloadPlan[] = ctx.plans.map((p) => ({ slug: p.slug, title: p.title, content: p.content }));
	let notes: RecallPayloadNote[] = ctx.notes.map((n) => ({ id: n.id, title: n.title, content: n.content }));

	// Resolved-key sets — a stub on a commit is considered "live" only if its
	// slug/id has a matching entry at the payload top level. This guards the
	// `always resolves` contract documented in the recall skill template:
	// stubs whose body wasn't loaded (orphan-branch read failed) or wasn't
	// requested (`--no-plans` / `--no-notes`) get filtered out of the
	// per-commit hit instead of dangling.
	const resolvedPlanSlugs = new Set(plans.map((p) => p.slug));
	const resolvedNoteIds = new Set(notes.map((n) => n.id));

	// Per the chronological invariant in compileTaskContext (Step 2), summaries
	// are sorted oldest first. We project commits from this order so commits[0]
	// is the oldest — matching the trim direction below.
	let commits: SearchHit[] = ctx.summaries.map((s) => filterStubs(buildHit(s), resolvedPlanSlugs, resolvedNoteIds));
	let truncated = false;

	// Recall-only pre-pass 1: drop topics the LLM flagged as `"minor"`. These
	// are noise at the branch level — by definition the summarizer thought
	// they don't carry decision-grade signal. Search Phase 2 keeps them
	// (it ships the full SearchHit shape) so this trimming lives here, not
	// in `buildHit`. If a commit's topics become empty after the filter,
	// drop the whole commit — kept commits must always carry decisions
	// per the skill-template contract. Safety: if the filter would evict
	// every commit (pathological branch where every topic is minor), skip
	// the assignment so the original commits stay in place and downstream
	// `commits=[]` doesn't ambiguously mean "no records found".
	const filtered: SearchHit[] = [];
	let anyTopicDropped = false;
	let anyCommitDropped = false;
	for (const hit of commits) {
		const kept = hit.topics.filter((t) => t.importance !== "minor");
		if (kept.length === hit.topics.length) {
			filtered.push(hit);
			continue;
		}
		anyTopicDropped = true;
		if (kept.length === 0) {
			anyCommitDropped = true;
			continue;
		}
		filtered.push({ ...hit, topics: kept });
	}
	if (filtered.length > 0) {
		commits = filtered;
		if (anyTopicDropped || anyCommitDropped) truncated = true;
	}

	// Recall-only pre-pass 2: above the large-branch threshold, drop
	// `topic.response` from every kept commit. The measurement runs AFTER
	// pre-pass 1 so we tier by what would actually ship, not what was
	// loaded. `trigger` and `decisions` survive — only `response` is
	// targeted here; the existing budget-trim loop below may further drop
	// `trigger` if --budget still leaves us over-pressure.
	const responseAlreadyStripped = commits.length > RECALL_LARGE_BRANCH_THRESHOLD;
	if (responseAlreadyStripped) {
		let anyDropped = false;
		commits = commits.map((hit) => {
			const trimmed = hit.topics.map((t) => {
				if (t.response === undefined) return t;
				anyDropped = true;
				const { response: _r, ...rest } = t;
				return rest;
			});
			return { ...hit, topics: trimmed };
		});
		if (anyDropped) truncated = true;
	}

	// Build a stable envelope that surrounds commits/plans/notes so the budget
	// measure reflects the actual JSON output size, not just the variable parts.
	// estimatedTokens / truncated are not included (chicken-and-egg with measure
	// itself); their ~15-token cost is negligible against any realistic budget.
	const envelope = {
		type: "recall" as const,
		branch: ctx.branch,
		period: ctx.period,
		commitCount: ctx.commitCount,
		totalFilesChanged: ctx.totalFilesChanged,
		totalInsertions: ctx.totalInsertions,
		totalDeletions: ctx.totalDeletions,
		stats: ctx.stats,
	};

	const measure = (): number => estimateTokens(JSON.stringify({ ...envelope, commits, plans, notes }));

	// Step 1: drop topic.response from oldest commits.
	// Skip when pre-pass 2 already stripped response from every commit —
	// the loop would otherwise spread-copy every topic for no reason.
	for (let i = 0; !responseAlreadyStripped && i < commits.length && measure() > budget; i++) {
		const hit = commits[i];
		const trimmed = hit.topics.map((t) => {
			if (t.response === undefined) return t;
			truncated = true;
			const { response: _r, ...rest } = t;
			return rest;
		});
		commits[i] = { ...hit, topics: trimmed };
	}

	// Step 2: drop topic.trigger from oldest commits
	for (let i = 0; i < commits.length && measure() > budget; i++) {
		const hit = commits[i];
		const trimmed = hit.topics.map((t) => {
			if (t.trigger === undefined) return t;
			truncated = true;
			const { trigger: _t, ...rest } = t;
			return rest;
		});
		commits[i] = { ...hit, topics: trimmed };
	}

	// Step 3: drop plans[].content (slug + title remain as citation anchors)
	if (measure() > budget && plans.some((p) => p.content !== undefined)) {
		plans = plans.map((p) => {
			if (p.content === undefined) return p;
			truncated = true;
			return { slug: p.slug, title: p.title };
		});
	}

	// Step 4: drop notes[].content
	if (measure() > budget && notes.some((n) => n.content !== undefined)) {
		notes = notes.map((n) => {
			if (n.content === undefined) return n;
			truncated = true;
			return { id: n.id, title: n.title };
		});
	}

	// Step 5: drop the oldest commit wholesale (with its decisions) until we fit.
	// Always keep at least one commit — otherwise `commits=[]` would
	// ambiguously mean "no records found" OR "budget evicted everything",
	// forcing the skill template to teach the LLM a 3-way state machine
	// for a case only pathological budgets (< envelope size) ever trigger.
	// Keeping ≥1 commit makes empty-commits unambiguously mean "no records",
	// at the cost of a minor overage when `--budget` is set absurdly low.
	while (measure() > budget && commits.length > 1) {
		commits = commits.slice(1);
		truncated = true;
	}

	const estimatedTokens = measure();

	return {
		type: "recall",
		branch: ctx.branch,
		period: ctx.period,
		commitCount: ctx.commitCount,
		totalFilesChanged: ctx.totalFilesChanged,
		totalInsertions: ctx.totalInsertions,
		totalDeletions: ctx.totalDeletions,
		commits,
		plans,
		notes,
		stats: ctx.stats,
		estimatedTokens,
		...(truncated && { truncated: true }),
	};
}

/**
 * Strips plan/note stubs whose canonical key has no matching entry at the
 * payload top level. Without this guard the "always resolve" contract breaks
 * in two paths: (1) `readPlanFromBranch` / `readNoteFromBranch` returned null
 * (orphan-branch read miss); (2) the caller passed `--no-plans` / `--no-notes`,
 * leaving the top-level array empty while `summary.plans` / `summary.notes`
 * still feed buildHit's stub projection.
 */
function filterStubs(hit: SearchHit, resolvedPlanSlugs: Set<string>, resolvedNoteIds: Set<string>): SearchHit {
	const liveStubPlans = hit.plans?.filter((p) => resolvedPlanSlugs.has(p.slug));
	const liveStubNotes = hit.notes?.filter((n) => resolvedNoteIds.has(n.id));

	const next: { -readonly [K in keyof SearchHit]: SearchHit[K] } = { ...hit };
	if (liveStubPlans && liveStubPlans.length > 0) {
		next.plans = liveStubPlans;
	} else {
		delete next.plans;
	}
	if (liveStubNotes && liveStubNotes.length > 0) {
		next.notes = liveStubNotes;
	} else {
		delete next.notes;
	}
	return next;
}

// ─── Markdown rendering (used by --full / --output / default short summary) ─

/**
 * Renders a compiled context into Markdown, applying token budget truncation.
 *
 * Priority (high to low): decisions → plans → summaries → transcripts.
 * When over budget: drop transcripts → fold older topics → truncate plans.
 * Decisions are never truncated.
 */
export function renderContextMarkdown(ctx: CompiledContext, tokenBudget?: number): string {
	const budget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;
	const lines: string[] = [];

	// Header
	lines.push(`# Task Context: ${ctx.branch}`);
	lines.push("");
	lines.push(`**Branch:** ${ctx.branch}`);
	lines.push(`**Period:** ${formatDate(ctx.period.start)} to ${formatDate(ctx.period.end)}`);
	lines.push(
		`**Commits:** ${ctx.commitCount} | **Changes:** ${ctx.totalFilesChanged} files, +${ctx.totalInsertions} -${ctx.totalDeletions}`,
	);
	lines.push("");
	lines.push("---");
	lines.push("");

	// Decisions section (never truncated)
	if (ctx.keyDecisions.length > 0) {
		lines.push("## Key Decisions");
		lines.push("");
		for (let i = 0; i < ctx.keyDecisions.length; i++) {
			const d = ctx.keyDecisions[i];
			lines.push(`${i + 1}. ${d.text} (${d.commitHash.substring(0, 8)})`);
		}
		lines.push("");
		lines.push("---");
		lines.push("");
	}

	// Plans section
	const planSection: string[] = [];
	if (ctx.plans.length > 0) {
		planSection.push("## Plans");
		planSection.push("");
		for (const plan of ctx.plans) {
			planSection.push(`### ${plan.title}`);
			planSection.push("");
			planSection.push(plan.content);
			planSection.push("");
		}
		planSection.push("---");
		planSection.push("");
	}

	// Notes section
	const noteSection: string[] = [];
	if (ctx.notes.length > 0) {
		noteSection.push("## Notes");
		noteSection.push("");
		for (const note of ctx.notes) {
			noteSection.push(`### ${note.title}`);
			noteSection.push("");
			noteSection.push(note.content);
			noteSection.push("");
		}
		noteSection.push("---");
		noteSection.push("");
	}

	// Summaries section
	const summarySection: string[] = [];
	summarySection.push("## Commit History (chronological)");
	summarySection.push("");

	for (let i = 0; i < ctx.summaries.length; i++) {
		const s = ctx.summaries[i];
		summarySection.push(renderSummarySection(s, i + 1));
		summarySection.push("");
	}

	// Apply budget: decisions + plans + notes + summaries
	const decisionsText = lines.join("\n");
	const plansText = planSection.join("\n");
	const notesText = noteSection.join("\n");
	const summariesText = summarySection.join("\n");

	const currentTokens = estimateTokens(decisionsText);
	const remaining = budget - currentTokens;

	// When decisions alone exceed the budget, drop plans, notes, and summaries entirely
	if (remaining <= 0) {
		const footer = `\n*Generated by Jolli Memory · ${ctx.commitCount} commits · ~${currentTokens} tokens (decisions exceeded budget)*`;
		return decisionsText + footer;
	}

	// Budget allocation: plans+notes share 25%, summaries get the rest
	const hasPlansOrNotes = ctx.plans.length > 0 || ctx.notes.length > 0;
	const plansNotesBudget = hasPlansOrNotes ? Math.floor(remaining * 0.25) : 0;
	const summaryBudget = remaining - plansNotesBudget;

	let finalPlans = plansText;
	let finalNotes = notesText;
	const combinedPlansNotes = plansText + notesText;
	if (estimateTokens(combinedPlansNotes) > plansNotesBudget) {
		const truncated = truncateToTokenBudget(combinedPlansNotes, plansNotesBudget);
		// Plans come first in the combined text, so truncation naturally favours them
		finalPlans = truncated;
		finalNotes = "";
	}

	let finalSummaries = summariesText;
	if (estimateTokens(summariesText) > summaryBudget) {
		finalSummaries = truncateToTokenBudget(summariesText, summaryBudget);
	}

	const allContent = decisionsText + finalPlans + finalNotes + finalSummaries;
	const footer = `\n*Generated by Jolli Memory · ${ctx.commitCount} commits · ~${estimateTokens(allContent)} tokens*`;

	return allContent + footer;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderSummarySection(summary: CommitSummary, index?: number): string {
	const lines: string[] = [];
	const stats = resolveDiffStats(summary);
	const prefix = index !== undefined ? `${index}. ` : "";

	lines.push(
		`### ${prefix}${summary.commitHash.substring(0, 8)} — ${summary.commitMessage} (${formatDate(getDisplayDate(summary))})`,
	);
	lines.push(`**Changes:** ${stats.filesChanged} files, +${stats.insertions} -${stats.deletions}`);
	lines.push("");

	const topics = collectAllTopics(summary);
	for (const topic of topics) {
		const importance = topic.importance ? ` [${topic.importance}]` : "";
		const category = topic.category ? `${topic.category}` : "";
		lines.push(`#### ${topic.title}${category ? ` [${category}]` : ""}${importance}`);
		if (topic.trigger) lines.push(`- **Why:** ${topic.trigger}`);
		if (topic.decisions) lines.push(`- **Decisions:** ${topic.decisions}`);
		if (topic.response) lines.push(`- **What:** ${topic.response}`);
		if (topic.filesAffected && topic.filesAffected.length > 0) {
			lines.push(`- **Files:** ${topic.filesAffected.join(", ")}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function emptyContext(branch: string): CompiledContext {
	return {
		branch,
		period: { start: "", end: "" },
		commitCount: 0,
		totalFilesChanged: 0,
		totalInsertions: 0,
		totalDeletions: 0,
		summaries: [],
		plans: [],
		notes: [],
		keyDecisions: [],
		stats: {
			topicCount: 0,
			planCount: 0,
			noteCount: 0,
			decisionCount: 0,
			topicTokens: 0,
			planTokens: 0,
			noteTokens: 0,
			decisionTokens: 0,
			transcriptTokens: 0,
			totalTokens: 0,
		},
	};
}

function formatDate(iso: string): string {
	if (!iso) return "unknown";
	return iso.split("T")[0];
}

function truncateToTokenBudget(text: string, budget: number): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let tokens = 0;

	for (const line of lines) {
		const lineTokens = estimateTokens(line);
		if (tokens + lineTokens > budget) {
			result.push("\n*[... truncated due to token budget]*");
			break;
		}
		result.push(line);
		tokens += lineTokens;
	}

	return result.join("\n");
}
