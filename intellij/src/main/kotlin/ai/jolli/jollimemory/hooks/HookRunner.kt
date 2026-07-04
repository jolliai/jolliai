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
                    // Legacy path: a stray `post-commit --worker` (from an older hook
                    // script still on disk) now drains the queue like queue-drain.
                    val cwd = System.getProperty("user.dir")
                    ai.jolli.jollimemory.core.telemetry.TelemetryActivation.bootstrap(cwd)
                    PostCommitHook.drainWorker(cwd)
                    ai.jolli.jollimemory.core.telemetry.TelemetryActivation.flushNow(cwd)
                } else {
                    PostCommitHook.launch(hookArgs)
                }
            }
            "queue-drain" -> {
                val cwd = System.getProperty("user.dir")
                // Fresh JVM — bootstrap telemetry so queue_drained/ingest events emit,
                // then flush before exit.
                ai.jolli.jollimemory.core.telemetry.TelemetryActivation.bootstrap(cwd)
                PostCommitHook.drainWorker(cwd)
                ai.jolli.jollimemory.core.telemetry.TelemetryActivation.flushNow(cwd)
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

        ai.jolli.jollimemory.core.JmLogger.flush()
    }
}
