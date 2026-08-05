/**
 * PreviewUri
 *
 * Shared URI plumbing for the three read-only markdown preview schemes
 * (`jollimemory-plan`, `jollimemory-note`, `jollimemory-archived`). Every one of
 * them builds the same shape — a sanitized title as the path segment, an
 * identifying payload in the query — and each used to hand-roll both halves.
 *
 * Pure string functions on purpose: no `vscode` import, so the callers own
 * `Uri.from` and this module stays trivially testable.
 */

/**
 * Makes `title` safe to use as a URI path segment (and therefore as the preview
 * tab's name).
 *
 * `#` in particular would be parsed as a URI fragment and silently truncate the
 * name; `/` and `:` would fabricate path segments. The 80-character cap keeps a
 * long Jira/Notion title from becoming an unreadable tab.
 */
export function sanitizeTitleForUriPath(title: string): string {
	return title.replace(/[/\\:*?"<>|#%&{}]/g, "-").substring(0, 80);
}

/** The identifying payload carried in a preview URI's query. */
export type PreviewRef = Readonly<Record<string, string | undefined>>;

/**
 * Encodes `ref` into a preview URI query string (`ref=<base64url of JSON>`).
 *
 * Base64url rather than percent-encoded params, because the query has to survive
 * a decode it does not control: VS Code percent-decodes the query when it
 * reconstructs a `Uri` from its string form — which is exactly what happens when
 * a preview tab is restored after a window reload. A value containing `&` or `=`
 * (an archived reference key is built from a source-supplied native id) would
 * decode back into real separators there and split one param into two. The
 * base64url alphabet is `A-Za-z0-9-_`, which neither percent-encoding nor
 * form-urlencoded space handling touches, so the round trip is lossless.
 *
 * Keys are sorted so the same ref always produces the same string — the query
 * doubles as the body-cache key, and two spellings would mean two cache entries.
 * `undefined` values are dropped rather than serialized.
 */
export function encodePreviewRef(ref: PreviewRef): string {
	const entries = Object.entries(ref)
		.filter((e): e is [string, string] => e[1] !== undefined)
		// No equality arm: object keys are unique, so two entries can never tie.
		// Not `localeCompare` — that reads the ambient locale, and the query it
		// orders doubles as a cache key that must not vary by machine.
		.sort((a, b) => (a[0] < b[0] ? -1 : 1));
	const payload = JSON.stringify(Object.fromEntries(entries));
	return `ref=${Buffer.from(payload, "utf8").toString("base64url")}`;
}

/**
 * Decodes a query string produced by {@link encodePreviewRef}.
 *
 * Returns `undefined` — never throws — for a missing, truncated or hand-typed
 * `ref`, because the only caller is a `TextDocumentContentProvider` and a throw
 * there surfaces as a broken tab rather than a message.
 */
export function decodePreviewRef(query: string): Record<string, string> | undefined {
	const raw = new URLSearchParams(query).get("ref");
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(raw, "base64url").toString("utf8"),
		);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as Record<string, string>;
	} catch {
		return undefined;
	}
}
