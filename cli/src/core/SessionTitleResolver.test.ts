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

	describe("a supplied aiTitle", () => {
		const claude = { sessionId: "s", transcriptPath: "/t/s.jsonl", updatedAt: "x", source: "claude" as const };

		it("is used without streaming the transcript", async () => {
			expect(await resolveSessionTitle(claude, undefined, "handed over")).toBe("handed over");
			expect(readClaudeAiTitle).not.toHaveBeenCalled();
		});

		it("null means 'looked, found none' and still skips the stream", async () => {
			// The state the three-way parameter exists for: a short conversation with no
			// ai-title row is common, and treating its absence as "unknown" would leave
			// the up-to-4 MB stream on for most sessions.
			vi.mocked(readFirstUserMessageTitle).mockResolvedValue("from the entries");

			const result = await resolveSessionTitle(claude, [{ role: "human", content: "from the entries" }], null);

			expect(result).toBe("from the entries");
			expect(readClaudeAiTitle).not.toHaveBeenCalled();
		});

		it("undefined means 'did not look', so the stream still runs", async () => {
			vi.mocked(readClaudeAiTitle).mockResolvedValue("streamed");
			expect(await resolveSessionTitle(claude, undefined, undefined)).toBe("streamed");
			expect(readClaudeAiTitle).toHaveBeenCalledTimes(1);
		});

		it("loses to a native SessionInfo.title, which is still checked first", async () => {
			expect(await resolveSessionTitle({ ...claude, title: "native" }, undefined, "handed over")).toBe("native");
		});
	});
});

// Every source has an entry in PARSE_LINE, but the ones whose discoverer always
// supplies a native title are deliberate no-op stubs — they exist so the record
// stays exhaustive over TranscriptSource, not because a line format was ever
// reverse-engineered for them. Pin that: the resolver must still hand the
// fallback a parser, and that parser must decline every line rather than invent
// a title from a transcript shape nobody verified.
describe("PARSE_LINE stubs for discoverer-titled sources", () => {
	it.each(["opencode", "cursor", "copilot", "cline", "cline-cli", "devin", "cursor-cli", "antigravity"] as const)(
		"passes a parser for %s that declines every line",
		async (source) => {
			vi.mocked(readFirstUserMessageTitle).mockResolvedValueOnce("(untitled session)");
			await resolveSessionTitle({
				sessionId: "s1",
				transcriptPath: "/tmp/x.jsonl",
				updatedAt: "2026-05-15T00:00:00Z",
				source,
			});

			const { parseLine } = vi.mocked(readFirstUserMessageTitle).mock.calls.at(-1)?.[0] ?? {};
			expect(parseLine).toBeTypeOf("function");
			for (const line of ['{"type":"user","content":"hello"}', "not json", ""]) {
				expect(parseLine?.(line)).toBeUndefined();
			}
		},
	);
});

// Kimi's parser is NOT a no-op stub (state.json often carries no title, so the
// fallback must recover the first user prompt from the ACP wire.jsonl). Pin that
// it extracts a `session/prompt` frame's text and declines everything else.
describe("PARSE_LINE for kimi", () => {
	it("extracts the session/prompt text and declines other frames", async () => {
		vi.mocked(readFirstUserMessageTitle).mockResolvedValueOnce("(untitled session)");
		await resolveSessionTitle({
			sessionId: "s1",
			transcriptPath: "/tmp/wire.jsonl",
			updatedAt: "2026-05-15T00:00:00Z",
			source: "kimi",
		});
		const { parseLine } = vi.mocked(readFirstUserMessageTitle).mock.calls.at(-1)?.[0] ?? {};
		expect(parseLine).toBeTypeOf("function");
		expect(parseLine?.('{"type":"turn.prompt","input":[{"type":"text","text":"hi there"}],"time":1}')).toBe(
			"hi there",
		);
		expect(parseLine?.('{"type":"turn.prompt","input":"bare"}')).toBe("bare");
		expect(parseLine?.('{"type":"context.append_loop_event","event":{}}')).toBeUndefined();
		expect(parseLine?.("not json")).toBeUndefined();
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
