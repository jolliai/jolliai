import { describe, expect, it } from "vitest";
import { mergeCommitMessages, TICKET_PATTERN } from "./CommitMessageMerge.js";

describe("mergeCommitMessages", () => {
	it("handles empty and single-message inputs", () => {
		expect(mergeCommitMessages([])).toBe("");
		expect(mergeCommitMessages(["feat: one thing"])).toBe("feat: one thing");
	});

	it("deduplicates a shared structural prefix", () => {
		expect(mergeCommitMessages(["Part of PROJ-123: Fix hook race", "Part of PROJ-123: Add regression tests"])).toBe(
			"Part of PROJ-123: Fix hook race; Add regression tests",
		);
	});

	it("deduplicates a shared structural prefix ending in '. '", () => {
		expect(mergeCommitMessages(["Closes PROJ-9. Fix parser", "Closes PROJ-9. Add tests"])).toBe(
			"Closes PROJ-9. Fix parser; Add tests",
		);
	});

	it("deduplicates different verbs when all messages share the same ticket", () => {
		expect(mergeCommitMessages(["Closes proj-123: Fix hook race", "Part of PROJ-123: Add regression tests"])).toBe(
			"Closes proj-123: Fix hook race; Add regression tests",
		);
	});

	it("falls back to a plain join when there is no shared structure", () => {
		expect(mergeCommitMessages(["Fix typo in README", "Add dark mode toggle"])).toBe(
			"Fix typo in README; Add dark mode toggle",
		);
	});

	it("does not deduplicate ticket prefixes when tickets differ or delimiters are missing", () => {
		expect(mergeCommitMessages(["Part of PROJ-123 Fix hook race", "Part of PROJ-999: Add regression tests"])).toBe(
			"Part of PROJ-123 Fix hook race; Part of PROJ-999: Add regression tests",
		);
	});

	it("falls back to plain join when all messages have ticket prefixes but different ticket numbers", () => {
		expect(mergeCommitMessages(["Closes PROJ-123: Fix hook race", "Part of PROJ-456: Add tests"])).toBe(
			"Closes PROJ-123: Fix hook race; Part of PROJ-456: Add tests",
		);
	});

	it("plain-joins when only some messages carry a ticket prefix", () => {
		expect(mergeCommitMessages(["Part of PROJ-123: Fix hook race", "Add dark mode toggle"])).toBe(
			"Part of PROJ-123: Fix hook race; Add dark mode toggle",
		);
	});
});

describe("TICKET_PATTERN", () => {
	it("matches Jira-style ids case-insensitively", () => {
		expect(TICKET_PATTERN.test("PROJ-123")).toBe(true);
		expect(TICKET_PATTERN.test("proj-42")).toBe(true);
		expect(TICKET_PATTERN.test("no ticket here")).toBe(false);
	});
});
