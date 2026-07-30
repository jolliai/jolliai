package ai.jolli.jollimemory.core.references

import com.intellij.ui.JBColor
import java.awt.Color

/**
 * Presentation metadata (letter tag, accent color, human-readable label) for each
 * [SourceId]. Single source of truth used by every panel that renders reference
 * rows so tag letters and colors don't drift between PlansPanel, CommitsPanel and
 * hover popups.
 *
 * **Byte-for-byte mirror of VSCode's `SOURCE_META` in
 * `vscode/src/views/SourceLabels.ts`** — letters and hex colors come from that
 * file. When adding a source, edit both. `NEUTRAL_SOURCE_COLOR` (`#6e7681`)
 * is VSCode's fallback color for the same purpose.
 *
 * `unknown()` is what every consumer must fall back to for a source the enum
 * doesn't cover yet — reference rows for a future CLI-side source render with a
 * neutral placeholder instead of crashing.
 */
object SourceDisplay {
	data class Style(val tag: String, val color: Color, val label: String)

	private val LINEAR = Style("L", JBColor(0x5E6AD2, 0x5E6AD2), "Linear")
	private val JIRA = Style("J", JBColor(0x0052CC, 0x0052CC), "Jira")
	private val GITHUB = Style("G", JBColor(0x6E7681, 0x6E7681), "GitHub")
	private val NOTION = Style("N", JBColor(0x787774, 0x787774), "Notion")
	private val SLACK = Style("S", JBColor(0x4A154B, 0x4A154B), "Slack")
	// `#9B5CFF` = primary hue from `vscode/assets/icon.svg`. Letter collides with
	// Jira ("J") — accepted collision: badge colors differ, and Jolli is the
	// first-party brand here, same call VSCode made.
	private val JOLLI = Style("J", JBColor(0x9B5CFF, 0x9B5CFF), "Jolli Memory")
	private val CONTEXT7 = Style("7", JBColor(0x0B7285, 0x0B7285), "Context7")
	private val CONFLUENCE = Style("C", JBColor(0x1868DB, 0x1868DB), "Confluence")
	private val ASANA = Style("A", JBColor(0xF06A6A, 0xF06A6A), "Asana")
	private val MONDAY = Style("M", JBColor(0xFF3D57, 0xFF3D57), "monday.com")
	private val ZOOM_DOC = Style("Z", JBColor(0x2D8CFF, 0x2D8CFF), "Zoom Doc")
	private val ZOOM_MEETING = Style("Z", JBColor(0x2D8CFF, 0x2D8CFF), "Zoom Meeting")

	/** Neutral fallback (VSCode's `NEUTRAL_SOURCE_COLOR = "#6e7681"`). */
	private val UNKNOWN = Style("R", JBColor(0x6E7681, 0x6E7681), "Reference")

	fun of(source: SourceId?): Style = when (source) {
		SourceId.linear -> LINEAR
		SourceId.jira -> JIRA
		SourceId.github -> GITHUB
		SourceId.notion -> NOTION
		SourceId.slack -> SLACK
		SourceId.jollimemory -> JOLLI
		SourceId.context7 -> CONTEXT7
		SourceId.confluence -> CONFLUENCE
		SourceId.asana -> ASANA
		SourceId.monday -> MONDAY
		SourceId.zoom_doc -> ZOOM_DOC
		SourceId.zoom_meeting -> ZOOM_MEETING
		null -> UNKNOWN
	}

	/** Public accessor for the unknown-source placeholder (kept internal by default). */
	fun unknown(): Style = UNKNOWN

	/**
	 * True when a reference label should read `<nativeId> — <title>` instead of
	 * just `<title>`. Only the three issue trackers whose nativeId is a
	 * human-recognisable key (Linear `PROJ-42`, Jira `KAN-5`, GitHub
	 * `owner/repo#123`) opt in — every other source's nativeId is a machine id
	 * (Notion 32-hex, Slack `<channel>-<ts>`, jollimemory tool name, …) that
	 * would just clutter the row.
	 *
	 * Mirrors `labelLeadsWithNativeId` in
	 * `cli/src/core/references/ReferenceDisplay.ts` — keep the two in lockstep.
	 */
	fun labelLeadsWithNativeId(source: SourceId?): Boolean =
		source == SourceId.linear || source == SourceId.jira || source == SourceId.github

	/**
	 * The reference's display title used by row/badge callers:
	 *   `<nativeId> — <title>` for Linear/Jira/GitHub; `<title>` for everyone else.
	 * Mirrors `referenceDisplayTitle` in `cli/src/core/references/ReferenceDisplay.ts`.
	 */
	fun displayTitle(source: SourceId?, nativeId: String, title: String): String =
		if (labelLeadsWithNativeId(source)) "$nativeId — $title" else title
}
