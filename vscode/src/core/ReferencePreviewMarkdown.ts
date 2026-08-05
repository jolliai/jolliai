/**
 * ReferencePreviewMarkdown
 *
 * Makes an archived reference snapshot readable as a *rendered* markdown preview.
 *
 * The snapshots on the orphan branch put their identity in YAML frontmatter —
 * `source`, `nativeId`, `title`, `url`, `fields`, `referencedAt`, `sourceToolName`
 * (see `ReferenceStore.renderMarkdown`). That was fine while these opened as raw
 * text. It is not fine in a rendered preview: VS Code's built-in markdown preview
 * mounts `markdown-it-front-matter` with an empty renderer, so every one of those
 * fields is invisible.
 *
 * The sharpest case is a bookmark-shaped reference — a Slack thread with no
 * permalink, a context7 lookup that records only the query. Its body says "only the
 * query and the link are recorded here" while the link itself sits in the
 * frontmatter, so the rendered page talks about a link the reader cannot see.
 *
 * So: replace the frontmatter block with a small visible header, and leave the body
 * byte-for-byte alone.
 *
 * **Why not rebuild the body from the parsed `Reference`.** `parseMarkdown` runs
 * `stripReferenceNote` before returning, which deletes precisely the "this is a
 * bookmark, not a full copy" paragraph that explains the missing content. The parser
 * is used here for its field extraction only; the body is sliced off the original
 * text.
 */

import { readReferenceMarkdownFromString } from "../../../cli/src/core/references/ReferenceStore.js";

/** Index just past the closing `---` of a frontmatter block, or -1 if there is none. */
function bodyStart(markdown: string): number {
	if (!markdown.startsWith("---\n")) return -1;
	const close = markdown.indexOf("\n---\n", 3);
	return close === -1 ? -1 : close + "\n---\n".length;
}

/**
 * Rewrites an archived reference snapshot for rendered display.
 *
 * Returns `markdown` unchanged when it carries no frontmatter, or when the
 * frontmatter does not parse as a reference — losing the body would be a far worse
 * outcome than showing it with its header still hidden.
 */
export function renderReferenceForPreview(markdown: string): string {
	const start = bodyStart(markdown);
	if (start === -1) return markdown;
	const ref = readReferenceMarkdownFromString(markdown);
	if (!ref) return markdown;

	const header = [`# ${ref.title}`, ""];
	// Rendered as an explicit `[url](url)` rather than a bare autolink so it stays a
	// visible, clickable line even for sources whose url is long and unlovely.
	if (ref.url !== undefined && ref.url.length > 0) {
		header.push(`[${ref.url}](${ref.url})`, "");
	}
	// `referencedAt` verbatim, not `toLocaleString()`: the ISO timestamp is
	// unambiguous and, unlike a locale-formatted one, does not change shape with the
	// machine's language settings.
	header.push(`\`${ref.source}\` · captured ${ref.referencedAt}`, "");

	return header.join("\n") + markdown.slice(start).replace(/^\n+/, "");
}
