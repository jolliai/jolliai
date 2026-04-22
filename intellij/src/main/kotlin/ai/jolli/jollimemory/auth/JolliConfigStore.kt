package ai.jolli.jollimemory.auth

import ai.jolli.jollimemory.core.JolliMemoryConfig
import ai.jolli.jollimemory.core.SessionTracker
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.nio.file.Files
import java.nio.file.Path

/**
 * Read/write store for general Jolli config files under ~/.jolli/ (shared with CLI).
 * Auth token and space are stored in ~/.jolli/jollimemory/config.json.
 */
object JolliConfigStore {

    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    private fun jolliDir(): Path =
        Path.of(System.getProperty("user.home"), ".jolli")

    private fun spacePath(): Path = jolliDir().resolve("space.json")

    private data class SpaceConfigFile(
        val space: String? = null,
    )

    /** Load auth token from env var or ~/.jolli/jollimemory/config.json. */
    fun loadAuthToken(): String? {
        System.getenv("JOLLI_AUTH_TOKEN")?.takeIf { it.isNotBlank() }?.let { return it }

        val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
        return config.authToken?.takeIf { it.isNotBlank() }
    }

    /** Save auth token to ~/.jolli/jollimemory/config.json. */
    fun saveAuthToken(token: String) {
        val globalDir = SessionTracker.getGlobalConfigDir()
        val existing = SessionTracker.loadConfigFromDir(globalDir)
        SessionTracker.saveConfigToDir(existing.copy(authToken = token), globalDir)
    }

    /** Clear auth token from ~/.jolli/jollimemory/config.json. */
    fun clearAuthToken() {
        val globalDir = SessionTracker.getGlobalConfigDir()
        val existing = SessionTracker.loadConfigFromDir(globalDir)
        SessionTracker.saveConfigToDir(existing.copy(authToken = null), globalDir)
    }

    /** Load space from ~/.jolli/space.json. */
    fun loadSpace(): String? {
        val path = spacePath()
        if (!Files.exists(path)) return null
        return try {
            val json = Files.readString(path)
            gson.fromJson(json, SpaceConfigFile::class.java)?.space
        } catch (_: Exception) {
            null
        }
    }

    /** Save space to ~/.jolli/space.json. */
    fun saveSpace(space: String) {
        val dir = jolliDir()
        Files.createDirectories(dir)
        val data = SpaceConfigFile(space = space)
        Files.writeString(spacePath(), gson.toJson(data))
    }
}
