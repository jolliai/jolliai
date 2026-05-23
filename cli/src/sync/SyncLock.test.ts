/**
 * Tests for SyncLock — global per-user lock for Memory Bank sync rounds.
 *
 * `sync.lock` lives at `~/.jolli/jollimemory/sync.lock`. We mock
 * `os.homedir()` to point at a tempdir so each test gets a clean lock state.
 */

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock homedir to use temp directory ─────────────────────────────────────

const { mockHomeDir } = vi.hoisted(() => ({
	mockHomeDir: { value: "" },
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		homedir: () => mockHomeDir.value,
	};
});

// Imports must come AFTER vi.mock setup so SyncLock's `homedir()` resolves
// to the mock.
import {
	acquireSyncLock,
	DEFAULT_SYNC_LOCK_POLL_MS,
	DEFAULT_SYNC_LOCK_TIMEOUT_MS,
	getSyncLockPath,
	isSyncLockHeld,
	refreshSyncLockMtime,
	releaseSyncLock,
} from "./SyncLock.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "jollimemory-synclock-"));
	mockHomeDir.value = tempDir;
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("SyncLock", () => {
	describe("getSyncLockPath", () => {
		it("returns path under ~/.jolli/jollimemory/sync.lock", () => {
			const path = getSyncLockPath();
			expect(path).toBe(join(tempDir, ".jolli", "jollimemory", "sync.lock"));
		});

		it("honors JOLLI_SYNC_LOCK_DIR env var override (acceptance-suite isolation)", () => {
			// Plan §P3#5 — acceptance helpers set this so tests don't share
			// `~/.jolli/jollimemory/sync.lock` with the user's real VS Code /
			// CLI sync rounds. Without the override the homedir() default is
			// used.
			const prior = process.env.JOLLI_SYNC_LOCK_DIR;
			process.env.JOLLI_SYNC_LOCK_DIR = "/tmp/acceptance-tempdir";
			try {
				expect(getSyncLockPath()).toBe(join("/tmp/acceptance-tempdir", "sync.lock"));
			} finally {
				if (prior === undefined) delete process.env.JOLLI_SYNC_LOCK_DIR;
				else process.env.JOLLI_SYNC_LOCK_DIR = prior;
			}
		});

		it("treats an empty JOLLI_SYNC_LOCK_DIR as 'not set' and falls back to homedir", () => {
			const prior = process.env.JOLLI_SYNC_LOCK_DIR;
			process.env.JOLLI_SYNC_LOCK_DIR = "";
			try {
				expect(getSyncLockPath()).toBe(join(tempDir, ".jolli", "jollimemory", "sync.lock"));
			} finally {
				if (prior === undefined) delete process.env.JOLLI_SYNC_LOCK_DIR;
				else process.env.JOLLI_SYNC_LOCK_DIR = prior;
			}
		});
	});

	describe("acquireSyncLock + releaseSyncLock", () => {
		it("acquires when the parent directory does not exist", async () => {
			const ok = await acquireSyncLock({ timeoutMs: 0 });
			expect(ok).toBe(true);
			const fileStat = await stat(getSyncLockPath());
			expect(fileStat.isFile()).toBe(true);
		});

		it("releases the lock on releaseSyncLock", async () => {
			await acquireSyncLock({ timeoutMs: 0 });
			await releaseSyncLock();
			await expect(stat(getSyncLockPath())).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("rejects when another holder is fresh and timeoutMs is 0", async () => {
			// Plant a fresh lock owned by a different PID.
			const lockPath = getSyncLockPath();
			await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(lockPath, String(process.pid)); // PID unlikely to collide with ours
			const ok = await acquireSyncLock({ timeoutMs: 0 });
			expect(ok).toBe(false);
		});

		it("waits up to timeoutMs for an existing holder to release", async () => {
			// Plant a fresh lock owned by another PID; release it mid-wait.
			const lockPath = getSyncLockPath();
			await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(lockPath, String(process.pid));

			// Release after 80 ms — well within a 1 s budget.
			setTimeout(async () => {
				await rm(lockPath, { force: true });
			}, 80);

			const start = Date.now();
			const ok = await acquireSyncLock({ timeoutMs: 1000, pollMs: 30 });
			const elapsed = Date.now() - start;
			expect(ok).toBe(true);
			expect(elapsed).toBeGreaterThanOrEqual(80);
			expect(elapsed).toBeLessThan(1000);
		});

		it("returns false after timeout when holder never releases", async () => {
			const lockPath = getSyncLockPath();
			await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(lockPath, String(process.pid));

			const start = Date.now();
			const ok = await acquireSyncLock({ timeoutMs: 200, pollMs: 50 });
			const elapsed = Date.now() - start;
			expect(ok).toBe(false);
			expect(elapsed).toBeGreaterThanOrEqual(200);
		});

		it("uses default 10 s timeout when timeoutMs is omitted", async () => {
			expect(DEFAULT_SYNC_LOCK_TIMEOUT_MS).toBe(10_000);
			expect(DEFAULT_SYNC_LOCK_POLL_MS).toBe(100);

			// Exercise the default-applied path by calling without any opts. The
			// lock is uncontended so it acquires immediately — we never actually
			// wait the 10 s budget.
			const ok = await acquireSyncLock();
			expect(ok).toBe(true);
			await releaseSyncLock();
		});

		it("uses default poll interval when pollMs is omitted but timeoutMs is set", async () => {
			// Plant a stale lock so acquire will succeed via the "remove stale +
			// reacquire" path on the very first iteration — exercises the default
			// pollMs fallback without actually waiting one poll cycle.
			const lockPath = getSyncLockPath();
			await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(lockPath, String(process.pid));
			const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
			await utimes(lockPath, sixMinAgo, sixMinAgo);

			const ok = await acquireSyncLock({ timeoutMs: 500 });
			expect(ok).toBe(true);
		});

		it("releaseSyncLock skips when held by another PID (stale-reclaim race guard)", async () => {
			// Plant a lock owned by a DIFFERENT alive PID — use the parent
			// pid which is reliably alive but not us. `releaseSyncLock`
			// should refuse because the PID doesn't match ours.
			const lockPath = getSyncLockPath();
			await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(lockPath, String(process.ppid));

			await releaseSyncLock();

			// Still present.
			const fileStat = await stat(lockPath);
			expect(fileStat.isFile()).toBe(true);
		});
	});

	describe("refreshSyncLockMtime", () => {
		it("bumps mtime when the lock is owned by us", async () => {
			await acquireSyncLock({ timeoutMs: 0 });
			const lockPath = getSyncLockPath();
			// Backdate the lock to 30 s ago so a refresh produces a measurable delta.
			const past = new Date(Date.now() - 30_000);
			await utimes(lockPath, past, past);
			const before = (await stat(lockPath)).mtimeMs;

			await refreshSyncLockMtime();

			const after = (await stat(lockPath)).mtimeMs;
			expect(after).toBeGreaterThan(before);
		});

		it("skips when the lock is owned by another PID", async () => {
			// Use a DIFFERENT alive PID (parent process) — the original test
			// used 99999 which the new PID-liveness check would reclaim
			// immediately, defeating the "another PID" scenario.
			const lockPath = getSyncLockPath();
			await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(lockPath, String(process.ppid));
			const past = new Date(Date.now() - 30_000);
			await utimes(lockPath, past, past);
			const before = (await stat(lockPath)).mtimeMs;

			await refreshSyncLockMtime();

			const after = (await stat(lockPath)).mtimeMs;
			expect(after).toBe(before);
		});

		it("is best-effort when the lock file is missing", async () => {
			// No lock has been acquired. Should not throw.
			await expect(refreshSyncLockMtime()).resolves.toBeUndefined();
		});
	});

	describe("isSyncLockHeld", () => {
		it("returns false when no lock exists", async () => {
			expect(await isSyncLockHeld()).toBe(false);
		});

		it("returns true when a fresh lock is present", async () => {
			await acquireSyncLock({ timeoutMs: 0 });
			expect(await isSyncLockHeld()).toBe(true);
		});

		it("returns false for an expired (stale) lock", async () => {
			const lockPath = getSyncLockPath();
			await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
			await writeFile(lockPath, String(process.pid));
			// Backdate beyond LOCK_TIMEOUT_MS (5 min). Use 6 min to be safe.
			const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
			await utimes(lockPath, sixMinAgo, sixMinAgo);

			expect(await isSyncLockHeld()).toBe(false);
		});
	});

	describe("acquisition retains exclusivity", () => {
		it("two acquires from the same process — second returns false on fail-fast", async () => {
			const first = await acquireSyncLock({ timeoutMs: 0 });
			const second = await acquireSyncLock({ timeoutMs: 0 });
			expect(first).toBe(true);
			// Second attempt sees a fresh lock and returns false even though the PID
			// matches — `tryAcquireOnce` uses `flag: "wx"` which errors on existing
			// file regardless of owner.
			expect(second).toBe(false);
		});

		// §I16: the prior tests are all plant-and-poll single-process flows
		// that never actually race `flag: "wx"` against itself. Concurrent
		// acquires let the kernel's open(O_EXCL|O_CREAT) — what `wx` lowers
		// into — be the arbiter. Exactly one acquire must win per round.
		it("concurrent acquires across many rounds — exactly one winner each", async () => {
			const ROUNDS = 50;
			for (let i = 0; i < ROUNDS; i++) {
				const results = await Promise.all([
					acquireSyncLock({ timeoutMs: 0 }),
					acquireSyncLock({ timeoutMs: 0 }),
					acquireSyncLock({ timeoutMs: 0 }),
				]);
				const winners = results.filter((r) => r === true).length;
				expect(winners).toBe(1);
				await releaseSyncLock();
			}
		});
	});
});
