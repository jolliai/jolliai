/**
 * CommitSelectionStore
 *
 * Persists the set of sidebar items the user wants EXCLUDED from the next
 * summary pipeline run. Four kinds (conversations / plans / notes / references)
 * live in a single JSON file under
 * `<projectDir>/.jolli/jollimemory/commit-selection.json`.
 *
 * Sticky semantics: an entry stays in this file until the user explicitly
 * un-excludes the item (re-checks the row, or hits the section's Select /
 * Deselect All button). No git operation, no pipeline outcome, no editor
 * lifecycle event modifies the file — the QueueWorker only ever READS it.
 *
 * Distinct from `HiddenConversationsStore` (permanent hide — row vanishes
 * from sidebar) and from `PlanEntry.ignored` / `NoteEntry.ignored`
 * (permanent ignore at the plans-registry layer). Exclusions are visible
 * in the sidebar with an unchecked box; the row still renders.
 *
 * Schema versions:
 *   - v1: { conversations, plans, notes }
 *   - v2: + references (panel-level skip for multi-source reference rows;
 *         key is `<source>:<nativeId>`, identical to the plans.json.references
 *         map key). v1 files are transparently migrated on read — references
 *         defaults to empty and the next write upgrades the file to v2.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, isEnoent, JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import type { TranscriptSource } from "../Types.js";

const log = createLogger("CommitSelection");

const SELECTION_FILE = "commit-selection.json";
const SELECTION_VERSION = 2 as const;

export type ExclusionKind = "conversations" | "plans" | "notes" | "references";

export interface CommitExclusions {
	readonly conversations: ReadonlySet<string>;
	readonly plans: ReadonlySet<string>;
	readonly notes: ReadonlySet<string>;
	/**
	 * Per-source reference exclusions. Key is `<source>:<nativeId>` (same shape as
	 * the `plans.json.references` map key). Added in v2; v1 files migrate
	 * transparently with an empty references set.
	 */
	readonly references: ReadonlySet<string>;
}

interface PersistedShape {
	readonly version: typeof SELECTION_VERSION;
	readonly conversations: readonly string[];
	readonly plans: readonly string[];
	readonly notes: readonly string[];
	readonly references: readonly string[];
}

function selectionPath(projectDir: string): string {
	return join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, SELECTION_FILE);
}

/**
 * Encode (source, sessionId) into a single string key. The colon is
 * reserved across jollimemory (TranscriptSource values never contain one)
 * so the key is unambiguously splittable if a debugging tool ever needs to.
 */
export function conversationKey(source: TranscriptSource, sessionId: string): string {
	return `${source}:${sessionId}`;
}

function emptyExclusions(): CommitExclusions {
	return {
		conversations: new Set<string>(),
		plans: new Set<string>(),
		notes: new Set<string>(),
		references: new Set<string>(),
	};
}

export async function readExclusions(projectDir: string): Promise<CommitExclusions> {
	let raw: string;
	try {
		raw = await readFile(selectionPath(projectDir), "utf8");
	} catch (err) {
		if (!isEnoent(err)) {
			log.warn("readExclusions read failed: %s", errMsg(err));
		}
		return emptyExclusions();
	}
	let parsed: Partial<PersistedShape>;
	try {
		parsed = JSON.parse(raw) as Partial<PersistedShape>;
	} catch (err) {
		log.warn("readExclusions JSON parse failed: %s", errMsg(err));
		return emptyExclusions();
	}
	// v1 (legacy) files are transparently migrated: read the three legacy fields
	// and default `references` to empty. Anything other than 1 or 2 is treated as
	// an unrecognized schema and ignored — same loud-but-safe behavior as before.
	if (parsed.version !== SELECTION_VERSION && parsed.version !== 1) {
		log.warn("readExclusions version mismatch (got %s) — ignoring file", String(parsed.version));
		return emptyExclusions();
	}
	return {
		conversations: new Set(asStringArray(parsed.conversations)),
		plans: new Set(asStringArray(parsed.plans)),
		notes: new Set(asStringArray(parsed.notes)),
		references: new Set(asStringArray(parsed.references)),
	};
}

function asStringArray(v: unknown): readonly string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

async function writeExclusions(projectDir: string, next: CommitExclusions): Promise<void> {
	const dir = join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR);
	await mkdir(dir, { recursive: true });
	const payload: PersistedShape = {
		version: SELECTION_VERSION,
		conversations: [...next.conversations],
		plans: [...next.plans],
		notes: [...next.notes],
		references: [...next.references],
	};
	const tmp = `${selectionPath(projectDir)}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, JSON.stringify(payload, null, "\t"), "utf8");
	try {
		await rename(tmp, selectionPath(projectDir));
	} catch (err) {
		// Atomic-write contract: the .tmp file is an implementation detail
		// of the swap, not user-visible state. On Windows a rename can fail
		// with EPERM/EBUSY (antivirus, file watcher, another reader). Without
		// this cleanup the unique `Date.now()` suffix would accumulate one
		// orphan per failed write. Best-effort unlink — the caller sees the
		// original rename error, not a misleading "cleanup failed" wrapper.
		await unlink(tmp).catch(() => undefined);
		throw err;
	}
}

function mutableClone(ex: CommitExclusions): {
	conversations: Set<string>;
	plans: Set<string>;
	notes: Set<string>;
	references: Set<string>;
} {
	return {
		conversations: new Set(ex.conversations),
		plans: new Set(ex.plans),
		notes: new Set(ex.notes),
		references: new Set(ex.references),
	};
}

// In-process serialization queue keyed by projectDir. setExcluded /
// setAllExcluded share an unlocked read-modify-write pattern, and the
// sidebar fires them as `void apply…(...)` (fire-and-forget) from
// rapid checkbox clicks. Without a queue two concurrent calls would
// (a) read the same pre-state and silently lose one update, and
// (b) collide on the temp filename in writeExclusions (same pid +
// same Date.now() ms) producing an ENOENT crash on the second rename.
// One chain per projectDir keeps cross-project work parallel.
const writeChains = new Map<string, Promise<void>>();

function serialize<T>(projectDir: string, work: () => Promise<T>): Promise<T> {
	const prior = writeChains.get(projectDir) ?? Promise.resolve();
	const next = prior.then(work, work);
	writeChains.set(
		projectDir,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

export async function setExcluded(
	projectDir: string,
	kind: ExclusionKind,
	key: string,
	excluded: boolean,
): Promise<void> {
	return serialize(projectDir, async () => {
		const current = await readExclusions(projectDir);
		const next = mutableClone(current);
		const set = next[kind];
		if (excluded) set.add(key);
		else set.delete(key);
		await writeExclusions(projectDir, next);
	});
}

export async function setAllExcluded(
	projectDir: string,
	kind: ExclusionKind,
	keys: readonly string[],
	excluded: boolean,
): Promise<void> {
	return serialize(projectDir, async () => {
		const current = await readExclusions(projectDir);
		const next = mutableClone(current);
		const set = next[kind];
		if (excluded) {
			for (const k of keys) set.add(k);
		} else {
			for (const k of keys) set.delete(k);
		}
		await writeExclusions(projectDir, next);
	});
}

/** Delete the file from disk. Tolerates ENOENT. Not used by the pipeline — exposed for tests / manual operator use. */
export async function deleteSelectionFile(projectDir: string): Promise<void> {
	try {
		await unlink(selectionPath(projectDir));
	} catch (err) {
		if (!isEnoent(err)) {
			log.warn("deleteSelectionFile failed: %s", errMsg(err));
		}
	}
}
