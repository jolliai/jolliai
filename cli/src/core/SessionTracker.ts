/**
 * Session Tracker Module
 *
 * Manages .jolli/jollimemory/ state files:
 *   - sessions.json: Registry of all active Claude Code sessions (Map<sessionId, SessionInfo>)
 *   - cursors.json: Per-transcript cursor positions (Map<transcriptPath, TranscriptCursor>)
 *   - config.json: Optional configuration (API key, model, etc.)
 *
 * Supports multiple concurrent Claude Code sessions. Stale sessions (>48h)
 * are automatically pruned during saveSession, along with their cursors.
 *
 * Lock primitives (`worker.lock` / `orphan-write.lock`) live in `Locks.ts`.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import {
	type CursorsRegistry,
	type GitOperation,
	isIngestOperation,
	type JolliMemoryConfig,
	type NoteEntry,
	type PlanEntry,
	type PlansRegistry,
	type Reference,
	type ReferenceEntry,
	type SessionInfo,
	type SessionsRegistry,
	type SourceId,
	type SquashPendingState,
	type TranscriptCursor,
} from "../Types.js";
import { atomicWriteFile as atomicWrite } from "./AtomicWrite.js";
import { writeReferenceMarkdown } from "./references/ReferenceStore.js";

const log = createLogger("SessionTracker");

const SESSIONS_FILE = "sessions.json";
const CURSORS_FILE = "cursors.json";
/** Merged plan+reference discovery cursors (replaces plan:/linear: prefixed keys in cursors.json). */
const DISCOVERY_CURSORS_FILE = "discovery-cursors.json";
const CONFIG_FILE = "config.json";
const PLANS_FILE = "plans.json";

/** Sessions older than 48 hours are considered stale and pruned automatically */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/**
 * Ensures the .jolli/jollimemory/ directory exists.
 * Returns the directory path.
 */
export async function ensureJolliMemoryDir(cwd?: string): Promise<string> {
	const dir = getJolliMemoryDir(cwd);
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Saves (upserts) a session into the sessions registry.
 * Also prunes stale sessions (>48h) and their corresponding cursors.
 * Signature is unchanged from the single-session version for StopHook compatibility.
 *
 * @param sessionInfo - The session to save/update
 * @param cwd - Optional working directory
 */
export async function saveSession(sessionInfo: SessionInfo, cwd?: string): Promise<void> {
	const dir = await ensureJolliMemoryDir(cwd);

	// Load existing registry
	const registry = await loadSessionsRegistry(dir);
	const sessions = { ...registry.sessions };

	// Upsert current session
	sessions[sessionInfo.sessionId] = sessionInfo;

	// Prune stale sessions and their cursors
	const { activeSessions, stalePaths } = pruneStale(sessions);

	// Write updated sessions registry
	const newRegistry: SessionsRegistry = { version: 1, sessions: activeSessions };
	await atomicWrite(join(dir, SESSIONS_FILE), JSON.stringify(newRegistry, null, "\t"));

	// If any sessions were pruned, also clean up their cursors
	if (stalePaths.length > 0) {
		await pruneOrphanedCursors(dir, stalePaths);
	}
}

/**
 * Loads all active (non-stale) sessions from the registry.
 * Returns an empty array if no sessions exist.
 */
export async function loadAllSessions(cwd?: string): Promise<ReadonlyArray<SessionInfo>> {
	const dir = getJolliMemoryDir(cwd);
	const registry = await loadSessionsRegistry(dir);
	const { activeSessions } = pruneStale(registry.sessions);
	const sessions = Object.values(activeSessions);
	return sessions;
}

/**
 * Counts stale sessions in the registry without modifying it.
 * Used by `clean --dry-run`.
 */
export async function countStaleSessions(cwd?: string): Promise<number> {
	const dir = getJolliMemoryDir(cwd);
	const registry = await loadSessionsRegistry(dir);
	const totalCount = Object.keys(registry.sessions).length;
	const { activeSessions } = pruneStale(registry.sessions);
	return totalCount - Object.keys(activeSessions).length;
}

/**
 * Prunes stale sessions from the registry and persists the result.
 * Also cleans up orphaned cursor entries. Returns the number of sessions pruned.
 */
export async function pruneStaleSessions(cwd?: string): Promise<number> {
	const dir = getJolliMemoryDir(cwd);
	const registry = await loadSessionsRegistry(dir);
	const totalCount = Object.keys(registry.sessions).length;
	const { activeSessions, stalePaths } = pruneStale(registry.sessions);
	const prunedCount = totalCount - Object.keys(activeSessions).length;

	if (prunedCount === 0) return 0;

	const newRegistry: SessionsRegistry = { version: 1, sessions: activeSessions };
	await atomicWrite(join(dir, SESSIONS_FILE), JSON.stringify(newRegistry, null, "\t"));

	/* v8 ignore start -- stalePaths is always non-empty when prunedCount > 0; the false branch is unreachable */
	if (stalePaths.length > 0) {
		await pruneOrphanedCursors(dir, stalePaths);
	}
	/* v8 ignore stop */

	return prunedCount;
}

/**
 * Returns the most recently updated session, or null if none exist.
 * Used by the status command.
 */
export async function loadMostRecentSession(cwd?: string): Promise<SessionInfo | null> {
	const sessions = await loadAllSessions(cwd);
	if (sessions.length === 0) return null;

	let mostRecent = sessions[0];
	for (let i = 1; i < sessions.length; i++) {
		if (sessions[i].updatedAt > mostRecent.updatedAt) {
			mostRecent = sessions[i];
		}
	}
	return mostRecent;
}

/**
 * Filters sessions to only include those from enabled integrations.
 * Sessions without a source are treated as Claude sessions (backward compatibility).
 */
export function filterSessionsByEnabledIntegrations(
	sessions: ReadonlyArray<SessionInfo>,
	config: JolliMemoryConfig,
): ReadonlyArray<SessionInfo> {
	let filtered = [...sessions];
	if (config.claudeEnabled === false) {
		filtered = filtered.filter((s) => s.source !== undefined && s.source !== "claude");
	}
	if (config.geminiEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "gemini");
	}
	if (config.openCodeEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "opencode");
	}
	if (config.cursorEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "cursor");
	}
	if (config.copilotEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "copilot" && s.source !== "copilot-chat");
	}
	return filtered;
}

/**
 * Saves a transcript cursor, keyed by its transcriptPath.
 * Signature is unchanged from the single-cursor version.
 *
 * @param cursor - The cursor to save
 * @param cwd - Optional working directory
 */
/** Writes a full cursors registry to `<dir>/<filename>` atomically. */
async function writeCursorsRegistry(registry: CursorsRegistry, dir: string, filename: string): Promise<void> {
	await atomicWrite(join(dir, filename), JSON.stringify(registry, null, "\t"));
}

/** Upserts one cursor (keyed by transcriptPath) into the given cursors file. */
async function upsertCursorInFile(cursor: TranscriptCursor, dir: string, filename: string): Promise<void> {
	const registry = await loadCursorsRegistry(dir, filename);
	const cursors = { ...registry.cursors, [cursor.transcriptPath]: cursor };
	await writeCursorsRegistry({ version: 1, cursors }, dir, filename);
}

export async function saveCursor(cursor: TranscriptCursor, cwd?: string): Promise<void> {
	const dir = await ensureJolliMemoryDir(cwd);
	await upsertCursorInFile(cursor, dir, CURSORS_FILE);
}

/**
 * Saves the merged plan+reference discovery cursor to discovery-cursors.json,
 * keyed by the bare transcriptPath (no plan:/linear: prefix).
 */
export async function saveDiscoveryCursor(cursor: TranscriptCursor, cwd?: string): Promise<void> {
	const dir = await ensureJolliMemoryDir(cwd);
	await upsertCursorInFile(cursor, dir, DISCOVERY_CURSORS_FILE);
}

/**
 * Loads the cursor for a specific transcript file.
 * Returns null if no cursor exists for that transcript.
 *
 * @param transcriptPath - The transcript file path to look up
 * @param cwd - Optional working directory
 */
export async function loadCursorForTranscript(transcriptPath: string, cwd?: string): Promise<TranscriptCursor | null> {
	const dir = getJolliMemoryDir(cwd);
	const registry = await loadCursorsRegistry(dir);
	return registry.cursors[transcriptPath] ?? null;
}

/** Loads the merged plan+reference discovery cursor from discovery-cursors.json. */
export async function loadDiscoveryCursor(transcriptPath: string, cwd?: string): Promise<TranscriptCursor | null> {
	const dir = getJolliMemoryDir(cwd);
	const registry = await loadCursorsRegistry(dir, DISCOVERY_CURSORS_FILE);
	return registry.cursors[transcriptPath] ?? null;
}

/**
 * One-shot migration folding legacy `plan:` / `linear:` prefixed cursors
 * from cursors.json into the merged discovery-cursors.json (keyed by bare path).
 * Idempotent — a no-op once cursors.json has no prefixed keys. For each path the
 * plan+linear lines are folded with `min()` so we never skip past either
 * discovery's prior progress (the tiny re-scan overlap is safe because discovery
 * is idempotent; `max()` would skip unprocessed lines).
 */
export async function migrateDiscoveryCursors(cwd?: string): Promise<void> {
	const dir = await ensureJolliMemoryDir(cwd);
	const legacy = await loadCursorsRegistry(dir, CURSORS_FILE);
	const prefixedKeys = Object.keys(legacy.cursors).filter((k) => k.startsWith("plan:") || k.startsWith("linear:"));
	if (prefixedKeys.length === 0) return; // already migrated / no legacy keys

	const discovery = await loadCursorsRegistry(dir, DISCOVERY_CURSORS_FILE);
	const merged = { ...discovery.cursors };
	const remaining = { ...legacy.cursors };
	const now = new Date().toISOString();
	for (const key of prefixedKeys) {
		const path = key.startsWith("plan:") ? key.slice("plan:".length) : key.slice("linear:".length);
		const line = legacy.cursors[key].lineNumber;
		const existing = merged[path];
		const folded = existing ? Math.min(existing.lineNumber, line) : line;
		merged[path] = { transcriptPath: path, lineNumber: folded, updatedAt: now };
		delete remaining[key];
	}
	await writeCursorsRegistry({ version: 1, cursors: merged }, dir, DISCOVERY_CURSORS_FILE);
	await writeCursorsRegistry({ version: 1, cursors: remaining }, dir, CURSORS_FILE);
}

/**
 * Returns the global Jolli Memory config directory (~/.jolli/jollimemory).
 */
export function getGlobalConfigDir(): string {
	return join(homedir(), ".jolli", "jollimemory");
}

/**
 * Reads config.json from a specific directory.
 * Returns empty config on any error (file missing, corrupt JSON, etc.).
 *
 * Use this when you need config from a specific directory (e.g. migration
 * checks). For normal config loading, prefer {@link loadConfig} which
 * reads from the global config directory.
 */
export async function loadConfigFromDir(dir: string): Promise<JolliMemoryConfig> {
	const filePath = join(dir, CONFIG_FILE);
	try {
		const content = await readFile(filePath, "utf-8");
		const raw = JSON.parse(content) as JolliMemoryConfig;
		return coalesceLegacyKeys(raw);
	} catch {
		log.debug("No config file found in %s, using defaults", dir);
		return {};
	}
}

/**
 * Read-time back-compat for renamed config keys. Maps old names onto their
 * new counterparts when the new key is absent, then drops the old key from
 * the returned object so downstream code only sees the new shape. The
 * on-disk file is left untouched here — the next `saveConfigScoped` call
 * will naturally write the new key and omit the old one (omit because
 * `coalesceLegacyKeys` deletes it from the in-memory object that
 * `saveConfigScoped` then spreads).
 *
 * Currently handles:
 *   - `syncEnabled` → `autoSyncEnabled` (UI label always was "Auto-sync to
 *     Personal Space"; the old name suggested a sync master switch but
 *     only ever controlled the background poll — see `JolliMemoryConfig`).
 */
function coalesceLegacyKeys(raw: JolliMemoryConfig): JolliMemoryConfig {
	if (raw.syncEnabled === undefined) return raw;
	const { syncEnabled, ...rest } = raw;
	return rest.autoSyncEnabled === undefined ? { ...rest, autoSyncEnabled: syncEnabled } : rest;
}

/**
 * Saves a partial config update to a specific directory.
 * Creates the directory if needed, merges with existing config, writes atomically.
 *
 * @param update - Partial config fields to save
 * @param targetDir - Directory to write config.json into
 */
export async function saveConfigScoped(update: Partial<JolliMemoryConfig>, targetDir: string): Promise<void> {
	await mkdir(targetDir, { recursive: true });
	const existing = await loadConfigFromDir(targetDir);
	// Fields set to undefined are omitted by JSON.stringify, effectively
	// removing them from the persisted config file.
	const merged = { ...existing, ...update };
	await atomicWrite(join(targetDir, CONFIG_FILE), JSON.stringify(merged, null, "\t"));
	log.info("Config saved to %s", targetDir);
}

/**
 * Loads optional configuration from the global ~/.jolli/jollimemory/config.json.
 * Returns empty config when no file exists.
 */
export async function loadConfig(): Promise<JolliMemoryConfig> {
	return loadConfigFromDir(getGlobalConfigDir());
}

/**
 * Saves configuration to the global ~/.jolli/jollimemory/config.json.
 * Merges the provided partial config with the existing config on disk,
 * preserving fields not included in the update.
 *
 * @param update - Partial config fields to save
 */
export async function saveConfig(update: Partial<JolliMemoryConfig>): Promise<void> {
	return saveConfigScoped(update, getGlobalConfigDir());
}

const SQUASH_PENDING_FILE = "squash-pending.json";

/** Max age for squash-pending.json before it is considered stale */
const SQUASH_PENDING_STALE_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Loads and validates the squash-pending.json state file.
 * Returns null if the file doesn't exist, is corrupt, or is older than 48 hours.
 * Deletes stale files automatically.
 */
export async function loadSquashPending(cwd?: string): Promise<SquashPendingState | null> {
	const dir = getJolliMemoryDir(cwd);
	const filePath = join(dir, SQUASH_PENDING_FILE);

	let state: SquashPendingState;
	try {
		const content = await readFile(filePath, "utf-8");
		state = JSON.parse(content) as SquashPendingState;
	} catch {
		return null;
	}

	// Check if stale
	const age = Date.now() - new Date(state.createdAt).getTime();
	if (age > SQUASH_PENDING_STALE_MS) {
		log.info("squash-pending.json is stale (%dh old), deleting", Math.round(age / 3600000));
		await deleteSquashPending(cwd);
		return null;
	}

	log.info("Loaded squash-pending.json: %d source hashes", state.sourceHashes.length);
	return state;
}

/**
 * Writes a squash-pending.json state file with the given source hashes.
 * Called by PrepareMsgHook when a git merge --squash is detected.
 *
 * @param sourceHashes - The commit hashes that were squashed
 * @param expectedParentHash - HEAD at prepare-commit-msg time; used by the Worker
 *   to detect stale squash-pending files that survived a lock-contention race
 * @param cwd - Optional working directory
 */
export async function saveSquashPending(
	sourceHashes: ReadonlyArray<string>,
	expectedParentHash: string,
	cwd?: string,
): Promise<void> {
	const dir = await ensureJolliMemoryDir(cwd);
	const state: SquashPendingState = {
		sourceHashes,
		expectedParentHash,
		createdAt: new Date().toISOString(),
	};
	await atomicWrite(join(dir, SQUASH_PENDING_FILE), JSON.stringify(state, null, "\t"));
	log.info(
		"Saved squash-pending.json: %d source hashes, parent %s",
		sourceHashes.length,
		expectedParentHash.substring(0, 8),
	);
}

/**
 * Counts active (non-stale) queue entries without modifying anything.
 * Used by `doctor` to detect Worker backlog without triggering cleanup side effects.
 */
export async function countActiveQueueEntries(cwd?: string): Promise<number> {
	const dir = getJolliMemoryDir(cwd);
	const queueDir = join(dir, GIT_OP_QUEUE_DIR);
	let files: string[];
	try {
		files = await readdir(queueDir);
	} catch {
		return 0;
	}

	const now = Date.now();
	let count = 0;
	for (const file of files.filter((f) => f.endsWith(".json"))) {
		try {
			const content = await readFile(join(queueDir, file), "utf-8");
			const op = JSON.parse(content) as GitOperation;
			const age = now - new Date(op.createdAt).getTime();
			if (age <= GIT_OP_QUEUE_STALE_MS) {
				count++;
			}
		} catch {
			// Corrupt entry — count as stale, not active
		}
	}
	return count;
}

/**
 * Counts stale queue entries without deleting them. Used by `clean --dry-run`.
 */
export async function countStaleQueueEntries(cwd?: string): Promise<number> {
	const dir = getJolliMemoryDir(cwd);
	const queueDir = join(dir, GIT_OP_QUEUE_DIR);
	let files: string[];
	try {
		files = await readdir(queueDir);
	} catch {
		return 0;
	}

	const now = Date.now();
	let count = 0;
	for (const file of files.filter((f) => f.endsWith(".json"))) {
		const filePath = join(queueDir, file);
		try {
			const content = await readFile(filePath, "utf-8");
			const op = JSON.parse(content) as GitOperation;
			const age = now - new Date(op.createdAt).getTime();
			if (age > GIT_OP_QUEUE_STALE_MS) count++;
		} catch {
			// Corrupt entry — also counts as stale
			count++;
		}
	}
	return count;
}

/**
 * Prunes stale queue entries and returns the number pruned.
 */
export async function pruneStaleQueueEntries(cwd?: string): Promise<number> {
	const dir = getJolliMemoryDir(cwd);
	const queueDir = join(dir, GIT_OP_QUEUE_DIR);
	let files: string[];
	try {
		files = await readdir(queueDir);
	} catch {
		return 0;
	}

	const now = Date.now();
	let pruned = 0;
	for (const file of files.filter((f) => f.endsWith(".json"))) {
		const filePath = join(queueDir, file);
		try {
			const content = await readFile(filePath, "utf-8");
			const op = JSON.parse(content) as GitOperation;
			const age = now - new Date(op.createdAt).getTime();
			if (age > GIT_OP_QUEUE_STALE_MS) {
				await rm(filePath, { force: true });
				pruned++;
			}
		} catch {
			// Corrupt entry — also prune
			await rm(filePath, { force: true });
			pruned++;
		}
	}
	return pruned;
}

/**
 * Checks if squash-pending.json exists and is stale (older than 48h).
 */
export async function checkStaleSquashPending(cwd?: string): Promise<boolean> {
	const dir = getJolliMemoryDir(cwd);
	const filePath = join(dir, SQUASH_PENDING_FILE);
	try {
		await stat(filePath);
	} catch {
		return false;
	}

	let content: string;
	try {
		content = await readFile(filePath, "utf-8");
		/* v8 ignore start -- stat succeeded but readFile failed: only possible with permission changes between calls */
	} catch {
		return false;
	}
	/* v8 ignore stop */

	try {
		const state = JSON.parse(content) as SquashPendingState;
		const age = Date.now() - new Date(state.createdAt).getTime();
		return age > SQUASH_PENDING_STALE_MS;
	} catch {
		// Corrupt file — also stale in the sense that it should be cleaned up
		return true;
	}
}

/**
 * Deletes the squash-pending.json state file.
 */
export async function deleteSquashPending(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	try {
		await rm(join(dir, SQUASH_PENDING_FILE), { force: true });
		log.info("Deleted squash-pending.json");
		/* v8 ignore start - filesystem permission error during squash-pending deletion */
	} catch (error: unknown) {
		log.error("Failed to delete squash-pending.json: %s", (error as Error).message);
	}
	/* v8 ignore stop */
}

// --- git operation queue ---

const GIT_OP_QUEUE_DIR = "git-op-queue";

/** Max age for queue entries before they are considered stale and pruned */
const GIT_OP_QUEUE_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Process-local monotonic sequence so two enqueues within the same
 * millisecond cannot collide on filename. Old on-disk entries without the
 * sequence segment still sort correctly because they were written under
 * lower wall-clock ms; this segment only disambiguates within a single ms.
 */
let enqueueSeq = 0;

/**
 * Enqueues a git operation for Worker processing.
 * Each entry is written as a separate file to avoid concurrent-write conflicts.
 * Filename format: `{timestamp}-{seq}-{tag}.json` ensures correct processing
 * order even when multiple enqueues land in the same millisecond.
 *
 * Tag is `hash8` for commit operations and `ingest` for ingest operations —
 * both fit the existing chronological-sort drain logic.
 */
export async function enqueueGitOperation(op: GitOperation, cwd?: string): Promise<boolean> {
	const tag = isIngestOperation(op) ? "ingest" : op.commitHash.substring(0, 8);
	try {
		const dir = await ensureJolliMemoryDir(cwd);
		const queueDir = join(dir, GIT_OP_QUEUE_DIR);
		await mkdir(queueDir, { recursive: true });

		const timestamp = Date.now();
		const seq = (++enqueueSeq).toString().padStart(8, "0");
		const fileName = `${timestamp}-${seq}-${tag}.json`;
		await atomicWrite(join(queueDir, fileName), JSON.stringify(op, null, "\t"));
		log.info("Enqueued queue operation: type=%s tag=%s file=%s", op.type, tag, fileName);
		return true;
	} catch (error: unknown) {
		log.error("Failed to enqueue queue operation type=%s tag=%s: %s", op.type, tag, (error as Error).message);
		return false;
	}
}

/**
 * Reads all queued git operations, sorted by filename (timestamp order).
 * Prunes entries older than 7 days automatically.
 * Returns the operations and their file paths (for deletion after processing).
 */
export async function dequeueAllGitOperations(
	cwd?: string,
): Promise<ReadonlyArray<{ op: GitOperation; filePath: string }>> {
	const dir = getJolliMemoryDir(cwd);
	const queueDir = join(dir, GIT_OP_QUEUE_DIR);

	let files: string[];
	try {
		files = await readdir(queueDir);
	} catch {
		return []; // Directory doesn't exist = empty queue
	}

	// Sort by filename (timestamp prefix ensures chronological order)
	const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

	const results: Array<{ op: GitOperation; filePath: string }> = [];
	for (const file of jsonFiles) {
		const filePath = join(queueDir, file);
		try {
			const content = await readFile(filePath, "utf-8");
			const op = JSON.parse(content) as GitOperation;

			// Prune stale entries
			const age = Date.now() - new Date(op.createdAt).getTime();
			if (age > GIT_OP_QUEUE_STALE_MS) {
				log.info("Pruning stale queue entry: %s (%dd old)", file, Math.round(age / 86400000));
				await rm(filePath, { force: true });
				continue;
			}

			results.push({ op, filePath });
		} catch (error: unknown) {
			log.warn("Failed to read queue entry %s: %s — skipping", file, (error as Error).message);
		}
	}

	return results;
}

/**
 * Deletes a single queue entry after it has been successfully processed.
 */
export async function deleteQueueEntry(filePath: string): Promise<void> {
	try {
		await rm(filePath, { force: true });
		/* v8 ignore start - filesystem permission error during queue entry deletion */
	} catch (error: unknown) {
		log.error("Failed to delete queue entry %s: %s", filePath, (error as Error).message);
	}
	/* v8 ignore stop */
}

// --- plugin-source marker ---

const PLUGIN_SOURCE_FILE = "plugin-source";

/**
 * Writes a plugin-source marker file to indicate the next commit
 * was triggered from the VSCode plugin (not CLI).
 * Called by the VSCode Bridge before executing git commit / amend / squash.
 */
export async function savePluginSource(cwd?: string): Promise<void> {
	const dir = await ensureJolliMemoryDir(cwd);
	await writeFile(join(dir, PLUGIN_SOURCE_FILE), new Date().toISOString(), "utf-8");
	log.info("Saved plugin-source marker");
}

/**
 * Checks whether a plugin-source marker file exists.
 * Returns true if present (operation was triggered from the VSCode plugin).
 */
export async function loadPluginSource(cwd?: string): Promise<boolean> {
	const dir = getJolliMemoryDir(cwd);
	try {
		await stat(join(dir, PLUGIN_SOURCE_FILE));
		log.info("Found plugin-source marker");
		return true;
	} catch {
		return false;
	}
}

/**
 * Deletes the plugin-source marker file.
 * Called by PostCommitHook Worker after reading the marker.
 */
export async function deletePluginSource(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	try {
		await rm(join(dir, PLUGIN_SOURCE_FILE), { force: true });
		log.info("Deleted plugin-source marker");
		/* v8 ignore next 3 - filesystem permission error during plugin-source deletion */
	} catch (error: unknown) {
		log.error("Failed to delete plugin-source marker: %s", (error as Error).message);
	}
}

// --- Internal helpers ---

/**
 * Loads the sessions registry from sessions.json.
 * Returns an empty registry if the file doesn't exist or is corrupt.
 */
async function loadSessionsRegistry(dir: string): Promise<SessionsRegistry> {
	const filePath = join(dir, SESSIONS_FILE);
	try {
		const content = await readFile(filePath, "utf-8");
		return JSON.parse(content) as SessionsRegistry;
	} catch {
		return { version: 1, sessions: {} };
	}
}

/**
 * Loads the cursors registry from cursors.json.
 * Returns an empty registry if the file doesn't exist or is corrupt.
 */
async function loadCursorsRegistry(dir: string, filename: string = CURSORS_FILE): Promise<CursorsRegistry> {
	const filePath = join(dir, filename);
	try {
		const content = await readFile(filePath, "utf-8");
		return JSON.parse(content) as CursorsRegistry;
	} catch {
		return { version: 1, cursors: {} };
	}
}

/**
 * Filters out sessions older than SESSION_STALE_MS.
 * Returns the active sessions and the transcript paths of pruned sessions.
 */
function pruneStale(sessions: Readonly<Record<string, SessionInfo>>): {
	activeSessions: Record<string, SessionInfo>;
	stalePaths: string[];
} {
	const now = Date.now();
	const activeSessions: Record<string, SessionInfo> = {};
	const stalePaths: string[] = [];

	for (const [id, session] of Object.entries(sessions)) {
		const age = now - new Date(session.updatedAt).getTime();
		if (age > SESSION_STALE_MS) {
			log.info("Pruning stale session %s (age: %dh)", id, Math.round(age / 3600000));
			stalePaths.push(session.transcriptPath);
		} else {
			activeSessions[id] = session;
		}
	}

	return { activeSessions, stalePaths };
}

/**
 * Removes cursor entries whose transcriptPath matches any stale path, across
 * BOTH cursors.json (QueueWorker summarization line) and discovery-cursors.json
 * (merged plan+reference discovery line). Both files are keyed by the bare
 * transcriptPath now (legacy plan:/linear: prefixes are folded away by
 * migrateDiscoveryCursors), so a direct membership check prunes both.
 */
async function pruneOrphanedCursors(dir: string, stalePaths: ReadonlyArray<string>): Promise<void> {
	const staleSet = new Set(stalePaths);
	for (const filename of [CURSORS_FILE, DISCOVERY_CURSORS_FILE]) {
		const registry = await loadCursorsRegistry(dir, filename);
		const cursors = { ...registry.cursors };
		let pruned = 0;
		for (const key of Object.keys(cursors)) {
			if (staleSet.has(key)) {
				delete cursors[key];
				pruned++;
			}
		}
		if (pruned > 0) {
			await writeCursorsRegistry({ version: 1, cursors }, dir, filename);
		}
	}
}

// ─── Plans Registry ───────────────────────────────────────────────────────────

/** Legacy fields removed from PlanEntry (`editCount` is plan-only) and NoteEntry. */
const LEGACY_PLAN_FIELDS = ["ignored", "branch", "editCount"] as const;
const LEGACY_NOTE_FIELDS = ["ignored", "branch"] as const;
/** Reference rows are now always active/uncommitted — these all became dead fields. */
const LEGACY_REFERENCE_FIELDS = ["ignored", "branch", "commitHash", "contentHashAtCommit"] as const;

/** Deletes `fields` from a shallow copy of `entry`; returns the copy + whether anything was dropped. */
function stripLegacyFields<T>(entry: T, fields: ReadonlyArray<string>): { value: T; changed: boolean } {
	const out = { ...(entry as unknown as Record<string, unknown>) };
	let changed = false;
	for (const f of fields) {
		if (f in out) {
			delete out[f];
			changed = true;
		}
	}
	return { value: out as T, changed };
}

/**
 * One-shot, in-memory migration of a parsed plans.json into the current schema
 * (see docs/2026-06-01-discovery-cursor-split-and-editcount-removal.md §14).
 *
 * Pure + idempotent — clean input returns `changed: false`. Per type:
 *   - plans / notes: drop rows with `ignored === true`; strip dead fields
 *     (`ignored` / `branch` / `editCount`); keep the `commitHash` +
 *     `contentHashAtCommit` guard.
 *   - references: also drop committed / guard rows — detected ONLY by the
 *     `commitHash` / `contentHashAtCommit` fields, deliberately NOT by a
 *     `-<8hex>` key shape (an active ticket id can legitimately end in 8 digits;
 *     see the predicate below) — a reference row is now always
 *     active/uncommitted — and strip the four now-dead fields from survivors.
 *
 * `JSON.parse` keeps unknown keys and `savePlansRegistry` re-serialises the
 * whole object, so legacy fields/rows do NOT disappear on their own; this is
 * the single place that purges them.
 */
export function normalizePlansRegistry(raw: Partial<PlansRegistry>): { registry: PlansRegistry; changed: boolean } {
	let changed = false;

	const plans: Record<string, PlanEntry> = {};
	for (const [slug, entry] of Object.entries(raw.plans ?? {})) {
		if ((entry as unknown as Record<string, unknown>).ignored === true) {
			changed = true;
			continue;
		}
		const stripped = stripLegacyFields(entry, LEGACY_PLAN_FIELDS);
		if (stripped.changed) changed = true;
		plans[slug] = stripped.value;
	}

	let notes: Record<string, NoteEntry> | undefined;
	if (raw.notes !== undefined) {
		notes = {};
		for (const [id, entry] of Object.entries(raw.notes)) {
			if ((entry as unknown as Record<string, unknown>).ignored === true) {
				changed = true;
				continue;
			}
			const stripped = stripLegacyFields(entry, LEGACY_NOTE_FIELDS);
			if (stripped.changed) changed = true;
			notes[id] = stripped.value;
		}
	}

	let references: Record<string, ReferenceEntry> | undefined;
	if (raw.references !== undefined) {
		references = {};
		for (const [key, entry] of Object.entries(raw.references)) {
			// A legacy committed/archived reference row always carries `commitHash`
			// (and usually `contentHashAtCommit`); these field checks catch them all.
			// We deliberately do NOT match on a `-<8hex>` key shape: an active ticket
			// id can legitimately end in `-<8 digits>` (e.g. linear:ENG-12345678), and
			// digits ⊂ hex, so a key-shape heuristic would silently drop a live row.
			const e = entry as unknown as Record<string, unknown>;
			if (e.ignored === true || e.commitHash != null || e.contentHashAtCommit !== undefined) {
				changed = true;
				continue;
			}
			const stripped = stripLegacyFields(entry, LEGACY_REFERENCE_FIELDS);
			if (stripped.changed) changed = true;
			references[key] = stripped.value;
		}
	}

	const registry: PlansRegistry = {
		version: 1,
		plans,
		...(notes !== undefined ? { notes } : {}),
		...(references !== undefined ? { references } : {}),
	};
	return { registry, changed };
}

/**
 * Loads the plans registry from plans.json together with a `changed` flag
 * indicating whether {@link normalizePlansRegistry} purged any legacy row/field.
 * Callers that want to persist the cleaned shape (the deterministic-writeback
 * path) use `changed`; {@link loadPlansRegistry} discards it.
 *
 * Returns an empty registry (`{ version: 1, plans: {} }`, `changed: false`) if
 * the file is missing or contains invalid JSON.
 */
export async function loadPlansRegistryWithStatus(
	cwd?: string,
): Promise<{ registry: PlansRegistry; changed: boolean }> {
	const dir = getJolliMemoryDir(cwd);
	const filePath = join(dir, PLANS_FILE);
	try {
		const content = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as Partial<PlansRegistry>;
		return normalizePlansRegistry(parsed);
	} catch {
		return { registry: { version: 1, plans: {} }, changed: false };
	}
}

/**
 * Loads the plans registry from plans.json, normalised to the current schema.
 *
 * Returns an empty registry (`{ version: 1, plans: {} }`) if the file doesn't
 * exist or contains invalid JSON. Legacy rows/fields are purged in-memory via
 * {@link normalizePlansRegistry} so every reader sees clean data even before
 * the file is physically rewritten.
 */
export async function loadPlansRegistry(cwd?: string): Promise<PlansRegistry> {
	return (await loadPlansRegistryWithStatus(cwd)).registry;
}

/**
 * Saves the plans registry to plans.json with atomic write.
 */
export async function savePlansRegistry(registry: PlansRegistry, cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, PLANS_FILE);
	await atomicWrite(filePath, JSON.stringify(registry, null, "\t"));
}

/**
 * If `archivedKey` looks like a per-commit archive id (base + `-XXXXXXXX` short
 * hash), returns the base/guard key plus the embedded oldShortHash. Otherwise
 * returns null — callers then skip guard-entry migration entirely. This is the
 * single inflection point that distinguishes "first-time association" from
 * "squash/rebase re-anchoring of an existing archive".
 */
export function splitArchivedKey(archivedKey: string): { baseKey: string; oldShortHash: string } | null {
	const match = archivedKey.match(/^(.+)-([0-9a-f]{8})$/);
	if (!match) return null;
	return { baseKey: match[1] as string, oldShortHash: match[2] as string };
}

/**
 * Updates a single plan entry's commitHash in the registry.
 * Called via `reassociateMetadata` from `QueueWorker` after squash / rebase.
 *
 * When `slug` is an archive id (`<baseSlug>-<oldShortHash>`) and the
 * corresponding guard entry exists with `commitHash` matching that old short
 * hash, the guard is migrated alongside it: its `commitHash` is moved to the
 * new hash. `contentHashAtCommit` is left untouched — squash/rebase only
 * rewrites commit metadata, not file content, so the archive-time anchor must
 * survive so that uncommitted edits to the source still surface as a revived
 * guard on the next post-commit detection.
 */
export async function associatePlanWithCommit(archivedSlug: string, commitHash: string, cwd?: string): Promise<void> {
	// Per-commit archive rows are no longer created — only the guard row
	// (base slug, carrying contentHashAtCommit) survives in plans.json. So this
	// migration (reassociateMetadata after squash/rebase) just sweeps the matching
	// guard's commitHash forward. `archivedSlug` is the CommitSummary pointer
	// `<baseSlug>-<oldShortHash>`; we split it directly rather than looking up a
	// (now-nonexistent) archive row first. contentHashAtCommit stays untouched —
	// only commit metadata moved, not file content, so uncommitted edits still
	// revive the guard on the next post-commit detection.
	const split = splitArchivedKey(archivedSlug);
	if (!split) {
		log.debug("associatePlanWithCommit: %s is not an archived slug, skipping", archivedSlug);
		return;
	}
	const registry = await loadPlansRegistry(cwd);
	const guard = registry.plans[split.baseKey];
	if (!guard?.contentHashAtCommit || !guard.commitHash?.startsWith(split.oldShortHash)) {
		log.debug("associatePlanWithCommit: no matching guard for %s, skipping", archivedSlug);
		return;
	}
	const now = new Date().toISOString();
	const updated: PlansRegistry = {
		...registry,
		plans: { ...registry.plans, [split.baseKey]: { ...guard, commitHash, updatedAt: now } },
	};
	await savePlansRegistry(updated, cwd);
	log.info("associatePlanWithCommit: migrated guard %s → %s", split.baseKey, commitHash.substring(0, 8));
}

/**
 * Updates the commitHash for a note entry in the registry (used after squash/rebase).
 *
 * Same guard-entry migration semantics as `associatePlanWithCommit` — see that
 * function's doc-comment for the rationale.
 */
export async function associateNoteWithCommit(noteId: string, commitHash: string, cwd?: string): Promise<void> {
	// Only the guard row survives — sweep its commitHash forward. See
	// associatePlanWithCommit for the rationale.
	const split = splitArchivedKey(noteId);
	if (!split) {
		log.debug("associateNoteWithCommit: %s is not an archived id, skipping", noteId);
		return;
	}
	const registry = await loadPlansRegistry(cwd);
	const notes = registry.notes;
	const guard = notes?.[split.baseKey];
	if (!guard?.contentHashAtCommit || !guard.commitHash?.startsWith(split.oldShortHash)) {
		log.debug("associateNoteWithCommit: no matching guard for %s, skipping", noteId);
		return;
	}
	const now = new Date().toISOString();
	const updated: PlansRegistry = {
		...registry,
		notes: {
			...(notes as NonNullable<PlansRegistry["notes"]>),
			[split.baseKey]: { ...guard, commitHash, updatedAt: now },
		},
	};
	await savePlansRegistry(updated, cwd);
	log.info("associateNoteWithCommit: migrated guard %s → %s", split.baseKey, commitHash.substring(0, 8));
}

/**
 * Loads a single plan entry from the registry by slug.
 * Returns null if not found.
 */
export async function loadPlanEntry(slug: string, cwd?: string): Promise<PlanEntry | null> {
	const registry = await loadPlansRegistry(cwd);
	return registry.plans[slug] ?? null;
}

// ─── Multi-source reference registry helpers ────────────────────────────────

/** Read `references` from the registry, defaulting to an empty map when absent. */
function referencesOf(reg: PlansRegistry): Readonly<Record<string, ReferenceEntry>> {
	return reg.references ?? {};
}

/**
 * Returns the entries (not just keys) of active references in the current worktree.
 *
 * "Active" = uncommitted (`commitHash === null`) and not a guard from a prior
 * commit (`!contentHashAtCommit`). No branch filter — the per-worktree
 * plans.json already isolates. Used by QueueWorker post-commit prompt assembly.
 */
export async function getReferenceEntriesForBranch(
	cwd: string,
	_branch: string,
): Promise<ReadonlyArray<ReferenceEntry>> {
	const registry = await loadPlansRegistry(cwd);
	const entries: ReferenceEntry[] = [];
	for (const entry of Object.values(referencesOf(registry))) {
		entries.push(entry);
	}
	return entries;
}

/**
 * Returns the {mapKey, source, sourcePath} triples for active references in the
 * current worktree — projection of `getReferenceEntriesForBranch` shaped for the
 * QueueWorker archive dispatch, which only needs these three fields.
 */
export async function detectUncommittedReferenceIds(
	cwd: string,
	_branch: string,
): Promise<ReadonlyArray<{ mapKey: string; source: SourceId; sourcePath: string }>> {
	const registry = await loadPlansRegistry(cwd);
	const out: Array<{ mapKey: string; source: SourceId; sourcePath: string }> = [];
	for (const [mapKey, entry] of Object.entries(referencesOf(registry))) {
		out.push({ mapKey, source: entry.source, sourcePath: entry.sourcePath });
	}
	return out;
}

/**
 * Upsert a reference entry into plans.json.references.
 *
 * References have no guard rows (commit deletes the entry), so every row in
 * the map is an uncommitted active reference. Semantics:
 *   - entry exists → refresh title / url / sourcePath / sourceToolName / updatedAt
 *     (preserve addedAt).
 *   - entry absent → insert fresh.
 *
 * Routes to {@link writeReferenceMarkdown} for the on-disk markdown (sanitization
 * happens there). The near-write reread only overwrites our own mapKey, so a
 * concurrent writer touching other mapKeys is preserved.
 */
export async function upsertReferenceEntry(ref: Reference, cwd: string, _branch: string): Promise<void> {
	const { sourcePath } = await writeReferenceMarkdown(ref, cwd);
	const mapKey = `${ref.source}:${ref.nativeId}`;
	const now = new Date().toISOString();

	const beforeRegistry = await loadPlansRegistry(cwd);
	const beforeReferences = referencesOf(beforeRegistry);
	const existing = beforeReferences[mapKey];

	const next: ReferenceEntry =
		existing !== undefined
			? {
					...existing,
					title: ref.title,
					url: ref.url,
					sourcePath,
					sourceToolName: ref.toolName,
					updatedAt: now,
				}
			: {
					source: ref.source,
					nativeId: ref.nativeId,
					title: ref.title,
					url: ref.url,
					sourcePath,
					addedAt: now,
					updatedAt: now,
					sourceToolName: ref.toolName,
				};

	// Near-write reread — only overwrites our own mapKey, so a concurrent writer
	// touching other mapKeys between our two loadPlansRegistry calls is preserved.
	const freshRegistry = await loadPlansRegistry(cwd);
	const freshReferences = referencesOf(freshRegistry);
	const references = { ...freshReferences, [mapKey]: next };
	const out: PlansRegistry = {
		version: 1,
		plans: freshRegistry.plans,
		...(freshRegistry.notes !== undefined ? { notes: freshRegistry.notes } : {}),
		references,
	};
	await savePlansRegistry(out, cwd);
	log.info("upsertReferenceEntry: %s (%s)", mapKey, existing === undefined ? "new" : "updated");
}

// ─── Active-entry queries for prompt assembly ───────────────────────────────

/** Active plans in the current worktree — uncommitted, not guard-archived. */
export async function detectActivePlansForBranch(cwd: string, _branch: string): Promise<ReadonlyArray<PlanEntry>> {
	const registry = await loadPlansRegistry(cwd);
	const entries: PlanEntry[] = [];
	for (const entry of Object.values(registry.plans)) {
		if (entry.commitHash !== null) continue;
		if (entry.contentHashAtCommit !== undefined) continue;
		entries.push(entry);
	}
	return entries;
}

/** Active notes in the current worktree — uncommitted, not guard-archived. */
export async function detectActiveNotesForBranch(cwd: string, _branch: string): Promise<ReadonlyArray<NoteEntry>> {
	const registry = await loadPlansRegistry(cwd);
	const entries: NoteEntry[] = [];
	for (const entry of Object.values(registry.notes ?? {})) {
		if (entry.commitHash !== null) continue;
		if (entry.contentHashAtCommit !== undefined) continue;
		entries.push(entry);
	}
	return entries;
}
