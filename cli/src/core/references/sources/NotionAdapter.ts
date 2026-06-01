/**
 * NotionAdapter — `SourceAdapter` for the Notion MCP server (notion-fetch only).
 *
 * Scope (Phase 5, deliberately narrow):
 *   - Only `mcp__claude_ai_Notion__notion-fetch` produces References. Other
 *     notion-* tools (`notion-search`, `notion-update-page`, `notion-create-*`,
 *     …) all return null even though the same MCP prefix matches the line.
 *     `notion-search` requires its own payload-shape investigation and is
 *     deferred to Phase 6.
 *   - Only `metadata.type === "page"` is accepted; database / data_source are
 *     silently rejected.
 *
 * URL validation:
 *   - HTTPS only.
 *   - Allowed hosts: `www.notion.so`, `notion.so`, `*.notion.site`.
 *   - 32-hex page id must appear in the URL path. Two forms are accepted:
 *       1. Plain  — `https://www.notion.so/<32hex>`
 *       2. Slug   — `https://www.notion.so/Page-Title-<32hex>`
 *     The regex matches a `/` or `-` boundary immediately before the 32 hex
 *     characters, followed by end-of-string / `?` / `#`.
 *
 * Persistence:
 *   - `mapKey` = `notion:<32hex>` (lowercased).
 *   - `nativeId` = 32-hex page id, lowercased — filesystem-safe and stable.
 *
 * Char budget: 30 KB per reference, 60 KB total — Notion pages are typically
 * larger than ticket descriptions, so the budget is widened over Linear/Jira/
 * GitHub's 4 KB/30 KB.
 *
 * Adapter modules MUST NOT share helpers across sources (per plan §Constraints).
 * `parseNotionEnvelope` lives in `./NotionEnvelope.ts` and is Notion-only.
 */

import type { Reference } from "../../../Types.js";
import { escapeForAttr, escapeForText } from "../../PromptXmlEscape.js";
import { parseNotionEnvelope } from "./NotionEnvelope.js";
import type { SourceAdapter } from "./SourceAdapter.js";

const MAX_CHARS = 30000;
const MAX_TOTAL = 60000;
// Two URL forms accepted:
//   1. Plain    — https://www.notion.so/36c4fc101d34805ab1fdfb3e69144580
//   2. Slugged  — https://www.notion.so/Page-Title-36c4fc101d34805ab1fdfb3e69144580
// 32hex is preceded by `/` or `-`, and followed by `/`, `?`, `#`, or end-of-
// string. The trailing `/` matters: a slugged URL can carry a subpath after the
// id (…/Page-<id>/comment-x). Global + lookahead (the boundary char is not
// consumed) so matchAll can yield every id segment; we take the LAST one, which
// is the deepest / actually-fetched page in a …/Parent-<id>/Child-<id> URL.
const PAGE_ID_RE = /[-/]([0-9a-fA-F]{32})(?=[/?#]|$)/g;
const ALLOWED_HOSTS = new Set(["www.notion.so", "notion.so"]);

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n…[truncated, ${s.length - max} more chars]`;
}

function isAllowedHost(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.protocol !== "https:") return false;
		if (ALLOWED_HOSTS.has(u.hostname)) return true;
		return u.hostname.endsWith(".notion.site");
	} catch {
		return false;
	}
}

export const NotionAdapter: SourceAdapter = {
	id: "notion",
	mcpPrefix: "mcp__claude_ai_Notion__",
	wrapperKeys: ["results", "items", "pages"],
	maxCharsPerReference: MAX_CHARS,

	extractRef(payload, toolName, referencedAt) {
		// Phase 5 scope: only notion-fetch. Other notion-* tools (search /
		// update-page / etc.) silently return null even when their MCP prefix
		// matches. notion-search is deferred to Phase 6 pending payload-shape
		// investigation.
		if (!toolName.endsWith("notion-fetch")) return null;

		if (!isObject(payload)) return null;
		const obj = payload as Record<string, unknown>;
		const metadata = obj.metadata;
		if (!isObject(metadata)) return null;
		const pageType = (metadata as { type?: unknown }).type;
		if (pageType !== "page") return null;

		const title = obj.title;
		const url = obj.url;
		if (typeof title !== "string" || title.length === 0) return null;
		if (typeof url !== "string" || !isAllowedHost(url)) return null;
		const matches = [...url.matchAll(PAGE_ID_RE)];
		if (matches.length === 0) return null;
		const pageId = matches[matches.length - 1][1].toLowerCase();

		const text = typeof obj.text === "string" ? obj.text : "";
		const envelope = parseNotionEnvelope(text);

		return {
			mapKey: `notion:${pageId}`,
			source: "notion",
			nativeId: pageId,
			title,
			url,
			// key "entity-type" matches GitHubAdapter's so the same "Type" concept
			// uses one persisted key across sources. (Notion never renders fields
			// into its prompt XML, so this key only affects frontmatter / tooltip.)
			fields: [{ key: "entity-type", label: "Type", value: "page", icon: "symbol-class" }],
			...(envelope.content.length > 0 ? { description: envelope.content } : {}),
			toolName,
			referencedAt,
		};
	},

	renderPromptBlock(refs, opts) {
		if (refs.length === 0) return "";
		const maxPer = opts?.maxCharsPerReference ?? MAX_CHARS;
		const maxTotal = opts?.maxTotalChars ?? MAX_TOTAL;
		const sorted = [...refs].sort((a, b) => a.referencedAt.localeCompare(b.referencedAt));
		const reversed = [...sorted].reverse();
		const selected: Reference[] = [];
		let total = 0;
		for (const r of reversed) {
			const rendered = renderOne(r, maxPer);
			if (total + rendered.length > maxTotal) break;
			selected.push(r);
			total += rendered.length;
		}
		if (selected.length === 0) return "";
		selected.reverse();
		return `<notion-pages>\n${selected.map((r) => renderOne(r, maxPer)).join("\n")}\n</notion-pages>`;
	},
};

function renderOne(ref: Reference, maxChars: number): string {
	const lines = [`<page id="${escapeForAttr(ref.nativeId)}">`];
	lines.push(`  <title>${escapeForText(ref.title)}</title>`);
	lines.push(`  <url>${escapeForText(ref.url)}</url>`);
	if (ref.description) {
		lines.push("  <content>");
		lines.push(escapeForText(truncate(ref.description, maxChars)));
		lines.push("  </content>");
	}
	lines.push("</page>");
	return lines.join("\n");
}
