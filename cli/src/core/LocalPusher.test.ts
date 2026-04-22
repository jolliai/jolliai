/**
 * LocalPusher tests
 *
 * TDD tests for pushSummaryToLocal: writes a summary markdown file, satellite
 * plans/notes to a "Plans & Notes" subfolder, rewrites Jolli URLs to relative
 * paths, and rebuilds an index.md from on-disk files cross-referenced with the
 * SummaryStore.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../Types.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	listSummaries: vi.fn(),
}));

vi.mock("./SummaryStore.js", () => ({
	listSummaries: mocks.listSummaries,
}));

import { pushSummaryToLocal } from "./LocalPusher.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 3,
		commitHash: "abcd1234ef56789012345678901234567890abcd",
		commitMessage: "Add feature X",
		commitAuthor: "Test User",
		commitDate: "2026-04-15T12:00:00Z",
		branch: "feature/test",
		generatedAt: "2026-04-15T12:05:00Z",
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("LocalPusher", () => {
	let folder: string;

	beforeEach(() => {
		vi.clearAllMocks();
		folder = mkdtempSync(join(tmpdir(), "localpusher-"));
		mocks.listSummaries.mockResolvedValue([]);
	});

	afterEach(() => {
		rmSync(folder, { recursive: true, force: true });
	});

	// ── Iteration A: Write the summary file ─────────────────────────────────

	describe("summary file writing", () => {
		it("writes the summary markdown to <folder>/<hash>-<slug>.md", async () => {
			const summary = makeSummary();
			const markdown = "# Add feature X\n\nSome summary content.";

			const result = await pushSummaryToLocal({
				folder,
				summary,
				summaryMarkdown: markdown,
				satellites: [],
			});

			expect(result.summaryPath).toBe(join(folder, "abcd1234-add-feature-x.md"));
			const written = readFileSync(result.summaryPath, "utf-8");
			expect(written).toBe(markdown);
		});

		it("creates the folder if it does not exist", async () => {
			const nestedFolder = join(folder, "nested", "deep");
			const summary = makeSummary();

			const result = await pushSummaryToLocal({
				folder: nestedFolder,
				summary,
				summaryMarkdown: "# Content",
				satellites: [],
			});

			const written = readFileSync(result.summaryPath, "utf-8");
			expect(written).toBe("# Content");
		});
	});

	// ── Iteration B: Write satellite plans/notes ────────────────────────────

	describe("satellite file writing", () => {
		it("writes satellites to <folder>/Plans & Notes/<slug>.md", async () => {
			const summary = makeSummary();
			const satellites = [
				{ slug: "refactor-auth", title: "Refactor auth", content: "# plan body" },
				{ slug: "useful-snippet", title: "Useful snippet", content: "# note body" },
			];

			const result = await pushSummaryToLocal({
				folder,
				summary,
				summaryMarkdown: "# Summary",
				satellites,
			});

			expect(result.satellitePaths).toHaveLength(2);

			const planPath = join(folder, "Plans & Notes", "refactor-auth.md");
			const notePath = join(folder, "Plans & Notes", "useful-snippet.md");
			expect(result.satellitePaths).toContain(planPath);
			expect(result.satellitePaths).toContain(notePath);

			expect(readFileSync(planPath, "utf-8")).toBe("# plan body");
			expect(readFileSync(notePath, "utf-8")).toBe("# note body");
		});

		it("returns empty satellitePaths when no satellites provided", async () => {
			const result = await pushSummaryToLocal({
				folder,
				summary: makeSummary(),
				summaryMarkdown: "# Summary",
				satellites: [],
			});

			expect(result.satellitePaths).toHaveLength(0);
		});

		it("strips path traversal components from satellite slugs", async () => {
			const satellites = [
				{ slug: "../../etc/evil", title: "Malicious", content: "# pwned" },
				{ slug: "normal-slug", title: "Normal", content: "# safe" },
			];

			const result = await pushSummaryToLocal({
				folder,
				summary: makeSummary(),
				summaryMarkdown: "# Summary",
				satellites,
			});

			// The traversal slug should be sanitized to just the basename
			const satDir = join(folder, "Plans & Notes");
			expect(result.satellitePaths).toContain(join(satDir, "evil.md"));
			expect(result.satellitePaths).toContain(join(satDir, "normal-slug.md"));
			// Verify the file was written inside the satellites dir, not outside
			expect(readFileSync(join(satDir, "evil.md"), "utf-8")).toBe("# pwned");
		});
	});

	// ── Iteration C: Rewrite Jolli URLs in summary markdown ─────────────────

	describe("Jolli URL rewriting", () => {
		it("rewrites Jolli URLs to relative satellite paths", async () => {
			const jolliUrl = "https://jolli.ai/doc/abc123";
			const markdown = `See the plan: [Refactor auth](${jolliUrl}) for details.`;
			const satellites = [{ slug: "refactor-auth", title: "Refactor auth", content: "# plan", jolliUrl }];

			const result = await pushSummaryToLocal({
				folder,
				summary: makeSummary(),
				summaryMarkdown: markdown,
				satellites,
			});

			const written = readFileSync(result.summaryPath, "utf-8");
			expect(written).toContain("./Plans & Notes/refactor-auth.md");
			expect(written).not.toContain(jolliUrl);
		});

		it("leaves external URLs untouched", async () => {
			const externalUrl = "https://external.example.com/page";
			const jolliUrl = "https://jolli.ai/doc/abc123";
			const markdown = `[External](${externalUrl}) and [Plan](${jolliUrl})`;
			const satellites = [{ slug: "my-plan", title: "Plan", content: "# plan", jolliUrl }];

			const result = await pushSummaryToLocal({
				folder,
				summary: makeSummary(),
				summaryMarkdown: markdown,
				satellites,
			});

			const written = readFileSync(result.summaryPath, "utf-8");
			expect(written).toContain(externalUrl);
			expect(written).toContain("./Plans & Notes/my-plan.md");
			expect(written).not.toContain(jolliUrl);
		});

		it("rewrites multiple occurrences of the same Jolli URL", async () => {
			const jolliUrl = "https://jolli.ai/doc/abc123";
			const markdown = `[First](${jolliUrl}) and [Second](${jolliUrl})`;
			const satellites = [{ slug: "plan-a", title: "Plan A", content: "# plan", jolliUrl }];

			const result = await pushSummaryToLocal({
				folder,
				summary: makeSummary(),
				summaryMarkdown: markdown,
				satellites,
			});

			const written = readFileSync(result.summaryPath, "utf-8");
			// Both occurrences should be replaced
			const matches = written.match(/\.\/Plans & Notes\/plan-a\.md/g);
			expect(matches).toHaveLength(2);
			expect(written).not.toContain(jolliUrl);
		});
	});

	// ── Iteration D: Rebuild index.md ───────────────────────────────────────

	describe("index.md rebuilding", () => {
		it("builds index from on-disk files cross-referenced with stored summaries", async () => {
			// Pre-seed an existing summary file on disk (simulating a prior push)
			const existingSummary = makeSummary({
				commitHash: "1111222233334444555566667777888899990000",
				commitMessage: "Prior commit",
				commitDate: "2026-04-14T10:00:00Z",
				generatedAt: "2026-04-14T10:05:00Z",
			});
			const existingFileName = "11112222-prior-commit.md";
			writeFileSync(join(folder, existingFileName), "# Prior", "utf-8");

			// The summary being pushed now
			const currentSummary = makeSummary();

			// Mock SummaryStore to return both summaries
			mocks.listSummaries.mockResolvedValue([currentSummary, existingSummary]);

			const result = await pushSummaryToLocal({
				folder,
				summary: currentSummary,
				summaryMarkdown: "# Current summary",
				satellites: [],
			});

			expect(result.indexPath).toBe(join(folder, "index.md"));

			const indexContent = readFileSync(result.indexPath, "utf-8");

			// Header
			expect(indexContent).toContain("# Memories Index");
			expect(indexContent).toContain("| Date | Commit | Summary |");
			expect(indexContent).toContain("|------|--------|---------|");

			// Current summary row
			expect(indexContent).toContain("| 2026-04-15 |");
			expect(indexContent).toContain("`abcd1234`");
			expect(indexContent).toContain("[Add feature X](./abcd1234-add-feature-x.md)");

			// Prior summary row
			expect(indexContent).toContain("| 2026-04-14 |");
			expect(indexContent).toContain("`11112222`");
			expect(indexContent).toContain("[Prior commit](./11112222-prior-commit.md)");
		});

		it("sorts index rows by commitDate descending (newest first)", async () => {
			// Pre-seed an older summary on disk
			const older = makeSummary({
				commitHash: "aaaa0000bbbb1111cccc2222dddd3333eeee4444",
				commitMessage: "Older",
				commitDate: "2026-04-10T08:00:00Z",
				generatedAt: "2026-04-10T08:05:00Z",
			});
			writeFileSync(join(folder, "aaaa0000-older.md"), "# Older", "utf-8");

			const newer = makeSummary({
				commitDate: "2026-04-15T12:00:00Z",
				generatedAt: "2026-04-15T12:05:00Z",
			});

			mocks.listSummaries.mockResolvedValue([newer, older]);

			const result = await pushSummaryToLocal({
				folder,
				summary: newer,
				summaryMarkdown: "# Newer",
				satellites: [],
			});

			const indexContent = readFileSync(result.indexPath, "utf-8");
			const newerIdx = indexContent.indexOf("2026-04-15");
			const olderIdx = indexContent.indexOf("2026-04-10");
			expect(newerIdx).toBeLessThan(olderIdx);
		});

		it("omits stored summaries that have no matching file on disk", async () => {
			const currentSummary = makeSummary();

			// This summary is in the store but has no file on disk
			const orphanSummary = makeSummary({
				commitHash: "deadbeef1234567890abcdef1234567890abcdef",
				commitMessage: "Ghost commit",
				commitDate: "2026-04-13T08:00:00Z",
			});

			mocks.listSummaries.mockResolvedValue([currentSummary, orphanSummary]);

			const result = await pushSummaryToLocal({
				folder,
				summary: currentSummary,
				summaryMarkdown: "# Current",
				satellites: [],
			});

			const indexContent = readFileSync(result.indexPath, "utf-8");

			// Current summary should be present (we just wrote it)
			expect(indexContent).toContain("Add feature X");

			// Orphan summary should NOT be present (no file on disk)
			expect(indexContent).not.toContain("Ghost commit");
			expect(indexContent).not.toContain("deadbeef");
		});

		it("escapes pipe characters in commit messages", async () => {
			const summary = makeSummary({
				commitMessage: "Fix A | B conflict",
			});

			mocks.listSummaries.mockResolvedValue([summary]);

			const result = await pushSummaryToLocal({
				folder,
				summary,
				summaryMarkdown: "# Content",
				satellites: [],
			});

			const indexContent = readFileSync(result.indexPath, "utf-8");
			expect(indexContent).toContain("Fix A \\| B conflict");
		});

		it("handles an empty folder with no prior summaries", async () => {
			const summary = makeSummary();
			mocks.listSummaries.mockResolvedValue([summary]);

			const result = await pushSummaryToLocal({
				folder,
				summary,
				summaryMarkdown: "# Content",
				satellites: [],
			});

			const indexContent = readFileSync(result.indexPath, "utf-8");
			expect(indexContent).toContain("# Memories Index");
			expect(indexContent).toContain("Add feature X");
		});
	});
});
