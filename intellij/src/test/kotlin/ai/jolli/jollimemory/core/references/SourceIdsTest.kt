package ai.jolli.jollimemory.core.references

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldEndWith
import io.kotest.matchers.string.shouldMatch
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Locks down [SourceIds.pathKey] — the read-side sanitize that MUST agree
 * with the CLI's `SummaryStore.orphanPathFor` / `ReferenceStore.ts`
 * `sanitizeNativeIdForPath`. Without this parity, GitHub and Context7
 * archived-reference bodies read as null on every IntelliJ surface.
 *
 * See AGENTS.md "FolderStorage hidden-layer schema stays in lockstep" —
 * this test IS the lockstep gate for the Kotlin readers.
 */
class SourceIdsTest {

    @Nested
    inner class WireName {
        @Test
        fun `underscore ids are hyphenated for zoom variants only`() {
            SourceIds.wireName(SourceId.zoom_doc) shouldBe "zoom-doc"
            SourceIds.wireName(SourceId.zoom_meeting) shouldBe "zoom-meeting"
            SourceIds.wireName(SourceId.github) shouldBe "github"
            SourceIds.wireName(SourceId.linear) shouldBe "linear"
        }
    }

    @Nested
    inner class StripPrefix {
        @Test
        fun `strips the source colon prefix and passes the rest through`() {
            SourceIds.stripPrefix("github", "github:owner/repo#42-abc12345") shouldBe "owner/repo#42-abc12345"
            SourceIds.stripPrefix("linear", "linear:PROJ-1234-abc12345") shouldBe "PROJ-1234-abc12345"
        }

        @Test
        fun `passes through when the prefix is absent`() {
            // Defense-in-depth for hand-passed inputs; the write path never emits these.
            SourceIds.stripPrefix("github", "owner/repo#42-abc12345") shouldBe "owner/repo#42-abc12345"
        }
    }

    @Nested
    inner class PathKey {
        @Test
        fun `path-safe sources round-trip as identity`() {
            // linear / jira / notion / slack / jollimemory / confluence / asana /
            // monday / zoom-doc / zoom-meeting / vercel / figma — everything
            // declared `nativeIdPathSafe: true` in the CLI. Adding a new one? Add
            // it to both this test and the CLI source definition in the same PR.
            // The CLI's `SourceLabelsLockstep.test.ts` pins the SET; this pins the
            // BEHAVIOUR of each member against a real-shaped id.
            SourceIds.pathKey(SourceId.linear, "PROJ-1234-abc12345") shouldBe "PROJ-1234-abc12345"
            SourceIds.pathKey(SourceId.jira, "KAN-4-abc12345") shouldBe "KAN-4-abc12345"
            SourceIds.pathKey(SourceId.notion, "abc123def456-abc12345") shouldBe "abc123def456-abc12345"
            SourceIds.pathKey(SourceId.slack, "C123-1728000000.001-abc12345") shouldBe "C123-1728000000.001-abc12345"
            SourceIds.pathKey(SourceId.jollimemory, "recall-abc12345") shouldBe "recall-abc12345"
            SourceIds.pathKey(SourceId.confluence, "1234-abc12345") shouldBe "1234-abc12345"
            SourceIds.pathKey(SourceId.asana, "1200000-abc12345") shouldBe "1200000-abc12345"
            SourceIds.pathKey(SourceId.monday, "9000000-abc12345") shouldBe "9000000-abc12345"
            SourceIds.pathKey(SourceId.zoom_doc, "doc-1-abc12345") shouldBe "doc-1-abc12345"
            SourceIds.pathKey(SourceId.zoom_meeting, "1234567890-abc12345") shouldBe "1234567890-abc12345"
            // A Vercel deployment id and a Figma file key are both bare
            // alphanumerics — the CLI's `require` patterns pin them to exactly that,
            // which is why both declare `nativeIdPathSafe: true`.
            SourceIds.pathKey(SourceId.vercel, "dpl_9RmvfLQzHVt-abc12345") shouldBe "dpl_9RmvfLQzHVt-abc12345"
            SourceIds.pathKey(SourceId.figma, "kQ7ZmR2xTb1-abc12345") shouldBe "kQ7ZmR2xTb1-abc12345"
        }

        @Test
        fun `sentry folds the host separator and appends an 8-hex suffix`() {
            // A Sentry nativeId is `<hostname>/<issueId>` — `nativeIdPathSafe: false`
            // for github's reason, and with the same second benefit: the sha8 keeps
            // two hosts' same-numbered issues apart. Omitting sentry from
            // `PATH_UNSAFE_SOURCES` would read `<host>/<id>` as a file stem, so every
            // archived Sentry body would come back null.
            val stem = SourceIds.pathKey(SourceId.sentry, "acme.sentry.io/7665509682-abc12345")
            stem shouldNotContain "/"
            stem shouldMatch Regex("^[\\w.-]+$")
            stem shouldMatch Regex("^.+-[0-9a-f]{8}$")
            val other = SourceIds.pathKey(SourceId.sentry, "other.sentry.io/7665509682-abc12345")
            stem shouldNotBe other
        }

        @Test
        fun `github folds slash and hash and appends an 8-hex suffix`() {
            val stem = SourceIds.pathKey(SourceId.github, "owner/repo#42-abc12345")
            // `/` and `#` → `-`, no other bytes replaced.
            stem shouldNotContain "/"
            stem shouldNotContain "#"
            // The whole stem is safe (word chars, dot, hyphen).
            stem shouldMatch Regex("^[\\w.-]+$")
            // Ends with `-<8 hex chars>` — the sha256 tail.
            stem shouldMatch Regex("^.+-[0-9a-f]{8}$")
            // Full canonical form (mirrors the CLI's byte-for-byte output). The
            // sha8 is over the RAW bareKey — regenerated here for the assertion.
            val expected = "owner-repo-42-abc12345-" + java.security.MessageDigest.getInstance("SHA-256")
                .digest("owner/repo#42-abc12345".toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
                .substring(0, 8)
            stem shouldBe expected
        }

        @Test
        fun `github with the same input is deterministic`() {
            SourceIds.pathKey(SourceId.github, "owner/repo#42-abc12345") shouldBe
                SourceIds.pathKey(SourceId.github, "owner/repo#42-abc12345")
        }

        @Test
        fun `github issue numbers that would collide across repos land at different stems`() {
            // The whole reason for the sha256 suffix: two repos with the same
            // issue number must not share a file. If the suffix ever went away,
            // this test would fail with a name collision.
            val a = SourceIds.pathKey(SourceId.github, "orgA/proj#100-abc12345")
            val b = SourceIds.pathKey(SourceId.github, "orgB/proj#100-abc12345")
            a shouldNotBe b
        }

        @Test
        fun `context7 folds the leading slash and appends an 8-hex suffix`() {
            val stem = SourceIds.pathKey(SourceId.context7, "/org/project-abc12345")
            // Leading `/` and the separator `/` both fold to `-`.
            stem shouldNotContain "/"
            stem shouldMatch Regex("^[\\w.-]+$")
            stem shouldMatch Regex("^.+-[0-9a-f]{8}$")
            // Deterministic + collision-free property covered by the github tests.
        }

        @Test
        fun `context7 keeps versioned ids distinct from unversioned`() {
            // Two legitimate Context7 ids differ only in the trailing version segment.
            // The suffix must keep them apart.
            val plain = SourceIds.pathKey(SourceId.context7, "/org/project-abc12345")
            val versioned = SourceIds.pathKey(SourceId.context7, "/org/project/v2-abc12345")
            plain shouldNotBe versioned
        }
    }
}
