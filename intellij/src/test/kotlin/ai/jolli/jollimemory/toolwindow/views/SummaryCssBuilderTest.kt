package ai.jolli.jollimemory.toolwindow.views

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Test

/**
 * Guards the *floating overlay must be opaque* invariant in the summary webview's CSS.
 *
 * The surface tokens in this stylesheet (`--panel-bg`, `--panel-inner`, `--surface-hover`, …)
 * are 1.5–4.5% alpha. That is correct for an element STACKED on a known background — a card
 * inside a panel composites against the panel and reads as a subtle lift. It is wrong for an
 * element FLOATING over arbitrary content (`position: fixed` / `absolute`): the page shows
 * straight through and the overlay's own text collides with whatever happens to be scrolled
 * underneath. A copy-confirmation toast pinned to `bottom: 16px` over a list of topic cards
 * was invisible for exactly this reason.
 *
 * [floatingOverlaysUseOpaqueBackgrounds] is the real guard: it walks EVERY declaration block
 * in the generated stylesheet rather than the handful we happened to think of, so the next
 * floating element that reaches for a translucent surface token fails here instead of in a
 * screenshot. The per-element tests below pin the specific elements this was found on.
 */
class SummaryCssBuilderTest {

    /** `--token: value;` definitions, i.e. the `:root` custom-property block. */
    private val tokenPattern = Regex("""--([a-z0-9-]+)\s*:\s*([^;]+);""")

    /**
     * Innermost declaration blocks — a `selector { … }` whose body contains no further `{`.
     * Restricting to innermost blocks is what makes this safe against the `@media` /
     * `@keyframes` wrappers in this stylesheet: their bodies contain braces, so they are
     * skipped as containers and their inner rules are matched individually.
     */
    private val declBlockPattern = Regex("""([^{}]+)\{([^{}]*)\}""")

    private val backgroundPattern = Regex("""\bbackground(?:-color)?\s*:\s*([^;]+)""")
    private val varRefPattern = Regex("""var\(\s*(--[a-z0-9-]+)""")

    /**
     * Partial alpha only — `0 < a < 1`. Fully `transparent` is deliberately NOT flagged:
     * that's a click-catcher scrim, which paints nothing and carries no text, so being
     * see-through is the entire point. The bug this guards is the opposite intent — "I
     * wanted a visible surface" plus a token that is almost invisible.
     */
    private fun isTranslucent(value: String): Boolean {
        val alpha = Regex("""(?:rgba|hsla)\([^)]*,\s*([0-9.]+)\s*\)""").find(value.trim())
            ?.groupValues?.get(1)?.toDoubleOrNull()
        return alpha != null && alpha > 0.0 && alpha < 1.0
    }

    private fun tokensIn(css: String): Map<String, String> =
        tokenPattern.findAll(css).associate { it.groupValues[1] to it.groupValues[2].trim() }

    /**
     * Selectors of blocks that float and paint a translucent *surface token*. Resolves one
     * level of `var()` indirection against the stylesheet's own token block, so the check is
     * on the effective colour rather than on the token's name.
     *
     * Only backgrounds that reach for a `var(--…)` token are considered — the bug this guards
     * is "I wanted a visible surface" plus a token that is almost invisible (see class doc).
     * A deliberate inline literal, e.g. the modal backdrop's `rgba(0, 0, 0, 0.5)` dimming
     * scrim, is not a mis-grabbed surface token; it is excluded for the same reason a fully
     * `transparent` click-catcher is — being see-through is the entire point.
     */
    private fun translucentFloatingSelectors(input: String): List<String> {
        // Strip comments so a preceding /* … */ can't end up in the reported selector.
        val css = input.replace(Regex("""/\*[\s\S]*?\*/"""), "")
        val tokens = tokensIn(css)
        return declBlockPattern.findAll(css).mapNotNull { block ->
            val selector = block.groupValues[1].trim()
            val body = block.groupValues[2]
            if (!body.contains("position:")) return@mapNotNull null
            val floats = Regex("""position\s*:\s*(fixed|absolute)""").containsMatchIn(body)
            if (!floats) return@mapNotNull null
            val background = backgroundPattern.find(body)?.groupValues?.get(1) ?: return@mapNotNull null
            val tokenName = varRefPattern.find(background)?.groupValues?.get(1)?.removePrefix("--")
                ?: return@mapNotNull null
            val resolved = tokens[tokenName] ?: return@mapNotNull null
            if (isTranslucent(resolved)) selector else null
        }.toList()
    }

    @Test
    fun `floating overlays use opaque backgrounds in both themes`() {
        for (isDark in listOf(true, false)) {
            translucentFloatingSelectors(SummaryCssBuilder.buildCss(isDark = isDark))
                .shouldBeEmpty()
        }
    }

    @Test
    fun `the alpha detector recognizes the token shapes this stylesheet actually uses`() {
        // Guards the guard: if isTranslucent stopped matching these, the sweep above would
        // pass vacuously and the original bug could walk right back in.
        isTranslucent("rgba(255, 255, 255, 0.045)") shouldBe true
        isTranslucent("rgba(0, 0, 0, 0.035)") shouldBe true
        isTranslucent("rgba(60, 63, 65, 1)") shouldBe false
        isTranslucent("#3c3f41") shouldBe false
        isTranslucent("#ffffff") shouldBe false
        // A click-catcher scrim means to be invisible — not the bug being guarded.
        isTranslucent("transparent") shouldBe false
        isTranslucent("rgba(0, 0, 0, 0)") shouldBe false
    }

    @Test
    fun `the sweep flags a floating element that reaches for a translucent token`() {
        // Proves the sweep has teeth by feeding it the exact bug it exists to catch.
        val regressed = """
          :root { --panel-inner: rgba(255, 255, 255, 0.045); }
          .copy-toast { position: fixed; bottom: 16px; background: var(--panel-inner); }
        """
        translucentFloatingSelectors(regressed) shouldContain ".copy-toast"
    }

    @Test
    fun `the copy toast and export dropdown paint the opaque overlay surface`() {
        for (isDark in listOf(true, false)) {
            val css = SummaryCssBuilder.buildCss(isDark = isDark)
            css shouldContain "background: var(--overlay-bg)"
            css shouldContain "--overlay-bg:"
            css shouldContain "--overlay-fg:"
            css shouldContain "--overlay-border:"
        }
    }

    @Test
    fun `the in-document tooltip stays opaque and inverted`() {
        // JCEF renders no native `title` tooltips, so this bubble IS the tooltip — it floats
        // over arbitrary content and must never be see-through.
        for (isDark in listOf(true, false)) {
            val tokens = tokensIn(SummaryCssBuilder.buildCss(isDark = isDark))
            isTranslucent(tokens.getValue("tooltip-bg")) shouldBe false
            isTranslucent(tokens.getValue("overlay-bg")) shouldBe false
        }
    }

    @Test
    fun `the reference-id chip has a visible focus ring for keyboard users`() {
        for (isDark in listOf(true, false)) {
            SummaryCssBuilder.buildCss(isDark = isDark) shouldContain ".page-title-ref:focus-visible"
        }
    }
}
