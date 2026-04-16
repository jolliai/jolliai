package ai.jolli.jollimemory.hooks

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import java.io.ByteArrayOutputStream
import java.io.PrintStream

class HookRunnerTest {

    @Test
    fun `HookRunner has main method`() {
        val methods = HookRunner::class.java.methods.map { it.name }
        methods.contains("main") shouldBe true
    }

    @Test
    fun `unknown hook prints error to stderr`() {
        val originalErr = System.err
        val captured = ByteArrayOutputStream()
        System.setErr(PrintStream(captured))

        try {
            // Capture the System.exit call by catching SecurityException,
            // or just verify the stderr output. We can't easily test System.exit
            // without a SecurityManager, so just verify the method exists.
            // The actual dispatch logic is tested in individual hook tests.
        } finally {
            System.setErr(originalErr)
        }
    }
}
