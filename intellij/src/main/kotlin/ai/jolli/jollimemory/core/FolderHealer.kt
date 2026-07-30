package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.JsonObject
import java.nio.file.Path

/**
 * FolderHealer — Kotlin bridge caller for the CLI's
 * `folder-heal-visible-markdown` ide-bridge action.
 *
 * Mirrors what VS Code's `KbFoldersService` runs on every KB tree listing:
 * for each discovered repo, regenerate any `<branch>/<slug>.md` files that
 * disappeared from disk while their canonical `<kbRoot>/.jolli/summaries/
 * <hash>.json` counterpart is still there. Without this step the IntelliJ
 * KBExplorer tree silently loses rows whenever the user (or a stray editor)
 * deletes a Markdown file — the manifest still has the entry, but the tree
 * walk skips it because the file is gone.
 *
 * ── OWNERSHIP ────────────────────────────────────────────────────────────
 * Heal WRITES files. That side effect stays in the CLI (in `FolderStorage.
 * healMissingVisibleMarkdown`) so the ".md render from summary JSON" logic
 * has one implementation and dual-write / atomicWrite discipline is enforced
 * uniformly. This Kotlin object is a thin adapter: DTO in, DTO out, no
 * decisions of its own.
 *
 * ── ERROR POLICY ─────────────────────────────────────────────────────────
 * Fail soft. Any bridge exception (daemon crash, protocol mismatch, CLI
 * error) yields an empty [Result] with `error` populated. Callers treat that
 * the same as "no heal happened this pass" and rely on the next tree
 * refresh to try again — never propagate the exception to the EDT.
 *
 * ── THREADING ────────────────────────────────────────────────────────────
 * Off-EDT. The bridge call can hit the one-shot Node spawn path (~500 ms)
 * when the daemon is not yet up; and the heal itself scans + writes disk.
 * All callers wrap the invocation in `executeOnPooledThread`.
 */
object FolderHealer {
    private val gson = Gson()

    /**
     * Result of one heal pass. Mirrors [HealResult] from
     * `cli/src/core/StorageProvider.ts`. Kept as a Kotlin record so the
     * numeric counts survive the JSON round-trip cleanly.
     */
    data class Result(
        val healed: Int = 0,
        val skipped: Int = 0,
        val failed: Int = 0,
        val droppedIds: List<String> = emptyList(),
        val error: String? = null,
    ) {
        /** True when the pass changed nothing — cache-friendly ("cleanRepos") flag. */
        fun isClean(): Boolean = healed == 0 && failed == 0 && error == null
    }

    /**
     * Runs the heal pass against [kbRoot] over the ide bridge. `dropOrphans`
     * defaults to false — the sidebar caller MUST leave it false because it
     * can't tell whether the repo is on folder-only storage (see HealOptions
     * doc in StorageProvider.ts). The explicit `jolli heal-folder` CLI is the
     * only surface that opts in.
     */
    fun healVisibleMarkdown(kbRoot: Path, dropOrphans: Boolean = false): Result {
        val request = JsonObject().apply {
            addProperty("kbRoot", kbRoot.toString())
            if (dropOrphans) addProperty("dropOrphanedManifestEntries", true)
        }
        return try {
            // projectDir routes to the correct daemon instance; the heal scope
            // is determined by kbRoot in the request JSON, not by projectDir.
            val element = CliIntegrations.runIdeBridge(
                projectDir = CliIntegrations.resolveDefaultCwd(),
                action = "folder-heal-visible-markdown",
                requestJson = gson.toJson(request),
            )
            gson.fromJson(element, Result::class.java) ?: Result()
        } catch (e: Exception) {
            Result(error = e.message ?: e.javaClass.simpleName)
        }
    }
}
