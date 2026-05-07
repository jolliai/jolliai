package ai.jolli.jollimemory.auth

import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.api.assertThrows
import java.util.Base64

class JolliAuthUtilsTest {

    /** Builds a sk-jol- key with the given embedded URL. */
    private fun fakeKey(url: String): String {
        val meta = """{"t":"tenant","u":"$url"}"""
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(meta.toByteArray())
        return "sk-jol-$encoded.fakesecret"
    }

    @Test
    fun `accepts https jolli-ai`() {
        assertDoesNotThrow { JolliAuthUtils.assertJolliOriginAllowed("https://jolli.ai") }
    }

    @Test
    fun `accepts https subdomain of jolli-ai`() {
        assertDoesNotThrow { JolliAuthUtils.assertJolliOriginAllowed("https://app.jolli.ai") }
    }

    @Test
    fun `accepts https jolli-dev`() {
        assertDoesNotThrow { JolliAuthUtils.assertJolliOriginAllowed("https://jolli.dev") }
    }

    @Test
    fun `accepts https subdomain of jolli-dev`() {
        assertDoesNotThrow { JolliAuthUtils.assertJolliOriginAllowed("https://foo.jolli.dev") }
    }

    @Test
    fun `accepts https jolli-cloud`() {
        assertDoesNotThrow { JolliAuthUtils.assertJolliOriginAllowed("https://jolli.cloud") }
    }

    @Test
    fun `accepts https jolli-local-me`() {
        assertDoesNotThrow { JolliAuthUtils.assertJolliOriginAllowed("https://jolli-local.me") }
    }

    @Test
    fun `accepts https subdomain of jolli-local-me`() {
        assertDoesNotThrow { JolliAuthUtils.assertJolliOriginAllowed("https://dev.jolli-local.me") }
    }

    @Test
    fun `rejects http even for allowlisted host`() {
        val ex = assertThrows<IllegalArgumentException> {
            JolliAuthUtils.assertJolliOriginAllowed("http://jolli.ai")
        }
        ex.message shouldContain "Rejected Jolli origin"
    }

    @Test
    fun `rejects non-allowlisted host`() {
        val ex = assertThrows<IllegalArgumentException> {
            JolliAuthUtils.assertJolliOriginAllowed("https://evil.com")
        }
        ex.message shouldContain "Rejected Jolli origin"
    }

    @Test
    fun `rejects suffix trick`() {
        val ex = assertThrows<IllegalArgumentException> {
            JolliAuthUtils.assertJolliOriginAllowed("https://notjolli.ai")
        }
        ex.message shouldContain "Rejected Jolli origin"
    }

    @Test
    fun `rejects allowlisted host embedded in attacker domain`() {
        val ex = assertThrows<IllegalArgumentException> {
            JolliAuthUtils.assertJolliOriginAllowed("https://jolli.ai.evil.com")
        }
        ex.message shouldContain "Rejected Jolli origin"
    }

    @Test
    fun `rejects unparseable origin`() {
        val ex = assertThrows<IllegalArgumentException> {
            JolliAuthUtils.assertJolliOriginAllowed("not a url")
        }
        ex.message shouldContain "unparseable"
    }

    // --- validateJolliApiKey tests ---

    @Test
    fun `validateJolliApiKey accepts key with allowlisted origin`() {
        assertDoesNotThrow { JolliAuthUtils.validateJolliApiKey(fakeKey("https://jolli.ai")) }
    }

    @Test
    fun `validateJolliApiKey rejects key with non-allowlisted origin`() {
        val ex = assertThrows<IllegalArgumentException> {
            JolliAuthUtils.validateJolliApiKey(fakeKey("https://evil.com"))
        }
        ex.message shouldContain "Rejected Jolli origin"
    }

    @Test
    fun `validateJolliApiKey rejects undecodable key`() {
        val ex = assertThrows<IllegalArgumentException> {
            JolliAuthUtils.validateJolliApiKey("sk-jol-notbase64")
        }
        ex.message shouldContain "cannot be decoded"
    }

    @Test
    fun `validateJolliApiKey rejects non-jolli key`() {
        val ex = assertThrows<IllegalArgumentException> {
            JolliAuthUtils.validateJolliApiKey("sk-other-abc123")
        }
        ex.message shouldContain "cannot be decoded"
    }
}
