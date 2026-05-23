/**
 * Acceptance §8 scenario 1 — First opt-in, `alreadyVaultBound === true`.
 *
 * The user flips `syncEnabled: true` for the first time on a personal space
 * that's already git-backed (e.g. a second device joining an existing vault,
 * or a fresh user after the backend pre-flipped the backing). The engine
 * should:
 *
 *   1. Mint credentials (real `BackendClient` call replaced by stub).
 *   2. Clone the empty bare repo into `<memoryBankRoot>` (which IS the
 *      working tree — plan §0.13 removed the separate `~/.jolli/vaults/`
 *      clone).
 *   3. Commit + push (`[jolli-mb] add: …`). Per §0.10 there is NO per-branch
 *      subdirectory — content lives directly at `<repoFolder>/...`.
 *   4. `notify-push` with the new HEAD sha (when push actually transmitted —
 *      §0.8 idle-tick fix).
 *   5. Final state: `synced`, vault repo at `main` contains the user's
 *      files, no legacy-content / complete-migration calls because backing
 *      was already `git`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AcceptanceWorld,
	buildEngineForWorld,
	defaultRoundOptions,
	expectRoundState,
	listFilesAtMain,
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

describe("acceptance §1 — first opt-in (backing=git)", () => {
	it("clones, mirrors, commits, and pushes the user's local Memory Bank to the vault", async () => {
		await writeFile(join(world.folderRoot, "hello.md"), "# Hello world\n");
		await mkdir(join(world.folderRoot, "notes"), { recursive: true });
		await writeFile(join(world.folderRoot, "notes", "a.md"), "note A\n");

		const engine = buildEngineForWorld(world);
		const result = await engine.runRound(defaultRoundOptions(world));

		expectRoundState(result, "synced");
		expect(result.pulled).toBe(true);
		expect(result.pushed).toBe(true);

		// Vault repo should contain user files directly under <repoFolder>/.
		// Plan §0.10 collapsed the per-branch subdir; there is no
		// `test-repo/main/` layer any more.
		const filesAtMain = listFilesAtMain(world.bareRepoPath);
		expect(filesAtMain).toContain("test-repo/hello.md");
		expect(filesAtMain).toContain("test-repo/notes/a.md");
		expect(readBlobAtMain(world.bareRepoPath, "test-repo/hello.md")).toBe("# Hello world\n");

		// Bootstrap-managed files: `.gitignore` at the vault root, and the
		// per-bank `.jolli/repos.json` mapping that the engine assigns on
		// first bind via `resolveOrAssignFolder`.
		expect(filesAtMain).toContain(".gitignore");
		expect(filesAtMain).toContain(".jolli/repos.json");

		// Backend call shape: one mint, one notify-push (with branch=main).
		expect(world.backend.mintCalls).toBe(1);
		expect(world.backend.notifyPushCalls).toHaveLength(1);
		expect(world.backend.notifyPushCalls[0]?.branch).toBe("main");
		expect(world.backend.notifyPushCalls[0]?.commitSha).toMatch(/^[0-9a-f]{40}$/);

		// Because backing was already "git", we should NOT have touched
		// legacy-content or complete-migration.
		expect(world.backend.legacyContentCalls).toBe(0);
		expect(world.backend.completeMigrationCalls).toBe(0);
	});

	it("is idempotent — a second round writes nothing and stays synced", async () => {
		await writeFile(join(world.folderRoot, "hello.md"), "# Hello world\n");
		const engine = buildEngineForWorld(world);

		const first = await engine.runRound(defaultRoundOptions(world));
		expectRoundState(first, "synced");

		// Mint cache makes the second round skip mint. Per §0.8, notifyPush
		// is now ALSO skipped when push reports "Everything up-to-date" —
		// idle ticks no longer pelt the backend with redundant SHAs.
		const notifyCountBeforeSecond = world.backend.notifyPushCalls.length;
		const second = await engine.runRound(defaultRoundOptions(world));
		expectRoundState(second, "synced");

		// No new commits in the bare repo on the second round.
		expect(listFilesAtMain(world.bareRepoPath).filter((f) => f.endsWith("hello.md"))).toEqual([
			"test-repo/hello.md",
		]);
		// And the §0.8 invariant: the second (idempotent) round did NOT fire
		// notify-push because nothing was transmitted.
		expect(world.backend.notifyPushCalls.length).toBe(notifyCountBeforeSecond);
	});
});
