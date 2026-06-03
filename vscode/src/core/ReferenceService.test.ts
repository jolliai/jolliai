import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockLoadPlansRegistry,
	mockLoadPlansRegistryWithStatus,
	mockSavePlansRegistry,
	mockGetCurrentBranch,
	mockReadFileSync,
	mockShowTextDocument,
	mockOpenExternal,
	mockShowWarningMessage,
	mockDeleteReferenceMarkdown,
} = vi.hoisted(() => ({
	mockLoadPlansRegistry: vi.fn(),
	mockLoadPlansRegistryWithStatus: vi.fn(),
	mockSavePlansRegistry: vi.fn(),
	mockGetCurrentBranch: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockShowTextDocument: vi.fn(),
	mockOpenExternal: vi.fn(),
	mockShowWarningMessage: vi.fn(),
	mockDeleteReferenceMarkdown: vi.fn(),
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadPlansRegistry: mockLoadPlansRegistry,
	loadPlansRegistryWithStatus: mockLoadPlansRegistryWithStatus,
	savePlansRegistry: mockSavePlansRegistry,
}));

vi.mock("../../../cli/src/core/references/ReferenceStore.js", () => ({
	deleteReferenceMarkdown: mockDeleteReferenceMarkdown,
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
	removeReference,
} from "./ReferenceService.js";

const fieldVal = (r: ReferenceInfo | undefined, key: string): string | undefined =>
	r?.fields?.find((f) => f.key === key)?.value;

function makeEntry(overrides: Partial<ReferenceEntry> = {}): ReferenceEntry {
	return {
		source: "linear",
		nativeId: "PROJ-1528",
		title: "Treat referenced Linear issues",
		url: "https://linear.app/jolliai/issue/PROJ-1528/",
		sourcePath: "/repo/.jolli/jollimemory/references/linear/PROJ-1528.md",
		addedAt: "2026-05-13T00:00:00Z",
		updatedAt: "2026-05-14T06:06:01.123Z",
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
	// Default: delegate to loadPlansRegistry with changed=false. The migration
	// writeback test overrides with mockResolvedValueOnce.
	mockLoadPlansRegistryWithStatus.mockImplementation(async (cwd: string) => ({
		registry: await mockLoadPlansRegistry(cwd),
		changed: false,
	}));
});

describe("detectReferences", () => {
	it("returns all reference entries across sources", async () => {
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

	it("persists the normalised registry once when migration purged legacy rows/fields (changed=true)", async () => {
		mockLoadPlansRegistryWithStatus.mockResolvedValueOnce({
			registry: { version: 1, plans: {}, references: {} },
			changed: true,
		});

		await detectReferences("/repo");

		expect(mockSavePlansRegistry).toHaveBeenCalledTimes(1);
	});

	it("does not persist when nothing changed (changed=false)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {}, references: {} });

		await detectReferences("/repo");

		expect(mockSavePlansRegistry).not.toHaveBeenCalled();
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
		});
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

	it("enriches ReferenceInfo with the frontmatter fields bag + description preview when readable", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			[
				"---",
				"fields:",
				'  - {"key":"status","label":"Status","value":"In Progress","icon":"circle-large-filled"}',
				'  - {"key":"priority","label":"Priority","value":"Urgent","icon":"flame"}',
				'  - {"key":"labels","label":"Labels","value":"A, B","icon":"tag"}',
				"---",
				"## Problem",
				"",
				"body here",
				"",
			].join("\n"),
		);
		const result = await detectReferences("/repo");
		expect(fieldVal(result[0], "status")).toBe("In Progress");
		expect(fieldVal(result[0], "priority")).toBe("Urgent");
		expect(fieldVal(result[0], "labels")).toBe("A, B");
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
		expect(result[0].fields).toBeUndefined();
	});

	it("gracefully handles malformed frontmatter (no opening ---)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue("no frontmatter at all");
		const result = await detectReferences("/repo");
		expect(result[0].fields).toBeUndefined();
	});

	it("gracefully handles missing closing ---", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			'---\nfields:\n  - {"key":"status","label":"Status","value":"x"}\n(no closing)',
		);
		const result = await detectReferences("/repo");
		expect(result[0].fields).toBeUndefined();
	});

	it("skips a non-JSON fields list item but preserves valid items / description", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			[
				"---",
				"fields:",
				'  - {"key":"status","label":"Status","value":"In Progress"}',
				"  - not-json-quoted",
				"---",
				"body",
				"",
			].join("\n"),
		);
		const result = await detectReferences("/repo");
		expect(fieldVal(result[0], "status")).toBe("In Progress");
		expect(result[0].fields).toHaveLength(1);
		expect(result[0].description).toBe("body");
	});

	it("skips a bad-shape fields list item (valid JSON, missing key/label/value)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			[
				"---",
				"fields:",
				'  - {"label":"Status","value":"open"}',
				"---",
				"body",
				"",
			].join("\n"),
		);
		const result = await detectReferences("/repo");
		expect(result[0].fields).toBeUndefined();
		expect(result[0].description).toBe("body");
	});

	it("skips a fields list item that is valid JSON but not an object (bare number)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			[
				"---",
				"fields:",
				"  - 42",
				'  - {"key":"status","label":"Status","value":"open"}',
				"---",
				"body",
				"",
			].join("\n"),
		);
		const result = await detectReferences("/repo");
		expect(result[0].fields).toHaveLength(1);
		expect(fieldVal(result[0], "status")).toBe("open");
	});

	it("skips a fields list item whose icon is not a string", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			[
				"---",
				"fields:",
				'  - {"key":"status","label":"Status","value":"open","icon":42}',
				'  - {"key":"labels","label":"Labels","value":"bug"}',
				"---",
				"body",
				"",
			].join("\n"),
		);
		const result = await detectReferences("/repo");
		expect(result[0].fields).toHaveLength(1);
		expect(fieldVal(result[0], "labels")).toBe("bug");
	});

	it("frontmatter: fields present but body empty", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			'---\nfields:\n  - {"key":"labels","label":"Labels","value":"A"}\n---\n',
		);
		const result = await detectReferences("/repo");
		expect(fieldVal(result[0], "labels")).toBe("A");
		expect(result[0].description).toBeUndefined();
	});

	it("frontmatter: no fields but body present", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue("---\nsource: \"linear\"\n---\nbody text");
		const result = await detectReferences("/repo");
		expect(result[0].fields).toBeUndefined();
		expect(result[0].description).toBe("body text");
	});

	it("frontmatter: ends the fields block when a non-list-item line interrupts (inFields=false arm)", async () => {
		// Pins the `inFields = false` reset after the `^\s+- (.+)$` match fails
		// inside the fields block — a trailing scalar line must not be swallowed
		// by the list parser.
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			[
				"---",
				"fields:",
				'  - {"key":"status","label":"Status","value":"A"}',
				'source: "linear"',
				"---",
				"body",
				"",
			].join("\n"),
		);
		const result = await detectReferences("/repo");
		expect(result[0].fields).toHaveLength(1);
		expect(fieldVal(result[0], "status")).toBe("A");
	});

	it("frontmatter: skips non-fields scalar lines silently", async () => {
		// A frontmatter line that is neither `fields:` nor a list item under it
		// is ignored — readFrontmatter only collects the fields bag.
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			'---\nsource: "linear"\nnativeId: "PROJ-1528"\n---\nbody\n',
		);
		const result = await detectReferences("/repo");
		expect(result[0].fields).toBeUndefined();
		expect(result[0].description).toBe("body");
	});
});

describe("removeReference", () => {
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
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: {},
		});
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

	it("still removes the registry row when the markdown delete throws", async () => {
		const entry = makeJiraEntry();
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "jira:KAN-5": entry },
		});
		mockDeleteReferenceMarkdown.mockRejectedValueOnce(new Error("EACCES"));
		await removeReference("/repo", "jira:KAN-5");
		expect(mockSavePlansRegistry).toHaveBeenCalled();
		const saved = mockSavePlansRegistry.mock.calls[0][0];
		expect(saved.references["jira:KAN-5"]).toBeUndefined();
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
