/**
 * Acceptance §8 scenario 8 — cross-device race ending in non-fast-forward push.
 *
 * Setup: our device clones the vault, then a peer device pushes a new commit
 * before we get to push our own. Our `git push` returns non-FF; the engine's
 * `pushWithRetry` should:
 *
 *   1. Detect the non-FF (`PushResult.nonFastForward === true`).
 *   2. Run `git pull --rebase` to integrate the peer's commit.
 *   3. Retry push — succeeds.
 *
 * Final state: `synced`, bare repo's `main` contains BOTH the peer's file
 * and ours. No conflict resolution needed (different files), so Tier 2/3
 * are not invoked.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConflictUi } from "../../src/sync/ConflictResolver.js";
import {
	type AcceptanceWorld,
	buildEngineForWorld,
	defaultRoundOptions,
	expectRoundState,
	listFilesAtMain,
	pushFromPeerDevice,
	readBlobAtMain,
	setupAcceptance,
	teardownAcceptance,
} from "./_helpers.js";

let world: AcceptanceWorld;

beforeEach(async () => {
	world = await setupAcceptance();
});

afterEach(async () => {
	await teardownAcceptance(world);
});

describe("acceptance §8 — cross-device race ends in successful retry", () => {
	it("recovers from non-FF push by rebasing onto peer's commit and retrying", async () => {
		// Local Memory Bank has hello.md.
		await writeFile(join(world.folderRoot, "hello.md"), "# Hello local\n");

		// A peer beats us to push — adds notes/from-peer.md.
		await pushFromPeerDevice(
			world.bareRepoPath,
			{ "notes/from-peer.md": "# Hello peer\n" },
			"[peer] add notes/from-peer.md",
		);

		const ui: ConflictUi = {
			promptBinaryPick: vi.fn(async () => "skip" as const),
		};
		const engine = buildEngineForWorld(world, { ui });

		const result = await engine.runRound(defaultRoundOptions(world));
		expectRoundState(result, "synced");
		// Tier 2/3 must NOT fire — the two devices touched different files.
		expect(ui.promptBinaryPick).not.toHaveBeenCalled();

		// Bare repo contains both files. Per §0.10 our path no longer has
		// a `<branch>/` subdir — content lives directly under `<repoFolder>/`.
		const files = listFilesAtMain(world.bareRepoPath);
		expect(files).toContain("notes/from-peer.md"); // peer's path (root level — pushed directly)
		expect(files).toContain("test-repo/hello.md"); // ours via the working tree
		expect(readBlobAtMain(world.bareRepoPath, "notes/from-peer.md")).toBe("# Hello peer\n");
		expect(readBlobAtMain(world.bareRepoPath, "test-repo/hello.md")).toBe("# Hello local\n");
	});
});
