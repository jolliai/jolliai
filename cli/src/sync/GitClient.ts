/**
 * Thin wrapper around the system `git` binary for vault working-tree
 * operations. All commands flow through one helper that injects the
 * askpass env (see `GitAskpass.ts`) so the Installation Token never leaks
 * into argv.
 *
 * This is a separate working tree from the source repo and from the orphan
 * branch storage path in `GitOps.ts`. The same `git` binary is used; only
 * the cwd and env differ.
 *
 * Methods:
 *
 *   - **clone(gitUrl)** — initial `git clone <url> <memoryBankRoot>` for the
 *     first-bind path.
 *   - **fetch()** — `git fetch origin` to refresh refs without touching the
 *     working tree.
 *   - **pullRebase()** — `git pull --rebase origin <branch>`. Returns the
 *     list of conflicted paths when rebase pauses, so the caller can drive
 *     the conflict pyramid.
 *   - **stageAll() / commit(msg) / push()** — usual flow. `push()` reports
 *     non-FF distinctly so the engine can pull-rebase + retry.
 *   - **readIndexStage(path, stage)** — `git show :<N>:<path>` for the
 *     base/ours/theirs blobs during conflict resolution.
 *   - **checkoutOurs(path) / checkoutTheirs(path)** — Tier 3 binary pick.
 *   - **rebaseContinue() / rebaseAbort()** — after Tier 2/3 resolves.
 *   - **hasUnmergedPaths()** — `git ls-files -u` returning grouped stages.
 *   - **currentHead()** — `git rev-parse HEAD`.
 *   - **checkGitInstalled()** — `git --version` probe for first-run hint.
 */

import { createLogger } from "../Logger.js";
import { execFileAsyncHidden } from "../util/Subprocess.js";
import { type AskpassHandle, prepareAskpass } from "./GitAskpass.js";
import type { GitCredentials } from "./SyncTypes.js";

const log = createLogger("Sync:Git");
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Hard timeout for local rebase plumbing (plan §P1#3). 30s is generous —
 * `rebase --continue` / `--abort` are pure index/refs operations with no
 * network I/O, and even on a slow disk they complete in milliseconds. The
 * deadline exists to bound the failure mode where a misconfigured git
 * tries to open `$EDITOR` despite our suppressors, so we'd rather fail
 * loud than deadlock the sync engine forever.
 *
 * Clone / fetch / pull / push do NOT pass a timeout — they can
 * legitimately take minutes on a slow connection, and step-level retry
 * already bounds their wall-clock impact.
 */
const REBASE_TIMEOUT_MS = 30_000;

/**
 * Env block that defangs every git editor entry point (plan §P1#3). Set
 * on every command that can land in a "git would normally pop the
 * editor" path:
 *
 *   - `GIT_EDITOR` — invoked by `commit`/`rebase --continue` when git
 *     wants the user to confirm a reused commit message. `true` is the
 *     POSIX shell built-in that returns 0 immediately, so git records
 *     the unchanged message.
 *   - `GIT_SEQUENCE_EDITOR` — invoked by `rebase -i` to edit the todo
 *     list. We don't run interactive rebase today, but suppressing it is
 *     a one-line insurance against a future caller forgetting.
 *
 * `process.env.EDITOR` is what makes this matter — the spawned child
 * inherits the user's shell editor (`vi`, `nano`, …) via the askpass env
 * spread, and without a TTY the editor blocks forever waiting for input.
 *
 * Belt + suspenders: callers also pass `-c core.editor=true` on the git
 * command line so a git config that explicitly sets `core.editor` (which
 * outranks `$GIT_EDITOR`) still falls through to the no-op.
 */
const NO_EDITOR_ENV = Object.freeze({
	GIT_EDITOR: "true",
	GIT_SEQUENCE_EDITOR: "true",
}) as NodeJS.ProcessEnv;

/**
 * Always-injected `-c core.symlinks=false` (plan §P2 revised — incoming
 * symlink defence). Without this, a malicious peer can push a mode-120000
 * blob whose payload is e.g. `/home/<user>/.aws/credentials`; the next
 * `git clone` / `pull` / `checkout` materialises a real symlink in the
 * vault working tree, and the host process (`FolderStorage`, the user's
 * file indexer, the editor's auto-reload) follows it and reads/writes
 * the link's target on disk. `core.symlinks=false` makes git check out
 * 120000 blobs as **regular files containing the link target as text**,
 * so nothing on disk is ever a real symlink. The on-write half of the
 * defence is `SymlinkSweep.ts`, which scrubs symlinks the OS or a
 * concurrent process may have created outside git's control.
 *
 * Injected at the central `run()` so it covers every subcommand —
 * `clone`, `fetch`, `pull --rebase`, `rebase --continue`, `checkout`,
 * `add`, `commit`. Per-call `-c` overrides (e.g. `-c core.editor=true`)
 * sit after this in the arg list.
 *
 * `credential.helper=` (empty value clears the inherited list) +
 * `credential.modalprompt=false` together neutralize Git Credential
 * Manager on Windows. Default Git for Windows installs configure GCM
 * at the system scope; without these overrides `git fetch` asks GCM
 * first → GCM pops a modal sign-in dialog → if the user doesn't
 * respond the git child hangs indefinitely, holding the sync round
 * past its budget. `GIT_ASKPASS` (see `GitAskpass.ts`) only gets a
 * shot when no helper resolves credentials, so we have to forcibly
 * empty the helper chain. Belt-and-braces: `GCM_INTERACTIVE=Never`
 * env var is set alongside (see `prepareAskpass`).
 */
const GIT_HARDENING_CONFIG: ReadonlyArray<string> = Object.freeze([
	"-c",
	"core.symlinks=false",
	"-c",
	"credential.helper=",
	"-c",
	"credential.modalprompt=false",
]);

/** Result of a `git pull --rebase`. */
export interface PullResult {
	readonly fastForwarded: boolean;
	readonly conflicted: ReadonlyArray<string>;
}

/**
 * Result of a `git push`. Distinguishes four failure modes the engine
 * can recover from differently:
 *
 *   - `nonFastForward` — remote moved ahead; engine pull-rebases and retries.
 *   - `unauthorized`   — token rejected by GitHub (mid-round expiry, IAM
 *     change on the broker, etc.); engine re-mints (idempotent, max 1× per
 *     round) and retries the failing step.
 *   - `repoMissing`    — GitHub returns 404 / "Repository not found" because
 *     the repo was deleted on GitHub (admin action, user test, etc.) while
 *     the round still held an old `gitUrl`. Same recovery as `unauthorized`:
 *     re-mint triggers backend `ensureGithubRepoExists` to recreate the repo
 *     (idempotent — backend reuses the same `repoFullName`, no duplicate
 *     private repos), then the failing step is retried.
 *   - none of the above — non-recoverable; engine reports offline with a
 *     terminal `lastError`.
 */
export type PushResult =
	| {
			readonly ok: true;
			/**
			 * `true` when the push actually transmitted commits to the remote;
			 * `false` when git reported "Everything up-to-date" (idempotent
			 * no-op). The engine gates `backend.notifyPush` on this so idle
			 * poll ticks don't pelt the backend with redundant SHAs every
			 * 90 minutes — see SyncEngine §0.8.
			 */
			readonly transmitted: boolean;
	  }
	| {
			readonly ok: false;
			readonly nonFastForward: boolean;
			readonly unauthorized: boolean;
			readonly repoMissing: boolean;
			readonly message: string;
	  };

/** Per-path unmerged-stage map returned by `hasUnmergedPaths`. */
export interface UnmergedEntry {
	readonly path: string;
	readonly stages: ReadonlySet<1 | 2 | 3>;
}

/** Test seam — defaults to `execFileAsyncHidden` (windowsHide-injected wrapper). */
export interface GitClientOpts {
	readonly memoryBankRoot: string;
	readonly credentials: GitCredentials;
	readonly askpass?: typeof prepareAskpass;
	readonly execFileImpl?: typeof execFileAsyncHidden;
	readonly maxBufferBytes?: number;
}

/** Internal raw exec result mirroring `GitOps.execGit`. */
interface ExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export class GitClient {
	private readonly memoryBankRoot: string;
	private readonly credentials: GitCredentials;
	private readonly askpass: typeof prepareAskpass;
	private readonly execFileImpl: typeof execFileAsyncHidden;
	private readonly maxBufferBytes: number;
	private cachedAskpass: AskpassHandle | undefined;

	constructor(opts: GitClientOpts) {
		this.memoryBankRoot = opts.memoryBankRoot;
		this.credentials = opts.credentials;
		this.askpass = opts.askpass ?? prepareAskpass;
		this.execFileImpl = opts.execFileImpl ?? execFileAsyncHidden;
		this.maxBufferBytes = opts.maxBufferBytes ?? MAX_BUFFER;
	}

	/** Probes `git --version`. Used at sync engine startup. */
	async checkGitInstalled(): Promise<{ ok: true; version: string } | { ok: false }> {
		try {
			const result = await this.execFileImpl("git", ["--version"], {
				maxBuffer: this.maxBufferBytes,
			});
			return { ok: true, version: result.stdout.trim() };
		} catch {
			return { ok: false };
		}
	}

	/**
	 * `git clone <gitUrl> <memoryBankRoot>` with `x-access-token@` injected as the
	 * URL username so GitHub knows we're authenticating as a GitHub App
	 * Installation Token (the actual token comes via `GIT_ASKPASS`).
	 *
	 * Without an explicit username GitHub prompts for both Username and
	 * Password; our askpass would return the same token for both, and the
	 * server rejects `<token>:<token>` as invalid credentials. Embedding
	 * `x-access-token@` keeps the token out of the URL (and thus out of
	 * `.git/config`) while telling GitHub which auth scheme to use.
	 */
	async clone(gitUrl: string): Promise<void> {
		// Pass the target dir as a positional arg and run with no cwd so git
		// is free to create `memoryBankRoot`. Running with `cwd = memoryBankRoot` would
		// require the directory to exist beforehand — the opposite of what
		// `clone` should do.
		const authUrl = injectGithubAppUsername(gitUrl);
		await this.runExpectOk(["clone", authUrl, this.memoryBankRoot], { cwdOverride: null });
		// Persist `core.symlinks=false` into the freshly-cloned repo so that
		// even out-of-band `git` invocations the user runs in the Memory Bank
		// folder honour it (manual `git pull`, IDE git integrations, etc.).
		// The clone above already ran with `-c core.symlinks=false` injected
		// by `run()`, so no symlinks were materialised during the initial
		// checkout.
		await this.persistNoSymlinksConfig();
	}

	/** `git fetch origin`. */
	async fetch(): Promise<void> {
		await this.runExpectOk(["fetch", "origin"]);
	}

	/**
	 * `git pull --rebase origin <branch>`. Returns the conflicted-paths list
	 * when rebase pauses; empty array on a clean run.
	 *
	 * Branch comes from `credentials.defaultBranch` (P2 fix) — the single
	 * source of truth shared with `push()`, `initRemote()`, and
	 * `notifyPush()`. Pre-fix this used `currentBranch()` which could
	 * diverge from the backend-declared default and produce
	 * "pushed branch X, notified backend about Y" inconsistencies.
	 *
	 * Note (plan §P1#2): the explicit `HEAD:refs/heads/<branch>` refspec
	 * lives on `push()`, NOT here. `git pull --rebase` with a single ref
	 * argument fetches that ref and rebases the **current HEAD** on it —
	 * which is exactly the behaviour the engine wants (the §P1#2
	 * `ensureOnDefaultBranch` guard makes sure HEAD is on the default
	 * branch by this point). An explicit `<branch>:<branch>` refspec
	 * would instead try to fast-forward the local default-branch ref
	 * during the fetch step, hard-failing on non-FF before the rebase
	 * even runs — the opposite of what conflict resolution needs.
	 *
	 * Editor suppression (plan §P1#3): `pull --rebase` can invoke the
	 * commit-message editor when fast-forward + autosquash bundles or
	 * specific replay paths land. Without the suppressors the child blocks
	 * forever in a hidden process because there's no TTY to drive `vi` —
	 * see `rebaseContinue` for the full rationale.
	 */
	async pullRebase(author?: { name: string; email: string }): Promise<PullResult> {
		const branch = this.credentials.defaultBranch;
		// Without `-c user.name/email`, `git pull --rebase` derives the
		// committer from the host's git config when rebase has to re-create
		// commits (the typical path — even a "Rebasing (1/1)" empty replay
		// rewrites the committer). On CI runners with no global git config
		// this fails with `fatal: empty ident name`. Mirror `rebaseContinue`
		// + `commit` so the rebased commits' committer matches the caller's
		// chosen author.
		const identityArgs = author ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`] : [];
		const result = await this.run(
			[...identityArgs, "-c", "core.editor=true", "pull", "--rebase", "origin", branch],
			{ extraEnv: NO_EDITOR_ENV },
		);
		if (result.exitCode === 0) {
			return { fastForwarded: /Fast-forward/i.test(result.stdout), conflicted: [] };
		}
		// Rebase paused — caller drives the conflict pyramid.
		const unmerged = await this.hasUnmergedPaths();
		if (unmerged.length === 0) {
			// Non-conflict failure (network, ref issue, etc.). Surface as Error
			// so the engine logs it and downgrades to `offline`.
			throw new Error(`git pull --rebase failed: ${result.stderr || result.stdout}`);
		}
		return { fastForwarded: false, conflicted: unmerged.map((u) => u.path) };
	}

	/** `git add --all`. Idempotent. */
	async stageAll(): Promise<void> {
		await this.runExpectOk(["add", "--all"]);
	}

	/** `git add -- <path>`. Used by `ConflictResolver` after writing a resolved blob. */
	async addPath(path: string): Promise<void> {
		await this.runExpectOk(["add", "--", path]);
	}

	/**
	 * `git rm -f -- <path>`. Used by `ConflictResolver` when Tier 2.7's
	 * base-aware delete-vs-modify rule decides the right resolution is to
	 * propagate a delete (rather than undelete by accepting the modified
	 * side). `-f` because the path is currently in a conflicted state
	 * with stage-:3: blobs present — git would otherwise refuse.
	 */
	async removePath(path: string): Promise<void> {
		await this.runExpectOk(["rm", "-f", "--", path]);
	}

	/**
	 * `git commit -m <message> --author=<author>`. Returns the new HEAD sha.
	 * Skips the commit (returns the current HEAD) when there is nothing to
	 * commit — keeps callers' "what's my latest sha" logic uniform.
	 */
	async commit(message: string, author: { name: string; email: string }): Promise<string> {
		const args = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message];
		const result = await this.run(args);
		if (result.exitCode !== 0) {
			// `nothing to commit` is an expected no-op outcome (mirror was idempotent
			// and produced no diff). Distinguish that case from real errors by inspecting
			// stdout — git prints "nothing to commit" but exits non-zero.
			if (/nothing to commit/i.test(result.stdout)) {
				return this.currentHead();
			}
			throw new Error(`git commit failed: ${result.stderr || result.stdout}`);
		}
		return this.currentHead();
	}

	/**
	 * `git push origin HEAD:refs/heads/<branch>`. Branch is
	 * `credentials.defaultBranch` (P2 fix — see `pullRebase` for the
	 * branch-source rationale). Distinguishes non-FF rejection.
	 *
	 * The explicit `HEAD:refs/heads/<branch>` refspec (plan §P1#2) pushes
	 * the **current HEAD** to the remote default branch regardless of
	 * which local branch name HEAD points at. Pre-fix this was
	 * `push origin <branch>`, which is shorthand for `<branch>:<branch>` —
	 * if an external actor had left the working tree on a non-default
	 * branch (manual checkout, a crashed round mid-rebase, etc.) the local
	 * `<branch>` ref was stale and git reported "Everything up-to-date"
	 * silently while commits piled up on HEAD that the remote never saw.
	 * The engine still asserts HEAD is on the default branch before
	 * commit; the refspec is belt-and-suspenders.
	 */
	async push(): Promise<PushResult> {
		const branch = this.credentials.defaultBranch;
		const result = await this.run(["push", "origin", `HEAD:refs/heads/${branch}`]);
		if (result.exitCode === 0) {
			// Detect git's "no transmission" verdict — both `stderr` (where git
			// puts this message for HTTPS/SSH transports) and `stdout` (file://
			// occasionally) are inspected. If git's wording changes in a future
			// version we default to `transmitted: true`, so the only failure
			// mode is one redundant notify-push, not a missed one.
			const combined = `${result.stdout}\n${result.stderr}`;
			const transmitted = !/everything up-to-date/i.test(combined);
			return { ok: true, transmitted };
		}
		const merged = `${result.stdout}\n${result.stderr}`.toLowerCase();
		// `git` reports auth failure as `authentication failed`, `invalid username
		// or password`, or `401 unauthorized` depending on the transport; match
		// any of them so we recover when the askpass-supplied token is rejected
		// (e.g. expired mid-round, IAM change on the broker, GitHub revoked it).
		const unauthorized =
			/authentication failed|invalid username or password|401 unauthorized|requested url returned error: 401/.test(
				merged,
			);
		// `repoMissing` covers the deleted-repo case where backend's
		// `ensureGithubRepoExists` only runs at `/credentials` mint time
		// (see plan §0.6). 401 takes precedence: GitHub sometimes returns
		// 404 instead of 401 for unauthorized reads of private repos, but
		// when both signals appear we want the auth retry path (a fresh
		// token might re-authorize a still-existing repo), not a needless
		// re-create.
		const repoMissing = !unauthorized && isRepoMissingMessage(merged);
		const nonFastForward = !unauthorized && !repoMissing && /non-fast-forward|rejected/.test(merged);
		return {
			ok: false,
			nonFastForward,
			unauthorized,
			repoMissing,
			message: result.stderr || result.stdout,
		};
	}

	/** `git show :<stage>:<path>`. Returns null when the stage is missing. */
	async readIndexStage(path: string, stage: 1 | 2 | 3): Promise<string | null> {
		const result = await this.run(["show", `:${stage}:${path}`]);
		if (result.exitCode !== 0) return null;
		return result.stdout;
	}

	/**
	 * "Use my local edit" — the conflict resolution the user picks when they
	 * want their version, not the remote's.
	 *
	 * **Rebase gotcha**: `pullRebase` is the ONLY path that surfaces
	 * conflicts in our system, and during `git pull --rebase` the ours/theirs
	 * roles are inverted vs. a normal merge:
	 *   - `--ours`   = the upstream commit (i.e. the remote version)
	 *   - `--theirs` = the local commit being replayed (your edit)
	 * So "Use my edit" maps to `git checkout --theirs`. Method names follow
	 * the user-facing label, not the raw flag.
	 */
	async checkoutOurs(path: string): Promise<void> {
		await this.runExpectOk(["checkout", "--theirs", "--", path]);
		await this.runExpectOk(["add", "--", path]);
	}

	/** "Use the remote's version" — see `checkoutOurs` for the rebase gotcha. */
	async checkoutTheirs(path: string): Promise<void> {
		await this.runExpectOk(["checkout", "--ours", "--", path]);
		await this.runExpectOk(["add", "--", path]);
	}

	/**
	 * `git rebase --continue`.
	 *
	 * Editor suppression + timeout (plan §P1#3):
	 *
	 *   - `-c core.editor=true` defangs the config-level editor setting.
	 *   - `extraEnv: NO_EDITOR_ENV` sets `GIT_EDITOR=true` and
	 *     `GIT_SEQUENCE_EDITOR=true` so neither the message editor nor a
	 *     hypothetical interactive todo editor can launch.
	 *   - `timeoutMs: REBASE_TIMEOUT_MS` is the last-line defence: if a
	 *     future git ever invents a fourth editor entry point and our
	 *     suppressors miss it, the child is reaped instead of hanging
	 *     the engine forever.
	 *
	 * Without this, a user shell with `EDITOR=vi` would freeze
	 * `git rebase --continue` after every Tier-2/3 conflict resolution —
	 * the child waits for editor input that can never arrive in a hidden
	 * process. Reproduced in the test suite when ran from `npm exec`.
	 */
	async rebaseContinue(author?: { name: string; email: string }): Promise<void> {
		// Without `-c user.name/email`, `git rebase --continue` will derive the
		// committer from the host's git config — which is absent in CI and is
		// stale on dev machines that have rotated identities. Mirror `commit()`
		// so the rebased commit's committer matches the author the caller
		// already chose for the round.
		const identityArgs = author ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`] : [];
		await this.runExpectOk([...identityArgs, "-c", "core.editor=true", "rebase", "--continue"], {
			extraEnv: NO_EDITOR_ENV,
			timeoutMs: REBASE_TIMEOUT_MS,
		});
	}

	/**
	 * `git rebase --abort`. Used when Tier 3 returns 'skip' for everything.
	 *
	 * Carries the same editor suppression as `rebaseContinue` — `--abort`
	 * itself shouldn't open an editor, but the same `core.editor` config
	 * resolution kicks in on hook execution (e.g. `post-rewrite`), so
	 * applying the suppressors uniformly avoids surprise.
	 */
	async rebaseAbort(): Promise<void> {
		await this.runExpectOk(["-c", "core.editor=true", "rebase", "--abort"], {
			extraEnv: NO_EDITOR_ENV,
			timeoutMs: REBASE_TIMEOUT_MS,
		});
	}

	/**
	 * `git ls-files -u` parsed into per-path stage sets. Empty array when
	 * the index has no unmerged entries.
	 */
	async hasUnmergedPaths(): Promise<ReadonlyArray<UnmergedEntry>> {
		const result = await this.run(["ls-files", "-u", "-z"]);
		if (result.exitCode !== 0) return [];
		const entries = new Map<string, Set<1 | 2 | 3>>();
		// Format per entry: `<mode> <oid> <stage>\t<path>` separated by NULs.
		for (const entry of result.stdout.split("\x00")) {
			if (!entry) continue;
			const tabIdx = entry.indexOf("\t");
			if (tabIdx === -1) continue;
			const head = entry.slice(0, tabIdx);
			const path = entry.slice(tabIdx + 1);
			const parts = head.split(/\s+/);
			const stage = Number(parts[2]);
			if (stage !== 1 && stage !== 2 && stage !== 3) continue;
			let set = entries.get(path);
			if (!set) {
				set = new Set();
				entries.set(path, set);
			}
			set.add(stage as 1 | 2 | 3);
		}
		return [...entries.entries()].map(([path, stages]) => ({ path, stages }));
	}

	/** `git rev-parse HEAD`. */
	async currentHead(): Promise<string> {
		const result = await this.runExpectOk(["rev-parse", "HEAD"]);
		return result.stdout.trim();
	}

	/**
	 * Returns true iff `HEAD` resolves to a commit. False on an unborn
	 * branch — e.g. immediately after `git init` + `git fetch` (no clone),
	 * where the branch ref exists but points at nothing. Lets callers
	 * detect the post-init pre-first-commit window without paying for the
	 * `fatal: ambiguous argument 'HEAD'` `currentHead` would throw.
	 */
	async hasHead(): Promise<boolean> {
		const result = await this.run(["rev-parse", "--verify", "--quiet", "HEAD"]);
		return result.exitCode === 0;
	}

	/**
	 * Returns true iff `git status --porcelain` reports any uncommitted
	 * entry (modifications, additions, deletions, untracked files).
	 *
	 * Used by `SyncEngine` to detect "user manually edited the vault"
	 * state before `pullRebase` — left unhandled, `pull --rebase` errors
	 * with "cannot pull with rebase: You have unstaged changes" and the
	 * round goes offline. Memory Bank is meant to be user-editable, so the
	 * engine auto-reconciles by staging + committing whatever's dirty
	 * before pulling.
	 */
	async hasUncommittedChanges(): Promise<boolean> {
		const result = await this.runExpectOk(["status", "--porcelain"]);
		return result.stdout.trim().length > 0;
	}

	/**
	 * Returns every working-tree path `git status --porcelain` flags as
	 * dirty (modified, added, untracked, deleted, renamed). Output uses
	 * `-z` so paths with spaces / quotes are returned verbatim with NUL
	 * separators. Rename entries (`R  new\0old\0`) contribute BOTH paths;
	 * the caller already has to `lstat` each before acting on it so
	 * non-existent entries (pure deletes, rename-from sides) are filtered
	 * naturally.
	 *
	 * Used by the auto-reconcile path (§I9) to validate aggregate JSON
	 * files before staging — a mid-write or truncated `.jolli/**\/*.json`
	 * file must be quarantined, not committed onto the orphan history
	 * where peers would pull a corrupt summary / index / transcript.
	 */
	async listDirtyPaths(): Promise<ReadonlyArray<string>> {
		const result = await this.runExpectOk(["status", "--porcelain", "-z"]);
		const out = result.stdout;
		if (out.length === 0) return [];
		// `-z` emits NUL-terminated records. Standard entries look like
		// `XY pathspec` (2 status chars + space + path). Rename / copy
		// entries (`R` or `C` in either X or Y) span TWO records: the
		// first carries the destination path with the `XY ` prefix, the
		// second carries the source path with NO prefix (raw path bytes).
		//
		// A heuristic like "third char is a space ⇒ standard prefix"
		// misparses a rename-source path whose third byte happens to be
		// a space (e.g. `ab cdef.json`). We track the rename/copy state
		// explicitly so the source path is always taken verbatim.
		const records = out.split("\0").filter((r) => r.length > 0);
		const paths: string[] = [];
		let renameSourcePending = false;
		for (const rec of records) {
			if (renameSourcePending) {
				// Whole record is the source path of the prior R/C entry.
				paths.push(rec);
				renameSourcePending = false;
				continue;
			}
			if (rec.length < 3) continue;
			const xy = rec.substring(0, 2);
			paths.push(rec.substring(3));
			// Either index- or worktree-side rename/copy flags the next
			// record as a source-path trailer (`git status` docs: "rename
			// in index" = `R `, "renamed in work tree" = ` R`, copies
			// analogous with `C`).
			if (xy.includes("R") || xy.includes("C")) {
				renameSourcePending = true;
			}
		}
		return paths;
	}

	/**
	 * `git init` in `memoryBankRoot` if there's no `.git/` yet, then
	 * `git remote add origin <gitUrl>` (or `set-url` if already set).
	 * Used for the §0.13 first-bind path: `<localFolder>` already exists
	 * with FolderStorage content but isn't yet a git repo. After this,
	 * `fetch()` works against the configured remote and the round can
	 * proceed normally.
	 *
	 * Idempotent — safe to call when `.git/` already exists; just
	 * upserts the `origin` remote URL.
	 */
	async initRemote(gitUrl: string): Promise<void> {
		const authUrl = injectGithubAppUsername(gitUrl);
		// Use the backend-declared default branch (P2 fix). Pre-fix this
		// hardcoded `main`, which would silently create a `main` branch
		// even when the personal-space repo's real default was something
		// else — then `push("<defaultBranch>")` would fail because that
		// ref didn't exist locally.
		await this.runExpectOk(["init", `--initial-branch=${this.credentials.defaultBranch}`]);
		// `remote add` errors if origin exists; `set-url` is the upsert path.
		const addRes = await this.run(["remote", "add", "origin", authUrl]);
		if (addRes.exitCode !== 0) {
			await this.runExpectOk(["remote", "set-url", "origin", authUrl]);
		}
		// Persist `core.symlinks=false` so the upcoming `fetch` + first
		// checkout (and any out-of-band `git` invocations the user runs in
		// the Memory Bank folder) refuse to materialise 120000 blobs as
		// real symlinks. See `GIT_HARDENING_CONFIG` rationale.
		await this.persistNoSymlinksConfig();
	}

	/**
	 * Writes `core.symlinks=false` into the local repo `.git/config` so the
	 * setting survives across processes — including manual `git` commands
	 * the user might run in the Memory Bank folder. Idempotent. Failures
	 * are non-fatal: the in-process `-c core.symlinks=false` injection in
	 * `run()` still protects every git command we drive ourselves.
	 */
	private async persistNoSymlinksConfig(): Promise<void> {
		const res = await this.run(["config", "core.symlinks", "false"]);
		if (res.exitCode !== 0) {
			log.warn("Failed to persist core.symlinks=false (non-fatal, in-process flag still active): %s", res.stderr);
		}
	}

	/**
	 * `git rm --cached -r <pathspec>` to untrack already-committed paths
	 * while keeping the working-tree copies on disk. Used by
	 * `MemoryBankBootstrap` when `syncTranscripts` flips OFF: `.gitignore`
	 * alone doesn't untrack existing tracked paths, so we explicitly
	 * stage deletions for the next commit.
	 *
	 * A glob with no matches yields a non-zero exit ("pathspec did not
	 * match any files"); we treat that as a no-op and return normally.
	 */
	async untrackPathGlob(pathspec: string): Promise<void> {
		// Two pre-fix quirks combined into a silent no-op for nested layouts:
		//
		//   1. `git rm` defaults to "literal" pathspec semantics — `**` is
		//      taken as the literal two-asterisk string, NOT a recursive
		//      glob. Wrap in `:(glob)` to opt into fnmatch dialect.
		//
		//   2. A directory pathspec (trailing `/`) matches the directory
		//      itself, not the files inside it. `git rm --cached -r` does
		//      NOT auto-expand `<dir>/` into `<dir>/**` the way you might
		//      expect — verified empirically on git 2.43 + 2.49. To
		//      actually untrack everything under a dir we have to spell out
		//      `<dir>/**` ourselves.
		//
		// Combined effect: callers can keep passing gitignore-style globs
		// (`**/.jolli/transcripts/`) and the wrapper produces a pathspec
		// that actually matches the contained files.
		const normalized = pathspec.endsWith("/") ? `${pathspec}**` : pathspec;
		const magic = normalized.startsWith(":(") ? normalized : `:(glob)${normalized}`;
		const result = await this.run(["rm", "--cached", "-r", "--ignore-unmatch", magic]);
		// `--ignore-unmatch` maps "pathspec matched no files" to exit 0.
		// Any non-zero exit is therefore a real error (index lock,
		// permission, fs corruption) — pre-fix this branch was a
		// `log.debug` that silently swallowed real failures. Callers that
		// don't care (`PER_DEVICE_JSON_GLOBS` cleanup, defensive
		// `untrackNonHashSummaries` calls) wrap in try/catch + WARN; the
		// privacy-critical transcripts callers must propagate, but Model 2
		// (plan §2.5) removes the only such caller — the bootstrap no
		// longer auto-untracks on toggle off.
		if (result.exitCode !== 0) {
			throw new Error(
				`git rm --cached failed for ${pathspec}: exit=${result.exitCode}${result.stderr ? ` stderr=${result.stderr.trim()}` : ""}`,
			);
		}
	}

	/** `git symbolic-ref --short HEAD`. Falls back to `HEAD` when detached. */
	async currentBranch(): Promise<string> {
		const result = await this.run(["symbolic-ref", "--short", "HEAD"]);
		if (result.exitCode === 0) return result.stdout.trim();
		return "HEAD";
	}

	/**
	 * `git remote get-url origin`. Returns `null` when the remote isn't
	 * configured (exit non-zero) so callers can treat "no remote" the same
	 * as "wrong remote" — both are reasons to refuse writing to the folder.
	 *
	 * Used by `verifyVaultMarker` (plan §P1#1 — the vault-marker /
	 * origin-URL crosscheck that prevents a misconfigured Memory Bank root
	 * pointing at a non-vault repo from being rewritten).
	 */
	async getOriginUrl(): Promise<string | null> {
		const result = await this.run(["remote", "get-url", "origin"]);
		if (result.exitCode !== 0) return null;
		const url = result.stdout.trim();
		return url.length > 0 ? url : null;
	}

	/**
	 * `git checkout <branch>` — switches HEAD to an existing local branch.
	 * Throws when the branch doesn't exist locally (callers should use
	 * `checkoutTrackingBranch` for the create-tracking-from-remote case).
	 *
	 * Used by `SyncEngine` to recover when an external actor has left the
	 * vault working tree on a non-default branch (plan §P1#2 — pre-fix
	 * `push origin <defaultBranch>` would silently report "Everything
	 * up-to-date" because the local default-branch ref hadn't moved).
	 */
	async checkoutBranch(branch: string): Promise<void> {
		await this.runExpectOk(["checkout", branch]);
	}

	/**
	 * `git checkout -B <branch> origin/<branch>` — recreates `<branch>`
	 * locally to track `origin/<branch>`, resetting any divergent local
	 * state. Used when `checkoutBranch` fails because the local ref
	 * doesn't exist (e.g. a vault that was cloned shallow or had its
	 * local branch pruned). Caller has already ensured a clean working
	 * tree.
	 */
	async checkoutTrackingBranch(branch: string): Promise<void> {
		await this.runExpectOk(["checkout", "-B", branch, `origin/${branch}`]);
	}

	/**
	 * `git checkout -B <branch> <sourceRef>` — recreates `<branch>` at
	 * `<sourceRef>` and switches to it. Used by `ensureOnDefaultBranch`
	 * to fast-forward the default branch to a side-branch tip when the
	 * side strictly leads the default (plan §P2 — recovers the pre-§P1#2
	 * "commits stranded on side branch" bug). `<sourceRef>` can be any
	 * resolvable revision (`HEAD`, a branch name, a sha).
	 */
	async recreateBranchAt(branch: string, sourceRef: string): Promise<void> {
		await this.runExpectOk(["checkout", "-B", branch, sourceRef]);
	}

	/**
	 * `git show-ref --verify --quiet <fullRef>` — exit 0 iff the ref
	 * exists. Use the fully-qualified form (`refs/heads/main`, not
	 * `main`) so we don't accidentally match a tag or remote-tracking
	 * branch with the same short name.
	 */
	async refExists(fullRef: string): Promise<boolean> {
		const result = await this.run(["show-ref", "--verify", "--quiet", fullRef]);
		return result.exitCode === 0;
	}

	/**
	 * `git merge-base --is-ancestor <a> <b>` — true iff `<a>` is an
	 * ancestor of `<b>` (i.e. `<b>` already contains every commit
	 * reachable from `<a>`). Used by `ensureOnDefaultBranch` to decide
	 * whether a side branch is strictly ahead of the default (fast-
	 * forward path) or has diverged (refuse).
	 *
	 * Exit codes per `git-merge-base(1)`: 0 = ancestor, 1 = not, 128 =
	 * usage error. We treat anything non-zero as "not an ancestor" so
	 * the caller doesn't have to handle the error case separately —
	 * misuse (bad refs) produces the safer "refuse" path.
	 */
	async isAncestor(maybeAncestor: string, descendant: string): Promise<boolean> {
		const result = await this.run(["merge-base", "--is-ancestor", maybeAncestor, descendant]);
		return result.exitCode === 0;
	}

	// ── internals ─────────────────────────────────────────────────────────

	private async getAskpass(): Promise<AskpassHandle> {
		if (this.cachedAskpass === undefined) {
			this.cachedAskpass = await this.askpass(this.credentials.token);
		}
		return this.cachedAskpass;
	}

	private async run(args: ReadonlyArray<string>, opts: RunOpts = {}): Promise<ExecResult> {
		const handle = await this.getAskpass();
		const cwd = opts.cwdOverride === null ? undefined : (opts.cwdOverride ?? this.memoryBankRoot);
		// Merge per-call env on top of askpass env so callers like
		// `rebaseContinue` can inject `GIT_EDITOR=true` to suppress editor
		// pop-ups even when the user's shell has `EDITOR=vi` set (plan §P1#3).
		// The askpass env already carries `GIT_TERMINAL_PROMPT=0` from
		// `prepareAskpass`; the per-call additions sit beside it.
		const env = opts.extraEnv ? { ...handle.env, ...opts.extraEnv } : handle.env;
		// Always inject the hardening config (see GIT_HARDENING_CONFIG
		// rationale). Prepending means per-call `-c` flags can still override
		// any other config they need to set, and clone/fetch/pull all run
		// with the safer behaviour from the very first checkout.
		const finalArgs = [...GIT_HARDENING_CONFIG, ...args];
		log.debug("git %s (cwd=%s)", finalArgs.join(" "), cwd ?? "<inherited>");
		try {
			const { stdout, stderr } = await this.execFileImpl("git", finalArgs, {
				cwd,
				env,
				maxBuffer: this.maxBufferBytes,
				// `timeout` is honoured by `child_process.execFile` natively:
				// at the deadline the child is killed with `killSignal`
				// (default SIGTERM) and the wrapping promise rejects. We
				// pass it through unchanged so undefined preserves the
				// long-running default behaviour for clone / fetch / pull.
				timeout: opts.timeoutMs,
			});
			return { stdout, stderr, exitCode: 0 };
		} catch (error: unknown) {
			const err = error as {
				stdout?: string;
				stderr?: string;
				code?: number | string;
				signal?: string;
				killed?: boolean;
				message?: string;
			};
			const exitCode = typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;
			// Use `||` (truthy check), not `??` (nullish-only). execFile's error
			// often has `stderr: ""` (empty string) when git exited non-zero
			// without printing — falling through to `err.message` ("Command
			// failed: git ...") gives us *something* to log instead of a bare
			// "failed:" with no detail.
			//
			// Timeout failures arrive here with `killed: true` and `signal`
			// populated. Rewrite the stderr to be self-explanatory so the
			// engine's `classifyGitError` and the eventual user-facing
			// status-bar tooltip both name the cause clearly.
			let stderr = err.stderr || err.message || "";
			if (err.killed && opts.timeoutMs !== undefined) {
				stderr =
					`git ${finalArgs.join(" ")} timed out after ${opts.timeoutMs}ms (signal=${err.signal ?? "SIGTERM"}). ${stderr}`.trim();
			}
			return {
				stdout: err.stdout ?? "",
				stderr,
				exitCode,
			};
		}
	}

	private async runExpectOk(args: ReadonlyArray<string>, opts: RunOpts = {}): Promise<ExecResult> {
		const result = await this.run(args, opts);
		if (result.exitCode !== 0) {
			throw new Error(
				`git ${args.join(" ")} exit=${result.exitCode}: ${result.stderr || result.stdout || "(no output)"}`,
			);
		}
		return result;
	}
}

/** Per-call options accepted by `GitClient.run()` / `runExpectOk()`. */
interface RunOpts {
	/**
	 * Override the working directory. `null` clears it (used by `clone`,
	 * which can't cd into a directory that doesn't exist yet); undefined
	 * defaults to `memoryBankRoot`.
	 */
	readonly cwdOverride?: string | null;
	/**
	 * Extra environment variables merged on top of the askpass env.
	 * Useful for per-command suppressors like `GIT_EDITOR=true` on the
	 * rebase family (plan §P1#3 — without this, a user shell with
	 * `EDITOR=vi` would freeze `git rebase --continue` waiting for the
	 * editor that never opens in our hidden child process).
	 */
	readonly extraEnv?: NodeJS.ProcessEnv;
	/**
	 * Hard timeout in milliseconds. `undefined` = no timeout (the default,
	 * keeping clone / fetch / pull / push behaviour unchanged because those
	 * can legitimately run for minutes on a slow network). Local operations
	 * with no business taking that long (rebase --continue, rebase --abort)
	 * pass an explicit deadline so a hung child can't deadlock the engine.
	 */
	readonly timeoutMs?: number;
}

/**
 * Detects the "GitHub repo doesn't exist on the remote" failure across
 * `git clone` / `git fetch` / `git push` stderr (case-insensitive). Engine
 * uses this to decide whether to trigger an at-most-one-per-round re-mint
 * (which lets backend `ensureGithubRepoExists` rebuild the repo).
 *
 * Patterns covered (from real git output across HTTPS transport):
 *
 *   - `remote: repository not found`     ← push/fetch against deleted repo
 *   - `repository '...' not found`       ← clone against missing repo
 *   - `the requested url returned error: 404`
 *   - `could not read from remote repository` (only when paired with one of
 *     the above — bare "could not read" can also mean transient network)
 *
 * We deliberately do NOT match a bare `404` token, because git's verbose
 * progress output occasionally contains `404` in unrelated contexts.
 */
export function isRepoMissingMessage(message: string): boolean {
	const m = message.toLowerCase();
	if (/remote: repository not found/.test(m)) return true;
	if (/repository '[^']*' not found/.test(m)) return true;
	if (/the requested url returned error: 404/.test(m)) return true;
	if (/fatal: not found/.test(m)) return true;
	return false;
}

/**
 * Detects network-layer failures from `git` stderr / Error messages — DNS,
 * TLS/SSL handshake, connection timeout, dropped sockets, etc. — across
 * `git clone` / `fetch` / `pull` / `push`. The engine routes these to a
 * unified `lastError.code = "network"` (plan §0.11) so the status bar
 * stays neutral instead of alarming the user about an environmental hiccup
 * the next poll tick will almost certainly recover from.
 *
 * Patterns are intentionally broad — false positives here are harmless
 * (they just suppress a one-off "Sync failed" toast that would have
 * resolved on retry anyway), while false negatives leave the user staring
 * at a red error for a benign network blip.
 *
 * Priority order at the engine call site is:
 *   `unauthorized` > `repoMissing` > `network` > `fatal`
 * — so a 401 page that happens to mention "connection" still gets routed
 * to the auth-recovery path, and a 404 still goes through re-mint
 * recovery; only when neither auth nor repo-missing signals appear does
 * the network classifier even get consulted.
 */
const NETWORK_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
	/gnutls/, // GnuTLS errors on Linux/WSL
	/\bhandshake failed\b/, // generic TLS/SSL handshake failure
	/tls connection.*(terminated|reset|closed|aborted)/,
	/ssl[\s_]?error/, // OpenSSL: SSL_ERROR_*
	/error: ssl/, // openssl backend error prefix
	/could ?n['o]?t resolve host/, // DNS failure
	/failed to connect to/, // generic connect failure
	/connection (timed out|refused|reset|closed)/,
	/operation timed out/,
	/network is unreachable/,
	/empty reply from server/,
	/\bearly eof\b/, // socket dropped mid-transfer
	/unexpected disconnect while reading sideband packet/,
	/the remote end hung up unexpectedly/,
	/rpc failed/,
	/curl.*(\(56\)|\(28\)|\(35\))/, // curl error codes: receive, timeout, ssl
];

export function isNetworkErrorMessage(message: string): boolean {
	const m = message.toLowerCase();
	return NETWORK_ERROR_PATTERNS.some((p) => p.test(m));
}

/**
 * Patterns that signal the **server actively rejected the push** rather
 * than a network blip. The patterns above (`the remote end hung up`,
 * `early eof`) overlap with server-side rejection symptoms because
 * GitHub / Gitea will close the side-band socket when a pre-receive hook
 * declines — so without this classifier, a protected-branch policy or a
 * pre-receive hook decline gets misrouted to `code: "network"`, which is
 * transient and silently retried forever.
 *
 * Match order: `isServerRejection` MUST be checked before
 * `isNetworkErrorMessage` so the rejection patterns take precedence.
 */
const SERVER_REJECTION_PATTERNS: ReadonlyArray<RegExp> = [
	/^remote: error:/m,
	/pre[-\s]?receive hook declined/,
	/post[-\s]?receive hook declined/,
	/refusing to update checked out branch/,
	/\bprotected branch\b/,
	/\b(push|file).{0,40}(too large|exceeds.{0,20}limit)\b/,
	/permission to .* denied/,
];

export function isServerRejectionMessage(message: string): boolean {
	const m = message.toLowerCase();
	return SERVER_REJECTION_PATTERNS.some((p) => p.test(m));
}

/**
 * Injects `x-access-token@` as the URL username for an `https://github.com/…`
 * URL so GitHub's auth flow treats us as a GitHub App. Idempotent: a URL that
 * already carries a username (`https://user@…` or `https://user:pwd@…`) is
 * returned unchanged. Non-HTTPS / non-GitHub URLs pass through too, so this is
 * safe to apply unconditionally.
 *
 * Exported for unit testing only — callers should use `GitClient.clone`.
 */
export function injectGithubAppUsername(url: string): string {
	const match = /^(https:\/\/)(?:([^@/]+)@)?(.+)$/.exec(url);
	if (!match) return url;
	if (match[2]) return url; // Already has a username; respect it.
	return `${match[1]}x-access-token@${match[3]}`;
}
