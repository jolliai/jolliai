package ai.jolli.jollimemory.core

import com.google.gson.GsonBuilder
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Wire tests for the `working-context` DTOs.
 *
 * These deserialize the payloads the CLI actually emits, which is the one thing a
 * Kotlin/TypeScript pair cannot check for itself: Gson silently drops a key it does
 * not know and writes null into a field it expects, so a mismatch surfaces as a
 * wrong panel — or a swallowed exception — rather than a failing build. The adapter
 * shipped without these and a fractional `mtimeMs` took the Add Plan picker down;
 * see [AvailablePlanWire].
 *
 * The Gson instance mirrors [WorkingContext]'s own (`serializeNulls`), which is
 * private. Keep the two in step.
 */
class WorkingContextTest {

	private val gson = GsonBuilder().serializeNulls().create()

	@Nested
	inner class AvailablePlanWire {

		@Test
		fun `accepts the whole-millisecond mtime the CLI sends`() {
			val plan = gson.fromJson(
				"""{"slug":"add-dark-mode","title":"Add dark mode","mtimeMs":1785768117378}""",
				WorkingContext.AvailablePlan::class.java,
			)
			plan.slug shouldBe "add-dark-mode"
			plan.title shouldBe "Add dark mode"
			plan.mtimeMs shouldBe 1785768117378L
		}

		/**
		 * Pins WHY `listAvailablePlans` truncates in `cli/src/core/PlanService.ts`.
		 *
		 * `statSync().mtimeMs` is fractional on APFS and ext4 alike (measured:
		 * `1785768117378.9856`), and Gson refuses to lose precision reading a
		 * fractional literal into a `Long` rather than truncating — so the raw value
		 * did not merely round badly, it failed the ENTIRE `plans-list-available`
		 * response and the Add Plan picker with it. Asserted as `RuntimeException`
		 * because the wrapping is Gson's business (`JsonSyntaxException` around a
		 * `NumberFormatException` today); what this file pins is that it is rejected
		 * rather than silently truncated. If it ever stops throwing, the CLI-side
		 * truncation is no longer load-bearing and its comment should say so.
		 */
		@Test
		fun `rejects a fractional mtime, which is why the CLI truncates`() {
			shouldThrow<RuntimeException> {
				gson.fromJson(
					"""{"slug":"s","title":"t","mtimeMs":1785768117378.9856}""",
					WorkingContext.AvailablePlan::class.java,
				)
			}
		}
	}

	@Nested
	inner class RowProjections {

		@Test
		fun `PlanInfo carries a null commitHash for an uncommitted row`() {
			val plan = gson.fromJson(
				"""
				{"slug":"s","filename":"s.md","filePath":"/p/s.md","title":"T",
				 "lastModified":"2026-01-02T00:00:00.000Z","addedAt":"2026-01-01T00:00:00.000Z",
				 "updatedAt":"2026-01-02T00:00:00.000Z","commitHash":null}
				""".trimIndent(),
				WorkingContext.PlanInfo::class.java,
			)
			plan.filename shouldBe "s.md"
			plan.commitHash.shouldBeNull()
		}

		// A snippet note has no `filename` / `filePath` on the wire at all — the CLI
		// omits the keys rather than sending null, so both must stay nullable here.
		@Test
		fun `NoteInfo tolerates the omitted filename and filePath of a snippet`() {
			val note = gson.fromJson(
				"""
				{"id":"note-ab12","title":"Scratch","format":"snippet",
				 "lastModified":"2026-01-02T00:00:00.000Z","addedAt":"2026-01-01T00:00:00.000Z",
				 "updatedAt":"2026-01-02T00:00:00.000Z","commitHash":null}
				""".trimIndent(),
				WorkingContext.NoteInfo::class.java,
			)
			note.format shouldBe NoteFormat.snippet
			note.filename.shouldBeNull()
			note.filePath.shouldBeNull()
		}

		@Test
		fun `NoteInfo maps the markdown format name`() {
			val note = gson.fromJson(
				"""
				{"id":"n","title":"T","format":"markdown","lastModified":"x","addedAt":"x",
				 "updatedAt":"x","commitHash":null,"filename":"n.md","filePath":"/p/n.md"}
				""".trimIndent(),
				WorkingContext.NoteInfo::class.java,
			)
			note.format shouldBe NoteFormat.markdown
			note.filePath shouldBe "/p/n.md"
		}
	}

	@Nested
	inner class ContextListWire {

		@Test
		fun `reads the four sections the CONTEXT panel renders`() {
			val list = gson.fromJson(
				"""
				{"plans":[{"slug":"p1","filename":"p1.md","filePath":"/p/p1.md","title":"P1",
				           "lastModified":"x","addedAt":"x","updatedAt":"x","commitHash":null}],
				 "notes":[{"id":"n1","title":"N1","format":"snippet","lastModified":"x",
				           "addedAt":"x","updatedAt":"x","commitHash":null}],
				 "references":{"jira:KAN-5":{"source":"jira","nativeId":"KAN-5","title":"Fix it",
				           "url":"https://example/KAN-5","sourcePath":"/p/KAN-5.md","addedAt":"x",
				           "updatedAt":"x","sourceToolName":"mcp__atlassian__getJiraIssue"}},
				 "exclusions":{"conversations":["c1"],"plans":["p1"],"notes":[],"references":[],
				           "skills":["claude:brainstorming"]}}
				""".trimIndent(),
				WorkingContext.ContextList::class.java,
			)
			list.plans.map { it.slug } shouldBe listOf("p1")
			list.notes.map { it.id } shouldBe listOf("n1")
			list.references.keys shouldBe setOf("jira:KAN-5")
			list.references["jira:KAN-5"]?.title shouldBe "Fix it"
			list.exclusions.plans shouldBe setOf("p1")
			list.exclusions.skills shouldBe setOf("claude:brainstorming")
		}

		/**
		 * The trap this whole file exists for: Gson writes null into a field the
		 * payload omits, and a non-null Kotlin declaration then throws on first use.
		 * Every field of [WorkingContext.ContextList] and of
		 * [CommitSelectionStore.CommitExclusions] has a default, so Kotlin synthesises
		 * the no-arg constructor Gson needs and an empty object degrades to empty
		 * collections instead. Adding a field WITHOUT a default silently re-opens it.
		 */
		@Test
		fun `an empty object degrades to empty sections rather than nulls`() {
			val list = gson.fromJson("{}", WorkingContext.ContextList::class.java)
			list.plans shouldBe emptyList()
			list.notes shouldBe emptyList()
			list.references shouldBe emptyMap()
			list.exclusions.conversations shouldBe emptySet()
			list.exclusions.plans shouldBe emptySet()
			list.exclusions.notes shouldBe emptySet()
			list.exclusions.references shouldBe emptySet()
			list.exclusions.skills shouldBe emptySet()
		}
	}

	@Nested
	inner class ActiveForCommitWire {

		@Test
		fun `reads all three kinds, the reference title and the exclude set`() {
			val active = gson.fromJson(
				"""
				{"plans":[{"slug":"p1","title":"P","sourcePath":"/p/p1.md","addedAt":"x",
				           "updatedAt":"x","commitHash":null}],
				 "notes":[],
				 "references":[{"mapKey":"jira:KAN-5","source":"jira","sourcePath":"/p/KAN-5.md",
				                "title":"Fix it"}],
				 "exclusions":{"conversations":[],"plans":["p1"],"notes":[],"references":[],
				                "skills":[]}}
				""".trimIndent(),
				WorkingContext.ActiveForCommit::class.java,
			)
			active.plans.map { it.slug } shouldBe listOf("p1")
			active.notes shouldBe emptyList()
			active.references.map { it.mapKey } shouldBe listOf("jira:KAN-5")
			// Carried by the CLI so the review never re-reads plans.json to label a row.
			active.references[0].title shouldBe "Fix it"
			active.exclusions.plans shouldBe setOf("p1")
		}

		// An older CLI omits `title` and `exclusions`; neither may deserialize into a
		// non-null field, and the review must still render.
		@Test
		fun `tolerates a payload from a CLI that sends neither title nor exclusions`() {
			val active = gson.fromJson(
				"""{"plans":[],"notes":[],"references":[{"mapKey":"jira:KAN-5","source":"jira",
				   "sourcePath":"/p/KAN-5.md"}]}""".trimIndent(),
				WorkingContext.ActiveForCommit::class.java,
			)
			active.references[0].title.shouldBeNull()
			active.exclusions.references shouldBe emptySet()
		}
	}
}
