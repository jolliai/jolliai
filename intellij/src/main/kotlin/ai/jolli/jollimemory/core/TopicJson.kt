package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.stream.JsonWriter
import java.io.StringWriter

/**
 * Serializer for the canonical topic-KB JSON (`topics/<slug>.json`, `topics/index.json`).
 *
 * Matches the CLI's `JSON.stringify(value, null, "\t")` byte-for-byte so the
 * synced canonical layer never re-conflicts across CLI / VS Code / IntelliJ:
 *  - **TAB** indentation (Gson's `setPrettyPrinting()` would emit 2 spaces)
 *  - HTML escaping **disabled** (`<`, `>`, `&`, `=` written literally)
 *  - null fields omitted (matches JS `undefined` omission)
 *  - no trailing newline
 *
 * Field/key order follows the data-class declaration order, which mirrors the
 * TS interface property order in [TopicKBTypes].
 */
internal object TopicJson {
    private val gson: Gson = GsonBuilder().disableHtmlEscaping().create()

    /** Serialize [value] to tab-indented JSON identical to `JSON.stringify(value, null, "\t")`. */
    fun stringify(value: Any): String {
        val sw = StringWriter()
        JsonWriter(sw).use { jw ->
            jw.setIndent("\t")
            gson.toJson(value, value.javaClass, jw)
        }
        return sw.toString()
    }

    /** Parse [raw] into [clazz], or null on any parse failure. */
    fun <T> parse(raw: String, clazz: Class<T>): T? =
        try {
            gson.fromJson(raw, clazz)
        } catch (_: Exception) {
            null
        }
}
