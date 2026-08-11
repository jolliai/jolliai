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
	mockExecuteCommand,
	mockShowArchivedMarkdownPreview,
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
	mockExecuteCommand: vi.fn(),
	mockShowArchivedMarkdownPreview: vi.fn(),
}));

// plans.lock passthrough — run the RMW body inline (no real lock file I/O on the
// synthetic CWD). The lock contract is covered in cli/src/core/Locks.test.ts.
vi.mock("../../../cli/src/core/Locks.js", () => ({
	withPlansLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadPlansRegistry: mockLoadPlansRegistry,
	loadPlansRegistryWithStatus: mockLoadPlansRegistryWithStatus,
	savePlansRegistry: mockSavePlansRegistry,
}));

// Partial: only the delete is stubbed. `readReferenceMarkdownFromString` stays REAL
// because `renderReferenceForPreview` parses through it, and a stub there would make
// the header assertions pass against a fake parser rather than the shipped one.
vi.mock("../../../cli/src/core/references/ReferenceStore.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../cli/src/core/references/ReferenceStore.js")>()),
	deleteReferenceMarkdown: mockDeleteReferenceMarkdown,
}));

vi.mock("./PlanService.js", () => ({
	getCurrentBranch: mockGetCurrentBranch,
}));

// The virtual-document scheme is a unit of its own (ArchivedMarkdownPreview.test.ts);
// here we only assert that the preview path delegates to it with the right ref, and
// mocking it keeps the vscode stub above from needing a provider registry.
vi.mock("./ArchivedMarkdownPreview.js", () => ({
	showArchivedMarkdownPreview: mockShowArchivedMarkdownPreview,
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
	commands: { executeCommand: mockExecuteCommand },
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

import { setManuallyDisabled } from "../../../cli/src/Logger.js";
import type { ReferenceEntry } from "../../../cli/src/Types.js";
import type { ReferenceInfo } from "../Types.js";
import {
	detectReferences,
	openReferenceInBrowser,
	openReferenceMarkdown,
	previewReferenceMarkdown,
	readActiveReferenceForPreview,
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
		// Two primed responses: the read-side load, then the fresh re-read done
		// inside plans.lock before the writeback (both still see changed=true since
		// nothing has persisted yet).
		mockLoadPlansRegistryWithStatus
			.mockResolvedValueOnce({
				registry: { version: 1, plans: {}, references: {} },
				changed: true,
			})
			.mockResolvedValueOnce({
				registry: { version: 1, plans: {}, references: {} },
				changed: true,
			});

		await detectReferences("/repo");

		expect(mockSavePlansRegistry).toHaveBeenCalledTimes(1);
	});

	it("skips the writeback when the project is manually disabled", async () => {
		mockLoadPlansRegistryWithStatus.mockResolvedValueOnce({
			registry: { version: 1, plans: {}, references: {} },
			changed: true,
		});
		setManuallyDisabled(true);
		try {
			await detectReferences("/repo");
			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
		} finally {
			setManuallyDisabled(false);
		}
	});

	it("skips the writeback when a concurrent process already normalised it (in-lock fresh.changed=false)", async () => {
		// Outer read reports changed=true, but by the time we hold plans.lock the
		// fresh re-read reports changed=false (a peer persisted the normalization
		// first) — the idempotency guard must skip the redundant save.
		mockLoadPlansRegistryWithStatus
			.mockResolvedValueOnce({
				registry: { version: 1, plans: {}, references: {} },
				changed: true,
			})
			.mockResolvedValueOnce({
				registry: { version: 1, plans: {}, references: {} },
				changed: false,
			});

		await detectReferences("/repo");

		expect(mockSavePlansRegistry).not.toHaveBeenCalled();
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

	it("defaults url to empty string for a persisted entry with no url (defensive — no shipping source emits one)", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: {
				"slack:C0-123.456": makeEntry({
					source: "slack",
					nativeId: "C0-123.456",
					title: "Thread about the release",
					url: undefined,
					sourcePath: "/repo/.jolli/jollimemory/references/slack/C0-123.456.md",
					sourceToolName: "mcp__claude_ai_Slack__slack_read_thread",
				}),
			},
		});

		const result = await detectReferences("/repo");

		expect(result[0].url).toBe("");
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

	it("strips the auto-generated track-only note from the description snippet", async () => {
		mockLoadPlansRegistry.mockResolvedValue({
			version: 1,
			plans: {},
			references: { "linear:PROJ-1528": makeEntry() },
		});
		mockReadFileSync.mockReturnValue(
			[
				"---",
				'source: "context7"',
				"---",
				"how to use jQuery.ajax()",
				"",
				"<!-- jolli:auto-note -->",
				"",
				"---",
				"",
				"> ℹ️ **This is a bookmark, not a full copy.** Context7's full response is intentionally not saved.",
				"",
			].join("\n"),
		);
		const result = await detectReferences("/repo");
		// Only the query survives — the sentinel and note text must not leak into the snippet.
		expect(result[0].description).toBe("how to use jQuery.ajax()");
		expect(result[0].description).not.toContain("jolli:auto-note");
		expect(result[0].description).not.toContain("bookmark");
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

const REFERENCE_MD = [
	"---",
	'source: "jira"',
	'nativeId: "KAN-5"',
	'title: "Implement Jira adapter"',
	'url: "https://example.atlassian.net/browse/KAN-5"',
	'referencedAt: "2026-05-14T06:06:01.123Z"',
	'sourceToolName: "mcp__claude_ai_Atlassian__getJiraIssue"',
	"---",
	"",
	"The body.",
	"",
].join("\n");

const previewInfo = (): ReferenceInfo => ({
	kind: "reference",
	source: "jira",
	nativeId: "KAN-5",
	mapKey: "jira:KAN-5",
	title: "Implement Jira adapter",
	url: "https://example.atlassian.net/browse/KAN-5",
	sourcePath: "/repo/.jolli/jollimemory/references/jira/KAN-5.md",
	addedAt: "x",
	updatedAt: "x",
	lastModified: "x",
	sourceToolName: "y",
});

describe("readActiveReferenceForPreview", () => {
	it("lifts the hidden frontmatter into a visible header", () => {
		mockReadFileSync.mockReturnValue(REFERENCE_MD);
		const rendered = readActiveReferenceForPreview("/repo/x.md");
		// The header is what the fix exists for: previewing the file itself renders
		// through markdown-it-front-matter, whose empty renderer hides all of this.
		expect(rendered).toContain("# Implement Jira adapter");
		expect(rendered).toContain("[https://example.atlassian.net/browse/KAN-5]");
		expect(rendered).toContain("`jira` · captured 2026-05-14T06:06:01.123Z");
		expect(rendered).toContain("The body.");
		expect(rendered).not.toContain("---\nsource:");
	});

	it("returns undefined when the file is gone (archived on commit, or removed)", () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(readActiveReferenceForPreview("/repo/missing.md")).toBeUndefined();
	});
});

describe("previewReferenceMarkdown", () => {
	beforeEach(() => {
		mockShowArchivedMarkdownPreview.mockClear();
		mockShowArchivedMarkdownPreview.mockResolvedValue(undefined);
		mockExecuteCommand.mockClear();
		mockExecuteCommand.mockResolvedValue(undefined);
		mockShowTextDocument.mockClear();
	});

	it("renders through the virtual document keyed by mapKey, not the file itself", async () => {
		mockReadFileSync.mockReturnValue(REFERENCE_MD);
		await previewReferenceMarkdown(previewInfo());
		expect(mockShowArchivedMarkdownPreview).toHaveBeenCalledOnce();
		const [ref, title, body] = mockShowArchivedMarkdownPreview.mock.calls[0];
		// mapKey, not sourcePath: the ref survives into the URI query and is re-read
		// after a window reload, so a path there would let a restored URI name any file.
		expect(ref).toEqual({ ns: "reference-live", mapKey: "jira:KAN-5" });
		expect(title).toBe("Implement Jira adapter");
		expect(body).toContain("# Implement Jira adapter");
		// The file itself is never handed to markdown.showPreview on this path.
		expect(mockExecuteCommand).not.toHaveBeenCalled();
		expect(mockShowTextDocument).not.toHaveBeenCalled();
	});

	it("falls back to previewing the file when it cannot be read", async () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("EACCES");
		});
		await previewReferenceMarkdown(previewInfo());
		expect(mockShowArchivedMarkdownPreview).not.toHaveBeenCalled();
		// Assert the fallback targets the reference's own sourcePath, not just "some
		// URI" — catches a regression that previews the wrong file. The mocked
		// vscode.Uri.file stringifies back to the path it was given.
		const previewCall = mockExecuteCommand.mock.calls.find(
			(c) => c[0] === "markdown.showPreview",
		);
		expect(previewCall).toBeDefined();
		expect((previewCall?.[1] as { toString(): string }).toString()).toBe(
			"/repo/.jolli/jollimemory/references/jira/KAN-5.md",
		);
		expect(mockShowTextDocument).not.toHaveBeenCalled();
	});
});
