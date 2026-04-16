package ai.jolli.jollimemory.hooks

/**
 * HookRunner — Main entry point for the fat JAR.
 *
 * Dispatches to the appropriate hook based on the first argument.
 *
 * Usage: java -jar jollimemory-hooks.jar <hook> [args...]
 *   hook = "post-commit" | "post-rewrite" | "prepare-commit-msg" | "stop" | "gemini-after-agent"
 */
object HookRunner {

    @JvmStatic
    fun main(args: Array<String>) {
        if (args.isEmpty()) {
            System.err.println("Usage: java -jar jollimemory-hooks.jar <hook> [args...]")
            System.err.println("Hooks: post-commit, post-rewrite, prepare-commit-msg, stop, gemini-after-agent")
            System.exit(1)
            return
        }

        val hook = args[0]
        val hookArgs = args.drop(1).toTypedArray()

        when (hook) {
            "post-commit" -> {
                if (hookArgs.contains("--worker")) {
                    PostCommitHook.runWorker(System.getProperty("user.dir"))
                } else {
                    PostCommitHook.launch(hookArgs)
                }
            }
            "post-rewrite" -> PostRewriteHook.run(hookArgs)
            "prepare-commit-msg" -> PrepareMsgHook.run(hookArgs)
            "stop" -> StopHook.run()
            "gemini-after-agent" -> GeminiAfterAgentHook.run()
            else -> {
                System.err.println("Unknown hook: $hook")
                System.exit(1)
            }
        }
    }
}
