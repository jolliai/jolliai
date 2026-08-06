import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceEntry } from "../../Types.js";

const { mockLoadPlansRegistry, mockSavePlansRegistry, mockDeleteReferenceMarkdown } = vi.hoisted(() => ({
	mockLoadPlansRegistry: vi.fn(),
	mockSavePlansRegistry: vi.fn(),
	mockDeleteReferenceMarkdown: vi.fn(),
}));

// plans.lock passthrough — run the RMW body inline (no real lock file I/O on the
// synthetic CWD). The lock contract is covered in cli/src/core/Locks.test.ts.
vi.mock("../Locks.js", () => ({
	withPlansLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../SessionTracker.js", () => ({
	loadPlansRegistry: mockLoadPlansRegistry,
	savePlansRegistry: mockSavePlansRegistry,
}));

vi.mock("./ReferenceStore.js", () => ({
	deleteReferenceMarkdown: mockDeleteReferenceMarkdown,
}));

import { removeReference } from "./ReferenceService.js";

function makeJiraEntry(): ReferenceEntry {
	return {
		source: "jira",
		nativeId: "KAN-5",
		title: "Fix the thing",
		url: "https://example.atlassian.net/browse/KAN-5",
		sourcePath: "/repo/.jolli/jollimemory/references/jira/KAN-5.md",
		addedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		sourceToolName: "mcp__atlassian__getJiraIssue",
	};
}

describe("removeReference", () => {
	beforeEach(() => {
		mockLoadPlansRegistry.mockReset();
		mockSavePlansRegistry.mockReset();
		mockDeleteReferenceMarkdown.mockReset();
	});

	it("removes the registry row and deletes the backing markdown", async () => {
		const entry = makeJiraEntry();
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "jira:KAN-5": entry },
		});
		await removeReference("/repo", "jira:KAN-5");
		expect(mockDeleteReferenceMarkdown).toHaveBeenCalledWith(entry.sourcePath);
		expect(mockSavePlansRegistry).toHaveBeenCalled();
		const saved = mockSavePlansRegistry.mock.calls[0][0];
		expect(saved.version).toBe(1);
		expect(saved.references["jira:KAN-5"]).toBeUndefined();
	});

	it("is a no-op when mapKey is not in the registry", async () => {
		mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {}, references: {} });
		await removeReference("/repo", "jira:UNKNOWN");
		expect(mockSavePlansRegistry).not.toHaveBeenCalled();
		expect(mockDeleteReferenceMarkdown).not.toHaveBeenCalled();
	});

	it("no-ops when the registry omits the references field entirely (?? {} fallback)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });
		await removeReference("/repo", "jira:KAN-5");
		expect(mockSavePlansRegistry).not.toHaveBeenCalled();
		expect(mockDeleteReferenceMarkdown).not.toHaveBeenCalled();
	});

	it("preserves the plans / notes sections on save", async () => {
		const notes = { "note-1": { foo: "bar" } };
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: { "plan-1": { slug: "x" } },
			notes,
			references: { "jira:KAN-5": makeJiraEntry() },
		});
		await removeReference("/repo", "jira:KAN-5");
		const saved = mockSavePlansRegistry.mock.calls[0][0];
		expect(saved.plans).toEqual({ "plan-1": { slug: "x" } });
		expect(saved.notes).toEqual(notes);
		expect(saved.references).toEqual({});
	});

	// Removing one reference must not erase the skill registry — the closure
	// rebuilds the registry field-by-field, so `skills` has to be carried
	// explicitly. See PlansRegistryWriters.test.ts.
	it("preserves the skills section on save", async () => {
		const skills = { "claude:brainstorming": { source: "claude", skill: "brainstorming" } };
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			skills,
			references: { "jira:KAN-5": makeJiraEntry() },
		});
		await removeReference("/repo", "jira:KAN-5");
		expect(mockSavePlansRegistry.mock.calls[0][0].skills).toEqual(skills);
	});

	it("still removes the registry row when the markdown delete throws", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "jira:KAN-5": makeJiraEntry() },
		});
		mockDeleteReferenceMarkdown.mockRejectedValueOnce(new Error("EACCES"));
		await removeReference("/repo", "jira:KAN-5");
		expect(mockSavePlansRegistry).toHaveBeenCalled();
		const saved = mockSavePlansRegistry.mock.calls[0][0];
		expect(saved.references["jira:KAN-5"]).toBeUndefined();
	});
});
