import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codexEnvelopeParser } from "./CodexEnvelopeParser.js";
import { extractReferencesFromTranscript } from "./ReferenceExtractor.js";
import { ALL_ADAPTERS } from "./sources/index.js";

const TS = "2026-06-05T10:24:53.000Z";

// ─── line builders mirroring real codex_apps rollout shapes ──────────────────

function jsonl(obj: unknown): string {
	return JSON.stringify(obj);
}

/** function_call request row (carries namespace + short name + call_id). */
function fnCall(namespace: string, name: string, callId: string, args = "{}"): string {
	return jsonl({
		type: "response_item",
		timestamp: TS,
		payload: { type: "function_call", name, namespace, arguments: args, call_id: callId },
	});
}

/** function_call_output row. `inner` is the business object; `wrap` controls
 *  whether it's the `[{type:text,text}]` double-string form (Linear/Notion) or a
 *  bare object (GitHub/Jira). `prefix` toggles the `Wall time:` human prefix. */
function fnOutput(callId: string, inner: unknown, opts: { wrap: "array" | "bare"; prefix: boolean }): string {
	const innerJson =
		opts.wrap === "array" ? JSON.stringify([{ type: "text", text: JSON.stringify(inner) }]) : JSON.stringify(inner);
	const output = opts.prefix ? `Wall time: 1.20s\nOutput:\n${innerJson}` : innerJson;
	return jsonl({
		type: "response_item",
		timestamp: TS,
		payload: { type: "function_call_output", call_id: callId, output },
	});
}

/** raw (non-JSON / error) function_call_output. */
function fnOutputRaw(callId: string, output: string): string {
	return jsonl({
		type: "response_item",
		timestamp: TS,
		payload: { type: "function_call_output", call_id: callId, output },
	});
}

/** mcp_tool_call_end event row. `inner` is the business object (single-stringed). */
function toolCallEnd(tool: string, callId: string, inner: unknown): string {
	return jsonl({
		type: "event_msg",
		timestamp: TS,
		payload: {
			type: "mcp_tool_call_end",
			call_id: callId,
			invocation: { server: "codex_apps", tool },
			result: { Ok: { content: [{ type: "text", text: JSON.stringify(inner) }] } },
		},
	});
}

// ─── business-object fixtures (real field shapes) ────────────────────────────

const LINEAR = {
	id: "JOLLI-1657",
	title: "Worker fails to start on older Node",
	url: "https://linear.app/jolliai/issue/JOLLI-1657/worker-fails",
	description: "## Problem\n\nNo summaries.",
};
const NOTION = {
	metadata: { type: "page" },
	title: "JolliMemory Initial Idea",
	url: "https://app.notion.com/p/36c4fc101d34805ab1fdfb3e69144580",
	text: "# JolliMemory\nsome content",
};
const GITHUB = {
	issue: {
		issue_number: 959,
		title: "Support multi-source external entity auto-discovery",
		url: "https://github.com/jolliai/jolli/issues/959",
		body: "Body text",
		state: "open",
		labels: [{ name: "enhancement" }, { name: "JolliMemory" }],
		assignees: [{ login: "sanshizhang-jolli" }],
	},
};
const JIRA_WRAPPED = {
	issues: {
		totalCount: 1,
		nodes: [
			{
				key: "KAN-4",
				self: "https://api.atlassian.com/ex/jira/29e34fb0/rest/api/3/issue/10013",
				webUrl: "https://jolli-team-kr0v9z0x.atlassian.net/browse/KAN-4",
				fields: {
					summary: "My Jira task",
					status: { name: "To Do" },
					priority: { name: "Medium" },
					description: "plain text desc",
				},
			},
		],
	},
};
const JIRA_BARE_NO_URL = {
	key: "KAN-9",
	self: "https://api.atlassian.com/ex/jira/29e34fb0/rest/api/3/issue/10099",
	fields: { summary: "No-url issue" },
};
// Real `_search_issues` shape (2026-06-08): a `{issues:[…]}` wrapper whose hit
// carries the URL but leaves `number`/`state` null — the connector's fallback
// path for resolving an issue URL. The number must be derived from the URL.
const GITHUB_SEARCH = {
	issues: [
		{
			url: "https://github.com/jolliai/jolli/issues/959",
			number: null,
			state: null,
			title: "Support multi-source external entity auto-discovery",
		},
	],
};

describe("CodexEnvelopeParser.parse", () => {
	it("emits one NormalizedToolResult per source via the PRIMARY function_call pair, with canonical toolName + matched adapter", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c_lin"),
			fnOutput("c_lin", LINEAR, { wrap: "array", prefix: true }),
			fnCall("mcp__codex_apps__notion", "_fetch", "c_not"),
			fnOutput("c_not", NOTION, { wrap: "array", prefix: true }),
			fnCall("mcp__codex_apps__github", "_fetch_issue", "c_gh"),
			fnOutput("c_gh", GITHUB, { wrap: "bare", prefix: true }),
			fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "c_jira"),
			fnOutput("c_jira", JIRA_WRAPPED, { wrap: "bare", prefix: false }),
		];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(lastLineNumberScanned).toBe(8);
		expect(results.map((r) => r.adapter.id).sort()).toEqual(["github", "jira", "linear", "notion"]);
		const jira = results.find((r) => r.adapter.id === "jira");
		expect(jira?.toolName).toContain("mcp__claude_ai_Atlassian__");
	});

	it("skips a non-JSON / no-prefix output (execution error) without throwing", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c_err"),
			fnOutputRaw("c_err", 'execution error: Io(Custom { kind: Other, error: "windows sandbox" })'),
		];
		const { results } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(0);
	});

	it("falls back to mcp_tool_call_end when a call_id has no function_call_output", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c_only_event"),
			toolCallEnd("linear_fetch", "c_only_event", LINEAR),
		];
		const { results } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(1);
		expect(results[0].adapter.id).toBe("linear");
	});

	it("does not double-emit when both function_call_output and event exist for the same call_id", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c_dup"),
			fnOutput("c_dup", LINEAR, { wrap: "array", prefix: true }),
			toolCallEnd("linear_fetch", "c_dup", LINEAR),
		];
		const { results } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(1);
	});

	it("ignores non-fetch (list/create) connector calls", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_list_teams", "c_list"),
			fnOutput("c_list", { teams: [] }, { wrap: "array", prefix: true }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(0);
	});

	it("honours fromLineNumber and reports the last line traversed", () => {
		const lines = [
			"{}",
			fnCall("mcp__codex_apps__linear", "_fetch", "c_lin"),
			fnOutput("c_lin", LINEAR, { wrap: "array", prefix: true }),
		];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(
			lines,
			{ fromLineNumber: 2 },
			ALL_ADAPTERS,
		);
		// Line index 0 (the fnCall) is skipped, so the pair can't be correlated.
		expect(results).toHaveLength(0);
		expect(lastLineNumberScanned).toBe(3);
	});

	it("tolerates malformed and shapeless lines", () => {
		const lines = [
			"mcp__codex_apps__linear not json",
			jsonl({ type: "response_item" }),
			jsonl({ payload: "mcp_tool_call_end" }),
		];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(0);
		expect(lastLineNumberScanned).toBe(3);
	});
});

describe("CodexEnvelopeParser.parse — defensive branches", () => {
	const raw = (payload: unknown) => jsonl({ type: "response_item", timestamp: TS, payload });

	it("ignores object payloads with an unrelated type, and rows missing required fields, without emitting", () => {
		const lines = [
			// payload object but unknown type → switch default
			raw({ type: "reasoning", note: "mcp__codex_apps__linear" }),
			// payload not an object → skipped before switch
			raw("mcp__codex_apps__linear-as-string"),
			// function_call missing call_id → not stored
			raw({ type: "function_call", name: "_fetch", namespace: "mcp__codex_apps__linear" }),
			// function_call_output missing output (but carries the type token) → not stored
			raw({ type: "function_call_output", call_id: "x" }),
			// mcp_tool_call_end variants: missing invocation / missing result / non-array content / non-text first
			raw({
				type: "mcp_tool_call_end",
				call_id: "a",
				result: { Ok: { content: [{ type: "text", text: "{}" }] } },
			}),
			raw({ type: "mcp_tool_call_end", call_id: "b", invocation: { tool: "linear_fetch" } }),
			raw({
				type: "mcp_tool_call_end",
				call_id: "c",
				invocation: { tool: "linear_fetch" },
				result: { Ok: { content: "x" } },
			}),
			raw({
				type: "mcp_tool_call_end",
				call_id: "d",
				invocation: { tool: "linear_fetch" },
				result: { Ok: { content: [{ type: "image" }] } },
			}),
			raw({
				type: "mcp_tool_call_end",
				call_id: "e",
				invocation: "notobj",
				result: { Ok: { content: [{ type: "text", text: "{}" }] } },
			}),
			// result not an object, and result.Ok not an object
			raw({ type: "mcp_tool_call_end", call_id: "f", invocation: { tool: "linear_fetch" }, result: "x" }),
			raw({ type: "mcp_tool_call_end", call_id: "g", invocation: { tool: "linear_fetch" }, result: { Ok: "x" } }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(0);
	});

	it("returns null payload for unparseable / Wall-time-without-marker / non-text-array outputs", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c1"),
			raw({ type: "function_call_output", call_id: "c1", output: "Wall time: 1s but no marker {not json}" }),
			fnCall("mcp__codex_apps__linear", "_fetch", "c2"),
			// array form whose first element is not a {type:text} block → unwrapTextArray returns the array as-is → adapter rejects
			raw({ type: "function_call_output", call_id: "c2", output: JSON.stringify([{ notText: 1 }]) }),
			fnCall("mcp__codex_apps__linear", "_fetch", "c3"),
			// array form whose text is not valid JSON → unwrapTextArray returns the array as-is
			raw({
				type: "function_call_output",
				call_id: "c3",
				output: JSON.stringify([{ type: "text", text: "not json" }]),
			}),
		];
		const { results } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		// c1 (null business) is skipped; c2/c3 still emit a result whose payload is the
		// un-unwrapped junk array — the adapter rejects it downstream (no Reference).
		expect(results).toHaveLength(2);
		expect(results.every((r) => Array.isArray(r.payload))).toBe(true);
	});

	it("fallback event with non-JSON text yields nothing", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "evt"),
			raw({
				type: "mcp_tool_call_end",
				call_id: "evt",
				invocation: { tool: "linear_fetch" },
				result: { Ok: { content: [{ type: "text", text: "definitely not json" }] } },
			}),
		];
		const { results } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(0);
	});

	it("GitHub reshape handles bare-string labels, repository_full_name, and non-object payloads", () => {
		const flatGithub = {
			issue_number: 12,
			title: "Flat issue",
			url: "https://github.com/o/r/issues/12",
			// mixed: bare string, empty string (skipped), non-string/non-object (skipped),
			// object with the key, object missing the key (skipped) — exercises every
			// flattenNamed branch.
			labels: ["bug", "", 7, { name: "feat" }, { nope: 1 }],
			assignees: ["alice"],
			repository_full_name: "o/r",
		};
		const lines = [
			fnCall("mcp__codex_apps__github", "_fetch_issue", "g1"),
			raw({ type: "function_call_output", call_id: "g1", output: JSON.stringify(flatGithub) }),
			// non-object business (a bare number) → reshapeGitHub returns it as-is → adapter rejects
			fnCall("mcp__codex_apps__github", "_fetch_issue", "g2"),
			raw({ type: "function_call_output", call_id: "g2", output: "123" }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		// Both emit a result (parser doesn't validate); g2's payload stays 123 and the
		// adapter rejects it downstream. g1 is reshaped into the canonical GitHub shape.
		expect(results).toHaveLength(2);
		const gh = results
			.map((r) => r.payload)
			.find(
				(p): p is { number: number; labels: unknown; repository?: { full_name?: string } } =>
					typeof (p as { number?: unknown })?.number === "number",
			);
		expect(gh?.number).toBe(12);
		expect(gh?.labels).toEqual(["bug", "feat"]);
		expect(gh?.repository?.full_name).toBe("o/r");
	});

	it("reshapes a _search_issues array and leaves number undefined when it can't be derived", () => {
		const search = {
			issues: [
				// url present but NOT an issue/PR url → number can't be derived from it
				{ url: "https://github.com/o/r/blob/main/x.ts", title: "blob, not an issue" },
				// no url at all → number stays undefined
				{ title: "no url here" },
			],
		};
		const lines = [
			fnCall("mcp__codex_apps__github", "_search_issues", "s1"),
			raw({ type: "function_call_output", call_id: "s1", output: JSON.stringify(search) }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(1);
		const payload = results[0].payload as { issues: Array<{ number?: unknown; html_url?: unknown }> };
		// First hit kept its (non-issue) url but no number; second has neither.
		expect(payload.issues[0].number).toBeUndefined();
		expect(payload.issues[0].html_url).toBe("https://github.com/o/r/blob/main/x.ts");
		expect(payload.issues[1].number).toBeUndefined();
		expect(payload.issues[1].html_url).toBeUndefined();
	});
});

describe("CodexEnvelopeParser.parse — cross-poll cursor safety (P1)", () => {
	it("holds the cursor BEFORE an in-flight fetch request whose output is not yet written", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "done"),
			fnOutput("done", LINEAR, { wrap: "array", prefix: true }),
			fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "inflight"), // no output yet
		];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(1); // only the completed linear call
		// Cursor is held at the in-flight request's line index (2), NOT EOF (3).
		expect(lastLineNumberScanned).toBe(2);
	});

	it("recovers the ref on the next poll once the output arrives (two-pass straddle)", () => {
		// Pass 1: only the request is present → nothing emitted, cursor held at 0.
		const pass1 = [fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "j1")];
		const r1 = codexEnvelopeParser.parse(pass1, {}, ALL_ADAPTERS);
		expect(r1.results).toHaveLength(0);
		expect(r1.lastLineNumberScanned).toBe(0);

		// Pass 2: request + now-written output, resumed from the held cursor (0).
		const pass2 = [
			fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "j1"),
			fnOutput("j1", JIRA_WRAPPED, { wrap: "bare", prefix: false }),
		];
		const r2 = codexEnvelopeParser.parse(pass2, { fromLineNumber: r1.lastLineNumberScanned }, ALL_ADAPTERS);
		expect(r2.results).toHaveLength(1);
		expect(r2.results[0].adapter.id).toBe("jira");
		expect(r2.lastLineNumberScanned).toBe(2);
	});

	it("does NOT hold the cursor for a non-fetch request, or one satisfied by an event", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_list_teams", "nonfetch"), // not a fetch → never holds
			fnCall("mcp__codex_apps__linear", "_fetch", "byEvent"),
			toolCallEnd("linear_fetch", "byEvent", LINEAR), // satisfied via event, no output
		];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {}, ALL_ADAPTERS);
		expect(results).toHaveLength(1); // linear via event
		expect(lastLineNumberScanned).toBe(3); // EOF — nothing held
	});
});

describe("CodexEnvelopeParser.parse — beforeTimestamp cutoff (P2)", () => {
	const row = (ts: string, payload: unknown) => jsonl({ type: "response_item", timestamp: ts, payload });
	const arr = (inner: unknown) => JSON.stringify([{ type: "text", text: JSON.stringify(inner) }]);
	const early = { id: "AAA-1", title: "early", url: "https://linear.app/x/issue/AAA-1/a" };
	const late = { id: "BBB-2", title: "late", url: "https://linear.app/x/issue/BBB-2/b" };

	it("drops results whose timestamp is after the cutoff", () => {
		const lines = [
			row("2026-06-05T10:00:00.000Z", {
				type: "function_call",
				name: "_fetch",
				namespace: "mcp__codex_apps__linear",
				call_id: "e1",
			}),
			row("2026-06-05T10:00:01.000Z", { type: "function_call_output", call_id: "e1", output: arr(early) }),
			row("2026-06-05T11:00:00.000Z", {
				type: "function_call",
				name: "_fetch",
				namespace: "mcp__codex_apps__linear",
				call_id: "e2",
			}),
			row("2026-06-05T11:00:01.000Z", { type: "function_call_output", call_id: "e2", output: arr(late) }),
		];
		const { results } = codexEnvelopeParser.parse(
			lines,
			{ beforeTimestamp: "2026-06-05T10:30:00.000Z" },
			ALL_ADAPTERS,
		);
		expect(results).toHaveLength(1);
		expect((results[0].payload as { id?: string }).id).toBe("AAA-1");
	});

	it("advances the cursor past a request whose ONLY result was cutoff-dropped (no deadlock)", () => {
		// Regression: the request's output exists but is past the cutoff, so it is
		// dropped. The cursor must still advance past the request — otherwise it is
		// pinned to this line every poll, the same output is re-dropped forever, and
		// all later lines become permanently unreachable.
		const lines = [
			row("2026-06-05T11:00:00.000Z", {
				type: "function_call",
				name: "_fetch",
				namespace: "mcp__codex_apps__linear",
				call_id: "late1",
			}),
			row("2026-06-05T11:00:01.000Z", { type: "function_call_output", call_id: "late1", output: arr(late) }),
		];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(
			lines,
			{ beforeTimestamp: "2026-06-05T10:30:00.000Z" },
			ALL_ADAPTERS,
		);
		expect(results).toHaveLength(0); // cutoff-dropped, nothing emitted
		expect(lastLineNumberScanned).toBe(2); // EOF, NOT pinned back to the request line (0)
	});
});

describe("CodexEnvelopeParser end-to-end via extractReferencesFromTranscript (source=codex, real adapters)", () => {
	let dir: string;
	let file: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "codex-env-"));
		file = join(dir, "rollout.jsonl");
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c_lin"),
			fnOutput("c_lin", LINEAR, { wrap: "array", prefix: true }),
			fnCall("mcp__codex_apps__notion", "_fetch", "c_not"),
			fnOutput("c_not", NOTION, { wrap: "array", prefix: true }),
			fnCall("mcp__codex_apps__github", "_fetch_issue", "c_gh"),
			fnOutput("c_gh", GITHUB, { wrap: "bare", prefix: true }),
			fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "c_jira"),
			fnOutput("c_jira", JIRA_WRAPPED, { wrap: "bare", prefix: false }),
			// A jira call with no webUrl (bare, via event) must NOT yield a ref.
			toolCallEnd("atlassian rovo_getjiraissue", "c_jira_nourl", JIRA_BARE_NO_URL),
		];
		writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("extracts correct refs for all four sources through the unchanged adapters", async () => {
		const { references } = await extractReferencesFromTranscript(file, ALL_ADAPTERS, { source: "codex" });
		const byKey = new Map(references.map((r) => [r.mapKey, r]));

		expect(byKey.get("linear:JOLLI-1657")?.url).toBe(LINEAR.url);
		expect(byKey.get("notion:36c4fc101d34805ab1fdfb3e69144580")?.url).toBe(NOTION.url);

		const gh = byKey.get("github:jolliai/jolli#959");
		expect(gh?.url).toBe("https://github.com/jolliai/jolli/issues/959");
		// labels/assignees object arrays were flattened so they survive readStringList.
		expect(gh?.fields?.some((f) => f.key === "labels")).toBe(true);

		// Jira: tenant browse webUrl from the function_call path (NOT the gateway self).
		const jira = byKey.get("jira:KAN-4");
		expect(jira?.url).toBe("https://jolli-team-kr0v9z0x.atlassian.net/browse/KAN-4");
		expect(jira?.title).toBe("My Jira task");

		// The webUrl-less jira event produced no ref.
		expect(byKey.has("jira:KAN-9")).toBe(false);
	});
});

describe("CodexEnvelopeParser end-to-end — GitHub _search_issues URL-resolution path", () => {
	let dir: string;
	let file: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "codex-ghsearch-"));
		file = join(dir, "rollout.jsonl");
		// Reproduces the 2026-06-08 case: the connector resolved an issue URL via
		// _search_issues (not _fetch_issue), returning {issues:[{url, number:null}]}.
		const lines = [
			fnCall("mcp__codex_apps__github", "_search_issues", "c_search"),
			fnOutput("c_search", GITHUB_SEARCH, { wrap: "bare", prefix: true }),
		];
		writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("extracts the github issue with the number derived from the URL", async () => {
		const { references } = await extractReferencesFromTranscript(file, ALL_ADAPTERS, { source: "codex" });
		const gh = references.find((r) => r.mapKey === "github:jolliai/jolli#959");
		expect(gh).toBeDefined();
		expect(gh?.url).toBe("https://github.com/jolliai/jolli/issues/959");
		expect(gh?.title).toBe("Support multi-source external entity auto-discovery");
	});
});

describe("CodexEnvelopeParser end-to-end — Jira malformed-output recovery", () => {
	let dir: string;
	let file: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "codex-jira-recover-"));
		file = join(dir, "rollout.jsonl");
		// The function_call output is the only copy with webUrl but is INVALID JSON
		// (the bare word `broken`); the valid mcp_tool_call_end event carries key +
		// summary (under versionedRepresentations, no `fields`) but no webUrl. The
		// recovery stitches them into one jira ref.
		const malformedOutput =
			'Wall time: 7s\nOutput:\n{"issues":{"nodes":[{"key":"KAN-7", broken "webUrl":"https://acme.atlassian.net/browse/KAN-7"}]}}';
		const lines = [
			fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "j1"),
			fnOutputRaw("j1", malformedOutput),
			toolCallEnd("atlassian rovo_getjiraissue", "j1", {
				key: "KAN-7",
				self: "https://api.atlassian.com/ex/jira/x/rest/api/3/issue/10099",
				versionedRepresentations: { summary: { "1": "Recovered jira summary" } },
			}),
		];
		writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("recovers a jira ref by stitching the valid event with webUrl salvaged from the malformed output", async () => {
		const { references } = await extractReferencesFromTranscript(file, ALL_ADAPTERS, { source: "codex" });
		const jira = references.find((r) => r.mapKey === "jira:KAN-7");
		expect(jira).toBeDefined();
		expect(jira?.title).toBe("Recovered jira summary");
		expect(jira?.url).toBe("https://acme.atlassian.net/browse/KAN-7");
	});
});
