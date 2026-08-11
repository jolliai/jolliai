/**
 * FigmaLink — parse Figma file links and harvest them from a transcript's role:user
 * text blocks. Structurally the twin of `SlackPermalink`, but with a much narrower
 * job: it supplies the file's human NAME only.
 *
 * The url does NOT depend on this. `FigmaNormalize.figmaFileUrl` builds a working link
 * from the file key alone, so a reference is complete without any harvest — a
 * harvested link merely upgrades the row's label from `Figma file bJRNYiLo` to
 * `小程序--Copy-`, and supplies the canonical (already type-correct) url.
 *
 * Verified against a real 2026-08-11 capture, where all three prompts pasted a link:
 *   https://www.figma.com/design/bJRNYiLoMlBI1UIgMSnOxt/%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-?node-id=0-1&…
 *   https://www.figma.com/board/pb6Hry0yvWpYI0UyyCx3bt/Untitled?t=…
 *
 * We scan ONLY role:user `message.content` text blocks — not tool_result content, where
 * a link the AGENT produced could otherwise name a file it merely mentioned.
 */

/**
 * `figma.com/<type>/<fileKey>[/branch/<branchKey>][/<slug>]`.
 *
 * The branch alternative is load-bearing, straight out of four tool schemas: "If the
 * URL is of the format https://figma.com/design/:fileKey/branch/:branchKey/:fileName
 * then use the branchKey as the fileKey." So a branch link's TOOL CALL carries the
 * BRANCH key, and indexing the harvest by the parent key would miss every time. Worse,
 * without this alternative the slug group captures the literal string `branch`, so the
 * file would be labelled "branch" — a WRONG name rather than a missing one.
 *
 * `make` is in the type list because `get_design_context` accepts Figma Make files and
 * passes the makeFileKey through as `fileKey`.
 *
 * Two compiled forms from one pattern: `parseFigmaLink` uses `.exec()`, which on a
 * GLOBAL regex would carry `lastIndex` across calls and skip links non-deterministically.
 * (`matchAll` clones its regex per spec, so the scanner is unaffected either way — the
 * split exists for the single-shot parser.)
 */
/**
 * Longest slug the pattern will CAPTURE. Bounding the group is load-bearing twice over,
 * and both failures are reachable from ordinary untrusted transcript text.
 *
 * 1. It is the only bound on the row's TITLE and URL. `figmaDefinition` requires a
 *    non-empty title (`.+`) and a `www.figma.com`-prefixed url, and neither constrains
 *    length — measured on the full path (`scanUserFigmaLinks` → `normalizeFigma` →
 *    `extractRef`), a 120 000-char slug produced a 120 000-char title and a
 *    120 052-char url, both passing. That title is the sidebar row label, the
 *    frontmatter `title:` line, and the title of a memory pushed to a Space.
 * 2. {@link TRAILING_PUNCT_RE} is quadratic in the length of what it is handed —
 *    `[<class>]+$` backtracks over every start position when the string ends in an
 *    out-of-class byte. Measured through `scanUserFigmaLinks`: 10 000 in-class chars
 *    plus one out-of-class char took 151 ms, 20 000 took 407 ms, 40 000 took 1091 ms
 *    (baseline, all-in-class and therefore matching: 0.1 ms). That runs in the Stop
 *    hook. Bounding the capture bounds the input, so the strip cannot be the vector.
 *
 * Sized so a real name is never clipped rather than off the pathological case: a slug is
 * percent-encoded UTF-8, which inflates CJK 9× per character (`小程序--Copy-` → the
 * 33-char `%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-`, verbatim from the capture), so 512 covers
 * a ~55-character Chinese file name whole. Past the bound the match still SUCCEEDS on a
 * truncated slug — which costs nothing for the link, because Figma resolves a file by its
 * key and the name segment is decorative (the same property that lets `figmaFileUrl` emit
 * no slug at all).
 *
 * The `fileKey` group stays unbounded deliberately: it is not a title or ReDoS vector,
 * and bounding it to Figma's declared `{22,128}` would make an over-long key match a
 * TRUNCATED prefix (the following groups are all optional), keying the harvest under a
 * key no tool call carries — strictly worse than today's "matches whole, never matches a
 * call".
 */
const MAX_SLUG_LEN = 512;

const FIGMA_LINK_PATTERN = String.raw`https://(?:www\.)?figma\.com/(design|board|slides|make|file|proto)/([0-9a-zA-Z]+)(?:/branch/([0-9a-zA-Z]+))?(?:/([^/?#\s]{0,${MAX_SLUG_LEN}}))?`;
const FIGMA_LINK_RE = new RegExp(FIGMA_LINK_PATTERN);
const FIGMA_LINK_RE_ALL = new RegExp(FIGMA_LINK_PATTERN, "g");

/**
 * Longest DISPLAY name kept from a decoded slug, following `SlackNormalize`'s precedent
 * for the other source that derives its title from free-form user text.
 *
 * Distinct from {@link MAX_SLUG_LEN} on purpose: that one is a safety ceiling on the raw
 * capture (and on the url, where a long slug is merely untidy), this one is what a row
 * label can be. Applied to the DECODED string so the cut never lands mid-`%XX` and leave
 * a `%E5%B0` tail — `decodeSlug` runs first and tolerates a malformed sequence anyway,
 * but a name is what a human reads.
 *
 * Sliced by CODE POINT, not by UTF-16 unit: an emoji in a file name is one astral pair,
 * and `String.prototype.slice` would cut it in half and leave a lone surrogate in the
 * frontmatter and in every push payload built from it.
 */
const MAX_NAME_LEN = 120;

function capName(name: string): string {
	const points = [...name];
	if (points.length <= MAX_NAME_LEN) return name;
	return `${points.slice(0, MAX_NAME_LEN).join("").trimEnd()}…`;
}

/** Appended to a branch's name so it cannot render identically to its parent. A branch
 *  link's slug is the PARENT's file name — Figma does not slugify the branch name into
 *  the url — so without this the two references show the same row label and the user
 *  cannot tell which is which (figma is not in `labelLeadsWithNativeId`, so the row is
 *  the title alone). */
const BRANCH_TITLE_SUFFIX = " (branch)";

/**
 * Punctuation stripped off the END of a captured slug.
 *
 * A pasted link almost never stands alone: `[设计稿](…/Login-Page)`, `<…/Login-Page>`,
 * `请看 …/Login-Page。`, `…/Login-Page, thanks`. None of those closers is `/`, `?`, `#`
 * or whitespace, so the slug group swallows them — measured: a markdown link yields the
 * name `Login-Page)` and a url ending in `)`. Since figma is not in
 * `labelLeadsWithNativeId`, that corrupted name IS the whole sidebar row label.
 *
 * Stripping AFTER the match rather than narrowing the slug charset, because the charset
 * has to stay permissive: a real slug is percent-encoded UTF-8 (`%E5%B0%8F…`) and can
 * carry bytes we have not enumerated. ASCII and CJK closers both listed — a Chinese
 * prompt pasting a link is the capture this feature was built from.
 *
 * `-` is deliberately NOT in the set: Figma slugifies punctuation to `-`, so a real slug
 * routinely ENDS in one (`%E5%B0%8F%E7%A8%8B%E5%BA%8F--Copy-`, verbatim from the
 * capture). Stripping it would corrupt the very name this exists to preserve.
 */
const TRAILING_PUNCT_RE = /[).,;:!?\]}>'"，。、；：！？）】》」』]+$/;
const URL_CANDIDATE_RE = /https?:\/\/[^\s<>"'`]+/g;

function hasAllowedFigmaHost(text: string): boolean {
	for (const m of text.matchAll(URL_CANDIDATE_RE)) {
		const candidate = m[0];
		try {
			const u = new URL(candidate);
			if (u.hostname === "figma.com" || u.hostname === "www.figma.com") return true;
		} catch {
			// Ignore malformed URL-like substrings.
		}
	}
	return false;
}

export interface FigmaLink {
	/**
	 * The key the TOOL CALL will carry — the branch key when the link names a branch,
	 * else the file key. This is the harvest map's key, so it must match what
	 * `normalizeFigma` reads out of `toolInput.fileKey`.
	 */
	readonly fileKey: string;
	/** Canonical link, query string dropped — it carries a session token `t=` and a
	 *  transient `node-id`, neither of which belongs in a stored reference. */
	readonly url: string;
	/** Percent-decoded file name from the slug. Absent when the link carried none. */
	readonly name?: string;
}

/** Percent-decode the slug, tolerating a malformed sequence rather than throwing.
 *  Figma slugifies the real name (spaces and punctuation → `-`), so this is a readable
 *  approximation, never the exact name — deliberately NOT "restored" by guessing which
 *  `-` used to be a space.
 *
 *  Total on a non-empty input, which is the only kind {@link fromMatch} passes (it
 *  gates on `hasSlug`): `decodeURIComponent` of a non-empty string either throws — the
 *  malformed-sequence case, caught — or returns a non-empty string, so there is no
 *  empty-result branch to carry. */
function decodeSlug(slug: string): string {
	try {
		return decodeURIComponent(slug);
	} catch {
		return slug;
	}
}

function fromMatch(m: RegExpMatchArray): FigmaLink {
	const [, kind, fileKey, branchKey, rawSlug] = m;
	// Both the name AND the url are built from this, so the strip has to happen before
	// either — a url ending in `)` is not the link the user pasted.
	const slug = rawSlug?.replace(TRAILING_PUNCT_RE, "");
	const hasSlug = slug !== undefined && slug.length > 0;
	const branchPath = branchKey !== undefined ? `/branch/${branchKey}` : "";
	// Capped BEFORE the branch suffix is appended, so the suffix is never what gets cut.
	const decoded = hasSlug ? capName(decodeSlug(slug)) : undefined;
	const name = decoded !== undefined && branchKey !== undefined ? `${decoded}${BRANCH_TITLE_SUFFIX}` : decoded;
	return {
		// The branch key when present: that is what the tool call carries, so a branch
		// and its parent are two distinct references. Deliberate — they are two
		// different documents. (A branch with no slug needs no suffix: its synthesized
		// title is built from its own distinct key.)
		fileKey: branchKey ?? fileKey,
		url: `https://www.figma.com/${kind}/${fileKey}${branchPath}${hasSlug ? `/${slug}` : ""}`,
		...(name !== undefined ? { name } : {}),
	};
}

/** First Figma link in the text, or null. */
export function parseFigmaLink(raw: string): FigmaLink | null {
	const m = FIGMA_LINK_RE.exec(raw);
	return m === null ? null : fromMatch(m);
}

interface UserTextLine {
	message?: { role?: unknown; content?: unknown };
}

/**
 * Map keyed by the tool-facing key → link, from role:user text only.
 *
 * ALL links in a block are harvested, not just the first: one prompt naming a design
 * file and a FigJam board together is ordinary Figma usage, and dropping the second
 * would silently label it by its key. (SlackPermalink takes only the first, but a
 * message carrying two different threads is not a shape that arises there.)
 *
 * FIRST link wins for a given key: the opening paste is the one that NAMED the file,
 * and a later link to the same file (often a bare node deep-link with no slug) would
 * otherwise replace a good name with none.
 */
export function scanUserFigmaLinks(lines: string[]): Map<string, FigmaLink> {
	const out = new Map<string, FigmaLink>();
	for (const line of lines) {
		let parsed: UserTextLine;
		try {
			parsed = JSON.parse(line) as UserTextLine;
		} catch {
			continue;
		}
		const msg = parsed.message;
		if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (typeof block !== "object" || block === null) continue;
			const b = block as { type?: unknown; text?: unknown };
			if (b.type !== "text" || typeof b.text !== "string") continue;
			if (!hasAllowedFigmaHost(b.text)) continue;
			for (const m of b.text.matchAll(FIGMA_LINK_RE_ALL)) {
				const link = fromMatch(m);
				if (!out.has(link.fileKey)) out.set(link.fileKey, link);
			}
		}
	}
	return out;
}
