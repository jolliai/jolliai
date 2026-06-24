package ai.jolli.jollimemory

import com.intellij.ui.JBColor

/**
 * Brand accent colors for the redesigned sidebar.
 *
 * The single Jolli accent (`#6BA5F8`) mirrors the `--jolli-accent` token from the
 * sidebar redesign mockup. Per the mockup's wiring notes the accent is used for
 * **accents only** — selected-tab underlines, focus rings, small indicators —
 * never for body text or large backgrounds, which stay on the platform's
 * theme-aware `JBColor`/`UIManager` tokens so light/dark/high-contrast keep working.
 */
object JolliColors {
    /** Jolli brand accent (mockup `--jolli-accent #6ba5f8`). Same value in light + dark. */
    val Accent: JBColor = JBColor(0x6BA5F8, 0x6BA5F8)
}
