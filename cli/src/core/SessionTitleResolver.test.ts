import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ClaudeAiTitleReader.js", () => ({
	readClaudeAiTitle: vi.fn(),
}));

vi.mock("./FallbackTitle.js", () => ({
	readFirstUserMessageTitle: vi.fn(),
	UNTITLED_SESSION: "(untitled session)",
	TITLE_MAX_CODE_POINTS: 60,
	truncateToCodePoints: (s: string) => s,
}));

import { readClaudeAiTitle } from "./ClaudeAiTitleReader.js";
import { readFirstUserMessageTitle } from "./FallbackTitle.js";
import { firstUserMessageTitleFromEntries, resolveSessionTitle } from "./SessionTitleResolver.js";

describe("resolveSessionTitle", () => {
	beforeEach(() => {
		vi.mocked(readClaudeAiTitle).mockReset();
		vi.mocked(readFirstUserMessageTitle).mockReset();
	});

	it("uses SessionInfo.title when present (opencode/cursor/copilot/cline/cline-cli)", async () => {
		for (const source of ["opencode", "cursor", "copilot", "cline", "cline-cli"] as const) {
			const result = await resolveSessionTitle({
				sessionId: "s1",
				transcriptPath: "/tmp/x",
				updatedAt: "2026-05-15T00:00:00Z",
				source,
				title: "native title here",
			});
			expect(result).toBe("native title here");
		}
		expect(readClaudeAiTitle).not.toHaveBeenCalled();
		expect(readFirstUserMessageTitle).not.toHaveBeenCalled();
	});

	it("for Claude, calls readClaudeAiTitle when SessionInfo has no title", async () => {
		vi.mocked(readClaudeAiTitle).mockResolvedValueOnce("from ai-title");
		const result = await resolveSessionTitle({
			sessionId: "s1",
			transcriptPath: "/tmp/x.jsonl",
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(result).toBe("from ai-title");
		expect(readClaudeAiTitle).toHaveBeenCalledWith("/tmp/x.jsonl");
	});

	it("skips the Claude ai-title disk read when the session has no transcript path", async () => {
		// Archived sessions (orphan-branch snapshots) often carry no live
		// transcriptPath — streaming "" would be a guaranteed-ENOENT fs
		// round-trip, and it made callers' evidence pipelines timing-sensitive.
		const result = await resolveSessionTitle(
			{ sessionId: "s1", transcriptPath: "", updatedAt: "2026-05-15T00:00:00Z", source: "claude" },
			[{ role: "human", content: "bare turn" }],
		);
		expect(result).toBe("bare turn");
		expect(readClaudeAiTitle).not.toHaveBeenCalled();
	});

	it("falls back to first-user-message when Claude has no ai-title", async () => {
		vi.mocked(readClaudeAiTitle).mockResolvedValueOnce(undefined);
		vi.mocked(readFirstUserMessageTitle).mockResolvedValueOnce("first user msg");
		const result = await resolveSessionTitle({
			sessionId: "s1",
			transcriptPath: "/tmp/x.jsonl",
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(result).toBe("first user msg");
	});

	it("for codex/gemini/copilot-chat, always falls back to first-user-message", async () => {
		vi.mocked(readFirstUserMessageTitle).mockResolvedValue("truncated msg");
		for (const source of ["codex", "gemini", "copilot-chat"] as const) {
			const result = await resolveSessionTitle({
				sessionId: "s1",
				transcriptPath: "/tmp/x.jsonl",
				updatedAt: "2026-05-15T00:00:00Z",
				source,
			});
			expect(result).toBe("truncated msg");
		}
		expect(readClaudeAiTitle).not.toHaveBeenCalled();
	});

	it("returns UNTITLED_SESSION when all paths fail", async () => {
		vi.mocked(readClaudeAiTitle).mockRejectedValueOnce(new Error("boom"));
		vi.mocked(readFirstUserMessageTitle).mockResolvedValueOnce("(untitled session)");
		const result = await resolveSessionTitle({
			sessionId: "s1",
			transcriptPath: "/tmp/x.jsonl",
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(result).toBe("(untitled session)");
	});

	// Silent-failure observability: when the fallback `readFirstUserMessageTitle`
	// itself throws (vs. just resolving to a generic untitled string), the
	// resolver swallows the error, logs at debug, and returns UNTITLED_SESSION
	// — the catch block at the bottom of the cascade.
	it("returns UNTITLED_SESSION when readFirstUserMessageTitle rejects", async () => {
		vi.mocked(readClaudeAiTitle).mockResolvedValueOnce(undefined);
		vi.mocked(readFirstUserMessageTitle).mockRejectedValueOnce(new Error("stream error"));
		const result = await resolveSessionTitle({
			sessionId: "s1",
			transcriptPath: "/tmp/x.jsonl",
			updatedAt: "2026-05-15T00:00:00Z",
			source: "claude",
		});
		expect(result).toBe("(untitled session)");
	});

	it("returns UNTITLED_SESSION when readFirstUserMessageTitle rejects for codex (no native reader cascade)", async () => {
		vi.mocked(readFirstUserMessageTitle).mockRejectedValueOnce(new Error("disk"));
		const result = await resolveSessionTitle({
			sessionId: "s1",
			transcriptPath: "/tmp/x.jsonl",
			updatedAt: "2026-05-15T00:00:00Z",
			source: "codex",
		});
		expect(result).toBe("(untitled session)");
	});

	// `mergedEntries`-provided branch — when the caller (sidebar aggregator)
	// has already loaded + overlay-applied the transcript, the resolver must
	// take the in-memory shortcut via `firstUserMessageTitleFromEntries`
	// instead of paying for a second disk pass. Mocking `readFirstUserMessageTitle`
	// to throw verifies we never reach the streaming fallback.
	it("uses mergedEntries shortcut when caller supplies them (no disk read)", async () => {
		vi.mocked(readFirstUserMessageTitle).mockRejectedValueOnce(new Error("disk reached"));
		const result = await resolveSessionTitle(
			{
				sessionId: "s1",
				transcriptPath: "/tmp/x.jsonl",
				updatedAt: "2026-05-15T00:00:00Z",
				source: "codex",
			},
			[
				{ role: "assistant", content: "asst-first" },
				{ role: "human", content: "the first human turn" },
				{ role: "human", content: "later turn" },
			],
		);
		expect(result).toBe("the first human turn");
		expect(readFirstUserMessageTitle).not.toHaveBeenCalled();
	});
});

// `firstUserMessageTitleFromEntries` is a pure helper exposed for the
// sidebar aggregator's "load once, derive both count and title" shortcut.
// Tested directly so the mergedEntries→title contract stays pinned even if
// `resolveSessionTitle` ever stops delegating to it.
describe("firstUserMessageTitleFromEntries", () => {
	it("returns the truncated first human-role entry", () => {
		expect(
			firstUserMessageTitleFromEntries([
				{ role: "assistant", content: "ignored" },
				{ role: "human", content: "the title" },
				{ role: "human", content: "later" },
			]),
		).toBe("the title");
	});

	it("returns UNTITLED_SESSION when no human entries exist", () => {
		expect(
			firstUserMessageTitleFromEntries([
				{ role: "assistant", content: "only assistant" },
				{ role: "assistant", content: "another" },
			]),
		).toBe("(untitled session)");
	});

	it("skips human entries whose content is empty or whitespace-only", () => {
		expect(
			firstUserMessageTitleFromEntries([
				{ role: "human", content: "" },
				{ role: "human", content: "   " },
				{ role: "human", content: "real" },
			]),
		).toBe("real");
	});

	it("returns UNTITLED_SESSION for an empty entries array", () => {
		expect(firstUserMessageTitleFromEntries([])).toBe("(untitled session)");
	});
});
