package ai.jolli.jollimemory.core.telemetry

/**
 * TelemetryConsent — opt-out gate for IntelliJ telemetry (JOLLI-1785 Phase 3).
 * Independent Kotlin implementation; matches the CLI/VS Code consent model so a
 * machine reads one consistent state. Telemetry is ON by default, silenced when
 * the user said no through any channel, in order of authority:
 *
 *   1. `DO_NOT_TRACK` env var (https://consoledonottrack.com): set & not "0".
 *   2. A host opt-out — the JetBrains data-sharing decline, when the startup
 *      wiring resolves it (passed in as `platformDisabled`; the consent core
 *      stays platform-agnostic and testable).
 *   3. The shared `telemetry: "off"` flag in ~/.jolli/jollimemory/config.json.
 */
object TelemetryConsent {
    enum class Reason { ON, DO_NOT_TRACK, PLATFORM_OFF, CONFIG_OFF }

    data class Result(val enabled: Boolean, val reason: Reason)

    /** Resolve the effective consent state and the reason behind it. */
    fun resolve(
        telemetryFlag: String?,
        env: Map<String, String> = System.getenv(),
        platformDisabled: Boolean = false,
    ): Result {
        if (doNotTrackSet(env)) return Result(false, Reason.DO_NOT_TRACK)
        if (platformDisabled) return Result(false, Reason.PLATFORM_OFF)
        if (telemetryFlag == "off") return Result(false, Reason.CONFIG_OFF)
        return Result(true, Reason.ON)
    }

    fun isEnabled(
        telemetryFlag: String?,
        env: Map<String, String> = System.getenv(),
        platformDisabled: Boolean = false,
    ): Boolean = resolve(telemetryFlag, env, platformDisabled).enabled

    /** Show the loud first-run notice once — only when enabled and not yet shown. */
    fun shouldShowNotice(
        noticeShown: Boolean,
        telemetryFlag: String?,
        env: Map<String, String> = System.getenv(),
        platformDisabled: Boolean = false,
    ): Boolean = !noticeShown && isEnabled(telemetryFlag, env, platformDisabled)

    private fun doNotTrackSet(env: Map<String, String>): Boolean {
        val v = env["DO_NOT_TRACK"]?.trim() ?: return false
        return v.isNotEmpty() && v != "0"
    }
}
