package ai.jolli.jollimemory.core.references

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class JiraAdapterTest {

	private fun payload(
		key: String = "KAN-4",
		summary: String = "Wire up Jira auto-discovery",
		webUrl: String = "https://example.atlassian.net/browse/KAN-4",
		statusName: String? = "To Do",
		priorityName: String? = "Medium",
		labels: List<String>? = listOf("JolliMemory", "Feature"),
		description: String? = "Jira issue body",
	): JsonObject {
		val obj = JsonObject()
		obj.addProperty("id", "10003")
		obj.addProperty("key", key)
		obj.addProperty("webUrl", webUrl)
		val fields = JsonObject()
		fields.addProperty("summary", summary)
		if (statusName != null) {
			val s = JsonObject(); s.addProperty("name", statusName); fields.add("status", s)
		}
		if (priorityName != null) {
			val p = JsonObject(); p.addProperty("name", priorityName); fields.add("priority", p)
		}
		if (labels != null) {
			val arr = JsonArray(); labels.forEach { arr.add(it) }; fields.add("labels", arr)
		}
		if (description != null) fields.addProperty("description", description)
		obj.add("fields", fields)
		return obj
	}

	@Nested
	inner class ExtractRef {
		@Test
		fun `extracts a valid Jira issue`() {
			val ref = JiraAdapter.extractRef(payload(), "mcp__jira__get", "2024-01-01T00:00:00Z")
			ref.shouldNotBeNull()
			ref.mapKey shouldBe "jira:KAN-4"
			ref.source shouldBe SourceId.jira
			ref.nativeId shouldBe "KAN-4"
			ref.title shouldBe "Wire up Jira auto-discovery"
		}

		@Test
		fun `reads status priority labels`() {
			val ref = JiraAdapter.extractRef(payload(), "t", "ts")!!
			ref.fields!!.find { it.key == "status" }!!.value shouldBe "To Do"
			ref.fields!!.find { it.key == "priority" }!!.value shouldBe "Medium"
			ref.fields!!.find { it.key == "labels" }!!.value shouldBe "JolliMemory, Feature"
		}

		@Test
		fun `status as bare string`() {
			val obj = payload(statusName = null)
			obj.objectOrNull("fields")!!.addProperty("status", "Done")
			val ref = JiraAdapter.extractRef(obj, "t", "ts")!!
			ref.fields!!.find { it.key == "status" }!!.value shouldBe "Done"
		}

		@Test
		fun `rejects invalid key format`() {
			JiraAdapter.extractRef(payload(key = "lowercase-1"), "t", "ts").shouldBeNull()
		}

		@Test
		fun `rejects empty summary`() {
			JiraAdapter.extractRef(payload(summary = ""), "t", "ts").shouldBeNull()
		}

		@Test
		fun `rejects non-url webUrl`() {
			JiraAdapter.extractRef(payload(webUrl = "not-a-url"), "t", "ts").shouldBeNull()
		}
	}

	@Nested
	inner class Metadata {
		@Test
		fun `adapter identity`() {
			JiraAdapter.id shouldBe SourceId.jira
			JiraAdapter.maxCharsPerReference shouldBe 4000
		}
	}

	@Nested
	inner class RenderPromptBlock {
		@Test
		fun `renders jira-issues XML`() {
			val ref = JiraAdapter.extractRef(payload(), "t", "ts")!!
			val xml = JiraAdapter.renderPromptBlock(listOf(ref), RenderOptions())
			xml shouldContain "<jira-issues>"
			xml shouldContain "id=\"KAN-4\""
		}
	}
}
