package ai.jolli.jollimemory.core.telemetry

import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.ints.shouldBeGreaterThanOrEqual
import io.kotest.matchers.string.shouldNotBeBlank
import org.junit.jupiter.api.Test

class TelemetryEventsTest {
    @Test
    fun `registers the v1 catalog with non-blank docs`() {
        TelemetryEvents.TELEMETRY_EVENTS.size shouldBeGreaterThanOrEqual 19
        for ((_, doc) in TelemetryEvents.TELEMETRY_EVENTS) {
            doc.shouldNotBeBlank()
        }
    }

    @Test
    fun `every name follows the object_action convention`() {
        for (name in TelemetryEvents.TELEMETRY_EVENTS.keys) {
            TelemetryEvents.TELEMETRY_EVENT_NAME_PATTERN.matches(name).shouldBeTrue()
        }
    }

    @Test
    fun `the naming pattern rejects malformed names`() {
        for (bad in listOf("Recall", "recall", "recall_", "_recall", "recall__performed", "recall performed")) {
            TelemetryEvents.TELEMETRY_EVENT_NAME_PATTERN.matches(bad).shouldBeFalse()
        }
        for (good in listOf("recall_performed", "signin_completed", "app_installed", "ai_source_detected")) {
            TelemetryEvents.TELEMETRY_EVENT_NAME_PATTERN.matches(good).shouldBeTrue()
        }
    }

    @Test
    fun `isTelemetryEventName accepts registered names and rejects everything else`() {
        TelemetryEvents.isTelemetryEventName("recall_performed").shouldBeTrue()
        TelemetryEvents.isTelemetryEventName("signin_completed").shouldBeTrue()
        TelemetryEvents.isTelemetryEventName("not_a_real_event").shouldBeFalse()
        TelemetryEvents.isTelemetryEventName("").shouldBeFalse()
    }
}
