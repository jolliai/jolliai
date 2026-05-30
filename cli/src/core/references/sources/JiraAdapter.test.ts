import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readFile: mockReadFile };
});

import type { Reference } from "../../../Types.js";
import { extractReferencesFromTranscript } from "../ReferenceExtractor.js";
import { JiraAdapter } from "./JiraAdapter.js";
import { unwrap } from "./TestHelpers.js";

// ─── Fixture builders ────────────────────────────────────────────────────────

function toolUseLine(opts: { toolUseId: string; toolName: string; timestamp: string }): string {
	return JSON.stringify({
		isSidechain: false,
		message: {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: opts.toolUseId,
					name: opts.toolName,
					input: {},
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

function makeJsonl(...lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

// Real KAN-4 payload shape (Atlassian getJiraIssue).
const KAN_4_PAYLOAD = {
	id: "10003",
	key: "KAN-4",
	fields: {
		summary: "Wire up Jira auto-discovery",
		status: { name: "To Do" },
		priority: { name: "Medium" },
		labels: ["JolliMemory", "Feature"],
		description: "## Body\n\nJira issues from the Atlassian MCP server.",
	},
	webUrl: "https://example.atlassian.net/browse/KAN-4",
};

const KAN_5_PAYLOAD = {
	id: "10004",
	key: "KAN-5",
	fields: {
		summary: "Second Jira ticket",
		status: { name: "In Progress" },
	},
	webUrl: "https://example.atlassian.net/browse/KAN-5",
};

beforeEach(() => {
	mockReadFile.mockReset();
});

// ─── Direct adapter tests ────────────────────────────────────────────────────

describe("JiraAdapter.extractRef", () => {
	const ts = "2026-05-27T00:00:00.000Z";
	const toolName = "mcp__claude_ai_Atlassian__getJiraIssue";

	it("extracts the real KAN-4 payload to an Reference", () => {
		const ref = JiraAdapter.extractRef(KAN_4_PAYLOAD, toolName, ts);
		expect(ref).toMatchObject({
			mapKey: "jira:KAN-4",
			source: "jira",
			nativeId: "KAN-4",
			title: "Wire up Jira auto-discovery",
			url: "https://example.atlassian.net/browse/KAN-4",
			status: "To Do",
			priority: "Medium",
			labels: ["JolliMemory", "Feature"],
			description: "## Body\n\nJira issues from the Atlassian MCP server.",
			toolName,
			referencedAt: ts,
		});
	});

	it("accepts status/priority as bare string values", () => {
		const ref = JiraAdapter.extractRef(
			{
				key: "KAN-7",
				fields: { summary: "x", status: "Done", priority: "High" },
				webUrl: "https://example.atlassian.net/browse/KAN-7",
			},
			toolName,
			ts,
		);
		expect(ref?.status).toBe("Done");
		expect(ref?.priority).toBe("High");
	});

	it("filters non-string and empty labels", () => {
		const ref = JiraAdapter.extractRef(
			{
				key: "KAN-9",
				fields: { summary: "x", labels: ["good", 42, "", null] },
				webUrl: "https://example.atlassian.net/browse/KAN-9",
			},
			toolName,
			ts,
		);
		expect(ref?.labels).toEqual(["good"]);
	});

	it("drops the labels field entirely when no valid strings remain", () => {
		const ref = JiraAdapter.extractRef(
			{
				key: "KAN-10",
				fields: { summary: "x", labels: [42, null] },
				webUrl: "https://example.atlassian.net/browse/KAN-10",
			},
			toolName,
			ts,
		);
		expect(ref?.labels).toBeUndefined();
	});

	it("returns null for non-object payloads", () => {
		expect(JiraAdapter.extractRef(null, toolName, ts)).toBeNull();
		expect(JiraAdapter.extractRef([], toolName, ts)).toBeNull();
		expect(JiraAdapter.extractRef("string", toolName, ts)).toBeNull();
		expect(JiraAdapter.extractRef(42, toolName, ts)).toBeNull();
	});

	it("rejects payloads with malformed Jira key", () => {
		const ref = JiraAdapter.extractRef(
			{ key: "not-a-key", fields: { summary: "x" }, webUrl: "https://example.atlassian.net/browse/x" },
			toolName,
			ts,
		);
		expect(ref).toBeNull();
	});

	it("rejects payloads with missing/empty summary", () => {
		expect(
			JiraAdapter.extractRef(
				{ key: "KAN-1", fields: { summary: "" }, webUrl: "https://example.atlassian.net/browse/KAN-1" },
				toolName,
				ts,
			),
		).toBeNull();
		expect(
			JiraAdapter.extractRef(
				{ key: "KAN-1", fields: {}, webUrl: "https://example.atlassian.net/browse/KAN-1" },
				toolName,
				ts,
			),
		).toBeNull();
	});

	it("rejects payloads with missing fields object", () => {
		const ref = JiraAdapter.extractRef(
			{ key: "KAN-1", webUrl: "https://example.atlassian.net/browse/KAN-1" },
			toolName,
			ts,
		);
		expect(ref).toBeNull();
	});

	it("rejects payloads with non-http url", () => {
		const ref = JiraAdapter.extractRef(
			{ key: "KAN-1", fields: { summary: "x" }, webUrl: "ftp://example.atlassian.net/browse/KAN-1" },
			toolName,
			ts,
		);
		expect(ref).toBeNull();
	});

	it("rejects payloads delivered under a non-Atlassian tool name (defense-in-depth)", () => {
		const ref = JiraAdapter.extractRef(KAN_4_PAYLOAD, "mcp__linear__get_issue", ts);
		expect(ref).toBeNull();
	});

	it("omits status/priority/description when missing or invalid types", () => {
		const ref = JiraAdapter.extractRef(
			{
				key: "KAN-11",
				fields: {
					summary: "x",
					status: { name: "" }, // empty name → undefined
					priority: { name: "" },
					description: "", // empty → undefined
				},
				webUrl: "https://example.atlassian.net/browse/KAN-11",
			},
			toolName,
			ts,
		);
		expect(ref?.status).toBeUndefined();
		expect(ref?.priority).toBeUndefined();
		expect(ref?.description).toBeUndefined();
	});

	it("omits status/priority when the field has neither object.name nor string value", () => {
		const ref = JiraAdapter.extractRef(
			{
				key: "KAN-12",
				fields: { summary: "x", status: { other: "field" }, priority: 42 },
				webUrl: "https://example.atlassian.net/browse/KAN-12",
			},
			toolName,
			ts,
		);
		expect(ref?.status).toBeUndefined();
		expect(ref?.priority).toBeUndefined();
	});
});

// ─── End-to-end extraction through walkPayload (object wrapper coverage) ─────

describe("JiraAdapter via extractReferencesFromTranscript", () => {
	it("extracts a single issue from a {issues:{nodes:[…]}} double wrapper", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_j",
				toolName: "mcp__claude_ai_Atlassian__getJiraIssue",
				timestamp: "2026-05-27T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_j",
				timestamp: "2026-05-27T06:00:01.000Z",
				payload: { issues: { totalCount: 1, nodes: [KAN_4_PAYLOAD] } },
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [JiraAdapter]);

		expect(references).toHaveLength(1);
		expect(references[0]).toMatchObject({
			mapKey: "jira:KAN-4",
			source: "jira",
			nativeId: "KAN-4",
			title: "Wire up Jira auto-discovery",
			status: "To Do",
		});
	});

	it("extracts a bare Jira issue payload (no wrapper)", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_bare",
				toolName: "mcp__claude_ai_Atlassian__getJiraIssue",
				timestamp: "2026-05-27T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_bare",
				timestamp: "2026-05-27T06:00:01.000Z",
				payload: KAN_4_PAYLOAD,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [JiraAdapter]);

		expect(references).toHaveLength(1);
		expect(references[0].nativeId).toBe("KAN-4");
	});
});

// ─── renderPromptBlock ───────────────────────────────────────────────────────

describe("JiraAdapter.renderPromptBlock", () => {
	const ts = "2026-05-27T00:00:00.000Z";
	const toolName = "mcp__claude_ai_Atlassian__getJiraIssue";

	it("emits <jira-issues> wrapper with attrs and body", () => {
		const ref = JiraAdapter.extractRef(KAN_4_PAYLOAD, toolName, ts);
		const out = JiraAdapter.renderPromptBlock([unwrap(ref)]);
		expect(out).toContain("<jira-issues>");
		expect(out).toContain("</jira-issues>");
		expect(out).toContain('id="KAN-4"');
		expect(out).toContain('status="To Do"');
		expect(out).toContain('priority="Medium"');
		expect(out).toContain('labels="JolliMemory, Feature"');
		expect(out).toContain("<title>Wire up Jira auto-discovery</title>");
		expect(out).toContain("<url>https://example.atlassian.net/browse/KAN-4</url>");
		expect(out).toContain("Jira issues from the Atlassian MCP server.");
	});

	it("returns empty string for empty input", () => {
		expect(JiraAdapter.renderPromptBlock([])).toBe("");
	});

	it("respects maxCharsPerReference (description truncated)", () => {
		const ref = JiraAdapter.extractRef(
			{
				key: "KAN-50",
				fields: { summary: "x", description: "x".repeat(5000) },
				webUrl: "https://example.atlassian.net/browse/KAN-50",
			},
			toolName,
			ts,
		);
		const out = JiraAdapter.renderPromptBlock([unwrap(ref)], { maxCharsPerReference: 1000 });
		expect(out).toContain("…[truncated, ");
	});

	it("returns empty when nothing fits the budget", () => {
		const ref = JiraAdapter.extractRef(
			{
				key: "KAN-51",
				fields: { summary: "x", description: "x".repeat(5000) },
				webUrl: "https://example.atlassian.net/browse/KAN-51",
			},
			toolName,
			ts,
		);
		expect(JiraAdapter.renderPromptBlock([unwrap(ref)], { maxTotalChars: 10 })).toBe("");
	});

	it("sorts ascending by referencedAt with both included when total fits", () => {
		const older = JiraAdapter.extractRef(KAN_4_PAYLOAD, toolName, "2026-01-01T00:00:00Z");
		const newer = JiraAdapter.extractRef(KAN_5_PAYLOAD, toolName, "2026-05-01T00:00:00Z");
		const out = JiraAdapter.renderPromptBlock([unwrap(older), unwrap(newer)]);
		expect(out.indexOf('id="KAN-4"')).toBeLessThan(out.indexOf('id="KAN-5"'));
	});

	it("drops the oldest when budget forces a choice", () => {
		const older = JiraAdapter.extractRef(
			{
				key: "KAN-100",
				fields: { summary: "older", description: "a".repeat(500) },
				webUrl: "https://example.atlassian.net/browse/KAN-100",
			},
			toolName,
			"2026-01-01T00:00:00Z",
		);
		const newer = JiraAdapter.extractRef(
			{
				key: "KAN-101",
				fields: { summary: "newer", description: "b".repeat(500) },
				webUrl: "https://example.atlassian.net/browse/KAN-101",
			},
			toolName,
			"2026-05-01T00:00:00Z",
		);
		const out = JiraAdapter.renderPromptBlock([unwrap(older), unwrap(newer)], { maxTotalChars: 700 });
		expect(out).toContain('id="KAN-101"');
		expect(out).not.toContain('id="KAN-100"');
	});

	it("skips labels attr when labels array is empty (hand-built ref)", () => {
		const ref: Reference = {
			mapKey: "jira:KAN-200",
			source: "jira",
			nativeId: "KAN-200",
			title: "x",
			url: "https://example.atlassian.net/browse/KAN-200",
			labels: [],
			toolName,
			referencedAt: ts,
		};
		const out = JiraAdapter.renderPromptBlock([ref]);
		expect(out).not.toContain("labels=");
	});

	it("renders minimal ref (no status/priority/labels/description)", () => {
		const ref = JiraAdapter.extractRef(
			{
				key: "KAN-300",
				fields: { summary: "Minimal" },
				webUrl: "https://example.atlassian.net/browse/KAN-300",
			},
			toolName,
			ts,
		);
		const out = JiraAdapter.renderPromptBlock([unwrap(ref)]);
		expect(out).toContain('<issue id="KAN-300">');
		expect(out).not.toContain("status=");
		expect(out).not.toContain("priority=");
		expect(out).not.toContain("labels=");
		expect(out).not.toContain("<description>");
	});
});

// ─── Adapter metadata ────────────────────────────────────────────────────────

describe("JiraAdapter metadata", () => {
	it("exposes id, mcpPrefix, wrapperKeys, maxCharsPerReference", () => {
		expect(JiraAdapter.id).toBe("jira");
		expect(JiraAdapter.mcpPrefix).toBe("mcp__claude_ai_Atlassian__");
		expect(JiraAdapter.wrapperKeys).toEqual(["nodes", "issues", "items", "results"]);
		expect(JiraAdapter.maxCharsPerReference).toBe(4000);
	});
});
