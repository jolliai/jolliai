/**
 * FolderPlanNoteSource — reads plan/note compile sources straight from the
 * Memory Bank folder (`<kbRoot>/.jolli/manifest.json` + `plans|notes/<id>.md`),
 * so compile no longer needs the working repo's plans.json registry. Used for
 * folder/dual-write storage; orphan-only mode keeps the registry path.
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { ManifestEntry } from "./KBTypes.js";
import { MetadataManager } from "./MetadataManager.js";
import { formatSourceHeadline } from "./SourceHeadline.js";
import type { SourceRef } from "./TopicKBTypes.js";

const log = createLogger("FolderPlanNoteSource");

export interface PlanNoteMeta {
	readonly type: "plan" | "note";
	readonly id: string;
	readonly title: string;
	readonly branch: string;
	readonly timestamp: string;
}

/** fileId shapes: `plan:<slug>` / `note:<id>`. */
function idFromFileId(fileId: string): string {
	const colon = fileId.indexOf(":");
	return colon === -1 ? fileId : fileId.slice(colon + 1);
}

function hiddenPath(kbRoot: string, type: "plan" | "note", id: string): string {
	const dir = type === "plan" ? "plans" : "notes";
	return join(kbRoot, ".jolli", dir, `${id}.md`);
}

/** mtime fallback when the manifest entry predates `updatedAt` stamping. */
function mtimeOrEmpty(path: string): string {
	try {
		return statSync(path).mtime.toISOString();
	} catch {
		return "";
	}
}

/** Reverse-derive branch from the visible path's first segment (e.g. `feature-x/plan--p1.md`).
 *  Delegates the folder→branch lookup to {@link MetadataManager.folderToBranch} so this and
 *  MemoryBankScanner share one resolver (incl. the missing-branches.json fallback). */
function branchFromPath(meta: MetadataManager, path: string): string {
	// `split` always yields ≥1 element, so `[0]` is a string (never undefined).
	return meta.folderToBranch(path.split("/")[0]);
}

// Process-wide memo: a single ingest batch loads N plan/note headlines with
// Promise.all (IngestPipeline), and each previously re-opened + re-parsed the
// same manifest.json synchronously — N× blocking I/O on a cold or network-mounted
// Memory Bank folder. Keyed by kbRoot, invalidated by the manifest's mtime so a
// concurrent writer's change is observed on the next call instead of served stale.
// A cheap statSync replaces the expensive readFileSync + JSON.parse on cache hits.
const metaCache = new Map<string, { mtimeMs: number; metas: PlanNoteMeta[] }>();

function readMeta(kbRoot: string): PlanNoteMeta[] {
	const manifestPath = join(kbRoot, ".jolli", "manifest.json");
	let mtimeMs = -1;
	try {
		mtimeMs = statSync(manifestPath).mtimeMs;
	} catch {
		// manifest missing/unreadable — skip the memo and let MetadataManager below
		// take the missing-file path (default empty manifest / WARN on read error).
	}
	const cached = metaCache.get(kbRoot);
	if (cached && mtimeMs !== -1 && cached.mtimeMs === mtimeMs) return cached.metas;

	const meta = new MetadataManager(join(kbRoot, ".jolli"));
	let entries: ManifestEntry[];
	try {
		entries = meta.readManifest().files;
	} catch (err) {
		log.warn("Cannot read manifest at %s: %s", kbRoot, (err as Error).message);
		return [];
	}
	const out: PlanNoteMeta[] = [];
	for (const e of entries) {
		if (e.type !== "plan" && e.type !== "note") continue;
		const id = idFromFileId(e.fileId);
		const branch = e.source?.branch ?? branchFromPath(meta, e.path);
		const timestamp = e.updatedAt ?? mtimeOrEmpty(hiddenPath(kbRoot, e.type, id));
		out.push({ type: e.type, id, title: e.title ?? id, branch, timestamp });
	}
	if (mtimeMs !== -1) metaCache.set(kbRoot, { mtimeMs, metas: out });
	return out;
}

/** Enumerate plan + note sources (not summaries/wiki) for the timeline fold. */
export async function listFolderPlanNoteRefs(kbRoot: string): Promise<SourceRef[]> {
	return readMeta(kbRoot).map((m) => ({ type: m.type, id: m.id, timestamp: m.timestamp, branch: m.branch }));
}

/**
 * Like {@link listFolderPlanNoteRefs} but carries each source's title + branch —
 * for a host that lists plan/note context items for display (the desktop
 * cockpit's Context sub-section), not just the timeline fold's refs.
 */
export async function listFolderPlanNotes(kbRoot: string): Promise<PlanNoteMeta[]> {
	return readMeta(kbRoot);
}

/** Full body for reconcile. null when the hidden source is missing (drops from the fold). */
export async function loadFolderPlanNoteContent(kbRoot: string, ref: SourceRef): Promise<string | null> {
	if (ref.type !== "plan" && ref.type !== "note") return null;
	try {
		return await readFile(hiddenPath(kbRoot, ref.type, ref.id), "utf-8");
	} catch {
		return null;
	}
}

/** One-line headline for the route classifier. */
export async function loadFolderPlanNoteHeadline(kbRoot: string, ref: SourceRef): Promise<string> {
	const m = readMeta(kbRoot).find((x) => x.type === ref.type && x.id === ref.id);
	return formatSourceHeadline(ref.type, m?.branch ?? "?", ref.timestamp, m?.title ?? ref.id);
}
