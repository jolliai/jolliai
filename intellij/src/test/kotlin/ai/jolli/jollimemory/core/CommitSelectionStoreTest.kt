package ai.jolli.jollimemory.core

import com.google.gson.Gson
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Pins the Gson defaulting that [CommitSelectionStore.CommitExclusions] depends on.
 *
 * The class declares five non-null `Set<String>` fields and reads them straight off
 * the `shared-store` wire. That is only safe because EVERY constructor parameter
 * carries a default: Kotlin emits a synthetic no-arg constructor in that case, Gson
 * prefers it, and the initializers actually run. Drop a single default — add one
 * required field — and Gson falls back to `Unsafe` allocation, skips initializers,
 * and writes null into every field the payload omits, so a non-null `Set`
 * declaration NPEs on first use.
 *
 * Removing a default is a COMPILE error today, not a silent switch to `Unsafe`:
 * five call sites construct this with no arguments, and two of them
 * (`WorkingContext.ContextList` / `ActiveForCommit`, which use it as their own
 * Gson-safe default) are structural. What the constructor assertion below adds is
 * naming the cause if that ever stops being true — an NPE surfacing in a panel is
 * a long way from "someone removed a default value".
 *
 * The defaulting cases earn their place independently: they cover a payload with
 * fields missing, which is an older dist serving a newer host, and no compiler
 * sees that.
 *
 * Pure Gson over literal JSON — no Project, no bridge, no JVM globals — so this runs
 * under the default parallel-tests policy.
 */
class CommitSelectionStoreTest {

    private val gson = Gson()

    private fun parse(json: String): CommitSelectionStore.CommitExclusions =
        gson.fromJson(json, CommitSelectionStore.CommitExclusions::class.java)

    @Test
    fun `an empty object deserializes to five empty sets, not nulls`() {
        val parsed = parse("{}")
        // Each accessed directly: a null behind a non-null declaration only throws
        // when it is touched, so asserting on the object as a whole would pass.
        parsed.conversations.shouldBeEmpty()
        parsed.plans.shouldBeEmpty()
        parsed.notes.shouldBeEmpty()
        parsed.references.shouldBeEmpty()
        parsed.skills.shouldBeEmpty()
    }

    // The real-world shape: a selection file written before skills were selectable.
    // The CLI spells all five out as [] today (`selection-read`), so this covers the
    // payloads it cannot know about — an older dist serving a newer host.
    @Test
    fun `a payload omitting skills still yields an empty skills set`() {
        val parsed = parse(
            """{"conversations":["claude:abc"],"plans":["p1"],"notes":[],"references":[]}""",
        )
        parsed.skills.shouldBeEmpty()
        parsed.conversations.shouldContainExactly("claude:abc")
        parsed.plans.shouldContainExactly("p1")
    }

    @Test
    fun `every kind round-trips when the payload is complete`() {
        val parsed = parse(
            """{"conversations":["c"],"plans":["p"],"notes":["n"],"references":["linear:JOL-1"],"skills":["s"]}""",
        )
        parsed.conversations.shouldContainExactly("c")
        parsed.plans.shouldContainExactly("p")
        parsed.notes.shouldContainExactly("n")
        parsed.references.shouldContainExactly("linear:JOL-1")
        parsed.skills.shouldContainExactly("s")
    }

    // Guards the defaulting mechanism itself rather than one field's symptom: if the
    // synthetic no-arg constructor ever stops being emitted, this is the assertion
    // that names the cause instead of leaving an NPE to be traced back to it.
    @Test
    fun `CommitExclusions keeps the synthetic no-arg constructor Gson relies on`() {
        val hasNoArgConstructor = CommitSelectionStore.CommitExclusions::class.java
            .declaredConstructors
            .any { it.parameterCount == 0 }
        hasNoArgConstructor shouldBe true
    }

    @Test
    fun `the no-arg default is all-empty`() {
        val fresh = CommitSelectionStore.CommitExclusions()
        fresh.conversations.shouldBeEmpty()
        fresh.skills.shouldBeEmpty()
    }
}
