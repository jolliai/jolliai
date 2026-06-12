package ai.jolli.jollimemory.auth

import io.kotest.matchers.shouldBe
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

    // --- shouldRequestFreshApiKey tests ---

    @Test
    fun `shouldRequestFreshApiKey true when no existing key`() {
        JolliAuthUtils.shouldRequestFreshApiKey(null, "https://jolli.ai") shouldBe true
        JolliAuthUtils.shouldRequestFreshApiKey("", "https://jolli.ai") shouldBe true
        JolliAuthUtils.shouldRequestFreshApiKey("   ", "https://jolli.ai") shouldBe true
    }

    @Test
    fun `shouldRequestFreshApiKey false when key tenant matches target`() {
        JolliAuthUtils.shouldRequestFreshApiKey(fakeKey("https://jolli.ai"), "https://jolli.ai") shouldBe false
    }

    @Test
    fun `shouldRequestFreshApiKey true on cross-tenant switch`() {
        // The bug this fixes: stale jolli.ai key, signing into jolli-local.me.
        JolliAuthUtils.shouldRequestFreshApiKey(
            fakeKey("https://jolli.ai"),
            "https://jolli-local.me",
        ) shouldBe true
    }

    @Test
    fun `shouldRequestFreshApiKey origin compares case-insensitively`() {
        JolliAuthUtils.shouldRequestFreshApiKey(
            fakeKey("https://Jolli.AI"),
            "https://jolli.ai",
        ) shouldBe false
    }

    @Test
    fun `shouldRequestFreshApiKey true when tenant slug differs`() {
        JolliAuthUtils.shouldRequestFreshApiKey(
            fakeKey("https://jolli-local.me/dev"),
            "https://jolli-local.me/prod",
        ) shouldBe true
    }

    @Test
    fun `shouldRequestFreshApiKey false when tenant slug matches`() {
        JolliAuthUtils.shouldRequestFreshApiKey(
            fakeKey("https://jolli-local.me/prod"),
            "https://jolli-local.me/prod",
        ) shouldBe false
    }

    @Test
    fun `shouldRequestFreshApiKey tenant slug compares case-sensitively`() {
        // Slug flows downstream verbatim as x-tenant-slug, so a case variant is
        // a different tenant — fail safe by requesting a fresh key.
        JolliAuthUtils.shouldRequestFreshApiKey(
            fakeKey("https://jolli-local.me/Acme"),
            "https://jolli-local.me/acme",
        ) shouldBe true
    }

    @Test
    fun `shouldRequestFreshApiKey false for undecodable legacy key`() {
        // Can't prove it's stale; don't surprise-drop a hand-typed key.
        JolliAuthUtils.shouldRequestFreshApiKey("sk-jol-notbase64", "https://jolli.ai") shouldBe false
    }
}
