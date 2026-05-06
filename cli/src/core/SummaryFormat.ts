/**
 * SummaryFormat — Shared formatting utilities for summary display.
 *
 * Contains date formatting, topic sorting, title builders, and the
 * collectSortedTopics helper used by both the CLI markdown exporter and the
 * VS Code webview. This file has zero VS Code dependencies.
 */

import type { CommitSummary, PlanReference } from "../Types.js";
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
