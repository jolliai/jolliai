package ai.jolli.jollimemory.core

import com.google.gson.GsonBuilder
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class TypesTest {

    @Nested
    inner class Enums {
        @Test
        fun `TranscriptSource has correct values`() {
            // Must stay in lockstep with cli/src/Types.ts TRANSCRIPT_SOURCES. Order
            // and count both matter: Gson reflection deserialises unknown enum names
            // to Kotlin `null` via Unsafe, so any CLI source missing from this enum
            // NPEs the sidebar on first render for users of that agent.
            TranscriptSource.entries.map { it.name } shouldBe listOf(
                "claude",
                "codex",
                "gemini",
                "opencode",
                "cursor",
                "cursor-cli",
                "copilot",
                "copilot-chat",
                "cline",
                "cline-cli",
                "devin",
                "antigravity",
                "kimi",
            )
        }

        @Test
        fun `TopicCategory has all expected values`() {
            TopicCategory.entries shouldBe listOf(
                TopicCategory.feature, TopicCategory.bugfix, TopicCategory.refactor,
                TopicCategory.`tech-debt`, TopicCategory.performance, TopicCategory.security,
                TopicCategory.test, TopicCategory.docs, TopicCategory.ux, TopicCategory.devops,
            )
        }

        @Test
        fun `TopicImportance has correct values`() {
            TopicImportance.entries.map { it.name } shouldBe listOf("major", "minor")
        }

        @Test
        fun `CommitType has all expected values`() {
            CommitType.entries.map { it.name } shouldBe listOf("commit", "amend", "squash", "rebase", "cherry-pick", "revert")
        }

        @Test
        fun `CommitSource has correct values`() {
            CommitSource.entries.map { it.name } shouldBe listOf("cli", "plugin")
        }

        @Test
        fun `LogLevel priorities are ordered`() {
            LogLevel.debug.priority shouldBe 0
            LogLevel.info.priority shouldBe 1
            LogLevel.warn.priority shouldBe 2
            LogLevel.error.priority shouldBe 3
        }
    }

    @Nested
    inner class DataClasses {
        @Test
        fun `DiffStats has sensible defaults`() {
            val stats = DiffStats()
            stats.filesChanged shouldBe 0
            stats.insertions shouldBe 0
            stats.deletions shouldBe 0
        }

        @Test
        fun `CommitSummary has sensible defaults`() {
            val summary = CommitSummary(
                commitHash = "abc",
                commitMessage = "msg",
                commitAuthor = "author",
                commitDate = "date",
                branch = "main",
                generatedAt = "now",
            )
            summary.version shouldBe 3
            summary.topics shouldBe null
            summary.children shouldBe null
            summary.ticketId shouldBe null
        }

        @Test
        fun `SummaryIndex has sensible defaults`() {
            val index = SummaryIndex()
            index.version shouldBe 3
            index.entries shouldBe emptyList()
            index.commitAliases shouldBe null
        }

        @Test
        fun `FileWrite has delete default false`() {
            val fw = FileWrite("path", "content")
            fw.delete shouldBe false
        }

        @Test
        fun `InstallResult has empty warnings by default`() {
            val result = ai.jolli.jollimemory.core.InstallResult(true, "ok")
            result.warnings shouldBe emptyList()
        }

        @Test
        fun `SessionsRegistry has sensible defaults`() {
            val registry = SessionsRegistry()
            registry.version shouldBe 1
            registry.sessions shouldBe emptyMap()
        }

        @Test
        fun `PlansRegistry has sensible defaults`() {
            val registry = PlansRegistry()
            registry.version shouldBe 1
            registry.plans shouldBe emptyMap()
        }

        @Test
        fun `TopicUpdates allows partial updates`() {
            val updates = TopicUpdates(title = "New Title")
            updates.title shouldBe "New Title"
            updates.trigger shouldBe null
            updates.response shouldBe null
        }
    }

    /**
     * Locks down the `knowledgeBasePath` → `localFolder` schema migration in
     * [JolliMemoryConfig]. The field carries
     * `@SerializedName(value = "localFolder", alternate = ["knowledgeBasePath"])`
     * so old configs written by pre-1.1 IntelliJ (`knowledgeBasePath` only) still
     * load, while every new save writes the canonical `localFolder` key.
     *
     * IMPORTANT: Gson resolves the alternate by ASSIGNING each matching key it
     * encounters as it walks the JSON, so on a config that carries BOTH keys
     * whichever appears LATER in the JSON stream wins — the primary and the
     * alternate compete on file order, not on "primary wins". A pre-1.1
     * config with only `knowledgeBasePath` still migrates cleanly (the tests
     * below prove it); the risk lives entirely in configs that were written
     * with both keys by some intermediate/broken code path. If that becomes a
     * real user-reported failure mode, either normalize the JSON before
     * parsing or drop the alternate and do an explicit on-load fixup.
     *
     * Uses the same `serializeNulls()` builder [SessionTracker] uses so the
     * observed behavior matches production.
     */
    @Nested
    inner class LocalFolderMigration {
        // Matches SessionTracker.gson (serializeNulls() flips the roundtrip
        // semantics for the null-primary edge case).
        private val gson = GsonBuilder().serializeNulls().create()

        @Test
        fun `legacy-only knowledgeBasePath deserializes into localFolder`() {
            val json = """{ "knowledgeBasePath": "/legacy/path" }"""
            val cfg = gson.fromJson(json, JolliMemoryConfig::class.java)
            cfg.localFolder shouldBe "/legacy/path"
        }

        @Test
        fun `new-only localFolder deserializes normally`() {
            val json = """{ "localFolder": "/new/path" }"""
            val cfg = gson.fromJson(json, JolliMemoryConfig::class.java)
            cfg.localFolder shouldBe "/new/path"
        }

        @Test
        fun `absent-both stays null`() {
            val cfg = gson.fromJson("{}", JolliMemoryConfig::class.java)
            cfg.localFolder.shouldBeNull()
        }

        @Test
        fun `both keys present — later key in JSON order wins`() {
            // Documents Gson's actual alternate rule: as the parser walks the
            // JSON top-to-bottom, EVERY matching key (primary or alternate)
            // assigns the field, so the LATER occurrence overwrites the
            // earlier one. This is NOT "primary wins"; there is no priority
            // between value and alternate at all.
            //
            // Practical impact: a hand-edited or intermediate-build config
            // whose keys landed in an unexpected order can flip which value
            // the plugin loads. The intended migration path (files with only
            // the legacy key) is unaffected — see the `legacy-only …` test.
            gson.fromJson(
                """{ "localFolder": "/new", "knowledgeBasePath": "/legacy" }""",
                JolliMemoryConfig::class.java,
            ).localFolder shouldBe "/legacy"

            gson.fromJson(
                """{ "knowledgeBasePath": "/legacy", "localFolder": "/new" }""",
                JolliMemoryConfig::class.java,
            ).localFolder shouldBe "/new"
        }

        @Test
        fun `null primary followed by legacy key — legacy value is picked up`() {
            // Same rule as above applied to the "primary null" edge case:
            // because the legacy key sits AFTER `"localFolder": null` in the
            // JSON, it overwrites the null and the user's setting survives.
            // This test exists so a future regression that reintroduces
            // "primary-wins" (silently dropping the user's setting) fails
            // loudly. If the file order flips (legacy first, then primary
            // null), the reverse holds — a real risk case documented by the
            // next test.
            val json = """{ "localFolder": null, "knowledgeBasePath": "/legacy" }"""
            val cfg = gson.fromJson(json, JolliMemoryConfig::class.java)
            cfg.localFolder shouldBe "/legacy"
        }

        @Test
        fun `legacy key followed by null primary — legacy value IS silently dropped`() {
            // REGRESSION-GUARD RISK CASE. With the legacy key parsed first
            // and `localFolder: null` following it, the null wins and the
            // user's setting is silently dropped. This can only happen if
            // some code path writes both keys with the primary explicitly
            // null — no current write path in `main/` does this, but a
            // partial-merge helper (SessionTracker.saveSharedProviderConfig
            // et al.) or a hand edit can produce it.
            val json = """{ "knowledgeBasePath": "/legacy", "localFolder": null }"""
            val cfg = gson.fromJson(json, JolliMemoryConfig::class.java)
            cfg.localFolder.shouldBeNull()
        }

        @Test
        fun `serialization always writes localFolder — legacy key self-heals`() {
            val cfg = JolliMemoryConfig(localFolder = "/anywhere")
            val out = gson.toJson(cfg)
            out shouldContain "\"localFolder\":\"/anywhere\""
            out shouldNotContain "knowledgeBasePath"
        }
    }

    /**
     * Gson drops every JSON member the target data class does not declare, and this
     * plugin does not only READ these payloads — `SummaryTree.updateTopicInTree` sends a
     * whole re-serialised `CommitSummary` back to the CLI, and `PlansPanel` does
     * load → `copy()` → `savePlansRegistry` (which the `plans-save` bridge action writes
     * verbatim, with no field-wise merge on the CLI side).
     *
     * So an undeclared field is not a missing feature, it is silent data loss on the next
     * edit: one topic edit would erase a commit's archived skills, and deleting one plan
     * would erase the project's whole captured skill history. These round-trips are the
     * regression guard for that.
     */
    @Nested
    inner class GsonRoundTrip {
        private val gson = com.google.gson.Gson()

        @Test
        fun `CommitSummary preserves skills through a serialise-deserialise cycle`() {
            val json = """
                {"version":5,"commitHash":"abc123","commitMessage":"m","commitAuthor":"a",
                 "commitDate":"2026-07-31T00:00:00Z","branch":"main","generatedAt":"2026-07-31T00:00:00Z",
                 "skills":[{"archivedKey":"claude:superpowers:brainstorming-abc12345",
                 "source":"claude","skill":"superpowers:brainstorming","plugin":"superpowers",
                 "entryPaths":["tool"],"invocationCount":3,"firstUsedAt":"2026-07-31T09:00:00Z",
                 "lastUsedAt":"2026-07-31T09:30:00Z",
                 "usage":{"input":79,"output":33944,"cached":59796,"confidence":"attributed"},
                 "usageBySession":{"claude:sess1":{"input":79,"output":33944,"cached":59796,"confidence":"attributed"}},
                 "detection":"heuristic"}]}
            """.trimIndent()

            val parsed = gson.fromJson(json, CommitSummary::class.java)
            val skill = parsed.skills?.single()
            skill?.skill shouldBe "superpowers:brainstorming"
            skill?.invocationCount shouldBe 3
            skill?.usage?.cached shouldBe 59796
            skill?.usage?.confidence shouldBe "attributed"
            skill?.usageBySession?.get("claude:sess1")?.output shouldBe 33944
            skill?.detection shouldBe "heuristic"

            // The half that actually regressed: what we would WRITE BACK.
            val reparsed = gson.fromJson(gson.toJson(parsed), CommitSummary::class.java)
            reparsed.skills shouldBe parsed.skills
        }

        @Test
        fun `PlansRegistry preserves the skills map through a copy and re-serialise`() {
            val json = """
                {"version":1,"plans":{},
                 "skills":{"claude:superpowers:brainstorming":{"source":"claude",
                 "skill":"superpowers:brainstorming","entryPaths":["tool","command"],
                 "invocations":[{"at":"2026-07-31T09:00:00Z","args":"x","bodyChars":120,"ok":true}],
                 "invocationCount":3,"firstUsedAt":"2026-07-31T09:00:00Z","lastUsedAt":"2026-07-31T09:30:00Z",
                 "sourcePath":"/p/.jolli/jollimemory/skills/claude/s.md","commitHash":null,
                 "archivedTotals":{"invocationCount":2}}}}
            """.trimIndent()

            val parsed = gson.fromJson(json, PlansRegistry::class.java)
            val entry = parsed.skills?.get("claude:superpowers:brainstorming")
            entry?.invocationCount shouldBe 3
            entry?.commitHash shouldBe null
            entry?.invocations?.single()?.bodyChars shouldBe 120
            entry?.archivedTotals?.invocationCount shouldBe 2

            // Mirrors PlansPanel: mutate one map, save the whole registry.
            val mutated = parsed.copy(plans = emptyMap())
            gson.fromJson(gson.toJson(mutated), PlansRegistry::class.java).skills shouldBe parsed.skills
        }
    }
}
