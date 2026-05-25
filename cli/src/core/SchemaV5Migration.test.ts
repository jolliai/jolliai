import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./GitOps.js", () => ({
	readFileFromBranch: vi.fn(),
	// Bulk read of summary contents during migration. Tests feed per-path
	// content via `Map`-shaped return values; the default empty Map is a safe
	// fallback for tests that mock listFilesInBranch with no summaries.
	batchReadFilesFromBranch: vi.fn().mockResolvedValue(new Map()),
	listFilesInBranch: vi.fn(),
	// Migration entry guard: default to "branch exists" so existing tests
	// that exercise the happy path don't need to set this. The fresh-install
	// case (no orphan branch yet) overrides this per-test.
	orphanBranchExists: vi.fn().mockResolvedValue(true),
	// Pre-migration SHA capture for debug-log recovery anchor (Feedback 2).
	// Tests don't assert on this — a benign stub is enough.
	execGit: vi.fn().mockResolvedValue({ stdout: "deadbeef0000000000000000000000000000beef\n", stderr: "" }),
}));

// Mock the StorageFactory so migration writes are observed via a single
// `writeFiles` spy. In production this returns a DualWriteStorage that fans
// out to both the orphan branch and the Memory Bank folder; here we just
// capture the call args so tests can assert on what would have been written.
const { mockStorageWriteFiles } = vi.hoisted(() => ({
	mockStorageWriteFiles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./StorageFactory.js", () => ({
	createStorage: vi.fn().mockResolvedValue({
		writeFiles: mockStorageWriteFiles,
	}),
}));

vi.mock("./Locks.js", () => ({
	acquireOrphanWriteLock: vi.fn().mockResolvedValue(true),
	releaseOrphanWriteLock: vi.fn().mockResolvedValue(undefined),
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import type { CommitSummary, FileWrite } from "../Types.js";
import { batchReadFilesFromBranch, listFilesInBranch, orphanBranchExists, readFileFromBranch } from "./GitOps.js";
import { __test__, migrateSchemaToV5, readSchemaV5State } from "./SchemaV5Migration.js";

const baseNode = {
	commitHash: "abc1234567890",
	commitMessage: "x",
	commitAuthor: "tester",
	commitDate: "2026-05-21T00:00:00Z",
	branch: "main",
	generatedAt: "2026-05-21T00:01:00Z",
} as const;

describe("SchemaV5Migration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ─── upgradeOneSummary (pure unit) ────────────────────────────────────────
	describe("upgradeOneSummary", () => {
		it("returns the input reference unchanged for v5 input (idempotent)", () => {
			const v5: CommitSummary = {
				...baseNode,
				version: 5,
				topics: [],
				transcripts: ["uuid-1"],
			} as CommitSummary;
			expect(__test__.upgradeOneSummary(v5, new Set(["uuid-1"]))).toBe(v5);
		});

		it("upgrades v4 leaf to v5 with transcripts populated when file exists", () => {
			const v4: CommitSummary = {
				...baseNode,
				version: 4,
				topics: [],
			} as CommitSummary;
			const upgraded = __test__.upgradeOneSummary(v4, new Set([baseNode.commitHash]));
			expect(upgraded.version).toBe(5);
			expect(upgraded.transcripts).toEqual([baseNode.commitHash]);
		});

		it("upgrades v4 leaf to v5 with empty transcripts array when no file exists for the hash", () => {
			// v5 contract: `transcripts` is ALWAYS present on a v5 root, even if
			// the migration found no matching files. Empty array is the right
			// signal for "no AI sessions captured" — distinct from "undefined"
			// which the read path treats as v3/v4 fallback territory.
			const v4: CommitSummary = {
				...baseNode,
				version: 4,
				topics: [],
			} as CommitSummary;
			const upgraded = __test__.upgradeOneSummary(v4, new Set([]));
			expect(upgraded.version).toBe(5);
			expect(upgraded.transcripts).toEqual([]);
		});

		it("idempotently preserves an existing v4 root's transcripts array (v5-aware writer pre-migration)", () => {
			// Critical data-loss regression guard: post-Step-3, the live write
			// paths stamp `version: 5 + transcripts: [uuid-1, uuid-2]` on new
			// roots, but if `migrateSchemaToV5` runs against a project where
			// a (rare) v4 root still carries a v5-shaped transcripts array
			// (e.g. a stale file from a partial earlier rollout), the upgrade
			// must NOT recompute `transcripts` via `collectAllTranscriptHashes`
			// — that would silently replace the UUID list with children commit
			// hashes (and the file-existence filter then drops them all,
			// yielding an empty transcripts array). Preserve verbatim.
			const v4WithV5Transcripts: CommitSummary = {
				...baseNode,
				version: 4,
				topics: [],
				transcripts: ["uuid-1", "uuid-2"],
			} as CommitSummary;
			const upgraded = __test__.upgradeOneSummary(
				v4WithV5Transcripts,
				// Pretend the UUID files don't exist on disk — verifies we don't
				// run them through the existence filter at all.
				new Set([baseNode.commitHash]),
			);
			expect(upgraded.version).toBe(5);
			expect(upgraded.transcripts).toEqual(["uuid-1", "uuid-2"]);
		});

		it("upgrades v3 squash root to v5 with topics preserved and transcripts from children", () => {
			// Lossless normalize semantics: v3 squash root's topics live on
			// children, normalizeToV4 hoists them; this migration carries them
			// through to v5 without an LLM call.
			const v3Squash: CommitSummary = {
				...baseNode,
				version: 3,
				topics: [],
				children: [
					{
						...baseNode,
						commitHash: "child-1",
						version: 3,
						topics: [{ title: "Topic 1", trigger: "t", response: "r", decisions: "d" }],
					} as CommitSummary,
					{
						...baseNode,
						commitHash: "child-2",
						version: 3,
						topics: [{ title: "Topic 2", trigger: "t", response: "r", decisions: "d" }],
					} as CommitSummary,
				],
			} as CommitSummary;
			const upgraded = __test__.upgradeOneSummary(v3Squash, new Set([baseNode.commitHash, "child-1", "child-2"]));
			expect(upgraded.version).toBe(5);
			expect(upgraded.topics).toHaveLength(2);
			expect(upgraded.transcripts).toEqual([baseNode.commitHash, "child-1", "child-2"]);
		});

		it("filters out hashes that have no transcript file on disk", () => {
			// Common case: a commit had no AI session so no transcript was ever
			// written for that hash. The migration must NOT list it in transcripts
			// or the read path will get null and surface "missing transcript".
			const v4Squash: CommitSummary = {
				...baseNode,
				version: 4,
				topics: [],
				children: [
					{ ...baseNode, commitHash: "has-file", version: 4 } as CommitSummary,
					{ ...baseNode, commitHash: "no-file", version: 4 } as CommitSummary,
				],
			} as CommitSummary;
			const upgraded = __test__.upgradeOneSummary(v4Squash, new Set(["has-file"]));
			expect(upgraded.transcripts).toEqual(["has-file"]);
		});

		it("migrates v3 legacy `stats` to `diffStats` via normalizeToV4", () => {
			const v3WithStats: CommitSummary = {
				...baseNode,
				version: 3,
				stats: { filesChanged: 4, insertions: 8, deletions: 1 },
			} as CommitSummary;
			const upgraded = __test__.upgradeOneSummary(v3WithStats, new Set([baseNode.commitHash]));
			expect(upgraded.diffStats).toEqual({ filesChanged: 4, insertions: 8, deletions: 1 });
		});
	});

	// ─── migrateSchemaToV5 (integration with GitOps mocks) ────────────────────
	describe("migrateSchemaToV5 (integration)", () => {
		it("returns a no-op fresh result when the orphan branch does not exist yet", async () => {
			// Fresh install: no jollimemory data, no orphan branch. Migration
			// must not create the branch as a side effect.
			vi.mocked(orphanBranchExists).mockResolvedValueOnce(false);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // state read

			const result = await migrateSchemaToV5();

			expect(result.fresh).toBe(true);
			expect(result.alreadyDone).toBe(false);
			expect(result.migrated).toBe(0);
			expect(mockStorageWriteFiles).not.toHaveBeenCalled();
			expect(listFilesInBranch).not.toHaveBeenCalled();
		});

		it("writes a fresh-install state when the orphan branch has no summaries", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValue(null); // state, index reads
			vi.mocked(listFilesInBranch)
				.mockResolvedValueOnce([]) // summaries/
				.mockResolvedValueOnce([]); // transcripts/

			const result = await migrateSchemaToV5();

			expect(result.fresh).toBe(true);
			expect(result.alreadyDone).toBe(false);
			expect(result.migrated).toBe(0);

			const writeCall = mockStorageWriteFiles.mock.calls[0];
			expect(writeCall).toBeDefined();
			const files = writeCall?.[0] as ReadonlyArray<FileWrite>;
			expect(files).toHaveLength(1);
			expect(files[0]?.path).toBe(__test__.SCHEMA_V5_STATE_FILE);
			const state = JSON.parse(files[0]?.content ?? "{}");
			expect(state.status).toBe("completed");
			expect(state.fresh).toBe(true);
		});

		it("skips when state already shows completed", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(
				JSON.stringify({
					version: 1,
					status: "completed",
					startedAt: "2026-05-22T00:00:00Z",
					completedAt: "2026-05-22T00:00:05Z",
					migratedCount: 3,
					skippedCount: 1,
					fresh: false,
				}),
			);

			const result = await migrateSchemaToV5();

			expect(result.alreadyDone).toBe(true);
			expect(result.migrated).toBe(3);
			expect(result.skipped).toBe(1);
			expect(mockStorageWriteFiles).not.toHaveBeenCalled();
		});

		it("upgrades v3 and v4 summaries to v5 in one atomic commit", async () => {
			const v3: CommitSummary = {
				...baseNode,
				commitHash: "v3-hash",
				version: 3,
				topics: [{ title: "T1", trigger: "t", response: "r", decisions: "d" }],
			} as CommitSummary;
			const v4: CommitSummary = {
				...baseNode,
				commitHash: "v4-hash",
				version: 4,
				topics: [{ title: "T2", trigger: "t", response: "r", decisions: "d" }],
			} as CommitSummary;

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // state read (readSchemaV5State)
			vi.mocked(listFilesInBranch)
				.mockResolvedValueOnce(["summaries/v3-hash.json", "summaries/v4-hash.json"])
				.mockResolvedValueOnce(["transcripts/v3-hash.json", "transcripts/v4-hash.json"]);
			// Summary contents now flow through the batched cat-file reader,
			// not per-file readFileFromBranch. One mock call serves all paths
			// for the migration's read phase.
			vi.mocked(batchReadFilesFromBranch).mockResolvedValueOnce(
				new Map([
					["summaries/v3-hash.json", JSON.stringify(v3)],
					["summaries/v4-hash.json", JSON.stringify(v4)],
				]),
			);

			const result = await migrateSchemaToV5();

			expect(result.migrated).toBe(2);
			expect(result.skipped).toBe(0);
			expect(result.fresh).toBe(false);

			const files = mockStorageWriteFiles.mock.calls[0]?.[0] as ReadonlyArray<FileWrite>;
			expect(files.length).toBe(3); // 2 summaries + 1 state file
			// All summaries are written at version=5.
			const summaryFiles = files.filter((f) => f.path.startsWith("summaries/"));
			for (const f of summaryFiles) {
				const parsed = JSON.parse(f.content);
				expect(parsed.version).toBe(5);
				expect(parsed.transcripts).toBeDefined();
			}
		});

		it("skips v5 summaries already present without rewriting them", async () => {
			const v5Already: CommitSummary = {
				...baseNode,
				commitHash: "v5-hash",
				version: 5,
				topics: [],
				transcripts: ["uuid-existing"],
			} as CommitSummary;

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // state read
			vi.mocked(listFilesInBranch)
				.mockResolvedValueOnce(["summaries/v5-hash.json"])
				.mockResolvedValueOnce(["transcripts/uuid-existing.json"]);
			vi.mocked(batchReadFilesFromBranch).mockResolvedValueOnce(
				new Map([["summaries/v5-hash.json", JSON.stringify(v5Already)]]),
			);

			const result = await migrateSchemaToV5();

			expect(result.skipped).toBe(1);
			expect(result.migrated).toBe(0);

			const files = mockStorageWriteFiles.mock.calls[0]?.[0] as ReadonlyArray<FileWrite>;
			// Only the state file should be written — the v5 summary is untouched.
			expect(files.length).toBe(1);
			expect(files[0]?.path).toBe(__test__.SCHEMA_V5_STATE_FILE);
		});

		it("routes the migration write through createStorage so dual-write fans out to orphan + shadow", async () => {
			// Regression guard for the v4-stuck-in-shadow bug: the earlier
			// implementation called `writeMultipleFilesToBranch` directly, so
			// dual-write users saw the orphan branch upgraded to v5 while the
			// `<localFolder>/<repo>/.jolli/summaries/*.json` shadow files kept
			// `"version": 4` until normal post-commit traffic eventually
			// rewrote each one. Routing through `createStorage()` gives the
			// active `StorageProvider` (DualWriteStorage in dual-write mode) a
			// chance to fan the v5 payload out to both backends in one pass.
			const { createStorage } = await import("./StorageFactory.js");

			const v4: CommitSummary = {
				...baseNode,
				commitHash: "shadow-hash",
				version: 4,
				topics: [],
			} as CommitSummary;
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // state
			vi.mocked(listFilesInBranch)
				.mockResolvedValueOnce(["summaries/shadow-hash.json"])
				.mockResolvedValueOnce([]);
			vi.mocked(batchReadFilesFromBranch).mockResolvedValueOnce(
				new Map([["summaries/shadow-hash.json", JSON.stringify(v4)]]),
			);

			await migrateSchemaToV5();

			expect(createStorage).toHaveBeenCalledTimes(1);
			expect(mockStorageWriteFiles).toHaveBeenCalledTimes(1);
			const writtenFiles = mockStorageWriteFiles.mock.calls[0]?.[0] as ReadonlyArray<FileWrite>;
			// 1 upgraded summary + 1 state file. The summary content is v5 so a
			// dual-write storage will write `"version": 5` to BOTH backends —
			// the bug we're guarding against was the shadow being skipped here.
			expect(writtenFiles).toHaveLength(2);
			const summaryFile = writtenFiles.find((f) => f.path.startsWith("summaries/"));
			expect(summaryFile).toBeDefined();
			const parsed = JSON.parse(summaryFile?.content ?? "{}");
			expect(parsed.version).toBe(5);
		});

		it("tolerates unparseable summary files by skipping them", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // state read
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/bad.json"]).mockResolvedValueOnce([]);
			vi.mocked(batchReadFilesFromBranch).mockResolvedValueOnce(
				new Map([["summaries/bad.json", "not valid json {"]]),
			);

			const result = await migrateSchemaToV5();

			expect(result.skipped).toBe(1);
			expect(result.migrated).toBe(0);
			// Migration still completes — the state file is written.
			expect(mockStorageWriteFiles).toHaveBeenCalledOnce();
		});

		it("throws when the orphan-write lock cannot be acquired within the timeout", async () => {
			// `withMigrationLock` short-circuits on lock acquisition failure
			// (covers the defensive throw branch in withMigrationLock). The
			// caller is expected to log + retry on next startup — see
			// `Extension.ts activate` and `Installer.install`.
			const locksMod = await import("./Locks.js");
			vi.mocked(locksMod.acquireOrphanWriteLock).mockResolvedValueOnce(false);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // state read

			await expect(migrateSchemaToV5()).rejects.toThrow(/orphan-write lock/);
			expect(mockStorageWriteFiles).not.toHaveBeenCalled();
		});

		it("tolerates execGit rejection when capturing pre-migration SHA (recovery log is best-effort)", async () => {
			// Pre-migration SHA capture is a debug-log convenience, not a
			// correctness gate. If the rev-parse call fails (e.g. on a fresh
			// orphan branch that hasn't been committed to yet, or in a CI
			// sandbox where git is unavailable), the migration still completes.
			const gitops = await import("./GitOps.js");
			vi.mocked(gitops.execGit).mockRejectedValueOnce(new Error("git not found"));
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // state
			vi.mocked(listFilesInBranch)
				.mockResolvedValueOnce([]) // summaries
				.mockResolvedValueOnce([]); // transcripts

			const result = await migrateSchemaToV5();
			expect(result.fresh).toBe(true);
			expect(mockStorageWriteFiles).toHaveBeenCalledOnce();
		});

		it("skips summary files whose batched read returned null (transient git read failure)", async () => {
			// Covers the `content === null` early-continue branch — cat-file's
			// batch reader maps an entry to null when the path resolved to
			// `missing` at read time (e.g. a concurrent orphan-write committed
			// a deletion between listFilesInBranch and the batch read).
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // state
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/vanished.json"]).mockResolvedValueOnce([]);
			vi.mocked(batchReadFilesFromBranch).mockResolvedValueOnce(new Map([["summaries/vanished.json", null]]));

			const result = await migrateSchemaToV5();

			expect(result.skipped).toBe(1);
			expect(result.migrated).toBe(0);
			expect(mockStorageWriteFiles).toHaveBeenCalledOnce();
		});

		it("throws when the batched read omits a requested path (contract violation, not transient race)", async () => {
			// `null` and `undefined` look identical to a casual read but have
			// very different causes: `null` is a benign race (file vanished),
			// `undefined` is a bug in the batch reader (it must populate one
			// entry per request). The migration code MUST surface the latter
			// — without this guard a future regression in
			// `batchReadFilesFromBranch` that silently drops entries would
			// be invisible (migrated count would just be lower than expected).
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null); // state
			vi.mocked(listFilesInBranch).mockResolvedValueOnce(["summaries/dropped.json"]).mockResolvedValueOnce([]);
			// Empty Map → `contents.get("summaries/dropped.json")` returns undefined.
			vi.mocked(batchReadFilesFromBranch).mockResolvedValueOnce(new Map());

			await expect(migrateSchemaToV5()).rejects.toThrow(/protocol contract violation/);
			expect(mockStorageWriteFiles).not.toHaveBeenCalled();
		});
	});

	// ─── readSchemaV5State ────────────────────────────────────────────────────
	describe("readSchemaV5State", () => {
		it("returns null when state file is absent", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			expect(await readSchemaV5State()).toBeNull();
		});

		it("returns the parsed state when file is present", async () => {
			const state = {
				version: 1,
				status: "completed",
				startedAt: "2026-05-22T00:00:00Z",
				completedAt: "2026-05-22T00:00:05Z",
				migratedCount: 0,
				skippedCount: 0,
				fresh: true,
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(state));
			expect(await readSchemaV5State()).toEqual(state);
		});

		it("returns null when state file is unparseable", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("not json");
			expect(await readSchemaV5State()).toBeNull();
		});
	});
});
