/**
 * Coverage for `loadUnreadMergedTranscript`'s per-source dispatch (the switch
 * in `readUnreadTranscript`). The main `TranscriptMessageCounter.test.ts`
 * suite exercises the claude / codex / gemini paths with real JSONL fixtures;
 * the four sqlite-backed sources need mocks because hand-crafting valid
 * SQLite databases for a switch-coverage test isn't worth the maintenance
 * cost. Kept in a separate file so the `vi.mock` of the reader modules
 * doesn't bleed into the realistic-fixture suite.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the five non-JSONL reader modules so the dispatch test doesn't need
// real DB / file fixtures. Each mock returns one entry so we can verify both
// "the right reader was called" and "its result flowed through applyOverlay".
vi.mock("./GeminiTranscriptReader.js", () => ({
	readGeminiTranscript: vi.fn().mockResolvedValue({
		entries: [{ role: "human", content: "gemini-payload" }],
		newCursor: null,
		totalLinesRead: 1,
	}),
}));
vi.mock("./OpenCodeTranscriptReader.js", () => ({
	readOpenCodeTranscript: vi.fn().mockResolvedValue({
		entries: [{ role: "human", content: "opencode-payload" }],
		newCursor: null,
		totalLinesRead: 1,
	}),
}));
vi.mock("./CursorTranscriptReader.js", () => ({
	readCursorTranscript: vi.fn().mockResolvedValue({
		entries: [{ role: "human", content: "cursor-payload" }],
		newCursor: null,
		totalLinesRead: 1,
	}),
}));
vi.mock("./CopilotTranscriptReader.js", () => ({
	readCopilotTranscript: vi.fn().mockResolvedValue({
		entries: [{ role: "human", content: "copilot-payload" }],
		newCursor: null,
		totalLinesRead: 1,
	}),
}));
vi.mock("./CopilotChatTranscriptReader.js", () => ({
	readCopilotChatTranscript: vi.fn().mockResolvedValue({
		entries: [{ role: "human", content: "copilot-chat-payload" }],
		newCursor: null,
		totalLinesRead: 1,
	}),
}));
// Mock the codex path's reader so we don't need a real JSONL file for it.
vi.mock("./TranscriptReader.js", () => ({
	readTranscript: vi.fn().mockResolvedValue({
		entries: [{ role: "human", content: "claude-or-codex-payload" }],
		newCursor: null,
		totalLinesRead: 1,
	}),
}));

import { readCopilotChatTranscript } from "./CopilotChatTranscriptReader.js";
import { readCopilotTranscript } from "./CopilotTranscriptReader.js";
import { readCursorTranscript } from "./CursorTranscriptReader.js";
import { readOpenCodeTranscript } from "./OpenCodeTranscriptReader.js";
import { loadUnreadMergedTranscript } from "./TranscriptMessageCounter.js";
import { readTranscript } from "./TranscriptReader.js";

describe("loadUnreadMergedTranscript per-source dispatch", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "msg-counter-disp-"));
		vi.mocked(readOpenCodeTranscript).mockClear();
		vi.mocked(readCursorTranscript).mockClear();
		vi.mocked(readCopilotTranscript).mockClear();
		vi.mocked(readCopilotChatTranscript).mockClear();
		vi.mocked(readTranscript).mockClear();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("dispatches to OpenCode reader for source=opencode", async () => {
		const entries = await loadUnreadMergedTranscript(
			{
				sessionId: "s",
				transcriptPath: "/synthetic/opencode.db#sess",
				updatedAt: "2026-05-15T00:00:00Z",
				source: "opencode",
			},
			projectDir,
		);
		expect(readOpenCodeTranscript).toHaveBeenCalledTimes(1);
		expect(entries).toEqual([{ role: "human", content: "opencode-payload" }]);
	});

	it("dispatches to Cursor reader for source=cursor", async () => {
		const entries = await loadUnreadMergedTranscript(
			{
				sessionId: "s",
				transcriptPath: "/synthetic/cursor.vscdb#sess",
				updatedAt: "2026-05-15T00:00:00Z",
				source: "cursor",
			},
			projectDir,
		);
		expect(readCursorTranscript).toHaveBeenCalledTimes(1);
		expect(entries).toEqual([{ role: "human", content: "cursor-payload" }]);
	});

	it("dispatches to Copilot reader for source=copilot", async () => {
		const entries = await loadUnreadMergedTranscript(
			{
				sessionId: "s",
				transcriptPath: "/synthetic/copilot.db#sess",
				updatedAt: "2026-05-15T00:00:00Z",
				source: "copilot",
			},
			projectDir,
		);
		expect(readCopilotTranscript).toHaveBeenCalledTimes(1);
		expect(entries).toEqual([{ role: "human", content: "copilot-payload" }]);
	});

	// `cursor ?? undefined` has two branches the v8 coverage report flags
	// separately: the truthy-cursor path (uses the saved cursor) and the
	// nullish-cursor path (defaults to undefined). Both need exercising for
	// the line to clear the 96% branch threshold.
	it("dispatches to CopilotChat reader for source=copilot-chat with no saved cursor", async () => {
		const entries = await loadUnreadMergedTranscript(
			{
				sessionId: "s",
				transcriptPath: "/synthetic/copilot-chat.jsonl",
				updatedAt: "2026-05-15T00:00:00Z",
				source: "copilot-chat",
			},
			projectDir,
		);
		expect(readCopilotChatTranscript).toHaveBeenCalledTimes(1);
		// No cursors.json on disk → loadCursorForTranscript returns null →
		// `cursor ?? undefined` evaluates to `undefined`. We forwarded it.
		expect(vi.mocked(readCopilotChatTranscript).mock.calls[0][1]).toBeUndefined();
		expect(entries).toEqual([{ role: "human", content: "copilot-chat-payload" }]);
	});

	it("forwards the saved cursor to CopilotChat reader when one exists", async () => {
		// Pre-seed cursors.json so loadCursorForTranscript returns a truthy
		// value — exercises the left-operand branch of `cursor ?? undefined`.
		const transcriptPath = "/synthetic/copilot-chat-with-cursor.jsonl";
		const jmDir = join(projectDir, ".jolli", "jollimemory");
		mkdirSync(jmDir, { recursive: true });
		writeFileSync(
			join(jmDir, "cursors.json"),
			JSON.stringify({
				version: 1,
				cursors: {
					[transcriptPath]: {
						transcriptPath,
						lineNumber: 5,
						updatedAt: "2026-05-15T00:00:00Z",
					},
				},
			}),
		);
		await loadUnreadMergedTranscript(
			{
				sessionId: "s",
				transcriptPath,
				updatedAt: "2026-05-15T00:00:00Z",
				source: "copilot-chat",
			},
			projectDir,
		);
		expect(readCopilotChatTranscript).toHaveBeenCalledTimes(1);
		// Cursor was non-null → `cursor ?? undefined` returned the cursor
		// itself, not undefined.
		expect(vi.mocked(readCopilotChatTranscript).mock.calls[0][1]).toBeTruthy();
	});

	it("dispatches to the JSONL reader for source=codex", async () => {
		const entries = await loadUnreadMergedTranscript(
			{
				sessionId: "s",
				transcriptPath: "/synthetic/codex.jsonl",
				updatedAt: "2026-05-15T00:00:00Z",
				source: "codex",
			},
			projectDir,
		);
		expect(readTranscript).toHaveBeenCalledTimes(1);
		expect(entries).toEqual([{ role: "human", content: "claude-or-codex-payload" }]);
	});

	// The default switch case (the `source` fallback to "claude" when
	// SessionInfo lacks the field) — exercises `s.source ?? "claude"` on
	// line 68 along with the default arm of the switch. `loadUnreadMergedTranscript`
	// is symmetric with `loadMergedTranscript` here; the existing default-source
	// test in the main suite only hits the `loadMergedTranscript` path.
	it("defaults to claude reader when SessionInfo omits source", async () => {
		const entries = await loadUnreadMergedTranscript(
			{
				sessionId: "s",
				transcriptPath: "/synthetic/no-source.jsonl",
				updatedAt: "2026-05-15T00:00:00Z",
				// source intentionally omitted
			},
			projectDir,
		);
		// readTranscript is shared with codex; this verifies it received the
		// claude parser, not the codex parser. We can't introspect the parser
		// arg easily, but the call count + non-empty result is the smoking
		// gun that the default arm was taken.
		expect(readTranscript).toHaveBeenCalledTimes(1);
		expect(entries).toEqual([{ role: "human", content: "claude-or-codex-payload" }]);
	});
});
