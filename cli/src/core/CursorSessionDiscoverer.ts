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

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getCursorGlobalDbPath } from "./CursorDetector.js";
import {
	getCursorProjectsDir,
	listCursorProjectBuckets,
	resolveCursorTranscriptPath,
} from "./CursorTranscriptLocator.js";
import { classifyScanError, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";
import { findVscodeWorkspaceHash, getVscodeWorkspaceStorageDir } from "./VscodeWorkspaceLocator.js";

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
 * @param windowMs - Optional staleness window in milliseconds. Defaults to
 *   {@link SESSION_STALE_MS} (48 h). The dashboard's history back-fill passes a wider
 *   window (7 d) to recover conversations the database never recorded. Callers that
 *   must NOT widen it omit the argument entirely: the "Active Conversations" sidebar,
 *   `jolli status`, and — the one that matters — the post-commit summary in
 *   `QueueWorker`, which uses this window to decide which conversations belong to the
 *   commit being summarised. That summary is written to the git orphan branch and
 *   kept, so a wider window there quietly attaches week-old unrelated conversations
 *   to a commit's stored memory with no error anywhere. Workspace anchors are
 *   unaffected — they bypass the window by design.
 * @returns { sessions, error? } — sessions is always an array; if `error` is
 *   present, callers should surface it to the user rather than silently reporting
 *   "0 sessions" (which is indistinguishable from a genuinely-empty scan).
 */
export async function scanCursorSessions(projectDir: string, windowMs?: number): Promise<CursorScanResult> {
	// Step 1 runs BEFORE the disk scan, and that order is this caller's whole cost
	// model. A repo Cursor has no workspace for claims nothing at all (see
	// {@link cursorSessionsForRepo}), and settling that costs a few `workspace.json`
	// reads — while the scan below is `LIKE 'composerData:%'` plus a `JSON.parse` of
	// every matching blob, i.e. a full pass over the user's entire Cursor history.
	// Scanning first and narrowing afterwards would put that full pass on the 60 s
	// sidebar tick, on every post-commit and on every `jolli status` of a repo Cursor
	// was never opened in, where the answer is provably empty before any blob is read.
	//
	// The multi-repo back-fill hoists the scan on purpose (see
	// {@link scanCursorComposersOnDisk}) — that caller pays the full pass once for N
	// repos, which is the opposite trade. This one has exactly one repo to answer for.
	const wsHash = await findCursorWorkspaceHash(projectDir);
	if (wsHash === null) {
		log.debug("No Cursor workspace found matching %s", projectDir);
		return { sessions: [] };
	}
	const { composers, error } = await scanCursorComposersOnDisk();
	const mine = await narrowToCursorWorkspace(composers, projectDir, wsHash, windowMs);
	return error ? { sessions: mine, error } : { sessions: mine };
}

/** One Cursor composer from the global store, with the timestamp the window judges. */
export interface CursorDiskComposer {
	readonly session: SessionInfo;
	/** `lastUpdatedAt` in epoch ms — already validated finite by the scan. */
	readonly lastUpdatedAt: number;
}

/** A machine-wide Cursor composer scan: every composer in the global store. */
export interface CursorDiskScanResult {
	readonly composers: ReadonlyArray<CursorDiskComposer>;
	readonly error?: SqliteScanError;
}

/**
 * Reads every composer out of Cursor's GLOBAL store, once.
 *
 * MACHINE-WIDE and repo-agnostic on purpose — and this is the source where that
 * split is least obvious, so it is worth stating what does and does not move here.
 *
 * There is no "this composer belongs to this workspace" pointer in the global store
 * (see this file's header), so a composer carries no directory and this scan cannot
 * narrow anything. What it CAN do is stop repeating the expensive half: the query is
 * `LIKE 'composerData:%'` over `cursorDiskKV` followed by a `JSON.parse` of every
 * matching blob — a full scan of the user's entire Cursor history, which the
 * repo-scoped shape ran once per registered repo.
 *
 * The cheap, genuinely per-repo half stays in {@link cursorSessionsForRepo}: the
 * workspace-hash lookup and the single-row anchor read. That is the right cut. The
 * anchor read is one `SELECT … LIMIT 1` against a per-workspace database, so hoisting
 * it would mean opening EVERY workspace's `state.vscdb` on the machine — more work
 * than it saves as soon as a user has more Cursor workspaces than registered repos,
 * which is the normal case.
 *
 * The staleness window is deliberately NOT applied here either: anchors bypass it by
 * design, so a composer outside the window can still be claimed by the workspace that
 * points at it. Filtering here would silently drop those.
 *
 * ## KNOWN, DEFERRED: this returns the user's ENTIRE Cursor history
 *
 * Not a defect to report again. The repo-scoped shape this replaced ran the same query
 * and the same `JSON.parse` per blob, but decided anchor-or-window INSIDE the loop, so
 * it only ever kept the composers one repo could claim. This keeps every composer in
 * the global store, because the decision moved to {@link cursorSessionsForRepo} — and
 * for a multi-repo run that is the point, since each repo answers it differently.
 *
 * What that costs is one small record per composer (id, synthetic path, instant, title)
 * held for the length of the run — single-digit megabytes for a heavy user, not a
 * transcript each. It is bounded by how much Cursor history exists, which does not grow
 * with the number of registered repos.
 *
 * It cannot be filtered here without breaking attribution, and the reason is worth
 * knowing before someone tries: a composer is claimed by anchor OR by window, and the
 * anchor set lives in the per-workspace `state.vscdb`, one database per workspace. To
 * know the anchors at scan time this would have to open EVERY workspace database on the
 * machine — measured above as more work than it saves once a user has more Cursor
 * workspaces than registered repos, which is the normal case. Applying the window alone
 * is not a safe subset either: that is exactly what silently drops an anchored composer
 * the user is actively working in. If this ever has to shrink, the shape to reach for is
 * a lazy handle (id plus enough to re-read the blob on demand), not a filter.
 */
export async function scanCursorComposersOnDisk(): Promise<CursorDiskScanResult> {
	const globalDbPath = getCursorGlobalDbPath();

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
				return { composers: [], error: scanError };
			}
			return { composers: [] };
		}
		/* v8 ignore stop */
		log.debug("Cursor global DB not present at %s — treating as not installed", globalDbPath);
		return { composers: [] };
	}

	try {
		const out: CursorDiskComposer[] = [];
		const seenIds = new Set<string>();

		await withSqliteDb(globalDbPath, (db) => {
			const rows = db
				.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
				.all() as ReadonlyArray<{ key: string; value: string }>;

			for (const row of rows) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(row.value);
				} catch {
					// Unexpected/anomalous (Cursor writes valid JSON) — kept at warn as a corruption
					// signal. It's rare, so it won't spam the way the routine placeholder rows below do.
					log.warn("Skipping Cursor composer row %s: invalid JSON", row.key);
					continue;
				}

				// `JSON.parse` only throws on syntactically invalid input. A row whose value is a
				// valid JSON scalar — most notably the literal `null` that Cursor stores for the
				// `composerData:empty-state-draft` sentinel row — parses without error, so the
				// catch above never fires. Without this guard the `parsed.composerId` access below
				// throws `Cannot read properties of null`, which escapes the loop and fails the
				// entire scan (surfacing as "Some sources unavailable (cursor)" in the UI).
				// Logged at debug, not warn: Cursor ships these placeholder/sentinel rows in every
				// install, so skipping them is routine — surfacing it per-scan only spams the log.
				if (parsed === null || typeof parsed !== "object") {
					log.debug("Skipping Cursor composer row %s: value is not a JSON object", row.key);
					continue;
				}
				const composer = parsed as Record<string, unknown>;

				const composerId = typeof composer.composerId === "string" ? composer.composerId : null;
				if (composerId === null) {
					// A composerData object without a string composerId is unexpected (schema drift),
					// not a routine placeholder — kept at warn. Rare, so it won't spam.
					log.warn("Skipping Cursor composer row %s: missing composerId", row.key);
					continue;
				}

				const lastUpdatedAt = composer.lastUpdatedAt;

				// Guard against schema drift: non-numeric timestamps. An empty/never-used draft
				// composer (e.g. a workspace anchor that was never run) has no lastUpdatedAt — that
				// is routine, so it's logged at debug rather than warn to keep the log quiet.
				if (typeof lastUpdatedAt !== "number" || !Number.isFinite(lastUpdatedAt)) {
					log.debug("Skipping Cursor composer %s: non-finite lastUpdatedAt", composerId);
					continue;
				}

				// Dedupe: each composerId appears at most once. The anchor / window
				// decision is NOT made here — it is per-repo, and lives in
				// `cursorSessionsForRepo`.
				if (seenIds.has(composerId)) {
					continue;
				}
				seenIds.add(composerId);

				const nameRaw = typeof composer.name === "string" ? composer.name.trim() : "";
				const title = nameRaw.length > 0 ? nameRaw : undefined;

				out.push({
					session: {
						sessionId: composerId,
						// Synthetic path: global DB path + composer discriminator (matches OpenCode
						// pattern). Upgraded to the real JSONL below when one exists — see
						// `upgradeToJsonlTranscripts`.
						transcriptPath: `${globalDbPath}#${composerId}`,
						updatedAt: new Date(lastUpdatedAt).toISOString(),
						source: "cursor",
						title,
					},
					lastUpdatedAt,
				});
			}
		});

		log.debug("Cursor disk scan: %d composer(s) in the global store", out.length);
		return { composers: await upgradeToJsonlTranscripts(out) };
	} catch (error: unknown) {
		const scanError = classifyScanError(error);
		/* v8 ignore start -- TOCTOU race: the DB passed stat() but vanished or became unreadable before DatabaseSync opened it. Requires a filesystem-level mock; classifier behavior is covered by classifyScanError unit tests. */
		if (scanError === null) {
			log.debug("Cursor global DB disappeared between detection and scan: %s", (error as Error).message);
			return { composers: [] };
		}
		/* v8 ignore stop */
		log.error("Cursor scan failed (%s): %s", scanError.kind, scanError.message);
		return { composers: [], error: scanError };
	}
}

/**
 * Points each composer at its plaintext JSONL transcript, where one exists.
 *
 * The IDE writes the SAME `agent-transcripts` JSONL that cursor-agent does, and
 * that file is strictly richer than the composer store this source discovers from:
 * it carries `tool_use` blocks (which the bubble reader drops outright) and the
 * `<manually_attached_skills>` envelope, and it does not lose turns — measured,
 * `38cbc0cb` had 0 bubbles in `composerData` while its JSONL held a real message.
 *
 * A composer with NO JSONL keeps its synthetic handle and is still returned. That
 * is the whole reason this upgrades per conversation rather than switching the
 * source wholesale: `readTranscriptForSource` routes on the path shape, so such a
 * conversation is read from the composer store exactly as before — and reports NO
 * `toolUse` at all rather than an empty array, which is the difference between
 * "cannot say" and the false claim "called no tools". On a real machine the only
 * two JSONL-less composers were `bubbles=0` empty drafts, but nothing guarantees
 * that: the JSONL store is newer than the composer store, so an old enough
 * conversation may exist only in the latter.
 *
 * Failure to LIST the bucket root is not propagated — every composer keeps its
 * handle. This runs on the discovery path of a source that already works, so an
 * unreadable `projects/` must degrade to the previous behaviour, not fail the scan.
 */
async function upgradeToJsonlTranscripts(
	composers: ReadonlyArray<CursorDiskComposer>,
	projectsDir: string = getCursorProjectsDir(),
): Promise<CursorDiskComposer[]> {
	const buckets = await listCursorProjectBuckets(projectsDir);
	if (buckets === undefined || buckets.length === 0) return [...composers];
	const out: CursorDiskComposer[] = [];
	// Carried across composers for the reason the CLI discoverer carries it: every
	// conversation of one repo lives in one bucket, so the remembered hit collapses
	// the lookup from O(buckets) to O(1) after the first.
	let preferredBucket: string | undefined;
	for (const composer of composers) {
		const resolved = await resolveCursorTranscriptPath(
			projectsDir,
			buckets,
			composer.session.sessionId,
			preferredBucket,
		);
		if (resolved === undefined) {
			out.push(composer);
			continue;
		}
		preferredBucket = resolved.bucket;
		out.push({ ...composer, session: { ...composer.session, transcriptPath: resolved.path } });
	}
	return out;
}

/**
 * Narrows a machine-wide Cursor composer scan to one repo — the β′ algorithm's
 * per-repo half.
 *
 * ASYNC and NOT built on `DiskSession`, because Cursor's attribution is not a
 * directory comparison at all. The global store records no workspace for a composer,
 * so a repo claims one of two ways:
 *
 *  1. **Anchor** — the repo's own workspace database points at it
 *     (`lastFocusedComposerIds` / `selectedComposerIds`). Anchors bypass the staleness
 *     window by design, which is why the scan must not pre-filter by time.
 *  2. **Time window** — the composer was updated recently.
 *
 * The second is deliberately coarse: with no workspace pointer in the global store,
 * every recent composer is claimed by every repo Cursor has a workspace for. That is
 * pre-existing behaviour, unchanged here — a repo with NO Cursor workspace still
 * claims nothing, which is what the early return preserves.
 */
export async function cursorSessionsForRepo(
	composers: ReadonlyArray<CursorDiskComposer>,
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	// Step 1: Workspace lookup — find which workspace hash corresponds to projectDir.
	const wsHash = await findCursorWorkspaceHash(projectDir);
	if (wsHash === null) {
		log.debug("No Cursor workspace found matching %s", projectDir);
		return [];
	}
	return narrowToCursorWorkspace(composers, projectDir, wsHash, windowMs);
}

/**
 * Steps 2-4 of the β′ algorithm, given a workspace hash step 1 already resolved.
 *
 * Split out so the single-repo entry point can settle step 1 BEFORE paying for the
 * disk scan without resolving the same hash twice — see {@link scanCursorSessions}.
 * Not exported: a caller with no hash belongs in {@link cursorSessionsForRepo},
 * which is the function that knows a missing hash means "claims nothing".
 */
async function narrowToCursorWorkspace(
	composers: ReadonlyArray<CursorDiskComposer>,
	projectDir: string,
	wsHash: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	// Step 2: Anchor extraction — read the per-workspace composer pointer IDs.
	const anchorSet = new Set(await readCursorAnchorComposerIds(wsHash));

	// Step 3/4: window cutoff, then union with the anchors.
	const cutoffMs = Date.now() - (windowMs ?? SESSION_STALE_MS);
	const out = composers
		.filter(({ session, lastUpdatedAt }) => anchorSet.has(session.sessionId) || lastUpdatedAt >= cutoffMs)
		.map(({ session }) => session);

	log.debug("Discovered %d Cursor session(s) for %s", out.length, projectDir);
	return out;
}

/**
 * Backwards-compatible wrapper around `scanCursorSessions` that only returns
 * the session array. Callers that need to surface scan failures to the user
 * should call `scanCursorSessions` directly.
 *
 * @param windowMs - Forwarded to {@link scanCursorSessions}; see that function for why
 *   the post-commit caller leaves it unset.
 */
export async function discoverCursorSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanCursorSessions(projectDir, windowMs);
	return sessions;
}

/**
 * Thin wrapper over the shared VscodeWorkspaceLocator. Cursor reuses VS Code's
 * workspaceStorage layout, so workspace lookup is delegated to the shared
 * implementation with `flavor: "Cursor"`.
 */
async function findCursorWorkspaceHash(projectDir: string): Promise<string | null> {
	return findVscodeWorkspaceHash("Cursor", projectDir);
}

/**
 * Reads the per-workspace state.vscdb for a given workspace hash and extracts
 * the anchor composer IDs from the `composer.composerData` row.
 *
 * Returns an empty array (never throws) — a workspace-level failure does NOT
 * abort the whole scan; we still proceed with time-window-only results.
 */
async function readCursorAnchorComposerIds(wsHash: string): Promise<ReadonlyArray<string>> {
	const wsStorageDir = getVscodeWorkspaceStorageDir("Cursor");
	const wsDbPath = join(wsStorageDir, wsHash, "state.vscdb");

	try {
		await stat(wsDbPath);
	} catch (err) {
		// Genuine absence (ENOENT) is the common case — workspace was opened
		// outside Cursor or storage was pruned. Anything else (EACCES from a
		// sandboxed user-data dir, EIO, etc.) is a real environmental
		// problem the user should hear about, not a "not found" mis-label.
		if (!isEnoent(err)) {
			log.warn("Cursor workspace DB stat failed at %s: %s", wsDbPath, errMsg(err));
			return [];
		}
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
		log.warn("Failed to read Cursor workspace anchor IDs from %s: %s", wsDbPath, errMsg(error));
		return [];
	}
}
