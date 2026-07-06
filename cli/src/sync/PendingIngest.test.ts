import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

import { getJolliMemoryDir } from "../Logger.js";
import { consumePendingIngest, INGEST_PENDING_FILE, recordPendingIngest, wakePendingIngest } from "./PendingIngest.js";

describe("PendingIngest", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jolli-pending-ingest-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	function flagPath(cwd: string): string {
		return join(getJolliMemoryDir(cwd), INGEST_PENDING_FILE);
	}

	it("recordPendingIngest writes the single-slot flag", async () => {
		await recordPendingIngest(tempDir);
		await expect(stat(flagPath(tempDir))).resolves.toBeDefined();
	});

	it("recordPendingIngest is idempotent (same single slot)", async () => {
		await recordPendingIngest(tempDir);
		await recordPendingIngest(tempDir);
		// Still exactly one flag; a second consume finds nothing.
		expect(await consumePendingIngest(tempDir)).toBe(true);
		expect(await consumePendingIngest(tempDir)).toBe(false);
	});

	it("consumePendingIngest returns false when no flag exists", async () => {
		expect(await consumePendingIngest(tempDir)).toBe(false);
	});

	it("consumePendingIngest returns true and deletes the flag", async () => {
		await recordPendingIngest(tempDir);
		expect(await consumePendingIngest(tempDir)).toBe(true);
		await expect(stat(flagPath(tempDir))).rejects.toThrow();
	});

	it("wakePendingIngest launches once when a waiter was recorded, then clears the flag", async () => {
		await recordPendingIngest(tempDir);
		const launch = vi.fn();
		await wakePendingIngest(tempDir, launch);
		expect(launch).toHaveBeenCalledOnce();
		expect(launch).toHaveBeenCalledWith(tempDir);
		// Flag consumed — a second wake is a no-op.
		launch.mockClear();
		await wakePendingIngest(tempDir, launch);
		expect(launch).not.toHaveBeenCalled();
	});

	it("wakePendingIngest does not launch when no waiter was recorded", async () => {
		const launch = vi.fn();
		await wakePendingIngest(tempDir, launch);
		expect(launch).not.toHaveBeenCalled();
	});

	it("wakePendingIngest swallows a launch failure (best-effort)", async () => {
		await recordPendingIngest(tempDir);
		const launch = vi.fn(() => {
			throw new Error("spawn boom");
		});
		await expect(wakePendingIngest(tempDir, launch)).resolves.toBeUndefined();
		expect(launch).toHaveBeenCalledOnce();
	});

	it("consumePendingIngest tolerates a pre-existing raw flag file", async () => {
		// A flag written directly (e.g. by another process) is still consumable.
		await mkdir(getJolliMemoryDir(tempDir), { recursive: true });
		await writeFile(flagPath(tempDir), "2026-01-01T00:00:00.000Z", "utf-8");
		expect(await consumePendingIngest(tempDir)).toBe(true);
	});

	it("recordPendingIngest swallows a filesystem failure (best-effort)", async () => {
		// Make the jollimemory dir un-creatable: put a FILE where its parent
		// (`<cwd>/.jolli`) must be a directory, so mkdir(recursive) throws ENOTDIR.
		await writeFile(join(tempDir, ".jolli"), "not a dir", "utf-8");
		await expect(recordPendingIngest(tempDir)).resolves.toBeUndefined();
	});

	it("consumePendingIngest returns true even when the flag delete fails", async () => {
		// A directory at the flag path: stat() sees it (so "pending" is true), but
		// rm(force:true) without recursive refuses a directory → the catch fires and
		// we still report the waiter as consumed.
		await mkdir(flagPath(tempDir), { recursive: true });
		expect(await consumePendingIngest(tempDir)).toBe(true);
	});
});
