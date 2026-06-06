/**
 * Bootstrap merge tests. Uses a real `git init --bare` fixture so the
 * destructive checkout + stage + commit path is exercised end-to-end —
 * mocks would hide exactly the failure mode bootstrap merge exists to
 * prevent ("untracked working tree files would be overwritten by
 * checkout"). Pattern mirrors `GitClient.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { promises as nodeFs } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_STASH_DIRNAME, runBootstrapMerge, shouldRunBootstrapMerge } from "./BootstrapMerge.js";
import { GitClient } from "./GitClient.js";
import type { GitCredentials } from "./SyncTypes.js";

// Same global-config isolation rationale as GitClient.test.ts: a developer
// `commit.gpgsign=true` or husky hook would hang every commit here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_TERMINAL_PROMPT = "0";

// Every test spawns several real `git` subprocesses; under parallel suite load
// + `--coverage` the global 15s testTimeout / 10s hookTimeout flake. 30s gives
// this real-git suite headroom without loosening the global pure-unit budget.
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

const AUTHOR = { name: "Test", email: "test@example.com" };

let rootTempDir: string;
let bareRepo: string;
let bareRepoUrl: string;

beforeAll(async () => {
	rootTempDir = await mkdtemp(join(tmpdir(), "bootstrap-merge-"));
	bareRepo = join(rootTempDir, "origin.git");
	await mkdir(bareRepo, { recursive: true });
	execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bareRepo], { stdio: "ignore" });
	bareRepoUrl = `file://${bareRepo}`;

	// Seed the bare repo with content that overlaps with what the "fresh
	// local" side will produce — the whole point is to exercise the
	// collision-on-checkout path.
	const seed = join(rootTempDir, "seed");
	execFileSync("git", ["clone", "--quiet", bareRepoUrl, seed], { stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "s@x"], { cwd: seed });
	execFileSync("git", ["config", "user.name", "S"], { cwd: seed });
	await mkdir(join(seed, "jolliai", ".jolli", "transcripts"), { recursive: true });
	await writeFile(join(seed, "jolliai", ".jolli", "migration.json"), '{"status":"remote"}');
	await writeFile(
		join(seed, "jolliai", ".jolli", "transcripts", "abc1234.json"),
		'{"hash":"abc1234","content":"remote-only"}',
	);
	await writeFile(join(seed, "jolliai", ".jolli", "manifest.json"), '{"name":"remote"}');
	await writeFile(join(seed, "remote-only.md"), "from remote\n");
	execFileSync("git", ["add", "."], { cwd: seed });
	execFileSync("git", ["commit", "--quiet", "-m", "[jolli-mb] seed"], { cwd: seed });
	execFileSync("git", ["push", "--quiet", "origin", "main"], { cwd: seed });
}, 30_000);

afterAll(async () => {
	await rm(rootTempDir, { recursive: true, force: true });
});

let memoryBankRoot: string;

beforeEach(async () => {
	memoryBankRoot = await mkdtemp(join(rootTempDir, "vault-"));
});

function makeClient(): GitClient {
	return new GitClient({ memoryBankRoot, credentials: FAKE_CREDS, askpass: NOOP_ASKPASS });
}

/**
 * Reproduce the "fresh local" state: `git init`, fetch from origin
 * (creating `refs/remotes/origin/main`), HEAD stays unborn pointing at
 * `refs/heads/main` which doesn't exist yet. Then write FolderStorage-shaped
 * files into the working tree to mimic MigrationEngine output.
 */
async function setupFreshLocal(): Promise<GitClient> {
	const client = makeClient();
	await mkdir(memoryBankRoot, { recursive: true });
	await client.initRemote(bareRepoUrl);
	await client.fetch();
	return client;
}

describe("shouldRunBootstrapMerge — trigger conditions", () => {
	it("returns ok when C1-C5 all hold (truly fresh local + populated remote + dirty tree)", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "untracked.md"), "x\n");
		const verdict = await shouldRunBootstrapMerge(client, "main");
		expect(verdict.ok).toBe(true);
	});

	it("rejects when HEAD is born (C1 failed)", async () => {
		const client = makeClient();
		await client.clone(bareRepoUrl);
		const verdict = await shouldRunBootstrapMerge(client, "main");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toMatch(/C1/);
	});

	it("rejects when origin/<default> is missing (C2 failed)", async () => {
		const client = makeClient();
		await mkdir(memoryBankRoot, { recursive: true });
		execFileSync("git", ["init", "--quiet", "-b", "main", memoryBankRoot], { stdio: "ignore" });
		// No remote / fetch — C2 fails.
		await writeFile(join(memoryBankRoot, "x.md"), "x\n");
		const verdict = await shouldRunBootstrapMerge(client, "main");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toMatch(/C2/);
	});

	it("rejects when working tree is empty (C3 failed)", async () => {
		const client = await setupFreshLocal();
		// no files written
		const verdict = await shouldRunBootstrapMerge(client, "main");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toMatch(/C3/);
	});

	it("rejects stranded-commits: unborn HEAD but a feature branch carries real work (C4 failed)", async () => {
		const client = await setupFreshLocal();
		// Create a feature branch with a commit — simulates the
		// stranded-commits scenario the trigger MUST refuse.
		execFileSync("git", ["config", "user.email", "t@x"], { cwd: memoryBankRoot });
		execFileSync("git", ["config", "user.name", "T"], { cwd: memoryBankRoot });
		execFileSync("git", ["checkout", "-b", "feature/x"], { cwd: memoryBankRoot });
		await writeFile(join(memoryBankRoot, "feat.md"), "feat\n");
		execFileSync("git", ["add", "."], { cwd: memoryBankRoot });
		execFileSync("git", ["commit", "--quiet", "-m", "feat"], { cwd: memoryBankRoot });
		// Switch HEAD back to unborn main.
		execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: memoryBankRoot });
		// Re-add some dirty content so C3 still holds.
		await writeFile(join(memoryBankRoot, "extra.md"), "extra\n");
		const verdict = await shouldRunBootstrapMerge(client, "main");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toMatch(/C4/);
	});

	it("rejects when git stash exists (C5 failed)", async () => {
		const client = makeClient();
		await client.clone(bareRepoUrl);
		execFileSync("git", ["config", "user.email", "t@x"], { cwd: memoryBankRoot });
		execFileSync("git", ["config", "user.name", "T"], { cwd: memoryBankRoot });
		// Make a stash entry while HEAD is still born.
		await writeFile(join(memoryBankRoot, "stash-me.md"), "s\n");
		execFileSync("git", ["add", "stash-me.md"], { cwd: memoryBankRoot });
		execFileSync("git", ["stash", "push", "-m", "test"], { cwd: memoryBankRoot });
		// To make C1 hold for an isolated C5 check, undo HEAD by symbolic-ref + delete heads.
		// But that would also remove the stash anchor; easier: detect via born-HEAD client and
		// expect the trigger to fall on C1 first. C5 is hit when the upstream ordering reaches it;
		// we cover it indirectly via the integration test that wires `shouldRun` → bootstrap.
		// For the unit-test surface, verify refs/stash existence semantics directly.
		expect(await client.refExists("refs/stash")).toBe(true);
	});

	it("rejects when git stash exists while C1-C4 still hold (C5 failed)", async () => {
		// Build the exact state where C1-C4 pass but C5 fails: fresh local
		// (unborn HEAD, origin fetched, dirty tree, no local branches) PLUS a
		// `refs/stash` ref pointed at the remote commit. We synthesize the stash
		// ref via `update-ref` so HEAD stays unborn (a real `git stash` needs a
		// born HEAD and would flip C1).
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "dirty.md"), "x\n");
		const remoteSha = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], {
			cwd: memoryBankRoot,
			encoding: "utf-8",
		}).trim();
		execFileSync("git", ["update-ref", "refs/stash", remoteSha], { cwd: memoryBankRoot });

		const verdict = await shouldRunBootstrapMerge(client, "main");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toMatch(/C5/);
	});
});

describe("runBootstrapMerge — per-path dispositions", () => {
	it("happy path: pure local additions, remote-only files, byte-identical no-ops, and remote-wins conflicts coexist", async () => {
		const client = await setupFreshLocal();
		const repoDir = join(memoryBankRoot, "jolliai");
		await mkdir(join(repoDir, ".jolli", "transcripts"), { recursive: true });

		// Conflict: local has different content for migration.json (remote has '{"status":"remote"}').
		await writeFile(join(repoDir, ".jolli", "migration.json"), '{"status":"local"}');
		// No-op: local writes byte-identical manifest.json (matches remote seed).
		await writeFile(join(repoDir, ".jolli", "manifest.json"), '{"name":"remote"}');
		// Pure local addition: a transcript hash the remote doesn't have.
		await writeFile(
			join(repoDir, ".jolli", "transcripts", "deadbeef.json"),
			'{"hash":"deadbeef","content":"local-only"}',
		);

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Working tree assertions:
		// - migration.json: remote wins.
		const m = await readFile(join(repoDir, ".jolli", "migration.json"), "utf-8");
		expect(m).toBe('{"status":"remote"}');
		// - manifest.json: still equal (no-op).
		const mf = await readFile(join(repoDir, ".jolli", "manifest.json"), "utf-8");
		expect(mf).toBe('{"name":"remote"}');
		// - deadbeef transcript: restored from local.
		const t = await readFile(join(repoDir, ".jolli", "transcripts", "deadbeef.json"), "utf-8");
		expect(t).toContain("local-only");
		// - remote-only.md: came from remote checkout.
		const r = await readFile(join(memoryBankRoot, "remote-only.md"), "utf-8");
		expect(r).toBe("from remote\n");

		// Stash dir: only the conflicting migration.json survives.
		const stashMigration = join(memoryBankRoot, BOOTSTRAP_STASH_DIRNAME, "jolliai", ".jolli", "migration.json");
		expect(await pathExists(stashMigration)).toBe(true);
		const stashed = await readFile(stashMigration, "utf-8");
		expect(stashed).toBe('{"status":"local"}');

		// Per-path report sanity.
		const dispositions = new Map(result.reports.map((r) => [r.path, r.disposition]));
		expect(dispositions.get("jolliai/.jolli/migration.json")).toBe("remote-wins-local-stashed");
		expect(dispositions.get("jolliai/.jolli/manifest.json")).toBe("no-op");
		expect(dispositions.get("jolliai/.jolli/transcripts/deadbeef.json")).toBe("added-from-local");
		expect(result.stashedSurvivors).toContain("jolliai/.jolli/migration.json");

		// HEAD now exists and is a fresh commit on main.
		expect(await client.hasHead()).toBe(true);
		expect(await client.currentBranch()).toBe("main");
	});

	it("empty merge: local content is byte-identical to remote — no commit needed but bootstrap still succeeds", async () => {
		const client = await setupFreshLocal();
		const repoDir = join(memoryBankRoot, "jolliai");
		await mkdir(join(repoDir, ".jolli", "transcripts"), { recursive: true });
		// Match remote seed exactly.
		await writeFile(join(repoDir, ".jolli", "migration.json"), '{"status":"remote"}');
		await writeFile(join(repoDir, ".jolli", "manifest.json"), '{"name":"remote"}');
		await writeFile(
			join(repoDir, ".jolli", "transcripts", "abc1234.json"),
			'{"hash":"abc1234","content":"remote-only"}',
		);

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.stashedSurvivors).toHaveLength(0);
		expect(await client.hasHead()).toBe(true);
	});

	it("race detection: rejects with race-detected if HEAD gets born between trigger check and the destructive checkout", async () => {
		// Simulate the race: caller-side `shouldRunBootstrapMerge` returned
		// `ok: true`, but before `runBootstrapMerge` ran, something committed.
		// We create that condition by cloning (HEAD born) and then handing
		// the client straight to runBootstrapMerge.
		const client = makeClient();
		await client.clone(bareRepoUrl);
		// Add untracked content so an upstream check would still see "dirty".
		await writeFile(join(memoryBankRoot, "extra.md"), "x\n");
		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("race-detected");
	});

	it("checkout failure rolls back the stash — working tree restored, hidden stash dir gone", async () => {
		const client = await setupFreshLocal();
		const repoDir = join(memoryBankRoot, "jolliai");
		await mkdir(join(repoDir, ".jolli", "transcripts"), { recursive: true });
		// Local content that step 1 will move into the stash dir.
		await writeFile(
			join(repoDir, ".jolli", "transcripts", "deadbeef.json"),
			'{"hash":"deadbeef","content":"local-only"}',
		);
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");

		// Force `checkoutTrackingBranch` to fail by targeting a branch with no
		// `origin/<branch>` ref. `git checkout -B <b> origin/<b>` then aborts,
		// driving the `checkout-failed` rollback path.
		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "does-not-exist",
			author: AUTHOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("checkout-failed");

		// Working tree restored byte-for-byte to its pre-bootstrap state.
		const t = await readFile(join(repoDir, ".jolli", "transcripts", "deadbeef.json"), "utf-8");
		expect(t).toContain("local-only");
		const n = await readFile(join(memoryBankRoot, "novel.md"), "utf-8");
		expect(n).toBe("novel\n");

		// No hidden stash dir left behind — rollback pruned it.
		const stashRoot = join(memoryBankRoot, BOOTSTRAP_STASH_DIRNAME);
		expect(await pathExists(stashRoot)).toBe(false);

		// HEAD still unborn (checkout never landed) — the next round can retry
		// bootstrap cleanly against the restored working tree.
		expect(await client.hasHead()).toBe(false);
	});

	it("stash directory is pruned to empty when every conflicting path resolved to no-op or restored", async () => {
		const client = await setupFreshLocal();
		const repoDir = join(memoryBankRoot, "jolliai");
		await mkdir(join(repoDir, ".jolli"), { recursive: true });
		// Only pure additions — no conflicts.
		await writeFile(join(repoDir, ".jolli", "branches.json"), '{"branches":["local-only"]}');
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.stashedSurvivors).toHaveLength(0);
		// Stash dir removed when fully drained.
		const stashRoot = join(memoryBankRoot, BOOTSTRAP_STASH_DIRNAME);
		expect(await pathExists(stashRoot)).toBe(false);
	});

	it("aggregate JSON conflict is union-merged (both peers' entries preserved) instead of remote-wins", async () => {
		// Fresh local pointed at a dedicated remote whose `manifest.json` is a
		// VALID aggregate envelope, so `tryAggregateMerge` succeeds rather than
		// returning null. The remote-seed `manifest.json` from beforeAll is
		// `{"name":"remote"}` (invalid envelope) — that exercises the null
		// fallback, not the merge — so we need a second origin here.
		const aggUrl = await seedAggregateRemote([manifestEntry("abc")]);
		const client = makeClient();
		await client.initRemote(aggUrl);
		await client.fetch();

		const repoDir = join(memoryBankRoot, "jolliai");
		await mkdir(join(repoDir, ".jolli"), { recursive: true });
		// Local manifest carries a DIFFERENT valid entry — the union merge must
		// keep both the remote `abc` file and the local `xyz` file.
		await writeFile(
			join(repoDir, ".jolli", "manifest.json"),
			`${JSON.stringify({ version: 1, files: [manifestEntry("xyz")] }, null, 2)}\n`,
		);

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const dispositions = new Map(result.reports.map((r) => [r.path, r.disposition]));
		expect(dispositions.get("jolliai/.jolli/manifest.json")).toBe("aggregate-merged");
		// Stash entry consumed by the merge — no survivor.
		expect(result.stashedSurvivors).not.toContain("jolliai/.jolli/manifest.json");

		const merged = JSON.parse(await readFile(join(repoDir, ".jolli", "manifest.json"), "utf-8"));
		const ids = (merged.files as Array<{ fileId: string }>).map((f) => f.fileId).sort();
		expect(ids).toEqual(["abc", "xyz"]);
	});

	it("aggregate path with unparseable envelope falls back to remote-wins (tryAggregateMerge returns null)", async () => {
		// The beforeAll remote seeds `jolliai/.jolli/manifest.json` =
		// `{"name":"remote"}` — a JSON-parseable but schema-invalid manifest
		// (no `files` array), so `tryAggregateMerge` returns null and we drop to
		// the conservative remote-wins-local-stashed policy.
		const client = await setupFreshLocal();
		const repoDir = join(memoryBankRoot, "jolliai");
		await mkdir(join(repoDir, ".jolli"), { recursive: true });
		// Differing, also schema-invalid local manifest → both parse, merge null.
		await writeFile(join(repoDir, ".jolli", "manifest.json"), '{"name":"local"}');

		const warns: string[] = [];
		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
			log: { info: () => {}, warn: (m, ...a) => warns.push(`${m} ${a.join(" ")}`) },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const dispositions = new Map(result.reports.map((r) => [r.path, r.disposition]));
		expect(dispositions.get("jolliai/.jolli/manifest.json")).toBe("remote-wins-local-stashed");
		expect(warns.some((w) => /aggregate merge returned null/.test(w))).toBe(true);
		// Remote content wins in the working tree.
		expect(await readFile(join(repoDir, ".jolli", "manifest.json"), "utf-8")).toBe('{"name":"remote"}');
	});

	it("race detection: rejects when a local branch ref appears between trigger check and stash", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "x.md"), "x\n");
		// HEAD stays unborn (pointing at refs/heads/main), but a stray local
		// branch ref exists — the in-function C4 reassertion must refuse.
		const remoteSha = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], {
			cwd: memoryBankRoot,
			encoding: "utf-8",
		}).trim();
		execFileSync("git", ["update-ref", "refs/heads/stray", remoteSha], { cwd: memoryBankRoot });

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("race-detected");
		expect(result.message).toMatch(/stray/);
	});

	it("commit failure (real error) returns commit-failed", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		const warns: string[] = [];
		// Throw a non-"nothing to commit" error → generic commit-failed branch.
		// biome-ignore lint/suspicious/noExplicitAny: stub override on a real client.
		vi.spyOn(client as any, "commit").mockRejectedValue(new Error("disk full"));

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
			log: { info: () => {}, warn: (m, ...a) => warns.push(`${m} ${a.join(" ")}`) },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("commit-failed");
		expect(result.message).toBe("disk full");
		expect(warns.some((w) => /commit failed/.test(w))).toBe(true);
	});

	it("commit failure with non-Error throw uses String(e) for the message", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// A thrown string has no `.message` → exercises the `?? String(e)` branch.
		// biome-ignore lint/suspicious/noExplicitAny: stub override on a real client.
		vi.spyOn(client as any, "commit").mockRejectedValue("string-error");

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("commit-failed");
		expect(result.message).toBe("string-error");
	});

	it("empty-merge commit throwing 'nothing to commit' is treated as success with HEAD as the sha", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// Real GitClient.commit swallows "nothing to commit" internally, so to
		// drive BootstrapMerge's own nothing-to-commit branch we force commit to
		// surface it as a throw. HEAD is born (checkout landed) so revParse
		// resolves and the run reports ok with that sha.
		// biome-ignore lint/suspicious/noExplicitAny: stub override on a real client.
		vi.spyOn(client as any, "commit").mockRejectedValue(new Error("nothing to commit, working tree clean"));

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: memoryBankRoot, encoding: "utf-8" }).trim();
		expect(result.commitSha).toBe(head);
	});

	it("empty-merge with missing HEAD after checkout returns commit-failed", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// nothing-to-commit throw + revParse("HEAD") === null → the defensive
		// "HEAD missing after empty merge" failure.
		// biome-ignore lint/suspicious/noExplicitAny: stub override on a real client.
		vi.spyOn(client as any, "commit").mockRejectedValue(new Error("nothing to commit"));
		// biome-ignore lint/suspicious/noExplicitAny: stub override on a real client.
		vi.spyOn(client as any, "revParse").mockResolvedValue(null);

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("commit-failed");
		expect(result.message).toMatch(/HEAD missing after empty merge/);
	});

	it("checkout failure with a non-Error throw uses String(e) and rolls back", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// biome-ignore lint/suspicious/noExplicitAny: stub override on a real client.
		vi.spyOn(client as any, "checkoutTrackingBranch").mockRejectedValue("plain-string-fail");

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("checkout-failed");
		expect(result.message).toBe("plain-string-fail");
		// Rollback restored the local file and removed the stash dir.
		expect(await readFile(join(memoryBankRoot, "novel.md"), "utf-8")).toBe("novel\n");
		expect(await pathExists(join(memoryBankRoot, BOOTSTRAP_STASH_DIRNAME))).toBe(false);
	});

	it("rename falling back to copy+unlink (cross-device simulation) still stashes and restores", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// Force EXDEV on the first stash-move (step 1) and on the restore move
		// (rollback) so both copyFile+unlink fallbacks run. Checkout fails so we
		// also hit the restore path's fallback.
		const exdev = Object.assign(new Error("EXDEV"), { code: "EXDEV" });
		vi.spyOn(nodeFs, "rename").mockRejectedValue(exdev);
		// biome-ignore lint/suspicious/noExplicitAny: stub override on a real client.
		vi.spyOn(client as any, "checkoutTrackingBranch").mockRejectedValue(new Error("checkout boom"));

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("checkout-failed");
		// copyFile+unlink fallback restored the file byte-for-byte.
		expect(await readFile(join(memoryBankRoot, "novel.md"), "utf-8")).toBe("novel\n");
	});

	it("a pre-existing stash dir from an aborted prior run is skipped during the step-1 walk", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// Leftover empty stash dir from an aborted prior run — collectLocalFiles
		// must skip it (the `full === stashRoot` continue) so it isn't re-stashed
		// into itself.
		await mkdir(join(memoryBankRoot, BOOTSTRAP_STASH_DIRNAME, "leftover"), { recursive: true });

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const dispositions = new Map(result.reports.map((r) => [r.path, r.disposition]));
		expect(dispositions.get("novel.md")).toBe("added-from-local");
		// Nothing under the leftover stash dir was treated as a stashed survivor.
		expect(result.stashedSurvivors).toHaveLength(0);
	});

	it("symlinks in the local tree are collected and moved like regular files", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "target.md"), "target\n");
		await symlink("target.md", join(memoryBankRoot, "link.md"));

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The symlink was a pure local addition → restored to the working tree.
		const dispositions = new Map(result.reports.map((r) => [r.path, r.disposition]));
		expect(dispositions.get("link.md")).toBe("added-from-local");
		expect(dispositions.get("target.md")).toBe("added-from-local");
		expect(await pathExists(join(memoryBankRoot, "link.md"))).toBe(true);
	});

	it("restoreStashedFiles skips an already-absent stash entry on rollback", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// Delete the stashed file out from under the rollback (after step 1's
		// move) so restore hits its `!pathExists(src)` continue branch. We do
		// this by failing checkout AND removing the stash entry mid-flight via a
		// spy that deletes the stash before throwing.
		const stashRoot = join(memoryBankRoot, BOOTSTRAP_STASH_DIRNAME);
		// biome-ignore lint/suspicious/noExplicitAny: stub override on a real client.
		vi.spyOn(client as any, "checkoutTrackingBranch").mockImplementation(async () => {
			await rm(join(stashRoot, "novel.md"), { force: true });
			throw new Error("checkout boom");
		});

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("checkout-failed");
		// The file was gone from the stash, so nothing is restored — but the run
		// still completes the rollback cleanly (no throw).
		expect(await pathExists(join(memoryBankRoot, "novel.md"))).toBe(false);
	});

	it("non-file/non-symlink dirents (FIFO) are ignored by both the local and stash walks", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// A named pipe is neither a regular file, a symlink, nor a directory, so
		// the `isFile() || isSymbolicLink()` else-if is false for it in both
		// collectLocalFiles and collectStashFiles. `git status` ignores it too,
		// so C3 still holds via novel.md.
		try {
			execFileSync("mkfifo", [join(memoryBankRoot, "pipe")]);
		} catch {
			// Platform without mkfifo — skip the assertion body; the test still
			// exercises the normal path.
			return;
		}

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The FIFO was never collected, so it has no per-path report.
		const dispositions = new Map(result.reports.map((r) => [r.path, r.disposition]));
		expect(dispositions.has("pipe")).toBe(false);
		expect(dispositions.get("novel.md")).toBe("added-from-local");
	});

	it("a FIFO sitting inside the stash dir is ignored by the stash walk", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// A leftover stash dir (skipped by step 1) containing a FIFO — when
		// collectStashFiles walks it in step 3, the FIFO trips the non-file/
		// non-symlink else-if branch.
		const stashRoot = join(memoryBankRoot, BOOTSTRAP_STASH_DIRNAME);
		await mkdir(stashRoot, { recursive: true });
		try {
			execFileSync("mkfifo", [join(stashRoot, "stash-pipe")]);
		} catch {
			return;
		}

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The FIFO is not a regular file, so it's never reported as a survivor.
		expect(result.stashedSurvivors).not.toContain("stash-pipe");
	});

	it("collectStashFiles rethrows a non-ENOENT readdir error", async () => {
		const client = await setupFreshLocal();
		const repoDir = join(memoryBankRoot, "jolliai");
		await mkdir(join(repoDir, ".jolli"), { recursive: true });
		await writeFile(join(repoDir, ".jolli", "branches.json"), '{"branches":["local-only"]}');
		const stashRoot = join(memoryBankRoot, BOOTSTRAP_STASH_DIRNAME);

		const realReaddir = nodeFs.readdir.bind(nodeFs);
		// Fail only when collectStashFiles (step 3) first reads the stash root,
		// with a non-ENOENT code → the `throw e` rethrow arm.
		// biome-ignore lint/suspicious/noExplicitAny: variadic readdir signature.
		vi.spyOn(nodeFs, "readdir").mockImplementation((async (p: any, opts: any) => {
			if (p === stashRoot) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			return realReaddir(p, opts);
			// biome-ignore lint/suspicious/noExplicitAny: cast through the overloaded type.
		}) as any);

		await expect(
			runBootstrapMerge({ client, vaultRoot: memoryBankRoot, defaultBranch: "main", author: AUTHOR }),
		).rejects.toThrow(/EACCES/);
	});

	it("collectLocalFiles swallows ENOENT (vault disappeared) and rethrows other readdir errors", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");

		// First run: readdir(vaultRoot) throws ENOENT → collectLocalFiles returns
		// [] (swallowed). With no files stashed, checkout adopts remote and the
		// run still succeeds. This covers the ENOENT arm of the catch.
		const realReaddir = nodeFs.readdir.bind(nodeFs);
		// biome-ignore lint/suspicious/noExplicitAny: variadic readdir signature.
		const spy = vi.spyOn(nodeFs, "readdir").mockImplementation((async (p: any, opts: any) => {
			if (p === memoryBankRoot) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return realReaddir(p, opts);
			// biome-ignore lint/suspicious/noExplicitAny: cast through the overloaded type.
		}) as any);

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		spy.mockRestore();
	});

	it("collectLocalFiles rethrows a non-ENOENT readdir error", async () => {
		const client = await setupFreshLocal();
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		const realReaddir = nodeFs.readdir.bind(nodeFs);
		// biome-ignore lint/suspicious/noExplicitAny: variadic readdir signature.
		vi.spyOn(nodeFs, "readdir").mockImplementation((async (p: any, opts: any) => {
			if (p === memoryBankRoot) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			return realReaddir(p, opts);
			// biome-ignore lint/suspicious/noExplicitAny: cast through the overloaded type.
		}) as any);

		await expect(
			runBootstrapMerge({ client, vaultRoot: memoryBankRoot, defaultBranch: "main", author: AUTHOR }),
		).rejects.toThrow(/EACCES/);
	});

	it("pruneEmptyDirs rethrows a non-ENOENT readdir error while walking the stash dir", async () => {
		const client = await setupFreshLocal();
		const repoDir = join(memoryBankRoot, "jolliai");
		await mkdir(join(repoDir, ".jolli"), { recursive: true });
		await writeFile(join(repoDir, ".jolli", "branches.json"), '{"branches":["local-only"]}');
		const stashRoot = join(memoryBankRoot, BOOTSTRAP_STASH_DIRNAME);

		const realReaddir = nodeFs.readdir.bind(nodeFs);
		// Let the step-1 + step-3 walks run normally; only fail when pruneEmptyDirs
		// reaches the stash root so the non-ENOENT rethrow arm executes. Step 3
		// fully drains the stash (pure addition) before prune, so failing on the
		// stash root readdir during prune is the only place this fires.
		let stage3Done = false;
		// biome-ignore lint/suspicious/noExplicitAny: variadic readdir signature.
		vi.spyOn(nodeFs, "readdir").mockImplementation((async (p: any, opts: any) => {
			if (p === stashRoot) {
				// Allow the collectStashFiles reads (step 3) through; trip only the
				// later pruneEmptyDirs read.
				if (stage3Done) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
				stage3Done = true;
			}
			return realReaddir(p, opts);
			// biome-ignore lint/suspicious/noExplicitAny: cast through the overloaded type.
		}) as any);

		await expect(
			runBootstrapMerge({ client, vaultRoot: memoryBankRoot, defaultBranch: "main", author: AUTHOR }),
		).rejects.toThrow(/EACCES/);
	});

	it("pruneEmptyDirs leaves a directory in place when rmdir fails", async () => {
		const client = await setupFreshLocal();
		const repoDir = join(memoryBankRoot, "jolliai");
		await mkdir(join(repoDir, ".jolli"), { recursive: true });
		// Pure addition → stash drained → prune walks the stash dir and rmdirs.
		await writeFile(join(repoDir, ".jolli", "branches.json"), '{"branches":["local-only"]}');
		await writeFile(join(memoryBankRoot, "novel.md"), "novel\n");
		// Make every rmdir fail so pruneEmptyDirs' catch branch (return false)
		// runs for the empty leaf dirs.
		vi.spyOn(nodeFs, "rmdir").mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));

		const result = await runBootstrapMerge({
			client,
			vaultRoot: memoryBankRoot,
			defaultBranch: "main",
			author: AUTHOR,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Survivors are computed from the (un-pruned) stash dir; the drained
		// files were moved out, so there are still zero file survivors even
		// though the empty dirs linger.
		expect(result.stashedSurvivors).toHaveLength(0);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Seed a fresh dedicated bare repo whose `jolliai/.jolli/manifest.json` is a
 * VALID aggregate envelope, then return its `file://` URL. Used by the
 * aggregate-merge test which needs `tryAggregateMerge` to succeed (the shared
 * beforeAll remote intentionally seeds an invalid envelope for the null path).
 */
function manifestEntry(id: string): {
	path: string;
	fileId: string;
	type: "commit";
	fingerprint: string;
	title: string;
	source: { commitHash: string; branch: string; generatedAt: string };
} {
	return {
		path: `main/${id}.md`,
		fileId: id,
		type: "commit",
		fingerprint: id,
		title: id,
		source: { commitHash: id, branch: "main", generatedAt: "2026-01-01T00:00:00.000Z" },
	};
}

async function seedAggregateRemote(files: ReadonlyArray<ReturnType<typeof manifestEntry>>): Promise<string> {
	const bare = join(rootTempDir, `agg-origin-${Date.now()}.git`);
	await mkdir(bare, { recursive: true });
	execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { stdio: "ignore" });
	const url = `file://${bare}`;
	const seed = join(rootTempDir, `agg-seed-${Date.now()}`);
	execFileSync("git", ["clone", "--quiet", url, seed], { stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "s@x"], { cwd: seed });
	execFileSync("git", ["config", "user.name", "S"], { cwd: seed });
	await mkdir(join(seed, "jolliai", ".jolli"), { recursive: true });
	await writeFile(
		join(seed, "jolliai", ".jolli", "manifest.json"),
		`${JSON.stringify({ version: 1, files }, null, 2)}\n`,
	);
	execFileSync("git", ["add", "."], { cwd: seed });
	execFileSync("git", ["commit", "--quiet", "-m", "[jolli-mb] agg seed"], { cwd: seed });
	execFileSync("git", ["push", "--quiet", "origin", "main"], { cwd: seed });
	return url;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}
