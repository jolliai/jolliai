/**
 * Coverage for the file-locking error paths in `HiddenConversationsStore`:
 *
 *   1. The `unlink(lockPath).catch(...)` arrow inside `hideConversation`'s
 *      `finally` block. Two branches: ENOENT (legitimate stale-lock race,
 *      silent) vs non-ENOENT (EACCES / EBUSY on Windows, logged at debug).
 *      Both arms are unreachable in real-fs tests because unlink always
 *      succeeds on a freshly-created lock file.
 *
 *   2. The `if (!isAlreadyExists(err)) throw err` rethrow inside
 *      `acquireHiddenLock`. The happy / EEXIST-collision paths are
 *      exercised by the concurrent-hide test in the main suite, but the
 *      "writeFile fails with a non-EEXIST errno" rethrow has no
 *      real-fs trigger short of yanking permissions mid-test.
 *
 * Pattern matches `ConversationOverlayStore.unlinkfail.test.ts`: mock
 * `node:fs/promises` selectively (wrap unlink + writeFile, leave the rest
 * pass-through) so the rest of the function — mkdir, readFile, rename — still
 * goes through real fs and the test reads as an integration of the locking
 * contract, not a unit test of fs.
 */

import { mkdtempSync, rmSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		unlink: vi.fn(original.unlink),
		writeFile: vi.fn(original.writeFile),
	};
});

import { hideConversation } from "./HiddenConversationsStore.js";

const enoent = (path: string): NodeJS.ErrnoException => {
	const e: NodeJS.ErrnoException = new Error(`ENOENT: no such file, open '${path}'`);
	e.code = "ENOENT";
	return e;
};

const eacces = (path: string): NodeJS.ErrnoException => {
	const e: NodeJS.ErrnoException = new Error(`EACCES: permission denied, open '${path}'`);
	e.code = "EACCES";
	return e;
};

describe("HiddenConversationsStore error paths", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "hidden-err-"));
		vi.mocked(realFsPromises.unlink).mockClear();
		vi.mocked(realFsPromises.writeFile).mockClear();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	// Arrow invoked, falsy `!isEnoent(err)` arm — the unlink failed because
	// a concurrent waiter unlinked the lock under us. Race-recovery case;
	// must stay silent (no log) so triage isn't spammed by routine contention.
	it("hideConversation: ENOENT on lock-release unlink is silently swallowed", async () => {
		vi.mocked(realFsPromises.unlink).mockImplementationOnce(async () => {
			throw enoent("hidden-conversations.json.lock");
		});

		// Hide should still succeed — the inner critical section completed
		// normally; lock-release ENOENT is an "already cleaned up" signal.
		const state = await hideConversation(projectDir, "claude", "s1");
		expect(state.entries["claude:s1"]).toBeDefined();
		expect(realFsPromises.unlink).toHaveBeenCalledTimes(1);
	});

	// Arrow invoked, truthy `!isEnoent(err)` arm — a real problem (EBUSY on
	// Windows when a viewer holds the lock fd, EACCES from a chmod race).
	// We log at debug level and otherwise keep going — the hide already
	// landed on disk before the finally block runs, so the user's intent
	// is durable; only the leftover lock file is the concern.
	it("hideConversation: non-ENOENT on lock-release unlink is logged at debug, hide still durable", async () => {
		vi.mocked(realFsPromises.unlink).mockImplementationOnce(async () => {
			throw eacces("hidden-conversations.json.lock");
		});

		const state = await hideConversation(projectDir, "claude", "s2");
		expect(state.entries["claude:s2"]).toBeDefined();
		expect(realFsPromises.unlink).toHaveBeenCalledTimes(1);
	});

	// `acquireHiddenLock` only catches EEXIST (the lock-collision case) and
	// rethrows anything else. The hideConversation contract — fail loudly
	// rather than silently lose the hide — depends on this rethrow surviving
	// any future refactor that "simplifies" the try/catch.
	it("acquireHiddenLock: writeFile non-EEXIST error is rethrown so hideConversation rejects", async () => {
		// writeFile is called twice during a successful hide:
		//   (1) lockPath with flag:'wx'  — inside acquireHiddenLock
		//   (2) tmpPath                  — the atomic-write of the JSON state
		// We want to fail (1) only. mockImplementationOnce intercepts the
		// FIRST call (= lockPath) and lets subsequent calls fall through to
		// the wrapped original (which won't be reached anyway because (1)
		// throws before (2) runs).
		vi.mocked(realFsPromises.writeFile).mockImplementationOnce(async () => {
			throw eacces("hidden-conversations.json.lock");
		});

		await expect(hideConversation(projectDir, "claude", "s3")).rejects.toThrow(/EACCES/);
		// Critical: only the lock-write was attempted. The atomic-write of
		// the state file must NOT have run — otherwise a half-written state
		// would survive the failed acquire.
		expect(realFsPromises.writeFile).toHaveBeenCalledTimes(1);
	});
});
