/**
 * SummaryFormat — Shared formatting utilities for summary display.
 *
 * Contains date formatting, topic sorting, title builders, and the
 * collectSortedTopics helper used by both the CLI markdown exporter and the
 * VS Code webview. This file has zero VS Code dependencies.
 */

import type { CommitSummary, LlmCredentialSource, NoteReference, PlanReference } from "../Types.js";
import { collectDisplayTopics, collectSourceNodes, type TopicWithDate } from "./SummaryTree.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Topic annotated with its source node's date. Re-exported from SummaryTree so
 * VSCode webview / IntelliJ-equivalent consumers can import it from this
 * formatting module without reaching into the tree-utility layer.
 */
export type { TopicWithDate };

// ─── Date formatting ──────────────────────────────────────────────────────────

/**
 * Returns the canonical "activity date" for a summary / index entry.
 *
 * Prefers `generatedAt` (set at each git-related summary (re)generation — commit,
 * amend, squash, rebase) over `commitDate` (git author-date, unchanged by amend).
 * This matches the user-visible activity timeline: when they actually did
 * something for this memory, not when the commit was first authored.
 *
 * Falls back to `commitDate` when `generatedAt` is missing or empty
 * (uses `||`, not `??`) — e.g. for loose plan-reference or catalog objects
 * that historically only carried `commitDate`, or for corrupt data where
 * `generatedAt` is persisted as an empty string.
 */
export function getDisplayDate(entry: { generatedAt?: string; commitDate: string }): string {
	return entry.generatedAt || entry.commitDate;
}

/** Returns a short date string, e.g. "Apr 5, 2026". */
export function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
		/* v8 ignore start -- Date constructor + toLocaleDateString do not throw; they return "Invalid Date" */
	} catch {
		return iso;
	}
	/* v8 ignore stop */
}

/** Returns a full human-readable date+time string, e.g. "February 27, 2026 at 7:49 PM". */
export function formatFullDate(iso: string): string {
	try {
		return new Date(iso).toLocaleString("en-US", {
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
		/* v8 ignore start -- Date constructor + toLocaleString do not throw; they return "Invalid Date" */
	} catch {
		return iso;
	}
	/* v8 ignore stop */
}

/** Extracts the date portion (YYYY-MM-DD) from an ISO string for day-level comparison. */
function dayOnly(iso: string): string {
	return iso.substring(0, 10);
}

// ─── Topic sorting ────────────────────────────────────────────────────────────

/**
 * Sorts topics by source date at day granularity (newest first), then by
 * importance (major before minor).
 *
 * Source date is `generatedAt || commitDate`. Under v4 unified Hoist all topics
 * on a squash/amend root share the root's date, so day-key falls equal and the
 * sort collapses to importance order — which is what we want for the flat
 * presentation model. v3 legacy data with cross-day topics still gets a
 * meaningful day ordering.
 */
export function sortTopics(topics: Array<TopicWithDate>): Array<TopicWithDate> {
	return [...topics].sort((a, b) => {
		// dayOnly("") returns "" — no need for a separate ternary guard around
		// the empty-date case. `||` falls through generatedAt → commitDate → "".
		const dayA = dayOnly(a.generatedAt || a.commitDate || "");
		const dayB = dayOnly(b.generatedAt || b.commitDate || "");
		if (dayA !== dayB) {
			return dayA > dayB ? -1 : 1;
		}
		/* v8 ignore start -- both branches tested but v8 undercounts nested ternary in sort callback */
		const impA = a.importance === "minor" ? 1 : 0;
		const impB = b.importance === "minor" ? 1 : 0;
		return impA - impB;
		/* v8 ignore stop */
	});
}

/** Pads a number to 2 digits (e.g. 1 → "01", 12 → "12"). */
export function padIndex(i: number): string {
	return String(i + 1).padStart(2, "0");
}

// ─── LLM provider attribution ─────────────────────────────────────────────────

/**
 * Human-readable labels for each LLM credential source. Compact-style chosen
 * over the more explicit `doctor` labels ("Anthropic API key (config)") because
 * the footer is a one-line attribution — the distinction between config-key and
 * env-key is preserved via "(env)" suffix without paying a lot of horizontal
 * space. Swap to a more verbose form here if you want it surfaced differently;
 * `formatProviderLabel` and the footer renderers downstream don't care.
 */
const PROVIDER_LABELS: Record<LlmCredentialSource, string> = {
	"anthropic-config": "Anthropic",
	"anthropic-env": "Anthropic (env)",
	"jolli-proxy": "Jolli proxy",
};

/**
 * Walks the v3 CommitSummary tree and collects every distinct
 * `LlmCallMetadata.source` it finds. Used to derive the provider attribution
 * in summary footers — squash / merge containers don't have their own LLM
 * call (their `.llm` is absent) so we MUST recurse into `children` to surface
 * the providers that actually produced the consolidated content.
 *
 * Returns sources in first-seen order across the depth-first walk.
 */
export function collectLlmSources(summary: CommitSummary): ReadonlyArray<LlmCredentialSource> {
	const seen = new Set<LlmCredentialSource>();
	const visit = (node: CommitSummary): void => {
		if (node.llm?.source) seen.add(node.llm.source);
		for (const child of node.children ?? []) visit(child);
	};
	visit(summary);
	return [...seen];
}

/**
 * Footer-ready provider attribution string. Returns:
 *   - `undefined` when no node in the tree carries a `source` field — i.e.
 *     the summary was generated before this field existed; callers should
 *     omit the provider segment of the footer entirely instead of printing
 *     "via unknown".
 *   - A single label (e.g. `"Anthropic"`) for the common single-source case.
 *   - `"mixed: A, B"` for cross-provider summaries (a squash whose source
 *     commits were summarized on different machines / configs).
 */
export function formatProviderLabel(summary: CommitSummary): string | undefined {
	const sources = collectLlmSources(summary);
	if (sources.length === 0) return undefined;
	if (sources.length === 1) return PROVIDER_LABELS[sources[0]];
	return `mixed: ${sources.map((s) => PROVIDER_LABELS[s]).join(", ")}`;
}

// ─── Title builders ───────────────────────────────────────────────────────────

/** Regex fallback: extracts ticket from commit message or branch (for old summaries without ticketId). */
function extractTicketFallback(commitMessage: string, branch: string): string | undefined {
	const pattern = /[A-Z][A-Z0-9]+-\d+/;
	const fromMessage = commitMessage.match(pattern);
	if (fromMessage) {
		return fromMessage[0];
	}
	const fromBranch = branch.match(/[A-Za-z][A-Za-z0-9]+-\d+/i);
	if (fromBranch) {
		return fromBranch[0].toUpperCase();
	}
	return;
}

/** Builds panel title: date · ticket · hash · author */
export function buildPanelTitle(summary: CommitSummary): string {
	const ticket = summary.ticketId ?? extractTicketFallback(summary.commitMessage, summary.branch);
	const date = getDisplayDate(summary).substring(0, 10);
	const author = summary.commitAuthor;
	const hash = summary.commitHash.substring(0, 7);
	return [date, ticket, hash, author].filter(Boolean).join(" · ");
}

/**
 * Replaces characters forbidden in Jolli Space document titles with a space,
 * then collapses multiple spaces. Based on filesystem restrictions: / \ : * ? " < > |
 */
function sanitizeTitle(title: string): string {
	return title
		.replace(/[/\\:*?"<>|]/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/** Builds the memory document title for pushing to Jolli Space. */
export function buildPushTitle(summary: CommitSummary): string {
	return sanitizeTitle(summary.commitMessage);
}

/** Builds the plan document title for pushing to Jolli Space. */
export function buildPlanPushTitle(_summary: CommitSummary, planTitle: string): string {
	return sanitizeTitle(planTitle);
}

/** Builds the note document title for pushing to Jolli Space. */
export function buildNotePushTitle(_summary: CommitSummary, noteTitle: string): string {
	return sanitizeTitle(noteTitle);
}

// ─── Topic collection ─────────────────────────────────────────────────────────

/**
 * Collects all topics from a summary tree and returns them sorted (newest
 * first, major before minor) with a stable `treeIndex` per topic for edit /
 * delete operations.
 *
 * Returns `sourceNodes` for callers that render the "Source Commits" section.
 *
 * **Flat presentation model**: under v4 unified Hoist all topics on a squash
 * or amend root share the root's date, so the previous "timeline grouping by
 * day" feature degenerated into a single useless group. The grouping path was
 * removed; topics now render as one flat list. Per-source date attribution
 * still surfaces via the Source Commits section.
 */
export function collectSortedTopics(summary: CommitSummary): {
	topics: Array<TopicWithDate>;
	sourceNodes: ReadonlyArray<CommitSummary>;
} {
	const sourceNodes = collectSourceNodes(summary);
	const collected = collectDisplayTopics(summary);
	const topics = sortTopics(collected.map((t, i) => ({ ...t, treeIndex: i })));
	return { topics, sourceNodes };
}

/**
 * Recursively collects all plan references from a summary tree.
 * Deduplicates by slug, keeping the most recently updated version.
 */
export function collectAllPlans(summary: CommitSummary): ReadonlyArray<PlanReference> {
	const planMap = new Map<string, PlanReference>();

	function walk(node: CommitSummary): void {
		if (node.plans) {
			for (const plan of node.plans) {
				const key = plan.slug;
				const existing = planMap.get(key);
				if (!existing || plan.updatedAt > existing.updatedAt) {
					planMap.set(key, plan);
				}
			}
		}
		if (node.children) {
			for (const child of node.children) {
				walk(child);
			}
		}
	}

	walk(summary);
	return [...planMap.values()];
}

/**
 * Recursively collects all note references from a summary tree.
 * Deduplicates by id, keeping the most recently updated version.
 */
export function collectAllNotes(summary: CommitSummary): ReadonlyArray<NoteReference> {
	const noteMap = new Map<string, NoteReference>();

	function walk(node: CommitSummary): void {
		if (node.notes) {
			for (const note of node.notes) {
				const existing = noteMap.get(note.id);
				if (!existing || note.updatedAt > existing.updatedAt) {
					noteMap.set(note.id, note);
				}
			}
		}
		if (node.children) {
			for (const child of node.children) {
				walk(child);
			}
		}
	}

	walk(summary);
	return [...noteMap.values()];
}

/**
 * Like {@link collectAllPlans} but also reports the host commit hash for each
 * plan reference — the commit (root or nested child) where the reference was
 * declared. Required for base-slug normalization, which strips a trailing
 * `-<hostHash>` suffix introduced when a plan was archived at that commit.
 *
 * Same dedup contract as {@link collectAllPlans} (latest `updatedAt` wins per
 * slug), with the winner's `hostCommitHash` reported alongside.
 */
export function collectAllPlansWithHosts(
	summary: CommitSummary,
): ReadonlyArray<{ readonly planRef: PlanReference; readonly hostCommitHash: string }> {
	const map = new Map<string, { planRef: PlanReference; hostCommitHash: string }>();

	function walk(node: CommitSummary): void {
		if (node.plans) {
			for (const plan of node.plans) {
				const existing = map.get(plan.slug);
				if (!existing || plan.updatedAt > existing.planRef.updatedAt) {
					map.set(plan.slug, { planRef: plan, hostCommitHash: node.commitHash });
				}
			}
		}
		if (node.children) {
			for (const child of node.children) {
				walk(child);
			}
		}
	}

	walk(summary);
	return [...map.values()];
}

/**
 * Like {@link collectAllNotes} but also reports the host commit hash for each
 * note reference. Notes have no archive-suffix mechanism today, but the API
 * is symmetric to {@link collectAllPlansWithHosts} so future archive-style
 * normalization (or per-host attribution) can plug in without churn.
 */
export function collectAllNotesWithHosts(
	summary: CommitSummary,
): ReadonlyArray<{ readonly noteRef: NoteReference; readonly hostCommitHash: string }> {
	const map = new Map<string, { noteRef: NoteReference; hostCommitHash: string }>();

	function walk(node: CommitSummary): void {
		if (node.notes) {
			for (const note of node.notes) {
				const existing = map.get(note.id);
				if (!existing || note.updatedAt > existing.noteRef.updatedAt) {
					map.set(note.id, { noteRef: note, hostCommitHash: node.commitHash });
				}
			}
		}
		if (node.children) {
			for (const child of node.children) {
				walk(child);
			}
		}
	}

	walk(summary);
	return [...map.values()];
}
