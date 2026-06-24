package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class PinStoreTest {

	@TempDir
	lateinit var tempDir: File

	private val cwd get() = tempDir.absolutePath

	@BeforeEach
	fun setUp() {
		File(tempDir, ".jolli/jollimemory").mkdirs()
	}

	@Nested
	inner class Read {
		@Test
		fun `returns empty when no file exists`() {
			PinStore.readPins(cwd) shouldBe emptyList()
		}

		@Test
		fun `returns empty for corrupt JSON`() {
			File(JmLogger.getJolliMemoryDir(cwd), "pins.json").apply {
				parentFile.mkdirs()
				writeText("not json")
			}
			PinStore.readPins(cwd) shouldBe emptyList()
		}
	}

	@Nested
	inner class PinAndQuery {
		@Test
		fun `pin and isPinned round-trip across kinds`() {
			PinStore.pin(cwd, "memories", "abc12345def", "Redesign sidebar", "M")
			PinStore.pin(cwd, "conversations", "claude:s1", "Sidebar UX redesign", "claude")

			PinStore.isPinned(cwd, "memories", "abc12345def") shouldBe true
			PinStore.isPinned(cwd, "conversations", "claude:s1") shouldBe true
			PinStore.isPinned(cwd, "memories", "other") shouldBe false
			PinStore.isPinned(cwd, "notes", "claude:s1") shouldBe false
		}

		@Test
		fun `pin stores the display title and badge`() {
			PinStore.pin(cwd, "plans", "plan-1", "My plan title", "P")
			val pins = PinStore.readPins(cwd)
			pins.size shouldBe 1
			pins[0].kind shouldBe "plans"
			pins[0].key shouldBe "plan-1"
			pins[0].title shouldBe "My plan title"
			pins[0].badge shouldBe "P"
		}

		@Test
		fun `pinning the same key twice does not duplicate`() {
			PinStore.pin(cwd, "plans", "plan-1", "First title", "P")
			PinStore.pin(cwd, "plans", "plan-1", "Updated title", "P")
			val pins = PinStore.readPins(cwd)
			pins.size shouldBe 1
			pins[0].title shouldBe "Updated title"
		}

		@Test
		fun `unpin removes the entry`() {
			PinStore.pin(cwd, "references", "github:1", "Issue 1", "GH")
			PinStore.isPinned(cwd, "references", "github:1") shouldBe true

			PinStore.unpin(cwd, "references", "github:1")
			PinStore.isPinned(cwd, "references", "github:1") shouldBe false
			PinStore.readPins(cwd) shouldBe emptyList()
		}
	}
}
