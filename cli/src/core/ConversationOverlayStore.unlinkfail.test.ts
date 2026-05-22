/**
 * Coverage for the `.catch(() => undefined)` arrow inside `saveOverlay`'s
 * rename-failure cleanup path. The main `ConversationOverlayStore.test.ts`
 * already proves the cleanup *runs* (rename throws → unlink succeeds, .tmp
 * vanishes), but the catch handler itself is only invoked when unlink also
 * fails — i.e. the "double failure" scenario where the rename error is the
 * one we want to surface and the cleanup failure must NOT mask it.
 *
 * The handler is `() => undefined` — small enough that the test feels like
 * coverage theater, but the production contract it encodes is real: a
 * post-rename unlink failure (Windows EBUSY when a viewer holds the dest,
 * cross-filesystem EXDEV that breaks the atomic-swap assumption, EPERM on
 * a sandboxed user-data dir, etc.) must propagate the *original* rename
 * error, not the cleanup error. Pinning the branch keeps that contract
 * from regressing into a try/throw refactor that surfaces the wrong cause.
 *
 * Kept in a separate file because `vi.mock("node:fs/promises")` is module-
 * scoped — applying it to the main suite would break every test that uses
 * real `mkdir`/`writeFile`/etc. for fixture setup.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

import { type OverlayableSession, pruneConsumedOverlayRules, saveOverlay } from "./ConversationOverlayStore.js";

describe("saveOverlay unlink-also-fails cleanup", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "overlay-unlink-fail-"));
		vi.mocked(realFsPromises.unlink).mockClear();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("swallows a secondary unlink failure and rethrows the original rename error", async () => {
		// Force the rename to fail by pre-creating the destination as a
		// directory — same trick the main test suite uses, EISDIR on POSIX.
		const overlayDir = join(projectDir, ".jolli", "jollimemory", "conversation-edits");
		mkdirSync(overlayDir, { recursive: true });
		const finalPath = join(overlayDir, "claude--double.json");
		mkdirSync(finalPath);

		// Make the cleanup unlink also fail. The .catch arrow must turn this
		// into a silent no-op so the rename error is what bubbles up.
		const cleanupErr = new Error("simulated EBUSY on cleanup");
		vi.mocked(realFsPromises.unlink).mockRejectedValueOnce(cleanupErr);

		// Expect the *rename* error (EISDIR / EPERM) to propagate — NOT the
		// fake cleanup error. The arrow's job is precisely to drop the
		// cleanup throw on the floor.
		await expect(
			saveOverlay(
				{ projectDir, source: "claude", sessionId: "double" },
				{ deletes: [{ role: "human", content: "x" }], edits: [] },
			),
		).rejects.toThrow(/EISDIR|EPERM|is a directory/i);

		// Confirm the failing unlink was actually attempted (otherwise the
		// arrow path wasn't exercised even if the test passed for unrelated
		// reasons).
		expect(realFsPromises.unlink).toHaveBeenCalled();
	});
});

describe("pruneConsumedOverlayRules unlink-failure", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "overlay-prune-unlink-fail-"));
		vi.mocked(realFsPromises.unlink).mockClear();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("swallows a non-ENOENT unlink error and warn-logs instead of throwing", async () => {
		// Plant a real overlay with a single delete rule so prune has something
		// to consume — when all rules are matched, prune calls unlink to remove
		// the now-empty overlay file.
		const sessionId = "prune-unlink-fail";
		const rule = { role: "human" as const, content: "ask-prune", timestamp: "tp1" };
		await saveOverlay({ projectDir, source: "claude", sessionId }, { deletes: [rule], edits: [] });

		// Confirm the file exists before prune runs.
		const overlayDir = join(projectDir, ".jolli", "jollimemory", "conversation-edits");
		const overlayFile = join(overlayDir, "claude--prune-unlink-fail.json");
		expect(existsSync(overlayFile)).toBe(true);

		// Force unlink to throw a non-ENOENT error — the inner catch re-throws
		// it (because isEnoent returns false), which lifts the error into the
		// outer try/catch that warn-logs and swallows it.
		vi.mocked(realFsPromises.unlink).mockRejectedValueOnce(new Error("EACCES: permission denied"));

		// The session whose entries fully match the planted rule — prune will
		// choose the unlink path after filtering leaves zero remaining rules.
		const session: OverlayableSession = {
			sessionId,
			source: "claude",
			entries: [{ role: "human", content: "ask-prune", timestamp: "tp1" }],
		};

		// Must resolve (not throw) — the outer catch swallows the error.
		await expect(pruneConsumedOverlayRules([session], projectDir)).resolves.toBeUndefined();

		// The overlay file is still on disk because unlink failed.
		expect(existsSync(overlayFile)).toBe(true);

		// Confirm unlink was actually called so the branch was exercised.
		expect(realFsPromises.unlink).toHaveBeenCalled();
	});
});
