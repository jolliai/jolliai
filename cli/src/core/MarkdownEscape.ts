/**
 * Markdown / HTML escaping helpers shared by the clipboard, webview, and PR
 * markdown builders. `escHtml` guards GitHub-flavored HTML tags; the `escMd*`
 * pair guards untrusted external-reference titles/URLs from breaking out of a
 * markdown link.
 */

export function escHtml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Escapes text for safe use as Markdown link text `[…]`. Untrusted reference
 * titles come from external trackers (Jira/Linear/GitHub/Notion), so a title
 * like `x](http://evil)` must not break out of the link and inject a phishing
 * link. Backslash-escapes `\ [ ]` and folds newlines so the line stays intact.
 */
export function escMdLinkText(str: string): string {
	return str.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

/**
 * Escapes text for safe use INSIDE a `~~…~~` strikethrough span: everything
 * escMdLinkText covers PLUS `~`, so a literal `~~` in the text cannot close
 * the span early. One single-pass character class with the backslash included
 * — escaping `\` in the same pass as the characters we prefix with it is what
 * keeps a pre-existing backslash from combining with an added `\~` into an
 * ambiguous sequence. Kept separate from escMdLinkText on purpose: adding `~`
 * there would change the output bytes of every existing consumer (PR bodies
 * must stay byte-identical).
 */
export function escMdStrikeText(str: string): string {
	return str.replace(/[\\[\]~]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

/**
 * Escapes an untrusted URL for safe use inside a Markdown link target `(…)`.
 * Percent-encodes the structure-breaking characters (parens, whitespace,
 * angle brackets, quote) so a crafted URL cannot close the link early or be
 * reinterpreted as a link title. Scheme is already whitelisted upstream
 * (`^https?://` in the adapters), so this only guards the link structure.
 */
export function escMdUrl(str: string): string {
	return str.replace(/[()\s<>"]/g, (c) => {
		if (c === "(") return "%28";
		if (c === ")") return "%29";
		return encodeURIComponent(c);
	});
}
