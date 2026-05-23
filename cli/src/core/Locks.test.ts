import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Re-export node:fs/promises through a mock so individual tests can `vi.spyOn`
// specific members (ESM exports are not configurable by default).
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return { ...original };
});

// Same trick for the Subprocess wrapper — needed by the fallback-path test,
// which forces `git rev-parse` to fail to exercise the per-worktree fallback.
// Locks.ts calls `Subprocess.execFileAsyncHidden`, so we spy on this module.
vi.mock("../util/Subprocess.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../util/Subprocess.js")>();
	return { ...original };
});

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import {
	__resetSharedLockDirCache,
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

/**
 * Worker lock dir = per-worktree (`<cwd>/.jolli/jollimemory/`).
 * Same path regardless of git presence.
 */
function workerLockPath(tempDir: string): string {
	return join(tempDir, ".jolli", "jollimemory", WORKER_LOCK_FILE);
}

/**
 * Orphan-write lock dir = `<git-common-dir>/jollimemory/` when the cwd is
 * inside a git repo. The default test setup does `git init` in the tempdir,
 * so the common dir is `<tempDir>/.git`.
 */
function orphanWriteLockPath(tempDir: string): string {
	return join(tempDir, ".git", "jollimemory", ORPHAN_WRITE_LOCK_FILE);
}

describe("Locks", () => {
	let tempDir: string;

	// `git init` per test would spawn ~30 subprocesses across this file, which
	// has been observed to push the v8-coverage worker pool over its memory
	// budget on Windows CI. Init once per file and clean lock files between
	// tests instead — each test still observes a fresh lock state, just inside
	// the same git repo.
	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jollimemory-locks-"));
		execFileSync("git", ["init", "--quiet"], { cwd: tempDir, stdio: "ignore" });
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		__resetSharedLockDirCache();
		// Clean any lock file that an earlier test left behind so each test
		// starts with both locks definitively unheld. `force: true` covers the
		// usual "file does not exist" case.
		await rm(join(tempDir, ".jolli", "jollimemory", WORKER_LOCK_FILE), { force: true });
		await rm(join(tempDir, ".git", "jollimemory", ORPHAN_WRITE_LOCK_FILE), { force: true });
	});

	afterEach(async () => {
		__resetSharedLockDirCache();
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
			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(workerLockPath(tempDir), past, past);
			expect(await acquireWorkerLock(tempDir)).toBe(true);
			await releaseWorkerLock(tempDir);
		});

		it("reclaims an orphaned lock whose owner PID is dead, even if mtime is fresh", async () => {
			// Simulate a crashed-without-release: write a PID that definitely
			// doesn't exist (huge number, virtually never reused) without
			// advancing mtime. Previously the next acquirer had to wait the
			// full LOCK_TIMEOUT_MS; with the PID liveness check it reclaims
			// immediately.
			const fsPromises = await import("node:fs/promises");
			await fsPromises.writeFile(workerLockPath(tempDir), "9999999", "utf-8");
			expect(await acquireWorkerLock(tempDir)).toBe(true);
			await releaseWorkerLock(tempDir);
		});

		it("does NOT reclaim a lock whose owner PID is alive (us), regardless of fresh mtime", async () => {
			// Write our own PID; acquireWorkerLock should fail because we
			// (the current process) are alive, even though the lock is
			// "owned" by the same process. This guards against reentrant
			// double-acquire by the same worker.
			const fsPromises = await import("node:fs/promises");
			await fsPromises.writeFile(workerLockPath(tempDir), String(process.pid), "utf-8");
			expect(await acquireWorkerLock(tempDir)).toBe(false);
			// Cleanup so afterEach doesn't see a leftover file.
			await fsPromises.rm(workerLockPath(tempDir), { force: true });
		});

		it("returns false when writeFile fails (race condition)", async () => {
			const fsPromises = await import("node:fs/promises");
			const writeSpy = vi.spyOn(fsPromises, "writeFile").mockRejectedValueOnce(new Error("EEXIST"));
			expect(await acquireWorkerLock(tempDir)).toBe(false);
			writeSpy.mockRestore();
		});

		it("releaseWorkerLock swallows filesystem errors", async () => {
			// Take the lock first so the PID check passes and we get to rm().
			await acquireWorkerLock(tempDir);
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
			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(workerLockPath(tempDir), past, past);
			expect(await isWorkerLockStale(tempDir)).toBe(true);
			await releaseWorkerLock(tempDir);
		});
	});

	describe("refreshWorkerLockMtime", () => {
		it("bumps the lock's mtime so a long-lived worker is not reaped", async () => {
			await acquireWorkerLock(tempDir);
			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(workerLockPath(tempDir), past, past);
			expect(await isWorkerLockStale(tempDir)).toBe(true);

			await refreshWorkerLockMtime(tempDir);
			expect(await isWorkerLockStale(tempDir)).toBe(false);
			expect(await isWorkerLockHeld(tempDir)).toBe(true);

			await releaseWorkerLock(tempDir);
		});

		it("silently no-ops when the lock file is missing", async () => {
			await expect(refreshWorkerLockMtime(tempDir)).resolves.toBeUndefined();
		});

		// PID-ownership guard: if a stale-reclaim race put a different process's
		// PID into our worker.lock, refreshing the mtime would let the other
		// process's stale-reclaim window get extended on our behalf.
		it("does not bump mtime when the lock is owned by a different PID", async () => {
			// Simulate a different owner: write a foreign PID into worker.lock and
			// backdate it so the test can detect any unwanted mtime bump.
			const lockPath = workerLockPath(tempDir);
			const fsPromises = await import("node:fs/promises");
			await fsPromises.mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(lockPath, "999999", "utf-8");
			const backdated = new Date(Date.now() - 2 * LOCK_TIMEOUT_MS);
			await utimes(lockPath, backdated, backdated);

			await refreshWorkerLockMtime(tempDir);

			// mtime should NOT have been advanced — the lock isn't ours.
			const after = await stat(lockPath);
			expect(Math.abs(after.mtimeMs - backdated.getTime())).toBeLessThan(1000);
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
			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(orphanWriteLockPath(tempDir), past, past);
			expect(await acquireOrphanWriteLock(tempDir, { timeoutMs: 100 })).toBe(true);
			await releaseOrphanWriteLock(tempDir);
		});

		it("releaseOrphanWriteLock swallows filesystem errors", async () => {
			await acquireOrphanWriteLock(tempDir);
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

			expect((await stat(workerLockPath(tempDir))).isFile()).toBe(true);
			expect((await stat(orphanWriteLockPath(tempDir))).isFile()).toBe(true);

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
			const fsPromises = await import("node:fs/promises");
			await fsPromises.mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			const stalePath = workerLockPath(tempDir);
			await writeFile(stalePath, "12345", "utf-8");
			const past = new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000);
			await utimes(stalePath, past, past);

			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			expect(await isWorkerLockHeld(tempDir)).toBe(false);
			await releaseOrphanWriteLock(tempDir);
		});
	});

	// ── PID ownership on release ────────────────────────────────────────────
	//
	// Stale-reclaim race the PID check guards against:
	//   1. Process A acquires lock (mtime t0)
	//   2. A blocks long enough that age ≥ LOCK_TIMEOUT_MS
	//   3. Process B's tryAcquireOnce removes A's lock and writes its own PID
	//   4. A wakes up and runs its `finally { releaseLock }` block
	//   5. Without the PID check: A would `rm` B's lock → C arrives → no lock
	//      visible → C acquires → B and C now both write concurrently.
	// The check makes step 5 a no-op.
	describe("PID ownership on release", () => {
		it("worker.lock release skips rm when the file's PID is not ours", async () => {
			const lockPath = workerLockPath(tempDir);
			const fsPromises = await import("node:fs/promises");
			await fsPromises.mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			// Plant a foreign PID into the worker lock — emulates the post-reclaim state.
			const foreignPid = String(process.pid + 1);
			await writeFile(lockPath, foreignPid, "utf-8");

			await releaseWorkerLock(tempDir);

			// File must still be there (not removed by us).
			const after = await stat(lockPath);
			expect(after.isFile()).toBe(true);
		});

		it("worker.lock release removes the file when the PID matches us", async () => {
			await acquireWorkerLock(tempDir);
			await releaseWorkerLock(tempDir);
			await expect(stat(workerLockPath(tempDir))).rejects.toThrow();
		});

		it("worker.lock release is a no-op when the file is missing (idempotent)", async () => {
			await expect(releaseWorkerLock(tempDir)).resolves.toBeUndefined();
		});

		it("orphan-write.lock release skips rm when the file's PID is not ours", async () => {
			const fsPromises = await import("node:fs/promises");
			await fsPromises.mkdir(join(tempDir, ".git", "jollimemory"), { recursive: true });
			const lockPath = orphanWriteLockPath(tempDir);
			const foreignPid = String(process.pid + 1);
			await writeFile(lockPath, foreignPid, "utf-8");

			await releaseOrphanWriteLock(tempDir);

			const after = await stat(lockPath);
			expect(after.isFile()).toBe(true);
		});

		it("orphan-write.lock release removes the file when the PID matches us", async () => {
			await acquireOrphanWriteLock(tempDir);
			await releaseOrphanWriteLock(tempDir);
			await expect(stat(orphanWriteLockPath(tempDir))).rejects.toThrow();
		});
	});

	// ── git-common-dir resolution ──────────────────────────────────────────
	//
	// orphan-write.lock must live at `<git-common-dir>/jollimemory/` so all
	// worktrees of the same repository serialize on the same lock file. The
	// default beforeEach has `git init`'d the tempdir, so the common dir is
	// <tempDir>/.git/. Both the file's actual location and a (non-init'd)
	// fallback path are exercised here.
	describe("orphan-write.lock path resolution", () => {
		it("places the lock at <git-common-dir>/jollimemory/ when cwd is inside a git repo", async () => {
			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			const expected = join(tempDir, ".git", "jollimemory", ORPHAN_WRITE_LOCK_FILE);
			expect((await stat(expected)).isFile()).toBe(true);
			await releaseOrphanWriteLock(tempDir);
		});

		it("falls back to <cwd>/.jolli/jollimemory/ when git rev-parse fails", async () => {
			// Force the resolver into the catch path by making the Subprocess
			// wrapper reject. Tests run with `mkdtemp` so the cache hasn't seen
			// tempDir yet — but reset to be safe in case a previous it-block
			// populated it.
			__resetSharedLockDirCache();
			const Subprocess = await import("../util/Subprocess.js");
			const execSpy = vi
				.spyOn(Subprocess, "execFileAsyncHidden")
				.mockRejectedValue(new Error("simulated: git not found"));

			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			const fallback = join(tempDir, ".jolli", "jollimemory", ORPHAN_WRITE_LOCK_FILE);
			expect((await stat(fallback)).isFile()).toBe(true);
			await releaseOrphanWriteLock(tempDir);

			execSpy.mockRestore();
			__resetSharedLockDirCache();
		});

		it("caches the resolved path so repeated polls don't spawn git on every iteration", async () => {
			__resetSharedLockDirCache();
			const Subprocess = await import("../util/Subprocess.js");
			const execSpy = vi.spyOn(Subprocess, "execFileAsyncHidden");

			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			await releaseOrphanWriteLock(tempDir);
			const callsAfterFirstAcquire = execSpy.mock.calls.length;

			// Multiple subsequent acquire/release cycles must hit the cache (zero
			// additional `git rev-parse` invocations).
			for (let i = 0; i < 5; i++) {
				await acquireOrphanWriteLock(tempDir);
				await releaseOrphanWriteLock(tempDir);
			}
			expect(execSpy.mock.calls.length).toBe(callsAfterFirstAcquire);

			execSpy.mockRestore();
		});

		// `acquireOrphanWriteLock()` with no `cwd` argument is the production
		// call shape for callers that don't track the project root explicitly.
		// Exercises the `cwd ?? process.cwd()` right-hand branch.
		it("uses process.cwd() when cwd argument is omitted", async () => {
			__resetSharedLockDirCache();
			const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);

			expect(await acquireOrphanWriteLock()).toBe(true);
			const expected = join(tempDir, ".git", "jollimemory", ORPHAN_WRITE_LOCK_FILE);
			expect((await stat(expected)).isFile()).toBe(true);
			await releaseOrphanWriteLock();

			cwdSpy.mockRestore();
			__resetSharedLockDirCache();
		});

		// `git rev-parse --git-common-dir` returns an absolute path for linked
		// worktrees. Exercises the `isAbsolute(commonDir) ? commonDir : …`
		// true branch — local macOS/Linux `git init` returns ".git" so this is
		// only reachable through a mock.
		it("uses the absolute common dir directly when git returns one", async () => {
			__resetSharedLockDirCache();
			const absoluteCommonDir = join(tempDir, ".git");
			const Subprocess = await import("../util/Subprocess.js");
			const execSpy = vi
				.spyOn(Subprocess, "execFileAsyncHidden")
				.mockResolvedValue({ stdout: `${absoluteCommonDir}\n`, stderr: "" });

			expect(await acquireOrphanWriteLock(tempDir)).toBe(true);
			const expected = join(absoluteCommonDir, "jollimemory", ORPHAN_WRITE_LOCK_FILE);
			expect((await stat(expected)).isFile()).toBe(true);
			await releaseOrphanWriteLock(tempDir);

			execSpy.mockRestore();
			__resetSharedLockDirCache();
		});
	});

	describe("readLockOwnerPid edge cases", () => {
		// `pid.length > 0 ? pid : null` — exercises the empty-PID branch where
		// readLockOwnerPid returns null even though the lock file exists. The
		// release path then falls through to rm (treating "unowned" as "ours").
		it("treats an empty lock file as unowned and removes it on release", async () => {
			const fsPromises = await import("node:fs/promises");
			await fsPromises.mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			const lockPath = workerLockPath(tempDir);
			await writeFile(lockPath, "   \n", "utf-8");

			await releaseWorkerLock(tempDir);

			await expect(stat(lockPath)).rejects.toThrow();
		});
	});
});
