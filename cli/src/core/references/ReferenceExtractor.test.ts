import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readFile: mockReadFile };
});

import type { Reference } from "../../Types.js";
import { extractReferencesFromTranscript } from "./ReferenceExtractor.js";
import { LinearAdapter } from "./sources/LinearAdapter.js";
import type { SourceAdapter } from "./sources/SourceAdapter.js";

const fieldVal = (r: Reference | null | undefined, key: string): string | undefined =>
	r?.fields?.find((f) => f.key === key)?.value;

// ─── Fixture builders ────────────────────────────────────────────────────────

function toolUseLine(opts: {
	toolUseId: string;
	toolName: string;
	timestamp: string;
	isSidechain?: boolean;
	inputJson?: string;
}): string {
	const input = opts.inputJson ?? '{"id":"PROJ-1528"}';
	return JSON.stringify({
		isSidechain: opts.isSidechain ?? false,
		message: {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: opts.toolUseId,
					name: opts.toolName,
					input: JSON.parse(input),
				},
			],
		},
		timestamp: opts.timestamp,
	});
}

function toolResultLine(opts: { toolUseId: string; timestamp: string; payload: object | object[] | string }): string {
	const payloadText = typeof opts.payload === "string" ? opts.payload : JSON.stringify(opts.payload);
	return JSON.stringify({
		isSidechain: false,
		type: "user",
		message: {
			role: "user",
			content: [
				{
					tool_use_id: opts.toolUseId,
					type: "tool_result",
					content: [{ type: "text", text: payloadText }],
				},
			],
		},
		timestamp: opts.timestamp,
	});
}

const SAMPLE_ISSUE_PAYLOAD = {
	id: "PROJ-1528",
	title: "Treat referenced Linear issues as a first-class panel item",
	description: "## Problem\n\nLinear issues are high-density context.",
	status: "In Progress",
	priority: { value: 0, name: "No priority" },
	labels: ["JolliMemory", "Feature"],
	url: "https://linear.app/jolliai/issue/PROJ-1528/treat-referenced-linear-issues",
};

const SAMPLE_ISSUE_PAYLOAD_2 = {
	id: "PROJ-1404",
	title: "Include active Plans/Notes as input",
	description: "## Problem\n\nPlans/Notes not in summarize.",
	status: "Backlog",
	priority: { value: 2, name: "High" },
	labels: ["Feature"],
	url: "https://linear.app/jolliai/issue/PROJ-1404/include-active-plans-notes",
};

function makeJsonl(...lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

beforeEach(() => {
	mockReadFile.mockReset();
});

// ─── extractReferencesFromTranscript ───────────────────────────────────────

describe("extractReferencesFromTranscript", () => {
	it("extracts a single get_issue payload as one ref with full description", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_1",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:06:00.228Z",
			}),
			toolResultLine({
				toolUseId: "toolu_1",
				timestamp: "2026-05-14T06:06:01.123Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references, lastLineNumberScanned } = await extractReferencesFromTranscript("/fake.jsonl", [
			LinearAdapter,
		]);

		expect(references).toHaveLength(1);
		expect(references[0]).toMatchObject({
			nativeId: "PROJ-1528",
			title: SAMPLE_ISSUE_PAYLOAD.title,
			url: SAMPLE_ISSUE_PAYLOAD.url,
			toolName: "mcp__linear__get_issue",
			referencedAt: "2026-05-14T06:06:01.123Z",
		});
		expect(fieldVal(references[0], "status")).toBe("In Progress");
		expect(fieldVal(references[0], "priority")).toBe("No priority");
		expect(fieldVal(references[0], "labels")).toBe("JolliMemory, Feature");
		expect(references[0].description).toContain("Linear issues are high-density");
		expect(lastLineNumberScanned).toBe(2);
	});

	it("extracts all issues from a list_issues array result, preserving order", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_2",
				toolName: "mcp__linear__list_issues",
				timestamp: "2026-05-14T06:00:00.000Z",
				inputJson: '{"team":"Jolli"}',
			}),
			toolResultLine({
				toolUseId: "toolu_2",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: [SAMPLE_ISSUE_PAYLOAD, SAMPLE_ISSUE_PAYLOAD_2],
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references.map((i) => i.nativeId)).toEqual(["PROJ-1528", "PROJ-1404"]);
		expect(references.every((i) => i.toolName === "mcp__linear__list_issues")).toBe(true);
	});

	it("dedupes same nativeId across multiple references, keeping the latest referencedAt", async () => {
		const jsonl = makeJsonl(
			// First: list result (no description)
			toolUseLine({
				toolUseId: "toolu_list",
				toolName: "mcp__linear__list_issues",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_list",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: [{ id: "PROJ-1528", title: "old title", url: SAMPLE_ISSUE_PAYLOAD.url }],
			}),
			// Then: get_issue with full description, later timestamp
			toolUseLine({
				toolUseId: "toolu_get",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T07:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_get",
				timestamp: "2026-05-14T07:00:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
		expect(references[0].title).toBe(SAMPLE_ISSUE_PAYLOAD.title);
		expect(references[0].referencedAt).toBe("2026-05-14T07:00:01.000Z");
		expect(references[0].description).toContain("Linear issues are high-density");
	});

	it("silently drops a tool_use that has no matching tool_result", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_orphan",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			// no tool_result line for toolu_orphan
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(0);
	});

	it("skips tool_result whose text is not valid JSON without throwing", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_bad",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_bad",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: "{not valid json",
			}),
			toolUseLine({
				toolUseId: "toolu_good",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:01:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_good",
				timestamp: "2026-05-14T06:01:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
		expect(references[0].nativeId).toBe("PROJ-1528");
	});

	it("filters out payloads whose shape does not match an issue (e.g. list_teams)", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_teams",
				toolName: "mcp__linear__list_teams",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_teams",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: [
					{ id: "team-uuid-1", name: "Jolli", key: "JOL" }, // not a Linear issue shape
					{ id: "team-uuid-2", name: "Other", key: "OTH" },
				],
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(0);
	});

	it("ignores non-Linear MCP tools via the mcp__linear__ prefix gate", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_gh",
				toolName: "mcp__github__search_issues",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_gh",
				timestamp: "2026-05-14T06:00:01.000Z",
				// even though this payload has issue-like shape, the tool name fails the prefix gate
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(0);
	});

	it("respects beforeTimestamp cutoff, dropping tool_results after the cutoff", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_early",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_early",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
			toolUseLine({
				toolUseId: "toolu_late",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T07:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_late",
				timestamp: "2026-05-14T07:00:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD_2,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter], {
			beforeTimestamp: "2026-05-14T06:30:00.000Z",
		});

		expect(references).toHaveLength(1);
		expect(references[0].nativeId).toBe("PROJ-1528");
	});

	it("starts scanning from fromLineNumber and reports lastLineNumberScanned", async () => {
		const earlyLines = Array.from({ length: 90 }, () =>
			JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "noise" }] } }),
		);
		const jsonl = makeJsonl(
			...earlyLines,
			toolUseLine({
				toolUseId: "toolu_new",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_new",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references, lastLineNumberScanned } = await extractReferencesFromTranscript(
			"/fake.jsonl",
			[LinearAdapter],
			{
				fromLineNumber: 90,
			},
		);

		expect(references).toHaveLength(1);
		expect(lastLineNumberScanned).toBe(92);
	});

	it("does NOT filter out sidechain (subagent) entries — they still count as references", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_sub",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
				isSidechain: true,
			}),
			toolResultLine({
				toolUseId: "toolu_sub",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
	});

	it("handles edge case: tool_result payload contains literal 'name:mcp__linear__list_issues' string", async () => {
		// PROJ-1528 itself discusses MCP tool names in its description, which means a real Linear
		// payload can include the substring "name":"mcp__linear__list_issues". The two-tier filter
		// + role-based dispatch must classify this line as a tool_result (role=user), not as a
		// tool_use (which would require role=assistant). Otherwise we'd mis-handle the payload.
		const payloadWithToolNameLiteral = {
			...SAMPLE_ISSUE_PAYLOAD,
			description:
				'Reference the JSON `{"name":"mcp__linear__list_issues","input":{}}` literally in description.',
		};
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_self",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_self",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: payloadWithToolNameLiteral,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
		expect(references[0].description).toContain("mcp__linear__list_issues");
	});

	it("rejects payloads whose id does not match the Linear ticket format", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_bad_id",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_bad_id",
				timestamp: "2026-05-14T06:00:01.000Z",
				// id "12345" doesn't match /^[A-Z][A-Z0-9_]*-\d+$/
				payload: { id: "12345", title: "x", url: "https://linear.app/x" },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(0);
	});

	it("rejects payloads whose title is the empty string", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_empty_title",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_empty_title",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: { id: "PROJ-1", title: "", url: "https://linear.app/x/PROJ-1" },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);
		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);
		expect(references).toHaveLength(0);
	});

	it("rejects payloads whose url does not start with http:// or https://", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_bad_url",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_bad_url",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: { id: "PROJ-1", title: "x", url: "ftp://linear.app/x" },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(0);
	});

	it("handles payloads wrapped in {items: [...]} or {issues: [...]} forms", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_w",
				toolName: "mcp__linear__list_issues",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_w",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: { items: [SAMPLE_ISSUE_PAYLOAD], total: 1 },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
		expect(references[0].nativeId).toBe("PROJ-1528");
	});

	it("descends into object wrappers (e.g. {issues: {totalCount, nodes:[…]}})", async () => {
		// Jira's getJiraIssue returns `{issues: {totalCount, nodes:[…]}}` — the outer
		// `issues` key is an OBJECT, not an array. Linear's adapter has the same
		// wrapperKey `issues`, so the walker must descend into the inner object and
		// then find the `nodes` array below it. This exercises the object-wrapper
		// branch added in Phase 3 Task 3.1.
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_obj",
				toolName: "mcp__linear__list_issues",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_obj",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: { issues: { totalCount: 2, nodes: [SAMPLE_ISSUE_PAYLOAD, SAMPLE_ISSUE_PAYLOAD_2] } },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(2);
		expect(references.map((i) => i.nativeId).sort()).toEqual(["PROJ-1404", "PROJ-1528"]);
	});

	it("skips entries that aren't valid JSON without breaking the rest", async () => {
		const jsonl = makeJsonl(
			"this is not json",
			toolUseLine({
				toolUseId: "toolu_v",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_v",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
	});

	it("silently skips lines that look Linear-like but fail JSON.parse on the outer envelope", async () => {
		const jsonl = makeJsonl(
			// Contains "name":"mcp__linear__" substring but is malformed JSON
			'{"name":"mcp__linear__get_issue", broken json...',
			toolUseLine({
				toolUseId: "toolu_x",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_x",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
	});

	it("ignores entries whose role is neither assistant nor user even if they match the prefix", async () => {
		const systemLine = JSON.stringify({
			message: {
				role: "system",
				content: [{ type: "tool_use", id: "x", name: "mcp__linear__get_issue", input: {} }],
			},
			timestamp: "2026-05-14T06:00:00.000Z",
		});
		const jsonl = makeJsonl(
			systemLine,
			toolUseLine({
				toolUseId: "toolu_normal",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:01:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_normal",
				timestamp: "2026-05-14T06:01:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
	});

	it("returns empty when transcript file is missing or unreadable", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));

		const { references, lastLineNumberScanned } = await extractReferencesFromTranscript("/missing.jsonl", [
			LinearAdapter,
		]);

		expect(references).toHaveLength(0);
		expect(lastLineNumberScanned).toBe(0);
	});

	it("treats string priority (not object) as plain string", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_p",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_p",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: { ...SAMPLE_ISSUE_PAYLOAD, priority: "Urgent" },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(fieldVal(references[0], "priority")).toBe("Urgent");
	});

	it("treats priority object whose name is empty string as no-priority", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_p2",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_p2",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: { ...SAMPLE_ISSUE_PAYLOAD, priority: { value: 0, name: "" } },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);
		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);
		expect(fieldVal(references[0], "priority")).toBeUndefined();
	});

	it("drops labels array of non-strings, leaving labels undefined on the ref", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_l",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_l",
				timestamp: "2026-05-14T06:00:01.000Z",
				// labels is an array but contains only non-strings → filter empties it → labels undefined
				payload: { ...SAMPLE_ISSUE_PAYLOAD, labels: [123, null] },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);
		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);
		expect(fieldVal(references[0], "labels")).toBeUndefined();
	});

	it("dedup keeps the FIRST ref when same nativeId appears with an older referencedAt second", async () => {
		// Exercises the !== branch of the dedup keep-latest check
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_a",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T08:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_a",
				timestamp: "2026-05-14T08:00:01.000Z",
				payload: { ...SAMPLE_ISSUE_PAYLOAD, title: "newer" },
			}),
			toolUseLine({
				toolUseId: "toolu_b",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_b",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: { ...SAMPLE_ISSUE_PAYLOAD, title: "older" },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);
		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);
		expect(references).toHaveLength(1);
		expect(references[0].title).toBe("newer");
	});

	it("accepts a tool_result whose content is a direct string (not an array of text blocks)", async () => {
		// Some MCP servers emit content as a bare string. The extractor must handle both shapes.
		const toolUseLineStr = toolUseLine({
			toolUseId: "toolu_str",
			toolName: "mcp__linear__get_issue",
			timestamp: "2026-05-14T06:00:00.000Z",
		});
		// Hand-craft a tool_result with `content` as a plain string instead of [{type:"text", text:"..."}]
		const toolResultStringContent = JSON.stringify({
			isSidechain: false,
			type: "user",
			message: {
				role: "user",
				content: [
					{
						tool_use_id: "toolu_str",
						type: "tool_result",
						content: JSON.stringify(SAMPLE_ISSUE_PAYLOAD),
					},
				],
			},
			timestamp: "2026-05-14T06:00:01.000Z",
		});
		mockReadFile.mockResolvedValue(makeJsonl(toolUseLineStr, toolResultStringContent));

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);
		expect(references).toHaveLength(1);
		expect(references[0].nativeId).toBe("PROJ-1528");
	});

	it("handles a tool_use entry that has no timestamp field", async () => {
		// Forces readTimestamp's non-string branch + the `timestamp ?? \"\"` fallback in walkPayload dispatch.
		const toolUseWithoutTs = JSON.stringify({
			isSidechain: false,
			message: {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_no_ts",
						name: "mcp__linear__get_issue",
						input: { id: "PROJ-1528" },
					},
				],
			},
			// no timestamp field
		});
		const toolResultLineStr = toolResultLine({
			toolUseId: "toolu_no_ts",
			timestamp: "2026-05-14T06:00:01.000Z",
			payload: SAMPLE_ISSUE_PAYLOAD,
		});
		mockReadFile.mockResolvedValue(makeJsonl(toolUseWithoutTs, toolResultLineStr));

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);
		expect(references).toHaveLength(1);
	});

	it("skips an orphan tool_result whose tool_use_id does not match any pending Linear use", async () => {
		// A non-Linear tool_result (e.g. from a Bash call) appearing AFTER a Linear
		// tool_use is pending; substring pre-filter lets the line through (pending.size > 0 +
		// "tool_use_id" present) but pending.get returns undefined → continue branch fires.
		const linearUse = toolUseLine({
			toolUseId: "toolu_linear",
			toolName: "mcp__linear__get_issue",
			timestamp: "2026-05-14T06:00:00.000Z",
		});
		const unrelatedToolResult = JSON.stringify({
			isSidechain: false,
			type: "user",
			message: {
				role: "user",
				content: [
					{
						tool_use_id: "toolu_unrelated_bash",
						type: "tool_result",
						content: [{ type: "text", text: "bash output here" }],
					},
				],
			},
			timestamp: "2026-05-14T06:00:00.500Z",
		});
		const linearResult = toolResultLine({
			toolUseId: "toolu_linear",
			timestamp: "2026-05-14T06:00:01.000Z",
			payload: SAMPLE_ISSUE_PAYLOAD,
		});
		mockReadFile.mockResolvedValue(makeJsonl(linearUse, unrelatedToolResult, linearResult));

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);
		expect(references).toHaveLength(1);
	});

	it("drops a tool_result whose payload text is not valid JSON without leaving the pending entry orphaned", async () => {
		// Regression for the C2 bug: previously `pending.delete()` ran BEFORE
		// `JSON.parse(payloadText)`, so a corrupted payload silently lost the
		// pending entry. Now the delete runs only after walkPayload completes —
		// or, on parse failure, the catch branch deletes it explicitly so the
		// pending map doesn't grow unbounded across retries.
		const linearUse = toolUseLine({
			toolUseId: "toolu_bad",
			toolName: "mcp__linear__get_issue",
			timestamp: "2026-05-14T06:00:00.000Z",
		});
		const malformedPayload = toolResultLine({
			toolUseId: "toolu_bad",
			timestamp: "2026-05-14T06:00:00.500Z",
			payload: "not-json-{",
		});
		// A second, well-formed pair on a different tool_use_id still produces
		// an issue, proving the malformed payload didn't poison the scan state.
		const linearUse2 = toolUseLine({
			toolUseId: "toolu_good",
			toolName: "mcp__linear__get_issue",
			timestamp: "2026-05-14T06:00:01.000Z",
		});
		const goodPayload = toolResultLine({
			toolUseId: "toolu_good",
			timestamp: "2026-05-14T06:00:01.500Z",
			payload: SAMPLE_ISSUE_PAYLOAD,
		});
		mockReadFile.mockResolvedValue(makeJsonl(linearUse, malformedPayload, linearUse2, goodPayload));

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);
		expect(references).toHaveLength(1);
		expect(references[0].nativeId).toBe("PROJ-1528");
	});

	it("contains a throw from walkPayload to the offending tool_result and keeps scanning", async () => {
		// The module contract promises every payload walk is wrapped: a throw
		// from deep inside the walk (here a deliberately throwing adapter; in
		// the wild, a RangeError from a pathologically deep payload) must NOT
		// abort extraction for the whole transcript. The pending entry is
		// dropped and a later well-formed pair on a sane adapter still resolves.
		const throwingAdapter: SourceAdapter = {
			...LinearAdapter,
			extractRef(payload, toolName, referencedAt) {
				if ((payload as { id?: unknown }).id === SAMPLE_ISSUE_PAYLOAD.id) {
					throw new Error("boom from adapter");
				}
				return LinearAdapter.extractRef(payload, toolName, referencedAt);
			},
		};
		const badUse = toolUseLine({
			toolUseId: "toolu_throw",
			toolName: "mcp__linear__get_issue",
			timestamp: "2026-05-14T06:00:00.000Z",
		});
		const badPayload = toolResultLine({
			toolUseId: "toolu_throw",
			timestamp: "2026-05-14T06:00:00.500Z",
			payload: SAMPLE_ISSUE_PAYLOAD,
		});
		const goodUse = toolUseLine({
			toolUseId: "toolu_ok",
			toolName: "mcp__linear__get_issue",
			timestamp: "2026-05-14T06:00:01.000Z",
		});
		const goodPayload = toolResultLine({
			toolUseId: "toolu_ok",
			timestamp: "2026-05-14T06:00:01.500Z",
			payload: SAMPLE_ISSUE_PAYLOAD_2,
		});
		mockReadFile.mockResolvedValue(makeJsonl(badUse, badPayload, goodUse, goodPayload));

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [throwingAdapter]);
		expect(references).toHaveLength(1);
		expect(references[0].nativeId).toBe("PROJ-1404");
	});

	it("ignores a tool_use line whose role is reported as something other than assistant or user", async () => {
		const systemLine = JSON.stringify({
			message: {
				role: "system",
				content: [{ type: "tool_use", id: "toolu_sys", name: "mcp__linear__get_issue", input: {} }],
			},
			timestamp: "2026-05-14T06:00:00.000Z",
		});
		mockReadFile.mockResolvedValue(makeJsonl(systemLine));
		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);
		expect(references).toHaveLength(0);
	});

	it("treats missing priority/labels/status/description gracefully", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_min",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_min",
				timestamp: "2026-05-14T06:00:01.000Z",
				payload: { id: "PROJ-99", title: "minimal", url: "https://linear.app/x/PROJ-99" },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
		expect(references[0].description).toBeUndefined();
		expect(fieldVal(references[0], "status")).toBeUndefined();
		expect(fieldVal(references[0], "priority")).toBeUndefined();
		expect(fieldVal(references[0], "labels")).toBeUndefined();
	});

	it("skips a Linear-like line whose message.content is not an array", async () => {
		// readContentBlocks returns undefined when content is not an array → line is skipped.
		// The top-level `name` key makes the line satisfy the `"name":"mcp__linear__` substring
		// pre-filter so we exercise the non-array branch inside readContentBlocks.
		const nonArrayContentLine = JSON.stringify({
			name: "mcp__linear__get_issue",
			message: {
				role: "assistant",
				content: "stringified content instead of an array",
			},
			timestamp: "2026-05-14T06:00:00.000Z",
		});
		const jsonl = makeJsonl(
			nonArrayContentLine,
			toolUseLine({
				toolUseId: "toolu_after",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:01.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_after",
				timestamp: "2026-05-14T06:00:02.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
		expect(references[0].nativeId).toBe("PROJ-1528");
	});

	it("drops a tool_result whose timestamp is after the beforeTimestamp cutoff even though its tool_use was inside the window", async () => {
		// tool_use inside cutoff → enters pending. tool_result outside cutoff →
		// collectToolResults' beforeTimestamp guard returns before walkPayload.
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_split",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-14T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_split",
				timestamp: "2026-05-14T07:00:01.000Z",
				payload: SAMPLE_ISSUE_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter], {
			beforeTimestamp: "2026-05-14T06:30:00.000Z",
		});

		expect(references).toHaveLength(0);
	});

	it("accepts a tool_result without a timestamp field, falling back to empty referencedAt", async () => {
		// Forces the `timestamp ?? \"\"` fallback when forwarding to walkPayload.
		const toolUseLineStr = toolUseLine({
			toolUseId: "toolu_no_res_ts",
			toolName: "mcp__linear__get_issue",
			timestamp: "2026-05-14T06:00:00.000Z",
		});
		const toolResultNoTs = JSON.stringify({
			isSidechain: false,
			type: "user",
			message: {
				role: "user",
				content: [
					{
						tool_use_id: "toolu_no_res_ts",
						type: "tool_result",
						content: [{ type: "text", text: JSON.stringify(SAMPLE_ISSUE_PAYLOAD) }],
					},
				],
			},
			// no timestamp field on the tool_result
		});
		mockReadFile.mockResolvedValue(makeJsonl(toolUseLineStr, toolResultNoTs));

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
		expect(references[0].referencedAt).toBe("");
	});
});

// Local shim for the old formatLinearIssuesBlock surface — now delegates to
// LinearAdapter.renderPromptBlock so existing test assertions keep working.
function formatReferencesBlock(
	refs: ReadonlyArray<Reference>,
	opts: { maxCharsPerIssue?: number; maxTotalChars?: number } = {},
): string {
	const renderOpts: { maxCharsPerReference?: number; maxTotalChars?: number } = {};
	if (opts.maxCharsPerIssue !== undefined) renderOpts.maxCharsPerReference = opts.maxCharsPerIssue;
	if (opts.maxTotalChars !== undefined) renderOpts.maxTotalChars = opts.maxTotalChars;
	return LinearAdapter.renderPromptBlock(refs, renderOpts);
}

// ─── formatReferencesBlock ─────────────────────────────────────────────────

function makeRef(overrides: Partial<Reference> = {}): Reference {
	const base: Reference = {
		mapKey: "linear:PROJ-1528",
		source: "linear" as const,
		nativeId: "PROJ-1528",
		title: "Treat referenced Linear issues",
		url: "https://linear.app/jolliai/issue/PROJ-1528/",
		fields: [
			{ key: "status", label: "Status", value: "In Progress", icon: "circle-large-filled" },
			{ key: "priority", label: "Priority", value: "No priority", icon: "flame" },
			{ key: "labels", label: "Labels", value: "JolliMemory, Feature", icon: "tag" },
		],
		description: "## Problem\n\nLinear issues are high-density context.",
		toolName: "mcp__linear__get_issue",
		referencedAt: "2026-05-14T06:00:01.000Z",
	};
	return { ...base, ...overrides };
}

describe("formatReferencesBlock", () => {
	it("returns empty string when given empty array", () => {
		expect(formatReferencesBlock([])).toBe("");
	});

	it("renders one issue with full XML structure", () => {
		const out = formatReferencesBlock([makeRef()]);

		expect(out).toContain("<linear-issues>");
		expect(out).toContain("</linear-issues>");
		expect(out).toContain('id="PROJ-1528"');
		expect(out).toContain('status="In Progress"');
		expect(out).toContain('priority="No priority"');
		expect(out).toContain('labels="JolliMemory, Feature"');
		expect(out).toContain("<title>Treat referenced Linear issues</title>");
		expect(out).toContain("<url>https://linear.app/jolliai/issue/PROJ-1528/</url>");
		expect(out).toContain("<description>");
		expect(out).toContain("</description>");
		expect(out).toContain("Linear issues are high-density");
	});

	it("escapes XML-special characters in attributes and text", () => {
		const ref = makeRef({
			title: 'Title with <tag> & "quote"',
			description: "Body with </description> and <script>alert(1)</script>",
		});

		const out = formatReferencesBlock([ref]);

		expect(out).toContain('Title with &lt;tag&gt; &amp; "quote"');
		expect(out).toContain("&lt;/description&gt;");
		expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	it("preserves SUMMARIZE sentinel strings verbatim (defense is via prompt warning, not escape)", () => {
		const ref = makeRef({
			description: "Reviewer wants ===SUMMARY=== and ---TICKETID--- discussed inline.",
		});

		const out = formatReferencesBlock([ref]);

		expect(out).toContain("===SUMMARY===");
		expect(out).toContain("---TICKETID---");
	});

	it("truncates a single description over maxCharsPerIssue with a truncation suffix", () => {
		const longBody = "x".repeat(5000);
		const ref = makeRef({ description: longBody });

		const out = formatReferencesBlock([ref], { maxCharsPerIssue: 1000 });

		expect(out).toContain("…[truncated, ");
		expect(out.length).toBeLessThan(longBody.length + 1000); // truncation happened
	});

	it("enforces maxTotalChars by dropping oldest-referenced issues first", () => {
		const refs = [
			makeRef({
				nativeId: "PROJ-1",
				description: "x".repeat(2500),
				referencedAt: "2026-05-14T01:00:00.000Z",
			}),
			makeRef({
				nativeId: "PROJ-2",
				description: "y".repeat(2500),
				referencedAt: "2026-05-14T02:00:00.000Z",
			}),
			makeRef({
				nativeId: "PROJ-3",
				description: "z".repeat(2500),
				referencedAt: "2026-05-14T03:00:00.000Z",
			}),
		];

		const out = formatReferencesBlock(refs, {
			maxCharsPerIssue: 3000,
			maxTotalChars: 6000,
		});

		expect(out.length).toBeLessThanOrEqual(6500); // small wrapper budget
		expect(out).toContain('id="PROJ-3"'); // newest preserved
		expect(out).not.toContain('id="PROJ-1"'); // oldest dropped
	});

	it("returns empty when the budget is too small to fit even one issue", () => {
		const out = formatReferencesBlock([makeRef()], { maxCharsPerIssue: 100, maxTotalChars: 10 });
		expect(out).toBe("");
	});

	it("renders refs in ascending referencedAt order", () => {
		const refs = [
			makeRef({ nativeId: "PROJ-3", referencedAt: "2026-05-14T03:00:00.000Z" }),
			makeRef({ nativeId: "PROJ-1", referencedAt: "2026-05-14T01:00:00.000Z" }),
			makeRef({ nativeId: "PROJ-2", referencedAt: "2026-05-14T02:00:00.000Z" }),
		];

		const out = formatReferencesBlock(refs);

		const idx1 = out.indexOf('id="PROJ-1"');
		const idx2 = out.indexOf('id="PROJ-2"');
		const idx3 = out.indexOf('id="PROJ-3"');
		expect(idx1).toBeLessThan(idx2);
		expect(idx2).toBeLessThan(idx3);
	});

	it("omits optional fields cleanly when they are undefined", () => {
		const minimal = makeRef({
			fields: undefined,
			description: undefined,
		});

		const out = formatReferencesBlock([minimal]);

		expect(out).toContain('id="PROJ-1528"');
		expect(out).not.toContain("status=");
		expect(out).not.toContain("priority=");
		expect(out).not.toContain("labels=");
		expect(out).not.toContain("<description>");
	});
});
