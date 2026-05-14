import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockLoadPlansRegistry,
	mockSavePlansRegistry,
	mockGetCurrentBranch,
	mockReadFileSync,
	mockShowTextDocument,
	mockOpenExternal,
} = vi.hoisted(() => ({
	mockLoadPlansRegistry: vi.fn(),
	mockSavePlansRegistry: vi.fn(),
	mockGetCurrentBranch: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockShowTextDocument: vi.fn(),
	mockOpenExternal: vi.fn(),
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadPlansRegistry: mockLoadPlansRegistry,
	savePlansRegistry: mockSavePlansRegistry,
}));

vi.mock("./PlanService.js", () => ({
	getCurrentBranch: mockGetCurrentBranch,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: mockReadFileSync };
});

vi.mock("vscode", () => ({
	Uri: {
		parse: vi.fn((u: string) => ({ toString: () => u })),
		file: vi.fn((p: string) => ({ toString: () => p })),
	},
	env: { openExternal: mockOpenExternal },
	window: {
		showTextDocument: mockShowTextDocument,
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			append: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		})),
	},
}));

import type { LinearIssueEntry } from "../../../cli/src/Types.js";
import type { LinearIssueInfo } from "../Types.js";
import {
	detectLinearIssues,
	openLinearIssueInBrowser,
	openLinearIssueMarkdown,
	setLinearIssueIgnored,
} from "./LinearIssueService.js";

function makeEntry(
	overrides: Partial<LinearIssueEntry> = {},
): LinearIssueEntry {
	return {
		ticketId: "JOLLI-1528",
		title: "Treat referenced Linear issues",
		url: "https://linear.app/jolliai/issue/JOLLI-1528/",
		sourcePath: "/repo/.jolli/jollimemory/linear-issues/JOLLI-1528.md",
		branch: "main",
		addedAt: "2026-05-13T00:00:00Z",
		updatedAt: "2026-05-14T06:06:01.123Z",
		commitHash: null,
		sourceToolName: "mcp__linear__get_issue",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetCurrentBranch.mockReturnValue("main");
	mockReadFileSync.mockImplementation(() => {
		throw new Error("ENOENT");
	});
});

describe("detectLinearIssues", () => {
	it("returns uncommitted, non-ignored entries on the current branch", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry() },
		});

		const result = await detectLinearIssues("/repo");

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			kind: "linearissue",
			ticketId: "JOLLI-1528",
			mapKey: "JOLLI-1528",
			title: "Treat referenced Linear issues",
			url: "https://linear.app/jolliai/issue/JOLLI-1528/",
			commitHash: null,
			ignored: false,
		});
	});

	it("filters out ignored entries", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry({ ignored: true }) },
		});
		const result = await detectLinearIssues("/repo");
		expect(result).toHaveLength(0);
	});

	it("filters out guard entries (have contentHashAtCommit)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: {
				"JOLLI-1528": makeEntry({
					contentHashAtCommit: "h",
					commitHash: "abc",
				}),
			},
		});
		const result = await detectLinearIssues("/repo");
		expect(result).toHaveLength(0);
	});

	it("filters out archived snapshot entries (commitHash set, no contentHashAtCommit)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: {
				"JOLLI-1528-abc1234": makeEntry({ commitHash: "abc1234" }),
			},
		});
		const result = await detectLinearIssues("/repo");
		expect(result).toHaveLength(0);
	});

	it("filters out entries on other branches", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry({ branch: "feature-x" }) },
		});
		mockGetCurrentBranch.mockReturnValue("main");
		const result = await detectLinearIssues("/repo");
		expect(result).toHaveLength(0);
	});

	it("returns empty when registry has no linearIssues section", async () => {
		mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });
		expect(await detectLinearIssues("/repo")).toEqual([]);
	});

	it("sorts entries by lastModified descending (newest first)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: {
				"JOLLI-1": makeEntry({
					ticketId: "JOLLI-1",
					updatedAt: "2026-05-14T03:00:00Z",
				}),
				"JOLLI-2": makeEntry({
					ticketId: "JOLLI-2",
					updatedAt: "2026-05-14T01:00:00Z",
				}),
				"JOLLI-3": makeEntry({
					ticketId: "JOLLI-3",
					updatedAt: "2026-05-14T02:00:00Z",
				}),
			},
		});
		const result = await detectLinearIssues("/repo");
		expect(result.map((r) => r.ticketId)).toEqual([
			"JOLLI-1",
			"JOLLI-3",
			"JOLLI-2",
		]);
	});

	it("enriches LinearIssueInfo with frontmatter status / priority / labels / description preview when markdown is readable", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			'---\nticketId: "JOLLI-1528"\ntitle: "t"\nurl: "u"\nstatus: "In Progress"\npriority: "Urgent"\nlabels:\n  - "A"\n  - "B"\nreferencedAt: "x"\nsourceToolName: "y"\n---\n## Problem\n\nbody here\n',
		);
		const result = await detectLinearIssues("/repo");
		expect(result[0]).toMatchObject({
			status: "In Progress",
			priority: "Urgent",
			labels: ["A", "B"],
		});
		expect(result[0].description).toContain("Problem");
	});

	it("gracefully handles missing markdown file (falls back to plans.json metadata only)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry() },
		});
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const result = await detectLinearIssues("/repo");
		expect(result).toHaveLength(1);
		expect(result[0].status).toBeUndefined();
	});

	it("gracefully handles malformed frontmatter (no opening --- delimiter)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue("no frontmatter at all");
		const result = await detectLinearIssues("/repo");
		expect(result[0].status).toBeUndefined();
	});

	it("gracefully handles missing closing --- delimiter", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue('---\nstatus: "x"\n(no closing)');
		const result = await detectLinearIssues("/repo");
		expect(result[0].status).toBeUndefined();
	});

	it("returns empty frontmatter when labels list contains invalid JSON", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			'---\nstatus: "In Progress"\nlabels:\n  - not-json-quoted\n---\nbody\n',
		);
		const result = await detectLinearIssues("/repo");
		expect(result[0].labels).toBeUndefined();
		expect(result[0].status).toBeUndefined();
	});

	it("frontmatter parse: labels present but body empty (covers line 202 FALSE branch)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			'---\nstatus: "X"\nlabels:\n  - "A"\n---\n',
		);
		const result = await detectLinearIssues("/repo");
		expect(result[0].labels).toEqual(["A"]);
		expect(result[0].description).toBeUndefined();
	});

	it("frontmatter parse: no labels but body present (covers line 201 FALSE branch)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue('---\nstatus: "X"\n---\nbody text');
		const result = await detectLinearIssues("/repo");
		expect(result[0].labels).toBeUndefined();
		expect(result[0].description).toBe("body text");
	});

	it("does not filter by branch when getCurrentBranch returns null (no git)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry({ branch: "feature-x" }) },
		});
		mockGetCurrentBranch.mockReturnValue(null);
		const result = await detectLinearIssues("/repo");
		expect(result).toHaveLength(1);
	});
});

describe("setLinearIssueIgnored", () => {
	it("sets ignored=true on the entry keyed by mapKey", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry() },
		});
		await setLinearIssueIgnored("/repo", "JOLLI-1528", true);
		expect(mockSavePlansRegistry).toHaveBeenCalled();
		const saved = mockSavePlansRegistry.mock.calls[0][0];
		expect(saved.linearIssues["JOLLI-1528"].ignored).toBe(true);
	});

	it("clears ignored when set to false", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: { "JOLLI-1528": makeEntry({ ignored: true }) },
		});
		await setLinearIssueIgnored("/repo", "JOLLI-1528", false);
		const saved = mockSavePlansRegistry.mock.calls[0][0];
		expect(saved.linearIssues["JOLLI-1528"].ignored).toBeUndefined();
	});

	it("is a no-op when mapKey is not in the registry", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			linearIssues: {},
		});
		await setLinearIssueIgnored("/repo", "JOLLI-99", true);
		expect(mockSavePlansRegistry).not.toHaveBeenCalled();
	});

	it("handles missing linearIssues section gracefully", async () => {
		mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });
		await setLinearIssueIgnored("/repo", "JOLLI-99", true);
		expect(mockSavePlansRegistry).not.toHaveBeenCalled();
	});
});

describe("open helpers", () => {
	const info: LinearIssueInfo = {
		kind: "linearissue",
		ticketId: "JOLLI-1528",
		mapKey: "JOLLI-1528",
		title: "t",
		url: "https://linear.app/x/JOLLI-1528",
		sourcePath: "/repo/.jolli/jollimemory/linear-issues/JOLLI-1528.md",
		branch: "main",
		addedAt: "x",
		updatedAt: "x",
		lastModified: "x",
		commitHash: null,
		ignored: false,
		sourceToolName: "mcp__linear__get_issue",
	};

	it("openLinearIssueInBrowser calls vscode.env.openExternal", async () => {
		mockOpenExternal.mockResolvedValue(true);
		const result = await openLinearIssueInBrowser(info);
		expect(result).toBe(true);
		expect(mockOpenExternal).toHaveBeenCalledOnce();
	});

	it("openLinearIssueMarkdown calls vscode.window.showTextDocument", async () => {
		mockShowTextDocument.mockResolvedValue(undefined);
		await openLinearIssueMarkdown(info);
		expect(mockShowTextDocument).toHaveBeenCalledOnce();
	});
});
