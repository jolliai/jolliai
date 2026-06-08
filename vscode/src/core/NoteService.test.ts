import { normalize } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockLoadPlansRegistry, mockLoadPlansRegistryWithStatus, mockSavePlansRegistry } = vi.hoisted(() => ({
	mockLoadPlansRegistry: vi.fn(),
	mockLoadPlansRegistryWithStatus: vi.fn(),
	mockSavePlansRegistry: vi.fn(),
}));

const { mockStoreNotes } = vi.hoisted(() => ({
	mockStoreNotes: vi.fn(),
}));

const { mockGetJolliMemoryDir } = vi.hoisted(() => ({
	mockGetJolliMemoryDir: vi.fn(() => "/mock-repo/.jolli/jollimemory"),
}));

const { info, warn, error, debug } = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

const {
	mockExistsSync,
	mockMkdirSync,
	mockReadFileSync,
	mockWriteFileSync,
	mockCopyFileSync,
	mockStatSync,
	mockUnlinkSync,
} = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockMkdirSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	mockCopyFileSync: vi.fn(),
	mockStatSync: vi.fn(),
	mockUnlinkSync: vi.fn(),
}));

const { mockGetCurrentBranch } = vi.hoisted(() => ({
	mockGetCurrentBranch: vi.fn(() => "feature/test"),
}));

const { mockCreateHash, mockRandomBytes } = vi.hoisted(() => ({
	mockCreateHash: vi.fn(() => ({
		update: vi.fn().mockReturnThis(),
		digest: vi.fn(() => "mock-sha256-hash"),
	})),
	mockRandomBytes: vi.fn(() => ({ toString: () => "a1b2" })),
}));

// ─── vi.mock declarations ────────────────────────────────────────────────────

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadPlansRegistry: mockLoadPlansRegistry,
	loadPlansRegistryWithStatus: mockLoadPlansRegistryWithStatus,
	savePlansRegistry: mockSavePlansRegistry,
	// Pure helper — real implementation so removeNote's exact→base-guard works.
	splitArchivedKey: (k: string) => {
		const m = k.match(/^(.+)-([0-9a-f]{8})$/);
		return m ? { baseKey: m[1], oldShortHash: m[2] } : null;
	},
}));

// plans.lock passthrough — run the RMW body inline (no real lock file I/O on the
// synthetic CWD). The lock contract is covered in cli/src/core/Locks.test.ts.
vi.mock("../../../cli/src/core/Locks.js", () => ({
	withPlansLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../../../cli/src/core/SummaryStore.js", () => ({
	storeNotes: mockStoreNotes,
}));

vi.mock("../../../cli/src/Logger.js", () => ({
	getJolliMemoryDir: mockGetJolliMemoryDir,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error, debug },
}));

vi.mock("node:fs", () => ({
	existsSync: mockExistsSync,
	mkdirSync: mockMkdirSync,
	readFileSync: mockReadFileSync,
	writeFileSync: mockWriteFileSync,
	copyFileSync: mockCopyFileSync,
	statSync: mockStatSync,
	unlinkSync: mockUnlinkSync,
}));

vi.mock("./PlanService.js", () => ({
	getCurrentBranch: mockGetCurrentBranch,
}));

vi.mock("node:crypto", () => ({
	createHash: mockCreateHash,
	randomBytes: mockRandomBytes,
}));

vi.mock("node:path", async () => {
	const actual = await vi.importActual<typeof import("node:path")>("node:path");
	return { ...actual };
});

// ─── Import under test (after mocks) ────────────────────────────────────────

import {
	archiveNoteForCommit,
	detectNotes,
	generateNoteSlug,
	getNotesDir,
	listUnassociatedNotes,
	removeNote,
	saveNote,
} from "./NoteService.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

const CWD = "/mock-repo";
// Normalized so path comparisons (`path === NOTES_DIR`) match what `path.join` produces
// at runtime on Windows (backslashes) as well as on Unix (forward slashes).
const NOTES_DIR = normalize("/mock-repo/.jolli/jollimemory/notes");

function emptyRegistry() {
	return { version: 1 as const, plans: {}, notes: {} };
}

/** Creates a NoteEntry with sensible defaults */
function makeNoteEntry(overrides: Record<string, unknown> = {}) {
	return {
		id: "test-note",
		title: "Test Note",
		format: "snippet" as const,
		sourcePath: `${NOTES_DIR}/test-note.md`,
		addedAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		branch: "main",
		commitHash: null,
		...overrides,
	};
}

/** Resets the chainable createHash mock to a fresh state */
function resetCreateHashMock(hashValue = "mock-sha256-hash") {
	mockCreateHash.mockImplementation(() => ({
		update: vi.fn().mockReturnThis(),
		digest: vi.fn(() => hashValue),
	}));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("NoteService", () => {
	beforeEach(() => {
		mockLoadPlansRegistry.mockReset();
		mockSavePlansRegistry.mockReset();
		// Default: delegate to loadPlansRegistry with changed=false. The migration
		// writeback test overrides with mockResolvedValueOnce.
		mockLoadPlansRegistryWithStatus.mockReset();
		mockLoadPlansRegistryWithStatus.mockImplementation(async (cwd: string) => ({
			registry: await mockLoadPlansRegistry(cwd),
			changed: false,
		}));
		mockStoreNotes.mockReset();
		mockGetJolliMemoryDir.mockReset();
		mockGetJolliMemoryDir.mockReturnValue("/mock-repo/.jolli/jollimemory");
		info.mockReset();
		warn.mockReset();
		error.mockReset();
		debug.mockReset();
		mockExistsSync.mockReset();
		mockMkdirSync.mockReset();
		mockReadFileSync.mockReset();
		mockWriteFileSync.mockReset();
		mockCopyFileSync.mockReset();
		mockStatSync.mockReset();
		mockCreateHash.mockReset();
		resetCreateHashMock();
		mockRandomBytes.mockReset();
		mockRandomBytes.mockReturnValue({ toString: () => "a1b2" });
		mockGetCurrentBranch.mockReset();
		mockGetCurrentBranch.mockReturnValue("main");
		mockUnlinkSync.mockReset();
	});

	// ─── getNotesDir ─────────────────────────────────────────────────────────

	describe("getNotesDir", () => {
		it("returns path ending in notes subdirectory", () => {
			const dir = getNotesDir(CWD);
			expect(dir).toBe(NOTES_DIR);
		});

		it("passes cwd to getJolliMemoryDir", () => {
			getNotesDir("/some/other/repo");
			expect(mockGetJolliMemoryDir).toHaveBeenCalledWith("/some/other/repo");
		});
	});

	// ─── generateNoteSlug ────────────────────────────────────────────────────

	describe("generateNoteSlug", () => {
		it("generates kebab-case slug from title with random suffix", () => {
			const slug = generateNoteSlug("My Note Title");
			expect(slug).toBe("my-note-title-a1b2");
		});

		it("strips special characters", () => {
			const slug = generateNoteSlug("Hello! @World #2025");
			expect(slug).toBe("hello-world-2025-a1b2");
		});

		it("strips leading and trailing hyphens", () => {
			const slug = generateNoteSlug("---leading-and-trailing---");
			expect(slug).toBe("leading-and-trailing-a1b2");
		});

		it("truncates base to 40 characters", () => {
			const longTitle = "a".repeat(50);
			const slug = generateNoteSlug(longTitle);
			// 40 chars + "-" + "a1b2" = 45 chars total
			expect(slug.startsWith("a".repeat(40))).toBe(true);
			expect(slug).toBe(`${"a".repeat(40)}-a1b2`);
		});

		it("uses 'note' prefix when title produces empty base", () => {
			const slug = generateNoteSlug("!@#$%^&*()");
			expect(slug).toBe("note-a1b2");
		});

		it("uses 'note' prefix for empty title", () => {
			const slug = generateNoteSlug("");
			expect(slug).toBe("note-a1b2");
		});

		it("calls randomBytes(2) for the suffix", () => {
			generateNoteSlug("test");
			expect(mockRandomBytes).toHaveBeenCalledWith(2);
		});
	});

	// ─── detectNotes ─────────────────────────────────────────────────────────

	describe("detectNotes", () => {
		it("returns empty array for empty registry", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());

			const notes = await detectNotes(CWD);

			expect(notes).toEqual([]);
		});

		it("returns empty array when registry has no notes field", async () => {
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });

			const notes = await detectNotes(CWD);

			expect(notes).toEqual([]);
		});

		it("persists the normalised registry once when migration purged legacy rows/fields (changed=true)", async () => {
			// Two primed responses: the read-side load, then the fresh re-read done
			// inside plans.lock before the writeback (nothing has persisted yet, so
			// both still report changed=true).
			mockLoadPlansRegistryWithStatus
				.mockResolvedValueOnce({
					registry: { version: 1, plans: {}, notes: {} },
					changed: true,
				})
				.mockResolvedValueOnce({
					registry: { version: 1, plans: {}, notes: {} },
					changed: true,
				});

			await detectNotes(CWD);

			expect(mockSavePlansRegistry).toHaveBeenCalledTimes(1);
		});

		it("skips the writeback when a concurrent process already normalised it (in-lock fresh.changed=false)", async () => {
			// Outer read reports changed=true, but the in-lock fresh re-read reports
			// changed=false (a peer persisted the normalization first) — the
			// idempotency guard must skip the redundant save.
			mockLoadPlansRegistryWithStatus
				.mockResolvedValueOnce({
					registry: { version: 1, plans: {}, notes: {} },
					changed: true,
				})
				.mockResolvedValueOnce({
					registry: { version: 1, plans: {}, notes: {} },
					changed: false,
				});

			await detectNotes(CWD);

			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
		});

		it("does not persist when nothing changed (changed=false)", async () => {
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {}, notes: {} });

			await detectNotes(CWD);

			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
		});

		it("filters out ignored notes", async () => {
			const entry = makeNoteEntry({ ignored: true });
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});

			const notes = await detectNotes(CWD);

			expect(notes).toEqual([]);
		});

		it("filters out committed snapshot copies (has commitHash, no contentHashAtCommit)", async () => {
			const entry = makeNoteEntry({
				commitHash: "abc12345",
				// no contentHashAtCommit — this is a committed snapshot copy
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});

			const notes = await detectNotes(CWD);

			expect(notes).toEqual([]);
		});

		it("filters out archive guards with matching content hash", async () => {
			const entry = makeNoteEntry({
				commitHash: "abc12345",
				contentHashAtCommit: "mock-sha256-hash", // matches what createHash returns
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("note content");

			const notes = await detectNotes(CWD);

			expect(notes).toEqual([]);
		});

		it("includes archive guard when content has changed (different hash)", async () => {
			const entry = makeNoteEntry({
				commitHash: "abc12345",
				contentHashAtCommit: "old-different-hash", // does NOT match mock-sha256-hash
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("updated content");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			const notes = await detectNotes(CWD);

			expect(notes).toHaveLength(1);
			expect(notes[0].id).toBe("test-note");
		});

		it("filters out archive guard when getNoteContent returns null", async () => {
			const entry = makeNoteEntry({
				commitHash: "abc12345",
				contentHashAtCommit: "old-different-hash",
				sourcePath: undefined, // no source path -> getNoteContent returns null
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(false);

			const notes = await detectNotes(CWD);

			expect(notes).toEqual([]);
		});

		it("filters out uncommitted notes whose source file was deleted", async () => {
			const entry = makeNoteEntry({
				commitHash: null,
				sourcePath: `${NOTES_DIR}/deleted-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(false);

			const notes = await detectNotes(CWD);

			expect(notes).toEqual([]);
		});

		it("includes uncommitted notes whose source file exists", async () => {
			const entry = makeNoteEntry({ commitHash: null });
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});
			mockReadFileSync.mockReturnValue("# Test Note\nContent");

			const notes = await detectNotes(CWD);

			expect(notes).toHaveLength(1);
			expect(notes[0].id).toBe("test-note");
		});

		it("uses statSync mtime for lastModified when source file exists", async () => {
			const entry = makeNoteEntry({
				commitHash: null,
				updatedAt: "2025-01-01T00:00:00.000Z",
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-15T12:00:00.000Z"),
			});
			mockReadFileSync.mockReturnValue("# Test Note\nContent");

			const notes = await detectNotes(CWD);

			expect(notes[0].lastModified).toBe("2025-06-15T12:00:00.000Z");
		});

		it("falls back to updatedAt when statSync throws", async () => {
			const entry = makeNoteEntry({
				commitHash: null,
				updatedAt: "2025-04-01T00:00:00.000Z",
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockStatSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			mockReadFileSync.mockReturnValue("# Test Note\nContent");

			const notes = await detectNotes(CWD);

			expect(notes).toHaveLength(1);
			expect(notes[0].lastModified).toBe("2025-04-01T00:00:00.000Z");
		});

		it("uses extractTitle for uncommitted markdown notes", async () => {
			const entry = makeNoteEntry({
				id: "md-note",
				title: "Old Title",
				format: "markdown",
				commitHash: null,
				sourcePath: `${NOTES_DIR}/md-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "md-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Fresh Title From File\nContent");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			const notes = await detectNotes(CWD);

			expect(notes[0].title).toBe("Fresh Title From File");
		});

		it("does not override title for snippet format notes", async () => {
			const entry = makeNoteEntry({
				id: "snip-note",
				title: "Snippet Title",
				format: "snippet",
				commitHash: null,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "snip-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});
			mockReadFileSync.mockReturnValue("# Different Title");

			const notes = await detectNotes(CWD);

			expect(notes[0].title).toBe("Snippet Title");
		});

		it("does not override title for committed markdown notes", async () => {
			// A committed markdown note with contentHashAtCommit that has changed content
			const entry = makeNoteEntry({
				id: "committed-md",
				title: "Committed Title",
				format: "markdown",
				commitHash: "abc12345",
				contentHashAtCommit: "old-hash-different",
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "committed-md": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Changed Title");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			const notes = await detectNotes(CWD);

			// commitHash !== null, so extractTitle branch is skipped
			expect(notes[0].title).toBe("Committed Title");
		});

		it("sorts by lastModified descending", async () => {
			const entryA = makeNoteEntry({
				id: "note-a",
				title: "Note A",
				format: "snippet",
				commitHash: null,
				sourcePath: `${NOTES_DIR}/note-a.md`,
				updatedAt: "2025-01-01T00:00:00.000Z",
			});
			const entryB = makeNoteEntry({
				id: "note-b",
				title: "Note B",
				format: "snippet",
				commitHash: null,
				sourcePath: `${NOTES_DIR}/note-b.md`,
				updatedAt: "2025-06-01T00:00:00.000Z",
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "note-a": entryA, "note-b": entryB },
			});
			mockExistsSync.mockReturnValue(true);
			mockStatSync.mockImplementation((path: string) => {
				if (path.includes("note-a")) {
					return { mtime: new Date("2025-01-01T00:00:00.000Z") };
				}
				return { mtime: new Date("2025-06-01T00:00:00.000Z") };
			});

			const notes = await detectNotes(CWD);

			expect(notes[0].id).toBe("note-b");
			expect(notes[1].id).toBe("note-a");
		});

		it("populates filename and filePath from sourcePath", async () => {
			const entry = makeNoteEntry({
				commitHash: null,
				sourcePath: `${NOTES_DIR}/my-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});
			mockReadFileSync.mockReturnValue("# Test Note");

			const notes = await detectNotes(CWD);

			expect(notes[0].filename).toBe("my-note.md");
			expect(notes[0].filePath).toBe(`${NOTES_DIR}/my-note.md`);
		});

		it("sets filename and filePath to undefined when sourcePath is absent", async () => {
			const entry = makeNoteEntry({
				commitHash: null,
				sourcePath: undefined,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			// No sourcePath, so existsSync for deleted-file check: entry.sourcePath is undefined
			// The `entry.sourcePath && !existsSync(entry.sourcePath)` check: falsy sourcePath short-circuits

			const notes = await detectNotes(CWD);

			expect(notes[0].filename).toBeUndefined();
			expect(notes[0].filePath).toBeUndefined();
		});

		it("logs the count of found vs registry notes", async () => {
			const visible = makeNoteEntry({ id: "visible", commitHash: null });
			const hidden = makeNoteEntry({ id: "hidden", commitHash: "abc" });
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { visible, hidden },
			});
			mockExistsSync.mockReturnValue(true);
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-01-01T00:00:00.000Z"),
			});

			await detectNotes(CWD);

			expect(info).toHaveBeenCalledWith(
				"notes",
				expect.stringContaining("1 notes"),
			);
			expect(info).toHaveBeenCalledWith(
				"notes",
				expect.stringContaining("2 in registry"),
			);
		});
	});

	// ─── saveNote ────────────────────────────────────────────────────────────

	describe("saveNote", () => {
		it("creates a new snippet note with generated id", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			// Notes dir doesn't exist (first check), but the file "exists" after write
			mockExistsSync.mockImplementation((path: string) => {
				if (path === NOTES_DIR) {
					return false;
				}
				return true; // note file "exists" after writeFileSync
			});
			mockReadFileSync.mockReturnValue("snippet content");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			const result = await saveNote(
				undefined,
				"My Snippet",
				"snippet content",
				"snippet",
				CWD,
			);

			// Should have called mkdirSync since dir doesn't exist
			expect(mockMkdirSync).toHaveBeenCalledWith(NOTES_DIR, {
				recursive: true,
			});
			// Should write file directly for snippets
			expect(mockWriteFileSync).toHaveBeenCalledWith(
				expect.stringContaining("my-snippet-a1b2.md"),
				"snippet content",
				"utf-8",
			);
			// Should save registry with correct note structure
			const saved = mockSavePlansRegistry.mock.calls[0][0];
			const savedNote = saved.notes["my-snippet-a1b2"];
			expect(savedNote.id).toBe("my-snippet-a1b2");
			expect(savedNote.title).toBe("My Snippet");
			expect(savedNote.format).toBe("snippet");
			expect(savedNote.commitHash).toBeNull();
			expect(savedNote.sourcePath).toContain("my-snippet-a1b2.md");
			expect(result.id).toBe("my-snippet-a1b2");
			expect(result.format).toBe("snippet");
		});

		it("creates a new markdown note referencing the original file (no copy)", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# My Markdown Note\nContent");

			const result = await saveNote(
				undefined,
				"My Markdown",
				"/source/path.md",
				"markdown",
				CWD,
			);

			// Should NOT copy — reference original file directly
			expect(mockCopyFileSync).not.toHaveBeenCalled();
			expect(result.format).toBe("markdown");
			expect(result.filePath).toBe("/source/path.md");
		});

		it("does not create notes dir if it already exists", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("content");

			await saveNote(undefined, "Test", "content", "snippet", CWD);

			expect(mockMkdirSync).not.toHaveBeenCalled();
		});

		it("updates an existing note keeping original sourcePath and addedAt", async () => {
			const existing = makeNoteEntry({
				id: "existing-note",
				sourcePath: `${NOTES_DIR}/existing-note.md`,
				addedAt: "2025-01-01T00:00:00.000Z",
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "existing-note": existing },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Updated Title\nContent");

			const result = await saveNote(
				"existing-note",
				"Updated Title",
				"",
				"snippet",
				CWD,
			);

			// Should not copy or write file — existing note just updates metadata
			expect(mockCopyFileSync).not.toHaveBeenCalled();
			expect(mockWriteFileSync).not.toHaveBeenCalled();
			// Should preserve original addedAt
			expect(result.addedAt).toBe("2025-01-01T00:00:00.000Z");
			// sourcePath should be the existing one
			expect(result.filePath).toBe(`${NOTES_DIR}/existing-note.md`);
		});

		it("uses extractTitle when title is empty (from file heading)", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Extracted Heading\nBody text");

			const result = await saveNote(
				undefined,
				"",
				"# Extracted Heading\nBody text",
				"snippet",
				CWD,
			);

			expect(result.title).toBe("Extracted Heading");
		});

		it("falls back to filename when extractTitle finds no heading", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("No heading here");

			const result = await saveNote(
				undefined,
				"",
				"No heading here",
				"snippet",
				CWD,
			);

			// extractTitle returns basename without .md extension
			expect(result.title).toContain("a1b2");
		});

		it("falls back to filename when extractTitle read throws", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			// First call: existsSync for notes dir
			mockExistsSync.mockReturnValue(true);
			// writeFileSync works, but readFileSync throws (for extractTitle)
			mockReadFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});

			const result = await saveNote(undefined, "", "content", "snippet", CWD);

			// extractTitle catch returns basename(filePath, ".md")
			expect(result.title).toContain("a1b2");
		});

		it("uses extractTitle for existing note with empty title", async () => {
			const existing = makeNoteEntry({
				id: "existing-note",
				sourcePath: `${NOTES_DIR}/existing-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "existing-note": existing },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Title From File");

			const result = await saveNote("existing-note", "", "", "snippet", CWD);

			expect(result.title).toBe("Title From File");
		});

		it("uses extractTitle for new markdown note with empty title", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Markdown Heading");

			const result = await saveNote(
				undefined,
				"",
				"/source/file.md",
				"markdown",
				CWD,
			);

			expect(result.title).toBe("Markdown Heading");
		});

		it("preserves existing commitHash on update in registry", async () => {
			const existing = makeNoteEntry({
				id: "committed-note",
				commitHash: "abc12345",
				sourcePath: `${NOTES_DIR}/committed-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "committed-note": existing },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Title");

			await saveNote("committed-note", "Title", "", "snippet", CWD);

			// Verify registry was saved with preserved commitHash
			const saved = mockSavePlansRegistry.mock.calls[0][0];
			expect(saved.notes["committed-note"].commitHash).toBe("abc12345");
		});

		it("sets commitHash to null for new notes", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("content");

			const result = await saveNote(
				undefined,
				"New Note",
				"content",
				"snippet",
				CWD,
			);

			expect(result.commitHash).toBeNull();
		});

		it("logs 'created' for new notes and 'updated' for existing", async () => {
			// New note
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("content");

			await saveNote(undefined, "New", "content", "snippet", CWD);
			expect(info).toHaveBeenCalledWith(
				"notes",
				expect.stringContaining("created"),
			);

			info.mockReset();

			// Update existing note
			const existing = makeNoteEntry({
				id: "existing",
				sourcePath: `${NOTES_DIR}/existing.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { existing },
			});

			await saveNote("existing", "Updated", "", "snippet", CWD);
			expect(info).toHaveBeenCalledWith(
				"notes",
				expect.stringContaining("updated"),
			);
		});

		it("handles registry with no notes field (undefined fallback)", async () => {
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("content");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			const result = await saveNote(
				undefined,
				"New Note",
				"content",
				"snippet",
				CWD,
			);

			expect(result).not.toBeNull();
			expect(result.title).toBe("New Note");
		});

		it("uses provided id instead of generating a slug", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("content");

			const result = await saveNote(
				"custom-id",
				"Title",
				"content",
				"snippet",
				CWD,
			);

			expect(result.id).toBe("custom-id");
			// Should NOT have called randomBytes since id was provided
			// (id is provided, so generateNoteSlug is not called)
		});
	});

	// ─── removeNote ────────────────────────────────────────────────────────────

	describe("removeNote", () => {
		it("deletes file and removes entry for uncommitted notes", async () => {
			const entry = makeNoteEntry({
				commitHash: null,
				sourcePath: `${NOTES_DIR}/my-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "my-note": entry },
			});
			mockExistsSync.mockReturnValue(true);

			await removeNote("my-note", CWD);

			expect(mockUnlinkSync).toHaveBeenCalledWith(`${NOTES_DIR}/my-note.md`);
			expect(mockSavePlansRegistry).toHaveBeenCalledWith(
				expect.objectContaining({ notes: {} }),
				CWD,
			);
		});

		it("does not delete the original file for uncommitted markdown notes", async () => {
			const entry = makeNoteEntry({
				commitHash: null,
				format: "markdown",
				sourcePath: "/user/docs/readme.md",
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "md-note": entry },
			});
			mockExistsSync.mockReturnValue(true);

			await removeNote("md-note", CWD);

			// Markdown notes reference the user's original file — never delete it
			expect(mockUnlinkSync).not.toHaveBeenCalled();
			expect(mockSavePlansRegistry).toHaveBeenCalledWith(
				expect.objectContaining({ notes: {} }),
				CWD,
			);
		});

		it("removes the entry but skips file deletion when the backing file is already gone", async () => {
			// New semantics: removeNote deletes the backing file only when it is
			// inside .jolli/jollimemory/ AND still exists — commitHash no longer
			// gates it. A committed snippet's file was already cleaned up by
			// archiveNoteForCommit, so existsSync is false → entry removed, no unlink.
			const entry = makeNoteEntry({ commitHash: "abc123" });
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "my-note": entry },
			});
			mockExistsSync.mockReturnValue(false);

			await removeNote("my-note", CWD);

			expect(mockUnlinkSync).not.toHaveBeenCalled();
			expect(mockSavePlansRegistry).toHaveBeenCalledWith(
				expect.objectContaining({ notes: {} }),
				CWD,
			);
		});

		it("does nothing when id is not in registry", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());

			await removeNote("nonexistent", CWD);

			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});

		it("handles registry with no notes field", async () => {
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });

			await removeNote("nonexistent", CWD);

			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});

		it("resolves an archived id to the bare-key guard when it still belongs to that commit", async () => {
			const guard = makeNoteEntry({ commitHash: "abcdef1234567890", contentHashAtCommit: "h" });
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {}, notes: { "my-note": guard } });

			await removeNote("my-note-abcdef12", CWD, "abcdef1234567890");

			expect(mockSavePlansRegistry).toHaveBeenCalledWith(expect.objectContaining({ notes: {} }), CWD);
		});

		it("does NOT delete the base note when it was revived/re-committed since (commitHash mismatch)", async () => {
			// P1 regression: dissociating an OLD commit must not wipe a live note.
			const revived = makeNoteEntry({ commitHash: null });
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {}, notes: { "my-note": revived } });

			await removeNote("my-note-abcdef12", CWD, "abcdef1234567890");

			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});

		it("deletes the exact id (not the stripped base) when it is this commit's guard", async () => {
			const foo = makeNoteEntry({ commitHash: "abcdef1234567890" });
			const real = makeNoteEntry({ commitHash: "abcdef1234567890" });
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { foo, "foo-deadbeef": real },
			});

			await removeNote("foo-deadbeef", CWD, "abcdef1234567890");

			const saved = mockSavePlansRegistry.mock.calls.at(-1)?.[0] as { notes: Record<string, unknown> };
			expect(saved.notes["foo-deadbeef"]).toBeUndefined();
			expect(saved.notes.foo).toBeDefined(); // base NOT mis-stripped
		});

		it("does NOT delete a live exact-id row (commitHash mismatch) when dissociating an old commit", async () => {
			// P1-extended: an archived id `foo-deadbeef` from an old summary can later
			// become a LIVE note under that exact id (commitHash=null). The exact id
			// matches, but the commitHash does not — dissociating the old commit must
			// not wipe the live row. The sidebar (no expectedCommitHash) still deletes it.
			const live = makeNoteEntry({ commitHash: null });
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {}, notes: { "foo-deadbeef": live } });

			await removeNote("foo-deadbeef", CWD, "abcdef1234567890");

			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});

		it("deletes the exact id unconditionally on the sidebar path (no expectedCommitHash)", async () => {
			// A committed note removed via the sidebar — no expectedCommitHash — is deleted
			// regardless of its commitHash. The user explicitly asked to remove the live note.
			const committed = makeNoteEntry({ commitHash: "abcdef1234567890" });
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {}, notes: { "my-note": committed } });

			await removeNote("my-note", CWD);

			expect(mockSavePlansRegistry).toHaveBeenCalledWith(expect.objectContaining({ notes: {} }), CWD);
		});

		it("handles file deletion failure gracefully", async () => {
			const entry = makeNoteEntry({
				commitHash: null,
				sourcePath: `${NOTES_DIR}/my-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "my-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockUnlinkSync.mockImplementation(() => {
				throw new Error("EACCES");
			});

			await removeNote("my-note", CWD);

			// Entry should still be removed from registry even if file delete fails
			expect(mockSavePlansRegistry).toHaveBeenCalledWith(
				expect.objectContaining({ notes: {} }),
				CWD,
			);
		});
	});

	// ─── archiveNoteForCommit ────────────────────────────────────────────────

	describe("archiveNoteForCommit", () => {
		it("archives a note and returns NoteReference", async () => {
			const entry = makeNoteEntry({
				format: "snippet",
				sourcePath: `${NOTES_DIR}/test-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("snippet content");

			const result = await archiveNoteForCommit(
				"test-note",
				"06d0f729abcdef12",
				CWD,
			);

			expect(result).not.toBeNull();
			expect(result?.id).toBe("test-note-06d0f729");
			expect(result?.title).toBe("Test Note");
			expect(result?.format).toBe("snippet");
			expect(result?.content).toBe("snippet content"); // snippet format includes content
			expect(result?.addedAt).toBe("2025-01-01T00:00:00.000Z");
		});

		it("sets the archive guard on the original entry without creating an archive row", async () => {
			const entry = makeNoteEntry();
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("content");

			await archiveNoteForCommit("test-note", "06d0f729abcdef12", CWD);

			const saved = mockSavePlansRegistry.mock.calls[0][0];
			// Only the guard row (original id) survives — it carries the
			// archive-time contentHashAtCommit and the commit hash.
			expect(saved.notes["test-note"].commitHash).toBe("06d0f729abcdef12");
			expect(saved.notes["test-note"].contentHashAtCommit).toBe(
				"mock-sha256-hash",
			);
			expect(saved.notes["test-note"].ignored).toBeUndefined();
			// No per-commit archive row is created; the new id lives only in the
			// returned NoteReference / orphan-branch snapshot.
			expect(saved.notes["test-note-06d0f729"]).toBeUndefined();
		});

		it("stores note in orphan branch via storeNotes", async () => {
			const entry = makeNoteEntry();
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("file content");

			await archiveNoteForCommit("test-note", "06d0f729abcdef12", CWD);

			expect(mockStoreNotes).toHaveBeenCalledWith(
				[{ id: "test-note-06d0f729", content: "file content" }],
				expect.stringContaining("Associate note"),
				CWD,
				undefined,
				undefined,
			);
		});

		it("returns null when note id is not in registry", async () => {
			mockLoadPlansRegistry.mockResolvedValue(emptyRegistry());

			const result = await archiveNoteForCommit("nonexistent", "abc12345", CWD);

			expect(result).toBeNull();
			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
		});

		it("handles registry with no notes field (undefined fallback)", async () => {
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });

			const result = await archiveNoteForCommit("nonexistent", "abc12345", CWD);

			expect(result).toBeNull();
		});

		it("returns null when note has no content (file missing)", async () => {
			const entry = makeNoteEntry({ sourcePath: `${NOTES_DIR}/missing.md` });
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(false);

			const result = await archiveNoteForCommit("test-note", "abc12345", CWD);

			expect(result).toBeNull();
			expect(mockSavePlansRegistry).not.toHaveBeenCalled();
		});

		it("returns null when entry has no sourcePath", async () => {
			const entry = makeNoteEntry({ sourcePath: undefined });
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});

			const result = await archiveNoteForCommit("test-note", "abc12345", CWD);

			expect(result).toBeNull();
		});

		it("does not include content for markdown format notes", async () => {
			const entry = makeNoteEntry({
				format: "markdown",
				sourcePath: `${NOTES_DIR}/test-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Markdown content");

			const result = await archiveNoteForCommit(
				"test-note",
				"06d0f729abcdef12",
				CWD,
			);

			expect(result?.content).toBeUndefined();
		});

		it("logs archive operation", async () => {
			const entry = makeNoteEntry();
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("content");

			await archiveNoteForCommit("test-note", "06d0f729abcdef12", CWD);

			expect(info).toHaveBeenCalledWith(
				"notes",
				expect.stringContaining("Archived note test-note"),
			);
		});

		it("uses first 8 characters of commitHash for new id", async () => {
			const entry = makeNoteEntry();
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("content");

			const result = await archiveNoteForCommit(
				"test-note",
				"abcdef1234567890",
				CWD,
			);

			expect(result?.id).toBe("test-note-abcdef12");
		});

		it("cleans up local snippet file after archiving", async () => {
			const entry = makeNoteEntry({
				format: "snippet",
				sourcePath: `${NOTES_DIR}/snippet-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("snippet content");

			await archiveNoteForCommit("test-note", "06d0f729abcdef12", CWD);

			expect(mockUnlinkSync).toHaveBeenCalledWith(
				`${NOTES_DIR}/snippet-note.md`,
			);
		});

		it("does not delete file for markdown notes after archiving", async () => {
			const entry = makeNoteEntry({
				format: "markdown",
				sourcePath: "/user/docs/readme.md",
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Markdown content");

			await archiveNoteForCommit("test-note", "06d0f729abcdef12", CWD);

			expect(mockUnlinkSync).not.toHaveBeenCalled();
		});

		it("handles snippet cleanup failure gracefully", async () => {
			const entry = makeNoteEntry({
				format: "snippet",
				sourcePath: `${NOTES_DIR}/snippet-note.md`,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("snippet content");
			mockUnlinkSync.mockImplementation(() => {
				throw new Error("EACCES");
			});

			// Should not throw even if cleanup fails
			const result = await archiveNoteForCommit(
				"test-note",
				"06d0f729abcdef12",
				CWD,
			);

			expect(result).not.toBeNull();
			expect(result?.id).toBe("test-note-06d0f729");
		});
	});

	// ─── listUnassociatedNotes ───────────────────────────────────────────────

	describe("listUnassociatedNotes", () => {
		it("returns notes where commitHash is null and not ignored", async () => {
			const notes = {
				"note-a": makeNoteEntry({
					id: "note-a",
					title: "Note A",
					commitHash: null,
				}),
				"note-b": makeNoteEntry({
					id: "note-b",
					title: "Note B",
					commitHash: "abc123",
				}),
				"note-c": makeNoteEntry({
					id: "note-c",
					title: "Note C",
					commitHash: null,
				}),
			};
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes,
			});

			const result = await listUnassociatedNotes(CWD);

			expect(result).toEqual([
				{ id: "note-a", title: "Note A", format: "snippet" },
				{ id: "note-c", title: "Note C", format: "snippet" },
			]);
		});

		it("returns empty array when all notes are committed", async () => {
			const notes = {
				"note-a": makeNoteEntry({ id: "note-a", commitHash: "abc123" }),
			};
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes,
			});

			const result = await listUnassociatedNotes(CWD);

			expect(result).toEqual([]);
		});

		it("returns empty when registry has no notes", async () => {
			mockLoadPlansRegistry.mockResolvedValue({ version: 1, plans: {} });

			const result = await listUnassociatedNotes(CWD);

			expect(result).toEqual([]);
		});

		it("preserves format in the returned objects", async () => {
			const notes = {
				"md-note": makeNoteEntry({
					id: "md-note",
					title: "MD Note",
					format: "markdown",
					commitHash: null,
				}),
			};
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes,
			});

			const result = await listUnassociatedNotes(CWD);

			expect(result).toEqual([
				{ id: "md-note", title: "MD Note", format: "markdown" },
			]);
		});
	});

	// ─── toNoteInfo edge cases (via detectNotes) ─────────────────────────────

	describe("toNoteInfo edge cases via detectNotes", () => {
		it("handles entry with no sourcePath (no filename/filePath in result)", async () => {
			const entry = makeNoteEntry({
				commitHash: null,
				sourcePath: undefined,
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});

			const notes = await detectNotes(CWD);

			expect(notes[0].filename).toBeUndefined();
			expect(notes[0].filePath).toBeUndefined();
		});

		it("uses updatedAt when sourcePath is present but existsSync returns false for stat path", async () => {
			// This covers the branch: sourcePath set, but existsSync returns false in the stat section
			// However, for uncommitted notes the deleted-file filter catches first.
			// So we need a committed note with contentHashAtCommit (changed) to reach the stat section.
			const entry = makeNoteEntry({
				commitHash: "abc12345",
				contentHashAtCommit: "old-hash-different",
				sourcePath: `${NOTES_DIR}/test-note.md`,
				updatedAt: "2025-03-15T00:00:00.000Z",
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			// getNoteContent needs file to exist for reading, but stat section may vary
			mockExistsSync.mockImplementation((path: string) => {
				// For getNoteContent (called in archive guard check) — file exists
				// For the stat section — we want it to return true so stat is attempted
				return path === `${NOTES_DIR}/test-note.md`;
			});
			mockReadFileSync.mockReturnValue("changed content");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-07-01T00:00:00.000Z"),
			});

			const notes = await detectNotes(CWD);

			expect(notes).toHaveLength(1);
			expect(notes[0].lastModified).toBe("2025-07-01T00:00:00.000Z");
		});

		it("handles entry where sourcePath exists but existsSync returns false in second check", async () => {
			// For uncommitted entry with sourcePath where stat check path doesn't exist
			// but deleted-file check does pass (existsSync returns true for that check)
			const entry = makeNoteEntry({
				commitHash: null,
				sourcePath: `${NOTES_DIR}/test-note.md`,
				updatedAt: "2025-03-15T00:00:00.000Z",
			});
			mockLoadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: {},
				notes: { "test-note": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockStatSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			mockReadFileSync.mockReturnValue("content without heading");

			const notes = await detectNotes(CWD);

			expect(notes).toHaveLength(1);
			// Falls back to updatedAt since statSync throws
			expect(notes[0].lastModified).toBe("2025-03-15T00:00:00.000Z");
		});
	});
});
