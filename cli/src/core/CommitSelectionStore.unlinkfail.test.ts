/**
 * Coverage for the `.catch(() => undefined)` arrow inside `writeExclusions`'
 * rename-failure cleanup path. The main `CommitSelectionStore.test.ts`
 * already proves the cleanup *runs* (rename throws → unlink succeeds, .tmp
 * vanishes), but the catch handler itself is only invoked when unlink also
 * fails — the "double failure" scenario where the rename error is the
 * one we want to surface and the cleanup failure must NOT mask it.
 *
 * Kept in a separate file because `vi.mock("node:fs/promises")` is module-
 * scoped — applying it to the main suite would break every test that uses
 * real `mkdir`/`writeFile`/etc. for fixture setup.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		// Default-behavior pass-through; tests use mockImplementationOnce
		// to inject a failure for just the unlink call we care about.
		unlink: vi.fn(original.unlink),
	};
});

import { setExcluded } from "./CommitSelectionStore.js";

describe("writeExclusions unlink-also-fails cleanup", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "commit-sel-unlink-fail-"));
		vi.mocked(realFsPromises.unlink).mockClear();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("swallows a secondary unlink failure and rethrows the original rename error", async () => {
		// Force the rename to fail by pre-creating the destination as a
		// directory — same trick the main test suite uses, EISDIR on POSIX.
		const dir = join(projectDir, ".jolli", "jollimemory");
		mkdirSync(dir, { recursive: true });
		const finalPath = join(dir, "commit-selection.json");
		mkdirSync(finalPath);

		// Make the cleanup unlink also fail. The .catch arrow must turn this
		// into a silent no-op so the rename error is what bubbles up.
		const cleanupErr = new Error("simulated EBUSY on cleanup");
		vi.mocked(realFsPromises.unlink).mockRejectedValueOnce(cleanupErr);

		// Expect the *rename* error (EISDIR / EPERM) to propagate — NOT the
		// fake cleanup error. The arrow's job is precisely to drop the
		// cleanup throw on the floor.
		await expect(setExcluded(projectDir, "plans", "x", true)).rejects.toThrow(/EISDIR|EPERM|is a directory/i);

		// Confirm the failing unlink was actually attempted (otherwise the
		// arrow path wasn't exercised even if the test passed for unrelated
		// reasons).
		expect(realFsPromises.unlink).toHaveBeenCalled();
	});
});
