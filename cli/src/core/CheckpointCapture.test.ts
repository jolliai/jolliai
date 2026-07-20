import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./GitOps.js", () => ({
	getWorkingTreeDiff: vi.fn(async () => ({
		content: "diff --git a b",
		stats: { filesChanged: 1, insertions: 2, deletions: 0 },
	})),
	getCurrentBranch: vi.fn(async () => "live-branch"),
}));
vi.mock("./KBPathResolver.js", () => ({
	extractRepoName: vi.fn(() => "myrepo"),
	getRemoteUrl: vi.fn(() => "https://github.com/o/myrepo"),
	resolveKBPath: vi.fn(() => "/kb/myrepo"),
}));
vi.mock("./Summarizer.js", () => ({ generateSummary: vi.fn() }));
vi.mock("./TranscriptReader.js", () => ({ buildMultiSessionContext: vi.fn(() => "conversation") }));
vi.mock("./CheckpointStore.js", () => ({
	CHECKPOINT_SCHEMA_VERSION: 1,
	writeCheckpoint: vi.fn(async () => {}),
}));

import type { JolliMemoryConfig, StoredTranscript } from "../Types.js";
import { generateCheckpoint } from "./CheckpointCapture.js";
import { writeCheckpoint } from "./CheckpointStore.js";
import { getCurrentBranch, getWorkingTreeDiff } from "./GitOps.js";
import { resolveKBPath } from "./KBPathResolver.js";
import { generateSummary } from "./Summarizer.js";

const CREDS = { apiKey: "sk-test" } as unknown as JolliMemoryConfig;

function transcript(over: Record<string, unknown> = {}): StoredTranscript {
	return {
		sessions: [
			{
				sessionId: "s1",
				source: "claude",
				transcriptPath: "",
				entries: [{ role: "human" }, { role: "assistant" }],
				...over,
			},
		],
	} as unknown as StoredTranscript;
}

function summaryResult(over: Record<string, unknown> = {}): unknown {
	return {
		transcriptEntries: 2,
		conversationTurns: 1,
		llm: { provider: "anthropic", model: "claude", input: 10, output: 5, cached: 0, stopReason: "end_turn" },
		stats: { filesChanged: 1, insertions: 2, deletions: 0 },
		topics: [{ title: "T", trigger: "why", response: "did", decisions: "chose" }],
		recap: "one-line recap",
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getWorkingTreeDiff).mockResolvedValue({
		content: "diff --git a b",
		stats: { filesChanged: 1, insertions: 2, deletions: 0 },
	});
	vi.mocked(getCurrentBranch).mockResolvedValue("live-branch");
	vi.mocked(resolveKBPath).mockReturnValue("/kb/myrepo");
	vi.mocked(generateSummary).mockResolvedValue(summaryResult() as never);
});

describe("generateCheckpoint", () => {
	it("throws when no LLM credentials are configured", async () => {
		await expect(generateCheckpoint("/repo", transcript(), {} as JolliMemoryConfig)).rejects.toThrow(
			"no LLM credentials",
		);
	});

	it("throws on an empty capture (no conversation and no working-tree changes)", async () => {
		vi.mocked(getWorkingTreeDiff).mockResolvedValue({
			content: "",
			stats: { filesChanged: 0, insertions: 0, deletions: 0 },
		});
		await expect(generateCheckpoint("/repo", transcript({ entries: [] }), CREDS)).rejects.toThrow(
			"nothing to checkpoint",
		);
	});

	it("captures, persists, and returns the record + resolved kbRoot", async () => {
		const { record, kbRoot } = await generateCheckpoint("/repo", transcript(), CREDS);
		expect(kbRoot).toBe("/kb/myrepo");
		expect(record.kind).toBe("checkpoint");
		expect(record.branch).toBe("live-branch");
		expect(record.topics[0].title).toBe("T");
		expect(record.recap).toBe("one-line recap");
		expect(record.source).toBe("claude");
		expect(record.sessionIds).toEqual(["s1"]);
		expect(record.id).toMatch(/^ckpt-/);
		expect(vi.mocked(writeCheckpoint)).toHaveBeenCalledWith("/kb/myrepo", record);
	});

	it("does NOT persist a draft when persist:false", async () => {
		const { record } = await generateCheckpoint("/repo", transcript(), CREDS, { persist: false });
		expect(record.topics).toHaveLength(1);
		expect(vi.mocked(writeCheckpoint)).not.toHaveBeenCalled();
	});

	it("prefers an explicit branch and kbRoot over resolution", async () => {
		const { kbRoot, record } = await generateCheckpoint("/repo", transcript(), CREDS, {
			branch: "explicit",
			kbRoot: "/explicit/kb",
			id: "ckpt-fixed",
		});
		expect(kbRoot).toBe("/explicit/kb");
		expect(record.branch).toBe("explicit");
		expect(record.id).toBe("ckpt-fixed");
		expect(vi.mocked(resolveKBPath)).not.toHaveBeenCalled();
	});

	it("falls back to the transcript's branch before the live branch", async () => {
		const { record } = await generateCheckpoint("/repo", transcript({ gitBranch: "from-transcript" }), CREDS);
		expect(record.branch).toBe("from-transcript");
		expect(vi.mocked(getCurrentBranch)).not.toHaveBeenCalled();
	});
});
