package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.bridge.GitOps
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File

/**
 * Kotlin adapter for the CLI's `repo-profile` ide-bridge action.
 *
 * The CLI owns `.jolli/profile.json` — `writeManualDisableFlag` in
 * `cli/src/core/RepoProfile.ts` is the single writer, and it takes the shared
 * profile lock so a concurrent `jolli disable` from a terminal (or a VS Code
 * sibling install) can't clobber a Kotlin write. Never write the file directly
 * from Kotlin: doing so would sidestep the mutex and break lockstep with the
 * VS Code path (which imports the same CLI writer).
 *
 * Reads are cheap (~5-20 ms via the daemon fast path, ~500 ms on a cold spawn)
 * but still off-EDT — every caller here runs from a background pool.
 */
object RepoProfileBridge {
    private val gson = Gson()

    /**
     * Sets the repo-wide `manuallyDisabled` opt-out — the highest-priority
     * disable in [readManuallyDisabled], honored across worktrees and IDE
     * restarts. Pass `true` to disable, `false` to clear on re-enable.
     *
     * Throws whatever [CliIntegrations.runIdeBridge] surfaces on failure
     * (`CliBridgeException` for structured errors, `RuntimeException` for
     * transport failures) — the caller must treat that as an abort signal
     * and NOT proceed with the disable, otherwise the on-disk state and
     * user intent would diverge (mirrors VS Code's `disableJolliMemory`).
     */
    fun writeManuallyDisabled(cwd: String, disabled: Boolean) {
        val request = JsonObject().apply {
            addProperty("operation", "write-manual-disable")
            addProperty("disabled", disabled)
        }
        CliIntegrations.runIdeBridge(cwd, "repo-profile", gson.toJson(request))
    }

    /**
     * Reads the repo-wide `manuallyDisabled` opt-out. Tries the ide-bridge first
     * (canonical, mutex-serialized with the CLI's own writes), but falls back to
     * reading `profile.json` directly on any bridge failure — daemon not up,
     * Node missing, spawn timeout, etc.
     *
     * The fallback is load-bearing on the auto-install path: `JolliMemoryService`
     * only skips auto-install when this returns `true`, so a bridge hiccup that
     * pushed us to a stale `false` would silently un-disable a repo the user
     * chose to disable (the CLI's install action clears `manuallyDisabled` on
     * success). VS Code has an analogous `readManualDisableFlagSync`; this is
     * IntelliJ's equivalent, folded into the same call site.
     *
     * A bridge reply whose envelope carries no usable `disabled` field is treated the
     * same as a bridge failure and falls through to disk. Returning `false` there would
     * contradict the paragraph above for the same reason a thrown exception would: it is
     * an absence of an answer, not an answer of "not disabled". Only an actual boolean
     * short-circuits the disk read.
     */
    fun readManuallyDisabled(cwd: String): Boolean {
        try {
            val request = JsonObject().apply { addProperty("operation", "read-manual-disable") }
            val result = CliIntegrations.runIdeBridge(cwd, "repo-profile", gson.toJson(request))
            val disabled = result?.asJsonObject?.get("disabled")
            if (disabled != null && !disabled.isJsonNull) return disabled.asBoolean
            // Fall through: the bridge answered, but not with the field we asked for.
        } catch (_: Exception) {
            // Bridge unreachable — fall back to a direct read below. The
            // manuallyDisabled flag is a highest-priority opt-out, so a
            // transient IPC failure MUST NOT be interpreted as "not disabled".
        }
        return readManuallyDisabledFromDisk(cwd)
    }

    /**
     * The repo's EXPLICIT `manuallyDisabled` decision, or `null` when this repo has
     * never recorded one. Unlike [readManuallyDisabled] — which collapses "no field"
     * to `false` because its callers only ask "is it disabled right now" — this
     * preserves the tri-state that `profile.json` actually stores
     * (`manuallyDisabled?: boolean` in `cli/src/core/RepoProfile.ts`).
     *
     * Needed by the legacy `config.paused` migration in [JolliMemoryService]: that
     * flag is machine-global while `manuallyDisabled` is per-repo, so the mapping is
     * not injective and the global flag can never be cleared without losing the
     * opt-out for every repo the user has not opened yet. Keeping it means the
     * migration must distinguish "this repo has decided" (honor the decision) from
     * "this repo is still undecided" (fall back to the global flag) — a plain boolean
     * cannot express that, and reading it as `false` is exactly what let an explicit
     * re-enable be undone on the next restart.
     *
     * Reads the file directly rather than going through the `repo-profile` bridge on
     * purpose: the bridge's `read-manual-disable` returns `{disabled: boolean}`, which
     * has already collapsed the distinction this function exists to report. That is
     * read-only, so it does not touch the write-side mutex contract documented above
     * — it runs once per repo at startup, off the EDT, alongside the existing direct
     * fallback reader.
     *
     * Returns `null` on a missing or malformed file: "undecided", so the caller falls
     * back to the global flag rather than inventing a decision the user never made.
     */
    fun readExplicitManualDisable(cwd: String): Boolean? {
        val profileFile = resolveProfileJsonPath(cwd) ?: return null
        if (!profileFile.isFile) return null
        return try {
            val flag = JsonParser.parseString(profileFile.readText(Charsets.UTF_8))
                ?.asJsonObject?.get("manuallyDisabled")
            if (flag == null || flag.isJsonNull) null else flag.asBoolean
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Direct read of `<mainRoot>/.jolli/jollimemory/profile.json`, no daemon
     * involvement. Mirrors [readManualDisableFlagSync in the CLI's RepoProfile.ts]:
     * same anchor (main worktree via git-common-dir), same schema, same
     * fail-safe (`false` on any error), AND the same legacy-marker fallback so
     * an older-VS-Code-disabled repo (marker present, no profile.json field yet)
     * still reads as disabled. Missing that fallback meant a bridge outage plus
     * this call was the ONLY manuallyDisabled read (spec 306 auto-install gate)
     * — a `false` here would let auto-install fire with `clearManualDisableOnSuccess`,
     * silently un-disabling the repo. Production code should still prefer the bridge;
     * this is the fallback branch.
     *
     * `internal` so tests can reach it DIRECTLY. Driving it through
     * [readManuallyDisabled] does not reliably exercise this branch: in a built monorepo
     * checkout [CliIntegrations.resolveCliJs] finds `../cli/dist/Cli.js` through its
     * development lookup, so the bridge call succeeds and really spawns Node (~1 s per
     * case). Assertions still pass — the real CLI reads the same file — but whether this
     * code ran at all depended on whether `cli/dist` happened to be built. It is the
     * only reader of the opt-out while the daemon is down, so its coverage must be
     * deliberate rather than incidental.
     */
    internal fun readManuallyDisabledFromDisk(cwd: String): Boolean {
        val profileFile = resolveProfileJsonPath(cwd)
        if (profileFile != null && profileFile.isFile) {
            try {
                val parsed = JsonParser.parseString(profileFile.readText(Charsets.UTF_8))
                val flag = parsed?.asJsonObject?.get("manuallyDisabled")
                if (flag != null && !flag.isJsonNull) {
                    return flag.asBoolean
                }
                // profile.json exists but the field is absent — fall through
                // to the legacy per-worktree marker so a pre-migration disable
                // still counts as disabled.
            } catch (_: Exception) {
                // Malformed profile.json — fall through to the legacy marker
                // rather than falsely reporting `not disabled`.
            }
        }
        // Legacy per-worktree marker (mirrors the CLI's sync path). This worktree
        // only — the async CLI reader enumerates every worktree and migrates;
        // this fast path stays cheap and matches Kotlin's callers, which always
        // run against the current worktree.
        return File(cwd, ".jolli/jollimemory/disabled-by-user").isFile
    }

    /**
     * Resolves the on-disk path of `profile.json` for the current repo, anchored to
     * the MAIN worktree root so linked worktrees observe the same file. Mirrors the
     * CLI's `resolvePaths` in `cli/src/core/RepoProfile.ts` (git-common-dir → dirname
     * → `.jolli/jollimemory/profile.json`), including the submodule edge case where
     * every sibling submodule of a super-repo shares one profile.
     *
     * Used ONLY by the VFS watcher in [ai.jolli.jollimemory.services.JolliMemoryService]
     * to observe cross-window / terminal writes — the bridge is still the single
     * read/write channel; this is a display-time anchor, not a second reader.
     *
     * Returns null when `cwd` is not a git repo (git-common-dir unresolvable), the
     * same "no watch" boundary the sibling watchers use.
     */
    fun resolveProfileJsonPath(cwd: String): File? {
        // Fast path: a `.git` DIRECTORY means `cwd` is the main worktree's top level, so
        // git-common-dir is exactly `<cwd>/.git` and its parent is `cwd`. Returning
        // directly is not an approximation — it is the same answer the fork produces.
        //
        // Worth a special case because the slow path is expensive on the EDT, and both
        // callers reach it from there: [GitOps.exec] seeds the child PATH from
        // `shellPath`, a per-instance `by lazy` that spawns `$SHELL -l -c 'echo $PATH'`
        // with a 5 s timeout. Every `GitOps` instance pays that once, and this function
        // builds a fresh one, so a login shell with a heavy profile (nvm, rbenv, conda)
        // turned "one git fork" into a multi-hundred-millisecond block during tool-window
        // open. Linked worktrees and submodules keep `.git` as a FILE (`gitdir: …`), so
        // they fall through and still resolve correctly.
        if (File(cwd, ".git").isDirectory) {
            return File(cwd, ".jolli/jollimemory/profile.json")
        }
        val raw = GitOps(cwd).exec("rev-parse", "--git-common-dir")?.trim()
        if (raw.isNullOrBlank()) return null
        val commonFile = File(raw).let { if (it.isAbsolute) it else File(cwd, raw) }
        val mainRoot = commonFile.parentFile ?: return null
        return File(mainRoot, ".jolli/jollimemory/profile.json")
    }
}
