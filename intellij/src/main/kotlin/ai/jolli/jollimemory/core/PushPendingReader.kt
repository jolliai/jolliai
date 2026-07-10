package ai.jolli.jollimemory.core

import com.google.gson.JsonParser
import java.io.File

/** Read-only view of the shared Node pre-push queue used by cleanup paths. */
object PushPendingReader {

    /**
     * Returns queued commit hashes, an empty set when no queue exists, or null
     * when the file cannot be parsed. Callers treat null conservatively as
     * "possibly pending" so cleanup never drops an in-flight article reference.
     */
    fun loadHashes(cwd: String): Set<String>? {
        val file = File(cwd, ".jolli/jollimemory/push-pending.json")
        if (!file.exists()) return emptySet()
        return try {
            val root = JsonParser.parseString(file.readText()).asJsonObject
            val entries = root.getAsJsonObject("entries") ?: return emptySet()
            entries.keySet().toSet()
        } catch (_: Exception) {
            null
        }
    }
}
