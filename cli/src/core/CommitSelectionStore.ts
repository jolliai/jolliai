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
 *   2. AI relevance layer (`aiRelevance` + `changeFingerprint`) — the relevance
 *      ranker's FULL per-item verdict list (tier + reason + the AI's exclude
 *      decision, one entry per ranked item), written by the pre-commit Review
 *      panel so the post-commit QueueWorker can reuse it when the fingerprint
 *      matches (otherwise QueueWorker recomputes). The user vetoes a single AI
 *      exclusion via `dismissAiExclusion`, which sets that entry's `dismissed`
 *      flag — the AI's original judgment is never rewritten, so nothing is
 *      lost. There is NO separate "user include" layer; a dismiss is a
 *      per-change (non-persistent across a re-rank) override, which is the
 *      intended model.
 *
 * Version stays at 2 ON PURPOSE. Bumping to 3 would make an older CLI/extension
 * reader (which hard-rejects unknown versions and returns an empty set) silently
 * DISCARD the user's manual excludes. Keeping version === 2 and adding the new
 * fields as OPTIONAL extra keys means an old reader still reads the four arrays
 * it knows and simply ignores the rest — true forward compatibility. Newer
 * fields are written only when non-empty so the file shape is unchanged for
 * users who never touch the AI-relevance feature.
 *
 * Sticky semantics: entries persist until explicitly changed by the user (or
 * consumed: the QueueWorker clears the AI layer post-commit via
 * clearAiSelection; all writes serialize under withCommitSelectionLock).
 *
 * Schema versions (all read at version 2):
 *   - v1: { conversations, plans, notes } (references migrates to empty)
 *   - v2: + references
 *   - v2+ (this file): + optional aiRelevance / changeFingerprint.
 *         Transparent to older readers. (Legacy `userIncluded` /
 *         `aiSuggestedExclude` / `aiRelevanceResults` keys from earlier builds
 *         of this in-development feature are ignored on read and dropped on the
 *         next write — this file is a short-lived local relay, so the sole cost
 *         is one fallback re-rank.)
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

/**
 * One ranked item's full AI relevance verdict — tier + one-line reason + the
 * AI's soft-exclude decision. ONE list carries the whole ranking (kept and
 * excluded alike), which removes the alignment/lifecycle drift an earlier
 * two-list shape (separate exclude list + verdict list) suffered from. This is
 * what lets the QueueWorker's fingerprint-reuse path rebuild the full decision
 * — effective exclude set AND kept items' tier/reason for
 * `CommitSummary.contextRelevance` — without re-running the LLM.
 *
 * Two independent facts, two fields, each with a single writer:
 * - `excluded` — the AI's ORIGINAL judgment. Written once by the ranking,
 *   never rewritten (a dismiss must not erase what the AI concluded).
 * - `dismissed` — the user's veto of that exclusion (the panel/sidebar
 *   "Include" / "+" action). Only meaningful when `excluded` is true.
 * The effective exclude decision is `isEffectivelyExcluded` (excluded &&
 * !dismissed). Nothing is ever lost: the AI's tier + reason survive a dismiss,
 * and "AI suggested excluding this but the user kept it" stays reconstructable.
 *
 * No score: the LLM's numeric score is uncalibrated display noise; the
 * rank-derived tier is the surfaced signal.
 */
export interface AiRelevanceEntry {
	readonly kind: ExclusionKind;
	readonly key: string;
	readonly tier: "high" | "mid" | "low";
	readonly reason: string;
	/** The AI's original soft-exclude judgment — never rewritten. */
	readonly excluded: boolean;
	/** User veto of the exclusion (Include / "+"). Absent = false. */
	readonly dismissed?: boolean;
}

/** The effective exclude decision: AI excluded it AND the user has not vetoed. */
export function isEffectivelyExcluded(e: AiRelevanceEntry): boolean {
	return e.excluded && e.dismissed !== true;
}

/** The AI-relevance layer read back for reuse by the QueueWorker / panel. */
export interface AiSelection {
	readonly aiRelevance: ReadonlyArray<AiRelevanceEntry>;
	readonly changeFingerprint?: string;
}

interface PersistedShape {
	readonly version: typeof SELECTION_VERSION;
	readonly conversations: readonly string[];
	readonly notes: readonly string[];
	readonly plans: readonly string[];
	readonly references: readonly string[];
	readonly aiRelevance?: readonly AiRelevanceEntry[];
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

function asAiRelevanceEntries(v: unknown): readonly AiRelevanceEntry[] {
	if (!Array.isArray(v)) return [];
	const kinds = new Set<ExclusionKind>(["conversations", "plans", "notes", "references"]);
	const tiers = new Set(["high", "mid", "low"]);
	const out: AiRelevanceEntry[] = [];
	for (const x of v) {
		if (x === null || typeof x !== "object") continue;
		const o = x as Record<string, unknown>;
		if (
			typeof o.kind === "string" &&
			kinds.has(o.kind as ExclusionKind) &&
			typeof o.key === "string" &&
			typeof o.tier === "string" &&
			tiers.has(o.tier) &&
			typeof o.reason === "string" &&
			typeof o.excluded === "boolean"
		) {
			out.push({
				kind: o.kind as ExclusionKind,
				key: o.key,
				tier: o.tier as AiRelevanceEntry["tier"],
				reason: o.reason,
				excluded: o.excluded,
				...(o.dismissed === true ? { dismissed: true } : {}),
			});
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
	// Legacy keys from earlier builds of this in-development feature —
	// `userIncluded`, `aiSuggestedExclude`, `aiRelevanceResults` — are
	// intentionally not read: this file is a short-lived local relay (cleared by
	// the worker after each commit), so the sole cost is one fingerprint miss →
	// one fallback re-rank. They're simply dropped on the next write.
	return {
		version: SELECTION_VERSION,
		conversations: asStringArray(parsed.conversations),
		notes: asStringArray(parsed.notes),
		plans: asStringArray(parsed.plans),
		references: asStringArray(parsed.references),
		...(parsed.aiRelevance ? { aiRelevance: asAiRelevanceEntries(parsed.aiRelevance) } : {}),
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

/** Reads the AI-relevance layer (the full per-item ranking + change fingerprint). */
export async function readAiSelection(projectDir: string): Promise<AiSelection> {
	const p = await readPersisted(projectDir);
	return {
		aiRelevance: p.aiRelevance ?? [],
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
		...(p.aiRelevance && p.aiRelevance.length > 0 ? { aiRelevance: p.aiRelevance } : {}),
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
 * Records the user's veto of one AI soft-exclusion (the panel/sidebar "Include" /
 * "+" action): sets `dismissed: true` on the matching (kind, key) entry so it is
 * no longer EFFECTIVELY excluded, while the AI's original judgment — `excluded`,
 * tier, reason — stays intact (nothing is lost; the item lands in the summary
 * with its original verdict attached). There is no separate persistent include
 * layer; the veto is a flag on the ranking itself. Idempotent; preserves the
 * rest of the list + the change fingerprint so the QueueWorker's fingerprint
 * reuse still holds.
 */
export async function dismissAiExclusion(projectDir: string, kind: ExclusionKind, key: string): Promise<void> {
	return serialize(projectDir, async () => {
		const p = await readPersisted(projectDir);
		const updated = (p.aiRelevance ?? []).map((e) =>
			e.kind === kind && e.key === key ? { ...e, dismissed: true } : e,
		);
		await writePersisted(projectDir, { ...p, aiRelevance: updated });
	});
}

/**
 * Writes the AI-relevance layer (the full per-item ranking + change fingerprint)
 * for the QueueWorker to reuse when its fingerprint matches. Called by the
 * pre-commit panel. (The worker doesn't call THIS one, but it DOES clear the
 * layer post-consume via clearAiSelection — both go through
 * withCommitSelectionLock.) Passing an empty list and no fingerprint clears the
 * layer. Entries carry EVERY ranked item's tier + reason + exclude decision —
 * the single source for both the effective exclude set and
 * CommitSummary.contextRelevance on the reuse path.
 */
export async function writeAiSelection(
	projectDir: string,
	aiRelevance: readonly AiRelevanceEntry[],
	changeFingerprint?: string,
): Promise<void> {
	return serialize(projectDir, async () => {
		const p = await readPersisted(projectDir);
		await writePersisted(projectDir, {
			...p,
			aiRelevance,
			...(changeFingerprint !== undefined ? { changeFingerprint } : { changeFingerprint: undefined }),
		});
	});
}

/**
 * Clears the AI-relevance layer (aiRelevance + changeFingerprint) while keeping
 * the user manual exclude set. Called by the QueueWorker AFTER it consumes the
 * ranking for a commit, so a later commit over the SAME file set can't reuse a
 * stale fingerprint / exclude decision. Runs under withCommitSelectionLock via
 * serialize.
 */
export async function clearAiSelection(projectDir: string): Promise<void> {
	return serialize(projectDir, async () => {
		const p = await readPersisted(projectDir);
		await writePersisted(projectDir, {
			...p,
			aiRelevance: [],
			changeFingerprint: undefined,
		});
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
