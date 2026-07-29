package ai.jolli.jollimemory.services

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Tests for JolliPushOrchestrator's abort-vs-collect classification.
 *
 * The two attachment loops (`pushPlanList` / `pushNoteList`) reach this predicate
 * only through a static [JolliApiClient.pushToJolli], which cannot be faked without
 * the mockk object-stubbing that `intellij/scripts/check-global-state.sh` bans in
 * new tests. So the classification is asserted directly; the loops each have
 * exactly one `isFatalPushError(e)` call site, which is what keeps the plan and
 * note paths from drifting apart.
 *
 * (Naming the banned mockk helper outright would itself trip that gate's grep,
 * which scans file contents including comments.)
 */
class JolliPushOrchestratorTest {

    @Nested
    inner class IsFatalPushError {

        @Test
        fun `binding-required and plugin-outdated abort the push`() {
            // These drive the caller's binding chooser / update prompt — collecting
            // them as a per-attachment failure would swallow the prompt.
            JolliPushOrchestrator.isFatalPushError(
                JolliApiClient.BindingRequiredError(repoUrl = "https://github.com/o/r", message = "bind first"),
            ) shouldBe true
            JolliPushOrchestrator.isFatalPushError(JolliApiClient.PluginOutdatedError("update")) shouldBe true
        }

        @Test
        fun `permission-denied aborts the push instead of becoming an attachment failure`() {
            // Repo-wide: the server's allowlist/ownership verdict refuses every doc in
            // this repo identically. Collecting it would mislabel it as `plan "X"
            // failed`, fire one doomed request per remaining attachment, and bypass the
            // panels' admin-oriented ("contact an admin") message.
            JolliPushOrchestrator.isFatalPushError(
                JolliApiClient.PermissionDeniedError("repo not allowlisted"),
            ) shouldBe true
        }

        @Test
        fun `push-disabled aborts the push instead of becoming an attachment failure`() {
            // Also repo-wide: the per-repo outbound-push opt-out (spec 306). Reaches an
            // attachment loop when the flag flips after the pre-call gate — the CLI's
            // own gate then refuses mid-push. Must keep the quiet "re-enable to push"
            // handling rather than reading as a failed attachment.
            JolliPushOrchestrator.isFatalPushError(JolliShareService.PushDisabledError()) shouldBe true
        }

        @Test
        fun `an unevaluatable push gate aborts the push`() {
            // Fail-closed and repo-wide: a gate that could not be read for this repo
            // cannot be read for the next attachment either. Not reachable from inside
            // the loops today (the gate runs at the entry points) — listed so a future
            // in-loop gate call can't silently degrade to a per-attachment failure.
            JolliPushOrchestrator.isFatalPushError(JolliShareService.PushGateUnavailableError()) shouldBe true
        }

        @Test
        fun `ordinary push failures are still collected per attachment`() {
            // The whole point of the collect path: one bad plan must not abort a push
            // whose other attachments and summary would succeed.
            JolliPushOrchestrator.isFatalPushError(RuntimeException("HTTP 500")) shouldBe false
        }

        @Test
        fun `KNOWN GAP - unauthorized is repo-wide but still takes the collect path`() {
            // Pins current behavior, NOT an endorsement. A 401 is repo-wide (every
            // remaining attachment gets the same rejection) and `CreatePrPanel`'s
            // `repoWideStopReason` already classifies it as a whole-loop stop — so this
            // is the one type the two classifiers disagree on beyond the deliberate
            // `BindingRequiredError` exception. Promoting it here means promoting
            // `NotAuthenticatedError` in vscode's `FATAL_PUSH_ERROR_NAMES` in the same
            // change; until then this test is the record that the gap is known.
            JolliPushOrchestrator.isFatalPushError(JolliApiClient.UnauthorizedError("no token")) shouldBe false
        }
    }
}
