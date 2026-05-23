/**
 * Tests for SyncStateStore — atomic per-user persistence of sync state.
 *
 * `os.homedir()` is mocked to point at a tempdir so each test gets an
 * isolated `~/.jolli/jollimemory/` to play with.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

import { clearConflict, getGlobalSyncDir, loadSyncState, recordConflict, saveSyncState } from "./SyncStateStore.js";
import type { SyncStateFile } from "./SyncTypes.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "syncstate-"));
	mockHomeDir.value = tempDir;
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

const sample = (overrides: Partial<SyncStateFile> = {}): SyncStateFile => ({
	version: 1,
	userSlug: "alice-abc1234",
	repoFolderName: "deadbeef-jolliai",
	lastSyncStatus: "synced",
	pendingConflicts: [],
	checkoutPath: "/home/alice/.jolli/vaults/alice-abc1234",
	...overrides,
});

describe("SyncStateStore", () => {
	describe("getGlobalSyncDir", () => {
		it("returns ~/.jolli/jollimemory/", () => {
			expect(getGlobalSyncDir()).toBe(join(tempDir, ".jolli", "jollimemory"));
		});
	});

	describe("loadSyncState", () => {
		it("returns null when the file does not exist", async () => {
			expect(await loadSyncState("alice-abc1234")).toBeNull();
		});

		it("returns null when the user's entry is missing", async () => {
			await saveSyncState(sample({ userSlug: "bob-xyz9999" }));
			expect(await loadSyncState("alice-abc1234")).toBeNull();
		});

		it("returns the stored entry when present", async () => {
			const s = sample();
			await saveSyncState(s);
			expect(await loadSyncState("alice-abc1234")).toEqual(s);
		});

		it("returns null when the file is unparseable", async () => {
			const path = join(getGlobalSyncDir(), "sync-state.json");
			await mkdir(getGlobalSyncDir(), { recursive: true });
			await writeFile(path, "{not valid json");
			expect(await loadSyncState("alice-abc1234")).toBeNull();
		});

		it("returns null when the file is an array (wrong shape)", async () => {
			const path = join(getGlobalSyncDir(), "sync-state.json");
			await mkdir(getGlobalSyncDir(), { recursive: true });
			await writeFile(path, "[1,2,3]");
			expect(await loadSyncState("alice-abc1234")).toBeNull();
		});

		it("returns null when the stored version doesn't match", async () => {
			const path = join(getGlobalSyncDir(), "sync-state.json");
			await mkdir(getGlobalSyncDir(), { recursive: true });
			await writeFile(
				path,
				JSON.stringify({
					"alice-abc1234": { ...sample(), version: 999 },
				}),
			);
			expect(await loadSyncState("alice-abc1234")).toBeNull();
		});
	});

	describe("saveSyncState", () => {
		it("creates ~/.jolli/jollimemory/ if missing", async () => {
			await saveSyncState(sample());
			const dirStat = await stat(getGlobalSyncDir());
			expect(dirStat.isDirectory()).toBe(true);
		});

		it("preserves entries for other users", async () => {
			await saveSyncState(sample({ userSlug: "alice-abc1234" }));
			await saveSyncState(sample({ userSlug: "bob-xyz9999" }));
			expect(await loadSyncState("alice-abc1234")).not.toBeNull();
			expect(await loadSyncState("bob-xyz9999")).not.toBeNull();
		});

		it("overwrites the entry for the same userSlug", async () => {
			await saveSyncState(sample({ lastSyncStatus: "syncing" }));
			await saveSyncState(sample({ lastSyncStatus: "synced" }));
			const loaded = await loadSyncState("alice-abc1234");
			expect(loaded?.lastSyncStatus).toBe("synced");
		});

		it("writes valid JSON to disk", async () => {
			await saveSyncState(sample());
			const raw = await readFile(join(getGlobalSyncDir(), "sync-state.json"), "utf-8");
			const parsed = JSON.parse(raw);
			expect(parsed["alice-abc1234"].userSlug).toBe("alice-abc1234");
		});

		it("sets POSIX mode 0600 (skipped on win32)", async () => {
			if (process.platform === "win32") return;
			await saveSyncState(sample());
			const fileStat = await stat(join(getGlobalSyncDir(), "sync-state.json"));
			// mode is the file-mode bits OR'd with type; mask to permission bits.
			expect(fileStat.mode & 0o777).toBe(0o600);
		});
	});

	describe("recordConflict", () => {
		it("is a no-op when no state exists for the user", async () => {
			await recordConflict("alice-abc1234", {
				path: "notes/foo.md",
				tier: 3,
				detectedAt: new Date().toISOString(),
			});
			expect(await loadSyncState("alice-abc1234")).toBeNull();
		});

		it("inserts a conflict record into the existing entry", async () => {
			await saveSyncState(sample());
			await recordConflict("alice-abc1234", {
				path: "notes/foo.md",
				tier: 3,
				detectedAt: "2026-05-19T00:00:00.000Z",
			});
			const loaded = await loadSyncState("alice-abc1234");
			expect(loaded?.pendingConflicts).toHaveLength(1);
			expect(loaded?.pendingConflicts[0]?.path).toBe("notes/foo.md");
		});

		it("replaces a prior record for the same path", async () => {
			await saveSyncState(sample());
			await recordConflict("alice-abc1234", {
				path: "notes/foo.md",
				tier: 2,
				detectedAt: "2026-05-19T00:00:00.000Z",
			});
			await recordConflict("alice-abc1234", {
				path: "notes/foo.md",
				tier: 3,
				detectedAt: "2026-05-19T00:01:00.000Z",
			});
			const loaded = await loadSyncState("alice-abc1234");
			expect(loaded?.pendingConflicts).toHaveLength(1);
			expect(loaded?.pendingConflicts[0]?.tier).toBe(3);
		});
	});

	describe("clearConflict", () => {
		it("is a no-op when no state exists", async () => {
			await expect(clearConflict("alice-abc1234", "notes/foo.md")).resolves.toBeUndefined();
		});

		it("removes the matching record", async () => {
			await saveSyncState(sample());
			await recordConflict("alice-abc1234", {
				path: "notes/foo.md",
				tier: 3,
				detectedAt: new Date().toISOString(),
			});
			await clearConflict("alice-abc1234", "notes/foo.md");
			const loaded = await loadSyncState("alice-abc1234");
			expect(loaded?.pendingConflicts).toEqual([]);
		});

		it("is a no-op when the path doesn't match anything", async () => {
			await saveSyncState(sample());
			await recordConflict("alice-abc1234", {
				path: "notes/foo.md",
				tier: 3,
				detectedAt: new Date().toISOString(),
			});
			await clearConflict("alice-abc1234", "notes/bar.md");
			const loaded = await loadSyncState("alice-abc1234");
			expect(loaded?.pendingConflicts).toHaveLength(1);
		});
	});
});
