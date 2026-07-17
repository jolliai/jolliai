package ai.jolli.jollimemory.bridge

/**
 * GitCommands — the git capability surface that SummaryReader, SummaryStore,
 * OrphanBranchStorage and StorageFactory depend on. [GitOps] is the sole real
 * implementation; production behavior is unchanged.
 *
 * Extracted so tests can inject a hand-written in-memory fake (FakeGit in test
 * sources) instead of MockK-mocking the final [GitOps] class. Inline-mocking a
 * final class retransforms its bytecode JVM-wide and records stubs on MockK's
 * process-global recorder; under JUnit 5 parallel class execution that
 * instrumentation/recording window overlapped other tests (worker threads
 * executing the real GitOps, the coverage agent rewriting freshly loaded
 * classes) and stubs occasionally vanished — a relaxed mock then answered
 * defaults and unrelated assertions failed. A fake is a plain object owned by
 * one test: nothing global, nothing to race on.
 *
 * Default parameter values live on the interface; overrides inherit them
 * (Kotlin forbids re-declaring defaults on overrides).
 */
interface GitCommands {

    /** Runs a git command and returns stdout, or null on failure. */
    fun exec(vararg args: String, timeoutSeconds: Long = 15, trim: Boolean = true): String?

    /** Runs a git command with [input] on stdin and returns stdout, or null on failure. */
    fun execWithStdin(vararg args: String, input: String, timeoutSeconds: Long = 15): String?

    /** Check if a branch exists. */
    fun branchExists(branchName: String): Boolean

    /** List files in an orphan branch under a prefix. */
    fun listBranchFiles(branch: String, prefix: String): List<String>

    /** Read a file from an orphan branch. */
    fun readBranchFile(branch: String, path: String): String?
}
