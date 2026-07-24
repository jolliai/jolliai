package ai.jolli.jollimemory.toolwindow.views

import com.intellij.openapi.editor.colors.EditorColorsManager
import java.awt.Color

/**
 * Shared theme helpers for JCEF-backed panels.
 *
 * The three memory panels (`SummaryPanel`, `CreatePrPanel`, `WorkingMemoryPanel`)
 * all seed their native Chromium view with the live IDE editor background before
 * the first `loadHTML`, so the initial `about:blank` → content navigation never
 * flashes white. Keep the plumbing here so a change to how we pick the colour
 * (or format it) can never drift between panels.
 *
 * Must be read on the EDT — `EditorColorsManager.globalScheme` mutates on theme
 * change events dispatched from Swing.
 */
object ThemeUtils {

    /**
     * Live IDE editor background — the single source of truth for both the JCEF
     * component background and the page's `--bg`, so the shell matches the current
     * theme exactly and the load is seamless.
     */
    fun editorBackground(): Color =
        EditorColorsManager.getInstance().globalScheme.defaultBackground

    /** `#rrggbb` CSS hex for a Swing colour, alpha ignored. */
    fun Color.toCssHex(): String =
        String.format("#%02x%02x%02x", red, green, blue)

    /**
     * True when this colour's luma is below mid-grey. Use this — not
     * `JBColor.isBright()` — to pick the dark vs light text-colour var set from
     * the SAME colour that backs the page (`--bg`), so the two can never disagree.
     * The LaF and the editor colour scheme are independent, so a light LaF paired
     * with a dark editor scheme would give invisible text if driven off LaF alone.
     */
    fun Color.isDarkByLuma(): Boolean =
        (0.299 * red + 0.587 * green + 0.114 * blue) < 128
}
