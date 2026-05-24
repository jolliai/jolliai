package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.sql.DriverManager
import java.time.Instant

class CursorSupportTest {

    private var originalHome: String? = null
    private var originalCursorOverride: String? = null

    @BeforeEach
    fun setup() {
        originalHome = System.getProperty("user.home")
        originalCursorOverride = System.getProperty("cursor.appdata.override")
    }

    @AfterEach
    fun teardown() {
        originalHome?.let { System.setProperty("user.home", it) }
        // On Windows the production code reads %APPDATA% (env var); we redirect it via the
        // `cursor.appdata.override` system property in helpers below. Clear it between tests.
        if (originalCursorOverride != null) {
            System.setProperty("cursor.appdata.override", originalCursorOverride!!)
        } else {
            System.clearProperty("cursor.appdata.override")
        }
    }

    /** Returns the platform-correct Cursor user-data dir under the given home. */
    private fun cursorUserDataDir(home: File): File {
        val osName = System.getProperty("os.name").lowercase()
        return when {
            osName.contains("mac") -> File(home, "Library/Application Support/Cursor")
            osName.contains("win") -> {
                // On Windows the production code uses %APPDATA% (env var) which we cannot unset
                // from Java; redirect it via the `cursor.appdata.override` system property hook.
                System.setProperty("cursor.appdata.override", File(home, "AppData/Roaming").absolutePath)
                File(home, "AppData/Roaming/Cursor")
            }
            else -> File(home, ".config/Cursor")
        }
    }

    /** Creates the Cursor user-data dir layout under `home` and returns the workspaceStorage subdir. */
    private fun setupCursorHome(home: File): File {
        val wsStorage = File(cursorUserDataDir(home), "User/workspaceStorage")
        wsStorage.mkdirs()
        return wsStorage
    }

    /** Path where CursorSupport.getGlobalDbPath() will look. */
    private fun globalDbFile(home: File): File =
        File(cursorUserDataDir(home), "User/globalStorage/state.vscdb").also { it.parentFile.mkdirs() }

    /** Creates a per-workspace state.vscdb with an ItemTable row for composer.composerData. */
    private fun createWorkspaceDb(
        path: File,
        folderUri: String,
        lastFocused: List<String> = emptyList(),
        selected: List<String> = emptyList(),
    ) {
        path.parentFile.mkdirs()
        // workspace.json next to the DB
        File(path.parentFile, "workspace.json").writeText("""{"folder": "$folderUri"}""")

        DriverManager.getConnection("jdbc:sqlite:${path.absolutePath}").use { conn ->
            conn.createStatement().use { st ->
                st.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            }
            val composerData = """{"lastFocusedComposerIds":${lastFocused.toJsonStringArray()},"selectedComposerIds":${selected.toJsonStringArray()}}"""
            conn.prepareStatement("INSERT INTO ItemTable(key, value) VALUES (?, ?)").use { ps ->
                ps.setString(1, "composer.composerData")
                ps.setString(2, composerData)
                ps.executeUpdate()
            }
        }
    }

    /** Creates a global state.vscdb with a cursorDiskKV table; rows are passed as (key, value). */
    private fun createGlobalDb(path: File, rows: List<Pair<String, String>>) {
        path.parentFile.mkdirs()
        DriverManager.getConnection("jdbc:sqlite:${path.absolutePath}").use { conn ->
            conn.createStatement().use { st ->
                st.execute("CREATE TABLE cursorDiskKV ([key] TEXT PRIMARY KEY, value TEXT)")
            }
            conn.prepareStatement("INSERT INTO cursorDiskKV([key], value) VALUES (?, ?)").use { ps ->
                for ((k, v) in rows) {
                    ps.setString(1, k)
                    ps.setString(2, v)
                    ps.executeUpdate()
                }
            }
        }
    }

    private fun composerData(id: String, lastUpdatedAt: Long, headers: List<Pair<String, Int>> = emptyList()): String {
        val headersJson = headers.joinToString(",") { (bid, type) -> """{"bubbleId":"$bid","type":$type}""" }
        return """{"composerId":"$id","lastUpdatedAt":$lastUpdatedAt,"fullConversationHeadersOnly":[$headersJson]}"""
    }

    private fun bubbleData(type: Int?, text: String?, createdAt: String? = null): String {
        val parts = mutableListOf<String>()
        if (type != null) parts.add("\"type\":$type")
        if (text != null) parts.add("\"text\":${jsonString(text)}")
        if (createdAt != null) parts.add("\"createdAt\":\"$createdAt\"")
        return "{${parts.joinToString(",")}}"
    }

    private fun jsonString(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    private fun List<String>.toJsonStringArray() = joinToString(prefix = "[", postfix = "]") { jsonString(it) }

    private fun fileUri(f: File): String {
        // Use absolutePath (not canonicalPath) so the URI matches what callers pass to
        // discoverSessions; canonicalPath would resolve macOS's /var → /private/var
        // symlink and mismatch.
        //
        // Build the URI manually (not via File.toURI()) so we control the exact form:
        // unix → "file:///abs/path", windows → "file:///C:/abs/path". Real Cursor writes
        // its workspace.json URIs in this same form on every platform.
        val abs = f.absolutePath.replace('\\', '/')
        return if (abs.startsWith("/")) "file://$abs" else "file:///$abs"
    }

    @Nested
    inner class IsCursorInstalled {
        @Test
        fun `false when global DB does not exist`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            // On Windows the production resolver uses %APPDATA% (which points at a real path
            // on dev machines that may have Cursor installed). Redirect via the override so
            // the resolver lands in the empty tempDir.
            System.setProperty("cursor.appdata.override", File(tempDir, "AppData/Roaming").absolutePath)
            CursorSupport.isCursorInstalled() shouldBe false
        }

        @Test
        fun `true when global DB exists`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val db = globalDbFile(tempDir)
            createGlobalDb(db, emptyList())
            CursorSupport.isCursorInstalled() shouldBe true
        }
    }

    @Nested
    inner class DiscoverSessions {

        @Test
        fun `no matching workspace returns empty`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val projectDir = File(tempDir, "my-project").also { it.mkdirs() }
            val otherProject = File(tempDir, "other-project").also { it.mkdirs() }
            val wsStorage = setupCursorHome(tempDir)
            createWorkspaceDb(File(wsStorage, "abc/state.vscdb"), fileUri(otherProject))
            createGlobalDb(globalDbFile(tempDir), listOf(
                "composerData:c1" to composerData("c1", System.currentTimeMillis())
            ))

            val result = CursorSupport.discoverSessions(projectDir.absolutePath)
            result.sessions.shouldBeEmpty()
            result.error.shouldBeNull()
        }

        @Test
        fun `anchor composer older than 48h is excluded`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val projectDir = File(tempDir, "my-project").also { it.mkdirs() }
            val wsStorage = setupCursorHome(tempDir)
            createWorkspaceDb(File(wsStorage, "ws1/state.vscdb"), fileUri(projectDir),
                lastFocused = listOf("ancient-composer"))
            val ancientTime = System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000  // 30 days ago
            createGlobalDb(globalDbFile(tempDir), listOf(
                "composerData:ancient-composer" to composerData("ancient-composer", ancientTime),
            ))

            val result = CursorSupport.discoverSessions(projectDir.absolutePath)
            result.error.shouldBeNull()
            result.sessions.shouldBeEmpty()
        }

        @Test
        fun `anchor-only filtering with staleness cutoff and dedupe`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val projectDir = File(tempDir, "my-project").also { it.mkdirs() }
            val wsStorage = setupCursorHome(tempDir)
            createWorkspaceDb(File(wsStorage, "ws1/state.vscdb"), fileUri(projectDir),
                lastFocused = listOf("focused", "both", "anchorStale"),
                selected = listOf("selected", "both"))  // "both" overlaps lastFocused
            val now = System.currentTimeMillis()
            val recent = now - 1000
            val ancient = now - 30L * 24 * 60 * 60 * 1000
            createGlobalDb(globalDbFile(tempDir), listOf(
                "composerData:focused" to composerData("focused", recent),        // anchor + recent
                "composerData:selected" to composerData("selected", recent),      // anchor + recent
                "composerData:both" to composerData("both", recent),              // anchor + recent (deduped)
                "composerData:fresh" to composerData("fresh", recent),            // recent but not anchored — excluded
                "composerData:stale" to composerData("stale", ancient),           // neither — excluded
                "composerData:anchorStale" to composerData("anchorStale", ancient), // anchored but stale — excluded
            ))

            val result = CursorSupport.discoverSessions(projectDir.absolutePath)
            result.error.shouldBeNull()
            // Only anchored + recent sessions returned; unanchored "fresh" must NOT leak in
            result.sessions.map { it.sessionId } shouldContainExactlyInAnyOrder
                listOf("focused", "selected", "both")
        }

        @Test
        fun `corrupt global DB returns ScanResult with corrupt error`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val projectDir = File(tempDir, "my-project").also { it.mkdirs() }
            val wsStorage = setupCursorHome(tempDir)
            createWorkspaceDb(File(wsStorage, "ws1/state.vscdb"), fileUri(projectDir))
            // Write garbage to the global DB — fails SQLite header check
            val globalDb = globalDbFile(tempDir)
            globalDb.writeBytes(ByteArray(64) { 0xFF.toByte() })

            val result = CursorSupport.discoverSessions(projectDir.absolutePath)
            result.sessions.shouldBeEmpty()
            result.error.shouldNotBeNull()
            // Either corrupt (clean SQLite check) or unknown (depending on how JDBC reports it)
            result.error!!.kind shouldBeOneOf listOf(SqliteScanErrorKind.corrupt, SqliteScanErrorKind.unknown)
        }

        @Test
        fun `malformed composer row is silently skipped`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val projectDir = File(tempDir, "my-project").also { it.mkdirs() }
            val wsStorage = setupCursorHome(tempDir)
            createWorkspaceDb(File(wsStorage, "ws1/state.vscdb"), fileUri(projectDir),
                lastFocused = listOf("good"))
            val now = System.currentTimeMillis()
            createGlobalDb(globalDbFile(tempDir), listOf(
                "composerData:bad-json" to "{not valid json",
                "composerData:good" to composerData("good", now - 1000),
            ))

            val result = CursorSupport.discoverSessions(projectDir.absolutePath)
            result.error.shouldBeNull()
            result.sessions.map { it.sessionId } shouldContainExactly listOf("good")
        }

        @Test
        fun `composer with missing composerId is skipped`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val projectDir = File(tempDir, "my-project").also { it.mkdirs() }
            val wsStorage = setupCursorHome(tempDir)
            createWorkspaceDb(File(wsStorage, "ws1/state.vscdb"), fileUri(projectDir),
                lastFocused = listOf("ok"))
            val now = System.currentTimeMillis()
            createGlobalDb(globalDbFile(tempDir), listOf(
                "composerData:no-id" to """{"lastUpdatedAt":$now}""",
                "composerData:ok" to composerData("ok", now - 1000),
            ))

            val result = CursorSupport.discoverSessions(projectDir.absolutePath)
            result.error.shouldBeNull()
            result.sessions.map { it.sessionId } shouldContainExactly listOf("ok")
        }

        @Test
        fun `composer with non-finite lastUpdatedAt is skipped`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val projectDir = File(tempDir, "my-project").also { it.mkdirs() }
            val wsStorage = setupCursorHome(tempDir)
            createWorkspaceDb(File(wsStorage, "ws1/state.vscdb"), fileUri(projectDir),
                lastFocused = listOf("weird", "good"))
            val now = System.currentTimeMillis()
            createGlobalDb(globalDbFile(tempDir), listOf(
                "composerData:weird" to """{"composerId":"weird","lastUpdatedAt":"not-a-number"}""",
                "composerData:good" to composerData("good", now - 1000),
            ))

            val result = CursorSupport.discoverSessions(projectDir.absolutePath)
            result.error.shouldBeNull()
            result.sessions.map { it.sessionId } shouldContainExactly listOf("good")
        }

        @Test
        fun `synthetic transcript path encodes composer id`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val projectDir = File(tempDir, "my-project").also { it.mkdirs() }
            val wsStorage = setupCursorHome(tempDir)
            createWorkspaceDb(File(wsStorage, "ws1/state.vscdb"), fileUri(projectDir),
                lastFocused = listOf("my-composer"))
            createGlobalDb(globalDbFile(tempDir), listOf(
                "composerData:my-composer" to composerData("my-composer", System.currentTimeMillis())
            ))

            val result = CursorSupport.discoverSessions(projectDir.absolutePath)
            val s = result.sessions.single()
            s.transcriptPath.endsWith("#my-composer") shouldBe true
            s.source shouldBe TranscriptSource.cursor
        }
    }

    @Nested
    inner class ReadTranscript {

        @Test
        fun `parses bubbles and maps type to role`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val db = globalDbFile(tempDir)
            createGlobalDb(db, listOf(
                "composerData:c1" to composerData("c1", 1_700_000_000_000L, listOf("b1" to 1, "b2" to 2)),
                "bubbleId:c1:b1" to bubbleData(type = 1, text = "Hello"),
                "bubbleId:c1:b2" to bubbleData(type = 2, text = "Hi there"),
            ))

            val result = CursorSupport.readTranscript("${db.absolutePath}#c1", cursor = null)
            result.entries shouldHaveSize 2
            result.entries[0].role shouldBe "human"
            result.entries[0].content shouldBe "Hello"
            result.entries[1].role shouldBe "assistant"
            result.entries[1].content shouldBe "Hi there"
        }

        @Test
        fun `consecutive same-role entries are merged`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val db = globalDbFile(tempDir)
            createGlobalDb(db, listOf(
                "composerData:c1" to composerData("c1", 1_700_000_000_000L, listOf("b1" to 1, "b2" to 1, "b3" to 2)),
                "bubbleId:c1:b1" to bubbleData(1, "first"),
                "bubbleId:c1:b2" to bubbleData(1, "second"),
                "bubbleId:c1:b3" to bubbleData(2, "reply"),
            ))

            val result = CursorSupport.readTranscript("${db.absolutePath}#c1", cursor = null)
            result.entries shouldHaveSize 2
            result.entries[0].role shouldBe "human"
            result.entries[1].role shouldBe "assistant"
        }

        @Test
        fun `empty-text bubble is skipped`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val db = globalDbFile(tempDir)
            createGlobalDb(db, listOf(
                "composerData:c1" to composerData("c1", 1_700_000_000_000L, listOf("b1" to 1, "b2" to 2)),
                "bubbleId:c1:b1" to bubbleData(1, "  "),  // whitespace only
                "bubbleId:c1:b2" to bubbleData(2, "kept"),
            ))

            val result = CursorSupport.readTranscript("${db.absolutePath}#c1", cursor = null)
            result.entries shouldHaveSize 1
            result.entries[0].content shouldBe "kept"
        }

        @Test
        fun `missing bubble row advances index without producing entry`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val db = globalDbFile(tempDir)
            createGlobalDb(db, listOf(
                "composerData:c1" to composerData("c1", 1_700_000_000_000L, listOf("missing" to 1, "present" to 2)),
                "bubbleId:c1:present" to bubbleData(2, "kept"),
            ))

            val result = CursorSupport.readTranscript("${db.absolutePath}#c1", cursor = null)
            result.entries shouldHaveSize 1
            result.entries[0].content shouldBe "kept"
            result.newCursor.lineNumber shouldBe 2  // both indices consumed
        }

        @Test
        fun `malformed bubble JSON is skipped`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val db = globalDbFile(tempDir)
            createGlobalDb(db, listOf(
                "composerData:c1" to composerData("c1", 1_700_000_000_000L, listOf("bad" to 1, "good" to 2)),
                "bubbleId:c1:bad" to "{not valid",
                "bubbleId:c1:good" to bubbleData(2, "ok"),
            ))

            val result = CursorSupport.readTranscript("${db.absolutePath}#c1", cursor = null)
            result.entries shouldHaveSize 1
            result.entries[0].content shouldBe "ok"
        }

        @Test
        fun `cursor-based incremental read skips already-processed bubbles`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val db = globalDbFile(tempDir)
            createGlobalDb(db, listOf(
                "composerData:c1" to composerData("c1", 1_700_000_000_000L, listOf("b1" to 1, "b2" to 2, "b3" to 1)),
                "bubbleId:c1:b1" to bubbleData(1, "skipped"),
                "bubbleId:c1:b2" to bubbleData(2, "skipped-too"),
                "bubbleId:c1:b3" to bubbleData(1, "fresh"),
            ))

            val priorCursor = TranscriptCursor("${db.absolutePath}#c1", 2, Instant.now().toString())
            val result = CursorSupport.readTranscript("${db.absolutePath}#c1", cursor = priorCursor)
            result.entries.map { it.content } shouldContainExactly listOf("fresh")
        }

        @Test
        fun `unknown bubble type is skipped`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val db = globalDbFile(tempDir)
            createGlobalDb(db, listOf(
                "composerData:c1" to composerData("c1", 1_700_000_000_000L, listOf("b1" to 99, "b2" to 1)),
                "bubbleId:c1:b1" to bubbleData(99, "system msg"),
                "bubbleId:c1:b2" to bubbleData(1, "user msg"),
            ))

            val result = CursorSupport.readTranscript("${db.absolutePath}#c1", cursor = null)
            result.entries.map { it.content } shouldContainExactly listOf("user msg")
        }

        @Test
        fun `composer not found throws`(@TempDir tempDir: File) {
            System.setProperty("user.home", tempDir.absolutePath)
            val db = globalDbFile(tempDir)
            createGlobalDb(db, emptyList())

            try {
                CursorSupport.readTranscript("${db.absolutePath}#missing-id", cursor = null)
                throw AssertionError("expected RuntimeException")
            } catch (_: RuntimeException) {
                // ok
            }
        }
    }
}

/** Kotest-style helper not in our project's matcher set — provides "shouldBeOneOf". */
private infix fun <T> T.shouldBeOneOf(options: Collection<T>) {
    if (this !in options) throw AssertionError("expected $this to be one of $options")
}
