package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Sentinel for the parallel-execution configuration. These assertions guard
 * settings whose silent loss would not fail loudly by itself but would bring
 * back flaky, hard-to-attribute failures across the suite.
 */
class JUnitConfigurationGateTest {

    @Test
    fun `intellij platform extensions are excluded from autodetection`() {
        // Asserting autodetection.enabled == "false" is a lost race by design:
        // the IDE testFramework.jar ships JUnit5TestEnvironmentInitializer, a
        // LauncherSessionListener that JUnit loads unconditionally via
        // ServiceLoader and that force-resets that property to "true" from
        // inside the JVM at session start — after every Gradle-side write.
        // What actually keeps the platform extensions out is the exclude
        // filter (JUnit 5.12+), set in the test task's doFirst in
        // build.gradle.kts and out of that listener's reach. If this assertion
        // fails, the filter got lost (e.g. a Gradle refactor dropped the
        // doFirst) and the serial-only extensions are back: ThreadLeakTracker
        // then fails random innocent tests over the shared
        // jollimemory-log-writer thread (waiting 10s per check), and
        // UncaughtExceptionExtension races on the JVM-global default exception
        // handler. Fix: restore the doFirst override, do NOT weaken this
        // assertion.
        System.getProperty("junit.jupiter.extensions.autodetection.exclude") shouldBe "com.intellij.*"
    }

    @Test
    fun `no auto-detected extension swapped the default exception handler`() {
        // UncaughtExceptionExtension (part of the auto-detected set) installs
        // its own default uncaught-exception handler around every test. Seeing
        // it here means auto-detection is effectively active regardless of
        // what the system property claims.
        val handlerClass = Thread.getDefaultUncaughtExceptionHandler()?.javaClass?.name ?: "none"
        handlerClass.contains("TestUncaughtExceptionHandler") shouldBe false
    }
}
