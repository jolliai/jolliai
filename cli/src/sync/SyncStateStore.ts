/**
 * Read/write helpers for `~/.jolli/jollimemory/sync-state.json`.
 *
 * File schema is `Record<userSlug, SyncStateFile>` keyed by the GitHub
 * user-slug so a single machine can hold state for multiple Jolli users
 * (rare but possible during account switches). Each entry is independent.
 *
 * Atomic writes via tmp+rename — partial writes (a crashed `writeFile`
 * mid-flight) never leave a corrupt JSON visible to readers. POSIX
 * permissions are tightened to `0600` after each write so other users on
 * a shared host can't read the file (it doesn't contain tokens but does
 * contain `userSlug`, which is mildly identifying).
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../Logger.js";
import type { ConflictRecord, SyncStateFile } from "./SyncTypes.js";

const log = createLogger("Sync:State");
const STATE_FILE = "sync-state.json";
const STATE_VERSION = 1 as const;

/** Returns `~/.jolli/jollimemory/`. Always created on first save. */
export function getGlobalSyncDir(): string {
	return join(homedir(), ".jolli", "jollimemory");
}

function getStatePath(): string {
	return join(getGlobalSyncDir(), STATE_FILE);
}

async function readAllEntries(): Promise<Record<string, SyncStateFile>> {
	try {
		const raw = await readFile(getStatePath(), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, SyncStateFile>;
		}
		return {};
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return {};
		log.warn("Failed to read sync-state.json (%s): %s — treating as empty", err.code ?? "unknown", err.message);
		return {};
	}
}

/**
 * Returns the saved state for `userSlug`, or `null` when the file is missing,
 * unreadable, or the stored `version` doesn't match `STATE_VERSION` (future
 * upgrade hook — for now there's only v1).
 */
export async function loadSyncState(userSlug: string): Promise<SyncStateFile | null> {
	const all = await readAllEntries();
	const entry = all[userSlug];
	if (!entry) return null;
	if (entry.version !== STATE_VERSION) {
		log.warn("Ignoring sync-state entry for %s with unknown version %d", userSlug, entry.version);
		return null;
	}
	return entry;
}

/**
 * Writes (or replaces) the state for `state.userSlug`. Other users' entries
 * in the file are preserved untouched.
 */
export async function saveSyncState(state: SyncStateFile): Promise<void> {
	const path = getStatePath();
	await mkdir(dirname(path), { recursive: true });
	const all = await readAllEntries();
	all[state.userSlug] = state;
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(all, null, 2));
	await rename(tmp, path);
	if (platform() !== "win32") {
		/* v8 ignore next 3 -- chmod failure is non-fatal log-only; the only realistic trigger is a hostile filesystem (e.g. fuse mount denying chmod) which the test fixture can't reliably reproduce */
		await chmod(path, 0o600).catch((e) => {
			log.warn("chmod 0600 on sync-state.json failed: %s", (e as Error).message);
		});
	}
}

/**
 * Inserts (or replaces) a single pending-conflict record. Useful when a
 * Tier 3 prompt is dismissed with "Skip" and we need to remember to ask
 * the user again on the next round.
 *
 * No-op when no prior state exists for `userSlug` (caller is responsible
 * for calling `saveSyncState` to bootstrap the entry first).
 */
export async function recordConflict(userSlug: string, c: ConflictRecord): Promise<void> {
	const existing = await loadSyncState(userSlug);
	if (existing === null) return;
	const others = existing.pendingConflicts.filter((p) => p.path !== c.path);
	await saveSyncState({ ...existing, pendingConflicts: [...others, c] });
}

/** Removes the pending-conflict record for `path`. No-op if not found. */
export async function clearConflict(userSlug: string, path: string): Promise<void> {
	const existing = await loadSyncState(userSlug);
	if (existing === null) return;
	const remaining = existing.pendingConflicts.filter((p) => p.path !== path);
	if (remaining.length === existing.pendingConflicts.length) return;
	await saveSyncState({ ...existing, pendingConflicts: remaining });
}
