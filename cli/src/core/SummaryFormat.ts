/**
 * SummaryFormat — Shared formatting utilities for summary display.
 *
 * Contains date formatting, topic sorting/grouping, title builders, and the
 * collectSortedTopics helper used by both the CLI markdown exporter and the
 * VS Code webview. This file has zero VS Code dependencies.
 */

import type { CommitSummary, PlanReference } from "../Types.js";
import {
	type TopicWithDate as CoreTopicWithDate,
	collectAllTopics,
	collectSourceNodes,
	computeDurationDays,
} from "./SummaryTree.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A topic annotated with its parent record's date (for multi-record display).
 * Extends the core TopicWithDate (which has commitDate) with an additional
 * recordDate field used in timeline display.
 */
export interface TopicWithDate extends CoreTopicWithDate {
	readonly recordDate?: string;
}

// ─── Date formatting ──────────────────────────────────────────────────────────

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

// ─── Topic sorting / grouping ─────────────────────────────────────────────────

/** Sorts topics by record date at day granularity (newest first), then by importance (major before minor). */
export function sortTopics(topics: Array<TopicWithDate>): Array<TopicWithDate> {
	return [...topics].sort((a, b) => {
		const dayA = a.recordDate ? dayOnly(a.recordDate) : "";
		const dayB = b.recordDate ? dayOnly(b.recordDate) : "";
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

/** Groups topics by date (YYYY-MM-DD). Preserves the sort order within each group. */
export function groupTopicsByDate(topics: Array<TopicWithDate>): Map<string, Array<TopicWithDate>> {
	const groups = new Map<string, Array<TopicWithDate>>();
	for (const t of topics) {
		const key = t.recordDate ? dayOnly(t.recordDate) : "unknown";
		const list = groups.get(key);
		if (list) {
			list.push(t);
		} else {
			groups.set(key, [t]);
		}
	}
	return groups;
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
	const date = summary.commitDate.substring(0, 10);
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
	const base = buildPanelTitle(summary);
	return sanitizeTitle(`${base} · ${summary.commitMessage}`);
}

/** Builds the plan document title for pushing to Jolli Space. */
export function buildPlanPushTitle(summary: CommitSummary, planTitle: string): string {
	const base = buildPanelTitle(summary);
	return sanitizeTitle(`${base} · ${planTitle}`);
}

/** Builds the note document title for pushing to Jolli Space. */
export function buildNotePushTitle(summary: CommitSummary, noteTitle: string): string {
	const base = buildPanelTitle(summary);
	return sanitizeTitle(`${base} · ${noteTitle}`);
}

// ─── Topic collection ─────────────────────────────────────────────────────────

/**
 * Collects all topics from a summary tree, enriches multi-day squash topics
 * with a `recordDate`, and returns them sorted (newest first, major before minor).
 *
 * Also returns `showRecordDates` so callers know whether to render timeline groups.
 */
export function collectSortedTopics(summary: CommitSummary): {
	topics: Array<TopicWithDate>;
	sourceNodes: ReadonlyArray<CommitSummary>;
	showRecordDates: boolean;
} {
	const sourceNodes = collectSourceNodes(summary);
	const showRecordDates = sourceNodes.length > 1 && computeDurationDays(summary) > 1;
	const collected = collectAllTopics(summary);
	const topics = sortTopics(
		collected.map((t, i) => ({
			...t,
			treeIndex: i,
			...(showRecordDates && t.commitDate ? { recordDate: t.commitDate } : {}),
		})),
	);
	return { topics, sourceNodes, showRecordDates };
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
