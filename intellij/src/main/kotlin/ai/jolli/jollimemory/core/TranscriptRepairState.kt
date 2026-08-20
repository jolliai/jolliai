package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject

/**
 * Thin JVM adapter over the CLI-owned transcript-repair verdict.
 *
 * One `transcript-repair-state` bridge round-trip into
 * `transcriptRepairState` (`cli/src/core/TranscriptRepair.ts`) — the same
 * predicate the VS Code extension calls in-process, and the same one the
 * dashboard's server-side render attaches to its memory detail. This file must
 * stay an adapter: it sends a commit hash and reads back a string, and decides
 * nothing.
 *
 * Do NOT reintroduce a Kotlin restatement of "can this memory's conversations
 * still be rebuilt?". That question is answered from the machine-global Claude
 * owners ledger plus the summary's own shape, and a second implementation of it
 * cannot be checked against the TypeScript one — nothing on the JSON wire fails
 * when the two disagree, so the user just gets a different sentence in the IDE
 * than on the dashboard about the same memory.
 *
 * What DOES live here is presentation: [emptyConversationsText] is the wording,
 * which is the host's job. The three sentences are duplicated across THREE
 * rendering surfaces — this Kotlin copy, the dashboard webview
 * (assets/js/memories.js) and the VS Code editor webview
 * (SummaryScriptBuilder.ts) — because each host draws that panel itself and they
 * share no code here. TranscriptRepairWordingLockstep.test.ts is the forcing
 * function that holds them together: it pins the canonical triple and fails if
 * any surface drifts OR misroutes a guarded sentence to the wrong state, so a
 * reword means updating that pinned triple AND all three surfaces in one change.
 * (The CLI doctor --repair-transcripts output is NOT one of them: it prints its
 * own operator-facing wording, not these sentences.)
 */
object TranscriptRepairState {

    private val gson: Gson = GsonBuilder().serializeNulls().create()
    private const val ACTION = "transcript-repair-state"

    /**
     * The CLI's `TranscriptRepairState` union, as it arrives on the wire.
     *
     * `state` has a default, so this class keeps the no-arg constructor Gson
     * prefers and an omitted field arrives as [UNREPAIRABLE] — the mildest
     * verdict, which is the safe way to be wrong about a body we could not read.
     * See `FileDiscarder.DiscardOutcome.additionalPaths` for why that regime is
     * a property of the class rather than of Gson.
     */
    private data class StateResponse(val state: String = UNREPAIRABLE)

    const val PRESENT: String = "present"
    const val REPAIRED: String = "repaired"
    const val REPAIRABLE: String = "repairable"
    const val UNREPAIRABLE: String = "unrepairable"

    /**
     * The webview message `SummaryPanel`'s deferred hydrate posts to correct the
     * empty-Conversations sentence in place, and the command
     * `SummaryScriptBuilder`'s handler matches on.
     *
     * A cross-language name with no compiler between its two ends: rename it on
     * one side only and the hydrate silently stops arriving, leaving the
     * server-rendered plainest sentence on a memory that deserved a different
     * one. Pinned from both directions — the producer goes through
     * [hydrateMessage] rather than spelling the string, and
     * `SummaryScriptBuilderTest` asserts the handler still carries this literal.
     */
    const val HYDRATE_COMMAND: String = "conversationsEmptyText"

    /** Payload key of [hydrateMessage] — the SENTENCE, not the state. */
    const val HYDRATE_TEXT_KEY: String = "text"

    /**
     * The hydrate message for [state], or null when there is nothing to correct.
     *
     * Null in, null out: a verdict that has not been fetched yet is exactly what
     * the server-rendered HTML already prints, so posting would be a no-op that
     * still costs a `executeJavaScript` round trip.
     *
     * Carries the SENTENCE rather than the state, so the three strings live in
     * one place instead of being restated in the webview's JS where nothing
     * would notice a drift.
     */
    fun hydrateMessage(state: String?): Pair<String, Map<String, Any>>? =
        state?.let { HYDRATE_COMMAND to mapOf(HYDRATE_TEXT_KEY to emptyConversationsText(it)) }

    /**
     * Which of spec §9's three sentences this memory's EMPTY conversations panel
     * is allowed to print.
     *
     * Every failure answers [UNREPAIRABLE], and none of them raises: an
     * unreadable body, a null state, a bridge that is down, a missing runtime.
     * "Repair may still be possible" is the one wrong direction to guess in — it
     * invites a repair that has nothing to work from — and a memory tab must not
     * fail to open over a wording detail. Same rule, same reason, as
     * `FileDiscarder.preview` returning an empty set.
     *
     * Blocking I/O — call OFF the EDT.
     */
    fun fetch(cwd: String, commitHash: String): String {
        if (cwd.isEmpty() || commitHash.isEmpty()) return UNREPAIRABLE
        val request = JsonObject().apply { addProperty("commitHash", commitHash) }
        return try {
            val response = CliIntegrations.runIdeBridge(cwd, ACTION, gson.toJson(request))
            val state = gson.fromJson(response, StateResponse::class.java)?.state
            @Suppress("SENSELESS_COMPARISON")
            if (state == null || state.isEmpty()) UNREPAIRABLE else state
        } catch (_: Exception) {
            UNREPAIRABLE
        }
    }

    /**
     * The sentence for [state]. Verbatim from spec §9 and identical on the CLI
     * dashboard, the VS Code memory detail and here.
     *
     * Anything unrecognised — a null this build never fetched, [PRESENT] on a
     * legacy summary that reads as captured while holding nothing, a state a
     * newer CLI added — falls to the plainest wording. The copy this replaced
     * ("No conversation transcripts saved for this commit") read as a *not yet*,
     * which is misleading for a capture that already failed and will never
     * complete on its own.
     */
    fun emptyConversationsText(state: String?): String = when (state) {
        REPAIRABLE -> "Conversation capture is missing but repair may still be possible"
        REPAIRED -> "Conversation capture was repaired from local transcript history"
        else -> "No conversations were captured for this memory"
    }
}
