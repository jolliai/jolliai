/**
 * Tests for GitClient. Uses a real `git init --bare` fixture so the
 * subprocess wiring (env injection, exit-code handling, ls-files parsing)
 * is exercised end-to-end without touching the network.
 *
 * `askpass` is replaced with a no-op stub that returns the existing
 * `process.env` so we don't write `~/.jolli/jollimemory/askpass/` artifacts
 * during tests. file:// remotes don't trigger askpass anyway.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitClient, injectGithubAppUsername, isNetworkErrorMessage, isRepoMissingMessage } from "./GitClient.js";
import type { GitCredentials } from "./SyncTypes.js";

// Isolate every `git` subprocess in this file from the developer's ~/.gitconfig
// and /etc/gitconfig. Without this, a global `commit.gpgsign=true`, gitsign
// signer, or `core.hooksPath` pointing at husky/lefthook will hang `git commit`
// in beforeAll — surfaces as a vitest hookTimeout, not a real failure.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_TERMINAL_PROMPT = "0";

// Every test here spawns several real `git` subprocesses (clone/commit/push/
// pullRebase). Under parallel suite load + `--coverage` instrumentation the
// global 15s testTimeout / 10s hookTimeout flake; 30s gives this real-git
// suite headroom without loosening the global budget for pure-unit tests.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const NOOP_ASKPASS = async (): Promise<{
	scriptPath: string;
	envVar: "JOLLI_SYNC_GIT_TOKEN";
	env: NodeJS.ProcessEnv;
}> => ({
	scriptPath: "/dev/null",
	envVar: "JOLLI_SYNC_GIT_TOKEN",
	env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});

const FAKE_CREDS: GitCredentials = {
	gitUrl: "file:///placeholder",
	token: "ghs_test",
	expiresAt: Date.now() + 3600_000,
	repoFullName: "jolli-vaults/placeholder",
	defaultBranch: "main",
	githubRepoCreated: false,
	alreadyVaultBound: true,
	lockOwnerToken: "test-lock-owner-token",
};

async function backdateFile(path: string, ageMs: number): Promise<void> {
	const seconds = (Date.now() - ageMs) / 1000;
	await utimes(path, seconds, seconds);
}

let rootTempDir: string;
let bareRepo: string;
let bareRepoUrl: string;

function gitSync(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

beforeAll(async () => {
	rootTempDir = await mkdtemp(join(tmpdir(), "gitvault-"));
	bareRepo = join(rootTempDir, "origin.git");
	await mkdir(bareRepo, { recursive: true });
	execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bareRepo], { stdio: "ignore" });
	bareRepoUrl = `file://${bareRepo}`;

	// Seed the bare repo with one commit on main via a throwaway clone.
	const seedClone = join(rootTempDir, "seed");
	execFileSync("git", ["clone", "--quiet", bareRepoUrl, seedClone], { stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "seed@example.com"], { cwd: seedClone });
	execFileSync("git", ["config", "user.name", "Seed"], { cwd: seedClone });
	await writeFile(join(seedClone, "README.md"), "# seed\n");
	execFileSync("git", ["add", "."], { cwd: seedClone });
	execFileSync("git", ["commit", "--quiet", "-m", "[jolli-mb] seed"], { cwd: seedClone });
	execFileSync("git", ["push", "--quiet", "origin", "main"], { cwd: seedClone });
}, 30_000);

afterAll(async () => {
	await rm(rootTempDir, { recursive: true, force: true });
});

let memoryBankRoot: string;

beforeEach(async () => {
	// Each test gets its own clone target. Bare repo state survives across
	// tests on purpose — multi-device push scenarios depend on it.
	memoryBankRoot = await mkdtemp(join(rootTempDir, "vault-"));
	await rm(memoryBankRoot, { recursive: true, force: true });
});

function makeClient(): GitClient {
	return new GitClient({ memoryBankRoot, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
}

describe("GitClient", () => {
	describe("checkGitInstalled", () => {
		it("returns { ok: true, version } when git is on PATH", async () => {
			const c = new GitClient({ memoryBankRoot: rootTempDir, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			const r = await c.checkGitInstalled();
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.version).toMatch(/^git version/);
		});

		it("returns { ok: false } when git is not found", async () => {
			const c = new GitClient({
				memoryBankRoot: rootTempDir,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				// Force ENOENT by pointing at a non-existent binary via a fake execFile.
				execFileImpl: (async () => {
					const err = new Error("not found") as NodeJS.ErrnoException;
					err.code = "ENOENT";
					throw err;
				}) as never,
			});
			const r = await c.checkGitInstalled();
			expect(r.ok).toBe(false);
		});
	});

	describe("clone + currentHead + currentBranch", () => {
		it("clones the bare repo and points HEAD at the seed commit", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const head = await client.currentHead();
			expect(head).toHaveLength(40);
			expect(await client.currentBranch()).toBe("main");
		});
	});

	describe("commit + push + fetch + pullRebase clean", () => {
		it("commits a new file, pushes, and a second clone can pullRebase the change", async () => {
			const clientA = makeClient();
			await clientA.clone(bareRepoUrl);

			await writeFile(join(memoryBankRoot, "alpha.md"), "alpha\n");
			await clientA.stageAll();
			const sha = await clientA.commit("[jolli-mb] add: alpha", {
				name: "Tester",
				email: "tester@example.com",
			});
			expect(sha).toHaveLength(40);

			const pushed = await clientA.push();
			expect(pushed.ok).toBe(true);
			// On a real push that transmits new commits, transmitted=true so
			// the engine fires notifyPush.
			if (pushed.ok) expect(pushed.transmitted).toBe(true);

			// Second push immediately after — nothing new on local → git reports
			// "Everything up-to-date" → transmitted=false so the engine skips
			// the redundant notifyPush. This is the §0.8 idle-tick fix.
			const noop = await clientA.push();
			expect(noop.ok).toBe(true);
			if (noop.ok) expect(noop.transmitted).toBe(false);

			// Second clone: pull-rebase should fast-forward to the new commit.
			const vaultB = await mkdtemp(join(rootTempDir, "vaultB-"));
			await rm(vaultB, { recursive: true, force: true });
			const clientB = new GitClient({ memoryBankRoot: vaultB, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			await clientB.clone(bareRepoUrl);
			const pull = await clientB.pullRebase();
			expect(pull.conflicted).toEqual([]);
		});

		it("commit returns the current HEAD when there is nothing to commit", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const before = await client.currentHead();
			const sha = await client.commit("[jolli-mb] noop", {
				name: "Tester",
				email: "tester@example.com",
			});
			expect(sha).toBe(before);
		});

		it("fetch is a no-op when the remote has no new commits", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			await expect(client.fetch()).resolves.toBeUndefined();
		});
	});

	describe("push — auth-rejected detection", () => {
		it("flags unauthorized=true when git stderr contains an auth failure", async () => {
			const fakeExec = ((_cmd: string, args: ReadonlyArray<string>) => {
				if (args.includes("symbolic-ref")) {
					return Promise.resolve({ stdout: "main\n", stderr: "" });
				}
				if (args.includes("push")) {
					const err = new Error("auth") as Error & { stderr?: string; code?: number };
					err.stderr = "remote: Invalid username or password\nfatal: Authentication failed";
					err.code = 128;
					return Promise.reject(err);
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			}) as unknown as typeof execFileSync;
			const c = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			const result = await c.push();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.unauthorized).toBe(true);
				expect(result.nonFastForward).toBe(false);
			}
		});

		it("does NOT flag non-FF when both auth-failure AND 'rejected' appear", async () => {
			const fakeExec = ((_cmd: string, args: ReadonlyArray<string>) => {
				if (args.includes("symbolic-ref")) {
					return Promise.resolve({ stdout: "main\n", stderr: "" });
				}
				if (args.includes("push")) {
					const err = new Error("auth") as Error & { stderr?: string; code?: number };
					err.stderr = "rejected: Authentication failed";
					err.code = 128;
					return Promise.reject(err);
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			}) as unknown as typeof execFileSync;
			const c = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			const result = await c.push();
			if (!result.ok) {
				// Auth wins — the engine handles unauthorized first.
				expect(result.unauthorized).toBe(true);
				expect(result.nonFastForward).toBe(false);
			}
		});
	});

	describe("push — repoMissing (404) detection (§0.6)", () => {
		it("flags repoMissing=true when git stderr says 'Repository not found'", async () => {
			const fakeExec = ((_cmd: string, args: ReadonlyArray<string>) => {
				if (args.includes("symbolic-ref")) {
					return Promise.resolve({ stdout: "main\n", stderr: "" });
				}
				if (args.includes("push")) {
					const err = new Error("404") as Error & { stderr?: string; code?: number };
					err.stderr =
						"remote: Repository not found.\nfatal: repository 'https://github.com/jolli-vaults/test.git/' not found";
					err.code = 128;
					return Promise.reject(err);
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			}) as unknown as typeof execFileSync;
			const c = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			const result = await c.push();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.repoMissing).toBe(true);
				expect(result.unauthorized).toBe(false);
				expect(result.nonFastForward).toBe(false);
			}
		});

		it("auth wins over repoMissing when both signals appear (fresh token may re-authorize)", async () => {
			const fakeExec = ((_cmd: string, args: ReadonlyArray<string>) => {
				if (args.includes("symbolic-ref")) {
					return Promise.resolve({ stdout: "main\n", stderr: "" });
				}
				if (args.includes("push")) {
					const err = new Error("ambiguous") as Error & { stderr?: string; code?: number };
					// GitHub sometimes surfaces "Repository not found" for unauthorized
					// reads of private repos; pair it with an auth marker to confirm
					// the precedence rule.
					err.stderr = "remote: Repository not found.\nfatal: Authentication failed";
					err.code = 128;
					return Promise.reject(err);
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			}) as unknown as typeof execFileSync;
			const c = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			const result = await c.push();
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.unauthorized).toBe(true);
				expect(result.repoMissing).toBe(false);
			}
		});
	});

	describe("isRepoMissingMessage", () => {
		it.each([
			["remote: Repository not found", true],
			["fatal: repository 'https://github.com/jolli-vaults/foo.git/' not found", true],
			["The requested URL returned error: 404", true],
			["fatal: not found", true],
			["fatal: Authentication failed", false],
			["error: failed to push some refs", false],
			["", false],
		])("classifies %j -> %s", (input, expected) => {
			expect(isRepoMissingMessage(input)).toBe(expected);
		});
	});

	describe("isNetworkErrorMessage (§0.11 unified network classification)", () => {
		it.each([
			// WSL/Linux GnuTLS — the real-world case that triggered §0.11
			[
				"fatal: unable to access 'https://github.com/foo/bar.git/': GnuTLS, handshake failed: The TLS connection was non-properly terminated.",
				true,
			],
			// OpenSSL handshake
			[
				"fatal: unable to access 'https://github.com/x/y.git/': SSL_ERROR_SYSCALL in connection to github.com:443",
				true,
			],
			["error: SSL peer handshake failed", true],
			// DNS
			["fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com", true],
			// Connection layer
			[
				"fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443: Connection timed out",
				true,
			],
			[
				"fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443: Connection refused",
				true,
			],
			["error: RPC failed; curl 56 Recv failure: Connection reset by peer", true],
			["fetch-pack: unexpected disconnect while reading sideband packet", true],
			["fatal: the remote end hung up unexpectedly", true],
			["fatal: early EOF", true],
			// Non-network — must NOT match (would mute alarming UI inappropriately)
			["remote: Repository not found", false],
			["fatal: Authentication failed", false],
			["fatal: bad object HEAD", false],
			["error: failed to push some refs", false],
			["fatal: destination path 'foo' already exists", false],
			["", false],
		])("classifies %j -> %s", (input, expected) => {
			expect(isNetworkErrorMessage(input)).toBe(expected);
		});
	});

	describe("push — non-fast-forward", () => {
		it("returns { ok: false, nonFastForward: true } when a concurrent push lands first", async () => {
			// A and B both clone HEAD. A pushes first; B then tries to push
			// a divergent commit without pulling — non-FF.
			const vaultA = await mkdtemp(join(rootTempDir, "vaultA-"));
			const vaultB = await mkdtemp(join(rootTempDir, "vaultB-"));
			await rm(vaultA, { recursive: true, force: true });
			await rm(vaultB, { recursive: true, force: true });
			const clientA = new GitClient({ memoryBankRoot: vaultA, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			const clientB = new GitClient({ memoryBankRoot: vaultB, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			await clientA.clone(bareRepoUrl);
			await clientB.clone(bareRepoUrl);

			await writeFile(join(vaultA, "race-a.md"), "from A\n");
			await clientA.stageAll();
			await clientA.commit("[jolli-mb] add: race a", { name: "A", email: "a@x" });
			expect((await clientA.push()).ok).toBe(true);

			await writeFile(join(vaultB, "race-b.md"), "from B\n");
			await clientB.stageAll();
			await clientB.commit("[jolli-mb] add: race b", { name: "B", email: "b@x" });
			const pushed = await clientB.push();
			expect(pushed.ok).toBe(false);
			if (!pushed.ok) expect(pushed.nonFastForward).toBe(true);
		});
	});

	describe("pullRebase — conflict + readIndexStage + checkout/ours/theirs", () => {
		it("surfaces conflicted paths, exposes :1:/:2:/:3: stages, and resolves via checkoutOurs", async () => {
			// Reset the bare repo state via two divergent commits on the same file.
			const vaultA = await mkdtemp(join(rootTempDir, "conflictA-"));
			const vaultB = await mkdtemp(join(rootTempDir, "conflictB-"));
			await rm(vaultA, { recursive: true, force: true });
			await rm(vaultB, { recursive: true, force: true });
			const clientA = new GitClient({ memoryBankRoot: vaultA, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			const clientB = new GitClient({ memoryBankRoot: vaultB, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			await clientA.clone(bareRepoUrl);
			await clientB.clone(bareRepoUrl);

			// Both modify the same line of notes/foo.md.
			await mkdir(join(vaultA, "notes"), { recursive: true });
			await mkdir(join(vaultB, "notes"), { recursive: true });
			await writeFile(join(vaultA, "notes", "foo.md"), "alpha-A\n");
			await writeFile(join(vaultB, "notes", "foo.md"), "alpha-B\n");

			// A commits + pushes first.
			await clientA.stageAll();
			await clientA.commit("[jolli-mb] add: foo from A", { name: "A", email: "a@x" });
			await clientA.push();

			// B commits and pulls — conflict.
			await clientB.stageAll();
			await clientB.commit("[jolli-mb] add: foo from B", { name: "B", email: "b@x" });
			const pull = await clientB.pullRebase();
			expect(pull.conflicted).toContain("notes/foo.md");

			// Read each stage.
			const base = await clientB.readIndexStage("notes/foo.md", 1);
			const ours = await clientB.readIndexStage("notes/foo.md", 2);
			const theirs = await clientB.readIndexStage("notes/foo.md", 3);
			// Base file did not exist on the seed; git treats the missing base
			// as no entry — readIndexStage returns null. ours/theirs are present.
			expect(base).toBeNull();
			expect(ours?.trim()).toBe("alpha-A");
			expect(theirs?.trim()).toBe("alpha-B");

			// Resolve via Tier 3 "Use mine" path — keeps B's edit.
			await clientB.checkoutOurs("notes/foo.md");
			expect(await clientB.hasUnmergedPaths()).toEqual([]);
			await clientB.rebaseContinue({ name: "B", email: "b@x" });
			const resolved = await readFile(join(vaultB, "notes", "foo.md"), "utf-8");
			expect(resolved.trim()).toBe("alpha-B");

			// The vault is now ahead of origin; push succeeds.
			const pushed = await clientB.push();
			expect(pushed.ok).toBe(true);
		});
	});

	describe("hasUncommittedChanges (§0.9 auto-reconcile)", () => {
		it("returns false on a freshly cloned, clean tree", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			expect(await client.hasUncommittedChanges()).toBe(false);
		});

		it("returns true after writing a new file (untracked) before stage", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			await writeFile(join(memoryBankRoot, "scratch.md"), "draft\n");
			expect(await client.hasUncommittedChanges()).toBe(true);
		});

		it("returns true after deleting a tracked file (user `rm`-ed it)", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			// README.md was seeded in beforeAll. Delete it on disk; git status
			// must report the deletion as uncommitted.
			await rm(join(memoryBankRoot, "README.md"));
			expect(await client.hasUncommittedChanges()).toBe(true);
		});

		it("returns false again after stage+commit", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			await writeFile(join(memoryBankRoot, "scratch.md"), "draft\n");
			expect(await client.hasUncommittedChanges()).toBe(true);
			await client.stageAll();
			await client.commit("[jolli-mb] add: scratch", { name: "T", email: "t@x" });
			expect(await client.hasUncommittedChanges()).toBe(false);
		});
	});

	describe("listDirtyPaths (§I9 corrupt-JSON quarantine)", () => {
		it("returns an empty array on a clean tree", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			expect(await client.listDirtyPaths()).toEqual([]);
		});

		it("lists an untracked new file by its relative path", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			await writeFile(join(memoryBankRoot, "scratch.md"), "x");
			expect(await client.listDirtyPaths()).toEqual(["scratch.md"]);
		});

		it("lists a modified tracked file by its relative path", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			await writeFile(join(memoryBankRoot, "README.md"), "edited");
			const dirty = await client.listDirtyPaths();
			expect(dirty).toContain("README.md");
		});

		it("lists a deleted tracked file (returned for caller to lstat-and-skip)", async () => {
			// Pure deletes return the path so the porcelain output stays
			// faithful; the quarantine helper filters via `lstat` and
			// treats missing files as no-op.
			const client = makeClient();
			await client.clone(bareRepoUrl);
			await rm(join(memoryBankRoot, "README.md"));
			const dirty = await client.listDirtyPaths();
			expect(dirty).toContain("README.md");
		});

		it("handles paths with spaces verbatim under `-z`", async () => {
			// Default porcelain quotes paths with spaces; `-z` disables
			// that. Confirm we return the raw path so the caller doesn't
			// have to undo quoting.
			const client = makeClient();
			await client.clone(bareRepoUrl);
			await writeFile(join(memoryBankRoot, "with spaces.md"), "x");
			const dirty = await client.listDirtyPaths();
			expect(dirty).toContain("with spaces.md");
		});

		it("emits both source and destination paths for a rename even when the source name has a space in its third byte", async () => {
			// Regression guard for the porcelain `-z` rename trailer
			// parser. `git mv ab cdef.json renamed.json` produces:
			//   `R<XY> renamed.json\0ab cdef.json\0`
			// A naive "third char is a space ⇒ status prefix" heuristic
			// stripped the first three bytes of `ab cdef.json` and
			// returned `cdef.json`, silently misattributing the source
			// path. The state-machine parser handles renames correctly.
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const oldName = "ab cdef.json";
			await writeFile(join(memoryBankRoot, oldName), JSON.stringify({ ok: 1 }));
			await client.stageAll();
			await client.commit("[jolli-mb] add: ab cdef.json", { name: "T", email: "t@x" });
			// `git mv` is the supported way to record a rename — produces
			// an `R` porcelain entry with both paths.
			execFileSync("git", ["mv", oldName, "renamed.json"], {
				cwd: memoryBankRoot,
				stdio: "ignore",
			});
			const dirty = await client.listDirtyPaths();
			expect(dirty).toContain("ab cdef.json");
			expect(dirty).toContain("renamed.json");
			// Critical: the SOURCE path is returned VERBATIM, not stripped
			// to `cdef.json`. Pre-fix this assertion was the symptom.
			expect(dirty).not.toContain("cdef.json");
		});
	});

	describe("hasUnmergedPaths", () => {
		it("returns empty when the index is clean", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			expect(await client.hasUnmergedPaths()).toEqual([]);
		});
	});

	describe("readIndexStage", () => {
		it("returns null when the stage doesn't exist", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			expect(await client.readIndexStage("missing.md", 1)).toBeNull();
		});
	});

	describe("rebaseAbort", () => {
		it("aborts a paused rebase", async () => {
			const vaultA = await mkdtemp(join(rootTempDir, "abortA-"));
			const vaultB = await mkdtemp(join(rootTempDir, "abortB-"));
			await rm(vaultA, { recursive: true, force: true });
			await rm(vaultB, { recursive: true, force: true });
			const clientA = new GitClient({ memoryBankRoot: vaultA, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			const clientB = new GitClient({ memoryBankRoot: vaultB, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			await clientA.clone(bareRepoUrl);
			await clientB.clone(bareRepoUrl);

			await mkdir(join(vaultA, "notes"), { recursive: true });
			await mkdir(join(vaultB, "notes"), { recursive: true });
			await writeFile(join(vaultA, "notes", "abort.md"), "from A\n");
			await writeFile(join(vaultB, "notes", "abort.md"), "from B\n");
			await clientA.stageAll();
			await clientA.commit("[jolli-mb] add: abort A", { name: "A", email: "a@x" });
			await clientA.push();
			await clientB.stageAll();
			await clientB.commit("[jolli-mb] add: abort B", { name: "B", email: "b@x" });
			await clientB.pullRebase();

			await clientB.rebaseAbort();
			expect(await clientB.hasUnmergedPaths()).toEqual([]);
		});
	});

	describe("isRebaseInProgress", () => {
		// The vault is exclusively driven by SyncEngine — no human runs git
		// in there — so `isRebaseInProgress` returning true at round start
		// always means the previous round was killed mid-rebase, and the
		// engine's self-heal step (`SyncEngine.doRound`) can safely abort.
		it("returns false on a clean clone (no rebase ever started)", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			expect(await client.isRebaseInProgress()).toBe(false);
		});

		it("returns false when `.git/` itself is missing (first-bind / cold path)", async () => {
			// `memoryBankRoot` from `beforeEach` is a freshly-mkdtemp'd + rm'd
			// path; `.git/` cannot exist yet. The probe must swallow ENOENT
			// rather than throwing — otherwise the engine's self-heal step
			// would crash the cold-clone path.
			const client = makeClient();
			expect(await client.isRebaseInProgress()).toBe(false);
		});

		it("returns true while a rebase is paused on conflicts, false after abort", async () => {
			const vaultA = await mkdtemp(join(rootTempDir, "rebprobeA-"));
			const vaultB = await mkdtemp(join(rootTempDir, "rebprobeB-"));
			await rm(vaultA, { recursive: true, force: true });
			await rm(vaultB, { recursive: true, force: true });
			const clientA = new GitClient({ memoryBankRoot: vaultA, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			const clientB = new GitClient({ memoryBankRoot: vaultB, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			await clientA.clone(bareRepoUrl);
			await clientB.clone(bareRepoUrl);

			// Force a conflicting concurrent edit so `pullRebase` pauses
			// without throwing — mirrors the in-progress state that our
			// production self-heal step is supposed to detect.
			await mkdir(join(vaultA, "notes"), { recursive: true });
			await mkdir(join(vaultB, "notes"), { recursive: true });
			await writeFile(join(vaultA, "notes", "probe.md"), "from A\n");
			await writeFile(join(vaultB, "notes", "probe.md"), "from B\n");
			await clientA.stageAll();
			await clientA.commit("[jolli-mb] add: probe A", { name: "A", email: "a@x" });
			await clientA.push();
			await clientB.stageAll();
			await clientB.commit("[jolli-mb] add: probe B", { name: "B", email: "b@x" });
			await clientB.pullRebase();

			expect(await clientB.isRebaseInProgress()).toBe(true);
			await clientB.rebaseAbort();
			expect(await clientB.isRebaseInProgress()).toBe(false);
		});
	});

	describe("revParse", () => {
		// Used by `SyncEngine`'s idle-round short-circuit to compare local
		// HEAD against `refs/remotes/origin/<branch>`. Must return the OID
		// when the ref resolves and `null` when it doesn't (rather than
		// throwing or returning a partial string) — the caller treats
		// `null` as "ref absent → don't short-circuit".
		it("returns the 40-char OID for a resolvable ref (HEAD)", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const head = await client.revParse("HEAD");
			expect(head).not.toBeNull();
			expect(head).toHaveLength(40);
		});

		it("returns null for a ref that doesn't exist", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const missing = await client.revParse("refs/heads/does-not-exist");
			expect(missing).toBeNull();
		});

		it("returns null when there is no repository (no `.git/`)", async () => {
			// Fresh `memoryBankRoot` from beforeEach — no `.git/` directory
			// yet. `git rev-parse` exits non-zero; the helper must surface
			// that as `null` rather than throwing.
			const client = makeClient();
			const head = await client.revParse("HEAD");
			expect(head).toBeNull();
		});
	});

	describe("sweepStaleLockFiles", () => {
		// SIGKILL on a running git op leaves `<name>.lock` siblings behind
		// (`.git/index.lock`, `.git/HEAD.lock`, `refs/heads/<b>.lock`,
		// `packed-refs.lock`, `config.lock`). The next op fails with
		// "Unable to create '….lock': File exists" — sticky terminal error
		// with no actionable customer UI. The sweep removes them by mtime.
		it("removes `.git/index.lock` older than the TTL", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const indexLock = join(memoryBankRoot, ".git", "index.lock");
			await writeFile(indexLock, "");
			// Backdate the lock a minute so its mtime is unambiguously older
			// than the sweep cutoff. `Date.now()` floors to integer ms while
			// `mtimeMs` carries sub-ms precision, so a just-written lock can
			// read as *newer* than a TTL=0 cutoff — backdating removes that
			// race and makes the assertion truly clock-resolution-independent.
			await backdateFile(indexLock, 60_000);
			const result = await client.sweepStaleLockFiles(0);
			expect(result.removed).toContain(indexLock);
			// Sanity: lock actually gone from disk.
			await expect(stat(indexLock)).rejects.toThrow();
		});

		it("removes recursive `refs/**/*.lock` (per-branch ref locks)", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const refsHeads = join(memoryBankRoot, ".git", "refs", "heads");
			const branchLock = join(refsHeads, "main.lock");
			// `refs/heads/main` already exists (set by clone); the .lock
			// sibling is the artifact a killed `git update-ref` leaves.
			await writeFile(branchLock, "");
			// Backdate so the mtime is unambiguously older than the cutoff —
			// see the index.lock case above for why a TTL=0 sweep otherwise
			// races sub-ms `mtimeMs` against floored `Date.now()`.
			await backdateFile(branchLock, 60_000);
			const result = await client.sweepStaleLockFiles(0);
			expect(result.removed).toContain(branchLock);
		});

		it("leaves fresh locks (younger than TTL) alone — concurrent in-flight ops are not touched", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const indexLock = join(memoryBankRoot, ".git", "index.lock");
			await writeFile(indexLock, "");
			// 60 s TTL > the lock's age (just written) → must NOT be removed.
			const result = await client.sweepStaleLockFiles(60_000);
			expect(result.removed).toEqual([]);
			// Sanity: lock still there.
			await stat(indexLock); // throws if missing
		});

		it("default TTL is ≥ 5 min so out-of-band manual `git gc` / `git fetch` aren't disrupted", async () => {
			// Regression guard: prior version defaulted to 30 s, which would
			// rip out the live lock under a slow user-initiated git op in the
			// vault. Default must stay long enough that a multi-minute manual
			// op survives a sync round running concurrently. Tightening this
			// back below 5 min requires re-justifying the safety story.
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const indexLock = join(memoryBankRoot, ".git", "index.lock");
			await writeFile(indexLock, "");
			// Call with the default TTL (no argument). A just-created lock
			// must NOT be swept.
			const result = await client.sweepStaleLockFiles();
			expect(result.removed).toEqual([]);
			await stat(indexLock); // still there
		});

		it("is a no-op on a fresh checkout with no `.git/` directory", async () => {
			// Fresh-from-mkdtemp `memoryBankRoot` from beforeEach — no
			// `.git/` yet. Sweep must not throw and must return an empty
			// removed list, otherwise the engine's self-heal step would
			// crash the cold-clone path.
			const client = makeClient();
			const result = await client.sweepStaleLockFiles(0);
			expect(result.removed).toEqual([]);
		});

		it("never descends into `.git/objects/` — pack-file `*.lock` siblings have their own semantics", async () => {
			// `git pack-objects` / `git gc` use `.pack.lock` and similar
			// transitorily; removing them under a live `git gc` would corrupt
			// the repack. The sweep candidate list explicitly avoids
			// `.git/objects/` (only walks `.git/refs/` recursively + four
			// top-level singletons). Regression guard: future broadening of
			// the candidate set must not start traversing objects/.
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const packDir = join(memoryBankRoot, ".git", "objects", "pack");
			await mkdir(packDir, { recursive: true });
			const packLock = join(packDir, "pack-deadbeef.lock");
			await writeFile(packLock, "");
			// TTL=0 would otherwise match anything; the only thing keeping
			// this lock alive is the sweep refusing to descend into objects/.
			const result = await client.sweepStaleLockFiles(0);
			expect(result.removed).not.toContain(packLock);
			// Sanity: pack lock untouched.
			await stat(packLock);
		});

		it("does not sweep names that aren't `*.lock`", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			const fakeName = join(memoryBankRoot, ".git", "index");
			// `.git/index` is the real index file — must NEVER be touched.
			const result = await client.sweepStaleLockFiles(0);
			expect(result.removed).not.toContain(fakeName);
			// Sanity: real index is still there.
			await stat(fakeName);
		});
	});

	describe("checkoutTheirs", () => {
		it("resolves a conflict by accepting the remote version", async () => {
			const vaultA = await mkdtemp(join(rootTempDir, "theirsA-"));
			const vaultB = await mkdtemp(join(rootTempDir, "theirsB-"));
			await rm(vaultA, { recursive: true, force: true });
			await rm(vaultB, { recursive: true, force: true });
			const clientA = new GitClient({ memoryBankRoot: vaultA, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			const clientB = new GitClient({ memoryBankRoot: vaultB, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			await clientA.clone(bareRepoUrl);
			await clientB.clone(bareRepoUrl);

			await mkdir(join(vaultA, "notes"), { recursive: true });
			await mkdir(join(vaultB, "notes"), { recursive: true });
			await writeFile(join(vaultA, "notes", "theirs.md"), "from A\n");
			await writeFile(join(vaultB, "notes", "theirs.md"), "from B\n");
			await clientA.stageAll();
			await clientA.commit("[jolli-mb] add: theirs A", { name: "A", email: "a@x" });
			await clientA.push();
			await clientB.stageAll();
			await clientB.commit("[jolli-mb] add: theirs B", { name: "B", email: "b@x" });
			await clientB.pullRebase();

			await clientB.checkoutTheirs("notes/theirs.md");
			await clientB.rebaseContinue({ name: "B", email: "b@x" });
			const finalContent = await readFile(join(vaultB, "notes", "theirs.md"), "utf-8");
			expect(finalContent.trim()).toBe("from A");
		});
	});

	describe("pullRebase — non-conflict failure", () => {
		it("throws when fetch fails for a reason other than a conflict", async () => {
			const vaultC = await mkdtemp(join(rootTempDir, "fail-"));
			await rm(vaultC, { recursive: true, force: true });
			// Clone, then point origin at a non-existent URL so the pull errors.
			const client = new GitClient({ memoryBankRoot: vaultC, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
			await client.clone(bareRepoUrl);
			execFileSync("git", ["remote", "set-url", "origin", "file:///nonexistent.git"], { cwd: vaultC });
			await expect(client.pullRebase()).rejects.toThrow(/git pull --rebase failed/);
		});
	});

	describe("commit — error parsing branches", () => {
		it("returns currentHead when 'nothing to commit' is reported on a non-zero exit", async () => {
			// Drive run() via a stubbed execFileImpl so we can simulate the exact
			// "nothing to commit" exit-1 output without needing two prior commits.
			const fakeExec = ((_cmd: string, args: ReadonlyArray<string>) => {
				if (args.includes("rev-parse")) {
					return Promise.resolve({ stdout: "deadbeef\n", stderr: "" });
				}
				if (args.includes("commit")) {
					const err = new Error("non-zero exit") as Error & { stdout?: string; code?: number };
					err.stdout = "On branch main\nnothing to commit, working tree clean\n";
					err.code = 1;
					return Promise.reject(err);
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			}) as unknown as typeof execFileSync;
			const c = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			const sha = await c.commit("[jolli-mb] noop", { name: "X", email: "x@x" });
			expect(sha).toBe("deadbeef");
		});

		it("throws when commit fails with a non-'nothing to commit' message", async () => {
			const fakeExec = ((_cmd: string, args: ReadonlyArray<string>) => {
				if (args.includes("commit")) {
					const err = new Error("real failure") as Error & { stderr?: string; code?: number };
					err.stderr = "fatal: not a git repository";
					err.code = 128;
					return Promise.reject(err);
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			}) as unknown as typeof execFileSync;
			const c = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			await expect(c.commit("[jolli-mb] x", { name: "X", email: "x@x" })).rejects.toThrow(/not a git repository/);
		});
	});

	describe("addPath / stageAll / untrackPathGlob", () => {
		it("addPath stages a specific file (used by ConflictResolver after Tier 1.5)", async () => {
			const c = makeClient();
			await c.clone(bareRepoUrl);
			await writeFile(join(memoryBankRoot, "single.md"), "# single\n");
			await writeFile(join(memoryBankRoot, "other.md"), "# other\n");
			await c.addPath("single.md");
			// `git diff --name-only --cached` lists staged but not yet committed.
			const staged = gitSync(["diff", "--name-only", "--cached"], memoryBankRoot).split("\n");
			expect(staged).toContain("single.md");
			expect(staged).not.toContain("other.md");
		});

		it("untrackPathGlob removes a tracked path from the index without deleting on disk", async () => {
			const c = makeClient();
			await c.clone(bareRepoUrl);
			await writeFile(join(memoryBankRoot, "to-untrack.md"), "# tracked\n");
			await c.addPath("to-untrack.md");
			await c.commit("[jolli-mb] add", { name: "Test", email: "t@t" });
			// Tracked. Now untrack via the glob.
			await c.untrackPathGlob("to-untrack.md");
			const staged = gitSync(["status", "--porcelain"], memoryBankRoot);
			// `D` = deletion staged (untracked from index), file still on disk.
			expect(staged).toMatch(/^D\s+to-untrack\.md/m);
			// Disk copy survives.
			const onDisk = await readFile(join(memoryBankRoot, "to-untrack.md"), "utf-8");
			expect(onDisk).toBe("# tracked\n");
		});

		it("untrackPathGlob is a no-op when the glob has no matches (no throw)", async () => {
			const c = makeClient();
			await c.clone(bareRepoUrl);
			// `git rm --cached --ignore-unmatch nonexistent` exits with code 0 OR non-zero
			// depending on git version + match shape; the wrapper swallows non-zero as
			// "no matches" and logs at debug. Either way, no throw.
			await expect(c.untrackPathGlob("does-not-exist-*.md")).resolves.toBeUndefined();
		});

		it("untrackPathGlob THROWS on a non-zero exit (I8: --ignore-unmatch maps no-match to 0, so non-zero is a real error)", async () => {
			// Pre-fix this test asserted "swallows non-zero exit + logs at
			// debug" — that's the silent-failure surface I8 exploited. The
			// wrapper now propagates so privacy-critical callers (and the
			// future explicit purge command) see real git failures
			// (`.git/index.lock` contention, permission errors, fs
			// corruption) instead of silently moving on as if untrack
			// succeeded.
			const fakeExec = async (
				_cmd: string,
				_args: ReadonlyArray<string>,
				_opts: unknown,
			): Promise<{ stdout: string; stderr: string }> => {
				const err = new Error("git rm failed") as Error & {
					stdout?: string;
					stderr?: string;
					code?: number;
				};
				err.stdout = "";
				err.stderr = "fatal: unable to acquire .git/index.lock";
				err.code = 128;
				throw err;
			};
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			await expect(c.untrackPathGlob("nothing-tracked")).rejects.toThrow(/git rm --cached failed/);
		});

		it("untrackPathGlob honors `**` (gitignore-dialect) via the `:(glob)` magic prefix", async () => {
			// Pre-fix: `**/.jolli/transcripts/` was passed as a literal pathspec
			// and git treated `**` as the literal two-asterisk string, so
			// nested transcripts directories (`<repo>/.jolli/transcripts/...`)
			// were never untracked even when `syncTranscripts` was OFF. The
			// wrapper now prepends `:(glob)` so git uses fnmatch dialect.
			const c = makeClient();
			await c.clone(bareRepoUrl);
			const nested = join(memoryBankRoot, "repoA", ".jolli", "transcripts");
			await mkdir(nested, { recursive: true });
			await writeFile(join(nested, "abc.json"), "{}");
			await c.addPath("repoA/.jolli/transcripts/abc.json");
			await c.commit("[jolli-mb] seed", { name: "T", email: "t@t" });

			await c.untrackPathGlob("**/.jolli/transcripts/");

			const staged = gitSync(["status", "--porcelain"], memoryBankRoot);
			expect(staged).toMatch(/^D\s+repoA\/\.jolli\/transcripts\/abc\.json/m);
		});
	});

	describe("initRemote — fresh init + remote upsert", () => {
		it("initializes a repo with the credentials' defaultBranch and adds origin", async () => {
			const c = makeClient();
			await mkdir(memoryBankRoot, { recursive: true });
			await c.initRemote(bareRepoUrl);

			// HEAD points at the defaultBranch ref even before any commit.
			const headRef = gitSync(["symbolic-ref", "HEAD"], memoryBankRoot);
			expect(headRef).toBe(`refs/heads/${FAKE_CREDS.defaultBranch}`);
			// Origin remote registered with the auth-injected URL.
			const remoteUrl = gitSync(["remote", "get-url", "origin"], memoryBankRoot);
			expect(remoteUrl).toBe(injectGithubAppUsername(bareRepoUrl));
		});

		it("upserts origin via set-url when `remote add` fails because origin already exists", async () => {
			const c = makeClient();
			await mkdir(memoryBankRoot, { recursive: true });
			// First init creates origin.
			await c.initRemote(bareRepoUrl);
			// Second init MUST NOT fail — it should fall through to `set-url`.
			const otherBare = join(rootTempDir, "other.git");
			await mkdir(otherBare, { recursive: true });
			execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", otherBare], { stdio: "ignore" });
			const otherUrl = `file://${otherBare}`;
			await expect(c.initRemote(otherUrl)).resolves.toBeUndefined();
			expect(gitSync(["remote", "get-url", "origin"], memoryBankRoot)).toBe(injectGithubAppUsername(otherUrl));
		});
	});

	describe("run — empty-stderr fallback to err.message", () => {
		it("uses err.message when stderr is empty (so logs always have *something*)", async () => {
			// Reproducer: a git invocation that fails with stderr="" — synthesize by
			// stubbing execFileImpl to reject with the shape execFile produces.
			const fakeExec = ((_cmd: string, args: ReadonlyArray<string>) => {
				if (args.includes("add")) {
					const err = new Error("Command failed: git add --all") as Error & {
						stderr?: string;
						code?: number;
					};
					err.stderr = ""; // explicit empty — the regression we guard against
					err.code = 1;
					return Promise.reject(err);
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			}) as unknown as typeof execFileSync;
			const c = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			// runExpectOk path: must throw with the err.message text in the message,
			// proving the `|| err.message` fallback fired.
			await expect(c.stageAll()).rejects.toThrow(/Command failed: git add --all/);
		});
	});

	describe("currentBranch — detached HEAD fallback", () => {
		it("returns 'HEAD' when symbolic-ref exits non-zero", async () => {
			const fakeExec = ((_cmd: string, args: ReadonlyArray<string>) => {
				if (args.includes("symbolic-ref")) {
					const err = new Error("detached") as Error & { stderr?: string; code?: number };
					err.stderr = "fatal: ref HEAD is not a symbolic ref";
					err.code = 1;
					return Promise.reject(err);
				}
				return Promise.resolve({ stdout: "", stderr: "" });
			}) as unknown as typeof execFileSync;
			const c = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			expect(await c.currentBranch()).toBe("HEAD");
		});
	});

	describe("getOriginUrl (§P1#1 — vault identity guard)", () => {
		it("returns the configured origin URL after clone", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			// Clone injects `x-access-token@` for github.com URLs; file://
			// URLs are passed through unchanged, so we get the exact bare
			// URL back.
			expect(await client.getOriginUrl()).toBe(bareRepoUrl);
		});

		it("returns null when no origin remote is configured", async () => {
			// Fresh `git init` with no remote — getOriginUrl should refuse
			// rather than throw so the engine routes to vault_mismatch.
			await mkdir(memoryBankRoot, { recursive: true });
			execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: memoryBankRoot });
			const client = makeClient();
			expect(await client.getOriginUrl()).toBeNull();
		});
	});

	describe("checkoutBranch / checkoutTrackingBranch (§P1#2 — default-branch guard)", () => {
		it("checkoutBranch switches HEAD to an existing local branch", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			// Create a local side branch then switch back via the engine helper.
			execFileSync("git", ["checkout", "-b", "side"], { cwd: memoryBankRoot });
			expect(await client.currentBranch()).toBe("side");
			await client.checkoutBranch("main");
			expect(await client.currentBranch()).toBe("main");
		});

		it("checkoutBranch throws when the local ref doesn't exist", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			await expect(client.checkoutBranch("doesnotexist")).rejects.toThrow();
		});

		it("checkoutTrackingBranch recreates the local default branch from origin/<branch>", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			// Simulate a vault whose local `main` was deleted (e.g. shallow
			// clone with detached HEAD). `git branch -D main` while still on
			// main fails, so detach first.
			execFileSync("git", ["checkout", "--detach"], { cwd: memoryBankRoot });
			execFileSync("git", ["branch", "-D", "main"], { cwd: memoryBankRoot });
			// Sanity: main is gone locally now.
			const branches = execFileSync("git", ["branch"], { cwd: memoryBankRoot, encoding: "utf-8" });
			expect(branches).not.toMatch(/^\*?\s*main/m);
			// Recreate from origin's tip.
			await client.checkoutTrackingBranch("main");
			expect(await client.currentBranch()).toBe("main");
		});
	});

	describe("rebase editor suppression + timeout (§P1#3)", () => {
		// Captures the options object `run()` passes to `execFile` so we can
		// assert the editor-suppressing env / config / timeout reach the
		// child. We mock execFile rather than driving a real rebase because
		// the failure mode under test (EDITOR=vi hanging the child forever)
		// is exactly what we don't want to exercise live in CI.
		type Captured = { args: ReadonlyArray<string>; env: NodeJS.ProcessEnv; timeout: number | undefined };

		function makeCapturingClient(): {
			client: GitClient;
			captured: Captured[];
		} {
			const captured: Captured[] = [];
			const fakeExec = ((
				_cmd: string,
				args: ReadonlyArray<string>,
				opts: { env?: NodeJS.ProcessEnv; timeout?: number },
			) => {
				captured.push({ args, env: opts.env ?? {}, timeout: opts.timeout });
				return Promise.resolve({ stdout: "", stderr: "" });
			}) as unknown as typeof execFileSync;
			const client = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			return { client, captured };
		}

		it("rebaseContinue passes `-c core.editor=true`, GIT_EDITOR=true, GIT_SEQUENCE_EDITOR=true, and a timeout", async () => {
			const { client, captured } = makeCapturingClient();
			await client.rebaseContinue();
			expect(captured).toHaveLength(1);
			const call = captured[0];
			if (!call) throw new Error("execFile was not invoked");
			// `-c core.editor=true` must arrive BEFORE the subcommand —
			// git ignores `-c` flags placed after the subcommand argument.
			expect(call.args.slice(0, 10)).toEqual([
				"-c",
				"core.symlinks=false",
				"-c",
				"credential.helper=",
				"-c",
				"credential.modalprompt=false",
				"-c",
				"core.editor=true",
				"rebase",
				"--continue",
			]);
			expect(call.env.GIT_EDITOR).toBe("true");
			expect(call.env.GIT_SEQUENCE_EDITOR).toBe("true");
			// A non-trivial timeout is set (30s today; tightening to ≤60s is
			// fine, going unbounded reintroduces the deadlock).
			expect(typeof call.timeout).toBe("number");
			expect(call.timeout).toBeGreaterThan(0);
			expect(call.timeout).toBeLessThanOrEqual(60_000);
		});

		it("rebaseAbort carries the same editor + timeout protection", async () => {
			const { client, captured } = makeCapturingClient();
			await client.rebaseAbort();
			const call = captured[0];
			if (!call) throw new Error("execFile was not invoked");
			expect(call.args.slice(0, 10)).toEqual([
				"-c",
				"core.symlinks=false",
				"-c",
				"credential.helper=",
				"-c",
				"credential.modalprompt=false",
				"-c",
				"core.editor=true",
				"rebase",
				"--abort",
			]);
			expect(call.env.GIT_EDITOR).toBe("true");
			expect(call.env.GIT_SEQUENCE_EDITOR).toBe("true");
			expect(typeof call.timeout).toBe("number");
		});

		it("pullRebase suppresses the editor too (autosquash / replay paths can pop one)", async () => {
			const { client, captured } = makeCapturingClient();
			await client.pullRebase();
			const call = captured[0];
			if (!call) throw new Error("execFile was not invoked");
			expect(call.args.slice(0, 8)).toEqual([
				"-c",
				"core.symlinks=false",
				"-c",
				"credential.helper=",
				"-c",
				"credential.modalprompt=false",
				"-c",
				"core.editor=true",
			]);
			expect(call.args).toContain("--rebase");
			expect(call.env.GIT_EDITOR).toBe("true");
			// pullRebase deliberately does NOT pass a timeout — the same
			// child may need to fetch over a slow network. Document that
			// invariant so future refactors don't add one absent-mindedly.
			expect(call.timeout).toBeUndefined();
		});

		it("EDITOR=vi in the parent env does NOT leak through (the original failure mode)", async () => {
			// Set EDITOR on the test process the way a real user shell would.
			// The askpass env spreads `process.env`, so without our
			// suppressors the child would inherit `EDITOR=vi` and try to
			// open it on rebase --continue.
			const previousEditor = process.env.EDITOR;
			process.env.EDITOR = "vi";
			try {
				const { client, captured } = makeCapturingClient();
				await client.rebaseContinue();
				const call = captured[0];
				if (!call) throw new Error("execFile was not invoked");
				// EDITOR still shows through (we only override the git-specific
				// vars), but GIT_EDITOR takes precedence in git's resolution
				// order: GIT_EDITOR > core.editor > VISUAL > EDITOR.
				expect(call.env.EDITOR).toBe("vi");
				expect(call.env.GIT_EDITOR).toBe("true");
			} finally {
				if (previousEditor === undefined) delete process.env.EDITOR;
				else process.env.EDITOR = previousEditor;
			}
		});

		it("a child that exceeds the timeout surfaces a 'timed out' stderr (not a hang)", async () => {
			// Simulate execFile's actual reject shape for a timeout: `killed:
			// true`, `signal: 'SIGTERM'`, empty stdout/stderr. The run()
			// helper must rewrite the error so callers see a recognizable
			// message instead of a bare "Command failed:".
			const fakeExec = ((_cmd: string, _args: ReadonlyArray<string>, _opts: { timeout?: number }) => {
				const err = new Error("Command failed") as Error & {
					killed?: boolean;
					signal?: string;
					code?: string;
					stdout?: string;
					stderr?: string;
				};
				err.killed = true;
				err.signal = "SIGTERM";
				err.stdout = "";
				err.stderr = "";
				return Promise.reject(err);
			}) as unknown as typeof execFileSync;
			const client = new GitClient({
				memoryBankRoot: "/tmp/fake",
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			await expect(client.rebaseContinue()).rejects.toThrow(/timed out/);
		});
	});

	describe("small predicate edge cases", () => {
		it("hasUnmergedPaths returns [] when the ls-files invocation itself fails (non-zero exit)", async () => {
			// `git ls-files -u -z` non-zero exit (e.g. corrupted index) — return
			// [] rather than throw so the caller treats "no unmerged entries"
			// as the safe default.
			const fakeExec = async () => {
				const err = new Error("git ls-files failed") as Error & {
					stdout?: string;
					stderr?: string;
					code?: number;
				};
				err.stdout = "";
				err.stderr = "fatal: index file corrupt";
				err.code = 128;
				throw err;
			};
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			expect(await c.hasUnmergedPaths()).toEqual([]);
		});

		it("hasUnmergedPaths returns [] when ls-files output is empty / has malformed entries", async () => {
			// Cover `if (!entry) continue` (empty split chunk after trailing NUL)
			// and `if (tabIdx === -1) continue` (malformed line without a tab).
			const fakeExec = async () =>
				// Mixed: well-formed entry + malformed (no tab) + empty trailing.
				({ stdout: "100644 abc 1\tfoo.md\x00malformed-no-tab\x00", stderr: "" });
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			const result = await c.hasUnmergedPaths();
			// Only the well-formed entry is recorded — malformed one was skipped
			// via tabIdx === -1 branch.
			expect(result.length).toBeLessThanOrEqual(1);
		});

		it("hasUnmergedPaths skips entries whose stage is outside the {1,2,3} set", async () => {
			// Stage "9" yields NaN parsing pass-through ≠ 1/2/3 → continue branch.
			const fakeExec = async () => ({
				stdout: "100644 abc 9\tweird.md\x00100644 abc 2\treal.md\x00",
				stderr: "",
			});
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			const entries = await c.hasUnmergedPaths();
			// Only the stage-2 entry survives the filter.
			expect(entries.map((e) => e.path)).toEqual(["real.md"]);
		});

		it("getOriginUrl returns null when origin URL is configured as empty string", async () => {
			// Covers the `url.length > 0 ? url : null` branch's null side.
			const fakeExec = async () => ({ stdout: "   \n", stderr: "" });
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			expect(await c.getOriginUrl()).toBeNull();
		});

		it("untrackPathGlob preserves an explicit `:(magic)` prefix on the caller's pathspec", async () => {
			// `normalized.startsWith(":(")` true branch — caller has already
			// scoped the pathspec via git pathspec magic; the wrapper must not
			// double-wrap with another `:(glob)`.
			const captured: ReadonlyArray<string>[] = [];
			const fakeExec = async (_cmd: string, args: ReadonlyArray<string>) => {
				captured.push(args);
				return { stdout: "", stderr: "" };
			};
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			await c.untrackPathGlob(":(exclude)secret.json");
			expect(captured[0]?.some((a) => a === ":(exclude)secret.json")).toBe(true);
			// Specifically does NOT prepend `:(glob)`.
			expect(captured[0]?.some((a) => a === ":(glob):(exclude)secret.json")).toBe(false);
		});
	});

	describe("run() — error classification branches", () => {
		// `run()` swallows execFile rejections and returns a structured
		// ExecResult. Each branch in the catch block has its own visible
		// behaviour; pin them down via the execFileImpl test seam.

		function makeRun(reject: unknown) {
			const fakeExec = async (_cmd: string, _args: ReadonlyArray<string>, _opts: unknown) => {
				throw reject;
			};
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			// `run` is private; we exercise it through `hasHead` which is the
			// thinnest public wrapper (single `rev-parse` invocation).
			return c.hasHead();
		}

		it("classifies ENOENT (git missing) as exitCode=127 — distinguishes from generic failures", async () => {
			// hasHead returns `result.exitCode === 0`; with our injected
			// rejection it returns false. We only need to verify it doesn't
			// throw — the 127 number itself is consumed by classifyGitError
			// downstream.
			const err = new Error("spawn ENOENT") as Error & { code?: string };
			err.code = "ENOENT";
			await expect(makeRun(err)).resolves.toBe(false);
		});

		it("classifies numeric error code by passing it through verbatim", async () => {
			// `execFile` sets `err.code` to the child's numeric exit code
			// when the process ran but exited non-zero. Hit the
			// `typeof err.code === 'number'` branch.
			const err = new Error("git exit 128") as Error & { code?: number };
			err.code = 128;
			await expect(makeRun(err)).resolves.toBe(false);
		});

		it("falls back to exitCode=1 for non-numeric, non-ENOENT error codes (generic failure)", async () => {
			const err = new Error("EAGAIN-ish") as Error & { code?: string };
			err.code = "EAGAIN"; // not a number, not ENOENT
			await expect(makeRun(err)).resolves.toBe(false);
		});

		it("falls back to exitCode=1 when err.code is missing entirely", async () => {
			// No `code` at all → ternary hits the final `1` branch.
			await expect(makeRun(new Error("vanilla failure"))).resolves.toBe(false);
		});

		it("uses err.message when err.stderr is empty (no useful diagnostic otherwise)", async () => {
			// Hit the `err.stderr || err.message` fallback. We can't observe
			// the stderr field directly through hasHead, so use runExpectOk
			// via `clone` instead — it throws an Error whose message embeds
			// the stderr/message fallback.
			const fakeExec = async () => {
				const err = new Error("git command failed (no stderr printed)") as Error & {
					stdout?: string;
					stderr?: string;
					code?: number;
				};
				err.stdout = "";
				err.stderr = ""; // empty — falls through to message
				err.code = 1;
				throw err;
			};
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			// `clone` calls `runExpectOk`, which throws on non-zero exit.
			await expect(c.clone(bareRepoUrl)).rejects.toThrow(/no stderr printed/);
		});

		it("falls back to '(no output)' in runExpectOk when both stderr and stdout are empty", async () => {
			// Final fallback in the throw message at line 748.
			const fakeExec = async () => {
				const err = new Error("") as Error & {
					stdout?: string;
					stderr?: string;
					code?: number;
				};
				err.stdout = "";
				err.stderr = "";
				err.message = "";
				err.code = 1;
				throw err;
			};
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			await expect(c.clone(bareRepoUrl)).rejects.toThrow(/\(no output\)/);
		});

		it("rewrites stderr for killed-by-timeout failures so the cause is self-explanatory", async () => {
			// `child_process.execFile` kills the child at timeout, throws
			// with `killed: true` and a signal name. The run() wrapper
			// rewrites stderr to "git X timed out after Yms (signal=SIGTERM)…"
			// so downstream classifyGitError + status-bar tooltip don't
			// just show a bare "Command failed".
			const fakeExec = async () => {
				const err = new Error("Command failed: timeout") as Error & {
					killed?: boolean;
					signal?: string;
					code?: number;
					stderr?: string;
				};
				err.killed = true;
				err.signal = "SIGTERM";
				err.code = 1;
				err.stderr = "";
				throw err;
			};
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			// Use a function whose run() is parameterised with timeoutMs.
			// rebaseAbort passes a non-trivial timeout — that triggers the
			// killed+timeoutMs branch in the catch.
			await expect(c.rebaseAbort()).rejects.toThrow(/timed out after/);
		});

		it("substitutes a default 'SIGTERM' when err.signal is missing on a timeout kill", async () => {
			// Same branch as above but with signal === undefined → the
			// `err.signal ?? "SIGTERM"` fallback kicks in. Verifies the
			// message stays well-formed even when execFile didn't populate
			// a signal name.
			const fakeExec = async () => {
				const err = new Error("Command failed: timeout") as Error & {
					killed?: boolean;
					code?: number;
				};
				err.killed = true;
				err.code = 1;
				// signal intentionally omitted
				throw err;
			};
			const c = new GitClient({
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
				execFileImpl: fakeExec as never,
			});
			await expect(c.rebaseAbort()).rejects.toThrow(/signal=SIGTERM/);
		});
	});

	describe("hasHead / refExists / isAncestor / recreateBranchAt — small predicates", () => {
		it("hasHead returns false on a freshly init'd repo with no commits, true once seeded", async () => {
			const client = makeClient();
			await mkdir(memoryBankRoot, { recursive: true });
			await client.initRemote(bareRepoUrl);
			// initRemote creates a branch ref but never commits — the unborn-HEAD
			// case `hasHead` was built to detect.
			expect(await client.hasHead()).toBe(false);

			// Seed a commit and check the true branch.
			await writeFile(join(memoryBankRoot, "x.md"), "x\n");
			execFileSync("git", ["config", "user.email", "t@x"], { cwd: memoryBankRoot });
			execFileSync("git", ["config", "user.name", "T"], { cwd: memoryBankRoot });
			await client.stageAll();
			await client.commit("[jolli-mb] seed", { name: "T", email: "t@x" });
			expect(await client.hasHead()).toBe(true);
		});

		it("refExists distinguishes existing and missing fully-qualified refs", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			// `refs/heads/main` exists post-clone; an invented branch ref does not.
			expect(await client.refExists("refs/heads/main")).toBe(true);
			expect(await client.refExists("refs/heads/no-such-branch")).toBe(false);
		});

		it("listLocalBranches enumerates local branch refs (empty post-init, non-empty post-clone-and-checkout)", async () => {
			const client = makeClient();
			await mkdir(memoryBankRoot, { recursive: true });
			// `initRemote` sets HEAD to symbolic-ref but never creates `refs/heads/<default>`
			// until the first commit. So `listLocalBranches` returns empty —
			// this is exactly the "fresh local" signal bootstrap-merge depends on.
			await client.initRemote(bareRepoUrl);
			expect(await client.listLocalBranches()).toEqual([]);

			// After clone we have `main` locally.
			await rm(memoryBankRoot, { recursive: true, force: true });
			await mkdir(memoryBankRoot, { recursive: true });
			await client.clone(bareRepoUrl);
			const branches = await client.listLocalBranches();
			expect(branches).toContain("main");

			// Make a side branch; both names should now appear.
			execFileSync("git", ["checkout", "-b", "feature/x"], { cwd: memoryBankRoot });
			const branches2 = await client.listLocalBranches();
			expect(branches2).toContain("main");
			expect(branches2).toContain("feature/x");
		});

		it("isAncestor returns true for ancestor relationships and false for divergent ones", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			execFileSync("git", ["config", "user.email", "t@x"], { cwd: memoryBankRoot });
			execFileSync("git", ["config", "user.name", "T"], { cwd: memoryBankRoot });

			const baseSha = await client.currentHead();
			// A commit chained on top of the base — base IS an ancestor of new.
			await writeFile(join(memoryBankRoot, "child.md"), "c\n");
			await client.stageAll();
			const newSha = await client.commit("[jolli-mb] child", { name: "T", email: "t@x" });
			expect(await client.isAncestor(baseSha, newSha)).toBe(true);

			// Branch off the base into a divergent side commit.
			execFileSync("git", ["checkout", baseSha], { cwd: memoryBankRoot });
			await writeFile(join(memoryBankRoot, "sibling.md"), "s\n");
			await client.stageAll();
			const sibSha = await client.commit("[jolli-mb] sibling", { name: "T", email: "t@x" });
			// Siblings: neither is an ancestor of the other.
			expect(await client.isAncestor(newSha, sibSha)).toBe(false);
			// Bad ref → treated as "not ancestor" (the safer refuse path).
			expect(await client.isAncestor("definitely-not-a-ref", "main")).toBe(false);
		});

		it("recreateBranchAt resets a branch to a given source ref", async () => {
			const client = makeClient();
			await client.clone(bareRepoUrl);
			execFileSync("git", ["config", "user.email", "t@x"], { cwd: memoryBankRoot });
			execFileSync("git", ["config", "user.name", "T"], { cwd: memoryBankRoot });
			// Make a side branch one commit ahead.
			execFileSync("git", ["checkout", "-b", "side"], { cwd: memoryBankRoot });
			await writeFile(join(memoryBankRoot, "side-tip.md"), "tip\n");
			await client.stageAll();
			const sideSha = await client.commit("[jolli-mb] side tip", { name: "T", email: "t@x" });

			// Move main to side's tip via recreateBranchAt.
			await client.recreateBranchAt("main", "side");
			expect(await client.currentBranch()).toBe("main");
			const mainSha = gitSync(["rev-parse", "refs/heads/main"], memoryBankRoot);
			expect(mainSha).toBe(sideSha);
		});
	});

	describe("persistNoSymlinksConfig — non-fatal failure path", () => {
		it("logs a warning but does not throw when `git config core.symlinks false` fails", async () => {
			// Pre-condition: a writable repo where `git config` would fail. The
			// cheapest way is to call `initRemote` against a directory that
			// has no `.git` but a broken config — but that's brittle. Easier:
			// use the execFileImpl seam and have the *second* call (the
			// `git config core.symlinks` invocation initRemote triggers at the
			// end) reject. Earlier calls succeed so we reach the persist step.
			const stub = {
				memoryBankRoot,
				credentials: FAKE_CREDS,
				askpass: NOOP_ASKPASS,
			};
			let callIdx = 0;
			const fakeExec = async (
				_cmd: string,
				args: ReadonlyArray<string>,
				_opts: unknown,
			): Promise<{ stdout: string; stderr: string }> => {
				callIdx++;
				// Find the `config core.symlinks false` invocation in args.
				const subcmdIdx = args.indexOf("config");
				if (subcmdIdx >= 0 && args[subcmdIdx + 1] === "core.symlinks") {
					const err = new Error("config write refused") as Error & {
						stderr?: string;
						code?: number;
					};
					err.stderr = "fatal: could not lock config file .git/config";
					err.code = 1;
					throw err;
				}
				return { stdout: "", stderr: "" };
			};
			const c = new GitClient({ ...stub, execFileImpl: fakeExec as never });
			// initRemote's last step calls persistNoSymlinksConfig — the
			// rejected `git config` triggers the warn branch, but the method
			// itself must NOT throw because the in-process `-c` flag still
			// protects every git command.
			await expect(c.initRemote(bareRepoUrl)).resolves.toBeUndefined();
			expect(callIdx).toBeGreaterThan(0);
		});
	});

	describe("push refspec (§P1#2 — HEAD:refs/heads/<branch>)", () => {
		it("pushes the CURRENT HEAD to the default branch even when HEAD is on a side branch name", async () => {
			// Pre-§P1#2 reproduction: `git push origin <branch>` would push
			// the local `<branch>` ref. If HEAD is on `side`, local `main`
			// is stale → push silently reports "Everything up-to-date" while
			// commits accumulate on side. The new `HEAD:refs/heads/<branch>`
			// refspec pushes the current commit chain to remote main.
			const client = makeClient();
			await client.clone(bareRepoUrl);
			execFileSync("git", ["config", "user.email", "t@x"], { cwd: memoryBankRoot });
			execFileSync("git", ["config", "user.name", "T"], { cwd: memoryBankRoot });
			// Branch off main onto `side`, commit something only on side.
			execFileSync("git", ["checkout", "-b", "side"], { cwd: memoryBankRoot });
			await writeFile(join(memoryBankRoot, "side-only.md"), "side\n");
			await client.stageAll();
			const sideSha = await client.commit("[jolli-mb] side commit", { name: "T", email: "t@x" });
			// Local `main` ref is unchanged — pre-fix push would no-op here.
			const localMainBefore = gitSync(["rev-parse", "refs/heads/main"], memoryBankRoot);
			expect(localMainBefore).not.toBe(sideSha);

			const pushed = await client.push();
			expect(pushed.ok).toBe(true);
			// Transmitted=true because the new commit on HEAD really did go
			// across the wire (this is the bug the refspec fix closes).
			if (pushed.ok) expect(pushed.transmitted).toBe(true);

			// Remote main now points at the side commit — the explicit
			// refspec made HEAD the source even though we're on `side`.
			const remoteMain = gitSync(["rev-parse", "refs/heads/main"], bareRepo);
			expect(remoteMain).toBe(sideSha);
		});
	});
});

describe("injectGithubAppUsername", () => {
	it("injects x-access-token@ into a bare github.com https URL", () => {
		expect(injectGithubAppUsername("https://github.com/foo/bar.git")).toBe(
			"https://x-access-token@github.com/foo/bar.git",
		);
	});

	it("leaves URLs that already carry a username untouched", () => {
		expect(injectGithubAppUsername("https://x-access-token@github.com/foo/bar.git")).toBe(
			"https://x-access-token@github.com/foo/bar.git",
		);
		expect(injectGithubAppUsername("https://user:pass@github.com/foo/bar.git")).toBe(
			"https://user:pass@github.com/foo/bar.git",
		);
	});

	it("passes through non-https URLs unchanged (file://, ssh, http)", () => {
		expect(injectGithubAppUsername("file:///tmp/repo.git")).toBe("file:///tmp/repo.git");
		expect(injectGithubAppUsername("git@github.com:foo/bar.git")).toBe("git@github.com:foo/bar.git");
	});
});

// Quiet unused-import warning when only some tests run.
void gitSync;
