/**
 * Acceptance §0 — production wiring smoke test.
 *
 * Every other acceptance scenario assembles a `SyncEngine` directly via
 * `new SyncEngine({ ... })` (see `_helpers.ts buildEngineForWorld`). That
 * shortcut is faster to iterate on, but it bypasses
 * `cli/src/sync/SyncBootstrap.ts buildSyncEngine` — the actual factory the
 * VS Code extension and CLI surface call. Wiring drift in `buildSyncEngine`
 * (missing dep, wrong default, signature change in `BootstrapOpts`) would
 * therefore stay invisible to acceptance.
 *
 * This one test goes through the public factory end-to-end against a fake
 * backend + real git bare repo, completes a steady-state round, and asserts
 * `synced`. If `buildSyncEngine` ever stops wiring a load-bearing dependency,
 * this round will fail loudly instead of the issue only surfacing in
 * production.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitClient } from "../../src/sync/GitClient.js";
import { buildSyncEngine } from "../../src/sync/SyncBootstrap.js";
import type { RoundContext } from "../../src/sync/SyncEngine.js";
import {
	type AcceptanceWorld,
	defaultRoundOptions,
	setupAcceptance,
	teardownAcceptance,
} from "./_helpers.js";

const SHARED_AUTHOR = { name: "Acceptance Test", email: "test@jolli.ai" };
const REPO_FOLDER = "test-repo";

let world: AcceptanceWorld;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let fakeHome: string;

beforeEach(async () => {
	world = await setupAcceptance();
	// `buildSyncEngine` reads `~/.jolli/jollimemory/config.json` via
	// `loadConfig()` to discover `jolliApiKey`; without a key the factory
	// returns `null` (= dormant). Redirect the homedir at the env layer so
	// the read hits a tempdir with a seeded config instead of the
	// developer's real config (which we must not mutate, and which may not
	// even exist in CI). `os.homedir()` consults `HOME` on POSIX and
	// `USERPROFILE` on Windows — set both so the override works on either
	// platform. Restore on teardown.
	priorHome = process.env.HOME;
	priorUserProfile = process.env.USERPROFILE;
	fakeHome = join(world.tempDir, "fake-home");
	await mkdir(join(fakeHome, ".jolli", "jollimemory"), { recursive: true });
	await writeFile(
		join(fakeHome, ".jolli", "jollimemory", "config.json"),
		JSON.stringify({ jolliApiKey: "sk-jol-acceptance-test" }),
	);
	process.env.HOME = fakeHome;
	process.env.USERPROFILE = fakeHome;
});

afterEach(async () => {
	if (priorHome === undefined) delete process.env.HOME;
	else process.env.HOME = priorHome;
	if (priorUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = priorUserProfile;
	await teardownAcceptance(world);
});

describe("acceptance §0 — production wiring (buildSyncEngine)", () => {
	it("buildSyncEngine assembles an engine that completes a steady-state round end-to-end", async () => {
		// Force-resolve to the world's vault layout instead of letting
		// `defaultResolveContext` walk the (fake) HOME + remote-URL machinery.
		// `makeVaultClient` swaps in the askpass-bypassing GitClient the
		// acceptance helper already uses for `file://` bares. Backend is the
		// world's controllable stub. Everything else (per-round loadConfig,
		// AI factory, conflict policy narrowing, real `MemoryBankBootstrap`
		// + `LegacyMigration` wiring) flows through unchanged so that drift
		// in those production paths surfaces here.
		const ctx: RoundContext = {
			memoryBankRoot: world.memoryBankRoot,
			repoFolderName: REPO_FOLDER,
			repoIdentity: "https://github.com/test-owner/test-repo",
			author: SHARED_AUTHOR,
		};
		const engine = await buildSyncEngine({
			cwd: world.folderRoot,
			ui: { promptBinaryPick: async () => "skip" as const },
			backend: world.backend,
			resolveContextOverride: async () => ctx,
			makeVaultClientOverride: (creds, memoryBankRoot) =>
				new GitClient({
					memoryBankRoot,
					credentials: creds,
					askpass: async () => ({
						scriptPath: "/unused",
						envVar: "JOLLI_SYNC_GIT_TOKEN" as const,
						env: process.env,
					}),
				}),
		});
		expect(engine).not.toBeNull();
		const result = await engine!.runRound(defaultRoundOptions(world));
		expect(result.newState).toBe("synced");
		// Smoke-check that production wiring exercised the backend exactly
		// like the direct-construction tests do (one mint, one notify-push).
		expect(world.backend.mintCalls).toBe(1);
		expect(world.backend.notifyPushCalls.length).toBeGreaterThanOrEqual(0);
	});

	it("returns null (dormant) when jolliApiKey is missing — production guard, not test-seam-only", async () => {
		// Overwrite the seeded config to drop the key. The factory's first
		// branch is the dormant check; if a future refactor moved that check
		// behind a test seam it would silently skip in production.
		await writeFile(
			join(fakeHome, ".jolli", "jollimemory", "config.json"),
			JSON.stringify({}),
		);
		const engine = await buildSyncEngine({
			cwd: world.folderRoot,
			ui: { promptBinaryPick: async () => "skip" as const },
			backend: world.backend,
		});
		expect(engine).toBeNull();
		expect(world.backend.mintCalls).toBe(0);
	});
});
