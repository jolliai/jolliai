package ai.jolli.jollimemory.core.references

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class GitHubAdapterTest {

	private fun payload(
		number: Int = 959,
		title: String = "Refactor entity discovery pipeline",
		htmlUrl: String = "https://github.com/jolliai/jolli/issues/959",
		body: String? = "## Problem\n\nGitHub bodies arrive &lt;HTML&gt;-encoded",
		state: String? = "open",
		labels: List<String>? = listOf("bug", "p1"),
		assignees: List<String>? = listOf("alice"),
		repoFullName: String? = "jolliai/jolli",
	): JsonObject {
		val obj = JsonObject()
		obj.addProperty("number", number)
		obj.addProperty("title", title)
		obj.addProperty("html_url", htmlUrl)
		if (body != null) obj.addProperty("body", body)
		if (state != null) obj.addProperty("state", state)
		if (labels != null) {
			val arr = JsonArray(); labels.forEach { arr.add(it) }; obj.add("labels", arr)
		}
		if (assignees != null) {
			val arr = JsonArray(); assignees.forEach { arr.add(it) }; obj.add("assignees", arr)
		}
		if (repoFullName != null) {
			val repo = JsonObject(); repo.addProperty("full_name", repoFullName)
			obj.add("repository", repo)
		}
		return obj
	}

	@Nested
	inner class ExtractRef {
		@Test
		fun `extracts a valid GitHub issue`() {
			val ref = GitHubAdapter.extractRef(payload(), "mcp__github__issue_read", "2024-01-01T00:00:00Z")
			ref.shouldNotBeNull()
			ref.mapKey shouldBe "github:jolliai/jolli#959"
			ref.nativeId shouldBe "jolliai/jolli#959"
			ref.source shouldBe SourceId.github
			ref.title shouldBe "Refactor entity discovery pipeline"
		}

		@Test
		fun `decodes HTML entities in body`() {
			val ref = GitHubAdapter.extractRef(payload(), "t", "ts")!!
			ref.description shouldContain "<HTML>"
			ref.description shouldContain "&" // no entity left for amp
		}

		@Test
		fun `reads state, labels, assignees`() {
			val ref = GitHubAdapter.extractRef(payload(), "t", "ts")!!
			ref.fields!!.find { it.key == "status" }!!.value shouldBe "open"
			ref.fields!!.find { it.key == "labels" }!!.value shouldBe "bug, p1"
			ref.fields!!.find { it.key == "assignees" }!!.value shouldBe "alice"
		}

		@Test
		fun `derives owner-repo from html_url fallback`() {
			val ref = GitHubAdapter.extractRef(payload(repoFullName = null), "t", "ts")
			ref.shouldNotBeNull()
			ref.nativeId shouldBe "jolliai/jolli#959"
		}

		@Test
		fun `supports pull request URLs`() {
			val ref = GitHubAdapter.extractRef(
				payload(htmlUrl = "https://github.com/o/r/pull/42", repoFullName = null), "t", "ts"
			)
			ref.shouldNotBeNull()
			ref.nativeId shouldBe "o/r#42"
		}

		@Test
		fun `rejects missing number`() {
			val obj = payload()
			obj.remove("number")
			GitHubAdapter.extractRef(obj, "t", "ts").shouldBeNull()
		}

		@Test
		fun `rejects empty title`() {
			GitHubAdapter.extractRef(payload(title = ""), "t", "ts").shouldBeNull()
		}

		@Test
		fun `reads milestone as object`() {
			val obj = payload()
			val ms = JsonObject(); ms.addProperty("title", "v1.0")
			obj.add("milestone", ms)
			val ref = GitHubAdapter.extractRef(obj, "t", "ts")!!
			ref.fields!!.find { it.key == "milestone" }!!.value shouldBe "v1.0"
		}

		@Test
		fun `reads issue_type as object`() {
			val obj = payload()
			val it = JsonObject(); it.addProperty("name", "Bug")
			obj.add("issue_type", it)
			val ref = GitHubAdapter.extractRef(obj, "t", "ts")!!
			ref.fields!!.find { it.key == "entity-type" }!!.value shouldBe "Bug"
		}
	}

	@Nested
	inner class Metadata {
		@Test
		fun `adapter identity`() {
			GitHubAdapter.id shouldBe SourceId.github
			GitHubAdapter.maxCharsPerReference shouldBe 4000
		}
	}

	@Nested
	inner class RenderPromptBlock {
		@Test
		fun `renders github-issues XML`() {
			val ref = GitHubAdapter.extractRef(payload(), "t", "ts")!!
			val xml = GitHubAdapter.renderPromptBlock(listOf(ref), RenderOptions())
			xml shouldContain "<github-issues>"
		}
	}
}
