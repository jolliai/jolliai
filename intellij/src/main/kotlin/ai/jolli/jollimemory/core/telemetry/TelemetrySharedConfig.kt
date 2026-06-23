package ai.jolli.jollimemory.core.telemetry

import ai.jolli.jollimemory.core.SessionTracker
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.util.UUID

/**
 * TelemetrySharedConfig — reads/writes the telemetry identity + opt-out flag in
 * the **shared** `~/.jolli/jollimemory/config.json` (JOLLI-1785 Phase 3).
 *
 * Deliberately NOT `config-intellij.json`: `installId` and the `telemetry` flag
 * are machine-global so there is one anonymous identity and one opt-out switch
 * per machine across CLI / VS Code / IntelliJ (the `surface` field distinguishes
 * clients). Because the CLI co-owns this file, we mutate it as a Gson
 * `JsonObject` tree — preserving every other field's exact JSON (a parse→Map
 * round-trip would widen the CLI's integer fields to doubles).
 *
 * The directory is injectable so it can be unit-tested without touching the
 * real home dir; production uses `SessionTracker.getGlobalConfigDir()`.
 */
object TelemetrySharedConfig {
    private const val CONFIG_FILE = "config.json"

    /** Atomic-exclusive sentinel that arbitrates a single installId mint across concurrent first-runs. */
    private const val INSTALL_ID_FILE = "install-id"
    private val gson: Gson = Gson()

    private fun configFile(dir: String): File = File(dir, CONFIG_FILE)

    private fun read(dir: String): JsonObject {
        val f = configFile(dir)
        if (!f.exists()) return JsonObject()
        return try {
            JsonParser.parseString(f.readText(Charsets.UTF_8)).asJsonObject
        } catch (_: Exception) {
            JsonObject()
        }
    }

    private fun write(dir: String, obj: JsonObject) {
        File(dir).mkdirs()
        atomicWrite(configFile(dir), gson.toJson(obj))
    }

    /**
     * Return the stable per-machine `installId`, minting and persisting one
     * (lowercase UUID — the backend column is `uuid`) on first call. `created`
     * is true only on the minting run, so the caller fires `app_installed` once.
     */
    fun getOrCreateInstallId(dir: String = SessionTracker.getGlobalConfigDir()): Pair<String, Boolean> {
        val obj = read(dir)
        val existing = obj.get("installId")?.takeIf { it.isJsonPrimitive }?.asString
        if (!existing.isNullOrEmpty()) return existing to false
        // Race-free mint (parity with the CLI): the OS-atomic exclusive create of
        // the `install-id` sentinel arbitrates a single winner across concurrent
        // first-runs (CLI worker + IDE), so `app_installed` fires once and the loser
        // adopts the winner's id instead of clobbering config.json with its own.
        File(dir).mkdirs()
        val sentinel = File(dir, INSTALL_ID_FILE)
        val candidate = UUID.randomUUID().toString()
        val (installId, created) =
            try {
                Files.write(sentinel.toPath(), candidate.toByteArray(Charsets.UTF_8), StandardOpenOption.CREATE_NEW)
                candidate to true
            } catch (_: Exception) {
                val fromSentinel = runCatching { sentinel.readText(Charsets.UTF_8).trim() }.getOrNull()
                (if (!fromSentinel.isNullOrEmpty()) fromSentinel else candidate) to false
            }
        if (obj.get("installId")?.takeIf { it.isJsonPrimitive }?.asString != installId) {
            obj.addProperty("installId", installId)
            write(dir, obj)
        }
        return installId to created
    }

    /** The shared `telemetry` opt-out flag ("on" / "off" / null = default-on). */
    fun telemetryFlag(dir: String = SessionTracker.getGlobalConfigDir()): String? =
        read(dir).get("telemetry")?.takeIf { it.isJsonPrimitive }?.asString

    fun noticeShown(dir: String = SessionTracker.getGlobalConfigDir()): Boolean =
        read(dir).get("telemetryNoticeShown")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false

    fun markNoticeShown(dir: String = SessionTracker.getGlobalConfigDir()) {
        val obj = read(dir)
        obj.addProperty("telemetryNoticeShown", true)
        write(dir, obj)
    }

    /**
     * Machine-global first-seen ledger for `ai_source_detected` (shared with the
     * CLI's `telemetrySeenSources` — same file). Returns true only the first time
     * a given source is recorded on this machine, so the event fires once per
     * source rather than on every run.
     */
    fun markAiSourceSeen(source: String, dir: String = SessionTracker.getGlobalConfigDir()): Boolean {
        val obj = read(dir)
        // Tolerate a malformed shared config: `getAsJsonArray` throws if the field
        // exists but isn't an array (corrupt/hand-edited config). This runs inside
        // the detached worker, so an exception here would fail the whole run.
        val existing = obj.get("telemetrySeenSources")
        val seen = if (existing != null && existing.isJsonArray) existing.asJsonArray else com.google.gson.JsonArray()
        if (seen.any { it.isJsonPrimitive && it.asString == source }) return false
        seen.add(source)
        obj.add("telemetrySeenSources", seen)
        write(dir, obj)
        return true
    }

    /** Set the opt-out flag; turning on also records the notice as shown. */
    fun setTelemetry(enabled: Boolean, dir: String = SessionTracker.getGlobalConfigDir()) {
        val obj = read(dir)
        obj.addProperty("telemetry", if (enabled) "on" else "off")
        if (enabled) obj.addProperty("telemetryNoticeShown", true)
        write(dir, obj)
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
