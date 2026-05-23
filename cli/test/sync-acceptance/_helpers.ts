/**
 * Shared fixtures + helpers for the sync acceptance suite.
 *
 * Goal: assemble a `SyncEngine` against:
 *   - a real `git init --bare` repo (so push/fetch/rebase exercise actual git)
 *   - a stub `BackendClient` (controllable from each test for credentials,
 *     legacy-content, complete-migration, notify-push)
 *   - real tempdirs for `memoryBankRoot` (which IS the working tree per
 *     plan §0.13 / §1.2 — no separate vault clone any more)
 *
 * Each test is responsible for `setupAcceptance()` in `beforeEach` and
 * `teardownAcceptance()` in `afterEach`; the helpers below return the wires
 * needed to drive the engine through `runRound`.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendClient } from "../../src/sync/BackendClient.js";
import { GitClient } from "../../src/sync/GitClient.js";
import { LegacyMigration } from "../../src/sync/LegacyMigration.js";
import { MemoryBankBootstrap } from "../../src/sync/MemoryBankBootstrap.js";
import {
	type RoundContext,
	SyncEngine,
	type SyncEngineOpts,
} from "../../src/sync/SyncEngine.js";
import type {
	GitCredentials,
	LegacyContentResponse,
	SyncRoundOptions,
} from "../../src/sync/SyncTypes.js";

export interface AcceptanceWorld {
	/** Parent tempdir; cleaned up on teardown. */
	readonly tempDir: string;
	/**
	 * Captured prior value of `JOLLI_SYNC_LOCK_DIR` so teardown can restore
	 * whatever was set before the test. Always undefined in practice (the
	 * env var is acceptance-only), but capturing it keeps the helper safe
	 * to use in shells that pre-set it for some reason.
	 */
	readonly priorSyncLockDir: string | undefined;
	/** `file://<tempDir>/bare.git` — the shared "remote". */
	readonly bareRepoUrl: string;
	readonly bareRepoPath: string;
	/**
	 * The git working tree root. Plan §0.13: this IS `<localFolder>` —
	 * one and the same as the user's Memory Bank folder. No separate clone.
	 */
	readonly memoryBankRoot: string;
	/**
	 * `<memoryBankRoot>/<repoFolderName>` — the source repo's subdir inside
	 * the working tree. Tests write source files here; the engine commits
	 * them with the rest of the working tree.
	 */
	readonly folderRoot: string;
	/** Mutable backend stub — tests rewire fields per scenario. */
	readonly backend: StubBackend;
}

/** Mutable test stub for `BackendClient`; supports `mintGitCredentials` etc. */
export interface StubBackend extends BackendClient {
	mintCalls: number;
	notifyPushCalls: Array<{ commitSha: string; branch: string }>;
	legacyContentCalls: number;
	completeMigrationCalls: number;
	/** Override the response of the next `mintGitCredentials` call. */
	mintResponse: GitCredentials;
	/** Override the response of `getLegacyContent`. */
	legacyResponse: LegacyContentResponse;
	/** Make `completeMigration` reject with this error if set. */
	completeMigrationError: Error | null;
}

const SHARED_AUTHOR = { name: "Acceptance Test", email: "test@jolli.ai" };
const REPO_FOLDER = "test-repo";

/**
 * Defensive `-c` overrides applied to every git invocation in the
 * acceptance fixtures. Insulates the suite from hostile host-git config:
 * GPG-sign forcing (no key in CI), DCO/sign-off `core.hooksPath`, and a
 * `init.defaultBranch=master` that would land seed commits on the wrong
 * branch. Identifies author identity in one place so it isn't repeated
 * per command.
 */
const SAFE_GIT_OPTS: readonly string[] = [
	"-c",
	`user.name=${SHARED_AUTHOR.name}`,
	"-c",
	`user.email=${SHARED_AUTHOR.email}`,
	"-c",
	"commit.gpgsign=false",
	"-c",
	"tag.gpgsign=false",
	"-c",
	"init.defaultBranch=main",
	"-c",
	"core.hooksPath=/dev/null",
];

export async function setupAcceptance(): Promise<AcceptanceWorld> {
	const tempDir = await mkdtemp(join(tmpdir(), "sync-acceptance-"));
	// Isolate `sync.lock` from the user's real `~/.jolli/jollimemory/`.
	// Without this, a live local VS Code or CLI sync round on the developer's
	// machine holds the shared lock and acceptance rounds time out at 5 s
	// without exercising any business logic (P3#5).
	const priorSyncLockDir = process.env.JOLLI_SYNC_LOCK_DIR;
	process.env.JOLLI_SYNC_LOCK_DIR = tempDir;
	const bareRepoPath = join(tempDir, "bare.git");
	// `--initial-branch=main` so the bare's HEAD points at `main` regardless
	// of the host's `init.defaultBranch` (GitHub CI runners default to `master`,
	// developer machines often default to `main` — without the flag the seed
	// commit lands on `master` and `git push origin main` later fails with
	// "src refspec main does not match any").
	execFileSync("git", ["init", "--bare", "--initial-branch=main", bareRepoPath], { stdio: "ignore" });

	// Seed the bare repo with an initial empty commit on `main` so that
	// subsequent fetches have something to find. Without this seed, a fresh
	// clone produces a working tree with no `main` ref; later rebases need
	// it to exist on origin.
	const seedDir = join(tempDir, "seed");
	execFileSync("git", ["clone", "--quiet", bareRepoPath, seedDir], { stdio: "ignore" });
	await writeFile(join(seedDir, ".gitignore"), "# Seed\n");
	const gitInSeed = (args: string[]) =>
		execFileSync("git", [...SAFE_GIT_OPTS, ...args], { cwd: seedDir, stdio: "ignore" });
	gitInSeed(["add", "."]);
	gitInSeed(["commit", "-m", "seed"]);
	// Force the local branch to `main` before pushing — `git clone` of an
	// empty bare leaves HEAD on an unborn branch named after the host's
	// `init.defaultBranch`. The `commit` above lands on that branch (could
	// be `master`). Renaming to `main` guarantees `push origin main` works.
	gitInSeed(["branch", "-M", "main"]);
	gitInSeed(["push", "origin", "main"]);
	await rm(seedDir, { recursive: true, force: true });

	const memoryBankRoot = join(tempDir, "memory-bank");
	const folderRoot = join(memoryBankRoot, REPO_FOLDER);
	await mkdir(folderRoot, { recursive: true });

	const bareRepoUrl = `file://${bareRepoPath}`;
	const backend = makeStubBackend(bareRepoUrl);

	return { tempDir, priorSyncLockDir, bareRepoUrl, bareRepoPath, memoryBankRoot, folderRoot, backend };
}

export async function teardownAcceptance(world: AcceptanceWorld): Promise<void> {
	if (world.priorSyncLockDir === undefined) {
		delete process.env.JOLLI_SYNC_LOCK_DIR;
	} else {
		process.env.JOLLI_SYNC_LOCK_DIR = world.priorSyncLockDir;
	}
	await rm(world.tempDir, { recursive: true, force: true });
}

/**
 * Builds a fully-wired `SyncEngine` against the world. Real
 * `GitClient`, real `MemoryBankBootstrap`, real `LegacyMigration`. Caller
 * may override pieces for targeted scenarios via `overrides`.
 */
export function buildEngineForWorld(
	world: AcceptanceWorld,
	overrides: Partial<SyncEngineOpts> = {},
): SyncEngine {
	const ctx: RoundContext = {
		memoryBankRoot: world.memoryBankRoot,
		repoFolderName: REPO_FOLDER,
		repoIdentity: "https://github.com/test-owner/test-repo",
		author: SHARED_AUTHOR,
	};
	return new SyncEngine({
		backend: world.backend,
		resolveContext: overrides.resolveContext ?? (async () => ctx),
		makeGitClient:
			overrides.makeGitClient ??
			((creds, memoryBankRoot) =>
				new GitClient({
					memoryBankRoot,
					credentials: creds,
					// No askpass setup needed — `file://` clones bypass auth.
					askpass: async () => ({
						scriptPath: "/unused",
						envVar: "JOLLI_SYNC_GIT_TOKEN" as const,
						env: process.env,
					}),
				})),
		makeBootstrap:
			overrides.makeBootstrap ??
			((opts) => new MemoryBankBootstrap(opts)),
		makeLegacyMigration:
			overrides.makeLegacyMigration ??
			((opts) => new LegacyMigration(opts)),
		ai: overrides.ai ?? (async () => null),
		ui: overrides.ui ?? { promptBinaryPick: async () => "skip" as const },
		onStateChange: overrides.onStateChange,
		lockTimeoutMs: overrides.lockTimeoutMs ?? 5_000,
		// Tighter refresh interval keeps `sync.lock` mtime fresh; default 60s
		// is fine for acceptance too but we'd rather not poll filesystem
		// while running tight tests.
		refreshIntervalMs: overrides.refreshIntervalMs ?? 60_000,
		maxPushRetries: overrides.maxPushRetries ?? 3,
	});
}

/**
 * Asserts the round ended in the expected state, including `result.lastError`
 * (code + message) in the failure message when it didn't. Acceptance tests
 * run on CI where bare `expected 'offline' to be 'synced'` gives zero signal —
 * surfacing the engine's classified error code in the assertion message turns
 * a one-line CI failure into something diagnosable without rerunning with
 * `stdio: "inherit"`.
 */
export function expectRoundState(
	result: { newState: string; lastError?: { code: string; message: string } | undefined },
	want: string,
): void {
	const detail = result.lastError
		? `code=${result.lastError.code} message=${result.lastError.message}`
		: "no lastError";
	if (result.newState !== want) {
		throw new Error(
			`expected newState=${want}, got ${result.newState} (${detail})`,
		);
	}
}

export function defaultRoundOptions(
	world: AcceptanceWorld,
	overrides: Partial<SyncRoundOptions> = {},
): SyncRoundOptions {
	return {
		cwd: world.folderRoot,
		reason: "manual",
		transcripts: false,
		...overrides,
	};
}

/**
 * Convenience: ask git running against `bareRepoPath` what's in a file at
 * `origin/main`. Tests use this to assert pushed content without spinning
 * up another clone.
 */
export function readBlobAtMain(bareRepoPath: string, relPath: string): string {
	return execFileSync("git", ["show", `main:${relPath}`], {
		cwd: bareRepoPath,
		encoding: "utf-8",
	});
}

/** Lists every blob path under `main` (depth-walks tree). */
export function listFilesAtMain(bareRepoPath: string): string[] {
	const out = execFileSync("git", ["ls-tree", "-r", "--name-only", "main"], {
		cwd: bareRepoPath,
		encoding: "utf-8",
	});
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/** Commits + pushes a file directly to the bare repo via a throwaway clone — simulates a "peer device". */
export async function pushFromPeerDevice(
	bareRepoPath: string,
	files: Record<string, string>,
	commitMessage: string,
): Promise<string> {
	const peerDir = await mkdtemp(join(tmpdir(), "peer-"));
	execFileSync("git", ["clone", "--quiet", bareRepoPath, peerDir], { stdio: "ignore" });
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(peerDir, rel);
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, content);
	}
	const gitArgs = (args: string[]) =>
		execFileSync("git", [...SAFE_GIT_OPTS, ...args], { cwd: peerDir, stdio: "ignore" });
	gitArgs(["add", "."]);
	gitArgs(["commit", "-m", commitMessage]);
	gitArgs(["push", "origin", "main"]);
	const sha = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: peerDir,
		encoding: "utf-8",
	}).trim();
	await rm(peerDir, { recursive: true, force: true });
	return sha;
}

function makeStubBackend(bareRepoUrl: string): StubBackend {
	const stub = {
		mintCalls: 0,
		notifyPushCalls: [] as Array<{ commitSha: string; branch: string }>,
		legacyContentCalls: 0,
		completeMigrationCalls: 0,
		mintResponse: {
			gitUrl: bareRepoUrl,
			token: "ghs_accept_test",
			expiresAt: Date.now() + 3600_000,
			repoFullName: "jolli-vaults/test-user",
			defaultBranch: "main",
			githubRepoCreated: true,
			alreadyVaultBound: true as const,
			lockOwnerToken: "test-lock-owner-token" as const,
		},
		legacyResponse: {
			spaceId: 1,
			spaceSlug: "personal",
			alreadyMigrated: true,
			docs: [],
		} satisfies LegacyContentResponse,
		completeMigrationError: null as Error | null,
		mintGitCredentials: async () => {
			stub.mintCalls++;
			return stub.mintResponse;
		},
		notifyPush: async (args: { commitSha: string; branch: string }) => {
			stub.notifyPushCalls.push(args);
		},
		getLegacyContent: async () => {
			stub.legacyContentCalls++;
			return stub.legacyResponse;
		},
		completeMigration: async () => {
			stub.completeMigrationCalls++;
			if (stub.completeMigrationError) throw stub.completeMigrationError;
			return { alreadyMigrated: false };
		},
		// Required so `SyncEngine.persistMintedLock` can derive the
		// `keyHash` for `pending-lock.json`. The real `BackendClient`
		// just returns its in-memory copy of the user's `jolliApiKey`;
		// a string here suffices because the engine only feeds it to
		// `hashKey()` in `PendingLockStore`.
		getJolliApiKey: () => "sk-jol-acceptance-test",
	};
	return stub as unknown as StubBackend;
}
