import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock GitOps
vi.mock("./GitOps.js", () => ({
	readFileFromBranch: vi.fn(),
	writeFileToBranch: vi.fn(),
	writeMultipleFilesToBranch: vi.fn(),
	listFilesInBranch: vi.fn(),
	orphanBranchExists: vi.fn(),
	execGit: vi.fn(),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import type { CommitSummary, FileWrite, LegacyCommitSummary } from "../Types.js";
import {
	execGit,
	listFilesInBranch,
	orphanBranchExists,
	readFileFromBranch,
	writeFileToBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";
import {
	cleanupV1IfExpired,
	deleteV1Branch,
	hasMigrationMeta,
	hasV1Branch,
	migrateV1toV3,
	writeMigrationMeta,
} from "./SummaryMigration.js";

/** Creates a minimal mock CommitSummary in tree format (leaf node). */
function createMockSummary(hash = "abc123def456", message = "Fix bug"): CommitSummary {
	return {
		version: 3,
		commitHash: hash,
		commitMessage: message,
		commitAuthor: "John",
		commitDate: "2026-02-19T10:00:00Z",
		branch: "main",
		generatedAt: "2026-02-19T10:00:05Z",
		transcriptEntries: 5,
		stats: { filesChanged: 2, insertions: 10, deletions: 5 },
		topics: [{ title: "Fix authentication", trigger: "Bug", response: "Fixed it", decisions: "Use JWT" }],
	};
}

describe("SummaryMigration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("migrateV1toV3", () => {
		it("should return zero counts when v1 branch does not exist", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(false);

			const result = await migrateV1toV3();
			expect(result).toEqual({ migrated: 0, skipped: 0 });
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should migrate single-record legacy summary to leaf node", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/abc123.json"]);

			const legacy: LegacyCommitSummary = {
				version: 3,
				commitHash: "abc123",
				commitMessage: "Fix bug",
				commitAuthor: "John",
				commitDate: "2026-02-19T10:00:00Z",
				branch: "main",
				generatedAt: "2026-02-19T10:00:05Z",
				records: [
					{
						commitHash: "abc123",
						commitMessage: "Fix bug",
						commitDate: "2026-02-19T10:00:00Z",
						transcriptEntries: 5,
						conversationTurns: 3,
						llm: {
							model: "claude-haiku",
							inputTokens: 100,
							outputTokens: 50,
							apiLatencyMs: 1200,
							stopReason: "end_turn",
						},
						stats: { filesChanged: 2, insertions: 10, deletions: 5 },
						topics: [{ title: "Fix login", trigger: "Bug", response: "Fixed it", decisions: "Simple fix" }],
					},
				],
			};
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(legacy)) // summary file
				.mockResolvedValueOnce(JSON.stringify({ version: 1, entries: [] })); // index

			const result = await migrateV1toV3();

			expect(result.migrated).toBe(1);
			expect(result.skipped).toBe(0);
			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;
			expect(migrated.version).toBe(3);
			// Promoted to top level: no children
			expect(migrated.children).toBeUndefined();
			expect(migrated.topics).toHaveLength(1);
			expect(migrated.topics?.[0].title).toBe("Fix login");
			expect(migrated.transcriptEntries).toBe(5);
			expect(migrated.conversationTurns).toBe(3);
			expect(migrated.llm?.model).toBe("claude-haiku");
			expect(migrated.stats?.filesChanged).toBe(2);
		});

		it("should migrate multi-record legacy summary to pure container with children", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/squash999.json"]);

			const legacy: LegacyCommitSummary = {
				version: 3,
				commitHash: "squash999",
				commitMessage: "Squashed",
				commitAuthor: "John",
				commitDate: "2026-02-20T10:00:00Z",
				branch: "main",
				generatedAt: "2026-02-20T10:00:05Z",
				records: [
					{
						commitHash: "src1",
						commitMessage: "Feature A",
						commitDate: "2026-02-18T10:00:00Z",
						transcriptEntries: 3,
						stats: { filesChanged: 2, insertions: 10, deletions: 5 },
						topics: [{ title: "Dark mode", trigger: "Request", response: "Done", decisions: "CSS vars" }],
					},
					{
						commitHash: "src2",
						commitMessage: "Feature B",
						commitDate: "2026-02-19T10:00:00Z",
						transcriptEntries: 4,
						stats: { filesChanged: 3, insertions: 20, deletions: 8 },
						topics: [
							{ title: "Auth fix", trigger: "Bug", response: "Fixed", decisions: "httpOnly" },
							{ title: "Logging", trigger: "Debug", response: "Added", decisions: "JSON" },
						],
					},
				],
			};
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(legacy))
				.mockResolvedValueOnce(JSON.stringify({ version: 1, entries: [] }));

			const result = await migrateV1toV3();

			expect(result.migrated).toBe(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;

			// Pure container at top
			expect(migrated.topics).toBeUndefined();
			expect(migrated.stats).toBeUndefined();
			expect(migrated.llm).toBeUndefined();

			// Children sorted by commitDate desc: src2 (Feb 19) first, then src1 (Feb 18)
			expect(migrated.children).toHaveLength(2);
			expect(migrated.children?.[0].commitHash).toBe("src2");
			expect(migrated.children?.[0].topics).toHaveLength(2);
			expect(migrated.children?.[1].commitHash).toBe("src1");
			expect(migrated.children?.[1].topics).toHaveLength(1);
		});

		it("should skip already-tree-format summaries (no records array)", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/abc123.json"]);

			const treeSummary = createMockSummary("abc123");
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(treeSummary))
				.mockResolvedValueOnce(JSON.stringify({ version: 1, entries: [] }));

			const result = await migrateV1toV3();

			expect(result.migrated).toBe(0);
			expect(result.skipped).toBe(1);
		});

		it("should skip unparseable files", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/bad.json"]);

			vi.mocked(readFileFromBranch).mockResolvedValueOnce("not valid json").mockResolvedValueOnce(null); // no index

			const result = await migrateV1toV3();
			expect(result.migrated).toBe(0);
			expect(result.skipped).toBe(1);
		});

		it("should skip files where readFileFromBranch returns null", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/missing.json"]);

			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // missing summary
				.mockResolvedValueOnce(null); // no index

			const result = await migrateV1toV3();
			expect(result.migrated).toBe(0);
			expect(result.skipped).toBe(0);
		});

		it("should rebuild index keeping only entries with written summary files", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/abc123.json"]);

			const treeSummary = createMockSummary("abc123");
			const v1Index = {
				version: 1,
				entries: [
					{ commitHash: "abc123", commitMessage: "m", commitDate: "d", branch: "b", generatedAt: "g" },
					{ commitHash: "orphan999", commitMessage: "m", commitDate: "d", branch: "b", generatedAt: "g" },
				],
			};
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(treeSummary)) // summary (tree format, skipped)
				.mockResolvedValueOnce(JSON.stringify(v1Index)); // index

			await migrateV1toV3();

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const indexFile = files.find((f) => f.path === "index.json");
			expect(indexFile).toBeDefined();
			const parsed = JSON.parse(indexFile?.content ?? "{}");
			// Only abc123 should remain; orphan999 has no summary file written
			expect(parsed.entries).toHaveLength(1);
			expect(parsed.entries[0].commitHash).toBe("abc123");
		});

		it("should exclude index entries for unparseable summary files", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/good.json", "summaries/bad.json"]);

			const legacy: LegacyCommitSummary = {
				version: 3,
				commitHash: "good",
				commitMessage: "msg",
				commitAuthor: "John",
				commitDate: "2026-02-19T10:00:00Z",
				branch: "main",
				generatedAt: "2026-02-19T10:00:05Z",
				records: [
					{
						commitHash: "good",
						commitMessage: "msg",
						commitDate: "2026-02-19T10:00:00Z",
						transcriptEntries: 1,
						stats: { filesChanged: 1, insertions: 1, deletions: 0 },
						topics: [{ title: "T", trigger: "t", response: "r", decisions: "d" }],
					},
				],
			};
			const v1Index = {
				version: 1,
				entries: [
					{ commitHash: "good", commitMessage: "m", commitDate: "d", branch: "b", generatedAt: "g" },
					{ commitHash: "bad", commitMessage: "m", commitDate: "d", branch: "b", generatedAt: "g" },
				],
			};
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(legacy)) // good.json
				.mockResolvedValueOnce("not valid json") // bad.json
				.mockResolvedValueOnce(JSON.stringify(v1Index)); // index

			const result = await migrateV1toV3();
			expect(result.migrated).toBe(1);
			expect(result.skipped).toBe(1);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const indexFile = files.find((f) => f.path === "index.json");
			const parsed = JSON.parse(indexFile?.content ?? "{}");
			// Only "good" should be in the rebuilt index; "bad" was unparseable
			expect(parsed.entries).toHaveLength(1);
			expect(parsed.entries[0].commitHash).toBe("good");
		});

		it("should skip rebuilding the index when the legacy index file is malformed", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce([]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("not valid json");

			const result = await migrateV1toV3();

			expect(result).toEqual({ migrated: 0, skipped: 0 });
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should queue migration even when the parsed summary is missing commitHash", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/abc.json"]);
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(
					JSON.stringify({
						version: 3,
						commitMessage: "msg",
						commitAuthor: "John",
						commitDate: "2026-02-19T10:00:00Z",
						branch: "main",
						generatedAt: "2026-02-19T10:00:05Z",
						records: [
							{
								commitHash: "abc",
								commitMessage: "msg",
								commitDate: "2026-02-19T10:00:00Z",
								transcriptEntries: 1,
								stats: { filesChanged: 1, insertions: 1, deletions: 0 },
								topics: [{ title: "T", trigger: "t", response: "r", decisions: "d" }],
							},
						],
					}),
				)
				.mockResolvedValueOnce(null);

			const result = await migrateV1toV3();

			expect(result).toEqual({ migrated: 1, skipped: 0 });
			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
		});

		it("should migrate jolliArticleUrl to jolliDocUrl during migration", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/abc.json"]);

			const legacy: LegacyCommitSummary = {
				version: 3,
				commitHash: "abc",
				commitMessage: "msg",
				commitAuthor: "John",
				commitDate: "2026-02-19T10:00:00Z",
				branch: "main",
				generatedAt: "2026-02-19T10:00:05Z",
				jolliArticleUrl: "https://team.jolli.app/articles/123",
				records: [
					{
						commitHash: "abc",
						commitMessage: "msg",
						commitDate: "2026-02-19T10:00:00Z",
						transcriptEntries: 1,
						stats: { filesChanged: 1, insertions: 1, deletions: 0 },
						topics: [{ title: "T", trigger: "t", response: "r", decisions: "d" }],
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(legacy)).mockResolvedValueOnce(null);

			await migrateV1toV3();

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;
			expect(migrated.jolliDocUrl).toBe("https://team.jolli.app/articles/123");
		});

		it("should migrate jolliArticleUrl to jolliDocUrl for multi-record summaries", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/abc.json"]);

			const legacy: LegacyCommitSummary = {
				version: 3,
				commitHash: "abc",
				commitMessage: "msg",
				commitAuthor: "John",
				commitDate: "2026-02-19T10:00:00Z",
				branch: "main",
				generatedAt: "2026-02-19T10:00:05Z",
				jolliArticleUrl: "https://team.jolli.app/articles/123",
				records: [
					{
						commitHash: "old-1",
						commitMessage: "msg 1",
						commitDate: "2026-02-19T09:00:00Z",
						transcriptEntries: 1,
						stats: { filesChanged: 1, insertions: 1, deletions: 0 },
						topics: [{ title: "T1", trigger: "t", response: "r", decisions: "d" }],
					},
					{
						commitHash: "old-2",
						commitMessage: "msg 2",
						commitDate: "2026-02-19T11:00:00Z",
						transcriptEntries: 2,
						stats: { filesChanged: 2, insertions: 2, deletions: 0 },
						topics: [{ title: "T2", trigger: "t", response: "r", decisions: "d" }],
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(legacy)).mockResolvedValueOnce(null);

			await migrateV1toV3();

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;
			expect(migrated.jolliDocUrl).toBe("https://team.jolli.app/articles/123");
			expect(migrated.children).toHaveLength(2);
		});

		it("should preserve commitType, commitSource, conversationTurns, and llm in single-record migration", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/abc.json"]);

			const legacy: LegacyCommitSummary = {
				version: 3,
				commitHash: "abc",
				commitMessage: "msg",
				commitAuthor: "John",
				commitDate: "2026-02-19T10:00:00Z",
				branch: "main",
				generatedAt: "2026-02-19T10:00:05Z",
				commitType: "squash",
				commitSource: "cli",
				records: [
					{
						commitHash: "abc",
						commitMessage: "msg",
						commitDate: "2026-02-19T10:00:00Z",
						transcriptEntries: 1,
						conversationTurns: 5,
						llm: {
							model: "claude",
							inputTokens: 100,
							outputTokens: 50,
							apiLatencyMs: 1000,
							stopReason: "end_turn",
						},
						stats: { filesChanged: 1, insertions: 1, deletions: 0 },
						topics: [{ title: "T", trigger: "t", response: "r", decisions: "d" }],
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(legacy)).mockResolvedValueOnce(null);

			await migrateV1toV3();

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;
			expect(migrated.commitType).toBe("squash");
			expect(migrated.commitSource).toBe("cli");
			expect(migrated.conversationTurns).toBe(5);
			expect(migrated.llm?.model).toBe("claude");
		});

		it("should preserve commitType/commitSource and conversationTurns/llm in multi-record migration children", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/multi.json"]);

			const legacy: LegacyCommitSummary = {
				version: 3,
				commitHash: "multi",
				commitMessage: "Squashed",
				commitAuthor: "John",
				commitDate: "2026-02-20T10:00:00Z",
				branch: "main",
				generatedAt: "2026-02-20T10:00:05Z",
				commitType: "squash",
				commitSource: "plugin",
				records: [
					{
						commitHash: "child1",
						commitMessage: "First",
						commitDate: "2026-02-18T10:00:00Z",
						transcriptEntries: 2,
						conversationTurns: 3,
						llm: {
							model: "claude",
							inputTokens: 50,
							outputTokens: 25,
							apiLatencyMs: 500,
							stopReason: "end_turn",
						},
						stats: { filesChanged: 1, insertions: 5, deletions: 2 },
						topics: [{ title: "A", trigger: "a", response: "a", decisions: "a" }],
					},
					{
						commitHash: "child2",
						commitMessage: "Second",
						commitDate: "2026-02-19T10:00:00Z",
						transcriptEntries: 3,
						stats: { filesChanged: 2, insertions: 10, deletions: 5 },
						topics: [{ title: "B", trigger: "b", response: "b", decisions: "b" }],
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(legacy)).mockResolvedValueOnce(null);

			await migrateV1toV3();

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;
			// Top-level container preserves commitType/commitSource
			expect(migrated.commitType).toBe("squash");
			expect(migrated.commitSource).toBe("plugin");
			// Children preserve conversationTurns and llm from records
			const child1 = migrated.children?.find((c) => c.commitHash === "child1");
			expect(child1?.conversationTurns).toBe(3);
			expect(child1?.llm?.model).toBe("claude");
			// child2 has no conversationTurns/llm
			const child2 = migrated.children?.find((c) => c.commitHash === "child2");
			expect(child2?.conversationTurns).toBeUndefined();
			expect(child2?.llm).toBeUndefined();
		});
	});

	describe("hasV1Branch / deleteV1Branch", () => {
		it("hasV1Branch should return true when v1 exists", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			expect(await hasV1Branch()).toBe(true);
		});

		it("hasV1Branch should return false when v1 does not exist", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(false);
			expect(await hasV1Branch()).toBe(false);
		});

		it("deleteV1Branch should call update-ref -d when v1 exists", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(execGit).mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			await deleteV1Branch();

			expect(execGit).toHaveBeenCalledWith(
				["update-ref", "-d", "refs/heads/jollimemory/summaries/v1"],
				undefined,
			);
		});

		it("deleteV1Branch should skip when v1 does not exist", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(false);
			await deleteV1Branch();
			expect(execGit).not.toHaveBeenCalled();
		});
	});

	describe("hasMigrationMeta", () => {
		it("should return true when migration-meta.json exists", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce('{"v1MigratedAt":"2026-01-01T00:00:00.000Z"}');
			const result = await hasMigrationMeta();
			expect(result).toBe(true);
			expect(readFileFromBranch).toHaveBeenCalledWith(
				"jollimemory/summaries/v3",
				"migration-meta.json",
				undefined,
			);
		});

		it("should return false when migration-meta.json does not exist", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const result = await hasMigrationMeta();
			expect(result).toBe(false);
		});
	});

	describe("writeMigrationMeta", () => {
		it("should write migration-meta.json with current timestamp", async () => {
			await writeMigrationMeta();

			expect(writeFileToBranch).toHaveBeenCalledTimes(1);
			const [branch, filePath, content] = vi.mocked(writeFileToBranch).mock.calls[0];
			expect(branch).toBe("jollimemory/summaries/v3");
			expect(filePath).toBe("migration-meta.json");
			const parsed = JSON.parse(content);
			expect(parsed.v1MigratedAt).toBeDefined();
			// Timestamp should be a valid ISO date within the last few seconds
			const diff = Date.now() - new Date(parsed.v1MigratedAt).getTime();
			expect(diff).toBeLessThan(5000);
		});
	});

	describe("cleanupV1IfExpired", () => {
		it("should skip when v1 branch does not exist", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(false);
			await cleanupV1IfExpired();
			expect(readFileFromBranch).not.toHaveBeenCalled();
		});

		it("should skip when migration-meta.json is missing", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true); // v1 exists
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // no meta
			await cleanupV1IfExpired();
			expect(execGit).not.toHaveBeenCalled();
		});

		it("should skip when migration-meta.json is unparseable", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("bad json");
			await cleanupV1IfExpired();
			expect(execGit).not.toHaveBeenCalled();
		});

		it("should retain v1 branch when less than 48 hours since migration", async () => {
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			const recentMeta = JSON.stringify({ v1MigratedAt: new Date().toISOString() });
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(recentMeta);
			await cleanupV1IfExpired();
			expect(execGit).not.toHaveBeenCalled();
		});

		it("should delete v1 branch when more than 48 hours since migration", async () => {
			// First call: cleanupV1IfExpired checks v1 exists
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			const oldDate = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify({ v1MigratedAt: oldDate }));
			// Second call: deleteV1Branch checks v1 exists
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(true);
			vi.mocked(execGit).mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

			await cleanupV1IfExpired();

			expect(execGit).toHaveBeenCalledWith(
				["update-ref", "-d", "refs/heads/jollimemory/summaries/v1"],
				undefined,
			);
		});
	});
});
