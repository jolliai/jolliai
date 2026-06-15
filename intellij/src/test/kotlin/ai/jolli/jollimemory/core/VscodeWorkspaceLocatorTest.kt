package ai.jolli.jollimemory.core

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class VscodeWorkspaceLocatorTest {

	private var originalHome: String? = null
	private var originalCursorOverride: String? = null
	private var originalCodeOverride: String? = null

	@BeforeEach
	fun setup() {
		originalHome = System.getProperty("user.home")
		originalCursorOverride = System.getProperty("cursor.appdata.override")
		originalCodeOverride = System.getProperty("code.appdata.override")
	}

	@AfterEach
	fun teardown() {
		originalHome?.let { System.setProperty("user.home", it) }
		restoreOrClear("cursor.appdata.override", originalCursorOverride)
		restoreOrClear("code.appdata.override", originalCodeOverride)
	}

	private fun restoreOrClear(key: String, original: String?) {
		if (original != null) System.setProperty(key, original) else System.clearProperty(key)
	}

	/**
	 * Points `user.home` at [home] and redirects every flavor's Windows %APPDATA%
	 * lookup into `<home>/AppData/Roaming` (the layout [userDataDir] writes to).
	 * On macOS/Linux the override system properties are ignored by production.
	 */
	private fun useHome(home: File) {
		System.setProperty("user.home", home.absolutePath)
		val appData = File(home, "AppData/Roaming").absolutePath
		System.setProperty("cursor.appdata.override", appData)
		System.setProperty("code.appdata.override", appData)
	}

	/** Returns the platform-correct user-data dir for a flavor under the given home. */
	private fun userDataDir(home: File, dirName: String): File {
		val osName = System.getProperty("os.name").lowercase()
		return when {
			osName.contains("mac") -> File(home, "Library/Application Support/$dirName")
			osName.contains("win") -> File(home, "AppData/Roaming/$dirName")
			else -> File(home, ".config/$dirName")
		}
	}

	private fun setupWorkspaceStorage(home: File, flavor: VscodeFlavor): File {
		val wsStorage = File(userDataDir(home, flavor.dirName), "User/workspaceStorage")
		wsStorage.mkdirs()
		return wsStorage
	}

	private fun writeWorkspaceJson(wsHashDir: File, folderUri: String) {
		wsHashDir.mkdirs()
		File(wsHashDir, "workspace.json").writeText("""{"folder": "$folderUri"}""")
	}

	/**
	 * Builds a `file:///...` URI matching what VS Code/Cursor actually writes in
	 * workspace.json. [File.toURI] returns `file:/path` (single slash, no authority)
	 * which doesn't match the `file://` prefix check in production code.
	 */
	private fun fileUri(f: File): String {
		val abs = f.absolutePath.replace('\\', '/')
		return if (abs.startsWith("/")) "file://$abs" else "file:///$abs"
	}

	@Nested
	inner class PathResolution {

		@Test
		fun `getVscodeUserDataDir returns flavor-specific path`(@TempDir tempHome: File) {
			useHome(tempHome)
			val cursorDir = getVscodeUserDataDir(VscodeFlavor.Cursor)
			val codeDir = getVscodeUserDataDir(VscodeFlavor.Code)
			(cursorDir != codeDir) shouldBe true
			cursorDir.endsWith("Cursor") shouldBe true
			codeDir.endsWith("Code") shouldBe true
		}

		@Test
		fun `getVscodeWorkspaceStorageDir appends User-workspaceStorage`() {
			val storage = getVscodeWorkspaceStorageDir(VscodeFlavor.Code)
			storage.endsWith("User${File.separator}workspaceStorage") shouldBe true
		}
	}

	@Nested
	inner class NormalizePathForMatch {

		@Test
		fun `converts backslashes to forward slashes`() {
			normalizePathForMatch("C:\\Users\\me\\proj").contains("\\") shouldBe false
		}

		@Test
		fun `strips trailing slashes`() {
			val osName = System.getProperty("os.name").lowercase()
			val expected = if (osName.contains("mac") || osName.contains("win")) "/foo/bar" else "/foo/bar"
			normalizePathForMatch("/foo/bar///") shouldBe expected
		}

		@Test
		fun `lowercases on case-insensitive platforms`() {
			val osName = System.getProperty("os.name").lowercase()
			val result = normalizePathForMatch("/Foo/BAR")
			if (osName.contains("mac") || osName.contains("win")) {
				result shouldBe "/foo/bar"
			} else {
				result shouldBe "/Foo/BAR"
			}
		}
	}

	@Nested
	inner class FindVscodeWorkspaceHash {

		@Test
		fun `returns null when workspaceStorage doesn't exist`(@TempDir tempHome: File) {
			useHome(tempHome)
			findVscodeWorkspaceHash(VscodeFlavor.Code, tempHome.absolutePath).shouldBeNull()
		}

		@Test
		fun `returns the hash whose workspace_json folder matches projectDir`(@TempDir tempHome: File, @TempDir projectDir: File) {
			useHome(tempHome)
			val ws = setupWorkspaceStorage(tempHome, VscodeFlavor.Code)
			val hashDir = File(ws, "abc123")
			val folderUri = fileUri(projectDir) // file:/...
			writeWorkspaceJson(hashDir, folderUri)

			val result = findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath)
			result.shouldNotBeNull()
			result shouldBe "abc123"
		}

		@Test
		fun `skips entries whose folder URI doesn't match`(@TempDir tempHome: File, @TempDir projectDir: File, @TempDir otherDir: File) {
			useHome(tempHome)
			val ws = setupWorkspaceStorage(tempHome, VscodeFlavor.Code)
			writeWorkspaceJson(File(ws, "wrong"), fileUri(otherDir))
			writeWorkspaceJson(File(ws, "right"), fileUri(projectDir))
			findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath) shouldBe "right"
		}

		@Test
		fun `skips workspace_json with missing folder field`(@TempDir tempHome: File, @TempDir projectDir: File) {
			useHome(tempHome)
			val ws = setupWorkspaceStorage(tempHome, VscodeFlavor.Code)
			val badDir = File(ws, "bad").also { it.mkdirs() }
			File(badDir, "workspace.json").writeText("""{"notFolder": "x"}""")
			findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath).shouldBeNull()
		}

		@Test
		fun `skips workspace_json with non-file URI`(@TempDir tempHome: File, @TempDir projectDir: File) {
			useHome(tempHome)
			val ws = setupWorkspaceStorage(tempHome, VscodeFlavor.Code)
			writeWorkspaceJson(File(ws, "remote"), "vscode-remote://ssh-host/foo")
			findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath).shouldBeNull()
		}

		@Test
		fun `Cursor and Code flavors search different roots`(@TempDir tempHome: File, @TempDir projectDir: File) {
			useHome(tempHome)
			val cursorWs = setupWorkspaceStorage(tempHome, VscodeFlavor.Cursor)
			writeWorkspaceJson(File(cursorWs, "cursor-only"), fileUri(projectDir))
			// VS Code workspaceStorage left empty
			setupWorkspaceStorage(tempHome, VscodeFlavor.Code)

			findVscodeWorkspaceHash(VscodeFlavor.Cursor, projectDir.absolutePath) shouldBe "cursor-only"
			findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath).shouldBeNull()
		}
	}
}
