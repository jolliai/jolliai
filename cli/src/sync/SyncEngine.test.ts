/**
 * Tests for SyncEngine — round-driver orchestration. All filesystem and
 * network deps are stubbed; we exercise the state-machine transitions and
 * lock/retry behaviour without touching git or backend.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomeDir } = vi.hoisted(() => ({
	mockHomeDir: { value: "" },
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: () => mockHomeDir.value };
});

import { type BackendClient, SyncBackendNetworkError } from "./BackendClient.js";
import type { GitClient } from "./GitClient.js";
import type { RoundContext } from "./SyncEngine.js";
import { SyncEngine } from "./SyncEngine.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "syncengine-"));
	mockHomeDir.value = tempDir;
	// Pre-create `<memoryBankRoot>/.git` so the default code path treats the
	// vault as already cloned and exercises the fetch branch. Tests that
	// want the clone branch (first-bind, clone-on-missing) delete this
	// before invoking the engine.
	await mkdir(join(tempDir, "vault", ".git"), { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

// ── Stubs ─────────────────────────────────────────────────────────────

interface VaultClientStub {
	checkGitInstalled?: () => Promise<{ ok: true; version: string } | { ok: false }>;
	clone?: ReturnType<typeof vi.fn>;
	fetch?: ReturnType<typeof vi.fn>;
	pullRebase?: ReturnType<typeof vi.fn>;
	stageAll?: ReturnType<typeof vi.fn>;
	// Allowlist-staging additions (Phase 1). Default stubs return empty
	// `statusPorcelainZ` output so `stageVault` becomes a no-op in the
	// existing fixture path — tests that exercise the allowlist directly
	// override these.
	statusPorcelainZ?: ReturnType<typeof vi.fn>;
	stageAddPaths?: ReturnType<typeof vi.fn>;
	stageRemovePaths?: ReturnType<typeof vi.fn>;
	unstagePaths?: ReturnType<typeof vi.fn>;
	commit?: ReturnType<typeof vi.fn>;
	push?: ReturnType<typeof vi.fn>;
	currentHead?: ReturnType<typeof vi.fn>;
	hasHead?: ReturnType<typeof vi.fn>;
}

function makeGitClient(
	overrides: VaultClientStub & {
		hasUncommittedChanges?: ReturnType<typeof vi.fn>;
		listDirtyPaths?: ReturnType<typeof vi.fn>;
		rebaseAbort?: ReturnType<typeof vi.fn>;
		isRebaseInProgress?: ReturnType<typeof vi.fn>;
		sweepStaleLockFiles?: ReturnType<typeof vi.fn>;
		initRemote?: ReturnType<typeof vi.fn>;
		untrackPathGlob?: ReturnType<typeof vi.fn>;
		getOriginUrl?: ReturnType<typeof vi.fn>;
		currentBranch?: ReturnType<typeof vi.fn>;
		checkoutBranch?: ReturnType<typeof vi.fn>;
		checkoutTrackingBranch?: ReturnType<typeof vi.fn>;
		recreateBranchAt?: ReturnType<typeof vi.fn>;
		refExists?: ReturnType<typeof vi.fn>;
		revParse?: ReturnType<typeof vi.fn>;
		isAncestor?: ReturnType<typeof vi.fn>;
	} = {},
): GitClient {
	return {
		checkGitInstalled: overrides.checkGitInstalled ?? (async () => ({ ok: true, version: "git version 2.50" })),
		clone: overrides.clone ?? vi.fn(async () => undefined),
		fetch: overrides.fetch ?? vi.fn(async () => undefined),
		initRemote: overrides.initRemote ?? vi.fn(async () => undefined),
		untrackPathGlob: overrides.untrackPathGlob ?? vi.fn(async () => undefined),
		pullRebase: overrides.pullRebase ?? vi.fn(async () => ({ fastForwarded: false, conflicted: [] })),
		stageAll: overrides.stageAll ?? vi.fn(async () => undefined),
		// Default empty porcelain → `stageVault` is a no-op (no entries to
		// classify, nothing to add/remove). Existing tests that mock the
		// staging step don't need to know about porcelain; the few tests
		// that DO exercise the allowlist path override `statusPorcelainZ`.
		statusPorcelainZ: overrides.statusPorcelainZ ?? vi.fn(async () => []),
		stageAddPaths: overrides.stageAddPaths ?? vi.fn(async () => undefined),
		stageRemovePaths: overrides.stageRemovePaths ?? vi.fn(async () => undefined),
		unstagePaths: overrides.unstagePaths ?? vi.fn(async () => undefined),
		resetPathsToHead: vi.fn(async () => undefined),
		commit: overrides.commit ?? vi.fn(async () => "deadbeef"),
		push: overrides.push ?? vi.fn(async () => ({ ok: true as const, transmitted: true })),
		currentHead: overrides.currentHead ?? vi.fn(async () => "deadbeef"),
		hasHead: overrides.hasHead ?? vi.fn(async () => true),
		// §P1#1 — vault identity guard. Default origin URL matches the
		// default creds' `gitUrl` so the existing fixture path goes through
		// the backfill branch (silently writes the marker once). Tests that
		// want mismatch / null origin override this.
		getOriginUrl: overrides.getOriginUrl ?? vi.fn(async () => "https://github.com/jolli-vaults/test.git"),
		// §P1#2 — default-branch guard. Default branch matches creds so
		// `ensureOnDefaultBranch` short-circuits. Tests that want the
		// switch path override this.
		currentBranch: overrides.currentBranch ?? vi.fn(async () => "main"),
		checkoutBranch: overrides.checkoutBranch ?? vi.fn(async () => undefined),
		checkoutTrackingBranch: overrides.checkoutTrackingBranch ?? vi.fn(async () => undefined),
		// §P2 revised — ancestry checks for the fast-forward recovery.
		// Defaults assume HEAD === default so neither helper is consulted.
		// Tests that exercise the side-branch paths override these.
		recreateBranchAt: overrides.recreateBranchAt ?? vi.fn(async () => undefined),
		refExists: overrides.refExists ?? vi.fn(async () => true),
		// Default to a remote head that DIFFERS from the stubbed local
		// HEAD ("deadbeef") so the idle-round short-circuit doesn't fire
		// by default and existing tests keep exercising the full
		// commit+push path. The short-circuit suite below overrides this
		// to match.
		revParse: overrides.revParse ?? vi.fn(async () => "remoteoid"),
		isAncestor: overrides.isAncestor ?? vi.fn(async () => false),
		// Methods we don't drive in these tests but the interface requires.
		hasUncommittedChanges: overrides.hasUncommittedChanges ?? vi.fn(async () => false),
		listDirtyPaths: overrides.listDirtyPaths ?? vi.fn(async () => []),
		readIndexStage: async () => null,
		checkoutOurs: async () => undefined,
		checkoutTheirs: async () => undefined,
		rebaseContinue: async () => undefined,
		rebaseAbort: overrides.rebaseAbort ?? vi.fn(async () => undefined),
		// Self-heal probes — default to clean state. Tests exercising the
		// recovery paths override these.
		isRebaseInProgress: overrides.isRebaseInProgress ?? vi.fn(async () => false),
		sweepStaleLockFiles: overrides.sweepStaleLockFiles ?? vi.fn(async () => ({ removed: [] })),
		hasUnmergedPaths: async () => [],
		addPath: async () => undefined,
	} as unknown as GitClient;
}

function makeBackend(overrides: Partial<BackendClient> = {}): BackendClient {
	return {
		mintGitCredentials:
			overrides.mintGitCredentials ??
			vi.fn(async () => ({
				gitUrl: "https://github.com/jolli-vaults/test.git",
				token: "ghs_test",
				expiresAt: Date.now() + 3600_000,
				repoFullName: "jolli-vaults/test",
				defaultBranch: "main",
				githubRepoCreated: false,
				alreadyVaultBound: true as const,
				lockOwnerToken: "test-lock-owner-token" as const,
			})),
		notifyPush: overrides.notifyPush ?? vi.fn(async () => undefined),
		getLegacyContent:
			overrides.getLegacyContent ??
			vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: true,
				docs: [],
			})),
		completeMigration: overrides.completeMigration ?? vi.fn(async () => ({ alreadyMigrated: false })),
		// Default to a stable test api key so `PendingLockStore` lookups
		// scope to this fixture (mocked `homedir` already isolates the
		// underlying file to the per-test tempDir). Tests that want to
		// exercise the signed-out / no-key path override with `undefined`.
		getJolliApiKey: overrides.getJolliApiKey ?? vi.fn(async () => "sk-jol-test-fixture"),
	} as BackendClient;
}

function defaultContext(): RoundContext {
	return {
		memoryBankRoot: join(tempDir, "vault"),
		repoFolderName: "test",
		repoIdentity: "https://github.com/test-owner/test",
		author: { name: "Tester", email: "t@x" },
	};
}

function makeEngine(
	overrides: {
		client?: GitClient;
		backend?: BackendClient;
		context?: RoundContext;
		ui?: import("./ConflictResolver.js").ConflictUi;
		makeResolver?: import("./SyncEngine.js").SyncEngineOpts["makeResolver"];
		makeBootstrap?: import("./SyncEngine.js").SyncEngineOpts["makeBootstrap"];
		makeLegacyMigration?: import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"];
		lockTimeoutMs?: number;
		onStateChange?: (s: import("./SyncTypes.js").SyncState) => void;
		vaultLockedRetrySchedule?: ReadonlyArray<number>;
		onLockedWait?: import("./SyncEngine.js").SyncEngineOpts["onLockedWait"];
	} = {},
) {
	const client = overrides.client ?? makeGitClient();
	const backend = overrides.backend ?? makeBackend();
	const ctx = overrides.context ?? defaultContext();
	const ui: import("./ConflictResolver.js").ConflictUi = overrides.ui ?? {
		promptBinaryPick: async () => "skip",
	};
	const bootstrap = { ensureBootstrap: vi.fn(async () => undefined) };
	const legacy = { apply: vi.fn(async () => ({ filesWritten: 0 })) };
	return {
		engine: new SyncEngine({
			backend,
			resolveContext: async () => ctx,
			makeGitClient: () => client,
			makeBootstrap:
				overrides.makeBootstrap ??
				(() =>
					bootstrap as unknown as ReturnType<
						NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeBootstrap"]>
					>),
			makeLegacyMigration:
				overrides.makeLegacyMigration ??
				(() =>
					legacy as unknown as ReturnType<
						NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
					>),
			makeResolver: overrides.makeResolver,
			ai: async () => null,
			ui,
			onStateChange: overrides.onStateChange,
			lockTimeoutMs: overrides.lockTimeoutMs,
			vaultLockedRetrySchedule: overrides.vaultLockedRetrySchedule,
			onLockedWait: overrides.onLockedWait,
		}),
		client,
		backend,
		bootstrap,
		legacy,
	};
}

const ROUND = { cwd: "/cwd", reason: "manual" as const, transcripts: false };

// ── Tests ─────────────────────────────────────────────────────────────

describe("SyncEngine.runRound — happy path", () => {
	it("returns synced when fetch + pull + mirror + push all succeed", async () => {
		const states: string[] = [];
		const { engine, backend, client } = makeEngine({
			onStateChange: (s) => states.push(s),
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(result.fetched).toBe(true);
		expect(result.pulled).toBe(true);
		expect(result.pushed).toBe(true);
		expect(states).toEqual(["synced"]);
		expect(backend.notifyPush).toHaveBeenCalledWith({
			commitSha: "deadbeef",
			branch: "main",
			lockOwnerToken: "test-lock-owner-token",
		});
		expect(client.fetch).toHaveBeenCalled();
		expect(client.push).toHaveBeenCalled();
	});

	it("swallows a notifyPush error without changing the synced verdict", async () => {
		const backend = makeBackend({
			notifyPush: async () => {
				throw new Error("transient");
			},
		});
		const { engine } = makeEngine({ backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
	});

	it("skips notifyPush when push was idempotent ('Everything up-to-date')", async () => {
		// Idle poll tick: nothing changed locally, git push reports "Everything
		// up-to-date" → engine must NOT pelt the backend with the same SHA every
		// 90 minutes (plan §0.8 — backend rate-limit signal stays clean).
		const client = makeGitClient({
			push: vi.fn(async () => ({ ok: true as const, transmitted: false })),
		});
		const { engine, backend } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(backend.notifyPush).not.toHaveBeenCalled();
	});

	it("fires notifyPush when push actually transmitted commits", async () => {
		const client = makeGitClient({
			push: vi.fn(async () => ({ ok: true as const, transmitted: true })),
		});
		const { engine, backend } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(backend.notifyPush).toHaveBeenCalledTimes(1);
	});
});

describe("SyncEngine.runRound — offline transitions", () => {
	it("goes offline when mintGitCredentials throws a network error", async () => {
		const backend = makeBackend({
			mintGitCredentials: async () => {
				throw new SyncBackendNetworkError(new Error("ECONNREFUSED"));
			},
		});
		const { engine } = makeEngine({ backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
	});

	it("goes offline when git is not installed", async () => {
		const client = makeGitClient({ checkGitInstalled: async () => ({ ok: false }) });
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
	});

	it("goes offline when pullRebase throws (non-conflict failure)", async () => {
		const client = makeGitClient({
			pullRebase: vi.fn(async () => {
				throw new Error("git pull --rebase failed: network");
			}),
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
	});

	it("clones when <memoryBankRoot>/.git does not exist (fresh first-bind)", async () => {
		await rm(join(tempDir, "vault"), { recursive: true, force: true });
		const cloneSpy = vi.fn(async () => undefined);
		const client = makeGitClient({ clone: cloneSpy });
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(cloneSpy).toHaveBeenCalled();
		expect(result.newState).toBe("synced");
	});

	it("goes offline when clone fails on a fresh first-bind", async () => {
		await rm(join(tempDir, "vault"), { recursive: true, force: true });
		const client = makeGitClient({
			clone: vi.fn(async () => {
				throw new Error("ENOSPC");
			}),
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
	});

	it("init-in-place when <memoryBankRoot> has content but no .git (first-bind init branch)", async () => {
		// Memory Bank folder pre-existed (FolderStorage already populated it,
		// or user re-pointed to a non-empty dir). `.git` doesn't exist yet:
		// engine must take the init branch — NOT clone (clone would refuse a
		// non-empty target) and NOT fetch (no repo to fetch into). Also
		// exercises the post-init audit log path.
		await rm(join(tempDir, "vault", ".git"), { recursive: true, force: true });
		await writeFile(join(tempDir, "vault", "stray.md"), "pre-existing content\n");
		const cloneSpy = vi.fn(async () => undefined);
		const initRemoteSpy = vi.fn(async () => undefined);
		const client = makeGitClient({ clone: cloneSpy, initRemote: initRemoteSpy });
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(initRemoteSpy).toHaveBeenCalled();
		expect(cloneSpy).not.toHaveBeenCalled();
		expect(result.newState).toBe("synced");
	});
});

describe("SyncEngine.runRound — vault identity guard (§P1#1)", () => {
	// All cases here share the `<memoryBankRoot>/.git` pre-created by the
	// top-level beforeEach, so the engine goes through the `hasGit` →
	// guardVaultIdentity branch (not clone / init).

	async function readMarker() {
		const path = join(tempDir, "vault", ".git", "jolli-vault-identity.json");
		const { readFile } = await import("node:fs/promises");
		try {
			return JSON.parse(await readFile(path, "utf-8")) as { gitUrl?: string };
		} catch {
			return null;
		}
	}

	it("goes offline with vault_mismatch when origin URL points at a different repo (refuses to write)", async () => {
		// User picked a random source repo as the Memory Bank folder. The
		// engine fetches fresh creds for the personal-space repo, then sees
		// origin pointing somewhere else → terminal `vault_mismatch`.
		const fetchSpy = vi.fn(async () => undefined);
		const pushSpy = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const client = makeGitClient({
			getOriginUrl: vi.fn(async () => "https://github.com/someone-else/source-repo.git"),
			fetch: fetchSpy,
			push: pushSpy,
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("vault_mismatch");
		// Critical safety property: NOTHING was written or transmitted.
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(pushSpy).not.toHaveBeenCalled();
	});

	it("goes offline with vault_mismatch when getOriginUrl returns null (no remote configured)", async () => {
		const fetchSpy = vi.fn(async () => undefined);
		const client = makeGitClient({
			getOriginUrl: vi.fn(async () => null),
			fetch: fetchSpy,
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("vault_mismatch");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("silently backfills the marker on a pre-§P1#1 vault (origin matches, no marker yet)", async () => {
		// Default stub: origin URL matches creds. No marker on disk yet
		// (beforeEach only creates `.git/`, not the marker file). After
		// the round, the marker should exist on disk with the matching
		// URL, AND the round should have completed normally.
		expect(await readMarker()).toBeNull();
		const { engine } = makeEngine();
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		const marker = await readMarker();
		expect(marker?.gitUrl).toBe("https://github.com/jolli-vaults/test");
	});

	it("rejects a marker whose URL disagrees with the current credentials", async () => {
		// User's personal space was re-pointed (or the marker was tampered
		// with). Marker says vault belongs to `old-vault`, but creds now
		// mint `test`. Even with the live origin matching creds, the
		// marker mismatch surfaces vault_mismatch.
		const { writeVaultMarker } = await import("./VaultMarker.js");
		await writeVaultMarker(join(tempDir, "vault"), {
			gitUrl: "https://github.com/jolli-vaults/old-vault.git",
			token: "stale",
			expiresAt: 0,
			repoFullName: "jolli-vaults/old-vault",
			defaultBranch: "main",
			githubRepoCreated: false,
			alreadyVaultBound: true,
			lockOwnerToken: "test-lock-owner-token",
		});
		const fetchSpy = vi.fn(async () => undefined);
		const client = makeGitClient({ fetch: fetchSpy });
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("vault_mismatch");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("writes the marker after a fresh clone (cold-start path)", async () => {
		await rm(join(tempDir, "vault"), { recursive: true, force: true });
		const client = makeGitClient({
			// `clone` would normally create `.git/`; emulate that here so
			// `writeVaultMarker` finds a place to land the file.
			clone: vi.fn(async () => {
				await mkdir(join(tempDir, "vault", ".git"), { recursive: true });
			}),
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(await readMarker()).not.toBeNull();
	});
});

describe("SyncEngine.runRound — default-branch guard (§P1#2 / P2 revised)", () => {
	// `isAncestor(a, b)` is consulted twice per branch-recovery path:
	// first `isAncestor(head, default)`, then `isAncestor(default, head)`.
	// Helper builds a matcher that pretends the side branch is in a
	// specific relationship with default for the tests below.
	function ancestryStub(rel: "head-behind" | "head-ahead" | "divergent") {
		return vi.fn(async (a: string, b: string) => {
			if (rel === "head-behind") return a !== "main" && b === "main"; // head ⊆ default
			if (rel === "head-ahead") return a === "main" && b !== "main"; // default ⊆ head
			return false; // divergent: neither ancestor of the other
		});
	}

	it("plain switch when HEAD is behind default (head ⊆ default)", async () => {
		const checkoutSpy = vi.fn(async () => undefined);
		const recreateSpy = vi.fn(async () => undefined);
		const client = makeGitClient({
			currentBranch: vi.fn(async () => "old-head"),
			isAncestor: ancestryStub("head-behind"),
			checkoutBranch: checkoutSpy,
			recreateBranchAt: recreateSpy,
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(checkoutSpy).toHaveBeenCalledWith("main");
		expect(recreateSpy).not.toHaveBeenCalled();
	});

	it("fast-forwards default to HEAD when HEAD is strictly ahead (recovers pre-§P1#2 stranded commits)", async () => {
		// The original P1#2 bug stranded N commits on `side` because the
		// buggy push pushed local default (stale). With the fast-forward
		// recovery, default is reset to HEAD's tip so the next push ships
		// those commits.
		const checkoutSpy = vi.fn(async () => undefined);
		const recreateSpy = vi.fn(async () => undefined);
		const client = makeGitClient({
			currentBranch: vi.fn(async () => "side"),
			isAncestor: ancestryStub("head-ahead"),
			checkoutBranch: checkoutSpy,
			recreateBranchAt: recreateSpy,
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		// Default ref was fast-forwarded to the side branch's tip.
		expect(recreateSpy).toHaveBeenCalledWith("main", "side");
		// No plain `git checkout main` was needed — `checkout -B main side`
		// covers both the ref move and the HEAD switch in one operation.
		expect(checkoutSpy).not.toHaveBeenCalled();
	});

	it("preserves dirty side-branch work via a commit before the ancestry checks", async () => {
		// Pending uncommitted work on `side` must land on `side` first so
		// the subsequent isAncestor(default, head) check sees it. Without
		// the pre-commit, `head` would be at side's last commit and the
		// dirty work would be invisible to the ancestry detector.
		const commitSpy = vi.fn(async () => "side_sha");
		const recreateSpy = vi.fn(async () => undefined);
		const client = makeGitClient({
			currentBranch: vi.fn(async () => "side"),
			hasUncommittedChanges: vi.fn(async () => true),
			commit: commitSpy,
			isAncestor: ancestryStub("head-ahead"),
			recreateBranchAt: recreateSpy,
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		// First commit on side is the preserve-work message.
		expect(commitSpy).toHaveBeenCalledWith(expect.stringContaining("preserve work from side"), expect.anything());
		// Then default is fast-forwarded to side's tip.
		expect(recreateSpy).toHaveBeenCalledWith("main", "side");
	});

	it("goes offline with vault_mismatch when head and default have diverged", async () => {
		// Both branches contain commits the other doesn't. Auto-merging
		// risks data loss; the engine refuses and lets the user resolve.
		const recreateSpy = vi.fn(async () => undefined);
		const checkoutSpy = vi.fn(async () => undefined);
		const client = makeGitClient({
			currentBranch: vi.fn(async () => "side"),
			isAncestor: ancestryStub("divergent"),
			checkoutBranch: checkoutSpy,
			recreateBranchAt: recreateSpy,
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("vault_mismatch");
		expect(result.lastError?.message).toMatch(/diverged/);
		expect(recreateSpy).not.toHaveBeenCalled();
		expect(checkoutSpy).not.toHaveBeenCalled();
	});

	it("recreates the local default from origin/default when local ref is missing", async () => {
		// Shallow clone or pruned local default — fall back to creating
		// it fresh from the tracking ref. Side commits remain on the
		// side ref locally; reflog still has them.
		const trackingSpy = vi.fn(async () => undefined);
		const checkoutSpy = vi.fn(async () => undefined);
		const recreateSpy = vi.fn(async () => undefined);
		const client = makeGitClient({
			currentBranch: vi.fn(async () => "side"),
			refExists: vi.fn(async () => false),
			checkoutTrackingBranch: trackingSpy,
			checkoutBranch: checkoutSpy,
			recreateBranchAt: recreateSpy,
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(trackingSpy).toHaveBeenCalledWith("main");
		expect(checkoutSpy).not.toHaveBeenCalled();
		expect(recreateSpy).not.toHaveBeenCalled();
	});

	it("does not invoke any branch switch when HEAD is already on the default branch", async () => {
		const checkoutSpy = vi.fn(async () => undefined);
		const recreateSpy = vi.fn(async () => undefined);
		const refExistsSpy = vi.fn(async () => true);
		const isAncestorSpy = vi.fn(async () => false);
		const client = makeGitClient({
			currentBranch: vi.fn(async () => "main"),
			checkoutBranch: checkoutSpy,
			recreateBranchAt: recreateSpy,
			refExists: refExistsSpy,
			isAncestor: isAncestorSpy,
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		// Short-circuit BEFORE any of the ancestry helpers fire. The
		// empty-remote pullRebase guard does call `refExists` separately —
		// for `refs/remotes/origin/<default>` — so we assert no
		// branch-switch refs (`refs/heads/...`) were probed instead of a
		// blanket "not called" check.
		expect(checkoutSpy).not.toHaveBeenCalled();
		expect(recreateSpy).not.toHaveBeenCalled();
		const branchSwitchProbes = refExistsSpy.mock.calls.filter(
			(args: unknown[]) => typeof args[0] === "string" && args[0].startsWith("refs/heads/"),
		);
		expect(branchSwitchProbes).toHaveLength(0);
		expect(isAncestorSpy).not.toHaveBeenCalled();
	});

	it("goes offline with vault_mismatch when the recovery itself errors out", async () => {
		const client = makeGitClient({
			currentBranch: vi.fn(async () => "side"),
			isAncestor: ancestryStub("head-ahead"),
			recreateBranchAt: vi.fn(async () => {
				throw new Error("disk full or something");
			}),
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("vault_mismatch");
	});
});

describe("SyncEngine.runRound — conflicts surface", () => {
	it("returns conflicts when the resolver returns skipped paths", async () => {
		const resolverStub = {
			resolveAll: vi.fn(async () => ({
				resolved: [],
				skipped: ["notes/foo.md"],
				aiMerged: [],
				binaryPicked: [],
				rebaseAdvanced: false,
			})),
		};
		const client = makeGitClient({
			pullRebase: vi.fn(async () => ({
				fastForwarded: false,
				conflicted: ["notes/foo.md"],
			})),
		});
		const { engine } = makeEngine({
			client,
			makeResolver: () => resolverStub as unknown as import("./ConflictResolver.js").ConflictResolver,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("conflicts");
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.path).toBe("notes/foo.md");
	});

	it("continues to push when the resolver advances the rebase", async () => {
		const resolverStub = {
			resolveAll: vi.fn(async () => ({
				resolved: ["notes/foo.md"],
				skipped: [],
				aiMerged: [],
				binaryPicked: [{ path: "notes/foo.md", pick: "mine" as const }],
				rebaseAdvanced: true,
			})),
		};
		const client = makeGitClient({
			pullRebase: vi.fn(async () => ({
				fastForwarded: false,
				conflicted: ["notes/foo.md"],
			})),
		});
		const { engine } = makeEngine({
			client,
			makeResolver: () => resolverStub as unknown as import("./ConflictResolver.js").ConflictResolver,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(client.push).toHaveBeenCalled();
	});
});

describe("SyncEngine.runRound — onRoundComplete (P2 #1 chain-spawn hook)", () => {
	it("fires onRoundComplete with the round cwd after a successful round", async () => {
		const onRoundComplete = vi.fn();
		const { engine } = makeEngine();
		(engine as unknown as { opts: { onRoundComplete: typeof onRoundComplete } }).opts.onRoundComplete =
			onRoundComplete;
		await engine.runRound(ROUND);
		expect(onRoundComplete).toHaveBeenCalledTimes(1);
		expect(onRoundComplete).toHaveBeenCalledWith(ROUND.cwd);
	});

	it("fires onRoundComplete even when the round goes offline (worker still needs the wake-up)", async () => {
		// The chain-spawn promise is "after sync releases its locks, try
		// the queue again" — outcome-independent. A round that failed for
		// network reasons released the same locks; the worker that was
		// blocked behind them must still be re-spawned.
		const onRoundComplete = vi.fn();
		const { engine } = makeEngine({
			client: makeGitClient({
				pullRebase: vi.fn(async () => {
					throw new Error("simulated transient network failure");
				}),
			}),
		});
		(engine as unknown as { opts: { onRoundComplete: typeof onRoundComplete } }).opts.onRoundComplete =
			onRoundComplete;
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(onRoundComplete).toHaveBeenCalledTimes(1);
		expect(onRoundComplete).toHaveBeenCalledWith(ROUND.cwd);
	});

	it("swallows onRoundComplete throws — a buggy hook must not poison the round result", async () => {
		// The hook IS best-effort (launchWorker spawns a detached child).
		// Errors thrown by the callback would otherwise surface as a
		// round-level offline result, masking the actual state from the user.
		const onRoundComplete = vi.fn(() => {
			throw new Error("callback boom");
		});
		const { engine } = makeEngine();
		(engine as unknown as { opts: { onRoundComplete: typeof onRoundComplete } }).opts.onRoundComplete =
			onRoundComplete;
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(onRoundComplete).toHaveBeenCalled();
	});
});

describe("SyncEngine.runRound — vault-write.lock refresh during long pullRebase", () => {
	it("refreshes `vault-write.lock` mtime while `withPullLock` holds it across a long resolver", async () => {
		// Regression guard: a Tier-2-heavy or Tier-3-prompt conflict round
		// can exceed `LOCK_TIMEOUT_MS` (5 min). Without an in-flight refresh
		// the lock's mtime falls behind and a peer `acquireWithPoll` would
		// reclaim it — reopening R9. The refresher inside `withPullLock`
		// must drive `lock.refresh()` on the configured interval so the
		// mtime keeps advancing for as long as `pullRebase` + the resolver
		// are running.
		const { getVaultWriteLockPath } = await import("./VaultLockPath.js");
		const memoryBankRoot = join(tempDir, "vault");
		const lockPath = getVaultWriteLockPath(memoryBankRoot);

		// Sample the lock's mtime at multiple points during a deliberately
		// slow `pullRebase`. With `refreshIntervalMs: 20 ms` and the
		// pullRebase paused for ~120 ms, we expect at least one tick of the
		// refresher to fire — mtime[end] > mtime[start].
		let mtimeAtStart = 0;
		let mtimeAtEnd = 0;
		const client = makeGitClient({
			pullRebase: vi.fn(async () => {
				mtimeAtStart = (await stat(lockPath)).mtimeMs;
				// Hold the lock window open long enough for the 20 ms
				// refresher to tick at least once. Two refreshes would be
				// ideal, but FS mtime resolution on some platforms is 10 ms
				// — a single confirmed bump is enough to prove the wiring.
				await new Promise((r) => setTimeout(r, 120));
				mtimeAtEnd = (await stat(lockPath)).mtimeMs;
				return { fastForwarded: false, conflicted: [] };
			}),
		});
		const { engine } = makeEngine({ client });
		// `refreshIntervalMs` is shared with the `sync.lock` refresher
		// (both run from the same option) — 20 ms is well below any
		// pullRebase duration, including the artificial 120 ms above.
		(engine as unknown as { opts: { refreshIntervalMs: number } }).opts.refreshIntervalMs = 20;

		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(mtimeAtStart).toBeGreaterThan(0);
		// Strict-greater asserts the refresher fired at least once during
		// the held window. If this fails, the `setInterval` wiring inside
		// `withPullLock` is gone and long conflict rounds can lose the lock.
		expect(mtimeAtEnd).toBeGreaterThan(mtimeAtStart);
	});
});

describe("SyncEngine.runRound — push retry", () => {
	it("retries on non-FF and succeeds after a pullRebase integrates the remote", async () => {
		let pushAttempts = 0;
		const client = makeGitClient({
			push: vi.fn(async () => {
				pushAttempts++;
				if (pushAttempts === 1) {
					return {
						ok: false as const,
						nonFastForward: true,
						unauthorized: false,
						message: "non-fast-forward",
					};
				}
				return { ok: true as const, transmitted: true };
			}),
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(pushAttempts).toBe(2);
	});

	it("gives up after exhausting retries on persistent non-FF", async () => {
		const client = makeGitClient({
			push: vi.fn(async () => ({
				ok: false as const,
				nonFastForward: true,
				unauthorized: false,
				message: "non-fast-forward",
			})),
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
	});

	it("surfaces non-recoverable push failure (not non-FF)", async () => {
		const client = makeGitClient({
			push: vi.fn(async () => ({
				ok: false as const,
				nonFastForward: false,
				unauthorized: false,
				message: "fatal: auth",
			})),
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
	});
});

describe("SyncEngine.runRound — 401 auth retry", () => {
	it("re-mints credentials and retries push exactly once on a 401 reply", async () => {
		let pushAttempts = 0;
		const client = makeGitClient({
			push: vi.fn(async () => {
				pushAttempts++;
				if (pushAttempts === 1) {
					return {
						ok: false as const,
						nonFastForward: false,
						unauthorized: true,
						message: "fatal: Authentication failed",
					};
				}
				return { ok: true as const, transmitted: true };
			}),
		});
		const mintCalls = vi.fn(async () => ({
			gitUrl: "https://github.com/jolli-vaults/test.git",
			token: `ghs_${Math.random().toString(36).slice(2)}`,
			expiresAt: Date.now() + 3600_000,
			repoFullName: "jolli-vaults/test",
			defaultBranch: "main",
			githubRepoCreated: false,
			alreadyVaultBound: true as const,
			lockOwnerToken: "test-lock-owner-token" as const,
		}));
		const backend = makeBackend({ mintGitCredentials: mintCalls });
		const { engine } = makeEngine({ client, backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(pushAttempts).toBe(2);
		// First mint (round start) + re-mint after 401 = 2 calls.
		expect(mintCalls).toHaveBeenCalledTimes(2);
	});

	it("does not loop on persistent 401 (gives up after one retry)", async () => {
		const client = makeGitClient({
			push: vi.fn(async () => ({
				ok: false as const,
				nonFastForward: false,
				unauthorized: true,
				message: "Authentication failed",
			})),
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		// 2 push attempts total — one with stale token, one with fresh token,
		// both rejected — engine gives up rather than spinning.
		expect(client.push).toHaveBeenCalledTimes(2);
	});

	it("goes offline when the 401-driven re-mint itself fails", async () => {
		let mintCount = 0;
		const backend = makeBackend({
			mintGitCredentials: vi.fn(async () => {
				mintCount++;
				if (mintCount === 1) {
					return {
						gitUrl: "https://github.com/x.git",
						token: "ghs_stale",
						expiresAt: Date.now() + 3600_000,
						repoFullName: "jolli-vaults/x",
						defaultBranch: "main",
						githubRepoCreated: false,
						alreadyVaultBound: true as const,
						lockOwnerToken: "test-lock-owner-token" as const,
					};
				}
				throw new SyncBackendNetworkError(new Error("ECONNREFUSED"));
			}),
		});
		const client = makeGitClient({
			push: vi.fn(async () => ({
				ok: false as const,
				nonFastForward: false,
				unauthorized: true,
				message: "401",
			})),
		});
		const { engine } = makeEngine({ client, backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
	});
});

describe("SyncEngine.runRound — first-bind commit message", () => {
	it("uses `[jolli-mb] migrate: ...` when fetchOrClone took the clone branch", async () => {
		// Force the clone branch by removing the pre-populated `.git` dir
		// so `pathExists` returns false and the engine goes straight to clone.
		await rm(join(tempDir, "vault"), { recursive: true, force: true });
		const commit = vi.fn(async (_msg: string, _author: { name: string; email: string }) => "deadbeef");
		const client = makeGitClient({
			clone: vi.fn(async () => undefined),
			commit,
		});
		const { engine } = makeEngine({ client });
		await engine.runRound(ROUND);
		const callArgs = commit.mock.calls[0];
		if (!callArgs) throw new Error("commit was never called");
		const [msg] = callArgs;
		expect(String(msg)).toContain("[jolli-mb] migrate:");
		expect(String(msg)).toContain("initial bootstrap");
	});

	it("uses `[jolli-mb] add: ...` on a regular fetch round", async () => {
		const commit = vi.fn(async (_msg: string, _author: { name: string; email: string }) => "deadbeef");
		const client = makeGitClient({ commit });
		const { engine } = makeEngine({ client });
		await engine.runRound(ROUND);
		const callArgs = commit.mock.calls[0];
		if (!callArgs) throw new Error("commit was never called");
		const [msg] = callArgs;
		expect(String(msg)).toContain("[jolli-mb] add:");
		expect(String(msg)).not.toContain("migrate");
	});
});

describe("SyncEngine.runRound — db→git first-bind migration", () => {
	function dbBackingMint() {
		return vi.fn(async () => ({
			gitUrl: "https://github.com/jolli-vaults/test.git",
			token: "ghs_test",
			expiresAt: Date.now() + 3600_000,
			repoFullName: "jolli-vaults/test",
			defaultBranch: "main",
			githubRepoCreated: true,
			alreadyVaultBound: false as const,
			lockOwnerToken: "test-lock-owner-token" as const,
		}));
	}

	it("calls getLegacyContent + applyLegacyContent + commit(migrate) + push + completeMigration when backing=db", async () => {
		const applyLegacy = vi.fn(async () => ({ filesWritten: 7 }));
		const commit = vi.fn(
			async (_msg: string, _author: { name: string; email: string }) =>
				"abc12340000000000000000000000000000000ab",
		);
		const getLegacy = vi.fn(async () => ({
			spaceId: 1,
			spaceSlug: "personal",
			alreadyMigrated: false,
			docs: [
				{
					id: 1,
					jrn: "doc:1",
					slug: "x",
					path: "/",
					docType: "document",
					parentId: null,
					content: "y",
					contentType: "text/markdown",
					sortOrder: 0,
					createdAt: "2026-05-01T00:00:00Z",
					updatedAt: "2026-05-01T00:00:00Z",
				},
			],
		}));
		const completeMigration = vi.fn(async () => ({ alreadyMigrated: false }));
		const backend = makeBackend({
			mintGitCredentials: dbBackingMint(),
			getLegacyContent: getLegacy,
			completeMigration,
		});
		const client = makeGitClient({ commit });
		const { engine } = makeEngine({
			backend,
			client,
			makeLegacyMigration: () =>
				({ apply: applyLegacy }) as unknown as ReturnType<
					NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
				>,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(getLegacy).toHaveBeenCalledTimes(1);
		expect(applyLegacy).toHaveBeenCalledTimes(1);
		expect(completeMigration).toHaveBeenCalledTimes(1);
		// At least one commit message should be the migrate commit.
		const migrateCall = commit.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("migrate"));
		expect(migrateCall).toBeDefined();
		expect(String(migrateCall?.[0])).toContain("7 items from legacy space");
	});

	it("skips applyLegacyContent + push when getLegacyContent reports alreadyMigrated (race condition)", async () => {
		const applyLegacy = vi.fn(async () => ({ filesWritten: 0 }));
		const getLegacy = vi.fn(async () => ({
			spaceId: 1,
			spaceSlug: "personal",
			alreadyMigrated: true,
			docs: [],
		}));
		const completeMigration = vi.fn(async () => ({ alreadyMigrated: true }));
		const backend = makeBackend({
			mintGitCredentials: dbBackingMint(),
			getLegacyContent: getLegacy,
			completeMigration,
		});
		const { engine } = makeEngine({
			backend,
			makeLegacyMigration: () =>
				({ apply: applyLegacy }) as unknown as ReturnType<
					NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
				>,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(applyLegacy).not.toHaveBeenCalled();
		// completeMigration is still called to confirm flip (idempotent on backend).
		expect(completeMigration).toHaveBeenCalledTimes(1);
	});

	it("calls notifyPush immediately after a transmitted migration push (releases per-user write lock without waiting on steady-state)", async () => {
		// Plan §0.8: notify-push is what releases the per-user
		// /credentials write lock. The steady-state push that follows
		// migration is almost always idempotent ("Everything up-to-date")
		// because nothing has been written since migration commit, so the
		// outer notifyPush at L548 gets skipped on `transmitted=false`.
		// Without the dedicated migration notify, peers hitting /credentials
		// during the lock TTL window would get 423 vault_locked and burn
		// retry budget. This test pins the migration-side notify so a
		// future change that drops it can't slip through unnoticed.
		const applyLegacy = vi.fn(async () => ({ filesWritten: 3 }));
		// First currentHead call is for the migration notify; second is for
		// the steady-state notify (which here is also transmitted by
		// default — that's fine, we just want to prove migration fired).
		const currentHead = vi
			.fn()
			.mockResolvedValueOnce("migrate0000000000000000000000000000000000")
			.mockResolvedValue("steady00000000000000000000000000000000000");
		const backend = makeBackend({
			mintGitCredentials: dbBackingMint(),
			getLegacyContent: vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [
					{
						id: 1,
						jrn: "doc:1",
						slug: "x",
						path: "/",
						docType: "document",
						parentId: null,
						content: "y",
						contentType: "text/markdown",
						sortOrder: 0,
						createdAt: "2026-05-01T00:00:00Z",
						updatedAt: "2026-05-01T00:00:00Z",
					},
				],
			})),
		});
		const client = makeGitClient({ currentHead });
		const { engine } = makeEngine({
			backend,
			client,
			makeLegacyMigration: () =>
				({ apply: applyLegacy }) as unknown as ReturnType<
					NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
				>,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(backend.notifyPush).toHaveBeenCalledWith({
			commitSha: "migrate0000000000000000000000000000000000",
			branch: "main",
			lockOwnerToken: "test-lock-owner-token",
		});
	});

	it("swallows notifyPush errors on the migration path without failing the round", async () => {
		const applyLegacy = vi.fn(async () => ({ filesWritten: 2 }));
		const notifyPush = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue(undefined);
		const backend = makeBackend({
			mintGitCredentials: dbBackingMint(),
			notifyPush,
			getLegacyContent: vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [
					{
						id: 1,
						jrn: "doc:1",
						slug: "x",
						path: "/",
						docType: "document",
						parentId: null,
						content: "y",
						contentType: "text/markdown",
						sortOrder: 0,
						createdAt: "2026-05-01T00:00:00Z",
						updatedAt: "2026-05-01T00:00:00Z",
					},
				],
			})),
		});
		const { engine } = makeEngine({
			backend,
			makeLegacyMigration: () =>
				({ apply: applyLegacy }) as unknown as ReturnType<
					NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
				>,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
	});

	it("does not call legacy-content endpoints when backing=git", async () => {
		const getLegacy = vi.fn();
		const completeMigration = vi.fn();
		const backend = makeBackend({
			// makeBackend's default mintGitCredentials already returns backing=git.
			getLegacyContent: getLegacy,
			completeMigration,
		});
		const { engine } = makeEngine({ backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(getLegacy).not.toHaveBeenCalled();
		expect(completeMigration).not.toHaveBeenCalled();
	});

	it("surfaces a completeMigration failure as terminal migration_failed (I10 — was silently swallowed pre-fix)", async () => {
		// Pre-I10 the round still reported "Synced ✓" even though the
		// backend's `backing=db` flag never flipped, leaving the user with
		// no signal that anything was wrong. The fix turns this into a
		// terminal `migration_failed` so the UI can flip to "Sync failed"
		// until the backend recovers. `complete-migration` is idempotent
		// on the backend, so the next round retries cleanly.
		const completeMigration = vi.fn(async () => {
			throw new Error("flip_failed 503");
		});
		const backend = makeBackend({
			mintGitCredentials: dbBackingMint(),
			getLegacyContent: vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: true,
				docs: [],
			})),
			completeMigration,
		});
		const { engine } = makeEngine({ backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("migration_failed");
		expect(result.lastError?.message).toMatch(/completeMigration:.*flip_failed 503/);
		expect(completeMigration).toHaveBeenCalledTimes(1);
	});

	it("goes offline when getLegacyContent errors", async () => {
		const backend = makeBackend({
			mintGitCredentials: dbBackingMint(),
			getLegacyContent: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		const { engine } = makeEngine({ backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
	});

	it("recovers from cross-phase 401: migration push 401 + steady-state push 401 → both re-mint, round still synced", async () => {
		// Phase budget: migration push consumed `remintsUsed` recovering from
		// its own 401; without the per-phase reset, the steady-state push 401
		// that follows would hit `recovery exhausted` and the round would flip
		// offline. With the reset, each phase gets its own at-most-one re-mint.
		const applyLegacy = vi.fn(async () => ({ filesWritten: 3 }));
		const getLegacy = vi.fn(async () => ({
			spaceId: 1,
			spaceSlug: "personal",
			alreadyMigrated: false,
			docs: [
				{
					id: 1,
					jrn: "doc:1",
					slug: "x",
					path: "/",
					docType: "document" as const,
					parentId: null,
					content: "y",
					contentType: "text/markdown",
					sortOrder: 0,
					createdAt: "2026-05-01T00:00:00Z",
					updatedAt: "2026-05-01T00:00:00Z",
				},
			],
		}));
		// 4 pushes total expected: migration 401, migration 200, steady-state
		// 401, steady-state 200. If the phase reset is broken, the 3rd push
		// (steady-state 401) classifies as `sync_failed_after_retries` and the
		// 4th push never happens.
		let pushAttempts = 0;
		const client = makeGitClient({
			push: vi.fn(async () => {
				pushAttempts += 1;
				if (pushAttempts === 1 || pushAttempts === 3) {
					return {
						ok: false as const,
						nonFastForward: false,
						unauthorized: true,
						message: "fatal: Authentication failed",
					};
				}
				return { ok: true as const, transmitted: true };
			}),
		});
		const mintCalls = vi.fn(async () => ({
			gitUrl: "https://github.com/jolli-vaults/test.git",
			token: `ghs_${Math.random().toString(36).slice(2)}`,
			expiresAt: Date.now() + 3600_000,
			repoFullName: "jolli-vaults/test",
			defaultBranch: "main",
			githubRepoCreated: true,
			alreadyVaultBound: false as const,
			lockOwnerToken: "test-lock-owner-token" as const,
		}));
		const backend = makeBackend({
			mintGitCredentials: mintCalls,
			getLegacyContent: getLegacy,
			completeMigration: vi.fn(async () => ({ alreadyMigrated: false })),
		});
		const { engine } = makeEngine({
			backend,
			client,
			makeLegacyMigration: () =>
				({ apply: applyLegacy }) as unknown as ReturnType<
					NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
				>,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(pushAttempts).toBe(4);
		// 1 initial mint + 1 migration-phase re-mint + 1 steady-state-phase re-mint = 3.
		expect(mintCalls).toHaveBeenCalledTimes(3);
	});
});

describe("SyncEngine.runRound — lock contention", () => {
	it("returns syncing without running when sync.lock is held by a live process", async () => {
		// Plant a lock owned by a still-alive PID. We use `process.pid`
		// because the lock-primitive PID liveness check now short-circuits
		// on a "dead" owner (the previous test wrote 99999, which is dead
		// and would be reclaimed immediately — defeating the contention
		// scenario this test is meant to cover).
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".jolli", "jollimemory"), { recursive: true });
		await writeFile(join(tempDir, ".jolli", "jollimemory", "sync.lock"), String(process.pid));

		const { engine, client } = makeEngine({ lockTimeoutMs: 0 });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("syncing");
		expect(client.fetch).not.toHaveBeenCalled();
	});
});

describe("SyncEngine.runRound — per-round mint (§0.6, supersedes credential cache)", () => {
	it("mints fresh credentials at the start of every round (no cross-round cache)", async () => {
		const backend = makeBackend({
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
		});
		const { engine } = makeEngine({ backend });
		await engine.runRound(ROUND);
		await engine.runRound(ROUND);
		await engine.runRound(ROUND);
		// One mint per round — N rounds = N mints. Replaces the old test
		// that asserted `toHaveBeenCalledTimes(1)` across rounds, which
		// was the broken behavior that masked deleted-repo recovery.
		expect(backend.mintGitCredentials).toHaveBeenCalledTimes(3);
	});

	it("classifies a 401 from mint as offline + lastError.code=mint_failed (terminal)", async () => {
		const { SyncBackendUnauthorizedError } = await import("./BackendClient.js");
		const backend = makeBackend({
			mintGitCredentials: vi.fn(async () => {
				throw new SyncBackendUnauthorizedError("token rejected by backend");
			}),
		});
		const { engine } = makeEngine({ backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("mint_failed");
	});

	it("classifies a network error from mint as offline + lastError.code=network (transient)", async () => {
		const backend = makeBackend({
			mintGitCredentials: vi.fn(async () => {
				throw new SyncBackendNetworkError("ECONNREFUSED");
			}),
		});
		const { engine } = makeEngine({ backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("network");
	});

	it("retries 423 vault_locked → eventually mints → synced (§0.8 happy path)", async () => {
		const { VaultLockedError } = await import("./BackendClient.js");
		const mintFn = vi
			.fn()
			.mockRejectedValueOnce(new VaultLockedError('{"error":"vault_locked"}'))
			.mockRejectedValueOnce(new VaultLockedError('{"error":"vault_locked"}'))
			.mockResolvedValueOnce({
				gitUrl: "https://github.com/jolli-vaults/test.git",
				token: "ghs_test",
				expiresAt: Date.now() + 3600_000,
				repoFullName: "jolli-vaults/test",
				defaultBranch: "main",
				githubRepoCreated: false,
				alreadyVaultBound: true as const,
				lockOwnerToken: "test-lock-owner-token" as const,
			});
		const backend = makeBackend({ mintGitCredentials: mintFn });
		// Skip wall-clock waits while keeping the retry count (3 retries).
		const { engine } = makeEngine({ backend, vaultLockedRetrySchedule: [0, 0, 0] });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		// 2 fails + 1 success = 3 total mint calls.
		expect(mintFn).toHaveBeenCalledTimes(3);
	});

	it("fires onLockedWait before each retry sleep (§0.12 mid-round UI feedback)", async () => {
		const { VaultLockedError } = await import("./BackendClient.js");
		const mintFn = vi.fn(async () => {
			throw new VaultLockedError('{"error":"vault_locked"}');
		});
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const onLockedWait = vi.fn();
		const { engine } = makeEngine({ backend, vaultLockedRetrySchedule: [0, 0, 0], onLockedWait });
		await engine.runRound(ROUND);
		// 4 attempts total, 3 backoff waits → 3 onLockedWait calls (the 4th
		// attempt is terminal and doesn't sleep).
		expect(onLockedWait).toHaveBeenCalledTimes(3);
		// `selfLocked: false` because no `pending-lock.json` was seeded in
		// this fixture — engine couldn't find prior self-issued lock token.
		// Self-locked path is exercised in its own test below.
		expect(onLockedWait).toHaveBeenNthCalledWith(1, {
			attempt: 1,
			totalAttempts: 4,
			nextRetryInMs: 0,
			message: expect.stringContaining("Personal Space"),
			selfLocked: false,
		});
		expect(onLockedWait).toHaveBeenNthCalledWith(3, {
			attempt: 3,
			totalAttempts: 4,
			nextRetryInMs: 0,
			message: expect.stringContaining("Personal Space"),
			selfLocked: false,
		});
	});

	it("flags onLockedWait + result.lastError with selfLocked=true when a fresh pending-lock entry exists", async () => {
		// Seed a pending-lock entry as if a prior round had successfully
		// minted and never released the lock. The engine's
		// `readSelfLockState` MUST surface this through both `onLockedWait`
		// and the terminal `lastError`.
		const { writePendingLock } = await import("./PendingLockStore.js");
		await writePendingLock("sk-jol-test-fixture", "prior-round-token");
		const { VaultLockedError } = await import("./BackendClient.js");
		const mintFn = vi.fn(async () => {
			throw new VaultLockedError('{"error":"vault_locked"}');
		});
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const onLockedWait = vi.fn();
		const { engine } = makeEngine({ backend, vaultLockedRetrySchedule: [0, 0, 0], onLockedWait });
		const result = await engine.runRound(ROUND);
		expect(onLockedWait).toHaveBeenCalledTimes(3);
		expect(onLockedWait).toHaveBeenNthCalledWith(1, expect.objectContaining({ selfLocked: true }));
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("vault_locked");
		expect(result.lastError?.selfLocked).toBe(true);
	});

	it("treats a future-dated pending-lock entry (clock skew) as self-locked", async () => {
		// Future-dated `mintedAt` is the corrupt-file / clock-skew branch
		// in `readSelfLockState`. Per the §0.8 comment, we side with
		// "treat as fresh" so the grace window retires it cleanly once
		// the clock settles — flipping to NOT self-locked here would
		// mis-attribute a real self-lock as peer-held during the skew.
		const { writePendingLock } = await import("./PendingLockStore.js");
		const future = Date.now() + 5 * 60_000;
		await writePendingLock("sk-jol-test-fixture", "future-dated-token", future);
		const { VaultLockedError } = await import("./BackendClient.js");
		const mintFn = vi.fn(async () => {
			throw new VaultLockedError('{"error":"vault_locked"}');
		});
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const onLockedWait = vi.fn();
		const { engine } = makeEngine({ backend, vaultLockedRetrySchedule: [0, 0, 0], onLockedWait });
		const result = await engine.runRound(ROUND);
		expect(onLockedWait).toHaveBeenCalledWith(expect.objectContaining({ selfLocked: true }));
		expect(result.lastError?.selfLocked).toBe(true);
	});

	it("treats a missing jolliApiKey as NOT self-locked (signed-out path)", async () => {
		// `readSelfLockState` short-circuits to `{ selfLocked: false }`
		// when `getJolliApiKey` returns undefined. Even if a stale
		// pending-lock entry exists on disk, without a key we have no
		// way to scope it to this user — safer to under-attribute than
		// to point at a stranger's lock.
		const { writePendingLock } = await import("./PendingLockStore.js");
		await writePendingLock("sk-jol-test-fixture", "stale-but-unscoped-token");
		const { VaultLockedError } = await import("./BackendClient.js");
		const mintFn = vi.fn(async () => {
			throw new VaultLockedError('{"error":"vault_locked"}');
		});
		const backend = makeBackend({
			mintGitCredentials: mintFn,
			getJolliApiKey: vi.fn(async () => undefined),
		});
		const onLockedWait = vi.fn();
		const { engine } = makeEngine({ backend, vaultLockedRetrySchedule: [0, 0, 0], onLockedWait });
		const result = await engine.runRound(ROUND);
		expect(onLockedWait).toHaveBeenCalledWith(expect.objectContaining({ selfLocked: false }));
		expect(result.lastError?.selfLocked).toBe(false);
	});

	it("falls back to NOT self-locked when getJolliApiKey throws (readSelfLockState catch arm)", async () => {
		// `readSelfLockState` wraps its whole body in a try/catch so a
		// transient apiKey-provider failure can't crash the mint loop.
		// The fallback is "default to false" — same posture as the
		// missing-key arm: better to under-attribute than to point at a
		// stranger's lock.
		const { VaultLockedError } = await import("./BackendClient.js");
		const mintFn = vi.fn(async () => {
			throw new VaultLockedError('{"error":"vault_locked"}');
		});
		const backend = makeBackend({
			mintGitCredentials: mintFn,
			getJolliApiKey: vi.fn(async () => {
				throw new Error("config read transient");
			}),
		});
		const onLockedWait = vi.fn();
		const { engine } = makeEngine({ backend, vaultLockedRetrySchedule: [0, 0, 0], onLockedWait });
		const result = await engine.runRound(ROUND);
		expect(onLockedWait).toHaveBeenCalledWith(expect.objectContaining({ selfLocked: false }));
		expect(result.lastError?.code).toBe("vault_locked");
		expect(result.lastError?.selfLocked).toBe(false);
	});

	it("treats a stale pending-lock entry (>= TTL grace) as NOT self-locked", async () => {
		// Backend's lock TTL is at most the retry-schedule total (6 min);
		// an entry older than that is by definition no longer held by us.
		const { writePendingLock } = await import("./PendingLockStore.js");
		const stale = Date.now() - 6 * 60_000 - 1_000;
		await writePendingLock("sk-jol-test-fixture", "ancient-token", stale);
		const { VaultLockedError } = await import("./BackendClient.js");
		const mintFn = vi.fn(async () => {
			throw new VaultLockedError('{"error":"vault_locked"}');
		});
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const onLockedWait = vi.fn();
		const { engine } = makeEngine({ backend, vaultLockedRetrySchedule: [0, 0, 0], onLockedWait });
		const result = await engine.runRound(ROUND);
		expect(onLockedWait).toHaveBeenCalledWith(expect.objectContaining({ selfLocked: false }));
		expect(result.lastError?.selfLocked).toBe(false);
	});

	it("persists lockOwnerToken on successful mint and clears it on notify-push", async () => {
		const { readPendingLock } = await import("./PendingLockStore.js");
		// Default fixture: mint returns a real token, push transmits,
		// notifyPush succeeds → token MUST be cleared by round end.
		const { engine } = makeEngine();
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		const after = await readPendingLock("sk-jol-test-fixture");
		expect(after).toBeNull();
	});

	it("leaves the persisted lockOwnerToken in place when notify-push throws", async () => {
		const { readPendingLock } = await import("./PendingLockStore.js");
		const backend = makeBackend({
			notifyPush: vi.fn(async () => {
				throw new Error("notify-push transient");
			}),
		});
		const { engine } = makeEngine({ backend });
		await engine.runRound(ROUND);
		const after = await readPendingLock("sk-jol-test-fixture");
		expect(after?.lockOwnerToken).toBe("test-lock-owner-token");
	});

	it("onLockedWait callback throwing does NOT abort the retry loop", async () => {
		const { VaultLockedError } = await import("./BackendClient.js");
		const mintFn = vi.fn(async () => {
			throw new VaultLockedError('{"error":"vault_locked"}');
		});
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const { engine } = makeEngine({
			backend,
			vaultLockedRetrySchedule: [0, 0, 0],
			onLockedWait: () => {
				throw new Error("UI handler exploded");
			},
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("vault_locked");
		// All 4 mint attempts still happened despite the callback throwing.
		expect(mintFn).toHaveBeenCalledTimes(4);
	});

	it("gives up after 4 consecutive 423s (initial + 3 retries) → offline + lastError.code=vault_locked", async () => {
		const { VaultLockedError } = await import("./BackendClient.js");
		const mintFn = vi.fn(async () => {
			throw new VaultLockedError('{"error":"vault_locked"}');
		});
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const { engine } = makeEngine({ backend, vaultLockedRetrySchedule: [0, 0, 0] });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("vault_locked");
		expect(result.lastError?.message).toContain("Personal Space");
		// 1 initial + 3 retries = 4 attempts. Hard-coded here so changing
		// the budget shape without updating tests fails loudly.
		expect(mintFn).toHaveBeenCalledTimes(4);
	});

	it("classifies an unclassified mint error as offline + lastError.code=mint_failed (the 'other' bucket)", async () => {
		const { SyncBackendError } = await import("./BackendClient.js");
		const backend = makeBackend({
			mintGitCredentials: vi.fn(async () => {
				throw new SyncBackendError(
					503,
					"vault_sync_disabled",
					JSON.stringify({ error: "vault_sync_disabled" }),
				);
			}),
		});
		const { engine } = makeEngine({ backend });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("mint_failed");
	});
});

describe("SyncEngine.runRound — repoMissing (404) recovery (§0.6)", () => {
	function freshCreds(label: string) {
		// `gitUrl` / `repoFullName` are stable across mints — `ensureGithubRepoExists`
		// is name-idempotent, so a successful recovery returns to the same
		// remote URL. We keep them aligned with the default `makeBackend`
		// fixture so `getOriginUrl` (which the §P1#1 vault guard reads)
		// stays in sync without per-test overrides. The `token` carries the
		// `label` so tests that observe "mint was re-called" still see
		// distinct identity between rounds.
		return {
			gitUrl: "https://github.com/jolli-vaults/test.git",
			token: `ghs_${label}`,
			expiresAt: Date.now() + 3600_000,
			repoFullName: "jolli-vaults/test",
			defaultBranch: "main",
			githubRepoCreated: false,
			alreadyVaultBound: true as const,
			lockOwnerToken: "test-lock-owner-token" as const,
		};
	}

	it("push 404 → re-mint once → retry push → synced (the deleted-repo recovery flow)", async () => {
		const mintFn = vi.fn().mockResolvedValueOnce(freshCreds("first")).mockResolvedValueOnce(freshCreds("second"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const push = vi
			.fn<() => Promise<import("./GitClient.js").PushResult>>()
			.mockResolvedValueOnce({
				ok: false,
				nonFastForward: false,
				unauthorized: false,
				repoMissing: true,
				message: "remote: Repository not found.",
			})
			.mockResolvedValueOnce({ ok: true, transmitted: true });
		const client = makeGitClient({ push });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(mintFn).toHaveBeenCalledTimes(2); // initial + 1 recovery
		expect(push).toHaveBeenCalledTimes(2); // first 404, second ok
	});

	it("push 404 twice → second recovery refused (mint guard) → offline + sync_failed_after_retries", async () => {
		const mintFn = vi.fn(async () => freshCreds("only"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const push = vi.fn<() => Promise<import("./GitClient.js").PushResult>>().mockResolvedValue({
			ok: false,
			nonFastForward: false,
			unauthorized: false,
			repoMissing: true,
			message: "remote: Repository not found.",
		});
		const client = makeGitClient({ push });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("sync_failed_after_retries");
		// Idempotency invariant: at most 1 recovery mint per round, so
		// backend.mintGitCredentials should only see 2 calls (initial + 1
		// recovery) — never 3, which would mean two recovery mints and
		// would risk duplicate `ensureGithubRepoExists` invocations.
		expect(mintFn).toHaveBeenCalledTimes(2);
	});

	it("fetch 404 → re-mint once → retry fetch → synced", async () => {
		const mintFn = vi.fn().mockResolvedValueOnce(freshCreds("first")).mockResolvedValueOnce(freshCreds("second"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const fetch = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("remote: Repository not found."))
			.mockResolvedValueOnce(undefined);
		const client = makeGitClient({ fetch });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(mintFn).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("clone 404 → re-mint once → retry clone → synced (fresh first-bind, no <localFolder>)", async () => {
		// Wipe the entire memoryBankRoot so the engine takes the cold-start
		// `git clone` path (not the §0.13 init-in-existing-dir path).
		await rm(join(tempDir, "vault"), { recursive: true, force: true });
		const mintFn = vi.fn().mockResolvedValueOnce(freshCreds("first")).mockResolvedValueOnce(freshCreds("second"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const clone = vi
			.fn<(url: string) => Promise<void>>()
			.mockImplementationOnce(async () => {
				throw new Error("fatal: repository 'https://github.com/jolli-vaults/test.git/' not found");
			})
			.mockImplementationOnce(async () => {
				await mkdir(join(tempDir, "vault", ".git"), { recursive: true });
			});
		const client = makeGitClient({ clone });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(mintFn).toHaveBeenCalledTimes(2);
		expect(clone).toHaveBeenCalledTimes(2);
	});

	it("fetch fatal (non-404, non-401, non-network) → offline + fetch_failed", async () => {
		const mintFn = vi.fn(async () => freshCreds("only"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const fetch = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("fatal: bad object HEAD"));
		const client = makeGitClient({ fetch });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("fetch_failed");
		// No recovery was attempted, so the initial mint is the only one.
		expect(mintFn).toHaveBeenCalledTimes(1);
	});

	it("fetch GnuTLS handshake error → offline + lastError.code=network (silent UI, §0.11)", async () => {
		const mintFn = vi.fn(async () => freshCreds("only"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const fetch = vi
			.fn<() => Promise<void>>()
			.mockRejectedValue(
				new Error(
					"fatal: unable to access 'https://github.com/foo/bar.git/': GnuTLS, handshake failed: The TLS connection was non-properly terminated.",
				),
			);
		const client = makeGitClient({ fetch });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		// Routed to `network` (not `fetch_failed`) so the status bar stays neutral.
		expect(result.lastError?.code).toBe("network");
		expect(result.lastError?.message).toContain("GnuTLS");
		// No recovery / re-mint attempted for a network-class error.
		expect(mintFn).toHaveBeenCalledTimes(1);
	});

	it("pullRebase TLS handshake error → offline + lastError.code=network (was pull_failed pre-§0.11)", async () => {
		const mintFn = vi.fn(async () => freshCreds("only"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const pullRebase = vi
			.fn<() => Promise<{ fastForwarded: boolean; conflicted: ReadonlyArray<string> }>>()
			.mockRejectedValue(
				new Error(
					"git pull --rebase failed: fatal: unable to access 'https://github.com/foo/bar.git/': GnuTLS, handshake failed",
				),
			);
		const client = makeGitClient({ pullRebase });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("network");
	});

	it("pullRebase non-network failure → offline + lastError.code=pull_failed", async () => {
		const mintFn = vi.fn(async () => freshCreds("only"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const pullRebase = vi
			.fn<() => Promise<{ fastForwarded: boolean; conflicted: ReadonlyArray<string> }>>()
			.mockRejectedValue(
				new Error("git pull --rebase failed: cannot pull with rebase: you have unstaged changes"),
			);
		const client = makeGitClient({ pullRebase });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("pull_failed");
	});

	it("push hard-failure with network-flavored message → offline + lastError.code=network", async () => {
		const mintFn = vi.fn(async () => freshCreds("only"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const push = vi.fn<() => Promise<import("./GitClient.js").PushResult>>().mockResolvedValue({
			ok: false,
			nonFastForward: false,
			unauthorized: false,
			repoMissing: false,
			message: "Failed to connect to github.com port 443: Connection timed out",
		});
		const client = makeGitClient({ push });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("network");
	});

	it("fetch 401 → re-mint once → retry fetch → synced (covers classifyGitError 'unauthorized')", async () => {
		const mintFn = vi.fn().mockResolvedValueOnce(freshCreds("first")).mockResolvedValueOnce(freshCreds("second"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const fetch = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("fatal: Authentication failed for 'https://github.com/...'"))
			.mockResolvedValueOnce(undefined);
		const client = makeGitClient({ fetch });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(mintFn).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("clone fatal (non-404, non-401) → offline + clone_failed", async () => {
		// Wipe entire memoryBankRoot so the engine takes the cold-start
		// `git clone` path (the §0.13 init-in-existing-dir path needs a
		// non-empty dir).
		await rm(join(tempDir, "vault"), { recursive: true, force: true });
		const backend = makeBackend({ mintGitCredentials: vi.fn(async () => freshCreds("only")) });
		const clone = vi
			.fn<(url: string) => Promise<void>>()
			.mockRejectedValue(new Error("fatal: destination path already exists"));
		const client = makeGitClient({ clone });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("clone_failed");
	});

	it("push pullRebase-throws during non-FF retry → offline + sync_failed_after_retries", async () => {
		const backend = makeBackend({ mintGitCredentials: vi.fn(async () => freshCreds("only")) });
		const push = vi.fn<() => Promise<import("./GitClient.js").PushResult>>().mockResolvedValueOnce({
			ok: false,
			nonFastForward: true,
			unauthorized: false,
			repoMissing: false,
			message: "non-fast-forward",
		});
		const pullRebase = vi
			.fn<() => Promise<{ fastForwarded: boolean; conflicted: ReadonlyArray<string> }>>()
			// First call is the round-level pull (clean), second is the non-FF retry that throws.
			.mockResolvedValueOnce({ fastForwarded: false, conflicted: [] })
			.mockRejectedValueOnce(new Error("rebase --abort failed: unknown ref"));
		const client = makeGitClient({ push, pullRebase });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("sync_failed_after_retries");
	});

	it("fetch 404 → re-mint succeeds → fetch 404 again → recovery refused (guard) → offline + sync_failed_after_retries", async () => {
		const mintFn = vi.fn(async () => freshCreds("only"));
		const backend = makeBackend({ mintGitCredentials: mintFn });
		const fetch = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("remote: Repository not found."));
		const client = makeGitClient({ fetch });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("sync_failed_after_retries");
		// At most one recovery mint per round (initial + 1 = 2).
		expect(mintFn).toHaveBeenCalledTimes(2);
	});
});

describe("SyncEngine.runRound — extra coverage (commit summary, migration filesWritten=0, non-FF conflict race)", () => {
	function dbCreds() {
		return {
			gitUrl: "https://github.com/jolli-vaults/test.git",
			token: "ghs_test",
			expiresAt: Date.now() + 3600_000,
			repoFullName: "jolli-vaults/test",
			defaultBranch: "main",
			githubRepoCreated: false,
			alreadyVaultBound: false as const,
			lockOwnerToken: "test-lock-owner-token" as const,
		};
	}

	it("migration with docs > 0 but applyLegacyContent returns filesWritten=0 → still ends synced (no migrate commit/push)", async () => {
		const backend = makeBackend({
			mintGitCredentials: vi.fn(async () => dbCreds()),
			getLegacyContent: vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [
					{
						id: 1,
						jrn: "jrn:1",
						slug: "doc",
						path: "doc.md",
						docType: "doc",
						parentId: null,
						content: "x",
						contentType: "text/markdown",
						sortOrder: 0,
						createdAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
					},
				],
			})),
		});
		const commit = vi.fn(async (_msg: string, _author: { name: string; email: string }) => "sha");
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const client = makeGitClient({ commit, push });
		const applyLegacy = vi.fn(async () => ({ filesWritten: 0 })); // allow-list rejected all docs
		const { engine } = makeEngine({
			backend,
			client,
			makeLegacyMigration: () =>
				({ apply: applyLegacy }) as unknown as ReturnType<
					NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
				>,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		// Only the steady-state commit happens — no migration commit since filesWritten=0.
		expect(commit).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledTimes(1);
	});

	it("non-FF retry where the inner pullRebase surfaces a conflicting commit → offline + sync_failed_after_retries", async () => {
		const backend = makeBackend();
		const push = vi.fn<() => Promise<import("./GitClient.js").PushResult>>().mockResolvedValueOnce({
			ok: false,
			nonFastForward: true,
			unauthorized: false,
			repoMissing: false,
			message: "non-fast-forward",
		});
		const pullRebase = vi
			.fn<() => Promise<{ fastForwarded: boolean; conflicted: ReadonlyArray<string> }>>()
			// Round-level pull is clean; the inner non-FF retry's pull surfaces a conflict.
			.mockResolvedValueOnce({ fastForwarded: false, conflicted: [] })
			.mockResolvedValueOnce({ fastForwarded: false, conflicted: ["foo.md"] });
		// Without abort here the vault stays in mid-rebase state and every
		// subsequent round's `pullRebase` fails with "already a rebase-merge
		// directory" — see SyncEngine.pushWithRetry's non-FF recovery comment.
		const rebaseAbort = vi.fn(async () => undefined);
		const client = makeGitClient({ push, pullRebase, rebaseAbort });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("sync_failed_after_retries");
		expect(result.lastError?.message).toContain("non-FF push raced");
		expect(rebaseAbort).toHaveBeenCalledTimes(1);
	});

	it("non-FF retry where the inner pullRebase throws still calls rebaseAbort defensively", async () => {
		const backend = makeBackend();
		const push = vi.fn<() => Promise<import("./GitClient.js").PushResult>>().mockResolvedValueOnce({
			ok: false,
			nonFastForward: true,
			unauthorized: false,
			repoMissing: false,
			message: "non-fast-forward",
		});
		const pullRebase = vi
			.fn<() => Promise<{ fastForwarded: boolean; conflicted: ReadonlyArray<string> }>>()
			.mockResolvedValueOnce({ fastForwarded: false, conflicted: [] })
			.mockRejectedValueOnce(new Error("git pull --rebase failed: ref refs/heads/main not found"));
		const rebaseAbort = vi.fn(async () => undefined);
		const client = makeGitClient({ push, pullRebase, rebaseAbort });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(rebaseAbort).toHaveBeenCalledTimes(1);
	});

	it("first-bind round produces a [jolli-mb] migrate: initial bootstrap commit", async () => {
		await rm(join(tempDir, "vault", ".git"), { recursive: true, force: true });
		const backend = makeBackend();
		const commit = vi.fn(async (_msg: string, _author: { name: string; email: string }) => "sha");
		const client = makeGitClient({
			commit,
			clone: vi.fn(async () => {
				await mkdir(join(tempDir, "vault", ".git"), { recursive: true });
			}),
		});
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(commit.mock.calls[0][0]).toMatch(/migrate.*initial bootstrap/);
	});

	it("migration with alreadyMigrated=false but docs=[] short-circuits to completeMigration", async () => {
		const completeMigration = vi.fn(async () => ({ alreadyMigrated: false }));
		const applyLegacy = vi.fn();
		const backend = makeBackend({
			mintGitCredentials: vi.fn(async () => dbCreds()),
			getLegacyContent: vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [],
			})),
			completeMigration,
		});
		const { engine } = makeEngine({
			backend,
			makeLegacyMigration: () =>
				({ apply: applyLegacy }) as unknown as ReturnType<
					NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
				>,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(applyLegacy).not.toHaveBeenCalled();
		expect(completeMigration).toHaveBeenCalled();
	});

	it("docs=[] + unborn HEAD: completeMigration retried after steady-state push (lenient — log only on retry failure)", async () => {
		// Pre-fix: with legacy.docs=[] AND unborn HEAD, tryCompleteMigration
		// short-circuited (no commitSha to send) and the round reported
		// `synced` while backend backing stayed `db`. The next round picked
		// it up, but the in-round signal was misleading. Fix: surface the
		// deferred state and retry once after `pushWithRetry` creates HEAD.
		const completeMigration = vi.fn(async () => ({ alreadyMigrated: false }));
		// hasHead toggles: false during runFirstBindMigration (legacy short-
		// circuit path), true after the steady-state push so the deferred
		// retry sees a real HEAD.
		let headBorn = false;
		const hasHead = vi.fn(async () => headBorn);
		const push = vi.fn(async () => {
			headBorn = true;
			return { ok: true as const, transmitted: true };
		});
		const backend = makeBackend({
			mintGitCredentials: vi.fn(async () => dbCreds()),
			getLegacyContent: vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [],
			})),
			completeMigration,
		});
		const client = makeGitClient({ hasHead, push });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		// Once: deferred-retry after step-7 push observes hasHead=true.
		expect(completeMigration).toHaveBeenCalledTimes(1);
	});

	it("docs=[] + unborn HEAD + retried completeMigration fails: round stays synced (lenient — next round retries)", async () => {
		// Lenient posture: the steady-state push already landed user data
		// on the remote; a transient RPC failure on the deferred retry must
		// not flip the round from green to red. Next round's
		// `runFirstBindMigration` re-enters (alreadyVaultBound still false)
		// and retries cleanly.
		const completeMigration = vi.fn(async () => {
			throw new Error("flip_failed 503");
		});
		let headBorn = false;
		const hasHead = vi.fn(async () => headBorn);
		const push = vi.fn(async () => {
			headBorn = true;
			return { ok: true as const, transmitted: true };
		});
		const backend = makeBackend({
			mintGitCredentials: vi.fn(async () => dbCreds()),
			getLegacyContent: vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [],
			})),
			completeMigration,
		});
		const client = makeGitClient({ hasHead, push });
		const { engine } = makeEngine({ backend, client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(completeMigration).toHaveBeenCalledTimes(1);
	});

	it("migration applyLegacyContent throws → offline + lastError.code=migration_failed", async () => {
		const backend = makeBackend({
			mintGitCredentials: vi.fn(async () => dbCreds()),
			getLegacyContent: vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [
					{
						id: 1,
						jrn: "jrn:1",
						slug: "doc",
						path: "doc.md",
						docType: "doc",
						parentId: null,
						content: "x",
						contentType: "text/markdown",
						sortOrder: 0,
						createdAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
					},
				],
			})),
		});
		const applyLegacy = vi.fn(async () => {
			throw new Error("disk full");
		});
		const { engine } = makeEngine({
			backend,
			makeLegacyMigration: () =>
				({ apply: applyLegacy }) as unknown as ReturnType<
					NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
				>,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		expect(result.lastError?.code).toBe("migration_failed");
		expect(result.lastError?.message).toContain("apply");
	});

	it("steady-state commit uses the generic `[jolli-mb] add: memory bank changes` message", async () => {
		const backend = makeBackend();
		const commit = vi.fn(async (_msg: string, _author: { name: string; email: string }) => "sha");
		const client = makeGitClient({ commit });
		const { engine } = makeEngine({ backend, client });
		await engine.runRound(ROUND);
		expect(commit.mock.calls[0][0]).toMatch(/\[jolli-mb\] add:.*memory bank changes/);
	});
});

describe("SyncEngine.runRound — auto-reconcile dirty vault (§0.9)", () => {
	it("auto-stages + commits dirty vault before pullRebase", async () => {
		// Post-R9: the auto-reconcile gate uses `hasOwnedDirtyPaths`
		// (statusPorcelainZ + classifier) instead of plain
		// `hasUncommittedChanges`. Drive the dirty signal via porcelain
		// — a brand-new owned summary under `<repoFolder>/.jolli/...`
		// classifies as owned and trips the reconcile path.
		const summaryPath = `myrepo/.jolli/summaries/${"d".repeat(40)}.json`;
		const statusPorcelainZ = vi.fn(async () => [
			{ path: summaryPath, indexStatus: "!", worktreeStatus: "!", oldPath: undefined },
		]);
		const commit = vi.fn(async (_msg: string, _author: { name: string; email: string }) => "deadbeef");
		const pullRebase = vi.fn(async () => ({ fastForwarded: false, conflicted: [] }));
		const client = makeGitClient({ statusPorcelainZ, commit, pullRebase });
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		// Reconcile commit must run BEFORE pullRebase. Order check: commit[0]
		// happened, pullRebase happened after.
		const commitFirstMsg = commit.mock.calls[0]?.[0];
		expect(typeof commitFirstMsg === "string" && commitFirstMsg).toMatch(/reconcile|user-modified/);
		expect(statusPorcelainZ).toHaveBeenCalled();
		expect(pullRebase).toHaveBeenCalled();
	});

	it("skips auto-stage when vault is already clean", async () => {
		const hasUncommittedChanges = vi.fn(async () => false);
		const stageAll = vi.fn(async () => undefined);
		const commit = vi.fn(async (_msg: string, _author: { name: string; email: string }) => "deadbeef");
		const client = makeGitClient({ hasUncommittedChanges, stageAll, commit });
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		// Only the steady-state commit runs (after mirror), not a reconcile pre-commit.
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it("quarantines corrupt .jolli JSON via listDirtyPaths before stageAll (plan §I9)", async () => {
		// Plant a corrupt .jolli JSON in the real vault dir, mock the
		// porcelain output to point auto-reconcile at it, and verify the
		// file got moved to the quarantine directory BEFORE stageAll +
		// commit. Without this, the truncated/half-written aggregate
		// would land on the orphan history and peers would crash on
		// parse.
		// Post-R9: gate is classifier-aware, so the corrupt JSON must live
		// under a repo folder (`myrepo/.jolli/summaries/...`) to classify
		// as owned. Root `.jolli/summaries/...` would classify as null
		// (only `repos.json` is recognized at the vault root) and the
		// gate would idle-skip.
		const vault = join(tempDir, "vault");
		await mkdir(join(vault, "myrepo", ".jolli", "summaries"), { recursive: true });
		const corruptRel = `myrepo/.jolli/summaries/${"a".repeat(40)}.json`;
		const cleanRel = `myrepo/.jolli/summaries/${"b".repeat(40)}.json`;
		await writeFile(join(vault, corruptRel), '{"truncated":');
		await writeFile(join(vault, cleanRel), JSON.stringify({ ok: true }));

		const statusPorcelainZ = vi.fn(async () => [
			{ path: corruptRel, indexStatus: "!", worktreeStatus: "!", oldPath: undefined },
			{ path: cleanRel, indexStatus: "!", worktreeStatus: "!", oldPath: undefined },
		]);
		const listDirtyPaths = vi.fn(async () => [corruptRel, cleanRel] as ReadonlyArray<string>);
		const stageAll = vi.fn(async () => undefined);
		const commit = vi.fn(async () => "deadbeef");
		const pullRebase = vi.fn(async () => ({ fastForwarded: false, conflicted: [] }));
		const client = makeGitClient({
			statusPorcelainZ,
			listDirtyPaths,
			stageAll,
			commit,
			pullRebase,
		});
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");

		// Corrupt file is gone from its original location.
		await expect(stat(join(vault, corruptRel))).rejects.toBeDefined();
		// Clean file is still in place — only corrupt entries get
		// quarantined.
		await expect(stat(join(vault, cleanRel))).resolves.toBeDefined();
		// Quarantined file landed under `.jolli-quarantine-corrupt/` with
		// the slash-encoded safe name (`/` → `-`).
		const qStat = await stat(
			join(vault, ".jolli-quarantine-corrupt", `myrepo-.jolli-summaries-${"a".repeat(40)}.json`),
		);
		expect(qStat.isFile()).toBe(true);
	});

	it("non-fatal: auto-stage throws but round still proceeds (pullRebase is the real gate)", async () => {
		const hasUncommittedChanges = vi.fn(async () => true);
		// First call (pre-pullRebase reconcile) throws; second call (mirror's
		// steady-state stageAll) succeeds. Mirrors a realistic failure mode:
		// e.g. a permission glitch on the first invocation that clears later.
		const stageAll = vi
			.fn<() => Promise<void>>()
			.mockImplementationOnce(async () => {
				throw new Error("disk full during stage");
			})
			.mockResolvedValue(undefined);
		const pullRebase = vi.fn(async () => ({ fastForwarded: false, conflicted: [] }));
		const client = makeGitClient({ hasUncommittedChanges, stageAll, pullRebase });
		const { engine } = makeEngine({ client });
		const result = await engine.runRound(ROUND);
		// The auto-stage failure is logged but doesn't down-state the round.
		// pullRebase is the gate; if it succeeds, the round still ends synced.
		expect(result.newState).toBe("synced");
	});
});

describe("SyncEngine.runRound — outer error handler", () => {
	it("uncaught error inside doRound is logged and surfaces as terminal failure with lastError", async () => {
		// `resolveContext` throws — this is one of the few paths that
		// escapes `doRound`'s inner try/catch since it runs at the very top.
		const engine = new SyncEngine({
			backend: makeBackend(),
			resolveContext: async () => {
				throw new Error("resolveContext blew up");
			},
			makeGitClient: () => makeGitClient(),
			ai: async () => null,
			ui: { promptBinaryPick: async () => "skip" },
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		// Outer catch now classifies the throw as `sync_failed_after_retries`
		// so StatusOrchestrator renders the red "Sync failed" branch with the
		// exception message in the tooltip — rather than a bare "Offline" that
		// looks indistinguishable from a dropped network.
		expect(result.lastError?.code).toBe("sync_failed_after_retries");
		expect(result.lastError?.message).toBe("resolveContext blew up");
	});

	it("the lock-refresher fires while a round is in flight", async () => {
		const ticks: number[] = [];
		// Drive a round long enough for the refresh interval to fire at least
		// once. We set a 10ms refresh and a mintGitCredentials that resolves
		// after ~40ms — guarantees ≥3 ticks of the refresher.
		const backend = makeBackend({
			mintGitCredentials: vi.fn(
				() =>
					new Promise<import("./SyncTypes.js").GitCredentials>((resolve) =>
						setTimeout(
							() =>
								resolve({
									gitUrl: "https://github.com/jolli-vaults/test.git",
									token: "ghs_test",
									expiresAt: Date.now() + 3600_000,
									repoFullName: "jolli-vaults/test",
									defaultBranch: "main",
									githubRepoCreated: false,
									alreadyVaultBound: true as const,
									lockOwnerToken: "test-lock-owner-token" as const,
								}),
							40,
						),
					),
			),
		});
		const realSetInterval = global.setInterval;
		const spy = vi.spyOn(global, "setInterval").mockImplementation(((handler: () => void, _ms: number) => {
			// Force-fire the refresher exactly once, synchronously after a microtask, so we
			// exercise the callback body without depending on real timers.
			void Promise.resolve().then(() => {
				handler();
				ticks.push(Date.now());
			});
			return realSetInterval(() => {}, 1_000_000) as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval);
		const { engine } = makeEngine({ backend });
		await engine.runRound(ROUND);
		spy.mockRestore();
		expect(ticks.length).toBeGreaterThanOrEqual(1);
	});

	it("uncaught error with no stack still reports offline (covers (e as Error).stack ?? '(no stack)')", async () => {
		const engine = new SyncEngine({
			backend: makeBackend(),
			resolveContext: async () => {
				const err = new Error("no stack here");
				(err as unknown as { stack: undefined }).stack = undefined;
				throw err;
			},
			makeGitClient: () => makeGitClient(),
			ai: async () => null,
			ui: { promptBinaryPick: async () => "skip" },
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
	});
});

describe("SyncEngine.runRound — first-bind migration push surfaces classified code", () => {
	it("migration push 404 with recovery refused → offline + lastError.code=sync_failed_after_retries", async () => {
		const mintFn = vi.fn(async () => ({
			gitUrl: "https://github.com/jolli-vaults/test.git",
			token: "ghs_test",
			expiresAt: Date.now() + 3600_000,
			repoFullName: "jolli-vaults/test",
			defaultBranch: "main",
			githubRepoCreated: false,
			alreadyVaultBound: false as const, // drives the migration branch
			lockOwnerToken: "test-lock-owner-token" as const,
		}));
		const backend = makeBackend({
			mintGitCredentials: mintFn,
			getLegacyContent: vi.fn(async () => ({
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [
					{
						id: 1,
						jrn: "jrn:1",
						slug: "doc",
						path: "doc.md",
						docType: "doc",
						parentId: null,
						content: "x",
						contentType: "text/markdown",
						sortOrder: 0,
						createdAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
					},
				],
			})),
		});
		const push = vi.fn(async () => ({
			ok: false as const,
			nonFastForward: false,
			unauthorized: false,
			repoMissing: true,
			message: "remote: Repository not found.",
		}));
		const client = makeGitClient({ push });
		// LegacyMigration needs filesWritten > 0 so we actually reach the
		// migration push (skipped when filesWritten === 0).
		const applyLegacy = vi.fn(async () => ({ filesWritten: 1 }));
		const { engine } = makeEngine({
			backend,
			client,
			makeLegacyMigration: () =>
				({ apply: applyLegacy }) as unknown as ReturnType<
					NonNullable<import("./SyncEngine.js").SyncEngineOpts["makeLegacyMigration"]>
				>,
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("offline");
		// Code propagates up from pushWithRetry → runFirstBindMigration → doRound.
		expect(result.lastError?.code).toBe("sync_failed_after_retries");
		expect(result.lastError?.message).toContain("migration push");
	});
});

// §P2 / I6 — the old `sweepSymlinks` round-terminal path was REMOVED in
// Phase 1 along with the SymlinkSweep module. The replacement defences
// (stageVault's per-entry `symlinked` canary bucket + FolderStorage's
// `safeAtomicWriteSync` refusing to traverse a hostile intermediate
// symlink) are exercised in their own unit tests:
//   - StageVault.test.ts  → "refuses to stage a path whose LEAF is a symlink"
//                         + "refuses to stage when an INTERMEDIATE path
//                            segment is a symlink"
//   - VaultSymlinkGuard.test.ts → full chain-walk and ENOENT cases
//
// Keeping a SyncEngine-level integration test for this would re-test
// the same code path through three layers; the unit-level coverage is
// the load-bearing surface. If a sweep-style regression ever surfaces,
// the StageVault canary's `symlinked` warn log will flag it on the
// first round.

describe("SyncEngine.runRound — state change callback is robust", () => {
	it("swallows a throwing onStateChange so the round result still propagates", async () => {
		const { engine } = makeEngine({
			onStateChange: () => {
				throw new Error("listener exploded");
			},
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
	});
});

describe("SyncEngine.runRound — stale rebase self-heal (Layer 1)", () => {
	// The vault working tree is exclusively driven by SyncEngine, so a
	// rebase paused at round start is unambiguous evidence that a previous
	// round was killed mid-flight (VSIX reinstall, laptop sleep, crash).
	// The engine self-heals via `rebaseAbort` so the customer doesn't have
	// to `cd` into the vault and run git commands by hand.

	it("aborts a stale rebase and proceeds to synced when the probe returns true", async () => {
		const rebaseAbort = vi.fn(async () => undefined);
		const isRebaseInProgress = vi.fn(async () => true);
		const { engine, client } = makeEngine({
			client: makeGitClient({ isRebaseInProgress, rebaseAbort }),
		});
		const result = await engine.runRound(ROUND);
		expect(client.isRebaseInProgress).toHaveBeenCalled();
		expect(rebaseAbort).toHaveBeenCalledTimes(1);
		expect(result.newState).toBe("synced");
	});

	it("does NOT call rebaseAbort on a clean vault (no probe false-positive)", async () => {
		const rebaseAbort = vi.fn(async () => undefined);
		const { engine } = makeEngine({
			client: makeGitClient({ rebaseAbort }), // default probe returns false
		});
		const result = await engine.runRound(ROUND);
		expect(rebaseAbort).not.toHaveBeenCalled();
		expect(result.newState).toBe("synced");
	});

	it("continues the round when rebaseAbort itself fails (real error surfaces downstream)", async () => {
		// Last-resort safety net: if `git rebase --abort` somehow fails
		// (corrupt state files, disk full, etc.), the round must not bail
		// in the self-heal step — fetch / pullRebase below will surface a
		// real, actionable error code instead of swallowing this one.
		const { engine } = makeEngine({
			client: makeGitClient({
				isRebaseInProgress: vi.fn(async () => true),
				rebaseAbort: vi.fn(async () => {
					throw new Error("rebase --abort: corrupt state");
				}),
			}),
		});
		const result = await engine.runRound(ROUND);
		// Stub `pullRebase` is happy → round completes; the point is that
		// rebaseAbort throwing did not short-circuit the round.
		expect(result.newState).toBe("synced");
	});

	it("survives a throwing probe (e.g. stat() permission error) and continues", async () => {
		const { engine } = makeEngine({
			client: makeGitClient({
				isRebaseInProgress: vi.fn(async () => {
					throw new Error("EACCES");
				}),
			}),
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
	});

	it("calls sweepStaleLockFiles on every round (default no-op when nothing to remove)", async () => {
		const sweepStaleLockFiles = vi.fn(async () => ({ removed: [] }));
		const { engine } = makeEngine({
			client: makeGitClient({ sweepStaleLockFiles }),
		});
		await engine.runRound(ROUND);
		expect(sweepStaleLockFiles).toHaveBeenCalledTimes(1);
	});

	it("logs and proceeds when sweepStaleLockFiles removes stale .git/*.lock files", async () => {
		// Realistic shape: previous round was SIGKILL'd while writing the
		// index, leaving `.git/index.lock`. The sweep removes it and the
		// round continues normally — without the sweep the next `git add`
		// would fail with a sticky terminal error.
		const sweepStaleLockFiles = vi.fn(async () => ({
			removed: ["/vault/.git/index.lock"],
		}));
		const { engine } = makeEngine({
			client: makeGitClient({ sweepStaleLockFiles }),
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
	});

	it("continues the round when sweepStaleLockFiles itself throws", async () => {
		const sweepStaleLockFiles = vi.fn(async () => {
			throw new Error("EACCES on .git/");
		});
		const { engine } = makeEngine({
			client: makeGitClient({ sweepStaleLockFiles }),
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
	});
});

describe("SyncEngine.runRound — idle-round short-circuit (perf)", () => {
	// When local HEAD already matches origin/<branch> AND the working tree
	// is clean, stageAll/commit/push/notify-push are guaranteed no-ops. The
	// engine should skip them to avoid ~2-3s of process spawns + network
	// round-trips on every idle poll tick.

	const ALIGNED_OID = "abcd1234abcd1234abcd1234abcd1234abcd1234";

	it("skips stageAll/commit/push when local HEAD === origin/<branch> and tree is clean", async () => {
		const stageAll = vi.fn(async () => undefined);
		const commit = vi.fn(async () => ALIGNED_OID);
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const { engine, backend } = makeEngine({
			client: makeGitClient({
				stageAll,
				commit,
				push,
				currentHead: vi.fn(async () => ALIGNED_OID),
				revParse: vi.fn(async () => ALIGNED_OID),
				hasUncommittedChanges: vi.fn(async () => false),
			}),
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(stageAll).not.toHaveBeenCalled();
		expect(commit).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
		// notify-push is downstream of push — also must not fire.
		expect(backend.notifyPush).not.toHaveBeenCalled();
	});

	it("does NOT short-circuit when the working tree has uncommitted changes", async () => {
		// e.g. `bootstrap.ensureBootstrap` just wrote a fresh `.gitignore`
		// that needs committing + pushing so peers see the new ignores.
		// Post-P1 #1: the idle gate is `statusPorcelainZ` + classifier
		// rather than the old plain-status `hasUncommittedChanges`, so
		// the fixture surfaces the `.gitignore` write via porcelain (with
		// status `M` for modified — `.gitignore` is the one path the
		// deny-all template explicitly re-allows, so it appears as
		// modified, not ignored). The classifier maps it to
		// `root-gitignore` → dirty-owned → round proceeds to stage/commit/push.
		const statusPorcelainZ = vi.fn(async () => [
			{
				path: ".gitignore",
				indexStatus: " ",
				worktreeStatus: "M",
				oldPath: undefined,
			},
		]);
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const { engine } = makeEngine({
			client: makeGitClient({
				statusPorcelainZ,
				push,
				currentHead: vi.fn(async () => ALIGNED_OID),
				revParse: vi.fn(async () => ALIGNED_OID),
				hasUncommittedChanges: vi.fn(async () => true),
			}),
		});
		await engine.runRound(ROUND);
		expect(statusPorcelainZ).toHaveBeenCalled();
		expect(push).toHaveBeenCalled();
	});

	it("does NOT short-circuit when a brand-new owned file is gitignored-but-dirty (deny-all .gitignore)", async () => {
		// Regression guard for P1 #1.
		//
		// The engine-managed `.gitignore` is `*` + `!.gitignore`, so every
		// FolderStorage-produced summary / aggregate / Markdown is IGNORED
		// (not UNTRACKED) by git. Plain `git status --porcelain` (no
		// `--ignored`) omits ignored files entirely, so the previous gate
		// `hasUncommittedChanges()` returned false on a freshly-onboarded
		// repo folder whose only local change was a brand-new owned summary.
		// Combined with `localHead === remoteHead` (HEAD hasn't moved
		// locally because nothing has been committed yet), the idle
		// short-circuit fired and the round reported `synced` without ever
		// staging or pushing the file. The user saw a green checkmark; the
		// remote never received the data.
		//
		// The new gate uses `statusPorcelainZ` (which includes ignored
		// files via `--ignored=matching`) + `classifyVaultPath` so any
		// owned-but-ignored entry forces the round through stage / commit /
		// push.
		const summaryPath = `myrepo/.jolli/summaries/${"a".repeat(40)}.json`;
		const statusPorcelainZ = vi.fn(async () => [
			// A brand-new summary written by FolderStorage. Status `!` =
			// ignored (deny-all `.gitignore`); classifier maps it to
			// `summary` so it must NOT be treated as idle.
			{
				path: summaryPath,
				indexStatus: "!",
				worktreeStatus: "!",
				oldPath: undefined,
			},
		]);
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const commit = vi.fn(async () => ALIGNED_OID);
		const { engine } = makeEngine({
			client: makeGitClient({
				statusPorcelainZ,
				push,
				commit,
				currentHead: vi.fn(async () => ALIGNED_OID),
				revParse: vi.fn(async () => ALIGNED_OID),
				// The legacy gate would return false here (gitignored ⇒
				// invisible to plain porcelain). The new gate ignores
				// this return value entirely — only `statusPorcelainZ`
				// + classifier decides idleness.
				hasUncommittedChanges: vi.fn(async () => false),
			}),
		});
		await engine.runRound(ROUND);
		// The short-circuit MUST have been bypassed — both commit and push
		// are downstream of the gate, so seeing either fire proves the
		// gate let the round through. (We don't assert on `stageAddPaths`
		// because `stageVault`'s symlink-guard lstat would reject a path
		// the test fixture never wrote to disk, and that's stageVault's
		// own concern — not the gate's.)
		expect(push).toHaveBeenCalled();
		expect(commit).toHaveBeenCalled();
	});

	it("does NOT short-circuit when a rename moves an owned path to an unowned location (R2)", async () => {
		// Regression for R2.
		//
		// Porcelain emits a rename as a single entry with `path = newPath`
		// + `oldPath = oldPath`. `stageVault.decomposeOps` decomposes it
		// into `del(old) + add(new)` and classifies each side
		// independently — so a rename FROM `<repo>/.jolli/notes/x.md`
		// (owned) TO `<repo>/random/x.md` (unowned) emits a real
		// `git rm --cached` for the owned old side. The idle gate must
		// mirror that bifurcation: classifying only the new side would
		// see `null` (unowned), trip the short-circuit, and leave the
		// del-of-owned uncommitted until the next non-idle round
		// happened to bundle it in.
		const statusPorcelainZ = vi.fn(async () => [
			{
				path: "myrepo/random/moved-note.md", // new (unowned)
				indexStatus: "R",
				worktreeStatus: " ",
				oldPath: "myrepo/.jolli/notes/moved-note.md", // old (owned)
			},
		]);
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const commit = vi.fn(async () => ALIGNED_OID);
		const { engine } = makeEngine({
			client: makeGitClient({
				statusPorcelainZ,
				push,
				commit,
				currentHead: vi.fn(async () => ALIGNED_OID),
				revParse: vi.fn(async () => ALIGNED_OID),
				hasUncommittedChanges: vi.fn(async () => false),
			}),
		});
		await engine.runRound(ROUND);
		// Round must NOT idle-skip — both commit and push fire so the
		// del-of-owned makes it onto the remote in this round, not the
		// next one.
		expect(push).toHaveBeenCalled();
		expect(commit).toHaveBeenCalled();
	});

	it("STILL short-circuits when the only dirty entry is unowned (sentinel / OS noise)", async () => {
		// Counterpart to the regression test above. The `.memorybank-state.json`
		// sentinel sits at vault root and is `--ignored=matching` visible, but
		// the classifier returns `null` for it (P3 #1). The idle gate must
		// ignore unowned noise — otherwise every round would spin up a
		// no-op stage/commit/push cycle just because the sentinel was on
		// disk.
		const statusPorcelainZ = vi.fn(async () => [
			{
				path: ".memorybank-state.json",
				indexStatus: "!",
				worktreeStatus: "!",
				oldPath: undefined,
			},
		]);
		const stageAddPaths = vi.fn(async () => undefined);
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const { engine } = makeEngine({
			client: makeGitClient({
				statusPorcelainZ,
				stageAddPaths,
				push,
				currentHead: vi.fn(async () => ALIGNED_OID),
				revParse: vi.fn(async () => ALIGNED_OID),
				hasUncommittedChanges: vi.fn(async () => false),
			}),
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(push).not.toHaveBeenCalled();
		expect(stageAddPaths).not.toHaveBeenCalled();
	});

	it("does NOT short-circuit when local HEAD is ahead of origin (unpushed historical commit)", async () => {
		// Simulates a previous round that committed but failed to push.
		// We must push the lingering local commit on the next round.
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const { engine } = makeEngine({
			client: makeGitClient({
				push,
				currentHead: vi.fn(async () => "local0000local0000local0000local0000aaaa"),
				revParse: vi.fn(async () => "remote00remote00remote00remote00bbbb"),
				hasUncommittedChanges: vi.fn(async () => false),
			}),
		});
		await engine.runRound(ROUND);
		expect(push).toHaveBeenCalled();
	});

	it("does NOT short-circuit when origin/<branch> doesn't exist (empty-remote first-bind)", async () => {
		// `refExists` returns false → `remoteHasDefault` is false → the
		// short-circuit guard skips its block, and we proceed to push the
		// initial state.
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const { engine } = makeEngine({
			client: makeGitClient({
				push,
				refExists: vi.fn(async () => false),
				currentHead: vi.fn(async () => ALIGNED_OID),
				hasUncommittedChanges: vi.fn(async () => false),
			}),
		});
		await engine.runRound(ROUND);
		expect(push).toHaveBeenCalled();
	});

	it("does NOT short-circuit when pullRebase fast-forwarded a peer commit (keep step-6 symlink sweep)", async () => {
		// Defence-in-depth: peer-pushed content landed in the working tree
		// via pullRebase. The step-6 pre-stage symlink sweep is the
		// designed wall against a peer-pushed symlink reaching the working
		// tree post-pull; skipping the rest of the round here would defer
		// that quarantine to the next poll (default 90 min). Even with
		// local HEAD now matching origin/<branch>, we must continue
		// through step 6 → stageVault → commit (no-op) → push (no-op).
		// Post-Phase-1: assert statusPorcelainZ (stageVault's entry call).
		const statusPorcelainZ = vi.fn(async () => []);
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const { engine } = makeEngine({
			client: makeGitClient({
				statusPorcelainZ,
				push,
				pullRebase: vi.fn(async () => ({ fastForwarded: true, conflicted: [] })),
				currentHead: vi.fn(async () => ALIGNED_OID),
				revParse: vi.fn(async () => ALIGNED_OID),
				hasUncommittedChanges: vi.fn(async () => false),
			}),
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		// stageVault must run so step 6's sweep + the no-op stage path
		// executes; push is allowed to fire (idempotent on "Everything
		// up-to-date").
		expect(statusPorcelainZ).toHaveBeenCalled();
	});

	it("falls through to normal commit/push when the short-circuit probe throws", async () => {
		// Defensive: a probe failure (e.g. revParse threw) must NOT block
		// the round — fall through to stageAll → commit → push, whose own
		// no-op branches preserve correctness.
		const push = vi.fn(async () => ({ ok: true as const, transmitted: true }));
		const { engine } = makeEngine({
			client: makeGitClient({
				push,
				revParse: vi.fn(async () => {
					throw new Error("rev-parse exploded");
				}),
				hasUncommittedChanges: vi.fn(async () => false),
			}),
		});
		const result = await engine.runRound(ROUND);
		expect(result.newState).toBe("synced");
		expect(push).toHaveBeenCalled();
	});
});
