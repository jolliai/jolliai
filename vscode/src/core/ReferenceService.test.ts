import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockLoadPlansRegistry,
	mockSavePlansRegistry,
	mockGetCurrentBranch,
	mockReadFileSync,
	mockShowTextDocument,
	mockOpenExternal,
	mockShowWarningMessage,
} = vi.hoisted(() => ({
	mockLoadPlansRegistry: vi.fn(),
	mockSavePlansRegistry: vi.fn(),
	mockGetCurrentBranch: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockShowTextDocument: vi.fn(),
	mockOpenExternal: vi.fn(),
	mockShowWarningMessage: vi.fn(),
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
		// minimal scheme regex extract — what openReferenceInBrowser's scheme
		// guard needs from vscode.Uri.parse.
		parse: vi.fn((u: string) => {
			const m = /^([a-z][a-z0-9+.-]*):/i.exec(u);
			return { scheme: m?.[1] ?? "", toString: () => u };
		}),
		file: vi.fn((p: string) => ({ toString: () => p })),
	},
	env: { openExternal: mockOpenExternal },
	window: {
		showTextDocument: mockShowTextDocument,
		showWarningMessage: mockShowWarningMessage,
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			append: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		})),
	},
}));

import type { ReferenceEntry } from "../../../cli/src/Types.js";
import type { ReferenceInfo } from "../Types.js";
import {
	detectReferences,
	openReferenceInBrowser,
	openReferenceMarkdown,
	setReferenceIgnored,
} from "./ReferenceService.js";

function makeEntry(overrides: Partial<ReferenceEntry> = {}): ReferenceEntry {
	return {
		source: "linear",
		nativeId: "PROJ-1528",
		title: "Treat referenced Linear issues",
		url: "https://linear.app/jolliai/issue/PROJ-1528/",
		sourcePath: "/repo/.jolli/jollimemory/references/linear/PROJ-1528.md",
		branch: "main",
		addedAt: "2026-05-13T00:00:00Z",
		updatedAt: "2026-05-14T06:06:01.123Z",
		commitHash: null,
		sourceToolName: "mcp__linear__get_issue",
		...overrides,
	};
}

function makeJiraEntry(overrides: Partial<ReferenceEntry> = {}): ReferenceEntry {
	return makeEntry({
		source: "jira",
		nativeId: "KAN-5",
		title: "Implement Jira adapter",
		url: "https://example.atlassian.net/browse/KAN-5",
		sourcePath: "/repo/.jolli/jollimemory/references/jira/KAN-5.md",
		sourceToolName: "mcp__claude_ai_Atlassian__getJiraIssue",
		...overrides,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetCurrentBranch.mockReturnValue("main");
	mockReadFileSync.mockImplementation(() => {
		throw new Error("ENOENT");
	});
});

describe("detectReferences", () => {
	it("returns uncommitted, non-ignored entries on the current branch (all sources)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: {
				"linear:PROJ-1528": makeEntry(),
				"jira:KAN-5": makeJiraEntry(),
			},
		});

		const result = await detectReferences("/repo");

		expect(result).toHaveLength(2);
		expect(result.map((r) => r.source).sort()).toEqual(["jira", "linear"]);
	});

	it("filters by sourceFilter when provided", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: {
				"linear:PROJ-1528": makeEntry(),
				"jira:KAN-5": makeJiraEntry(),
			},
		});

		const linearOnly = await detectReferences("/repo", "linear");
		expect(linearOnly).toHaveLength(1);
		expect(linearOnly[0].source).toBe("linear");

		const jiraOnly = await detectReferences("/repo", "jira");
		expect(jiraOnly).toHaveLength(1);
		expect(jiraOnly[0].source).toBe("jira");

		const githubOnly = await detectReferences("/repo", "github");
		expect(githubOnly).toHaveLength(0);
	});

	it("populates ReferenceInfo from ReferenceEntry (mapKey passes through)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "jira:KAN-5": makeJiraEntry() },
		});
		const result = await detectReferences("/repo");
		expect(result[0]).toMatchObject({
			kind: "reference",
			source: "jira",
			nativeId: "KAN-5",
			mapKey: "jira:KAN-5",
			title: "Implement Jira adapter",
			url: "https://example.atlassian.net/browse/KAN-5",
			commitHash: null,
			ignored: false,
		});
	});

	it("filters out ignored entries", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry({ ignored: true }) },
		});
		expect(await detectReferences("/repo")).toHaveLength(0);
	});

	it("filters out guard entries (contentHashAtCommit set)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: {
				"linear:PROJ-1528": makeEntry({
					contentHashAtCommit: "h",
					commitHash: "abc",
				}),
			},
		});
		expect(await detectReferences("/repo")).toHaveLength(0);
	});

	it("filters out archived snapshots (commitHash set, no contentHashAtCommit)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: {
				"linear:PROJ-1528-abc1234": makeEntry({ commitHash: "abc1234" }),
			},
		});
		expect(await detectReferences("/repo")).toHaveLength(0);
	});

	it("filters out entries on other branches", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry({ branch: "feature-x" }) },
		});
		mockGetCurrentBranch.mockReturnValue("main");
		expect(await detectReferences("/repo")).toHaveLength(0);
	});

	it("does NOT filter by branch when getCurrentBranch returns null", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry({ branch: "feature-x" }) },
		});
		mockGetCurrentBranch.mockReturnValue(null);
		expect(await detectReferences("/repo")).toHaveLength(1);
	});

	it("returns empty when references section is missing", async () => {
		mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });
		expect(await detectReferences("/repo")).toEqual([]);
	});

	it("sorts by lastModified descending", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: {
				"linear:A": makeEntry({
					nativeId: "A",
					updatedAt: "2026-05-14T03:00:00Z",
				}),
				"linear:B": makeEntry({
					nativeId: "B",
					updatedAt: "2026-05-14T01:00:00Z",
				}),
				"jira:C": makeJiraEntry({
					nativeId: "C",
					updatedAt: "2026-05-14T02:00:00Z",
				}),
			},
		});
		const result = await detectReferences("/repo");
		expect(result.map((r) => r.nativeId)).toEqual(["A", "C", "B"]);
	});

	it("enriches ReferenceInfo with frontmatter status / priority / labels / description preview when readable", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			'---\nstatus: "In Progress"\npriority: "Urgent"\nlabels:\n  - "A"\n  - "B"\n---\n## Problem\n\nbody here\n',
		);
		const result = await detectReferences("/repo");
		expect(result[0]).toMatchObject({
			status: "In Progress",
			priority: "Urgent",
			labels: ["A", "B"],
		});
		expect(result[0].description).toContain("Problem");
	});

	it("gracefully handles missing markdown file", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const result = await detectReferences("/repo");
		expect(result).toHaveLength(1);
		expect(result[0].status).toBeUndefined();
	});

	it("gracefully handles malformed frontmatter (no opening ---)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue("no frontmatter at all");
		const result = await detectReferences("/repo");
		expect(result[0].status).toBeUndefined();
	});

	it("gracefully handles missing closing ---", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue('---\nstatus: "x"\n(no closing)');
		const result = await detectReferences("/repo");
		expect(result[0].status).toBeUndefined();
	});

	it("skips bad label line but preserves status / description", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			'---\nstatus: "In Progress"\nlabels:\n  - not-json-quoted\n---\nbody\n',
		);
		const result = await detectReferences("/repo");
		expect(result[0].status).toBe("In Progress");
		expect(result[0].labels).toBeUndefined();
		expect(result[0].description).toBe("body");
	});

	it("frontmatter: labels present but body empty", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue('---\nstatus: "X"\nlabels:\n  - "A"\n---\n');
		const result = await detectReferences("/repo");
		expect(result[0].labels).toEqual(["A"]);
		expect(result[0].description).toBeUndefined();
	});

	it("frontmatter: no labels but body present", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue('---\nstatus: "X"\n---\nbody text');
		const result = await detectReferences("/repo");
		expect(result[0].labels).toBeUndefined();
		expect(result[0].description).toBe("body text");
	});

	it("frontmatter: ends labels block when a non-list-item line interrupts (L285 inLabels=false arm)", async () => {
		// Pins EntityService.ts L285: `inLabels = false` after the
		// `^\s+- (.+)$` match fails inside the labels block. Without this
		// the labels block would silently swallow trailing fields.
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		// labels: starts the labels block, "  - A" is one entry, then
		// "status: ..." is NOT a list-item — the loop must reset inLabels
		// to false and parse status: on the same pass.
		mockReadFileSync.mockReturnValue(
			'---\nlabels:\n  - "A"\nstatus: "After Labels"\n---\nbody\n',
		);
		const result = await detectReferences("/repo");
		expect(result[0].labels).toEqual(["A"]);
		expect(result[0].status).toBe("After Labels");
	});

	it("frontmatter: skips unrecognized scalar fields without affecting status/priority parsing (L292 !kv continue arm)", async () => {
		// Pins EntityService.ts L292: `if (!kv) continue` — when a frontmatter
		// line is neither `labels:` nor a `status:` / `priority:` field, the
		// regex match returns null and the loop must skip silently. Without
		// this branch a stray scalar (e.g. `assignees: bob`, which the
		// frontmatter writer emits but readFrontmatter doesn't yet handle)
		// would crash or get mis-parsed.
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			'---\nassignees: "bob"\nstatus: "Done"\n---\nbody\n',
		);
		const result = await detectReferences("/repo");
		// status still parsed; the unknown `assignees:` line was skipped.
		expect(result[0].status).toBe("Done");
	});
});

describe("setReferenceIgnored", () => {
	it("sets ignored=true on the entry keyed by mapKey", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "jira:KAN-5": makeJiraEntry() },
		});
		await setReferenceIgnored("/repo", "jira:KAN-5", true);
		expect(mockSavePlansRegistry).toHaveBeenCalled();
		const saved = mockSavePlansRegistry.mock.calls[0][0];
		expect(saved.version).toBe(1);
		expect(saved.references["jira:KAN-5"].ignored).toBe(true);
	});

	it("clears ignored when set to false", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "jira:KAN-5": makeJiraEntry({ ignored: true }) },
		});
		await setReferenceIgnored("/repo", "jira:KAN-5", false);
		const saved = mockSavePlansRegistry.mock.calls[0][0];
		expect(saved.references["jira:KAN-5"].ignored).toBeUndefined();
	});

	it("is a no-op when mapKey is not in the registry", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: {},
		});
		await setReferenceIgnored("/repo", "jira:UNKNOWN", true);
		expect(mockSavePlansRegistry).not.toHaveBeenCalled();
	});

	it("preserves the plans / notes sections on save", async () => {
		const notes = { "note-1": { foo: "bar" } };
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: { "plan-1": { slug: "x" } },
			notes,
			references: { "jira:KAN-5": makeJiraEntry() },
		});
		await setReferenceIgnored("/repo", "jira:KAN-5", true);
		const saved = mockSavePlansRegistry.mock.calls[0][0];
		expect(saved.plans).toEqual({ "plan-1": { slug: "x" } });
		expect(saved.notes).toEqual(notes);
	});

});

describe("openReferenceInBrowser — http(s) scheme guard", () => {
	function makeInfo(url: string, overrides: Partial<ReferenceInfo> = {}): ReferenceInfo {
		return {
			kind: "reference",
			source: "linear",
			nativeId: "PROJ-1528",
			mapKey: "linear:PROJ-1528",
			title: "t",
			url,
			sourcePath: "/x.md",
			branch: "main",
			addedAt: "x",
			updatedAt: "x",
			lastModified: "x",
			commitHash: null,
			ignored: false,
			sourceToolName: "y",
			...overrides,
		};
	}

	it("opens https URLs via vscode.env.openExternal", async () => {
		mockOpenExternal.mockResolvedValue(true);
		const result = await openReferenceInBrowser(
			makeInfo("https://linear.app/x/PROJ-1528"),
		);
		expect(result).toBe(true);
		expect(mockOpenExternal).toHaveBeenCalledOnce();
	});

	it("opens http URLs via vscode.env.openExternal", async () => {
		mockOpenExternal.mockResolvedValue(true);
		const result = await openReferenceInBrowser(
			makeInfo("http://example.com/issue/1"),
		);
		expect(result).toBe(true);
	});

	it("rejects javascript: URLs and shows a warning", async () => {
		const result = await openReferenceInBrowser(
			makeInfo("javascript:alert('xss')"),
		);
		expect(result).toBe(false);
		expect(mockOpenExternal).not.toHaveBeenCalled();
		expect(mockShowWarningMessage).toHaveBeenCalled();
	});

	it("rejects data: URLs", async () => {
		const result = await openReferenceInBrowser(
			makeInfo("data:text/html,<script>...</script>"),
		);
		expect(result).toBe(false);
		expect(mockOpenExternal).not.toHaveBeenCalled();
	});

	it("rejects file: URLs", async () => {
		const result = await openReferenceInBrowser(
			makeInfo("file:///etc/passwd"),
		);
		expect(result).toBe(false);
		expect(mockOpenExternal).not.toHaveBeenCalled();
	});
});

describe("openReferenceMarkdown", () => {
	it("calls vscode.window.showTextDocument with the file URI", async () => {
		mockShowTextDocument.mockResolvedValue(undefined);
		await openReferenceMarkdown({
			kind: "reference",
			source: "jira",
			nativeId: "KAN-5",
			mapKey: "jira:KAN-5",
			title: "t",
			url: "https://example.atlassian.net/browse/KAN-5",
			sourcePath: "/repo/.jolli/jollimemory/references/jira/KAN-5.md",
			branch: "main",
			addedAt: "x",
			updatedAt: "x",
			lastModified: "x",
			commitHash: null,
			ignored: false,
			sourceToolName: "y",
		});
		expect(mockShowTextDocument).toHaveBeenCalledOnce();
	});
});
