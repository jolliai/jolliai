package ai.jolli.jollimemory.bridge

/**
 * FakeGit — hand-written in-memory [GitCommands] implementation, the
 * HookEnv-style replacement for `mockk<GitOps>()` (see GitCommands.kt for why
 * the mock had to go). Every test builds its own instance, so all state is
 * per-test and thread-confined: no bytecode instrumentation, no process-global
 * stub registry, nothing to race on under JUnit 5 parallel class execution.
 *
 * Reads ([readBranchFile]/[listBranchFiles]) serve straight from [files].
 * Plumbing calls route through the programmable [onExec]/[onExecWithStdin]
 * handlers — returning null means "the git command failed", mirroring GitOps.
 * Every call is recorded, so tests assert interactions by inspecting plain
 * lists instead of MockK's verify {}.
 */
class FakeGit : GitCommands {

    /** Branch-file contents keyed by path (branch-agnostic — one orphan branch in play). */
    val files = mutableMapOf<String, String>()

    /** What [branchExists] reports. Defaults to false, like a repo without the orphan branch. */
    var branchPresent = false

    /** Every [exec] invocation's argument list, in call order. */
    val execCalls = mutableListOf<List<String>>()

    /** Every [execWithStdin] invocation: argument list paired with its stdin payload. */
    val stdinCalls = mutableListOf<Pair<List<String>, String>>()

    /** Programmable [exec] behavior; return null to simulate a failing git command. */
    var onExec: (List<String>) -> String? = { null }

    /** Programmable [execWithStdin] behavior; return null to simulate a failing git command. */
    var onExecWithStdin: (List<String>, String) -> String? = { _, _ -> null }

    override fun exec(vararg args: String, timeoutSeconds: Long, trim: Boolean): String? {
        val call = args.toList()
        execCalls += call
        return onExec(call)
    }

    override fun execWithStdin(vararg args: String, input: String, timeoutSeconds: Long): String? {
        val call = args.toList()
        stdinCalls += call to input
        return onExecWithStdin(call, input)
    }

    override fun branchExists(branchName: String): Boolean = branchPresent

    override fun listBranchFiles(branch: String, prefix: String): List<String> =
        files.keys.filter { it.startsWith(prefix) }.sorted()

    override fun readBranchFile(branch: String, path: String): String? = files[path]

    /** Stdin payloads of every `hash-object` call — the blobs a write pipeline persisted. */
    fun writtenBlobs(): List<String> =
        stdinCalls.filter { it.first.firstOrNull() == "hash-object" }.map { it.second }

    /** `exec` calls reading a branch tip (`rev-parse refs/heads/...`) — the write-pipeline entry point. */
    fun branchTipReads(): List<List<String>> =
        execCalls.filter { it.getOrNull(0) == "rev-parse" && it.getOrNull(1)?.startsWith("refs/heads/") == true }

    /** True when any `mktree` plumbing call happened (a tree object was written). */
    fun wroteTree(): Boolean = stdinCalls.any { it.first.firstOrNull() == "mktree" }
}
