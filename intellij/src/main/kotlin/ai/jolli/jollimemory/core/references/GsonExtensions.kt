package ai.jolli.jollimemory.core.references

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** Safe string access — returns null if key is missing or not a string primitive. */
fun JsonObject.stringOrNull(key: String): String? {
	val el = get(key) ?: return null
	return if (el.isJsonPrimitive && el.asJsonPrimitive.isString) el.asString else null
}

/** Safe int access — returns null if key is missing or not an integer-valued number. */
fun JsonObject.intOrNull(key: String): Int? {
	val el = get(key) ?: return null
	if (!el.isJsonPrimitive || !el.asJsonPrimitive.isNumber) return null
	return runCatching { el.asInt }.getOrNull()
}

/** Safe boolean access. */
fun JsonObject.boolOrNull(key: String): Boolean? {
	val el = get(key) ?: return null
	return if (el.isJsonPrimitive && el.asJsonPrimitive.isBoolean) el.asBoolean else null
}

/** Safe JsonArray access. */
fun JsonObject.arrayOrNull(key: String): JsonArray? {
	val el = get(key) ?: return null
	return if (el.isJsonArray) el.asJsonArray else null
}

/** Safe JsonObject access. */
fun JsonObject.objectOrNull(key: String): JsonObject? {
	val el = get(key) ?: return null
	return if (el.isJsonObject) el.asJsonObject else null
}

/** Parse JSON string, returning null on failure instead of throwing. */
fun tryParseJson(text: String): JsonElement? =
	runCatching { JsonParser.parseString(text) }.getOrNull()

/** Parse JSON string as a JsonObject, returning null on failure or wrong type. */
fun tryParseJsonObject(text: String): JsonObject? =
	tryParseJson(text)?.let { if (it.isJsonObject) it.asJsonObject else null }
