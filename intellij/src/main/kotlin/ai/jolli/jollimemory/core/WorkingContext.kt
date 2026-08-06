package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.core.references.ReferenceEntry
import ai.jolli.jollimemory.core.references.SourceId
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject

/**
 * Thin JVM adapter for the CLI-owned working-area context: the plans, notes and
 * references a worktree carries before a commit claims them.
 *
 * Every function here is one `working-context` bridge round-trip into
 * `cli/src/core/{PlanService,NoteService,references/ReferenceService}` — the same
 * functions the VS Code extension calls in-process. This file must stay an
 * adapter: it serialises arguments and deserialises DTOs, and decides nothing.
 *
 * Do NOT reintroduce Kotlin-side registry rules. Visibility filters ("is this
 * row an archive guard / a committed snapshot / an orphan?") and delete
 * semantics ("does removing this row also unlink its backing file?") are
 * data-model questions, and a Kotlin restatement of them cannot be checked
 * against the TypeScript one — nothing on the JSON wire fails when the two
 * disagree. The re-implementation this file replaced had drifted into treating a
 * hard delete as a soft one and unlinking a different set of files than VS Code
 * did for the same user action. Presentation (row order in a panel, icons,
 * dialogs) stays here; meaning does not.
 */
object WorkingContext {
	private val gson: Gson = GsonBuilder().serializeNulls().create()
	private const val ACTION = "working-context"

	/** Display projection of a plan row — Kotlin port of the CLI's `PlanInfo`. */
	data class PlanInfo(
		val slug: String,
		val filename: String,
		val filePath: String,
		val title: String,
		val lastModified: String,
		val addedAt: String,
		val updatedAt: String,
		val commitHash: String?,
	)

	/** Display projection of a note row — Kotlin port of the CLI's `NoteInfo`. */
	data class NoteInfo(
		val id: String,
		val title: String,
		val format: NoteFormat,
		val lastModified: String,
		val addedAt: String,
		val updatedAt: String,
		val commitHash: String?,
		val filename: String? = null,
		val filePath: String? = null,
	)

	/** One `~/.claude/plans/` file not yet in the registry, for the Add Plan picker. */
	data class AvailablePlan(
		val slug: String,
		val title: String,
		/**
		 * File mtime in WHOLE milliseconds, for ordering the picker.
		 *
		 * `Long` only works because the CLI truncates: `statSync().mtimeMs` carries
		 * sub-millisecond precision on APFS and ext4 alike, and Gson's
		 * `JsonReader.nextLong` REJECTS a fractional literal rather than truncating
		 * it — so the raw value failed the whole response and took the Add Plan
		 * picker with it. `listAvailablePlans` in `cli/src/core/PlanService.ts` owns
		 * that truncation; if this ever widens to a float, widen the field too.
		 */
		val mtimeMs: Long,
	)

	private data class PlansResponse(val plans: List<PlanInfo> = emptyList())

	private data class NotesResponse(val notes: List<NoteInfo> = emptyList())

	private data class AvailablePlansResponse(val plans: List<AvailablePlan> = emptyList())

	private data class RegisterNewResponse(val accepted: List<String> = emptyList())

	private data class ArchiveResponse(val reference: PlanReference? = null)

	private data class NoteResponse(val note: NoteInfo? = null)

	/** Everything the browsable CONTEXT panel renders. See [contextList]. */
	data class ContextList(
		val plans: List<PlanInfo> = emptyList(),
		val notes: List<NoteInfo> = emptyList(),
		/** Registry rows keyed `<source>:<nativeId>` — every one is active. */
		val references: Map<String, ReferenceEntry> = emptyMap(),
		val exclusions: CommitSelectionStore.CommitExclusions = CommitSelectionStore.CommitExclusions(),
	)

	// ── Plans ───────────────────────────────────────────────────────────────

	/**
	 * Visible plans for the CONTEXT panel, already filtered and sorted by the CLI.
	 *
	 * Uncommitted plans are deliberately NOT branch-scoped: working-area context
	 * belongs to the worktree and binds to a branch only at commit, exactly like
	 * an uncommitted code change. Do not add a branch filter on top of this list.
	 *
	 * Prefer [contextList] when the caller also needs notes, references or the
	 * exclude set — the panel repaint used to be four separate round-trips.
	 */
	fun detectPlans(cwd: String): List<PlanInfo> =
		gson.fromJson(run(cwd, request("plans-detect")), PlansResponse::class.java).plans

	fun listAvailablePlans(cwd: String, excludeSlugs: Set<String>): List<AvailablePlan> {
		val req = request("plans-list-available").apply { add("excludeSlugs", gson.toJsonTree(excludeSlugs)) }
		return gson.fromJson(run(cwd, req), AvailablePlansResponse::class.java).plans
	}

	fun addPlan(cwd: String, slug: String) {
		run(cwd, request("plans-add").apply { addProperty("slug", slug) })
	}

	/**
	 * Registers plan files that just APPEARED in the machine-global
	 * `~/.claude/plans/`, so a plan reaches the panel while the session is still
	 * running instead of at the agent's next Stop.
	 *
	 * [names] are raw directory entries (`<slug>.md`) exactly as the OS reported
	 * them — do NOT strip the extension, filter to markdown, or check the file
	 * still exists here. All three are rules, and all three already exist once in
	 * `PlanService`; the plans dir is shared by every project on the machine, so
	 * "which of these are ours?" in particular is the kind of predicate that has
	 * drifted before. This host contributes the filenames and nothing else.
	 *
	 * Returns the slugs the CLI accepted (passed every filter and were handed to
	 * `registerNewPlan`) — a diagnostic, not a promise that a row changed:
	 * registering an already-tracked slug is a no-op there.
	 */
	fun registerNewPlans(cwd: String, names: List<String>): List<String> {
		if (names.isEmpty()) return emptyList()
		val req = request("plans-register-new").apply { add("names", gson.toJsonTree(names)) }
		return gson.fromJson(run(cwd, req), RegisterNewResponse::class.java).accepted
	}

	/**
	 * Hard-removes a plan row. The backing file is unlinked only when it lives
	 * inside `.jolli/jollimemory/` — the CLI owns that rule; the panel must not
	 * delete plan files itself.
	 */
	fun removePlan(cwd: String, slug: String, expectedCommitHash: String? = null) {
		val req = request("plans-remove").apply {
			addProperty("slug", slug)
			if (expectedCommitHash != null) addProperty("expectedCommitHash", expectedCommitHash)
		}
		run(cwd, req)
	}

	/**
	 * Syncs a plan row's title after its markdown was edited, keeping the sidebar
	 * and the commit summary in agreement. Unknown slug is a no-op.
	 */
	fun renamePlanTitle(cwd: String, slug: String, title: String) {
		val req = request("plans-rename-title").apply {
			addProperty("slug", slug)
			addProperty("title", title)
		}
		run(cwd, req)
	}

	/** Archives a plan onto a commit; returns the `CommitSummary.plans` pointer. */
	fun archivePlanForCommit(cwd: String, slug: String, commitHash: String): PlanReference? {
		val req = request("plans-archive-for-commit").apply {
			addProperty("slug", slug)
			addProperty("commitHash", commitHash)
		}
		return gson.fromJson(run(cwd, req), ArchiveResponse::class.java).reference
	}

	/**
	 * Deletes the user-visible `<branch>/plan--<slug>.md` from the Memory Bank folder
	 * after a plan was dissociated from a commit, so the tree stops showing a file
	 * whose memory no longer references it.
	 *
	 * Paired with [removePlan], not folded into it: `removePlan` is also the sidebar's
	 * "remove this live plan" path, where no commit — and therefore no branch folder —
	 * is involved. Call this only when dissociating from a commit, with that commit's
	 * branch. A no-op in orphan-only storage mode, decided CLI-side.
	 */
	fun cleanupVisiblePlanArtifact(cwd: String, slug: String, branch: String) {
		val req = request("plans-cleanup-visible").apply {
			addProperty("slug", slug)
			addProperty("branch", branch)
		}
		run(cwd, req)
	}

	// ── Notes ───────────────────────────────────────────────────────────────

	/** Visible notes for the CONTEXT panel. Not branch-scoped — see [detectPlans]. */
	fun detectNotes(cwd: String): List<NoteInfo> =
		gson.fromJson(run(cwd, request("notes-detect")), NotesResponse::class.java).notes

	/**
	 * Creates or updates a note.
	 *
	 * @param id existing note id to update, or null to create a new one
	 * @param content snippet text for [NoteFormat.snippet]; the source file path
	 *   for a new [NoteFormat.markdown] note (the CLI references it in place)
	 */
	fun saveNote(cwd: String, id: String?, title: String, content: String, format: NoteFormat): NoteInfo? {
		val req = request("notes-save").apply {
			if (id != null) addProperty("id", id)
			addProperty("title", title)
			addProperty("content", content)
			addProperty("format", format.name)
		}
		return gson.fromJson(run(cwd, req), NoteResponse::class.java).note
	}

	/**
	 * Hard-removes a note row. As with [removePlan], whether the backing file is
	 * unlinked is the CLI's decision, not the caller's.
	 */
	fun removeNote(cwd: String, id: String, expectedCommitHash: String? = null) {
		val req = request("notes-remove").apply {
			addProperty("id", id)
			if (expectedCommitHash != null) addProperty("expectedCommitHash", expectedCommitHash)
		}
		run(cwd, req)
	}

	// ── References ──────────────────────────────────────────────────────────

	/** Hard-removes a reference row (`<source>:<nativeId>`) and its markdown file. */
	fun removeReference(cwd: String, mapKey: String) {
		run(cwd, request("references-remove").apply { addProperty("mapKey", mapKey) })
	}

	// ── Cross-kind ──────────────────────────────────────────────────────────

	/**
	 * Plans, notes, references and the exclude set for the CONTEXT panel, in ONE
	 * round-trip.
	 *
	 * Replaces four separate calls (`plans-detect`, `notes-detect`, a raw
	 * `plans-load`, and `selection-read`), which also meant three independent
	 * reads of `plans.json` per repaint. That was tolerable while the panel only
	 * refreshed on a status recompute; it is not now that the working-context
	 * channel repaints it whenever a plan file is saved anywhere on the machine.
	 *
	 * NOT interchangeable with [activeForCommit] — see its docstring. This is the
	 * browsable set; that one is the archive-selection set.
	 */
	fun contextList(cwd: String): ContextList =
		gson.fromJson(run(cwd, request("context-list")), ContextList::class.java)

	/** One reference the next commit would claim. */
	data class ActiveReference(
		val mapKey: String,
		val source: SourceId?,
		val sourcePath: String,
		/**
		 * Row title, carried by the CLI so this host does not compose one. Nullable
		 * only to survive a payload from an older CLI; a current one always sends it.
		 */
		val title: String? = null,
	)

	/** Everything the next commit would claim, plus the exclude set, in one round-trip. */
	data class ActiveForCommit(
		val plans: List<PlanEntry> = emptyList(),
		val notes: List<NoteEntry> = emptyList(),
		val references: List<ActiveReference> = emptyList(),
		val exclusions: CommitSelectionStore.CommitExclusions = CommitSelectionStore.CommitExclusions(),
	)

	/**
	 * Plans, notes and references the NEXT commit would archive, plus the exclude
	 * set that decides which of them render struck through.
	 *
	 * Narrower than [detectPlans] / [detectNotes], which drive a browsable panel
	 * and keep a revived guard (a committed row whose file changed again) visible.
	 * This is the archive-selection set: only rows no commit has claimed at all.
	 * Both rules live CLI-side — pick the one that matches the question being
	 * asked rather than filtering either result further here.
	 *
	 * One round-trip, like [contextList]: the Working Memory review used to make
	 * three (this, `selection-read`, and a raw `plans-load` purely to label the
	 * reference rows), and it repaints whenever a plan file is saved anywhere on
	 * the machine.
	 */
	fun activeForCommit(cwd: String): ActiveForCommit =
		gson.fromJson(run(cwd, request("active-for-commit")), ActiveForCommit::class.java)

	// ── Internals ───────────────────────────────────────────────────────────

	private fun request(operation: String): JsonObject = JsonObject().apply { addProperty("operation", operation) }

	private fun run(cwd: String, request: JsonObject): com.google.gson.JsonElement =
		CliIntegrations.runIdeBridge(cwd, ACTION, gson.toJson(request))
}
