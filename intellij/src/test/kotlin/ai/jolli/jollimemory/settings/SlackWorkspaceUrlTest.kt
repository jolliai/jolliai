package ai.jolli.jollimemory.settings

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.SlackConfig
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class SlackWorkspaceUrlTest {

	@Nested
	inner class Validation {
		@Test
		fun `accepts a valid workspace url`() {
			SlackWorkspaceUrl.normalizeOrNull("https://my-team.slack.com") shouldBe "https://my-team.slack.com"
		}

		@Test
		fun `accepts bare slack_com`() {
			SlackWorkspaceUrl.normalizeOrNull("https://slack.com") shouldBe "https://slack.com"
		}

		@Test
		fun `normalizes away trailing slash and path`() {
			SlackWorkspaceUrl.normalizeOrNull("https://my-team.slack.com/") shouldBe "https://my-team.slack.com"
			SlackWorkspaceUrl.normalizeOrNull("https://my-team.slack.com/archives/x") shouldBe "https://my-team.slack.com"
		}

		@Test
		fun `rejects non-https scheme`() {
			SlackWorkspaceUrl.normalizeOrNull("http://my-team.slack.com").shouldBeNull()
		}

		@Test
		fun `rejects non-slack host`() {
			SlackWorkspaceUrl.normalizeOrNull("https://example.com").shouldBeNull()
		}

		@Test
		fun `rejects a lookalike host via suffix boundary`() {
			SlackWorkspaceUrl.normalizeOrNull("https://slack.com.evil.com").shouldBeNull()
		}

		@Test
		fun `rejects blank and malformed input`() {
			SlackWorkspaceUrl.normalizeOrNull("").shouldBeNull()
			SlackWorkspaceUrl.normalizeOrNull("   ").shouldBeNull()
			SlackWorkspaceUrl.normalizeOrNull("not a url").shouldBeNull()
		}
	}

	@Nested
	inner class ConfigPersistence {
		@Test
		fun `slack config survives a full-serialize save round-trip`(@TempDir tempDir: File) {
			val dir = tempDir.absolutePath
			val cfg = JolliMemoryConfig(
				apiKey = "sk-test",
				slack = SlackConfig(workspaceUrl = "https://my-team.slack.com"),
			)
			SessionTracker.saveConfigToDir(cfg, dir)
			val back = SessionTracker.loadConfigFromDir(dir)
			back.slack?.workspaceUrl shouldBe "https://my-team.slack.com"
			back.apiKey shouldBe "sk-test"
		}

		@Test
		fun `merge-with-existing preserves slack when other fields update`(@TempDir tempDir: File) {
			val dir = tempDir.absolutePath
			// Seed with a slack workspace url.
			SessionTracker.saveConfigToDir(
				JolliMemoryConfig(slack = SlackConfig(workspaceUrl = "https://my-team.slack.com")),
				dir,
			)
			// Mimic the settings apply() path: read existing, copy with new fields.
			val existing = SessionTracker.loadConfigFromDir(dir)
			val merged = existing.copy(
				apiKey = "sk-new",
				slack = (existing.slack ?: SlackConfig()).copy(workspaceUrl = "https://my-team.slack.com"),
			)
			SessionTracker.saveConfigToDir(merged, dir)

			val back = SessionTracker.loadConfigFromDir(dir)
			back.apiKey shouldBe "sk-new"
			back.slack?.workspaceUrl shouldBe "https://my-team.slack.com"
		}

	}
}
