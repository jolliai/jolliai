/**
 * Cursor Session Discoverer
 *
 * On-demand scanner for Cursor Composer sessions. Cursor stores all Composer
 * transcripts in a *global* SQLite at:
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb  (macOS)
 *   ~/.config/Cursor/User/globalStorage/state.vscdb                      (Linux)
 *   %APPDATA%/Cursor/User/globalStorage/state.vscdb                      (Windows)
 *
 * Rows in the `cursorDiskKV` table are JSON BLOBs keyed by:
 *   composerData:<composerId>        — full composer metadata + bubble headers
 *   bubbleId:<composerId>:<bubbleId> — individual message blobs (not read here)
 *
 * There is NO authoritative "this composer belongs to this workspace" pointer in
 * the global DB. Per-workspace `state.vscdb` files (under
 * User/workspaceStorage/<wsHash>/) DO contain a `composer.composerData` row in
 * their `ItemTable` with `lastFocusedComposerIds` and `selectedComposerIds`.
 *
 * β′ Attribution Algorithm (4 steps):
 *   1. Workspace lookup — scan each <wsHash>/workspace.json for a `folder` URI
 *      that resolves to projectDir. Stop at the first match; return its <wsHash>.
 *   2. Anchor extraction — read <wsHash>/state.vscdb and union the two pointer
 *      arrays into an anchor set. These composers are always included, even if
 *      their lastUpdatedAt is older than the 48 h window.
 *   3. Time-window scan — open the global cursorDiskKV and include every
 *      composerData row whose `lastUpdatedAt` is within the last 48 h.
 *   4. Union + dedupe — merge anchors and window composers; each composer ID
 *      appears at most once in the result.
 *
 * Synthetic transcript path:
 *   "<globalDbPath>#<composerId>"
 *   Matches OpenCode's pattern (<dbPath>#<sessionId>) so downstream cursor-keying
 *   and transcript-reading code works uniformly across SQLite-backed sources.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getCursorGlobalDbPath, getCursorWorkspaceStorageDir } from "./CursorDetector.js";
import { classifyScanError, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("CursorDiscoverer");

/** Sessions older than 48 hours are considered stale (matches other sources) */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export interface CursorScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	/**
	 * Present only when the scan hit a genuine failure (not ENOENT). Callers
	 * should surface this to the UI rather than silently reporting "0 sessions".
	 */
	readonly error?: SqliteScanError;
}

/**
 * Discovers Cursor Composer sessions relevant to the given project directory.
 *
 * Uses the β′ algorithm: workspace pointer IDs (always included) union with
 * composers updated within the last 48 h (time window), deduped.
 *
 * @param projectDir - The git repository root to filter sessions by
 * @returns { sessions, error? } — sessions is always an array; if `error` is
 *   present, callers should surface it to the user rather than silently reporting
 *   "0 sessions" (which is indistinguishable from a genuinely-empty scan).
 */
export async function scanCursorSessions(projectDir: string): Promise<CursorScanResult> {
	const globalDbPath = getCursorGlobalDbPath();

	// Step 1: Workspace lookup — find which workspace hash corresponds to projectDir.
	const wsHash = await findCursorWorkspaceHash(projectDir);
	if (wsHash === null) {
		log.debug("No Cursor workspace found matching %s", projectDir);
		return { sessions: [] };
	}

	// Pre-flight: distinguish "global DB missing" (silent) from "DB unreadable" (genuine failure)
	// before calling DatabaseSync, which surfaces both as the same error message.
	try {
		await stat(globalDbPath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		/* v8 ignore start -- ENOENT branch tested by "does not match" test; the else-branch (EACCES, EPERM, EIO, …) is a rare TOCTOU path requiring a filesystem-level mock. The classifier logic itself is fully covered by classifyScanError's unit tests. */
		if (code !== "ENOENT") {
			const scanError = classifyScanError(error);
			if (scanError) {
				log.error("Cursor global DB stat failed (%s): %s", scanError.kind, scanError.message);
				return { sessions: [], error: scanError };
			}
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.debug("Cursor global DB not present at %s — treating as not installed", globalDbPath);
		return { sessions: [] };
	}

	// Step 2: Anchor extraction — read the per-workspace composer pointer IDs.
	const anchorIds = await readCursorAnchorComposerIds(wsHash);
	const anchorSet = new Set(anchorIds);

	// Step 3: Time-window scan — compute cutoff and open the global DB.
	const cutoffMs = Date.now() - SESSION_STALE_MS;

	try {
		const out: SessionInfo[] = [];
		const seenIds = new Set<string>();

		await withSqliteDb(globalDbPath, (db) => {
			const rows = db
				.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
				.all() as ReadonlyArray<{ key: string; value: string }>;

			for (const row of rows) {
				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(row.value) as Record<string, unknown>;
				} catch {
					log.warn("Skipping Cursor composer row %s: invalid JSON", row.key);
					continue;
				}

				const composerId = typeof parsed.composerId === "string" ? parsed.composerId : null;
				if (composerId === null) {
					log.warn("Skipping Cursor composer row %s: missing composerId", row.key);
					continue;
				}

				const lastUpdatedAt = parsed.lastUpdatedAt;

				// Guard against schema drift: non-numeric timestamps.
				if (typeof lastUpdatedAt !== "number" || !Number.isFinite(lastUpdatedAt)) {
					// Only warn if this composer is an anchor — otherwise silently skip.
					if (anchorSet.has(composerId)) {
						log.warn("Skipping Cursor composer %s: non-finite lastUpdatedAt", composerId);
					}
					continue;
				}

				const inAnchor = anchorSet.has(composerId);
				const inWindow = lastUpdatedAt >= cutoffMs;

				// Step 4: Union — include if in anchor set OR within time window.
				if (!inAnchor && !inWindow) {
					continue;
				}

				// Dedupe: each composerId appears at most once.
				if (seenIds.has(composerId)) {
					continue;
				}
				seenIds.add(composerId);

				out.push({
					sessionId: composerId,
					// Synthetic path: global DB path + composer discriminator (matches OpenCode pattern)
					transcriptPath: `${globalDbPath}#${composerId}`,
					updatedAt: new Date(lastUpdatedAt).toISOString(),
					source: "cursor",
				});
			}
		});

		log.info("Discovered %d Cursor session(s) for %s", out.length, projectDir);
		return { sessions: out };
	} catch (error: unknown) {
		const scanError = classifyScanError(error);
		/* v8 ignore start -- TOCTOU race: the DB passed stat() but vanished or became unreadable before DatabaseSync opened it. Requires a filesystem-level mock; classifier behavior is covered by classifyScanError unit tests. */
		if (scanError === null) {
			log.debug("Cursor global DB disappeared between detection and scan: %s", (error as Error).message);
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.error("Cursor scan failed (%s): %s", scanError.kind, scanError.message);
		return { sessions: [], error: scanError };
	}
}

/**
 * Backwards-compatible wrapper around `scanCursorSessions` that only returns
 * the session array. Callers that need to surface scan failures to the user
 * should call `scanCursorSessions` directly.
 */
export async function discoverCursorSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanCursorSessions(projectDir);
	return sessions;
}

/**
 * Scans the Cursor workspaceStorage directory for a workspace whose `folder`
 * URI resolves to projectDir. Returns the workspace hash (directory name) on
 * match, or null if no match is found.
 *
 * workspace.json contains a `folder` property that is a `file://` URI. We
 * decode it with fileURLToPath so percent-encoding and platform casing are
 * handled correctly.
 */
async function findCursorWorkspaceHash(projectDir: string): Promise<string | null> {
	const wsStorageDir = getCursorWorkspaceStorageDir();

	let entries: string[];
	try {
		entries = await readdir(wsStorageDir);
	} catch {
		log.debug("Cursor workspaceStorage not readable at %s", wsStorageDir);
		return null;
	}

	const target = normalizePathForMatch(projectDir);

	for (const entry of entries) {
		const wsJsonPath = join(wsStorageDir, entry, "workspace.json");
		let folderUri: string | undefined;
		try {
			const raw = await readFile(wsJsonPath, "utf8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			folderUri = typeof parsed.folder === "string" ? parsed.folder : undefined;
		} catch {
			// Skip entries without a readable workspace.json
			continue;
		}

		if (!folderUri || !folderUri.startsWith("file://")) {
			continue;
		}

		let folderPath: string;
		try {
			folderPath = fileURLToPath(folderUri);
		} catch {
			log.warn("Cursor workspace %s has unparseable folder URI: %s", entry, folderUri);
			continue;
		}

		if (normalizePathForMatch(folderPath) === target) {
			return entry;
		}
	}

	return null;
}

/**
 * Reads the per-workspace state.vscdb for a given workspace hash and extracts
 * the anchor composer IDs from the `composer.composerData` row.
 *
 * Returns an empty array (never throws) — a workspace-level failure does NOT
 * abort the whole scan; we still proceed with time-window-only results.
 */
async function readCursorAnchorComposerIds(wsHash: string): Promise<ReadonlyArray<string>> {
	const wsStorageDir = getCursorWorkspaceStorageDir();
	const wsDbPath = join(wsStorageDir, wsHash, "state.vscdb");

	try {
		await stat(wsDbPath);
	} catch {
		log.debug("Cursor workspace DB not found at %s — skipping anchor extraction", wsDbPath);
		return [];
	}

	try {
		return await withSqliteDb(wsDbPath, (db) => {
			const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1").get() as
				| { value: string }
				| undefined;

			if (!row) {
				return [];
			}

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(row.value) as Record<string, unknown>;
			} catch {
				log.warn("Cursor workspace %s composer.composerData is not valid JSON", wsHash);
				return [];
			}

			const lastFocused = Array.isArray(parsed.lastFocusedComposerIds)
				? (parsed.lastFocusedComposerIds as unknown[]).filter((id): id is string => typeof id === "string")
				: [];
			const selected = Array.isArray(parsed.selectedComposerIds)
				? (parsed.selectedComposerIds as unknown[]).filter((id): id is string => typeof id === "string")
				: [];

			// Union of the two pointer arrays, deduped
			const union = new Set([...lastFocused, ...selected]);
			return Array.from(union);
		});
	} catch (error: unknown) {
		log.warn("Failed to read Cursor workspace anchor IDs from %s: %s", wsDbPath, (error as Error).message);
		return [];
	}
}

/**
 * Normalises a filesystem path for workspace matching.
 * - Strips trailing slashes.
 * - Lowercases on case-insensitive platforms (darwin, win32) so that Cursor's
 *   stored path and the projectDir passed by callers compare correctly even
 *   when their casing differs.
 */
function normalizePathForMatch(p: string): string {
	// Normalize backslashes to forward slashes so Windows paths from
	// fileURLToPath (which returns `\`-separated paths) compare correctly
	// against caller-supplied forward-slash paths.
	const fwd = p.replace(/\\/g, "/");
	// Linear-time trailing-slash strip. Equivalent to /\/+$/ but expressed as a
	// loop so CodeQL's js/polynomial-redos heuristic doesn't flag the regex
	// when this function receives paths read from on-disk JSON.
	let end = fwd.length;
	while (end > 0 && fwd[end - 1] === "/") {
		end--;
	}
	const trimmed = fwd.slice(0, end);
	const os = platform();
	return os === "darwin" || os === "win32" ? trimmed.toLowerCase() : trimmed;
}
