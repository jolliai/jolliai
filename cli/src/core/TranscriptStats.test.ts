import { describe, expect, it } from "vitest";
import type { StoredTranscript } from "../Types.js";
import { countConversationTurns, countTranscriptEntries, firstBranch } from "./TranscriptStats.js";

function transcript(sessions: unknown[]): StoredTranscript {
	return { sessions } as unknown as StoredTranscript;
}

describe("countTranscriptEntries", () => {
	it("sums entries across all sessions", () => {
		const t = transcript([{ entries: [{}, {}] }, { entries: [{}] }, { entries: [] }]);
		expect(countTranscriptEntries(t)).toBe(3);
	});

	it("is 0 for no sessions", () => {
		expect(countTranscriptEntries(transcript([]))).toBe(0);
	});
});

describe("countConversationTurns", () => {
	it("counts human-role entries, ignoring assistant and role-less entries", () => {
		const t = transcript([
			{ entries: [{ role: "human" }, { role: "assistant" }, { role: "human" }] },
			{ entries: [{ role: "assistant" }, {}] },
		]);
		expect(countConversationTurns(t)).toBe(2);
	});

	it("is 0 when no entry carries a human role", () => {
		expect(countConversationTurns(transcript([{ entries: [{ role: "assistant" }, {}] }]))).toBe(0);
	});
});

describe("firstBranch", () => {
	it("returns the first non-empty gitBranch across sessions", () => {
		const t = transcript([{ gitBranch: "" }, { gitBranch: "feature/x" }, { gitBranch: "feature/y" }]);
		expect(firstBranch(t)).toBe("feature/x");
	});

	it("returns undefined when no session has a usable branch", () => {
		expect(firstBranch(transcript([{ gitBranch: "" }, {}]))).toBeUndefined();
	});
});
