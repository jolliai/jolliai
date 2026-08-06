package ai.jolli.jollimemory.core

import com.google.gson.Gson
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Pins the Gson wire mapping of the `skills-active` response.
 *
 * [SkillsProjection] is the ONLY skill surface IntelliJ has, and nothing else in this
 * repo can see a break in it: the CLI suite tests `SkillProjection.ts` against its own
 * TypeScript types, and the VS Code suite imports those types directly. The Kotlin
 * mirror is hand-written, and Gson resolves fields by name at runtime — a rename on
 * either side compiles clean and silently leaves the field at its default, which for
 * this DTO means a skill row that renders as an unnamed zero-invocation entry, or an
 * aggregate checkbox that writes an empty key list.
 *
 * Follows the precedent of `TypesTest.GsonRoundTrip`, which pins the same hazard for
 * `CommitSummary.skills` / `PlansRegistry.skills`. The payloads below are shaped like
 * the real bridge response — including the three members the CLI sends and this DTO
 * deliberately does not declare (`kind`, `entryPaths`, `sourcePath`).
 */
class SkillsProjectionTest {

    private val gson = Gson()

    /** One full row as `toActiveSkill` in `SkillProjection.ts` emits it. */
    private val fullResponse = """
        {"skills":[
          {"kind":"skill","mapKey":"claude:superpowers:brainstorming","source":"claude",
           "skill":"superpowers:brainstorming","plugin":"superpowers","entryPaths":["tool"],
           "invocationCount":3,"firstUsedAt":"2026-07-31T09:00:00Z","lastUsedAt":"2026-07-31T09:30:00Z",
           "usage":{"input":79,"output":33944,"cached":59796,"confidence":"attributed"},
           "sourcePath":"/p/.jolli/jollimemory/skills/claude/s.md","detection":"heuristic",
           "lastModified":"2026-07-31T09:30:00Z"}
        ],"summaryLabel":"1 skill · 1.0k tokens"}
    """.trimIndent()

    @Nested
    inner class ActiveSkillsMapping {

        @Test
        fun `every declared field of a full skills-active row lands`() {
            val parsed = gson.fromJson(fullResponse, SkillsProjection.ActiveSkills::class.java)

            parsed.summaryLabel shouldBe "1 skill · 1.0k tokens"
            parsed.isEmpty shouldBe false

            val skill = parsed.skills.single()
            skill.mapKey shouldBe "claude:superpowers:brainstorming"
            skill.source shouldBe "claude"
            skill.skill shouldBe "superpowers:brainstorming"
            skill.plugin shouldBe "superpowers"
            skill.invocationCount shouldBe 3
            skill.firstUsedAt shouldBe "2026-07-31T09:00:00Z"
            skill.lastUsedAt shouldBe "2026-07-31T09:30:00Z"
            skill.usage?.input shouldBe 79
            skill.usage?.output shouldBe 33944
            skill.usage?.cached shouldBe 59796
            skill.usage?.confidence shouldBe "attributed"
            skill.detection shouldBe "heuristic"
            skill.lastModified shouldBe "2026-07-31T09:30:00Z"
        }

        /**
         * The aggregate checkbox writes exactly this list. A `mapKey` rename would leave
         * it a list of empty strings rather than fail, and `setAllExcluded` would happily
         * persist those — so the values matter, not just the count.
         */
        @Test
        fun `exclusionKeys are the mapKeys in response order`() {
            val json = """
                {"skills":[{"mapKey":"claude:a","lastModified":"2026-07-31T09:30:00Z"},
                           {"mapKey":"codex:b","lastModified":"2026-07-31T09:00:00Z"}],
                 "summaryLabel":"2 skills"}
            """.trimIndent()

            gson.fromJson(json, SkillsProjection.ActiveSkills::class.java)
                .exclusionKeys shouldBe listOf("claude:a", "codex:b")
        }

        /**
         * `usage` absent must stay absent. The CLI omits the member when the source
         * could not attribute tokens, and the table renders an em-dash for it — a
         * zero-valued `SkillUsage` here would report that the skill spent nothing.
         */
        @Test
        fun `an omitted usage stays null rather than becoming a zero`() {
            val json = """
                {"skills":[{"mapKey":"codex:x","source":"codex","skill":"x",
                 "invocationCount":1,"lastModified":"2026-07-31T09:00:00Z"}],"summaryLabel":"1 skill"}
            """.trimIndent()

            gson.fromJson(json, SkillsProjection.ActiveSkills::class.java).skills.single().usage.shouldBeNull()
        }

        @Test
        fun `anyInferred tracks the heuristic detection marker`() {
            fun responseWith(detection: String) = """
                {"skills":[{"mapKey":"codex:x","detection":$detection,
                 "lastModified":"2026-07-31T09:00:00Z"}],"summaryLabel":"1 skill"}
            """.trimIndent()

            gson.fromJson(responseWith("\"heuristic\""), SkillsProjection.ActiveSkills::class.java)
                .anyInferred shouldBe true
            // Omitted entirely — an observed invocation. The label must not claim inference.
            val observed = """
                {"skills":[{"mapKey":"codex:x","lastModified":"2026-07-31T09:00:00Z"}],"summaryLabel":"1 skill"}
            """.trimIndent()
            gson.fromJson(observed, SkillsProjection.ActiveSkills::class.java).anyInferred shouldBe false
        }
    }

    /**
     * The declared defaults only apply because EVERY constructor parameter of these
     * three data classes has one, which is what makes Kotlin emit a synthetic no-arg
     * constructor for Gson to call. Add one parameter without a default and Gson falls
     * back to `Unsafe` allocation instead: every default silently stops applying, and
     * the non-null `String` fields come back as `null` to blow up at first use. These
     * cases fail the moment that happens.
     */
    @Nested
    inner class DefaultsSurviveDeserialisation {

        @Test
        fun `a sparse row falls back to declared defaults`() {
            val json = """{"skills":[{"mapKey":"claude:a"}],"summaryLabel":"1 skill"}"""

            val skill = gson.fromJson(json, SkillsProjection.ActiveSkills::class.java).skills.single()
            skill.mapKey shouldBe "claude:a"
            skill.source shouldBe ""
            skill.skill shouldBe ""
            skill.lastModified shouldBe ""
            skill.invocationCount shouldBe 0
            skill.plugin.shouldBeNull()
            skill.firstUsedAt.shouldBeNull()
            skill.lastUsedAt.shouldBeNull()
        }

        @Test
        fun `a sparse usage falls back to zeroed counters`() {
            val json = """{"skills":[{"mapKey":"claude:a","usage":{}}],"summaryLabel":"1 skill"}"""

            val usage = gson.fromJson(json, SkillsProjection.ActiveSkills::class.java).skills.single().usage
            usage?.input shouldBe 0
            usage?.output shouldBe 0
            usage?.cached shouldBe 0
            usage?.confidence.shouldBeNull()
        }

        /**
         * `readActive` returns this shape on a response that carries neither member, and
         * the aggregate checkbox calls `exclusionKeys` on it — so `skills` must be an
         * empty list, never null.
         */
        @Test
        fun `an empty response object yields empty skills rather than null`() {
            val parsed = gson.fromJson("{}", SkillsProjection.ActiveSkills::class.java)

            parsed.skills shouldBe emptyList()
            parsed.summaryLabel shouldBe ""
            parsed.isEmpty shouldBe true
            parsed.exclusionKeys shouldBe emptyList()
            parsed.anyInferred shouldBe false
        }
    }
}
