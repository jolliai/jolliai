package ai.jolli.jollimemory.core.telemetry

import ai.jolli.jollimemory.services.JolliApiClient
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
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
                response.statusCode() in 200..299
            } catch (_: Exception) {
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

        val lines = TelemetryBuffer.readLines(cwd)
        if (lines.isEmpty()) return FlushResult(0, 0)
        if (resolvedOrigin.isNullOrEmpty()) return FlushResult(0, lines.size)

        // Defense-in-depth: never POST telemetry (or a Bearer key) to a non-Jolli
        // host. The flusher re-derives origin from raw config, so re-assert the
        // HTTPS + allowlist boundary here (parity with the CLI flusher).
        try {
            ai.jolli.jollimemory.auth.JolliAuthUtils.assertJolliOriginAllowed(resolvedOrigin)
        } catch (_: Exception) {
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

        val batchSize = maxOf(1, maxBatch)
        var sent = 0
        var i = 0
        while (i < lines.size) {
            val batch = lines.subList(i, minOf(i + batchSize, lines.size))
            val body = """{"events":[${batch.joinToString(",")}]}"""
            if (!sender.send(url, body, bearer)) break
            sent += batch.size
            i += batchSize
        }

        if (sent == 0) return FlushResult(0, lines.size)

        // Re-read so events appended during the flush survive, then remove the
        // acked lines by identity rather than by count: under the ring cap a
        // concurrent append can trim the buffer head, so a positional sublist
        // would drop the wrong (newest) lines. Identity removal is correct
        // regardless of trimming (lines are stored verbatim, so equality is exact).
        val current = TelemetryBuffer.readLines(cwd)
        val remaining = removeAcked(current, lines.subList(0, sent))
        TelemetryBuffer.replaceLines(cwd, remaining)
        return FlushResult(sent, remaining.size)
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
