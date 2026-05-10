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
import type {
	CommitSummary,
	LlmCredentialSource,
} from "../../../cli/src/Types.js";
import { sanitizeBranchSlug } from "../util/GitRemoteUtils.js";

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
export function collectLlmSources(
	summary: CommitSummary,
): ReadonlyArray<LlmCredentialSource> {
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
export function formatProviderLabel(
	summary: CommitSummary,
): string | undefined {
	const sources = collectLlmSources(summary);
	if (sources.length === 0) return undefined;
	if (sources.length === 1) return PROVIDER_LABELS[sources[0]];
	return `mixed: ${sources.map((s) => PROVIDER_LABELS[s]).join(", ")}`;
}

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
