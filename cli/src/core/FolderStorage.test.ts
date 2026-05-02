import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderStorage } from "./FolderStorage.js";
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
		it("warns and keeps the entry when unlinkSync fails", async () => {
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
});
