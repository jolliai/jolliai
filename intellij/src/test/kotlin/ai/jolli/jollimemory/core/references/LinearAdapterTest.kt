package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class LinearAdapterTest {

	private fun payload(
		id: String = "PROJ-1234",
		title: String = "Sample issue",
		url: String = "https://linear.app/x/issue/PROJ-1234",
		status: String? = "In Progress",
		priority: String? = "High",
		labels: List<String>? = listOf("bug"),
		description: String? = "Body text",
	): JsonObject {
		val obj = JsonObject()
		obj.addProperty("id", id)
		obj.addProperty("title", title)
		obj.addProperty("url", url)
		if (status != null) obj.addProperty("status", status)
		if (priority != null) obj.addProperty("priority", priority)
		if (labels != null) {
			val arr = com.google.gson.JsonArray()
			labels.forEach { arr.add(it) }
			obj.add("labels", arr)
		}
		if (description != null) obj.addProperty("description", description)
		return obj
	}

	@Nested
	inner class ExtractRef {
		@Test
		fun `extracts a valid Linear issue`() {
			val ref = LinearAdapter.extractRef(payload(), "mcp__linear__get_issue", "2024-01-01T00:00:00Z")
			ref.shouldNotBeNull()
			ref.mapKey shouldBe "linear:PROJ-1234"
			ref.source shouldBe SourceId.linear
			ref.nativeId shouldBe "PROJ-1234"
			ref.title shouldBe "Sample issue"
			ref.url shouldBe "https://linear.app/x/issue/PROJ-1234"
			ref.description shouldBe "Body text"
		}

		@Test
		fun `reads status, priority, labels fields`() {
			val ref = LinearAdapter.extractRef(payload(), "t", "ts")!!
			ref.fields.shouldNotBeNull()
			ref.fields!!.find { it.key == "status" }!!.value shouldBe "In Progress"
			ref.fields!!.find { it.key == "priority" }!!.value shouldBe "High"
			ref.fields!!.find { it.key == "labels" }!!.value shouldBe "bug"
		}

		@Test
		fun `reads priority as object with name`() {
			val obj = payload(priority = null)
			val p = JsonObject()
			p.addProperty("name", "Urgent")
			obj.add("priority", p)
			val ref = LinearAdapter.extractRef(obj, "t", "ts")!!
			ref.fields!!.find { it.key == "priority" }!!.value shouldBe "Urgent"
		}

		@Test
		fun `rejects non-ticket id`() {
			LinearAdapter.extractRef(payload(id = "lowercase-123"), "t", "ts").shouldBeNull()
			LinearAdapter.extractRef(payload(id = "1234"), "t", "ts").shouldBeNull()
		}

		@Test
		fun `rejects missing title`() {
			LinearAdapter.extractRef(payload(title = ""), "t", "ts").shouldBeNull()
		}

		@Test
		fun `rejects bad url`() {
			LinearAdapter.extractRef(payload(url = "not-a-url"), "t", "ts").shouldBeNull()
		}

		@Test
		fun `no fields when all are null`() {
			val ref = LinearAdapter.extractRef(
				payload(status = null, priority = null, labels = null, description = null), "t", "ts"
			)!!
			ref.fields.shouldBeNull()
			ref.description.shouldBeNull()
		}

		@Test
		fun `filters empty labels`() {
			val ref = LinearAdapter.extractRef(payload(labels = listOf("", "real")), "t", "ts")!!
			ref.fields!!.find { it.key == "labels" }!!.value shouldBe "real"
		}
	}

	@Nested
	inner class Metadata {
		@Test
		fun `adapter identity`() {
			LinearAdapter.id shouldBe SourceId.linear
			LinearAdapter.maxCharsPerReference shouldBe 4000
			LinearAdapter.wrapperKeys shouldBe listOf("items", "issues", "nodes", "results")
		}
	}

	@Nested
	inner class RenderPromptBlock {
		@Test
		fun `renders XML block`() {
			val ref = LinearAdapter.extractRef(payload(), "t", "2024-01-01T00:00:00Z")!!
			val xml = LinearAdapter.renderPromptBlock(listOf(ref), RenderOptions())
			xml shouldContain "<linear-issues>"
			xml shouldContain "id=\"PROJ-1234\""
			xml shouldContain "<title>Sample issue</title>"
		}

		@Test
		fun `empty refs returns empty string`() {
			LinearAdapter.renderPromptBlock(emptyList(), RenderOptions()) shouldBe ""
		}
	}
}
