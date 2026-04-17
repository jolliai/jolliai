package ai.jolli.jollimemory.core

import java.io.File
import java.time.Instant
import java.util.concurrent.LinkedBlockingQueue

/**
 * JolliMemory Logger — Kotlin port of Logger.ts
 *
 * Writes to .jolli/jollimemory/debug.log with sequential ordering.
 * Also logs via IntelliJ's Logger when running inside the IDE.
 */
object JmLogger {
    const val JOLLI_DIR = ".jolli"
    const val JOLLIMEMORY_DIR = "jollimemory"
    const val LOG_FILE = "debug.log"
    const val ORPHAN_BRANCH = "jollimemory/summaries/v3"
    const val ORPHAN_BRANCH_V1 = "jollimemory/summaries/v1"

    private const val MAX_LOG_SIZE = 512 * 1024 // 500KB

    @Volatile
    private var logDirCwd: String? = null

    @Volatile
    private var globalLogLevel: LogLevel = LogLevel.info
    @Volatile
    private var moduleOverrides: Map<String, LogLevel> = emptyMap()

    private val writeQueue = LinkedBlockingQueue<String>()

    @Volatile
    private var writerRunning = false
    private val writerLock = Any()

    /** Ensures a single daemon writer thread is active. Starts one if needed. */
    private fun ensureWriterThread() {
        if (writerRunning) return
        synchronized(writerLock) {
            if (writerRunning) return
            writerRunning = true
            Thread({
                try {
                    while (true) {
                        // Poll with timeout so the thread exits when idle (prevents thread-leak false positives)
                        val line = writeQueue.poll(5, java.util.concurrent.TimeUnit.SECONDS) ?: break
                        writeToFile(line)
                    }
                } catch (_: InterruptedException) {
                    // Drain remaining items
                    writeQueue.forEach { writeToFile(it) }
                } finally {
                    writerRunning = false
                }
            }, "jollimemory-log-writer").apply {
                isDaemon = true
                start()
            }
        }
    }

    fun setLogDir(cwd: String) {
        logDirCwd = cwd
    }

    fun setLogLevel(level: LogLevel, overrides: Map<String, LogLevel> = emptyMap()) {
        globalLogLevel = level
        moduleOverrides = overrides
    }

    fun getJolliMemoryDir(cwd: String? = null): String {
        val base = cwd ?: logDirCwd ?: System.getProperty("user.dir")
        return "$base/$JOLLI_DIR/$JOLLIMEMORY_DIR"
    }

    fun create(module: String): ModuleLogger = ModuleLogger(module)

    private fun shouldLog(level: LogLevel, module: String): Boolean {
        val threshold = moduleOverrides[module]?.let { LogLevel.valueOf(it.name) } ?: globalLogLevel
        return level.priority >= threshold.priority
    }

    private fun formatMessage(level: LogLevel, module: String, message: String): String {
        val timestamp = Instant.now().toString()
        val levelTag = level.name.uppercase().padEnd(5)
        return "[$timestamp] $levelTag [$module] $message"
    }

    private fun writeToFile(line: String) {
        try {
            val dir = File(getJolliMemoryDir())
            if (!dir.exists()) return

            val logFile = File(dir, LOG_FILE)

            // Rotate if too large
            if (logFile.exists() && logFile.length() > MAX_LOG_SIZE) {
                logFile.writeText("[log rotated at ${Instant.now()}]\n")
            }

            logFile.appendText("$line\n")
        } catch (_: Exception) {
            // Silently skip — logging should never crash
        }
    }

    class ModuleLogger(private val module: String) {
        fun debug(message: String, vararg args: Any?) = log(LogLevel.debug, message, args)
        fun info(message: String, vararg args: Any?) = log(LogLevel.info, message, args)
        fun warn(message: String, vararg args: Any?) = log(LogLevel.warn, message, args)
        fun error(message: String, vararg args: Any?) = log(LogLevel.error, message, args)

        private fun log(level: LogLevel, message: String, args: Array<out Any?>) {
            val formatted = formatPrintf(message, args)
            val line = formatMessage(level, module, formatted)

            if (shouldLog(level, module)) {
                writeQueue.offer(line)
                ensureWriterThread()
            }
        }

        /** Simple printf-style formatting: %s, %d, %j */
        private fun formatPrintf(message: String, args: Array<out Any?>): String {
            if (args.isEmpty()) return message
            var argIndex = 0
            return message.replace(Regex("%[sdj]")) { match ->
                if (argIndex >= args.size) return@replace match.value
                val arg = args[argIndex++]
                when (match.value) {
                    "%d" -> (arg as? Number)?.toString() ?: arg.toString()
                    "%j" -> arg.toString() // simplified JSON
                    else -> arg?.toString() ?: "null"
                }
            }
        }
    }
}
