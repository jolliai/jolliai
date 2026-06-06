/**
 * SourceTimeline — turns the four heterogeneous source streams into one
 * deterministic, time-ordered list of not-yet-ingested SourceRefs. This is the
 * single source of truth for the time-fold's "old → new" ordering, so it is
 * isolated and pure-by-input: same disk snapshot + same processed set → same
 * ordered list.
 */

import { listFolderPlanNoteRefs } from "./FolderPlanNoteSource.js";
import { FolderStorage } from "./FolderStorage.js";
import { listAllUserKnowledge, listAllUserKnowledgeFromRoot } from "./MemoryBankScanner.js";
import { hasProcessed } from "./ProcessedSourceStore.js";
import { createReadStorage } from "./ReadStorageResolver.js";
import { loadPlansRegistry } from "./SessionTracker.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getIndex } from "./SummaryStore.js";
import type { ProcessedSet, SourceRef, SourceType } from "./TopicKBTypes.js";

/** Fixed tie-break rank for equal-instant sources (parent spec §3.2). */
const TYPE_RANK: Record<SourceType, number> = { summary: 0, plan: 1, note: 2, userfile: 3 };

/**
 * Total order over SourceRefs: epoch ascending, then (type rank, id) tie-break.
 * Timestamps are parsed to epoch (NOT compared as strings) so timezone offsets
 * order correctly. Unparseable timestamps sort after all valid ones, then fall
 * through to the deterministic type/id tie-break.
 */
export function compareSourceRefs(a: SourceRef, b: SourceRef): number {
	const ta = Date.parse(a.timestamp);
	const tb = Date.parse(b.timestamp);
	const av = Number.isNaN(ta) ? null : ta;
	const bv = Number.isNaN(tb) ? null : tb;
	if (av !== null && bv !== null && av !== bv) return av - bv;
	if (av === null && bv !== null) return 1; // NaN after valid
	if (bv === null && av !== null) return -1;
	if (a.type !== b.type) return TYPE_RANK[a.type] - TYPE_RANK[b.type];
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Enumerates every source across the four streams as SourceRefs. Root commit
 * summaries only (parentCommitHash null/undefined) — matching the existing
 * compile input contract. User files are scanned once per distinct branch (so
 * branch-scoped files are not silently dropped) plus once for global/repo when
 * the index is empty, then deduped by `path@fingerprint`.
 *
 * NOTE on `storage`: it scopes the **summary index** read only. Plans and notes
 * always come from the per-project `.jolli/jollimemory/plans.json` via
 * `loadPlansRegistry(cwd)`, and user files from `listUserKnowledge(cwd, …)` —
 * neither goes through `StorageProvider`. Tests that need to control plans/notes
 * must mock those loaders, not the injected `storage`.
 */
export async function collectAllSourceRefs(cwd: string, storage?: StorageProvider): Promise<SourceRef[]> {
	const readStorage = storage ?? (await createReadStorage(cwd));
	const kbRoot = readStorage instanceof FolderStorage ? readStorage.kbRoot : null;
	const refs: SourceRef[] = [];

	const index = await getIndex(cwd, readStorage);
	if (index) {
		for (const e of index.entries) {
			if (e.parentCommitHash === null || e.parentCommitHash === undefined) {
				refs.push({ type: "summary", id: e.commitHash, timestamp: e.commitDate, branch: e.branch });
			}
		}
	}

	// Folder/dual-write: read plan/note straight from the Memory Bank folder.
	// Orphan-only (no folder): keep the working-repo plans.json registry path.
	if (kbRoot) {
		refs.push(...(await listFolderPlanNoteRefs(kbRoot)));
	} else {
		const registry = await loadPlansRegistry(cwd);
		// Orphan-only (legacy) registry entries carry no branch — `branch` was
		// deliberately stripped from PlanEntry/NoteEntry by the 2026-06-01
		// plans.json migration. `SourceRef.branch` is optional, so we omit it
		// here; the folder path above still derives branch from the visible path,
		// so the default dual-write mode is unaffected.
		for (const p of Object.values(registry.plans)) {
			refs.push({ type: "plan", id: p.slug, timestamp: p.updatedAt });
		}
		for (const n of Object.values(registry.notes ?? {})) {
			refs.push({ type: "note", id: n.id, timestamp: n.updatedAt });
		}
	}

	// User files are enumerated disk-driven (global + repo + every branch folder
	// present), NOT from the summary index's branch list — a branch with user
	// notes but no summary yet was previously skipped entirely. Dedup by
	// path@fingerprint guards the (rare) same-file-twice case.
	const userFiles = kbRoot ? await listAllUserKnowledgeFromRoot(kbRoot) : await listAllUserKnowledge(cwd);
	const seenUserFiles = new Set<string>();
	for (const f of userFiles) {
		const id = `${f.path}@${f.fingerprint}`;
		if (seenUserFiles.has(id)) continue;
		seenUserFiles.add(id);
		refs.push({ type: "userfile", id, timestamp: f.mtime });
	}

	return refs;
}

/**
 * Returns all not-yet-ingested sources sorted old → new. Deterministic for a
 * given disk snapshot + processed set — the single source of truth for the
 * time-fold ordering.
 */
export async function listPendingSources(
	cwd: string,
	processed: ProcessedSet,
	storage?: StorageProvider,
): Promise<ReadonlyArray<SourceRef>> {
	const all = await collectAllSourceRefs(cwd, storage);
	return all.filter((r) => !hasProcessed(processed, r)).sort(compareSourceRefs);
}
