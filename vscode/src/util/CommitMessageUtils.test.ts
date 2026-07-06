import { describe, expect, it } from "vitest";
import { findTicketInContext, mergeCommitMessages } from "./CommitMessageUtils.js";

describe("mergeCommitMessages", () => {
	it("handles empty and single-message inputs", () => {
		expect(mergeCommitMessages([])).toBe("");
		expect(mergeCommitMessages(["feat: one thing"])).toBe("feat: one thing");
	});

	it("deduplicates a shared structural prefix", () => {
		expect(
			mergeCommitMessages([
				"Part of PROJ-123: Fix hook race",
				"Part of PROJ-123: Add regression tests",
			]),
		).toBe("Part of PROJ-123: Fix hook race; Add regression tests");
	});

	it("deduplicates different verbs when all messages share the same ticket", () => {
		expect(
			mergeCommitMessages([
				"Closes proj-123: Fix hook race",
				"Part of PROJ-123: Add regression tests",
			]),
		).toBe("Closes proj-123: Fix hook race; Add regression tests");
	});

	it("falls back to a plain join when there is no shared structure", () => {
		expect(
			mergeCommitMessages(["Fix typo in README", "Add dark mode toggle"]),
		).toBe("Fix typo in README; Add dark mode toggle");
	});

	it("does not deduplicate ticket prefixes when tickets differ or delimiters are missing", () => {
		expect(
			mergeCommitMessages([
				"Part of PROJ-123 Fix hook race",
				"Part of PROJ-999: Add regression tests",
			]),
		).toBe(
			"Part of PROJ-123 Fix hook race; Part of PROJ-999: Add regression tests",
		);
	});

	it("falls back to plain join when all messages have ticket prefixes but different ticket numbers", () => {
		expect(
			mergeCommitMessages([
				"Closes PROJ-123: Fix hook race",
				"Part of PROJ-456: Add tests",
			]),
		).toBe("Closes PROJ-123: Fix hook race; Part of PROJ-456: Add tests");
	});
});

describe("findTicketInContext", () => {
	it("returns the ticket from the first selected reference row", () => {
		const items = [
			{ id: "p1", label: "Sidebar redesign plan", contextValue: "plan", isSelected: true },
			{ id: "r1", label: "JOLLI-1620 · Sidebar UX redesign", contextValue: "reference", isSelected: true },
			{ id: "r2", label: "CX-482 · Density follow-ups", contextValue: "reference", isSelected: true },
		];
		expect(findTicketInContext(items)).toBe("JOLLI-1620");
	});

	it("skips excluded reference rows", () => {
		const items = [
			{ id: "r1", label: "JOLLI-1620 · Sidebar UX redesign", contextValue: "reference", isSelected: false },
			{ id: "r2", label: "CX-482 · Density follow-ups", contextValue: "reference", isSelected: true },
		];
		expect(findTicketInContext(items)).toBe("CX-482");
	});

	it("returns undefined when no selected reference has a ticket-shaped label", () => {
		const items = [
			{ id: "n1", label: "VS Code token mapping notes", contextValue: "note", isSelected: true },
			{ id: "r1", label: "Sidebar redesign spec: Notion", contextValue: "reference", isSelected: true },
		];
		expect(findTicketInContext(items)).toBeUndefined();
	});

	it("returns undefined for an empty list", () => {
		expect(findTicketInContext([])).toBeUndefined();
	});
});
