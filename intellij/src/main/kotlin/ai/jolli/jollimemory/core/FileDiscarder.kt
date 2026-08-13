package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject

/**
 * Thin JVM adapter over the CLI-owned file-discard rules.
 *
 * One `discard-files` bridge round-trip into `cli/src/core/FileDiscardService.ts`
 * — the same code the VS Code extension runs in-process. This file must stay an
 * adapter: it serialises paths and deserialises outcomes, and decides nothing.
 *
 * Do NOT reintroduce a Kotlin dispatch here. "Which git command reverts THIS
 * file, and does it also unlink the file on disk?" is a data-model rule, and a
 * Kotlin restatement of it cannot be checked against the TypeScript one —
 * nothing on the JSON wire fails when the two disagree. The version this
 * replaced had drifted in two ways at once, both invisible: it tested untracked
 * as the raw `"??"` while every producer in this host collapses a status code to
 * ONE character, so untracked files fell through to `git checkout HEAD -- <path>`
 * and did nothing at all; and it had no case for renames or copies, which cannot
 * be reverted without the original path — a field [ai.jolli.jollimemory.services.FileChange]
 * never carried, because `getChangedFiles` discards it while parsing.
 *
 * **Send paths, not status codes.** The service reads the authoritative status
 * itself, which is what makes both of those failures structurally impossible
 * here: this host no longer has to understand porcelain columns at all.
 */
object FileDiscarder {

    private val gson: Gson = GsonBuilder().serializeNulls().create()
    private const val ACTION = "discard-files"
    private const val PREVIEW_ACTION = "discard-preview"

    /**
     * What happened to one requested path. [ok] false means the file is still
     * there and [error] says why — the caller MUST surface that rather than
     * assuming success, since the whole point of this rewrite was that a silent
     * failure looked exactly like a working button.
     */
    data class DiscardOutcome(
        val relativePath: String = "",
        val ok: Boolean = false,
        /**
         * `restored` | `unstaged-and-deleted` | `deleted` | `rename-reverted` |
         * `not-found` | `status-unavailable` | `invalid-path` | `unclassified`
         *
         * Mirrors `DiscardAction` in `cli/src/core/FileDiscardService.ts`. Display
         * only — nothing here dispatches on it, and nothing should start: the CLI
         * owns which git command a path needs. Read it WITH [ok]: on success it is
         * what happened, on failure it is what was attempted.
         *
         * Only `not-found` pairs with `ok = true`. Do not treat `status-unavailable`
         * or `invalid-path` as a quiet "already clean" — nothing ran for either.
         */
        val action: String = "",
        val error: String? = null,
        /**
         * Other repo-relative paths the discard changed on disk (a rename revert
         * restores its original path as well as removing the new one).
         *
         * These MUST be refreshed in the VFS alongside [relativePath]: the file
         * list is built from ChangeListManager, which is built from the VFS, so a
         * restored original the IDE was never told about stays invisible and the
         * row survives its own successful revert.
         *
         * NULLABLE on purpose, and it must stay that way. The CLI omits this field
         * for every outcome that is not a rename, so the absent case is the norm.
         *
         * A `= emptyList()` declaration would work TODAY and break on one unrelated
         * edit. Kotlin emits a no-arg constructor only while every parameter of
         * this class has a default; Gson prefers that constructor and applies the
         * defaults. Add one parameter without a default and the constructor is
         * gone, Gson falls back to `Unsafe.allocateInstance`, and no default runs
         * at all — every reference field lands on null, including a non-null
         * `List<String>` that then throws on first read. Nullable is correct under
         * both. Go through [touchedPaths] rather than reading it directly.
         */
        val additionalPaths: List<String>? = null,
    ) {
        /** Every path this outcome touched — what a caller has to refresh. */
        val touchedPaths: List<String> get() = listOf(relativePath) + additionalPaths.orEmpty()
    }

    private data class DiscardResponse(val outcomes: List<DiscardOutcome> = emptyList())

    /**
     * Whether discarding [relativePath] would REMOVE the file rather than restore
     * it in place. Mirrors `DiscardPreview` in `FileDiscardService.ts`.
     *
     * Every field has a default, so this class keeps the no-arg constructor Gson
     * prefers and an omitted `deletesFile` arrives as `false` — the milder verb,
     * which is the safe way to be wrong about a body we could not read. See
     * [DiscardOutcome.additionalPaths] for why that regime is a property of the
     * class and not of Gson.
     */
    data class DiscardPreview(
        val relativePath: String = "",
        val deletesFile: Boolean = false,
    )

    private data class PreviewResponse(val previews: List<DiscardPreview> = emptyList())

    /** Reported when the bridge answered with a body we cannot line up against the request. */
    private const val UNREADABLE_RESPONSE =
        "The Jolli CLI returned an unreadable discard result. Nothing was changed on disk."

    /**
     * True when an outcome carries the fields every caller reads unconditionally.
     *
     * The CLI always names the path it acted on and always sets an action, so a
     * blank [DiscardOutcome.action] means the body carried no `action` at all and
     * cannot be lined up against the request. Folding that into the same
     * "unreadable response" answer as a mismatched outcome count is what keeps it
     * from reaching a caller as an outcome whose `ok` happens to be false but
     * whose reason is empty.
     *
     * The null guards are NOT redundant even though both fields are declared
     * non-null. Gson uses this class's no-arg constructor only while every
     * parameter has a default; the day one does not, it switches to
     * `Unsafe.allocateInstance` and every reference field arrives null through a
     * non-null declaration. Kotlin inserts no check on a data-class getter, so
     * such a null escapes untyped and the first caller to reach it builds
     * `File(repoRoot, null)` and throws — on a pooled thread, OUTSIDE the try
     * that would have turned it into an error dialog, so the user gets neither
     * the discard nor a message. The parameter is nullable for the same reason:
     * a JSON `[null]` element would otherwise NPE inside the very predicate
     * meant to catch it.
     */
    private fun isWellFormed(outcome: DiscardOutcome?): Boolean {
        if (outcome == null) return false
        @Suppress("SENSELESS_COMPARISON")
        if (outcome.relativePath == null || outcome.action == null) return false
        return outcome.action.isNotEmpty()
    }

    /**
     * Reverts the working-tree changes for [relativePaths].
     *
     * [cwd] MUST come from [WorktreeRoot.of], and [relativePaths] must be relative
     * to that same root. Neither `project.basePath` (not the git root when the
     * project is opened on a subdirectory) nor the main repository of a `git
     * worktree` checkout is interchangeable with it. The CLI looks each path up in
     * the `git status` of the repository it resolves from [cwd]; a path from a
     * different space is simply absent there, so it answers `not-found` with
     * `ok = true` — the dialog appears, the user clicks Discard, and nothing happens
     * with no error anywhere. See [WorktreeRoot] for the full reasoning.
     *
     * Returns one outcome per requested path, in the order given. Never throws
     * for a per-file failure — a partial result is reported so a caller can tell
     * the user which files survived. A bridge-level failure (daemon down, CLI
     * missing) still propagates as [ai.jolli.jollimemory.bridge.CliBridgeException].
     *
     * A response we cannot line up against the request becomes one FAILED outcome
     * per path, never an empty list. The service returns exactly one outcome per
     * requested path, so a short, long, or unparseable body means we do not know
     * what happened — and callers read "no failing outcome" as success, which
     * would turn an unreadable answer into a silent no-op with a confirmation
     * dialog in front of it.
     *
     * Blocking I/O — call OFF the EDT.
     */
    fun discard(cwd: String, relativePaths: List<String>): List<DiscardOutcome> {
        if (relativePaths.isEmpty()) return emptyList()
        // A top-level bridge action (sibling of `git-exec`), so the request carries
        // only its arguments — there is no inner `operation` to dispatch on.
        val request = JsonObject().apply {
            add("relativePaths", JsonArray().apply { relativePaths.forEach { add(it) } })
        }
        val response = CliIntegrations.runIdeBridge(cwd, ACTION, gson.toJson(request))
        val outcomes = gson.fromJson(response, DiscardResponse::class.java)?.outcomes
        if (outcomes == null || outcomes.size != relativePaths.size || !outcomes.all { isWellFormed(it) }) {
            return relativePaths.map {
                DiscardOutcome(relativePath = it, ok = false, action = "", error = UNREADABLE_RESPONSE)
            }
        }
        return outcomes
    }

    /**
     * The repo-relative paths among [relativePaths] that a discard would DELETE
     * rather than restore in place — what a confirmation prompt has to word
     * itself from.
     *
     * This host cannot answer it alone, which is why it is a round trip and not a
     * local predicate. `FileChange` carries ONE collapsed status letter, and the
     * collapse is lossy exactly here: a staged deletion (`D `, which discard
     * restores) and the conflicts `DU` / `DD` (whose file it removes) all arrive
     * as `"D"`, while `UU` / `UD` (restored) and `UA` (removed) all arrive as
     * `"U"`. The panel's rows usually do not even come from git — they come from
     * `ChangeListManager`, whose `Change.Type` has no conflicted case at all, so
     * the raw columns are not recoverable here under any spelling.
     *
     * Read-only: no index, worktree or ref is written, so this runs BEFORE the
     * user has confirmed anything.
     *
     * On an unreadable or short response every path is reported as NOT deleted —
     * an EMPTY set, returned normally. That is the milder verb, and it is the right
     * way to fail here: nothing has been deleted, so promising less than happens is
     * the safe direction, and the discard itself then reports the real reason.
     *
     * Note what this does NOT do: it does not raise, so the caller's
     * [GitStatusCodes.discardDeletesFile] fallback does NOT run for these cases.
     * That fallback is reachable only when the query itself throws (transport /
     * parse failure, a host process that is down, a missing runtime) — see the
     * caller. The letter heuristic is lossy for conflicted rows, so keeping it off
     * the merely-unusable-answer path is deliberate.
     *
     * [cwd] and [relativePaths] follow the same rules as [discard] — see
     * [WorktreeRoot]. Blocking I/O; call OFF the EDT.
     */
    fun preview(cwd: String, relativePaths: List<String>): Set<String> {
        if (relativePaths.isEmpty()) return emptySet()
        val request = JsonObject().apply {
            add("relativePaths", JsonArray().apply { relativePaths.forEach { add(it) } })
        }
        val response = CliIntegrations.runIdeBridge(cwd, PREVIEW_ACTION, gson.toJson(request))
        val previews = gson.fromJson(response, PreviewResponse::class.java)?.previews
        if (previews == null || previews.size != relativePaths.size) return emptySet()
        return previews.filter { it.deletesFile }.map { it.relativePath }.toSet()
    }
}
