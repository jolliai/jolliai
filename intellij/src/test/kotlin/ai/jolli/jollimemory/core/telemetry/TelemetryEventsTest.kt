package ai.jolli.jollimemory.core.telemetry

import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.ints.shouldBeGreaterThanOrEqual
import io.kotest.matchers.string.shouldNotBeBlank
import java.io.File
import org.junit.jupiter.api.Test

class TelemetryEventsTest {
    @Test
    fun `registers the v1 catalog with non-blank docs`() {
        TelemetryEvents.TELEMETRY_EVENTS.size shouldBeGreaterThanOrEqual 19
        for ((_, doc) in TelemetryEvents.TELEMETRY_EVENTS) {
            doc.shouldNotBeBlank()
        }
    }

    @Test
    fun `every name follows the object_action convention`() {
        for (name in TelemetryEvents.TELEMETRY_EVENTS.keys) {
            TelemetryEvents.TELEMETRY_EVENT_NAME_PATTERN.matches(name).shouldBeTrue()
        }
    }

    @Test
    fun `the naming pattern rejects malformed names`() {
        for (bad in listOf("Recall", "recall", "recall_", "_recall", "recall__performed", "recall performed")) {
            TelemetryEvents.TELEMETRY_EVENT_NAME_PATTERN.matches(bad).shouldBeFalse()
        }
        for (good in listOf("recall_performed", "signin_completed", "app_installed", "ai_source_detected")) {
            TelemetryEvents.TELEMETRY_EVENT_NAME_PATTERN.matches(good).shouldBeTrue()
        }
    }

    @Test
    fun `isTelemetryEventName accepts registered names and rejects everything else`() {
        TelemetryEvents.isTelemetryEventName("recall_performed").shouldBeTrue()
        TelemetryEvents.isTelemetryEventName("signin_completed").shouldBeTrue()
        TelemetryEvents.isTelemetryEventName("not_a_real_event").shouldBeFalse()
        TelemetryEvents.isTelemetryEventName("").shouldBeFalse()
    }

    /**
     * Every `Telemetry.track("…")` literal in production code must name a REGISTERED event,
     * because `track` silently drops anything else — an unregistered name is a call site that
     * looks like instrumentation and reports nothing, which is worse than no call at all
     * (`memory_ref_id_copied` shipped that way and produced zero data).
     *
     * The CLI/VS Code side gets this from the compiler: its `track` takes the
     * `TelemetryEventName` union, so an unregistered name fails typecheck. Kotlin's takes a
     * plain `String`, so nothing catches it there — hence this test.
     */
    @Test
    fun `every tracked event name in production code is registered`() {
        val unregistered = trackedEventNames()
            .filterNot { (_, name) -> TelemetryEvents.isTelemetryEventName(name) }
            .map { (file, name) -> "$name (in $file)" }
        unregistered.shouldBeEmpty()
    }

    @Test
    fun `the tracked-name sweep can actually see the call sites it is guarding`() {
        // Guards the guard: a sweep that finds nothing would pass vacuously forever —
        // which is the failure mode that let an unregistered name ship in the first place.
        val found = trackedEventNames().map { (_, name) -> name }.toSet()
        found.size shouldBeGreaterThanOrEqual 5
        found shouldContain "memory_ref_id_copied"
    }

    private companion object {
        private val TRACK_CALL = Regex("""Telemetry\.track\(\s*"([^"]+)"""")

        /**
         * (file name, event name) for every `Telemetry.track("…")` literal in production
         * Kotlin. Tolerates being run from either the `intellij/` project dir (Gradle's
         * default test working dir) or the repo root (some IDE run configurations).
         */
        fun trackedEventNames(): List<Pair<String, String>> {
            val root = listOf("src/main/kotlin", "intellij/src/main/kotlin")
                .map { File(it) }
                .firstOrNull { it.isDirectory }
                ?: return emptyList()
            return root.walkTopDown()
                .filter { it.isFile && it.extension == "kt" }
                .flatMap { file -> TRACK_CALL.findAll(file.readText()).map { file.name to it.groupValues[1] } }
                .toList()
        }
    }
}
