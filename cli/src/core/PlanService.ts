/**
 * PlanService
 *
 * Central service for all plan management operations:
 * - Discovery: Plans are discovered by the StopHook (in jollimemory) which
 *   incrementally scans transcripts and writes to plans.json. This service
 *   only reads plans.json — no transcript scanning happens here.
 * - Registry: plans.json CRUD (load, save, hard-remove, add)
 * - Resolution: Resolving editable file paths for committed/uncommitted plans
 * - Listing: Available plans for QuickPick selection
 * - Filtering: archive guards (content-hash) + committed-snapshot/orphan rows
 *
 * SHARED BY BOTH IDE HOSTS. VS Code imports this in-process (it bundles
 * `cli/src/**`); IntelliJ reaches the same functions over `jolli ide-bridge`
 * (`plans-*` operations in `IdeBridgeCommand.ts`). The visibility rules below —
 * what counts as an archive guard, a committed snapshot copy, or an orphan —
 * are data-model semantics, not per-host presentation, so they live here rather
 * than being restated per host. A Kotlin re-implementation of them silently
 * drifted from this one before the sink; see AGENTS.md → "IDE hosts are
 * adapters".
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync as fsReadFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, getJolliMemoryDir, isManuallyDisabled } from "../Logger.js";
import type { PlanEntry, PlanInfo, PlanReference } from "../Types.js";
import { withPlansLock } from "./Locks.js";
import { isPathInside } from "./PathUtils.js";
import { getPlansDir } from "./PlanPaths.js";
import { readManualDisableFlagSync } from "./RepoProfile.js";
import {
	loadAllSessions,
	loadPlansRegistry,
	loadPlansRegistryWithStatus,
	savePlansRegistry,
	splitArchivedKey,
} from "./SessionTracker.js";
import type { StorageProvider } from "./StorageProvider.js";
import { storePlans } from "./SummaryStore.js";

const log = createLogger("PlanService");

// ─── Public API ───────────────────────────────────────────────────────────────

// Re-exported so every existing importer (the VS Code shim, the `plans-register-new`
// handler's dynamic import) is unchanged. The definition lives in the leaf
// `PlanPaths` module because `DaemonServer` needs it statically and must not pull
// this module's chain into a cold `ide-bridge` spawn — see PlanPaths' header.
export { getPlansDir };

/**
 * Reads plans.json and returns a filtered, sorted list of PlanInfo.
 *
 * This function does NOT discover new plans from the filesystem — that is the
 * job of (a) the StopHook at turn end (scans transcripts) and (b) the
 * plans-dir watcher's onDidCreate callback wiring `registerNewPlan` in
 * Extension.ts. Scanning the directory here would surface historical plans
 * from other projects/sessions (since ~/.claude/plans/ is global), polluting
 * the per-project panel.
 *
 * The pass also cleans up orphaned entries (uncommitted, file deleted) — a
 * one-shot convergence: a subsequent call with no orphans performs no writes.
 */
export async function detectPlans(cwd: string): Promise<Array<PlanInfo>> {
	// `changed` is true when loadPlansRegistry purged any legacy row/field
	// (one-shot schema migration); persisting it here deterministically cleans
	// plans.json on the first panel refresh after upgrade. `registry` is already
	// normalised, so this save also persists cleaned notes/references.
	const { registry, changed } = await loadPlansRegistryWithStatus(cwd);
	const registryPlans = { ...registry.plans };

	// Clean up orphaned entries (source file deleted, uncommitted, not a guard)
	let cleaned = false;
	for (const [slug, entry] of Object.entries(registryPlans)) {
		if (entry.commitHash === null && !entry.contentHashAtCommit && !existsSync(entry.sourcePath)) {
			delete registryPlans[slug];
			cleaned = true;
		}
	}
	// The write-back is skipped while manually disabled: detectPlans runs on
	// read-side refreshes (including the disabled-startup initialLoad before
	// refreshStatusBar corrects the stores' enabled flags), and the cleanup
	// would write plans.json + plans.lock. Purely a deferral — the next
	// enabled refresh converges identically.
	if ((cleaned || changed) && !isManuallyDisabled()) {
		// Re-run the convergence cleanup on a fresh in-lock snapshot so it can't
		// clobber a concurrent write (the Codex-discovery tick in this host, or a
		// cross-process StopHook/QueueWorker). The display list uses the pre-lock
		// snapshot, which is fine for a read-side refresh.
		await withPlansLock(cwd, async () => {
			const fresh = await loadPlansRegistryWithStatus(cwd);
			const freshPlans = { ...fresh.registry.plans };
			let mutate = fresh.changed;
			for (const [slug, entry] of Object.entries(freshPlans)) {
				if (entry.commitHash === null && !entry.contentHashAtCommit && !existsSync(entry.sourcePath)) {
					delete freshPlans[slug];
					mutate = true;
				}
			}
			if (mutate) await savePlansRegistry({ ...fresh.registry, plans: freshPlans }, cwd);
		});
	}

	const plans = buildPlanInfoList(registryPlans);
	log.info("detectPlans found %d plans (%d in registry)", plans.length, Object.keys(registryPlans).length);
	return plans;
}

/** Converts registry entries into a sorted PlanInfo array, filtering out invisible entries. */
function buildPlanInfoList(registryPlans: Record<string, PlanEntry>): Array<PlanInfo> {
	const plans: Array<PlanInfo> = [];
	for (const entry of Object.values(registryPlans)) {
		const info = toPlanInfo(entry);
		if (info) {
			plans.push(info);
		}
	}
	plans.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
	return plans;
}

/** Converts a single PlanEntry to PlanInfo, returning null if the entry should be hidden. */
function toPlanInfo(entry: PlanEntry): PlanInfo | null {
	// Skip archive guards (source file unchanged)
	if (entry.contentHashAtCommit) {
		const planFile = entry.sourcePath;
		if (!existsSync(planFile) || hashFileContent(planFile) === entry.contentHashAtCommit) {
			return null;
		}
	}

	// Skip committed snapshot copies (slug-<shortHash> entries created by archivePlanForCommit).
	// These exist only for orphan branch storage / Summary WebView, not for the sidebar panel.
	if (entry.commitHash !== null && !entry.contentHashAtCommit) {
		return null;
	}

	// Skip uncommitted plans whose source file was deleted
	if (entry.commitHash === null && !existsSync(entry.sourcePath)) {
		return null;
	}

	// Keep the on-disk path for committed-then-modified guard rows too: the row
	// is only visible because the source file changed after the commit, so Edit
	// and Preview must open that local file — mirrors NoteService.toNoteInfo,
	// which never blanks filePath for guard rows.
	const filePath = entry.sourcePath;

	let title = entry.title;
	if (existsSync(entry.sourcePath)) {
		title = extractTitle(entry.sourcePath);
	}

	let lastModified = entry.updatedAt;
	if (existsSync(entry.sourcePath)) {
		try {
			lastModified = statSync(entry.sourcePath).mtime.toISOString();
		} catch {
			/* ignore — stat failure is non-critical */
		}
	}

	return {
		slug: entry.slug,
		filename: `${entry.slug}.md`,
		filePath,
		title,
		lastModified,
		addedAt: entry.addedAt,
		updatedAt: entry.updatedAt,
		commitHash: entry.commitHash,
	};
}

/**
 * Hard-removes a plan from plans.json: deletes the registry entry, and deletes
 * the source file ONLY when it lives inside the per-project `.jolli/jollimemory/`
 * directory. Plan source files are almost always external (`~/.claude/plans/`,
 * repo `docs/`, external note dirs), so in practice the file is preserved and
 * only the registry row is removed — matching `NoteService.removeNote`'s
 * "delete the internal backing file, never touch external user files" rule.
 *
 * Idempotent: an unknown slug is a no-op. Allows revival — no `ignored`
 * tombstone is left, so re-adding the same plan file re-registers it.
 *
 * `expectedCommitHash` (passed by the commit-summary dissociate flow) gates EVERY
 * delete — both the exact-key match and the archive-base fallback — on the row
 * still belonging to that commit (`row.commitHash === expectedCommitHash`). A
 * registry row is a single time-evolving slot: an archived slug like
 * `plan-x-abcdef12` from an old summary can later become a LIVE plan created
 * under that very key (commitHash=null), or the base can be revived/re-committed
 * elsewhere. Gating on commitHash means dissociating an OLD commit never wipes a
 * row that has moved on. Sidebar removal (no `expectedCommitHash`) deletes the
 * exact key unconditionally — that's the user explicitly removing the live plan.
 */
export async function removePlan(slug: string, cwd: string, expectedCommitHash?: string): Promise<void> {
	// Resolve, gate, and delete all on ONE fresh read inside plans.lock so the
	// commit gate is checked against the same snapshot we delete from (and a
	// concurrent write to another row survives). Returns the deleted entry so the
	// backing-file cleanup can run AFTER the lock; returns null on a no-op.
	const removed = await withPlansLock(cwd, async () => {
		const registry = await loadPlansRegistry(cwd);
		// Resolve the registry key to delete.
		let key: string | undefined;
		if (expectedCommitHash === undefined) {
			// Sidebar / cleanup path: exact key only, delete whatever lives there.
			key = registry.plans[slug] !== undefined ? slug : undefined;
		} else {
			// Commit-dissociate path: only delete a row still owned by THIS commit.
			// Exact key first; then the archive base (`<base>-<8hex>` → `<base>`),
			// which handles squash/rebase where the summary slug keeps the old hash.
			if (registry.plans[slug]?.commitHash === expectedCommitHash) {
				key = slug;
			} else {
				const split = splitArchivedKey(slug);
				if (split && registry.plans[split.baseKey]?.commitHash === expectedCommitHash) {
					key = split.baseKey;
				}
			}
		}
		if (key === undefined) {
			return null;
		}
		const entry = registry.plans[key];
		if (!entry) {
			return null;
		}
		const plans = { ...registry.plans };
		delete plans[key];
		await savePlansRegistry({ ...registry, plans }, cwd);
		return { entry };
	});
	if (removed === null) {
		return;
	}
	// Delete the backing file only when it is inside .jolli/jollimemory/ —
	// external plan files (the common case) are the user's own, never deleted.
	// Done after the lock: the registry row is already gone, so a failed unlink
	// can't strand state.
	const { entry } = removed;
	if (isPathInside(entry.sourcePath, getJolliMemoryDir(cwd)) && existsSync(entry.sourcePath)) {
		try {
			unlinkSync(entry.sourcePath);
		} catch {
			/* best-effort — the registry row is already removed */
		}
	}
}

/**
 * Syncs a plan row's title after its markdown file was edited, so the sidebar
 * and the commit summary agree on what the plan is called.
 *
 * Callers pass the title they already extracted from the edited buffer (the
 * on-disk file may not have been written yet). Idempotent: an unknown slug is a
 * no-op — the summary-side rename still stands on its own.
 */
export async function renamePlanTitle(slug: string, title: string, cwd: string): Promise<void> {
	// plans.lock + fresh re-read so this title sync merges onto the latest state
	// instead of clobbering a concurrent write (a discovery tick in the calling
	// host, or a cross-process StopHook/QueueWorker).
	await withPlansLock(cwd, async () => {
		const registry = await loadPlansRegistry(cwd);
		const entry = registry.plans[slug];
		if (!entry) return;
		await savePlansRegistry({ ...registry, plans: { ...registry.plans, [slug]: { ...entry, title } } }, cwd);
	});
}

/**
 * Adds a plan from ~/.claude/plans/ to the registry as an uncommitted entry.
 * Resets any prior committed/guard state so the plan becomes editable again.
 */
export async function addPlanToRegistry(slug: string, cwd: string): Promise<void> {
	const planFile = join(getPlansDir(), `${slug}.md`);
	if (!existsSync(planFile)) {
		return;
	}

	const registry = await loadPlansRegistry(cwd);
	const existing = registry.plans[slug];
	const now = new Date().toISOString();

	// Always reset to a fresh uncommitted entry — clears contentHashAtCommit
	// and commitHash so the plan becomes visible and editable again.
	const entry: PlanEntry = {
		slug,
		title: extractTitle(planFile),
		sourcePath: planFile,
		addedAt: existing?.addedAt ?? now,
		updatedAt: now,
		commitHash: null,
	};

	// plans.lock + fresh re-read so this single-plan upsert merges onto the latest
	// state instead of clobbering a concurrent write.
	await withPlansLock(cwd, async () => {
		const fresh = await loadPlansRegistry(cwd);
		await savePlansRegistry({ ...fresh, plans: { ...fresh.plans, [slug]: entry } }, cwd);
	});
}

/**
 * Registers a plan slug into plans.json iff it isn't already tracked.
 *
 * - If the slug is already tracked, this is a no-op (it preserves the existing
 *   entry's committed/guard state rather than resetting it).
 * - Otherwise creates a fresh uncommitted entry.
 *
 * Designed to be called from the plans-dir watcher's `onDidCreate` callback:
 * the OS only fires create events for files appearing after the watcher is
 * subscribed, so historical plans from other projects/sessions in
 * ~/.claude/plans/ never reach this function.
 *
 * The check and write run under plans.lock to prevent a race where a concurrent
 * StopHook write lands between the check and the add (the lock would ensure the
 * final state is a consistent read-modify-write, not a reset to uncommitted).
 */
export async function registerNewPlan(slug: string, cwd: string): Promise<void> {
	// The plans-dir watcher keeps firing while the project is manually
	// disabled (Claude Code sessions can still save plan files); registering
	// would write plans.json + plans.lock in the project dir. The plan is not
	// lost — re-enabling and saving it again (or the StopHook once hooks are
	// reinstalled) registers it.
	//
	// isManuallyDisabled() is in-process only (inert in CLI/hook processes);
	// readManualDisableFlagSync gates the durable on-disk flag that persists
	// across process boundaries (esp. the long-lived ide-bridge-serve daemon).
	if (isManuallyDisabled() || readManualDisableFlagSync(cwd)) return;

	const planFile = join(getPlansDir(), `${slug}.md`);
	if (!existsSync(planFile)) {
		return;
	}

	// Check and register under the lock to avoid a race where a concurrent StopHook
	// write lands between the check and the add.
	await withPlansLock(cwd, async () => {
		const registry = await loadPlansRegistry(cwd);
		if (slug in registry.plans) {
			return;
		}
		const now = new Date().toISOString();
		const entry: PlanEntry = {
			slug,
			title: extractTitle(planFile),
			sourcePath: planFile,
			addedAt: now,
			updatedAt: now,
			commitHash: null,
		};
		await savePlansRegistry({ ...registry, plans: { ...registry.plans, [slug]: entry } }, cwd);
	});
}

/**
 * Returns true iff the given plan file's absolute path appears in one of the
 * transcripts belonging to the current project.
 *
 * Why: `~/.claude/plans/` is global across projects. When multiple VS Code
 * instances are open on different workspaces, the OS delivers a single
 * `onDidCreate` event to every subscriber watching that directory. Without a
 * project-affinity check, a plan created by project B's Claude session would
 * get registered into project A's plans.json as well. This helper restores
 * the attribution that the StopHook path has always had (it only scans the
 * current project's transcripts).
 *
 * Matching strategy: we look for the absolute path as a substring in the raw
 * transcript text. Claude Code records Write/Edit `tool_use` entries with
 * `"file_path":"<absPath>"`. Because transcripts are JSON-escaped, backslashes
 * on Windows appear doubled (`\\`), so we compare against the escaped form.
 */
export async function isPlanFromCurrentProject(absPath: string, cwd: string): Promise<boolean> {
	const sessions = await loadAllSessions(cwd);
	if (sessions.length === 0) {
		return false;
	}
	// JSON-escaped form of the path, matching how Claude Code writes file_path
	// values into transcript JSONL lines.
	const needle = absPath.replace(/\\/g, "\\\\");
	for (const session of sessions) {
		try {
			const content = await readFile(session.transcriptPath, "utf-8");
			if (content.includes(needle)) {
				return true;
			}
		} catch {
			// Transcript missing or unreadable (rotated, permission issue) —
			// skip; attribution just falls through to StopHook later.
		}
	}
	return false;
}

/**
 * Lists all plan files in ~/.claude/plans/ that are NOT in the exclude set.
 * Returns { slug, title, mtimeMs } sorted by modification time (newest first).
 *
 * `mtimeMs` is a WHOLE number of milliseconds, and that is a wire contract, not
 * a cosmetic choice. `statSync().mtimeMs` carries sub-millisecond precision on
 * every filesystem this ships to (APFS and ext4 both store nanoseconds), so the
 * raw value serialises as e.g. `1785768117378.9856`. This result crosses the
 * `working-context` ide-bridge to IntelliJ, where Gson deserialises it into a
 * Kotlin `Long` — and `JsonReader.nextLong` REJECTS a fractional literal rather
 * than truncating it, so the raw value failed the whole `plans-list-available`
 * response and took the Add Plan picker with it. Truncating here keeps the wire
 * integral for every consumer instead of asking each one to be tolerant. The
 * field only orders the picker, so the discarded fraction costs nothing.
 */
export function listAvailablePlans(
	excludeSlugs: ReadonlySet<string>,
): ReadonlyArray<{ slug: string; title: string; mtimeMs: number }> {
	if (!existsSync(getPlansDir())) {
		return [];
	}

	const files = readdirSync(getPlansDir()).filter((f) => f.endsWith(".md"));
	const available: Array<{ slug: string; title: string; mtimeMs: number }> = [];

	for (const file of files) {
		const slug = file.replace(/\.md$/, "");
		if (excludeSlugs.has(slug)) {
			continue;
		}
		const filePath = join(getPlansDir(), file);
		try {
			const mtime = Math.trunc(statSync(filePath).mtimeMs);
			available.push({ slug, title: extractTitle(filePath), mtimeMs: mtime });
		} catch {
			available.push({ slug, title: extractTitle(filePath), mtimeMs: 0 });
		}
	}

	return available.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ─── WebView plan operations ──────────────────────────────────────────────────

/**
 * Archives a plan and associates it with a commit (called from WebView "+ Associate Plan").
 * Mirrors PostCommitHook's archive logic: renames slug to slug-hash, sets archive guard
 * on original slug (contentHashAtCommit), stores plan file in orphan branch.
 *
 * @returns PlanReference for inclusion in CommitSummary.plans
 */
export async function archivePlanForCommit(
	slug: string,
	commitHash: string,
	cwd: string,
	storage?: StorageProvider,
): Promise<PlanReference | null> {
	const registry = await loadPlansRegistry(cwd);
	let entry = registry.plans[slug];

	// If slug is not in the registry (e.g., picked from ~/.claude/plans/ directory but
	// never auto-discovered from transcript), create a fresh entry first.
	if (!entry) {
		const planFile = join(getPlansDir(), `${slug}.md`);
		if (!existsSync(planFile)) {
			return null;
		}
		entry = {
			slug,
			title: extractTitle(planFile),
			sourcePath: planFile,
			addedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			commitHash: null,
		};
	}

	const now = new Date().toISOString();
	const shortHash = commitHash.substring(0, 8);
	const newSlug = `${slug}-${shortHash}`;

	// Compute content hash for archive guard
	let contentHashAtCommit: string | undefined;
	if (existsSync(entry.sourcePath)) {
		contentHashAtCommit = hashFileContent(entry.sourcePath);
	}

	// Update plans.json: the original slug becomes the guard. No
	// `<slug>-<shortHash>` archive row — the orphan-branch snapshot (stored under
	// newSlug below) + the CommitSummary PlanReference are the system of record.
	const guardEntry: PlanEntry = {
		...entry,
		commitHash,
		updatedAt: now,
		contentHashAtCommit,
	};
	// plans.lock + fresh re-read so the guard upsert merges onto the latest state.
	await withPlansLock(cwd, async () => {
		const fresh = await loadPlansRegistry(cwd);
		await savePlansRegistry({ ...fresh, plans: { ...fresh.plans, [slug]: guardEntry } }, cwd);
	});

	// Store plan file in orphan branch under new slug.
	//
	// Source path: read from entry.sourcePath (same path used for
	// contentHashAtCommit above) so the two snapshots can't diverge — and so
	// external plans (e.g. docs/foo.md) are archived correctly.
	//
	// storePlans branch arg (below): intentionally left undefined.
	// FolderStorage.resolveBranchFromSlug uses the commit hash embedded in
	// `newSlug` to look up the commit's branch from the manifest / index —
	// that's the right home for the visible <branch>/plan--<slug>.md.
	const planFile = entry.sourcePath;
	if (existsSync(planFile)) {
		const content = fsReadFileSync(planFile, "utf-8");
		await storePlans(
			[{ slug: newSlug, content }],
			`Associate plan ${newSlug} with commit ${shortHash}`,
			cwd,
			undefined,
			storage,
		);
	}

	log.info("Archived plan %s → %s for commit %s", slug, newSlug, shortHash);

	return {
		slug: newSlug,
		title: entry.title,
		addedAt: entry.addedAt,
		updatedAt: now,
	};
}

/**
 * Lists unassociated (uncommitted) plans from plans.json for WebView QuickPick.
 */
export async function listUnassociatedPlans(cwd: string): Promise<ReadonlyArray<{ slug: string; title: string }>> {
	const registry = await loadPlansRegistry(cwd);
	return Object.values(registry.plans)
		.filter((p) => p.commitHash === null)
		.map((p) => ({ slug: p.slug, title: p.title }));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Extracts the first # heading from a markdown file, falling back to the filename. */
export function extractTitle(filePath: string): string {
	const filename = filePath.split(/[/\\]/).pop() as string;
	try {
		const content = fsReadFileSync(filePath, "utf-8");
		const match = /^#\s+(.+)/m.exec(content);
		return match?.[1]?.trim() ?? filename;
	} catch {
		return filename;
	}
}

function hashFileContent(filePath: string): string {
	return createHash("sha256").update(fsReadFileSync(filePath, "utf-8")).digest("hex");
}
