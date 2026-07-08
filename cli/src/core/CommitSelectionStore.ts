/**
 * CommitSelectionStore
 *
 * Persists the sidebar item selection that shapes the next summary pipeline
 * run, in `<projectDir>/.jolli/jollimemory/commit-selection.json`. Two layers:
 *
 *   1. User manual EXCLUDE set (four kinds: conversations/plans/notes/references).
 *      This is the original v1/v2 shape — the top-level `conversations` / `plans`
 *      / `notes` / `references` arrays. Read by `readExclusions`, whose contract
 *      is UNCHANGED: it returns exactly this set. Multiple consumers
 *      (QueueWorker, PlansTreeProvider, SelectAllSelection) treat it as
 *      "user unchecked these" — do not change what it returns.
 *
 *   2. AI suggestion (`aiSuggestedExclude` + `changeFingerprint`) — the
 *      relevance ranker's soft-exclude list with a per-item reason, written
 *      by the pre-commit Review panel so the post-commit QueueWorker can reuse
 *      it when the fingerprint matches (otherwise QueueWorker recomputes). The
 *      user dismisses a single AI suggestion via `removeAiExclusion` (drops that
 *      entry so the item lands normally). There is NO separate "user include"
 *      layer — dismissing edits this list directly, so a dismiss is a per-change
 *      (non-persistent across a re-rank) override, which is the intended model.
 *
 * Version stays at 2 ON PURPOSE. Bumping to 3 would make an older CLI/extension
 * reader (which hard-rejects unknown versions and returns an empty set) silently
 * DISCARD the user's manual excludes. Keeping version === 2 and adding the new
 * fields as OPTIONAL extra keys means an old reader still reads the four arrays
 * it knows and simply ignores the rest — true forward compatibility. Newer
 * fields are written only when non-empty so the file shape is unchanged for
 * users who never touch the AI-relevance feature.
 *
 * Sticky semantics: entries persist until explicitly changed by the user. The
 * QueueWorker only READS this file; it never writes AI results back here (it
 * writes the audit trail to CommitSummary.excludedContext instead), which keeps
 * a cross-process file lock unnecessary.
 *
 * Schema versions (all read at version 2):
 *   - v1: { conversations, plans, notes } (references migrates to empty)
 *   - v2: + references
 *   - v2+ (this file): + optional aiSuggestedExclude / changeFingerprint.
 *         Transparent to older readers. (A legacy `userIncluded` key from an
 *         earlier build is ignored on read and dropped on the next write.)
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, isEnoent, JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import type { TranscriptSource } from "../Types.js";
import { withCommitSelectionLock } from "./Locks.js";

const log = createLogger("CommitSelection");

const SELECTION_FILE = "commit-selection.json";
const SELECTION_VERSION = 2 as const;

export type ExclusionKind = "conversations" | "plans" | "notes" | "references";

export interface CommitExclusions {
	readonly conversations: ReadonlySet<string>;
	readonly plans: ReadonlySet<string>;
	readonly notes: ReadonlySet<string>;
	/** Per-source reference key `<source>:<nativeId>`. */
	readonly references: ReadonlySet<string>;
}

/** One AI-suggested soft-exclusion with its reason (panel reuse by the worker). No
 *  score: the LLM's numeric score lives only in the panel's in-process relevanceCache
 *  (surfaced as the tier); the worker only needs kind/key/reason to reconstruct the
 *  exclude set, so persisting a score here was dead weight (always written as 0). */
export interface AiExclusion {
	readonly kind: ExclusionKind;
	readonly key: string;
	readonly reason: string;
}

/** The AI-relevance layer read back for reuse by the QueueWorker / panel. */
export interface AiSelection {
	readonly aiExcluded: ReadonlyArray<AiExclusion>;
	readonly changeFingerprint?: string;
}

interface PersistedShape {
	readonly version: typeof SELECTION_VERSION;
	readonly conversations: readonly string[];
	readonly notes: readonly string[];
	readonly plans: readonly string[];
	readonly references: readonly string[];
	readonly aiSuggestedExclude?: readonly AiExclusion[];
	readonly changeFingerprint?: string;
}

function selectionPath(projectDir: string): string {
	return join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, SELECTION_FILE);
}

/**
 * Encode (source, sessionId) into a single string key. The colon is
 * reserved across jollimemory (TranscriptSource values never contain one).
 */
export function conversationKey(source: TranscriptSource, sessionId: string): string {
	return `${source}:${sessionId}`;
}

function asStringArray(v: unknown): readonly string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

function asAiExclusions(v: unknown): readonly AiExclusion[] {
	if (!Array.isArray(v)) return [];
	const kinds = new Set<ExclusionKind>(["conversations", "plans", "notes", "references"]);
	const out: AiExclusion[] = [];
	for (const x of v) {
		if (x === null || typeof x !== "object") continue;
		const o = x as Record<string, unknown>;
		if (
			typeof o.kind === "string" &&
			kinds.has(o.kind as ExclusionKind) &&
			typeof o.key === "string" &&
			typeof o.reason === "string"
		) {
			// Extract only kind/key/reason — a legacy `score` from an older file is dropped.
			out.push({ kind: o.kind as ExclusionKind, key: o.key, reason: o.reason });
		}
	}
	return out;
}

/**
 * Reads the raw persisted shape (with migration + defaults). Internal — public
 * readers project specific layers out of it. Returns null-equivalent empty
 * shape on missing/corrupt/unknown-version file.
 */
async function readPersisted(projectDir: string): Promise<PersistedShape> {
	const empty: PersistedShape = {
		version: SELECTION_VERSION,
		conversations: [],
		notes: [],
		plans: [],
		references: [],
	};
	let raw: string;
	try {
		raw = await readFile(selectionPath(projectDir), "utf8");
	} catch (err) {
		if (!isEnoent(err)) log.warn("readPersisted read failed: %s", errMsg(err));
		return empty;
	}
	let parsed: Partial<PersistedShape>;
	try {
		parsed = JSON.parse(raw) as Partial<PersistedShape>;
	} catch (err) {
		log.warn("readPersisted JSON parse failed: %s", errMsg(err));
		return empty;
	}
	// v1 and v2 both read here; anything else is an unrecognized schema.
	if (parsed.version !== SELECTION_VERSION && parsed.version !== 1) {
		log.warn("readPersisted version mismatch (got %s) — ignoring file", String(parsed.version));
		return empty;
	}
	// A legacy `userIncluded` key (from an earlier build) is intentionally not read
	// — the dismiss model edits aiSuggestedExclude directly, so it's simply dropped
	// on the next write.
	return {
		version: SELECTION_VERSION,
		conversations: asStringArray(parsed.conversations),
		notes: asStringArray(parsed.notes),
		plans: asStringArray(parsed.plans),
		references: asStringArray(parsed.references),
		...(parsed.aiSuggestedExclude ? { aiSuggestedExclude: asAiExclusions(parsed.aiSuggestedExclude) } : {}),
		...(typeof parsed.changeFingerprint === "string" ? { changeFingerprint: parsed.changeFingerprint } : {}),
	};
}

/** Reads the USER MANUAL EXCLUDE set. Contract unchanged from v1/v2. */
export async function readExclusions(projectDir: string): Promise<CommitExclusions> {
	const p = await readPersisted(projectDir);
	return {
		conversations: new Set(p.conversations),
		plans: new Set(p.plans),
		notes: new Set(p.notes),
		references: new Set(p.references),
	};
}

/** Reads the AI-relevance layer (AI exclude suggestions + change fingerprint). */
export async function readAiSelection(projectDir: string): Promise<AiSelection> {
	const p = await readPersisted(projectDir);
	return {
		aiExcluded: p.aiSuggestedExclude ?? [],
		...(p.changeFingerprint !== undefined ? { changeFingerprint: p.changeFingerprint } : {}),
	};
}

/** Serializes the shape, omitting new fields when empty to keep the file shape
 *  unchanged for users who never touch the AI-relevance feature. */
function serializePersisted(p: PersistedShape): PersistedShape {
	return {
		version: SELECTION_VERSION,
		conversations: p.conversations,
		plans: p.plans,
		notes: p.notes,
		references: p.references,
		...(p.aiSuggestedExclude && p.aiSuggestedExclude.length > 0
			? { aiSuggestedExclude: p.aiSuggestedExclude }
			: {}),
		...(p.changeFingerprint ? { changeFingerprint: p.changeFingerprint } : {}),
	};
}

async function writePersisted(projectDir: string, next: PersistedShape): Promise<void> {
	const dir = join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR);
	await mkdir(dir, { recursive: true });
	const payload = serializePersisted(next);
	const tmp = `${selectionPath(projectDir)}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, JSON.stringify(payload, null, "\t"), "utf8");
	try {
		await rename(tmp, selectionPath(projectDir));
	} catch (err) {
		// Atomic-write swap: best-effort cleanup of the temp file on a failed
		// rename (Windows EPERM/EBUSY from AV / watchers), then surface the
		// original error rather than a misleading cleanup wrapper.
		await unlink(tmp).catch(() => undefined);
		throw err;
	}
}

// In-process serialization queue keyed by projectDir — same-process setters run one at
// a time. Each `work` additionally runs under withCommitSelectionLock so the pre-commit
// panel and the post-commit QueueWorker (which clears the AI layer after consuming
// it) don't lose-update each other ACROSS processes. One chain per
// projectDir keeps cross-project work parallel.
const writeChains = new Map<string, Promise<void>>();

function serialize<T>(projectDir: string, work: () => Promise<T>): Promise<T> {
	const locked = () => withCommitSelectionLock(projectDir, work);
	const prior = writeChains.get(projectDir) ?? Promise.resolve();
	const next = prior.then(locked, locked);
	writeChains.set(
		projectDir,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

/** Adds/removes a key from the USER MANUAL EXCLUDE set (preserving other layers). */
export async function setExcluded(
	projectDir: string,
	kind: ExclusionKind,
	key: string,
	excluded: boolean,
): Promise<void> {
	return serialize(projectDir, async () => {
		const p = await readPersisted(projectDir);
		const set = new Set(p[kind]);
		if (excluded) set.add(key);
		else set.delete(key);
		await writePersisted(projectDir, { ...p, [kind]: [...set] });
	});
}

/** Bulk add/remove for a kind in the USER MANUAL EXCLUDE set. */
export async function setAllExcluded(
	projectDir: string,
	kind: ExclusionKind,
	keys: readonly string[],
	excluded: boolean,
): Promise<void> {
	return serialize(projectDir, async () => {
		const p = await readPersisted(projectDir);
		const set = new Set(p[kind]);
		for (const k of keys) {
			if (excluded) set.add(k);
			else set.delete(k);
		}
		await writePersisted(projectDir, { ...p, [kind]: [...set] });
	});
}

/**
 * Dismisses one AI soft-exclude suggestion: removes the matching (kind, key) entry
 * from `aiSuggestedExclude` so the item lands normally in the summary. This is the
 * whole "user overrides the AI" mechanism — there is no separate persistent include
 * layer; the user edits the AI list directly. Preserves the rest of the list + the
 * change fingerprint so the QueueWorker's fingerprint reuse still holds.
 */
export async function removeAiExclusion(projectDir: string, kind: ExclusionKind, key: string): Promise<void> {
	return serialize(projectDir, async () => {
		const p = await readPersisted(projectDir);
		const filtered = (p.aiSuggestedExclude ?? []).filter((e) => !(e.kind === kind && e.key === key));
		await writePersisted(projectDir, { ...p, aiSuggestedExclude: filtered });
	});
}

/**
 * Writes the AI suggestion layer (soft-exclude list + change fingerprint) for the
 * QueueWorker to reuse when its fingerprint matches. Called by the pre-commit panel.
 * (The worker doesn't call THIS one, but it DOES clear the layer post-consume via
 * clearAiSelection — both go through withCommitSelectionLock.) Passing an empty list
 * and no fingerprint clears the layer.
 */
export async function writeAiSelection(
	projectDir: string,
	aiExcluded: readonly AiExclusion[],
	changeFingerprint?: string,
): Promise<void> {
	return serialize(projectDir, async () => {
		const p = await readPersisted(projectDir);
		await writePersisted(projectDir, {
			...p,
			aiSuggestedExclude: aiExcluded,
			...(changeFingerprint !== undefined ? { changeFingerprint } : { changeFingerprint: undefined }),
		});
	});
}

/**
 * Clears the AI-relevance layer (aiSuggestedExclude + changeFingerprint) while keeping
 * the user manual exclude set. Called by the QueueWorker AFTER it consumes the ranking
 * for a commit, so a later commit over the SAME file set can't reuse a stale fingerprint
 * / exclude decision. Runs under withCommitSelectionLock via serialize.
 */
export async function clearAiSelection(projectDir: string): Promise<void> {
	return serialize(projectDir, async () => {
		const p = await readPersisted(projectDir);
		await writePersisted(projectDir, { ...p, aiSuggestedExclude: [], changeFingerprint: undefined });
	});
}

/** Delete the file from disk. Tolerates ENOENT. Exposed for tests / operator use. */
export async function deleteSelectionFile(projectDir: string): Promise<void> {
	try {
		await unlink(selectionPath(projectDir));
	} catch (err) {
		if (!isEnoent(err)) {
			log.warn("deleteSelectionFile failed: %s", errMsg(err));
		}
	}
}
