/**
 * The rename-failure cleanup path (`unlink(tmpPath).catch(() => {})`, then
 * rethrow) is only exercised by a REAL rename failure — mocking `rename` at
 * the module level would also have to fake `mkdir`/`writeFile`, and the point
 * of this writer is exactly that temp-then-rename sequence. `vi.mock`s here
 * are scoped to `unlink` alone (pass-through by default) so the "double
 * failure" case — cleanup itself fails — can be injected without faking the
 * rest of the filesystem, mirroring `CommitSelectionStore.unlinkfail.test.ts`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		// Default-behavior pass-through; one test overrides this to inject a
		// secondary cleanup failure.
		unlink: vi.fn(original.unlink),
	};
});

import { writeFileAtomic } from "./AtomicJsonFile.js";

describe("writeFileAtomic", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "atomic-json-file-"));
		vi.mocked(realFsPromises.unlink).mockClear();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes contents via a pid-scoped temp file and renames it into place", async () => {
		const target = join(dir, "state.json");

		await writeFileAtomic(target, '{"ok":true}');

		expect(readFileSync(target, "utf-8")).toBe('{"ok":true}');
	});

	it("creates parent directories that do not exist yet", async () => {
		const target = join(dir, "nested", "deep", "state.json");

		await writeFileAtomic(target, "hello");

		expect(readFileSync(target, "utf-8")).toBe("hello");
	});

	it("applies a given mode to the temp file, which the rename carries onto the target", async () => {
		const target = join(dir, "secret.json");

		await writeFileAtomic(target, "s3cr3t", { mode: 0o600 });

		expect(readFileSync(target, "utf-8")).toBe("s3cr3t");
		if (process.platform !== "win32") {
			expect(statSync(target).mode & 0o777).toBe(0o600);
		}
	});

	it("cleans up the temp file and rethrows when the rename fails", async () => {
		const target = join(dir, "blocked.json");
		// Renaming a regular file onto an existing directory always fails EISDIR
		// on POSIX, regardless of whether the directory is empty.
		mkdirSync(target);

		await expect(writeFileAtomic(target, "next")).rejects.toThrow(/EISDIR|directory/i);

		expect(realFsPromises.unlink).toHaveBeenCalledWith(`${target}.${process.pid}.tmp`);
	});

	it("swallows a secondary unlink failure and still rethrows the original rename error", async () => {
		const target = join(dir, "blocked2.json");
		mkdirSync(target);
		const cleanupErr = new Error("simulated EBUSY on cleanup");
		vi.mocked(realFsPromises.unlink).mockRejectedValueOnce(cleanupErr);

		// The rename error (EISDIR) must win — not the fake cleanup failure the
		// `.catch(() => {})` arrow exists to drop on the floor.
		await expect(writeFileAtomic(target, "next")).rejects.toThrow(/EISDIR|directory/i);
		expect(realFsPromises.unlink).toHaveBeenCalledWith(`${target}.${process.pid}.tmp`);
	});
});
