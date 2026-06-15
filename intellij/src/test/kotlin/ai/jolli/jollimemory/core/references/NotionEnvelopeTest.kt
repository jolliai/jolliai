package ai.jolli.jollimemory.core.references

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class NotionEnvelopeTest {

	@Test
	fun `extracts content block`() {
		val text = "<page><title>Hello</title><content># Body\n\nSome text</content></page>"
		NotionEnvelope.parse(text).content shouldBe "# Body\n\nSome text"
	}

	@Test
	fun `returns empty for missing content block`() {
		NotionEnvelope.parse("<page><title>Hello</title></page>").content shouldBe ""
	}

	@Test
	fun `returns empty for null input`() {
		NotionEnvelope.parse(null).content shouldBe ""
	}

	@Test
	fun `returns empty for empty string`() {
		NotionEnvelope.parse("").content shouldBe ""
	}

	@Test
	fun `tolerates attributes on content tag`() {
		val text = """<content class="body">inner</content>"""
		NotionEnvelope.parse(text).content shouldBe "inner"
	}

	@Test
	fun `takes first content block only`() {
		val text = "<content>first</content><content>second</content>"
		NotionEnvelope.parse(text).content shouldBe "first"
	}
}
