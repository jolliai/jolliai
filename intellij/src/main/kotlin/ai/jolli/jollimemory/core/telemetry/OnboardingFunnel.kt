package ai.jolli.jollimemory.core.telemetry

import ai.jolli.jollimemory.core.HookEnv
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StatusInfo
import com.google.gson.Gson
import java.io.File
import java.time.Instant

/**
 * OnboardingFunnel — Kotlin mirror of the CLI's `cli/src/core/OnboardingFunnel.ts`
 * behind the `onboarding_progressed` telemetry event. Keep the two in lockstep:
 * same field names, same content-free payload (booleans, one enum, a count
 * bucket — no path, repo name, URL, or key), same coarse `capture_method`
 * discriminator.
 *
 * The product question: after install, where do people stall before memories get
 * generated — the key or the repo? The checkpoints, keyed by the machine-global
 * `installId` already on every envelope: in_git_repo → repo_enabled →
 * capture_configured/capture_method → memories_generated.
 *
 * Emitted from a repo context on status refresh (see
 * `JolliMemoryService.refreshStatus`), so the snapshot carries
 * `surface="intellij"`. The CLI subprocesses the plugin spawns emit the same
 * event too, but attribute to `surface="cli"` (they inherit no client-header
 * env), so this native emit is what captures the IntelliJ surface — in
 * particular the "opened the IDE but never committed" stalled user.
 *
 * One deliberate deviation from the TS source: dedup uses a SEPARATE ledger file
 * (`onboarding-progress.intellij.json`) so the IntelliJ surface dedups
 * independently and can never desync the TS-side `onboarding-progress.json`
 * shared by the CLI and VS Code. `captureMethodOf` is otherwise a faithful port
 * of `resolveLlmCredentialSource` (including the ANTHROPIC_API_KEY env branch,
 * read through `HookEnv` per the global-state contract).
 */
object OnboardingFunnel {
    private val log = JmLogger.create("OnboardingFunnel")
    private val gson = Gson()
    private const val LEDGER_FILE = "onboarding-progress.intellij.json"
    private const val HEARTBEAT_MS = 24L * 60 * 60 * 1000

    private data class Ledger(val sig: String = "", val tsIso: String = "")

    /**
     * Collapse `resolveLlmCredentialSource` — the same decision that drives
     * generation on the CLI side — onto the funnel's coarse discriminator:
     * `local-agent` / `anthropic` (config key or env) / `jolli` (key) / `none`.
     */
    fun captureMethodOf(config: JolliMemoryConfig, env: HookEnv = HookEnv()): String =
        when (config.aiProvider) {
            "local-agent" -> "local-agent"
            "jolli" -> if (!config.jolliApiKey.isNullOrBlank()) "jolli" else "none"
            "anthropic" ->
                if (!config.apiKey.isNullOrBlank() || !env.getenv("ANTHROPIC_API_KEY").isNullOrBlank()) "anthropic"
                else "none"
            else ->
                when {
                    !config.apiKey.isNullOrBlank() || !env.getenv("ANTHROPIC_API_KEY").isNullOrBlank() -> "anthropic"
                    !config.jolliApiKey.isNullOrBlank() -> "jolli"
                    else -> "none"
                }
        }

    /**
     * Emit an onboarding snapshot for [cwd] using the just-computed [status].
     * Deduped by state tuple + a daily heartbeat, keyed on a per-repo ledger.
     * Short-circuits when telemetry is off (no config round-trip then) and never
     * throws — telemetry must never break the status refresh that triggers it.
     */
    fun maybeEmit(cwd: String, status: StatusInfo, env: HookEnv = HookEnv()) {
        try {
            if (!Telemetry.isEnabled()) return
            val inGitRepo = File(cwd, ".git").exists()
            val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
            val captureMethod = captureMethodOf(config, env)
            val captureConfigured = captureMethod != "none"
            val repoEnabled = inGitRepo && status.enabled
            val summaryCount = status.summaryCount
            val memoriesBucket = Telemetry.bucket(summaryCount)

            val sig = listOf(inGitRepo, repoEnabled, captureMethod, summaryCount > 0, memoriesBucket)
                .joinToString("|")
            val ledgerFile = File(JmLogger.getJolliMemoryDir(cwd), LEDGER_FILE)
            val prev = readLedger(ledgerFile)
            val now = System.currentTimeMillis()
            val changed = prev == null || prev.sig != sig
            val stale = prev == null || (now - parseIso(prev.tsIso)) >= HEARTBEAT_MS
            if (!changed && !stale) return

            Telemetry.track(
                "onboarding_progressed",
                mapOf(
                    "in_git_repo" to inGitRepo,
                    "repo_enabled" to repoEnabled,
                    "capture_configured" to captureConfigured,
                    "capture_method" to captureMethod,
                    "memories_generated" to (summaryCount > 0),
                    "memories_bucket" to memoriesBucket,
                ),
            )
            writeLedger(ledgerFile, Ledger(sig, Instant.ofEpochMilli(now).toString()))
        } catch (e: Exception) {
            log.warn("onboarding snapshot failed (ignored): ${e.message}")
        }
    }

    private fun readLedger(file: File): Ledger? =
        try {
            if (!file.isFile) {
                null
            } else {
                gson.fromJson(file.readText(), Ledger::class.java)
                    ?.takeIf { it.sig.isNotEmpty() && it.tsIso.isNotEmpty() }
            }
        } catch (e: Exception) {
            null
        }

    private fun writeLedger(file: File, ledger: Ledger) {
        file.parentFile?.mkdirs()
        file.writeText(gson.toJson(ledger))
    }

    /** Parse an ISO-8601 instant to epoch millis; a malformed value reads as 0 (⇒ stale ⇒ re-emit). */
    private fun parseIso(iso: String): Long =
        try {
            Instant.parse(iso).toEpochMilli()
        } catch (e: Exception) {
            0L
        }
}
