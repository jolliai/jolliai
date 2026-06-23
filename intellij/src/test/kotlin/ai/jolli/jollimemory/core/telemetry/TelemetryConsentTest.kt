package ai.jolli.jollimemory.core.telemetry

import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class TelemetryConsentTest {
    @Test
    fun `on by default`() {
        TelemetryConsent.resolve(telemetryFlag = null, env = emptyMap()) shouldBe
            TelemetryConsent.Result(true, TelemetryConsent.Reason.ON)
    }

    @Test
    fun `DO_NOT_TRACK opts out unless 0 or empty`() {
        TelemetryConsent.isEnabled(null, mapOf("DO_NOT_TRACK" to "1")).shouldBeFalse()
        TelemetryConsent.isEnabled(null, mapOf("DO_NOT_TRACK" to "true")).shouldBeFalse()
        TelemetryConsent.isEnabled(null, mapOf("DO_NOT_TRACK" to " 1 ")).shouldBeFalse()
        TelemetryConsent.isEnabled(null, mapOf("DO_NOT_TRACK" to "0")).shouldBeTrue()
        TelemetryConsent.isEnabled(null, mapOf("DO_NOT_TRACK" to "")).shouldBeTrue()
    }

    @Test
    fun `honors host platform opt-out`() {
        TelemetryConsent.resolve(null, emptyMap(), platformDisabled = true) shouldBe
            TelemetryConsent.Result(false, TelemetryConsent.Reason.PLATFORM_OFF)
    }

    @Test
    fun `honors config off`() {
        TelemetryConsent.resolve("off", emptyMap()) shouldBe
            TelemetryConsent.Result(false, TelemetryConsent.Reason.CONFIG_OFF)
        TelemetryConsent.isEnabled("on", emptyMap()).shouldBeTrue()
    }

    @Test
    fun `precedence DO_NOT_TRACK over platform over config`() {
        TelemetryConsent.resolve("off", mapOf("DO_NOT_TRACK" to "1"), platformDisabled = true).reason shouldBe
            TelemetryConsent.Reason.DO_NOT_TRACK
        TelemetryConsent.resolve("off", emptyMap(), platformDisabled = true).reason shouldBe
            TelemetryConsent.Reason.PLATFORM_OFF
    }

    @Test
    fun `shouldShowNotice once when enabled and not shown`() {
        TelemetryConsent.shouldShowNotice(noticeShown = false, telemetryFlag = null, env = emptyMap()).shouldBeTrue()
        TelemetryConsent.shouldShowNotice(noticeShown = true, telemetryFlag = null, env = emptyMap()).shouldBeFalse()
        TelemetryConsent.shouldShowNotice(noticeShown = false, telemetryFlag = "off", env = emptyMap()).shouldBeFalse()
    }
}
