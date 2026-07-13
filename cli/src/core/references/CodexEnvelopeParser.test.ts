import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codexEnvelopeParser } from "./CodexEnvelopeParser.js";
import { extractReferencesFromTranscript } from "./ReferenceExtractor.js";

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
function fnOutput(
	callId: string,
	inner: unknown,
	opts: { wrap: "array" | "bare" | "envelope"; prefix: boolean },
): string {
	const innerJson =
		opts.wrap === "array"
			? JSON.stringify([{ type: "text", text: JSON.stringify(inner) }])
			: opts.wrap === "envelope"
				? // Newer codex_apps connectors emit the full MCP CallToolResult object.
					JSON.stringify({
						meta: null,
						content: [{ type: "text", text: JSON.stringify(inner) }],
						structuredContent: null,
						isError: false,
					})
				: JSON.stringify(inner);
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
// Real `codex_apps/zoom._get_meeting_assets` shape (2026-07-13 rollout): the
// business payload is a single meeting object identical to the Claude
// get_meeting_assets result, read directly by the zoom-meeting definition.
const ZOOM_MEETING = {
	from_server: true,
	meeting_uuid: "CB9D57D1-D6B0-4ECC-A6C2-E00449DF9B8D",
	meeting_number: 98668434129,
	topic: "US/China sync meeting",
	start_time: "2026-07-09T01:30:00Z",
	end_time: "2026-07-09T02:00:00Z",
	deep_url: "https://jolli.zoom.us/launch/edl?muid=b69e8f55-b001-420f-a02d-ba19b3bc9416",
	meeting_category: "history",
	meeting_summary: {
		summary_plain_text: "Quick recap ...",
		summary_markdown: "## Quick recap\n\nThe team reviewed the 1.0 release plan.",
		summary_doc_url: "https://docs.zoom.us/doc/BL6P4Z-qRv-5Tpj3svUONw",
		has_permission: true,
		has_summary: true,
	},
	meeting_transcript: {
		primary_language: "en",
		transcript_items: [{ start: "00:01:58.000", text: "Hi", end: "00:01:59.000" }],
	},
	my_notes: { has_my_notes: false },
};
// Real Codex built-in "Atlassian Rovo" app shapes, captured from live rollouts
// (2026-07). Confluence uses a dedicated `_getconfluencepage`; Jira is reachable
// BOTH through the generic `_fetch` (`{id,title,text,url,type,metadata}` entity
// envelope) AND a dedicated `_getjiraissue` (standard REST issue — see
// ROVO_JIRA_REST). The older fixtures fabricated a `{key,fields,webUrl}` _fetch
// shape and a mis-spelled `_getjiraissue` name, neither matching reality.
//
// Rovo's `_getconfluencepage` `content[0].text` — the string the Codex envelope
// layer extracts — is a FLAT page node, NOT Claude's `{content:{nodes:[…]}}`
// wrapper (that wrapped twin lives only in the discarded `structuredContent`).
// The flat node carries `spaceId`/`authorId` IDs, NO `space`/`author` objects.
const ROVO_CONFLUENCE = {
	id: "131076",
	type: "page",
	status: "current",
	title: "数据库访问架构变更设计：Per-Provider 连接池",
	spaceId: 98307,
	parentId: "98415",
	authorId: "712020:bb39bcb3-833a-4d6e-8605-5cfaad3e2172",
	body: "## TL;DR\n\n1. 现状：per-(tenant, org) 连接池。",
	webUrl: "https://lichengbin2008.atlassian.net/wiki/spaces/KAN/pages/131076/Per-Provider",
};
const ROVO_JIRA_FETCH = {
	id: "ari:cloud:jira:e8d56e41-d65c-44d9-822d-96fb42c56007:issue/KAN-1",
	title: "Trace Log",
	text: "1. Background\n\nThe backend uses pino for logging.",
	url: "https://api.atlassian.com/ex/jira/e8d56e41-d65c-44d9-822d-96fb42c56007/rest/api/3/issue/10000",
	type: "jira-issue",
	metadata: {
		cloudId: "e8d56e41-d65c-44d9-822d-96fb42c56007",
		status: "To Do",
		priority: "Medium",
		issueType: "Task",
	},
};
// Real dedicated `atlassian_rovo.getJiraIssue` content[0].text (2026-07-13): the
// standard Jira REST v3 issue — `{key, fields:{summary,…}, self}` with NO webUrl.
const ROVO_JIRA_REST = {
	expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
	id: "10000",
	self: "https://api.atlassian.com/ex/jira/e8d56e41-d65c-44d9-822d-96fb42c56007/rest/api/3/issue/10000",
	key: "KAN-1",
	fields: {
		summary: "Trace Log",
		status: { name: "To Do", statusCategory: { name: "To Do" } },
		priority: { name: "Medium" },
		issuetype: { name: "Task" },
		description: "1. Background\n\nThe backend uses pino for logging.",
		labels: [],
	},
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
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {});
		expect(lastLineNumberScanned).toBe(8);
		expect(results.map((r) => r.def.id).sort()).toEqual(["github", "jira", "linear", "notion"]);
		const jira = results.find((r) => r.def.id === "jira");
		expect(jira?.toolName).toContain("mcp__claude_ai_Atlassian__");
	});

	it("extracts a Confluence reference from the real Rovo _getconfluencepage (flat content[0].text via mcp_tool_call_end)", () => {
		// Faithful to the live rollout: the page fetch produced only a
		// mcp_tool_call_end event (no function_call_output), and its
		// `result.Ok.content[0].text` is the FLAT node — the shape that used to
		// slip past normalizeConfluence's `content.nodes` gate and get dropped.
		const lines = [
			fnCall("mcp__codex_apps__atlassian_rovo", "_getconfluencepage", "c_conf"),
			toolCallEnd("atlassian_rovo.getConfluencePage", "c_conf", ROVO_CONFLUENCE),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results.map((r) => r.def.id)).toEqual(["confluence"]);
		const payload = results[0].payload as { pageId?: string; space?: string; author?: string };
		expect(payload.pageId).toBe("131076");
		// Flat node has only spaceId/authorId → these display fields stay undefined.
		expect(payload.space).toBeUndefined();
		expect(payload.author).toBeUndefined();
		expect(results[0].toolName).toBe("mcp__claude_ai_Atlassian__getConfluencePage");
	});

	it("extracts a Jira reference from the real Rovo generic _fetch entity envelope", () => {
		const lines = [
			fnCall("mcp__codex_apps__atlassian_rovo", "_fetch", "c_jf"),
			fnOutput("c_jf", ROVO_JIRA_FETCH, { wrap: "bare", prefix: true }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results.map((r) => r.def.id)).toEqual(["jira"]);
		const payload = results[0].payload as { key?: string; fields?: { summary?: string } };
		expect(payload.key).toBe("KAN-1");
		expect(payload.fields?.summary).toBe("Trace Log");
	});

	it("extracts a Jira reference from the real Rovo dedicated getJiraIssue (REST issue via mcp_tool_call_end)", () => {
		// Faithful to the live rollout: the dedicated tool fires a `_getjiraissue`
		// function_call and an `atlassian_rovo.getJiraIssue` event whose
		// content[0].text is the standard Jira REST issue — `{key,fields,self}`, NO
		// webUrl. Before the fix the event name did not match and, even if it had, the
		// missing webUrl voided the ref.
		const lines = [
			fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "c_gji"),
			toolCallEnd("atlassian_rovo.getJiraIssue", "c_gji", ROVO_JIRA_REST),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results.map((r) => r.def.id)).toEqual(["jira"]);
		const payload = results[0].payload as { key?: string; webUrl?: string; fields?: { summary?: string } };
		expect(payload.key).toBe("KAN-1");
		expect(payload.fields?.summary).toBe("Trace Log");
		// self mapped to webUrl (no browsable url from Rovo).
		expect(payload.webUrl).toBe(
			"https://api.atlassian.com/ex/jira/e8d56e41-d65c-44d9-822d-96fb42c56007/rest/api/3/issue/10000",
		);
		expect(results[0].toolName).toBe("mcp__claude_ai_Atlassian__getJiraIssue");
	});

	it("unwraps the object-envelope function_call_output ({content:[{text}]}) — newer Linear _get_issue connector", () => {
		// Regression: the OpenAI-curated Linear connector returns the full MCP
		// CallToolResult object (not the bare [{text}] array). The issue JSON lives
		// in content[0].text and must be unwrapped, or the adapter sees the envelope
		// and extracts nothing.
		const lines = [
			fnCall("mcp__codex_apps__linear", "_get_issue", "c_gi"),
			fnOutput("c_gi", LINEAR, { wrap: "envelope", prefix: true }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results.map((r) => r.def.id)).toEqual(["linear"]);
		// Payload is the UNWRAPPED issue (id present), not the envelope object.
		expect((results[0].payload as { id?: string }).id).toBe("JOLLI-1657");
		expect(results[0].toolName).toBe("mcp__linear__get_issue");
	});

	it("skips a non-JSON / no-prefix output (execution error) without throwing", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c_err"),
			fnOutputRaw("c_err", 'execution error: Io(Custom { kind: Other, error: "windows sandbox" })'),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
	});

	it("falls back to mcp_tool_call_end when a call_id has no function_call_output", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c_only_event"),
			toolCallEnd("linear_fetch", "c_only_event", LINEAR),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("linear");
	});

	it("does not double-emit when both function_call_output and event exist for the same call_id", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c_dup"),
			fnOutput("c_dup", LINEAR, { wrap: "array", prefix: true }),
			toolCallEnd("linear_fetch", "c_dup", LINEAR),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
	});

	it("ignores non-fetch (list/create) connector calls", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_list_teams", "c_list"),
			fnOutput("c_list", { teams: [] }, { wrap: "array", prefix: true }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
	});

	it("honours fromLineNumber and reports the last line traversed", () => {
		const lines = [
			"{}",
			fnCall("mcp__codex_apps__linear", "_fetch", "c_lin"),
			fnOutput("c_lin", LINEAR, { wrap: "array", prefix: true }),
		];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, { fromLineNumber: 2 });
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
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
		expect(lastLineNumberScanned).toBe(3);
	});
});

describe("CodexEnvelopeParser.parse — normalize still applied once identity resolves via the registry", () => {
	// Real Codex node (mirrors CodexJiraBinding.test.ts's fixture): NO `fields`,
	// summary lives under `versionedRepresentations` — this is the shape
	// `jiraCodexBinding.normalize` (reshapeJiraNode) actually reshapes. Unlike
	// JIRA_WRAPPED above (already adapter-shaped, so normalize is a no-op on it),
	// this fixture only produces a valid Reference if `getCodexNormalizer` is
	// still wired to the def the registry resolves — proving normalize survived
	// the identity-resolution wiring change (registry.match replacing
	// codexBindingFromFunctionCall), not just that the parser doesn't throw.
	const JIRA_NODE_NEEDING_NORMALIZE = {
		key: "KAN-4",
		self: "https://api.atlassian.com/ex/jira/x/rest/api/3/issue/10013",
		webUrl: "https://acme.atlassian.net/browse/KAN-4",
		versionedRepresentations: { summary: { "1": "Add Jira issue auto-discovery" } },
	};

	it("derives fields.summary from versionedRepresentations for a Jira function_call pair", () => {
		const lines = [
			fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "c_jira_norm"),
			fnOutput(
				"c_jira_norm",
				{ issues: { totalCount: 1, nodes: [JIRA_NODE_NEEDING_NORMALIZE] } },
				{ wrap: "bare", prefix: false },
			),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("jira");
		const payload = results[0].payload as { issues: { nodes: Array<{ fields?: { summary?: string } }> } };
		expect(payload.issues.nodes[0].fields?.summary).toBe("Add Jira issue auto-discovery");
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
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
	});

	it("returns null payload for unparseable / Wall-time-without-marker / non-text-array outputs", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_fetch", "c1"),
			raw({ type: "function_call_output", call_id: "c1", output: "Wall time: 1s but no marker {not json}" }),
			fnCall("mcp__codex_apps__linear", "_fetch", "c2"),
			// array form whose first element is not a {type:text} block → unwrapTextEnvelope returns the array as-is → adapter rejects
			raw({ type: "function_call_output", call_id: "c2", output: JSON.stringify([{ notText: 1 }]) }),
			fnCall("mcp__codex_apps__linear", "_fetch", "c3"),
			// array form whose text is not valid JSON → unwrapTextEnvelope returns the array as-is
			raw({
				type: "function_call_output",
				call_id: "c3",
				output: JSON.stringify([{ type: "text", text: "not json" }]),
			}),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
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
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
	});

	it("fallback event whose invocation.tool matches no registered source yields nothing", () => {
		const lines = [toolCallEnd("some_other_connector_fetch", "evt_unknown", LINEAR)];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
	});

	it("ignores a function_call whose namespace does not START with the shared codex_apps prefix", () => {
		// The namespace value below still contains the "mcp__codex_apps__" substring
		// (so it clears the envelope's cheap per-line pre-filter) but doesn't START
		// with it — resolveCodexDef must reject on the anchored prefix check rather
		// than a loose substring match.
		const lines = [
			fnCall("not_mcp__codex_apps__linear", "_fetch", "c_wrongns"),
			fnOutput("c_wrongns", LINEAR, { wrap: "array", prefix: true }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
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
		const { results } = codexEnvelopeParser.parse(lines, {});
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
		const { results } = codexEnvelopeParser.parse(lines, {});
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
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1); // only the completed linear call
		// Cursor is held at the in-flight request's line index (2), NOT EOF (3).
		expect(lastLineNumberScanned).toBe(2);
	});

	it("recovers the ref on the next poll once the output arrives (two-pass straddle)", () => {
		// Pass 1: only the request is present → nothing emitted, cursor held at 0.
		const pass1 = [fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "j1")];
		const r1 = codexEnvelopeParser.parse(pass1, {});
		expect(r1.results).toHaveLength(0);
		expect(r1.lastLineNumberScanned).toBe(0);

		// Pass 2: request + now-written output, resumed from the held cursor (0).
		const pass2 = [
			fnCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue", "j1"),
			fnOutput("j1", JIRA_WRAPPED, { wrap: "bare", prefix: false }),
		];
		const r2 = codexEnvelopeParser.parse(pass2, { fromLineNumber: r1.lastLineNumberScanned });
		expect(r2.results).toHaveLength(1);
		expect(r2.results[0].def.id).toBe("jira");
		expect(r2.lastLineNumberScanned).toBe(2);
	});

	it("does NOT hold the cursor for a non-fetch request, or one satisfied by an event", () => {
		const lines = [
			fnCall("mcp__codex_apps__linear", "_list_teams", "nonfetch"), // not a fetch → never holds
			fnCall("mcp__codex_apps__linear", "_fetch", "byEvent"),
			toolCallEnd("linear_fetch", "byEvent", LINEAR), // satisfied via event, no output
		];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {});
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
		const { results } = codexEnvelopeParser.parse(lines, { beforeTimestamp: "2026-06-05T10:30:00.000Z" });
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
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {
			beforeTimestamp: "2026-06-05T10:30:00.000Z",
		});
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
			// A dedicated getJiraIssue with only `self` (no webUrl), via the real
			// `atlassian_rovo.getJiraIssue` event — captured with self mapped to url.
			toolCallEnd("atlassian_rovo.getJiraIssue", "c_jira_nourl", JIRA_BARE_NO_URL),
		];
		writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("extracts correct refs for all four sources through the unchanged adapters", async () => {
		const { references } = await extractReferencesFromTranscript(file, { source: "codex" });
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

		// The getJiraIssue with only `self` is now captured, with `self` as its url
		// (the api.atlassian.com endpoint — no browsable link is available).
		expect(byKey.get("jira:KAN-9")?.url).toBe("https://api.atlassian.com/ex/jira/29e34fb0/rest/api/3/issue/10099");
	});
});

describe("CodexEnvelopeParser — Zoom meeting connector", () => {
	it("emits a zoom-meeting ref via the PRIMARY function_call pair (identity normalize)", () => {
		const lines = [
			fnCall("mcp__codex_apps__zoom", "_get_meeting_assets", "c_zoom"),
			fnOutput("c_zoom", ZOOM_MEETING, { wrap: "bare", prefix: true }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("zoom-meeting");
		expect(results[0].toolName).toBe("mcp__claude_ai_Zoom_for_Claude__get_meeting_assets");
	});

	it("recovers a zoom-meeting ref from the mcp_tool_call_end event when the output is malformed", () => {
		// Real 2026-07-13 case: on a long meeting the function_call_output is invalid
		// JSON (a bad escape mid-transcript), but the paired event carries a complete,
		// valid copy that already includes the URLs — no `recover` hook is needed.
		const lines = [
			fnCall("mcp__codex_apps__zoom", "_get_meeting_assets", "c_zoom_bad"),
			fnOutputRaw("c_zoom_bad", `Wall time: 10.06s\nOutput:\n{"topic":"US/China sync",bad json`),
			toolCallEnd("zoom.get_meeting_assets", "c_zoom_bad", ZOOM_MEETING),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("zoom-meeting");
	});

	it("ignores zoom enumeration / recording-resource connector calls", () => {
		const lines = [
			fnCall("mcp__codex_apps__zoom", "_search_meetings", "c_zsearch"),
			fnOutput("c_zsearch", { meetings: [] }, { wrap: "bare", prefix: true }),
			fnCall("mcp__codex_apps__zoom", "_get_recording_resource", "c_zrec"),
			fnOutput("c_zrec", { recording: {} }, { wrap: "bare", prefix: true }),
		];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
	});
});

describe("CodexEnvelopeParser end-to-end — Zoom meeting fallback path via extractReferencesFromTranscript", () => {
	let dir: string;
	let file: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "codex-zoom-"));
		file = join(dir, "rollout.jsonl");
		const lines = [
			fnCall("mcp__codex_apps__zoom", "_get_meeting_assets", "c_zoom_e2e"),
			fnOutputRaw("c_zoom_e2e", `Wall time: 10.06s\nOutput:\n{"topic":"US/China sync",bad json`),
			toolCallEnd("zoom.get_meeting_assets", "c_zoom_e2e", ZOOM_MEETING),
		];
		writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("extracts the meeting ref (title, summary-doc url, mapKey) through the unchanged definition", async () => {
		const { references } = await extractReferencesFromTranscript(file, { source: "codex" });
		const zoom = references.find((r) => r.mapKey === "zoom-meeting:CB9D57D1-D6B0-4ECC-A6C2-E00449DF9B8D");
		expect(zoom).toBeDefined();
		expect(zoom?.title).toBe("US/China sync meeting");
		expect(zoom?.url).toBe("https://docs.zoom.us/doc/BL6P4Z-qRv-5Tpj3svUONw");
		expect(zoom?.description).toContain("Quick recap");
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
		const { references } = await extractReferencesFromTranscript(file, { source: "codex" });
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
			toolCallEnd("atlassian_rovo.getJiraIssue", "j1", {
				key: "KAN-7",
				self: "https://api.atlassian.com/ex/jira/x/rest/api/3/issue/10099",
				versionedRepresentations: { summary: { "1": "Recovered jira summary" } },
			}),
		];
		writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("recovers a jira ref by stitching the valid event with webUrl salvaged from the malformed output", async () => {
		const { references } = await extractReferencesFromTranscript(file, { source: "codex" });
		const jira = references.find((r) => r.mapKey === "jira:KAN-7");
		expect(jira).toBeDefined();
		expect(jira?.title).toBe("Recovered jira summary");
		expect(jira?.url).toBe("https://acme.atlassian.net/browse/KAN-7");
	});
});

// ─── shell CLI (`gh issue view … --json`) ────────────────────────────────────

/** shell_command request row: NO namespace; the command is inside the JSON-string `arguments`. */
function shellCall(command: string, callId: string): string {
	return jsonl({
		type: "response_item",
		timestamp: TS,
		payload: {
			type: "function_call",
			name: "shell_command",
			arguments: JSON.stringify({ command, workdir: "e:\\jollimemory-3", timeout_ms: 20000 }),
			call_id: callId,
		},
	});
}

/** shell function_call_output: real prefix `Exit code: N\nWall time: …\nOutput:\n<json>`. */
function shellOutput(callId: string, inner: unknown, exitCode = 0): string {
	const output = `Exit code: ${exitCode}\nWall time: 2.1 seconds\nOutput:\n${JSON.stringify(inner)}`;
	return jsonl({
		type: "response_item",
		timestamp: TS,
		payload: { type: "function_call_output", call_id: callId, output },
	});
}

/** Real `gh issue view 959 --json …` payload (single issue, uppercase state). */
const GH_CLI = {
	number: 959,
	title: "Support multi-source external entity auto-discovery",
	state: "CLOSED",
	url: "https://github.com/jolliai/jolli/issues/959",
	body: "Body text",
	labels: [{ name: "enhancement" }],
	assignees: [{ login: "sanshizhang-jolli" }],
};
const GH_VIEW_CMD = "gh issue view 959 --repo jolliai/jolli --json number,title,state,labels,assignees,body,url";

describe("CodexEnvelopeParser.parse — shell CLI (gh issue view)", () => {
	it("emits a github ref from a shell gh issue view pair (canonical toolName, exit 0)", () => {
		const lines = [shellCall(GH_VIEW_CMD, "c_sh"), shellOutput("c_sh", GH_CLI, 0)];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("github");
		expect(results[0].toolName).toBe("mcp__github__issue_read");
	});

	it("drops a failed command (non-zero exit) even when stdout is valid issue JSON", () => {
		const lines = [shellCall(GH_VIEW_CMD, "c_fail"), shellOutput("c_fail", GH_CLI, 1)];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
	});

	it("ignores a non-gh shell command", () => {
		const lines = [shellCall("npm test", "c_npm"), shellOutput("c_npm", GH_CLI, 0)];
		const { results } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
	});

	it("ignores a shell call whose `arguments` are not parseable JSON (no command extracted)", () => {
		const badCall = jsonl({
			type: "response_item",
			timestamp: TS,
			payload: { type: "function_call", name: "shell_command", arguments: "{not json", call_id: "c_bad" },
		});
		const { results } = codexEnvelopeParser.parse([badCall, shellOutput("c_bad", GH_CLI, 0)], {});
		expect(results).toHaveLength(0);
	});

	it("drops a gh shell pair whose exit-0 stdout is not JSON", () => {
		const out = jsonl({
			type: "response_item",
			timestamp: TS,
			payload: {
				type: "function_call_output",
				call_id: "c_txt",
				output: "Exit code: 0\nWall time: 1s\nOutput:\nnot json",
			},
		});
		const { results } = codexEnvelopeParser.parse([shellCall(GH_VIEW_CMD, "c_txt"), out], {});
		expect(results).toHaveLength(0);
	});

	it("drops a gh shell pair whose output lacks the `Exit code:` prefix (treated as not-success)", () => {
		const out = jsonl({
			type: "response_item",
			timestamp: TS,
			payload: { type: "function_call_output", call_id: "c_nopfx", output: JSON.stringify(GH_CLI) },
		});
		const { results } = codexEnvelopeParser.parse([shellCall(GH_VIEW_CMD, "c_nopfx"), out], {});
		expect(results).toHaveLength(0);
	});

	it("holds the cursor before an in-flight shell gh request (output not yet written)", () => {
		const lines = ["{}", shellCall(GH_VIEW_CMD, "c_inflight")];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(0);
		// safeCursor pinned to the request's 0-based line index (1), not EOF (2).
		expect(lastLineNumberScanned).toBe(1);
	});

	it("advances the cursor once the in-flight shell output lands on the next poll", () => {
		const lines = ["{}", shellCall(GH_VIEW_CMD, "c_inflight"), shellOutput("c_inflight", GH_CLI, 0)];
		const { results, lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(lastLineNumberScanned).toBe(3);
	});

	it("holds the cursor at the EARLIEST of multiple in-flight shell requests", () => {
		const lines = ["{}", shellCall(GH_VIEW_CMD, "c1"), shellCall(GH_VIEW_CMD, "c2")];
		const { lastLineNumberScanned } = codexEnvelopeParser.parse(lines, {});
		expect(lastLineNumberScanned).toBe(1); // pinned to c1's line, not lowered again by c2
	});

	it("ignores a shell call whose `arguments` is not a string", () => {
		const badCall = jsonl({
			type: "response_item",
			timestamp: TS,
			payload: { type: "function_call", name: "shell_command", arguments: 42, call_id: "c_numargs" },
		});
		const { results } = codexEnvelopeParser.parse([badCall, shellOutput("c_numargs", GH_CLI, 0)], {});
		expect(results).toHaveLength(0);
	});
});

describe("CodexEnvelopeParser end-to-end — shell gh issue view (state lowercased, dedupe with MCP search)", () => {
	let dir: string;
	let file: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "codex-ghcli-"));
		file = join(dir, "rollout.jsonl");
		// The connector searched first (sparse hit), then ran gh to backfill — gh
		// appears LATER, so it wins the same-mapKey dedupe in the realistic flow.
		const lines = [
			fnCall("mcp__codex_apps__github", "_search_issues", "c_search"),
			fnOutput("c_search", GITHUB_SEARCH, { wrap: "bare", prefix: true }),
			shellCall(GH_VIEW_CMD, "c_sh"),
			shellOutput("c_sh", GH_CLI, 0),
		];
		writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("dedupes gh + MCP search to one rich ref with lowercased state", async () => {
		const { references } = await extractReferencesFromTranscript(file, { source: "codex" });
		const gh = references.filter((r) => r.mapKey === "github:jolliai/jolli#959");
		expect(gh).toHaveLength(1);
		expect(gh[0].fields?.find((f) => f.key === "status")?.value).toBe("closed");
		expect(gh[0].fields?.some((f) => f.key === "labels")).toBe(true);
	});
});
