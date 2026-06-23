package ai.jolli.jollimemory.core.telemetry

import java.net.URI
import java.security.MessageDigest
import java.time.Instant

/**
 * Telemetry — the single `track()` choke-point for the IntelliJ plugin
 * (JOLLI-1785 Phase 3). Independent Kotlin implementation that produces the
 * same wire contract as the CLI/VS Code client (event names, envelope shape,
 * UUID installId, `command` not `name`, content-free scrubbed properties).
 *
 *   - `track()` never throws and is cheap: all setup (config, installId,
 *     origin→env) happens once in `init()` and is cached; the hot path stamps a
 *     timestamp, scrubs, and appends one buffer line.
 *   - No-op until `init()` runs or when consent resolved to off.
 *   - `surface` is fixed to "intellij"; `surfaceVersion` is the plugin version.
 */
object Telemetry {
    const val SCHEMA_VERSION = 1
    private const val MAX_STRING_LEN = 120
    private const val MAX_DEPTH = 4

    private val ALWAYS_DROP_KEYS =
        setOf(
            "token", "secret", "password", "passwd", "apikey", "api_key", "jolliapikey",
            "authtoken", "auth_token", "accesstoken", "access_token", "refreshtoken",
            "refresh_token", "cookie", "credential", "credentials",
        )

    private data class Context(
        val enabled: Boolean,
        val cwd: String,
        val installId: String,
        val sessionId: String?,
        val surfaceVersion: String,
        val env: String,
    )

    @Volatile
    private var context: Context? = null

    /**
     * Resolve and cache the telemetry context. `telemetryFlag` + `platformDisabled`
     * feed the consent gate; `origin` (key tenant URL or jolliUrl) maps to `env`.
     */
    fun init(
        cwd: String,
        installId: String,
        surfaceVersion: String,
        sessionId: String? = null,
        origin: String? = null,
        telemetryFlag: String? = null,
        platformDisabled: Boolean = false,
        env: Map<String, String> = System.getenv(),
    ) {
        val consent = TelemetryConsent.resolve(telemetryFlag, env, platformDisabled)
        context =
            Context(
                enabled = consent.enabled,
                cwd = cwd,
                installId = installId,
                sessionId = sessionId,
                surfaceVersion = surfaceVersion,
                env = resolveEnv(origin),
            )
    }

    /**
     * Refresh only the cached `env` from a freshly-resolved origin — e.g. after
     * sign-in changes the tenant — preserving cwd / installId / consent. No-op
     * when uninitialized.
     */
    fun refreshEnv(origin: String?) {
        context = context?.copy(env = resolveEnv(origin))
    }

    /** Tear down the cached context (tests / shutdown). */
    fun shutdown() {
        context = null
    }

    fun isInitialized(): Boolean = context != null

    /** True only when telemetry is initialized AND consent resolved to on. */
    fun isEnabled(): Boolean = context?.enabled == true

    /** Record one event. No-op when uninitialized or opted out. Never throws. */
    fun track(eventName: String, properties: Map<String, Any?> = emptyMap()) {
        val ctx = context ?: return
        if (!ctx.enabled) return
        if (!TelemetryEvents.isTelemetryEventName(eventName)) return
        try {
            val envelope =
                TelemetryEnvelope(
                    schemaVersion = SCHEMA_VERSION,
                    eventName = eventName,
                    surface = "intellij",
                    surfaceVersion = ctx.surfaceVersion,
                    installId = ctx.installId,
                    sessionId = ctx.sessionId,
                    os = System.getProperty("os.name") ?: "unknown",
                    arch = System.getProperty("os.arch") ?: "unknown",
                    runtimeVersion = "jvm-${System.getProperty("java.version") ?: "unknown"}",
                    env = ctx.env,
                    tsIso = Instant.now().toString(),
                    // Always null from the client; the backend attributes account_id
                    // from the Bearer key at ingest time.
                    accountId = null,
                    properties = scrubProperties(properties),
                )
            TelemetryBuffer.append(ctx.cwd, envelope)
        } catch (_: Exception) {
            // Telemetry must never break product code.
        }
    }

    // ─────────────────────────── helpers ───────────────────────────

    enum class Bucket(val label: String) {
        ZERO("0"),
        ONE_TO_FIVE("1-5"),
        SIX_TO_TWENTY("6-20"),
        TWENTYONE_TO_HUNDRED("21-100"),
        HUNDRED_PLUS("100+"),
    }

    /** Map a raw count to a coarse bucket label. Non-positive → "0". */
    fun bucket(n: Int): String =
        when {
            n <= 0 -> Bucket.ZERO.label
            n <= 5 -> Bucket.ONE_TO_FIVE.label
            n <= 20 -> Bucket.SIX_TO_TWENTY.label
            n <= 100 -> Bucket.TWENTYONE_TO_HUNDRED.label
            else -> Bucket.HUNDRED_PLUS.label
        }

    /** Coarse query-length bucket — never the query text. */
    fun queryLenBucket(query: String): String =
        when {
            query.length < 20 -> "short"
            query.length < 80 -> "medium"
            else -> "long"
        }

    /**
     * Salted SHA-256 hash, hex-truncated — for a stable-but-anonymous id. Never raw.
     * The separator is a NUL byte (U+0000), matching the CLI/VS Code `saltedHash`
     * so the same (value, salt) hashes identically across all three surfaces.
     */
    fun saltedHash(value: String, salt: String, length: Int = 12): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("$salt\u0000$value".toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(length)
    }

    /** Derive `env` from the resolved jolli origin via the host allowlist. */
    fun resolveEnv(origin: String?): String {
        if (origin.isNullOrEmpty()) return "unknown"
        val host =
            try {
                URI(origin).host?.lowercase()
            } catch (_: Exception) {
                null
            } ?: return "unknown"
        fun matches(h: String) = host == h || host.endsWith(".$h")
        return when {
            matches("jolli-local.me") -> "local"
            matches("jolli.dev") -> "dev"
            matches("jolli.cloud") -> "preview"
            matches("jolli.ai") -> "prod"
            else -> "unknown"
        }
    }

    /** Client-side scrub: redact content-shaped strings, drop secret keys, bound depth. */
    fun scrubProperties(properties: Map<String, Any?>): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return scrubValue(properties, 0) as Map<String, Any?>
    }

    private fun scrubValue(value: Any?, depth: Int): Any? {
        if (depth > MAX_DEPTH) return "[redacted:deep]"
        return when (value) {
            null -> null
            is Boolean -> value
            is Number -> if (value.toDouble().isFinite()) value else null
            is String -> redactString(value)
            is Map<*, *> -> {
                val out = LinkedHashMap<String, Any?>()
                for ((k, v) in value) {
                    val key = k.toString()
                    if (ALWAYS_DROP_KEYS.contains(key.lowercase())) continue
                    // Redact the KEY too, not just the value: a content-derived dynamic
                    // key (path/email/repo name) would otherwise leak verbatim.
                    out[redactString(key)] = scrubValue(v, depth + 1)
                }
                out
            }
            is Iterable<*> -> value.map { scrubValue(it, depth + 1) }
            else -> "[redacted:type]"
        }
    }

    private fun redactString(s: String): String {
        if (s.length > MAX_STRING_LEN) return "[redacted:long]"
        // Word-boundary anchored (not start-anchored) so a token embedded mid-message
        // is still redacted, while an unrelated word (e.g. "task-force") is not.
        if (Regex("\\b(sk-|ghp_|gho_|ghs_|github_pat_|xox[baprs]-)").containsMatchIn(s) || s.contains("-----BEGIN")) {
            return "[redacted:secret]"
        }
        if (Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+").containsMatchIn(s)) return "[redacted:email]"
        if (s.contains("://")) return "[redacted:url]"
        if (Regex("^~[/\\\\]").containsMatchIn(s) || Regex("[A-Za-z0-9._-][/\\\\][A-Za-z0-9._-]").containsMatchIn(s)) {
            return "[redacted:path]"
        }
        return s
    }
}
