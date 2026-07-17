package ai.jolli.jollimemory.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.PrintStream
import kotlin.io.path.createTempDirectory

/**
 * Builds a [HookEnv] whose EVERY field defaults to a fake — the mirror image
 * of production's "every field defaults to the real thing". A test overriding
 * only one field can never accidentally reach the real environment through
 * the fields it left alone.
 *
 * Prefer passing a JUnit `@TempDir` as [userHome]/[userDir]; the built-in
 * defaults only guarantee isolation, not full cleanup. `deleteOnExit()`
 * removes them at JVM exit while they are still empty — a default dir a test
 * actually wrote into is non-empty and stays behind, like any leaked temp
 * file, which is the signal to switch that test to `@TempDir`.
 */
fun fakeHookEnv(
    stdinContent: String = "",
    // Overrides stdinContent when a test needs behavior, e.g. a throwing stdin.
    readStdin: () -> String = { stdinContent },
    stdout: PrintStream = PrintStream(ByteArrayOutputStream()),
    stderr: PrintStream = PrintStream(ByteArrayOutputStream()),
    userHome: File = createTempDirectory("fake-home").toFile().apply { deleteOnExit() },
    userDir: File = createTempDirectory("fake-cwd").toFile().apply { deleteOnExit() },
    osName: String = "Mac OS X",
    env: Map<String, String> = emptyMap(),
): HookEnv = HookEnv(
    readStdin = readStdin,
    stdout = stdout,
    stderr = stderr,
    userHome = userHome,
    userDir = userDir,
    osName = osName,
    getenv = { key -> env[key] },
)
