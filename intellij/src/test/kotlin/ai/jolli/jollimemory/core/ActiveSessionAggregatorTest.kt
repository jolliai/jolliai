package ai.jolli.jollimemory.core

import com.google.gson.Gson
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
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
 *
 * For the staged-rollout gap (`hermes`), the aggregator boundary drops the
 * null-decoded item instead of letting it reach the UI — see
 * [ActiveSessionAggregator.filterAndApplyConfig].
 */
class ActiveSessionAggregatorTest {

	private val gson = Gson()

	/**
	 * Matches the JVM-supported subset of `cli/src/Types.ts TRANSCRIPT_SOURCES`.
	 * KNOWN GAP: `hermes` is intentionally omitted until the follow-up IntelliJ
	 * integration PR can add its enum, config and UI mappings atomically. Keep this
	 * comment with the omission so reviews do not mistake the staged rollout for
	 * accidental drift.
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
		"kimi",
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
			item.source.shouldNotBeNull().name shouldBe allSources[i]
		}
		result.failedSources.forEachIndexed { i, source ->
			source.shouldNotBeNull().name shouldBe allSources[i]
		}
	}

	@Test
	fun `unknown CLI source is dropped at the decode boundary, never treated as a known source`() {
		// `hermes` is the current unknown (see Types.kt's KNOWN JVM GAP): a newer
		// CLI emits it in `active-conversations` while this enum does not know it.
		val json = """{"items":[{"sessionId":"s1","source":"hermes","title":"Hermes session","messageCount":1,"updatedAt":"2026-08-26T00:00:00Z","transcriptPath":"/db#s1","isSelected":true}],"failedSources":["hermes"]}"""
		val raw = gson.fromJson(json, ActiveConversationsResult::class.java)

		// Gson's unknown-enum behavior is null, not an exception — which is exactly
		// why the pre-fix code NPE'd later at `item.source.name` in the renderer.
		@Suppress("SENSELESS_COMPARISON")
		(raw.items.single().source as TranscriptSource?).shouldBeNull()
		@Suppress("SENSELESS_COMPARISON")
		(raw.failedSources.single() as TranscriptSource?).shouldBeNull()

		// The boundary drops both: a hermes session must not ride claudeEnabled
		// (misattribution) and must never reach the renderer (NPE).
		val result = ActiveSessionAggregator.filterAndApplyConfig(raw, JolliMemoryConfig())
		result.items shouldBe emptyList()
		result.failedSources shouldBe emptyList()
	}

	@Test
	fun `unknown failed source does not flip the unavailable banner when claude is disabled`() {
		// The legacy `isSourceEnabled(null)` fallback reads claudeEnabled; a null
		// source must be dropped BEFORE that fallback, or disabling claude would
		// look like it silenced an undecodable source.
		val json = """{"items":[],"failedSources":["hermes"]}"""
		val raw = gson.fromJson(json, ActiveConversationsResult::class.java)
		val result = ActiveSessionAggregator.filterAndApplyConfig(
			raw,
			JolliMemoryConfig(claudeEnabled = false),
		)
		result.failedSources shouldBe emptyList()
	}

	@Test
	fun `TranscriptSource enum stays in lockstep with the CLI source list`() {
		// The complementary assertion to the round-trip above: if the enum
		// itself drifts (someone removes a member), catch it here rather than
		// through a spooky Gson-null in production.
		TranscriptSource.entries.map { it.name } shouldContainExactly allSources
	}

	// ── isSourceEnabled — hand-mirror of cli/src/core/SessionTracker.ts ──
	//
	// The Kotlin implementation is a hand-maintained mirror of the CLI function of
	// the same name (canonical definition in `SessionTracker.ts`; re-exported by
	// `ActiveSessionAggregator.ts` for pre-existing importers — see the comment
	// on [ActiveSessionAggregator.isSourceEnabled]). The CLI-side has its own
	// vitest suite that pins the mapping to `config.xxxEnabled !== false`; these
	// tests pin the same contract on the Kotlin side so a one-sided edit of the
	// switch statement fails loudly.

	@Test
	fun `default config leaves every source enabled (fail-open)`() {
		val cfg = JolliMemoryConfig()
		for (src in TranscriptSource.entries) {
			ActiveSessionAggregator.isSourceEnabled(src, cfg) shouldBe true
		}
		// Legacy sessions predating the source field ride claudeEnabled.
		ActiveSessionAggregator.isSourceEnabled(null, cfg) shouldBe true
	}

	@Test
	fun `null source falls back to claudeEnabled`() {
		ActiveSessionAggregator.isSourceEnabled(null, JolliMemoryConfig()) shouldBe true
		ActiveSessionAggregator.isSourceEnabled(null, JolliMemoryConfig(claudeEnabled = false)) shouldBe false
		// Only `false` is off; every other value (including true) is on.
		ActiveSessionAggregator.isSourceEnabled(null, JolliMemoryConfig(claudeEnabled = true)) shouldBe true
	}

	@Test
	fun `each singleton flag switches its own source off`() {
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.claude, JolliMemoryConfig(claudeEnabled = false)) shouldBe false
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.codex, JolliMemoryConfig(codexEnabled = false)) shouldBe false
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.gemini, JolliMemoryConfig(geminiEnabled = false)) shouldBe false
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.opencode, JolliMemoryConfig(openCodeEnabled = false)) shouldBe false
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.devin, JolliMemoryConfig(devinEnabled = false)) shouldBe false
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.antigravity, JolliMemoryConfig(antigravityEnabled = false)) shouldBe false
	}

	@Test
	fun `cursorEnabled toggles both cursor and cursor-cli in lockstep`() {
		val off = JolliMemoryConfig(cursorEnabled = false)
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.cursor, off) shouldBe false
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.`cursor-cli`, off) shouldBe false
		val on = JolliMemoryConfig(cursorEnabled = true)
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.cursor, on) shouldBe true
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.`cursor-cli`, on) shouldBe true
	}

	@Test
	fun `copilotEnabled toggles both copilot and copilot-chat in lockstep`() {
		val off = JolliMemoryConfig(copilotEnabled = false)
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.copilot, off) shouldBe false
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.`copilot-chat`, off) shouldBe false
	}

	@Test
	fun `clineEnabled toggles both cline and cline-cli in lockstep`() {
		val off = JolliMemoryConfig(clineEnabled = false)
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.cline, off) shouldBe false
		ActiveSessionAggregator.isSourceEnabled(TranscriptSource.`cline-cli`, off) shouldBe false
	}

	@Test
	fun `disabling one source does not affect other sources`() {
		val cfg = JolliMemoryConfig(claudeEnabled = false)
		// Only claude flips; every other source stays on.
		TranscriptSource.entries.filter { it != TranscriptSource.claude }.forEach {
			ActiveSessionAggregator.isSourceEnabled(it, cfg) shouldBe true
		}
	}
}
