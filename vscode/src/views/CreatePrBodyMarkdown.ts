/**
 * CreatePrBodyMarkdown
 *
 * Server-side (TypeScript) renderer that turns the PR body markdown produced by
 * `buildPrBodyMarkdown` into formatted HTML for the Create PR pane, so the body
 * reads like the rendered memory detail view instead of raw monospace text.
 *
 * The PR body is GitHub-flavored markdown that mixes markdown syntax
 * (`## heading`, `**bold**`, `- list`, `` `code` ``, `> quote`, `---`) with a
 * small set of structural HTML tags used for folding topics
 * (`<details>` / `<summary>` / `<blockquote>` / `<br>`). We render it safely by:
 *
 *   1. Passing through ONLY whole-line, whitelisted structural tags verbatim so
 *      `<details>` folds and `<blockquote>` quotes render natively.
 *   2. HTML-escaping every other line (via {@link escHtml}) BEFORE applying
 *      markdown, so any stray angle bracket in prose becomes literal text and
 *      can never inject markup. Combined with the pane's strict CSP (no inline
 *      handlers), this is defense-in-depth against injection from an
 *      LLM-generated / hand-edited summary.
 *
 * This is deliberately distinct from SummaryScriptBuilder's webview-side
 * `renderMarkdown`, which escapes ALL HTML (its content never contains folding
 * tags). Keep the two independent — they have different escaping contracts.
 */

import { escHtml } from "./SummaryUtils.js";

/** Whole-line structural tags emitted by buildPrMarkdown — passed through as-is. */
const PASSTHROUGH_LINE = /^(<details>|<\/details>|<br\s*\/?>|<blockquote>|<\/blockquote>)$/;
/**
 * A single-line `<summary><strong>…</strong></summary>` row — the exact shape
 * `wrapInGithubDetails` callers produce (see SummaryPrMarkdownBuilder.ts). Anchored
 * to that shape, not just the outer tags, so that if the embedded title ever isn't
 * pre-escaped upstream, the stray `<`/`>` it carries makes the line fail to match
 * here and fall through to the paragraph branch, which HTML-escapes it — fail
 * closed rather than emitting untrusted markup verbatim.
 */
const SUMMARY_LINE = /^<summary><strong>[^<>]*<\/strong><\/summary>$/;

/**
 * Reverses cli's `escapeGithubWrapperTags` encoding of the `<details>` /
 * `<blockquote>` tag names (see SummaryPrMarkdownBuilder.ts) before this
 * renderer's own {@link escHtml} re-escapes the line. That function neutralizes
 * a literal `<details>`/`<blockquote>` typed in body prose into the entity text
 * `&lt;details&gt;` so GitHub's markdown renderer shows it inertly. Without this
 * undo step, `escHtml` here would escape the leftover `&` a second time —
 * `&lt;details&gt;` becomes `&amp;lt;details&amp;gt;`, which the browser then
 * displays as the literal text "&lt;details&gt;" instead of "<details>",
 * diverging from what GitHub shows for the identical markdown. Limited to
 * exactly the two tag names `escapeGithubWrapperTags` touches, so it can't be
 * used to smuggle other markup back in.
 */
const GH_WRAPPER_ENTITY = /&lt;(\/?)(details|blockquote)((?:\s[^&]*)?)&gt;/gi;
function undoGithubWrapperEntities(text: string): string {
	return text.replace(GH_WRAPPER_ENTITY, "<$1$2$3>");
}

// Delimits inline-protection placeholder tokens (see applyInline below). U+E000 is
// in the Unicode Private Use Area — never produced by escHtml or real PR body text,
// so it can't collide with content. Built via fromCharCode rather than embedded as
// a literal character so the source stays a plain, diffable ASCII file; a `\x00`
// control character was rejected here too, by biome's noControlCharactersInRegex.
const PLACEHOLDER_DELIM = String.fromCharCode(0xe000);

/**
 * Applies inline markdown to an already-HTML-escaped string.
 *
 * Order matters: inline code first, then links, then bold, then italic. `_`-based
 * emphasis is intentionally unsupported because underscores are common in file
 * paths, identifiers, and URLs that appear throughout PR bodies.
 *
 * Code and link matches are swapped for opaque placeholder tokens rather than
 * spliced in directly — otherwise the later bold/italic passes run over the
 * whole string and reprocess `*`/`_` characters that happen to land inside the
 * HTML just inserted for an earlier match (e.g. `` `**not bold**` `` would have
 * its code-span content re-bolded). The tokens are restored after all passes run.
 */
function applyInline(escaped: string): string {
	const placeholders: string[] = [];
	const protect = (html: string): string => {
		const token = `${PLACEHOLDER_DELIM}${placeholders.length}${PLACEHOLDER_DELIM}`;
		placeholders.push(html);
		return token;
	};
	const withPlaceholders = escaped
		.replace(/`([^`]+)`/g, (_m, code: string) => protect(`<code class="md-inline-code">${code}</code>`))
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, text: string, url: string) =>
			protect(`<a class="md-link" href="${url}">${text}</a>`),
		)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
	if (placeholders.length === 0) return withPlaceholders;
	const restore = new RegExp(`${PLACEHOLDER_DELIM}(\\d+)${PLACEHOLDER_DELIM}`, "g");
	return withPlaceholders.replace(restore, (_m, i: string) => placeholders[Number(i)]);
}

/**
 * Renders PR body markdown to formatted HTML.
 *
 * @param raw - The PR body markdown (without idempotent markers).
 * @returns HTML string safe to inject into the pane's `.md-body` container, or
 *   an empty string when the body is blank.
 */
export function renderPrBodyMarkdown(raw: string): string {
	if (!raw || !raw.trim()) return "";
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let listType: "ul" | "ol" | null = null;
	let inCode = false;
	let codeLines: string[] = [];

	const closeList = (): void => {
		if (listType) {
			out.push(listType === "ul" ? "</ul>" : "</ol>");
			listType = null;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Fenced code block: toggle, buffering the raw lines between the fences.
		if (/^```/.test(trimmed)) {
			if (inCode) {
				out.push(`<pre class="md-code-block"><code>${escHtml(codeLines.join("\n"))}</code></pre>`);
				codeLines = [];
				inCode = false;
			} else {
				closeList();
				inCode = true;
			}
			continue;
		}
		if (inCode) {
			codeLines.push(line);
			continue;
		}

		// Whitelisted structural HTML — emit verbatim so folding renders natively.
		if (PASSTHROUGH_LINE.test(trimmed) || SUMMARY_LINE.test(trimmed)) {
			closeList();
			out.push(trimmed);
			continue;
		}

		// ATX heading (# … ######). Level is offset +1 so top-level "##" section
		// titles render as modest labels rather than oversized headings.
		const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			closeList();
			const level = Math.min(heading[1].length + 1, 6);
			out.push(
				`<h${level} class="md-heading">${applyInline(escHtml(undoGithubWrapperEntities(heading[2])))}</h${level}>`,
			);
			continue;
		}

		// Horizontal rule.
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			closeList();
			out.push('<hr class="md-hr" />');
			continue;
		}

		// Markdown blockquote (`>`), distinct from the passthrough `<blockquote>`
		// HTML tag. Consecutive quote lines merge into one block.
		const quote = trimmed.match(/^>\s?(.*)$/);
		if (quote) {
			closeList();
			const parts = [applyInline(escHtml(undoGithubWrapperEntities(quote[1])))];
			while (i + 1 < lines.length) {
				const next = lines[i + 1].trim().match(/^>\s?(.*)$/);
				if (!next) break;
				parts.push(applyInline(escHtml(undoGithubWrapperEntities(next[1]))));
				i++;
			}
			out.push(`<blockquote class="md-quote">${parts.join("<br />")}</blockquote>`);
			continue;
		}

		// List item — unordered (`-`/`*`) or ordered (`1.`). Switching marker type
		// (e.g. a `-` list followed by a `1.` list) closes the open list and opens
		// a new one, matching GFM's own list-type-boundary behavior.
		const unorderedItem = trimmed.match(/^[-*]\s+(.+)$/);
		const orderedItem = unorderedItem ? null : trimmed.match(/^\d+[.)]\s+(.+)$/);
		const item = unorderedItem ?? orderedItem;
		if (item) {
			const type = unorderedItem ? "ul" : "ol";
			if (listType !== type) {
				closeList();
				out.push(type === "ul" ? '<ul class="md-list">' : '<ol class="md-list">');
				listType = type;
			}
			out.push(`<li>${applyInline(escHtml(undoGithubWrapperEntities(item[1])))}</li>`);
			continue;
		}

		closeList();

		// Blank line → vertical gap.
		if (trimmed === "") {
			out.push('<div class="md-blank"></div>');
			continue;
		}

		// Regular paragraph line.
		out.push(`<div class="md-line">${applyInline(escHtml(undoGithubWrapperEntities(trimmed)))}</div>`);
	}

	closeList();
	// An unterminated fenced block still flushes what was buffered.
	if (inCode) {
		out.push(`<pre class="md-code-block"><code>${escHtml(codeLines.join("\n"))}</code></pre>`);
	}
	return out.join("");
}
