/**
 * ContextRelevance
 *
 * Assesses how relevant each CONTEXT item (plan / note / reference) is to a
 * specific code change, BEFORE a commit summary is generated. The result is
 * used to (a) rank items and take top-N under a token budget, (b) attach a
 * one-line AI relevance note + tier to each item, and (c) conservatively
 * soft-exclude clearly-unrelated items.
 *
 * Design:
 *   - Pure LLM scoring (no BM25 / embeddings). One batch call per assessment.
 *   - Candidates are NOT sent whole when large: small items go verbatim, large
 *     ones are reduced to a mechanical, fence-aware skeleton. A total token cap
 *     bounds the prompt regardless of item count/size.
 *   - Model follows the caller's LlmConfig (default sonnet, proxy fallback) —
 *     same resolution as summary generation.
 *   - fail-open: any error (LLM failure, timeout, parse failure) yields a
 *     "keep everything" result so a ranking problem never drops context.
 *
 * The orchestrator `rankContextRelevance` is credential-driven; the pure
 * helpers (`extractCandidateRepr`, `buildItemsBlock`, `parseRankContextResponse`)
 * are exported for unit testing.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type {
	ContextRelevanceRef,
	ExcludedContextItem,
	LlmConfig,
	NoteEntry,
	PlanEntry,
	ReferenceEntry,
} from "../Types.js";
import { type AiRelevanceEntry, isEffectivelyExcluded } from "./CommitSelectionStore.js";
import { execGit, getDiffContent } from "./GitOps.js";
import { callLlm } from "./LlmClient.js";
import { toForwardSlash } from "./PathUtils.js";
import { resolveModelId } from "./Summarizer.js";

const log = createLogger("ContextRelevance");

// -- Tunables -----------------------------------------------------------------

/** Rough chars-per-token used for budget estimation. Deliberately low
 *  (code + CJK are denser than English prose) so the cap errs toward smaller
 *  prompts rather than overflow. */
export const CHARS_PER_TOKEN = 3;

/** Total character budget for the rendered <context-items> block. ~40K tokens
 *  at CHARS_PER_TOKEN. Items beyond the budget (after skeletonization) are
 *  dropped from the tail of the initial order and logged. */
export const TOTAL_ITEMS_CHAR_BUDGET = 120_000;

/** A reference whose (frontmatter-stripped) body is at/under this is sent
 *  whole; aligned with the summarize-stage per-reference cap so we never send
 *  more to the ranker than the summary will ever use. */
export const REFERENCE_WHOLE_CHAR_CAP = 4_000;

/** A plan/note at/under this is sent whole; larger ones are skeletonized. */
export const PLANNOTE_WHOLE_CHAR_CAP = 6_000;

/** Hard cap on a single item's skeleton (~1.5K tokens). */
export const SKELETON_CHAR_CAP = 4_500;

/** Short per-call wall-clock so a wedged ranking call fails open fast without
 *  holding the post-commit queue lock. */
export const RANK_TIMEOUT_MS = 45_000;

/** Max output tokens for the ranking call — one short block per item. */
const RANK_MAX_TOKENS = 4_096;

// -- Types --------------------------------------------------------------------

export type ContextKind = "plan" | "note" | "reference";

/** A candidate CONTEXT item to assess. `content` is the item's full text, read
 *  from its `sourcePath` on disk (falling back to the title when the file is
 *  missing or empty), which may be large. */
export interface ContextItem {
	readonly kind: ContextKind;
	/** slug (plan) / note id / mapKey (reference). Opaque; echoed back to caller. */
	readonly id: string;
	readonly title: string;
	readonly content: string;
}

/** The change being assessed against. Built by `buildChangeSignal`. */
export interface ChangeSignal {
	readonly commitMessage: string;
	readonly changedFiles: readonly string[];
	readonly symbols: readonly string[];
}

export type RelevanceTier = "high" | "mid" | "low";

export interface ContextRelevanceResult {
	readonly id: string;
	readonly kind: ContextKind;
	readonly relevant: boolean;
	/** 0..1 confidence the item is relevant. */
	readonly score: number;
	readonly tier: RelevanceTier;
	readonly reason: string;
	/** 1-based rank by score descending (1 = most relevant). */
	readonly rank: number;
	/** true when the item should be soft-excluded (clearly unrelated). */
	readonly autoExclude: boolean;
}

export interface RankOptions {
	readonly config: LlmConfig;
	/** Override the per-call timeout (default RANK_TIMEOUT_MS). */
	readonly timeoutMs?: number;
	/** Override the total items char budget (default TOTAL_ITEMS_CHAR_BUDGET). */
	readonly totalBudget?: number;
}

// -- Frontmatter & skeleton extraction ---------------------------------------

/** Strips a leading YAML frontmatter block (`---\n...\n---`) if present. */
export function stripFrontmatter(content: string): string {
	const m = content.match(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	return m ? content.slice(m[0].length) : content;
}

/** Matches a repo-relative-ish file path with a known code/doc extension. */
const FILE_PATH_RE = /[\w][\w./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|kt|kts|css|ya?ml|py|go|rs)\b/g;

/**
 * Builds a mechanical, fence-aware skeleton of a large markdown document:
 * metadata line + title + first paragraph + all section headings + referenced
 * file paths + each section's first sentence (L1), truncated to `cap`.
 * Code-fence contents are excluded from heading detection.
 */
export function buildSkeleton(kind: ContextKind, title: string, body: string, cap: number): string {
	const lines = body.split(/\r?\n/);
	const totalChars = body.length;
	const headings: string[] = [];
	const files = new Set<string>();
	const sectionFirstSentences: string[] = [];
	let firstParagraph = "";

	let fenceChar: string | null = null;
	let sawFirstHeading = false;
	let pendingSectionSentence = false;
	// Collect the lead prose before the first heading as the Overview, regardless
	// of whether the item also has a title (Memory Bank docs keep the title in
	// frontmatter and open with prose, so the lead paragraph is high signal).
	let collectingIntro = true;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		// Fence tracking is marker-type aware: a fence only closes on the SAME
		// marker char it opened with, so a `~~~` line inside a ``` block (or vice
		// versa) does not spuriously toggle the state.
		const fenceMatch = line.match(/^(```+|~~~+)/);
		if (fenceMatch) {
			const ch = fenceMatch[1][0];
			if (fenceChar === null) fenceChar = ch;
			else if (ch === fenceChar) fenceChar = null;
			continue;
		}
		if (fenceChar !== null) continue;

		// Collect file-path tokens from any non-fence line.
		for (const match of rawLine.matchAll(FILE_PATH_RE)) {
			files.add(toForwardSlash(match[0]));
		}

		const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
		if (headingMatch) {
			const text = headingMatch[1].trim();
			headings.push(text);
			sawFirstHeading = true;
			pendingSectionSentence = true;
			collectingIntro = false;
			continue;
		}

		if (line.length === 0) continue;

		// First paragraph = first non-empty prose before the first heading.
		if (!sawFirstHeading && collectingIntro && firstParagraph.length < 240) {
			firstParagraph = firstParagraph ? `${firstParagraph} ${line}` : line;
			continue;
		}

		// First sentence after each heading (L1).
		if (pendingSectionSentence) {
			sectionFirstSentences.push(firstSentence(line));
			pendingSectionSentence = false;
		}
	}

	const metaLine = `[${kind} · original ${totalChars} chars / ${lines.length} lines · mechanical skeleton, not full text]`;
	const parts: string[] = [metaLine];
	if (title) parts.push(`Title: ${title}`);
	if (firstParagraph) parts.push(`Overview: ${firstParagraph}`);
	if (headings.length > 0) parts.push(`Sections: ${headings.join(" / ")}`);
	if (files.size > 0) parts.push(`Files: ${[...files].slice(0, 40).join(", ")}`);

	// L1/L2: append section first-sentences until we approach the cap.
	let out = parts.join("\n");
	for (const sentence of sectionFirstSentences) {
		if (!sentence) continue;
		const next = `${out}\n- ${sentence}`;
		if (next.length > cap) break;
		out = next;
	}
	return out.length > cap ? `${out.slice(0, cap)}\n[…truncated]` : out;
}

/** Returns the first sentence-ish fragment of a line (up to ~160 chars). */
function firstSentence(line: string): string {
	const trimmed = line.replace(/^[-*+]\s+/, "").trim();
	const dot = trimmed.search(/[.。!?！？]\s|[.。!?！？]$/);
	const frag = dot >= 0 ? trimmed.slice(0, dot + 1) : trimmed;
	return frag.length > 160 ? `${frag.slice(0, 160)}…` : frag;
}

/**
 * Produces the representation of one candidate to feed the ranker: whole text
 * when small, a skeleton when large. References have their YAML frontmatter
 * stripped first (title is carried separately by the item).
 */
export function extractCandidateRepr(item: ContextItem): string {
	const isReference = item.kind === "reference";
	const body = isReference ? stripFrontmatter(item.content) : item.content;
	const wholeCap = isReference ? REFERENCE_WHOLE_CHAR_CAP : PLANNOTE_WHOLE_CHAR_CAP;
	const trimmed = body.trim();
	if (trimmed.length <= wholeCap) {
		return trimmed;
	}
	// Skeleton cap never exceeds the whole-send cap, so skeletonizing can never
	// produce a larger representation than sending the item whole would have
	// (guards the reference case where SKELETON_CHAR_CAP > REFERENCE_WHOLE_CHAR_CAP).
	return buildSkeleton(item.kind, item.title, trimmed, Math.min(SKELETON_CHAR_CAP, wholeCap));
}

// -- Prompt assembly ----------------------------------------------------------

/** Renders the <context-items> block and the index→id map. Enforces a total
 *  char budget by dropping items from the tail of the initial order (logged),
 *  so an oversized candidate set never overflows the prompt. */
export function buildItemsBlock(
	items: readonly ContextItem[],
	totalBudget = TOTAL_ITEMS_CHAR_BUDGET,
): {
	block: string;
	indexToId: Map<number, string>;
	dropped: number;
} {
	const indexToId = new Map<number, string>();
	const blocks: string[] = [];
	let used = 0;
	let dropped = 0;
	let index = 0;

	for (const item of items) {
		const repr = extractCandidateRepr(item);
		const rendered = `[${index + 1}] (${item.kind}) ${item.title}\n${repr}`;
		if (used + rendered.length > totalBudget && blocks.length > 0) {
			dropped = items.length - index;
			log.warn("buildItemsBlock: total budget %d reached, dropping %d tail item(s)", totalBudget, dropped);
			break;
		}
		index += 1;
		indexToId.set(index, item.id);
		blocks.push(rendered);
		used += rendered.length;
	}

	return { block: blocks.join("\n\n"), indexToId, dropped };
}

/** Renders the <change> block from a ChangeSignal. */
export function buildChangeBlock(change: ChangeSignal): string {
	const lines: string[] = [`Commit message: ${change.commitMessage || "(none)"}`];
	if (change.changedFiles.length > 0) {
		lines.push(`Changed files:\n${change.changedFiles.map((f) => `  ${f}`).join("\n")}`);
	}
	if (change.symbols.length > 0) {
		lines.push(`Key symbols: ${change.symbols.join(", ")}`);
	}
	return lines.join("\n");
}

// -- Response parsing ---------------------------------------------------------

const ITEM_DELIMITER_RE = /^\s*===ITEM===\s*$/m;

interface ParsedItem {
	index: number;
	relevant: boolean;
	score: number;
	reason: string;
}

/**
 * Parses the rank-context response (===ITEM=== blocks) into per-index records.
 * Tolerant of missing/garbled fields: an item with an unparseable index is
 * skipped; missing relevant/score/reason default to conservative "keep".
 */
export function parseRankContextResponse(text: string): ParsedItem[] {
	const segments = text
		.split(ITEM_DELIMITER_RE)
		.slice(1)
		.filter((s) => s.trim().length > 0);
	const out: ParsedItem[] = [];
	for (const seg of segments) {
		const index = intField(seg, "index");
		if (index === undefined) continue;
		const relevantRaw = strField(seg, "relevant");
		const scoreRaw = strField(seg, "score");
		const reason = strField(seg, "reason") ?? "";
		// Treat any answer starting with no / nope / none / not / false as "not
		// relevant"; everything else (incl. omitted) defaults to relevant (conservative).
		const relevant = relevantRaw ? !/^\s*(no?|nope|none|not\b|false)/i.test(relevantRaw.trim()) : true;
		const scoreNum = scoreRaw !== undefined ? Number.parseFloat(scoreRaw) : Number.NaN;
		const score = Number.isFinite(scoreNum) ? clamp01(scoreNum) : relevant ? 0.7 : 0.2;
		out.push({ index, relevant, score, reason: reason.trim() });
	}
	return out;
}

function strField(segment: string, name: string): string | undefined {
	const re = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "im");
	const m = segment.match(re);
	return m ? m[1].trim() : undefined;
}

function intField(segment: string, name: string): number | undefined {
	const raw = strField(segment, name);
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isInteger(n) ? n : undefined;
}

function clamp01(n: number): number {
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Maps a 1-based rank (within `total` items) to a tier by POSITION, not by the
 *  model's uncalibrated absolute score (which drifts across commits, so absolute
 *  cutoffs aren't comparable run-to-run).
 *  Top third → high, middle → mid, bottom third → low. */
function tierForRank(rank: number, total: number): RelevanceTier {
	if (total <= 1) return "high";
	const frac = (rank - 1) / (total - 1);
	if (frac <= 1 / 3) return "high";
	if (frac <= 2 / 3) return "mid";
	return "low";
}

/** True when a rank sits in the bottom third — the only band eligible for
 *  auto-exclude (and only when the item is also judged not relevant). */
function isBottomRank(rank: number, total: number): boolean {
	if (total <= 1) return false;
	return (rank - 1) / (total - 1) > 2 / 3;
}

// -- Orchestrator -------------------------------------------------------------

/** Builds a "keep everything" fail-open result (used on any error). */
function keepAll(items: readonly ContextItem[]): ContextRelevanceResult[] {
	return items.map((item, i) => ({
		id: item.id,
		kind: item.kind,
		relevant: true,
		score: 0.7,
		tier: "high" as const,
		reason: "",
		rank: i + 1,
		autoExclude: false,
	}));
}

/**
 * Assesses relevance of every item against the change with one LLM call.
 * Returns per-item {relevant, score, tier, reason, rank, autoExclude}, ranked
 * by score descending. Never throws: on any failure returns keepAll (fail-open).
 * Returns [] for an empty item list (0 items → no analysis).
 */
export async function rankContextRelevance(
	change: ChangeSignal,
	items: readonly ContextItem[],
	opts: RankOptions,
): Promise<ContextRelevanceResult[]> {
	if (items.length === 0) return [];

	try {
		const { block, indexToId } = buildItemsBlock(items, opts.totalBudget ?? TOTAL_ITEMS_CHAR_BUDGET);
		const llmResult = await callLlm({
			action: "rank-context",
			params: { changeSignal: buildChangeBlock(change), items: block },
			maxTokens: RANK_MAX_TOKENS,
			timeoutMs: opts.timeoutMs ?? RANK_TIMEOUT_MS,
			apiKey: opts.config.apiKey,
			model: resolveModelId(opts.config.model),
			jolliApiKey: opts.config.jolliApiKey,
			aiProvider: opts.config.aiProvider,
		});
		const parsed = parseRankContextResponse(llmResult.text ?? "");

		// Map parsed records back onto items by index. Items the LLM omitted are
		// conservatively kept (relevant, mid score) so nothing is silently dropped.
		const byIndex = new Map<number, ParsedItem>();
		for (const p of parsed) byIndex.set(p.index, p);

		const merged = items.map((item, i) => {
			// index in the block is 1-based and matches insertion order up to any
			// dropped tail; find this item's block index via indexToId.
			const blockIndex = findIndexForId(indexToId, item.id) ?? i + 1;
			const p = byIndex.get(blockIndex);
			const relevant = p?.relevant ?? true;
			const score = p?.score ?? 0.5;
			const reason = p?.reason ?? "";
			return { item, relevant, score, reason };
		});

		// Rank by score desc (stable on ties by original order).
		const ranked = merged
			.map((m, i) => ({ ...m, origin: i }))
			.sort((a, b) => b.score - a.score || a.origin - b.origin);

		const total = ranked.length;
		return ranked.map((m, i) => {
			const rank = i + 1;
			return {
				id: m.item.id,
				kind: m.item.kind,
				relevant: m.relevant,
				score: m.score,
				// Tier and auto-exclude are driven by RANK (position), not the raw
				// score — score is retained on the result for audit only.
				tier: tierForRank(rank, total),
				reason: m.reason,
				rank,
				autoExclude: !m.relevant && isBottomRank(rank, total),
			};
		});
	} catch (err) {
		log.warn(
			"rankContextRelevance failed (%s) — keeping all items",
			err instanceof Error ? err.message : String(err),
		);
		return keepAll(items);
	}
}

function findIndexForId(indexToId: Map<number, string>, id: string): number | undefined {
	for (const [idx, mappedId] of indexToId) {
		if (mappedId === id) return idx;
	}
	return undefined;
}

// -- Change signal ------------------------------------------------------------

const SYMBOL_DECL_RE = /\b(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;

/** Extracts declared symbol names from added diff lines (bounded, deduped). */
export function extractSymbols(diff: string, max = 40): string[] {
	const out = new Set<string>();
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (!line.startsWith("+")) continue;
		for (const m of line.matchAll(SYMBOL_DECL_RE)) {
			out.add(m[1]);
			if (out.size >= max) return [...out];
		}
	}
	return [...out];
}

/**
 * Builds a ChangeSignal for a commit range: message (caller-supplied) + changed
 * file list (git diff --name-only) + key declared symbols (from the diff body).
 * Uses its own `--name-only` call — capDiffToBudget only embeds --stat when the
 * diff overflows, so a dedicated call is the reliable way to get the file list.
 * Best-effort: git failures leave the respective field empty rather than throw.
 */
export async function buildChangeSignal(
	commitMessage: string,
	fromRef: string,
	toRef: string,
	cwd: string,
): Promise<ChangeSignal> {
	let changedFiles: readonly string[] = [];
	const namesRes = await execGit(["diff", "--name-only", fromRef, toRef], cwd);
	if (namesRes.exitCode === 0) {
		changedFiles = namesRes.stdout
			.split(/\r?\n/)
			.map((l) => toForwardSlash(l.trim()))
			.filter((l) => l.length > 0);
	}
	let symbols: readonly string[] = [];
	try {
		const diff = await getDiffContent(fromRef, toRef, cwd, 60_000);
		symbols = extractSymbols(diff);
	} catch {
		// symbols are best-effort; leave empty on failure
	}
	return { commitMessage, changedFiles, symbols };
}

/** Fingerprint of a change for panel↔worker reuse coordination. Keyed ONLY on the
 *  sorted changed-file set — deliberately NOT the commit message — so the pre-commit
 *  panel (which has no message yet) and the post-commit worker (which does) produce
 *  the SAME fingerprint for the same file set, letting the worker reuse the panel's
 *  ranking instead of re-running the LLM. Order-independent (sorted). */
export function computeChangeFingerprint(change: ChangeSignal): string {
	const h = createHash("sha1");
	h.update([...change.changedFiles].sort().join("\n"));
	return h.digest("hex");
}

// -- Pipeline integration (registry entries → relevance decision) ------------

/** Registry entries for the three context kinds, pre-filtered of user hard-excludes. */
export interface RawContextEntries {
	readonly plans: readonly PlanEntry[];
	readonly notes: readonly NoteEntry[];
	readonly references: readonly ReferenceEntry[];
}

/** Decision returned to the QueueWorker: kept entries (in relevance order) per
 *  kind, plus the soft-excluded items for CommitSummary.excludedContext. */
export interface ContextRelevanceDecision {
	readonly plans: readonly PlanEntry[];
	readonly notes: readonly NoteEntry[];
	readonly references: readonly ReferenceEntry[];
	readonly excludedContext: readonly ExcludedContextItem[];
	readonly results: readonly ContextRelevanceResult[];
}

/** Reference key `<source>:<nativeId>` — matches the plans.json.references map key
 *  and the QueueWorker's prompt-filter key on both the normal and amend paths. */
function referenceKey(e: ReferenceEntry): string {
	return `${e.source}:${e.nativeId}`;
}

/** Display label for a reference: `<nativeId> — <title>`, matching the sidebar and
 *  the summary's kept-reference rows so the AI-excluded list reads identically (a
 *  bare title like "JolliMemory: …" without the "JOLLI-776 —" prefix looked
 *  inconsistent next to the kept references). */
function referenceLabel(e: ReferenceEntry): string {
	return `${e.nativeId} — ${e.title}`;
}

/** Reads an entry's canonical content from disk, falling back to its title when
 *  the source file is missing/empty (plan sourcePaths can point outside the
 *  worktree). Best-effort: never throws. */
async function readEntryContent(sourcePath: string | undefined, fallback: string): Promise<string> {
	if (!sourcePath) return fallback;
	try {
		const c = await readFile(sourcePath, "utf8");
		return c.trim().length > 0 ? c : fallback;
	} catch {
		return fallback;
	}
}

/**
 * End-to-end relevance assessment for the QueueWorker. Builds candidates from
 * registry entries (already filtered of user hard-excludes), ranks them, and
 * returns kept entries in relevance order plus the soft-excluded items for the
 * summary's `excludedContext`.
 *
 * Always recomputes: fingerprint-based reuse of the panel's persisted
 * aiRelevance list lives in buildDecisionFromAiRelevance, not here. Never
 * throws — rankContextRelevance fails open, so any failure yields "keep
 * everything, exclude nothing".
 */
export async function assessContextRelevance(
	raw: RawContextEntries,
	change: ChangeSignal,
	config: LlmConfig,
): Promise<ContextRelevanceDecision> {
	const items: ContextItem[] = [];
	for (const p of raw.plans) {
		items.push({
			kind: "plan",
			id: p.slug,
			title: p.title,
			content: await readEntryContent(p.sourcePath, p.title),
		});
	}
	for (const n of raw.notes) {
		items.push({ kind: "note", id: n.id, title: n.title, content: await readEntryContent(n.sourcePath, n.title) });
	}
	for (const r of raw.references) {
		items.push({
			kind: "reference",
			id: referenceKey(r),
			title: r.title,
			content: await readEntryContent(r.sourcePath, r.title),
		});
	}

	if (items.length === 0) {
		return { plans: raw.plans, notes: raw.notes, references: raw.references, excludedContext: [], results: [] };
	}

	const results = await rankContextRelevance(change, items, { config });

	const planById = new Map(raw.plans.map((p) => [p.slug, p] as const));
	const noteById = new Map(raw.notes.map((n) => [n.id, n] as const));
	const refByKey = new Map(raw.references.map((r) => [referenceKey(r), r] as const));

	const keptPlans: PlanEntry[] = [];
	const keptNotes: NoteEntry[] = [];
	const keptRefs: ReferenceEntry[] = [];
	const excludedContext: ExcludedContextItem[] = [];

	for (const res of results) {
		if (res.autoExclude) {
			const refEntry = res.kind === "reference" ? refByKey.get(res.id) : undefined;
			const title =
				res.kind === "plan"
					? planById.get(res.id)?.title
					: res.kind === "note"
						? noteById.get(res.id)?.title
						: refEntry
							? referenceLabel(refEntry)
							: undefined;
			excludedContext.push({
				kind: res.kind,
				key: res.id,
				title: title ?? res.id,
				reason: res.reason,
				tier: "low",
			});
			continue;
		}
		if (res.kind === "plan") {
			const e = planById.get(res.id);
			if (e) keptPlans.push(e);
		} else if (res.kind === "note") {
			const e = noteById.get(res.id);
			if (e) keptNotes.push(e);
		} else {
			const e = refByKey.get(res.id);
			if (e) keptRefs.push(e);
		}
	}

	return { plans: keptPlans, notes: keptNotes, references: keptRefs, excludedContext, results };
}

/**
 * Projects a decision's per-item results into the summary-artifact shape: one
 * `{kind, key, tier, reason}` entry per KEPT item (excluded items live on
 * `excludedContext` instead — no duplication). This is what lands on
 * `CommitSummary.contextRelevance`. Works for both ranking sources: a fresh
 * `assessContextRelevance` (full results) and a fingerprint-reuse
 * `buildDecisionFromAiRelevance` (results rebuilt from the persisted
 * aiRelevance list; empty on legacy selection files → returns []).
 *
 * Empty-reason entries are dropped: the fail-open `keepAll` fallback fabricates
 * `tier:"high", reason:""` for EVERY item when the ranking LLM fails, and a
 * per-item LLM omission defaults to `reason:""` too — neither is a real
 * verdict, and persisting them would stamp "all High" onto the artifact
 * (contradicting the field's "absent on fail-open" contract) and render
 * dangling `· ` separators.
 */
export function keptContextRelevanceRefs(decision: ContextRelevanceDecision): ContextRelevanceRef[] {
	return decision.results
		.filter((r) => !r.autoExclude && r.reason !== "")
		.map((r) => ({ kind: r.kind, key: r.id, tier: r.tier, reason: r.reason }));
}

/**
 * Reconstructs a decision from the previously-persisted AI ranking. The pre-commit
 * panel writes the full per-item `aiRelevance` list + a change fingerprint
 * (full-text ranking); the QueueWorker reuses it here when the fingerprint
 * matches, INSTEAD of re-running the LLM — so what the user saw in the panel is
 * exactly what lands, and the common path costs only one LLM call. Registry order
 * is kept (no re-ranking: the authoritative data is the per-item entries; top-N
 * ordering is secondary).
 *
 * Membership comes from `isEffectivelyExcluded`: the AI's original `excluded`
 * judgment minus the user's `dismissed` veto. A dismissed entry therefore lands
 * as a KEPT item carrying its ORIGINAL tier + reason (nothing the AI concluded
 * is lost — display layers decide what to show). Items with no persisted entry
 * (legacy file, or added after the ranking) get no result entry — the display
 * layers fall back to plain title rows. Pure — no I/O.
 */
export function buildDecisionFromAiRelevance(
	raw: RawContextEntries,
	aiRelevance: readonly AiRelevanceEntry[],
): ContextRelevanceDecision {
	const entryByKind = {
		plans: new Map<string, AiRelevanceEntry>(),
		notes: new Map<string, AiRelevanceEntry>(),
		references: new Map<string, AiRelevanceEntry>(),
	};
	for (const e of aiRelevance) {
		if (e.kind === "plans" || e.kind === "notes" || e.kind === "references") entryByKind[e.kind].set(e.key, e);
	}
	const keptPlans: PlanEntry[] = [];
	const keptNotes: NoteEntry[] = [];
	const keptRefs: ReferenceEntry[] = [];
	const excludedContext: ExcludedContextItem[] = [];
	const results: ContextRelevanceResult[] = [];
	// Reconstructed results carry no meaningful score/rank (those never persist);
	// rank re-numbers in registry order purely to keep the field monotonic.
	// Returns whether the item is EFFECTIVELY excluded so the caller can route it.
	const pushResult = (kind: ContextKind, id: string, entry: AiRelevanceEntry | undefined): boolean => {
		if (!entry) return false; // no persisted verdict for this item → kept, plain
		const excluded = isEffectivelyExcluded(entry);
		results.push({
			id,
			kind,
			relevant: !excluded,
			score: 0,
			tier: entry.tier,
			reason: entry.reason,
			rank: results.length + 1,
			autoExclude: excluded,
		});
		return excluded;
	};
	for (const p of raw.plans) {
		const entry = entryByKind.plans.get(p.slug);
		if (pushResult("plan", p.slug, entry)) {
			excludedContext.push({ kind: "plan", key: p.slug, title: p.title, reason: entry?.reason ?? "" });
		} else keptPlans.push(p);
	}
	for (const n of raw.notes) {
		const entry = entryByKind.notes.get(n.id);
		if (pushResult("note", n.id, entry)) {
			excludedContext.push({ kind: "note", key: n.id, title: n.title, reason: entry?.reason ?? "" });
		} else keptNotes.push(n);
	}
	for (const r of raw.references) {
		const key = referenceKey(r);
		const entry = entryByKind.references.get(key);
		if (pushResult("reference", key, entry)) {
			excludedContext.push({ kind: "reference", key, title: referenceLabel(r), reason: entry?.reason ?? "" });
		} else keptRefs.push(r);
	}
	return { plans: keptPlans, notes: keptNotes, references: keptRefs, excludedContext, results };
}
