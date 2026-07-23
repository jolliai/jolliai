package ai.jolli.jollimemory.core

import com.google.gson.Gson
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Guards the CLI ↔ Kotlin `TranscriptSource` lockstep.
 *
 * The `active-conversations` ide-bridge action returns JSON that Kotlin
 * deserialises via Gson into [ActiveConversationsResult]. Gson resolves an
 * unknown enum name to `null` and installs it into a non-null Kotlin field
 * through Unsafe — that is, an enum member missing from the Kotlin side does
 * NOT surface as a Gson exception but as a downstream NPE the moment the UI
 * touches `item.source`.
 *
 * These tests round-trip every currently-shipping source through Gson and
 * assert non-null. Adding a source to the CLI without matching this enum
 * makes the round-trip null-check fail, giving the change author a signal
 * long before the sidebar crashes for end users.
 */
class ActiveSessionAggregatorTest {

	private val gson = Gson()

	/**
	 * MUST match `cli/src/Types.ts TRANSCRIPT_SOURCES` verbatim. If a new source
	 * ships on the CLI side, add its raw string here and the corresponding
	 * `TranscriptSource` enum member together.
	 */
	private val allSources = listOf(
		"claude",
		"codex",
		"gemini",
		"opencode",
		"cursor",
		"cursor-cli",
		"copilot",
		"copilot-chat",
		"cline",
		"cline-cli",
		"devin",
		"antigravity",
	)

	@Test
	fun `every CLI-known TranscriptSource round-trips into a non-null Kotlin enum`() {
		val itemsJson = allSources.mapIndexed { i, s ->
			"""{"sessionId":"s$i","source":"$s","title":"t$i","messageCount":$i,"updatedAt":"2026-07-23T00:00:00Z","transcriptPath":"/tmp/$s.jsonl","isSelected":true}"""
		}.joinToString(",")
		val failedJson = allSources.joinToString(",") { "\"$it\"" }
		val json = """{"items":[$itemsJson],"failedSources":[$failedJson]}"""

		val result = gson.fromJson(json, ActiveConversationsResult::class.java)

		// Both collections must have every source resolved to a real enum value.
		// A missing enum member would show up as either a null entry or, worse,
		// a stealthily-installed null (via Unsafe) that only NPEs when dereferenced.
		result.items shouldContainExactly result.items
		result.items.size shouldBe allSources.size
		result.failedSources.size shouldBe allSources.size

		result.items.forEachIndexed { i, item ->
			item.shouldNotBeNull()
			@Suppress("SENSELESS_COMPARISON")
			(item.source as TranscriptSource?).shouldNotBeNull()
			item.source.name shouldBe allSources[i]
		}
		result.failedSources.forEachIndexed { i, source ->
			@Suppress("SENSELESS_COMPARISON")
			(source as TranscriptSource?).shouldNotBeNull()
			source.name shouldBe allSources[i]
		}
	}

	@Test
	fun `TranscriptSource enum stays in lockstep with the CLI source list`() {
		// The complementary assertion to the round-trip above: if the enum
		// itself drifts (someone removes a member), catch it here rather than
		// through a spooky Gson-null in production.
		TranscriptSource.entries.map { it.name } shouldContainExactly allSources
	}
}
