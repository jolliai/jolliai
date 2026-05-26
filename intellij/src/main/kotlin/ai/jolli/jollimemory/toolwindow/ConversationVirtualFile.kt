package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.ActiveConversationItem
import com.intellij.testFramework.LightVirtualFile

/**
 * Lightweight virtual file that carries an [ActiveConversationItem].
 * Used to open conversation transcripts as editor tabs in the main editor area.
 */
class ConversationVirtualFile(
	val item: ActiveConversationItem,
	val cwd: String,
) : LightVirtualFile(
	"${sourceEmoji(item.source.name)} ${item.title}",
	"",
) {
	/** Stable identity so the same conversation always reuses the same tab. */
	override fun equals(other: Any?): Boolean {
		if (this === other) return true
		if (other !is ConversationVirtualFile) return false
		return item.source == other.item.source && item.sessionId == other.item.sessionId
	}

	override fun hashCode(): Int = 31 * item.source.hashCode() + item.sessionId.hashCode()

	override fun isWritable(): Boolean = false
}

private fun sourceEmoji(source: String): String = when (source) {
	"claude" -> "\uD83D\uDFE0"  // orange circle
	"gemini" -> "\uD83D\uDFE2"  // green circle
	"codex" -> "\uD83D\uDFE3"   // purple circle
	"opencode" -> "\uD83D\uDD35" // blue circle
	"cursor" -> "\uD83D\uDD34"  // red circle
	else -> "\u2B1C"             // white square
}
