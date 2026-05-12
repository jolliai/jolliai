package ai.jolli.jollimemory.core

import java.nio.file.Files
import java.nio.file.Path

/** Best-effort `dos:hidden` on Windows; no-op elsewhere. Silent on failure — hidden bit is cosmetic. */
object WindowsHidden {
    private val isWindows: Boolean =
        System.getProperty("os.name").lowercase().contains("win")

    fun tryMarkHidden(path: Path) {
        if (!isWindows) return
        try {
            Files.setAttribute(path, "dos:hidden", true)
        } catch (_: Exception) {
            /* hidden bit is cosmetic — never fail the caller */
        }
    }
}
