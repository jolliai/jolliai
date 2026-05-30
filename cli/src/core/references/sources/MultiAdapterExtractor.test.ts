/**
 * MultiAdapterExtractor tests — exercise `extractReferencesFromTranscript` as the
 * generalised, adapter-driven entry point. The legacy `extractReferencesFromTranscript`
 * tests (`../LinearIssueExtractor.test.ts`) cover Linear-projection behaviour exhaustively;
 * this file pins the new contract:
 *   - same fixture produces the same number of refs whether read via the legacy
 *     wrapper or the generic entry point
 *   - `Reference` carries `source`, `mapKey`, `nativeId` per the SourceAdapter contract
 *   - dedupe keys off `mapKey` (so two adapters with the same nativeId would coexist)
 *   - `toLinearIssueRef` projection drops the multi-source fields
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readFile: mockReadFile };
});

import { extractReferencesFromTranscript } from "../ReferenceExtractor.js";
import { ALL_ADAPTERS } from "./index.js";
import { LinearAdapter } from "./LinearAdapter.js";

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

const SAMPLE_ISSUE = {
	id: "PROJ-7",
	title: "Multi-adapter extractor",
	url: "https://linear.app/x/PROJ-7",
	description: "## Body\n\nMulti-source plumbing.",
	status: "In Progress",
	priority: { name: "Medium" },
	labels: ["adapter"],
};

const SAMPLE_ISSUE_2 = {
	id: "PROJ-8",
	title: "Second issue",
	url: "https://linear.app/x/PROJ-8",
	description: "Second body",
};

function makeJsonl(...lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

beforeEach(() => {
	mockReadFile.mockReset();
});

describe("ALL_ADAPTERS", () => {
	it("contains LinearAdapter as its first entry (Phase 1)", () => {
		expect(ALL_ADAPTERS).toContain(LinearAdapter);
		expect(ALL_ADAPTERS[0].id).toBe("linear");
	});
});

describe("extractReferencesFromTranscript", () => {
	it("produces the same number of refs as the legacy Linear wrapper for the same fixture", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_1",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-26T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_1",
				timestamp: "2026-05-26T06:00:01.000Z",
				payload: SAMPLE_ISSUE,
			}),
			toolUseLine({
				toolUseId: "toolu_2",
				toolName: "mcp__linear__list_issues",
				timestamp: "2026-05-26T06:00:02.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_2",
				timestamp: "2026-05-26T06:00:03.000Z",
				payload: [SAMPLE_ISSUE_2],
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(2);
	});

	it("populates Reference with source='linear', mapKey='linear:<id>', nativeId=<id>", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_1",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-26T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_1",
				timestamp: "2026-05-26T06:00:01.000Z",
				payload: SAMPLE_ISSUE,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references, lastLineNumberScanned } = await extractReferencesFromTranscript("/fake.jsonl", [
			LinearAdapter,
		]);

		expect(references).toHaveLength(1);
		expect(references[0]).toMatchObject({
			source: "linear",
			mapKey: "linear:PROJ-7",
			nativeId: "PROJ-7",
			title: SAMPLE_ISSUE.title,
			url: SAMPLE_ISSUE.url,
			status: "In Progress",
			priority: "Medium",
			labels: ["adapter"],
			toolName: "mcp__linear__get_issue",
			referencedAt: "2026-05-26T06:00:01.000Z",
		});
		expect(lastLineNumberScanned).toBe(2);
	});

	it("dedupes by mapKey when the same ticket is referenced twice, keeping the latest referencedAt", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_old",
				toolName: "mcp__linear__list_issues",
				timestamp: "2026-05-26T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_old",
				timestamp: "2026-05-26T06:00:01.000Z",
				payload: [{ id: "PROJ-7", title: "old", url: SAMPLE_ISSUE.url }],
			}),
			toolUseLine({
				toolUseId: "toolu_new",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-26T07:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_new",
				timestamp: "2026-05-26T07:00:01.000Z",
				payload: SAMPLE_ISSUE,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(1);
		// All collected entries share mapKey "linear:PROJ-7"; the keep-latest dedupe must
		// retain the entry whose referencedAt is greater.
		expect(references[0].mapKey).toBe("linear:PROJ-7");
		expect(references[0].referencedAt).toBe("2026-05-26T07:00:01.000Z");
		expect(references[0].title).toBe(SAMPLE_ISSUE.title);
	});

	it("returns empty list when no adapter matches any line", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_gh",
				toolName: "mcp__github__search_issues",
				timestamp: "2026-05-26T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_gh",
				timestamp: "2026-05-26T06:00:01.000Z",
				payload: SAMPLE_ISSUE,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter]);

		expect(references).toHaveLength(0);
	});

	it("returns empty + lastLineNumberScanned=0 when transcript is missing", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));

		const { references, lastLineNumberScanned } = await extractReferencesFromTranscript("/missing.jsonl", [
			LinearAdapter,
		]);

		expect(references).toHaveLength(0);
		expect(lastLineNumberScanned).toBe(0);
	});

	it("uses ALL_ADAPTERS as a valid adapter list", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_1",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-26T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_1",
				timestamp: "2026-05-26T06:00:01.000Z",
				payload: SAMPLE_ISSUE,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", ALL_ADAPTERS);

		expect(references).toHaveLength(1);
		expect(references[0].source).toBe("linear");
	});

	it("respects beforeTimestamp cutoff (covers the option path through the generic loop)", async () => {
		const jsonl = makeJsonl(
			toolUseLine({
				toolUseId: "toolu_early",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-26T06:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_early",
				timestamp: "2026-05-26T06:00:01.000Z",
				payload: SAMPLE_ISSUE,
			}),
			toolUseLine({
				toolUseId: "toolu_late",
				toolName: "mcp__linear__get_issue",
				timestamp: "2026-05-26T07:00:00.000Z",
			}),
			toolResultLine({
				toolUseId: "toolu_late",
				timestamp: "2026-05-26T07:00:01.000Z",
				payload: SAMPLE_ISSUE_2,
			}),
		);
		mockReadFile.mockResolvedValue(jsonl);

		const { references } = await extractReferencesFromTranscript("/fake.jsonl", [LinearAdapter], {
			beforeTimestamp: "2026-05-26T06:30:00.000Z",
		});

		expect(references).toHaveLength(1);
		expect(references[0].nativeId).toBe("PROJ-7");
	});
});
