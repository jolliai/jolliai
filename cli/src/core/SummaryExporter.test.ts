/**
 * SummaryExporter tests
 *
 * Tests the export command's core logic: file writing, skip-existing behavior,
 * index generation, and project name resolution.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	execFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	homedir: vi.fn(),
	getSummary: vi.fn(),
	listSummaries: vi.fn(),
	buildMarkdown: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	mkdirSync: mocks.mkdirSync,
	readdirSync: mocks.readdirSync,
	writeFileSync: mocks.writeFileSync,
}));
vi.mock("node:os", () => ({ homedir: mocks.homedir }));
vi.mock("./SummaryStore.js", () => ({
	getSummary: mocks.getSummary,
	listSummaries: mocks.listSummaries,
}));
vi.mock("./SummaryMarkdownBuilder.js", () => ({
	buildMarkdown: mocks.buildMarkdown,
}));

import { sep } from "node:path";
import type { CommitSummary } from "../Types.js";
import { exportSummaries } from "./SummaryExporter.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 3,
		commitHash: "abc12345deadbeef",
		commitMessage: "Fix login timeout",
		commitAuthor: "Alice",
		commitDate: "2026-03-30T10:00:00Z",
		branch: "feature/test",
		generatedAt: "2026-03-30T10:05:00Z",
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SummaryExporter", () => {
	/** Tracks files "written" by writeFileSync so existsSync can find them. */
	const writtenFiles = new Set<string>();

	beforeEach(() => {
		vi.clearAllMocks();
		writtenFiles.clear();
		mocks.homedir.mockReturnValue("/home/user");
		mocks.execFileSync.mockReturnValue("/mock/project\n");
		mocks.existsSync.mockImplementation((p: string) => writtenFiles.has(p));
		mocks.writeFileSync.mockImplementation((p: string) => writtenFiles.add(p));
		mocks.readdirSync.mockReturnValue([]);
		mocks.buildMarkdown.mockReturnValue("# Mock Markdown");
	});

	it("should export all summaries by default", async () => {
		const summary = makeSummary();
		mocks.listSummaries.mockResolvedValue([summary]);

		const result = await exportSummaries({});

		expect(mocks.listSummaries).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER, undefined);
		expect(result.filesWritten).toBe(1);
		expect(result.filesSkipped).toBe(0);
		expect(result.totalSummaries).toBe(1);
	});

	it("should export a single commit when --commit is set", async () => {
		const summary = makeSummary();
		mocks.getSummary.mockResolvedValue(summary);

		const result = await exportSummaries({ commit: "abc12345" });

		expect(mocks.getSummary).toHaveBeenCalledWith("abc12345", undefined);
		expect(result.filesWritten).toBe(1);
	});

	it("should skip already exported summaries", async () => {
		const summary = makeSummary();
		mocks.listSummaries.mockResolvedValue([summary]);
		// Simulate existing output dir with the file already present
		mocks.existsSync.mockReturnValue(true);
		mocks.readdirSync.mockReturnValue(["abc12345-fix-login-timeout.md"]);

		const result = await exportSummaries({});

		expect(result.filesWritten).toBe(0);
		expect(result.filesSkipped).toBe(1);
		expect(result.totalSummaries).toBe(1);
		// buildMarkdown should NOT be called for skipped files
		expect(mocks.buildMarkdown).not.toHaveBeenCalled();
	});

	it("should write new files and skip existing ones in the same run", async () => {
		const existing = makeSummary({ commitHash: "aaa11111deadbeef", commitMessage: "Old commit" });
		const newSummary = makeSummary({ commitHash: "bbb22222deadbeef", commitMessage: "New commit" });
		mocks.listSummaries.mockResolvedValue([existing, newSummary]);
		// Output dir exists with one already-exported file
		mocks.readdirSync.mockReturnValue(["aaa11111-old-commit.md"]);
		mocks.existsSync.mockImplementation((p: string) => {
			if (p.endsWith("aaa11111-old-commit.md")) return true;
			// Output directory itself exists (for getExistingHashes check)
			if (!p.endsWith(".md")) return true;
			return writtenFiles.has(p);
		});

		const result = await exportSummaries({});

		expect(result.filesWritten).toBe(1);
		expect(result.filesSkipped).toBe(1);
		expect(result.totalSummaries).toBe(2);
	});

	it("should rebuild index.md with header and all entries", async () => {
		const summary = makeSummary();
		mocks.listSummaries.mockResolvedValue([summary]);

		await exportSummaries({});

		const indexWrites = mocks.writeFileSync.mock.calls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].endsWith("index.md"),
		);
		expect(indexWrites.length).toBe(1);
		const content = indexWrites[0][1] as string;
		expect(content).toContain("# Project Knowledge:");
		expect(content).toContain("| Date | Commit | Summary |");
		expect(content).toContain("Fix login timeout");
		expect(content).toContain("abc12345");
	});

	it("should include skipped summaries in rebuilt index", async () => {
		const summary = makeSummary();
		mocks.listSummaries.mockResolvedValue([summary]);
		// File already exists on disk
		mocks.existsSync.mockReturnValue(true);
		mocks.readdirSync.mockReturnValue(["abc12345-fix-login-timeout.md"]);

		await exportSummaries({});

		const indexWrites = mocks.writeFileSync.mock.calls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].endsWith("index.md"),
		);
		expect(indexWrites.length).toBe(1);
		const content = indexWrites[0][1] as string;
		// Skipped file should still appear in index
		expect(content).toContain("Fix login timeout");
		expect(content).toContain("abc12345");
	});

	it("should use project name from --project option", async () => {
		mocks.listSummaries.mockResolvedValue([]);

		const result = await exportSummaries({ project: "my-app" });

		expect(result.outputDir).toContain("my-app");
	});

	it("should derive project name from git repo root", async () => {
		mocks.execFileSync.mockReturnValue("/home/user/repos/cool-project\n");
		mocks.listSummaries.mockResolvedValue([]);

		const result = await exportSummaries({});

		expect(result.outputDir).toContain("cool-project");
	});

	it("should output to ~/Documents/jollimemory/<project>/", async () => {
		mocks.listSummaries.mockResolvedValue([]);

		const result = await exportSummaries({ project: "test" });

		// Use path.join for cross-platform compatibility (Windows uses backslashes)
		expect(result.outputDir).toContain(["Documents", "jollimemory", "test"].join(sep));
	});

	it("should handle empty summaries gracefully", async () => {
		mocks.listSummaries.mockResolvedValue([]);

		const result = await exportSummaries({});

		expect(result.filesWritten).toBe(0);
		expect(result.totalSummaries).toBe(0);
	});

	it("should fall back to cwd basename when git command fails", async () => {
		mocks.execFileSync.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		mocks.listSummaries.mockResolvedValue([]);

		const result = await exportSummaries({ cwd: "/tmp/my-fallback-project" });

		expect(result.outputDir).toContain("my-fallback-project");
	});

	it("should fall back to process.cwd when git command fails and no cwd provided", async () => {
		mocks.execFileSync.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		mocks.listSummaries.mockResolvedValue([]);

		const result = await exportSummaries({});

		// Should still resolve to some project name (from process.cwd)
		expect(result.outputDir).toBeTruthy();
	});

	it("should skip non-matching files in existing hashes scan", async () => {
		const summary = makeSummary();
		mocks.listSummaries.mockResolvedValue([summary]);
		// Return files with non-matching names in the output directory
		mocks.existsSync.mockImplementation((p: string) => {
			if (!p.endsWith(".md")) return true; // outputDir exists
			return writtenFiles.has(p);
		});
		mocks.readdirSync.mockReturnValue(["README.md", "notes.txt", "abc12345-fix-login-timeout.md"]);

		const result = await exportSummaries({});

		// abc12345 matches the summary hash so it should be skipped
		expect(result.filesSkipped).toBe(1);
	});

	it("should count as errored (not skipped) when buildMarkdown throws", async () => {
		const summary = makeSummary();
		mocks.listSummaries.mockResolvedValue([summary]);
		mocks.buildMarkdown.mockImplementation(() => {
			throw new Error("render error");
		});

		const result = await exportSummaries({});

		expect(result.filesWritten).toBe(0);
		expect(result.filesSkipped).toBe(0);
		expect(result.filesErrored).toBe(1);
	});

	it("should count as errored when writeFileSync throws for a summary file", async () => {
		const summary = makeSummary();
		mocks.listSummaries.mockResolvedValue([summary]);
		// Only throw for the first writeFileSync call (the summary file), not for index.md
		let callCount = 0;
		mocks.writeFileSync.mockImplementation((p: string) => {
			callCount++;
			if (callCount === 1) {
				throw new Error("ENOSPC");
			}
			writtenFiles.add(p);
		});

		const result = await exportSummaries({});

		expect(result.filesWritten).toBe(0);
		expect(result.filesSkipped).toBe(0);
		expect(result.filesErrored).toBe(1);
	});

	it("should return single summary when --commit finds nothing", async () => {
		mocks.getSummary.mockResolvedValue(null);

		const result = await exportSummaries({ commit: "nonexistent" });

		expect(result.filesWritten).toBe(0);
		expect(result.totalSummaries).toBe(0);
	});
});
