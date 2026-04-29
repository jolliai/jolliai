import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileWrite } from "../Types.js";
import { FolderStorage } from "./FolderStorage.js";
import { MetadataManager } from "./MetadataManager.js";
import { MigrationEngine } from "./MigrationEngine.js";
import type { StorageProvider } from "./StorageProvider.js";

// Mock SummaryMarkdownBuilder
vi.mock("./SummaryMarkdownBuilder.js", () => ({
	buildMarkdown: vi.fn().mockReturnValue("# Mock Markdown\n\nBody"),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

/** In-memory storage to simulate orphan branch */
class InMemoryStorage implements StorageProvider {
	private files = new Map<string, string>();

	async readFile(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	async writeFiles(files: FileWrite[], _msg: string): Promise<void> {
		for (const f of files) {
			if (f.delete) this.files.delete(f.path);
			else this.files.set(f.path, f.content);
		}
	}
	async listFiles(prefix: string): Promise<string[]> {
		return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
	}
	async exists(): Promise<boolean> {
		return true;
	}
	async ensure(): Promise<void> {}
}

function makeTmpDir(): string {
	const dir = join(tmpdir(), `kb-mig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function makeSummary(hash: string, message = "Test commit", branch = "main"): string {
	return JSON.stringify({
		version: 3,
		commitHash: hash,
		commitMessage: message,
		commitAuthor: "Alice",
		commitDate: "2026-01-15T10:00:00Z",
		branch,
		generatedAt: "2026-01-15T10:00:00Z",
		topics: [{ title: "Topic", trigger: "t", response: "r", decisions: "d" }],
		stats: { filesChanged: 2, insertions: 20, deletions: 5 },
	});
}

function makeIndex(entries: { commitHash: string; parentCommitHash?: string | null; branch?: string }[]): string {
	return JSON.stringify({
		version: 3,
		entries: entries.map((e) => ({
			commitHash: e.commitHash,
			parentCommitHash: e.parentCommitHash ?? null,
			commitMessage: "Test",
			commitDate: "2026-01-15T10:00:00Z",
			branch: e.branch ?? "main",
			generatedAt: "2026-01-15T10:00:00Z",
		})),
	});
}

function seedOrphan(
	orphan: InMemoryStorage,
	summaries: { hash: string; message?: string; branch?: string }[],
	extras?: {
		transcripts?: Record<string, string>;
		plans?: Record<string, string>;
		planProgress?: Record<string, string>;
		notes?: Record<string, string>;
	},
): void {
	const entries = summaries.map((s) => ({
		commitHash: s.hash,
		parentCommitHash: null,
		branch: s.branch ?? "main",
	}));
	orphan.writeFiles([{ path: "index.json", content: makeIndex(entries) }], "seed index");
	for (const s of summaries) {
		orphan.writeFiles(
			[{ path: `summaries/${s.hash}.json`, content: makeSummary(s.hash, s.message, s.branch) }],
			"seed summary",
		);
	}
	if (extras?.transcripts) {
		for (const [hash, content] of Object.entries(extras.transcripts)) {
			orphan.writeFiles([{ path: `transcripts/${hash}.json`, content }], "seed transcript");
		}
	}
	if (extras?.plans) {
		for (const [name, content] of Object.entries(extras.plans)) {
			orphan.writeFiles([{ path: `plans/${name}`, content }], "seed plan");
		}
	}
	if (extras?.planProgress) {
		for (const [name, content] of Object.entries(extras.planProgress)) {
			orphan.writeFiles([{ path: `plan-progress/${name}`, content }], "seed plan-progress");
		}
	}
	if (extras?.notes) {
		for (const [name, content] of Object.entries(extras.notes)) {
			orphan.writeFiles([{ path: `notes/${name}`, content }], "seed note");
		}
	}
}

describe("MigrationEngine", () => {
	let orphan: InMemoryStorage;
	let kbRoot: string;
	let metadataManager: MetadataManager;
	let folderStorage: FolderStorage;

	beforeEach(() => {
		orphan = new InMemoryStorage();
		kbRoot = makeTmpDir();
		metadataManager = new MetadataManager(join(kbRoot, ".jolli"));
		folderStorage = new FolderStorage(kbRoot, metadataManager);
	});

	afterEach(() => {
		rmrf(kbRoot);
	});

	function createEngine(): MigrationEngine {
		return new MigrationEngine(orphan, folderStorage, metadataManager);
	}

	describe("basic migration", () => {
		it("migrates single summary to markdown", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);

			const state = await createEngine().runMigration();
			expect(state.status).toBe("completed");
			expect(state.totalEntries).toBe(1);
			expect(state.migratedEntries).toBe(1);

			// Hidden JSON exists
			expect(await folderStorage.readFile("summaries/aaa11111aaa11111.json")).not.toBeNull();

			// Manifest has entry with title
			const manifest = metadataManager.readManifest();
			const commits = manifest.files.filter((f) => f.type === "commit");
			expect(commits).toHaveLength(1);
			expect(commits[0].path).toContain(".md");
			expect(commits[0].title).toBe("Test commit");
		});

		it("migrates multiple summaries", async () => {
			seedOrphan(orphan, [
				{ hash: "aaa11111aaa11111", message: "First" },
				{ hash: "bbb22222bbb22222", message: "Second" },
				{ hash: "ccc33333ccc33333", message: "Third", branch: "feature/test" },
			]);

			const state = await createEngine().runMigration();
			expect(state.status).toBe("completed");
			expect(state.migratedEntries).toBe(3);

			const commits = metadataManager.readManifest().files.filter((f) => f.type === "commit");
			expect(commits).toHaveLength(3);
		});

		it("migrates transcripts", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }], {
				transcripts: { aaa11111aaa11111: '{"sessions":[]}' },
			});

			await createEngine().runMigration();
			expect(await folderStorage.readFile("transcripts/aaa11111aaa11111.json")).toBe('{"sessions":[]}');
		});

		it("migrates plans", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }], {
				plans: { "my-plan.md": "# My Plan\n\nSteps..." },
			});

			await createEngine().runMigration();
			expect(await folderStorage.readFile("plans/my-plan.md")).toBe("# My Plan\n\nSteps...");
		});

		it("copies index to folder", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);

			await createEngine().runMigration();
			const indexJson = await folderStorage.readFile("index.json");
			expect(indexJson).not.toBeNull();
			expect(indexJson).toContain("aaa11111aaa11111");
		});
	});

	describe("idempotency", () => {
		it("running twice does not duplicate entries", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);

			const engine = createEngine();
			await engine.runMigration();
			await engine.runMigration();

			const commits = metadataManager.readManifest().files.filter((f) => f.type === "commit");
			expect(commits).toHaveLength(1);
		});

		it("tracks progress callbacks", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }, { hash: "bbb22222bbb22222" }]);

			const progress: [number, number][] = [];
			await createEngine().runMigration((m, t) => progress.push([m, t]));

			expect(progress).toHaveLength(2);
			expect(progress[0]).toEqual([1, 2]);
			expect(progress[1]).toEqual([2, 2]);
		});
	});

	describe("edge cases", () => {
		it("empty orphan branch", async () => {
			const state = await createEngine().runMigration();
			expect(state.status).toBe("completed");
			expect(state.totalEntries).toBe(0);
		});

		it("empty index", async () => {
			await orphan.writeFiles([{ path: "index.json", content: makeIndex([]) }], "empty");
			const state = await createEngine().runMigration();
			expect(state.status).toBe("completed");
			expect(state.totalEntries).toBe(0);
		});

		it("skips child entries — only migrates roots", async () => {
			const index = makeIndex([
				{ commitHash: "aaa11111aaa11111", parentCommitHash: null },
				{ commitHash: "bbb22222bbb22222", parentCommitHash: "aaa11111aaa11111" },
			]);
			await orphan.writeFiles([{ path: "index.json", content: index }], "seed");
			await orphan.writeFiles(
				[{ path: "summaries/aaa11111aaa11111.json", content: makeSummary("aaa11111aaa11111") }],
				"seed summary",
			);

			const state = await createEngine().runMigration();
			expect(state.totalEntries).toBe(1);
		});

		it("validates migration", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);
			await createEngine().runMigration();
			expect(await createEngine().validateMigration()).toBe(true);
		});
	});

	describe("plan-progress migration", () => {
		it("migrates plan-progress files", async () => {
			const progress = JSON.stringify({
				planSlug: "my-plan-aaa11111",
				totalSteps: 5,
				completedSteps: 3,
			});
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }], {
				planProgress: { "my-plan-aaa11111.json": progress },
			});

			await createEngine().runMigration();
			expect(await folderStorage.readFile("plan-progress/my-plan-aaa11111.json")).toBe(progress);
		});

		it("migrates multiple plan-progress files", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }], {
				planProgress: {
					"plan-a-aaa11111.json": '{"planSlug":"plan-a","totalSteps":3,"completedSteps":1}',
					"plan-b-aaa11111.json": '{"planSlug":"plan-b","totalSteps":7,"completedSteps":7}',
				},
			});

			await createEngine().runMigration();
			expect(await folderStorage.readFile("plan-progress/plan-a-aaa11111.json")).not.toBeNull();
			expect(await folderStorage.readFile("plan-progress/plan-b-aaa11111.json")).not.toBeNull();
		});

		it("handles empty plan-progress directory", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);

			const state = await createEngine().runMigration();
			expect(state.status).toBe("completed");
		});
	});

	describe("notes migration", () => {
		it("migrates note files", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }], {
				notes: { "note-1234-aaa11111.md": "# My Note\n\nContent" },
			});

			await createEngine().runMigration();
			expect(await folderStorage.readFile("notes/note-1234-aaa11111.md")).toBe("# My Note\n\nContent");
		});
	});

	describe("branch organization", () => {
		it("summaries organized by branch folder", async () => {
			seedOrphan(orphan, [
				{ hash: "aaa11111aaa11111", message: "Main commit", branch: "main" },
				{ hash: "bbb22222bbb22222", message: "Feature commit", branch: "feature/login" },
			]);

			await createEngine().runMigration();

			const { existsSync } = require("node:fs");
			expect(existsSync(join(kbRoot, "main"))).toBe(true);
			expect(existsSync(join(kbRoot, "feature-login"))).toBe(true);
		});
	});
});
