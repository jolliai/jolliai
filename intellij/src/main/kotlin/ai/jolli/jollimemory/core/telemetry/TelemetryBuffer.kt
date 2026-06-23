package ai.jolli.jollimemory.core.telemetry

import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.Gson
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * One telemetry event as it sits on disk and goes over the wire — the shared
 * envelope from JOLLI-1786 §7.0. `properties` carries all event-specific
 * fields. `installId` MUST be a UUID (the backend `telemetry_events.install_id`
 * column is `uuid` and silently drops non-UUID rows). `accountId` is always
 * null from the client; the backend attributes it from the Bearer key.
 */
data class TelemetryEnvelope(
    val schemaVersion: Int,
    val eventName: String,
    val surface: String,
    val surfaceVersion: String,
    val installId: String,
    val sessionId: String? = null,
    val os: String,
    val arch: String,
    val runtimeVersion: String,
    val env: String,
    val tsIso: String,
    val accountId: String? = null,
    val properties: Map<String, Any?> = emptyMap(),
)

/**
 * TelemetryBuffer — Kotlin port of cli/src/core/TelemetryBuffer.ts (JOLLI-1785).
 * Durable, bounded NDJSON queue at
 * `<projectDir>/.jolli/jollimemory/telemetry-queue.ndjson`.
 *
 * Kotlin-side adaptation vs the TS original: the flush path operates on **raw
 * JSON lines** (`readLines` / `replaceLines`), not re-serialized objects. Gson
 * widens integers to doubles on a parse→serialize round-trip (`7` → `7.0`),
 * which would drift the wire payload from the TS client; sending the stored
 * lines verbatim keeps the two surfaces byte-identical. `read()` (parsed) is
 * for `telemetry inspect` / status only.
 *
 * Append is synchronous and append-only so it never blocks the <5ms hooks; the
 * ring cap (`MAX_EVENTS`, drop-oldest) is enforced lazily on read/replace.
 */
object TelemetryBuffer {
    const val MAX_EVENTS = 500

    /**
     * Hard byte ceiling that bounds the file even if it is only ever appended to
     * (backend permanently unreachable, so the flusher never compacts). Only the
     * rare overflow triggers an in-place compaction; the hot append path stays
     * O(1) otherwise.
     */
    const val MAX_BYTES = 1_000_000L
    private const val QUEUE_FILE = "telemetry-queue.ndjson"
    private val gson = Gson()

    private fun queueFile(cwd: String): File = File(JmLogger.getJolliMemoryDir(cwd), QUEUE_FILE)

    /** Append one event as an NDJSON line, creating the dir if needed. */
    @Synchronized
    fun append(cwd: String, event: TelemetryEnvelope) {
        val dir = File(JmLogger.getJolliMemoryDir(cwd))
        dir.mkdirs()
        val f = File(dir, QUEUE_FILE)
        f.appendText(gson.toJson(event) + "\n", Charsets.UTF_8)
        // Keep the file bounded even if the flusher never compacts it (the ring cap
        // is otherwise only applied at read/replace). Best-effort; never throw.
        try {
            if (f.length() > MAX_BYTES) {
                val kept =
                    f.readText(Charsets.UTF_8).split("\n").map { it.trim() }.filter { it.isNotEmpty() }.let {
                        if (it.size > MAX_EVENTS) it.subList(it.size - MAX_EVENTS, it.size) else it
                    }
                f.writeText(if (kept.isEmpty()) "" else kept.joinToString("\n") + "\n", Charsets.UTF_8)
            }
        } catch (_: Exception) {
            // best-effort compaction
        }
    }

    /** Raw non-empty JSON lines, capped to the newest MAX_EVENTS (drop-oldest). Missing file → empty. */
    fun readLines(cwd: String): List<String> {
        val f = queueFile(cwd)
        if (!f.exists()) return emptyList()
        val lines = f.readText(Charsets.UTF_8).split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        return if (lines.size > MAX_EVENTS) lines.subList(lines.size - MAX_EVENTS, lines.size) else lines
    }

    /** Parsed events (for `telemetry inspect` / status). Corrupt lines are skipped. */
    fun read(cwd: String): List<TelemetryEnvelope> {
        val out = ArrayList<TelemetryEnvelope>()
        for (line in readLines(cwd)) {
            try {
                out.add(gson.fromJson(line, TelemetryEnvelope::class.java))
            } catch (_: Exception) {
                // Skip a torn/corrupt line; the rest of the buffer is still good.
            }
        }
        return out
    }

    /** Overwrite the buffer with raw JSON lines (capped). Empty → remove the file. */
    @Synchronized
    fun replaceLines(cwd: String, lines: List<String>) {
        val capped = if (lines.size > MAX_EVENTS) lines.subList(lines.size - MAX_EVENTS, lines.size) else lines
        val f = queueFile(cwd)
        if (capped.isEmpty()) {
            f.delete()
            return
        }
        File(JmLogger.getJolliMemoryDir(cwd)).mkdirs()
        atomicWrite(f, capped.joinToString("\n") + "\n")
    }

    /** Drop the entire buffer (e.g. after a successful full flush). Idempotent. */
    @Synchronized
    fun clear(cwd: String) {
        queueFile(cwd).delete()
    }

    private fun atomicWrite(file: File, content: String) {
        val tmp = File("${file.absolutePath}.tmp")
        tmp.writeText(content, Charsets.UTF_8)
        try {
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: Exception) {
            try {
                file.writeText(content, Charsets.UTF_8)
            } finally {
                tmp.delete()
            }
        }
    }
}
