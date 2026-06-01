import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./GitOps.js", () => ({
	// Pre-migration SHA capture for debug-log recovery anchor. Tests don't
	// assert on this — a benign stub is enough. The migration's reads now go
	// through the StorageProvider (mocked below), not GitOps directly.
	execGit: vi.fn().mockResolvedValue({ stdout: "deadbeef0000000000000000000000000000beef\n", stderr: "" }),
}));

// Mock the StorageFactory so the migration's reads AND writes are observed via
// a single fake StorageProvider. In production `createStorage` returns the
// active backend (DualWriteStorage by default); here every primitive is a spy
// so tests can drive `exists`/`listFiles`/`batchReadFiles`/`readFile` and
// assert on the captured `writeFiles` args. Defaults are the happy-path
// values (backend exists, empty listings, null state) so each test only
// overrides what it exercises.
const {
	mockStorageWriteFiles,
	mockStorageExists,
	mockStorageListFiles,
	mockStorageReadFile,
	mockStorageBatchReadFiles,
	mockStorageIsDirty,
} = vi.hoisted(() => ({
	mockStorageWriteFiles: vi.fn().mockResolvedValue(undefined),
	mockStorageExists: vi.fn().mockResolvedValue(true),
	mockStorageListFiles: vi.fn().mockResolvedValue([]),
	mockStorageReadFile: vi.fn().mockResolvedValue(null),
	mockStorageBatchReadFiles: vi.fn().mockResolvedValue(new Map()),
	// Shadow clean by default → migration stamps `completed`. The shadow-failure
	// test flips this to true to assert the migration stays pending.
	mockStorageIsDirty: vi.fn().mockReturnValue(false),
}));
vi.mock("./StorageFactory.js", () => ({
	createStorage: vi.fn().mockResolvedValue({
		writeFiles: mockStorageWriteFiles,
		exists: mockStorageExists,
		listFiles: mockStorageListFiles,
		readFile: mockStorageReadFile,
		batchReadFiles: mockStorageBatchReadFiles,
		isDirty: mockStorageIsDirty,
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

		it("repairs a version-5 record that is MISSING the transcripts field (not treated as migrated)", () => {
			// Anomalous record (bug / hand-edit): version 5 but no `transcripts`.
			// The fast-path must NOT return it as-is — left alone it forces the
			// read path down the v3/v4 children-walk fallback forever. Falling
			// through computes the array like any pre-v5 root.
			const v5NoTranscripts: CommitSummary = {
				...baseNode,
				version: 5,
				topics: [],
			} as CommitSummary;
			const upgraded = __test__.upgradeOneSummary(v5NoTranscripts, new Set([baseNode.commitHash]));
			expect(upgraded).not.toBe(v5NoTranscripts); // repaired, not returned verbatim
			expect(upgraded.version).toBe(5);
			expect(upgraded.transcripts).toEqual([baseNode.commitHash]);
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
			// The legacy `stats` field is STRIPPED, not carried alongside
			// `diffStats` — otherwise the read-time stats→diffStats fallback could
			// never be removed (a v5 record carrying both is the anti-pattern).
			expect(upgraded.stats).toBeUndefined();
		});

		it("stamps the AGGREGATE diffStats for a v3 container (amend root), not the raw root delta", async () => {
			// An amend root's own `stats` is just the delta; pre-v5 the display
			// went through resolveDiffStats → aggregateStats (delta + children).
			// Migration must stamp that aggregate, else the v5 fast-path returns
			// the raw delta and the displayed diff silently shrinks.
			const v3AmendRoot: CommitSummary = {
				...baseNode,
				version: 3,
				// root (amend) delta
				stats: { filesChanged: 1, insertions: 2, deletions: 0 },
				children: [
					{
						...baseNode,
						commitHash: "child-pre-amend",
						version: 3,
						stats: { filesChanged: 3, insertions: 10, deletions: 4 },
					} as CommitSummary,
				],
			} as CommitSummary;
			const upgraded = __test__.upgradeOneSummary(v3AmendRoot, new Set([baseNode.commitHash]));
			// delta (1/2/0) + child (3/10/4) = 4/12/4, NOT the raw 1/2/0.
			expect(upgraded.diffStats).toEqual({ filesChanged: 4, insertions: 12, deletions: 4 });
			expect(upgraded.stats).toBeUndefined();
		});
	});

	// ─── migrateSchemaToV5 (integration with StorageProvider mocks) ───────────
	describe("migrateSchemaToV5 (integration)", () => {
		it("returns a no-op fresh result when the storage backend does not exist yet", async () => {
			// Fresh install: no jollimemory data, no orphan branch / no Memory
			// Bank folder. Migration must not create the backend as a side effect.
			mockStorageExists.mockResolvedValueOnce(false);

			const result = await migrateSchemaToV5();

			expect(result.fresh).toBe(true);
			expect(result.alreadyDone).toBe(false);
			expect(result.migrated).toBe(0);
			expect(mockStorageWriteFiles).not.toHaveBeenCalled();
			expect(mockStorageListFiles).not.toHaveBeenCalled();
		});

		it("migrates folder-only data: reads via readFile when batchReadFiles is absent", async () => {
			// folder-only regression guard: FolderStorage exposes no
			// `batchReadFiles`, so the migration must fall back to per-file
			// `readFile`. Previously folder-only repos were skipped entirely
			// (orphan-branch gate) and never reached v5.
			const v4: CommitSummary = {
				...baseNode,
				commitHash: "folder-hash",
				version: 4,
				topics: [],
			} as CommitSummary;
			const { createStorage } = await import("./StorageFactory.js");
			// A folder-style provider: exists/listFiles/readFile/writeFiles but
			// NO batchReadFiles capability.
			const folderReadFile = vi.fn(async (path: string) =>
				path === "summaries/folder-hash.json" ? JSON.stringify(v4) : null,
			);
			vi.mocked(createStorage).mockResolvedValueOnce({
				exists: vi.fn().mockResolvedValue(true),
				listFiles: vi
					.fn()
					.mockResolvedValueOnce(["summaries/folder-hash.json"])
					.mockResolvedValueOnce(["transcripts/folder-hash.json"]),
				readFile: folderReadFile,
				writeFiles: mockStorageWriteFiles,
				// batchReadFiles intentionally omitted.
			} as never);

			const result = await migrateSchemaToV5();

			expect(result.migrated).toBe(1);
			expect(result.fresh).toBe(false);
			// Per-file fallback was used for the summary read (state reads also
			// go through readFile, so just assert the summary path was read).
			expect(folderReadFile).toHaveBeenCalledWith("summaries/folder-hash.json");
			const files = mockStorageWriteFiles.mock.calls[0]?.[0] as ReadonlyArray<FileWrite>;
			const summaryFile = files.find((f) => f.path.startsWith("summaries/"));
			expect(JSON.parse(summaryFile?.content ?? "{}").version).toBe(5);
		});

		it("writes a fresh-install state when the backend has no summaries", async () => {
			mockStorageListFiles
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
			mockStorageReadFile.mockResolvedValueOnce(
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

		it("skips (no rescan) when a concurrent run completed between the outer check and the lock", async () => {
			// #6 idempotency guard: the state check in migrateSchemaToV5 is
			// outside the lock. The first readFile (outer check) returns null
			// (pending), but by the time we hold the lock another process has
			// written "completed". The in-lock re-check must short-circuit so we
			// don't rescan and overwrite the state with migratedCount:0.
			mockStorageReadFile
				.mockResolvedValueOnce(null) // outer check: still pending
				.mockResolvedValueOnce(
					JSON.stringify({
						version: 1,
						status: "completed",
						startedAt: "2026-05-22T00:00:00Z",
						completedAt: "2026-05-22T00:00:09Z",
						migratedCount: 7,
						skippedCount: 2,
						fresh: false,
					}),
				); // in-lock re-check: a concurrent run finished

			const result = await migrateSchemaToV5();

			expect(result.alreadyDone).toBe(true);
			expect(result.migrated).toBe(7);
			expect(result.skipped).toBe(2);
			// No rescan, no overwrite of the completed state.
			expect(mockStorageListFiles).not.toHaveBeenCalled();
			expect(mockStorageWriteFiles).not.toHaveBeenCalled();
		});

		it("upgrades v3 and v4 summaries to v5 in one atomic write", async () => {
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

			mockStorageListFiles
				.mockResolvedValueOnce(["summaries/v3-hash.json", "summaries/v4-hash.json"])
				// The stray non-`.json` entry exercises the `match?.[1]` falsy
				// guard — `listFiles("transcripts/")` can surface paths that don't
				// match the `transcripts/<id>.json` shape; those must be ignored.
				.mockResolvedValueOnce([
					"transcripts/v3-hash.json",
					"transcripts/v4-hash.json",
					"transcripts/stray.txt",
				]);
			// Summary contents flow through the storage batch reader. One mock
			// call serves all paths for the migration's read phase.
			mockStorageBatchReadFiles.mockResolvedValueOnce(
				new Map([
					["summaries/v3-hash.json", JSON.stringify(v3)],
					["summaries/v4-hash.json", JSON.stringify(v4)],
				]),
			);

			const result = await migrateSchemaToV5();

			expect(result.migrated).toBe(2);
			expect(result.skipped).toBe(0);
			expect(result.fresh).toBe(false);

			// Content first (the 2 summaries), then the completed-state marker as
			// a SEPARATE write — the marker only lands after the content does, and
			// only when the shadow is clean.
			const contentFiles = mockStorageWriteFiles.mock.calls[0]?.[0] as ReadonlyArray<FileWrite>;
			expect(contentFiles.map((f) => f.path).sort()).toEqual([
				"summaries/v3-hash.json",
				"summaries/v4-hash.json",
			]);
			for (const f of contentFiles) {
				const parsed = JSON.parse(f.content);
				expect(parsed.version).toBe(5);
				expect(parsed.transcripts).toBeDefined();
			}
			const stateFiles = mockStorageWriteFiles.mock.calls[1]?.[0] as ReadonlyArray<FileWrite>;
			expect(stateFiles).toHaveLength(1);
			expect(stateFiles[0]?.path).toBe(__test__.SCHEMA_V5_STATE_FILE);
		});

		it("recovery: re-pushes already-v5 summaries to heal a lagging shadow, then completes", async () => {
			// Reaching the locked migration with everything already v5 (migrated=0)
			// but no completed marker means a prior attempt upgraded the source of
			// truth but didn't finish (classic dual-write shadow failure). The
			// skip-unchanged fast-path would write nothing to the folder; instead
			// we MUST re-push every v5 summary so the lagging shadow catches up.
			const v5Already: CommitSummary = {
				...baseNode,
				commitHash: "v5-hash",
				version: 5,
				topics: [],
				transcripts: ["uuid-existing"],
			} as CommitSummary;

			mockStorageListFiles
				.mockResolvedValueOnce(["summaries/v5-hash.json"])
				.mockResolvedValueOnce(["transcripts/uuid-existing.json"]);
			mockStorageBatchReadFiles.mockResolvedValueOnce(
				new Map([["summaries/v5-hash.json", JSON.stringify(v5Already)]]),
			);

			const result = await migrateSchemaToV5();

			expect(result.skipped).toBe(1);
			expect(result.migrated).toBe(0);

			// Content write re-pushes the already-v5 summary (NOT skipped), then the
			// state marker is written separately.
			const contentFiles = mockStorageWriteFiles.mock.calls[0]?.[0] as ReadonlyArray<FileWrite>;
			expect(contentFiles).toHaveLength(1);
			expect(contentFiles[0]?.path).toBe("summaries/v5-hash.json");
			const stateFiles = mockStorageWriteFiles.mock.calls[1]?.[0] as ReadonlyArray<FileWrite>;
			expect(stateFiles[0]?.path).toBe(__test__.SCHEMA_V5_STATE_FILE);
		});

		it("leaves state PENDING (no completed marker) when the storage shadow write failed", async () => {
			// dual-write swallows a folder (shadow) write failure + flags dirty.
			// The migration must NOT stamp `completed` then — otherwise the folder
			// is stranded at the old schema and the marker locks out any retry.
			const v4: CommitSummary = {
				...baseNode,
				commitHash: "shadow-hash",
				version: 4,
				topics: [],
			} as CommitSummary;
			mockStorageListFiles.mockResolvedValueOnce(["summaries/shadow-hash.json"]).mockResolvedValueOnce([]);
			mockStorageBatchReadFiles.mockResolvedValueOnce(
				new Map([["summaries/shadow-hash.json", JSON.stringify(v4)]]),
			);
			// Shadow reported dirty after the content write.
			mockStorageIsDirty.mockReturnValueOnce(true);

			const result = await migrateSchemaToV5();

			expect(result.alreadyDone).toBe(false);
			// Content was written, but the state marker was NOT (only one write).
			expect(mockStorageWriteFiles).toHaveBeenCalledTimes(1);
			const written = mockStorageWriteFiles.mock.calls[0]?.[0] as ReadonlyArray<FileWrite>;
			expect(written.some((f) => f.path === __test__.SCHEMA_V5_STATE_FILE)).toBe(false);
			expect(written[0]?.path).toBe("summaries/shadow-hash.json");
		});

		it("routes the migration write through createStorage so dual-write fans out to orphan + shadow", async () => {
			// Regression guard for the v4-stuck-in-shadow bug: the earlier
			// implementation called `writeMultipleFilesToBranch` directly, so
			// dual-write users saw the orphan branch upgraded to v5 while the
			// `<localFolder>/<repo>/.jolli/summaries/*.json` shadow files kept
			// `"version": 4` until normal post-commit traffic eventually
			// rewrote each one. Routing through `createStorage()` gives the
			// active `StorageProvider` (DualWriteStorage in dual-write mode) a
			// chance to fan the v5 payload out to both backends.
			const { createStorage } = await import("./StorageFactory.js");

			const v4: CommitSummary = {
				...baseNode,
				commitHash: "shadow-hash",
				version: 4,
				topics: [],
			} as CommitSummary;
			mockStorageListFiles.mockResolvedValueOnce(["summaries/shadow-hash.json"]).mockResolvedValueOnce([]);
			mockStorageBatchReadFiles.mockResolvedValueOnce(
				new Map([["summaries/shadow-hash.json", JSON.stringify(v4)]]),
			);

			await migrateSchemaToV5();

			expect(createStorage).toHaveBeenCalledTimes(1);
			// Two writes: content (the upgraded summary) then the completed marker.
			expect(mockStorageWriteFiles).toHaveBeenCalledTimes(2);
			const contentFiles = mockStorageWriteFiles.mock.calls[0]?.[0] as ReadonlyArray<FileWrite>;
			const summaryFile = contentFiles.find((f) => f.path.startsWith("summaries/"));
			expect(summaryFile).toBeDefined();
			// The summary content is v5 so dual-write fans `"version": 5` to BOTH
			// backends — the bug we're guarding against was the shadow being skipped.
			expect(JSON.parse(summaryFile?.content ?? "{}").version).toBe(5);
		});

		it("tolerates unparseable summary files by skipping them", async () => {
			mockStorageListFiles.mockResolvedValueOnce(["summaries/bad.json"]).mockResolvedValueOnce([]);
			mockStorageBatchReadFiles.mockResolvedValueOnce(new Map([["summaries/bad.json", "not valid json {"]]));

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
			mockStorageListFiles
				.mockResolvedValueOnce([]) // summaries
				.mockResolvedValueOnce([]); // transcripts

			const result = await migrateSchemaToV5();
			expect(result.fresh).toBe(true);
			expect(mockStorageWriteFiles).toHaveBeenCalledOnce();
		});

		it("skips summary files whose batched read returned null (transient read failure)", async () => {
			// Covers the `content === null` early-continue branch — the batch
			// reader maps an entry to null when the path resolved to `missing`
			// at read time (e.g. a concurrent write committed a deletion between
			// listFiles and the batch read).
			mockStorageListFiles.mockResolvedValueOnce(["summaries/vanished.json"]).mockResolvedValueOnce([]);
			mockStorageBatchReadFiles.mockResolvedValueOnce(new Map([["summaries/vanished.json", null]]));

			const result = await migrateSchemaToV5();

			expect(result.skipped).toBe(1);
			expect(result.migrated).toBe(0);
			expect(mockStorageWriteFiles).toHaveBeenCalledOnce();
		});

		it("throws when the batched read omits a requested path (contract violation, not transient race)", async () => {
			// `null` and `undefined` look identical to a casual read but have
			// very different causes: `null` is a benign race (file vanished),
			// `undefined` is a bug in the batch reader (it must populate one
			// entry per request). The migration code MUST surface the latter —
			// without this guard a future regression in `readSummaries` that
			// silently drops entries would be invisible (migrated count would
			// just be lower than expected).
			mockStorageListFiles.mockResolvedValueOnce(["summaries/dropped.json"]).mockResolvedValueOnce([]);
			// Empty Map → `contents.get("summaries/dropped.json")` returns undefined.
			mockStorageBatchReadFiles.mockResolvedValueOnce(new Map());

			await expect(migrateSchemaToV5()).rejects.toThrow(/protocol contract violation/);
			expect(mockStorageWriteFiles).not.toHaveBeenCalled();
		});
	});

	// ─── readSchemaV5State ────────────────────────────────────────────────────
	describe("readSchemaV5State", () => {
		it("returns null when state file is absent", async () => {
			mockStorageReadFile.mockResolvedValueOnce(null);
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
			mockStorageReadFile.mockResolvedValueOnce(JSON.stringify(state));
			expect(await readSchemaV5State()).toEqual(state);
		});

		it("returns null when state file is unparseable", async () => {
			mockStorageReadFile.mockResolvedValueOnce("not json");
			expect(await readSchemaV5State()).toBeNull();
		});

		it("uses a caller-provided storage without constructing a new one", async () => {
			// The migration threads its already-built provider in to avoid the
			// extra `createStorage` (loadConfig) I/O. Verify the passed storage's
			// readFile is used and createStorage is NOT called.
			const { createStorage } = await import("./StorageFactory.js");
			const passedReadFile = vi.fn().mockResolvedValue(null);
			await readSchemaV5State(undefined, { readFile: passedReadFile } as never);
			expect(passedReadFile).toHaveBeenCalledWith(__test__.SCHEMA_V5_STATE_FILE);
			expect(createStorage).not.toHaveBeenCalled();
		});
	});
});
