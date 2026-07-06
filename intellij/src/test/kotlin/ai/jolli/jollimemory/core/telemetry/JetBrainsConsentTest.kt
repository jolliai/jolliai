package ai.jolli.jollimemory.core.telemetry

import io.kotest.assertions.throwables.shouldNotThrowAny
import org.junit.jupiter.api.Test

class JetBrainsConsentTest {
    @Test
    fun `degrades gracefully — never throws regardless of consent API availability`() {
        // The reflective ConsentOptions lookup must never propagate an exception:
        // when the API is absent (headless worker JVM) it catches and returns false;
        // when the platform IS on the test classpath it resolves to the runtime's
        // ThreeState. Both are valid — the only environment-independent guarantee is
        // that the call returns cleanly rather than throwing or wrongly suppressing.
        shouldNotThrowAny { JetBrainsConsent.isUsageStatsDenied() }
    }
}
