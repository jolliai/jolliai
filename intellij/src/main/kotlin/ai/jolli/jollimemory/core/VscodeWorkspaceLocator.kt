package ai.jolli.jollimemory.core

import com.google.gson.JsonParser
import java.io.File
import java.net.URI
import java.nio.file.Paths

/**
 * VscodeWorkspaceLocator — per-platform path resolution and `workspace.json`
 * scanning for VS Code-family user data directories.
 *
 * Used by both Cursor IDE (`flavor: Cursor`) and VS Code Copilot Chat
 * (`flavor: Code`). Adding a new vscode fork (Insiders, Code-OSS, Windsurf, …)
 * requires only extending [VscodeFlavor].
 *
 * Kotlin port of `cli/src/core/VscodeWorkspaceLocator.ts`.
 */

private val log = JmLogger.create("VscodeWorkspaceLocator")

enum class VscodeFlavor(val dirName: String) {
	Cursor("Cursor"),
	Code("Code"),
}

/**
 * Returns the VS Code-family user-data root for the current platform.
 *
 *   darwin   ~/Library/Application Support/<flavor>
 *   linux    ~/.config/<flavor>
 *   win32    %APPDATA%/<flavor>  (fallback to ~/AppData/Roaming/<flavor>)
 */
fun getVscodeUserDataDir(flavor: VscodeFlavor, home: String = System.getProperty("user.home")): String {
	val osName = System.getProperty("os.name").lowercase()
	return when {
		osName.contains("mac") ->
			home + File.separator + "Library" + File.separator + "Application Support" + File.separator + flavor.dirName
		osName.contains("win") -> {
			// `cursor.appdata.override` is a test hook: Java cannot unset env vars, so tests
			// that need to redirect away from the real %APPDATA% set this system property instead.
			val appData = if (flavor == VscodeFlavor.Cursor) System.getProperty("cursor.appdata.override") else null
			(appData ?: System.getenv("APPDATA") ?: (home + File.separator + "AppData" + File.separator + "Roaming")) +
				File.separator + flavor.dirName
		}
		else ->
			home + File.separator + ".config" + File.separator + flavor.dirName
	}
}

/** Returns the workspaceStorage dir for the given flavor. */
fun getVscodeWorkspaceStorageDir(flavor: VscodeFlavor, home: String = System.getProperty("user.home")): String =
	getVscodeUserDataDir(flavor, home) + File.separator + "User" + File.separator + "workspaceStorage"

/**
 * Normalises a filesystem path for workspace matching:
 *   - Backslashes → forward slashes (Windows path comparison)
 *   - Strip trailing slashes
 *   - Lowercase on macOS and Windows (case-insensitive filesystems)
 */
fun normalizePathForMatch(p: String): String {
	val fwd = p.replace('\\', '/')
	val trimmed = fwd.trimEnd('/')
	val osName = System.getProperty("os.name").lowercase()
	return if (osName.contains("mac") || osName.contains("win")) trimmed.lowercase() else trimmed
}

/**
 * Scans the workspaceStorage directory for an entry whose `workspace.json` has
 * a `folder` URI that resolves to projectDir. Returns the entry name (workspace
 * hash) on match, or null when no match is found.
 *
 * Single-folder workspaces only — entries with a `workspace` field instead of
 * `folder` (multi-root .code-workspace files) are skipped silently.
 */
fun findVscodeWorkspaceHash(flavor: VscodeFlavor, projectDir: String): String? {
	val wsStorageDir = File(getVscodeWorkspaceStorageDir(flavor))
	if (!wsStorageDir.isDirectory) {
		log.debug("%s workspaceStorage not readable at %s", flavor, wsStorageDir.path)
		return null
	}

	val target = normalizePathForMatch(projectDir)
	val entries = wsStorageDir.listFiles() ?: return null

	for (entry in entries) {
		val wsJson = File(entry, "workspace.json")
		if (!wsJson.isFile) continue

		val folderUri = try {
			JsonParser.parseString(wsJson.readText()).asJsonObject
				.get("folder")?.takeIf { it.isJsonPrimitive }?.asString
		} catch (_: Exception) {
			continue
		} ?: continue

		if (!folderUri.startsWith("file://")) continue

		val folderPath = try {
			Paths.get(URI(folderUri)).toString()
		} catch (_: Exception) {
			log.warn("%s workspace %s has unparseable folder URI: %s", flavor, entry.name, folderUri)
			continue
		}

		if (normalizePathForMatch(folderPath) == target) {
			return entry.name
		}
	}
	return null
}
