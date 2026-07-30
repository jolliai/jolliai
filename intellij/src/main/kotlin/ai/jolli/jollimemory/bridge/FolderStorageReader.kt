package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.Gson
import java.io.File

/**
 * Read-only accessor for the local Memory Bank folder written by the CLI's
 * [FolderStorage](cli/src/core/FolderStorage.ts).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 * IntelliJ's default read path forwards every summary / plan / note read
 * through `runIdeBridge` → Node CLI → git plumbing. Each hop is 5-20 ms hot,
 * 500-2000 ms cold. VS Code has no such gap because it reads the JSON
 * files under `.jolli/` directly with `readFileSync` (microseconds, hits
 * the OS page cache). This reader is the Kotlin counterpart of that path.
 *
 * ── LOCKSTEP CONTRACT ────────────────────────────────────────────────────
 * The hidden `.jolli/` layout is defined by the CLI's `FolderStorage.ts`.
 * File paths, folder names, and JSON schemas here MUST match what that
 * writer emits. AGENTS.md ("Critical rules") registers this pair; a
 * schema-touching change to FolderStorage.ts must edit this file in the
 * same PR. See the header comment on `cli/src/core/FolderStorage.ts`.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────────
 * READ ONLY. Never writes anywhere on disk — dual-write consistency is
 * the CLI's job, and reintroducing a Kotlin writer would fork the schema
 * decision. Also: fails soft. Every method returns null on any I/O or
 * parse error so callers can fall back to the orphan-branch path.
 */
class FolderStorageReader private constructor(private val kbRoot: File) {

    private val log = JmLogger.create("FolderStorageReader")

    private val summariesDir = File(kbRoot, ".jolli/summaries")
    private val plansDir = File(kbRoot, ".jolli/plans")
    private val notesDir = File(kbRoot, ".jolli/notes")
    private val shadowStatusFile = File(kbRoot, ".jolli/shadow-status.json")

    /** True if the hidden `.jolli/summaries` directory exists (dual-write
     *  is active for this repo). Callers use this at construction time and
     *  the reader is never handed out otherwise. */
    fun isReady(): Boolean = summariesDir.isDirectory

    /**
     * True if the CLI's `DualWriteStorage` recorded a swallowed shadow-write
     * failure and hasn't cleared it yet. Presence of the marker file is the
     * contract: the CLI writes `.jolli/shadow-status.json` in `markDirty` and
     * unlinks it in `clearDirty` (see cli/src/core/FolderStorage.ts).
     *
     * Every read method below short-circuits when this returns true so callers
     * fall back to the orphan-branch path — the folder mirror is a best-effort
     * cache, the branch is the system of record. Without this, an amend or
     * squash whose shadow write failed would keep serving the pre-write summary
     * for the rest of the session with no user-visible warning.
     */
    fun isDirty(): Boolean = shadowStatusFile.isFile

    /**
     * Defense-in-depth path-containment check: `File(dir, "$name.ext")` happily
     * builds a path OUTSIDE `dir` when `name` contains `..` or absolute-path
     * separators. All three read paths below take a caller-supplied name
     * (commit hash / slug / id) that today comes from git listings or the
     * CLI's slugified writes — but a crafted orphan-branch summary landing a
     * plan/note with `slug=".."` or a symlink pointing outside could otherwise
     * read arbitrary files. Falls back to the orphan-branch path (which is
     * stored in git object DB — un-escapable) if this returns false. The git
     * fallback is why we can be strict here without breaking anything.
     */
    private fun File.isSafelyWithin(parent: File): Boolean {
        return try {
            val childCanon = this.canonicalPath
            val parentCanon = parent.canonicalPath
            childCanon.startsWith(parentCanon + File.separator)
        } catch (_: Exception) {
            false
        }
    }

    fun getSummary(commitHash: String): CommitSummary? {
        if (isDirty()) return null
        val file = File(summariesDir, "$commitHash.json")
        if (!file.isSafelyWithin(summariesDir) || !file.isFile) return null
        return try {
            // Gson bypasses the primary constructor via reflection, so a `{}` body
            // yields a CommitSummary whose non-null Kotlin fields (commitHash,
            // commitMessage, …) are actually null at runtime. That would satisfy
            // fromJson without throwing and slip past the fail-soft contract the
            // class docstring promises, shadowing the orphan-branch fallback.
            //
            // The `?: return null` catches an outright null result (Gson returns
            // null for the JSON literal "null"). Reading commitHash on a
            // constructor-bypass instance where the field is actually null
            // trips Kotlin's Intrinsics NPE — caught below and translated into
            // the same fall-through as any other parse failure. `.isBlank()`
            // catches the explicit-empty-string case the same way.
            val parsed = gson.fromJson(file.readText(Charsets.UTF_8), CommitSummary::class.java) ?: return null
            if (parsed.commitHash.isBlank()) null else parsed
        } catch (e: Exception) {
            log.debug("getSummary(%s): parse failed: %s", commitHash.take(8), e.message ?: "")
            null
        }
    }

    fun getSummaryJson(commitHash: String): String? {
        if (isDirty()) return null
        val file = File(summariesDir, "$commitHash.json")
        if (!file.isSafelyWithin(summariesDir) || !file.isFile) return null
        return try { file.readText(Charsets.UTF_8) } catch (_: Exception) { null }
    }

    fun readPlanBody(slug: String): String? {
        if (isDirty()) return null
        val file = File(plansDir, "$slug.md")
        if (!file.isSafelyWithin(plansDir) || !file.isFile) return null
        return try { file.readText(Charsets.UTF_8) } catch (_: Exception) { null }
    }

    fun readNoteBody(id: String): String? {
        if (isDirty()) return null
        val file = File(notesDir, "$id.md")
        if (!file.isSafelyWithin(notesDir) || !file.isFile) return null
        return try { file.readText(Charsets.UTF_8) } catch (_: Exception) { null }
    }

    companion object {
        /** Thread-safe; shared across all reader instances (one per project). */
        private val gson = Gson()

        /**
         * Constructs a reader if [kbRootPath] resolves to a Memory Bank folder
         * whose hidden layer is populated AND the active [storageMode] actually
         * writes to that folder. Returns null when the folder is missing, empty,
         * unreadable, OR when writes bypass it ("orphan" mode) — callers fall
         * back to the orphan-branch path in that case.
         *
         * The storageMode gate matters because a repo can toggle to
         * `storageMode = "orphan"` at any time via `jolli configure --set`
         * (see `Types.ts` UserConfig): the on-disk folder from a previous
         * dual-write session is still there, but every subsequent amend /
         * squash / new commit writes only to the orphan branch. Without this
         * gate the reader would happily serve pre-toggle JSON for the rest of
         * the session, silently shadowing the fresh orphan-branch data.
         *
         * `null` / `"dual-write"` / `"folder"` all resolve to a live reader
         * (dual-write is the default when [storageMode] is unset).
         */
        fun forRoot(kbRootPath: String?, storageMode: String? = null): FolderStorageReader? {
            if (kbRootPath.isNullOrBlank()) return null
            if (storageMode == "orphan") return null
            val root = File(kbRootPath)
            if (!root.isDirectory) return null
            val reader = FolderStorageReader(root)
            return reader.takeIf { it.isReady() }
        }
    }
}
