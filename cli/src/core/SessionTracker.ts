/**
 * Session Tracker Module
 *
 * Manages .jolli/jollimemory/ state files:
 *   - sessions.json: Registry of all active Claude Code sessions (Map<sessionId, SessionInfo>)
 *   - cursors.json: Per-transcript cursor positions (Map<transcriptPath, TranscriptCursor>)
 *   - config.json: Optional configuration (API key, model, etc.)
 *   - lock: Concurrency lock file
 *
 * Supports multiple concurrent Claude Code sessions. Stale sessions (>48h)
 * are automatically pruned during saveSession, along with their cursors.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import type {
	CursorsRegistry,
	GitOperation,
	JolliMemoryConfig,
	PlanEntry,
	PlansRegistry,
	SessionInfo,
	SessionsRegistry,
	SquashPendingState,
	TranscriptCursor,
} from "../Types.js";

const log = createLogger("SessionTracker");

const SESSIONS_FILE = "sessions.json";
const CURSORS_FILE = "cursors.json";
const CONFIG_FILE = "config.json";
const LOCK_FILE = "lock";
const PLANS_FILE = "plans.json";

/** Sessions older than 48 hours are considered stale and pruned automatically */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/** Lock timeout: if a lock is older than this, consider it stale */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
	return filtered;
}

/**
 * Saves a transcript cursor, keyed by its transcriptPath.
 * Signature is unchanged from the single-cursor version.
 *
 * @param cursor - The cursor to save
 * @param cwd - Optional working directory
 */
export async function saveCursor(cursor: TranscriptCursor, cwd?: string): Promise<void> {
	const dir = await ensureJolliMemoryDir(cwd);

	const registry = await loadCursorsRegistry(dir);
	const cursors = { ...registry.cursors };
	cursors[cursor.transcriptPath] = cursor;

	const newRegistry: CursorsRegistry = { version: 1, cursors };
	await atomicWrite(join(dir, CURSORS_FILE), JSON.stringify(newRegistry, null, "\t"));
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
		return JSON.parse(content) as JolliMemoryConfig;
	} catch {
		log.debug("No config file found in %s, using defaults", dir);
		return {};
	}
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

/**
 * Acquires a simple file-based lock to prevent concurrent operations.
 * Returns true if lock was acquired, false if another process holds it.
 *
 * If a lock file exists but is older than LOCK_TIMEOUT_MS, considers it stale
 * and removes it.
 */
export async function acquireLock(cwd?: string): Promise<boolean> {
	const dir = await ensureJolliMemoryDir(cwd);
	const lockPath = join(dir, LOCK_FILE);

	try {
		// Check for existing lock
		const lockStat = await stat(lockPath);
		const age = Date.now() - lockStat.mtimeMs;

		if (age < LOCK_TIMEOUT_MS) {
			log.warn("Lock file exists (age: %dms), another process may be running", age);
			return false;
		}

		// Stale lock — remove it
		log.warn("Removing stale lock file (age: %dms)", age);
		await rm(lockPath, { force: true });
	} catch (error: unknown) {
		const err = error as { code?: string };
		/* v8 ignore next 4 - defensive: non-ENOENT errors from stat are rare filesystem issues */
		if (err.code !== "ENOENT") {
			log.error("Failed to check lock file: %s", (error as Error).message);
			return false;
		}
		// No lock file exists, proceed
	}

	// Create lock file with PID
	try {
		await writeFile(lockPath, String(process.pid), { flag: "wx" });
		return true;
		/* v8 ignore next 4 - race condition: another process grabbed lock between check and write */
	} catch {
		log.warn("Failed to acquire lock (another process may have grabbed it)");
		return false;
	}
}

/**
 * Releases the file-based lock.
 */
export async function releaseLock(cwd?: string): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	const lockPath = join(dir, LOCK_FILE);

	try {
		await rm(lockPath, { force: true });
		/* v8 ignore next 3 - filesystem permission error during lock release */
	} catch (error: unknown) {
		log.error("Failed to release lock: %s", (error as Error).message);
	}
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
 * Enqueues a git operation for Worker processing.
 * Each entry is written as a separate file to avoid concurrent-write conflicts.
 * Filename format: `{timestamp}-{hash8}.json` ensures correct processing order.
 */
export async function enqueueGitOperation(op: GitOperation, cwd?: string): Promise<boolean> {
	const hash8 = op.commitHash.substring(0, 8);
	try {
		const dir = await ensureJolliMemoryDir(cwd);
		const queueDir = join(dir, GIT_OP_QUEUE_DIR);
		await mkdir(queueDir, { recursive: true });

		const timestamp = Date.now();
		const fileName = `${timestamp}-${hash8}.json`;
		await atomicWrite(join(queueDir, fileName), JSON.stringify(op, null, "\t"));
		log.info("Enqueued git operation: type=%s hash=%s file=%s", op.type, hash8, fileName);
		return true;
	} catch (error: unknown) {
		log.error("Failed to enqueue git operation type=%s hash=%s: %s", op.type, hash8, (error as Error).message);
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

/**
 * Checks whether the Worker lock is currently held (another Worker is running).
 * Used by PostRewriteHook to decide whether to spawn a Worker.
 */
export async function isLockHeld(cwd?: string): Promise<boolean> {
	const dir = getJolliMemoryDir(cwd);
	const lockPath = join(dir, LOCK_FILE);
	try {
		const lockStat = await stat(lockPath);
		const age = Date.now() - lockStat.mtimeMs;
		// Lock is held if it exists and is not stale (< 5 min)
		return age < LOCK_TIMEOUT_MS;
	} catch {
		return false; // No lock file = not held
	}
}

/**
 * Checks whether the Worker lock file exists but is stale (older than LOCK_TIMEOUT_MS).
 * A stale lock indicates a crashed Worker that never cleaned up its lock file.
 * Used by `doctor` to detect stuck locks that need manual release.
 */
export async function isLockStale(cwd?: string): Promise<boolean> {
	const dir = getJolliMemoryDir(cwd);
	const lockPath = join(dir, LOCK_FILE);
	try {
		const lockStat = await stat(lockPath);
		const age = Date.now() - lockStat.mtimeMs;
		return age >= LOCK_TIMEOUT_MS;
	} catch {
		return false; // No lock file = not stale
	}
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
async function loadCursorsRegistry(dir: string): Promise<CursorsRegistry> {
	const filePath = join(dir, CURSORS_FILE);
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
 * Removes cursor entries whose transcriptPath matches any of the stale paths.
 * Also prunes "plan:" prefixed cursors whose underlying transcript path is stale.
 */
async function pruneOrphanedCursors(dir: string, stalePaths: ReadonlyArray<string>): Promise<void> {
	const registry = await loadCursorsRegistry(dir);
	const cursors = { ...registry.cursors };
	const staleSet = new Set(stalePaths);
	let pruned = 0;

	for (const key of Object.keys(cursors)) {
		// Strip "plan:" prefix (if present) to match the underlying transcript path
		const rawPath = key.startsWith("plan:") ? key.slice(5) : key;
		if (staleSet.has(rawPath)) {
			delete cursors[key];
			pruned++;
		}
	}

	if (pruned > 0) {
		const newRegistry: CursorsRegistry = { version: 1, cursors };
		await atomicWrite(join(dir, CURSORS_FILE), JSON.stringify(newRegistry, null, "\t"));
	}
}

/**
 * Writes content to a file atomically via tmpfile + rename.
 *
 * On Windows, rename() can fail with EPERM when the target file is held open
 * by another process (antivirus, file watchers, etc.). In that case, falls
 * back to a direct overwrite and cleans up the tmp file.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
	const tmpPath = `${filePath}.tmp`;
	await writeFile(tmpPath, content, "utf-8");
	try {
		await rename(tmpPath, filePath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") {
			// Fallback: write directly and clean up tmp file
			await writeFile(filePath, content, "utf-8");
			await rm(tmpPath, { force: true });
		} else {
			throw error;
		}
	}
}

// ─── Plans Registry ───────────────────────────────────────────────────────────

/**
 * Loads the plans registry from plans.json.
 * Returns an empty registry if the file doesn't exist or is corrupt.
 */
export async function loadPlansRegistry(cwd?: string): Promise<PlansRegistry> {
	const dir = getJolliMemoryDir(cwd);
	const filePath = join(dir, PLANS_FILE);
	try {
		const content = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as Partial<PlansRegistry>;
		// Normalize partial/malformed content (e.g. a manual edit leaving `{}`
		// without the `plans` key) so callers can always assume the canonical
		// shape — prevents `registry.plans[slug]` from throwing on undefined.
		// Spread first to preserve optional fields like `notes`.
		return { ...parsed, version: parsed.version ?? 1, plans: parsed.plans ?? {} };
	} catch {
		return { version: 1, plans: {} };
	}
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
 * Updates a single plan entry's commitHash in the registry.
 * Called by PostCommitHook (on commit) and PostRewriteHook (on rebase).
 */
export async function associatePlanWithCommit(slug: string, commitHash: string, cwd?: string): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const entry = registry.plans[slug];
	if (!entry) {
		log.debug("associatePlanWithCommit: slug %s not in registry, skipping", slug);
		return;
	}
	const updated: PlansRegistry = {
		...registry,
		plans: {
			...registry.plans,
			[slug]: { ...entry, commitHash, updatedAt: new Date().toISOString() },
		},
	};
	await savePlansRegistry(updated, cwd);
	log.info("associatePlanWithCommit: %s → %s", slug, commitHash.substring(0, 8));
}

/** Updates the commitHash for a note entry in the registry (used after squash/rebase). */
export async function associateNoteWithCommit(noteId: string, commitHash: string, cwd?: string): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const entry = registry.notes?.[noteId];
	if (!entry) {
		log.debug("associateNoteWithCommit: id %s not in registry, skipping", noteId);
		return;
	}
	const notes = registry.notes as NonNullable<PlansRegistry["notes"]>;
	const updated: PlansRegistry = {
		...registry,
		notes: {
			...notes,
			[noteId]: { ...entry, commitHash, updatedAt: new Date().toISOString() },
		},
	};
	await savePlansRegistry(updated, cwd);
	log.info("associateNoteWithCommit: %s → %s", noteId, commitHash.substring(0, 8));
}

/**
 * Loads a single plan entry from the registry by slug.
 * Returns null if not found.
 */
export async function loadPlanEntry(slug: string, cwd?: string): Promise<PlanEntry | null> {
	const registry = await loadPlansRegistry(cwd);
	return registry.plans[slug] ?? null;
}
