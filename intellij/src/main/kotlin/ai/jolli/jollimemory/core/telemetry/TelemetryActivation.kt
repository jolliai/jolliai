package ai.jolli.jollimemory.core.telemetry

import ai.jolli.jollimemory.auth.JolliUrlConfig
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliApiClient

/**
 * TelemetryActivation — IntelliJ glue between the plugin lifecycle and the
 * telemetry core (JOLLI-1785 Phase 3). Resolves everything `Telemetry.init`
 * needs and exposes a flush hook. Never throws — telemetry must never disturb
 * plugin startup, sign-in, or the UI tick.
 *
 * `installId` + the `telemetry` opt-out flag come from the SHARED config.json
 * (machine-global, cross-surface); `jolliApiKey` / origin come from the plugin's
 * own config. Origin → env via the host allowlist.
 */
object TelemetryActivation {
    /**
     * Bootstrap telemetry for this plugin instance. Mints the installId (fires
     * `app_installed` once per machine) and primes the track() context. Returns
     * true when the loud first-run notice should be shown (caller shows it, then
     * calls `TelemetrySharedConfig.markNoticeShown()`).
     *
     * `platformDisabled` defaults to the IDE's data-sharing decision
     * (`JetBrainsConsent`), so telemetry follows the JetBrains "Send usage
     * statistics" setting unless the caller overrides it (tests).
     */
    fun bootstrap(cwd: String, platformDisabled: Boolean = JetBrainsConsent.isUsageStatsDenied()): Boolean {
        return try {
            val (installId, created) = TelemetrySharedConfig.getOrCreateInstallId()
            val telemetryFlag = TelemetrySharedConfig.telemetryFlag()
            Telemetry.init(
                cwd = cwd,
                installId = installId,
                surfaceVersion = JolliApiClient.pluginVersion,
                origin = resolveOrigin(),
                telemetryFlag = telemetryFlag,
                platformDisabled = platformDisabled,
            )
            if (created) Telemetry.track("app_installed")
            TelemetryConsent.shouldShowNotice(
                noticeShown = TelemetrySharedConfig.noticeShown(),
                telemetryFlag = telemetryFlag,
                platformDisabled = platformDisabled,
            )
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Re-resolve `env` from the current config and update the live telemetry
     * context. Call after sign-in saves a new key so the `signin_completed`
     * conversion event carries the new tenant's env, not the startup origin's.
     * Never throws.
     */
    fun refreshEnv() {
        try {
            Telemetry.refreshEnv(resolveOrigin())
        } catch (_: Exception) {
            // best-effort
        }
    }

    /** Resolve origin + key from config and flush the buffer once. Never throws. */
    fun flushNow(cwd: String) {
        try {
            // Re-gate consent at flush time, not just at track() time: a user who
            // opted out (config "off" / DO_NOT_TRACK / IDE data-sharing off) after
            // events were buffered must not have them uploaded — drop them instead.
            val enabled =
                TelemetryConsent.isEnabled(
                    telemetryFlag = TelemetrySharedConfig.telemetryFlag(),
                    platformDisabled = JetBrainsConsent.isUsageStatsDenied(),
                )
            if (!enabled) {
                TelemetryBuffer.clear(cwd)
                return
            }
            val jolliApiKey = SessionTracker.loadConfig().jolliApiKey
            TelemetryFlusher.flush(cwd, origin = resolveOrigin(jolliApiKey), jolliApiKey = jolliApiKey)
        } catch (e: Exception) {
            // best-effort — but log it (JOLLI-1966): a silently-swallowed flush
            // failure made a delivery outage impossible to diagnose.
            ai.jolli.jollimemory.core.JmLogger.create("TelemetryActivation")
                .warn("flushNow failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** A signed-in key's tenant origin wins; else the configured jolli URL. */
    private fun resolveOrigin(jolliApiKey: String? = SessionTracker.loadConfig().jolliApiKey): String? {
        if (jolliApiKey != null) {
            JolliApiClient.parseJolliApiKey(jolliApiKey)?.let { return it.u }
        }
        return try {
            JolliUrlConfig.getJolliUrl()
        } catch (_: Exception) {
            null
        }
    }
}
