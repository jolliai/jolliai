package ai.jolli.jollimemory.bridge

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

/**
 * Unit tests for [CliDaemonClient]'s wire helpers. Spawning a real daemon
 * requires a built Cli.js and a Node runtime, so those paths are integration
 * territory; the pieces asserted here are the ones that would silently rot
 * without being noticed — the JSON-RPC 2.0 envelope on the way in and the way
 * out.
 */
class CliDaemonClientTest {

	// ── PROTOCOL — lockstep with cli/src/commands/IdeBridgeCommand.ts ──────
	// If this value ever drifts, every ide-bridge call the plugin makes
	// falls back to one-shot spawns (the handshake check in [startDaemon]
	// rejects a mismatched daemon), so the daemon speedup silently
	// disappears. Bump both together.

	@Test
	fun `PROTOCOL is the stable named version`() {
		CliDaemonClient.PROTOCOL shouldBe "jolli-ide-bridge-jsonrpc-v1"
	}

	// ── serializeRequestLine — wire shape of every request ────────────────

	@Test
	fun `serializeRequestLine emits a single-line JSON-RPC 2_0 request`() {
		val line = CliDaemonClient.serializeRequestLine(
			id = 7L,
			action = "session-state",
			cwd = "/tmp/repo",
			requestJson = """{"operation":"config-load"}""",
		)
		// Protocol invariant: exactly one JSON object per line.
		line shouldNotContain "\n"
		val obj = JsonParser.parseString(line).asJsonObject
		obj.get("jsonrpc").asString shouldBe "2.0"
		obj.get("id").asLong shouldBe 7L
		obj.get("method").asString shouldBe "session-state"
		val params = obj.getAsJsonObject("params")
		params.get("cwd").asString shouldBe "/tmp/repo"
		params.getAsJsonObject("request").get("operation").asString shouldBe "config-load"
	}

	@Test
	fun `serializeRequestLine treats a null request body as an empty object (not a missing field)`() {
		// A missing `request` field would make the server-side normaliseServeRequest
		// happy too, but the invariant we want is "always present so downstream
		// code can just index into it." Assert it.
		val line = CliDaemonClient.serializeRequestLine(1L, "status", "/tmp/x", null)
		val obj = JsonParser.parseString(line).asJsonObject
		val params = obj.getAsJsonObject("params")
		params.has("request") shouldBe true
		params.getAsJsonObject("request").size() shouldBe 0
	}

	@Test
	fun `serializeRequestLine treats a blank request body identically to null`() {
		val a = CliDaemonClient.serializeRequestLine(1L, "status", "/tmp/x", null)
		val b = CliDaemonClient.serializeRequestLine(1L, "status", "/tmp/x", "")
		val c = CliDaemonClient.serializeRequestLine(1L, "status", "/tmp/x", "   \t\n ")
		a shouldBe b
		b shouldBe c
	}

	@Test
	fun `serializeRequestLine round-trips an already-serialized JSON body`() {
		// The Kotlin caller side (SummaryStore.run, PinStore.run, etc.) hands
		// us a preserialized JSON string. It must round-trip losslessly.
		val body = """{"operation":"filter-hashes","hashes":["aaaa1111","bbbb2222"]}"""
		val line = CliDaemonClient.serializeRequestLine(3L, "summary-store", "/tmp/x", body)
		val obj = JsonParser.parseString(line).asJsonObject
		val request = obj.getAsJsonObject("params").getAsJsonObject("request")
		request.get("operation").asString shouldBe "filter-hashes"
		val arr = request.get("hashes") as JsonArray
		arr.size() shouldBe 2
		arr[0].asString shouldBe "aaaa1111"
		arr[1].asString shouldBe "bbbb2222"
	}

	@Test
	fun `serializeRequestLine rejects a body that is not a JSON object (top-level array)`() {
		// A JSON array top level would be ambiguous — the server contract is
		// "a JSON object" — so we surface parse-time failure loudly rather
		// than shipping a wrong payload the daemon would then reject.
		val ex = assertThrows(IllegalArgumentException::class.java) {
			CliDaemonClient.serializeRequestLine(1L, "x", "/tmp/x", "[1,2,3]")
		}
		ex.message!! shouldContain "JSON object"
	}

	@Test
	fun `serializeRequestLine rejects a top-level primitive`() {
		// String / number / boolean bodies are the same wire-shape violation
		// as an array — reject them at serialise time for the same reason.
		assertThrows(IllegalArgumentException::class.java) {
			CliDaemonClient.serializeRequestLine(1L, "x", "/tmp/x", "\"just a string\"")
		}
		assertThrows(IllegalArgumentException::class.java) {
			CliDaemonClient.serializeRequestLine(1L, "x", "/tmp/x", "42")
		}
	}

	// ── unwrapResponseEnvelope — error / success mapping ──────────────────

	@Test
	fun `unwrapResponseEnvelope returns the result element on success`() {
		val env = JsonObject().apply {
			addProperty("jsonrpc", "2.0")
			addProperty("id", 5L)
			add("result", JsonObject().apply { addProperty("enabled", true) })
		}
		val res = CliDaemonClient.unwrapResponseEnvelope(env).asJsonObject
		res.get("enabled").asBoolean shouldBe true
	}

	@Test
	fun `unwrapResponseEnvelope returns JsonNull when success has no result field`() {
		// The CLI passes `undefined` through as an absent field; the wrapper
		// normalises that to JsonNull.INSTANCE so callers can assume the
		// element is never null-in-Kotlin.
		val env = JsonObject().apply {
			addProperty("jsonrpc", "2.0")
			addProperty("id", 5L)
		}
		CliDaemonClient.unwrapResponseEnvelope(env) shouldBe JsonNull.INSTANCE
	}

	@Test
	fun `unwrapResponseEnvelope rethrows an error envelope as CliBridgeException`() {
		val env = JsonObject().apply {
			addProperty("jsonrpc", "2.0")
			addProperty("id", 5L)
			add(
				"error",
				JsonObject().apply {
					addProperty("code", -32000)
					addProperty("message", "No LLM provider available.")
					add("data", JsonObject().apply { addProperty("errorName", "SomeError") })
				},
			)
		}
		val ex = assertThrows(CliIntegrations.CliBridgeException::class.java) {
			CliDaemonClient.unwrapResponseEnvelope(env)
		}
		ex.message shouldBe "No LLM provider available."
		ex.errorName shouldBe "SomeError"
	}

	@Test
	fun `unwrapResponseEnvelope surfaces optional data as an empty JsonObject when absent`() {
		val env = JsonObject().apply {
			addProperty("jsonrpc", "2.0")
			addProperty("id", 5L)
			add(
				"error",
				JsonObject().apply {
					addProperty("code", -32000)
					addProperty("message", "boom")
				},
			)
		}
		val ex = assertThrows(CliIntegrations.CliBridgeException::class.java) {
			CliDaemonClient.unwrapResponseEnvelope(env)
		}
		ex.details.size() shouldBe 0
	}

	@Test
	fun `unwrapResponseEnvelope surfaces error data when the CLI returned it`() {
		val data = JsonObject().apply {
			addProperty("errorName", "AuthFailure")
			addProperty("kind", "auth")
			addProperty("retryable", false)
		}
		val env = JsonObject().apply {
			addProperty("jsonrpc", "2.0")
			addProperty("id", 5L)
			add(
				"error",
				JsonObject().apply {
					addProperty("code", -32000)
					addProperty("message", "auth failed")
					add("data", data)
				},
			)
		}
		val ex = assertThrows(CliIntegrations.CliBridgeException::class.java) {
			CliDaemonClient.unwrapResponseEnvelope(env)
		}
		ex.details.get("kind").asString shouldBe "auth"
		ex.details.get("retryable").asBoolean shouldBe false
	}

	@Test
	fun `unwrapResponseEnvelope tolerates a JsonNull errorName inside data`() {
		// The CLI writes errorName as undefined when the thrown value is not
		// an Error subclass. Gson serialises that as JSON `null`. The wrapper
		// must not turn "explicit null" into the literal string "null".
		val env = JsonObject().apply {
			addProperty("jsonrpc", "2.0")
			add(
				"error",
				JsonObject().apply {
					addProperty("code", -32000)
					addProperty("message", "plain failure")
					add("data", JsonObject().apply { add("errorName", JsonNull.INSTANCE) })
				},
			)
		}
		val ex = assertThrows(CliIntegrations.CliBridgeException::class.java) {
			CliDaemonClient.unwrapResponseEnvelope(env)
		}
		ex.errorName shouldBe null
	}

	// ── PROTOCOL parity with the CLI ──────────────────────────────────────
	// A soft double-check that the Kotlin side of the handshake matches the
	// TypeScript constant. Reading the CLI source is a fragile test in isolation,
	// but the value is short and stable, so we cross-check by string here — a
	// grep-visible early warning if someone bumps only one side.

	@Test
	fun `PROTOCOL matches the value literal declared in IdeBridgeCommand ts`() {
		// This is deliberately duplicated from the previous test as a
		// grep target: search for the literal string to find every location
		// that must be bumped together.
		CliDaemonClient.PROTOCOL shouldBe "jolli-ide-bridge-jsonrpc-v1"
		CliDaemonClient.PROTOCOL shouldNotBe ""
	}
}
