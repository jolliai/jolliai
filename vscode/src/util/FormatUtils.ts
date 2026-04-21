/**
 * Shared formatting utilities for tree view labels, descriptions, and tooltips.
 * Used by HistoryTreeProvider, PlansTreeProvider, and other UI components.
 */

/**
 * Formats an ISO 8601 date as a relative + absolute string, matching the
 * VSCode GRAPH panel date format: "22 hours ago (February 25, 2026 at 4:57 PM)"
 */
export function formatRelativeDate(iso: string): string {
	try {
		const date = new Date(iso);
		const diffMs = Date.now() - date.getTime();
		const diffMins = Math.floor(diffMs / 60_000);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);
		const diffMonths = Math.floor(diffDays / 30);
		const diffYears = Math.floor(diffDays / 365);

		let relative: string;
		if (diffMins < 1) {
			relative = "just now";
		} else if (diffMins < 60) {
			relative = `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
		} else if (diffHours < 24) {
			relative = `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
		} else if (diffDays < 30) {
			relative = `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
		} else if (diffMonths < 12) {
			relative = `${diffMonths} month${diffMonths !== 1 ? "s" : ""} ago`;
		} else {
			relative = `${diffYears} year${diffYears !== 1 ? "s" : ""} ago`;
		}

		// Absolute part: "February 25, 2026 at 4:57 PM"
		const absolute = date.toLocaleString(undefined, {
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});

		return `${relative} (${absolute})`;
	} catch {
		return iso.substring(0, 10);
	}
}

/**
 * Formats an ISO 8601 date as a short relative string for tree item descriptions.
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "1mo ago", "2y ago"
 */
export function formatShortRelativeDate(iso: string): string {
	try {
		const date = new Date(iso);
		const diffMs = Date.now() - date.getTime();
		const diffMins = Math.floor(diffMs / 60_000);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);
		const diffMonths = Math.floor(diffDays / 30);
		const diffYears = Math.floor(diffDays / 365);

		if (diffMins < 1) {
			return "just now";
		}
		if (diffMins < 60) {
			return `${diffMins}m ago`;
		}
		if (diffHours < 24) {
			return `${diffHours}h ago`;
		}
		if (diffDays < 30) {
			return `${diffDays}d ago`;
		}
		if (diffMonths < 12) {
			return `${diffMonths}mo ago`;
		}
		return `${diffYears}y ago`;
	} catch {
		return iso.substring(0, 10);
	}
}

/**
 * Escapes Markdown special characters in a plain-text string for safe
 * embedding inside a MarkdownString (e.g. in bold/italic/link contexts).
 */
export function escMd(str: string): string {
	return str.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
