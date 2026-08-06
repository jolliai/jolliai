import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import { withPushPendingLock } from "./Locks.js";
import {
	__writeForTest,
	CLAIM_RENEW_INTERVAL_MS,
	claimForPush,
	deleteEntry,
	loadPushPending,
	mergeEntries,
	PUSH_ERROR_MSG_MAX_LEN,
	PUSH_PENDING_STALE_MS,
	type PushPendingFile,
	renewClaims,
	truncateError,
	updateBatch,
	updateEntry,
} from "./PushPendingStore.js";

let cwd: string;

beforeEach(async () => {
	cwd = join(tmpdir(), `push-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR), { recursive: true });
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function filePath(): string {
	return join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR, "push-pending.json");
}

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const TARGET = { remote: "origin", remoteRef: "refs/heads/feature/x", localSha: HASH_B } as const;

describe("loadPushPending", () => {
	it("returns empty when the file is missing", async () => {
		const file = await loadPushPending(cwd);
		expect(file.version).toBe(1);
		expect(Object.keys(file.entries)).toHaveLength(0);
	});

	it("returns empty and does not throw on corrupt JSON", async () => {
		await writeFile(filePath(), "not json {", "utf8");
		const file = await loadPushPending(cwd);
		expect(Object.keys(file.entries)).toHaveLength(0);
	});

	it("returns empty on an unexpected shape (wrong version)", async () => {
		await writeFile(filePath(), JSON.stringify({ version: 99, entries: {} }), "utf8");
		const file = await loadPushPending(cwd);
		expect(Object.keys(file.entries)).toHaveLength(0);
	});

	// The shape guard has to reject each way the file can be valid JSON yet not a
	// pending file — a bad state file must never block the pre-push flow.
	it.each([
		["a bare JSON scalar", JSON.stringify("just a string")],
		["JSON null", "null"],
		["a non-object `entries`", JSON.stringify({ version: 1, entries: 5 })],
		["a null `entries`", JSON.stringify({ version: 1, entries: null })],
	])("returns empty for %s", async (_label, contents) => {
		await writeFile(filePath(), contents, "utf8");
		expect(Object.keys((await loadPushPending(cwd)).entries)).toHaveLength(0);
	});

	it("returns empty when the pending path is unreadable (not merely absent)", async () => {
		// A DIRECTORY where the file should be → EISDIR, which is a real failure
		// rather than the routine "nothing enqueued yet" ENOENT.
		await rm(filePath(), { force: true });
		await mkdir(filePath(), { recursive: true });
		expect(Object.keys((await loadPushPending(cwd)).entries)).toHaveLength(0);
	});

	it("tolerates an unlink failure when the file becomes empty", async () => {
		// Non-empty DIRECTORY at the pending path → the `rm` inside writeOrUnlink
		// fails. Writing an empty entry set must still resolve, not reject.
		await rm(filePath(), { force: true });
		await mkdir(join(filePath(), "occupied"), { recursive: true });
		await expect(__writeForTest(cwd, { version: 1, entries: {} })).resolves.toBeUndefined();
	});

	// The locked re-read exists because another process can refresh the entries
	// between the optimistic read and the lock. When it has, there is nothing
	// left to prune and the load must NOT rewrite the file it just re-read.
	it("skips the prune write when a concurrent writer already refreshed the entries", async () => {
		const old = new Date(Date.now() - PUSH_PENDING_STALE_MS - 1000).toISOString();
		const fresh = new Date().toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "b", enqueuedAt: old, retryCount: 0 } },
		});

		let releaseHolder: () => void = () => {};
		let markEntered: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const holder = withPushPendingLock(cwd, async () => {
			markEntered();
			await new Promise<void>((resolve) => {
				releaseHolder = resolve;
			});
			// Stand in for the concurrent enqueue: replace the stale entry with a
			// fresh one AFTER the loader's optimistic read has already seen the
			// stale file and queued behind this lock.
			await writeFile(
				filePath(),
				JSON.stringify({
					version: 1,
					entries: { [HASH_B]: { branch: "b", enqueuedAt: fresh, retryCount: 0 } },
				}),
				"utf8",
			);
		});
		await entered;

		// Optimistic read happens here and sees the stale entry, so the loader
		// takes the lock instead of returning early.
		const loading = loadPushPending(cwd);
		await new Promise((resolve) => setTimeout(resolve, 60));
		releaseHolder();
		await holder;

		expect(Object.keys((await loading).entries)).toEqual([HASH_B]);
		// The refreshed file is left exactly as the concurrent writer wrote it.
		const onDisk = JSON.parse(await readFile(filePath(), "utf8")) as PushPendingFile;
		expect(Object.keys(onDisk.entries)).toEqual([HASH_B]);
	});

	it("reads back a valid file", async () => {
		const now = new Date().toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "feature/x", enqueuedAt: now, retryCount: 0 } },
		});
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A]).toMatchObject({ branch: "feature/x", retryCount: 0 });
	});

	it("prunes an entry older than the stale window (by enqueuedAt) and unlinks when empty", async () => {
		const old = new Date(Date.now() - PUSH_PENDING_STALE_MS - 1000).toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "b", enqueuedAt: old, retryCount: 0 } },
		});
		const file = await loadPushPending(cwd);
		expect(Object.keys(file.entries)).toHaveLength(0);
		// File unlinked once empty.
		await expect(readFile(filePath(), "utf8")).rejects.toThrow();
	});

	it("uses lastAttemptAt over enqueuedAt for staleness (fresh attempt keeps an old entry)", async () => {
		const oldEnqueue = new Date(Date.now() - PUSH_PENDING_STALE_MS - 1000).toISOString();
		const recentAttempt = new Date(Date.now() - 1000).toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: {
				[HASH_A]: { branch: "b", enqueuedAt: oldEnqueue, lastAttemptAt: recentAttempt, retryCount: 1 },
			},
		});
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A]).toBeDefined();
	});

	it("keeps an entry with a malformed anchor (NaN treated as fresh)", async () => {
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "b", enqueuedAt: "not-a-date", retryCount: 0 } },
		});
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A]).toBeDefined();
	});

	it("prunes only the stale entry, keeps the fresh one, and rewrites the file", async () => {
		const old = new Date(Date.now() - PUSH_PENDING_STALE_MS - 1000).toISOString();
		const fresh = new Date().toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: {
				[HASH_A]: { branch: "b", enqueuedAt: old, retryCount: 0 },
				[HASH_B]: { branch: "b", enqueuedAt: fresh, retryCount: 0 },
			},
		});
		const file = await loadPushPending(cwd);
		expect(Object.keys(file.entries)).toEqual([HASH_B]);
		const onDisk = JSON.parse(await readFile(filePath(), "utf8")) as PushPendingFile;
		expect(Object.keys(onDisk.entries)).toEqual([HASH_B]);
	});

	it("waits for push-pending.lock before persisting a stale prune", async () => {
		const old = new Date(Date.now() - PUSH_PENDING_STALE_MS - 1000).toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "b", enqueuedAt: old, retryCount: 0 } },
		});

		let releaseHolder: () => void = () => {};
		let markEntered: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const holder = withPushPendingLock(cwd, async () => {
			markEntered();
			await new Promise<void>((resolve) => {
				releaseHolder = resolve;
			});
		});
		await entered;

		const loading = loadPushPending(cwd);
		await new Promise((resolve) => setTimeout(resolve, 60));
		await expect(readFile(filePath(), "utf8")).resolves.toContain(HASH_A);

		releaseHolder();
		await holder;
		const file = await loading;
		expect(Object.keys(file.entries)).toHaveLength(0);
		await expect(readFile(filePath(), "utf8")).rejects.toThrow();
	});
});

describe("mergeEntries", () => {
	it("adds new hashes with retryCount 0", async () => {
		await mergeEntries(cwd, [HASH_A, HASH_B], "feature/x");
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A]).toMatchObject({ branch: "feature/x", retryCount: 0 });
		expect(file.entries[HASH_B]).toMatchObject({ branch: "feature/x", retryCount: 0 });
	});

	it("stores the remote confirmation target on a new entry", async () => {
		await mergeEntries(cwd, [HASH_A], "feature/x", TARGET);
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].pushTargets).toEqual([TARGET]);
	});

	it("preserves existing retry state for a hash already present", async () => {
		await __writeForTest(cwd, {
			version: 1,
			entries: {
				[HASH_A]: { branch: "b", enqueuedAt: new Date().toISOString(), retryCount: 2, lastError: "boom" },
			},
		});
		await mergeEntries(cwd, [HASH_A], "feature/x");
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A]).toMatchObject({ retryCount: 2, lastError: "boom", branch: "b" });
	});

	it("adds and deduplicates a remote confirmation target on existing entries", async () => {
		await mergeEntries(cwd, [HASH_A], "feature/x");
		await mergeEntries(cwd, [HASH_A], "feature/x", TARGET);
		await mergeEntries(cwd, [HASH_A], "feature/x", TARGET);

		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].pushTargets).toEqual([TARGET]);
	});

	it("no-ops on an empty hash list", async () => {
		await mergeEntries(cwd, [], "feature/x");
		await expect(readFile(filePath(), "utf8")).rejects.toThrow();
	});

	it("prunes stale entries inside the existing merge lock", async () => {
		const old = new Date(Date.now() - PUSH_PENDING_STALE_MS - 1000).toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "b", enqueuedAt: old, retryCount: 0 } },
		});

		await mergeEntries(cwd, [HASH_B], "feature/x");

		const onDisk = JSON.parse(await readFile(filePath(), "utf8")) as PushPendingFile;
		expect(Object.keys(onDisk.entries)).toEqual([HASH_B]);
	});
});

describe("updateBatch / updateEntry / deleteEntry", () => {
	beforeEach(async () => {
		await mergeEntries(cwd, [HASH_A, HASH_B], "feature/x");
	});

	it("deletes an entry", async () => {
		await deleteEntry(cwd, HASH_A);
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A]).toBeUndefined();
		expect(file.entries[HASH_B]).toBeDefined();
	});

	it("patches retryCount + lastError (truncating the error)", async () => {
		const longError = "x".repeat(PUSH_ERROR_MSG_MAX_LEN + 50);
		await updateEntry(cwd, HASH_A, {
			retryCount: 1,
			lastError: longError,
			lastAttemptAt: new Date().toISOString(),
		});
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].retryCount).toBe(1);
		expect(file.entries[HASH_A].lastError?.length).toBe(PUSH_ERROR_MSG_MAX_LEN);
	});

	it("preserves pushTargets while applying a retry patch", async () => {
		await mergeEntries(cwd, [HASH_A], "feature/x", TARGET);
		await updateEntry(cwd, HASH_A, { retryCount: 1 });

		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].pushTargets).toEqual([TARGET]);
	});

	it("clears lastError when patched with null", async () => {
		await updateEntry(cwd, HASH_A, { lastError: "boom" });
		await updateEntry(cwd, HASH_A, { lastError: null });
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].lastError).toBeUndefined();
	});

	it("records pushedDocId/pushedUrl and preserves them across later patches", async () => {
		await updateEntry(cwd, HASH_A, {
			pushedDocId: 123,
			pushedUrl: "https://acme.jolli.ai/articles?doc=123",
		});
		await updateEntry(cwd, HASH_A, { retryCount: 1, lastError: "boom" });

		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A]).toMatchObject({
			pushedDocId: 123,
			pushedUrl: "https://acme.jolli.ai/articles?doc=123",
			retryCount: 1,
			lastError: "boom",
		});
	});

	it("ignores updates for hashes no longer present", async () => {
		await deleteEntry(cwd, HASH_A);
		await updateEntry(cwd, HASH_A, { retryCount: 5 }); // gone — no-op
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A]).toBeUndefined();
	});

	it("applies a mixed delete + patch batch and unlinks when all removed", async () => {
		await updateBatch(
			cwd,
			new Map([
				[HASH_A, { kind: "delete" }],
				[HASH_B, { kind: "delete" }],
			]),
		);
		await expect(readFile(filePath(), "utf8")).rejects.toThrow();
	});

	it("no-ops on an empty update map", async () => {
		await updateBatch(cwd, new Map());
		const file = await loadPushPending(cwd);
		expect(Object.keys(file.entries)).toHaveLength(2);
	});

	it("survives concurrent mergeEntries without losing updates (lock + re-read)", async () => {
		const hashes = Array.from({ length: 6 }, (_, i) => String(i).repeat(40).slice(0, 40));
		await Promise.all(hashes.map((h) => mergeEntries(cwd, [h], "feature/x")));
		const file = await loadPushPending(cwd);
		// The two from beforeEach plus the six new = 8 distinct entries.
		expect(Object.keys(file.entries).length).toBe(8);
	});
});

describe("renewClaims", () => {
	const seed = async (over: Record<string, unknown> = {}) => {
		const now = new Date().toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "feature/x", enqueuedAt: now, retryCount: 0, ...over } },
		});
	};

	it("refreshes a claim this drain still holds and returns the new token", async () => {
		await seed();
		const claim = await claimForPush(cwd, [HASH_A]);
		const renewed = await renewClaims(cwd, [HASH_A], claim.claimedAt);
		expect(renewed).toBeDefined();
		// A same-millisecond renewal legitimately produces an identical stamp, so
		// the contract is "never goes backwards", not "always differs".
		expect(Date.parse(renewed as string)).toBeGreaterThanOrEqual(Date.parse(claim.claimedAt));
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].claimedAt).toBe(renewed);
	});

	it("leaves a claim someone else took over untouched", async () => {
		// `claimedAt` carries no holder identity, so a stale-but-fresh check would
		// happily renew THEIR claim and put both processes on the same commit.
		await seed();
		const claim = await claimForPush(cwd, [HASH_A]);
		const theirs = new Date(Date.now() + 1000).toISOString();
		await updateEntry(cwd, HASH_A, {});
		await __writeForTest(cwd, {
			version: 1,
			entries: {
				[HASH_A]: {
					branch: "feature/x",
					enqueuedAt: new Date().toISOString(),
					retryCount: 0,
					claimedAt: theirs,
				},
			},
		});
		const renewed = await renewClaims(cwd, [HASH_A], claim.claimedAt);
		expect(renewed).toBeUndefined();
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].claimedAt).toBe(theirs);
	});

	it("ignores entries with no claim at all", async () => {
		await seed();
		const renewed = await renewClaims(cwd, [HASH_A], new Date().toISOString());
		expect(renewed).toBeUndefined();
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].claimedAt).toBeUndefined();
	});

	it("ignores hashes that are no longer pending", async () => {
		const renewed = await renewClaims(cwd, [HASH_A], new Date().toISOString());
		expect(renewed).toBeUndefined();
	});

	it("no-ops on an empty hash list without touching the file", async () => {
		await expect(renewClaims(cwd, [], new Date().toISOString())).resolves.toBeUndefined();
	});

	it("beats the claim TTL with room for a missed beat", async () => {
		// The heartbeat only protects a long drain while it stays comfortably
		// inside the TTL; a half-TTL interval would retry exactly on the boundary.
		expect(CLAIM_RENEW_INTERVAL_MS * 2).toBeLessThan(5 * 60 * 1000);
	});
});

describe("claimForPush", () => {
	it("returns empty when there are no candidates", async () => {
		const r = await claimForPush(cwd, []);
		expect(r.claimed.size).toBe(0);
	});

	it("claims fresh entries and stamps claimedAt on disk", async () => {
		const now = new Date().toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "feature/x", enqueuedAt: now, retryCount: 0 } },
		});
		const r = await claimForPush(cwd, [HASH_A]);
		expect(r.claimed.has(HASH_A)).toBe(true);
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].claimedAt).toBeDefined();
	});

	it("skips an entry already claimed by another process within the stale window", async () => {
		const now = new Date().toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: {
				[HASH_A]: { branch: "feature/x", enqueuedAt: now, retryCount: 0, claimedAt: now },
			},
		});
		const r = await claimForPush(cwd, [HASH_A]);
		expect(r.claimed.has(HASH_A)).toBe(false);
	});

	it("reclaims an entry whose claim has gone stale (crashed process)", async () => {
		const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // > 5 min stale window
		const now = new Date().toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: {
				[HASH_A]: { branch: "feature/x", enqueuedAt: now, retryCount: 0, claimedAt: stale },
			},
		});
		const r = await claimForPush(cwd, [HASH_A]);
		expect(r.claimed.has(HASH_A)).toBe(true);
	});

	it("only one of two concurrent claimForPush calls acquires a given hash", async () => {
		const now = new Date().toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "feature/x", enqueuedAt: now, retryCount: 0 } },
		});
		const [r1, r2] = await Promise.all([claimForPush(cwd, [HASH_A]), claimForPush(cwd, [HASH_A])]);
		expect(r1.claimed.has(HASH_A) !== r2.claimed.has(HASH_A)).toBe(true);
	});

	it("silently skips a hash that has no pending entry", async () => {
		const r = await claimForPush(cwd, [HASH_A]);
		expect(r.claimed.has(HASH_A)).toBe(false);
	});

	it("updateBatch clears claimedAt when patching an entry so retries are unblocked", async () => {
		const now = new Date().toISOString();
		await __writeForTest(cwd, {
			version: 1,
			entries: { [HASH_A]: { branch: "feature/x", enqueuedAt: now, retryCount: 0, claimedAt: now } },
		});
		await updateEntry(cwd, HASH_A, { retryCount: 1, lastError: "boom" });
		const file = await loadPushPending(cwd);
		expect(file.entries[HASH_A].claimedAt).toBeUndefined();
		expect(file.entries[HASH_A].retryCount).toBe(1);
	});
});

describe("truncateError", () => {
	it("leaves short strings untouched", () => {
		expect(truncateError("short")).toBe("short");
	});
	it("truncates and appends an ellipsis for long strings", () => {
		const out = truncateError("y".repeat(PUSH_ERROR_MSG_MAX_LEN + 10));
		expect(out.length).toBe(PUSH_ERROR_MSG_MAX_LEN);
		expect(out.endsWith("…")).toBe(true);
	});
});
