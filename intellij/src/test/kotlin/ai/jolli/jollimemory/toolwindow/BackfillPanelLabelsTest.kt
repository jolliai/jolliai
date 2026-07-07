package ai.jolli.jollimemory.toolwindow

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * The card's row/note wording MUST match vscode/src/views/BackfillListRenderer.ts 1:1
 * (the two surfaces share a repo and users move between them). These assertions pin the
 * exact strings so a drift in either implementation is caught.
 */
class BackfillPanelLabelsTest {

	@Test
	fun `backfillMeta reads sessions and turns, singularizing at 1`() {
		BackfillPanel.backfillMeta(0, 0) shouldBe "Code change only"
		BackfillPanel.backfillMeta(1, 1) shouldBe "1 session · 1 turn"
		BackfillPanel.backfillMeta(3, 12) shouldBe "3 sessions · 12 turns"
	}

	@Test
	fun `backfillResult reads sessions and topics, diff-only shows topics alone`() {
		BackfillPanel.backfillResult(0, 1) shouldBe "1 topic"
		BackfillPanel.backfillResult(0, 5) shouldBe "5 topics"
		BackfillPanel.backfillResult(3, 5) shouldBe "3 sessions · 5 topics"
	}

	@Test
	fun `coldStartNote empty variant invites building from scratch`() {
		BackfillPanel.coldStartNote("empty", 0, 10) shouldBe
			"You are set up — this repo has no memories yet. Build them from your recent commits, " +
			"or just keep coding and they capture automatically."
	}

	@Test
	fun `coldStartNote gaps variant states the count when under the cap`() {
		BackfillPanel.coldStartNote("gaps", 1, 10) shouldBe
			"You are set up. 1 recent commit from the last month (up to 10) without a memory yet — " +
			"build now, or keep coding (new commits capture automatically)."
		BackfillPanel.coldStartNote("gaps", 4, 10) shouldBe
			"You are set up. 4 recent commits from the last month (up to 10) without a memory yet — " +
			"build now, or keep coding (new commits capture automatically)."
	}

	@Test
	fun `coldStartNote gaps variant switches to capped copy at the cap`() {
		BackfillPanel.coldStartNote("gaps", 10, 10) shouldBe
			"You are set up. The 10 most recent commits from the last month without a memory yet — " +
			"build now, or manage all in Settings (new commits capture automatically)."
	}
}
