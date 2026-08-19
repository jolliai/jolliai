import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../../Types.js";
import { executeRepairs } from "./RepairExecutor.js";

// Only the two default-wiring cases at the bottom of this file reach these;
// every other case injects its own collaborator, so the mocks stay untouched.
vi.mock("../SummaryStore.js", () => ({
	getSummary: vi.fn(),
	remountStrandedTree: vi.fn(),
	migrateOneToOne: vi.fn(),
	mergeManyToOne: vi.fn(),
}));
vi.mock("../GitOps.js", () => ({ getCommitInfo: vi.fn() }));
vi.mock("../SquashConsolidation.js", () => ({ consolidateSquashSources: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
});

/** A target as it looks AFTER a successful repair: the sources hang under it. */
function withChildren(target: CommitSummary, ...childHashes: string[]): CommitSummary {
	return { ...target, children: childHashes.map((commitHash) => ({ commitHash })) } as unknown as CommitSummary;
}

/**
 * `readTarget` is called twice per action now — once before the write (for the
 * backup) and once after (to prove the write landed). This serves a different
 * value each call so a test can describe both states.
 */
function readTargetOnce(
	...states: ReadonlyArray<CommitSummary | undefined>
): (hash: string, cwd: string) => Promise<CommitSummary | undefined> {
	let call = 0;
	return async () => states[Math.min(call++, states.length - 1)];
}

describe("executeRepairs", () => {
	it("backs up the target's AND every source root's pre-write state before invoking remount", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const targetBeforeWrite = { commitHash: "new", topics: ["pre-existing-topic"] } as unknown as CommitSummary;
		const sourceBeforeWrite = { commitHash: "old", topics: ["stranded-topic"] } as unknown as CommitSummary;
		// The assertion lives INSIDE the mock, at call time: if remount ran
		// before the backup was written, the file this reads either wouldn't
		// exist yet or would already hold post-write content -- either way the
		// test would fail, unlike an after-the-fact directory-count check.
		//
		// It covers the SOURCE roots as well as the target: `storeSummary`
		// overwrites and the SQLite upsert replaces `summary_json`, so the
		// stranded tree is exactly as unrecoverable as the target. Asserting
		// only the target left `...roots` deletable from `backupBeforeWrite`'s
		// `affected` with the suite still green.
		const remount = vi.fn(async () => {
			const backupRoot = join(cwd, ".jolli", "jollimemory", "repair-backups");
			const [stamp] = await readdir(backupRoot);
			const read = async (hash: string) =>
				JSON.parse(await readFile(join(backupRoot, stamp as string, `${hash}.json`), "utf8"));
			expect(await read("new")).toEqual(targetBeforeWrite);
			expect(await read("old")).toEqual(sourceBeforeWrite);
		});
		const outcomes = await executeRepairs(
			[{ kind: "remount", targetHash: "new", source: { oldHash: "old", root: sourceBeforeWrite } }] as never,
			cwd,
			{
				useLlm: true,
				remount,
				readTarget: readTargetOnce(targetBeforeWrite, withChildren(targetBeforeWrite, "old")),
			},
		);
		expect(remount).toHaveBeenCalledTimes(1);
		expect(outcomes[0]?.ok).toBe(true);
		await rm(cwd, { recursive: true, force: true });
	});

	it("keeps going after one action fails and reports both", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const remount = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
		const outcomes = await executeRepairs(
			[
				{ kind: "remount", targetHash: "n1", source: { oldHash: "o1", root: { commitHash: "o1" } } },
				{ kind: "remount", targetHash: "n2", source: { oldHash: "o2", root: { commitHash: "o2" } } },
			] as never,
			cwd,
			{
				useLlm: true,
				remount,
				readTarget: async (hash: string) =>
					({ commitHash: hash, children: [{ commitHash: hash === "n1" ? "o1" : "o2" }] }) as never,
			},
		);
		expect(outcomes.map((o) => o.ok)).toEqual([false, true]);
		expect(outcomes[0]?.error).toMatch(/boom/);
		await rm(cwd, { recursive: true, force: true });
	});

	it("skips an unpaired action without touching storage", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const remount = vi.fn();
		const outcomes = await executeRepairs(
			[{ kind: "unpaired", source: { oldHash: "o" }, reason: "none" }] as never,
			cwd,
			{ useLlm: true, remount, readTarget: async () => undefined },
		);
		expect(remount).not.toHaveBeenCalled();
		expect(outcomes[0]?.ok).toBe(false);
		await rm(cwd, { recursive: true, force: true });
	});

	it("skips an unsupported action without touching storage", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const remount = vi.fn();
		const migrateOneToOne = vi.fn();
		const mergeManyToOne = vi.fn();
		const outcomes = await executeRepairs(
			[
				{
					kind: "unsupported",
					targetHash: "t",
					sources: [{ oldHash: "a" }, { oldHash: "b" }],
					reason: "several stranded trees pair to a target that already has its own memory",
				},
			] as never,
			cwd,
			{ useLlm: true, remount, migrateOneToOne, mergeManyToOne, readTarget: async () => undefined },
		);
		expect(remount).not.toHaveBeenCalled();
		expect(migrateOneToOne).not.toHaveBeenCalled();
		expect(mergeManyToOne).not.toHaveBeenCalled();
		expect(outcomes[0]).toMatchObject({
			ok: false,
			error: "several stranded trees pair to a target that already has its own memory",
		});
		await rm(cwd, { recursive: true, force: true });
	});

	it("routes a single-source migrate through migrateOneToOne, not consolidation", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const commitInfo = { hash: "new", message: "msg", author: "a", date: "d" } as never;
		const getCommitInfo = vi.fn(async () => commitInfo);
		const migrateOneToOne = vi.fn(async () => undefined);
		const consolidateSquashSources = vi.fn();
		const mergeManyToOne = vi.fn();
		const outcomes = await executeRepairs(
			[
				{
					kind: "migrate",
					targetHash: "new",
					sources: [{ oldHash: "old", root: { commitHash: "old" } }],
					needsLlm: false,
				},
			] as never,
			cwd,
			{
				useLlm: true,
				readTarget: readTargetOnce(undefined, withChildren({ commitHash: "new" } as CommitSummary, "old")),
				getCommitInfo,
				migrateOneToOne,
				consolidateSquashSources,
				mergeManyToOne,
			},
		);
		expect(getCommitInfo).toHaveBeenCalledWith("new", cwd);
		expect(migrateOneToOne).toHaveBeenCalledWith({ commitHash: "old" }, commitInfo, cwd);
		expect(consolidateSquashSources).not.toHaveBeenCalled();
		expect(mergeManyToOne).not.toHaveBeenCalled();
		expect(outcomes[0]?.ok).toBe(true);
		await rm(cwd, { recursive: true, force: true });
	});

	it("routes a multi-source migrate through consolidation then mergeManyToOne, passing useLlm through", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const commitInfo = { hash: "new", message: "PROJ-1: squash", author: "a", date: "d" } as never;
		const getCommitInfo = vi.fn(async () => commitInfo);
		const consolidated = { topics: [], status: "mechanical" } as never;
		const consolidateSquashSources = vi.fn(async () => consolidated);
		const mergeManyToOne = vi.fn(async () => ({ orphanedDocIds: [] }));
		const migrateOneToOne = vi.fn();
		const outcomes = await executeRepairs(
			[
				{
					kind: "migrate",
					targetHash: "new",
					sources: [
						{ oldHash: "a", root: { commitHash: "a" } },
						{ oldHash: "b", root: { commitHash: "b" } },
					],
					needsLlm: true,
				},
			] as never,
			cwd,
			{
				useLlm: false,
				readTarget: readTargetOnce(undefined, withChildren({ commitHash: "new" } as CommitSummary, "a", "b")),
				getCommitInfo,
				migrateOneToOne,
				consolidateSquashSources,
				mergeManyToOne,
			},
		);
		expect(migrateOneToOne).not.toHaveBeenCalled();
		expect(consolidateSquashSources).toHaveBeenCalledWith(
			[{ commitHash: "a" }, { commitHash: "b" }],
			"PROJ-1: squash",
			{ onFailure: "throw", useLlm: false },
		);
		expect(mergeManyToOne).toHaveBeenCalledWith([{ commitHash: "a" }, { commitHash: "b" }], commitInfo, cwd, {
			consolidated,
		});
		expect(outcomes[0]?.ok).toBe(true);
		await rm(cwd, { recursive: true, force: true });
	});

	// The silent-skip channel that needs no user input at all:
	// `migrateOneToOneLocked` returns without writing whenever the target hash
	// is already in the index (routine after `git merge --squash`), and
	// `remountStrandedTree` returns under a manual disable. Neither throws, so
	// "no exception" is not evidence -- only re-reading the target is.
	it("reports ok:false when the write silently did not land", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const remount = vi.fn(async () => undefined);
		const targetUnchanged = { commitHash: "new", topics: ["mine"] } as unknown as CommitSummary;
		const outcomes = await executeRepairs(
			[{ kind: "remount", targetHash: "new", source: { oldHash: "old", root: { commitHash: "old" } } }] as never,
			cwd,
			{ useLlm: true, remount, readTarget: async () => targetUnchanged },
		);
		expect(remount).toHaveBeenCalledTimes(1);
		expect(outcomes[0]?.ok).toBe(false);
		expect(outcomes[0]?.error).toMatch(/old.*still not attached under new/);
		await rm(cwd, { recursive: true, force: true });
	});

	it("reports ok:false when a migrate leaves the target with no memory at all", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const outcomes = await executeRepairs(
			[
				{
					kind: "migrate",
					targetHash: "new",
					sources: [{ oldHash: "old", root: { commitHash: "old" } }],
					needsLlm: false,
				},
			] as never,
			cwd,
			{
				useLlm: true,
				readTarget: async () => undefined,
				getCommitInfo: async () => ({ hash: "new", message: "m", author: "a", date: "d" }) as never,
				migrateOneToOne: async () => undefined,
			},
		);
		expect(outcomes[0]?.ok).toBe(false);
		expect(outcomes[0]?.error).toMatch(/still has no stored memory/);
		await rm(cwd, { recursive: true, force: true });
	});

	// The DEFAULT wiring is the production path and every test above injects
	// past it. A swapped `(target, stranded)` argument order in the remount
	// closure, or the wrong function behind `readTarget` / `migrateOneToOne`,
	// would be catastrophic, silent, and fail no other test in this file.
	it("defaults to the real remount, target reader and 1:1 migrator", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const { remountStrandedTree, getSummary } = await import("../SummaryStore.js");
		const target = { commitHash: "new", topics: ["mine"] } as unknown as CommitSummary;
		const strandedRoot = { commitHash: "old" } as unknown as CommitSummary;

		vi.mocked(getSummary)
			.mockResolvedValueOnce(target)
			.mockResolvedValueOnce({ ...target, children: [strandedRoot] } as never);
		vi.mocked(remountStrandedTree).mockResolvedValue(undefined);

		const outcomes = await executeRepairs(
			[{ kind: "remount", targetHash: "new", source: { oldHash: "old", root: strandedRoot } }] as never,
			cwd,
			{ useLlm: true },
		);

		expect(getSummary).toHaveBeenNthCalledWith(1, "new", cwd);
		// Argument ORDER is the whole point: target first, stranded root second.
		expect(remountStrandedTree).toHaveBeenCalledWith(target, strandedRoot, cwd);
		expect(outcomes[0]?.ok).toBe(true);
		await rm(cwd, { recursive: true, force: true });
	});

	it("defaults to migrateOneToOne tagged as a rebase for a single-source migrate", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const { getSummary, migrateOneToOne } = await import("../SummaryStore.js");
		const { getCommitInfo } = await import("../GitOps.js");
		const commitInfo = { hash: "new", message: "m", author: "a", date: "d" } as never;
		const strandedRoot = { commitHash: "old" } as unknown as CommitSummary;

		vi.mocked(getCommitInfo).mockResolvedValue(commitInfo);
		vi.mocked(migrateOneToOne).mockResolvedValue(undefined);
		vi.mocked(getSummary)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ commitHash: "new", children: [strandedRoot] } as never);

		const outcomes = await executeRepairs(
			[
				{
					kind: "migrate",
					targetHash: "new",
					sources: [{ oldHash: "old", root: strandedRoot }],
					needsLlm: false,
				},
			] as never,
			cwd,
			{ useLlm: true },
		);

		expect(getCommitInfo).toHaveBeenCalledWith("new", cwd);
		expect(migrateOneToOne).toHaveBeenCalledWith(strandedRoot, commitInfo, cwd, { commitType: "rebase" });
		expect(outcomes[0]?.ok).toBe(true);
		await rm(cwd, { recursive: true, force: true });
	});
});
