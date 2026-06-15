package ai.jolli.jollimemory.core.references

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject

/**
 * GitHub-domain payload reshaping.
 *
 * Maps a producer's issue object into the shape [GitHubAdapter.extractRef] reads:
 * unwrap `issue.*`, `issue_number`→`number`, `url`→`html_url`, flatten the
 * object-array `labels`/`assignees` into string arrays, and — for search hits
 * that leave `number` null — derive the issue number from the URL.
 */
object GitHubNormalize {

	private val ISSUE_NUMBER_IN_URL = Regex("/(?:issues|pull)/(\\d+)")

	/** Flatten an array of `{[key]: string}` objects (or bare strings) to a string JsonArray. */
	private fun flattenNamed(value: JsonElement?, key: String): JsonArray? {
		if (value == null || !value.isJsonArray) return null
		val arr = value.asJsonArray
		val out = JsonArray()
		for (item in arr) {
			if (item.isJsonPrimitive && item.asJsonPrimitive.isString) {
				val s = item.asString
				if (s.isNotEmpty()) out.add(s)
			} else if (item.isJsonObject) {
				val v = item.asJsonObject.stringOrNull(key)
				if (!v.isNullOrEmpty()) out.add(v)
			}
		}
		return if (out.size() > 0) out else null
	}

	/** Reshape one GitHub issue (single fetch OR one search-result element) into adapter shape. */
	fun reshape(raw: JsonElement?): JsonElement? {
		if (raw == null || !raw.isJsonObject) return raw
		val rawObj = raw.asJsonObject
		val issue = rawObj.objectOrNull("issue") ?: rawObj
		val out = JsonObject()

		val num = issue.intOrNull("issue_number") ?: issue.intOrNull("number")
		if (num != null) out.addProperty("number", num)
		issue.stringOrNull("title")?.let { out.addProperty("title", it) }
		val url = issue.stringOrNull("url") ?: issue.stringOrNull("html_url")
		if (url != null) out.addProperty("html_url", url)
		issue.stringOrNull("body")?.let { out.addProperty("body", it) }
		issue.stringOrNull("state")?.let { out.addProperty("state", it) }

		flattenNamed(issue.get("labels"), "name")?.let { out.add("labels", it) }
		flattenNamed(issue.get("assignees"), "login")?.let { out.add("assignees", it) }

		val fullName = issue.stringOrNull("repository_full_name")
			?: rawObj.stringOrNull("repository_full_name")
		if (fullName != null) {
			val repo = JsonObject()
			repo.addProperty("full_name", fullName)
			out.add("repository", repo)
		}

		// Search hits leave `number` null — derive from URL.
		if (!out.has("number") || !out.get("number").isJsonPrimitive) {
			val htmlUrl = out.stringOrNull("html_url")
			if (htmlUrl != null) {
				val m = ISSUE_NUMBER_IN_URL.find(htmlUrl)
				if (m != null) out.addProperty("number", m.groupValues[1].toInt())
			}
		}

		return out
	}
}
