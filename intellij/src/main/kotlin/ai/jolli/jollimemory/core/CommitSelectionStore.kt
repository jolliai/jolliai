package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject

/**
 * CommitSelectionStore — thin bridge adapter for CLI `CommitSelectionStore.ts`,
 * holding the set of sidebar items the user wants EXCLUDED from the next summary
 * pipeline run.
 *
 * Sticky semantics: an entry stays excluded until the user explicitly re-checks the
 * row. No git operation or pipeline outcome modifies it — the PostCommitHook only
 * ever READS.
 *
 * **This used to read and write `commit-selection.json` itself, and the write half
 * was silently destructive.** The file carries more than the exclusion kinds: an
 * `aiRelevance` array (the relevance ranker's verdicts) and its `changeFingerprint`
 * (what makes those verdicts still valid) live alongside them, and `skills` was
 * added as a fifth kind after this port was written. The Kotlin writer rebuilt the
 * payload field by field from the four kinds it knew about, so EVERY exclusion
 * toggle — a conversation, a plan, a note, a reference — rewrote the file without
 * the fields it had never heard of. A skill the user excluded in VS Code came back
 * and was archived onto the next commit anyway, and the ranker's work was discarded.
 * The CLI's own serializer carries those fields explicitly and says why; this had no
 * counterpart to that guard.
 *
 * Delegating fixes it by construction rather than by remembering: there is one
 * writer, in one language, and a field added to the persisted shape can no longer be
 * dropped by a host that does not know it exists. Same reason [PinStore] is a bridge
 * adapter — hand-porting the file format back here would be a regression, not an
 * optimisation.
 */
object CommitSelectionStore {

    private val log = JmLogger.create("CommitSelection")
    private val gson = Gson()

    data class CommitExclusions(
        val conversations: Set<String> = emptySet(),
        val plans: Set<String> = emptySet(),
        val notes: Set<String> = emptySet(),
        val references: Set<String> = emptySet(),
        /** Skill key `<source>:<skill>` — one entry per captured skill, not per aggregate row. */
        val skills: Set<String> = emptySet(),
    )

    /**
     * Reads every exclusion kind. Degrades to "nothing excluded" on a bridge failure,
     * which keeps a panel rendering rather than blanking it.
     *
     * The write paths below deliberately do NOT swallow — but be aware that today
     * nothing DOWNSTREAM surfaces what they throw either: every caller runs them on a
     * pooled thread with no handler (or, in `WorkingMemoryPanel`, logs and returns),
     * so a failed write reaches idea.log and nowhere else. The row is left showing the
     * state the user clicked while the store still holds the old one, until the next
     * refresh corrects it. That was near-unreachable while this wrote a local file;
     * routing it through the bridge makes ordinary causes (daemon down, CLI missing)
     * reach it. Not letting these throw would only make it quieter — the missing half
     * is feedback at the call sites, not a catch here.
     */
    fun readExclusions(projectDir: String): CommitExclusions {
        return try {
            val json = run(projectDir, request("selection-read")).asJsonObject
            CommitExclusions(
                conversations = asStringSet(json, "conversations"),
                plans = asStringSet(json, "plans"),
                notes = asStringSet(json, "notes"),
                references = asStringSet(json, "references"),
                skills = asStringSet(json, "skills"),
            )
        } catch (ex: Exception) {
            log.warn("readExclusions failed: %s", ex.message)
            CommitExclusions()
        }
    }

    fun setExcluded(projectDir: String, kind: String, key: String, excluded: Boolean) {
        run(
            projectDir,
            request("selection-set").apply {
                addProperty("kind", kind)
                addProperty("key", key)
                addProperty("excluded", excluded)
            },
        )
    }

    fun setAllExcluded(projectDir: String, kind: String, keys: List<String>, excluded: Boolean) {
        run(
            projectDir,
            request("selection-set-all").apply {
                addProperty("kind", kind)
                add("keys", JsonArray().apply { keys.forEach { add(it) } })
                addProperty("excluded", excluded)
            },
        )
    }

    /**
     * Kept local rather than routed through the bridge's `selection-key` operation:
     * it is a two-part string join that every rendered conversation row needs, so a
     * round trip per row would cost more than the format is worth. The colon is
     * reserved across jollimemory and [TranscriptSource] names never contain one, so
     * this matches the CLI's `conversationKey` exactly.
     */
    fun conversationKey(source: TranscriptSource, sessionId: String): String {
        return "${source.name}:$sessionId"
    }

    private fun request(operation: String): JsonObject = JsonObject().apply { addProperty("operation", operation) }

    private fun run(cwd: String, request: JsonObject) =
        CliIntegrations.runIdeBridge(cwd, "shared-store", gson.toJson(request))

    private fun asStringSet(json: JsonObject, key: String): Set<String> {
        val arr = json.getAsJsonArray(key) ?: return emptySet()
        return arr.mapNotNull { el ->
            try { el.asString } catch (_: Exception) { null }
        }.toSet()
    }
}
