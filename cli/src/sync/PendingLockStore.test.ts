/**
 * Tests for `PendingLockStore` — the persistence layer that lets the
 * sync engine attribute a 423 vault_locked to "this device's prior
 * round" vs "another device". File schema, account-switch invalidation,
 * and resilience to corrupt input are the load-bearing properties.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomeDir } = vi.hoisted(() => ({
	mockHomeDir: { value: "" },
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: () => mockHomeDir.value };
});

import { clearPendingLock, readPendingLock, writePendingLock } from "./PendingLockStore.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pendinglock-"));
	mockHomeDir.value = tempDir;
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("PendingLockStore", () => {
	it("returns null when the file does not exist", async () => {
		expect(await readPendingLock("sk-jol-anything")).toBeNull();
	});

	it("round-trips a write through read", async () => {
		const before = Date.now();
		await writePendingLock("sk-jol-key-A", "lock-token-1");
		const after = Date.now();
		const got = await readPendingLock("sk-jol-key-A");
		expect(got).not.toBeNull();
		expect(got?.lockOwnerToken).toBe("lock-token-1");
		// `mintedAt` defaults to `Date.now()` at write time.
		expect(got?.mintedAt).toBeGreaterThanOrEqual(before);
		expect(got?.mintedAt).toBeLessThanOrEqual(after);
	});

	it("scopes entries by api-key hash — a different key reads null", async () => {
		// Account-switch invariant: a stale entry from user A must not
		// leak into user B's 423 attribution. The hash prefix is the
		// guard; corrupting either side would breach the invariant.
		await writePendingLock("sk-jol-userA", "tokenA");
		expect(await readPendingLock("sk-jol-userB")).toBeNull();
		expect((await readPendingLock("sk-jol-userA"))?.lockOwnerToken).toBe("tokenA");
	});

	it("overwrites an existing entry on second write", async () => {
		await writePendingLock("sk-jol-key", "first", 1_000);
		await writePendingLock("sk-jol-key", "second", 2_000);
		const got = await readPendingLock("sk-jol-key");
		expect(got?.lockOwnerToken).toBe("second");
		expect(got?.mintedAt).toBe(2_000);
	});

	it("clear removes the entry", async () => {
		await writePendingLock("sk-jol-key", "token");
		await clearPendingLock();
		expect(await readPendingLock("sk-jol-key")).toBeNull();
	});

	it("clear is a no-op when the file is already absent", async () => {
		await expect(clearPendingLock()).resolves.toBeUndefined();
	});

	it("returns null on corrupt JSON rather than throwing", async () => {
		const path = join(tempDir, ".jolli", "jollimemory", "pending-lock.json");
		await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
		await writeFile(path, "{this is not} json");
		expect(await readPendingLock("sk-jol-key")).toBeNull();
	});

	it("returns null on an unknown version", async () => {
		const path = join(tempDir, ".jolli", "jollimemory", "pending-lock.json");
		await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
		await writeFile(path, JSON.stringify({ version: 99, keyHash: "x", lockOwnerToken: "y", mintedAt: 1 }));
		expect(await readPendingLock("sk-jol-key")).toBeNull();
	});

	it("returns null when required fields are missing or wrong-typed", async () => {
		const path = join(tempDir, ".jolli", "jollimemory", "pending-lock.json");
		await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
		// Missing `lockOwnerToken`.
		await writeFile(path, JSON.stringify({ version: 1, keyHash: "x", mintedAt: 1 }));
		expect(await readPendingLock("sk-jol-key")).toBeNull();
		// Wrong-typed `mintedAt`.
		await writeFile(
			path,
			JSON.stringify({ version: 1, keyHash: "x", lockOwnerToken: "y", mintedAt: "not-a-number" }),
		);
		expect(await readPendingLock("sk-jol-key")).toBeNull();
	});

	it("returns null when the parsed JSON is `null` (covers the `parsed === null` guard)", async () => {
		const path = join(tempDir, ".jolli", "jollimemory", "pending-lock.json");
		await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
		await writeFile(path, "null");
		expect(await readPendingLock("sk-jol-key")).toBeNull();
	});

	it("returns null when the parsed JSON is an array (covers the `Array.isArray` guard)", async () => {
		const path = join(tempDir, ".jolli", "jollimemory", "pending-lock.json");
		await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
		await writeFile(path, "[1,2,3]");
		expect(await readPendingLock("sk-jol-key")).toBeNull();
	});

	it("read returns null and logs when the path exists as a directory (non-ENOENT errno)", async () => {
		// Forcing readFile into a non-ENOENT branch (EISDIR here) without
		// hostile filesystem permissions: create a directory at the file's
		// own path so `readFile(path)` fails with EISDIR, exercising the
		// "log.warn + treat as absent" arm.
		const path = join(tempDir, ".jolli", "jollimemory", "pending-lock.json");
		await mkdir(path, { recursive: true });
		expect(await readPendingLock("sk-jol-key")).toBeNull();
	});

	it("clear returns and logs when unlink fails with a non-ENOENT errno", async () => {
		// Same trick: a directory at the target path makes `unlink(path)`
		// fail with EISDIR / EPERM (platform-dependent), driving the
		// non-ENOENT log branch without filesystem permission tricks.
		const path = join(tempDir, ".jolli", "jollimemory", "pending-lock.json");
		await mkdir(path, { recursive: true });
		await expect(clearPendingLock()).resolves.toBeUndefined();
	});
});
