import { describe, expect, it } from "vitest";
import { normalizeSentry, SENTRY_TOOL_NAMES, SENTRY_TOOL_PREFIXES } from "./SentryNormalize.js";

/**
 * The real 2026-08-11 capture, verbatim in shape: a numeric id in the ARGUMENTS and a
 * short id in the PROSE result. That mismatch is the whole reason identity and display
 * are sourced separately, so it is the fixture everything else is measured against.
 */
const CAPTURED_URL =
	"https://jolli.sentry.io/issues/7665509682/?project=4511891639762944&query=is%3Aunresolved&referrer=issue-stream";

const CAPTURED_PROSE = [
	"# Issue JAVASCRIPT-NEXTJS-1 in **jolli**",
	"",
	"**Description**: TypeError: Object [object Object] has no method 'updateFrom'",
	"**Culprit**: ../../sentry/scripts/views.js in poll",
	"**Occurrences**: 1",
	"**Status**: unresolved",
	"**Platform**: other",
	"**Project**: javascript-nextjs",
	"**URL**: https://jolli.sentry.io/issues/JAVASCRIPT-NEXTJS-1",
	"",
	"### User",
	"**user**: id:1, email:mail@example.org, ip:127.0.0.1",
	"",
	"### HTTP Request",
	"**URL:** http://example.com/foo",
	"",
	"### Extra Data",
	'**session**: { "foo": "bar" }',
	"",
	"## Event Details",
	"```",
	"**Description**: not-this-one-inside-a-fence",
	"```",
].join("\n");

const GET_RESOURCE = "mcp__Sentry__get_sentry_resource";
const SEER = "mcp__Sentry__analyze_issue_with_seer";

function ref(input: unknown, tool = GET_RESOURCE, prose?: string): Record<string, unknown> | null {
	return normalizeSentry(input, tool, prose) as Record<string, unknown> | null;
}

describe("normalizeSentry", () => {
	describe("the captured call", () => {
		it("takes identity from the ARGUMENTS even though the prose names a different id", () => {
			const out = ref({ url: CAPTURED_URL }, GET_RESOURCE, CAPTURED_PROSE);
			// Numeric, from the input — NOT `JAVASCRIPT-NEXTJS-1` from the prose. Canonicalising
			// onto the prose id would split one issue across two rows whenever that
			// best-effort parse missed.
			expect(out?.nativeId).toBe("jolli.sentry.io/7665509682");
		});

		it("drops the UI query string when rebuilding the url", () => {
			const out = ref({ url: CAPTURED_URL }, GET_RESOURCE, CAPTURED_PROSE);
			expect(out?.url).toBe("https://jolli.sentry.io/issues/7665509682");
		});

		it("titles the row with the short id AND the error description", () => {
			// The short id carries the project (`javascript-nextjs`) as its own prefix, so the
			// label answers "which app" and "which bug" at once. A bare project name would
			// render three identical rows for three issues in one project.
			const out = ref({ url: CAPTURED_URL }, GET_RESOURCE, CAPTURED_PROSE);
			expect(out?.title).toBe(
				"JAVASCRIPT-NEXTJS-1 · TypeError: Object [object Object] has no method 'updateFrom'",
			);
		});

		it("uses `·`, not the ` — ` reserved for nativeId-led tracker labels", () => {
			// ReferenceDisplay composes `<nativeId> — <title>` for linear/jira/github only.
			// sentry's nativeId is a machine id, so it must not mimic that form.
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, CAPTURED_PROSE)?.title).not.toContain(" — ");
		});

		it("harvests the short id and project as display fields", () => {
			const out = ref({ url: CAPTURED_URL }, GET_RESOURCE, CAPTURED_PROSE);
			expect(out?.shortId).toBe("JAVASCRIPT-NEXTJS-1");
			expect(out?.project).toBe("javascript-nextjs");
		});

		it("puts the culprit above the link in the body", () => {
			// The click path renders this body; the culprit answers "why does this commit touch
			// these files", so it reads first.
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, CAPTURED_PROSE)?.detail).toBe(
				"**Culprit:** ../../sentry/scripts/views.js in poll\n\nSentry issue JAVASCRIPT-NEXTJS-1 · https://jolli.sentry.io/issues/7665509682",
			);
		});

		it("stores NO end-user PII from the event — the harvest boundary", () => {
			// A Sentry event routinely carries an end-user email, IP, request url and free-form
			// extra data. This body is committed to the orphan branch, mirrored into the Memory
			// Bank AND pushed to a Space, so none of it may be captured. Pinned against the real
			// section names rather than a size check, because the layout is not contractual.
			const out = ref({ url: CAPTURED_URL }, GET_RESOURCE, CAPTURED_PROSE);
			const serialized = JSON.stringify(out);
			for (const leak of ["mail@example.org", "127.0.0.1", "example.com/foo", "session", "Extra Data"]) {
				expect(serialized).not.toContain(leak);
			}
		});

		it("TRUNCATES an over-long culprit instead of dropping it from the body", () => {
			// Same cliff as the description, and it costs more: the culprit is the line that
			// says WHERE the bug is, so losing it empties the body of everything but the link.
			const prose = ["# Issue JS-1 in **jolli**", `**Culprit**: ${"a/".repeat(120)}x in poll`].join("\n");
			const detail = ref({ url: CAPTURED_URL }, GET_RESOURCE, prose)?.detail as string;
			expect(detail.startsWith("**Culprit:** a/a/")).toBe(true);
			expect(detail).toContain("…");
		});

		it("falls back to the link line alone when no Culprit is present", () => {
			const prose = "# Issue JAVASCRIPT-NEXTJS-1 in **jolli**";
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, prose)?.detail).toBe(
				"Sentry issue JAVASCRIPT-NEXTJS-1 · https://jolli.sentry.io/issues/7665509682",
			);
		});

		it("does NOT harvest status — the one fact that can go stale", () => {
			// Nothing re-polls Sentry, and a field renders with no label and no timestamp, so
			// a stored `unresolved` would keep asserting itself after the issue was fixed.
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, CAPTURED_PROSE)?.status).toBeUndefined();
		});
	});

	describe("title fallback chain", () => {
		it("falls back to the prose short id when no Description line is present", () => {
			const prose = "# Issue JAVASCRIPT-NEXTJS-1 in **jolli**\n\n**Status**: resolved";
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, prose)?.title).toBe("Issue JAVASCRIPT-NEXTJS-1");
		});

		it("falls back to the description alone when the heading is missing", () => {
			const prose = "**Description**: TypeError: boom";
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, prose)?.title).toBe("TypeError: boom");
		});

		it("falls back to the argument id with no prose at all — the Kimi path", () => {
			// KimiEnvelopeParser passes no rawResultText. The reference must still be
			// complete: identity, url and a usable title all come from the arguments.
			const out = ref({ url: CAPTURED_URL });
			expect(out?.title).toBe("Issue 7665509682");
			expect(out?.url).toBe("https://jolli.sentry.io/issues/7665509682");
			expect(out?.shortId).toBeUndefined();
		});

		it("caps the COMPOSED label, not just the description", () => {
			const long = [`# Issue ${"P".repeat(40)}-1 in **jolli**`, `**Description**: ${"x".repeat(400)}`].join("\n");
			const title = ref({ url: CAPTURED_URL }, GET_RESOURCE, long)?.title as string;
			expect(title.length).toBe(160);
			expect(title.endsWith("…")).toBe(true);
			expect(title.startsWith("PPPP")).toBe(true);
		});

		it("TRUNCATES a description past the harvest cap instead of losing it", () => {
			// The cap is a pre-tidy sanity bound, not a filter. An anchored lazy capture
			// could not match a 401-char line at all, so the description was dropped
			// wholesale and the title fell back to `Issue <id>` — on exactly the
			// long-message errors this source exists to record.
			const long = ["# Issue JS-1 in **jolli**", `**Description**: ${"x".repeat(401)}`].join("\n");
			const title = ref({ url: CAPTURED_URL }, GET_RESOURCE, long)?.title as string;
			expect(title.startsWith("JS-1 · xxx")).toBe(true);
			expect(title.length).toBe(160);
		});
	});

	describe("url validation — the vercel spoof shapes", () => {
		// Each of these ends in the right bytes while RESOLVING to evil.example. They die
		// on the PATH check, because the host is taken from URL.hostname (the resolved
		// host) rather than matched out of the raw string.
		it.each([
			["query-smuggled", "https://evil.example?x=.sentry.io/issues/1"],
			["fragment-smuggled", "https://evil.example#.sentry.io/issues/1"],
			["backslash-smuggled", "https://evil.example\\.sentry.io/issues/1"],
			["userinfo-smuggled", "https://user@evil.example?.sentry.io/issues/1"],
			["port-smuggled", "https://evil.example:8443?.sentry.io/issues/1"],
		])("voids a %s lookalike", (_label, url) => {
			expect(ref({ url })).toBeNull();
		});

		it("voids plain http", () => {
			expect(ref({ url: "http://jolli.sentry.io/issues/7665509682" })).toBeNull();
		});

		it("voids an unparseable url", () => {
			expect(ref({ url: "not-a-url" })).toBeNull();
		});

		// The hole the host anchor closes. Every OTHER check here passes for these: the
		// path is issue-shaped and the host charset is clean. Only the anchor stops an
		// arbitrary https host becoming a clickable "Sentry" row. `\issues` is included
		// because WHATWG parses the backslash as a separator, so it reaches `/issues/1`
		// exactly like the plain form.
		it.each([
			["a bare foreign host", "https://evil.example/issues/1"],
			["a backslash-separated foreign host", "https://evil.example\\issues/1"],
			["a suffix-lookalike host", "https://evilsentry.io/issues/1"],
			["a hyphenated lookalike host", "https://not-sentry.io/issues/1"],
		])("voids %s", (_label, url) => {
			expect(ref({ url })).toBeNull();
		});

		it("accepts a regional Sentry subdomain", () => {
			expect(ref({ url: "https://us.sentry.io/issues/123" })?.nativeId).toBe("us.sentry.io/123");
		});

		it("accepts the apex host", () => {
			expect(ref({ url: "https://sentry.io/issues/123" })?.nativeId).toBe("sentry.io/123");
		});

		it("VOIDS self-hosted Sentry — a documented, deliberate gap", () => {
			// Not an oversight: the url arrives in the ARGUMENTS, so it is untrusted, and
			// no self-hosted envelope has ever been captured. See SENTRY_HOST.
			expect(ref({ url: "https://sentry.mycorp.example/issues/ABC-1" })).toBeNull();
		});

		it("accepts the /organizations/<org>/issues/<id> form", () => {
			const out = ref({ url: "https://jolli.sentry.io/organizations/jolli/issues/7665509682/" });
			expect(out?.nativeId).toBe("jolli.sentry.io/7665509682");
		});

		it("voids a deeper path — an event is not its issue", () => {
			expect(ref({ url: "https://jolli.sentry.io/issues/7665509682/events/3b4db846/" })).toBeNull();
		});

		it("voids a non-issue resource path", () => {
			expect(ref({ url: "https://jolli.sentry.io/replays/abc123/" })).toBeNull();
		});
	});

	describe("resourceType gating", () => {
		it("voids a url call explicitly typed as something other than an issue", () => {
			expect(ref({ url: CAPTURED_URL, resourceType: "replay" })).toBeNull();
		});

		it("accepts a url call explicitly typed as an issue", () => {
			expect(ref({ url: CAPTURED_URL, resourceType: "issue" })?.nativeId).toBe("jolli.sentry.io/7665509682");
		});

		it("synthesizes <org>.sentry.io from an explicit issue resourceId", () => {
			const out = ref({ resourceType: "issue", organizationSlug: "jolli", resourceId: "JAVASCRIPT-NEXTJS-1" });
			expect(out?.nativeId).toBe("jolli.sentry.io/JAVASCRIPT-NEXTJS-1");
			expect(out?.url).toBe("https://jolli.sentry.io/issues/JAVASCRIPT-NEXTJS-1");
		});

		it("voids a bare resourceId with no resourceType — nothing to infer from", () => {
			expect(ref({ organizationSlug: "jolli", resourceId: "JAVASCRIPT-NEXTJS-1" })).toBeNull();
		});

		it("voids a non-issue resourceType even with a resourceId", () => {
			expect(ref({ resourceType: "trace", organizationSlug: "jolli", resourceId: "abc" })).toBeNull();
		});
	});

	describe("a REJECTED url never falls through to the org-slug synthesis", () => {
		// The synthesis ignores the url, so falling through answered a url this module had
		// just refused with a FABRICATED link to whatever SaaS org owns that slug — a
		// different tenant than the call named, and the one thing SENTRY_HOST exists to
		// prevent. Both forms arriving together is ordinary: a model holding the org in
		// context passes it alongside the url.
		it("voids a self-hosted url even when org + resourceId are also present", () => {
			expect(
				ref({
					url: "https://sentry.mycorp.example/issues/ABC-1",
					resourceType: "issue",
					organizationSlug: "mycorp",
					resourceId: "ABC-1",
				}),
			).toBeNull();
		});

		it("voids a foreign https url rather than pointing at <slug>.sentry.io", () => {
			expect(
				ref({
					url: "https://evil.example/issues/1",
					resourceType: "issue",
					organizationSlug: "victim-org",
					resourceId: "1",
				}),
			).toBeNull();
		});

		it("voids the same shape on the Seer tool", () => {
			expect(
				ref(
					{
						issueUrl: "https://sentry.mycorp.example/issues/ABC-1",
						organizationSlug: "mycorp",
						issueId: "ABC-1",
					},
					SEER,
				),
			).toBeNull();
		});

		it("still synthesizes when the url key is absent or empty — absent is not rejected", () => {
			// The guard keys off a url having been SUPPLIED, so the documented bare-id form
			// keeps working, and an empty string counts as absent (readString's contract).
			expect(ref({ resourceType: "issue", organizationSlug: "jolli", resourceId: "1" })?.nativeId).toBe(
				"jolli.sentry.io/1",
			);
			expect(ref({ resourceType: "issue", url: "", organizationSlug: "jolli", resourceId: "1" })?.nativeId).toBe(
				"jolli.sentry.io/1",
			);
		});
	});

	describe("org slug is validated as the DNS label it becomes", () => {
		// A slug the definition's own `nativeId` / `url` requires would refuse must not
		// build an object here: it voided in `extractRef` instead, two files away from the
		// pattern that admitted it.
		it("voids an underscored slug instead of synthesizing an unresolvable host", () => {
			expect(ref({ resourceType: "issue", organizationSlug: "my_org", resourceId: "1" })).toBeNull();
			expect(ref({ organizationSlug: "my_org", issueId: "1" }, SEER)).toBeNull();
		});

		it("voids a slug longer than one DNS label", () => {
			expect(ref({ resourceType: "issue", organizationSlug: "a".repeat(64), resourceId: "1" })).toBeNull();
		});

		it("voids a multi-label slug past the total length bound", () => {
			// Per-label validation alone is unbounded in total, and the definition's nativeId
			// caps the host at 253 — so without the length lookahead this rebuilt the same
			// admitted-here / refused-in-extractRef split.
			const slug = Array.from({ length: 5 }, () => "a".repeat(63)).join(".");
			expect(ref({ resourceType: "issue", organizationSlug: slug, resourceId: "1" })).toBeNull();
		});

		it("still accepts a multi-label slug, which both requires allow", () => {
			expect(ref({ resourceType: "issue", organizationSlug: "foo.bar", resourceId: "1" })?.nativeId).toBe(
				"foo.bar.sentry.io/1",
			);
		});

		it("voids a hyphen-edged label rather than storing a host that cannot resolve", () => {
			// `-foo` satisfies a bare [A-Za-z0-9-] class and built
			// `https://-foo.sentry.io/issues/1` — a dead link, which is the one outcome this
			// branch exists to avoid (the same rule the self-hosted void follows).
			for (const slug of ["-foo", "foo-", "a.-b", "a.b-"]) {
				expect(ref({ resourceType: "issue", organizationSlug: slug, resourceId: "1" })).toBeNull();
				expect(ref({ organizationSlug: slug, issueId: "1" }, SEER)).toBeNull();
			}
		});

		it("still accepts an interior hyphen, which is a real slug shape", () => {
			expect(ref({ resourceType: "issue", organizationSlug: "my-org", resourceId: "1" })?.nativeId).toBe(
				"my-org.sentry.io/1",
			);
		});

		it("LOWER-CASES the synthesized host so it cannot split a row from the url form", () => {
			// A url's host arrives already case-folded by the URL parser, so without this the
			// same issue got two native ids on nothing but the caller's capitalisation.
			const viaOrg = ref({ resourceType: "issue", organizationSlug: "Jolli", resourceId: "123" });
			const viaUrl = ref({ url: "https://Jolli.sentry.io/issues/123" });
			expect(viaOrg?.nativeId).toBe("jolli.sentry.io/123");
			expect(viaOrg?.nativeId).toBe(viaUrl?.nativeId);
			expect(viaOrg?.url).toBe("https://jolli.sentry.io/issues/123");
		});

		it("does NOT fold the issue id — a short id is upper-case and case-significant", () => {
			expect(ref({ resourceType: "issue", organizationSlug: "Jolli", resourceId: "JS-1A" })?.nativeId).toBe(
				"jolli.sentry.io/JS-1A",
			);
		});
	});

	describe("fenced regions are removed before the harvest runs", () => {
		// The line anchor does NOT do this: `^` matches at the start of any line, fence or
		// not. The captured payload ends with a fenced `## Event Details` block of raw event
		// content, and first-match-wins only hid it while the real field appeared above.
		const FENCED_ONLY = [
			"# Issue API-42 in **api**",
			"",
			"## Event Details",
			"```",
			"**Description**: secret from a stack frame",
			"**Culprit**: /internal/secret.js in leak",
			"**Project**: leaked-project",
			"```",
		].join("\n");

		it("does not read a Description that exists only inside a fence", () => {
			const out = ref({ url: CAPTURED_URL }, GET_RESOURCE, FENCED_ONLY);
			expect(out?.title).toBe("Issue API-42");
			expect(out?.title).not.toContain("secret");
		});

		it("does not read a fenced Culprit into the body", () => {
			const out = ref({ url: CAPTURED_URL }, GET_RESOURCE, FENCED_ONLY);
			expect(out?.detail).not.toContain("secret.js");
			expect(out?.detail).toBe("Sentry issue API-42 · https://jolli.sentry.io/issues/7665509682");
		});

		it("does not read a fenced display field", () => {
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, FENCED_ONLY)?.project).toBeUndefined();
		});

		it("still harvests fields OUTSIDE the fence in the same payload", () => {
			// The heading above the fence is read normally — stripping is not "give up on a
			// payload containing a fence".
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, FENCED_ONLY)?.shortId).toBe("API-42");
		});

		it("treats an UNTERMINATED fence as swallowing the rest", () => {
			// Deliberate direction to be wrong in: the alternative reads lines the service
			// marked as raw content.
			const unterminated = ["# Issue API-42 in **api**", "```", "**Description**: from an unclosed fence"].join(
				"\n",
			);
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, unterminated)?.title).toBe("Issue API-42");
		});

		it("honours ~~~ as well as ```", () => {
			const tilde = ["# Issue API-42 in **api**", "~~~", "**Description**: fenced with tildes", "~~~"].join("\n");
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, tilde)?.title).toBe("Issue API-42");
		});

		// A closing fence must MATCH the opener — same character, not shorter, no info
		// string. A flag that flips on any fence line is escapable with one injected line,
		// and the injected line comes from the one place this function guards: an error
		// message echoes attacker-influenced input, which Sentry renders inside the fenced
		// event block. Each of these put the escaped text straight into the title.
		it("does not let a ~~~ line close a ``` fence", () => {
			const escaped = [
				"# Issue API-42 in **api**",
				"## Event Details",
				"```",
				"ValidationError: bad input",
				"~~~",
				"**Description**: attacker-controlled text from an echoed input",
			].join("\n");
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, escaped)?.title).toBe("Issue API-42");
		});

		it("does not let a ``` line close a ~~~ fence", () => {
			const escaped = [
				"# Issue API-42 in **api**",
				"~~~",
				"ValidationError: bad input",
				"```",
				"**Description**: escaped from a tilde fence",
			].join("\n");
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, escaped)?.title).toBe("Issue API-42");
		});

		it("does not let a SHORTER fence close a longer opener", () => {
			const escaped = [
				"# Issue API-42 in **api**",
				"````",
				"ValidationError: bad input",
				"```",
				"**Description**: a shorter fence must not close it",
			].join("\n");
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, escaped)?.title).toBe("Issue API-42");
		});

		it("does not let a closing fence carrying an info string close one", () => {
			// CommonMark forbids an info string on a closing fence; honouring that is one
			// more line an injected payload cannot use.
			const escaped = [
				"# Issue API-42 in **api**",
				"```",
				"ValidationError: bad input",
				"```json",
				"**Description**: escaped behind an info string",
			].join("\n");
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, escaped)?.title).toBe("Issue API-42");
		});

		it("DOES let a longer fence of the same character close a shorter opener", () => {
			// The rule is "at least as long", not "exactly as long" — the text after a
			// legitimately closed fence is still the issue's own.
			const closed = [
				"# Issue API-42 in **api**",
				"```",
				"raw",
				"`````",
				"**Description**: TypeError: real one",
			].join("\n");
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, closed)?.title).toBe("API-42 · TypeError: real one");
		});

		it("reads a real field that appears AFTER a closed fence", () => {
			const after = [
				"# Issue API-42 in **api**",
				"```",
				"**Description**: fenced",
				"```",
				"**Description**: TypeError: real one",
			].join("\n");
			expect(ref({ url: CAPTURED_URL }, GET_RESOURCE, after)?.title).toBe("API-42 · TypeError: real one");
		});
	});

	describe("analyze_issue_with_seer — the second argument shape", () => {
		it("reads issueUrl", () => {
			const out = ref({ issueUrl: "https://my-org.sentry.io/issues/PROJECT-1Z43" }, SEER);
			expect(out?.nativeId).toBe("my-org.sentry.io/PROJECT-1Z43");
		});

		it("reads organizationSlug + issueId", () => {
			const out = ref({ organizationSlug: "my-org", issueId: "ERROR-456" }, SEER);
			expect(out?.nativeId).toBe("my-org.sentry.io/ERROR-456");
		});

		it("voids when neither form is present", () => {
			expect(ref({ instruction: "why does this fail on mobile" }, SEER)).toBeNull();
		});

		it("shares a mapKey with the read tool for the same issue, so the row merges", () => {
			// Same host + same id from two different tools and two different argument
			// shapes. Dedupe is last-wins on this key, which is what lets a Seer run
			// refresh the row a prior lookup created rather than duplicating it.
			const read = ref({ url: "https://my-org.sentry.io/issues/PROJECT-1Z43" });
			const seer = ref({ issueUrl: "https://my-org.sentry.io/issues/PROJECT-1Z43" }, SEER);
			expect(seer?.nativeId).toBe(read?.nativeId);
		});

		it("does NOT read get_sentry_resource's keys — dispatch is on the tool name", () => {
			// The seer branch must not duck-type `url`; a shape-only match would let a
			// third tool's lookalike input through.
			expect(ref({ url: CAPTURED_URL }, SEER)).toBeNull();
		});

		it("does NOT read seer's keys under the read tool", () => {
			expect(ref({ issueUrl: "https://my-org.sentry.io/issues/PROJECT-1Z43" })).toBeNull();
		});
	});

	describe("capture gate", () => {
		it("voids a tool outside the capture set even under a matching prefix", () => {
			// The definition's `exact` allow-list already blocks these; this is the second,
			// independent gate that protects a future Codex/Kimi binding with no allow-list.
			for (const tool of ["search_issues", "execute_sentry_tool", "update_issue", "find_projects"]) {
				expect(ref({ url: CAPTURED_URL }, `mcp__Sentry__${tool}`)).toBeNull();
			}
		});

		it("resolves a prototype-chain tool name to nothing", () => {
			expect(ref({ url: CAPTURED_URL }, "mcp__Sentry__toString")).toBeNull();
			expect(ref({ url: CAPTURED_URL }, "mcp__Sentry__constructor")).toBeNull();
		});

		it("accepts both prefix spellings and a bare name", () => {
			for (const prefix of [...SENTRY_TOOL_PREFIXES, ""]) {
				expect(ref({ url: CAPTURED_URL }, `${prefix}get_sentry_resource`)?.nativeId).toBe(
					"jolli.sentry.io/7665509682",
				);
			}
		});

		it("voids a non-object input", () => {
			expect(ref(null)).toBeNull();
			expect(ref("https://jolli.sentry.io/issues/1")).toBeNull();
			expect(ref([{ url: CAPTURED_URL }])).toBeNull();
		});
	});

	it("exports exactly the two captured tools", () => {
		// Pinned so widening the capture set is a deliberate edit with a visible diff —
		// adding one also requires a matching branch in `resolveIssue`.
		expect([...SENTRY_TOOL_NAMES]).toEqual(["get_sentry_resource", "analyze_issue_with_seer"]);
	});
});
