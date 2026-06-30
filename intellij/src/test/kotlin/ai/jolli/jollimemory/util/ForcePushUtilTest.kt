package ai.jolli.jollimemory.util

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class ForcePushUtilTest {

	@Test
	fun `detects non-fast-forward error`() {
		ForcePushUtil.isNonFastForwardError("! [rejected] main -> main (non-fast-forward)") shouldBe true
	}

	@Test
	fun `detects fetch first hint`() {
		ForcePushUtil.isNonFastForwardError("hint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. If you want to integrate the remote changes,\nhint: use 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.") shouldBe true
	}

	@Test
	fun `detects rejected bracket marker`() {
		ForcePushUtil.isNonFastForwardError("To github.com:user/repo.git\n ! [rejected]        feature -> feature (fetch first)") shouldBe true
	}

	@Test
	fun `detects tip behind message`() {
		ForcePushUtil.isNonFastForwardError("error: failed to push some refs to 'origin'\nhint: tip of your current branch is behind") shouldBe true
	}

	@Test
	fun `returns false for auth error`() {
		ForcePushUtil.isNonFastForwardError("remote: Permission to user/repo.git denied to user.\nfatal: unable to access 'https://github.com/user/repo.git/': The requested URL returned error: 403") shouldBe false
	}

	@Test
	fun `returns false for empty string`() {
		ForcePushUtil.isNonFastForwardError("") shouldBe false
	}

	@Test
	fun `detection is case insensitive`() {
		ForcePushUtil.isNonFastForwardError("NON-FAST-FORWARD") shouldBe true
	}
}
