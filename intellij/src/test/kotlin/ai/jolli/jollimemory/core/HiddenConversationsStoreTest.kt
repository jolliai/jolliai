package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.time.Instant

class HiddenConversationsStoreTest {

	@TempDir
	lateinit var tempDir: File

	private val cwd get() = tempDir.absolutePath

	@BeforeEach
	fun setUp() {
		File(tempDir, ".jolli/jollimemory").mkdirs()
	}

	// ── Load ────────────────────────────────────────────────────────────

	@Nested
	inner class Load {
		@Test
		fun `returns empty state when no file exists`() {
			val state = HiddenConversationsStore.loadHiddenConversations(cwd)
			state.entries shouldBe emptyMap()
		}

		@Test
		fun `returns empty state for corrupt JSON`() {
			File(JmLogger.getJolliMemoryDir(cwd), "hidden-conversations.json").apply {
				parentFile.mkdirs()
				writeText("not json")
			}
			val state = HiddenConversationsStore.loadHiddenConversations(cwd)
			state.entries shouldBe emptyMap()
		}
	}

	// ── Hide / isHidden round-trip ──────────────────────────────────────

	@Nested
	inner class HideAndQuery {
		@Test
		fun `hideConversation and isHidden round-trip`() {
			HiddenConversationsStore.hideConversation(cwd, TranscriptSource.claude, "s1")

			val state = HiddenConversationsStore.loadHiddenConversations(cwd)
			HiddenConversationsStore.isHidden(state, TranscriptSource.claude, "s1") shouldBe true
			HiddenConversationsStore.isHidden(state, TranscriptSource.claude, "other") shouldBe false
		}

		@Test
		fun `re-hiding refreshes timestamp`() {
			HiddenConversationsStore.hideConversation(cwd, TranscriptSource.claude, "s1")
			val state1 = HiddenConversationsStore.loadHiddenConversations(cwd)
			val hiddenAt1 = state1.entries[HiddenConversationsStore.hiddenKey(TranscriptSource.claude, "s1")]!!.hiddenAt

			Thread.sleep(50) // ensure time advances
			HiddenConversationsStore.hideConversation(cwd, TranscriptSource.claude, "s1")
			val state2 = HiddenConversationsStore.loadHiddenConversations(cwd)
			val hiddenAt2 = state2.entries[HiddenConversationsStore.hiddenKey(TranscriptSource.claude, "s1")]!!.hiddenAt

			(hiddenAt2 > hiddenAt1) shouldBe true
		}
	}

	// ── isStillHidden (auto-unhide) ─────────────────────────────────────

	@Nested
	inner class IsStillHidden {
		@Test
		fun `returns true when session has not been updated since hiding`() {
			val beforeHide = Instant.now().minusSeconds(10).toString()
			HiddenConversationsStore.hideConversation(cwd, TranscriptSource.claude, "s1")
			val state = HiddenConversationsStore.loadHiddenConversations(cwd)

			HiddenConversationsStore.isStillHidden(
				state, TranscriptSource.claude, "s1", beforeHide,
			) shouldBe true
		}

		@Test
		fun `returns false when session was updated after hiding (auto-unhide)`() {
			HiddenConversationsStore.hideConversation(cwd, TranscriptSource.claude, "s1")
			val state = HiddenConversationsStore.loadHiddenConversations(cwd)

			val afterHide = Instant.now().plusSeconds(10).toString()
			HiddenConversationsStore.isStillHidden(
				state, TranscriptSource.claude, "s1", afterHide,
			) shouldBe false
		}

		@Test
		fun `returns false for sessions that were never hidden`() {
			val state = HiddenConversationsStore.loadHiddenConversations(cwd)
			HiddenConversationsStore.isStillHidden(
				state, TranscriptSource.claude, "unknown", Instant.now().toString(),
			) shouldBe false
		}
	}
}
