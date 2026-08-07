package ai.jolli.jollimemory.core

import com.google.gson.Gson
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Pins the wire shape of [FileDiscarder.DiscardOutcome] against real Gson.
 *
 * The CLI omits `error` for every success and `additionalPaths` for everything
 * that is not a rename, so "this field is absent from the JSON" is the common
 * case here, not an edge one — and what Gson does with an absent field depends
 * on something invisible at the call site.
 *
 * **Which of two opposite behaviours you get is decided by the class, not by
 * Gson.** Kotlin emits an extra no-arg constructor when EVERY primary-constructor
 * parameter has a default (verified in the bytecode: `DiscardOutcome` carries a
 * public `()V`). Gson prefers that constructor, so every Kotlin default really is
 * applied and an absent `relativePath` arrives as `""`. Give any parameter no
 * default and that constructor disappears, Gson falls back to
 * `Unsafe.allocateInstance`, and the defaults stop running entirely: every field
 * lands on its JVM zero, so a non-null `String` holds null and throws the first
 * time anything reads it.
 *
 * That flip is silent, and it is one added field away — which is why the no-arg
 * constructor is asserted below rather than assumed. Declaring an omitted field
 * nullable (as `additionalPaths` is) stays correct under BOTH regimes and is the
 * reason to keep doing it.
 *
 * `discard()` itself is not exercised here: it goes through
 * [ai.jolli.jollimemory.bridge.CliIntegrations.runIdeBridge], which has no
 * injectable seam, and the JVM-global-state rule forbids stubbing a Kotlin
 * singleton. What is testable — and what actually broke — is the
 * deserialization contract below.
 *
 * Pure in-memory: no Project, no VFS, no JVM globals, so this runs under the
 * default parallel-tests policy.
 */
class FileDiscarderTest {

    private val gson = Gson()

    private fun parse(json: String): FileDiscarder.DiscardOutcome =
        gson.fromJson(json, FileDiscarder.DiscardOutcome::class.java)

    @Test
    fun `a successful outcome without additionalPaths reports only its own path`() {
        // The CLI omits the field entirely here. Reading it must not throw, and
        // the caller must still get one path to refresh.
        val outcome = parse("""{"relativePath":"a.txt","ok":true,"action":"restored"}""")

        outcome.ok shouldBe true
        outcome.error shouldBe null
        outcome.additionalPaths shouldBe null
        outcome.touchedPaths shouldBe listOf("a.txt")
    }

    @Test
    fun `a rename revert reports the restored original alongside the clicked path`() {
        // Both must be refreshed: the IDE's file list is built from the VFS, and
        // the restored original is invisible until it is told about it.
        val outcome = parse(
            """{"relativePath":"new.txt","ok":true,"action":"rename-reverted","additionalPaths":["old.txt"]}""",
        )

        outcome.touchedPaths shouldBe listOf("new.txt", "old.txt")
    }

    @Test
    fun `a failed outcome carries git's reason`() {
        val outcome = parse(
            """{"relativePath":"a.txt","ok":false,"action":"restored","error":"fatal: index.lock exists"}""",
        )

        outcome.ok shouldBe false
        outcome.error shouldBe "fatal: index.lock exists"
    }

    @Test
    fun `a status read that could not run is a failure, not a clean not-found`() {
        // The distinction is the whole point: `not-found` with ok=true means the
        // caller asked for a state that already holds, while this means nothing
        // was classified and nothing was discarded.
        val outcome = parse(
            """{"relativePath":"a.txt","ok":false,"action":"status-unavailable","error":"fatal: not a git repository"}""",
        )

        outcome.ok shouldBe false
        outcome.action shouldBe "status-unavailable"
    }

    @Test
    fun `an outcome missing ok defaults to failed, never to success`() {
        // `ok` is the one field the constructor question cannot hurt: Kotlin's
        // default is false and the JVM zero for a boolean is also false, so an
        // absent `ok` reads as a failure under BOTH deserialization regimes. That
        // is the safe side — an unreadable outcome must never read as a working
        // button. Pinned so a migration to a nullable Boolean, or a default of
        // true, cannot flip it silently.
        val outcome = parse("""{"relativePath":"a.txt","action":"restored"}""")

        outcome.ok shouldBe false
    }

    @Test
    fun `an empty additionalPaths array behaves like an absent one`() {
        val outcome = parse("""{"relativePath":"a.txt","ok":true,"action":"deleted","additionalPaths":[]}""")

        outcome.touchedPaths shouldBe listOf("a.txt")
    }

    @Test
    fun `DiscardOutcome keeps the no-arg constructor its defaults depend on`() {
        // The load-bearing premise, asserted rather than assumed. Kotlin only
        // emits this constructor while EVERY primary-constructor parameter has a
        // default; adding one without a default deletes it, and Gson silently
        // switches to Unsafe.allocateInstance — at which point every default
        // below stops being applied and every non-null declaration starts lying.
        // Nothing else in the build notices that: it compiles, it lints, and the
        // first symptom is an NPE reading a `String` that cannot be null.
        val hasNoArgConstructor = FileDiscarder.DiscardOutcome::class.java.declaredConstructors
            .any { it.parameterCount == 0 }

        hasNoArgConstructor shouldBe true
    }

    @Test
    fun `an outcome that omits relativePath falls back to the Kotlin default`() {
        // Because of the constructor above, an absent field is "" — NOT null.
        // `discard()` still rejects this shape as an unreadable response: the CLI
        // always names the path it acted on, so a blank one means the body cannot
        // be lined up against the request.
        val outcome = parse("""{"ok":true,"action":"restored"}""")

        outcome.relativePath shouldBe ""
    }

    @Test
    fun `an invalid-path outcome is a failure carrying its reason`() {
        // The CLI's answer to a blank path. It must NOT arrive as not-found: a
        // caller reading `ok` alone would otherwise show the user a confirmation
        // dialog, a click, and no change anywhere.
        val outcome = parse(
            """{"relativePath":"","ok":false,"action":"invalid-path","error":"no file path was provided"}""",
        )

        outcome.ok shouldBe false
        outcome.action shouldBe "invalid-path"
        outcome.error shouldBe "no file path was provided"
    }

    // ── DiscardPreview ──────────────────────────────────────────────────
    //
    // The wording query. `preview()` goes through the same un-stubbable
    // `runIdeBridge` seam as `discard()`, so what is pinned here is the same
    // thing that can actually break: the deserialization contract.

    private fun parsePreview(json: String): FileDiscarder.DiscardPreview =
        gson.fromJson(json, FileDiscarder.DiscardPreview::class.java)

    @Test
    fun `a preview reports whether the discard deletes the file`() {
        parsePreview("""{"relativePath":"new.txt","deletesFile":true}""").deletesFile shouldBe true
        parsePreview("""{"relativePath":"mod.txt","deletesFile":false}""").deletesFile shouldBe false
    }

    @Test
    fun `a preview that omits deletesFile falls back to the milder verb`() {
        // Same no-arg-constructor regime as DiscardOutcome, and the default is
        // chosen so that a body we could not fully read understates rather than
        // overstates: nothing is claimed to be deleted, and the caller degrades to
        // GitStatusCodes.discardDeletesFile.
        val preview = parsePreview("""{"relativePath":"a.txt"}""")

        preview.relativePath shouldBe "a.txt"
        preview.deletesFile shouldBe false
    }

    @Test
    fun `DiscardPreview keeps the no-arg constructor its defaults depend on`() {
        // Identical trap to DiscardOutcome's: one parameter without a default and
        // Gson switches to Unsafe.allocateInstance, at which point `relativePath`
        // arrives null through a non-null declaration and the defaults above stop
        // being true.
        val hasNoArgConstructor = FileDiscarder.DiscardPreview::class.java.declaredConstructors
            .any { it.parameterCount == 0 }

        hasNoArgConstructor shouldBe true
    }
}
