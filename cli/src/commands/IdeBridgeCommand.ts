/**
 * Hidden JSON bridge used by IDE hosts that cannot import the TypeScript core.
 *
 * VS Code imports `cli/src/**` in-process. IntelliJ runs on the JVM, so it sends
 * one JSON request to `jolli ide-bridge <action>` and reads one JSON response.
 * Keeping every action here makes the CLI implementation the single source of
 * truth while the IntelliJ side remains a process/DTO adapter.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { LiveSharePatch, LiveSharePayload } from "../core/JolliShareClient.js";
import type { SkillTableRow } from "../core/SkillsAggregateMarkdown.js";
import { runWithTrace } from "../core/TraceContext.js";
import type { TranscriptRepairState } from "../core/TranscriptRepair.js";
import { buildRefreshParams, computeWatchTargets } from "../daemon/DaemonServer.js";
import { DaemonWatcher } from "../daemon/DaemonWatcher.js";
import { recordMemoryEdit } from "../dashboard/ProducerHooks.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { ConflictUi, Tier3Pick } from "../sync/ConflictResolver.js";
import type { FileWrite, JolliMemoryConfig, LocalAgentToolId, TranscriptSource } from "../Types.js";
import { TRANSCRIPT_SOURCES as ALL_TRANSCRIPT_SOURCES } from "../Types.js";
import { IDE_BRIDGE_STDIN_MAX_BYTES, readStdin } from "./CliUtils.js";

const log = createLogger("IdeBridge");

type JsonObject = Record<string, unknown>;

// Derived from the SINGLE source of truth in Types.ts so a new transcript
// source (Cline / Devin / Antigravity) becomes acceptable here automatically —
// the pre-fix inline list drifted 7-vs-12 and made transcript/overlay actions
// reject valid sources the aggregator was already emitting.
const TRANSCRIPT_SOURCES: ReadonlySet<TranscriptSource> = new Set(ALL_TRANSCRIPT_SOURCES);

function parseRequest(raw: string): JsonObject {
	if (raw.trim().length === 0) return {};
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Bridge request must be a JSON object.");
	}
	return parsed as JsonObject;
}

// Custom errors carry structured detail (AmbiguousHashError.prefix,
// SyncBackendError.status, ...) that IDE hosts render as part of the failure
// message. The one-shot and long-lived error envelopes both forward primitive
// extras so the two shapes stay identical, but the copier MUST NOT leak a
// credential a caller has stashed on the Error — nothing on the CLI side stops
// a future author from writing `err.jolliApiKey = cfg.jolliApiKey` for context.
// Two barriers below, either drops the field:
//   1. key name matches a common secret naming pattern
//      (api-key / token / secret / password / credential / authorization),
//   2. string value looks like a Jolli API key or a JWT.
// Non-string primitives are safe from #2 but still pass #1.
const SENSITIVE_ERROR_KEY_PATTERN = /api[-_]?key|token|secret|password|passwd|credential|authorization|bearer/i;
const SENSITIVE_ERROR_VALUE_PATTERN = /^(?:sk-jol-|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$)/;

function copyPrimitiveErrorFields(error: unknown, data: Record<string, unknown>): void {
	if (typeof error !== "object" || error === null) return;
	for (const [key, value] of Object.entries(error)) {
		if (key === "name" || key === "message" || key === "stack") continue;
		if (SENSITIVE_ERROR_KEY_PATTERN.test(key)) continue;
		if (typeof value === "string") {
			if (SENSITIVE_ERROR_VALUE_PATTERN.test(value)) continue;
			data[key] = value;
		} else if (typeof value === "number" || typeof value === "boolean") {
			data[key] = value;
		}
	}
}

function stringField(request: JsonObject, key: string): string {
	const value = request[key];
	if (typeof value !== "string") throw new Error(`Request field "${key}" must be a string.`);
	return value;
}

function optionalString(request: JsonObject, key: string): string | undefined {
	const value = request[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`Request field "${key}" must be a string.`);
	return value;
}

function stringArrayField(request: JsonObject, key: string): string[] {
	const value = request[key];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`Request field "${key}" must be an array of strings.`);
	}
	return value;
}

/**
 * Required boolean. Throws rather than coercing, matching [stringField] /
 * [numberField]: for a field that IS the payload of a state-changing write, there is
 * no safe direction to default to, and a silent `false` would be the dangerous one.
 */
function booleanField(request: JsonObject, key: string): boolean {
	const value = request[key];
	if (typeof value !== "boolean") throw new Error(`Request field "${key}" must be a boolean.`);
	return value;
}

/**
 * The `skills` field as aggregate-table rows.
 *
 * Validated only as far as {@link buildSkillsSummaryLabel} actually reads it — the
 * caller may send either side of the commit boundary (live `ActiveSkill` rows or
 * archived `SkillCommitRef`s), and both are deliberately wider than the row type.
 * Rejecting anything beyond "array of objects" would couple this to whichever of
 * the two shapes was passed.
 */
function skillTableRows(request: JsonObject): SkillTableRow[] {
	const value = request.skills;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null)) {
		throw new Error('Request field "skills" must be an array of objects.');
	}
	return value as SkillTableRow[];
}

function numberField(request: JsonObject, key: string): number {
	const value = request[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Request field "${key}" must be a finite number.`);
	}
	return value;
}

function optionalNumberField(request: JsonObject, key: string, fallback: number): number {
	const value = request[key];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Request field "${key}" must be a finite number.`);
	}
	return value;
}

export interface IdeBridgeConflictDetail {
	readonly path: string;
	readonly ours: string | null;
	readonly theirs: string | null;
}

/** Conflict UI that records prompt data for the IDE and replays IDE-selected choices on the next bridge call. */
export class IdeBridgeConflictUi implements ConflictUi {
	readonly details: IdeBridgeConflictDetail[] = [];
	private readonly seen = new Set<string>();

	constructor(private readonly choices: Readonly<Record<string, "mine" | "theirs">>) {}

	async promptBinaryPick(path: string, ours: string | null, theirs: string | null): Promise<Tier3Pick> {
		const choice = this.choices[path];
		if (choice === "mine" || choice === "theirs") return choice;
		if (!this.seen.has(path)) {
			this.seen.add(path);
			this.details.push({ path, ours, theirs });
		}
		return "skip";
	}
}

function conflictChoices(request: JsonObject): Record<string, "mine" | "theirs"> {
	const raw = request.conflictChoices;
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error('Request field "conflictChoices" must be an object.');
	}
	const choices: Record<string, "mine" | "theirs"> = {};
	for (const [path, value] of Object.entries(raw)) {
		if (value !== "mine" && value !== "theirs") {
			throw new Error(`Conflict choice for "${path}" must be "mine" or "theirs".`);
		}
		choices[path] = value;
	}
	return choices;
}

/**
 * Bridge operations that put the user's data somewhere. Gated on the manual
 * opt-out below; every other operation stays readable while disabled, exactly
 * like the Settings dialog does (see `repo-hooks`' own gate).
 *
 * `ensure` is deliberately absent: it creates an empty container, and the
 * install flow that calls it is already gated at its own action.
 */
const STORAGE_WRITE_OPERATIONS: ReadonlySet<string> = new Set(["write"]);
const SUMMARY_STORE_WRITE_OPERATIONS: ReadonlySet<string> = new Set([
	"store-summary",
	"store-files",
	"write-plan",
	"write-reference",
	"write-transcript-batch",
]);

/** What a refused write answers. See {@link refuseWriteIfManuallyDisabled}. */
const MANUALLY_DISABLED_RESULT = { ok: false, manuallyDisabled: true } as const;

/**
 * `jolli disable` must stop bridge writes, and only this layer can enforce it.
 *
 * The providers' own `isManuallyDisabled()` gate cannot: it reads a
 * process-local boolean in `Logger.ts` that ONLY the VS Code extension host
 * ever sets (`Extension.ts` activate/enable/disable). `ide-bridge-serve` is a
 * CLI process, where — as Logger's own docstring states — the in-memory flag is
 * inert. Nothing else covers this path either: the argument that "disable
 * uninstalls the git hooks, so no new writer starts" does not apply to a
 * long-lived server the JVM host already has running, and every backend has the
 * same bare in-memory gate, so the exposure is not specific to one route.
 *
 * `readManualDisableFlag` is the disk-backed, async read, and it answers the
 * single `manuallyDisabled` switch — the retired `userDisabled` is only folded
 * onto it on read, never consulted for a decision of its own. What must stay
 * true of that switch is that the cutover fence is NOT folded into it: a
 * composite (the fence was folded in once) would stop the new runtime on
 * exactly the repos whose orphan branch is frozen, i.e. the ones where SQLite
 * is the only place a memory can go.
 *
 * Checked BEFORE the write path takes its orphan-write lock, same as the
 * `repo-hooks` action: a disabled repo should not contend for a lock, and the
 * flag is stable across it.
 *
 * The refusal is explicit (`ok: false`) rather than a silent `{ ok: true }`.
 * A host told the write succeeded when nothing was written has no way to
 * notice; an older plugin that drops the unknown `manuallyDisabled` field still
 * sees a failed write, which is the safer of the two things to be wrong about.
 */
async function refuseWriteIfManuallyDisabled(
	cwd: string,
	operation: string,
	writeOperations: ReadonlySet<string>,
): Promise<typeof MANUALLY_DISABLED_RESULT | null> {
	if (!writeOperations.has(operation)) return null;
	const { readManualDisableFlag } = await import("../core/RepoProfile.js");
	return (await readManualDisableFlag(cwd)) ? MANUALLY_DISABLED_RESULT : null;
}

async function runStorageAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const refused = await refuseWriteIfManuallyDisabled(cwd, operation, STORAGE_WRITE_OPERATIONS);
	if (refused) return refused;
	const { createStorage } = await import("../core/StorageFactory.js");
	const storage = await createStorage(cwd, cwd);
	switch (operation) {
		case "read":
			return { content: await storage.readFile(stringField(request, "path")) };
		case "list":
			return { paths: await storage.listFiles(stringField(request, "prefix")) };
		case "batch-read": {
			// One bridge round trip for N paths. Without this, IntelliJ's move off
			// the folder reader turns every list-then-read screen into N CLI
			// subprocesses — the plan's G.3 calls this out as a same-PR requirement.
			const paths = request.paths;
			if (!Array.isArray(paths)) throw new Error('Request field "paths" must be an array.');
			// batchReadFiles is optional on the interface; a provider without it
			// still answers, just without the single-round-trip optimization.
			const contents = storage.batchReadFiles
				? await storage.batchReadFiles(paths as string[])
				: new Map(
						await Promise.all(
							(paths as string[]).map(async (p) => [p, await storage.readFile(p)] as const),
						),
					);
			return { contents: Object.fromEntries(contents) };
		}
		case "exists":
			return { exists: await storage.exists() };
		case "ensure":
			await storage.ensure();
			return { ok: true };
		case "write": {
			const files = request.files;
			if (!Array.isArray(files)) throw new Error('Request field "files" must be an array.');
			// Under orphan-write.lock: this action exposes bare writeFiles to the
			// IDE, and an unlocked orphan write can land on the branch between
			// the cutover's compare and its CAS tip-check (D6 invariant).
			//
			// MUST-LAND budget, not the background one. `ide-bridge-serve` dispatches
			// request lines concurrently, and the re-entrancy store only propagates
			// down the holder's own await chain — so a second write request in flight
			// is a genuine competitor for a file lock that refuses even its own PID.
			// On the 1 s background budget it simply failed, and the JVM host does not
			// retry; 30 s waits out the ~50-200 ms held window instead.
			// Lazily imported like every other SummaryStore use here — a static import
			// would pull that module's graph into CLI startup.
			const { withRequiredOrphanWriteLock } = await import("../core/SummaryStore.js");
			await withRequiredOrphanWriteLock(cwd, "ide-bridge storage.write", () =>
				storage.writeFiles(files as FileWrite[], stringField(request, "message")),
			);
			return { ok: true };
		}
		default:
			throw new Error(`Unknown storage operation "${operation}".`);
	}
}

async function runConversationOverlayAction(cwd: string, request: JsonObject): Promise<unknown> {
	const source = stringField(request, "source") as TranscriptSource;
	if (!TRANSCRIPT_SOURCES.has(source)) throw new Error(`Unknown transcript source "${source}".`);
	const sessionId = stringField(request, "sessionId");
	const operation = stringField(request, "operation");
	if (operation === "hide") {
		const { hideConversation } = await import("../core/HiddenConversationsStore.js");
		await hideConversation(cwd, source, sessionId);
		return { ok: true };
	}
	const overlayStore = await import("../core/ConversationOverlayStore.js");
	const key = { projectDir: cwd, source, sessionId };
	if (operation === "view") {
		if (!Array.isArray(request.entries)) throw new Error('Request field "entries" must be an array.');
		const entries = request.entries as Parameters<typeof overlayStore.applyOverlay>[0];
		const overlay = await overlayStore.loadOverlay(key);
		return {
			overlay,
			displayed: overlayStore.applyOverlay(entries, overlay),
			rawWithDeletesOnly: overlayStore.applyDeletes(entries, overlay),
		};
	}
	if (operation === "merge-save") {
		if (!Array.isArray(request.deletes) || !Array.isArray(request.edits)) {
			throw new Error('Request fields "deletes" and "edits" must be arrays.');
		}
		const existing = await overlayStore.loadOverlay(key);
		const merged = overlayStore.mergeOverlay(existing, {
			deletes: request.deletes as Parameters<typeof overlayStore.mergeOverlay>[1]["deletes"],
			edits: request.edits as Parameters<typeof overlayStore.mergeOverlay>[1]["edits"],
		});
		return overlayStore.saveOverlay(key, merged);
	}
	throw new Error(`Unknown conversation-overlay operation "${operation}".`);
}

/**
 * Working-area context CRUD — the plans / notes / references a worktree carries
 * before they are claimed by a commit.
 *
 * Every operation here delegates to the shared services in `cli/src/core`
 * (`PlanService`, `NoteService`, `references/ReferenceService`), which VS Code
 * calls in-process. This action is the ONLY sanctioned way for a JVM host to
 * mutate or list that state: a Kotlin re-implementation of these rules drifted
 * silently from the TypeScript one (soft-delete that was really a hard delete,
 * a different predicate deciding which backing files got unlinked), because
 * nothing on the JSON wire fails when the two disagree.
 *
 * Note the deliberate asymmetry with `session-state`'s `plans-load` /
 * `plans-save`: those move the whole registry and exist for callers that own a
 * read-modify-write cycle. The operations here are the semantic ones — prefer
 * them, and reach for the raw pair only when no semantic operation fits.
 */
async function runWorkingContextAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	switch (operation) {
		// ── Plans ──────────────────────────────────────────────────────────
		case "plans-detect": {
			const { detectPlans } = await import("../core/PlanService.js");
			return { plans: await detectPlans(cwd) };
		}
		case "plans-list-available": {
			const { listAvailablePlans } = await import("../core/PlanService.js");
			return { plans: listAvailablePlans(new Set(stringArrayField(request, "excludeSlugs"))) };
		}
		case "plans-add": {
			const { addPlanToRegistry } = await import("../core/PlanService.js");
			await addPlanToRegistry(stringField(request, "slug"), cwd);
			return { ok: true };
		}
		/**
		 * Registers plan files that just APPEARED in the machine-global
		 * `~/.claude/plans/`, so a plan shows up while the session is still
		 * running instead of at the agent's next Stop.
		 *
		 * The JVM-host counterpart of the VS Code plans-dir watcher's
		 * `onDidCreate` → `isPlanFromCurrentProject` → `registerNewPlan` chain
		 * (`vscode/src/stores/PlansStore.ts`), and deliberately the same three
		 * steps in the same order — the host contributes only the filenames the
		 * OS reported, which is the one thing it has and the CLI does not.
		 *
		 * `names` are raw directory entries (`<slug>.md`), NOT slugs: deriving
		 * the slug, skipping non-markdown, and deciding project affinity are
		 * rules, and a Kotlin restatement of them is exactly the drift this
		 * bridge exists to prevent. Unknown / stale / foreign names are dropped
		 * silently — `~/.claude/plans/` is shared by every project on the
		 * machine, so a name this project should ignore is the common case,
		 * not an error.
		 *
		 * ONE host difference is inherent and is NOT drift to "fix": VS Code wires
		 * this to `onDidCreate` only (its `onDidChange` just refreshes), while the
		 * daemon feeds it from `fs.watch`, which cannot distinguish a create from a
		 * content edit. So an edit to an already-known plan reaches here on the JVM
		 * host and not on VS Code. It is invisible for a tracked slug (the fast path
		 * below skips it) and for a foreign one (attribution says no). It is visible
		 * in exactly one case: a plan the user explicitly REMOVED from the sidebar.
		 * `removePlan` leaves no tombstone, so the slug is untracked again, and the
		 * agent's next write to that file re-registers it here — where VS Code would
		 * wait for the StopHook to do the same thing at turn end. Same end state,
		 * earlier. Reviving on edit is a consequence of hard-delete semantics, not of
		 * this handler; the place to change it would be a tombstone in `plans.json`,
		 * which the working-area contract deliberately does not have.
		 */
		case "plans-register-new": {
			// Validated and short-circuited before any I/O — an empty burst is a
			// normal outcome of the caller's own filtering, not a reason to read
			// the registry.
			const names = stringArrayField(request, "names");
			if (names.length === 0) return { accepted: [] };
			const { existsSync } = await import("node:fs");
			const { basename, join } = await import("node:path");
			const { getClaudePlansDir, isPlanFromCurrentProject, registerNewPlan } = await import(
				"../core/PlanService.js"
			);
			const tracker = await import("../core/SessionTracker.js");
			const plansDir = getClaudePlansDir();
			// One registry read for the whole burst, used purely as a fast path
			// (see the `tracked` check below). `registerNewPlan` re-reads under
			// plans.lock, so this snapshot never decides a write — going stale
			// between here and there only costs a redundant no-op call.
			const tracked = new Set(Object.keys((await tracker.loadPlansRegistry(cwd)).plans));
			// `accepted`, not `registered`: these are the slugs that passed every
			// filter and were handed to registerNewPlan. Claiming a write happened
			// would be a guess — the caller uses this as a diagnostic, and its
			// own refresh reads the registry back either way.
			const accepted: string[] = [];
			for (const name of names) {
				// A directory entry has no path component. Anything else is
				// either a client bug or an attempt to walk out of plansDir —
				// both get dropped rather than joined.
				if (name !== basename(name) || !name.endsWith(".md")) continue;
				const slug = name.slice(0, -".md".length);
				if (slug.length === 0) continue;
				// Cheap checks BEFORE `isPlanFromCurrentProject`, which reads every
				// active transcript in full (a Claude Code JSONL is routinely tens of
				// MB) to substring-match the path. `fs.watch` fires on content edits
				// too, not just creates, so a user iterating on one plan would
				// otherwise re-scan every transcript on every save — in every open
				// project, since the plans dir is machine-global. An already-tracked
				// slug is the common case there and `registerNewPlan` would no-op on
				// it anyway, so attribution has nothing left to decide.
				//
				// KNOWN LIMIT, deliberately left as-is — not a review finding. This fast
				// path only covers slugs THIS project has registered, and a plan owned by
				// another project never enters this registry, so every edit to one does
				// reach the scan below. Bounded rather than unbounded: `loadAllSessions`
				// prunes stale entries, so a project with no live session returns [] and
				// `isPlanFromCurrentProject` exits before reading anything. Neither
				// obvious mitigation is free — an mtime check cannot help (fs.watch fires
				// BECAUSE the file changed, so mtime has always advanced), and a
				// time-boxed negative cache would delay legitimate attribution, which is
				// the one thing this path exists to make faster than the StopHook. Fixing
				// it is a cost-vs-latency product call, so it is out of scope here.
				if (tracked.has(slug)) continue;
				const absPath = join(plansDir, name);
				// `fs.watch` reports creates and deletes as the same event, so a
				// deleted plan arrives here indistinguishable from a new one.
				if (!existsSync(absPath)) continue;
				if (!(await isPlanFromCurrentProject(absPath, cwd))) continue;
				// Serial, not Promise.all: registerNewPlan is a load-modify-save
				// under plans.lock, and concurrent calls would queue on that lock
				// anyway. VS Code serialises the same burst through its own
				// `registerQueue` for this reason.
				await registerNewPlan(slug, cwd);
				// Keep the fast path honest within this burst: `fs.watch` can report
				// the same name twice (rename + change), and re-registering would be
				// a second lock acquisition for nothing.
				tracked.add(slug);
				accepted.push(slug);
			}
			return { accepted };
		}
		case "plans-remove": {
			const { removePlan } = await import("../core/PlanService.js");
			await removePlan(stringField(request, "slug"), cwd, optionalString(request, "expectedCommitHash"));
			return { ok: true };
		}
		case "plans-rename-title": {
			const { renamePlanTitle } = await import("../core/PlanService.js");
			await renamePlanTitle(stringField(request, "slug"), stringField(request, "title"), cwd);
			return { ok: true };
		}
		/**
		 * KNOWN ASYMMETRY, pre-existing and deliberately not closed here — not a
		 * review finding. The plan operations below have no note counterparts:
		 * neither `notes-archive-for-commit` nor a note visible-cleanup exists, so the
		 * JVM host cannot attach a note to an existing commit's memory while VS Code
		 * can (`SummaryWebviewPanel` has an add-markdown-note and an add-snippet flow
		 * calling `archiveNoteForCommit`, plus `cleanupVisibleNoteArtifact` on removal).
		 * This predates the working-context sink — the deleted Kotlin `PlanService` had
		 * no note archive either — and it is a missing FEATURE, not a broken one:
		 * IntelliJ's summary panel registers no note command at all, so nothing
		 * silently no-ops.
		 *
		 * Closing it is two bridge operations plus the whole IntelliJ side (webview
		 * commands, HTML affordances, note picker, rollback-on-archive-failure), which
		 * is why it is not bundled in here. Adding the operations alone would just be
		 * unreachable exports. See AGENTS.md → "A missing bridge operation is the
		 * OTHER way this rule gets broken".
		 */
		case "plans-archive-for-commit": {
			const [{ archivePlanForCommit }, { createStorage }] = await Promise.all([
				import("../core/PlanService.js"),
				import("../core/StorageFactory.js"),
			]);
			// Storage MUST be threaded. This is the only working-context operation that
			// writes through SummaryStore, and `resolveStorage` fails SAFE rather than
			// loud: with no storage and no `setActiveStorage` (this process never calls
			// it) it falls back to a bare OrphanBranchStorage, which preserves the
			// system of record but bypasses DualWriteStorage — so a folder-mode user
			// silently loses both the hidden JSON and the visible
			// `<branch>/plan--<slug>.md`, with nothing but one debug.log warn to show
			// it. Reads come from the orphan branch, so the sidebar looks correct and
			// the gap only surfaces as a phantom missing file later. `runStorageAction`
			// and `runSummaryStoreAction` already build storage the same way.
			return {
				reference: await archivePlanForCommit(
					stringField(request, "slug"),
					stringField(request, "commitHash"),
					cwd,
					await createStorage(cwd, cwd),
				),
			};
		}
		/**
		 * Deletes the user-visible `<branch>/plan--<slug>.md` from the Memory Bank
		 * folder after a plan is dissociated from a commit, so the tree stops showing
		 * a ghost file. No-op when the active backend has no visible layer
		 * (orphan-only mode) — `deletePlanVisibleArtifact` checks for the method.
		 *
		 * Split from `plans-remove` rather than folded into it: that operation is also
		 * the sidebar's "remove this live plan" path, where there is no commit and so
		 * no branch folder to clean, and it is called by hosts that pass no branch at
		 * all. Keeping them separate means neither has to guess.
		 *
		 * Same storage-threading requirement as the archive above, and the same
		 * reason: without it this silently no-ops instead of failing.
		 */
		case "plans-cleanup-visible": {
			const [{ deletePlanVisibleArtifact }, { createStorage }] = await Promise.all([
				import("../core/SummaryStore.js"),
				import("../core/StorageFactory.js"),
			]);
			await deletePlanVisibleArtifact(
				stringField(request, "slug"),
				stringField(request, "branch"),
				cwd,
				await createStorage(cwd, cwd),
			);
			return { ok: true };
		}
		// ── Notes ──────────────────────────────────────────────────────────
		case "notes-detect": {
			const { detectNotes } = await import("../core/NoteService.js");
			return { notes: await detectNotes(cwd) };
		}
		case "notes-save": {
			const { saveNote } = await import("../core/NoteService.js");
			const format = stringField(request, "format");
			if (format !== "markdown" && format !== "snippet") {
				throw new Error(`Request field "format" must be "markdown" or "snippet", got "${format}".`);
			}
			return {
				note: await saveNote(
					optionalString(request, "id"),
					stringField(request, "title"),
					stringField(request, "content"),
					format,
					cwd,
				),
			};
		}
		case "notes-remove": {
			const { removeNote } = await import("../core/NoteService.js");
			await removeNote(stringField(request, "id"), cwd, optionalString(request, "expectedCommitHash"));
			return { ok: true };
		}
		// ── References ─────────────────────────────────────────────────────
		case "references-remove": {
			const { removeReference } = await import("../core/references/ReferenceService.js");
			await removeReference(cwd, stringField(request, "mapKey"));
			return { ok: true };
		}
		// ── Cross-kind ─────────────────────────────────────────────────────
		/**
		 * Everything the browsable CONTEXT panel renders, in ONE round-trip.
		 *
		 * The panel needs four things together — visible plans, visible notes, the
		 * raw reference rows, and the user's exclude set — and asking for them
		 * separately made a single repaint four bridge calls and three independent
		 * reads of `plans.json`. That was tolerable while the panel only refreshed
		 * on a status recompute; it is not now that the working-context channel
		 * repaints it whenever a plan file is saved anywhere on the machine.
		 *
		 * Deliberately NOT merged with `active-for-commit`. These are the two
		 * CLI-owned visibility rules and they are not interchangeable: this one is
		 * the browsable set (a revived guard — a committed row whose file changed
		 * again — stays visible), that one is the archive-selection set (only rows
		 * no commit has claimed at all). A host must pick the one that matches the
		 * question, so they stay separate operations rather than one payload a
		 * caller could take the wrong half of.
		 *
		 * `references` is the registry map verbatim: a reference has no committed
		 * or guard state — a commit deletes the row — so every row is active.
		 */
		case "context-list": {
			const [{ detectPlans }, { detectNotes }, tracker, selection] = await Promise.all([
				import("../core/PlanService.js"),
				import("../core/NoteService.js"),
				import("../core/SessionTracker.js"),
				import("../core/CommitSelectionStore.js"),
			]);
			// Serial, not Promise.all: `detectPlans` and `detectNotes` both perform a
			// one-shot normalising write-back under plans.lock on the first refresh
			// after an upgrade, and racing them would have each build its payload from
			// a snapshot the other is about to replace.
			const plans = await detectPlans(cwd);
			const notes = await detectNotes(cwd);
			const [registry, exclusions] = await Promise.all([
				tracker.loadPlansRegistry(cwd),
				selection.readExclusions(cwd),
			]);
			return {
				plans,
				notes,
				references: registry.references ?? {},
				// Same reason `selection-read` spells it out: `skills` is optional on
				// disk, and Gson turns an absent key into a null Set that throws on
				// first use, so "nothing excluded" has to arrive as [].
				exclusions: {
					conversations: [...exclusions.conversations],
					plans: [...exclusions.plans],
					notes: [...exclusions.notes],
					references: [...exclusions.references],
					skills: [...(exclusions.skills ?? [])],
				},
			};
		}
		/**
		 * Everything the NEXT commit would claim, plus the exclude set that decides
		 * which of it is struck through — in ONE round-trip.
		 *
		 * A narrower set than `plans-detect` / `notes-detect`: those drive a
		 * browsable panel and therefore keep a revived guard (a committed row whose
		 * file changed again) visible, while this is the archive-selection set and
		 * keeps only rows no commit has claimed at all. The two rules are both
		 * CLI-owned and must not be conflated by a host.
		 *
		 * `exclusions` rides along for the same reason it does on `context-list`:
		 * every caller needs both together, and the Working Memory review was
		 * paying a second round-trip for it. The references carry their `title`
		 * (see `detectUncommittedReferenceIds`) so a host has no reason to re-read
		 * `plans.json` on the side to label a row.
		 */
		case "active-for-commit": {
			const [tracker, selection] = await Promise.all([
				import("../core/SessionTracker.js"),
				import("../core/CommitSelectionStore.js"),
			]);
			// `branch` is vestigial in all three — working-area context is not
			// branch-scoped — but the signatures still take it.
			const branch = optionalString(request, "branch") ?? "";
			// KNOWN, deliberately not changed here — not a review finding. Four of these
			// five read `plans.json` independently (each `detect*` loads the registry
			// itself, plus the explicit load for the title join), so a write landing
			// mid-flight can leave them on different snapshots. Display-only and
			// self-healing on the next refresh: a reference whose row the registry read
			// missed falls back to its bare `mapKey` for one paint, and the plans and
			// notes lists can momentarily disagree about a row that was just added.
			// Nothing is written from these, so no data is at risk.
			//
			// Collapsing it means threading one shared registry through all three
			// `detect*` helpers — commit-path functions the QueueWorker also calls — so
			// the change is materially riskier than the glitch it removes. Left for its
			// own change; do not "fix" it by post-filtering or re-reading host-side.
			const [plans, notes, referenceIds, exclusions, registry] = await Promise.all([
				tracker.detectActivePlansForBranch(cwd, branch),
				tracker.detectActiveNotesForBranch(cwd, branch),
				tracker.detectUncommittedReferenceIds(cwd, branch),
				selection.readExclusions(cwd),
				tracker.loadPlansRegistry(cwd),
			]);
			// Join the display title on here rather than widening
			// `detectUncommittedReferenceIds` (that triple is the QueueWorker's shape).
			// The join has to happen SOMEWHERE CLI-side: IntelliJ was doing it host-side
			// with its own `plans-load`, which is both a second round-trip and a second
			// answer to "what is this reference called".
			const referenceTitles = registry.references ?? {};
			const references = referenceIds.map((r) => ({ ...r, title: referenceTitles[r.mapKey]?.title ?? r.mapKey }));
			// A plan whose sourcePath belongs to a DIFFERENT git repo is dropped at the
			// archive chokepoint (`detectPlanSlugsFromRegistry`), so this op — "what the
			// next commit will claim" — must not present it as claimable. Fold the
			// foreign slugs into the returned `exclusions.plans` so the panel strikes
			// them through with the render path it already has (no host change), keeping
			// them VISIBLE rather than silently includable. Return-value only: the
			// user's on-disk manual-exclude set is untouched. Same classifier the commit
			// path uses, so pre-commit and commit agree.
			const { createPlanSourceClassifier } = await import("../core/plans/PlanContainment.js");
			const classifyPlanSource = createPlanSourceClassifier(cwd);
			const planClasses = await Promise.all(plans.map((p) => classifyPlanSource(p.sourcePath)));
			const excludedPlanSlugs = new Set(exclusions.plans);
			plans.forEach((p, i) => {
				if (planClasses[i] === "foreign") excludedPlanSlugs.add(p.slug);
			});
			return {
				plans,
				notes,
				references,
				// Materialised the same way `context-list` and `selection-read` do —
				// Gson turns an absent key into a null Set that throws on first use,
				// so "nothing excluded" has to arrive as [].
				exclusions: {
					conversations: [...exclusions.conversations],
					plans: [...excludedPlanSlugs],
					notes: [...exclusions.notes],
					references: [...exclusions.references],
					skills: [...(exclusions.skills ?? [])],
				},
			};
		}
		default:
			throw new Error(`Unknown working-context operation "${operation}".`);
	}
}

async function runSessionStateAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const tracker = await import("../core/SessionTracker.js");
	switch (operation) {
		case "global-config-dir":
			return { path: tracker.getGlobalConfigDir() };
		case "notes-dir": {
			const { join } = await import("node:path");
			const { getJolliMemoryDir } = await import("../Logger.js");
			return { path: join(getJolliMemoryDir(cwd), "notes") };
		}
		case "config-load": {
			const dir = optionalString(request, "dir");
			return dir ? tracker.loadConfigFromDir(dir) : tracker.loadConfig();
		}
		case "config-save": {
			const config = request.config as Partial<JolliMemoryConfig> | undefined;
			if (!config || typeof config !== "object") throw new Error('Request field "config" must be an object.');
			const dir = optionalString(request, "dir") ?? tracker.getGlobalConfigDir();
			// `jolliUrl` follows the key being saved — the same rule the CLI's
			// `configure --set` and the VS Code Settings panel apply (see
			// `resolveJolliUrlForKey`). This is the JVM host's ONLY config writer,
			// so it is where the rule has to live: IntelliJ's Settings dialog has
			// its own editable "Jolli API Key" field, and a key pasted there used
			// to leave `jolliUrl` naming the previous tenant while every push went
			// to the new one.
			//
			// It belongs here rather than in Kotlin for a reason that outranks the
			// usual "product rules live in cli/src": the Kotlin `JolliMemoryConfig`
			// has no `jolliUrl` field, and its Gson is `serializeNulls()`, so ADDING
			// one would make every unrelated Kotlin save (`saveDcoSignoff`,
			// `saveGlobalInstructions`, …) transmit `"jolliUrl": null` and blank the
			// value on disk. The field's absence is what keeps the shallow merge
			// preserving it; keep it absent.
			//
			// Applies to every save, not just a changed key: each Kotlin caller
			// round-trips the key already on disk, so an unrelated save also repairs
			// a `jolliUrl` that drifted before this rule existed — matching the VS
			// Code panel's re-save-repairs behavior. A cleared key arrives as `null`
			// and fails the `typeof` check, so signing out never rewrites the URL.
			//
			// The derived value deliberately OVERRIDES a `jolliUrl` in the request
			// rather than deferring to it. No caller can send one today (no Kotlin
			// field), but if one ever does and the two disagree, honouring the
			// caller would persist a pair that is known-wrong — the key is what
			// requests route on. A caller whose key carries no claim still keeps
			// its own value, since nothing is derived to override it with.
			const { resolveJolliUrlForKey } = await import("../core/JolliApiUtils.js");
			const keyTenantUrl =
				typeof config.jolliApiKey === "string" ? resolveJolliUrlForKey(config.jolliApiKey) : undefined;
			await tracker.saveConfigScoped(
				keyTenantUrl !== undefined ? { ...config, jolliUrl: keyTenantUrl } : config,
				dir,
			);
			return { ok: true };
		}
		case "plans-load":
			return tracker.loadPlansRegistry(cwd);
		case "plans-save":
			await tracker.savePlansRegistry(request.registry as Parameters<typeof tracker.savePlansRegistry>[0], cwd);
			return { ok: true };
		case "worker-busy": {
			const { getWorkerBusyState } = await import("../core/Locks.js");
			return getWorkerBusyState(cwd);
		}
		case "acquire-lock": {
			// Hold `plans.lock` on behalf of a two-phase IDE caller (Kotlin
			// TranscriptReferenceDiscovery does load → mutate → save across three
			// bridge calls and needs a shared mutex against the CLI's own
			// StopHook / QueueWorker / Codex-tick writers, which all wrap their
			// RMW in `withPlansLock`). The daemon process (this bridge) becomes
			// the PID recorded in the lock file, so releaseIfOwned in the
			// paired release-lock call correctly matches ownership.
			//
			// Concurrent acquire-lock calls to the SAME daemon+cwd serialize:
			// `isPidAlive` short-circuits when the recorded PID is the daemon's
			// own, so the second caller polls until the first releases (or the
			// caller-supplied timeout fires). That is the intended behaviour —
			// the same rule as `withPlansLock`'s "MUST NOT be nested".
			const { join } = await import("node:path");
			const { mkdir } = await import("node:fs/promises");
			const { getJolliMemoryDir } = await import("../Logger.js");
			const { acquireWithPoll } = await import("../core/LockPrimitives.js");
			const { PLANS_LOCK_FILE, DEFAULT_PLANS_LOCK_TIMEOUT_MS, DEFAULT_PLANS_LOCK_POLL_MS } = await import(
				"../core/Locks.js"
			);
			const dir = getJolliMemoryDir(cwd);
			await mkdir(dir, { recursive: true });
			const lockPath = join(dir, PLANS_LOCK_FILE);
			const timeoutMs = optionalNumberField(request, "timeoutMs", DEFAULT_PLANS_LOCK_TIMEOUT_MS);
			const pollMs = optionalNumberField(request, "pollMs", DEFAULT_PLANS_LOCK_POLL_MS);
			const acquired = await acquireWithPoll(lockPath, { timeoutMs, pollMs });
			return { acquired };
		}
		case "release-lock": {
			// PID-checked release — the paired acquire-lock recorded this
			// daemon's PID, so releaseIfOwned matches and removes the file.
			// A stray release from a caller that never acquired (or whose
			// acquire returned false) becomes a safe no-op because a
			// different-PID owner short-circuits the delete.
			const { join } = await import("node:path");
			const { getJolliMemoryDir } = await import("../Logger.js");
			const { releaseIfOwned } = await import("../core/LockPrimitives.js");
			const { PLANS_LOCK_FILE } = await import("../core/Locks.js");
			const lockPath = join(getJolliMemoryDir(cwd), PLANS_LOCK_FILE);
			await releaseIfOwned(lockPath, PLANS_LOCK_FILE);
			return { ok: true };
		}
		case "save-plugin-source":
			await tracker.savePluginSource(cwd);
			return { ok: true };
		case "save-squash-pending":
			await tracker.saveSquashPending(
				stringArrayField(request, "sourceHashes"),
				stringField(request, "expectedParentHash"),
				cwd,
			);
			return { ok: true };
		default:
			throw new Error(`Unknown session-state operation "${operation}".`);
	}
}

/**
 * Bridge equivalent of `jolli enable`. The IntelliJ plugin routes its full-enable
 * / integrations-enable through this action instead of a fresh `node Cli.js enable`
 * subprocess (see `intellij/.../CliIntegrations.enableFull`), so the ~300-600 ms
 * Node cold-start + Cli.js module-load happens ONCE per daemon lifetime rather than
 * on every enable. The daemon's readline loop dispatches this concurrently with
 * other in-flight bridge calls (fire-and-forget in the server, per-id futures on
 * the Kotlin side), so a slow enable never blocks a hot-path status/config-load
 * on the same daemon.
 *
 * Payload mirrors the CLI's `enable` flags (`--source-tag`, `--integrations-only`,
 * `--repo-hooks-only`, `--automatic`) plus the two lock-ordering flags that
 * `EnableCommand.ts` sets from the outside. Return shape is the full
 * [InstallResult] — callers key on `success` / `message` / `warnings`.
 *
 * `distDir` exists because this action runs INSIDE the daemon. `install`'s default
 * registers the running bundle's own directory, which is correct for every
 * in-process caller but wrong here: the daemon is launched from the plugin's own
 * `cli-dist` inside the IDE's plugins directory, so without this the plugin would
 * register a path that dies on plugin uninstall or an IDE major upgrade, and
 * `run-hook` exits silently by design — capture would just stop. See the `distDir`
 * option's docs.
 */
async function runInstallAction(cwd: string, request: JsonObject): Promise<unknown> {
	const { install } = await import("../install/Installer.js");
	// Only accept the two documented source values — anything else falls back to
	// "cli" so a malformed request can't smuggle a novel string into the dist-path
	// writer's identity logic.
	const rawSource = request.source;
	const source: "cli" | "vscode-extension" = rawSource === "vscode-extension" ? "vscode-extension" : "cli";
	return install(cwd, {
		source,
		sourceTag: optionalString(request, "sourceTag"),
		integrationsOnly: request.integrationsOnly === true,
		repoHooksOnly: request.repoHooksOnly === true,
		respectManualDisable: request.respectManualDisable === true,
		clearManualDisableOnSuccess: request.clearManualDisableOnSuccess === true,
		automatic: request.automatic === true,
		distDir: distDirField(request),
	});
}

/**
 * Validates an optional `distDir`. Absent → undefined, so `install` keeps its own
 * directory as before.
 *
 * Validated rather than passed through because this string is written to
 * `dist-paths/<tag>` and later handed to `run-hook`, which execs a script from it on
 * the blocking git path — the same reason `sourceTag` is re-validated at its write
 * boundary. A relative path would resolve against whatever cwd the hook happens to
 * run in, and a non-existent directory would register a dead entry that fails
 * silently, so both are rejected loudly here instead.
 */
function distDirField(request: JsonObject): string | undefined {
	const value = optionalString(request, "distDir");
	if (value === undefined) return undefined;
	if (!isAbsolute(value)) throw new Error(`Request field "distDir" must be an absolute path.`);
	if (!existsSync(value)) throw new Error(`Request field "distDir" does not exist: ${value}`);
	return value;
}

/**
 * Bridge equivalent of `jolli disable`. Same daemon-hosted rationale as
 * [runInstallAction]. Mirrors the flags `DisableCommand.ts` passes: `preserveMenu`
 * and `persistManualDisable` both derive from `!integrationsOnly`.
 *
 * Those two DERIVE rather than strict-cast (`=== true`) on purpose, even though
 * every other flag on this action strict-casts. Strict casting is the right default
 * for an untrusted field whose absence should mean "off", but these two invert that:
 * omitting `preserveMenu` means "also delete the `/jolli` umbrella skill and strip
 * the jolli section from `.git/info/exclude`", and omitting `persistManualDisable`
 * means "tear the hooks out without recording that the user asked for it", so the
 * next start silently reinstalls them. A caller that passes `{}` intending a plain
 * full disable would get neither. Deriving makes the safe reading the default and
 * still lets a caller opt out explicitly, which is exactly what the sibling
 * `case "disable"` has always done — the two must not disagree, since they wrap the
 * same [uninstall].
 *
 * Note `case "disable"` is retained rather than folded into this action despite
 * having no caller left in this repo: dist-path indirection means an already-
 * installed plugin build can resolve to a NEWER cli dist than itself, and plugin
 * versions shipped before this action existed call `"disable"`. Removing it would
 * break disable for those installs on the next CLI upgrade.
 */
async function runUninstallAction(cwd: string, request: JsonObject): Promise<unknown> {
	const { uninstall } = await import("../install/Installer.js");
	const integrationsOnly = request.integrationsOnly === true;
	return uninstall(cwd, {
		integrationsOnly,
		preserveMenu: typeof request.preserveMenu === "boolean" ? request.preserveMenu : !integrationsOnly,
		persistManualDisable:
			typeof request.persistManualDisable === "boolean" ? request.persistManualDisable : !integrationsOnly,
	});
}

/**
 * Exposes the repo-scoped `RepoProfile` fields IntelliJ needs to keep in sync with
 * VS Code — today just the `manuallyDisabled` opt-out. Kotlin has no independent
 * reader/writer for `.jolli/profile.json`, so this action is the single write
 * channel; the CLI file is the system of record and every writer takes the
 * `profile.lock` mutex, so a Kotlin caller can't clobber a concurrent
 * `jolli disable` from a terminal (or vice-versa).
 *
 * `disabled` is read with [booleanField], so a request that omits it fails loudly
 * instead of being coerced. `=== true` would have quietly turned a malformed write
 * into `manuallyDisabled=false` — a silent RE-ENABLE of the highest-priority opt-out,
 * the one direction that must never happen by accident.
 */
async function runRepoProfileAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const { readManualDisableFlag, writeManualDisableFlag } = await import("../core/RepoProfile.js");
	switch (operation) {
		case "read-manual-disable":
			return { disabled: await readManualDisableFlag(cwd) };
		case "write-manual-disable":
			await writeManualDisableFlag(cwd, booleanField(request, "disabled"));
			return { ok: true };
		default:
			throw new Error(`Unknown repo-profile operation "${operation}".`);
	}
}

async function runAuthAction(request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const auth = await import("../auth/AuthConfig.js");
	switch (operation) {
		case "site-url":
			return { url: auth.getJolliUrl() };
		case "is-signed-in":
			return { signedIn: Boolean(await auth.loadAuthToken()) };
		case "parse-api-key": {
			const { parseJolliApiKey } = await import("../core/JolliApiUtils.js");
			return { meta: parseJolliApiKey(stringField(request, "apiKey")) };
		}
		case "validate-api-key": {
			const { validateJolliApiKey } = await import("../core/JolliApiUtils.js");
			validateJolliApiKey(stringField(request, "apiKey"));
			return { ok: true };
		}
		case "assert-origin": {
			const { assertJolliOriginAllowed } = await import("../core/JolliApiUtils.js");
			assertJolliOriginAllowed(stringField(request, "origin"));
			return { ok: true };
		}
		case "should-request-fresh":
			return {
				fresh: auth.shouldRequestFreshApiKey(
					optionalString(request, "existingKey"),
					stringField(request, "jolliUrl"),
				),
			};
		case "build-login-url": {
			const { jolliPageUrl } = await import("../auth/AuthCallback.js");
			// Insertion order IS the query order: cli_callback → state → client
			// → client_version → generate_api_key → device_name → install_id.
			// The leading six match VS Code's login URL verbatim
			// (`AuthService.openSignInPage`); `install_id` is appended last
			// because VS Code sends none at all. The CLI (`auth/Login.ts`) emits
			// the same params but places `install_id` BEFORE `generate_api_key` —
			// a pinned order per surface keeps captures and server logs
			// comparable, but do not "fix" one surface to match another without
			// changing all of them.
			const params: Record<string, string> = { cli_callback: stringField(request, "callbackUrl") };
			const state = optionalString(request, "state");
			if (state) params.state = state;
			params.client = "intellij";
			params.client_version = stringField(request, "clientVersion");
			if (request.generateApiKey === true) {
				params.generate_api_key = "true";
				// `device_name` scopes the server's per-user idempotency key, so
				// signing in from a second machine mints a second key row instead
				// of invalidating the first machine's. Only meaningful when we're
				// asking for a fresh key — paired with generate_api_key, exactly
				// as in `auth/Login.ts` and VS Code's `openSignInPage`.
				//
				// Resolved here rather than passed in from Kotlin: the ide-bridge
				// runs on the user's machine (same-host daemon assumption), so
				// `getDeviceLabel()` sees the same hostname the IDE would, and
				// the sanitization stays in lockstep with the server's
				// `sanitizeDeviceLabel` for free. If that ever changes (headless
				// dev server, remote daemon), the label would report the
				// daemon's host — pass it in from the caller then.
				const { getDeviceLabel } = await import("../auth/DeviceLabel.js");
				const deviceLabel = getDeviceLabel();
				if (deviceLabel) params.device_name = deviceLabel;
			}
			const installId = optionalString(request, "installId");
			if (installId) params.install_id = installId;
			return { url: jolliPageUrl(stringField(request, "jolliUrl"), "/login", params) };
		}
		case "exchange-and-save": {
			const { exchangeAndPersist } = await import("../auth/AuthCallback.js");
			return await exchangeAndPersist(stringField(request, "jolliUrl"), stringField(request, "code"));
		}
		case "handle-auth-callback": {
			// Whole-callback handler for IDE surfaces that own a loopback
			// server (IntelliJ). The IDE forwards the raw query string and gets
			// back both the outcome and the URL to 302 the browser at, so the
			// decision tree, the credential write, and the error wording live
			// here rather than being re-ported per IDE.
			const { jolliPageUrl, resolveAuthCallback } = await import("../auth/AuthCallback.js");
			const jolliUrl = stringField(request, "jolliUrl");
			// Built (and origin-checked) BEFORE any network work: the caller
			// puts this straight into a `Location` header, so an off-allowlist
			// or malformed tenant URL must fail loudly here, not reach a
			// browser redirect.
			const completeUrl = jolliPageUrl(jolliUrl, "/cli-complete");
			const outcome = await resolveAuthCallback({
				jolliUrl,
				params: new URLSearchParams(stringField(request, "queryString")),
				expectedState: stringField(request, "expectedState"),
				// The IDE names its own recovery path ("…from Settings"), so the
				// `user_denied` sentence can't be baked into the shared table.
				retryHint: optionalString(request, "retryHint"),
			});
			if (!outcome.ok) {
				return {
					success: false,
					redirectUrl: jolliPageUrl(jolliUrl, "/cli-complete", { error: outcome.code }),
					errorCode: outcome.code,
					errorMessage: outcome.message,
				};
			}
			// Telemetry is deliberately NOT emitted here — the IDE surface
			// tracks `signin_completed` itself, and doing it in both places
			// would double-count the conversion event.
			return {
				success: true,
				redirectUrl: completeUrl,
				token: outcome.token,
				space: outcome.space ?? null,
				jolliApiKey: outcome.jolliApiKey ?? null,
			};
		}
		case "sign-out":
			await auth.clearAuthCredentials();
			return { ok: true };
		default:
			throw new Error(`Unknown auth operation "${operation}".`);
	}
}

// Operations that reach the network and therefore stamp `x-jolli-client`. Kept
// out of the client-header drift warning below because they're either pure
// local helpers (serialize-summary) or don't hit the jolli-api HTTP path.
const JOLLI_API_LOCAL_OPERATIONS = new Set(["serialize-summary"]);

async function runJolliApiAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	// The `x-jolli-client` header the bundled CLI would otherwise send
	// identifies the CLI build (`cli/<cli-version>`), not the plugin that
	// initiated the call. IDE surfaces pass `clientHeader` on every jolli-api
	// request so their traffic identifies as `intellij-plugin/<plugin-version>`
	// (etc.) — the server's per-surface min-version gate + API attribution
	// depend on it. Absent → default `JOLLI_CLIENT_HEADER` (CLI-initiated call).
	const clientHeader = optionalString(request, "clientHeader");
	// Drift guard: log a warning when a network-reaching jolli-api op arrives
	// without a `clientHeader`, so a future IDE-surface caller that forgets to
	// stamp its plugin identity gets caught in debug.log instead of silently
	// misidentifying as the bundled CLI (which would evade per-surface min-
	// version gating + skew API attribution). Non-fatal to preserve the CLI-
	// initiated path — jolli's own commands legitimately omit it.
	if (clientHeader === undefined && !JOLLI_API_LOCAL_OPERATIONS.has(operation)) {
		log.warn("jolli-api %s: no clientHeader provided; falling back to bundled CLI identity", operation);
	}
	if (operation === "serialize-summary") {
		const { serializeSummaryJson } = await import("../core/JolliMemoryPushOrchestrator.js");
		return { json: serializeSummaryJson(request.summary as Parameters<typeof serializeSummaryJson>[0]) ?? null };
	}
	// spec 306: the memory-mutating operations must consult the per-repo
	// outbound-push opt-out — the SAME gate the CLI drains, the manual/MCP push, and
	// the VS Code HTTP client use — so a host driving this bridge cannot push/delete
	// from a repo the user push-disabled. `list-spaces`/`create-binding` are reads or
	// binding metadata (not memory content); `*-share` is the separate live-share
	// channel, out of this flag's scope.
	//
	// Thrown as the NAMED `PushDisabledError` so the error envelope carries
	// `errorName: "PushDisabledError"` and an IDE host can map it back to its own
	// push-disabled type (quiet "re-enable to push" info, not a failure dialog).
	// Hosts gate before calling too, but that check and this one straddle a
	// network round trip — a flag flipped in between lands here, and with a bare
	// `Error` the host could only report it as a generic push failure.
	if (operation === "push" || operation === "delete") {
		const { isOutboundPushAllowed, PushDisabledError } = await import("../core/PushControl.js");
		if (!(await isOutboundPushAllowed(cwd))) {
			throw new PushDisabledError();
		}
	}
	const apiKey = stringField(request, "apiKey");
	const baseUrl = optionalString(request, "baseUrl");
	const { JolliMemoryPushClient } = await import("../core/JolliMemoryPushClient.js");
	const client = new JolliMemoryPushClient({
		baseUrlOverride: baseUrl,
		apiKeyProvider: async () => apiKey,
		...(clientHeader ? { clientHeaderOverride: clientHeader } : {}),
	});
	switch (operation) {
		case "push":
			return client.push(request.payload as Parameters<typeof client.push>[0]);
		case "delete":
			await client.deleteDoc(numberField(request, "docId"));
			return { ok: true };
		case "list-spaces":
			return client.listSpaces();
		case "create-binding":
			return client.createBinding({
				repoUrl: stringField(request, "repoUrl"),
				repoName: stringField(request, "repoName"),
				jmSpaceId: numberField(request, "jmSpaceId"),
			});
		case "create-share": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			return new JolliShareClient({
				apiKey,
				baseUrlOverride: baseUrl,
				...(clientHeader ? { clientHeaderOverride: clientHeader } : {}),
			}).create(request.payload as LiveSharePayload);
		}
		case "update-share": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			return new JolliShareClient({
				apiKey,
				baseUrlOverride: baseUrl,
				...(clientHeader ? { clientHeaderOverride: clientHeader } : {}),
			}).update(stringField(request, "shareId"), request.patch as LiveSharePatch);
		}
		case "revoke-share": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			await new JolliShareClient({
				apiKey,
				baseUrlOverride: baseUrl,
				...(clientHeader ? { clientHeaderOverride: clientHeader } : {}),
			}).revoke(stringField(request, "shareId"));
			return { ok: true };
		}
		case "invite-share": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			return new JolliShareClient({
				apiKey,
				baseUrlOverride: baseUrl,
				...(clientHeader ? { clientHeaderOverride: clientHeader } : {}),
			}).invite(
				stringField(request, "shareId"),
				stringArrayField(request, "recipients"),
				optionalString(request, "message"),
			);
		}
		case "list-org-members": {
			const { JolliShareClient } = await import("../core/JolliShareClient.js");
			return {
				members: await new JolliShareClient({
					apiKey,
					baseUrlOverride: baseUrl,
					...(clientHeader ? { clientHeaderOverride: clientHeader } : {}),
				}).listOrgMembers(),
			};
		}
		default:
			throw new Error(`Unknown Jolli API operation "${operation}".`);
	}
}

async function currentPinGroup(cwd: string): Promise<{ repoName: string; branch: string }> {
	const [{ getCanonicalRepoUrl, deriveRepoNameFromUrl }, { getCurrentBranch, getProjectRootDir }, path] =
		await Promise.all([import("../core/GitRemoteUtils.js"), import("../core/GitOps.js"), import("node:path")]);
	const repoUrl = await getCanonicalRepoUrl(cwd);
	const root = await getProjectRootDir(cwd).catch(() => cwd);
	return {
		repoName: repoUrl ? deriveRepoNameFromUrl(repoUrl) : path.basename(root),
		branch: await getCurrentBranch(cwd),
	};
}

function pinKind(kind: string): "conversation" | "plan" | "note" | "memory" | "reference" {
	const normalized =
		(
			{
				conversations: "conversation",
				plans: "plan",
				notes: "note",
				memories: "memory",
				references: "reference",
			} as const
		)[kind as "conversations" | "plans" | "notes" | "memories" | "references"] ?? kind;
	if (["conversation", "plan", "note", "memory", "reference"].includes(normalized)) {
		return normalized as "conversation" | "plan" | "note" | "memory" | "reference";
	}
	throw new Error(`Unknown pin kind "${kind}".`);
}

async function runSharedStoreAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	if (operation.startsWith("pins-")) {
		const pins = await import("../core/PinStore.js");
		const group = await currentPinGroup(cwd);
		if (operation === "pins-read") return { pins: await pins.listPins(cwd, group.repoName, group.branch) };
		const kind = pinKind(stringField(request, "kind"));
		const id = stringField(request, "key");
		if (operation === "pins-add") {
			const badge = optionalString(request, "badge");
			// Prefer an explicit "source" from the caller; fall back to the badge for
			// conversation pins so IntelliJ hosts that only pass a source-derived
			// badge keep populating PinEntry.source without extra plumbing.
			const source = optionalString(request, "source") ?? (kind === "conversation" ? badge : undefined);
			const transcriptPath = optionalString(request, "transcriptPath");
			await pins.addPin(cwd, group.repoName, group.branch, {
				kind,
				id,
				title: stringField(request, "title"),
				pinnedAt: Date.now(),
				...(badge !== undefined ? { badge } : {}),
				...(source !== undefined ? { source } : {}),
				...(transcriptPath !== undefined ? { transcriptPath } : {}),
			});
			return { ok: true };
		}
		if (operation === "pins-remove") {
			await pins.removePin(cwd, group.repoName, group.branch, kind, id);
			return { ok: true };
		}
	}
	if (operation.startsWith("selection-")) {
		const selection = await import("../core/CommitSelectionStore.js");
		if (operation === "selection-read") {
			const value = await selection.readExclusions(cwd);
			return {
				conversations: [...value.conversations],
				plans: [...value.plans],
				notes: [...value.notes],
				references: [...value.references],
				// Always present, even though `CommitExclusions.skills` is optional on the
				// persisted shape — it postdates the file, so a selection written before
				// skills were selectable has no such field. Omitting the key costs twice: a
				// caller that saw it vanish could not tell "nothing excluded" from a CLI too
				// old to know about skills, and the JVM adapter mirrors this shape
				// field-for-field, where Gson turns an absent key into a null Set that throws
				// on first use. So "nothing excluded" has to arrive as [], not as no key.
				skills: [...(value.skills ?? [])],
			};
		}
		if (operation === "selection-key") {
			return {
				key: selection.conversationKey(
					stringField(request, "source") as TranscriptSource,
					stringField(request, "sessionId"),
				),
			};
		}
		const kind = stringField(request, "kind") as Parameters<typeof selection.setExcluded>[1];
		if (operation === "selection-set") {
			await selection.setExcluded(cwd, kind, stringField(request, "key"), request.excluded === true);
			return { ok: true };
		}
		if (operation === "selection-set-all") {
			await selection.setAllExcluded(cwd, kind, stringArrayField(request, "keys"), request.excluded === true);
			return { ok: true };
		}
	}
	if (operation.startsWith("branch-share-")) {
		const shares = await import("../core/BranchShareStore.js");
		const branch = stringField(request, "branch");
		const commitHash = optionalString(request, "commitHash");
		if (operation === "branch-share-put") {
			await shares.putBranchShare(
				cwd,
				branch,
				request.record as Parameters<typeof shares.putBranchShare>[2],
				commitHash,
			);
			return { ok: true };
		}
		if (operation === "branch-share-remove") {
			await shares.removeShare(cwd, branch, commitHash);
			return { ok: true };
		}
		if (operation === "branch-share-get") {
			const [{ loadConfig }, { deriveJolliBackendKey, parseJolliApiKey }] = await Promise.all([
				import("../core/SessionTracker.js"),
				import("../core/JolliApiUtils.js"),
			]);
			const key = (await loadConfig()).jolliApiKey;
			const backendKey = deriveJolliBackendKey(key ? parseJolliApiKey(key)?.u : undefined);
			return { record: (await shares.getShare(cwd, branch, backendKey, commitHash)) ?? null };
		}
	}
	if (operation.startsWith("skills-")) {
		// Every skill surface an IDE renders is served from here, so the aggregate table
		// and the row that summarises it cannot disagree. IntelliJ has no Kotlin skill
		// renderer by design — see the module header of SkillProjection.
		const aggregate = await import("../core/SkillsAggregateMarkdown.js");
		if (operation === "skills-label") {
			// Takes the rows rather than reading them: the caller may be summarising an
			// ARCHIVED set off a CommitSummary, which the working registry no longer holds.
			return { label: aggregate.buildSkillsSummaryLabel(skillTableRows(request)) };
		}
		if (operation === "skills-committed-markdown") {
			// Rendered from the summary rather than read from `skills--<hash8>.md`: that
			// file only exists in the Memory Bank's visible layer, which is absent in
			// orphan-branch-only mode and for a foreign repo this machine never synced.
			const { buildSkillsAggregateMarkdown } = aggregate;
			const summary = request.summary as Parameters<typeof buildSkillsAggregateMarkdown>[0];
			const skills = summary?.skills ?? [];
			if (skills.length === 0) return { markdown: null };
			return { markdown: buildSkillsAggregateMarkdown(summary, skills) };
		}
		// Gated on the two operations that read the working registry rather than run
		// for the whole `skills-` family: an unrecognised operation must fall through
		// to the unknown-operation error without paying for a registry read first.
		if (operation === "skills-active" || operation === "skills-live-markdown") {
			const { projectActiveSkills } = await import("../core/skills/SkillProjection.js");
			const active = await projectActiveSkills(cwd);
			if (operation === "skills-active") {
				// The label rides along because every caller of this needs both and it is
				// derived from the rows already in hand — a second round trip would buy nothing.
				return { skills: active, summaryLabel: aggregate.buildSkillsSummaryLabel(active) };
			}
			// null, not an empty table: committing archives every skill, so an empty list
			// here is the normal post-commit state and the caller should say so in words.
			return { markdown: active.length > 0 ? aggregate.buildLiveSkillsMarkdown(active) : null };
		}
	}
	if (operation === "push-pending-hashes") {
		const { loadPushPending } = await import("../core/PushPendingStore.js");
		return { hashes: Object.keys((await loadPushPending(cwd)).entries) };
	}
	if (operation === "repo-profile-read") {
		const { readRepoProfile } = await import("../core/RepoProfile.js");
		return { profile: await readRepoProfile(cwd) };
	}
	if (operation === "repo-profile-set-backfill-dismissed") {
		if (typeof request.dismissed !== "boolean") {
			throw new Error('Request field "dismissed" must be a boolean.');
		}
		const { updateRepoProfile } = await import("../core/RepoProfile.js");
		await updateRepoProfile(cwd, { backfillDismissed: request.dismissed });
		return { ok: true };
	}
	if (operation === "summary-markdown") {
		const { buildMarkdown } = await import("../core/SummaryMarkdownBuilder.js");
		return { markdown: buildMarkdown(request.summary as Parameters<typeof buildMarkdown>[0]) };
	}
	if (operation === "summary-pr-markdown") {
		const { buildPrMarkdown } = await import("../core/SummaryPrMarkdownBuilder.js");
		return { markdown: buildPrMarkdown(request.summary as Parameters<typeof buildPrMarkdown>[0]) };
	}
	if (operation === "pr-wrap-markdown") {
		const { wrapWithMarkers } = await import("../core/PrDescription.js");
		return { markdown: wrapWithMarkers(stringField(request, "markdown")) };
	}
	if (operation === "pr-replace-markdown") {
		const { replaceSummaryInBody } = await import("../core/PrDescription.js");
		return {
			body: replaceSummaryInBody(stringField(request, "currentBody"), stringField(request, "markdown")),
		};
	}
	if (operation === "reference-push-presentation") {
		if (typeof request.reference !== "object" || request.reference === null || Array.isArray(request.reference)) {
			throw new Error('Request field "reference" must be an object.');
		}
		const [{ buildReferencePushTitle }, { buildReferencePushMarkdown }, references] = await Promise.all([
			import("../core/SummaryFormat.js"),
			import("../core/SummaryMarkdownBuilder.js"),
			import("../core/references/ReferenceStore.js"),
		]);
		const reference = request.reference as Parameters<typeof buildReferencePushMarkdown>[0];
		const storedMarkdown = optionalString(request, "storedMarkdown");
		const description = storedMarkdown
			? (references.readReferenceMarkdownFromString(storedMarkdown)?.description ?? undefined)
			: undefined;
		return {
			title: buildReferencePushTitle(reference),
			markdown: buildReferencePushMarkdown(reference, description),
		};
	}
	throw new Error(`Unknown shared-store operation "${operation}".`);
}

async function runSummaryStoreAction(cwd: string, request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const refused = await refuseWriteIfManuallyDisabled(cwd, operation, SUMMARY_STORE_WRITE_OPERATIONS);
	if (refused) return refused;
	const [summaries, { createStorage }] = await Promise.all([
		import("../core/SummaryStore.js"),
		import("../core/StorageFactory.js"),
	]);
	const storage = await createStorage(cwd, cwd);
	switch (operation) {
		case "index":
			return summaries.getIndex(cwd, storage);
		case "get":
			return summaries.getSummary(stringField(request, "commitHash"), cwd, storage);
		case "list":
			return summaries.listSummaries(optionalNumberField(request, "count", 10), cwd, storage);
		case "count":
			return { count: await summaries.getSummaryCount(cwd, storage) };
		case "find-root": {
			const index = await summaries.getIndex(cwd, storage);
			if (!index) return { hash: null };
			const requested = stringField(request, "commitHash");
			const resolved = index.commitAliases?.[requested] ?? requested;
			const entries = new Map(index.entries.map((entry) => [entry.commitHash, entry]));
			let current = entries.get(resolved);
			if (!current) return { hash: null };
			while (current.parentCommitHash !== null && current.parentCommitHash !== undefined) {
				const parent = entries.get(current.parentCommitHash);
				if (!parent) break;
				current = parent;
			}
			return { hash: current.commitHash };
		}
		case "filter-hashes": {
			const index = await summaries.getIndex(cwd, storage);
			const available = new Set(index?.entries.map((entry) => entry.commitHash) ?? []);
			for (const alias of Object.keys(index?.commitAliases ?? {})) available.add(alias);
			return { hashes: stringArrayField(request, "hashes").filter((hash) => available.has(hash)) };
		}
		case "scan-aliases":
			return {
				changed: await summaries.scanTreeHashAliases(
					stringArrayField(request, "hashes"),
					cwd,
					storage,
					storage,
				),
			};
		case "resolve-alias": {
			const hash = stringField(request, "commitHash");
			const index = await summaries.getIndex(cwd, storage);
			return { hash: index?.commitAliases?.[hash] ?? hash };
		}
		case "store-summary": {
			const summary = request.summary as Parameters<typeof summaries.storeSummary>[0];
			if (!summary || typeof summary !== "object") throw new Error('Request field "summary" must be an object.');
			const transcript = request.transcript;
			const planProgress = request.planProgress;
			const referenceFiles = request.referenceFiles;
			await summaries.storeSummary(
				summary,
				cwd,
				request.force === true,
				{
					...(transcript && typeof transcript === "object"
						? {
								transcript: {
									id: summary.commitHash,
									data: transcript as Parameters<
										typeof summaries.saveTranscriptsBatch
									>[0][number]["data"],
								},
							}
						: {}),
					...(Array.isArray(planProgress)
						? {
								planProgress: planProgress as NonNullable<
									Parameters<typeof summaries.storeSummary>[3]
								>["planProgress"],
							}
						: {}),
					...(Array.isArray(referenceFiles) ? { referenceFiles: referenceFiles as FileWrite[] } : {}),
				},
				storage,
			);
			// The JVM host edits memories through this action; without the
			// re-projection the local dashboard keeps serving the pre-edit
			// conversations/plans (see `recordMemoryEdit`). VS Code gets the same
			// call from its own bridge.
			await recordMemoryEdit(cwd, [summary.commitHash]);
			return { ok: true };
		}
		case "read-plan-progress":
			return summaries.readPlanProgress(stringField(request, "slug"), cwd, storage);
		case "store-files": {
			const files = request.files;
			if (!Array.isArray(files)) throw new Error('Request field "files" must be an array.');
			// Same D6 rule — and the same must-land budget — as the storage action's
			// "write" above.
			const { withRequiredOrphanWriteLock } = await import("../core/SummaryStore.js");
			await withRequiredOrphanWriteLock(cwd, "ide-bridge store-files", () =>
				storage.writeFiles(files as FileWrite[], stringField(request, "message")),
			);
			return { ok: true };
		}
		case "read-plan":
			return { content: await summaries.readPlanFromBranch(stringField(request, "slug"), cwd, storage) };
		case "write-plan":
			await summaries.storePlans(
				[{ slug: stringField(request, "slug"), content: stringField(request, "content") }],
				stringField(request, "message"),
				cwd,
				undefined,
				storage,
			);
			return { ok: true };
		case "read-reference":
			return {
				content: await summaries.readReferenceFromBranch(
					stringField(request, "source"),
					stringField(request, "archivedKey"),
					cwd,
					storage,
				),
			};
		case "write-reference":
			await summaries.storeReferences(
				[
					{
						source: stringField(request, "source"),
						archivedKey: stringField(request, "archivedKey"),
						content: stringField(request, "content"),
					},
				],
				stringField(request, "message"),
				cwd,
				undefined,
				storage,
			);
			return { ok: true };
		case "transcript-hashes":
			return { hashes: [...(await summaries.getTranscriptHashes(cwd, storage))] };
		case "read-transcript":
			return summaries.readTranscript(stringField(request, "commitHash"), cwd, storage);
		case "write-transcript-batch": {
			const rawWrites = request.writes;
			if (typeof rawWrites !== "object" || rawWrites === null || Array.isArray(rawWrites)) {
				throw new Error('Request field "writes" must be an object.');
			}
			const writes = Object.entries(rawWrites).map(([hash, data]) => ({
				hash,
				data: data as Parameters<typeof summaries.saveTranscriptsBatch>[0][number]["data"],
			}));
			await summaries.saveTranscriptsBatch(writes, stringArrayField(request, "deletes"), cwd, storage);
			return { ok: true };
		}
		default:
			throw new Error(`Unknown summary-store operation "${operation}".`);
	}
}

async function runSummaryTreeAction(request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const summary = request.summary;
	if (!summary || typeof summary !== "object") throw new Error('Request field "summary" must be an object.');
	const tree = await import("../core/SummaryTree.js");
	type Summary = Parameters<typeof tree.aggregateStats>[0];
	const value = summary as Summary;
	const nestedTopics = (topics: ReturnType<typeof tree.collectAllTopics>) =>
		topics.map(({ commitDate, generatedAt: _generatedAt, treeIndex, ...topic }) => ({
			topic,
			commitDate,
			treeIndex,
		}));
	switch (operation) {
		case "analyze":
			return {
				unified: tree.isUnifiedHoistFormat(value),
				allTopics: nestedTopics(tree.collectAllTopics(value)),
				displayTopics: nestedTopics(tree.collectDisplayTopics(value)),
				stats: tree.aggregateStats(value),
				turns: tree.aggregateTurns(value),
				tokens: tree.aggregateConversationTokens(value),
				breakdown: tree.aggregateConversationTokenBreakdown(value),
				estimatedCost: tree.aggregateEstimatedCost(value),
				topicCount: tree.countTopics(value),
				sourceNodes: tree.collectSourceNodes(value),
				leaf: tree.isLeafNode(value),
				durationDays: tree.computeDurationDays(value),
				durationLabel: tree.formatDurationLabel(value),
				// v5-compatible transcript-ID resolution (summary.transcripts with a
				// v3/v4 commit-hash fallback) owned here so IDE clients share one
				// implementation instead of porting the fallback rules per surface.
				transcriptIds: tree.getTranscriptIds(value),
			};
		case "update-topic":
			return tree.updateTopicInTree(
				value,
				numberField(request, "globalIndex"),
				(request.updates ?? {}) as Parameters<typeof tree.updateTopicInTree>[2],
			);
		case "delete-topic":
			return tree.deleteTopicInTree(value, numberField(request, "globalIndex"));
		default:
			throw new Error(`Unknown summary-tree operation "${operation}".`);
	}
}

async function runPlanGroupingAction(request: JsonObject): Promise<unknown> {
	const plans = await import("../core/JolliMemoryPushOrchestrator.js");
	switch (stringField(request, "operation")) {
		case "base-key":
			return { key: plans.planBaseKey(stringField(request, "slug")) };
		case "base-keys":
			return Object.fromEntries(
				stringArrayField(request, "slugs").map((slug) => [slug, plans.planBaseKey(slug)]),
			);
		case "latest": {
			if (!Array.isArray(request.plans)) throw new Error('Request field "plans" must be an array.');
			return plans.latestPlanPerName(request.plans as Parameters<typeof plans.latestPlanPerName>[0]);
		}
		default:
			throw new Error("Unknown plan-grouping operation.");
	}
}

async function runReferenceStoreAction(request: JsonObject): Promise<unknown> {
	const references = await import("../core/references/ReferenceStore.js");
	switch (stringField(request, "operation")) {
		case "read":
			return references.readReferenceMarkdown(stringField(request, "sourcePath"));
		case "parse":
			return references.readReferenceMarkdownFromString(stringField(request, "content"));
		default:
			throw new Error("Unknown reference-store operation.");
	}
}

async function runKbAction(request: JsonObject): Promise<unknown> {
	const operation = stringField(request, "operation");
	const paths = await import("../core/KBPathResolver.js");
	switch (operation) {
		case "resolve":
			return {
				path: paths.resolveKBPath(
					stringField(request, "repoName"),
					optionalString(request, "remoteUrl") ?? null,
					optionalString(request, "customPath"),
				),
			};
		case "initialize":
			paths.initializeKBFolder(
				stringField(request, "kbRoot"),
				stringField(request, "repoName"),
				optionalString(request, "remoteUrl") ?? null,
			);
			return { ok: true };
		case "find-repo-folders":
			return {
				paths: paths.findRepoFolders(
					stringField(request, "repoName"),
					optionalString(request, "remoteUrl") ?? null,
					optionalString(request, "customPath"),
				),
			};
		case "find-fresh":
			return {
				path: paths.findFreshKBPath(stringField(request, "repoName"), optionalString(request, "customPath")),
			};
		case "archive":
			return {
				path: paths.archiveKBFolder(stringField(request, "kbRoot"), optionalString(request, "customPath")),
			};
		case "extract-repo-name":
			return { value: paths.extractRepoName(stringField(request, "projectPath")) };
		case "get-remote-url":
			return { value: paths.getRemoteUrl(stringField(request, "projectPath")) };
		case "discover": {
			const { discoverRepos } = await import("../core/KBRepoDiscoverer.js");
			return {
				repos: discoverRepos(
					optionalString(request, "currentRepoName") ?? null,
					optionalString(request, "currentRemoteUrl") ?? null,
					optionalString(request, "customParent"),
				),
			};
		}
	}
	const { MetadataManager } = await import("../core/MetadataManager.js");
	const manager = new MetadataManager(stringField(request, "jolliDir"));
	switch (operation) {
		case "metadata-ensure":
			manager.ensure();
			return { ok: true };
		case "metadata-read-manifest":
			return manager.readManifest();
		case "metadata-read-index":
			return manager.readIndex();
		case "metadata-read-config":
			return manager.readConfig();
		case "metadata-find-by-path":
			return { entry: manager.findByPath(stringField(request, "path")) ?? null };
		case "metadata-update-path":
			return { changed: manager.updatePath(stringField(request, "fileId"), stringField(request, "newPath")) };
		case "metadata-rename-branch-folder":
			return {
				count: manager.renameBranchFolder(stringField(request, "oldFolder"), stringField(request, "newFolder")),
			};
		case "metadata-remove-branch-folder":
			return { count: manager.removeBranchFolder(stringField(request, "folder")) };
		case "metadata-remove-manifest":
			return { changed: manager.removeFromManifest(stringField(request, "fileId")) };
		case "metadata-reconcile":
			return { count: manager.reconcile(stringField(request, "kbRoot")) };
		case "metadata-save-migration":
			manager.saveMigrationState(request.state as Parameters<typeof manager.saveMigrationState>[0]);
			return { ok: true };
		default:
			throw new Error(`Unknown KB operation "${operation}".`);
	}
}

export async function runIdeBridgeAction(action: string, cwd: string, request: JsonObject): Promise<unknown> {
	switch (action) {
		case "active-conversations": {
			const { listActiveConversationsWithDiagnostics } = await import("../core/ActiveSessionAggregator.js");
			const windowMs = typeof request.windowMs === "number" ? request.windowMs : 2 * 24 * 60 * 60 * 1000;
			return listActiveConversationsWithDiagnostics({ cwd, windowMs });
		}
		case "migrate-memory-bank": {
			// IntelliJ's migration route — the same runMemoryBankMigration the
			// hidden `jolli migrate-memory-bank` one-shot command wraps, delivered
			// over the standard ide-bridge transport so the long-lived daemon can
			// serve it (~5-20ms startup vs a dedicated cold Node spawn's
			// ~500ms-2s). Long-running (minutes on a large first-install): the
			// daemon dispatches requests concurrently, so it cannot block
			// hot-path actions, and callers pass a large timeout.
			const { runMemoryBankMigration } = await import("../core/MemoryBankMigration.js");
			return runMemoryBankMigration(cwd);
		}
		case "sync-agent-hooks": {
			// Per-worktree Claude Stop + Gemini AfterAgent hook sync, called by
			// the IntelliJ Settings dialog when the user flips a per-agent toggle.
			// Mirrors VS Code's in-process `SettingsWebviewPanel.syncHooks`
			// (vscode/src/views/SettingsWebviewPanel.ts) — same installers, same
			// per-worktree iteration, same manual-disable early-return. Reuses the
			// exported hook helpers from `install/Installer.js` so the two
			// surfaces cannot drift.
			//
			// Runs on the daemon fast path (~5-20ms) instead of the previous
			// unconditional `enable --integrations-only` subprocess spawn
			// (~500ms-2s cold Node start) every Apply. Idempotent: re-saving with
			// the same values re-writes the same hook block, matching how VS Code
			// treats settings save.
			//
			// Serialized against enable/disable via [acquireRepoHooksLock] — the
			// SAME lock the installer / uninstaller take (Installer.ts:327/868),
			// so a Settings Apply that lands mid-way through the IntelliJ startup
			// auto-install cannot interleave read-modify-writes on
			// `.claude/settings.local.json`. `reconcileClaudeAgentHooks`'
			// per-call atomicity is only intra-call; the lock is what prevents
			// two callers (start-up install + Apply's sync-agent-hooks) from
			// clobbering each other's Stop/SessionStart block. Lock timeout
			// (default 60 s) throws — the caller renders a "click Apply again"
			// balloon, which is the right recovery for a genuine contention.
			if (typeof request.claudeEnabled !== "boolean" || typeof request.geminiEnabled !== "boolean") {
				throw new Error('Request fields "claudeEnabled" and "geminiEnabled" must be booleans.');
			}
			const claudeEnabled = request.claudeEnabled;
			const geminiEnabled = request.geminiEnabled;
			const { readManualDisableFlag } = await import("../core/RepoProfile.js");
			// Highest-priority opt-out is enforced by CLI/VS Code alike. The
			// Settings dialog stays reachable while manually disabled (it's the
			// re-enable entry point), so we must not silently reinstate hooks.
			// Checked BEFORE taking the repo-hooks lock so a manually-disabled
			// repo (the common case where this action fires from a Settings save
			// on an unrelated field) doesn't contend with a concurrent
			// enable/disable — the flag itself is stable across the lock.
			if (await readManualDisableFlag(cwd)) {
				return { manuallyDisabled: true, worktrees: [], failures: [] };
			}
			const { acquireRepoHooksLock } = await import("../core/Locks.js");
			const repoLock = await acquireRepoHooksLock(cwd);
			if (!repoLock) {
				throw new Error("Another Jolli enable/disable operation is still running; retry shortly");
			}
			try {
				const { getProjectRootDir, listWorktrees } = await import("../core/GitOps.js");
				const repoRoot = await getProjectRootDir(cwd).catch(() => cwd);
				let worktrees: ReadonlyArray<string>;
				try {
					worktrees = await listWorktrees(repoRoot);
				} catch {
					// Detached checkout or missing `git worktree` — fall back to the
					// current dir, exactly like VS Code does.
					worktrees = [repoRoot];
				}
				const { installClaudeHook, removeClaudeHook, installGeminiHook, removeGeminiHook } = await import(
					"../install/Installer.js"
				);
				const failures: Array<{ worktree: string; integration: string; message: string }> = [];
				for (const wt of worktrees) {
					try {
						if (claudeEnabled) {
							await installClaudeHook(wt);
						} else {
							await removeClaudeHook(wt);
						}
					} catch (err) {
						failures.push({
							worktree: wt,
							integration: "Claude",
							message: err instanceof Error ? err.message : String(err),
						});
					}
					try {
						if (geminiEnabled) {
							await installGeminiHook(wt);
						} else {
							await removeGeminiHook(wt);
						}
					} catch (err) {
						failures.push({
							worktree: wt,
							integration: "Gemini",
							message: err instanceof Error ? err.message : String(err),
						});
					}
				}
				return { manuallyDisabled: false, worktrees: [...worktrees], failures };
			} finally {
				await repoLock.release();
			}
		}
		case "disable": {
			// Full or integrations-only disable, driven by the IntelliJ Settings
			// dialog's Pause checkbox and its auto-signout branch. Wraps the same
			// exported [uninstall] that VS Code's `bridge.disable()` calls
			// in-process — so IntelliJ can reach the identical hook-removal /
			// manual-disable code path via the daemon (~5-20 ms) or a one-shot
			// `ide-bridge` spawn (~500 ms fallback) instead of the ~500 ms – 2 s
			// cold `Cli.js disable` subprocess it used before.
			//
			// `persistManualDisable` defaults to the inverse of
			// `integrationsOnly`, mirroring [`EnableCommand.ts`] `disable`
			// branch: a full disable persists the machine-owned opt-out; an
			// integrations-only teardown does not.
			const integrationsOnly = request.integrationsOnly === true;
			const persistManualDisable =
				typeof request.persistManualDisable === "boolean" ? request.persistManualDisable : !integrationsOnly;
			const { uninstall } = await import("../install/Installer.js");
			const result = await uninstall(cwd, {
				integrationsOnly,
				persistManualDisable,
				preserveMenu: !integrationsOnly,
			});
			return {
				success: result.success,
				message: result.message,
				warnings: [...result.warnings],
			};
		}
		case "unread-transcript": {
			const source = stringField(request, "source") as TranscriptSource;
			if (!TRANSCRIPT_SOURCES.has(source)) throw new Error(`Unknown transcript source "${source}".`);
			const { loadUnreadTranscript } = await import("../core/TranscriptMessageCounter.js");
			return { entries: await loadUnreadTranscript(source, stringField(request, "transcriptPath"), cwd) };
		}
		case "transcript": {
			const source = stringField(request, "source") as TranscriptSource;
			if (!TRANSCRIPT_SOURCES.has(source)) throw new Error(`Unknown transcript source "${source}".`);
			const { loadTranscript } = await import("../core/TranscriptLoader.js");
			return {
				entries: await loadTranscript({ source, transcriptPath: stringField(request, "transcriptPath") }),
			};
		}
		case "transcript-repair-state": {
			// Which of the three sentences spec §9 allows the memory-detail UI to
			// print. VS Code answers this by calling `transcriptRepairState`
			// in-process; the JVM host cannot import `cli/src`, so without this
			// action the whole distinction would be silently VS Code-only — no
			// compile error, no failing test, just an IntelliJ tab that shows the
			// plainest sentence forever.
			//
			// A summary we cannot find answers `unrepairable`, the MILDEST verdict,
			// rather than throwing. "Repair may still be possible" is the one wrong
			// direction to guess in: it invites the user to run a repair that has
			// nothing to work from, and a memory nobody can look up is no evidence
			// that local transcripts survive.
			const { getSummary } = await import("../core/SummaryStore.js");
			const summary = await getSummary(optionalString(request, "commitHash") ?? "", cwd);
			if (!summary) return { state: "unrepairable" satisfies TranscriptRepairState };
			const { transcriptRepairState } = await import("../core/TranscriptRepair.js");
			return { state: await transcriptRepairState(summary, cwd) };
		}
		case "compile": {
			const config = request.config as JolliMemoryConfig | undefined;
			if (!config || typeof config !== "object") throw new Error('Request field "config" must be an object.');
			const localFolder = optionalString(request, "localFolder") ?? config.localFolder;
			if (!localFolder) throw new Error("No Memory Bank folder configured.");
			const { compileAllRepos } = await import("../core/MultiRepoCompile.js");
			return compileAllRepos(localFolder, config);
		}
		case "local-agent-tools": {
			// The `LOCAL_AGENT_TOOLS` map in cli/src/core/localagent/ToolMeta.ts is
			// the single source of truth for the supported local-agent CLIs
			// (claude-code / codex / cursor-agent / opencode / kimi). VS Code renders
			// its Agent-tool <select> from the same map at bundle time. IntelliJ pulls
			// this action too, but as an *override* on top of a static Kotlin baseline
			// (`LocalAgentTools.DEFAULT_TOOLS`) so its picker still shows every tool
			// when this fetch fails — that baseline is a hand-maintained mirror of this
			// map (pinned by `LocalAgentToolsTest`), so a tool added here must be added
			// there in the same change.
			const { LOCAL_AGENT_TOOLS } = await import("../core/localagent/ToolMeta.js");
			return {
				tools: Object.entries(LOCAL_AGENT_TOOLS).map(([id, meta]) => ({
					id,
					label: meta.label,
					loginHint: meta.loginHint,
				})),
			};
		}
		case "local-agent-usable": {
			// IntelliJ mirror of the VS Code webview's `probeLocalAgent`
			// (see `handleProbeLocalAgent` in `SettingsWebviewPanel.ts`, which imports
			// `isLocalAgentUsable` in-process because VS Code bundles the CLI). Kotlin
			// cannot import the TS core, so it asks the same question over the bridge.
			//
			// `tool` is untrusted input and is allow-listed against LOCAL_AGENT_TOOLS
			// before it reaches `isLocalAgentUsable`. An unknown id is a bug in the
			// caller, not a user-visible outcome, so it fails loudly rather than
			// silently reporting unavailable. Uses `getOwnPropertyDescriptor` — a
			// plain index-truthy check would leak prototype keys (`toString`,
			// `__proto__`, `constructor`) through the allow-list, and biome rejects
			// `hasOwnProperty.call` while `Object.hasOwn` only lands in ES2022 (this
			// project targets ES2020). Same pattern PluginLoader.ts uses.
			//
			// Every other failure mode (config unreadable, discovery throws) is caught
			// and answered as `available: false`, matching the VS Code sibling — the
			// UI contract is "unknown ≡ not usable" so the user is never blocked on an
			// unanswered probe, and never told a tool works when we could not verify.
			const rawTool = stringField(request, "tool");
			const { LOCAL_AGENT_TOOLS } = await import("../core/localagent/ToolMeta.js");
			if (Object.getOwnPropertyDescriptor(LOCAL_AGENT_TOOLS, rawTool) === undefined) {
				throw new Error(`Unknown local agent tool "${rawTool}".`);
			}
			const tool = rawTool as LocalAgentToolId;
			let available = false;
			try {
				// Tool-scoped override: `localAgentPath` belongs to the CONFIGURED tool,
				// so probing the dropdown's current pick must NOT borrow it. See
				// `localAgentOverrideFrom` for why the pairing is required.
				const tracker = await import("../core/SessionTracker.js");
				const config = await tracker.loadConfigFromDir(tracker.getGlobalConfigDir());
				const { isLocalAgentUsable, localAgentOverrideFrom } = await import(
					"../core/localagent/DetectAgents.js"
				);
				available = await isLocalAgentUsable(tool, { override: localAgentOverrideFrom(config) });
			} catch (err) {
				log.error("IdeBridge", `local-agent-usable probe failed for ${tool}: ${String(err)}`);
			}
			return { available };
		}
		case "folder-heal-visible-markdown": {
			// Regenerates missing `<branch>/<slug>.md` files from their canonical
			// `.jolli/summaries/<hash>.json` counterpart, matching VS Code's
			// KbFoldersService which fires the same heal on every tree listing.
			// The kbRoot argument scopes the pass to one Memory Bank repo — the
			// IntelliJ sidebar calls this once per discovered repo before
			// rendering. `dropOrphanedManifestEntries` defaults to false because
			// the ide-bridge can't tell whether the caller is on folder-only
			// storage (where the manifest is the last record and dropping it is
			// data loss); the explicit `jolli heal-folder` CLI reads
			// `storageMode` and is the only place opt-in dropping happens.
			const kbRoot = stringField(request, "kbRoot");
			const dropOrphans = request.dropOrphanedManifestEntries === true;
			const { join } = await import("node:path");
			const { MetadataManager } = await import("../core/MetadataManager.js");
			const { FolderStorage } = await import("../core/FolderStorage.js");
			const mm = new MetadataManager(join(kbRoot, ".jolli"));
			const storage = new FolderStorage(kbRoot, mm);
			return await storage.healMissingVisibleMarkdown({ dropOrphanedManifestEntries: dropOrphans });
		}
		case "pr-description": {
			const { buildPrDescription } = await import("../core/PrDescription.js");
			return buildPrDescription(cwd, {
				baseBranch: optionalString(request, "baseBranch"),
				includeMarkers: request.includeMarkers !== false,
			});
		}
		case "outbound-push-allowed": {
			// spec 306 gate. IntelliJ push sites call this before pushing so the
			// per-repo opt-out is enforced from the one source of truth (the
			// machine-global push-control store, keyed by canonical repo identity).
			const { isOutboundPushAllowed } = await import("../core/PushControl.js");
			return { allowed: await isOutboundPushAllowed(cwd) };
		}
		case "push-control-get": {
			// Reads the PURE per-repo push-disabled flag for the current project's
			// repo (NOT the composed `outbound-push-allowed`, which also folds in
			// `manuallyDisabled`). Drives the IntelliJ Settings toggle's initial
			// state so unchecking it maps 1:1 to clearing this flag.
			//
			// The STATE form, not the boolean shorthand: this is a *reporting* surface,
			// and `isPushDisabled` drops the reason. An unreadable store fails closed to
			// `true` for EVERY repo on the machine, so the boolean alone would make the
			// Settings checkbox claim "you turned this repo off" — a state the user never
			// chose, machine-wide rather than per-repo, and with no hint of the one file
			// that needs fixing. `pushDisabledError` rides along (carrying the store's
			// absolute path) so the host can render "unknown" instead, exactly like
			// `getStatus` / `jolli push-control` show.
			const { readPushDisabledState } = await import("../core/PushControl.js");
			const state = await readPushDisabledState(cwd);
			return { pushDisabled: state.disabled, ...(state.error ? { pushDisabledError: state.error } : {}) };
		}
		case "push-control-set": {
			// Toggle outbound push for the current project's repo (spec 306). The
			// flag is per-repo, so the bridge acts on `cwd` — the project the IDE
			// opened it for. Re-enabling drains retained memory via the shared core.
			const { applyPushDisabled } = await import("../core/PushControl.js");
			// Validate rather than coerce. `request.disabled === true` would make a
			// missing or mistyped field silently mean ENABLE — and enabling is the one
			// direction that rebuilds an unreadable store from empty, dropping every
			// other repo's opt-out. A malformed request must never take that path.
			if (typeof request.disabled !== "boolean") {
				throw new Error('Request field "disabled" must be a boolean.');
			}
			const disabled = request.disabled;
			const { recoveredFromCorrupt, preservedAt } = await applyPushDisabled(cwd, disabled, "intellij");
			return {
				pushDisabled: disabled,
				...(recoveredFromCorrupt
					? { recoveredFromCorrupt: true, ...(preservedAt ? { preservedAt } : {}) }
					: {}),
			};
		}
		case "status": {
			const { createStorage } = await import("../core/StorageFactory.js");
			const { getStatus } = await import("../install/Installer.js");
			return getStatus(cwd, await createStorage(cwd, cwd));
		}
		case "sync": {
			const { loadConfig } = await import("../core/SessionTracker.js");
			const config = await loadConfig();
			if (!config.jolliApiKey) throw new Error("Sync requires a Jolli sign-in.");
			const { ensureKBInitAndMigrated } = await import("./SyncCommand.js");
			await ensureKBInitAndMigrated(cwd, config.localFolder);
			const { buildSyncEngine } = await import("../sync/SyncBootstrap.js");
			const ui = new IdeBridgeConflictUi(conflictChoices(request));
			const engine = await buildSyncEngine({ cwd, ui });
			if (engine === null) throw new Error("Sync requires a Jolli sign-in.");
			const rawReason = optionalString(request, "reason") ?? "manual";
			const reason = (["post-commit", "poll", "manual", "first-bind"] as const).find(
				(candidate) => candidate === rawReason,
			);
			if (reason === undefined) throw new Error(`Unknown sync reason "${rawReason}".`);
			const result = await engine.runRound({
				cwd,
				reason,
				transcripts: request.transcripts === true || config.syncTranscripts === true,
			});
			return { ...result, conflictDetails: ui.details };
		}
		case "install":
			return runInstallAction(cwd, request);
		case "uninstall":
			return runUninstallAction(cwd, request);
		case "conversation-overlay":
			return runConversationOverlayAction(cwd, request);
		case "session-state":
			return runSessionStateAction(cwd, request);
		case "working-context":
			return runWorkingContextAction(cwd, request);
		case "repo-profile":
			return runRepoProfileAction(cwd, request);
		case "auth":
			return runAuthAction(request);
		case "jolli-api":
			return runJolliApiAction(cwd, request);
		case "pricing": {
			const operation = stringField(request, "operation");
			if (operation === "sonnet-cost") {
				const { estimateConversationCostUsd } = await import("../core/TokenCost.js");
				return {
					costUsd: estimateConversationCostUsd(
						request.breakdown as Parameters<typeof estimateConversationCostUsd>[0],
						numberField(request, "totalTokens"),
					),
				};
			}
			const pricing = await import("../core/Pricing.js");
			if (operation === "provider") {
				return { provider: pricing.MODEL_PRICES[stringField(request, "model")]?.provider ?? "unknown" };
			}
			if (operation === "model-cost") {
				return {
					costUsd: pricing.estimateModelCostUsd(
						request.usage as Parameters<typeof pricing.estimateModelCostUsd>[0],
					),
				};
			}
			if (operation === "total-cost") {
				return pricing.estimateCostUsd(request.usages as Parameters<typeof pricing.estimateCostUsd>[0]);
			}
			throw new Error(`Unknown pricing operation "${operation}".`);
		}
		case "shared-store":
			return runSharedStoreAction(cwd, request);
		case "summary-store":
			return runSummaryStoreAction(cwd, request);
		case "summary-tree":
			return runSummaryTreeAction(request);
		case "plan-grouping":
			return runPlanGroupingAction(request);
		case "reference-store":
			return runReferenceStoreAction(request);
		case "kb":
			return runKbAction(request);
		case "storage":
			return runStorageAction(cwd, request);
		case "git-exec": {
			const { execGit } = await import("../core/GitOps.js");
			return execGit(stringArrayField(request, "args"), cwd);
		}
		/**
		 * Reverts working-tree changes for a set of repo-relative paths.
		 *
		 * Takes PATHS, never statuses. The service resolves each path against one
		 * authoritative `git status` read, which is what stops a host from
		 * collapsing porcelain columns lossily on the way in — the IntelliJ port
		 * this replaced did exactly that and silently no-opped on every untracked
		 * file — and from sending a status that went stale between painting the
		 * row and the user clicking it.
		 *
		 * Returns one outcome per requested path, in the order given. A per-file
		 * failure is REPORTED, not thrown: discarding four files where the third
		 * fails must still tell the caller about the other three, and the caller
		 * must surface `ok: false` rather than assume the click worked.
		 */
		case "discard-files": {
			const { discardFiles } = await import("../core/FileDiscardService.js");
			return { outcomes: await discardFiles(cwd, stringArrayField(request, "relativePaths")) };
		}
		/**
		 * Read-only companion to `discard-files`: would discarding these paths
		 * delete the files, or restore them in place?
		 *
		 * The JVM host cannot answer this itself — its rows come from
		 * `ChangeListManager`, which has no conflicted state, and every producer
		 * collapses git's two porcelain columns to one ambiguous character. VS
		 * Code gets the same rule by importing the module. Returns one preview per
		 * requested path, in the order given.
		 */
		case "discard-preview": {
			const { previewDiscard } = await import("../core/FileDiscardService.js");
			return { previews: await previewDiscard(cwd, stringArrayField(request, "relativePaths")) };
		}
		case "git-main-worktree-root": {
			const { getProjectRootDir } = await import("../core/GitOps.js");
			return { path: await getProjectRootDir(cwd) };
		}
		case "git-remote": {
			const remote = await import("../core/GitRemoteUtils.js");
			switch (stringField(request, "operation")) {
				case "canonical-url":
					return { value: await remote.getCanonicalRepoUrl(cwd) };
				case "normalize-url":
					return { value: remote.normalizeRemoteUrl(stringField(request, "remote"), cwd) };
				case "derive-name":
					return { value: remote.deriveRepoNameFromUrl(stringField(request, "repoUrl")) };
				case "sanitize-branch":
					return { value: remote.sanitizeBranchSlug(optionalString(request, "branch")) };
				default:
					throw new Error("Unknown git-remote operation.");
			}
		}
		case "telemetry-track": {
			const { bootstrapTelemetry } = await import("../core/TelemetryStartup.js");
			const { bucket, track } = await import("../core/Telemetry.js");
			await bootstrapTelemetry({ cwd, platformDisabled: request.platformDisabled === true });
			const properties = {
				...((request.properties as Readonly<Record<string, unknown>> | undefined) ?? {}),
			};
			const bucketCounts = request.bucketCounts;
			if (bucketCounts !== undefined) {
				if (typeof bucketCounts !== "object" || bucketCounts === null || Array.isArray(bucketCounts)) {
					throw new Error('Request field "bucketCounts" must be an object.');
				}
				for (const [key, value] of Object.entries(bucketCounts)) {
					if (typeof value !== "number") throw new Error(`Bucket count "${key}" must be a number.`);
					properties[key] = bucket(value);
				}
			}
			track(stringField(request, "eventName") as Parameters<typeof track>[0], properties);
			return { ok: true };
		}
		case "telemetry-bootstrap": {
			const { bootstrapTelemetry } = await import("../core/TelemetryStartup.js");
			const { loadConfig } = await import("../core/SessionTracker.js");
			const { shouldShowTelemetryNotice } = await import("../core/TelemetryConsent.js");
			const platformDisabled = request.platformDisabled === true;
			await bootstrapTelemetry({ cwd, platformDisabled });
			return { shouldShowNotice: shouldShowTelemetryNotice({ config: await loadConfig(), platformDisabled }) };
		}
		case "telemetry-install-id": {
			const { getOrCreateInstallId } = await import("../core/SessionTracker.js");
			return getOrCreateInstallId();
		}
		case "telemetry-flush": {
			const { flushTelemetryNow } = await import("../core/TelemetryStartup.js");
			await flushTelemetryNow(cwd, { platformDisabled: request.platformDisabled === true });
			return { ok: true };
		}
		default:
			throw new Error(`Unknown IDE bridge action "${action}".`);
	}
}

/**
 * One-shot mode. Reads one request body from stdin (already just the `request`
 * payload — `method` and `cwd` come from the CLI args), invokes the handler,
 * and writes one JSON-RPC 2.0 response envelope on stdout. Success and error
 * shapes match the long-lived server so the host has a single parser.
 * Note there is no `id` in the one-shot response: the process itself is the
 * correlation — one spawn = one call.
 *
 * Uses [writeServeLine] for the wire write so the one-shot and daemon modes
 * share one stdout choke point and the CodeQL `js/clear-text-logging` query
 * doesn't misread the JSON-RPC channel as a log sink for auth responses that
 * legitimately carry `jolliApiKey`.
 */
export async function executeIdeBridgeCommand(action: string, cwd: string): Promise<void> {
	try {
		setLogDir(cwd);
		// A push payload (content + summaryJson) or an LLM-proxy prompt
		// carrying a diff routinely exceeds the 64 KiB `--arg-stdin` cap on
		// the one-shot spawn path (no daemon bound). This request is a fresh
		// JSON DTO from an in-process IDE plugin, never user shell input, so
		// the OOM concern shaping the smaller cap does not apply here — see
		// {@link IDE_BRIDGE_STDIN_MAX_BYTES} for the rationale.
		const result = await runIdeBridgeAction(
			action,
			cwd,
			parseRequest(await readStdin({ maxBytes: IDE_BRIDGE_STDIN_MAX_BYTES, label: "ide-bridge request" })),
		);
		writeServeLine({ jsonrpc: "2.0", result });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const data: Record<string, unknown> = {};
		if (error instanceof Error && error.name.length > 0) {
			data.errorName = error.name;
		}
		copyPrimitiveErrorFields(error, data);
		writeServeLine({ jsonrpc: "2.0", error: { code: -32000, message, data } });
		process.exitCode = 1;
	}
}

/**
 * Wire protocol name for the long-lived JSON-RPC 2.0 ide-bridge server. The
 * host side refuses a handshake with any other value so a mismatched Node
 * binary (older plugin dist, newer client) fails loudly instead of silently
 * misbehaving.
 */
export const IDE_BRIDGE_PROTOCOL = "jolli-ide-bridge-jsonrpc-v1";

/** Handshake — a JSON-RPC 2.0 notification (no `id`) with method "ready". */
interface HandshakeLine {
	readonly jsonrpc: "2.0";
	readonly method: "ready";
	readonly params: {
		readonly protocol: typeof IDE_BRIDGE_PROTOCOL;
		readonly pluginVersion: string;
		readonly pid: number;
	};
}

/** One request received from the IDE. Fields extra to this shape are ignored. */
interface ServeRequest {
	readonly id: number | string | null;
	readonly action: string;
	readonly cwd?: string;
	readonly request?: JsonObject;
	/**
	 * IDE-supplied Jolli trace id (32-hex, no span segment). When present, the
	 * daemon adopts it via {@link runWithTrace} for the action's duration so the
	 * CLI's outbound HTTP calls carry the IDE-scoped trace id (`x-jolli-trace`)
	 * instead of a fresh CLI-only one — restoring the cross-log correlation the
	 * pre-bridge Kotlin path had. Silently ignored when the value isn't a
	 * well-formed trace id ({@link runWithTrace} falls back to a fresh id).
	 */
	readonly traceId?: string;
}

/**
 * Extracts the id from a decoded request line without throwing — used on the
 * error path so a malformed line still gets a paired error response when the
 * `id` field alone is intelligible.
 */
function extractRequestId(parsed: unknown): number | string | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const id = (parsed as { id?: unknown }).id;
	if (typeof id === "number" || typeof id === "string") return id;
	return null;
}

/**
 * Validates and normalises one raw JSON-RPC 2.0 request line into a
 * [ServeRequest]. Throws with a specific message on any missing / wrong-typed
 * field — the caller pairs the resulting error with whatever id could be
 * extracted separately.
 *
 * Wire shape: `{"jsonrpc":"2.0","id":<n|s>,"method":"<action>","params":{"cwd":"...","request":{...}}}`.
 * `jsonrpc` is required by the spec but we accept its absence for transitional
 * clients — the presence of `method`/`id` is what actually drives dispatch.
 */
function normaliseServeRequest(parsed: unknown): ServeRequest {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Request must be a JSON object.");
	}
	const raw = parsed as Record<string, unknown>;
	const method = raw.method;
	if (typeof method !== "string" || method.length === 0) {
		throw new Error('Request field "method" must be a non-empty string.');
	}
	const rawParams = raw.params;
	if (rawParams !== undefined && (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams))) {
		throw new Error('Request field "params" must be a JSON object.');
	}
	const params = (rawParams as Record<string, unknown> | undefined) ?? {};
	const cwd = params.cwd;
	if (cwd !== undefined && typeof cwd !== "string") {
		throw new Error('Request field "params.cwd" must be a string.');
	}
	const request = params.request;
	if (request !== undefined && (typeof request !== "object" || request === null || Array.isArray(request))) {
		throw new Error('Request field "params.request" must be a JSON object.');
	}
	const traceId = params.traceId;
	if (traceId !== undefined && typeof traceId !== "string") {
		throw new Error('Request field "params.traceId" must be a string.');
	}
	const id = extractRequestId(parsed);
	return {
		id,
		action: method,
		...(typeof cwd === "string" ? { cwd } : {}),
		...(request ? { request: request as JsonObject } : {}),
		...(typeof traceId === "string" ? { traceId } : {}),
	};
}

/**
 * Emits one JSON line to stdout as the wire format for the daemon. Kept as a
 * single choke point so any future framing change (e.g. Content-Length) is a
 * one-line edit.
 *
 * Stringify guard: a handler that returns a value carrying a bigint or a
 * circular reference makes `JSON.stringify` throw AFTER the request already
 * committed an id. Without this fallback the host's per-id future is orphaned
 * and only unblocks when the caller's own timeout fires (300 s in the default
 * bridge budget). Fall back to a minimal, guaranteed-serialisable error
 * envelope carrying the same id so the caller fails fast with a real message.
 *
 * Exported so vitest can assert the fallback envelope shape without spawning
 * a real daemon.
 */
export function writeServeLine(obj: object): void {
	let line: string;
	try {
		line = JSON.stringify(obj);
	} catch (err: unknown) {
		const rawId = (obj as { id?: unknown }).id;
		const id = typeof rawId === "number" || typeof rawId === "string" ? rawId : null;
		const message = err instanceof Error ? err.message : String(err);
		// JSON-RPC 2.0 error object. -32603 = internal error (spec).
		line = JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: {
				code: -32603,
				message: `response not serialisable: ${message}`,
				data: { errorName: "SerializationError" },
			},
		});
	}
	process.stdout.write(`${line}\n`);
}

/**
 * Long-lived NDJSON server mode for `ide-bridge`. Reads one JSON request per
 * line from stdin and writes one JSON response per line to stdout; every
 * request is dispatched concurrently by [runIdeBridgeAction] so a slow request
 * (e.g. `sync`, `compile`) cannot block a fast one (`session-state`, `status`).
 *
 * Contract highlights (see also IDE_BRIDGE_PROTOCOL):
 *   - Handshake — one `{"type":"ready", …}` line is emitted before any request
 *     is read, so the host can wait for it before sending traffic.
 *   - Requests — `{"id":<int|string>, "action":"<a>", "cwd":"<abs>", "request":{…}}`.
 *   - Responses — success `{"id":<n>, "type":"<action>", "result":<any>}`;
 *     failure `{"id":<n>, "type":"error", "message":"…", "errorName":"…",
 *     "details":{…}}` — same shape as the one-shot mode so the host can reuse
 *     one parser.
 *   - Malformed lines produce an error response whose id is whatever could be
 *     extracted, or `null` when even that fails; the loop keeps running.
 *   - Handler exceptions are caught per-request; the daemon process never
 *     exits from a business-logic error.
 *   - stdin EOF (`readline` `close` event) drains outstanding responses and
 *     exits cleanly with code 0.
 *   - stdout is protocol-only. All logging goes through [setLogDir] to the
 *     per-project log file, and any accidental stray writer would violate the
 *     protocol; every stdout write in this file funnels through
 *     [writeServeLine], which emits one well-formed JSON envelope per line
 *     (shared by both the one-shot [executeIdeBridgeCommand] and the daemon
 *     loop below).
 */
export interface RunIdeBridgeServeOptions {
	/**
	 * Override for the machine-global Claude plans dir. Mirrors
	 * [DaemonServerOptions.plansDir], and for the same reason: every other watch
	 * target is rooted at `cwdDefault`, but this one would otherwise arm on the
	 * developer's real `~/.claude/plans/` and let an unrelated Claude Code
	 * session write a `refresh` line into a test's captured stdout — between the
	 * handshake and the response it is asserting on. Tests must set it.
	 */
	readonly plansDir?: string;
}

export async function runIdeBridgeServe(cwdDefault: string, options: RunIdeBridgeServeOptions = {}): Promise<void> {
	setLogDir(cwdDefault);

	// Last-resort guards — any un-caught throw would otherwise crash the daemon
	// and orphan every in-flight future in the Kotlin client. Route to stderr
	// (Node's default for console.error / .warn) so stdout stays clean.
	process.on("uncaughtException", (err) => {
		console.error(
			`[ide-bridge-serve] uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
		);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(
			`[ide-bridge-serve] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}`,
		);
	});

	const handshake: HandshakeLine = {
		jsonrpc: "2.0",
		method: "ready",
		params: {
			protocol: IDE_BRIDGE_PROTOCOL,
			pluginVersion: typeof __CLI_PKG_VERSION__ !== "undefined" ? __CLI_PKG_VERSION__ : "dev",
			pid: process.pid,
		},
	};
	writeServeLine(handshake);

	// Same stdout is used for two message families:
	//   - request/response pairs (this loop below)
	//   - server→client refresh notifications from fs.watch on the write outputs
	// Merging both into one process (scheme A') means the Kotlin host only
	// spawns and manages a single Node child; notifications carry no `id`, so
	// the host can route them by envelope `type` alone.
	const watchers = startRefreshWatchers(cwdDefault, options.plansDir);

	const readline = await import("node:readline");
	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

	const pending = new Set<Promise<void>>();
	for await (const rawLine of rl) {
		if (rawLine.trim().length === 0) continue;
		const task = handleServeLine(rawLine, cwdDefault).catch((err) => {
			// handleServeLine already writes a JSON error line for any expected
			// failure; this catch only fires if the writer itself threw (e.g.
			// EPIPE after the client went away). Log and continue — the read
			// loop will naturally exit next.
			console.error(
				`[ide-bridge-serve] response write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
		pending.add(task);
		task.finally(() => pending.delete(task));
	}

	// stdin closed → stop watchers and let outstanding work finish before
	// exiting so the host receives every pending response instead of a
	// truncated stream.
	stopRefreshWatchers(watchers);
	await Promise.all(pending);
}

/**
 * Debounced fs.watch on the write outputs a host needs to hear about — the
 * git-hook outputs (queue, orphan ref) plus the mid-session working-context
 * pair (plans.json, `~/.claude/plans/`). The target list, its filename gates
 * and the emitted payload all live in `computeWatchTargets` /
 * `buildRefreshParams` so this server and the standalone `jolli daemon` cannot
 * drift into watching or emitting different things.
 *
 * Bursts collapse into one refresh line per kind after the watcher's quiet
 * window. Notification envelope carries no `id` — the host distinguishes it
 * from a response by the absence of that field and routes by `type` alone.
 * When the target directory does not yet exist (typical for orphan-ref on a
 * fresh clone, or `~/.claude/plans/` before the user's first plan), start a
 * retry timer that polls until it appears and arm the watcher then.
 *
 * `plansDir` is the test override — see [RunIdeBridgeServeOptions.plansDir].
 */
function startRefreshWatchers(
	cwd: string,
	plansDir?: string,
): {
	watchers: DaemonWatcher[];
	armRetries: NodeJS.Timeout[];
} {
	const DEBOUNCE_MS = 300;
	const ARM_RETRY_MS = 5000;
	const watchers: DaemonWatcher[] = [];
	const armRetries: NodeJS.Timeout[] = [];
	for (const target of computeWatchTargets(cwd, { plansDir })) {
		const watcher = new DaemonWatcher({
			path: target.path,
			debounceMs: DEBOUNCE_MS,
			ensureDir: target.ensureDir,
			filter: target.filter,
			onTrigger: (names) => {
				// JSON-RPC 2.0 server→client notification (no `id`).
				writeServeLine({
					jsonrpc: "2.0",
					method: "refresh",
					params: buildRefreshParams(target, cwd, names),
				});
			},
		});
		if (!watcher.start()) {
			const retry = setInterval(() => {
				if (watcher.start()) {
					clearInterval(retry);
					const idx = armRetries.indexOf(retry);
					if (idx >= 0) armRetries.splice(idx, 1);
				}
			}, ARM_RETRY_MS);
			retry.unref?.();
			armRetries.push(retry);
		}
		watchers.push(watcher);
	}
	return { watchers, armRetries };
}

function stopRefreshWatchers({
	watchers,
	armRetries,
}: {
	watchers: DaemonWatcher[];
	armRetries: NodeJS.Timeout[];
}): void {
	for (const w of watchers) w.stop();
	for (const t of armRetries) clearInterval(t);
}

/** Dispatches one line; always writes exactly one response line (success or error). */
async function handleServeLine(line: string, cwdDefault: string): Promise<void> {
	writeServeLine(await computeServeResponse(line, cwdDefault));
}

/**
 * Turns one request line into its response envelope — the object that the
 * daemon would otherwise pass straight to [writeServeLine]. Split out from
 * [handleServeLine] so vitest can exercise it without touching stdin/stdout
 * or spawning readline. Never throws — every failure (malformed JSON,
 * validator, handler exception) produces an `error`-typed envelope.
 */
export async function computeServeResponse(line: string, cwdDefault: string): Promise<Record<string, unknown>> {
	let id: number | string | null = null;
	try {
		const parsed: unknown = JSON.parse(line);
		id = extractRequestId(parsed);
		const req = normaliseServeRequest(parsed);
		id = req.id;
		const cwd = req.cwd && req.cwd.length > 0 ? req.cwd : cwdDefault;
		// Adopt the IDE-supplied trace id (when present) so this action's
		// outbound HTTP calls carry the caller's x-jolli-trace, keeping IDE
		// logs, CLI logs, and backend logs correlated. `runWithTrace` falls
		// back to a fresh id when the value isn't a well-formed trace id.
		// Intentionally unconditional: even without an IDE-supplied traceId,
		// every daemon-served request gets its own trace scope so all outbound
		// HTTP calls are correlated in backend logs.
		const result = await runWithTrace(req.traceId, () => runIdeBridgeAction(req.action, cwd, req.request ?? {}));
		return { jsonrpc: "2.0", id, result };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		// -32000 is the server-defined error range per JSON-RPC 2.0. Business
		// errors from handlers all funnel here; parse/dispatch failures share
		// the same envelope so the host has one code path.
		const data: Record<string, unknown> = {};
		if (error instanceof Error && error.name.length > 0) {
			data.errorName = error.name;
		}
		copyPrimitiveErrorFields(error, data);
		return {
			jsonrpc: "2.0",
			id,
			error: { code: -32000, message, data },
		};
	}
}
