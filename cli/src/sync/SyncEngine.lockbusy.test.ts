/**
 * Isolated coverage for SyncEngine's `VaultLockBusyError` path.
 *
 * `withPullLock` acquires `vault-write.lock` with a 10 s poll budget
 * (`DEFAULT_PULL_LOCK_WAIT_MS`). Forcing the "lock unavailable" branch by
 * actually holding the lock would make the suite poll for the full 10 s,
 * so this file mocks `./VaultWriteLock.js` to return `null` from
 * `acquireVaultWriteLock`. That mock is incompatible with the main
 * SyncEngine.test.ts (whose lock-refresh test needs the real lock), so it
 * lives here per the "isolate heavy mocks" rule.
 *
 * Covered regions in SyncEngine.ts:
 *   - `VaultLockBusyError` class constructor (the `name = …` line).
 *   - `withPullLock` `lock === null → throw VaultLockBusyError`.
 *   - `runRound`'s outer catch routing `VaultLockBusyError → network`.
 *   - the pull-step inner catch re-throwing `VaultLockBusyError`.
 *   - `pushWithRetry`'s non-FF catch mapping `VaultLockBusyError → network`.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomeDir, lockState } = vi.hoisted(() => ({
	mockHomeDir: { value: "" },
	// `available` toggles whether `acquireVaultWriteLock` hands back a handle
	// or signals "busy" (null). Hoisted so the module factory can read it.
	lockState: { available: false },
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: () => mockHomeDir.value };
});

// Mock the lock module: `acquireVaultWriteLock` returns null (busy) by
// default so `withPullLock` throws `VaultLockBusyError` synchronously
// rather than polling for 10 s. Keep `DEFAULT_PULL_LOCK_WAIT_MS` real.
vi.mock("./VaultWriteLock.js", async () => {
	const actual = await vi.importActual<typeof import("./VaultWriteLock.js")>("./VaultWriteLock.js");
	return {
		...actual,
		acquireVaultWriteLock: vi.fn(async () =>
			lockState.available ? { release: async () => undefined, refresh: async () => undefined } : null,
		),
	};
});

import type { BackendClient } from "./BackendClient.js";
import type { GitClient } from "./GitClient.js";
import type { RoundContext } from "./SyncEngine.js";
import { SyncEngine } from "./SyncEngine.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "syncengine-lockbusy-"));
	mockHomeDir.value = tempDir;
	lockState.available = false;
	await mkdir(join(tempDir, "vault", ".git"), { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeGitClient(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}): GitClient {
	return {
		checkGitInstalled: async () => ({ ok: true, version: "git version 2.50" }),
		clone: vi.fn(async () => undefined),
		fetch: vi.fn(async () => undefined),
		initRemote: vi.fn(async () => undefined),
		untrackPathGlob: vi.fn(async () => undefined),
		pullRebase: overrides.pullRebase ?? vi.fn(async () => ({ fastForwarded: false, conflicted: [] })),
		stageAll: vi.fn(async () => undefined),
		statusPorcelainZ: vi.fn(async () => []),
		stageAddPaths: vi.fn(async () => undefined),
		stageRemovePaths: vi.fn(async () => undefined),
		unstagePaths: vi.fn(async () => undefined),
		resetPathsToHead: vi.fn(async () => undefined),
		commit: vi.fn(async () => "deadbeef"),
		push: overrides.push ?? vi.fn(async () => ({ ok: true as const, transmitted: true })),
		currentHead: vi.fn(async () => "deadbeef"),
		hasHead: vi.fn(async () => true),
		getOriginUrl: vi.fn(async () => "https://github.com/jolli-vaults/test.git"),
		currentBranch: vi.fn(async () => "main"),
		checkoutBranch: vi.fn(async () => undefined),
		checkoutTrackingBranch: vi.fn(async () => undefined),
		recreateBranchAt: vi.fn(async () => undefined),
		refExists: vi.fn(async () => true),
		revParse: vi.fn(async () => "remoteoid"),
		isAncestor: vi.fn(async () => false),
		hasUncommittedChanges: vi.fn(async () => false),
		listDirtyPaths: vi.fn(async () => []),
		readIndexStage: async () => null,
		checkoutOurs: async () => undefined,
		checkoutTheirs: async () => undefined,
		rebaseContinue: async () => undefined,
		rebaseAbort: overrides.rebaseAbort ?? vi.fn(async () => undefined),
		isRebaseInProgress: vi.fn(async () => false),
		sweepStaleLockFiles: vi.fn(async () => ({ removed: [] })),
		hasUnmergedPaths: async () => [],
		addPath: async () => undefined,
	} as unknown as GitClient;
}

function makeBackend(): BackendClient {
	return {
		mintGitCredentials: vi.fn(async () => ({
			gitUrl: "https://github.com/jolli-vaults/test.git",
			token: "ghs_test",
			expiresAt: Date.now() + 3600_000,
			repoFullName: "jolli-vaults/test",
			defaultBranch: "main",
			githubRepoCreated: false,
			alreadyVaultBound: true as const,
			lockOwnerToken: "test-lock-owner-token" as const,
		})),
		notifyPush: vi.fn(async () => undefined),
		getLegacyContent: vi.fn(async () => ({ spaceId: 1, spaceSlug: "personal", alreadyMigrated: true, docs: [] })),
		completeMigration: vi.fn(async () => ({ alreadyMigrated: false })),
		releaseLock: vi.fn(async () => undefined),
		getJolliApiKey: vi.fn(async () => "sk-jol-test-fixture"),
	} as unknown as BackendClient;
}

function defaultContext(): RoundContext {
	return {
		memoryBankRoot: join(tempDir, "vault"),
		repoFolderName: "test",
		repoIdentity: "https://github.com/test-owner/test",
		author: { name: "Tester", email: "t@x" },
	};
}

function makeEngine(client: GitClient) {
	const bootstrap = { ensureBootstrap: vi.fn(async () => undefined) };
	const legacy = { apply: vi.fn(async () => ({ filesWritten: 0 })) };
	return new SyncEngine({
		backend: makeBackend(),
		resolveContext: async () => defaultContext(),
		makeGitClient: () => client,
		makeBootstrap: () => bootstrap as unknown as never,
		makeLegacyMigration: () => legacy as unknown as never,
		ai: async () => null,
		ui: { promptBinaryPick: async () => "skip" },
	});
}

const ROUND = { cwd: "/cwd", reason: "manual" as const, transcripts: false };

describe("SyncEngine — VaultLockBusyError (vault-write.lock held by a concurrent worker)", () => {
	it("routes the main-round pull-lock miss to a transient network outcome", async () => {
		// `lockState.available = false` → `withPullLock` (driving the main
		// step-4 pullRebase) gets `null`, throws `VaultLockBusyError`. The
		// pull-step inner catch re-throws it (rather than mislabelling it
		// pull_failed), and runRound's outer catch maps it to the transient
		// `network` code so the next poll retries instead of a red "Sync
		// failed".
		const engine = makeEngine(makeGitClient());
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("network");
		expect(result.lastError?.message).toContain("vault-write.lock");
	});

	it("maps a busy pull-lock inside the non-FF push retry to network (not sync_failed)", async () => {
		// Sequence the lock so the FIRST acquire (main step-4 pull) succeeds
		// but the SECOND (the non-FF push retry's pullRebaseLocked) misses.
		// That exercises `pushWithRetry`'s catch arm that maps
		// `VaultLockBusyError → network`, distinct from the main-round
		// catch covered above.
		const { acquireVaultWriteLock } = await import("./VaultWriteLock.js");
		const mocked = acquireVaultWriteLock as unknown as ReturnType<typeof vi.fn>;
		mocked.mockReset();
		// First call: real-ish handle. Subsequent calls: busy (null).
		mocked
			.mockResolvedValueOnce({ release: async () => undefined, refresh: async () => undefined })
			.mockResolvedValue(null);
		const push = vi.fn(async () => ({
			ok: false as const,
			nonFastForward: true,
			unauthorized: false,
			message: "non-fast-forward",
		}));
		const engine = makeEngine(makeGitClient({ push }));
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		// The non-FF retry's pullRebaseLocked hit a busy lock → mapped to
		// transient network rather than terminal sync_failed_after_retries.
		expect(result.lastError?.code).toBe("network");
	});
});
