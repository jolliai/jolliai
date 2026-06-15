package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class NotionAdapterTest {

	private fun payload(
		title: String = "Adapter spec",
		url: String = "https://www.notion.so/Adapter-spec-36c4fc101d34805ab1fdfb3e69144580",
		metadataType: String = "page",
		text: String? = "<page><title>Adapter spec</title><content># Notion Adapter\n\nBody text</content></page>",
	): JsonObject {
		val obj = JsonObject()
		obj.addProperty("title", title)
		obj.addProperty("url", url)
		val metadata = JsonObject()
		metadata.addProperty("type", metadataType)
		obj.add("metadata", metadata)
		if (text != null) obj.addProperty("text", text)
		return obj
	}

	@Nested
	inner class ExtractRef {
		@Test
		fun `extracts a valid Notion page`() {
			val ref = NotionAdapter.extractRef(payload(), "notion-fetch", "2024-01-01T00:00:00Z")
			ref.shouldNotBeNull()
			ref.mapKey shouldBe "notion:36c4fc101d34805ab1fdfb3e69144580"
			ref.source shouldBe SourceId.notion
			ref.nativeId shouldBe "36c4fc101d34805ab1fdfb3e69144580"
			ref.title shouldBe "Adapter spec"
			ref.description shouldBe "# Notion Adapter\n\nBody text"
		}

		@Test
		fun `normalizes page id to lowercase`() {
			val ref = NotionAdapter.extractRef(
				payload(url = "https://www.notion.so/Page-36C4FC101D34805AB1FDFB3E69144580"),
				"t", "ts"
			)!!
			ref.nativeId shouldBe "36c4fc101d34805ab1fdfb3e69144580"
		}

		@Test
		fun `rejects database type`() {
			NotionAdapter.extractRef(payload(metadataType = "database"), "t", "ts").shouldBeNull()
		}

		@Test
		fun `rejects non-Notion host`() {
			NotionAdapter.extractRef(
				payload(url = "https://example.com/36c4fc101d34805ab1fdfb3e69144580"), "t", "ts"
			).shouldBeNull()
		}

		@Test
		fun `rejects HTTP scheme`() {
			NotionAdapter.extractRef(
				payload(url = "http://www.notion.so/36c4fc101d34805ab1fdfb3e69144580"), "t", "ts"
			).shouldBeNull()
		}

		@Test
		fun `accepts notion-site subdomain`() {
			val ref = NotionAdapter.extractRef(
				payload(url = "https://team.notion.site/Page-36c4fc101d34805ab1fdfb3e69144580"), "t", "ts"
			)
			ref.shouldNotBeNull()
		}

		@Test
		fun `accepts app-notion-com`() {
			val ref = NotionAdapter.extractRef(
				payload(url = "https://app.notion.com/36c4fc101d34805ab1fdfb3e69144580"), "t", "ts"
			)
			ref.shouldNotBeNull()
		}

		@Test
		fun `takes deepest page id from nested URL`() {
			val ref = NotionAdapter.extractRef(
				payload(url = "https://www.notion.so/Parent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1/Child-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
				"t", "ts"
			)
			ref.shouldNotBeNull()
			ref.nativeId shouldBe "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		}

		@Test
		fun `empty title rejects`() {
			NotionAdapter.extractRef(payload(title = ""), "t", "ts").shouldBeNull()
		}

		@Test
		fun `no text gives null description`() {
			val ref = NotionAdapter.extractRef(payload(text = null), "t", "ts")!!
			ref.description.shouldBeNull()
		}
	}

	@Nested
	inner class Metadata {
		@Test
		fun `adapter identity`() {
			NotionAdapter.id shouldBe SourceId.notion
			NotionAdapter.maxCharsPerReference shouldBe 30000
		}
	}

	@Nested
	inner class RenderPromptBlock {
		@Test
		fun `renders notion-pages XML`() {
			val ref = NotionAdapter.extractRef(payload(), "t", "ts")!!
			val xml = NotionAdapter.renderPromptBlock(listOf(ref), RenderOptions())
			xml shouldContain "<notion-pages>"
			xml shouldContain "<page id=\"36c4fc101d34805ab1fdfb3e69144580\">"
		}
	}
}
