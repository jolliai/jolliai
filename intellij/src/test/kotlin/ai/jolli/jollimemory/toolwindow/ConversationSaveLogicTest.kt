package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.*
import ai.jolli.jollimemory.core.ConversationOverlayStore.EntryIdentity
import ai.jolli.jollimemory.core.ConversationOverlayStore.OverlayEditRule
import ai.jolli.jollimemory.core.ConversationOverlayStore.OverlayKey
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/**
 * Tests the save/overlay/hide workflow that ConversationFileEditor.doSave()
 * implements. These tests exercise the backend directly without requiring
 * IntelliJ UI fixtures.
 */
class ConversationSaveLogicTest {

	@TempDir
	lateinit var tempDir: File

	private val cwd get() = tempDir.absolutePath

	@BeforeEach
	fun setUp() {
		File(tempDir, ".jolli/jollimemory").mkdirs()
	}

	private fun key(source: TranscriptSource = TranscriptSource.claude, sessionId: String = "s1") =
		OverlayKey(cwd, source, sessionId)

	private fun entry(role: String, content: String, timestamp: String? = null) =
		TranscriptEntry(role, content, timestamp)

	private fun identity(role: String, content: String, timestamp: String? = null) =
		EntryIdentity(role, content, timestamp)

	private fun edit(role: String, content: String, newContent: String, timestamp: String? = null) =
		OverlayEditRule(role, content, timestamp, newContent)

	// ── Identity derivation anchors to raw entries ──────────────────────

	@Nested
	inner class IdentityAnchoring {
		@Test
		fun `identity is derived from raw entry content, not edited content`() {
			val k = key()
			val rawEntries = listOf(
				entry("human", "original question"),
				entry("assistant", "original answer"),
			)

			// Simulate: user edits entry 1 to "better answer"
			// Identity must anchor to "original answer" (the raw content)
			val edits = listOf(edit("assistant", "original answer", "better answer"))
			ConversationOverlayStore.saveOverlay(k, emptyList(), edits)

			val overlay = ConversationOverlayStore.loadOverlay(k)
			overlay shouldNotBe null
			overlay!!.edits shouldHaveSize 1
			overlay.edits[0].content shouldBe "original answer"
			overlay.edits[0].newContent shouldBe "better answer"

			// Apply overlay to raw entries
			val displayed = ConversationOverlayStore.applyOverlay(rawEntries, overlay)
			displayed shouldHaveSize 2
			displayed[1].content shouldBe "better answer"
		}

		@Test
		fun `chained edits preserve identity through raw content`() {
			val k = key()
			val rawContent = "original"

			// First save: edit "original" → "version2"
			ConversationOverlayStore.saveOverlay(k, emptyList(), listOf(edit("human", rawContent, "version2")))

			// Second save: user sees "version2" but identity must still anchor to "original"
			// (simulating what the editor does: rawEntries has deletes-only applied)
			val existing = ConversationOverlayStore.loadOverlay(k)
			val (mergedDeletes, mergedEdits) = ConversationOverlayStore.mergeOverlay(
				existing,
				emptyList(),
				listOf(edit("human", rawContent, "version3")),
			)
			ConversationOverlayStore.saveOverlay(k, mergedDeletes, mergedEdits)

			val final_ = ConversationOverlayStore.loadOverlay(k)
			final_ shouldNotBe null
			final_!!.edits shouldHaveSize 1
			final_.edits[0].content shouldBe rawContent
			final_.edits[0].newContent shouldBe "version3"
		}
	}

	// ── Delete wins over edit ───────────────────────────────────────────

	@Nested
	inner class DeleteWinsOverEdit {
		@Test
		fun `delete supersedes existing edit for same identity`() {
			val k = key()
			val raw = entry("human", "hello")

			// First: save an edit
			ConversationOverlayStore.saveOverlay(k, emptyList(), listOf(edit("human", "hello", "goodbye")))

			// Then: delete the same entry
			val existing = ConversationOverlayStore.loadOverlay(k)
			val (mergedDeletes, mergedEdits) = ConversationOverlayStore.mergeOverlay(
				existing,
				listOf(identity("human", "hello")),
				emptyList(),
			)
			ConversationOverlayStore.saveOverlay(k, mergedDeletes, mergedEdits)

			val final_ = ConversationOverlayStore.loadOverlay(k)
			final_ shouldNotBe null
			final_!!.deletes shouldHaveSize 1
			final_.edits.shouldBeEmpty()

			// Apply: entry should be gone
			val result = ConversationOverlayStore.applyOverlay(listOf(raw), final_)
			result.shouldBeEmpty()
		}

		@Test
		fun `editor excludes deleted indices from edits`() {
			// Simulates the editor's doSave logic: if an index is in both
			// deletedIndices and editedContent, only the delete is sent
			val rawEntries = listOf(
				entry("human", "q1"),
				entry("assistant", "a1"),
			)
			val deletedIndices = setOf(0, 1)
			val editedContent = mapOf(1 to "edited a1")

			val newDeletes = deletedIndices.map { idx ->
				val raw = rawEntries[idx]
				identity(raw.role, raw.content, raw.timestamp)
			}
			val newEdits = editedContent
				.filter { (idx, _) -> idx !in deletedIndices }
				.map { (idx, newContent) ->
					val raw = rawEntries[idx]
					edit(raw.role, raw.content, newContent, raw.timestamp)
				}

			newDeletes shouldHaveSize 2
			newEdits.shouldBeEmpty() // Both indices deleted, so no edits
		}
	}

	// ── Auto-hide on empty ──────────────────────────────────────────────

	@Nested
	inner class AutoHideOnEmpty {
		@Test
		fun `hiding a conversation persists to hidden-conversations json`() {
			HiddenConversationsStore.hideConversation(cwd, TranscriptSource.claude, "s1")

			val state = HiddenConversationsStore.loadHiddenConversations(cwd)
			HiddenConversationsStore.isHidden(state, TranscriptSource.claude, "s1") shouldBe true
			HiddenConversationsStore.isHidden(state, TranscriptSource.claude, "s2") shouldBe false
		}

		@Test
		fun `deleting all entries triggers overlay save then hide`() {
			val k = key()
			val rawEntries = listOf(
				entry("human", "q1"),
				entry("assistant", "a1"),
			)

			// Delete all entries
			val deletes = rawEntries.map { identity(it.role, it.content, it.timestamp) }
			ConversationOverlayStore.saveOverlay(k, deletes, emptyList())

			// Verify all entries are gone after overlay
			val overlay = ConversationOverlayStore.loadOverlay(k)
			val remaining = ConversationOverlayStore.applyOverlay(rawEntries, overlay)
			remaining.shouldBeEmpty()

			// Auto-hide
			HiddenConversationsStore.hideConversation(cwd, TranscriptSource.claude, "s1")
			val state = HiddenConversationsStore.loadHiddenConversations(cwd)
			HiddenConversationsStore.isHidden(state, TranscriptSource.claude, "s1") shouldBe true
		}
	}

	// ── Merge with existing overlay ─────────────────────────────────────

	@Nested
	inner class MergeWithExisting {
		@Test
		fun `mergeOverlay preserves existing rules and adds new ones`() {
			val k = key()

			// Save initial overlay with one edit
			ConversationOverlayStore.saveOverlay(
				k, emptyList(), listOf(edit("human", "q1", "edited q1")),
			)

			// Merge in a new delete for a different entry
			val existing = ConversationOverlayStore.loadOverlay(k)
			val (mergedDeletes, mergedEdits) = ConversationOverlayStore.mergeOverlay(
				existing,
				listOf(identity("assistant", "a1")),
				emptyList(),
			)

			mergedDeletes shouldHaveSize 1
			mergedDeletes[0].content shouldBe "a1"
			mergedEdits shouldHaveSize 1
			mergedEdits[0].content shouldBe "q1"
		}

		@Test
		fun `new edit replaces existing edit for same identity`() {
			val k = key()
			ConversationOverlayStore.saveOverlay(
				k, emptyList(), listOf(edit("human", "q1", "v1")),
			)

			val existing = ConversationOverlayStore.loadOverlay(k)
			val (_, mergedEdits) = ConversationOverlayStore.mergeOverlay(
				existing,
				emptyList(),
				listOf(edit("human", "q1", "v2")),
			)

			mergedEdits shouldHaveSize 1
			mergedEdits[0].newContent shouldBe "v2"
		}
	}
}
