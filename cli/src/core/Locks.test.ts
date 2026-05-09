import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Re-export node:fs/promises through a mock so individual tests can `vi.spyOn`
// specific members (ESM exports are not configurable by default).
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original };
});

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import {
	acquireOrphanWriteLock,
	acquireWorkerLock,
	DEFAULT_ORPHAN_WRITE_POLL_MS,
	isWorkerLockHeld,
	isWorkerLockStale,
	LOCK_TIMEOUT_MS,
	ORPHAN_WRITE_LOCK_FILE,
	refreshWorkerLockMtime,
	releaseOrphanWriteLock,
	releaseWorkerLock,
	WORKER_LOCK_FILE,
} from "./Locks.js";

describe("Locks", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jollimemory-locks-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	describe("worker.lock — fail-fast", () => {
		it("acquires and releases", async () => {
			expect(await acquireWorkerLock(tempDir)).toBe(true);
			await releaseWorkerLock(tempDir);
			expect(await acquireWorkerLock(tempDir)).toBe(true);
			await releaseWorkerLock(tempDir);
		});

		it("a second acquire returns false immediately while held", async () => {
			expect(await acquireWorkerLock(tempDir)).toBe(true);
			expect(await acquireWorkerLock(tempDir)).toBe(false);
			await releaseWorkerLock(tempDir);
		});

		it("reclaims a stale lock (older than LOCK_TIMEOUT_MS) and acquires", async () => {
			expect(await acquireWorkerLock(tempDir)).toBe(true);
			const lockPath = join(tempDir, ".jolli", "jollimemory", WORKER_LOCK_FILE);
			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(lockPath, past, past);
			expect(await acquireWorkerLock(tempDir)).toBe(true);
			await releaseWorkerLock(tempDir);
		});

		it("returns false when writeFile fails (race condition)", async () => {
			const fsPromises = await import("node:fs/promises");
			const writeSpy = vi.spyOn(fsPromises, "writeFile").mockRejectedValueOnce(new Error("EEXIST"));
			expect(await acquireWorkerLock(tempDir)).toBe(false);
			writeSpy.mockRestore();
		});

		it("releaseWorkerLock swallows filesystem errors", async () => {
			const fsPromises = await import("node:fs/promises");
			const rmSpy = vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(new Error("EACCES"));
			await expect(releaseWorkerLock(tempDir)).resolves.toBeUndefined();
			rmSpy.mockRestore();
		});
	});

	describe("isWorkerLockHeld / isWorkerLockStale", () => {
		it("isWorkerLockHeld returns false when no lock exists", async () => {
			expect(await isWorkerLockHeld(tempDir)).toBe(false);
		});

		it("isWorkerLockHeld returns true when worker.lock is fresh", async () => {
			await acquireWorkerLock(tempDir);
			expect(await isWorkerLockHeld(tempDir)).toBe(true);
			await releaseWorkerLock(tempDir);
		});

		it("isWorkerLockHeld returns false after release", async () => {
			await acquireWorkerLock(tempDir);
			await releaseWorkerLock(tempDir);
			expect(await isWorkerLockHeld(tempDir)).toBe(false);
		});

		it("isWorkerLockHeld is NOT influenced by orphan-write.lock", async () => {
			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			expect(await isWorkerLockHeld(tempDir)).toBe(false);
			await releaseOrphanWriteLock(tempDir);
		});

		it("isWorkerLockStale returns false when no lock exists", async () => {
			expect(await isWorkerLockStale(tempDir)).toBe(false);
		});

		it("isWorkerLockStale returns false for a fresh lock", async () => {
			await acquireWorkerLock(tempDir);
			expect(await isWorkerLockStale(tempDir)).toBe(false);
			await releaseWorkerLock(tempDir);
		});

		it("isWorkerLockStale returns true when lock is older than LOCK_TIMEOUT_MS", async () => {
			await acquireWorkerLock(tempDir);
			const lockPath = join(tempDir, ".jolli", "jollimemory", WORKER_LOCK_FILE);
			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(lockPath, past, past);
			expect(await isWorkerLockStale(tempDir)).toBe(true);
			await releaseWorkerLock(tempDir);
		});
	});

	describe("refreshWorkerLockMtime", () => {
		it("bumps the lock's mtime so a long-lived worker is not reaped", async () => {
			await acquireWorkerLock(tempDir);
			const lockPath = join(tempDir, ".jolli", "jollimemory", WORKER_LOCK_FILE);

			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(lockPath, past, past);
			expect(await isWorkerLockStale(tempDir)).toBe(true);

			await refreshWorkerLockMtime(tempDir);
			expect(await isWorkerLockStale(tempDir)).toBe(false);
			expect(await isWorkerLockHeld(tempDir)).toBe(true);

			await releaseWorkerLock(tempDir);
		});

		it("silently no-ops when the lock file is missing", async () => {
			await expect(refreshWorkerLockMtime(tempDir)).resolves.toBeUndefined();
		});
	});

	describe("orphan-write.lock — timeout-with-poll", () => {
		it("acquires and releases", async () => {
			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			await releaseOrphanWriteLock(tempDir);
			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			await releaseOrphanWriteLock(tempDir);
		});

		it("a second acquire waits for the first holder, then succeeds", async () => {
			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);

			// Schedule a release ~80 ms in the future, then race a new acquire
			// with a 1 s budget. With a 50 ms poll the second call sees the
			// release within ~one poll and returns true.
			const releasedAt = setTimeout(() => {
				void releaseOrphanWriteLock(tempDir);
			}, 80);

			const start = Date.now();
			const acquired = await acquireOrphanWriteLock(tempDir, { timeoutMs: 1000, pollMs: 25 });
			const elapsed = Date.now() - start;
			clearTimeout(releasedAt);

			expect(acquired).toBe(true);
			expect(elapsed).toBeLessThan(500);
			await releaseOrphanWriteLock(tempDir);
		});

		it("returns false after timeoutMs when the lock stays held", async () => {
			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);

			const start = Date.now();
			const acquired = await acquireOrphanWriteLock(tempDir, { timeoutMs: 150, pollMs: 25 });
			const elapsed = Date.now() - start;

			expect(acquired).toBe(false);
			expect(elapsed).toBeGreaterThanOrEqual(140);
			await releaseOrphanWriteLock(tempDir);
		});

		it("falls back to the default poll interval when pollMs is omitted", async () => {
			// Sanity check that the constant is small enough to avoid flaky tests.
			expect(DEFAULT_ORPHAN_WRITE_POLL_MS).toBeLessThanOrEqual(100);

			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			const acquired = await acquireOrphanWriteLock(tempDir, { timeoutMs: 80 });
			expect(acquired).toBe(false);
			await releaseOrphanWriteLock(tempDir);
		});

		it("reclaims a stale orphan-write lock", async () => {
			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			const lockPath = join(tempDir, ".jolli", "jollimemory", ORPHAN_WRITE_LOCK_FILE);
			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(lockPath, past, past);
			expect(await acquireOrphanWriteLock(tempDir, { timeoutMs: 100 })).toBe(true);
			await releaseOrphanWriteLock(tempDir);
		});

		it("releaseOrphanWriteLock swallows filesystem errors", async () => {
			const fsPromises = await import("node:fs/promises");
			const rmSpy = vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(new Error("EACCES"));
			await expect(releaseOrphanWriteLock(tempDir)).resolves.toBeUndefined();
			rmSpy.mockRestore();
		});
	});

	describe("worker.lock and orphan-write.lock are independent", () => {
		it("can hold both simultaneously", async () => {
			expect(await acquireWorkerLock(tempDir)).toBe(true);
			expect(await acquireOrphanWriteLock(tempDir, { timeoutMs: 100 })).toBe(true);

			const dir = join(tempDir, ".jolli", "jollimemory");
			expect((await stat(join(dir, WORKER_LOCK_FILE))).isFile()).toBe(true);
			expect((await stat(join(dir, ORPHAN_WRITE_LOCK_FILE))).isFile()).toBe(true);

			await releaseOrphanWriteLock(tempDir);
			await releaseWorkerLock(tempDir);
		});

		it("acquireOrphanWriteLock with worker.lock present still succeeds (lock files don't share state)", async () => {
			expect(await acquireWorkerLock(tempDir)).toBe(true);
			expect(await acquireOrphanWriteLock(tempDir, { timeoutMs: 100 })).toBe(true);
			await releaseOrphanWriteLock(tempDir);
			await releaseWorkerLock(tempDir);
		});

		it("isWorkerLockHeld ignores a stale worker.lock + fresh orphan-write.lock", async () => {
			// Plant a stale worker.lock the way a crashed worker would leave it.
			const dir = join(tempDir, ".jolli", "jollimemory");
			const fsPromises = await import("node:fs/promises");
			await fsPromises.mkdir(dir, { recursive: true });
			const stalePath = join(dir, WORKER_LOCK_FILE);
			await writeFile(stalePath, "12345", "utf-8");
			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(stalePath, past, past);

			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			expect(await isWorkerLockHeld(tempDir)).toBe(false);
			await releaseOrphanWriteLock(tempDir);
		});
	});
});
