package ai.jolli.jollimemory.core.references

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class HtmlEntitiesTest {

	@Nested
	inner class NamedEntities {
		@Test
		fun `decodes amp lt gt quot apos`() {
			HtmlEntities.decode("&amp; &lt; &gt; &quot; &apos;") shouldBe "& < > \" '"
		}

		@Test
		fun `passes through unknown named entities`() {
			HtmlEntities.decode("&nbsp; &mdash;") shouldBe "&nbsp; &mdash;"
		}
	}

	@Nested
	inner class NumericEntities {
		@Test
		fun `decodes decimal entities`() {
			HtmlEntities.decode("&#960;") shouldBe "π"
		}

		@Test
		fun `decodes hex entities`() {
			HtmlEntities.decode("&#x2026;") shouldBe "…"
		}

		@Test
		fun `decodes newline`() {
			HtmlEntities.decode("&#10;") shouldBe "\n"
			HtmlEntities.decode("&#x0A;") shouldBe "\n"
		}

		@Test
		fun `rejects out-of-range code points`() {
			HtmlEntities.decode("&#x110000;") shouldBe "&#x110000;"
		}

		@Test
		fun `rejects surrogate code points`() {
			HtmlEntities.decode("&#xD800;") shouldBe "&#xD800;"
			HtmlEntities.decode("&#xDFFF;") shouldBe "&#xDFFF;"
		}
	}

	@Nested
	inner class Mixed {
		@Test
		fun `handles consecutive entities`() {
			HtmlEntities.decode("&lt;&gt;") shouldBe "<>"
		}

		@Test
		fun `no-op on plain text`() {
			HtmlEntities.decode("hello world") shouldBe "hello world"
		}

		@Test
		fun `empty string`() {
			HtmlEntities.decode("") shouldBe ""
		}
	}
}
