package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.references.SourceId
import ai.jolli.jollimemory.core.references.SourceIds
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Path

/**
 * Locks down the schema the CLI's `FolderStorage.ts` and this Kotlin reader
 * MUST agree on. See AGENTS.md "Critical rules" — this pair is lockstep.
 */
class FolderStorageReaderTest {

    @TempDir lateinit var tmp: Path

    private fun writeFile(rel: String, content: String) {
        val f = File(tmp.toFile(), rel)
        f.parentFile.mkdirs()
        f.writeText(content, Charsets.UTF_8)
    }

    @Test
    fun `forRoot returns null when kbRoot is missing`() {
        FolderStorageReader.forRoot(null).shouldBeNull()
        FolderStorageReader.forRoot("").shouldBeNull()
        FolderStorageReader.forRoot(File(tmp.toFile(), "does/not/exist").absolutePath).shouldBeNull()
    }

    @Test
    fun `forRoot returns null when hidden summaries dir is missing`() {
        // Root exists but has no .jolli/summaries — folder is not populated yet.
        FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldBeNull()
    }

    @Test
    fun `getSummary reads canonical JSON at dot-jolli slash summaries slash hash dot json`() {
        val hash = "0123456789abcdef0123456789abcdef01234567"
        writeFile(
            ".jolli/summaries/$hash.json",
            """
                {
                  "version": 3,
                  "commitHash": "$hash",
                  "commitMessage": "test commit",
                  "commitAuthor": "Test",
                  "commitDate": "2026-01-01T00:00:00Z",
                  "branch": "main",
                  "generatedAt": "2026-01-01T00:00:00Z"
                }
            """.trimIndent(),
        )
        val reader = FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldNotBeNull()

        val summary = reader.getSummary(hash).shouldNotBeNull()
        summary.commitHash shouldBe hash
        summary.commitMessage shouldBe "test commit"
        summary.branch shouldBe "main"
        summary.version shouldBe 3

        // Raw-JSON path returns the exact bytes without a Gson round-trip.
        val raw = reader.getSummaryJson(hash).shouldNotBeNull()
        raw shouldBe File(tmp.toFile(), ".jolli/summaries/$hash.json").readText(Charsets.UTF_8)
    }

    @Test
    fun `getSummary returns null on unknown hash and on malformed JSON`() {
        val goodHash = "1111111111111111111111111111111111111111"
        val badHash = "2222222222222222222222222222222222222222"
        writeFile(
            ".jolli/summaries/$goodHash.json",
            """{"version":3,"commitHash":"$goodHash","commitMessage":"ok","commitAuthor":"a","commitDate":"d","branch":"b","generatedAt":"g"}""",
        )
        writeFile(".jolli/summaries/$badHash.json", "{not json")
        val reader = FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldNotBeNull()

        reader.getSummary("deadbeef").shouldBeNull()
        reader.getSummary(badHash).shouldBeNull()          // parse failure → null (fail-soft)
        reader.getSummary(goodHash).shouldNotBeNull()      // sanity check
    }

    @Test
    fun `readPlanBody reads dot-jolli slash plans slash slug dot md and readNoteBody reads notes slash id dot md`() {
        // At least one summary file so forRoot returns non-null (isReady gate).
        writeFile(".jolli/summaries/dummy.json", "{}")
        writeFile(".jolli/plans/my-plan.md", "# Plan body\n")
        writeFile(".jolli/notes/n42.md", "note body\n")
        val reader = FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldNotBeNull()

        reader.readPlanBody("my-plan") shouldBe "# Plan body\n"
        reader.readNoteBody("n42") shouldBe "note body\n"
        reader.readPlanBody("missing").shouldBeNull()
        reader.readNoteBody("missing").shouldBeNull()
    }

    @Test
    fun `forRoot returns null when storageMode is orphan even if summaries dir exists`() {
        // A repo can toggle to storageMode="orphan" via `jolli configure --set`;
        // subsequent writes bypass the folder, but the previous dual-write session's
        // JSON is still on disk. Serving it would silently shadow fresh orphan-branch
        // data on amend/squash — the reader must decline and let callers fall back.
        val hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        writeFile(
            ".jolli/summaries/$hash.json",
            """{"version":3,"commitHash":"$hash","commitMessage":"m","commitAuthor":"a","commitDate":"d","branch":"b","generatedAt":"g"}""",
        )
        FolderStorageReader.forRoot(tmp.toFile().absolutePath, storageMode = "orphan").shouldBeNull()

        // Every other value (unset, "dual-write", "folder") returns a live reader.
        FolderStorageReader.forRoot(tmp.toFile().absolutePath, storageMode = null).shouldNotBeNull()
        FolderStorageReader.forRoot(tmp.toFile().absolutePath, storageMode = "dual-write").shouldNotBeNull()
        FolderStorageReader.forRoot(tmp.toFile().absolutePath, storageMode = "folder").shouldNotBeNull()
    }

    @Test
    fun `getSummary rejects JSON that Gson would parse without a real commitHash`() {
        // Gson bypasses the primary constructor via reflection: `{}` yields a
        // CommitSummary whose non-null Kotlin fields (commitHash, commitMessage,
        // …) are actually null at runtime. The reader must not treat that as a
        // success — the fail-soft comment promises a fall-through, and callers
        // rely on it to reach the orphan-branch path.
        val hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        writeFile(".jolli/summaries/$hash.json", "{}")
        // Second entry with an explicit empty commitHash is the same failure mode
        // one JSON transformation upstream — must also be rejected.
        val hash2 = "cccccccccccccccccccccccccccccccccccccccc"
        writeFile(".jolli/summaries/$hash2.json", """{"commitHash":""}""")
        val reader = FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldNotBeNull()

        reader.getSummary(hash).shouldBeNull()
        reader.getSummary(hash2).shouldBeNull()
    }

    @Test
    fun `readReferenceBody reads path-safe sources at the identity stem`() {
        // Sources declared `nativeIdPathSafe: true` in the CLI (linear here).
        // The archive stem IS the bareKey, so the reader must interpolate directly.
        writeFile(".jolli/summaries/dummy.json", "{}")
        writeFile(".jolli/references/linear/PROJ-42-abc12345.md", "linear body")
        val reader = FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldNotBeNull()

        reader.readReferenceBody(SourceId.linear, "linear:PROJ-42-abc12345") shouldBe "linear body"
        reader.readReferenceBody(SourceId.linear, "linear:missing").shouldBeNull()
    }

    @Test
    fun `readReferenceBody sanitizes GitHub bareKey and reads at the sanitized stem`() {
        // GitHub archivedKey is `github:<owner>/<repo>#<n>-<shortHash>`. The CLI's
        // orphanPathFor folds `/` and `#` to `-` and appends an 8-hex sha256 tail
        // over the RAW bareKey; the reader MUST do the same or it will point at
        // `references/github/owner/repo#n-…md` (nested subdirectory, wrong stem).
        // Regression guard for the bug fixed alongside this test.
        writeFile(".jolli/summaries/dummy.json", "{}")
        val archivedKey = "github:owner/repo#42-abc12345"
        val bareKey = "owner/repo#42-abc12345"
        val stem = SourceIds.pathKey(SourceId.github, bareKey)
        // Sanity: the stem must not contain path separators anymore.
        (stem.contains("/") || stem.contains("#")) shouldBe false
        writeFile(".jolli/references/github/$stem.md", "github body")
        val reader = FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldNotBeNull()

        reader.readReferenceBody(SourceId.github, archivedKey) shouldBe "github body"

        // A file at the raw (un-sanitized) path is NOT what the CLI writes and
        // must NOT be read either — the previous reader accidentally accepted it
        // for path-safe sources but never for GitHub (the `/` would nest a
        // subdirectory). Explicit assertion so a future refactor doesn't
        // regress this.
        reader.readReferenceBody(SourceId.github, "github:different/repo#42-abc12345").shouldBeNull()
    }

    @Test
    fun `readReferenceBody sanitizes Context7 bareKey and reads at the sanitized stem`() {
        // Context7 nativeIds are shaped `/org/project` (optionally `/org/project/version`),
        // so the bareKey legitimately starts with `/` — the same sanitize rule as GitHub
        // (`nativeIdPathSafe: false`) applies here. Missing this in the reader made
        // every Context7 reference unreadable.
        writeFile(".jolli/summaries/dummy.json", "{}")
        val archivedKey = "context7:/org/project-abc12345"
        val bareKey = "/org/project-abc12345"
        val stem = SourceIds.pathKey(SourceId.context7, bareKey)
        stem.contains("/") shouldBe false
        writeFile(".jolli/references/context7/$stem.md", "context7 body")
        val reader = FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldNotBeNull()

        reader.readReferenceBody(SourceId.context7, archivedKey) shouldBe "context7 body"
    }

    @Test
    fun `readReferenceBody short-circuits when the folder is dirty`() {
        // Same dirty-marker gate as the other read methods — a shadow-write
        // failure must not serve stale reference bodies.
        writeFile(".jolli/summaries/dummy.json", "{}")
        writeFile(".jolli/references/linear/PROJ-1-abc12345.md", "body")
        writeFile(".jolli/shadow-status.json", """{"dirty":true,"lastFailedAt":"2026-01-01T00:00:00Z"}""")
        val reader = FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldNotBeNull()

        reader.readReferenceBody(SourceId.linear, "linear:PROJ-1-abc12345").shouldBeNull()
    }

    @Test
    fun `read methods short-circuit to null when shadow-status marks the folder dirty`() {
        // DualWriteStorage writes .jolli/shadow-status.json when a folder write
        // failed and the orphan branch is now ahead. This reader must fall back
        // to the branch until the marker clears (mirrors the "system of record"
        // contract documented on FolderStorage.markDirty / isDirty).
        val hash = "3333333333333333333333333333333333333333"
        writeFile(
            ".jolli/summaries/$hash.json",
            """{"version":3,"commitHash":"$hash","commitMessage":"m","commitAuthor":"a","commitDate":"d","branch":"b","generatedAt":"g"}""",
        )
        writeFile(".jolli/plans/plan1.md", "plan body")
        writeFile(".jolli/notes/note1.md", "note body")
        writeFile(".jolli/shadow-status.json", """{"dirty":true,"lastFailedAt":"2026-01-01T00:00:00Z","message":"test"}""")
        val reader = FolderStorageReader.forRoot(tmp.toFile().absolutePath).shouldNotBeNull()

        reader.isDirty() shouldBe true
        reader.getSummary(hash).shouldBeNull()
        reader.getSummaryJson(hash).shouldBeNull()
        reader.readPlanBody("plan1").shouldBeNull()
        reader.readNoteBody("note1").shouldBeNull()

        // Remove the marker and the reader wakes back up.
        File(tmp.toFile(), ".jolli/shadow-status.json").delete() shouldBe true
        reader.isDirty() shouldBe false
        reader.getSummary(hash).shouldNotBeNull()
        reader.readPlanBody("plan1") shouldBe "plan body"
        reader.readNoteBody("note1") shouldBe "note body"
    }

}
