package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.JsonObject
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldMatch
import io.kotest.matchers.types.shouldBeInstanceOf
import java.util.Base64
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Kotlin-side tests for the JolliApiClient facade. HTTP client behavior lives in
 * the CLI (`cli/src/core/JolliApiUtils.ts`, `cli/src/core/JolliMemoryPushClient.ts`,
 * exercised by `cli/src/core/JolliApiUtils.test.ts` etc.); this file covers the
 * pieces the Kotlin side still owns:
 * - parseJolliApiKey (kept as a pure-Kotlin port for EDT hot paths — must stay
 *   in lockstep with the CLI's `parseJolliApiKey`)
 * - remapBridgeException — the CLI errorName → Kotlin exception mapping that
 *   drives every UI branch. Silent drift here would break unauthorized /
 *   outdated / binding-required dialogs without a test tripping.
 * - Data-class shapes and the pluginVersion classpath resource contract.
 */
class JolliApiClientTest {

    @Nested
    inner class ParseJolliApiKey {
        @Test
        fun `parses new-format API key with tenant and URL`() {
            val meta = """{"t":"test-tenant","u":"https://test-tenant.jolli.ai"}"""
            val result = JolliApiClient.parseJolliApiKey(buildKey(meta))
            result shouldNotBe null
            result!!.t shouldBe "test-tenant"
            result.u shouldBe "https://test-tenant.jolli.ai"
            result.o shouldBe null
        }

        @Test
        fun `parses API key with org slug`() {
            val meta = """{"t":"tenant","u":"https://tenant.jolli.ai","o":"org1"}"""
            JolliApiClient.parseJolliApiKey(buildKey(meta))!!.o shouldBe "org1"
        }

        @Test
        fun `parses JWT-shaped key with meta in the second segment`() {
            // Format B: `sk-jol-<headerB64>.<payloadB64>.<sigB64>` — the parser must
            // scan every dot-separated segment, not just the first.
            val header = urlEncode("""{"alg":"HS256"}""")
            val payload = urlEncode("""{"t":"tenant","u":"https://tenant.jolli.ai"}""")
            val sig = urlEncode("sig-bytes")
            val result = JolliApiClient.parseJolliApiKey("sk-jol-$header.$payload.$sig")
            result!!.t shouldBe "tenant"
            result.u shouldBe "https://tenant.jolli.ai"
        }

        @Test
        fun `returns null for old-format API key`() {
            JolliApiClient.parseJolliApiKey("sk-jol-abcdef1234567890abcdef1234567890") shouldBe null
        }

        @Test
        fun `returns null for non-sk-jol prefix`() {
            JolliApiClient.parseJolliApiKey("not-a-key") shouldBe null
        }

        @Test
        fun `returns null for invalid base64 meta`() {
            JolliApiClient.parseJolliApiKey("sk-jol-!!!invalid!!!.${randomSegment()}") shouldBe null
        }

        @Test
        fun `returns null for meta missing t field`() {
            JolliApiClient.parseJolliApiKey(buildKey("""{"u":"https://x.jolli.ai"}""")) shouldBe null
        }

        @Test
        fun `returns null for meta missing u field`() {
            JolliApiClient.parseJolliApiKey(buildKey("""{"t":"tenant"}""")) shouldBe null
        }

        private fun buildKey(meta: String): String = "sk-jol-${urlEncode(meta)}.${randomSegment()}"
        private fun urlEncode(s: String): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray())
        private fun randomSegment(): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))
    }

    @Nested
    inner class RemapBridgeException {
        @Test
        fun `ClientOutdatedError maps to PluginOutdatedError with CLI message`() {
            val e = CliIntegrations.CliBridgeException("ClientOutdatedError", "please update")
            val mapped = JolliApiClient.remapBridgeException(e, null)
            mapped.shouldBeInstanceOf<JolliApiClient.PluginOutdatedError>()
            mapped.message shouldBe "please update"
        }

        @Test
        fun `NotAuthenticatedError maps to UnauthorizedError`() {
            val e = CliIntegrations.CliBridgeException("NotAuthenticatedError", "no token")
            val mapped = JolliApiClient.remapBridgeException(e, null)
            mapped.shouldBeInstanceOf<JolliApiClient.UnauthorizedError>()
            mapped.message shouldBe "no token"
        }

        @Test
        fun `PermissionDeniedError maps to the distinct PermissionDeniedError (cross-client parity)`() {
            // A credential-OK refusal (repo not allowlisted / ownership mismatch)
            // must stay distinct from NotAuthenticatedError so the panels can
            // surface the admin-oriented text instead of a re-login prompt.
            val e = CliIntegrations.CliBridgeException("PermissionDeniedError", "forbidden")
            val mapped = JolliApiClient.remapBridgeException(e, null)
            mapped.shouldBeInstanceOf<JolliApiClient.PermissionDeniedError>()
            mapped.message shouldBe "forbidden"
        }

        @Test
        fun `PushDisabledError maps to the share service's opt-out type, not a generic error`() {
            // The CLI's own gate can refuse mid-call when the opt-out flips after a push
            // site's pre-check. Without this mapping it fell through to the plain
            // RuntimeException, so the panels' quiet "re-enable to push" info path was
            // skipped and a user opt-out surfaced as a push failure.
            val e = CliIntegrations.CliBridgeException("PushDisabledError", "disabled; use jolli push-control --enable")
            val mapped = JolliApiClient.remapBridgeException(e, null)
            mapped.shouldBeInstanceOf<JolliShareService.PushDisabledError>()
            // The bridge message is DROPPED on purpose: it names a CLI command, so IDE
            // users get the IDE-worded default — identical to the pre-call gate's text.
            mapped.message shouldBe JolliShareService.PushDisabledError().message
        }

        @Test
        fun `BindingRequiredError uses repoUrl from CLI details when present`() {
            val details = JsonObject().apply { addProperty("repoUrl", "https://git.example/repo.git") }
            val e = CliIntegrations.CliBridgeException("BindingRequiredError", "bind first", details)
            val mapped = JolliApiClient.remapBridgeException(e, null)
            mapped.shouldBeInstanceOf<JolliApiClient.BindingRequiredError>()
            (mapped as JolliApiClient.BindingRequiredError).repoUrl shouldBe "https://git.example/repo.git"
            mapped.message shouldBe "bind first"
        }

        @Test
        fun `BindingRequiredError falls back to payloadRepoUrl when details omit repoUrl`() {
            val e = CliIntegrations.CliBridgeException("BindingRequiredError", "bind first")
            val mapped = JolliApiClient.remapBridgeException(e, "https://fallback.example/repo.git")
            (mapped as JolliApiClient.BindingRequiredError).repoUrl shouldBe "https://fallback.example/repo.git"
        }

        @Test
        fun `BindingRequiredError repoUrl is empty when neither details nor payload have it`() {
            val e = CliIntegrations.CliBridgeException("BindingRequiredError", "bind first")
            val mapped = JolliApiClient.remapBridgeException(e, null)
            (mapped as JolliApiClient.BindingRequiredError).repoUrl shouldBe ""
        }

        @Test
        fun `ShareRevokedError maps to ShareRevokedError`() {
            val e = CliIntegrations.CliBridgeException("ShareRevokedError", "gone")
            val mapped = JolliApiClient.remapBridgeException(e, null)
            mapped.shouldBeInstanceOf<JolliApiClient.ShareRevokedError>()
            mapped.message shouldBe "gone"
        }

        @Test
        fun `unknown errorName falls back to plain RuntimeException`() {
            val e = CliIntegrations.CliBridgeException("SomethingNewError", "boom")
            val mapped = JolliApiClient.remapBridgeException(e, null)
            mapped::class.java shouldBe RuntimeException::class.java
            mapped.message shouldBe "boom"
        }

        @Test
        fun `null errorName falls back to plain RuntimeException`() {
            val e = CliIntegrations.CliBridgeException(null, "generic")
            val mapped = JolliApiClient.remapBridgeException(e, null)
            mapped::class.java shouldBe RuntimeException::class.java
            mapped.message shouldBe "generic"
        }
    }

    @Nested
    inner class MapCreateBindingBridgeException {
        // Regression coverage for the 409 race path. The pre-existing
        // remapBridgeException mapper folds every non-listed errorName into a
        // plain RuntimeException, which would strip `existingSpaceId` and
        // leave BindingChooserDialog's race-winner banner unable to settle on
        // the winning binding. createBinding delegates here so
        // `existingSpaceId` survives.

        @Test
        fun `BindingAlreadyExistsError yields BindingAlreadyExistsException carrying existingSpaceId`() {
            val details = JsonObject().apply {
                addProperty("existingSpaceId", 42)
            }
            val e = CliIntegrations.CliBridgeException("BindingAlreadyExistsError", "binding_already_exists", details)
            val mapped = JolliApiClient.mapCreateBindingBridgeException(
                e,
                repoUrl = "https://git.example/repo.git",
                repoName = "repo",
            )
            mapped.shouldBeInstanceOf<ai.jolli.jollimemory.toolwindow.BindingAlreadyExistsException>()
            val winner = (mapped as ai.jolli.jollimemory.toolwindow.BindingAlreadyExistsException).winner
            // id=0 is deliberate — the CLI's 409 payload has no bindingId (the
            // server rejects the create, and the winning row's id isn't echoed).
            // The push path only needs jmSpaceId to settle on the winning
            // binding; jmSpaceName is always "" because the server does not
            // send it on the /bindings response.
            winner.id shouldBe 0
            winner.jmSpaceId shouldBe 42
            winner.jmSpaceName shouldBe ""
            winner.repoName shouldBe "repo"
        }

        @Test
        fun `BindingAlreadyExistsError defaults existingSpaceId when the CLI omits it`() {
            // Rare no-winner race — the CLI omits existingSpaceId. The mapper
            // falls back to 0 rather than throwing so the caller still sees
            // the typed exception instead of a bare RuntimeException.
            val e = CliIntegrations.CliBridgeException(
                "BindingAlreadyExistsError",
                "binding_already_exists",
                JsonObject(),
            )
            val mapped = JolliApiClient.mapCreateBindingBridgeException(
                e,
                repoUrl = "https://git.example/repo.git",
                repoName = "repo",
            )
            val winner = (mapped as ai.jolli.jollimemory.toolwindow.BindingAlreadyExistsException).winner
            winner.jmSpaceId shouldBe 0
            winner.jmSpaceName shouldBe ""
            winner.repoName shouldBe "repo"
        }

        @Test
        fun `non-409 errorName falls through to remapBridgeException`() {
            val e = CliIntegrations.CliBridgeException("NotAuthenticatedError", "no token")
            val mapped = JolliApiClient.mapCreateBindingBridgeException(
                e,
                repoUrl = "https://git.example/repo.git",
                repoName = "repo",
            )
            mapped.shouldBeInstanceOf<JolliApiClient.UnauthorizedError>()
        }

        @Test
        fun `non-409 errorName threads repoUrl into BindingRequiredError`() {
            // BindingRequiredError falls back to payloadRepoUrl when the CLI
            // details omit it — the createBinding path always has a repoUrl
            // available, so threading it lets the surface open the chooser
            // dialog for the right repo instead of an empty one.
            val e = CliIntegrations.CliBridgeException("BindingRequiredError", "bind first")
            val mapped = JolliApiClient.mapCreateBindingBridgeException(
                e,
                repoUrl = "https://git.example/repo.git",
                repoName = "repo",
            )
            (mapped as JolliApiClient.BindingRequiredError).repoUrl shouldBe "https://git.example/repo.git"
        }

        @Test
        fun `unknown errorName falls through to plain RuntimeException`() {
            val e = CliIntegrations.CliBridgeException("SomethingNewError", "boom")
            val mapped = JolliApiClient.mapCreateBindingBridgeException(
                e,
                repoUrl = "https://git.example/repo.git",
                repoName = "repo",
            )
            mapped::class.java shouldBe RuntimeException::class.java
            mapped.message shouldBe "boom"
        }
    }

    @Test
    fun `JolliPushPayload has correct defaults`() {
        val payload = JolliApiClient.JolliPushPayload("Test", "Content", "abc123", "summary")
        payload.branch shouldBe null
        payload.docId shouldBe null
        payload.repoUrl shouldBe null
        payload.relativePath shouldBe null
    }

    @Test
    fun `JolliPushResult fields work`() {
        val result = JolliApiClient.JolliPushResult("url", 1, "jrn", true)
        result.url shouldBe "url"
        result.created shouldBe true
    }

    @Test
    fun `PluginOutdatedError is a RuntimeException`() {
        val error = JolliApiClient.PluginOutdatedError("outdated")
        (error is RuntimeException) shouldBe true
        error.message shouldBe "outdated"
    }

    @Test
    fun `JolliApiKeyMeta fields work`() {
        val meta = JolliApiClient.JolliApiKeyMeta("t", "u", "o")
        meta.t shouldBe "t"
        meta.u shouldBe "u"
        meta.o shouldBe "o"
    }

    @Test
    fun `pluginVersion is populated from build-time resource`() {
        // Asserts the processResources expand step ran and produced a real
        // version — not the 0.0.0 fallback that signals a packaging bug.
        // Allows an optional 4th segment for local dev builds (e.g. 0.99.4.2).
        JolliApiClient.pluginVersion shouldMatch Regex("""^\d+\.\d+\.\d+(\.\d+)?$""")
        JolliApiClient.pluginVersion shouldNotBe "0.0.0"
    }

    /**
     * Wire-contract tests: pin every field name that crosses the CLI ide-bridge
     * literally. Motivated by the code review of the java.net.http → ide-bridge
     * migration — the pre-migration Kotlin HTTP client had these covered
     * end-to-end, but with the DTOs now marshalled through a bridge whose only
     * type safety is a `Parameters<typeof client.push>` cast, a silent rename
     * on either side compiles fine and collapses the wire value to 0/"" at
     * runtime (a docId of 0 makes every commit re-CREATE its Space article
     * instead of updating).
     *
     * These tests do NOT spawn Node — they assert the raw JSON shapes and the
     * response mappers. The peer TypeScript contract lives in
     * [`cli/src/core/JolliMemoryPushClient.ts`] / [`cli/src/core/JolliShareClient.ts`];
     * a rename there must be caught by that side's own tests.
     */
    @Nested
    inner class WireContract {
        // ─── pushPayloadJson — every field the CLI PushPayload interface declares ───

        @Test
        fun `pushPayloadJson emits every required field with the wire-contract name`() {
            val payload = JolliApiClient.JolliPushPayload(
                title = "Add feature",
                content = "# heading",
                commitHash = "abc123",
                docType = "summary",
            )
            val out = JolliApiClient.pushPayloadJson(payload)
            out.get("title").asString shouldBe "Add feature"
            out.get("content").asString shouldBe "# heading"
            out.get("commitHash").asString shouldBe "abc123"
            out.get("docType").asString shouldBe "summary"
            // Optional fields must be OMITTED (not `null` / `""`) when absent so a
            // hand-written CLI request-schema validator can enforce required-vs-optional.
            out.has("branch") shouldBe false
            out.has("docId") shouldBe false
            out.has("repoUrl") shouldBe false
            out.has("relativePath") shouldBe false
            out.has("summaryJson") shouldBe false
        }

        @Test
        fun `pushPayloadJson threads through every optional field`() {
            val payload = JolliApiClient.JolliPushPayload(
                title = "t",
                content = "c",
                commitHash = "h",
                docType = "summary",
                branch = "main",
                docId = 42,
                repoUrl = "https://git.example/repo.git",
                relativePath = "docs/x.md",
                summaryJson = "{\"a\":1}",
            )
            val out = JolliApiClient.pushPayloadJson(payload)
            out.get("branch").asString shouldBe "main"
            out.get("docId").asInt shouldBe 42
            out.get("repoUrl").asString shouldBe "https://git.example/repo.git"
            out.get("relativePath").asString shouldBe "docs/x.md"
            out.get("summaryJson").asString shouldBe "{\"a\":1}"
        }

        // ─── parsePushResponse — every field JolliPushResult needs to survive ───

        @Test
        fun `parsePushResponse reads every field by the wire-contract name`() {
            val obj = JsonObject().apply {
                addProperty("url", "https://tenant.jolli.ai/articles?doc=42")
                addProperty("docId", 42)
                addProperty("jrn", "jrn:jolli:doc:42")
                addProperty("created", true)
            }
            val result = JolliApiClient.parsePushResponse(obj)
            result.url shouldBe "https://tenant.jolli.ai/articles?doc=42"
            result.docId shouldBe 42
            result.jrn shouldBe "jrn:jolli:doc:42"
            result.created shouldBe true
        }

        @Test
        fun `parsePushResponse defaults every field when the CLI omits it`() {
            // Defensive parse: the CLI must not surface a torn/partial success as
            // a JolliPushResult that would silently poison the article link
            // (docId=0 → `?doc=0`) or the create/update decision (`created=false`
            // when the server actually created). This mirrors the CLI's own
            // "docId missing" hard-fail; here we default rather than throw so a
            // caller that has a fallback path (deletion cleanup, best-effort
            // recreate) doesn't crash on a bug we couldn't otherwise diagnose.
            val result = JolliApiClient.parsePushResponse(JsonObject())
            result.url shouldBe ""
            result.docId shouldBe 0
            result.jrn shouldBe ""
            result.created shouldBe false
        }

        // ─── parseListSpacesResponse ───────────────────────────────────────────

        @Test
        fun `parseListSpacesResponse reads spaces list and defaultSpaceId`() {
            val obj = JsonObject().apply {
                add("spaces", com.google.gson.JsonArray().apply {
                    add(JsonObject().apply {
                        addProperty("id", 7)
                        addProperty("name", "Engineering")
                        addProperty("slug", "eng")
                    })
                    add(JsonObject().apply {
                        addProperty("id", 9)
                        addProperty("name", "Design")
                        addProperty("slug", "design")
                    })
                })
                addProperty("defaultSpaceId", 7)
            }
            val result = JolliApiClient.parseListSpacesResponse(obj)
            result.spaces.size shouldBe 2
            result.spaces[0].id shouldBe 7
            result.spaces[0].name shouldBe "Engineering"
            result.spaces[0].slug shouldBe "eng"
            result.defaultSpaceId shouldBe 7
        }

        @Test
        fun `parseListSpacesResponse tolerates a missing defaultSpaceId (older backends)`() {
            // Spec 95 tolerates two shapes for legacy backends. The envelope
            // without `defaultSpaceId` must yield null, not 0 (the caller uses
            // null as "no default configured").
            val obj = JsonObject().apply {
                add("spaces", com.google.gson.JsonArray())
            }
            JolliApiClient.parseListSpacesResponse(obj).defaultSpaceId shouldBe null
        }

        // ─── parseCreateBindingResponse — the fields most at risk of silent drift ─

        @Test
        fun `parseCreateBindingResponse reads bindingId jmSpaceId repoName by exact name`() {
            // Regression coverage: the raw `jm_repo_binding` row's PK is `id`,
            // and the CLI intentionally re-shapes it to `bindingId` before
            // returning. If either side drops the re-shape, this test trips.
            val obj = JsonObject().apply {
                addProperty("bindingId", 101)
                addProperty("jmSpaceId", 7)
                addProperty("repoName", "acme/repo")
            }
            val result = JolliApiClient.parseCreateBindingResponse(obj)
            result.id shouldBe 101
            result.jmSpaceId shouldBe 7
            result.repoName shouldBe "acme/repo"
            // Server does not send a jmSpaceName on POST /bindings — the mapper
            // must not fabricate one; the race-winner banner falls back to a
            // name-less string when this is "".
            result.jmSpaceName shouldBe ""
        }

        @Test
        fun `parseCreateBindingResponse collapses missing IDs to zero`() {
            // Documents the "silent zero" the wire-contract test protects
            // against: without these tests, a rename would land here and the
            // caller would think the binding was created against space 0.
            val result = JolliApiClient.parseCreateBindingResponse(JsonObject())
            result.id shouldBe 0
            result.jmSpaceId shouldBe 0
            result.repoName shouldBe ""
        }

        // ─── liveSharePayloadJson ──────────────────────────────────────────────

        @Test
        fun `liveSharePayloadJson emits every required field with the wire-contract name`() {
            val payload = JolliApiClient.LiveSharePayload(
                repoUrl = "https://git.example/repo.git",
                repoName = "acme/repo",
                branch = "main",
                kind = "branch",
                visibility = "public",
                decisionCount = 3,
                headCommitHash = "abc",
                commitHashes = listOf("abc", "def"),
                ref = ai.jolli.jollimemory.core.BranchShareStore.LiveRef.branchCollection(
                    relativePath = "acme/repo/main",
                    covered = emptyList(),
                ),
            )
            val out = JolliApiClient.liveSharePayloadJson(payload)
            out.get("repoUrl").asString shouldBe "https://git.example/repo.git"
            out.get("repoName").asString shouldBe "acme/repo"
            out.get("branch").asString shouldBe "main"
            out.get("kind").asString shouldBe "branch"
            out.get("visibility").asString shouldBe "public"
            out.get("decisionCount").asInt shouldBe 3
            out.get("headCommitHash").asString shouldBe "abc"
            out.get("commitHashes").asJsonArray.size() shouldBe 2
            out.get("commitHashes").asJsonArray[0].asString shouldBe "abc"
            // Optional fields absent → keys omitted, not null.
            out.has("branchSlug") shouldBe false
            out.has("recipients") shouldBe false
            out.has("ref") shouldBe true
        }

        @Test
        fun `liveSharePayloadJson threads through branchSlug and recipients`() {
            val payload = JolliApiClient.LiveSharePayload(
                repoUrl = "https://git.example/repo.git",
                repoName = "acme/repo",
                branch = "main",
                kind = "branch",
                visibility = "people",
                decisionCount = 0,
                headCommitHash = "abc",
                commitHashes = listOf(),
                branchSlug = "main-slug",
                ref = ai.jolli.jollimemory.core.BranchShareStore.LiveRef.branchCollection(
                    relativePath = "acme/repo/main",
                    covered = emptyList(),
                ),
                recipients = listOf("alice@x.com", "bob@x.com"),
            )
            val out = JolliApiClient.liveSharePayloadJson(payload)
            out.get("branchSlug").asString shouldBe "main-slug"
            out.get("recipients").asJsonArray.size() shouldBe 2
            out.get("recipients").asJsonArray[0].asString shouldBe "alice@x.com"
        }

        // ─── liveSharePatchJson — server rule: unchanged fields must be OMITTED ─

        @Test
        fun `liveSharePatchJson omits absent fields (server treats absence as unchanged)`() {
            val patch = JolliApiClient.LiveSharePatch(visibility = "org")
            val out = JolliApiClient.liveSharePatchJson(patch)
            out.get("visibility").asString shouldBe "org"
            // Every other field must be OMITTED — sending `null` or `""` would
            // instruct the server to clear the field instead of leaving it
            // alone.
            out.has("expiresAt") shouldBe false
            out.has("ref") shouldBe false
            out.has("recipients") shouldBe false
        }

        @Test
        fun `liveSharePatchJson threads through every optional field`() {
            val patch = JolliApiClient.LiveSharePatch(
                visibility = "public",
                expiresAt = "2026-01-01T00:00:00Z",
                ref = ai.jolli.jollimemory.core.BranchShareStore.LiveRef.commitDocs(
                    summaryDocIds = listOf(1),
                    attachmentDocIds = listOf(2),
                ),
                recipients = listOf("alice@x.com"),
            )
            val out = JolliApiClient.liveSharePatchJson(patch)
            out.get("visibility").asString shouldBe "public"
            out.get("expiresAt").asString shouldBe "2026-01-01T00:00:00Z"
            out.has("ref") shouldBe true
            out.get("recipients").asJsonArray.size() shouldBe 1
        }
    }
}
