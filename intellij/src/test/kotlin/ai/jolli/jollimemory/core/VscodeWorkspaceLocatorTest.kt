package ai.jolli.jollimemory.core

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class VscodeWorkspaceLocatorTest {

	/**
	 * Env pinned to macOS so the on-disk layout the helpers below create is
	 * deterministic on any host. Platform-branch coverage lives in
	 * [PathResolution.getVscodeUserDataDir resolves each platform branch].
	 */
	private fun macEnv(home: File): HookEnv = fakeHookEnv(userHome = home, osName = "Mac OS X")

	/** The macOS user-data dir for a flavor under the given home. */
	private fun userDataDir(home: File, dirName: String): File =
		File(home, "Library/Application Support/$dirName")

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
			val env = macEnv(tempHome)
			val cursorDir = getVscodeUserDataDir(VscodeFlavor.Cursor, env)
			val codeDir = getVscodeUserDataDir(VscodeFlavor.Code, env)
			(cursorDir != codeDir) shouldBe true
			cursorDir.endsWith("Cursor") shouldBe true
			codeDir.endsWith("Code") shouldBe true
		}

		@Test
		fun `getVscodeUserDataDir resolves each platform branch`(@TempDir tempHome: File) {
			val sep = File.separator
			val home = tempHome.path

			val mac = getVscodeUserDataDir(VscodeFlavor.Code, fakeHookEnv(userHome = tempHome, osName = "Mac OS X"))
			mac shouldBe "$home${sep}Library${sep}Application Support${sep}Code"

			val linux = getVscodeUserDataDir(VscodeFlavor.Code, fakeHookEnv(userHome = tempHome, osName = "Linux"))
			linux shouldBe "$home$sep.config${sep}Code"

			val winWithAppData = getVscodeUserDataDir(
				VscodeFlavor.Code,
				fakeHookEnv(userHome = tempHome, osName = "Windows 11", env = mapOf("APPDATA" to "$home${sep}Roaming")),
			)
			winWithAppData shouldBe "$home${sep}Roaming${sep}Code"

			val winFallback = getVscodeUserDataDir(VscodeFlavor.Code, fakeHookEnv(userHome = tempHome, osName = "Windows 11"))
			winFallback shouldBe "$home${sep}AppData${sep}Roaming${sep}Code"
		}

		@Test
		fun `getVscodeWorkspaceStorageDir appends User-workspaceStorage`(@TempDir tempHome: File) {
			val storage = getVscodeWorkspaceStorageDir(VscodeFlavor.Code, macEnv(tempHome))
			storage.endsWith("User${File.separator}workspaceStorage") shouldBe true
		}
	}

	@Nested
	inner class NormalizePathForMatch {

		@Test
		fun `converts backslashes to forward slashes`(@TempDir tempHome: File) {
			normalizePathForMatch("C:\\Users\\me\\proj", macEnv(tempHome)).contains("\\") shouldBe false
		}

		@Test
		fun `strips trailing slashes`(@TempDir tempHome: File) {
			normalizePathForMatch("/foo/bar///", macEnv(tempHome)) shouldBe "/foo/bar"
		}

		@Test
		fun `lowercases on case-insensitive platforms only`(@TempDir tempHome: File) {
			normalizePathForMatch("/Foo/BAR", fakeHookEnv(userHome = tempHome, osName = "Mac OS X")) shouldBe "/foo/bar"
			normalizePathForMatch("/Foo/BAR", fakeHookEnv(userHome = tempHome, osName = "Windows 11")) shouldBe "/foo/bar"
			normalizePathForMatch("/Foo/BAR", fakeHookEnv(userHome = tempHome, osName = "Linux")) shouldBe "/Foo/BAR"
		}
	}

	@Nested
	inner class FindVscodeWorkspaceHash {

		@Test
		fun `returns null when workspaceStorage doesn't exist`(@TempDir tempHome: File) {
			findVscodeWorkspaceHash(VscodeFlavor.Code, tempHome.absolutePath, macEnv(tempHome)).shouldBeNull()
		}

		@Test
		fun `returns the hash whose workspace_json folder matches projectDir`(@TempDir tempHome: File, @TempDir projectDir: File) {
			val ws = setupWorkspaceStorage(tempHome, VscodeFlavor.Code)
			val hashDir = File(ws, "abc123")
			val folderUri = fileUri(projectDir) // file:/...
			writeWorkspaceJson(hashDir, folderUri)

			val result = findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath, macEnv(tempHome))
			result.shouldNotBeNull()
			result shouldBe "abc123"
		}

		@Test
		fun `skips entries whose folder URI doesn't match`(@TempDir tempHome: File, @TempDir projectDir: File, @TempDir otherDir: File) {
			val ws = setupWorkspaceStorage(tempHome, VscodeFlavor.Code)
			writeWorkspaceJson(File(ws, "wrong"), fileUri(otherDir))
			writeWorkspaceJson(File(ws, "right"), fileUri(projectDir))
			findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath, macEnv(tempHome)) shouldBe "right"
		}

		@Test
		fun `skips workspace_json with missing folder field`(@TempDir tempHome: File, @TempDir projectDir: File) {
			val ws = setupWorkspaceStorage(tempHome, VscodeFlavor.Code)
			val badDir = File(ws, "bad").also { it.mkdirs() }
			File(badDir, "workspace.json").writeText("""{"notFolder": "x"}""")
			findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath, macEnv(tempHome)).shouldBeNull()
		}

		@Test
		fun `skips workspace_json with non-file URI`(@TempDir tempHome: File, @TempDir projectDir: File) {
			val ws = setupWorkspaceStorage(tempHome, VscodeFlavor.Code)
			writeWorkspaceJson(File(ws, "remote"), "vscode-remote://ssh-host/foo")
			findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath, macEnv(tempHome)).shouldBeNull()
		}

		@Test
		fun `Cursor and Code flavors search different roots`(@TempDir tempHome: File, @TempDir projectDir: File) {
			val cursorWs = setupWorkspaceStorage(tempHome, VscodeFlavor.Cursor)
			writeWorkspaceJson(File(cursorWs, "cursor-only"), fileUri(projectDir))
			// VS Code workspaceStorage left empty
			setupWorkspaceStorage(tempHome, VscodeFlavor.Code)

			findVscodeWorkspaceHash(VscodeFlavor.Cursor, projectDir.absolutePath, macEnv(tempHome)) shouldBe "cursor-only"
			findVscodeWorkspaceHash(VscodeFlavor.Code, projectDir.absolutePath, macEnv(tempHome)).shouldBeNull()
		}
	}
}
