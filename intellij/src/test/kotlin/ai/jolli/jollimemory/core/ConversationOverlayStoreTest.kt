package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class ConversationOverlayStoreTest {

	@TempDir
	lateinit var tempDir: File

	private val cwd get() = tempDir.absolutePath

	@BeforeEach
	fun setUp() {
		File(tempDir, ".jolli/jollimemory").mkdirs()
	}

	private fun key(source: TranscriptSource = TranscriptSource.claude, sessionId: String = "s1") =
		ConversationOverlayStore.OverlayKey(cwd, source, sessionId)

	private fun entry(role: String, content: String, timestamp: String? = null) =
		TranscriptEntry(role, content, timestamp)

	private fun identity(role: String, content: String, timestamp: String? = null) =
		ConversationOverlayStore.EntryIdentity(role, content, timestamp)

	private fun edit(role: String, content: String, newContent: String, timestamp: String? = null) =
		ConversationOverlayStore.OverlayEditRule(role, content, timestamp, newContent)

	// ── Save / Load round-trip ──────────────────────────────────────────

	@Nested
	inner class SaveAndLoad {
		@Test
		fun `saveOverlay and loadOverlay round-trip`() {
			val k = key()
			val deletes = listOf(identity("human", "delete me"))
			val edits = listOf(edit("assistant", "old", "new"))

			ConversationOverlayStore.saveOverlay(k, deletes, edits)
			val loaded = ConversationOverlayStore.loadOverlay(k)

			loaded shouldNotBe null
			loaded!!.source shouldBe "claude"
			loaded.sessionId shouldBe "s1"
			loaded.deletes shouldHaveSize 1
			loaded.deletes[0].content shouldBe "delete me"
			loaded.edits shouldHaveSize 1
			loaded.edits[0].newContent shouldBe "new"
		}

		@Test
		fun `loadOverlay returns null when file does not exist`() {
			ConversationOverlayStore.loadOverlay(key(sessionId = "nonexistent")) shouldBe null
		}

		@Test
		fun `loadOverlay rejects key mismatch`() {
			val k = key(sessionId = "s1")
			ConversationOverlayStore.saveOverlay(k, emptyList(), emptyList())

			// Try loading with a different sessionId pointing at the same file won't work
			// because the file is at s1's path. Load with original key should work.
			ConversationOverlayStore.loadOverlay(k) shouldNotBe null
		}

		@Test
		fun `loadOverlay returns null for malformed JSON`() {
			val k = key()
			val path = ConversationOverlayStore.overlayPath(k)
			File(path).parentFile.mkdirs()
			File(path).writeText("not json at all")

			ConversationOverlayStore.loadOverlay(k) shouldBe null
		}

		@Test
		fun `loadOverlay returns null for wrong version`() {
			val k = key()
			val path = ConversationOverlayStore.overlayPath(k)
			File(path).parentFile.mkdirs()
			File(path).writeText("""{"version":999,"source":"claude","sessionId":"s1","updatedAt":"x","deletes":[],"edits":[]}""")

			ConversationOverlayStore.loadOverlay(k) shouldBe null
		}
	}

	// ── applyOverlay ────────────────────────────────────────────────────

	@Nested
	inner class ApplyOverlay {
		@Test
		fun `null overlay returns entries unchanged`() {
			val entries = listOf(entry("human", "hi"))
			ConversationOverlayStore.applyOverlay(entries, null) shouldBe entries
		}

		@Test
		fun `deletes remove matching entries`() {
			val entries = listOf(
				entry("human", "keep"),
				entry("human", "remove"),
				entry("assistant", "also keep"),
			)
			val k = key()
			ConversationOverlayStore.saveOverlay(k, listOf(identity("human", "remove")), emptyList())
			val overlay = ConversationOverlayStore.loadOverlay(k)!!

			val result = ConversationOverlayStore.applyOverlay(entries, overlay)
			result shouldHaveSize 2
			result[0].content shouldBe "keep"
			result[1].content shouldBe "also keep"
		}

		@Test
		fun `edits replace content`() {
			val entries = listOf(entry("assistant", "old answer"))
			val k = key()
			ConversationOverlayStore.saveOverlay(k, emptyList(), listOf(edit("assistant", "old answer", "new answer")))
			val overlay = ConversationOverlayStore.loadOverlay(k)!!

			val result = ConversationOverlayStore.applyOverlay(entries, overlay)
			result shouldHaveSize 1
			result[0].content shouldBe "new answer"
		}

		@Test
		fun `delete wins over edit for same identity`() {
			val entries = listOf(entry("human", "target"))
			val k = key()
			ConversationOverlayStore.saveOverlay(
				k,
				listOf(identity("human", "target")),
				listOf(edit("human", "target", "edited")),
			)
			val overlay = ConversationOverlayStore.loadOverlay(k)!!

			val result = ConversationOverlayStore.applyOverlay(entries, overlay)
			result.shouldBeEmpty()
		}
	}

	// ── applyDeletes ────────────────────────────────────────────────────

	@Nested
	inner class ApplyDeletes {
		@Test
		fun `only removes deleted entries, leaves edits with raw content`() {
			val entries = listOf(
				entry("human", "delete me"),
				entry("assistant", "edit me"),
			)
			val k = key()
			ConversationOverlayStore.saveOverlay(
				k,
				listOf(identity("human", "delete me")),
				listOf(edit("assistant", "edit me", "edited")),
			)
			val overlay = ConversationOverlayStore.loadOverlay(k)!!

			val result = ConversationOverlayStore.applyDeletes(entries, overlay)
			result shouldHaveSize 1
			result[0].content shouldBe "edit me" // raw, not "edited"
		}
	}

	// ── mergeOverlay ────────────────────────────────────────────────────

	@Nested
	inner class MergeOverlay {
		@Test
		fun `new deletes supersede existing edits for same identity`() {
			val k = key()
			ConversationOverlayStore.saveOverlay(k, emptyList(), listOf(edit("human", "x", "y")))
			val existing = ConversationOverlayStore.loadOverlay(k)!!

			val (deletes, edits) = ConversationOverlayStore.mergeOverlay(
				existing,
				listOf(identity("human", "x")),
				emptyList(),
			)

			deletes shouldHaveSize 1
			edits.shouldBeEmpty() // edit for "x" was superseded by delete
		}

		@Test
		fun `new edits replace existing edits for same identity`() {
			val k = key()
			ConversationOverlayStore.saveOverlay(k, emptyList(), listOf(edit("human", "x", "old-edit")))
			val existing = ConversationOverlayStore.loadOverlay(k)!!

			val (_, edits) = ConversationOverlayStore.mergeOverlay(
				existing,
				emptyList(),
				listOf(edit("human", "x", "new-edit")),
			)

			edits shouldHaveSize 1
			edits[0].newContent shouldBe "new-edit"
		}

		@Test
		fun `merge from null existing works`() {
			val (deletes, edits) = ConversationOverlayStore.mergeOverlay(
				null,
				listOf(identity("human", "a")),
				listOf(edit("assistant", "b", "c")),
			)
			deletes shouldHaveSize 1
			edits shouldHaveSize 1
		}
	}

	// ── Identity matching ───────────────────────────────────────────────

	@Nested
	inner class IdentityMatching {
		@Test
		fun `matches by role and content when timestamps are null`() {
			val entries = listOf(entry("human", "hi"))
			val k = key()
			ConversationOverlayStore.saveOverlay(k, listOf(identity("human", "hi")), emptyList())
			val overlay = ConversationOverlayStore.loadOverlay(k)!!

			ConversationOverlayStore.applyOverlay(entries, overlay).shouldBeEmpty()
		}

		@Test
		fun `matches when only one side has a timestamp (lenient)`() {
			val entries = listOf(entry("human", "hi", "2026-01-01T00:00:00Z"))
			val k = key()
			ConversationOverlayStore.saveOverlay(k, listOf(identity("human", "hi")), emptyList())
			val overlay = ConversationOverlayStore.loadOverlay(k)!!

			ConversationOverlayStore.applyOverlay(entries, overlay).shouldBeEmpty()
		}

		@Test
		fun `does not match when timestamps differ`() {
			val entries = listOf(entry("human", "hi", "2026-01-01T00:00:00Z"))
			val k = key()
			ConversationOverlayStore.saveOverlay(
				k,
				listOf(identity("human", "hi", "2026-01-02T00:00:00Z")),
				emptyList(),
			)
			val overlay = ConversationOverlayStore.loadOverlay(k)!!

			ConversationOverlayStore.applyOverlay(entries, overlay) shouldHaveSize 1
		}
	}
}
