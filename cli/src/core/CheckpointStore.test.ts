import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import {
	archiveSupersededCheckpoints,
	CHECKPOINT_SCHEMA_VERSION,
	type CheckpointRecord,
	commitSecondUpperBound,
	deleteCheckpoint,
	getCheckpoint,
	listCheckpoints,
	writeCheckpoint,
} from "./CheckpointStore.js";

let kbRoot: string;

beforeEach(async () => {
	kbRoot = await mkdtemp(join(tmpdir(), "ckpt-store-"));
});

afterEach(async () => {
	await rm(kbRoot, { recursive: true, force: true });
});

function record(over: Partial<CheckpointRecord> = {}): CheckpointRecord {
	return {
		version: CHECKPOINT_SCHEMA_VERSION,
		kind: "checkpoint",
		id: "ckpt-1",
		branch: "feat/x",
		createdAt: "2026-07-12T10:00:00.000Z",
		generatedAt: "2026-07-12T10:00:01.000Z",
		topics: [{ title: "T", trigger: "why", response: "did", decisions: "chose" }],
		diffStats: { filesChanged: 1, insertions: 2, deletions: 0 },
		...over,
	};
}

const checkpointsDir = (): string => join(kbRoot, ".jolli", "checkpoints");
const archivedDir = (): string => join(checkpointsDir(), ".archived");

describe("CheckpointStore", () => {
	it("writes then reads back a checkpoint round-trip", async () => {
		await writeCheckpoint(kbRoot, record());
		const got = await getCheckpoint(kbRoot, "ckpt-1");
		expect(got?.id).toBe("ckpt-1");
		expect(got?.topics[0].title).toBe("T");
	});

	it("lists checkpoints newest-captured first", async () => {
		await writeCheckpoint(kbRoot, record({ id: "old", createdAt: "2026-07-12T09:00:00.000Z" }));
		await writeCheckpoint(kbRoot, record({ id: "new", createdAt: "2026-07-12T11:00:00.000Z" }));
		const list = await listCheckpoints(kbRoot);
		expect(list.map((c) => c.id)).toEqual(["new", "old"]);
	});

	it("filters by branch", async () => {
		await writeCheckpoint(kbRoot, record({ id: "a", branch: "feat/x" }));
		await writeCheckpoint(kbRoot, record({ id: "b", branch: "feat/y" }));
		const list = await listCheckpoints(kbRoot, { branch: "feat/y" });
		expect(list.map((c) => c.id)).toEqual(["b"]);
	});

	it("returns [] when the checkpoints dir does not exist", async () => {
		expect(await listCheckpoints(kbRoot)).toEqual([]);
	});

	it("skips malformed and non-json files without throwing", async () => {
		await writeCheckpoint(kbRoot, record({ id: "good" }));
		await writeFile(join(checkpointsDir(), "broken.json"), "{ not json");
		await writeFile(join(checkpointsDir(), "wrong.json"), JSON.stringify({ kind: "summary" }));
		await writeFile(join(checkpointsDir(), "notes.txt"), "ignore me");
		const list = await listCheckpoints(kbRoot);
		expect(list.map((c) => c.id)).toEqual(["good"]);
	});

	it("deletes a checkpoint idempotently", async () => {
		await writeCheckpoint(kbRoot, record({ id: "gone" }));
		await deleteCheckpoint(kbRoot, "gone");
		expect(await getCheckpoint(kbRoot, "gone")).toBeNull();
		// Second delete on a missing file is a no-op, not an error.
		await expect(deleteCheckpoint(kbRoot, "gone")).resolves.toBeUndefined();
	});

	it("rejects unsafe ids at the fs boundary", async () => {
		await expect(writeCheckpoint(kbRoot, record({ id: "../escape" }))).rejects.toThrow("unsafe checkpoint id");
		await expect(getCheckpoint(kbRoot, "a/b")).rejects.toThrow("unsafe checkpoint id");
	});

	it("drops a planted file whose stored id would escape the checkpoints dir", async () => {
		await writeCheckpoint(kbRoot, record({ id: "good" }));
		// A record whose on-disk CONTENT carries a traversal id — the filename is
		// innocuous, so only the read-path content check can catch it. Left
		// unfiltered, archiveSupersededCheckpoints would write/rm `<dir>/../../evil.json`.
		await writeFile(join(checkpointsDir(), "planted.json"), JSON.stringify(record({ id: "../../evil" })));
		const list = await listCheckpoints(kbRoot);
		expect(list.map((c) => c.id)).toEqual(["good"]);
	});

	describe("archiveSupersededCheckpoints", () => {
		it("moves branch checkpoints into .archived and stamps supersededBy", async () => {
			await writeCheckpoint(kbRoot, record({ id: "c1", branch: "feat/x" }));
			await writeCheckpoint(kbRoot, record({ id: "c2", branch: "feat/y" }));

			const n = await archiveSupersededCheckpoints(kbRoot, "feat/x", { supersededBy: "abc1234" });
			expect(n).toBe(1);

			// Active list no longer has feat/x's checkpoint; feat/y untouched.
			expect((await listCheckpoints(kbRoot)).map((c) => c.id).sort()).toEqual(["c2"]);
			// The archived copy is stamped.
			const archived = await readdir(archivedDir());
			expect(archived).toEqual(["c1.json"]);
			const raw = JSON.parse(
				await (await import("node:fs/promises")).readFile(join(archivedDir(), "c1.json"), "utf-8"),
			) as CheckpointRecord;
			expect(raw.supersededBy).toBe("abc1234");
			expect(typeof raw.archivedAt).toBe("string");
		});

		it("respects the `before` cutoff so newer checkpoints survive a back-filled commit", async () => {
			await writeCheckpoint(kbRoot, record({ id: "older", createdAt: "2026-07-12T08:00:00.000Z" }));
			await writeCheckpoint(kbRoot, record({ id: "newer", createdAt: "2026-07-12T12:00:00.000Z" }));

			const n = await archiveSupersededCheckpoints(kbRoot, "feat/x", { before: "2026-07-12T10:00:00.000Z" });
			expect(n).toBe(1);
			expect((await listCheckpoints(kbRoot)).map((c) => c.id)).toEqual(["newer"]);
		});

		it("is a no-op (returns 0) when the branch has no checkpoints", async () => {
			expect(await archiveSupersededCheckpoints(kbRoot, "feat/none")).toBe(0);
			await writeCheckpoint(kbRoot, record({ id: "other", branch: "feat/other" }));
			expect(await archiveSupersededCheckpoints(kbRoot, "feat/x")).toBe(0);
		});

		it("resolves a lazy `before` only when checkpoints exist (keeps the hot path git-call-free)", async () => {
			// No checkpoints on the branch → the resolver must never be invoked (the
			// live QueueWorker path passes a git-backed resolver here).
			let calls = 0;
			const lazyBefore = () => {
				calls++;
				return Promise.resolve("2026-07-12T10:00:00.000Z");
			};
			expect(await archiveSupersededCheckpoints(kbRoot, "feat/x", { before: lazyBefore })).toBe(0);
			expect(calls).toBe(0);

			// With checkpoints present, the resolver runs and its bound is applied.
			await writeCheckpoint(kbRoot, record({ id: "older", createdAt: "2026-07-12T08:00:00.000Z" }));
			await writeCheckpoint(kbRoot, record({ id: "newer", createdAt: "2026-07-12T12:00:00.000Z" }));
			const n = await archiveSupersededCheckpoints(kbRoot, "feat/x", { before: lazyBefore });
			expect(calls).toBe(1);
			expect(n).toBe(1);
			expect((await listCheckpoints(kbRoot)).map((c) => c.id)).toEqual(["newer"]);
		});

		it("archives NOTHING when a lazy `before` resolves null (no usable bound)", async () => {
			// The caller asked to scope archival to a bound but couldn't compute one
			// (e.g. an unparseable commit date). Archiving everything could wipe
			// checkpoints captured for later work, so we archive nothing instead.
			await writeCheckpoint(kbRoot, record({ id: "a" }));
			await writeCheckpoint(kbRoot, record({ id: "b" }));
			const n = await archiveSupersededCheckpoints(kbRoot, "feat/x", { before: () => Promise.resolve(null) });
			expect(n).toBe(0);
			expect((await listCheckpoints(kbRoot)).map((c) => c.id).sort()).toEqual(["a", "b"]);
		});

		it("archives all active checkpoints when NO `before` is supplied", async () => {
			// Distinct from the null-resolver case: omitting `before` entirely means
			// "no scoping requested", so every active checkpoint is superseded.
			await writeCheckpoint(kbRoot, record({ id: "a" }));
			await writeCheckpoint(kbRoot, record({ id: "b" }));
			const n = await archiveSupersededCheckpoints(kbRoot, "feat/x");
			expect(n).toBe(2);
			expect(await listCheckpoints(kbRoot)).toEqual([]);
		});
	});

	describe("commitSecondUpperBound", () => {
		it("rounds a second-precision git date up to the end of its second", () => {
			expect(commitSecondUpperBound("2026-03-04T05:06:07Z")).toBe("2026-03-04T05:06:07.999Z");
			expect(commitSecondUpperBound("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.999Z");
		});

		it("normalizes a timezone offset to UTC while keeping the .999 bound", () => {
			// 05:06:07+02:00 == 03:06:07Z, bound at that second's end.
			expect(commitSecondUpperBound("2026-03-04T05:06:07+02:00")).toBe("2026-03-04T03:06:07.999Z");
		});

		it("returns null for an unparseable date", () => {
			expect(commitSecondUpperBound("not a date")).toBeNull();
		});
	});
});
