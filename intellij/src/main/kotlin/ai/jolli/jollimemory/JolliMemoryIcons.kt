package ai.jolli.jollimemory

import com.intellij.icons.AllIcons
import com.intellij.openapi.util.IconLoader
import java.awt.Color
import javax.swing.Icon

/**
 * Custom icons for the JolliMemory plugin.
 * These match the VSCode codicons used in the VSCode extension for visual consistency.
 */
object JolliMemoryIcons {
    /** Green checkmark — matches VSCode codicon "check" (green). */
    val Check: Icon = IconLoader.getIcon("/icons/check.svg", JolliMemoryIcons::class.java)

    /** Red X — matches VSCode codicon "x" (red). */
    val X: Icon = IconLoader.getIcon("/icons/x.svg", JolliMemoryIcons::class.java)

    /** Yellow warning triangle — matches VSCode codicon "warning" (yellow). */
    val Warning: Icon = IconLoader.getIcon("/icons/warning.svg", JolliMemoryIcons::class.java)

    /** Green pulse/heartbeat — matches VSCode codicon "pulse" (green). */
    val Pulse: Icon = IconLoader.getIcon("/icons/pulse.svg", JolliMemoryIcons::class.java)

    /** Green book — matches VSCode codicon "book" (green). */
    val Book: Icon = IconLoader.getIcon("/icons/book.svg", JolliMemoryIcons::class.java)

    /** Green globe — matches VSCode codicon "globe" (green). */
    val Globe: Icon = IconLoader.getIcon("/icons/globe.svg", JolliMemoryIcons::class.java)

    /** Sparkle — matches VSCode codicon "sparkle" for AI commit. */
    val Sparkle: Icon = IconLoader.getIcon("/icons/sparkle.svg", JolliMemoryIcons::class.java)

    /** Database cylinder — matches VSCode codicon "database" for the back-fill build action. */
    val Database: Icon = IconLoader.getIcon("/icons/database.svg", JolliMemoryIcons::class.java)

    /** Git merge — matches VSCode codicon "git-merge" for squash. */
    val GitMerge: Icon = IconLoader.getIcon("/icons/git-merge.svg", JolliMemoryIcons::class.java)

    /** Git pull request — matches VSCode codicon "git-pull-request" for Create PR. */
    val GitPullRequest: Icon = IconLoader.getIcon("/icons/git-pull-request.svg", JolliMemoryIcons::class.java)

    /** GitHub-style pull request glyph (octicon) — used in the Committed Memories SHIPPED row. */
    val PullRequest: Icon = IconLoader.getIcon("/icons/pull-request.svg", JolliMemoryIcons::class.java)

    /** Share — node-share glyph, for the Share action. */
    val Share: Icon = IconLoader.getIcon("/icons/share.svg", JolliMemoryIcons::class.java)

    /** Cloud upload — matches VSCode codicon "cloud-upload" for push. */
    val CloudUpload: Icon = IconLoader.getIcon("/icons/cloud-upload.svg", JolliMemoryIcons::class.java)

    /** Eye — matches VSCode codicon "eye" for view summary. */
    val Eye: Icon = IconLoader.getIcon("/icons/eye.svg", JolliMemoryIcons::class.java)

    /** Vertical three dots (⋮) — per-row "more actions" affordance. */
    val MoreVertical: Icon = IconLoader.getIcon("/icons/more-vertical.svg", JolliMemoryIcons::class.java)

    /** Select/deselect all — uses IntelliJ platform icon for crisp rendering. */
    val CheckAll: Icon = AllIcons.Actions.Selectall

    /** Refresh — uses IntelliJ platform icon for crisp rendering. */
    val Refresh: Icon = AllIcons.Actions.Refresh

    /** Key (yellow) — used for Anthropic API key option in onboarding. */
    val Key: Icon = IconLoader.getIcon("/icons/key.svg", JolliMemoryIcons::class.java)

    /** Lock (green) — matches VSCode codicon "lock" for committed plans. */
    val Lock: Icon = IconLoader.getIcon("/icons/lock.svg", JolliMemoryIcons::class.java)

    /** File text — matches VSCode codicon "file-text" for uncommitted plans. */
    val FileText: Icon = IconLoader.getIcon("/icons/file-text.svg", JolliMemoryIcons::class.java)

    /** Note — matches VSCode codicon "note" for markdown notes. */
    val Note: Icon = IconLoader.getIcon("/icons/note.svg", JolliMemoryIcons::class.java)

    /** Comment — matches VSCode codicon "comment" for text snippet notes. */
    val Comment: Icon = IconLoader.getIcon("/icons/comment.svg", JolliMemoryIcons::class.java)

    /** Discard — matches VSCode codicon "discard" for reverting file changes. */
    val Discard: Icon = IconLoader.getIcon("/icons/discard.svg", JolliMemoryIcons::class.java)

    /** Trash — matches VSCode codicon "trash" for delete/remove actions. */
    val Trash: Icon = IconLoader.getIcon("/icons/trash.svg", JolliMemoryIcons::class.java)

    // ── CONTEXT row hover actions ────────────────────────────────────────────
    // These four are the exact codicon glyphs the VS Code sidebar renders in a
    // Context row's hover cluster (pin / edit / trash / close-or-add), traced
    // from `@vscode/codicons` so the two surfaces show the same shapes rather
    // than IntelliJ's near-equivalents (AllIcons.General.Pin_tab and friends
    // read noticeably different at 16px). Keep the light/dark pair in step with
    // the rest of this folder: #6C6C6C light, #C5C5C5 dark.

    /** Pin — matches VSCode codicon "pin" for the row's Pin action. */
    val Pin: Icon = IconLoader.getIcon("/icons/pin.svg", JolliMemoryIcons::class.java)

    /** Pencil — matches VSCode codicon "edit" for the row's Edit action. */
    val Edit: Icon = IconLoader.getIcon("/icons/edit.svg", JolliMemoryIcons::class.java)

    /** ✕ — matches VSCode codicon "close" for "Leave out of this memory". */
    val Close: Icon = IconLoader.getIcon("/icons/close.svg", JolliMemoryIcons::class.java)

    /** + — matches VSCode codicon "add" for "Add back to this memory". */
    val Add: Icon = IconLoader.getIcon("/icons/add.svg", JolliMemoryIcons::class.java)

    /**
     * Theme-adaptive pulse (heartbeat) glyph — the base of the tool window Status
     * button. Rendered gray on both themes so the colored health dot on top of it
     * (green/yellow/red) is the piece that reads. Matches the design's
     * codicon-pulse used with a currentColor mask.
     */
    val PulseNeutral: Icon = IconLoader.getIcon("/icons/pulse-neutral.svg", JolliMemoryIcons::class.java)

    /** Pulse + green health dot — Status button when everything is OK. */
    val PulseStatusGreen: Icon = PulseStatusIcon(PulseNeutral, Color(0x3F, 0xB9, 0x50))

    /** Pulse + yellow health dot — Status button when there are warnings. */
    val PulseStatusYellow: Icon = PulseStatusIcon(PulseNeutral, Color(0xD2, 0x99, 0x22))

    /** Pulse + red health dot — Status button when Jolli is disabled / failed. */
    val PulseStatusRed: Icon = PulseStatusIcon(PulseNeutral, Color(0xF8, 0x51, 0x49))

    /** Jolli Memory logo — used for tool window icon and onboarding. */
    val JolliLogo: Icon = IconLoader.getIcon("/icons/jollimemory.svg", JolliMemoryIcons::class.java)

    /** Issues — matches VSCode codicon "issues" for external references (Linear, Jira, GitHub). */
    val Issues: Icon = IconLoader.getIcon("/icons/issues.svg", JolliMemoryIcons::class.java)

    /** Red cloud — cloud sync disabled (not signed in to Jolli). */
    val CloudRed: Icon = IconLoader.getIcon("/icons/cloud-red.svg", JolliMemoryIcons::class.java)

    // ── Per-source logos (AI tool that produced a conversation) ──────────────
    private val sourceClaude: Icon = IconLoader.getIcon("/icons/source-claude.svg", JolliMemoryIcons::class.java)
    private val sourceCodex: Icon = IconLoader.getIcon("/icons/source-codex.svg", JolliMemoryIcons::class.java)
    private val sourceGemini: Icon = IconLoader.getIcon("/icons/source-gemini.svg", JolliMemoryIcons::class.java)
    private val sourceCursor: Icon = IconLoader.getIcon("/icons/source-cursor.svg", JolliMemoryIcons::class.java)
    private val sourceOpenCode: Icon = IconLoader.getIcon("/icons/source-opencode.svg", JolliMemoryIcons::class.java)
    private val sourceCopilot: Icon = IconLoader.getIcon("/icons/source-copilot.svg", JolliMemoryIcons::class.java)
    private val sourceCline: Icon = IconLoader.getIcon("/icons/source-cline.svg", JolliMemoryIcons::class.java)
    private val sourceDevin: Icon = IconLoader.getIcon("/icons/source-devin.svg", JolliMemoryIcons::class.java)
    private val sourceAntigravity: Icon = IconLoader.getIcon("/icons/source-antigravity.svg", JolliMemoryIcons::class.java)

    /**
     * Logo for an AI source by its transcript-source name. Returns null for
     * unknown names so callers can fall back to a color-coded text badge.
     * Grouped variants:
     *   cursor / cursor-cli → source-cursor.svg (cursor-cli falls back to the IDE brand)
     *   copilot / copilot-chat → source-copilot.svg
     *   cline / cline-cli → source-cline.svg
     */
    fun sourceLogo(name: String): Icon? = when (name) {
        "claude" -> sourceClaude
        "codex" -> sourceCodex
        "gemini" -> sourceGemini
        "cursor", "cursor-cli" -> sourceCursor
        "opencode" -> sourceOpenCode
        "copilot", "copilot-chat" -> sourceCopilot
        "cline", "cline-cli" -> sourceCline
        "devin" -> sourceDevin
        "antigravity" -> sourceAntigravity
        else -> null
    }
}
