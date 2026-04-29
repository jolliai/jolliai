import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

			const { readdirSync } = require("node:fs");
			const rootFiles = readdirSync(rootPath).filter((f: string) => !f.startsWith("."));
			const mdFiles = rootFiles.filter((f: string) => f.endsWith(".md"));
			expect(mdFiles).toHaveLength(0);
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
});
