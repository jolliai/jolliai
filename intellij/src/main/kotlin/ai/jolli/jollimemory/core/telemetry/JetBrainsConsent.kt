package ai.jolli.jollimemory.core.telemetry

/**
 * JetBrainsConsent — reads the IDE's "Send usage statistics" / data-sharing
 * consent so jollimemory telemetry follows the JetBrains default (JOLLI-1785):
 * if the user declined usage-stats sharing in the IDE, we treat telemetry as
 * platform-disabled.
 *
 * Uses reflection on `com.intellij.ide.gdpr.ConsentOptions` so the plugin
 * compiles and runs across IDE SDK versions and **degrades gracefully** — any
 * error (API absent/renamed, no running application, headless worker JVM)
 * returns `false` (not-denied), leaving our own `telemetry` opt-out flag in
 * charge rather than wrongly suppressing everything.
 */
object JetBrainsConsent {
    /** True only when the IDE user has explicitly DECLINED usage-statistics sharing. */
    fun isUsageStatsDenied(): Boolean =
        try {
            val consentOptions = Class.forName("com.intellij.ide.gdpr.ConsentOptions")
            val instance = consentOptions.getMethod("getInstance").invoke(null)
            // ConsentOptions.isSendingUsageStatsAllowed(): ThreeState (YES / NO / UNSURE)
            val state = consentOptions.getMethod("isSendingUsageStatsAllowed").invoke(instance)
            state?.toString() == "NO"
        } catch (_: Throwable) {
            false
        }
}
