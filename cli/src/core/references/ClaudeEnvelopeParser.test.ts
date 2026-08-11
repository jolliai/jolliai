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

describe("ClaudeEnvelopeParser context7 (arguments-derived, prose result)", () => {
	function context7Lines(toolName: string, id: string, input: Record<string, unknown>, resultText: string): string[] {
		return [
			JSON.stringify({
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id, name: toolName, input }],
				},
			}),
			JSON.stringify({
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: id, content: resultText }],
				},
			}),
		];
	}

	it("extracts one reference from a query-docs call whose result is markdown", () => {
		const lines = context7Lines(
			"mcp__context7__query-docs",
			"c7a",
			{ libraryId: "/vercel/next.js", query: "how does middleware work in the app router" },
			"### Real-world middleware example\n\nSource: https://github.com/vercel/next.js/blob/canary/examples/i18n-routing/middleware.ts\n\nA complete middleware.ts example…",
		);
		const { results } = claudeEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("context7");
		expect(results[0].payload).toEqual({
			libraryId: "/vercel/next.js",
			query: "how does middleware work in the app router",
		});
	});

	it("ignores resolve-library-id calls", () => {
		const lines = context7Lines(
			"mcp__context7__resolve-library-id",
			"c7r",
			{ libraryName: "Next.js", query: "middleware" },
			"Available Libraries:\n- /vercel/next.js",
		);
		expect(claudeEnvelopeParser.parse(lines, {}).results).toHaveLength(0);
	});
});

describe("ClaudeEnvelopeParser tail-rewind with an earlier abandoned call", () => {
	// Regression: a resultless call left behind EARLIER in the transcript (aborted
	// / errored) must not drag the tail-rewind target back below lastResultLineIndex
	// and thereby suppress the rewind of a genuinely-incomplete TAIL call. Before
	// the fix the rewind used the earliest pending tool_use ANYWHERE; the abandoned
	// call's low line index failed the `> lastResultLineIndex` guard, so the cursor
	// stayed at EOF and the tail context7 reference was stranded forever once its
	// result finally landed on a later scan.
	function assistantToolUse(id: string, input: Record<string, unknown>): string {
		return JSON.stringify({
			message: {
				role: "assistant",
				content: [{ type: "tool_use", id, name: "mcp__context7__query-docs", input }],
			},
		});
	}
	function userToolResult(id: string, text: string): string {
		return JSON.stringify({
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
		});
	}

	it("rewinds to the trailing incomplete call, not the earlier abandoned one", () => {
		const transcript = [
			assistantToolUse("old-abandoned", { libraryId: "/a/aborted", query: "never answered" }), // line 0, no result
			assistantToolUse("mid-paired", { libraryId: "/b/paired", query: "answered inline" }), // line 1
			userToolResult("mid-paired", "### docs\nSource: https://example.test/b"), // line 2 → lastResultLineIndex = 2
			assistantToolUse("tail-incomplete", { libraryId: "/c/tail", query: "result not flushed yet" }), // line 3
		];
		const { results, lastLineNumberScanned } = claudeEnvelopeParser.parse(transcript, {});
		// Only the mid pair produced a reference this scan.
		expect(results).toHaveLength(1);
		expect(results[0].payload).toEqual({ libraryId: "/b/paired", query: "answered inline" });
		// Cursor must rewind to the tail tool_use (line index 3) so the next scan
		// re-pairs it — NOT sit at EOF (4), which strands it forever.
		expect(lastLineNumberScanned).toBe(3);
	});
});

describe("ClaudeEnvelopeParser jollimemory (self-referential, arguments-derived)", () => {
	// Envelope shapes below are taken from real transcripts. Notably `recall` arrives
	// with `input: {}` (it takes no arguments) and its result is ALWAYS offloaded —
	// 72,378 chars observed, well past the tool-output cap — so the offload path is
	// this tool's normal case, not an edge case.
	function jmLines(toolName: string, id: string, input: Record<string, unknown>, resultText: string): string[] {
		return [
			JSON.stringify({
				message: { role: "assistant", content: [{ type: "tool_use", id, name: toolName, input }] },
			}),
			JSON.stringify({
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: resultText }] },
			}),
		];
	}

	/** The real offload wording for a recall result, verbatim apart from the path. */
	function recallOffloadPointer(savedPath: string): string {
		return `Error: result (72,378 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${savedPath}.\nFormat: Plain text\n- For targeted searches (find a string) use \`grep\``;
	}

	const SEARCH_RESULT = JSON.stringify({
		hits: [{ id: "commit:3b6dd021", type: "commit", title: "Add Zoom meeting and doc source references" }],
	});

	it("extracts a search reference from the arguments, ignoring the result", () => {
		const lines = jmLines(
			"mcp__jollimemory__search",
			"jm1",
			{ query: "reference SourceDefinition adding new source registry ripple", limit: 15 },
			SEARCH_RESULT,
		);
		const { results } = claudeEnvelopeParser.parse(lines, {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("jollimemory");
		expect(results[0].payload).toEqual({
			tool: "search",
			title: "Search",
			query: "reference SourceDefinition adding new source registry ripple",
		});
	});

	it("extracts a decision-timeline reference keyed on its own tool", () => {
		const lines = jmLines(
			"mcp__jollimemory__get_decision_timeline",
			"jm2",
			{ slug: "mcp-pr-tools" },
			JSON.stringify({ events: [] }),
		);
		const { results } = claudeEnvelopeParser.parse(lines, {});
		expect(results[0].payload).toEqual({
			tool: "get_decision_timeline",
			title: "Decision timeline",
			query: "mcp-pr-tools",
		});
	});

	it("distinguishes a bare recall() from list_branches() — both have an EMPTY input", () => {
		// THE test that proves the toolName threading. The two inputs are byte-identical,
		// so nothing but the tool name can tell a captured tool from an ignored one.
		const recall = claudeEnvelopeParser.parse(
			jmLines("mcp__jollimemory__recall", "jm3", {}, JSON.stringify({ type: "recall" })),
			{},
		).results;
		expect(recall).toHaveLength(1);
		expect(recall[0].payload).toEqual({ tool: "recall", title: "Recall", query: "(current branch)" });

		const listed = claudeEnvelopeParser.parse(
			jmLines("mcp__jollimemory__list_branches", "jm4", {}, JSON.stringify({ branches: [] })),
			{},
		).results;
		expect(listed).toHaveLength(0);
	});

	it("captures search but not the sibling tools whose names extend it", () => {
		// `mcp__jollimemory__search` is a startsWith-prefix of both siblings, which is
		// exactly why the definition declares an `exact` allow-list.
		for (const sibling of ["search_remote_articles", "search_remote_repo"]) {
			const { results } = claudeEnvelopeParser.parse(
				jmLines(`mcp__jollimemory__${sibling}`, `jm-${sibling}`, { query: "x" }, JSON.stringify({ hits: [] })),
				{},
			);
			expect(results).toHaveLength(0);
		}
		expect(
			claudeEnvelopeParser.parse(jmLines("mcp__jollimemory__search", "jm5", { query: "x" }, SEARCH_RESULT), {})
				.results,
		).toHaveLength(1);
	});

	it("recovers a recall whose oversized result was offloaded to a file", () => {
		const saved = join(freshToolResultsDir(), "mcp-jollimemory-recall-1785210714712.txt");
		writeFileSync(saved, JSON.stringify({ type: "recall", decisions: ["…"] }));
		const { results } = claudeEnvelopeParser.parse(
			jmLines(
				"mcp__jollimemory__recall",
				"jm6",
				{ branch: "feature/mcp-integration" },
				recallOffloadPointer(saved),
			),
			{},
		);
		expect(results).toHaveLength(1);
		// The recovered payload is discarded: the reference is built from the arguments,
		// which is the whole point of not copying recalled memory back into memory.
		expect(results[0].payload).toEqual({
			tool: "recall",
			title: "Recall",
			query: "feature/mcp-integration",
		});
	});

	it("still captures a recall whose offloaded file is gone", () => {
		// Offload files are session-scoped temp files, so by the time post-commit
		// extraction runs the file may well have been cleaned up. For a NON-arguments-
		// derived source that drops the reference; here `argumentsDerived` hands the
		// normalizer an empty payload instead, so the act is still recorded. Since every
		// real recall result is offloaded, this is the path that decides whether recall
		// is captured at all.
		const missing = join(freshToolResultsDir(), "mcp-jollimemory-recall-gone.txt");
		const { results } = claudeEnvelopeParser.parse(
			jmLines("mcp__jollimemory__recall", "jm7", {}, recallOffloadPointer(missing)),
			{},
		);
		expect(results).toHaveLength(1);
		expect(results[0].payload).toEqual({ tool: "recall", title: "Recall", query: "(current branch)" });
	});
});

describe("ClaudeEnvelopeParser confluence", () => {
	// Confluence is a context-normalized source not because it needs out-of-payload
	// context, but because the DSL cannot flatten its `{content:{nodes:[…]}}`
	// wrapper (nor an ADF-object body) into the canonical page shape.
	const PAGE_URL = "https://acme.atlassian.net/wiki/spaces/ENG/pages/557292/Per-Provider";

	function confluenceLines(body: unknown): string[] {
		return [
			JSON.stringify({
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "c1",
							name: "mcp__claude_ai_Atlassian__getConfluencePage",
							input: { pageId: "557292" },
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
							tool_use_id: "c1",
							content: JSON.stringify({
								content: {
									totalCount: 1,
									nodes: [
										{
											id: "557292",
											type: "page",
											title: "Per-Provider pools",
											space: { key: "ENG", name: "Engineering" },
											author: { displayName: "Flyer Li" },
											webUrl: PAGE_URL,
											body,
										},
									],
								},
							}),
						},
					],
				},
			}),
		];
	}

	it("flattens the nodes wrapper into the canonical page shape", () => {
		const { results } = claudeEnvelopeParser.parse(confluenceLines("## TL;DR\n\nUse one pool."), {});
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("confluence");
		expect(results[0].payload).toMatchObject({
			pageId: "557292",
			title: "Per-Provider pools",
			url: PAGE_URL,
			body: "## TL;DR\n\nUse one pool.",
			space: "Engineering",
			author: "Flyer Li",
		});
	});

	it("renders an ADF-object body to text on the way through", () => {
		const adf = {
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "One pool per provider." }] }],
		};
		const { results } = claudeEnvelopeParser.parse(confluenceLines(adf), {});
		expect((results[0].payload as { body?: string }).body).toBe("One pool per provider.");
	});
});

// Verbatim from a real Claude Code session (2026-08-10) in the project
// /Users/zf/.jolli/sites/d98a494d413a: the connector namespace is
// `mcp__claude_ai_Vercel__`, and `get_deployment`'s `{deployment:{…}}` is the only
// JSON result the Vercel connector produces. Shapes are captured, never inferred.
const VERCEL_RESULT = JSON.stringify({
	deployment: {
		id: "dpl_21ZZLCbgMKjWucj9sFV6i74BB2nr",
		name: "forge-docs",
		url: "forge-docs-b4p8u0cxu-jolli.vercel.app",
		state: "ERROR",
		project: { id: "prj_avItWqEtyEdMJlABjdwjiBBpIvNz", name: "forge-docs", framework: "nextjs" },
		target: "production",
		readyState: "ERROR",
		errorCode: "enoent",
		errorMessage: 'Command "npm run build && npx pagefind --site out" exited with 1',
		errorStep: "buildStep",
	},
});

function vercelLines(toolName: string, resultText: string): string[] {
	return [
		JSON.stringify({
			timestamp: "2026-08-10T10:59:52.000Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "v1",
						name: toolName,
						input: { idOrUrl: "dpl_21ZZLCbgMKjWucj9sFV6i74BB2nr", teamId: "team_35lUmEmlUV6VQTk8RSPd5LfI" },
					},
				],
			},
		}),
		JSON.stringify({
			timestamp: "2026-08-10T10:59:53.000Z",
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "v1", content: [{ type: "text", text: resultText }] }],
			},
		}),
	];
}

describe("ClaudeEnvelopeParser vercel", () => {
	it("routes get_deployment to the vercel definition with an identity payload", () => {
		const { results } = claudeEnvelopeParser.parse(
			vercelLines("mcp__claude_ai_Vercel__get_deployment", VERCEL_RESULT),
			{},
		);
		expect(results).toHaveLength(1);
		expect(results[0].def.id).toBe("vercel");
		// No context-normalizer: the payload arrives exactly as the connector sent it,
		// wrapper key included, and `walkPayload` descends it downstream.
		expect((results[0].payload as { deployment: { id: string } }).deployment.id).toBe(
			"dpl_21ZZLCbgMKjWucj9sFV6i74BB2nr",
		);
		expect(results[0].referencedAt).toBe("2026-08-10T10:59:53.000Z");
	});

	it("matches the standalone remote MCP prefix too (the Kimi-reachable spelling)", () => {
		const { results } = claudeEnvelopeParser.parse(vercelLines("mcp__vercel__get_deployment", VERCEL_RESULT), {});
		expect(results.map((r) => r.def.id)).toEqual(["vercel"]);
	});

	it("does not match the sibling tools whose results are prose, not JSON", () => {
		// `endsWith("get_deployment")` is false for `…_build_logs`, so those never resolve
		// to a definition at all — the prose result is a non-match, not a drop. Capturing
		// them would need a raw-text capability the envelope layer does not have.
		for (const tool of [
			"mcp__claude_ai_Vercel__get_deployment_build_logs",
			"mcp__claude_ai_Vercel__deploy_to_vercel",
			"mcp__claude_ai_Vercel__list_projects",
			"mcp__claude_ai_Vercel__list_teams",
			"mcp__claude_ai_Vercel__search_vercel_documentation",
		]) {
			const { results } = claudeEnvelopeParser.parse(
				vercelLines(tool, "## Build Logs\n\n10:49:25  Running build in Cleveland, USA (East) – cle1"),
				{},
			);
			expect(results, tool).toHaveLength(0);
		}
	});

	it("drops an errored get_deployment whose body is the connector's prose error", () => {
		// Real capture: `is_error: true` with `API error occurred: Status 404 …`. MCP
		// entries carry no success gate, so this is the JSON.parse drop doing the work —
		// vercel is result-derived, so it has no `argumentsDerived` escape hatch.
		const { results } = claudeEnvelopeParser.parse(
			vercelLines(
				"mcp__claude_ai_Vercel__get_deployment",
				'API error occurred: Status 404 Content-Type "application/json". Body: {"error":{"code":"not_found"}}',
			),
			{},
		);
		expect(results).toHaveLength(0);
	});
});
