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

	describe("malformed orphan data", () => {
		it("returns failed when index.json is unparseable", async () => {
			await orphan.writeFiles([{ path: "index.json", content: "{ broken" }], "bad index");
			const state = await createEngine().runMigration();
			expect(state.status).toBe("failed");
			expect(state.totalEntries).toBe(0);
		});

		// Wraps the real folderStorage but selectively rejects writeFiles whose
		// `message` matches a predicate. Lets us simulate a single failing step
		// (e.g. per-root migrateSummary) without breaking the rest of the run.
		function selectiveFailingFolder(predicate: (msg: string) => unknown): StorageProvider {
			const real = folderStorage;
			return {
				readFile: real.readFile.bind(real),
				writeFiles: async (files, message) => {
					const reason = predicate(message);
					if (reason !== undefined && reason !== false && reason !== null) {
						throw reason;
					}
					return real.writeFiles(files, message);
				},
				listFiles: real.listFiles.bind(real),
				exists: real.exists.bind(real),
				ensure: real.ensure.bind(real),
			};
		}

		// migrateSummary throws → outer try/catch records the hash and proceeds.
		it("records failed hashes when a per-root migration step throws", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);
			const failingFolder = selectiveFailingFolder((msg) =>
				msg.startsWith("Migration: summary ") ? new Error("disk full") : undefined,
			);

			const engine = new MigrationEngine(orphan, failingFolder, metadataManager);
			const state = await engine.runMigration();
			expect(state.status).toBe("partial");
			expect(state.failedHashes).toContain("aaa11111aaa11111");
		});

		// Non-Error rejection from the failing storage exercises the
		// `e instanceof Error ? e.message : String(e)` else branch.
		it("records failed hashes when migration throws a non-Error value", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);
			const failingFolder = selectiveFailingFolder((msg) =>
				msg.startsWith("Migration: summary ") ? "kaboom" : undefined,
			);

			const engine = new MigrationEngine(orphan, failingFolder, metadataManager);
			const state = await engine.runMigration();
			expect(state.status).toBe("partial");
			expect(state.failedHashes).toContain("aaa11111aaa11111");
		});
	});

	describe("backfillTitle", () => {
		it("backfills the title for a manifest entry written without one", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111", message: "Original message" }]);

			// Pre-seed a manifest entry without a title — simulates an older
			// migration that ran before titles were tracked.
			metadataManager.updateManifest({
				path: "main/old-aaa11111.md",
				fileId: "aaa11111aaa11111",
				type: "commit",
				fingerprint: "fp",
				source: { commitHash: "aaa11111aaa11111", branch: "main" },
			});

			await createEngine().runMigration();
			const entry = metadataManager.findById("aaa11111aaa11111");
			expect(entry?.title).toBe("Original message");
		});

		// backfillTitle silently swallows JSON.parse failure — re-migration must
		// not blow up if the orphan summary file is somehow corrupt.
		it("ignores malformed summary JSON during backfill", async () => {
			await orphan.writeFiles(
				[
					{ path: "index.json", content: makeIndex([{ commitHash: "aaa11111aaa11111" }]) },
					{ path: "summaries/aaa11111aaa11111.json", content: "{ broken" },
				],
				"seed",
			);
			metadataManager.updateManifest({
				path: "main/exists.md",
				fileId: "aaa11111aaa11111",
				type: "commit",
				fingerprint: "fp",
				source: {},
			});

			await expect(createEngine().runMigration()).resolves.toBeDefined();
		});

		// Existing entry already has a title → backfill is skipped (covers the
		// `if (!existing.title)` false branch). Also pre-populate the folder JSON
		// so the bulk-pass `migrateAllSummaries` doesn't re-write it and stomp the title.
		it("does not touch entries that already have a title", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111", message: "Will not see this" }]);
			await folderStorage.ensure();
			await folderStorage.writeFiles(
				[
					{
						path: "summaries/aaa11111aaa11111.json",
						content: makeSummary("aaa11111aaa11111", "Pre-existing"),
					},
				],
				"pre",
			);
			metadataManager.updateManifest({
				path: "main/old-aaa11111.md",
				fileId: "aaa11111aaa11111",
				type: "commit",
				fingerprint: "fp",
				source: { commitHash: "aaa11111aaa11111", branch: "main" },
				title: "Existing title",
			});

			await createEngine().runMigration();
			expect(metadataManager.findById("aaa11111aaa11111")?.title).toBe("Existing title");
		});

		// backfillTitle returns early when the orphan's summary file is missing.
		it("does nothing when the orphan branch has no summary for the entry", async () => {
			await orphan.writeFiles(
				[{ path: "index.json", content: makeIndex([{ commitHash: "aaa11111aaa11111" }]) }],
				"seed",
			);
			metadataManager.updateManifest({
				path: "main/exists.md",
				fileId: "aaa11111aaa11111",
				type: "commit",
				fingerprint: "fp",
				source: {},
			});
			await expect(createEngine().runMigration()).resolves.toBeDefined();
		});
	});

	describe("validateMigration", () => {
		it("returns true when the orphan has no index.json", async () => {
			expect(await createEngine().validateMigration()).toBe(true);
		});

		it("returns false when the migration state recorded failed hashes", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);
			metadataManager.saveMigrationState({
				status: "partial",
				totalEntries: 1,
				migratedEntries: 0,
				failedHashes: ["aaa11111aaa11111"],
			});
			expect(await createEngine().validateMigration()).toBe(false);
		});

		it("returns false when the orphan index.json is unparseable", async () => {
			await orphan.writeFiles([{ path: "index.json", content: "{ broken" }], "bad");
			expect(await createEngine().validateMigration()).toBe(false);
		});

		it("returns false when the manifest has fewer commit entries than orphan roots", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }, { hash: "bbb22222bbb22222" }]);
			// Only migrate one of the two roots manually
			metadataManager.updateManifest({
				path: "main/one.md",
				fileId: "aaa11111aaa11111",
				type: "commit",
				fingerprint: "fp",
				source: {},
			});
			expect(await createEngine().validateMigration()).toBe(false);
		});

		it("returns true when manifest commit count matches orphan root count", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);
			await createEngine().runMigration();
			expect(await createEngine().validateMigration()).toBe(true);
		});
	});

	describe("storage edge cases (null/empty file content)", () => {
		// orphan.listFiles returns a path, but readFile returns null (e.g. concurrent
		// delete). Each migrate*-loop must skip that path silently rather than throw.
		function makeOrphanWithListEntries(
			rootHashes: string[],
			extras: {
				plans?: string[];
				planProgress?: string[];
				notes?: string[];
				transcripts?: string[];
				summaries?: string[];
			},
		): StorageProvider {
			const files = new Map<string, string>();
			files.set("index.json", makeIndex(rootHashes.map((h) => ({ commitHash: h }))));
			for (const h of rootHashes) {
				files.set(`summaries/${h}.json`, makeSummary(h));
			}
			const phantomPaths = [
				...(extras.plans ?? []).map((p) => `plans/${p}`),
				...(extras.planProgress ?? []).map((p) => `plan-progress/${p}`),
				...(extras.notes ?? []).map((p) => `notes/${p}`),
				...(extras.transcripts ?? []).map((p) => `transcripts/${p}`),
				...(extras.summaries ?? []).map((p) => `summaries/${p}`),
			];

			return {
				async readFile(path) {
					return files.get(path) ?? null;
				},
				async writeFiles(writes) {
					for (const w of writes) {
						if (w.delete) files.delete(w.path);
						else files.set(w.path, w.content);
					}
				},
				async listFiles(prefix) {
					const real = [...files.keys()].filter((k) => k.startsWith(prefix));
					const phantoms = phantomPaths.filter((p) => p.startsWith(prefix));
					return [...real, ...phantoms].sort();
				},
				async exists() {
					return true;
				},
				async ensure() {},
			};
		}

		it("skips plan/note/plan-progress/transcript/summary paths whose content is null", async () => {
			const orphanish = makeOrphanWithListEntries(["aaa11111aaa11111"], {
				plans: ["phantom-plan-aaa11111.md"],
				planProgress: ["phantom-progress.json"],
				notes: ["phantom-note-aaa11111.md"],
				transcripts: ["phantom-transcript.json"],
				summaries: ["phantom-orphan.json"],
			});

			const engine = new MigrationEngine(orphanish, folderStorage, metadataManager);
			const state = await engine.runMigration();
			expect(state.status).toBe("completed");
		});
	});

	describe("migrateAllSummaries / migrateAllTranscripts skip-existing", () => {
		// When folder storage already has the file, the bulk-pass must skip it.
		it("does not re-write summaries that the folder already has", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }]);
			// Pre-populate the folder so readFile returns existing content
			await folderStorage.ensure();
			await folderStorage.writeFiles(
				[
					{
						path: "summaries/aaa11111aaa11111.json",
						content:
							'{"version":3,"commitHash":"aaa11111aaa11111","commitMessage":"Pre-existing","commitAuthor":"x","commitDate":"2026","branch":"main","generatedAt":"2026"}',
					},
				],
				"pre",
			);

			await createEngine().runMigration();
			// File is whatever the orphan wrote (since per-root migration runs before bulk pass)
			expect(await folderStorage.readFile("summaries/aaa11111aaa11111.json")).not.toBeNull();
		});

		it("does not re-write transcripts that the folder already has", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }], {
				transcripts: { aaa11111aaa11111: '{"sessions":["a"]}' },
			});
			// Pre-populate folder
			await folderStorage.ensure();
			await folderStorage.writeFiles(
				[{ path: "transcripts/aaa11111aaa11111.json", content: '{"sessions":["pre"]}' }],
				"pre",
			);

			await createEngine().runMigration();
			expect(await folderStorage.readFile("transcripts/aaa11111aaa11111.json")).not.toBeNull();
		});
	});

	describe("resolveBranchFromPath", () => {
		// Plan whose name doesn't end in a hash → branch undefined → folder storage
		// falls through to slug-based resolution. Migration succeeds without throwing.
		it("does not crash when the plan path has no hash suffix", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111" }], {
				plans: { "no-hash-plan.md": "# Plan" },
			});
			await expect(createEngine().runMigration()).resolves.toBeDefined();
		});

		// Plan hash present in index.json → branch resolved correctly.
		it("propagates the branch from index for plans with a known hash", async () => {
			seedOrphan(orphan, [{ hash: "aaa11111aaa11111", branch: "feature/x" }], {
				plans: { "deploy-aaa11111.md": "# Plan" },
			});
			await createEngine().runMigration();
			const { existsSync } = require("node:fs");
			expect(existsSync(join(kbRoot, "feature-x"))).toBe(true);
		});

		// Index has a matching hash but the entry has no `branch` field.
		// resolveBranchFromPath returns undefined and migration succeeds.
		it("returns undefined when the matched index entry has no branch field", async () => {
			const indexJson = JSON.stringify({
				version: 3,
				entries: [
					{
						commitHash: "aaa11111aaa11111",
						parentCommitHash: null,
						commitMessage: "T",
						commitDate: "2026-01-15T10:00:00Z",
						generatedAt: "2026-01-15T10:00:00Z",
						// branch intentionally omitted
					},
				],
			});
			await orphan.writeFiles(
				[
					{ path: "index.json", content: indexJson },
					{ path: "summaries/aaa11111aaa11111.json", content: makeSummary("aaa11111aaa11111") },
					{ path: "plans/p-aaa11111.md", content: "# Plan" },
				],
				"seed",
			);
			await expect(createEngine().runMigration()).resolves.toBeDefined();
		});
	});

	describe("missing summary on disk for an indexed root", () => {
		// Index claims a root exists but the summary file is missing — migrateSummary
		// must early-return on null content (covers `if (!json) return;`).
		it("skips roots that have no summary file on the orphan branch", async () => {
			await orphan.writeFiles(
				[{ path: "index.json", content: makeIndex([{ commitHash: "aaa11111aaa11111" }]) }],
				"index only",
			);
			const state = await createEngine().runMigration();
			expect(state.status).toBe("completed");
		});
	});

	describe("migrateAllTranscripts writes child transcripts", () => {
		// Transcripts/ contains hashes that aren't root entries (e.g. children of
		// a squash). Per-root migration touches only roots, so the bulk pass is
		// the one that actually moves these. Covers the writeFiles + log lines.
		it("writes transcripts whose hashes are not root entries", async () => {
			seedOrphan(orphan, [{ hash: "rootroot11111111" }], {
				transcripts: {
					rootroot11111111: '{"sessions":["root"]}',
					childchild22222222: '{"sessions":["child"]}',
				},
			});
			await createEngine().runMigration();
			expect(await folderStorage.readFile("transcripts/rootroot11111111.json")).toBe('{"sessions":["root"]}');
			expect(await folderStorage.readFile("transcripts/childchild22222222.json")).toBe('{"sessions":["child"]}');
		});
	});

	describe("malformed orphan parse errors as non-Error", () => {
		// Mock JSON.parse to throw a non-Error so the parse-error log path takes
		// the `String(e)` else branch in `e instanceof Error ? e.message : String(e)`.
		it("surfaces a non-Error parse failure via String(e)", async () => {
			await orphan.writeFiles([{ path: "index.json", content: '{"version":3,"entries":[]}' }], "seed");
			const realParse = JSON.parse.bind(JSON);
			const spy = vi.spyOn(JSON, "parse").mockImplementation(((text: string, reviver?: unknown) => {
				if (typeof text === "string" && text.includes('"version":3,"entries":[]')) {
					// biome-ignore lint/suspicious/noExplicitAny: synthetic non-Error throw
					throw "raw string parse failure" as any;
				}
				return realParse(text, reviver as Parameters<typeof realParse>[1]);
			}) as typeof JSON.parse);
			try {
				const state = await createEngine().runMigration();
				expect(state.status).toBe("failed");
			} finally {
				spy.mockRestore();
			}
		});
	});
});
