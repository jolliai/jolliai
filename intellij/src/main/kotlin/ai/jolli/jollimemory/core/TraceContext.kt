package ai.jolli.jollimemory.core

import java.security.SecureRandom

/**
 * TraceContext — Jolli trace id generation for outbound backend requests.
 *
 * The `x-jolli-trace` header lets the Jolli backend group all logs of one
 * logical operation, including those it triggers downstream.
 *
 * Wire contract — deliberately **Jolli-private, not W3C**: header
 * [HEADER_NAME] = `x-jolli-trace` (not the W3C-reserved `traceparent`), value
 * `<traceId>-<spanId>` (no `00-` version byte, no `-01` flags). Keep this
 * byte-for-byte identical to the TS module (`cli/src/core/TraceContext.ts`) and
 * the backend contract (`jolli-common` `TraceContext.ts`). The `<spanId>` is a
 * flat per-request marker (fresh per outbound call); there is no client-side
 * span hierarchy — correlation is by `traceId`. Every backend request carries
 * the header: this operation's id inside a scope, else a fresh one-shot value.
 *
 * Ambient context: a `ThreadLocal` set by [withTrace] makes the id ambient for
 * one logical operation, so [JmLogger] can stamp `[trace=<id>]` on every line
 * and the out-call sites can read it via [currentTraceHeader] without threading
 * a parameter. This mirrors the TS module's `AsyncLocalStorage`. IntelliJ work
 * is synchronous + single-threaded per operation, so a `ThreadLocal` is the
 * right fit (no coroutine/async hop to lose context across). Callers that are
 * not inside any operation scope can still mint a one-shot id via
 * [newTraceHeader].
 */
object TraceContext {

	/** HTTP header carrying the Jolli trace context. Matches backend `TRACE_HEADER_NAME`. */
	const val HEADER_NAME = "x-jolli-trace"

	private val random = SecureRandom()

	/** 32 lowercase-hex trace id. */
	private val TRACE_ID_RE = Regex("^[0-9a-f]{32}$")

	/** All-zero trace id — the invalid sentinel the backend rejects; never adopt or emit it. */
	private val INVALID_TRACE_ID = "0".repeat(32)

	/** Ambient trace id for the current thread's operation, or null outside any [withTrace] scope. */
	private val ambient = ThreadLocal<String?>()

	/** Generates a trace id: 16 random bytes as 32 lowercase hex (never all-zero). */
	fun generateTraceId(): String = randomNonZeroHex(16)

	/** Generates a span id: 8 random bytes as 16 lowercase hex (never all-zero). */
	fun generateSpanId(): String = randomNonZeroHex(8)

	/**
	 * Builds a Jolli trace value: `<traceId>-<spanId>` (Jolli-private 2-segment,
	 * no W3C version/flags).
	 */
	fun buildTraceHeader(traceId: String, spanId: String): String = "$traceId-$spanId"

	/** A fresh trace value for a single outbound request (no ambient scope). */
	fun newTraceHeader(): String = buildTraceHeader(generateTraceId(), generateSpanId())

	/**
	 * Runs [block] inside an ambient trace scope so [JmLogger] tags every line
	 * and [currentTraceHeader] returns this operation's id. Adopts [traceId] when
	 * it is a well-formed, non-all-zero id, else mints a fresh one. Restores the
	 * previous ambient id on exit so nested/pooled-thread reuse is safe.
	 */
	fun <T> withTrace(traceId: String? = null, block: () -> T): T {
		val previous = ambient.get()
		val id = if (traceId != null && isValidTraceId(traceId)) traceId else generateTraceId()
		ambient.set(id)
		try {
			return block()
		} finally {
			if (previous != null) ambient.set(previous) else ambient.remove()
		}
	}

	/** The ambient trace id, or null outside any [withTrace] scope. */
	fun getCurrentTraceId(): String? = ambient.get()

	/**
	 * An `x-jolli-trace` value for the ambient trace with a fresh span id (each
	 * outbound request is its own client span), or null when no trace is active
	 * so callers can fall back to [newTraceHeader].
	 */
	fun currentTraceHeader(): String? = ambient.get()?.let { buildTraceHeader(it, generateSpanId()) }

	private fun isValidTraceId(id: String): Boolean = TRACE_ID_RE.matches(id) && id != INVALID_TRACE_ID

	/** Random [byteCount] bytes as lowercase hex, regenerating on the all-zero sentinel the backend rejects. */
	private fun randomNonZeroHex(byteCount: Int): String {
		val bytes = ByteArray(byteCount)
		while (true) {
			random.nextBytes(bytes)
			if (bytes.any { it.toInt() != 0 }) {
				return bytes.joinToString("") { "%02x".format(it) }
			}
		}
	}
}
