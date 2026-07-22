package ai.jolli.jollimemory.core

import java.io.File
import java.io.PrintStream

/**
 * HookEnv — the single access point for JVM-global state.
 *
 * This is the ONLY production file that may touch System.out / System.err /
 * System.`in` / System.getProperty / System.getenv directly (enforced by
 * scripts/check-global-state.sh). Every field's default value IS the real
 * global, so a bare `HookEnv()` built at a composition root behaves exactly
 * like the previously hard-wired code.
 *
 * Composition roots (the only places a REAL instance is born):
 *   - IDE-side services construct one where needed (plugin process)
 *
 * Tests never mutate JVM globals: they build a fake instance via
 * `fakeHookEnv(...)` (test sources, TestEnvs.kt) and pass it in. Each test
 * owning its private instance is what makes the suite safe to run in one JVM
 * with JUnit 5 parallel class execution — there is no shared mutable state
 * left to race on.
 */
class HookEnv(
    /** Reads the entire stdin. Hooks receive their JSON payload this way. */
    val readStdin: () -> String = { System.`in`.bufferedReader().readText() },
    /** Protocol channel to the parent process (NOT a log sink — logs go to JmLogger). */
    val stdout: PrintStream = System.out,
    /** Human-facing error channel. */
    val stderr: PrintStream = System.err,
    /** The user's home directory (~). */
    val userHome: File = File(System.getProperty("user.home")),
    /** Current working directory of this process. */
    val userDir: File = File(System.getProperty("user.dir")),
    /** OS name as reported by the JVM, e.g. "Mac OS X", "Windows 11", "Linux". */
    val osName: String = System.getProperty("os.name"),
    /** Environment variable lookup. */
    val getenv: (String) -> String? = System::getenv,
)
