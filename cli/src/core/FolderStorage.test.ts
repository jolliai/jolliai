import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderStorage } from "./FolderStorage.js";
import type { ManifestEntry } from "./KBTypes.js";
import { MetadataManager } from "./MetadataManager.js";

// Mock SummaryMarkdownBuilder
vi.mock("./SummaryMarkdownBuilder.js", () => ({
	buildMarkdown: vi.fn().mockReturnValue("# Mock Markdown\n\nBody content"),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

function makeTmpDir(): string {
	const dir = join(tmpdir(), `kb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function rmrf(dir: string): void {
	const { rmSync } = require("node:fs");
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

function makeSummaryJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 3,
		commitHash: "abc12345deadbeef",
		commitMessage: "Add login feature",
		commitAuthor: "Alice",
		commitDate: "2026-01-15T10:00:00Z",
		branch: "main",
		generatedAt: "2026-01-15T10:00:00Z",
		topics: [{ title: "Login", trigger: "t", response: "r", decisions: "d" }],
		stats: { filesChanged: 3, insertions: 50, deletions: 10 },
		...overrides,
	});
}

describe("FolderStorage", () => {
	let rootPath: string;
	let metadataManager: MetadataManager;
	let storage: FolderStorage;

	beforeEach(() => {
		rootPath = makeTmpDir();
		metadataManager = new MetadataManager(join(rootPath, ".jolli"));
		storage = new FolderStorage(rootPath, metadataManager);
	});

	afterEach(() => {
		rmrf(rootPath);
	});

	describe("exists / ensure", () => {
		it("exists returns true when dir exists", async () => {
			expect(await storage.exists()).toBe(true);
		});

		it("ensure creates jolli dir", async () => {
			await storage.ensure();
			expect(existsSync(join(rootPath, ".jolli"))).toBe(true);
		});
	});

	describe("readFile / writeFiles", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("readFile returns null for nonexistent file", async () => {
			expect(await storage.readFile("nonexistent.txt")).toBeNull();
		});

		it("write then read round-trips via hidden dir", async () => {
			await storage.writeFiles([{ path: "test.txt", content: "hello world" }], "test write");
			expect(existsSync(join(rootPath, ".jolli", "test.txt"))).toBe(true);
			expect(await storage.readFile("test.txt")).toBe("hello world");
		});

		it("write creates nested directories", async () => {
			await storage.writeFiles([{ path: "a/b/c/deep.txt", content: "deep" }], "nested");
			expect(await storage.readFile("a/b/c/deep.txt")).toBe("deep");
		});

		it("write overwrites existing file", async () => {
			await storage.writeFiles([{ path: "f.txt", content: "v1" }], "v1");
			await storage.writeFiles([{ path: "f.txt", content: "v2" }], "v2");
			expect(await storage.readFile("f.txt")).toBe("v2");
		});

		it("delete removes file", async () => {
			await storage.writeFiles([{ path: "f.txt", content: "content" }], "create");
			await storage.writeFiles([{ path: "f.txt", content: "", delete: true }], "delete");
			expect(await storage.readFile("f.txt")).toBeNull();
		});

		it("index.json stored in hidden dir", async () => {
			await storage.writeFiles([{ path: "index.json", content: '{"version":3}' }], "write index");
			expect(existsSync(join(rootPath, ".jolli", "index.json"))).toBe(true);
			expect(existsSync(join(rootPath, "index.json"))).toBe(false);
		});
	});

	describe("listFiles", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("returns empty for nonexistent prefix", async () => {
			expect(await storage.listFiles("nonexistent")).toHaveLength(0);
		});

		it("lists files under prefix", async () => {
			await storage.writeFiles(
				[
					{ path: "summaries/a.json", content: makeSummaryJson({ commitHash: "aaa11111" }) },
					{ path: "summaries/b.json", content: makeSummaryJson({ commitHash: "bbb22222" }) },
					{ path: "plans/p.md", content: "# Plan" },
				],
				"seed",
			);
			const result = await storage.listFiles("summaries");
			expect(result).toHaveLength(2);
		});
	});

	describe("markdown generation", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("generates visible markdown when writing summary json", async () => {
			const json = makeSummaryJson();
			await storage.writeFiles([{ path: "summaries/abc12345deadbeef.json", content: json }], "store");

			// Hidden JSON exists
			expect(existsSync(join(rootPath, ".jolli", "summaries", "abc12345deadbeef.json"))).toBe(true);

			// Visible markdown exists in branch folder
			const mainDir = join(rootPath, "main");
			expect(existsSync(mainDir)).toBe(true);

			const { readdirSync } = require("node:fs");
			const mdFiles = readdirSync(mainDir).filter((f: string) => f.endsWith(".md"));
			expect(mdFiles).toHaveLength(1);
			expect(mdFiles[0]).toContain("abc12345");
			expect(mdFiles[0]).toContain("add-login-feature");

			// Markdown has frontmatter
			const content = readFileSync(join(mainDir, mdFiles[0]), "utf-8");
			expect(content).toContain("---");
			expect(content).toContain("commitHash: abc12345deadbeef");
			expect(content).toContain("branch: main");
			expect(content).toContain("type: commit");
		});

		it("generates into branch subfolder with transcoding", async () => {
			const json = makeSummaryJson({ branch: "feature/login" });
			await storage.writeFiles([{ path: "summaries/abc12345deadbeef.json", content: json }], "store");
			expect(existsSync(join(rootPath, "feature-login"))).toBe(true);
		});

		it("updates manifest with title", async () => {
			const json = makeSummaryJson();
			await storage.writeFiles([{ path: "summaries/abc12345deadbeef.json", content: json }], "store");

			const entry = metadataManager.findById("abc12345deadbeef");
			expect(entry).toBeDefined();
			expect(entry?.type).toBe("commit");
			expect(entry?.title).toBe("Add login feature");
			expect(entry?.path).toContain(".md");
		});

		it("writes plan files to .jolli/plans/ and generates visible markdown in branch dir", async () => {
			const planContent = "# My Plan\n\nDo stuff.";
			await storage.writeFiles(
				[{ path: "plans/my-plan-abc12345.md", content: planContent, branch: "feature/login" }],
				"store plan",
			);

			// Hidden file exists in .jolli/plans/
			expect(existsSync(join(rootPath, ".jolli", "plans", "my-plan-abc12345.md"))).toBe(true);
			expect(await storage.readFile("plans/my-plan-abc12345.md")).toBe(planContent);

			// Visible markdown copy in branch directory
			const branchDir = join(rootPath, "feature-login");
			expect(existsSync(branchDir)).toBe(true);

			const { readdirSync } = require("node:fs");
			const mdFiles = readdirSync(branchDir).filter((f: string) => f.startsWith("plan--"));
			expect(mdFiles).toHaveLength(1);
			expect(mdFiles[0]).toBe("plan--my-plan-abc12345.md");

			// Visible copy has frontmatter
			const content = readFileSync(join(branchDir, mdFiles[0]), "utf-8");
			expect(content).toContain("---");
			expect(content).toContain("type: plan");
			expect(content).toContain("slug: my-plan-abc12345");
			expect(content).toContain("# My Plan");
		});

		it("writes note files to .jolli/notes/ and generates visible markdown in branch dir", async () => {
			const noteContent = "# My Note\n\nImportant details.";
			await storage.writeFiles(
				[{ path: "notes/my-note-abc12345.md", content: noteContent, branch: "main" }],
				"store note",
			);

			// Hidden file exists in .jolli/notes/
			expect(existsSync(join(rootPath, ".jolli", "notes", "my-note-abc12345.md"))).toBe(true);
			expect(await storage.readFile("notes/my-note-abc12345.md")).toBe(noteContent);

			// Visible markdown copy in branch directory
			const mainDir = join(rootPath, "main");
			expect(existsSync(mainDir)).toBe(true);

			const { readdirSync } = require("node:fs");
			const mdFiles = readdirSync(mainDir).filter((f: string) => f.startsWith("note--"));
			expect(mdFiles).toHaveLength(1);
			expect(mdFiles[0]).toBe("note--my-note-abc12345.md");

			// Visible copy has frontmatter
			const content = readFileSync(join(mainDir, mdFiles[0]), "utf-8");
			expect(content).toContain("---");
			expect(content).toContain("type: note");
			expect(content).toContain("id: my-note-abc12345");
			expect(content).toContain("# My Note");
		});

		it("non-summary files do not generate markdown", async () => {
			await storage.writeFiles(
				[
					{ path: "index.json", content: '{"version":3}' },
					{ path: "transcripts/abc.json", content: '{"sessions":[]}' },
				],
				"other",
			);

			const rootFiles = readdirSync(rootPath).filter((f: string) => !f.startsWith("."));
			const mdFiles = rootFiles.filter((f: string) => f.endsWith(".md"));
			expect(mdFiles).toHaveLength(0);
		});
	});

	describe("amend/squash cleanup of superseded MDs", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		// Helper: build a CommitSummary JSON tree where each child is the prior root
		function summaryWithChildren(hash: string, message: string, children: ReadonlyArray<unknown> = []): string {
			return JSON.stringify({
				version: 3,
				commitHash: hash,
				commitMessage: message,
				commitAuthor: "Alice",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				...(children.length > 0 && { children }),
			});
		}

		it("deletes the prior root's MD when an amend wraps it as a child", async () => {
			const oldJson = summaryWithChildren("old1234567890abcd", "Old commit message");
			await storage.writeFiles([{ path: "summaries/old1234567890abcd.json", content: oldJson }], "old");
			const mainDir = join(rootPath, "main");
			let mds = readdirSync(mainDir).filter((f: string) => f.endsWith(".md"));
			expect(mds).toHaveLength(1);
			expect(mds[0]).toContain("old12345");

			const newJson = summaryWithChildren("new9876543210fedc", "New commit message", [JSON.parse(oldJson)]);
			await storage.writeFiles([{ path: "summaries/new9876543210fedc.json", content: newJson }], "new");

			mds = readdirSync(mainDir).filter((f: string) => f.endsWith(".md"));
			expect(mds).toHaveLength(1);
			expect(mds[0]).toContain("new98765");

			expect(metadataManager.findById("old1234567890abcd")).toBeUndefined();
			expect(metadataManager.findById("new9876543210fedc")).toBeDefined();
		});

		it("deletes every descendant in a deep amend chain", async () => {
			const aJson = summaryWithChildren("aaaa11111111aaaa", "A");
			await storage.writeFiles([{ path: "summaries/aaaa11111111aaaa.json", content: aJson }], "A");

			const bJson = summaryWithChildren("bbbb22222222bbbb", "B", [JSON.parse(aJson)]);
			await storage.writeFiles([{ path: "summaries/bbbb22222222bbbb.json", content: bJson }], "B");

			const cJson = summaryWithChildren("cccc33333333cccc", "C", [JSON.parse(bJson)]);
			await storage.writeFiles([{ path: "summaries/cccc33333333cccc.json", content: cJson }], "C");

			const mainDir = join(rootPath, "main");
			const mds = readdirSync(mainDir).filter((f: string) => f.endsWith(".md"));
			expect(mds).toHaveLength(1);
			expect(mds[0]).toContain("cccc3333");

			expect(metadataManager.findById("aaaa11111111aaaa")).toBeUndefined();
			expect(metadataManager.findById("bbbb22222222bbbb")).toBeUndefined();
			expect(metadataManager.findById("cccc33333333cccc")).toBeDefined();
		});

		it("preserves a hand-edited descendant MD (fingerprint mismatch)", async () => {
			const oldJson = summaryWithChildren("old1234567890abcd", "Old commit message");
			await storage.writeFiles([{ path: "summaries/old1234567890abcd.json", content: oldJson }], "old");
			const mainDir = join(rootPath, "main");
			const oldName = readdirSync(mainDir).find((f: string) => f.includes("old12345"));
			expect(oldName).toBeDefined();
			const oldPath = join(mainDir, oldName as string);

			writeFileSync(oldPath, "# Hand-edited\n\nUser changed this", "utf-8");

			const newJson = summaryWithChildren("new9876543210fedc", "New commit message", [JSON.parse(oldJson)]);
			await storage.writeFiles([{ path: "summaries/new9876543210fedc.json", content: newJson }], "new");

			expect(existsSync(oldPath)).toBe(true);
			expect(readFileSync(oldPath, "utf-8")).toContain("Hand-edited");
			expect(metadataManager.findById("old1234567890abcd")).toBeDefined();
			expect(metadataManager.findById("new9876543210fedc")).toBeDefined();
		});

		it("deletes both source MDs when a squash root wraps them as children", async () => {
			const aJson = summaryWithChildren("aaaa11111111aaaa", "A change");
			const bJson = summaryWithChildren("bbbb22222222bbbb", "B change");
			await storage.writeFiles([{ path: "summaries/aaaa11111111aaaa.json", content: aJson }], "A");
			await storage.writeFiles([{ path: "summaries/bbbb22222222bbbb.json", content: bJson }], "B");
			const mainDir = join(rootPath, "main");
			expect(readdirSync(mainDir).filter((f: string) => f.endsWith(".md"))).toHaveLength(2);

			const mergedJson = summaryWithChildren("merge3333merge33", "Squashed", [
				JSON.parse(aJson),
				JSON.parse(bJson),
			]);
			await storage.writeFiles([{ path: "summaries/merge3333merge33.json", content: mergedJson }], "merged");

			const mds = readdirSync(mainDir).filter((f: string) => f.endsWith(".md"));
			expect(mds).toHaveLength(1);
			expect(mds[0]).toContain("merge333");
		});

		it("is idempotent — second write of the same root does not fail", async () => {
			const oldJson = summaryWithChildren("old1234567890abcd", "Old");
			await storage.writeFiles([{ path: "summaries/old1234567890abcd.json", content: oldJson }], "old");
			const newJson = summaryWithChildren("new9876543210fedc", "New", [JSON.parse(oldJson)]);
			await storage.writeFiles([{ path: "summaries/new9876543210fedc.json", content: newJson }], "new1");
			// Second time the descendant is already gone — must not throw.
			await expect(
				storage.writeFiles([{ path: "summaries/new9876543210fedc.json", content: newJson }], "new2"),
			).resolves.not.toThrow();

			const mainDir = join(rootPath, "main");
			const mds = readdirSync(mainDir).filter((f: string) => f.endsWith(".md"));
			expect(mds).toHaveLength(1);
		});

		// Legacy manifest entries (pre-fingerprint era) carry no fingerprint
		// baseline, so cleanupSupersededDescendants cannot prove the system
		// wrote the on-disk file. It must skip the delete and leave both the
		// MD file and the manifest entry in place — anything else risks
		// deleting hand-edited content that predates the fingerprint feature.
		it("preserves descendant MD AND manifest entry when the entry has no fingerprint baseline (legacy)", async () => {
			const oldJson = summaryWithChildren("legacynofp000000", "Legacy descendant");
			await storage.writeFiles([{ path: "summaries/legacynofp000000.json", content: oldJson }], "old");
			const mainDir = join(rootPath, "main");
			const oldName = readdirSync(mainDir).find((f: string) => f.includes("legacyno"));
			expect(oldName).toBeDefined();
			const oldPath = join(mainDir, oldName as string);

			// Strip fingerprint to simulate a pre-fingerprint manifest row.
			const legacyEntry = metadataManager.findById("legacynofp000000");
			if (!legacyEntry) throw new Error("legacy entry must exist before strip");
			metadataManager.updateManifest({
				path: legacyEntry.path,
				fileId: legacyEntry.fileId,
				type: legacyEntry.type,
				fingerprint: undefined as unknown as string,
				source: legacyEntry.source,
				title: legacyEntry.title,
			});

			// Wrap the legacy entry as a child of a new root → triggers cleanup.
			const newJson = summaryWithChildren("newroot000000000", "New root", [JSON.parse(oldJson)]);
			await storage.writeFiles([{ path: "summaries/newroot000000000.json", content: newJson }], "new");

			// Legacy descendant MD survives — no baseline = no proof we wrote it.
			expect(existsSync(oldPath)).toBe(true);
			expect(metadataManager.findById("legacynofp000000")).toBeDefined();
			expect(metadataManager.findById("newroot000000000")).toBeDefined();
		});
	});

	describe("deleteVisibleMarkdown", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("deletes the visible md file and leaves .jolli/ untouched", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "deadbeef12345678",
				commitMessage: "Add login",
				branch: "feature/login",
			});
			await storage.writeFiles([{ path: "summaries/deadbeef12345678.json", content: summaryJson }], "seed");

			const visiblePath = join(rootPath, "feature-login", "add-login-deadbeef.md");
			expect(existsSync(visiblePath)).toBe(true);

			await storage.deleteVisibleMarkdown({
				commitHash: "deadbeef12345678",
				commitMessage: "Add login",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "feature/login",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			expect(existsSync(visiblePath)).toBe(false);
			// Hidden JSON intact.
			const hiddenPath = join(rootPath, ".jolli", "summaries", "deadbeef12345678.json");
			expect(existsSync(hiddenPath)).toBe(true);
		});

		it("is idempotent on a missing file (no throw)", async () => {
			await expect(
				storage.deleteVisibleMarkdown({
					commitHash: "ffffffffffffffff",
					commitMessage: "ghost",
					commitDate: "2026-01-15T10:00:00Z",
					branch: "ghost-branch",
					generatedAt: "2026-01-15T10:00:00Z",
					parentCommitHash: null,
				}),
			).resolves.toBeUndefined();
		});

		it("preserves a hand-edited md (fingerprint mismatch — same protection cleanupSupersededDescendants gives at write time)", async () => {
			// Regression: cleanupBranchStaleChildMarkdown (called by QueueWorker
			// tail and MigrationEngine) routes through this method to delete
			// hoisted older versions. Without fingerprint protection here, a
			// user who hand-edited a stale child MD before the worker drained
			// would silently lose those edits — only the write-time path's
			// cleanupSupersededDescendants protected them, and that path is not
			// involved in the tail-cleanup or migration flows.
			const summaryJson = makeSummaryJson({
				commitHash: "deadbeef12345678",
				commitMessage: "Add login",
				branch: "feature/login",
			});
			await storage.writeFiles([{ path: "summaries/deadbeef12345678.json", content: summaryJson }], "seed");

			const visiblePath = join(rootPath, "feature-login", "add-login-deadbeef.md");
			expect(existsSync(visiblePath)).toBe(true);

			writeFileSync(visiblePath, "# Hand-edited\n\nUser changed this", "utf-8");

			await storage.deleteVisibleMarkdown({
				commitHash: "deadbeef12345678",
				commitMessage: "Add login",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "feature/login",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: "newroot1234567890",
			});

			expect(existsSync(visiblePath)).toBe(true);
			expect(readFileSync(visiblePath, "utf-8")).toContain("Hand-edited");
			expect(metadataManager.findById("deadbeef12345678")).toBeDefined();
		});

		it("drops the manifest entry alongside the visible md on successful delete", async () => {
			// Mirrors cleanupSupersededDescendants' "ghost entry" cleanup: if we
			// removed the file but kept the manifest record, future migrations
			// / scans would re-trip on a path that no longer exists.
			const summaryJson = makeSummaryJson({
				commitHash: "cafe1234cafe1234",
				commitMessage: "Add cafe",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/cafe1234cafe1234.json", content: summaryJson }], "seed");
			expect(metadataManager.findById("cafe1234cafe1234")).toBeDefined();

			await storage.deleteVisibleMarkdown({
				commitHash: "cafe1234cafe1234",
				commitMessage: "Add cafe",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: "newroot1234567890",
			});

			expect(metadataManager.findById("cafe1234cafe1234")).toBeUndefined();
		});

		// Coverage: manifestEntry truthy + file already gone — drops the
		// orphaned manifest entry (line 139 truthy arm).
		it("drops the manifest entry when the visible md is already gone", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "f00d0000f00d0000",
				commitMessage: "Already gone",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/f00d0000f00d0000.json", content: summaryJson }], "seed");
			// Manually delete the visible MD so the next call hits the
			// `!existsSync + manifestEntry` early-return branch.
			const visiblePath = join(rootPath, "main", "already-gone-f00d0000.md");
			require("node:fs").unlinkSync(visiblePath);
			expect(metadataManager.findById("f00d0000f00d0000")).toBeDefined();

			await storage.deleteVisibleMarkdown({
				commitHash: "f00d0000f00d0000",
				commitMessage: "Already gone",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});
			// Manifest entry was cleaned up.
			expect(metadataManager.findById("f00d0000f00d0000")).toBeUndefined();
		});

		// Coverage: manifestEntry exists but its `fingerprint` field is
		// undefined — proceeds with the unlinkSync without the
		// fingerprint-mismatch guard (line 143 falsy arm).
		it("deletes without fingerprint guard when the manifest entry lacks a fingerprint", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "1234567812345678",
				commitMessage: "Legacy",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/1234567812345678.json", content: summaryJson }], "seed");
			const visiblePath = join(rootPath, "main", "legacy-12345678.md");
			expect(existsSync(visiblePath)).toBe(true);
			// Clobber the manifest entry's fingerprint to simulate a legacy
			// entry that predates fingerprint tracking. The ManifestEntry type
			// declares fingerprint as required, but FolderStorage.ts guards
			// every read with `entry.fingerprint &&` (lines 196, 559, 612, 715,
			// 792) so legacy on-disk manifests written before fingerprint
			// tracking still load. The cast documents that we are intentionally
			// constructing the legacy shape to exercise the falsy-fingerprint
			// arm of deleteVisibleMarkdown.
			const entry = metadataManager.findById("1234567812345678");
			if (!entry) throw new Error("seeded entry vanished");
			const { fingerprint: _omit, ...withoutFp } = entry;
			metadataManager.updateManifest(withoutFp as ManifestEntry);

			await storage.deleteVisibleMarkdown({
				commitHash: "1234567812345678",
				commitMessage: "Legacy",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});
			expect(existsSync(visiblePath)).toBe(false);
		});

		// Coverage: visible MD on disk with NO manifest entry (e.g. a stale
		// file from a previous version) — unlinkSync runs but the
		// removeFromManifest is skipped (line 164 falsy arm).
		it("deletes the file even when there is no manifest entry", async () => {
			require("node:fs").mkdirSync(join(rootPath, "main"), { recursive: true });
			const visiblePath = join(rootPath, "main", "no-manifest-deadbeef.md");
			require("node:fs").writeFileSync(visiblePath, "# Orphan", "utf-8");
			expect(metadataManager.findById("deadbeefdeadbeef")).toBeUndefined();

			await storage.deleteVisibleMarkdown({
				commitHash: "deadbeefdeadbeef",
				commitMessage: "no manifest",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});
			expect(existsSync(visiblePath)).toBe(false);
		});

		it("leaves the <branch>/ directory in place after the last md is removed", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "aaaa11112222bbbb",
				commitMessage: "Solo entry",
				branch: "lone-branch",
			});
			await storage.writeFiles([{ path: "summaries/aaaa11112222bbbb.json", content: summaryJson }], "seed");

			await storage.deleteVisibleMarkdown({
				commitHash: "aaaa11112222bbbb",
				commitMessage: "Solo entry",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "lone-branch",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			const branchDir = join(rootPath, "lone-branch");
			expect(existsSync(branchDir)).toBe(true);
		});
	});

	describe("deletePlanVisible", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("deletes the visible plan--<slug>.md and leaves .jolli/plans/<slug>.md untouched", async () => {
			await storage.writeFiles(
				[{ path: "plans/my-plan-abc12345.md", content: "# Plan\n\nBody", branch: "feature/login" }],
				"seed plan",
			);
			const visiblePath = join(rootPath, "feature-login", "plan--my-plan-abc12345.md");
			const hiddenPath = join(rootPath, ".jolli", "plans", "my-plan-abc12345.md");
			expect(existsSync(visiblePath)).toBe(true);
			expect(existsSync(hiddenPath)).toBe(true);

			await storage.deletePlanVisible("my-plan-abc12345", "feature/login");

			expect(existsSync(visiblePath)).toBe(false);
			// Hidden mirror is intentionally preserved — the orphan branch source
			// stays addressable so a re-association regenerates the visible copy.
			expect(existsSync(hiddenPath)).toBe(true);
			expect(metadataManager.findById("plan:my-plan-abc12345")).toBeUndefined();
		});

		it("is idempotent on a missing file", async () => {
			await expect(storage.deletePlanVisible("ghost-plan", "ghost-branch")).resolves.toBeUndefined();
		});

		it("preserves a hand-edited plan md (fingerprint mismatch)", async () => {
			await storage.writeFiles(
				[{ path: "plans/edited-plan-abc12345.md", content: "# Plan\n\nOriginal", branch: "main" }],
				"seed plan",
			);
			const visiblePath = join(rootPath, "main", "plan--edited-plan-abc12345.md");
			expect(existsSync(visiblePath)).toBe(true);

			writeFileSync(visiblePath, "---\ntype: plan\n---\n\n# Hand-edited\n\nUser changed this", "utf-8");

			await storage.deletePlanVisible("edited-plan-abc12345", "main");

			expect(existsSync(visiblePath)).toBe(true);
			expect(readFileSync(visiblePath, "utf-8")).toContain("Hand-edited");
			// Manifest entry kept — the hand-edited file is still tracked.
			expect(metadataManager.findById("plan:edited-plan-abc12345")).toBeDefined();
		});

		it("falls back to <branchFolder>/plan--<slug>.md when no manifest entry exists", async () => {
			// Simulate a stale visible file without a manifest record (e.g. from
			// a folder that pre-dates manifest tracking).
			mkdirSync(join(rootPath, "main"), { recursive: true });
			const visiblePath = join(rootPath, "main", "plan--orphan-plan.md");
			writeFileSync(visiblePath, "# Stale", "utf-8");
			expect(metadataManager.findById("plan:orphan-plan")).toBeUndefined();

			await storage.deletePlanVisible("orphan-plan", "main");

			expect(existsSync(visiblePath)).toBe(false);
		});
	});

	describe("deleteNoteVisible", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("deletes the visible note--<id>.md and leaves .jolli/notes/<id>.md untouched", async () => {
			await storage.writeFiles(
				[{ path: "notes/my-note-abc12345.md", content: "# Note\n\nBody", branch: "feature/x" }],
				"seed note",
			);
			const visiblePath = join(rootPath, "feature-x", "note--my-note-abc12345.md");
			const hiddenPath = join(rootPath, ".jolli", "notes", "my-note-abc12345.md");
			expect(existsSync(visiblePath)).toBe(true);
			expect(existsSync(hiddenPath)).toBe(true);

			await storage.deleteNoteVisible("my-note-abc12345", "feature/x");

			expect(existsSync(visiblePath)).toBe(false);
			expect(existsSync(hiddenPath)).toBe(true);
			expect(metadataManager.findById("note:my-note-abc12345")).toBeUndefined();
		});

		it("is idempotent on a missing file", async () => {
			await expect(storage.deleteNoteVisible("ghost-note", "ghost-branch")).resolves.toBeUndefined();
		});

		it("preserves a hand-edited note md (fingerprint mismatch)", async () => {
			await storage.writeFiles(
				[{ path: "notes/edited-note-abc12345.md", content: "# Note\n\nOriginal", branch: "main" }],
				"seed note",
			);
			const visiblePath = join(rootPath, "main", "note--edited-note-abc12345.md");
			expect(existsSync(visiblePath)).toBe(true);

			writeFileSync(visiblePath, "---\ntype: note\n---\n\n# Hand-edited", "utf-8");

			await storage.deleteNoteVisible("edited-note-abc12345", "main");

			expect(existsSync(visiblePath)).toBe(true);
			expect(metadataManager.findById("note:edited-note-abc12345")).toBeDefined();
		});

		it("falls back to <branchFolder>/note--<id>.md when no manifest entry exists", async () => {
			mkdirSync(join(rootPath, "main"), { recursive: true });
			const visiblePath = join(rootPath, "main", "note--orphan-note.md");
			writeFileSync(visiblePath, "# Stale", "utf-8");
			expect(metadataManager.findById("note:orphan-note")).toBeUndefined();

			await storage.deleteNoteVisible("orphan-note", "main");

			expect(existsSync(visiblePath)).toBe(false);
		});
	});

	describe("regenerateVisibleMarkdown", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("re-emits the visible md from hidden JSON when the .md is missing", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "deadbeef12345678",
				commitMessage: "Restore me",
				branch: "feature/restore",
			});
			// Seed both hidden + visible.
			await storage.writeFiles([{ path: "summaries/deadbeef12345678.json", content: summaryJson }], "seed");
			const visiblePath = join(rootPath, "feature-restore", "restore-me-deadbeef.md");
			expect(existsSync(visiblePath)).toBe(true);
			// Simulate post-0.99.2 disk state: head .md deleted, hidden JSON intact.
			require("node:fs").unlinkSync(visiblePath);
			expect(existsSync(visiblePath)).toBe(false);

			const wrote = await storage.regenerateVisibleMarkdown({
				commitHash: "deadbeef12345678",
				commitMessage: "Restore me",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "feature/restore",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			expect(wrote).toBe(true);
			expect(existsSync(visiblePath)).toBe(true);
		});

		it("returns true and is a no-op when the visible md already exists", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "cafebabe12345678",
				commitMessage: "Already here",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/cafebabe12345678.json", content: summaryJson }], "seed");
			const visiblePath = join(rootPath, "main", "already-here-cafebabe.md");
			const before = require("node:fs").readFileSync(visiblePath, "utf-8");

			const wrote = await storage.regenerateVisibleMarkdown({
				commitHash: "cafebabe12345678",
				commitMessage: "Already here",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			expect(wrote).toBe(true);
			// File untouched (idempotent fast path).
			const after = require("node:fs").readFileSync(visiblePath, "utf-8");
			expect(after).toBe(before);
		});

		it("returns false when hidden JSON source is missing — cannot regenerate", async () => {
			const wrote = await storage.regenerateVisibleMarkdown({
				commitHash: "ffffffffffffffff",
				commitMessage: "Lost summary",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "ghost-branch",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			expect(wrote).toBe(false);
		});

		it("preserves existing manifest title when regenerating (companion of backfillTitle)", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "feedbabe12345678",
				commitMessage: "Auto-generated message",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/feedbabe12345678.json", content: summaryJson }], "seed");
			// Simulate user-edited title in manifest, then delete the .md to mimic
			// the post-0.99.2 disk state.
			const mm = new MetadataManager(join(rootPath, ".jolli"));
			mm.updateManifest({
				path: "main/auto-generated-message-feedbabe.md",
				fileId: "feedbabe12345678",
				type: "commit",
				fingerprint: "fp",
				source: { commitHash: "feedbabe12345678", branch: "main" },
				title: "Hand-edited title",
			});
			require("node:fs").unlinkSync(join(rootPath, "main", "auto-generated-message-feedbabe.md"));

			await storage.regenerateVisibleMarkdown({
				commitHash: "feedbabe12345678",
				commitMessage: "Auto-generated message",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			// .md regenerated, but manifest title preserved.
			expect(mm.findById("feedbabe12345678")?.title).toBe("Hand-edited title");
		});
	});

	describe("regenerateVisibleMarkdown title fallback", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		// Coverage: when no manifest entry yet exists for the commit (e.g.
		// a fresh recovery against an orphan-branch summary), the manifest
		// title falls back to the summary's commit message (line 243 falsy
		// arm of `existing?.title ?? summary.commitMessage`).
		it("falls back to summary.commitMessage when manifest has no prior entry", async () => {
			const commitHash = "ad0bead0bead0bea"; // 16-char placeholder
			// Write the hidden JSON directly without going through writeFiles
			// so no manifest entry gets created up-front. regenerateVisibleMarkdown
			// must still produce a manifest row keyed on summary.commitMessage.
			await storage.writeFiles(
				[
					{
						path: `summaries/${commitHash}.json`,
						content: makeSummaryJson({
							commitHash,
							commitMessage: "Fresh recovery commit",
							branch: "main",
						}),
					},
				],
				"seed hidden only",
			);
			// Strip the manifest entry that writeFiles auto-created so the
			// regenerate call sees `existing === undefined`.
			metadataManager.removeFromManifest(commitHash);
			require("node:fs").unlinkSync(join(rootPath, "main", "fresh-recovery-commit-ad0bead0.md"));
			expect(metadataManager.findById(commitHash)).toBeUndefined();

			const wrote = await storage.regenerateVisibleMarkdown({
				commitHash,
				commitMessage: "Fresh recovery commit",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});
			expect(wrote).toBe(true);
			// Manifest title now mirrors the summary commit message.
			expect(metadataManager.findById(commitHash)?.title).toBe("Fresh recovery commit");
		});
	});

	// Regression coverage for the "visible .md vanished, manifest entry kept,
	// hidden JSON intact" disk state. Pins the contract that:
	//   - MetadataManager.reconcile preserves the manifest row (it's
	//     deliberately conservative — its missing-file branch only logs WARN).
	//   - Recovery is the explicit responsibility of healMissingVisibleMarkdown
	//     (or regenerateVisibleMarkdown for a single entry).
	describe("reconcile preserves missing entries; heal is the recovery path", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("reconcile keeps the manifest entry and leaves the .md missing", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "0011223344556677",
				commitMessage: "feat: icon style",
				branch: "feature/icon-style",
			});
			await storage.writeFiles([{ path: "summaries/0011223344556677.json", content: summaryJson }], "seed");

			const branchDir = join(rootPath, "feature-icon-style");
			const visiblePath = join(branchDir, "feat-icon-style-00112233.md");
			const hiddenJsonPath = join(rootPath, ".jolli", "summaries", "0011223344556677.json");

			expect(existsSync(visiblePath)).toBe(true);
			expect(existsSync(hiddenJsonPath)).toBe(true);
			expect(metadataManager.findById("0011223344556677")).toBeDefined();

			unlinkSync(visiblePath);

			const fixed = metadataManager.reconcile(rootPath);

			expect(fixed).toBe(0);
			expect(metadataManager.findById("0011223344556677")).toBeDefined();
			expect(existsSync(hiddenJsonPath)).toBe(true);
			// reconcile is intentionally non-healing — recovery lives in heal.
			expect(existsSync(visiblePath)).toBe(false);
		});

		it("regenerateVisibleMarkdown recovers the same file reconcile leaves missing", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "0011223344556677",
				commitMessage: "feat: icon style",
				branch: "feature/icon-style",
			});
			await storage.writeFiles([{ path: "summaries/0011223344556677.json", content: summaryJson }], "seed");
			const visiblePath = join(rootPath, "feature-icon-style", "feat-icon-style-00112233.md");
			unlinkSync(visiblePath);
			metadataManager.reconcile(rootPath);
			expect(existsSync(visiblePath)).toBe(false);

			const wrote = await storage.regenerateVisibleMarkdown({
				commitHash: "0011223344556677",
				commitMessage: "feat: icon style",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "feature/icon-style",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			expect(wrote).toBe(true);
			expect(existsSync(visiblePath)).toBe(true);
		});
	});

	describe("healMissingVisibleMarkdown", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("returns zero counts for an empty manifest", async () => {
			const result = await storage.healMissingVisibleMarkdown();
			expect(result).toEqual({ healed: 0, skipped: 0, failed: 0 });
		});

		it("regenerates the visible md when only the .md was deleted (hidden JSON intact)", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "0011223344556677",
				commitMessage: "feat: icon style",
				branch: "feature/icon-style",
			});
			await storage.writeFiles([{ path: "summaries/0011223344556677.json", content: summaryJson }], "seed");
			const visiblePath = join(rootPath, "feature-icon-style", "feat-icon-style-00112233.md");
			unlinkSync(visiblePath);

			const result = await storage.healMissingVisibleMarkdown();

			expect(result).toEqual({ healed: 1, skipped: 0, failed: 0 });
			expect(existsSync(visiblePath)).toBe(true);
			expect(metadataManager.findById("0011223344556677")).toBeDefined();
		});

		it("skips entries whose visible md is already on disk (counts as skipped)", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "alreadyhere12345",
				commitMessage: "Already here",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/alreadyhere12345.json", content: summaryJson }], "seed");
			const visiblePath = join(rootPath, "main", "already-here-alreadyh.md");
			const beforeBytes = readFileSync(visiblePath, "utf-8");

			const result = await storage.healMissingVisibleMarkdown();

			expect(result).toEqual({ healed: 0, skipped: 1, failed: 0 });
			// Untouched (regenerateVisibleMarkdown short-circuits on existing file).
			expect(readFileSync(visiblePath, "utf-8")).toBe(beforeBytes);
		});

		// Folder-only safety contract: the default heal call (no opts) must NOT
		// drop manifest entries whose hidden JSON is also missing — the manifest
		// is the last record we have in folder-only mode, and dropping it is
		// permanent data loss.
		it("keeps manifest entry when hidden JSON is also missing (default opts)", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "ghost11111111111",
				commitMessage: "Lost commit",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/ghost11111111111.json", content: summaryJson }], "seed");
			unlinkSync(join(rootPath, "main", "lost-commit-ghost111.md"));
			unlinkSync(join(rootPath, ".jolli", "summaries", "ghost11111111111.json"));

			const result = await storage.healMissingVisibleMarkdown();

			expect(result).toEqual({ healed: 0, skipped: 0, failed: 1 });
			// Manifest entry preserved — no truth source to repopulate from.
			expect(metadataManager.findById("ghost11111111111")).toBeDefined();
		});

		// Opt-in drop contract: callers backed by a truth source (orphan branch
		// via DualWriteStorage, `jolli heal-folder` in dual-write mode) can
		// request the drop so reconcile stops re-reporting the ghost.
		it("drops manifest entry when hidden JSON is missing AND dropOrphanedManifestEntries=true", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "ghost22222222222",
				commitMessage: "Lost commit",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/ghost22222222222.json", content: summaryJson }], "seed");
			unlinkSync(join(rootPath, "main", "lost-commit-ghost222.md"));
			unlinkSync(join(rootPath, ".jolli", "summaries", "ghost22222222222.json"));

			const result = await storage.healMissingVisibleMarkdown({ dropOrphanedManifestEntries: true });

			expect(result.healed).toBe(0);
			expect(result.failed).toBe(1);
			expect(result.droppedIds).toEqual(["ghost22222222222"]);
			expect(metadataManager.findById("ghost22222222222")).toBeUndefined();
		});

		// EACCES / EBUSY / EIO / antivirus locks must NEVER drop the manifest
		// entry. Read errors that are not ENOENT are treated as transient.
		it("does not drop manifest entry on transient (non-ENOENT) read errors even with drop opt-in", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "transientread123",
				commitMessage: "Transient read",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/transientread123.json", content: summaryJson }], "seed");
			unlinkSync(join(rootPath, "main", "transient-read-transien.md"));

			// Replace the hidden JSON file with a directory of the same name.
			// readFileSync(dir, ...) throws with code "EISDIR" — a non-ENOENT
			// failure that must NOT trigger a manifest drop.
			const hiddenJsonPath = join(rootPath, ".jolli", "summaries", "transientread123.json");
			unlinkSync(hiddenJsonPath);
			mkdirSync(hiddenJsonPath, { recursive: true });

			const result = await storage.healMissingVisibleMarkdown({ dropOrphanedManifestEntries: true });

			expect(result.healed).toBe(0);
			expect(result.failed).toBe(1);
			expect(result.droppedIds).toBeUndefined();
			expect(metadataManager.findById("transientread123")).toBeDefined();
		});

		// Malformed hidden JSON: heal cannot reconstruct without parseable data,
		// but the data file is present so this is recoverable (user could fix
		// the JSON by hand). Counts as failed; never drops.
		it("counts malformed hidden JSON as failed and keeps the manifest entry", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "malformedjson456",
				commitMessage: "Bad JSON",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/malformedjson456.json", content: summaryJson }], "seed");
			// hash8 = first 8 chars of commitHash ("malforme").
			unlinkSync(join(rootPath, "main", "bad-json-malforme.md"));

			const hiddenJsonPath = join(rootPath, ".jolli", "summaries", "malformedjson456.json");
			writeFileSync(hiddenJsonPath, "{ this is : not valid json", "utf-8");

			const result = await storage.healMissingVisibleMarkdown({ dropOrphanedManifestEntries: true });

			expect(result.healed).toBe(0);
			expect(result.failed).toBe(1);
			expect(result.droppedIds).toBeUndefined();
			expect(metadataManager.findById("malformedjson456")).toBeDefined();
		});

		// Path drift: the manifest's recorded path no longer matches the path
		// the hidden JSON would produce. Heal must NOT silently rewrite the
		// manifest path — that's a separate decision the caller should make
		// after seeing the WARN.
		it("WARNs and skips when the recomputed path diverges from the manifest path", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "drift00000000abcd",
				commitMessage: "Original subject",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/drift00000000abcd.json", content: summaryJson }], "seed");
			const computedPath = join(rootPath, "main", "original-subject-drift000.md");
			unlinkSync(computedPath);

			// Forge the manifest so the recorded path points at a different file
			// name. Heal must refuse to rewrite — that would orphan whatever the
			// user has been navigating to.
			const manifestPath = join(rootPath, ".jolli", "manifest.json");
			const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
				files: Array<{ fileId: string; path: string }>;
			};
			for (const f of manifestRaw.files) {
				if (f.fileId === "drift00000000abcd") {
					f.path = "renamed-folder/handpicked-name.md";
				}
			}
			writeFileSync(manifestPath, JSON.stringify(manifestRaw, null, "\t"));
			metadataManager = new MetadataManager(join(rootPath, ".jolli"));
			storage = new FolderStorage(rootPath, metadataManager);

			const result = await storage.healMissingVisibleMarkdown();

			expect(result.healed).toBe(0);
			// Path drift is counted under `skipped`, not `failed`: the hidden
			// JSON is intact and the entry is recoverable via reconcile.
			// `failed` is reserved for "hidden JSON missing / unreadable /
			// malformed / regenerate refused" — those four cases the CLI's
			// summary line names explicitly. Pinning this here so a future
			// counter swap can't silently change what users see.
			expect(result.failed).toBe(0);
			expect(result.skipped).toBe(1);
			// Manifest path NOT rewritten.
			expect(metadataManager.findById("drift00000000abcd")?.path).toBe("renamed-folder/handpicked-name.md");
			// Computed path NOT written either.
			expect(existsSync(computedPath)).toBe(false);
		});

		it("ignores plan and note entries (only commits use heal-via-hidden-JSON)", async () => {
			// One commit (will be healed), one plan, one note — heal must touch only the commit.
			const summaryJson = makeSummaryJson({
				commitHash: "commit1234567890",
				commitMessage: "Real commit",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/commit1234567890.json", content: summaryJson }], "c");
			await storage.writeFiles([{ path: "plans/some-plan-deadbeef.md", content: "# Plan", branch: "main" }], "p");
			await storage.writeFiles([{ path: "notes/some-note-cafebabe.md", content: "# Note", branch: "main" }], "n");

			unlinkSync(join(rootPath, "main", "real-commit-commit12.md"));
			unlinkSync(join(rootPath, "main", "plan--some-plan-deadbeef.md"));
			unlinkSync(join(rootPath, "main", "note--some-note-cafebabe.md"));

			const result = await storage.healMissingVisibleMarkdown();

			expect(result.healed).toBe(1);
			expect(result.failed).toBe(0);
			expect(existsSync(join(rootPath, "main", "real-commit-commit12.md"))).toBe(true);
			// Plans and notes have no hidden-JSON recovery path here — they aren't healed,
			// but their manifest entries also aren't dropped (heal scope is commits only).
			expect(metadataManager.findById("plan:some-plan-deadbeef")).toBeDefined();
			expect(metadataManager.findById("note:some-note-cafebabe")).toBeDefined();
		});

		it("is idempotent — second call after a successful heal is a no-op", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "idempotent123456",
				commitMessage: "Round trip",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/idempotent123456.json", content: summaryJson }], "seed");
			unlinkSync(join(rootPath, "main", "round-trip-idempote.md"));

			const first = await storage.healMissingVisibleMarkdown();
			const second = await storage.healMissingVisibleMarkdown();

			expect(first.healed).toBe(1);
			expect(second.healed).toBe(0);
			expect(second.skipped).toBe(1);
		});

		// Reads the authoritative branch from the hidden JSON, not the manifest.
		// The synthetic entry must NOT use `entry.source.branch` because legacy
		// manifests can omit it — a `?? ""` fallback would route through
		// `transcodeBranchName("")` → "default" and pollute branches.json.
		it("uses the hidden JSON branch when the manifest entry's source.branch is absent", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "legacysrcbranch1",
				commitMessage: "Legacy entry",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/legacysrcbranch1.json", content: summaryJson }], "seed");
			const correctPath = join(rootPath, "main", "legacy-entry-legacysr.md");
			unlinkSync(correctPath);

			// Simulate a legacy manifest entry that lost its source.branch backfill.
			const manifestPath = join(rootPath, ".jolli", "manifest.json");
			const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
				files: Array<{ fileId: string; source: { branch?: string } }>;
			};
			for (const f of manifestRaw.files) {
				if (f.fileId === "legacysrcbranch1") {
					delete (f.source as { branch?: string }).branch;
				}
			}
			writeFileSync(manifestPath, JSON.stringify(manifestRaw, null, "\t"));
			metadataManager = new MetadataManager(join(rootPath, ".jolli"));
			storage = new FolderStorage(rootPath, metadataManager);

			const result = await storage.healMissingVisibleMarkdown();

			expect(result).toEqual({ healed: 1, skipped: 0, failed: 0 });
			expect(existsSync(correctPath)).toBe(true);
			// Must NOT have written to a "default" branch folder.
			expect(existsSync(join(rootPath, "default", "legacy-entry-legacysr.md"))).toBe(false);
			// Must NOT have polluted branches.json with a ghost empty-branch mapping.
			const branchesRaw = JSON.parse(readFileSync(join(rootPath, ".jolli", "branches.json"), "utf-8")) as {
				mappings: Array<{ branch: string; folder: string }>;
			};
			expect(branchesRaw.mappings.find((m) => m.branch === "")).toBeUndefined();
		});

		// Reads the authoritative commitMessage from the hidden JSON, not the
		// manifest. `entry.title` is preserved across regenerate to honour user
		// edits and so can already diverge from the original commit subject;
		// using it would emit a .md under a different slug.
		it("uses the hidden JSON commitMessage when the manifest title has diverged", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "divergedtitle345",
				commitMessage: "Original commit subject",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/divergedtitle345.json", content: summaryJson }], "seed");
			const correctPath = join(rootPath, "main", "original-commit-subject-diverged.md");
			unlinkSync(correctPath);

			// Simulate a manifest whose title field drifted away from the
			// original commit subject (e.g. a future user-rename feature).
			const manifestPath = join(rootPath, ".jolli", "manifest.json");
			const manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
				files: Array<{ fileId: string; title?: string }>;
			};
			for (const f of manifestRaw.files) {
				if (f.fileId === "divergedtitle345") {
					f.title = "User renamed this entry";
				}
			}
			writeFileSync(manifestPath, JSON.stringify(manifestRaw, null, "\t"));
			metadataManager = new MetadataManager(join(rootPath, ".jolli"));
			storage = new FolderStorage(rootPath, metadataManager);

			const result = await storage.healMissingVisibleMarkdown();

			expect(result).toEqual({ healed: 1, skipped: 0, failed: 0 });
			expect(existsSync(correctPath)).toBe(true);
			// Must NOT have written under the diverged title's slug.
			expect(existsSync(join(rootPath, "main", "user-renamed-this-entry-diverged.md"))).toBe(false);
		});

		// Batch drop: N ghost rows must result in a single manifest rewrite,
		// not N. We can't observe the IO directly without instrumenting, but
		// we can verify the post-state is consistent (all N rows dropped,
		// manifest still parseable, droppedIds returns all N fileIds).
		it("batches manifest drops in a single rewrite when multiple entries are ghosts", async () => {
			const ids = ["ghostA0000000aaaa", "ghostB0000000bbbb", "ghostC0000000cccc"];
			for (const id of ids) {
				const summaryJson = makeSummaryJson({
					commitHash: id,
					commitMessage: `Ghost ${id.slice(5, 6)}`,
					branch: "main",
				});
				await storage.writeFiles([{ path: `summaries/${id}.json`, content: summaryJson }], "seed");
				unlinkSync(join(rootPath, ".jolli", "summaries", `${id}.json`));
			}
			// Delete the visible files for all of them too.
			for (const id of ids) {
				const slugLetter = id.slice(5, 6).toUpperCase();
				const hash8 = id.slice(0, 8);
				unlinkSync(join(rootPath, "main", `ghost-${slugLetter.toLowerCase()}-${hash8}.md`));
			}

			const result = await storage.healMissingVisibleMarkdown({ dropOrphanedManifestEntries: true });

			expect(result.failed).toBe(ids.length);
			expect(result.droppedIds).toEqual(expect.arrayContaining(ids));
			for (const id of ids) {
				expect(metadataManager.findById(id)).toBeUndefined();
			}
		});

		// TOCTOU: hidden JSON disappeared (or parse failed inside regenerate)
		// between heal's existsSync probe and the actual regenerate call. The
		// manifest row is kept (the source was intact a moment ago); failed++
		// so the CLI's "transient read error — re-run later" hint surfaces.
		it("counts as failed when regenerateVisibleMarkdown returns false (TOCTOU between probe and write)", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "toctoufalse00000",
				commitMessage: "Toctou false",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/toctoufalse00000.json", content: summaryJson }], "seed");
			unlinkSync(join(rootPath, "main", "toctou-false-toctoufa.md"));
			const spy = vi.spyOn(storage, "regenerateVisibleMarkdown").mockResolvedValueOnce(false);

			const result = await storage.healMissingVisibleMarkdown();

			expect(spy).toHaveBeenCalledTimes(1);
			expect(result.healed).toBe(0);
			expect(result.failed).toBe(1);
			// Row preserved — heal will retry on the next pass.
			expect(metadataManager.findById("toctoufalse00000")).toBeDefined();
			spy.mockRestore();
		});

		it("counts as failed when regenerateVisibleMarkdown throws (errMsg path)", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "regenerateboom00",
				commitMessage: "Regen boom",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/regenerateboom00.json", content: summaryJson }], "seed");
			unlinkSync(join(rootPath, "main", "regen-boom-regenera.md"));
			const spy = vi
				.spyOn(storage, "regenerateVisibleMarkdown")
				.mockRejectedValueOnce(new Error("ENOSPC during write"));

			const result = await storage.healMissingVisibleMarkdown();

			expect(spy).toHaveBeenCalledTimes(1);
			expect(result.healed).toBe(0);
			expect(result.failed).toBe(1);
			expect(metadataManager.findById("regenerateboom00")).toBeDefined();
			spy.mockRestore();
		});
	});

	describe("pruneBranchMappings", () => {
		it("delegates to MetadataManager.unregisterBranches and returns the removal count", async () => {
			// Pre-seed branches.json with three mappings (resolveFolderForBranch
			// auto-creates them on first lookup) then prune two; the third must
			// survive both at the branches.json level and as a resolvable mapping.
			await storage.ensure();
			metadataManager.resolveFolderForBranch("alive/branch");
			metadataManager.resolveFolderForBranch("dead/one");
			metadataManager.resolveFolderForBranch("dead/two");
			const before = metadataManager.readBranches();
			expect(before.mappings).toHaveLength(3);

			const removed = await storage.pruneBranchMappings(["dead/one", "dead/two"]);

			expect(removed).toBe(2);
			const after = metadataManager.readBranches();
			expect(after.mappings.map((m) => m.branch)).toEqual(["alive/branch"]);
		});

		it("returns 0 when none of the requested branches are mapped", async () => {
			await storage.ensure();
			metadataManager.resolveFolderForBranch("real/branch");

			const removed = await storage.pruneBranchMappings(["never/mapped"]);

			expect(removed).toBe(0);
		});
	});

	describe("regenerateVisibleMarkdown — malformed hidden JSON", () => {
		// `regenerateVisibleMarkdown` is reused by heal AND by the explicit
		// revert flow. A malformed hidden JSON must NOT throw — it returns
		// false so callers count it as "transient" rather than aborting.
		it("returns false (does not throw) when the hidden JSON cannot be parsed", async () => {
			await storage.ensure();
			const summaryJson = makeSummaryJson({
				commitHash: "malformedregen00",
				commitMessage: "Malformed regen",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/malformedregen00.json", content: summaryJson }], "seed");
			// Trash the hidden JSON in-place so regenerate's parseJSON throws.
			writeFileSync(join(rootPath, ".jolli", "summaries", "malformedregen00.json"), "{ not valid json", "utf-8");
			const visiblePath = join(rootPath, "main", "malformed-regen-malforme.md");
			unlinkSync(visiblePath);

			const entry = metadataManager.findById("malformedregen00");
			if (!entry) throw new Error("entry must exist");
			const result = await storage.regenerateVisibleMarkdown({
				commitHash: "malformedregen00",
				parentCommitHash: null,
				commitMessage: "Malformed regen",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
			});

			expect(result).toBe(false);
			expect(existsSync(visiblePath)).toBe(false);
		});
	});

	describe("slugify", () => {
		it("basic message", () => {
			expect(FolderStorage.slugify("Add login feature")).toBe("add-login-feature");
		});

		it("strips special characters", () => {
			expect(FolderStorage.slugify("Fix bug (#123)!")).toBe("fix-bug-123");
		});

		it("truncates long messages", () => {
			expect(FolderStorage.slugify("a".repeat(100)).length).toBeLessThanOrEqual(50);
		});

		it("returns untitled for empty", () => {
			expect(FolderStorage.slugify("")).toBe("untitled");
			expect(FolderStorage.slugify("!!!")).toBe("untitled");
		});
	});

	describe("readFile error handling", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		// readFileSync throws when the path is a directory; that should be caught
		// silently and surface as `null`, not propagate as an exception.
		it("returns null when readFileSync throws", async () => {
			const dirAsFile = join(rootPath, ".jolli", "is-a-dir");
			mkdirSync(dirAsFile, { recursive: true });
			expect(await storage.readFile("is-a-dir")).toBeNull();
		});
	});

	describe("dirty marker (markDirty / clearDirty / isDirty)", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("markDirty writes a status file and isDirty reports true", () => {
			expect(storage.isDirty()).toBe(false);
			storage.markDirty("some failed write");
			expect(storage.isDirty()).toBe(true);

			const statusPath = join(rootPath, ".jolli", "shadow-status.json");
			expect(existsSync(statusPath)).toBe(true);
			const status = JSON.parse(readFileSync(statusPath, "utf-8"));
			expect(status.dirty).toBe(true);
			expect(status.message).toBe("some failed write");
		});

		it("clearDirty removes the status file", () => {
			storage.markDirty("oops");
			expect(storage.isDirty()).toBe(true);
			storage.clearDirty();
			expect(storage.isDirty()).toBe(false);
		});

		it("clearDirty is a no-op when nothing is dirty", () => {
			expect(storage.isDirty()).toBe(false);
			expect(() => storage.clearDirty()).not.toThrow();
		});
	});

	describe("delete and listFiles edge cases", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("delete on a non-existent file reports zero without throwing", async () => {
			await expect(
				storage.writeFiles([{ path: "ghost.txt", content: "", delete: true }], "delete-ghost"),
			).resolves.toBeUndefined();
		});

		// File exists but unlinkSync throws (parent dir read-only) — deleteHiddenFile
		// must catch and return false rather than propagating.
		it("delete swallows unlink errors from a read-only parent dir", async () => {
			await storage.writeFiles([{ path: "subdir/locked.txt", content: "x" }], "create");
			const fs = await import("node:fs");
			const subDir = join(rootPath, ".jolli", "subdir");
			fs.chmodSync(subDir, 0o500);
			try {
				await expect(
					storage.writeFiles([{ path: "subdir/locked.txt", content: "", delete: true }], "delete"),
				).resolves.toBeUndefined();
			} finally {
				fs.chmodSync(subDir, 0o700);
			}
		});

		it("listFiles recurses into nested subdirectories", async () => {
			await storage.writeFiles(
				[
					{ path: "summaries/sub-a/x.json", content: makeSummaryJson({ commitHash: "aaaa11111111aaaa" }) },
					{ path: "summaries/sub-b/y.json", content: makeSummaryJson({ commitHash: "bbbb22222222bbbb" }) },
				],
				"nested",
			);
			const result = await storage.listFiles("summaries");
			expect(result).toHaveLength(2);
			expect(result.some((p) => p.includes("sub-a"))).toBe(true);
			expect(result.some((p) => p.includes("sub-b"))).toBe(true);
		});
	});

	describe("frontmatter commitType", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		// Optional `commitType` field is rendered into YAML frontmatter only when set.
		it("renders commitType when present on the summary", async () => {
			const json = makeSummaryJson({ commitType: "feat" });
			await storage.writeFiles([{ path: "summaries/abc12345deadbeef.json", content: json }], "store");
			const mainDir = join(rootPath, "main");
			const md = readdirSync(mainDir).find((f) => f.endsWith(".md")) as string;
			const content = readFileSync(join(mainDir, md), "utf-8");
			expect(content).toContain("commitType: feat");
		});
	});

	describe("invalid summary JSON", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		// The hidden JSON is still written (orphan branch invariants), but the
		// markdown generator silently bails on parse failure rather than throwing.
		it("does not throw and does not generate markdown when summary JSON is malformed", async () => {
			await expect(
				storage.writeFiles([{ path: "summaries/badhash.json", content: "{ bad json" }], "bad"),
			).resolves.toBeUndefined();
			expect(existsSync(join(rootPath, ".jolli", "summaries", "badhash.json"))).toBe(true);
			// No markdown generated
			const root = readdirSync(rootPath);
			const branchDirs = root.filter((f) => !f.startsWith("."));
			for (const dir of branchDirs) {
				const dirPath = join(rootPath, dir);
				if (!readdirSync(dirPath).some((f) => f.endsWith(".md"))) continue;
				throw new Error(`Unexpected markdown in ${dir}`);
			}
		});
	});

	describe("cleanup edge cases", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		function summaryJson(hash: string, message: string, children?: ReadonlyArray<unknown>): string {
			return JSON.stringify({
				version: 3,
				commitHash: hash,
				commitMessage: message,
				commitAuthor: "Alice",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				...(children && children.length > 0 ? { children } : {}),
			});
		}

		// Manifest still tracks the descendant but its on-disk MD is already gone.
		// Cleanup must drop the stale manifest entry, not bail or throw.
		it("drops manifest entries for descendants whose MD file is already gone", async () => {
			const oldJson = summaryJson("old1234567890abcd", "Old commit message");
			await storage.writeFiles([{ path: "summaries/old1234567890abcd.json", content: oldJson }], "old");
			const mainDir = join(rootPath, "main");
			const oldName = readdirSync(mainDir).find((f) => f.includes("old12345")) as string;
			// Simulate an external delete of just the on-disk MD; manifest still
			// has the entry pointing at it.
			const fs = await import("node:fs");
			fs.unlinkSync(join(mainDir, oldName));
			expect(metadataManager.findById("old1234567890abcd")).toBeDefined();

			const newJson = summaryJson("new9876543210fedc", "New commit", [JSON.parse(oldJson)]);
			await storage.writeFiles([{ path: "summaries/new9876543210fedc.json", content: newJson }], "new");

			expect(metadataManager.findById("old1234567890abcd")).toBeUndefined();
			expect(metadataManager.findById("new9876543210fedc")).toBeDefined();
		});

		// Reading the on-disk MD fails (e.g. because we replaced it with a dir).
		// Cleanup must skip it (preserving the manifest entry, not throwing).
		it("preserves the manifest entry when reading the descendant file fails", async () => {
			const oldJson = summaryJson("old1234567890abcd", "Old");
			await storage.writeFiles([{ path: "summaries/old1234567890abcd.json", content: oldJson }], "old");
			const mainDir = join(rootPath, "main");
			const oldName = readdirSync(mainDir).find((f) => f.includes("old12345")) as string;
			const oldPath = join(mainDir, oldName);

			// Replace the file with a directory of the same name → readFileSync throws
			const fs = await import("node:fs");
			fs.unlinkSync(oldPath);
			fs.mkdirSync(oldPath);

			const newJson = summaryJson("new9876543210fedc", "New", [JSON.parse(oldJson)]);
			await storage.writeFiles([{ path: "summaries/new9876543210fedc.json", content: newJson }], "new");

			// The unreadable descendant entry must be kept (manifest still has it).
			expect(metadataManager.findById("old1234567890abcd")).toBeDefined();
		});

		// Defensive guard: the new root and a "descendant" share the same path.
		// Only happens if a summary lists itself as a child (or via a hash-prefix
		// collision). Cleanup must skip it instead of unlinking what we just wrote.
		it("skips cleanup when the descendant path matches the new root", async () => {
			const selfHash = "selfself11111111";
			const initial = summaryJson(selfHash, "Self");
			await storage.writeFiles([{ path: `summaries/${selfHash}.json`, content: initial }], "first");
			const mainDir = join(rootPath, "main");
			const before = readdirSync(mainDir).filter((f) => f.endsWith(".md"));
			expect(before).toHaveLength(1);

			// Re-write the same root, but now wrap a child whose hash equals the
			// root's own hash — the manifest entry for that hash points at the
			// path we're about to (re-)write, so the inner equality guard fires.
			const reWritten = summaryJson(selfHash, "Self", [JSON.parse(initial)]);
			await storage.writeFiles([{ path: `summaries/${selfHash}.json`, content: reWritten }], "again");

			// The MD survived (the equality guard prevented cleanup from deleting it).
			const after = readdirSync(mainDir).filter((f) => f.endsWith(".md"));
			expect(after).toHaveLength(1);
			expect(metadataManager.findById(selfHash)).toBeDefined();
		});

		// Unreachable defensively-handled branches: descendant entry whose `type`
		// is not "commit" is skipped. Manually inject a non-commit manifest entry
		// with a hash that the new root's child list will name.
		it("skips manifest entries whose type is not 'commit'", async () => {
			metadataManager.updateManifest({
				path: "main/manual-1234.md",
				fileId: "manualhash00000000",
				type: "plan",
				fingerprint: "fp",
				source: {},
				title: "manual",
			});
			const newJson = summaryJson("new9876543210fedc", "New", [
				{
					version: 3,
					commitHash: "manualhash00000000",
					commitMessage: "manual",
					commitAuthor: "x",
					commitDate: "2026-01-15T10:00:00Z",
					branch: "main",
					generatedAt: "2026-01-15T10:00:00Z",
				},
			]);
			await storage.writeFiles([{ path: "summaries/new9876543210fedc.json", content: newJson }], "new");

			// The plan-typed entry must remain (cleanup skipped it).
			expect(metadataManager.findById("manualhash00000000")?.type).toBe("plan");
		});

		// Cleanup tolerates an unlinkSync failure (e.g. permissions). On Unix we
		// strip write permission on the parent directory so unlink raises EACCES
		// while the rest of the storage write path still succeeds (the new MD
		// goes into a different branch directory).
		it.skipIf(process.platform === "win32")("warns and keeps the entry when unlinkSync fails", async () => {
			const oldJson = summaryJson("old1234567890abcd", "Old");
			await storage.writeFiles([{ path: "summaries/old1234567890abcd.json", content: oldJson }], "old");

			// New root lives in a *different* branch folder so writing it doesn't
			// touch the read-only "main" directory.
			const newJson = JSON.stringify({
				version: 3,
				commitHash: "new9876543210fedc",
				commitMessage: "New",
				commitAuthor: "Alice",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "feature/x",
				generatedAt: "2026-01-15T10:00:00Z",
				children: [JSON.parse(oldJson)],
			});

			// Windows chmod doesn't enforce the same EACCES behaviour as POSIX, so
			// the unlink-fails branch can't be exercised on win32. Skipping there
			// keeps `npm run all` green on the maintainer's primary platform.
			if (process.platform === "win32") {
				return;
			}

			const fs = await import("node:fs");
			const mainDir = join(rootPath, "main");
			fs.chmodSync(mainDir, 0o500); // r-x — unlink within fails with EACCES

			try {
				await storage.writeFiles([{ path: "summaries/new9876543210fedc.json", content: newJson }], "new");
				// Entry still present because unlink failed
				expect(metadataManager.findById("old1234567890abcd")).toBeDefined();
			} finally {
				fs.chmodSync(mainDir, 0o700);
			}
		});
	});

	describe("plan/note without branch (resolveBranchFromSlug)", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		// Plan slug ends with a known commit's hash8 prefix → branch resolved
		// via manifest lookup, no need for the caller to pass `branch`.
		it("resolves branch via manifest when plan slug embeds a known commit hash", async () => {
			// Seed a commit so its branch is in the manifest
			const commitJson = makeSummaryJson({ branch: "feature/auth", commitHash: "aaaa11111111aaaa" });
			await storage.writeFiles([{ path: "summaries/aaaa11111111aaaa.json", content: commitJson }], "commit");

			const planContent = "# Plan body";
			await storage.writeFiles([{ path: "plans/my-plan-aaaa1111.md", content: planContent }], "plan no branch");

			const branchDir = join(rootPath, "feature-auth");
			expect(existsSync(branchDir)).toBe(true);
			expect(readdirSync(branchDir).some((f) => f.startsWith("plan--"))).toBe(true);
		});

		// Slug whose hash8 isn't in the manifest but is in index.json (e.g. a
		// child commit from a squash). Manifest miss → falls back to index.json.
		it("falls back to index.json when manifest has no matching commit", async () => {
			// Write index.json directly so it's the ONLY source of truth for the hash
			const indexJson = JSON.stringify({
				version: 3,
				entries: [
					{
						commitHash: "indexhash11111111",
						parentCommitHash: null,
						commitMessage: "Test",
						commitDate: "2026-01-15T10:00:00Z",
						branch: "release",
						generatedAt: "2026-01-15T10:00:00Z",
					},
				],
			});
			await storage.writeFiles([{ path: "index.json", content: indexJson }], "seed index");

			await storage.writeFiles([{ path: "plans/idx-plan-indexhas.md", content: "body" }], "plan");

			expect(existsSync(join(rootPath, "release"))).toBe(true);
		});

		// Slug whose embedded hash8 doesn't match either source → fallback to "_shared".
		it("falls back to _shared when neither manifest nor index has the hash", async () => {
			await storage.writeFiles([{ path: "plans/orphan-zzzz9999.md", content: "body" }], "plan");
			expect(existsSync(join(rootPath, "_shared"))).toBe(true);
		});

		// Slug with no recognizable hash suffix (too short) → fallback to _shared.
		it("falls back to _shared when slug has no hash suffix", async () => {
			await storage.writeFiles([{ path: "plans/short.md", content: "body" }], "plan");
			expect(existsSync(join(rootPath, "_shared"))).toBe(true);
		});

		// Same lookup logic for notes — exercises the second call site of
		// resolveBranchFromSlug.
		it("uses manifest hash lookup for notes too", async () => {
			const commitJson = makeSummaryJson({ branch: "main", commitHash: "cccc33333333cccc" });
			await storage.writeFiles([{ path: "summaries/cccc33333333cccc.json", content: commitJson }], "commit");

			await storage.writeFiles([{ path: "notes/idea-cccc3333.md", content: "body" }], "note");

			const mainDir = join(rootPath, "main");
			expect(readdirSync(mainDir).some((f) => f.startsWith("note--"))).toBe(true);
		});

		// index.json present but corrupt → caught and fall through to _shared.
		it("falls back to _shared when index.json is unparseable", async () => {
			// Write directly so index.json bypasses the normal write path
			const indexPath = join(rootPath, ".jolli", "index.json");
			writeFileSync(indexPath, "{ broken json", "utf-8");

			await storage.writeFiles([{ path: "plans/lost-aaaa9999.md", content: "body" }], "plan");
			expect(existsSync(join(rootPath, "_shared"))).toBe(true);
		});
	});

	describe("plan/note title fallback", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		// extractTitle returns null when the body has no `#` heading; the manifest
		// title must then fall back to the slug/id.
		it("uses the slug as title when the plan body has no markdown heading", async () => {
			await storage.writeFiles(
				[{ path: "plans/no-heading-aaa11111.md", content: "Body without heading", branch: "main" }],
				"plan",
			);
			const entry = metadataManager.findById("plan:no-heading-aaa11111");
			expect(entry?.title).toBe("no-heading-aaa11111");
		});

		it("uses the id as title when the note body has no markdown heading", async () => {
			await storage.writeFiles(
				[{ path: "notes/no-heading-aaa11111.md", content: "Body without heading", branch: "main" }],
				"note",
			);
			const entry = metadataManager.findById("note:no-heading-aaa11111");
			expect(entry?.title).toBe("no-heading-aaa11111");
		});
	});

	describe("isUserEditedOnDisk", () => {
		it("returns false when the file does not exist", () => {
			const result = storage.isUserEditedOnDisk(join(rootPath, "nope.md"), "abc123");
			expect(result).toBe(false);
		});

		it("returns false when no manifest fingerprint baseline is available", () => {
			const absPath = join(rootPath, "main", "foo.md");
			mkdirSync(join(rootPath, "main"), { recursive: true });
			writeFileSync(absPath, "anything", "utf-8");
			const result = storage.isUserEditedOnDisk(absPath, undefined);
			expect(result).toBe(false);
		});

		it("returns false when on-disk content matches the fingerprint", () => {
			const absPath = join(rootPath, "main", "foo.md");
			mkdirSync(join(rootPath, "main"), { recursive: true });
			const content = "stable content";
			writeFileSync(absPath, content, "utf-8");
			const fingerprint = MetadataManager.sha256(content);
			const result = storage.isUserEditedOnDisk(absPath, fingerprint);
			expect(result).toBe(false);
		});

		it("returns true when on-disk content diverges from the fingerprint", () => {
			const absPath = join(rootPath, "main", "foo.md");
			mkdirSync(join(rootPath, "main"), { recursive: true });
			writeFileSync(absPath, "edited content", "utf-8");
			const fingerprint = MetadataManager.sha256("original content");
			const result = storage.isUserEditedOnDisk(absPath, fingerprint);
			expect(result).toBe(true);
		});
	});

	describe("generateSummaryMarkdown: write protection", () => {
		it("skips overwriting a user-edited visible markdown", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "abcdef1234567890",
				commitMessage: "Add feature",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/abcdef1234567890.json", content: summaryJson }], "seed");

			const visiblePath = join(rootPath, "main", "add-feature-abcdef12.md");
			expect(existsSync(visiblePath)).toBe(true);

			const editedContent = "# User edited content\n\nThis must survive.";
			writeFileSync(visiblePath, editedContent, "utf-8");

			await storage.writeFiles([{ path: "summaries/abcdef1234567890.json", content: summaryJson }], "regenerate");

			expect(readFileSync(visiblePath, "utf-8")).toBe(editedContent);
		});

		it("overwrites normally when the on-disk file matches the manifest fingerprint", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "11112222deadbeef",
				commitMessage: "Refactor module",
				branch: "main",
				commitAuthor: "Alice",
			});
			await storage.writeFiles([{ path: "summaries/11112222deadbeef.json", content: summaryJson }], "seed");

			const visiblePath = join(rootPath, "main", "refactor-module-11112222.md");
			const before = readFileSync(visiblePath, "utf-8");

			// Keep commitMessage (and thus filename) stable. Change a frontmatter
			// field — buildMarkdown is mocked to a constant in this suite, so the
			// body alone won't show a difference; the YAML frontmatter will.
			const updatedJson = makeSummaryJson({
				commitHash: "11112222deadbeef",
				commitMessage: "Refactor module",
				branch: "main",
				commitAuthor: "Bob",
			});
			await storage.writeFiles([{ path: "summaries/11112222deadbeef.json", content: updatedJson }], "update");

			const after = readFileSync(visiblePath, "utf-8");
			expect(after).not.toBe(before);
		});

		it("overwrites legacy entries without a fingerprint, then protects on next write", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "3333444455556666",
				commitMessage: "Old commit",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/3333444455556666.json", content: summaryJson }], "seed");

			const visiblePath = join(rootPath, "main", "old-commit-33334444.md");
			const manifestEntry = metadataManager.findById("3333444455556666");
			expect(manifestEntry).toBeDefined();
			expect(manifestEntry?.fingerprint).toBeDefined();
			if (!manifestEntry) throw new Error("manifestEntry must be defined");

			// Simulate legacy by deleting the fingerprint from the manifest entry.
			metadataManager.updateManifest({
				path: manifestEntry.path,
				fileId: manifestEntry.fileId,
				type: manifestEntry.type,
				fingerprint: undefined as unknown as string,
				source: manifestEntry.source,
				title: manifestEntry.title,
			});

			writeFileSync(visiblePath, "# Legacy hand-edit", "utf-8");

			await storage.writeFiles(
				[{ path: "summaries/3333444455556666.json", content: summaryJson }],
				"rewrite-legacy",
			);

			// Legacy: overwrite was permitted (no baseline to protect).
			expect(readFileSync(visiblePath, "utf-8")).not.toContain("Legacy hand-edit");

			// Now there IS a fingerprint; a fresh hand-edit must be protected.
			writeFileSync(visiblePath, "# Post-legacy hand-edit", "utf-8");
			await storage.writeFiles(
				[{ path: "summaries/3333444455556666.json", content: summaryJson }],
				"second-rewrite",
			);
			expect(readFileSync(visiblePath, "utf-8")).toContain("Post-legacy hand-edit");
		});
	});

	describe("generatePlanMarkdown: manifest source.branch persistence", () => {
		it("records source.branch on the plan manifest entry so revert can route back to the source branch", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "ffff1111aaaa2222",
				commitMessage: "Plan branch persist",
				branch: "feature/login",
			});
			await storage.writeFiles(
				[{ path: "summaries/ffff1111aaaa2222.json", content: summaryJson }],
				"seed-summary",
			);
			await storage.writeFiles(
				[
					{
						path: "plans/ffff1111aaaa2222.md",
						content: "# Plan body\n\nLogin scope.",
						branch: "feature/login",
					},
				],
				"seed-plan",
			);
			const manifest = metadataManager.readManifest();
			const entry = manifest.files.find((f) => f.fileId === "plan:ffff1111aaaa2222");
			expect(entry?.source?.branch).toBe("feature/login");
		});
	});

	describe("generateNoteMarkdown: manifest source.branch persistence", () => {
		it("records source.branch on the note manifest entry so revert can route back to the source branch", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "eeee5555ffff6666",
				commitMessage: "Note branch persist",
				branch: "fix/doc-bug",
			});
			await storage.writeFiles(
				[{ path: "summaries/eeee5555ffff6666.json", content: summaryJson }],
				"seed-summary",
			);
			await storage.writeFiles(
				[
					{
						path: "notes/eeee5555ffff6666.md",
						content: "# Note body",
						branch: "fix/doc-bug",
					},
				],
				"seed-note",
			);
			const manifest = metadataManager.readManifest();
			const entry = manifest.files.find((f) => f.fileId === "note:eeee5555ffff6666");
			expect(entry?.source?.branch).toBe("fix/doc-bug");
		});
	});

	describe("resolveBranchForFolder", () => {
		it("returns the registered branch for a known folder", async () => {
			metadataManager.resolveFolderForBranch("feature/login");
			expect(storage.resolveBranchForFolder("feature-login")).toBe("feature/login");
		});

		it("returns null for an unregistered folder", () => {
			expect(storage.resolveBranchForFolder("does-not-exist")).toBeNull();
		});
	});

	describe("generatePlanMarkdown: write protection", () => {
		it("skips overwriting a user-edited visible plan markdown", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "aaaa1111bbbb2222",
				commitMessage: "Add login",
				branch: "feature/login",
			});
			await storage.writeFiles(
				[{ path: "summaries/aaaa1111bbbb2222.json", content: summaryJson }],
				"seed-summary",
			);
			await storage.writeFiles(
				[
					{
						path: "plans/aaaa1111bbbb2222.md",
						content: "# Plan body\n\nThink about login.",
						branch: "feature/login",
					},
				],
				"seed-plan",
			);

			const visiblePath = join(rootPath, "feature-login", "plan--aaaa1111bbbb2222.md");
			expect(existsSync(visiblePath)).toBe(true);

			const editedContent = "# Hand-edited plan\n\nMust survive.";
			writeFileSync(visiblePath, editedContent, "utf-8");

			await storage.writeFiles(
				[
					{
						path: "plans/aaaa1111bbbb2222.md",
						content: "# Plan body\n\nThink about login.",
						branch: "feature/login",
					},
				],
				"regenerate-plan",
			);

			expect(readFileSync(visiblePath, "utf-8")).toBe(editedContent);
		});
	});

	describe("generateNoteMarkdown: write protection", () => {
		it("skips overwriting a user-edited visible note markdown", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "cccc3333dddd4444",
				commitMessage: "Doc bug",
				branch: "fix/doc-bug",
			});
			await storage.writeFiles(
				[{ path: "summaries/cccc3333dddd4444.json", content: summaryJson }],
				"seed-summary",
			);
			await storage.writeFiles(
				[
					{
						path: "notes/cccc3333dddd4444.md",
						content: "# Note body",
						branch: "fix/doc-bug",
					},
				],
				"seed-note",
			);

			const visiblePath = join(rootPath, "fix-doc-bug", "note--cccc3333dddd4444.md");
			expect(existsSync(visiblePath)).toBe(true);

			const editedContent = "# Hand-edited note\n\nMust survive.";
			writeFileSync(visiblePath, editedContent, "utf-8");

			await storage.writeFiles(
				[
					{
						path: "notes/cccc3333dddd4444.md",
						content: "# Note body",
						branch: "fix/doc-bug",
					},
				],
				"regenerate-note",
			);

			expect(readFileSync(visiblePath, "utf-8")).toBe(editedContent);
		});
	});

	describe("forceRegenerateVisibleMarkdown", () => {
		it("overwrites a diverged visible markdown back to the JSON-derived version", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "5555666677778888",
				commitMessage: "Add tests",
				branch: "main",
			});
			await storage.writeFiles([{ path: "summaries/5555666677778888.json", content: summaryJson }], "seed");

			const visiblePath = join(rootPath, "main", "add-tests-55556666.md");
			const original = readFileSync(visiblePath, "utf-8");

			writeFileSync(visiblePath, "# Diverged content", "utf-8");
			expect(readFileSync(visiblePath, "utf-8")).toBe("# Diverged content");

			const result = await storage.forceRegenerateVisibleMarkdown({
				commitHash: "5555666677778888",
				commitMessage: "Add tests",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			expect(result).toBe(true);
			expect(readFileSync(visiblePath, "utf-8")).toBe(original);
		});

		it("returns false when the hidden JSON source is missing", async () => {
			const result = await storage.forceRegenerateVisibleMarkdown({
				commitHash: "9999000011112222",
				commitMessage: "Phantom",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});
			expect(result).toBe(false);
		});
	});

	describe("regenerateVisiblePlan", () => {
		it("overwrites a diverged visible plan from the hidden plans/ source", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "abcd1234abcd1234",
				commitMessage: "Plan thing",
				branch: "feature/plan-thing",
			});
			await storage.writeFiles(
				[{ path: "summaries/abcd1234abcd1234.json", content: summaryJson }],
				"seed-summary",
			);
			await storage.writeFiles(
				[
					{
						path: "plans/abcd1234abcd1234.md",
						content: "# Original plan",
						branch: "feature/plan-thing",
					},
				],
				"seed-plan",
			);

			const visiblePath = join(rootPath, "feature-plan-thing", "plan--abcd1234abcd1234.md");
			writeFileSync(visiblePath, "# Diverged plan", "utf-8");

			const result = await storage.regenerateVisiblePlan("abcd1234abcd1234", "feature/plan-thing");

			expect(result).toBe(true);
			expect(readFileSync(visiblePath, "utf-8")).toContain("Original plan");
			expect(readFileSync(visiblePath, "utf-8")).not.toContain("Diverged");
		});

		it("returns false when the hidden plans/ source is missing", async () => {
			const result = await storage.regenerateVisiblePlan("nonexistent", "main");
			expect(result).toBe(false);
		});

		// The unlink-first branch only fires when a visible file actually
		// exists. The opposite — hidden source present but visible already
		// missing — must skip the unlink and write the visible directly.
		// Pins the `existsSync(visiblePath) === false` arm.
		it("writes the visible plan without unlinking when no prior visible file exists", async () => {
			await storage.writeFiles(
				[
					{
						path: "plans/freshplan11111.md",
						content: "# Fresh plan",
						branch: "feature/fresh-plan",
					},
				],
				"seed-plan",
			);
			const visiblePath = join(rootPath, "feature-fresh-plan", "plan--freshplan11111.md");
			// Remove visible so the existsSync branch in regenerate takes the
			// "no prior file" path.
			unlinkSync(visiblePath);
			expect(existsSync(visiblePath)).toBe(false);

			const result = await storage.regenerateVisiblePlan("freshplan11111", "feature/fresh-plan");

			expect(result).toBe(true);
			expect(existsSync(visiblePath)).toBe(true);
			expect(readFileSync(visiblePath, "utf-8")).toContain("Fresh plan");
		});
	});

	describe("regenerateVisibleNote", () => {
		it("overwrites a diverged visible note from the hidden notes/ source", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "ef0123ef0123ef01",
				commitMessage: "Note thing",
				branch: "fix/note-thing",
			});
			await storage.writeFiles(
				[{ path: "summaries/ef0123ef0123ef01.json", content: summaryJson }],
				"seed-summary",
			);
			await storage.writeFiles(
				[
					{
						path: "notes/ef0123ef0123ef01.md",
						content: "# Original note",
						branch: "fix/note-thing",
					},
				],
				"seed-note",
			);

			const visiblePath = join(rootPath, "fix-note-thing", "note--ef0123ef0123ef01.md");
			writeFileSync(visiblePath, "# Diverged note", "utf-8");

			const result = await storage.regenerateVisibleNote("ef0123ef0123ef01", "fix/note-thing");

			expect(result).toBe(true);
			expect(readFileSync(visiblePath, "utf-8")).toContain("Original note");
		});

		it("returns false when the hidden notes/ source is missing", async () => {
			const result = await storage.regenerateVisibleNote("nonexistent", "main");
			expect(result).toBe(false);
		});

		// Mirrors the regenerateVisiblePlan "no prior visible" test; pins the
		// `existsSync(visiblePath) === false` arm for the note path.
		it("writes the visible note without unlinking when no prior visible file exists", async () => {
			await storage.writeFiles(
				[
					{
						path: "notes/freshnote2222.md",
						content: "# Fresh note",
						branch: "fix/fresh-note",
					},
				],
				"seed-note",
			);
			const visiblePath = join(rootPath, "fix-fresh-note", "note--freshnote2222.md");
			unlinkSync(visiblePath);
			expect(existsSync(visiblePath)).toBe(false);

			const result = await storage.regenerateVisibleNote("freshnote2222", "fix/fresh-note");

			expect(result).toBe(true);
			expect(existsSync(visiblePath)).toBe(true);
			expect(readFileSync(visiblePath, "utf-8")).toContain("Fresh note");
		});
	});
});
