import { describe, expect, it } from "vitest";
import { findTicketInContext } from "./CommitMessageUtils.js";

// mergeCommitMessages moved to cli/src/core/CommitMessageMerge.ts (re-exported
// here); its tests live next to the implementation in
// cli/src/core/CommitMessageMerge.test.ts.

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

	it("does not misread a `LETTERS-DIGITS` fragment in a free-text title as a ticket", () => {
		// A Notion reference titled "Migrate to UTF-8 encoding" contains "UTF-8",
		// which the old unanchored pattern matched. The anchored pattern must not.
		const items = [
			{ id: "r1", label: "Migrate to UTF-8 encoding", contextValue: "reference", isSelected: true },
		];
		expect(findTicketInContext(items)).toBeUndefined();
	});

	it("does not treat a GitHub `owner/repo#n` reference whose title contains a fragment as a ticket", () => {
		const items = [
			{ id: "r1", label: "jolliai/jolli#959 · Migrate to UTF-8 encoding", contextValue: "reference", isSelected: true },
		];
		expect(findTicketInContext(items)).toBeUndefined();
	});
});
