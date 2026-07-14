import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { symlinksSupported } from "../../testUtils/symlinkSupport.js";
import { claudeEnvelopeParser } from "./ClaudeEnvelopeParser.js";

// `symlinkSync` throws EPERM on a non-elevated Windows account, so skip the
// symlink-guard test there rather than fail the build (see symlinkSupport.ts).
const itIfSymlinks = symlinksSupported ? it : it.skip;

const PERMALINK = "https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009";
const BLOB =
	"=== THREAD PARENT MESSAGE ===\nMessage TS: 1783413984.700009\nConsolidate…\n\n=== THREAD REPLIES (2 total) ===\n";

function lines(): string[] {
	return [
		JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `look ${PERMALINK}` }] } }),
		JSON.stringify({
			message: {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "mcp__claude_ai_Slack__slack_read_thread",
						input: { channel_id: "C0BFF9UHBD1", message_ts: "1783413984.700009" },
					},
				],
			},
		}),
		JSON.stringify({
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ messages: BLOB }) }],
			},
		}),
	];
}

describe("ClaudeEnvelopeParser slack", () => {
	it("correlates the pasted permalink with the thread result", () => {
		const { results } = claudeEnvelopeParser.parse(lines(), {});
		expect(results).toHaveLength(1);
		const p = results[0].payload as { channelId: string; parentTs: string; url?: string };
		expect(results[0].def.id).toBe("slack");
		expect(p).toMatchObject({ channelId: "C0BFF9UHBD1", parentTs: "1783413984.700009", url: PERMALINK });
	});
	it("reconstructs url from slackWorkspaceUrl when no permalink pasted", () => {
		const noPermalink = lines().slice(1); // drop the user permalink line
		const { results } = claudeEnvelopeParser.parse(noPermalink, {
			slackWorkspaceUrl: "https://flyer-q4r7867.slack.com",
		});
		expect((results[0].payload as { url?: string }).url).toBe(PERMALINK);
	});
	it("emits a urlless canonical when neither permalink nor config present (extractRef voids it downstream)", () => {
		// The parser is a lower layer than extractRef: it still surfaces the
		// canonical thread object with no url. The slack definition marks url
		// required, so `SourceEngine.extractRef` is where this urlless payload
		// is voided (see slack.test.ts / SourceEngine.test.ts) — nothing is stored.
		const { results } = claudeEnvelopeParser.parse(lines().slice(1), {});
		expect((results[0].payload as { url?: string }).url).toBeUndefined();
	});
});

function zoomDocLines(): string[] {
	return [
		JSON.stringify({
			message: {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "z1",
						name: "mcp__claude_ai_Zoom_for_Claude__hub_get_file_content",
						input: { fileId: "y_sTD3ZsQv-o-f2pw3IQCA", format: "markdown" },
					},
				],
			},
		}),
		JSON.stringify({
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "z1",
						content: JSON.stringify({ file_name: "Doc Title", file_content: "body" }),
					},
				],
			},
		}),
	];
}

describe("ClaudeEnvelopeParser zoom-doc", () => {
	it("merges fileId from the tool_use input into the canonical payload", () => {
		const { results } = claudeEnvelopeParser.parse(zoomDocLines(), {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("zoom-doc");
		const p = results[0].payload as { fileId: string; url: string; title: string };
		expect(p.fileId).toBe("y_sTD3ZsQv-o-f2pw3IQCA");
		expect(p.url).toBe("https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA");
		expect(p.title).toBe("Doc Title");
	});
});

const MEETING_PAYLOAD = {
	meeting_uuid: "CB9D57D1-D6B0-4ECC-A6C2-E00449DF9B8D",
	topic: "US/China sync meeting",
	deep_url: "https://zoom.us/rec/share/xyz",
	start_time: "2026-07-09T01:30:00Z",
	meeting_number: 98668434129,
	meeting_summary: {
		summary_markdown: "## Quick recap\nRelease 1.0 planning.",
		summary_doc_url: "https://docs.zoom.us/doc/abc",
	},
};

/**
 * A `get_meeting_assets` exchange whose tool_result carries the given raw text
 * instead of JSON — used to drive the offload-recovery path with either a real
 * "Output has been saved to <path>" pointer or an arbitrary non-offload string.
 */
function meetingResultLines(resultContent: string): string[] {
	return [
		JSON.stringify({
			message: {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "m1",
						name: "mcp__claude_ai_Zoom_for_Claude__get_meeting_assets",
						input: { meetingId: "CB9D57D1-D6B0-4ECC-A6C2-E00449DF9B8D" },
					},
				],
			},
		}),
		JSON.stringify({
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "m1", content: resultContent }],
			},
		}),
	];
}

/** The harness pointer text, with the sentence period + schema hint that follow the path in real transcripts. */
function offloadPointer(savedPath: string): string {
	return `Error: result (119,792 characters) exceeds maximum allowed tokens. Output has been saved to ${savedPath}.\nFormat: JSON with schema: {topic: string, meeting_uuid: string, ...}`;
}

/**
 * The harness's SECOND offload format: the `<persisted-output>` wrapper used for
 * large (non-error) tool outputs like `hub_get_file_content` — "Output too large
 * (N KB). Full output saved to: <path>" on its own line, followed by a truncated
 * preview (no trailing period after the path). Distinct wording from the
 * oversized-error pointer above, so the recovery must recognise both.
 */
function persistedOutputPointer(savedPath: string): string {
	return `<persisted-output>\nOutput too large (65.2KB). Full output saved to: ${savedPath}\n\nPreview (first 2KB):\n{"topic":"US/Chin`;
}

/** Fresh temp dir with a `tool-results/` subdir mirroring Claude Code's offload layout. */
function freshToolResultsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "jolli-offload-"));
	const toolResults = join(dir, "tool-results");
	mkdirSync(toolResults);
	return toolResults;
}

function writeOffloadFile(body: string): string {
	const saved = join(freshToolResultsDir(), "mcp-claude_ai_Zoom_for_Claude-get_meeting_assets-123.txt");
	writeFileSync(saved, body);
	return saved;
}

describe("ClaudeEnvelopeParser oversized/offloaded tool result", () => {
	it("recovers the get_meeting_assets payload from the offloaded tool-results file", () => {
		const saved = writeOffloadFile(JSON.stringify(MEETING_PAYLOAD));
		const { results } = claudeEnvelopeParser.parse(meetingResultLines(offloadPointer(saved)), {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("zoom-meeting");
		const p = results[0].payload as { meeting_uuid: string; topic: string };
		expect(p.meeting_uuid).toBe("CB9D57D1-D6B0-4ECC-A6C2-E00449DF9B8D");
		expect(p.topic).toBe("US/China sync meeting");
	});

	it("recovers a payload offloaded via the <persisted-output> 'Output too large' format", () => {
		// Regression: `hub_get_file_content` (and other large non-error results)
		// come back wrapped in the `<persisted-output>` "Output too large … Full
		// output saved to: <path>" pointer, NOT the oversized-error pointer — the
		// recovery must match both wordings or the reference is silently dropped.
		const saved = writeOffloadFile(JSON.stringify(MEETING_PAYLOAD));
		const { results } = claudeEnvelopeParser.parse(meetingResultLines(persistedOutputPointer(saved)), {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("zoom-meeting");
		expect((results[0].payload as { meeting_uuid: string }).meeting_uuid).toBe(
			"CB9D57D1-D6B0-4ECC-A6C2-E00449DF9B8D",
		);
	});

	it("drops a non-offload malformed payload (no pointer to recover from)", () => {
		const { results } = claudeEnvelopeParser.parse(meetingResultLines("not json and no pointer"), {});
		expect(results).toHaveLength(0);
	});

	it("refuses a relative offload path", () => {
		const { results } = claudeEnvelopeParser.parse(meetingResultLines(offloadPointer("tool-results/x.txt")), {});
		expect(results).toHaveLength(0);
	});

	it("refuses a traversal offload path", () => {
		const saved = writeOffloadFile(JSON.stringify(MEETING_PAYLOAD));
		// Build the string by hand — `join(saved, "..", …)` would normalize the
		// `..` away and instead exercise the parent-dir guard. A literal `..`
		// keeps the pointer pointed at the `path.includes("..")` defense.
		const traversal = `${saved}/../../../etc/passwd`;
		const { results } = claudeEnvelopeParser.parse(meetingResultLines(offloadPointer(traversal)), {});
		expect(results).toHaveLength(0);
	});

	it("refuses an offload path outside the tool-results dir", () => {
		const dir = mkdtempSync(join(tmpdir(), "jolli-outside-"));
		const saved = join(dir, "mcp-get_meeting_assets.txt");
		writeFileSync(saved, JSON.stringify(MEETING_PAYLOAD));
		const { results } = claudeEnvelopeParser.parse(meetingResultLines(offloadPointer(saved)), {});
		expect(results).toHaveLength(0);
	});

	it("refuses when the offload path is a directory, not a file", () => {
		const toolResults = freshToolResultsDir();
		const { results } = claudeEnvelopeParser.parse(meetingResultLines(offloadPointer(toolResults)), {});
		expect(results).toHaveLength(0);
	});

	itIfSymlinks("refuses a symlinked offload file (lstat rejects the link)", () => {
		const realDir = mkdtempSync(join(tmpdir(), "jolli-symlink-"));
		const realFile = join(realDir, "payload.json");
		writeFileSync(realFile, JSON.stringify(MEETING_PAYLOAD));
		const link = join(freshToolResultsDir(), "mcp-get_meeting_assets-link.txt");
		symlinkSync(realFile, link);
		const { results } = claudeEnvelopeParser.parse(meetingResultLines(offloadPointer(link)), {});
		expect(results).toHaveLength(0);
	});

	it("refuses a tool-results segment that is not the immediate parent dir", () => {
		// `tool-results` present in the path, but the file sits one level deeper —
		// the containment requires it as the direct parent, not merely a segment.
		const nested = join(freshToolResultsDir(), "nested");
		mkdirSync(nested);
		const saved = join(nested, "payload.json");
		writeFileSync(saved, JSON.stringify(MEETING_PAYLOAD));
		const { results } = claudeEnvelopeParser.parse(meetingResultLines(offloadPointer(saved)), {});
		expect(results).toHaveLength(0);
	});

	it("refuses an offloaded file larger than the size cap", () => {
		const saved = writeOffloadFile(`0${"0".repeat(10 * 1024 * 1024)}`);
		const { results } = claudeEnvelopeParser.parse(meetingResultLines(offloadPointer(saved)), {});
		expect(results).toHaveLength(0);
	});

	it("drops when the offloaded file is missing or unparseable", () => {
		const missing = join(freshToolResultsDir(), "gone.txt");
		expect(claudeEnvelopeParser.parse(meetingResultLines(offloadPointer(missing)), {}).results).toHaveLength(0);
		const badJson = writeOffloadFile("{ not: valid json");
		expect(claudeEnvelopeParser.parse(meetingResultLines(offloadPointer(badJson)), {}).results).toHaveLength(0);
	});
});

describe("ClaudeEnvelopeParser monday", () => {
	const PAYLOAD = {
		board: { id: "18421599187", name: "Tasks" },
		items: [
			{
				id: "12511130115",
				name: "Add monday MCP integration",
				url: "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
				created_at: "2026-07-12T11:05:25Z",
				updated_at: "2026-07-14T08:30:22Z",
				item_description: {
					blocks: [{ content: '{"deltaFormat":[{"insert":"Use MCP to get monday task info."}]}' }],
				},
			},
		],
		pagination: { count: 1 },
	};
	const TOOL = "mcp__claude_ai_monday_com__get_board_items_page";

	function mondayLines(input: Record<string, unknown>): string[] {
		return [
			JSON.stringify({
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "m1", name: TOOL, input }],
				},
			}),
			JSON.stringify({
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "m1", content: JSON.stringify(PAYLOAD) }],
				},
			}),
		];
	}

	it("normalizes a targeted itemIds fetch into the { items } wrapper", () => {
		const { results } = claudeEnvelopeParser.parse(
			mondayLines({ boardId: 18421599187, itemIds: [12511130115] }),
			{},
		);
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("monday");
		const p = results[0].payload as { items: Array<{ id: string; description?: string }> };
		expect(p.items[0].id).toBe("12511130115");
		expect(p.items[0].description).toBe("Use MCP to get monday task info.");
	});

	it("produces nothing for a board browse (no itemIds)", () => {
		const { results } = claudeEnvelopeParser.parse(mondayLines({ boardId: 18421599187 }), {});
		expect(results.filter((r) => r.def.id === "monday")).toHaveLength(0);
	});
});
