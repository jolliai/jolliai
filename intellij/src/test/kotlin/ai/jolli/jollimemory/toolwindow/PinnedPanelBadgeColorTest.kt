package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.core.PinStore
import ai.jolli.jollimemory.core.references.SourceDisplay
import ai.jolli.jollimemory.core.references.SourceId
import com.intellij.ui.JBColor
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.Test

/**
 * Pinned rows mirror their source row's badge. For a reference BOTH halves are
 * derived from the pin's `key`, never from the stored letter: the letter tag is not
 * a unique key (Jira/Jolli both "J", Zoom Doc/Meeting both "Z") and it collides with
 * the note/snippet letters this panel owns ("N", "S"), so it cannot drive the color;
 * and the stored letter is itself whatever alphabet the writing plugin version used,
 * so it cannot be trusted as the label either.
 *
 * Identity comparisons throughout: JBColor resolves its RGB against the active
 * theme, which is not stood up in these unit tests, so the assertion is "the same
 * Style object the reference row would have used" rather than a value compare.
 */
class PinnedPanelBadgeColorTest {

    private fun pin(kind: String, key: String, badge: String) =
        PinStore.PinnedEntry(kind = kind, key = key, title = "t", badge = badge, pinnedAt = 0)

    @Test
    fun `reference color comes from the source, not the letter tag`() {
        val notion = PinnedPanel.badgeColor(pin("references", "notion:abc123", "N"))
        notion shouldBe SourceDisplay.of(SourceId.notion).color
        // The regression: "N" also keys note-green in this panel's own tag map.
        notion shouldNotBe PinnedPanel.TAG_COLORS["N"]
    }

    @Test
    fun `slack does not inherit the snippet amber that shares its letter`() {
        val slack = PinnedPanel.badgeColor(pin("references", "slack:C123-1700000000", "S"))
        slack shouldBe SourceDisplay.of(SourceId.slack).color
        slack shouldNotBe PinnedPanel.TAG_COLORS["S"]
    }

    @Test
    fun `the two sources sharing the letter J resolve to different colors`() {
        val jira = PinnedPanel.badgeColor(pin("references", "jira:KAN-5", "J"))
        val jolli = PinnedPanel.badgeColor(pin("references", "jollimemory:recall", "J"))
        jira shouldBe SourceDisplay.of(SourceId.jira).color
        jolli shouldBe SourceDisplay.of(SourceId.jollimemory).color
        jira shouldNotBe jolli
    }

    @Test
    fun `hyphenated wire names resolve rather than falling through to unknown`() {
        // `zoom-doc` is the wire name, not the enum name — a naive valueOf would miss it.
        val zoomDoc = PinnedPanel.badgeColor(pin("references", "zoom-doc:xyz", "Z"))
        zoomDoc shouldBe SourceDisplay.of(SourceId.zoom_doc).color
    }

    @Test
    fun `sources added since the old letter map still get their brand color`() {
        // "G", "C", "A", "M", "7" had no entry in the letter map and fell through to gray.
        for ((key, id) in listOf(
            "github:o/r#1" to SourceId.github,
            "confluence:1234" to SourceId.confluence,
            "asana:1" to SourceId.asana,
            "monday:1" to SourceId.monday,
            "context7:/vercel/next.js" to SourceId.context7,
        )) {
            PinnedPanel.badgeColor(pin("references", key, "?")) shouldBe SourceDisplay.of(id).color
        }
    }

    @Test
    fun `an unknown wire name lands on the reference placeholder, not the conversation fallback`() {
        // The placeholder is itself a neutral gray (#6E7681) — what this pins is that it
        // is the SAME neutral the reference rows use, not the `JBColor.GRAY` that the
        // conversation branch falls back to.
        val unknown = PinnedPanel.badgeColor(pin("references", "notatool:1", "R"))
        unknown shouldBe SourceDisplay.unknown().color
        unknown shouldNotBe JBColor.GRAY
    }

    @Test
    fun `plan and note letters still resolve from the panel's own tag map`() {
        PinnedPanel.badgeColor(pin("plans", "my-plan", "P")) shouldBe PinnedPanel.TAG_COLORS["P"]
        PinnedPanel.badgeColor(pin("notes", "n1", "N")) shouldBe PinnedPanel.TAG_COLORS["N"]
        PinnedPanel.badgeColor(pin("notes", "n2", "S")) shouldBe PinnedPanel.TAG_COLORS["S"]
    }

    @Test
    fun `conversation rows keep resolving by source name`() {
        PinnedPanel.badgeColor(pin("conversations", "claude:sess", "Claude")) shouldBe
            PinnedPanel.SOURCE_COLORS["claude"]
        PinnedPanel.badgeColor(pin("conversations", "x:sess", "Nope")) shouldBe JBColor.GRAY
    }

    @Test
    fun `a reference letter stamped by an older plugin is re-derived, not rendered as stored`() {
        // Pre-single-letter alphabet: GitHub was "GH", Notion "No". Deriving only the
        // color would leave those letters next to the new, correct hue forever.
        PinnedPanel.badgeText(pin("references", "github:o/r#1", "GH")) shouldBe SourceDisplay.of(SourceId.github).tag
        PinnedPanel.badgeText(pin("references", "notion:abc123", "No")) shouldBe SourceDisplay.of(SourceId.notion).tag
    }

    @Test
    fun `a reference pin with no stored badge still gets its letter`() {
        // `PinStore.load` falls back to the raw source name when `badge` is absent.
        PinnedPanel.badgeText(pin("references", "slack:C123-1700000000", "slack")) shouldBe
            SourceDisplay.of(SourceId.slack).tag
    }

    @Test
    fun `an unknown reference wire name takes the placeholder letter`() {
        PinnedPanel.badgeText(pin("references", "notatool:1", "X")) shouldBe SourceDisplay.unknown().tag
    }

    @Test
    fun `plan, note and conversation letters are kept as stored, not derived`() {
        PinnedPanel.badgeText(pin("plans", "my-plan", "P")) shouldBe "P"
        PinnedPanel.badgeText(pin("notes", "n1", "N")) shouldBe "N"
        PinnedPanel.badgeText(pin("notes", "n2", "S")) shouldBe "S"
        PinnedPanel.badgeText(pin("conversations", "claude:sess", "Claude")) shouldBe "Claude"
    }
}
