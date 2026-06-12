package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Thin wrapper around the system `git` binary for vault working-tree
 * operations (clone, fetch, pull-rebase, commit, push, conflict resolution,
 * self-healing).
 *
 * Port of `cli/src/sync/GitClient.ts`.
 *
 * This is a separate working tree from the source repo (`GitOps`). The same
 * `git` binary is used; only the cwd and env differ. All commands flow
 * through [run] which injects the askpass env so the Installation Token
 * never leaks into argv.
 *
 * @param vaultRoot        Absolute path to the Memory Bank folder (vault working tree).
 * @param credentials      Credentials from [SyncBackendClient.mintGitCredentials].
 * @param askpassProvider  Test seam — defaults to [prepareAskpass].
 * @param processRunner    Test seam — defaults to real ProcessBuilder execution.
 */
class SyncGitClient(
	private val vaultRoot: String,
	private val credentials: GitCredentials,
	private val askpassProvider: (token: String) -> AskpassHandle = ::prepareAskpass,
	private val processRunner: ProcessRunner = RealProcessRunner(),
) {

	private val log = JmLogger.create("Sync:Git")
	private var cachedAskpass: AskpassHandle? = null

	companion object {
		/**
		 * Per-batch character budget for [stageAddPaths] / [stageRemovePaths].
		 * Stays under the Windows `cmd.exe` ARG_MAX floor (~32 KB).
		 */
		const val ARG_BUDGET_CHARS = 16_384

		/**
		 * Hard timeout for local rebase plumbing (ms). 30s is generous — rebase
		 * continue/abort are pure index/refs operations. The deadline bounds
		 * the failure mode where a misconfigured git tries to open `$EDITOR`.
		 */
		const val REBASE_TIMEOUT_MS = 30_000L

		/**
		 * Always-injected git config flags for security hardening.
		 * - `core.symlinks=false` — prevents symlink attacks from malicious peers.
		 * - `credential.helper=` — clears the inherited credential helper chain.
		 * - `credential.modalprompt=false` — prevents GCM modal dialogs on Windows.
		 */
		val GIT_HARDENING_CONFIG = listOf(
			"-c", "core.symlinks=false",
			"-c", "credential.helper=",
			"-c", "credential.modalprompt=false",
		)

		/**
		 * Env block that suppresses every git editor entry point.
		 * `true` is the POSIX shell built-in that returns 0 immediately.
		 */
		val NO_EDITOR_ENV = mapOf(
			"GIT_EDITOR" to "true",
			"GIT_SEQUENCE_EDITOR" to "true",
		)
	}

	// ── Public API ────────────────────────────────────────────────────

	/** Probes `git --version`. Used at sync engine startup. */
	fun checkGitInstalled(): GitVersionResult {
		return try {
			val result = processRunner.exec(listOf("git", "--version"), null, emptyMap(), null)
			GitVersionResult.Ok(result.stdout.trim())
		} catch (_: Exception) {
			GitVersionResult.NotFound
		}
	}

	/**
	 * `git clone <gitUrl> <vaultRoot>` with `x-access-token@` injected as
	 * the URL username so GitHub knows we're authenticating as a GitHub App
	 * Installation Token (the actual token comes via `GIT_ASKPASS`).
	 */
	fun clone(gitUrl: String) {
		val authUrl = injectGithubAppUsername(gitUrl)
		runExpectOk(listOf("clone", authUrl, vaultRoot), cwdOverride = UseNoWorkDir)
		persistNoSymlinksConfig()
	}

	/** `git fetch origin`. */
	fun fetch() {
		runExpectOk(listOf("fetch", "origin"))
	}

	/**
	 * `git pull --rebase origin <branch>`. Returns the conflicted-paths
	 * list when rebase pauses; empty list on a clean run.
	 */
	fun pullRebase(author: CommitAuthor? = null): PullResult {
		val branch = credentials.defaultBranch
		val identityArgs = if (author != null) {
			listOf("-c", "user.name=${author.name}", "-c", "user.email=${author.email}")
		} else emptyList()

		// `--autostash`: the Memory Bank vault can hold tracked files that the
		// sync classifier does not own (e.g. `.jolli/topics/` written by a newer
		// surface's post-commit pipeline). Auto-reconcile only commits owned
		// paths, so those leftover modifications keep the working tree dirty and
		// `git pull --rebase` hard-fails with "cannot pull with rebase: You have
		// unstaged changes", dropping the whole round to offline. Autostash
		// shelves any such changes for the rebase and restores them after, so an
		// unrecognized content type can no longer block sync.
		val result = run(
			identityArgs + listOf("-c", "core.editor=true", "pull", "--rebase", "--autostash", "origin", branch),
			extraEnv = NO_EDITOR_ENV,
		)
		if (result.exitCode == 0) {
			return PullResult(
				fastForwarded = Regex("Fast-forward", RegexOption.IGNORE_CASE).containsMatchIn(result.stdout),
				conflicted = emptyList(),
			)
		}
		val unmerged = hasUnmergedPaths()
		if (unmerged.isEmpty()) {
			throw RuntimeException("git pull --rebase failed: ${result.stderr.ifEmpty { result.stdout }}")
		}
		return PullResult(fastForwarded = false, conflicted = unmerged.map { it.path })
	}

	/** `git add --all`. Idempotent. */
	fun stageAll() {
		runExpectOk(listOf("add", "--all"))
	}

	/** `git add -f -- <path>`. Force-add past deny-all `.gitignore`. */
	fun addPath(path: String) {
		runExpectOk(listOf("add", "-f", "--", path))
	}

	/** `git rm -f -- <path>`. Force-remove for conflict resolution deletes. */
	fun removePath(path: String) {
		runExpectOk(listOf("rm", "-f", "--", path))
	}

	/**
	 * `git commit -m <message>`. Returns the new HEAD sha.
	 * Returns the current HEAD when there is nothing to commit.
	 */
	fun commit(message: String, author: CommitAuthor): String {
		val args = listOf(
			"-c", "user.name=${author.name}",
			"-c", "user.email=${author.email}",
			"commit", "-m", message,
		)
		val result = run(args)
		if (result.exitCode != 0) {
			if (Regex("nothing to commit", RegexOption.IGNORE_CASE).containsMatchIn(result.stdout)) {
				return currentHead()
			}
			throw RuntimeException("git commit failed: ${result.stderr.ifEmpty { result.stdout }}")
		}
		return currentHead()
	}

	/**
	 * `git push origin HEAD:refs/heads/<branch>`. Distinguishes non-FF,
	 * unauthorized, and repo-missing failure modes.
	 */
	fun push(): PushResult {
		val branch = credentials.defaultBranch
		val result = run(listOf("push", "origin", "HEAD:refs/heads/$branch"))
		if (result.exitCode == 0) {
			val combined = "${result.stdout}\n${result.stderr}"
			val transmitted = !Regex("everything up-to-date", RegexOption.IGNORE_CASE).containsMatchIn(combined)
			return PushResult.Ok(transmitted)
		}
		val merged = "${result.stdout}\n${result.stderr}".lowercase()
		val unauthorized = Regex(
			"authentication failed|invalid username or password|401 unauthorized|requested url returned error: 401"
		).containsMatchIn(merged)
		val repoMissing = !unauthorized && isRepoMissingMessage(merged)
		val nonFastForward = !unauthorized && !repoMissing &&
			Regex("non-fast-forward|rejected").containsMatchIn(merged)
		return PushResult.Failed(
			nonFastForward = nonFastForward,
			unauthorized = unauthorized,
			repoMissing = repoMissing,
			message = result.stderr.ifEmpty { result.stdout },
		)
	}

	/** `git show :<stage>:<path>`. Returns null when the stage is missing. */
	fun readIndexStage(path: String, stage: Int): String? {
		require(stage in 1..3) { "stage must be 1, 2, or 3" }
		val result = run(listOf("show", ":$stage:$path"))
		if (result.exitCode != 0) return null
		return result.stdout
	}

	/**
	 * "Use my local edit" — during `pull --rebase`, ours/theirs are inverted:
	 * `--theirs` = the local commit being replayed (your edit).
	 */
	fun checkoutOurs(path: String) {
		runExpectOk(listOf("checkout", "--theirs", "--", path))
		runExpectOk(listOf("add", "-f", "--", path))
	}

	/** "Use the remote's version" — see [checkoutOurs] for rebase gotcha. */
	fun checkoutTheirs(path: String) {
		runExpectOk(listOf("checkout", "--ours", "--", path))
		runExpectOk(listOf("add", "-f", "--", path))
	}

	/** `git rebase --continue` with editor suppression + timeout. */
	fun rebaseContinue(author: CommitAuthor? = null) {
		val identityArgs = if (author != null) {
			listOf("-c", "user.name=${author.name}", "-c", "user.email=${author.email}")
		} else emptyList()
		runExpectOk(
			identityArgs + listOf("-c", "core.editor=true", "rebase", "--continue"),
			extraEnv = NO_EDITOR_ENV,
			timeoutMs = REBASE_TIMEOUT_MS,
		)
	}

	/** `git rebase --abort` with editor suppression. */
	fun rebaseAbort() {
		runExpectOk(
			listOf("-c", "core.editor=true", "rebase", "--abort"),
			extraEnv = NO_EDITOR_ENV,
			timeoutMs = REBASE_TIMEOUT_MS,
		)
	}

	/**
	 * Returns true when a previous rebase left its state files behind
	 * (`.git/rebase-merge/` or `.git/rebase-apply/`). Engine uses this
	 * to self-heal at round start.
	 */
	fun isRebaseInProgress(): Boolean {
		for (dir in listOf("rebase-merge", "rebase-apply")) {
			val f = File(vaultRoot, ".git${File.separator}$dir")
			if (f.isDirectory) return true
		}
		return false
	}

	/**
	 * Sweeps stale `*.lock` files under `.git/` left behind when a
	 * previous git invocation was killed. Returns removed paths.
	 *
	 * @param ttlMs Lock files older than this are considered stale (default 5 min).
	 */
	fun sweepStaleLockFiles(ttlMs: Long = 5 * 60_000L): List<String> {
		val gitDir = File(vaultRoot, ".git")
		val cutoff = System.currentTimeMillis() - ttlMs
		val removed = mutableListOf<String>()

		val candidates = mutableListOf(
			File(gitDir, "index.lock"),
			File(gitDir, "HEAD.lock"),
			File(gitDir, "packed-refs.lock"),
			File(gitDir, "config.lock"),
		)
		candidates.addAll(collectLockFiles(File(gitDir, "refs")))

		for (file in candidates) {
			try {
				if (file.isFile && file.lastModified() <= cutoff) {
					if (file.delete()) {
						removed.add(file.absolutePath)
					}
				}
			} catch (_: Exception) {
				// Already gone or perm error — ignore.
			}
		}
		return removed
	}

	/**
	 * `git ls-files -u` parsed into per-path stage sets. Empty list when
	 * the index has no unmerged entries.
	 */
	fun hasUnmergedPaths(): List<UnmergedEntry> {
		val result = run(listOf("ls-files", "-u", "-z"))
		if (result.exitCode != 0) return emptyList()
		val entries = mutableMapOf<String, MutableSet<Int>>()
		for (entry in result.stdout.split("\u0000")) {
			if (entry.isEmpty()) continue
			val tabIdx = entry.indexOf('\t')
			if (tabIdx == -1) continue
			val head = entry.substring(0, tabIdx)
			val path = entry.substring(tabIdx + 1)
			val parts = head.split(Regex("\\s+"))
			val stage = parts.getOrNull(2)?.toIntOrNull() ?: continue
			if (stage !in 1..3) continue
			entries.getOrPut(path) { mutableSetOf() }.add(stage)
		}
		return entries.map { (path, stages) -> UnmergedEntry(path, stages.toSet()) }
	}

	/** `git rev-parse HEAD`. */
	fun currentHead(): String {
		return runExpectOk(listOf("rev-parse", "HEAD")).stdout.trim()
	}

	/** True iff `HEAD` resolves to a commit. False on an unborn branch. */
	fun hasHead(): Boolean {
		return run(listOf("rev-parse", "--verify", "--quiet", "HEAD")).exitCode == 0
	}

	/** True iff `git status --porcelain` reports any uncommitted entry. */
	fun hasUncommittedChanges(includeIgnored: Boolean = false): Boolean {
		val args = mutableListOf("status", "--porcelain")
		if (includeIgnored) {
			args.addAll(listOf("--untracked-files=all", "--ignored=matching"))
		}
		val result = runExpectOk(args)
		return result.stdout.trim().isNotEmpty()
	}

	/** Returns every dirty path from `git status --porcelain -z`. */
	fun listDirtyPaths(): List<String> {
		val entries = statusPorcelainZ()
		val paths = mutableListOf<String>()
		for (e in entries) {
			paths.add(e.path)
			if (e.oldPath != null) paths.add(e.oldPath)
		}
		return paths
	}

	/** Structured `git status --porcelain -z` output. */
	fun statusPorcelainZ(): List<PorcelainEntry> {
		val result = runExpectOk(listOf(
			"status", "--porcelain", "-z",
			"--untracked-files=all", "--ignored=matching",
		))
		return parsePorcelainZ(result.stdout)
	}

	/**
	 * Stages paths via `git add -f`. Chunked at [ARG_BUDGET_CHARS] to stay
	 * under the Windows ARG_MAX floor.
	 */
	fun stageAddPaths(paths: List<String>) {
		for (batch in chunkByBudget(paths, ARG_BUDGET_CHARS)) {
			runExpectOk(listOf("add", "-f", "--") + batch)
		}
	}

	/** Removes paths from index via `git rm --ignore-unmatch --quiet`. */
	fun stageRemovePaths(paths: List<String>) {
		for (batch in chunkByBudget(paths, ARG_BUDGET_CHARS)) {
			runExpectOk(listOf("rm", "--ignore-unmatch", "--quiet", "--") + batch)
		}
	}

	/**
	 * DANGER: data-loss vector. `git rm --cached -f --ignore-unmatch`.
	 * For HEAD-tracked paths, stages a DELETION. Only use for explicit
	 * one-shot eviction logic.
	 */
	fun unstagePaths(paths: List<String>) {
		for (batch in chunkByBudget(paths, ARG_BUDGET_CHARS)) {
			runExpectOk(listOf("rm", "--cached", "-f", "--ignore-unmatch", "--quiet", "--") + batch)
		}
	}

	/**
	 * Restores index entries to their HEAD blob without touching the
	 * working tree. Safe alternative to [unstagePaths] for per-round use.
	 */
	fun resetPathsToHead(paths: List<String>) {
		for (batch in chunkByBudget(paths, ARG_BUDGET_CHARS)) {
			runExpectOk(listOf("reset", "--quiet", "HEAD", "--") + batch)
		}
	}

	/**
	 * `git init` + `git remote add/set-url origin <gitUrl>`. Used for
	 * first-bind when a Memory Bank folder exists but isn't a git repo yet.
	 */
	fun initRemote(gitUrl: String) {
		val authUrl = injectGithubAppUsername(gitUrl)
		runExpectOk(listOf("init", "--initial-branch=${credentials.defaultBranch}"))
		val addRes = run(listOf("remote", "add", "origin", authUrl))
		if (addRes.exitCode != 0) {
			runExpectOk(listOf("remote", "set-url", "origin", authUrl))
		}
		persistNoSymlinksConfig()
	}

	/** `git remote get-url origin`. Null when no remote configured. */
	fun getOriginUrl(): String? {
		val result = run(listOf("remote", "get-url", "origin"))
		if (result.exitCode != 0) return null
		val url = result.stdout.trim()
		return url.ifEmpty { null }
	}

	/** `git symbolic-ref --short HEAD`. Falls back to "HEAD" when detached. */
	fun currentBranch(): String {
		val result = run(listOf("symbolic-ref", "--short", "HEAD"))
		if (result.exitCode == 0) return result.stdout.trim()
		return "HEAD"
	}

	/** `git checkout <branch>` — switches HEAD to an existing local branch. */
	fun checkoutBranch(branch: String) {
		runExpectOk(listOf("checkout", branch))
	}

	/** `git checkout -B <branch> origin/<branch>` — create/reset tracking branch. */
	fun checkoutTrackingBranch(branch: String) {
		runExpectOk(listOf("checkout", "-B", branch, "origin/$branch"))
	}

	/** `git checkout -B <branch> <sourceRef>` — recreate branch at a ref. */
	fun recreateBranchAt(branch: String, sourceRef: String) {
		runExpectOk(listOf("checkout", "-B", branch, sourceRef))
	}

	/** `git show-ref --verify --quiet <fullRef>` — true iff the ref exists. */
	fun refExists(fullRef: String): Boolean {
		return run(listOf("show-ref", "--verify", "--quiet", fullRef)).exitCode == 0
	}

	/** `git rev-parse --verify --quiet <ref>` — returns OID or null. */
	fun revParse(ref: String): String? {
		val result = run(listOf("rev-parse", "--verify", "--quiet", ref))
		if (result.exitCode != 0) return null
		val oid = result.stdout.trim()
		return oid.ifEmpty { null }
	}

	/** `git merge-base --is-ancestor <a> <b>` — true iff a is ancestor of b. */
	fun isAncestor(maybeAncestor: String, descendant: String): Boolean {
		return run(listOf("merge-base", "--is-ancestor", maybeAncestor, descendant)).exitCode == 0
	}

	/** `git for-each-ref refs/heads/` — returns local branch short names. */
	fun listLocalBranches(): List<String> {
		val result = run(listOf("for-each-ref", "--format=%(refname:short)", "refs/heads/"))
		if (result.exitCode != 0) return emptyList()
		return result.stdout.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
	}

	// ── Internals ─────────────────────────────────────────────────────

	private fun getAskpass(): AskpassHandle {
		if (cachedAskpass == null) {
			cachedAskpass = askpassProvider(credentials.token)
		}
		return cachedAskpass!!
	}

	private fun persistNoSymlinksConfig() {
		val res = run(listOf("config", "core.symlinks", "false"))
		if (res.exitCode != 0) {
			log.warn("Failed to persist core.symlinks=false (non-fatal): %s", res.stderr)
		}
	}

	private fun run(
		args: List<String>,
		cwdOverride: CwdOverride = UseVaultRoot,
		extraEnv: Map<String, String> = emptyMap(),
		timeoutMs: Long? = null,
	): ExecResult {
		val handle = getAskpass()
		val cwd = when (cwdOverride) {
			UseVaultRoot -> vaultRoot
			UseNoWorkDir -> null
		}
		val env = if (extraEnv.isNotEmpty()) handle.env + extraEnv else handle.env
		val finalArgs = listOf("git") + GIT_HARDENING_CONFIG + args
		log.debug("git %s (cwd=%s)", (GIT_HARDENING_CONFIG + args).joinToString(" "), cwd ?: "<inherited>")
		return processRunner.exec(finalArgs, cwd, env, timeoutMs)
	}

	private fun runExpectOk(
		args: List<String>,
		cwdOverride: CwdOverride = UseVaultRoot,
		extraEnv: Map<String, String> = emptyMap(),
		timeoutMs: Long? = null,
	): ExecResult {
		val result = run(args, cwdOverride, extraEnv, timeoutMs)
		if (result.exitCode != 0) {
			throw RuntimeException(
				"git ${args.joinToString(" ")} exit=${result.exitCode}: ${
					result.stderr.ifEmpty { result.stdout.ifEmpty { "(no output)" } }
				}"
			)
		}
		return result
	}
}

// ── Types ─────────────────────────────────────────────────────────────

/** Raw result from a git process invocation. */
data class ExecResult(val stdout: String, val stderr: String, val exitCode: Int)

/** Result of `git pull --rebase`. */
data class PullResult(val fastForwarded: Boolean, val conflicted: List<String>)

/** Result of `git push`. */
sealed class PushResult {
	data class Ok(val transmitted: Boolean) : PushResult()
	data class Failed(
		val nonFastForward: Boolean,
		val unauthorized: Boolean,
		val repoMissing: Boolean,
		val message: String,
	) : PushResult()
}

/** Per-path unmerged-stage map from `git ls-files -u`. */
data class UnmergedEntry(val path: String, val stages: Set<Int>)

/** Author identity for commits. */
data class CommitAuthor(val name: String, val email: String)

/** Sealed marker for cwd override in [SyncGitClient.run]. */
sealed interface CwdOverride
private data object UseVaultRoot : CwdOverride
private data object UseNoWorkDir : CwdOverride

/** Result of [SyncGitClient.checkGitInstalled]. */
sealed class GitVersionResult {
	data class Ok(val version: String) : GitVersionResult()
	data object NotFound : GitVersionResult()
}

/**
 * Abstraction over process execution for testability. The real implementation
 * uses ProcessBuilder; tests inject a fake that returns canned responses.
 */
interface ProcessRunner {
	fun exec(
		command: List<String>,
		cwd: String?,
		env: Map<String, String>,
		timeoutMs: Long?,
	): ExecResult
}

/**
 * Real implementation that spawns a child process via ProcessBuilder.
 * Reads stdout on a CompletableFuture to avoid pipe deadlock.
 */
class RealProcessRunner : ProcessRunner {
	override fun exec(
		command: List<String>,
		cwd: String?,
		env: Map<String, String>,
		timeoutMs: Long?,
	): ExecResult {
		return try {
			val pb = ProcessBuilder(command)
			if (cwd != null) pb.directory(File(cwd))
			pb.redirectErrorStream(false)
			pb.environment().clear()
			pb.environment().putAll(env)

			val process = pb.start()

			// Read stdout on a separate thread to avoid pipe buffer deadlock.
			val stdoutFuture = CompletableFuture.supplyAsync {
				process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
			}

			val timeout = timeoutMs ?: 600_000L // 10 min default for network ops
			val completed = process.waitFor(timeout, TimeUnit.MILLISECONDS)
			if (!completed) {
				process.destroyForcibly()
				stdoutFuture.cancel(true)
				return ExecResult(
					stdout = "",
					stderr = "git ${command.drop(1).joinToString(" ")} timed out after ${timeout}ms",
					exitCode = 1,
				)
			}

			val stderr = process.errorStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
			val stdout = stdoutFuture.get(5, TimeUnit.SECONDS) ?: ""

			ExecResult(stdout = stdout, stderr = stderr, exitCode = process.exitValue())
		} catch (e: Exception) {
			ExecResult(stdout = "", stderr = e.message ?: "unknown error", exitCode = 1)
		}
	}
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Injects `x-access-token@` as the URL username for `https://` URLs so
 * GitHub's auth flow treats us as a GitHub App. Idempotent.
 */
internal fun injectGithubAppUsername(url: String): String {
	val match = Regex("^(https://)(?:([^@/]+)@)?(.+)$").find(url) ?: return url
	if (match.groupValues[2].isNotEmpty()) return url // Already has username
	return "${match.groupValues[1]}x-access-token@${match.groupValues[3]}"
}

/**
 * Splits paths into batches whose joined character length stays under budget.
 * A single path longer than budget ships as its own batch.
 */
internal fun chunkByBudget(paths: List<String>, budget: Int): List<List<String>> {
	val result = mutableListOf<List<String>>()
	var batch = mutableListOf<String>()
	var used = 0
	for (p in paths) {
		val cost = p.length + 1
		if (batch.isNotEmpty() && used + cost > budget) {
			result.add(batch)
			batch = mutableListOf()
			used = 0
		}
		batch.add(p)
		used += cost
	}
	if (batch.isNotEmpty()) result.add(batch)
	return result
}

/**
 * Recursively collects every `*.lock` file path under [root].
 * Returns empty list when root doesn't exist.
 */
private fun collectLockFiles(root: File): List<File> {
	val out = mutableListOf<File>()
	val entries = root.listFiles() ?: return out
	for (entry in entries) {
		if (entry.isDirectory) {
			out.addAll(collectLockFiles(entry))
		} else if (entry.isFile && entry.name.endsWith(".lock")) {
			out.add(entry)
		}
	}
	return out
}
