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
import { getIndex, getSummary, readNoteFromBranch, readPlanFromBranch } from "./SummaryStore.js";
import { aggregateStats, collectAllTopics } from "./SummaryTree.js";

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

/** JSON output for SKILL.md (stats + rendered markdown, no raw data duplication) */
export interface ContextOutput {
	readonly type: "recall";
	readonly stats: ContextStats;
	readonly renderedMarkdown: string;
}

export interface BranchCatalogEntry {
	readonly branch: string;
	readonly commitCount: number;
	readonly period: { readonly start: string; readonly end: string };
	readonly commitMessages: ReadonlyArray<string>;
}

export interface BranchCatalog {
	readonly type: "catalog";
	readonly query?: string;
	readonly branches: ReadonlyArray<BranchCatalogEntry>;
}

// ─── Token estimation ────────────────────────────────────────────────────────

const CJK_RANGE =
	/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/u;

/**
 * Estimates token count for mixed CJK/ASCII text.
 * CJK characters ~1.5 tokens each, ASCII ~0.25 tokens/char.
 */
export function estimateTokens(text: string): number {
	let cjkChars = 0;
	let asciiChars = 0;
	for (const ch of text) {
		if (CJK_RANGE.test(ch)) {
			cjkChars++;
		} else {
			asciiChars++;
		}
	}
	return Math.ceil(cjkChars * 1.5 + asciiChars * 0.25);
}

// ─── Branch catalog ──────────────────────────────────────────────────────────

/**
 * Lists all branches with Jolli Memory records, aggregated from index.json.
 * Only reads the index file — no summary files loaded. Fast.
 */
export async function listBranchCatalog(cwd?: string): Promise<BranchCatalog> {
	const index = await getIndex(cwd);
	if (!index) {
		return { type: "catalog", branches: [] };
	}

	const rootEntries = index.entries.filter((e) => e.parentCommitHash === null || e.parentCommitHash === undefined);

	const branchMap = new Map<string, SummaryIndexEntry[]>();
	for (const entry of rootEntries) {
		const list = branchMap.get(entry.branch);
		if (list) {
			list.push(entry);
		} else {
			branchMap.set(entry.branch, [entry]);
		}
	}

	const branches: BranchCatalogEntry[] = [];
	for (const [branch, entries] of branchMap) {
		const sorted = entries.sort((a, b) => new Date(a.commitDate).getTime() - new Date(b.commitDate).getTime());
		branches.push({
			branch,
			commitCount: entries.length,
			period: {
				start: sorted[0].commitDate,
				end: sorted[sorted.length - 1].commitDate,
			},
			commitMessages: sorted.map((e) => e.commitMessage),
		});
	}

	// Sort branches by most recent activity
	branches.sort((a, b) => new Date(b.period.end).getTime() - new Date(a.period.end).getTime());

	return { type: "catalog", branches };
}

// ─── Plan deduplication ──────────────────────────────────────────────────────

interface PlanCandidate {
	readonly slug: string;
	readonly title: string;
	readonly commitHash: string;
	readonly commitDate: string;
}

/**
 * Deduplicates plan references by base slug.
 * Archived plans have slug format "base-slug-<shortHash>". We extract the base
 * by cross-validating the trailing hash against the actual commit's shortHash.
 */
function deduplicatePlans(candidates: ReadonlyArray<PlanCandidate>): ReadonlyArray<PlanCandidate> {
	const baseSlugMap = new Map<string, PlanCandidate>();

	for (const plan of candidates) {
		const baseSlug = extractBaseSlug(plan.slug, plan.commitHash);
		const existing = baseSlugMap.get(baseSlug);
		if (!existing || new Date(plan.commitDate).getTime() > new Date(existing.commitDate).getTime()) {
			baseSlugMap.set(baseSlug, plan);
		}
	}

	return [...baseSlugMap.values()];
}

/**
 * Extracts the base slug from an archived slug by cross-validating the trailing
 * hash against the commit's actual short hash.
 */
function extractBaseSlug(slug: string, commitHash: string): string {
	const shortHash = commitHash.substring(0, 8);
	if (slug.endsWith(`-${shortHash}`)) {
		return slug.slice(0, -(shortHash.length + 1));
	}
	// Try 7-char hash too
	const shortHash7 = commitHash.substring(0, 7);
	if (slug.endsWith(`-${shortHash7}`)) {
		return slug.slice(0, -(shortHash7.length + 1));
	}
	// No match — slug is the base
	return slug;
}

// ─── Core compilation ────────────────────────────────────────────────────────

export const DEFAULT_TOKEN_BUDGET = 30000;

/**
 * Compiles task context for a branch from Jolli Memory's orphan branch data.
 */
export async function compileTaskContext(options: ContextOptions, cwd?: string): Promise<CompiledContext> {
	const { branch, depth, includePlans = true, includeNotes = includePlans } = options;

	const index = await getIndex(cwd);
	if (!index) {
		return emptyContext(branch);
	}

	// Step 1: Filter root entries for this branch
	let rootEntries = index.entries.filter(
		(e) => e.branch === branch && (e.parentCommitHash === null || e.parentCommitHash === undefined),
	);

	// Step 2: Sort by commit date (oldest first for narrative)
	rootEntries = [...rootEntries].sort((a, b) => new Date(a.commitDate).getTime() - new Date(b.commitDate).getTime());

	// Step 3: Apply depth limit
	if (depth !== undefined && depth > 0 && rootEntries.length > depth) {
		rootEntries = rootEntries.slice(-depth);
	}

	if (rootEntries.length === 0) {
		return emptyContext(branch);
	}

	// Step 4: Load full summaries
	const summaries: CommitSummary[] = [];
	for (const entry of rootEntries) {
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

	// Step 6: Load and deduplicate plans
	const plans: { slug: string; title: string; content: string }[] = [];
	if (includePlans) {
		const planCandidates: PlanCandidate[] = [];
		for (const summary of summaries) {
			if (summary.plans) {
				for (const planRef of summary.plans) {
					planCandidates.push({
						slug: planRef.slug,
						title: planRef.title,
						commitHash: summary.commitHash,
						commitDate: summary.commitDate,
					});
				}
			}
		}

		const deduplicated = deduplicatePlans(planCandidates);
		for (const plan of deduplicated) {
			const content = await readPlanFromBranch(plan.slug, cwd);
			if (content) {
				plans.push({ slug: plan.slug, title: plan.title, content });
			} else {
				log.warn("Plan %s referenced but not found in orphan branch", plan.slug);
			}
		}
	}

	// Step 6b: Load and deduplicate notes
	const notes: { id: string; title: string; content: string }[] = [];
	if (includeNotes) {
		const seenIds = new Set<string>();
		for (const summary of summaries) {
			if (summary.notes) {
				for (const noteRef of summary.notes) {
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
	}

	// Step 7: Aggregate stats
	let totalFilesChanged = 0;
	let totalInsertions = 0;
	let totalDeletions = 0;
	for (const summary of summaries) {
		const stats = aggregateStats(summary);
		totalFilesChanged += stats.filesChanged;
		totalInsertions += stats.insertions;
		totalDeletions += stats.deletions;
	}

	const period = {
		start: summaries[0].commitDate,
		end: summaries[summaries.length - 1].commitDate,
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
	const stats = aggregateStats(summary);
	const prefix = index !== undefined ? `${index}. ` : "";

	lines.push(
		`### ${prefix}${summary.commitHash.substring(0, 8)} — ${summary.commitMessage} (${formatDate(summary.commitDate)})`,
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
