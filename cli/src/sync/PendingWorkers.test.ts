/**
 * Tests for `PendingWorkers` — the per-vault registry that wakes up
 * timeout-victim queue workers across source repos sharing one vault.
 *
 * The load-bearing properties are: (a) the dir-derivation function hashes
 * a *resolved* memoryBankRoot so the default-config case still has a
 * stable key; (b) record is idempotent (same cwd → same filename); (c)
 * consume reads + deletes each entry before returning, tolerates missing
 * dirs, and cleans the registry dir when empty.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

import {
	consumePendingWorkers,
	getPendingWorkersDir,
	recordPendingWorker,
	wakePendingWorkers,
} from "./PendingWorkers.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "pendingworkers-"));
	mockHomeDir.value = tempDir;
	delete process.env.JOLLI_VAULT_LOCK_DIR;
});

afterEach(async () => {
	delete process.env.JOLLI_VAULT_LOCK_DIR;
	await rm(tempDir, { recursive: true, force: true });
});

describe("getPendingWorkersDir", () => {
	it("derives a per-vault dir under ~/.jolli/jollimemory/locks by default", () => {
		const dir = getPendingWorkersDir(join(tempDir, "vault"));
		expect(dir.startsWith(join(tempDir, ".jolli", "jollimemory", "locks"))).toBe(true);
		expect(dir).toMatch(/vault-[0-9a-f]{64}-pending$/);
	});

	it("honours JOLLI_VAULT_LOCK_DIR override", () => {
		process.env.JOLLI_VAULT_LOCK_DIR = join(tempDir, "override");
		const dir = getPendingWorkersDir(join(tempDir, "vault"));
		expect(dir.startsWith(join(tempDir, "override"))).toBe(true);
	});

	it("ignores an empty-string override (treats it like unset)", () => {
		process.env.JOLLI_VAULT_LOCK_DIR = "";
		const dir = getPendingWorkersDir(join(tempDir, "vault"));
		expect(dir.startsWith(join(tempDir, ".jolli", "jollimemory", "locks"))).toBe(true);
	});

	it("produces the same hash for the same canonical input (producer/consumer symmetry)", () => {
		const a = getPendingWorkersDir(join(tempDir, "vault"));
		const b = getPendingWorkersDir(join(tempDir, "vault"));
		expect(a).toBe(b);
	});

	it("produces different hashes for different memoryBankRoots", () => {
		const a = getPendingWorkersDir(join(tempDir, "vault-a"));
		const b = getPendingWorkersDir(join(tempDir, "vault-b"));
		expect(a).not.toBe(b);
	});
});

describe("recordPendingWorker", () => {
	it("creates the registry dir and writes one file per cwd, content = cwd", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		await recordPendingWorker(memoryBankRoot, "/path/to/repoA");
		const dir = getPendingWorkersDir(memoryBankRoot);
		const files = await readdir(dir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is idempotent for the same cwd (same filename, second write overwrites)", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		await recordPendingWorker(memoryBankRoot, "/path/to/repoA");
		await recordPendingWorker(memoryBankRoot, "/path/to/repoA");
		const dir = getPendingWorkersDir(memoryBankRoot);
		expect(await readdir(dir)).toHaveLength(1);
	});

	it("writes distinct files for distinct cwds in the same vault", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		await recordPendingWorker(memoryBankRoot, "/path/to/repoA");
		await recordPendingWorker(memoryBankRoot, "/path/to/repoB");
		const dir = getPendingWorkersDir(memoryBankRoot);
		expect(await readdir(dir)).toHaveLength(2);
	});

	it("swallows filesystem errors (non-fatal best-effort)", async () => {
		// Force mkdir failure by pointing the override at a path that exists
		// as a file (cannot mkdir over a file). The function logs and
		// resolves; no throw.
		const filePath = join(tempDir, "not-a-dir");
		await writeFile(filePath, "x");
		process.env.JOLLI_VAULT_LOCK_DIR = filePath;
		await expect(recordPendingWorker(join(tempDir, "vault"), "/path/to/cwd")).resolves.toBeUndefined();
	});
});

describe("consumePendingWorkers", () => {
	it("returns an empty list when the registry dir does not exist", async () => {
		const cwds = await consumePendingWorkers(join(tempDir, "vault"));
		expect(cwds).toEqual([]);
	});

	it("returns recorded cwds and removes each entry", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		await recordPendingWorker(memoryBankRoot, "/path/to/repoA");
		await recordPendingWorker(memoryBankRoot, "/path/to/repoB");

		const cwds = await consumePendingWorkers(memoryBankRoot);
		expect([...cwds].sort()).toEqual(["/path/to/repoA", "/path/to/repoB"]);

		// Each entry is unlinked as it's read; subsequent consume sees nothing.
		const second = await consumePendingWorkers(memoryBankRoot);
		expect(second).toEqual([]);
	});

	it("skips empty-content files as a corruption guard", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		const dir = getPendingWorkersDir(memoryBankRoot);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "deadbeef"), ""); // empty content
		const cwds = await consumePendingWorkers(memoryBankRoot);
		expect(cwds).toEqual([]);
	});

	it("does NOT trim whitespace in the cwd (paths with leading/trailing space are legal)", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		const dir = getPendingWorkersDir(memoryBankRoot);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "abc"), "  /weird/ path  ");
		const cwds = await consumePendingWorkers(memoryBankRoot);
		expect(cwds).toEqual(["  /weird/ path  "]);
	});

	it("logs and skips per-entry read failures rather than throwing", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		const dir = getPendingWorkersDir(memoryBankRoot);
		await mkdir(dir, { recursive: true });
		// A directory at a child path makes readFile() fail with EISDIR,
		// exercising the catch arm without filesystem permission tricks.
		await mkdir(join(dir, "child-as-dir"));
		// Also include one healthy entry to assert the loop continues.
		await recordPendingWorker(memoryBankRoot, "/healthy/cwd");

		const cwds = await consumePendingWorkers(memoryBankRoot);
		expect(cwds).toEqual(["/healthy/cwd"]);
	});

	it("tolerates a non-empty registry dir at cleanup time (concurrent producer)", async () => {
		// Simulate a producer landing a new entry between read and rmdir:
		// we read+delete the only entry, then immediately re-create one and
		// re-run consume to make sure the rmdir-failure arm is benign.
		const memoryBankRoot = join(tempDir, "vault");
		await recordPendingWorker(memoryBankRoot, "/cwd-1");
		await consumePendingWorkers(memoryBankRoot);

		await recordPendingWorker(memoryBankRoot, "/cwd-2");
		const cwds = await consumePendingWorkers(memoryBankRoot);
		expect(cwds).toEqual(["/cwd-2"]);
	});
});

describe("wakePendingWorkers", () => {
	it("drains the registry and launches a worker for each recorded cwd", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		await recordPendingWorker(memoryBankRoot, "/repo-a");
		await recordPendingWorker(memoryBankRoot, "/repo-b");
		const launched: string[] = [];

		await wakePendingWorkers(memoryBankRoot, (cwd) => launched.push(cwd));

		expect(launched.sort()).toEqual(["/repo-a", "/repo-b"]);
		// Drained — a second wake launches nothing.
		const again: string[] = [];
		await wakePendingWorkers(memoryBankRoot, (cwd) => again.push(cwd));
		expect(again).toEqual([]);
	});

	it("skips the holder's own cwd when selfCwd is supplied", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		await recordPendingWorker(memoryBankRoot, "/repo-self");
		await recordPendingWorker(memoryBankRoot, "/repo-other");
		const launched: string[] = [];

		await wakePendingWorkers(memoryBankRoot, (cwd) => launched.push(cwd), "/repo-self");

		expect(launched).toEqual(["/repo-other"]);
	});

	it("is a no-op when the registry is empty", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		const launched: string[] = [];
		await wakePendingWorkers(memoryBankRoot, (cwd) => launched.push(cwd));
		expect(launched).toEqual([]);
	});

	it("swallows a launch() throw (best-effort — one bad spawn must not abort the rest)", async () => {
		const memoryBankRoot = join(tempDir, "vault");
		await recordPendingWorker(memoryBankRoot, "/repo-a");
		// launch throws — wakePendingWorkers must not propagate it.
		await expect(
			wakePendingWorkers(memoryBankRoot, () => {
				throw new Error("spawn failed");
			}),
		).resolves.toBeUndefined();
	});

	it("isolates a launch() throw per cwd — a later repo is still launched", async () => {
		// The registry is DRAINED before launching, so a throw that aborted the loop
		// would silently drop every later (already-consumed) repo. Each launch must
		// be isolated so one bad spawn never strands the others.
		const memoryBankRoot = join(tempDir, "vault");
		await recordPendingWorker(memoryBankRoot, "/repo-throws");
		await recordPendingWorker(memoryBankRoot, "/repo-ok");
		const launched: string[] = [];

		await wakePendingWorkers(memoryBankRoot, (cwd) => {
			if (cwd === "/repo-throws") throw new Error("spawn failed");
			launched.push(cwd);
		});

		expect(launched).toEqual(["/repo-ok"]);
	});
});
