package ai.jolli.jollimemory.core.telemetry

import ai.jolli.jollimemory.services.JolliApiClient
import com.google.gson.JsonParser
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.MessageDigest
import java.time.Duration

/**
 * TelemetryFlusher — drains the on-disk buffer to the jolli backend
 * (JOLLI-1785 Phase 3). Batched, fire-and-forget, best-effort:
 *
 *   - POSTs `{ "events": [<raw line>, …] }` to `<origin>/api/telemetry/events`
 *     in chunks of at most `maxBatch`. Sends the buffer's raw JSON lines
 *     verbatim (no re-serialize) so the wire bytes match what was recorded.
 *   - Anonymous vs signed-in: a decodable `jolliApiKey` is sent as
 *     `Authorization: Bearer …` and the request targets the key's tenant origin
 *     (the backend decodes account_id from the key; the endpoint is mounted
 *     before tenant middleware, so anonymous requests with no key are accepted).
 *   - Never throws; a non-2xx / network error stops the drain and leaves the
 *     un-acked events for next time. Only the ring cap ever discards. The
 *     post-send rewrite re-reads and drops only the leading `sent` lines, so
 *     events appended during the flush survive.
 *
 * The HTTP sender is injectable so the flush logic is unit-testable without a
 * live backend.
 */
object TelemetryFlusher {
    const val DEFAULT_MAX_BATCH = 100
    private const val TELEMETRY_PATH = "/api/telemetry/events"
    private val TIMEOUT: Duration = Duration.ofSeconds(10)
    private val UUID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

    // JOLLI-1966 diagnostics: the flush path is otherwise silent, so a delivery
    // outage is invisible. Log the resolved target + per-batch HTTP status.
    private val log = ai.jolli.jollimemory.core.JmLogger.create("TelemetryFlusher")

    data class FlushResult(val sent: Int, val remaining: Int)

    /** Sends a batch body to `url` with an optional Bearer token; returns true on 2xx. */
    fun interface Sender {
        fun send(url: String, body: String, bearer: String?): Boolean
    }

    private val httpClient: HttpClient by lazy { HttpClient.newBuilder().connectTimeout(TIMEOUT).build() }

    private val defaultSender =
        Sender { url, body, bearer ->
            try {
                val builder =
                    HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .timeout(TIMEOUT)
                        .header("Content-Type", "application/json")
                        .header("x-jolli-client", "intellij-plugin/${JolliApiClient.pluginVersion}")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                if (bearer != null) builder.header("Authorization", "Bearer $bearer")
                val response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.discarding())
                val ok = response.statusCode() in 200..299
                log.info("telemetry POST $url -> HTTP ${response.statusCode()} (bearer=${bearer != null}, ok=$ok)")
                ok
            } catch (e: Exception) {
                log.warn("telemetry POST $url threw ${e.javaClass.simpleName}: ${e.message}")
                false
            }
        }

    fun flush(
        cwd: String,
        origin: String?,
        jolliApiKey: String? = null,
        maxBatch: Int = DEFAULT_MAX_BATCH,
        sender: Sender = defaultSender,
    ): FlushResult {
        // Resolve target origin + optional bearer. A signed-in key targets its
        // own tenant origin; an undecodable key falls back to anonymous.
        var resolvedOrigin = origin
        var bearer: String? = null
        if (jolliApiKey != null) {
            val meta = JolliApiClient.parseJolliApiKey(jolliApiKey)
            if (meta != null) {
                resolvedOrigin = meta.u
                bearer = jolliApiKey
            }
        }

        val lines = TelemetryBuffer.readLines(cwd).map { ensureEventIdLine(it) }
        if (lines.isEmpty()) return FlushResult(0, 0)
        log.info("telemetry flush: ${lines.size} buffered, resolvedOrigin=$resolvedOrigin, bearer=${bearer != null}")
        if (resolvedOrigin.isNullOrEmpty()) {
            log.warn("telemetry flush: no origin resolved — ${lines.size} events stranded")
            return FlushResult(0, lines.size)
        }

        // Defense-in-depth: never POST telemetry (or a Bearer key) to a non-Jolli
        // host. The flusher re-derives origin from raw config, so re-assert the
        // HTTPS + allowlist boundary here (parity with the CLI flusher).
        try {
            ai.jolli.jollimemory.auth.JolliAuthUtils.assertJolliOriginAllowed(resolvedOrigin)
        } catch (e: Exception) {
            log.warn("telemetry flush: origin rejected by allowlist ($resolvedOrigin): ${e.message}")
            return FlushResult(0, lines.size)
        }

        val url =
            try {
                // Absolute-path resolve drops any tenant path on the key origin,
                // posting to the root-mounted telemetry route.
                URI(resolvedOrigin).resolve(TELEMETRY_PATH).toString()
            } catch (_: Exception) {
                return FlushResult(0, lines.size)
            }

        // Group by install_id before batching: the backend rejects a batch that
        // mixes install_ids with 400 ("batch must carry a single install_id"). If
        // the buffer holds >1 install_id — e.g. after an install_id rotation leaves
        // a stray event from a prior install — count-only batching puts both in one
        // batch and that 400 permanently jams delivery for EVERY event. Grouping
        // keeps each batch homogeneous; a failing group is skipped without blocking
        // the others, so one poisoned install_id can't strand the rest.
        val groups = LinkedHashMap<String, MutableList<String>>()
        for (line in lines) groups.getOrPut(installIdOf(line)) { mutableListOf() }.add(line)

        val batchSize = maxOf(1, maxBatch)
        val acked = ArrayList<String>()
        for (group in groups.values) {
            var i = 0
            while (i < group.size) {
                val batch = group.subList(i, minOf(i + batchSize, group.size))
                val body = """{"events":[${batch.joinToString(",")}]}"""
                // A failed batch stops THIS install_id's remaining batches (the next
                // would fail the same way) but not the other groups' — break inner only.
                if (!sender.send(url, body, bearer)) break
                acked.addAll(batch)
                i += batchSize
            }
        }

        if (acked.isEmpty()) {
            log.warn("telemetry flush: all batches failed — ${lines.size} events remain buffered (url=$url)")
            return FlushResult(0, lines.size)
        }
        log.info("telemetry flush: sent ${acked.size}/${lines.size} event(s) to $url")

        // Re-read so events appended during the flush survive, then remove the
        // acked lines by identity rather than by count: under the ring cap a
        // concurrent append can trim the buffer head, and grouping means acked
        // lines are no longer a contiguous prefix, so a positional sublist would
        // drop the wrong lines. Identity removal is correct regardless of
        // order/trimming (lines are stored verbatim, so equality is exact).
        val current = TelemetryBuffer.readLines(cwd).map { ensureEventIdLine(it) }
        val remaining = removeAcked(current, acked)
        TelemetryBuffer.replaceLines(cwd, remaining)
        return FlushResult(acked.size, remaining.size)
    }

    /** The `installId` of a buffered line, for batch grouping; "" when absent/unparseable. */
    private fun installIdOf(line: String): String =
        try {
            JsonParser.parseString(line).asJsonObject.get("installId")?.asString ?: ""
        } catch (_: Exception) {
            ""
        }

    /**
     * Backfill a stable UUID for telemetry lines buffered by older clients before
     * `eventId` existed. The id is deterministic from the exact stored line, so a
     * failed flush/retry keeps the same id even though the legacy file is unchanged.
     */
    private fun ensureEventIdLine(line: String): String {
        return try {
            val obj = JsonParser.parseString(line).asJsonObject
            val hasEventId = obj.has("eventId")
            val eventId = runCatching { obj.get("eventId")?.asString }.getOrNull()
            if (eventId != null && UUID_RE.matches(eventId)) {
                line
            } else {
                val trimmed = line.trim()
                // The fast path splices `"eventId":...,` right after the opening
                // brace, so it only produces valid JSON when at least one more
                // property follows. An empty object (`{}`, or `{ }` with padding)
                // would splice to `{"eventId":"…",}` (trailing comma → invalid
                // JSON → the whole batch is rejected forever). Only take the fast
                // path when the object already has a property; empty objects fall
                // to the parser-based path, which re-serializes cleanly.
                if (!hasEventId && trimmed.startsWith("{") && !obj.entrySet().isEmpty()) {
                    """{"eventId":"${legacyEventId(trimmed)}",${trimmed.substring(1)}"""
                } else {
                    obj.addProperty("eventId", legacyEventId(trimmed))
                    obj.toString()
                }
            }
        } catch (_: Exception) {
            line
        }
    }

    private fun legacyEventId(rawLine: String): String {
        val hex = MessageDigest.getInstance("SHA-256").digest(rawLine.toByteArray(Charsets.UTF_8)).joinToString("") {
            "%02x".format(it)
        }
        val variant = ((hex.substring(16, 18).toInt(16) and 0x3f) or 0x80).toString(16).padStart(2, '0')
        return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-5${hex.substring(13, 16)}-$variant${hex.substring(18, 20)}-${hex.substring(20, 32)}"
    }

    /**
     * Return `current` with the acked lines removed by identity (first match per
     * duplicate), preserving order. Acked lines already gone from `current` (ring
     * cap trim during the flush) are simply skipped.
     */
    private fun removeAcked(current: List<String>, acked: List<String>): List<String> {
        val counts = HashMap<String, Int>()
        for (line in acked) counts[line] = (counts[line] ?: 0) + 1
        val out = ArrayList<String>(current.size)
        for (line in current) {
            val n = counts[line] ?: 0
            if (n > 0) counts[line] = n - 1 else out.add(line)
        }
        return out
    }
}
