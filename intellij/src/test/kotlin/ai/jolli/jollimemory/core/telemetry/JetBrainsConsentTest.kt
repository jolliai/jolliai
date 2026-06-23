package ai.jolli.jollimemory.core.telemetry

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class JetBrainsConsentTest {
    @Test
    fun `degrades gracefully — never throws, returns false when consent API unavailable`() {
        // In a plain unit-test JVM there is no running IDE application, so the
        // reflective ConsentOptions lookup fails and we must default to not-denied
        // (false) rather than throwing or wrongly suppressing telemetry.
        JetBrainsConsent.isUsageStatsDenied() shouldBe false
    }
}
