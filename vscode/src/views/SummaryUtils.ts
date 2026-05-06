/**
 * SummaryUtils
 *
 * Shared utility functions and types used across the Summary webview modules
 * (HTML builder, Markdown builder, CSS/Script builders, and the panel class).
 *
 * Formatting, sorting, and topic collection utilities are re-exported from
 * the core jollimemory package. HTML-specific helpers remain local.
 */

// ─── Re-exports from core ─────────────────────────────────────────────────────

export {
	buildNotePushTitle,
	buildPanelTitle,
	buildPlanPushTitle,
	buildPushTitle,
	collectAllPlans,
	collectSortedTopics,
	formatDate,
	formatFullDate,
	getDisplayDate,
	padIndex,
	sortTopics,
	type TopicWithDate,
} from "../../../cli/src/core/SummaryFormat.js";

import { formatDate as coreFormatDate } from "../../../cli/src/core/SummaryFormat.js";
import { sanitizeBranchSlug } from "../util/GitRemoteUtils.js";

// ─── Push contract: relativePath construction (server plan §8) ───────────────

/**
 * Returns the `relativePath` for any push: `<branchSlug>`. Summary, plan, and
 * note docs all share this flat per-branch path; the server distinguishes them
 * via the body's `docType` field and writes it to `sourceMetadata.docType`.
 */
export function buildBranchRelativePath(branch: string | undefined): string {
	return sanitizeBranchSlug(branch);
}

// ─── HTML escaping ────────────────────────────────────────────────────────────

export function escHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Escapes a string for safe use inside an HTML attribute value (single- or double-quoted). */
export function escAttr(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// ─── Date helpers (UI-specific) ───────────────────────────────────────────────

/** Returns a relative time string like "3 hours ago", "Yesterday", "5 days ago". */
export function timeAgo(iso: string): string {
	try {
		const diffMs = Date.now() - new Date(iso).getTime();
		const diffMin = Math.floor(diffMs / 60_000);
		const diffHour = Math.floor(diffMin / 60);
		const diffDay = Math.floor(diffHour / 24);

		if (diffDay > 30) {
			return coreFormatDate(iso);
		}
		if (diffDay > 1) {
			return `${diffDay} days ago`;
		}
		if (diffDay === 1) {
			return "Yesterday";
		}
		if (diffHour > 1) {
			return `${diffHour} hours ago`;
		}
		if (diffHour === 1) {
			return "1 hour ago";
		}
		if (diffMin > 1) {
			return `${diffMin} minutes ago`;
		}
		if (diffMin === 1) {
			return "1 minute ago";
		}
		return "Just now";
	} catch {
		return iso;
	}
}

// ─── Text rendering ───────────────────────────────────────────────────────────

/** Converts Markdown `**bold**` to `<strong>` tags. Input must already be HTML-escaped. */
function inlineBold(html: string): string {
	return html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/**
 * Renders callout body text as HTML. Detects Markdown-style unordered list
 * lines (`- item`) and converts them to `<ul><li>` elements. Non-list lines
 * are rendered as escaped text with `<br>` separators. Inline `**bold**` is
 * converted to `<strong>`.
 */
export function renderCalloutText(raw: string): string {
	const lines = raw.split("\n");
	const parts: Array<string> = [];
	let listItems: Array<string> = [];

	function flushList(): void {
		if (listItems.length > 0) {
			parts.push(
				`<ul>${listItems.map((li) => `<li>${li}</li>`).join("")}</ul>`,
			);
			listItems = [];
		}
	}

	for (const line of lines) {
		const listMatch = line.match(/^[-*]\s+(.*)/);
		if (listMatch) {
			listItems.push(inlineBold(escHtml(listMatch[1])));
		} else {
			flushList();
			const trimmed = line.trim();
			if (trimmed.length > 0) {
				parts.push(inlineBold(escHtml(trimmed)));
			}
		}
	}
	flushList();

	return parts.join("<br>");
}
