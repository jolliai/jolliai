package ai.jolli.jollimemory.services

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.lang.reflect.Method
import java.util.Base64

class JolliApiClientTest {

    // ── parseJolliApiKey ────────────────────────────────────────────────

    @Nested
    inner class ParseJolliApiKey {
        @Test
        fun `parses new-format API key with tenant and URL`() {
            val meta = """{"t":"test-tenant","u":"https://test-tenant.jolli.ai"}"""
            val key = buildKey(meta)
            val result = JolliApiClient.parseJolliApiKey(key)
            result shouldNotBe null
            result!!.t shouldBe "test-tenant"
            result.u shouldBe "https://test-tenant.jolli.ai"
            result.o shouldBe null
        }

        @Test
        fun `parses API key with org slug`() {
            val meta = """{"t":"tenant","u":"https://tenant.jolli.ai","o":"org1"}"""
            val result = JolliApiClient.parseJolliApiKey(buildKey(meta))
            result!!.o shouldBe "org1"
        }

        @Test
        fun `returns null for old-format API key`() {
            JolliApiClient.parseJolliApiKey("sk-jol-abcdef1234567890abcdef1234567890") shouldBe null
        }

        @Test
        fun `returns null for non-sk-jol prefix`() {
            JolliApiClient.parseJolliApiKey("not-a-key") shouldBe null
        }

        @Test
        fun `returns null for invalid base64 meta`() {
            val key = "sk-jol-!!!invalid!!!.${randomPart()}"
            JolliApiClient.parseJolliApiKey(key) shouldBe null
        }

        @Test
        fun `returns null for meta missing t field`() {
            JolliApiClient.parseJolliApiKey(buildKey("""{"u":"https://x.jolli.ai"}""")) shouldBe null
        }

        @Test
        fun `returns null for meta missing u field`() {
            JolliApiClient.parseJolliApiKey(buildKey("""{"t":"tenant"}""")) shouldBe null
        }

        private fun buildKey(meta: String): String {
            val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(meta.toByteArray())
            return "sk-jol-$encoded.${randomPart()}"
        }
        private fun randomPart() = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))
    }

    // ── parseBaseUrl (private, via reflection) ──────────────────────────

    @Nested
    inner class ParseBaseUrl {
        private fun parseBaseUrl(baseUrl: String): Any {
            val method: Method = JolliApiClient::class.java.getDeclaredMethod("parseBaseUrl", String::class.java)
            method.isAccessible = true
            return method.invoke(JolliApiClient, baseUrl)
        }

        private fun getOrigin(result: Any): String = result::class.java.getDeclaredField("origin").also { it.isAccessible = true }.get(result) as String
        private fun getTenantSlug(result: Any): String? = result::class.java.getDeclaredField("tenantSlug").also { it.isAccessible = true }.get(result) as String?

        @Test
        fun `parses subdomain URL`() {
            val result = parseBaseUrl("https://test.jolli.ai")
            getOrigin(result) shouldBe "https://test.jolli.ai"
            getTenantSlug(result) shouldBe null
        }

        @Test
        fun `parses path-based URL`() {
            val result = parseBaseUrl("http://localhost:3000/acme/")
            getOrigin(result) shouldBe "http://localhost:3000"
            getTenantSlug(result) shouldBe "acme"
        }

        @Test
        fun `handles URL without path`() {
            val result = parseBaseUrl("https://example.com")
            getOrigin(result) shouldBe "https://example.com"
            getTenantSlug(result) shouldBe null
        }
    }

    // ── parseResponse (private, via reflection) ─────────────────────────

    @Nested
    inner class ParseResponse {
        private fun parseResponse(raw: String, statusCode: Int): Any {
            val method: Method = JolliApiClient::class.java.getDeclaredMethod("parseResponse", String::class.java, Int::class.javaPrimitiveType)
            method.isAccessible = true
            return method.invoke(JolliApiClient, raw, statusCode)
        }

        @Test
        fun `parses successful response`() {
            val raw = """{"url":"https://jolli.ai/articles/1","docId":42,"jrn":"jrn:1","created":true}"""
            val result = parseResponse(raw, 200) as JolliApiClient.JolliPushResult
            result.url shouldBe "https://jolli.ai/articles/1"
            result.docId shouldBe 42
            result.jrn shouldBe "jrn:1"
            result.created shouldBe true
        }

        @Test
        fun `parses 201 as success`() {
            val raw = """{"url":"u","docId":1,"jrn":"j","created":false}"""
            val result = parseResponse(raw, 201) as JolliApiClient.JolliPushResult
            result.docId shouldBe 1
        }

        @Test
        fun `throws PluginOutdatedError for 426`() {
            val raw = """{"message":"Please update plugin"}"""
            val ex = assertThrows<java.lang.reflect.InvocationTargetException> {
                parseResponse(raw, 426)
            }
            (ex.cause is JolliApiClient.PluginOutdatedError) shouldBe true
            ex.cause!!.message shouldBe "Please update plugin"
        }

        @Test
        fun `throws RuntimeException for other errors`() {
            val raw = """{"error":"Not found"}"""
            val ex = assertThrows<java.lang.reflect.InvocationTargetException> {
                parseResponse(raw, 404)
            }
            (ex.cause is RuntimeException) shouldBe true
            ex.cause!!.message shouldBe "Not found"
        }

        @Test
        fun `throws for invalid JSON on error status`() {
            val ex = assertThrows<java.lang.reflect.InvocationTargetException> {
                parseResponse("not json", 500)
            }
            // May throw RuntimeException or Gson parse error wrapped in InvocationTargetException
            (ex.cause is RuntimeException) shouldBe true
        }
    }

    // ── Data classes ────────────────────────────────────────────────────

    @Test
    fun `JolliPushPayload has correct defaults`() {
        val payload = JolliApiClient.JolliPushPayload("Test", "Content", "abc123")
        payload.branch shouldBe null
        payload.subFolder shouldBe null
        payload.docId shouldBe null
        payload.pluginVersion shouldBe null
    }

    @Test
    fun `JolliPushResult fields work`() {
        val result = JolliApiClient.JolliPushResult("url", 1, "jrn", true)
        result.url shouldBe "url"
        result.created shouldBe true
    }

    @Test
    fun `PluginOutdatedError is a RuntimeException`() {
        val error = JolliApiClient.PluginOutdatedError("outdated")
        (error is RuntimeException) shouldBe true
        error.message shouldBe "outdated"
    }

    @Test
    fun `JolliApiKeyMeta fields work`() {
        val meta = JolliApiClient.JolliApiKeyMeta("t", "u", "o")
        meta.t shouldBe "t"
        meta.u shouldBe "u"
        meta.o shouldBe "o"
    }
}
