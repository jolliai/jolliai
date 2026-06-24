package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldMatch
import org.junit.jupiter.api.Test

/**
 * Unit tests for [TraceContext]. Pins the Jolli-private wire contract that must
 * stay byte-for-byte in lockstep with the TS module (`cli/src/core/TraceContext.ts`)
 * and the backend (`jolli-common` `TraceContext.ts`): header `x-jolli-trace`,
 * value `<traceId>-<spanId>` (no W3C `00-` version / `-01` flags).
 */
class TraceContextTest {

	private val traceIdRe = Regex("^[0-9a-f]{32}$")
	private val spanIdRe = Regex("^[0-9a-f]{16}$")
	private val traceValueRe = Regex("^[0-9a-f]{32}-[0-9a-f]{16}$")

	@Test
	fun `header name is the Jolli-private header, not W3C traceparent`() {
		TraceContext.HEADER_NAME shouldBe "x-jolli-trace"
	}

	@Test
	fun `generates well-formed, unique ids`() {
		TraceContext.generateTraceId() shouldMatch traceIdRe
		TraceContext.generateSpanId() shouldMatch spanIdRe
		TraceContext.generateTraceId() shouldNotBe TraceContext.generateTraceId()
	}

	@Test
	fun `buildTraceHeader emits the 2-segment shape without W3C version or flags`() {
		val traceId = "a".repeat(32)
		val spanId = "b".repeat(16)
		TraceContext.buildTraceHeader(traceId, spanId) shouldBe "$traceId-$spanId"
	}

	@Test
	fun `newTraceHeader returns a fresh well-formed value`() {
		TraceContext.newTraceHeader() shouldMatch traceValueRe
		TraceContext.newTraceHeader() shouldNotBe TraceContext.newTraceHeader()
	}
}
