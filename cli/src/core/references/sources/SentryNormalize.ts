/**
 * Sentry is an arguments-derived source, and the RESULT is what forces it: the only
 * captured call (2026-08-11, `get_sentry_resource`) returns Markdown PROSE —
 * `# Issue JAVASCRIPT-NEXTJS-1 in **jolli**` — not JSON. A non-JSON result cannot reach
 * a definition through the normal path: the envelope parsers either `JSON.parse` it or,
 * for `argumentsDerived`, replace it with `{}`.
 *
 * So identity comes from the ARGUMENTS and display comes, best-effort, from that prose.
 * The split is deliberate and load-bearing — see {@link normalizeSentry}.
 *
 * ## Identity: arguments only, never the prose
 *
 * The capture's INPUT carried the numeric id `7665509682` while its RESULT named the
 * short id `JAVASCRIPT-NEXTJS-1` — the same issue under two names. `update_issue` and
 * `analyze_issue_with_seer` both declare `issueId` as `PROJECT-1Z43`, so both spellings
 * are real and reachable. They cannot be reconciled locally.
 *
 * The prose DOES name the short id, so canonicalising identity onto it looks tempting.
 * It is a trap: a prose harvest is best-effort by nature, so the same issue would get
 * one nativeId when the harvest succeeded and another when it did not — splitting one
 * row in two on a display-layer accident. Identity therefore reads ONLY the arguments,
 * which are always present and always the same shape. The cost is accepted and bounded:
 * an issue referenced BOTH ways yields two rows. The benefit is that a title change can
 * never split a row.
 *
 * ## Namespaced by HOSTNAME, not by org slug
 *
 * The org is recoverable three different ways (`<org>.sentry.io`,
 * `/organizations/<org>/issues/`, an explicit `organizationSlug`) and they do not always
 * agree — `jolli.sentry.io/organizations/jolli/issues/1` and `.../issues/1` are the same
 * issue, and only the hostname is derivable from both. It is also the tenant boundary, so
 * two orgs' same-numbered issues cannot collide.
 *
 * The host is additionally ANCHORED to `sentry.io` — see {@link SENTRY_HOST} for why the
 * url's origin (the tool arguments) makes that necessary, and for the self-hosted gap it
 * knowingly creates.
 */
import { isObject } from "../guards.js";

/**
 * Claude namespace prefixes for the Sentry MCP server.
 *
 * TWO spellings, because this segment is the user's own MCP registration NAME rather
 * than anything Sentry controls: the capture reads `mcp__Sentry__` because that is the
 * key in this user's config, while `claude mcp add sentry …` yields `mcp__sentry__`.
 * Recognition is a case-SENSITIVE `startsWith` with no normalization anywhere in the
 * chain, so a single spelling silently captures nothing on half the installs — the same
 * split linear and figma already carry.
 */
export const SENTRY_TOOL_PREFIXES = ["mcp__Sentry__", "mcp__sentry__"] as const;

/** The observed read tool. Identity in `url`, or `resourceType`+`organizationSlug`+`resourceId`. */
const TOOL_GET_RESOURCE = "get_sentry_resource";

/**
 * Sentry's AI root-cause analysis. Identity in `issueUrl`, or
 * `organizationSlug`+`issueId` — a DIFFERENT argument shape from the tool above, which
 * is why adding a tool here is never a one-line change: {@link resolveIssue} needs a
 * matching branch or the reference silently voids.
 *
 * Captured without a real envelope of its own, and that is a narrower risk than it
 * looks. The precedent this repo enforces ("a fabricated invocation name silently never
 * matches", spec 154's jira `atlassian_rovo.getJiraIssue`) is about GUESSED names in the
 * Codex binding; this tool's name and parameter names are read off the live MCP server
 * schema. What is genuinely unverified is which of the two argument forms a model picks
 * — and both are schema-declared and both are handled below. The failure mode of
 * guessing wrong is a VOID (no row), never a wrong row, because the id is still
 * validated and the url still rebuilt from a parsed hostname.
 *
 * It earns its place: Sentry's own tool description says "Do NOT call this tool as an
 * automatic follow-up to get_sentry_resource", so a Seer run is an independent path into
 * an issue. Capturing only the read tool would miss the commit where the issue is most
 * literally the reason for the change.
 */
const TOOL_SEER = "analyze_issue_with_seer";

/**
 * The capture set. Everything else on this server is excluded deliberately:
 *   - `search_issues` (limit 100), `search_events` (limit 100), `find_projects` /
 *     `find_organizations` (25 each), `search_sentry_tools` — enumerations, which
 *     bulk-capture one reference per row (linear's `list_issues` precedent).
 *   - `execute_sentry_tool` — a DISPATCHER. Its tool name is constant and the real
 *     operation lives in `arguments.name`, so a name-based allow-list cannot tell
 *     `whoami` from `get_issue_details`; admitting it admits the whole catalog,
 *     enumerations included.
 *   - `update_issue` — a WRITE, and unobserved (figma excludes writes for the same
 *     reason).
 */
export const SENTRY_TOOL_NAMES: ReadonlyArray<string> = [TOOL_GET_RESOURCE, TOOL_SEER];

/**
 * Own-key gate, mirroring figma's: a `Set` so a prototype-chain name (`toString`) can
 * never resolve, and a second line of defence independent of the definition's `exact`
 * allow-list — `normalizeSentry` accepts BARE tool names for a future Codex/Kimi
 * binding, and that caller has no allow-list in front of it.
 */
const CAPTURED_TOOL_NAMES: ReadonlySet<string> = new Set(SENTRY_TOOL_NAMES);

/**
 * HOSTNAME charset, not "anything but a slash" — the vercel lesson, one step further.
 * There, `https://evil.example?x=.vercel.app` and `https://evil.example\.vercel.app`
 * both satisfied `^https://[^/]+\.vercel\.app$` and both navigated to `evil.example`.
 *
 * This is the FIRST of two host checks and it does not stand alone — {@link SENTRY_HOST}
 * anchors the domain. What this one adds is that the url is never read through: it is
 * REBUILT from `URL.hostname`, the host the parser actually resolved, so "passes the
 * check" and "is where it navigates" are the same statement by construction rather than
 * by regex. The charset is what makes that equivalence hold, since a string of these
 * bytes is read as the host in its entirety.
 */
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/;

/**
 * Sentry's SaaS host. A captured url must resolve to this host or a subdomain of it.
 *
 * This anchor is NOT the same requirement linear and github carry, and the difference is
 * where the url comes from. Those two read `url` / `html_url` out of the RESULT payload —
 * the service's own answer about itself — so `^https?://` is enough there. Sentry's url
 * comes from the tool ARGUMENTS, which is the weakest origin in the catalog: a transcript
 * records the block the model emitted whether or not the server accepted it, so a url
 * that was never a Sentry url at all still reaches this code.
 *
 * Without the anchor, ANY https host with an `/issues/<id>` path becomes a "Sentry"
 * reference pointing at it — measured: `https://evil.example/issues/1` satisfies every
 * other check here, and `https://evil.example\issues/1` reaches the same place because
 * WHATWG parses the backslash as a separator. That url is rendered as a clickable link
 * in the sidebar, in the archived markdown, and in memory pushed to a Space.
 *
 * KNOWN GAP, deliberate: this drops SELF-HOSTED Sentry, which the tool schemas do
 * mention (`regionUrl` is "usually not needed" there). Voiding beats storing an
 * unvalidated link, and no self-hosted envelope has ever been captured — designing an
 * exception for a deployment nobody here has seen would be guessing. If one shows up, the
 * principled relaxation is to corroborate the host against the `**URL**:` line the PROSE
 * carries (a url the SERVER produced, unlike the argument), not to widen this constant.
 */
const SENTRY_HOST = "sentry.io";

/**
 * Suffix-boundary check, not `endsWith(SENTRY_HOST)`: a bare suffix test also accepts
 * `evilsentry.io` and `not-sentry.io`. Same shape as `assertJolliOriginAllowed`'s
 * `host === h || host.endsWith("." + h)` in `JolliApiUtils.ts`.
 */
function isSentryHost(host: string): boolean {
	return host === SENTRY_HOST || host.endsWith(`.${SENTRY_HOST}`);
}

/**
 * Both observed id spellings: numeric (`7665509682`) and short-id
 * (`JAVASCRIPT-NEXTJS-1`). Neither can be preferred locally, so both are admitted.
 */
const ISSUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Org slug, for the branches that have to SYNTHESIZE a host — so it is validated as the
 * DNS LABEL it is about to become, not as a slug.
 *
 * A looser charset here does not widen what is captured, it only moves the rejection out
 * of sight: `sentryDefinition`'s `nativeId` (`[A-Za-z0-9.-]`) and `url` (`[A-Za-z0-9-]`
 * per label, 63 max) are applied to the SYNTHESIZED host, so `my_org` and a 70-char slug
 * both built an object here and were then voided wholesale by `extractRef` — measured,
 * with the pattern that admitted them 200 lines from the pattern that refused them. Two
 * validators for one value, disagreeing silently.
 *
 * The dot stays: a multi-label value still satisfies both `require`s, so keeping it
 * preserves the current accepted set exactly. The cost, unchanged by this alignment, is
 * that an org slug containing `_` is not reachable through the bare-id branch at all — a
 * `_` host does not resolve, so the alternative would be storing a dead link. A
 * url-shaped call from the same org works normally.
 *
 * The leading length lookahead is what makes the per-label form safe to have introduced:
 * labels alone are unbounded in total, and `nativeId`'s host half caps at 253 — so a slug
 * of five 63-char labels would have rebuilt the exact "admitted here, refused two files
 * away" split this pattern exists to close. The bound is the ORIGINAL 128.
 *
 * Each label must also BEGIN and END alphanumeric, which is the rest of what "validated as
 * the DNS label it is about to become" means. A bare `[A-Za-z0-9-]` class admits `-foo`
 * and `foo-`, and neither resolves — measured: `-foo` built
 * `https://-foo.sentry.io/issues/123` and stored it, so the one thing this branch exists to
 * avoid (a dead link) is what it produced. Unlike the `_` case there is no url-shaped
 * alternative to preserve here: a hyphen-edged label cannot be a real Sentry org slug, so
 * voiding costs nothing that was ever reachable.
 */
const ORG_SLUG =
	/^(?=.{1,128}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * `/issues/<id>` and the older `/organizations/<org>/issues/<id>`.
 *
 * Anchored and slash-free after the id, so a deeper path does NOT match:
 * `/issues/123/events/456` is an EVENT, and matching it would store the event under the
 * issue's identity.
 */
const ISSUE_PATH = /^\/(?:organizations\/[A-Za-z0-9._-]{1,128}\/)?issues\/([A-Za-z0-9_-]{1,128})\/?$/;

/**
 * Prose harvest patterns. DISPLAY-ONLY and best-effort — every one of them may miss,
 * and {@link normalizeSentry} degrades rather than voiding when they do.
 *
 * Multiline-anchored so a capture always starts at the beginning of a line and can never
 * be picked up mid-line. That anchor is NOT what keeps a fenced code block out — see
 * {@link stripFencedBlocks}, which removes those regions before any of these patterns runs.
 * Each capture is length-capped: this text is a remote service's output rendered into the
 * sidebar, an archived markdown file, and memory pushed to a Space.
 *
 * The two free-text caps TRUNCATE rather than reject, and the difference is not cosmetic:
 * `(.{1,400}?)[ \t]*$` cannot match a 401-char line at all, so an over-long line was
 * harvested as NOTHING — measured, the title fell all the way back to `Issue <id>` and the
 * culprit vanished from the body, on exactly the long-message errors this source exists to
 * record. Greedy and unanchored keeps the truncation while `.` still excludes newlines, so
 * a capture can never leave its own line. The trailing-whitespace trim the anchor used to
 * do is redundant: both of these values reach the output only through {@link tidyTitle},
 * which collapses whitespace and applies the real bound ({@link TITLE_MAX}) — the number
 * here is a pre-tidy sanity cap, not the storage bound.
 *
 * `**Status**:` is deliberately NOT harvested. It is the one fact in this payload that
 * can become FALSE: nothing re-polls Sentry, so a row observed while the issue was
 * `unresolved` keeps saying so after it is fixed, and a stale `resolved` on a regressed
 * issue is worse still. The hover card renders a field as a bare value with no label and
 * no timestamp, so it would read as a present-tense claim rather than "as observed".
 * `project` and `shortId` are permanent facts about the issue and cannot go stale.
 */
const PROSE_DESCRIPTION = /^\*\*Description\*\*:[ \t]*(.{1,400})/m;
const PROSE_HEADING_SHORT_ID = /^# Issue ([A-Za-z0-9_-]{1,128}) in /m;
const PROSE_PROJECT = /^\*\*Project\*\*:[ \t]*([A-Za-z0-9._-]{1,128})[ \t]*$/m;

/**
 * `**Culprit**: ../../sentry/scripts/views.js in poll` — the file and function Sentry
 * blames. The single most commit-relevant line in the whole payload: it says WHERE in the
 * code the bug is, which is the question a reader of this memory is actually asking.
 *
 * This is the ONLY part of the error detail that is harvested, and the boundary is drawn
 * on PRIVACY, not on size. A Sentry event routinely carries end-user PII — the real
 * capture holds `**user**: id:1, email:mail@example.org, ip:127.0.0.1`, an HTTP request
 * url, tags and a free-form `### Extra Data` section — and this body is written to the
 * per-reference markdown, committed to the orphan branch (permanent git history), mirrored
 * into the Memory Bank folder, AND pushed to a Space when the memory is shared. Production
 * user data must not enter a shared team knowledge base by default.
 *
 * That is also why this is a line-anchored capture of ONE named field rather than a
 * prefix of the prose: the section layout is not contractual, so any "take the first N
 * characters" rule would eventually scoop up whichever section happened to move up.
 *
 * WHAT THIS DOES NOT CLAIM, and the distinction is load-bearing for anyone extending it:
 * naming the field bounds WHICH sections are read, not whether their CONTENTS are personal.
 * The two values harvested are the two likeliest places for an identifier to appear in a
 * bounded field. A validation error echoes its input, so `**Description**:` legitimately
 * reads `ValidationError: user jane@customer.example already registered`; and a culprit is
 * often the transaction name, so `**Culprit**:` can be a url path carrying an account id.
 * Both then take the same route into git history and a Space push as everything above.
 *
 * That residual is ACCEPTED, not overlooked: the description is the entire value of this
 * label, and dropping it leaves `Issue <id>` — a row that records nothing. What the
 * boundary does buy is that the volume of PII stays bounded and its shape stays
 * inspectable, instead of a whole `### User` block arriving because a section moved.
 * A future change here — widening a pattern, adding a section, raising a cap — must be
 * weighed as "more production data into permanent shared history", not as a display tweak.
 */
const PROSE_CULPRIT = /^\*\*Culprit\*\*:[ \t]*(.{1,200})/m;

/** Sidebar rows truncate anyway; this bounds what reaches storage and the Space push. */
const TITLE_MAX = 160;

/**
 * Strip whichever known prefix is present, else return the name verbatim (a future
 * Codex binding delivers bare tool names).
 *
 * Deliberately an explicit prefix list rather than a `lastIndexOf("__")` trick: an MCP
 * server name may itself contain underscores — `mcp__claude_ai_Zoom_for_Claude__` is a
 * shipping example — so delimiter-hunting is not safe here.
 */
function bareToolName(toolName: string): string {
	for (const prefix of SENTRY_TOOL_PREFIXES) {
		if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
	}
	return toolName;
}

function readString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

interface ResolvedIssue {
	readonly host: string;
	readonly issueId: string;
}

/**
 * Parse an issue URL into a validated host + id, or null.
 *
 * Shared by `get_sentry_resource`'s `url` and `analyze_issue_with_seer`'s `issueUrl`,
 * which are the same thing under two parameter names.
 *
 * The returned host is `URL.hostname` — the host the parser RESOLVED. Attack shapes that
 * end in the right bytes while resolving elsewhere die on the path check rather than the
 * host check: `https://evil.example\.sentry.io` parses to hostname `evil.example` with
 * pathname `/.sentry.io`, and `https://evil.example?x=.sentry.io/issues/1` to pathname
 * `/` — neither matches {@link ISSUE_PATH}.
 */
function parseIssueUrl(raw: unknown): ResolvedIssue | null {
	const value = readString(raw);
	if (value === undefined) return null;

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:") return null;
	// Charset first, then the anchor. The charset check is what makes "matches the
	// suffix" and "resolves to the suffix" the same statement (the vercel finding); the
	// anchor is what keeps an arbitrary host out entirely.
	if (!HOSTNAME.test(parsed.hostname)) return null;
	if (!isSentryHost(parsed.hostname)) return null;

	const match = ISSUE_PATH.exec(parsed.pathname);
	if (match === null) return null;

	// `parsed.hostname`, never the raw string — and the query goes with it. The captured
	// url carried `?project=…&query=is%3Aunresolved&referrer=issue-stream`, UI noise that
	// would otherwise make two views of one issue look like different resources.
	return { host: parsed.hostname, issueId: match[1] };
}

/**
 * Synthesize a host from an org slug, for the id-based branches.
 *
 * `<org>.sentry.io` matches both tools' own documented examples. This is the one place a
 * self-hosted install is not served, and it cannot be: the arguments carry no host, and
 * guessing one would produce a dead link. A url-shaped call from the same install works
 * fine — only the bare-id form is affected.
 *
 * The slug is LOWER-CASED, because this branch is the only one that does not get that for
 * free. {@link parseIssueUrl} returns `URL.hostname`, which the WHATWG parser has already
 * case-folded, so `https://Jolli.sentry.io/issues/123` resolves to host `jolli.sentry.io`
 * while `{organizationSlug:"Jolli"}` built `Jolli.sentry.io` — a DIFFERENT nativeId for the
 * same issue, measured, splitting it into two rows on nothing but the caller's capitalisation.
 * Hosts are case-insensitive, so folding here loses no information and cannot change which
 * page the url opens; the id is deliberately left alone, since a short id is genuinely
 * upper-case (`JAVASCRIPT-NEXTJS-1`) and IS case-sensitive.
 *
 * This is the same class of split the header accepts for numeric-vs-short-id — but that one
 * is forced by two irreconcilable spellings from the service, whereas this one is ours.
 */
function fromOrgAndId(org: unknown, id: unknown): ResolvedIssue | null {
	const orgSlug = readString(org);
	const issueId = readString(id);
	if (orgSlug === undefined || !ORG_SLUG.test(orgSlug)) return null;
	if (issueId === undefined || !ISSUE_ID.test(issueId)) return null;
	return { host: `${orgSlug.toLowerCase()}.sentry.io`, issueId };
}

/**
 * Resolve identity from one tool's arguments. Dispatch is on the TOOL NAME, never on the
 * argument shape: the two tools spell the same fact with different keys, and duck-typing
 * would quietly accept a third tool's lookalike input.
 *
 * `get_sentry_resource` also serves events, traces, AI conversations, replays, monitors
 * and preprod snapshots. Its `resourceType` is OPTIONAL when a url is given (the tool
 * auto-detects), so an absent one is accepted and the PATH decides; when present it must
 * be `issue`, because the tool's own docs say the type can override a url's detection.
 * With no url there is nothing to infer from, so `resourceType` must be explicitly
 * `issue` — defaulting would capture every replay and trace as an issue.
 *
 * A url that was SUPPLIED and REJECTED voids; it never falls through to the org-slug
 * synthesis. Both forms can legitimately arrive together (a model that has the org in
 * context routinely passes it alongside the url), and the synthesis ignores the url
 * entirely — so the fall-through answered a rejected `https://sentry.mycorp.example/…`
 * with a link to whatever SaaS org happens to own that slug, and a rejected
 * `https://evil.example/issues/1` with `https://victim-org.sentry.io/issues/1`. Both
 * measured. That is a FABRICATED link where the whole point of {@link SENTRY_HOST} is
 * that a url from the arguments is the weakest origin in the catalog, and it silently
 * un-did the documented self-hosted void: the row it produced pointed at a different
 * tenant than the one the call named. Voiding is the same answer this module gives every
 * other unvalidatable url.
 */
function resolveIssue(bare: string, input: Record<string, unknown>): ResolvedIssue | null {
	if (bare === TOOL_SEER) {
		const fromIssueUrl = parseIssueUrl(input.issueUrl);
		if (fromIssueUrl !== null) return fromIssueUrl;
		if (readString(input.issueUrl) !== undefined) return null;
		return fromOrgAndId(input.organizationSlug, input.issueId);
	}
	if (bare === TOOL_GET_RESOURCE) {
		const resourceType = input.resourceType;
		if (resourceType !== undefined && resourceType !== "issue") return null;
		const fromUrl = parseIssueUrl(input.url);
		if (fromUrl !== null) return fromUrl;
		if (readString(input.url) !== undefined) return null;
		if (resourceType !== "issue") return null;
		return fromOrgAndId(input.organizationSlug, input.resourceId);
	}
	/* v8 ignore start -- unreachable today: every name reaching here passed CAPTURED_TOOL_NAMES, which is exactly the two branches above. Present so ADDING a tool fails closed. */
	// An `else` on the read tool, not a fall-through to it. Adding a third entry to
	// SENTRY_TOOL_NAMES widens the definition's `exact` allow-list AND this module's
	// captured-name gate in one edit, so the new tool would otherwise arrive here and be
	// read with `get_sentry_resource`'s argument keys. That is not the void the old comment
	// promised: a tool taking a `url` (an event or replay lookup is the obvious next one)
	// would be CAPTURED, storing a different resource under an issue's identity. Voiding an
	// undeclared tool makes the missing branch a no-op instead of a wrong row.
	return null;
	/* v8 ignore stop */
}

/** Collapse whitespace and cap. Prose lines reach the sidebar, an archived file, and a Space push. */
function tidyTitle(raw: string): string | undefined {
	const collapsed = raw.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX - 1)}…` : collapsed;
}

function firstCapture(pattern: RegExp, text: string): string | undefined {
	const match = pattern.exec(text);
	return match === null ? undefined : match[1];
}

/** Everything harvested from the prose result. Every field independently optional. */
interface ProseFacts {
	readonly description?: string;
	readonly shortId?: string;
	readonly project?: string;
	readonly culprit?: string;
}

/**
 * Drop every fenced region before harvesting, so a `**Description**:` or `**Culprit**:`
 * line that exists only INSIDE one cannot be read as the issue's own.
 *
 * The captured payload ends with a fenced `## Event Details` block holding raw event
 * content — stack frames, and whatever the frames' locals and messages happen to contain.
 * The real named fields always appear above it, so first-match-wins hid this for the
 * common case; it does not hold when the field is absent up there, which is precisely the
 * degraded payload the fallback title exists for. Measured: an issue with no top-level
 * `**Description**:` harvested `secret from a stack frame` out of the fence and titled the
 * row with it, and took the fenced `**Culprit**:` into the body as well.
 *
 * That crosses the boundary {@link PROSE_CULPRIT} draws — one named field, not a prefix of
 * the prose — in the one direction that matters, since this body is committed to permanent
 * git history and pushed to a Space. Losing a harvest to a fence-only field is the right
 * trade: the row degrades to `Issue <id>`, which is a documented, recoverable state.
 *
 * An UNTERMINATED fence swallows the rest of the text, deliberately: the alternative reads
 * lines the service marked as raw content, and this is the direction to be wrong in.
 * `~~~` is honoured alongside ``` because CommonMark treats them identically.
 *
 * ## The closing fence is MATCHED, and that is the whole security property
 *
 * A naive "any fence line toggles a flag" is escapable with one line, and the escaping
 * content is exactly the content this function exists to contain: an error message echoes
 * attacker-influenced input, Sentry renders it inside the fenced event block, so a message
 * carrying a lone `~~~` closed a ``` fence early and put everything after it back in scope.
 * Measured, all three shapes reaching the title: `~~~` inside ```, ``` inside `~~~`, and a
 * SHORTER fence closing a longer opener (` ``` ` against ` ```` `). And it triggers on the
 * absent-`**Description**:` payload, i.e. the same degraded case the fence rule was added
 * for — so the toggle closed one door and left the next one open.
 *
 * CommonMark's own rule closes all three: a closing fence uses the SAME character, is at
 * least as long as the opener, and carries no info string. A non-matching fence line inside
 * a fence is content, so it is dropped like any other line in there.
 *
 * Two deliberate divergences from CommonMark, both toward stripping MORE, because every
 * asymmetry here should cost a harvest rather than leak a region:
 *   - the opener's indent is `\s{0,3}` (CommonMark: three SPACES), so a tab-indented marker
 *     still opens a fence. Broadening the OPENER cannot help an attacker escape — it can
 *     only strip more of their own content — while narrowing it would hand them a fence
 *     that this function does not see but a reader would.
 *   - no blank-line or list-context handling. Sentry emits column-zero fences; the extra
 *     precision would only ever re-admit text.
 */
function stripFencedBlocks(text: string): string {
	const out: string[] = [];
	let open: { readonly char: string; readonly length: number } | null = null;
	for (const line of text.split("\n")) {
		const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (marker === null) {
			if (open === null) out.push(line);
			continue;
		}
		const [, run, trailing] = marker;
		if (open === null) {
			open = { char: run[0], length: run.length };
			continue;
		}
		// Same character, not shorter, and nothing but whitespace after it — CommonMark
		// forbids an info string on a closing fence, and honouring that is one more line an
		// injected payload cannot use to get out.
		if (run[0] === open.char && run.length >= open.length && trailing.trim().length === 0) open = null;
		// Either way the delimiter line itself is never emitted.
	}
	return out.join("\n");
}

function readProse(rawResultText: string | undefined): ProseFacts {
	if (rawResultText === undefined || rawResultText.length === 0) return {};
	const text = stripFencedBlocks(rawResultText);
	const description = firstCapture(PROSE_DESCRIPTION, text);
	const shortId = firstCapture(PROSE_HEADING_SHORT_ID, text);
	const project = firstCapture(PROSE_PROJECT, text);
	// Collapsed and capped like the title: this one is a free-form string from a remote
	// service and it lands in a markdown body, so it must not carry newlines that would
	// break out of its own line.
	const rawCulprit = firstCapture(PROSE_CULPRIT, text);
	const culprit = rawCulprit === undefined ? undefined : tidyTitle(rawCulprit);
	return {
		...(description !== undefined ? { description } : {}),
		...(shortId !== undefined ? { shortId } : {}),
		...(project !== undefined ? { project } : {}),
		...(culprit !== undefined ? { culprit } : {}),
	};
}

/**
 * Canonical shape for `sentryDefinition`'s plain `path` ops. Returns null to VOID — a
 * non-issue resource, a malformed url, or a tool outside the capture set.
 *
 * `rawResultText` is the prose result the arguments-derived path would otherwise
 * discard. OPTIONAL and DISPLAY-ONLY, exactly like figma's harvested link map: the
 * Claude parser supplies it, the Kimi parser does not, and a Kimi-captured reference is
 * complete either way — only the title falls back from the error description to
 * `Issue <id>`. Nothing about identity, dedupe or the url depends on it.
 */
export function normalizeSentry(toolInput: unknown, toolName: string, rawResultText?: string): object | null {
	const bare = bareToolName(toolName);
	if (!CAPTURED_TOOL_NAMES.has(bare)) return null;
	if (!isObject(toolInput)) return null;

	const resolved = resolveIssue(bare, toolInput);
	if (resolved === null) return null;

	const { host, issueId } = resolved;
	const url = `https://${host}/issues/${issueId}`;
	const prose = readProse(rawResultText);

	// Four arms, all reachable in production:
	//   1. `JAVASCRIPT-NEXTJS-1 · TypeError: …` — both halves harvested;
	//   2. `TypeError: …`                       — description only;
	//   3. `Issue JAVASCRIPT-NEXTJS-1`          — a non-error issue with no Description;
	//   4. `Issue 7665509682`                   — no prose at all (the Kimi path).
	//
	// Arm 1 leads with the SHORT ID rather than the project name, and that is the whole
	// design of this label. A project name alone (`javascript-nextjs`, harvestable from
	// `**Project**:`) identifies the APP but not the BUG, so three issues in one project
	// render three identical, indistinguishable rows — the trap vercel documented when
	// its title was the bare project name. The short id carries the project as its own
	// prefix AND a per-issue sequence, so it answers both questions at once. It is also
	// Sentry's canonical handle: the captured result's own Response Notes say
	// `Fixes JAVASCRIPT-NEXTJS-1` in a commit message closes the issue.
	//
	// The separator is `·`, deliberately NOT the ` — ` that `ReferenceDisplay` composes
	// for `linear`/`jira`/`github`. That form is reserved for a label built from the
	// `nativeId`, and sentry's nativeId is a machine id (`jolli.sentry.io/7665509682`);
	// borrowing the em dash would advertise a mechanism this source cannot use. Adding
	// sentry to `NATIVE_ID_TRACKER_SOURCES` instead would render that host-and-number
	// pair in front of every row, which is strictly worse than what is built here.
	//
	// Capped AFTER composing, so the bound holds for the whole label rather than for the
	// description alone.
	const composed =
		prose.shortId !== undefined && prose.description !== undefined
			? `${prose.shortId} · ${prose.description}`
			: prose.description;
	const title = (composed !== undefined ? tidyTitle(composed) : undefined) ?? `Issue ${prose.shortId ?? issueId}`;

	// The click path hides YAML frontmatter (the vercel finding), so a description-less
	// reference opens as nothing but the auto-generated track-only note. The link line
	// carries what the title does not; the culprit goes ABOVE it because it is the answer
	// to "why does this commit touch these files" and should be the first thing read.
	//
	// The colon is INSIDE the bold here (`**Culprit:**`) while the harvest pattern matches
	// Sentry's own spelling with it outside (`**Culprit**:`). Not a detail worth
	// "fixing" — the harvest only ever reads Sentry's raw result, never this body, so the
	// two cannot feed each other in either direction.
	const linkLine = `Sentry issue ${prose.shortId ?? issueId} · ${url}`;
	const detail = prose.culprit !== undefined ? `**Culprit:** ${prose.culprit}\n\n${linkLine}` : linkLine;

	return {
		nativeId: `${host}/${issueId}`,
		title,
		url,
		detail,
		// Display fields. Each is absent unless the prose carried it; the scalar coercion
		// drops an absent value, so no special case is needed downstream.
		...(prose.shortId !== undefined ? { shortId: prose.shortId } : {}),
		...(prose.project !== undefined ? { project: prose.project } : {}),
	};
}
