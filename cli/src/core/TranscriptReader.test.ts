import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import type { TranscriptEntry } from "../Types.js";
import type { SessionTranscript } from "./TranscriptReader.js";
import {
	buildConversationContext,
	buildMultiSessionContext,
	parseTranscriptLine,
	readTranscript,
} from "./TranscriptReader.js";

describe("TranscriptReader", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jollimemory-transcript-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("parseTranscriptLine", () => {
		it("should parse user message with string content", () => {
			const line = JSON.stringify({
				message: { role: "user", content: "Help me fix this bug" },
				timestamp: "2026-02-19T10:00:00Z",
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry).not.toBeNull();
			expect(entry?.role).toBe("human");
			expect(entry?.content).toBe("Help me fix this bug");
			expect(entry?.timestamp).toBe("2026-02-19T10:00:00Z");
		});

		it("should parse assistant message with array content", () => {
			const line = JSON.stringify({
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I'll help you fix that." }],
				},
				timestamp: "2026-02-19T10:01:00Z",
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.role).toBe("assistant");
			expect(entry?.content).toBe("I'll help you fix that.");
		});

		it("should skip top-level toolUseResult entries", () => {
			const line = JSON.stringify({
				toolUseResult: { tool_use_id: "123", output: "File edited successfully" },
				timestamp: "2026-02-19T10:02:00Z",
			});
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should return null for invalid JSON", () => {
			const entry = parseTranscriptLine("not json", 0);
			expect(entry).toBeNull();
		});

		it("should return null for unrecognized structures", () => {
			const line = JSON.stringify({ someOtherField: true });
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should skip system event entries without message field", () => {
			const line = JSON.stringify({ type: "system", event: "compaction", timestamp: "2026-02-23T00:00:00Z" });
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should skip entries with unknown message role", () => {
			const line = JSON.stringify({
				message: { role: "system", content: "System prompt" },
				timestamp: "2026-02-23T00:00:00Z",
			});
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should handle content array with blocks missing text field", () => {
			const line = JSON.stringify({
				message: {
					role: "assistant",
					content: [{ type: "text" }, { type: "text", text: "actual content" }],
				},
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.role).toBe("assistant");
			expect(entry?.content).toBe("actual content");
		});

		it("should handle content array with null blocks", () => {
			const line = JSON.stringify({
				message: {
					role: "assistant",
					content: [null, { type: "text", text: "after null" }],
				},
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.role).toBe("assistant");
			expect(entry?.content).toBe("after null");
		});

		it("should return null for empty string content", () => {
			const line = JSON.stringify({
				message: { role: "user", content: "" },
			});
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should return null when message content is neither string nor array", () => {
			const userLine = JSON.stringify({
				message: { role: "user", content: { text: "not a valid content shape" } },
			});
			const assistantLine = JSON.stringify({
				message: { role: "assistant", content: { text: "also invalid" } },
			});
			expect(parseTranscriptLine(userLine, 0)).toBeNull();
			expect(parseTranscriptLine(assistantLine, 1)).toBeNull();
		});

		it("should handle message field that is not an object", () => {
			const line = JSON.stringify({ message: "not an object" });
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should handle missing timestamp gracefully", () => {
			const line = JSON.stringify({
				message: { role: "user", content: "no timestamp here" },
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.role).toBe("human");
			expect(entry?.timestamp).toBeUndefined();
		});

		// --- Compaction filtering ---

		it("should skip compaction summary messages", () => {
			const line = JSON.stringify({
				message: {
					role: "user",
					content: "This session is being continued from a previous conversation that ran out of context.",
				},
				isCompactSummary: true,
				isVisibleInTranscriptOnly: true,
				timestamp: "2026-02-23T00:00:00Z",
			});
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should parse normal user messages without isCompactSummary", () => {
			const line = JSON.stringify({
				message: { role: "user", content: "Fix the login bug" },
				timestamp: "2026-02-23T00:00:00Z",
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.role).toBe("human");
			expect(entry?.content).toBe("Fix the login bug");
		});

		// --- IDE tag stripping ---

		it("should strip ide_opened_file tags from user messages", () => {
			const line = JSON.stringify({
				message: {
					role: "user",
					content:
						"<ide_opened_file>The user opened PostCommitHook.ts in the IDE.</ide_opened_file>\nFix the bug",
				},
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.role).toBe("human");
			expect(entry?.content).toBe("Fix the bug");
		});

		it("should strip system-reminder tags from user messages", () => {
			const line = JSON.stringify({
				message: {
					role: "user",
					content:
						"<system-reminder>Note: file was modified by linter.</system-reminder>Write a commit message",
				},
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.content).toBe("Write a commit message");
		});

		it("should strip multiple IDE tags and preserve remaining text", () => {
			const line = JSON.stringify({
				message: {
					role: "user",
					content: [
						"<system-reminder>Some reminder</system-reminder>",
						"<ide_selection>selected code here</ide_selection>",
						"Please refactor this function",
					].join(""),
				},
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.content).toBe("Please refactor this function");
		});

		it("should return null when content is only IDE tags", () => {
			const line = JSON.stringify({
				message: {
					role: "user",
					content: "<ide_opened_file>The user opened file.ts in the IDE.</ide_opened_file>",
				},
			});
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		// --- System-generated message filtering (SKIP_USER_PREFIXES) ---

		it("should skip skill injection messages", () => {
			const line = JSON.stringify({
				message: {
					role: "user",
					content: "Base directory for this skill: /path/to/project\n\nLong verbose skill instructions...",
				},
			});
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should skip user-interrupted messages", () => {
			const variants = ["[Request interrupted by user for tool use]", "[Request interrupted by user]"];
			for (const text of variants) {
				const line = JSON.stringify({ message: { role: "user", content: text } });
				expect(parseTranscriptLine(line, 0)).toBeNull();
			}
		});

		// --- Assistant tool_use handling ---

		it("should return null for assistant messages with only tool_use blocks", () => {
			const line = JSON.stringify({
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", name: "Edit", input: { file: "test.ts" } },
						{ type: "tool_use", name: "Read", input: { file_path: "/src/App.tsx" } },
					],
				},
			});
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should skip assistant messages with only whitespace content", () => {
			// Streaming first chunk is often just "\n\n"
			const line = JSON.stringify({
				message: { role: "assistant", content: [{ type: "text", text: "\n\n" }] },
			});
			expect(parseTranscriptLine(line, 0)).toBeNull();
		});

		it("should trim whitespace from assistant text content", () => {
			const line = JSON.stringify({
				message: { role: "assistant", content: [{ type: "text", text: "  actual content  \n" }] },
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.content).toBe("actual content");
		});

		it("should extract text from assistant messages that also contain tool_use blocks", () => {
			const line = JSON.stringify({
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I'll fix the bug by editing the file." },
						{ type: "tool_use", name: "Edit", input: { file: "test.ts" } },
					],
				},
			});
			const entry = parseTranscriptLine(line, 0);
			expect(entry?.role).toBe("assistant");
			expect(entry?.content).toBe("I'll fix the bug by editing the file.");
		});
	});

	describe("readTranscript", () => {
		it("should read all entries from a transcript file", async () => {
			const filePath = join(tempDir, "test.jsonl");
			const lines = [
				JSON.stringify({ message: { role: "user", content: "hello" } }),
				JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
			];
			await writeFile(filePath, lines.join("\n"), "utf-8");

			const result = await readTranscript(filePath);
			expect(result.entries.length).toBe(2);
			expect(result.entries[0].role).toBe("human");
			expect(result.entries[1].role).toBe("assistant");
			expect(result.newCursor.lineNumber).toBe(2);
		});

		it("should resume from cursor position", async () => {
			const filePath = join(tempDir, "test.jsonl");
			const lines = [
				JSON.stringify({ message: { role: "user", content: "first" } }),
				JSON.stringify({ message: { role: "user", content: "second" } }),
				JSON.stringify({ message: { role: "user", content: "third" } }),
			];
			await writeFile(filePath, lines.join("\n"), "utf-8");

			const result = await readTranscript(filePath, {
				transcriptPath: filePath,
				lineNumber: 2,
				updatedAt: "2026-02-19T10:00:00Z",
			});

			expect(result.entries.length).toBe(1);
			expect(result.entries[0].content).toBe("third");
			expect(result.newCursor.lineNumber).toBe(3);
		});

		it("should handle empty files", async () => {
			const filePath = join(tempDir, "empty.jsonl");
			await writeFile(filePath, "", "utf-8");

			const result = await readTranscript(filePath);
			expect(result.entries.length).toBe(0);
		});

		it("should throw for missing files", async () => {
			await expect(readTranscript("/nonexistent/path.jsonl")).rejects.toThrow("Cannot read transcript");
		});

		it("should merge consecutive assistant entries into one", async () => {
			const filePath = join(tempDir, "streaming.jsonl");
			const lines = [
				JSON.stringify({ message: { role: "user", content: "fix the bug" } }),
				JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Let me check." }] } }),
				JSON.stringify({
					message: { role: "assistant", content: [{ type: "text", text: "Found the issue." }] },
				}),
				JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] } }),
			];
			await writeFile(filePath, lines.join("\n"), "utf-8");

			const result = await readTranscript(filePath);
			expect(result.entries.length).toBe(2);
			expect(result.entries[0].content).toBe("fix the bug");
			expect(result.entries[1].content).toBe("Let me check.\n\nFound the issue.\n\nFixed it.");
		});

		it("should merge consecutive human entries into one", async () => {
			const filePath = join(tempDir, "multi-human.jsonl");
			const lines = [
				JSON.stringify({
					message: { role: "user", content: "first request" },
					timestamp: "2026-02-23T10:00:00Z",
				}),
				JSON.stringify({
					message: { role: "user", content: "additional context" },
					timestamp: "2026-02-23T10:00:01Z",
				}),
				JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "OK" }] } }),
			];
			await writeFile(filePath, lines.join("\n"), "utf-8");

			const result = await readTranscript(filePath);
			expect(result.entries.length).toBe(2);
			expect(result.entries[0].content).toBe("first request\n\nadditional context");
			expect(result.entries[0].timestamp).toBe("2026-02-23T10:00:00Z");
		});

		it("should filter empty streaming chunks before merging", async () => {
			const filePath = join(tempDir, "empty-chunks.jsonl");
			const lines = [
				JSON.stringify({ message: { role: "user", content: "help" } }),
				// Empty streaming first chunk (just whitespace) — filtered out
				JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "\n\n" }] } }),
				// Actual content
				JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Sure!" }] } }),
			];
			await writeFile(filePath, lines.join("\n"), "utf-8");

			const result = await readTranscript(filePath);
			expect(result.entries.length).toBe(2);
			expect(result.entries[1].content).toBe("Sure!");
		});

		it("should skip unparseable lines", async () => {
			const filePath = join(tempDir, "mixed.jsonl");
			const lines = [
				JSON.stringify({ message: { role: "user", content: "good" } }),
				"invalid json here",
				JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "also good" }] } }),
			];
			await writeFile(filePath, lines.join("\n"), "utf-8");

			const result = await readTranscript(filePath);
			expect(result.entries.length).toBe(2);
		});
	});

	describe("buildConversationContext", () => {
		it("should format entries with role prefixes and blank line separators", () => {
			const entries: TranscriptEntry[] = [
				{ role: "human", content: "Help me" },
				{ role: "assistant", content: "Sure thing" },
			];
			const context = buildConversationContext(entries);
			expect(context).toBe("[Human]: Help me\n\n[Assistant]: Sure thing");
		});

		it("should truncate from oldest entries when over budget", () => {
			const entries: TranscriptEntry[] = [
				{ role: "human", content: "A".repeat(100) },
				{ role: "human", content: "B".repeat(100) },
				{ role: "human", content: "C".repeat(100) },
			];
			const context = buildConversationContext(entries, 150);
			// Should include the most recent entry but not the oldest
			expect(context).toContain("C".repeat(100));
			expect(context).not.toContain("A".repeat(100));
		});

		it("should handle empty entries", () => {
			const context = buildConversationContext([]);
			expect(context).toBe("");
		});
	});

	describe("buildMultiSessionContext", () => {
		it("should merge two sessions with entries ordered by timestamp", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-1",
					transcriptPath: "/path/1.jsonl",
					entries: [
						{ role: "human", content: "dark mode please", timestamp: "2026-02-23T10:00:00Z" },
						{ role: "assistant", content: "Adding dark mode", timestamp: "2026-02-23T10:01:00Z" },
					],
				},
				{
					sessionId: "sess-2",
					transcriptPath: "/path/2.jsonl",
					entries: [
						{ role: "human", content: "fix login bug", timestamp: "2026-02-23T10:02:00Z" },
						{ role: "assistant", content: "Looking at login", timestamp: "2026-02-23T10:03:00Z" },
					],
				},
			];

			const result = buildMultiSessionContext(sessions);

			// Should contain both session blocks
			expect(result).toContain('<session id="sess-1"');
			expect(result).toContain('<session id="sess-2"');
			expect(result).toContain("</session>");

			// Session 2 should come first (has newest entry at 10:03)
			const sess2Pos = result.indexOf("sess-2");
			const sess1Pos = result.indexOf("sess-1");
			expect(sess2Pos).toBeLessThan(sess1Pos);
		});

		it("should respect budget and truncate oldest entries", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-1",
					transcriptPath: "/path/1.jsonl",
					entries: [{ role: "human", content: "A".repeat(200), timestamp: "2026-02-23T09:00:00Z" }],
				},
				{
					sessionId: "sess-2",
					transcriptPath: "/path/2.jsonl",
					entries: [{ role: "human", content: "B".repeat(50), timestamp: "2026-02-23T10:00:00Z" }],
				},
			];

			// Budget of 100 chars should only fit the shorter, newer entry from sess-2
			const result = buildMultiSessionContext(sessions, 100);
			expect(result).toContain("B".repeat(50));
			expect(result).not.toContain("A".repeat(200));
		});

		it("should return empty string when no selected entry fits within the budget", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-1",
					transcriptPath: "/path/1.jsonl",
					entries: [{ role: "human", content: "this entry is too long", timestamp: "2026-02-23T10:00:00Z" }],
				},
			];

			expect(buildMultiSessionContext(sessions, 5)).toBe("");
		});

		it("should handle single session", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "only-session",
					transcriptPath: "/path/only.jsonl",
					entries: [{ role: "human", content: "hello", timestamp: "2026-02-23T10:00:00Z" }],
				},
			];

			const result = buildMultiSessionContext(sessions);
			expect(result).toContain('<session id="only-session"');
			expect(result).toContain("[Human]: hello");
			expect(result).toContain("</session>");
		});

		it("should wrap output in <transcript> tags", () => {
			// <transcript> tags are added here so the caller (buildSummarizationPrompt)
			// can embed the result directly without adding extra markup.
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-1",
					transcriptPath: "/path/1.jsonl",
					entries: [{ role: "human", content: "hello", timestamp: "2026-02-23T10:00:00Z" }],
				},
			];
			const result = buildMultiSessionContext(sessions);
			expect(result).toMatch(/^<transcript>\n/);
			expect(result).toMatch(/\n<\/transcript>$/);
		});

		it("should return empty string (no tags) when there are no entries", () => {
			expect(buildMultiSessionContext([])).toBe("");
		});

		it("should handle sessions with no entries", () => {
			const sessions: SessionTranscript[] = [
				{ sessionId: "empty", transcriptPath: "/path/empty.jsonl", entries: [] },
			];
			const result = buildMultiSessionContext(sessions);
			expect(result).toBe("");
		});

		it("should place entries without timestamps last", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-1",
					transcriptPath: "/path/1.jsonl",
					entries: [
						{ role: "human", content: "no-timestamp entry" },
						{ role: "human", content: "timestamped entry", timestamp: "2026-02-23T10:00:00Z" },
					],
				},
			];

			// With a tight budget, only the timestamped entry should be selected
			// (it comes first in the sorted pool since entries without timestamps go last)
			const result = buildMultiSessionContext(sessions, 35);
			expect(result).toContain("timestamped entry");
			expect(result).not.toContain("no-timestamp entry");
		});

		it("should prioritize timestamped entries even when the earlier compared entry lacks a timestamp", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-1",
					transcriptPath: "/path/1.jsonl",
					entries: [
						{ role: "human", content: "no timestamp first" },
						{ role: "assistant", content: "timestamp should win", timestamp: "2026-02-23T10:00:00Z" },
					],
				},
			];

			const result = buildMultiSessionContext(sessions, 35);
			expect(result).toContain("timestamp should win");
			expect(result).not.toContain("no timestamp first");
		});

		it("should sort entries without timestamps after timestamped entries regardless of input order", () => {
			// Place the timestamped entry first and the untimestamped entry second
			// to exercise the reverse comparator direction (!tsA && tsB)
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-1",
					transcriptPath: "/path/1.jsonl",
					entries: [
						{ role: "assistant", content: "has timestamp", timestamp: "2026-02-23T10:00:00Z" },
						{ role: "human", content: "no timestamp at all" },
					],
				},
			];

			const result = buildMultiSessionContext(sessions, 35);
			expect(result).toContain("has timestamp");
			expect(result).not.toContain("no timestamp at all");
		});

		it("should handle multiple sessions with mixed timestamp presence", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-a",
					transcriptPath: "/path/a.jsonl",
					entries: [{ role: "human", content: "untimed-a" }],
				},
				{
					sessionId: "sess-b",
					transcriptPath: "/path/b.jsonl",
					entries: [{ role: "human", content: "timed-b", timestamp: "2026-02-23T10:00:00Z" }],
				},
			];

			const result = buildMultiSessionContext(sessions, 10_000);
			// Both should be included with enough budget
			expect(result).toContain("timed-b");
			expect(result).toContain("untimed-a");
		});

		it("should include transcript path in session tag", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-1",
					transcriptPath: "/home/user/.claude/projects/test/abc.jsonl",
					entries: [{ role: "human", content: "test", timestamp: "2026-02-23T10:00:00Z" }],
				},
			];

			const result = buildMultiSessionContext(sessions);
			expect(result).toContain('transcript="/home/user/.claude/projects/test/abc.jsonl"');
		});

		it("should order entries within a session chronologically (oldest first)", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-1",
					transcriptPath: "/path/1.jsonl",
					entries: [
						{ role: "human", content: "first message", timestamp: "2026-02-23T10:00:00Z" },
						{ role: "assistant", content: "first reply", timestamp: "2026-02-23T10:01:00Z" },
						{ role: "human", content: "second message", timestamp: "2026-02-23T10:02:00Z" },
					],
				},
			];

			const result = buildMultiSessionContext(sessions);
			const firstPos = result.indexOf("first message");
			const replyPos = result.indexOf("first reply");
			const secondPos = result.indexOf("second message");

			expect(firstPos).toBeLessThan(replyPos);
			expect(replyPos).toBeLessThan(secondPos);
		});

		it("should preserve original order when neither compared entry has a timestamp", () => {
			const sessions: SessionTranscript[] = [
				{
					sessionId: "sess-a",
					transcriptPath: "/path/a.jsonl",
					entries: [
						{ role: "human", content: "first without timestamp" },
						{ role: "assistant", content: "second without timestamp" },
					],
				},
			];

			const result = buildMultiSessionContext(sessions, 10_000);
			expect(result.indexOf("first without timestamp")).toBeLessThan(result.indexOf("second without timestamp"));
		});
	});

	// ─── readTranscript with custom parser ────────────────────────────────────

	describe("readTranscript with custom parser", () => {
		it("uses the provided parser instead of default Claude parser", async () => {
			// Write a Codex-style JSONL file
			const lines = [
				JSON.stringify({
					timestamp: "2026-03-22T00:00:00Z",
					type: "session_meta",
					payload: { id: "test", cwd: "/tmp" },
				}),
				JSON.stringify({
					timestamp: "2026-03-22T00:00:01Z",
					type: "event_msg",
					payload: { type: "user_message", message: "Hello Codex" },
				}),
				JSON.stringify({
					timestamp: "2026-03-22T00:00:02Z",
					type: "event_msg",
					payload: { type: "agent_message", message: "Hi there!", phase: "final_answer" },
				}),
			].join("\n");

			const filePath = join(tempDir, "codex-session.jsonl");
			await writeFile(filePath, lines, "utf-8");

			// Import and use the Codex parser
			const { CodexTranscriptParser } = await import("./TranscriptParser.js");
			const parser = new CodexTranscriptParser();
			const result = await readTranscript(filePath, null, parser);

			expect(result.entries).toHaveLength(2);
			expect(result.entries[0]).toEqual({
				role: "human",
				content: "Hello Codex",
				timestamp: "2026-03-22T00:00:01Z",
			});
			expect(result.entries[1]).toEqual({
				role: "assistant",
				content: "Hi there!",
				timestamp: "2026-03-22T00:00:02Z",
			});
		});

		it("defaults to Claude parsing when no parser is provided", async () => {
			const lines = [
				JSON.stringify({
					message: { role: "user", content: "Hello Claude" },
					timestamp: "2026-03-22T00:00:00Z",
				}),
			].join("\n");

			const filePath = join(tempDir, "claude-session.jsonl");
			await writeFile(filePath, lines, "utf-8");

			const result = await readTranscript(filePath);
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].content).toBe("Hello Claude");
		});
	});

	describe("beforeTimestamp cutoff", () => {
		it("stops consuming entries after the cutoff timestamp", async () => {
			const lines = [
				JSON.stringify({
					type: "human",
					message: { role: "user", content: "Before cutoff" },
					timestamp: "2026-03-20T10:00:00Z",
				}),
				JSON.stringify({
					type: "assistant",
					message: { role: "assistant", content: "Response before" },
					timestamp: "2026-03-20T10:00:01Z",
				}),
				JSON.stringify({
					type: "human",
					message: { role: "user", content: "After cutoff" },
					timestamp: "2026-03-20T12:00:00Z",
				}),
			].join("\n");

			const filePath = join(tempDir, "session.jsonl");
			await writeFile(filePath, lines, "utf-8");

			const result = await readTranscript(filePath, undefined, undefined, "2026-03-20T11:00:00Z");

			expect(result.entries).toHaveLength(2);
			expect(result.entries[0].content).toBe("Before cutoff");
			expect(result.entries[1].content).toBe("Response before");
			// Cursor should advance only to last consumed line, not end
			expect(result.newCursor.lineNumber).toBe(2);
			expect(result.totalLinesRead).toBe(2);
		});

		it("advances cursor to EOF when no beforeTimestamp is provided", async () => {
			const lines = [
				JSON.stringify({
					type: "human",
					message: { role: "user", content: "msg1" },
					timestamp: "2026-03-20T10:00:00Z",
				}),
				JSON.stringify({
					type: "assistant",
					message: { role: "assistant", content: "msg2" },
					timestamp: "2026-03-20T10:00:01Z",
				}),
			].join("\n");

			const filePath = join(tempDir, "session.jsonl");
			await writeFile(filePath, lines, "utf-8");

			const result = await readTranscript(filePath);

			expect(result.newCursor.lineNumber).toBe(2);
		});
	});
});
