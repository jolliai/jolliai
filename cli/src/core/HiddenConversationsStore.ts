/**
 * HiddenConversationsStore
 *
 * Persists the set of AI conversations the user wants hidden from the
 * sidebar CONVERSATIONS list. Implemented as a single JSON file under
 * `<projectDir>/.jolli/jollimemory/hidden-conversations.json` (not one
 * file per session, like ConversationOverlayStore) because hiding is a
 * list-level decision: aggregator reads it once per refresh and filters.
 *
 * Trigger: ConversationDetailsPanel decides a session is hidden when its
 * post-overlay merged transcript is empty after a save (Mark All as
 * Deleted, or piecewise deletion of every entry). This file is the seam
 * that survives reload — without it the session would re-appear next
 * window-reload from on-disk aggregator state.
 *
 * Why a separate store (vs. embedding `hidden: true` in the overlay):
 * the overlay is keyed per session and only loaded when the panel opens
 * one. Filtering the sidebar list from N overlay files on every refresh
 * would be O(N) IO per paint; a single index file is O(1) plus a Set
 * lookup. Also keeps overlay semantics scoped to entry-level edits.
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, isEnoent, JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import type { TranscriptSource } from "../Types.js";

const log = createLogger("HiddenConversations");

const HIDDEN_FILE = "hidden-conversations.json";
const HIDDEN_VERSION = 1 as const;

export interface HiddenEntry {
	readonly hiddenAt: string;
}

export interface HiddenConversationsState {
	readonly version: typeof HIDDEN_VERSION;
	readonly entries: Readonly<Record<string, HiddenEntry>>;
}

// Null-prototype entries object so `key in entries` doesn't match
// inherited members like "toString" / "__proto__".
const EMPTY_ENTRIES: Readonly<Record<string, HiddenEntry>> = Object.freeze(
	Object.create(null) as Record<string, HiddenEntry>,
);
const EMPTY_STATE: HiddenConversationsState = Object.freeze({
	version: HIDDEN_VERSION,
	entries: EMPTY_ENTRIES,
});

function hiddenPath(projectDir: string): string {
	return join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, HIDDEN_FILE);
}

/**
 * Map (source, sessionId) → the single key used inside `entries`. Using a
 * flat string key keeps the JSON file simple; the colon is reserved across
 * the rest of jollimemory so source values never contain one.
 *
 * TODO (type-design): brand the return type as `HiddenKey = string & {
 * readonly __brand: "HiddenKey" }` so the colon-separator invariant cannot
 * be forged by callers building keys ad-hoc. Deferred from this PR because
 * the file-level API is small enough that the runtime guarantee is held by
 * convention; no caller outside this module currently constructs the key.
 */
export function hiddenKey(source: TranscriptSource, sessionId: string): string {
	return `${source}:${sessionId}`;
}

/**
 * Reads the hidden-conversations file. Returns an empty state if the file
 * doesn't exist or is unreadable / malformed — a corrupt hidden file must
 * never strand the user with no way to see their sessions. The aggregator
 * treats "no state" as "nothing hidden", so the user just sees everything.
 *
 * Absence (ENOENT) is silent. Any other read or parse failure is logged at
 * warn — a corrupt file means the user's hidden sessions all re-appear
 * with no signal, and the log line is the only way an operator notices.
 */
export async function loadHiddenConversations(projectDir: string): Promise<HiddenConversationsState> {
	let raw: string;
	try {
		raw = await readFile(hiddenPath(projectDir), "utf8");
	} catch (err) {
		if (!isEnoent(err)) {
			log.warn("loadHiddenConversations read failed: %s", errMsg(err));
		}
		return EMPTY_STATE;
	}
	try {
		const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, HiddenEntry> };
		if (parsed.version !== HIDDEN_VERSION) {
			log.warn("loadHiddenConversations version mismatch (got %s) — ignoring file", String(parsed.version));
			return EMPTY_STATE;
		}
		if (!parsed.entries || typeof parsed.entries !== "object") {
			log.warn("loadHiddenConversations malformed entries — ignoring file");
			return EMPTY_STATE;
		}
		// Use a null-prototype object so a sessionId of "__proto__" or
		// "toString" can't pick up a value from Object.prototype on lookup.
		// This lets isHidden use a plain `key in entries` check that biome
		// approves of (no Object.hasOwn / hasOwnProperty.call rule fires).
		const cleaned = Object.create(null) as Record<string, HiddenEntry>;
		for (const [k, v] of Object.entries(parsed.entries)) {
			if (v && typeof v === "object" && typeof v.hiddenAt === "string") {
				cleaned[k] = { hiddenAt: v.hiddenAt };
			}
		}
		return { version: HIDDEN_VERSION, entries: cleaned };
	} catch (err) {
		log.warn("loadHiddenConversations JSON parse failed: %s", errMsg(err));
		return EMPTY_STATE;
	}
}

export function isHidden(state: HiddenConversationsState, source: TranscriptSource, sessionId: string): boolean {
	// `key in entries` is safe because loadHiddenConversations builds entries
	// with Object.create(null) — prototype-chain keys like "__proto__" and
	// "toString" can't return a function from Object.prototype.
	return hiddenKey(source, sessionId) in state.entries;
}

/**
 * Returns true only when the session is hidden AND no new turns have arrived
 * since the user hid it. The aggregator uses this (not `isHidden`) so that
 * "Mark All as Deleted" behaves as a per-snapshot dismiss rather than a
 * permanent block — once the source app appends fresh user/assistant
 * messages, the session re-surfaces as a new active conversation.
 *
 * Comparison is "session updatedAt > hiddenAt" (strict). Equal timestamps
 * stay hidden: an updatedAt that has not advanced past the hide event means
 * we're looking at the same snapshot the user just dismissed.
 *
 * Robust against malformed `hiddenAt` strings: an unparseable timestamp
 * collapses to NaN and any `>` / `<=` comparison against NaN is false, so we
 * fall back to "treat as hidden" — preserving the user's stated intent
 * rather than silently unhiding because the file got corrupted.
 */
export function isStillHidden(
	state: HiddenConversationsState,
	source: TranscriptSource,
	sessionId: string,
	sessionUpdatedAt: string,
): boolean {
	const key = hiddenKey(source, sessionId);
	if (!(key in state.entries)) return false;
	const entry = state.entries[key];
	const hiddenAtMs = Date.parse(entry.hiddenAt);
	const updatedAtMs = Date.parse(sessionUpdatedAt);
	if (Number.isNaN(hiddenAtMs)) {
		// Corrupt hiddenAt: keep the user's hide intent intact rather than
		// silently unhiding. The load path already filters out entries with
		// non-string hiddenAt, so reaching here means a date-string we
		// can't parse — rare but possible across timezone-suffix variants.
		return true;
	}
	if (Number.isNaN(updatedAtMs)) {
		// Likewise: a session whose updatedAt is unparseable shouldn't
		// auto-resurface — we have no evidence of activity past the hide.
		return true;
	}
	return updatedAtMs <= hiddenAtMs;
}

/**
 * Marks a session as hidden. Idempotent: re-hiding refreshes the timestamp
 * but doesn't fail. Atomic write (write `.tmp` then rename) so a crash
 * mid-write leaves the previous state intact rather than a half-written
 * file that would parse as empty and unhide everything.
 *
 * Serialised by an advisory `.lock` sibling file: two concurrent callers
 * (e.g. one CLI process + the VS Code extension host both running through
 * ConversationDetailsPanel) would otherwise race on load→modify→write,
 * with the loser's hide silently dropped on next reload. Locks are
 * single-process boundaries — we acquire with `O_EXCL` and treat a lock
 * file older than HIDDEN_LOCK_STALE_MS as crash-orphaned to avoid wedging
 * the store forever if a previous holder died mid-write.
 */
export async function hideConversation(
	projectDir: string,
	source: TranscriptSource,
	sessionId: string,
): Promise<HiddenConversationsState> {
	const dir = join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR);
	await mkdir(dir, { recursive: true });
	const finalPath = hiddenPath(projectDir);
	const lockPath = `${finalPath}.lock`;
	await acquireHiddenLock(lockPath);
	try {
		const current = await loadHiddenConversations(projectDir);
		const key = hiddenKey(source, sessionId);
		// Null-prototype object so isHidden's `key in entries` stays safe even
		// before the file is reloaded from disk.
		const nextEntries = Object.create(null) as Record<string, HiddenEntry>;
		Object.assign(nextEntries, current.entries, { [key]: { hiddenAt: new Date().toISOString() } });
		const next: HiddenConversationsState = { version: HIDDEN_VERSION, entries: nextEntries };
		const tmpPath = `${finalPath}.tmp`;
		await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
		await rename(tmpPath, finalPath);
		return next;
	} finally {
		await unlink(lockPath).catch((err: unknown) => {
			// Best-effort release. ENOENT is the legitimate race-with-stale-
			// recovery case (a concurrent waiter unlinked our lock under us)
			// and stays silent. Anything else — EACCES from a chmod race,
			// EBUSY on Windows when a viewer still holds the handle — is a
			// real problem: the lock file lingers, the next hide will wait
			// up to HIDDEN_LOCK_STALE_MS before reclaiming. Surface it at
			// debug level so triage can correlate with slow hide latency.
			if (!isEnoent(err)) {
				log.debug("HiddenConversations lock release failed at %s: %s", lockPath, errMsg(err));
			}
		});
	}
}

const HIDDEN_LOCK_WAIT_MS = 2000;
const HIDDEN_LOCK_STALE_MS = 10_000;
const HIDDEN_LOCK_POLL_MS = 25;

/**
 * Acquires the hide-store lock by creating `lockPath` with O_EXCL. On
 * collision we poll until either the lock disappears (the previous holder
 * finished) or it is older than HIDDEN_LOCK_STALE_MS (crashed holder),
 * in which case we unlink it and retry. Throws if the wait window
 * expires — the caller's catch path posts overridesSaveError so the user
 * sees a real banner rather than a silently-lost hide.
 */
async function acquireHiddenLock(lockPath: string): Promise<void> {
	const start = Date.now();
	while (true) {
		try {
			await writeFile(lockPath, `${process.pid}`, { flag: "wx" });
			return;
		} catch (err) {
			if (!isAlreadyExists(err)) throw err;
		}
		// Stale-lock recovery: if the existing lock is older than the
		// stale threshold we assume the previous holder crashed and
		// reclaim it. The unlink itself can race with another reclaimer
		// — that's fine, the next loop iteration will simply re-try wx.
		/* v8 ignore start -- racy stat failure (lock disappeared between EEXIST and stat) exercised in concurrent integration, not unit tests */
		try {
			const st = await stat(lockPath);
			if (Date.now() - st.mtimeMs > HIDDEN_LOCK_STALE_MS) {
				await unlink(lockPath).catch(() => undefined);
				continue;
			}
		} catch {
			continue;
		}
		/* v8 ignore stop */
		/* v8 ignore start -- timeout branch would require a 2s real-time wait; exercised by manual reproduction, not the unit suite */
		if (Date.now() - start > HIDDEN_LOCK_WAIT_MS) {
			throw new Error(`hideConversation: lock contention timeout (${HIDDEN_LOCK_WAIT_MS}ms) at ${lockPath}`);
		}
		/* v8 ignore stop */
		await new Promise((r) => setTimeout(r, HIDDEN_LOCK_POLL_MS));
	}
}

function isAlreadyExists(err: unknown): boolean {
	return !!err && typeof err === "object" && (err as { code?: string }).code === "EEXIST";
}
