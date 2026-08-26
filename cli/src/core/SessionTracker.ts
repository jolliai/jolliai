/**
 * Session Tracker Module
 *
 * Manages .jolli/jollimemory/ state files:
 *   - sessions.json: Registry of all active AI-agent sessions (Map<sessionId, SessionInfo>)
 *   - cursors.json: Per-transcript cursor positions (Map<transcriptPath, TranscriptCursor>)
 *   - config.json: Optional configuration (API key, model, etc.)
 *
 * Supports multiple concurrent Claude Code sessions. Stale sessions (>48h)
 * are automatically pruned during saveSession, along with their cursors.
 *
 * Lock primitives (`worker.lock` / `orphan-write.lock`) live in `Locks.ts`.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, errMsg, getJolliMemoryDir } from "../Logger.js";
import {
	type CursorsRegistry,
	type DiscoveryExtractor,
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
	type SkillEntry,
	type SkillUse,
	type SourceId,
	type SquashPendingState,
	type TranscriptCursor,
	type TranscriptSource,
} from "../Types.js";
import { atomicWriteFile as atomicWrite } from "./AtomicWrite.js";
import { withConfigLock, withPlansLock, withSessionsLock } from "./Locks.js";
import { writeReferenceMarkdown } from "./references/ReferenceStore.js";
import { archivedTotalsOf, isLegacyArchived, uncommittedDelta } from "./skills/SkillDelta.js";
import { writeSkillMarkdown } from "./skills/SkillStore.js";

const log = createLogger("SessionTracker");

const SESSIONS_FILE = "sessions.json";
const CURSORS_FILE = "cursors.json";
/** Merged plan+reference discovery cursors (replaces plan:/linear: prefixed keys in cursors.json). */
const DISCOVERY_CURSORS_FILE = "discovery-cursors.json";
const CONFIG_FILE = "config.json";
const PLANS_FILE = "plans.json";
/** Atomic-exclusive sentinel that arbitrates a single installId mint across concurrent first-runs. */
const INSTALL_ID_FILE = "install-id";

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
	await withSessionsLock(cwd, async () => {
		// Re-read after acquiring the lock so concurrent plugin/agent hook writers
		// merge from the latest snapshot rather than overwriting one another.
		const registry = await loadSessionsRegistry(dir);
		const sessions = { ...registry.sessions, [sessionInfo.sessionId]: sessionInfo };
		const { activeSessions, stalePaths } = pruneStale(sessions);
		const newRegistry: SessionsRegistry = { version: 1, sessions: activeSessions };
		await atomicWrite(join(dir, SESSIONS_FILE), JSON.stringify(newRegistry, null, "\t"));
		if (stalePaths.length > 0) await pruneOrphanedCursors(dir, stalePaths);
	});
}

/**
 * Loads all active (non-stale) sessions from the registry.
 * Returns an empty array if no sessions exist.
 *
 * `windowMs` widens the read-side filter and defaults to {@link SESSION_STALE_MS},
 * so every existing caller is unaffected. It exists for interface symmetry with the
 * per-source discoverers, which the dashboard's back-fill calls with a 7-day window.
 *
 * **Widening it recovers almost nothing, and for Gemini nothing at all.** The prune
 * here only filters what it returns, but `saveSession` writes back the pruned
 * registry — a PHYSICAL delete — and every Claude or Gemini turn triggers one. So
 * rows past the window are normally gone from the file before any reader could have
 * asked for them. Claude has a second route (`ClaudeSessionDiscoverer` reads the
 * transcripts themselves, which survive indefinitely); Gemini has none, so its
 * history older than 48 h is unrecoverable until a Gemini disk scanner exists.
 */
export async function loadAllSessions(cwd?: string, windowMs?: number): Promise<ReadonlyArray<SessionInfo>> {
	const dir = getJolliMemoryDir(cwd);
	const registry = await loadSessionsRegistry(dir);
	const { activeSessions } = pruneStale(registry.sessions, windowMs);
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
 *
 * `ensureJolliMemoryDir`, not `getJolliMemoryDir`: the lock file lives in that
 * directory, so it has to exist before `withSessionsLock` can create one. The side
 * effect is that `jolli clean` — the only caller — now creates an empty
 * `.jolli/jollimemory/` in a repository that never had Jolli enabled. Harmless (the
 * directory is git-excluded and clean is what the user asked for) but not free, so
 * do not copy this pattern into a read-only path.
 */
export async function pruneStaleSessions(cwd?: string): Promise<number> {
	const dir = await ensureJolliMemoryDir(cwd);
	return withSessionsLock(cwd, async () => {
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
	});
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
 * Source-to-config-flag decision shared by every layer that has to honor the
 * AI Agents toggles:
 *   - CLI [`ActiveSessionAggregator`] — primary source of truth, gates on-disk scans.
 *     (Re-exports this function so historical importers keep working.)
 *   - CLI [`filterSessionsByEnabledIntegrations`] — post-hoc filter over already-loaded
 *     `sessions.json` rows (used by `getStatus` in `install/Installer.ts`).
 *   - VS Code `ActiveSessionsProvider` — belt-and-suspenders post-filter.
 *   - IntelliJ Kotlin `ActiveSessionAggregator` — same, via a hand-mirror.
 *
 * `xxxEnabled === false` is off; every other value (including `undefined`) is
 * on, matching the QueueWorker convention. Grouping:
 *   cursor / cursor-cli → cursorEnabled
 *   copilot / copilot-chat → copilotEnabled
 *   cline / cline-cli → clineEnabled
 * A source not listed here defaults to enabled (fail-open) so a future source
 * never disappears just because the switch statement isn't updated yet.
 *
 * Legacy sessions predating the `source` field (undefined) ride claudeEnabled —
 * matches the historical StopHook-only behaviour.
 */
export function isSourceEnabled(source: TranscriptSource | undefined, config: JolliMemoryConfig): boolean {
	const s = source ?? "claude";
	switch (s) {
		case "claude":
			return config.claudeEnabled !== false;
		case "codex":
			return config.codexEnabled !== false;
		case "gemini":
			return config.geminiEnabled !== false;
		case "opencode":
			return config.openCodeEnabled !== false;
		case "cursor":
		case "cursor-cli":
			return config.cursorEnabled !== false;
		case "copilot":
		case "copilot-chat":
			return config.copilotEnabled !== false;
		case "cline":
		case "cline-cli":
			return config.clineEnabled !== false;
		case "devin":
			return config.devinEnabled !== false;
		case "antigravity":
			return config.antigravityEnabled !== false;
		case "kimi":
			return config.kimiEnabled !== false;
		case "hermes":
			return config.hermesEnabled !== false;
		default:
			return true;
	}
}

/**
 * Filters sessions to only include those from enabled integrations. Sessions
 * without a source are treated as Claude sessions (backward compatibility) —
 * see [isSourceEnabled] for the shared mapping. Prior to that consolidation
 * this function carried its own per-flag switch that had silently drifted
 * (codex was missing), so the single-source rule matters: every AI-agent
 * toggle now flows through one function.
 */
export function filterSessionsByEnabledIntegrations(
	sessions: ReadonlyArray<SessionInfo>,
	config: JolliMemoryConfig,
): ReadonlyArray<SessionInfo> {
	return sessions.filter((s) => isSourceEnabled(s.source, config));
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
	await withSessionsLock(cwd, () => upsertCursorInFile(cursor, dir, CURSORS_FILE));
}

/**
 * Matches a Codex rollout transcript path, keyed under `.codex/sessions/` OR
 * `.codex/archived_sessions/`. Both are scanned by
 * {@link scanCodexSessionsOnDisk} (active tree + flat archive), so both can carry
 * a read cursor the JOLLI-2240 parser bug stranded — a Codex conversation the user
 * archived before running recovery keys under the archive path and would be missed
 * by a `sessions/`-only match. Windows-safe: `[\\/]` accepts both `\` and `/`
 * rather than assuming the POSIX form every other cursor key happens to use.
 */
const CODEX_ROLLOUT_PATH = /[\\/]\.codex[\\/](?:archived_)?sessions[\\/]/;

/**
 * Recovery lever for JOLLI-2240: before this PR's response-item parser fix,
 * Codex conversations parsed to zero entries while their `cursors.json` read
 * cursor still advanced — so the rollout content was marked consumed and
 * could never attach to a commit again, even though the file is still on
 * disk. This rewinds every Codex conversation cursor back to line 0 so a
 * future commit re-reads (re-captures) those sessions.
 *
 * Deliberately scoped to `cursors.json` (the transcript CONVERSATION cursor)
 * and never `discovery-cursors.json` — plan/reference/skill extraction reads
 * that file and was never broken by the parser bug, so touching it would
 * needlessly re-extract. `anchorId`/`extractors` are dropped on rewind:
 * Codex is a linear source and carries neither, so this is defensive rather
 * than lossy.
 *
 * The rewind is UNCONDITIONAL over Codex cursors — no cutoff by time, build
 * version, or "was that read empty?" — and that is intentional, not an
 * oversight: a cursor records only a line number, so a session stranded by the
 * bug is indistinguishable here from a healthy one, and there is no cheap probe
 * that separates them without re-reading. The accepted cost is that an
 * already-captured session is re-captured on the next commit as a DUPLICATE;
 * `--relink-codex` warns about this so the manual recovery is an informed
 * choice. Do not add a silent partial filter here — it would strand exactly the
 * sessions this lever exists to recover.
 */
export async function rewindCodexCursors(cwd: string): Promise<{ rewound: number; paths: string[] }> {
	const dir = await ensureJolliMemoryDir(cwd);
	return withSessionsLock(cwd, async () => {
		const registry = await loadCursorsRegistry(dir, CURSORS_FILE);
		const paths: string[] = [];
		const cursors = { ...registry.cursors };
		for (const [transcriptPath, cursor] of Object.entries(registry.cursors)) {
			if (!CODEX_ROLLOUT_PATH.test(transcriptPath)) continue;
			cursors[transcriptPath] = {
				transcriptPath: cursor.transcriptPath,
				lineNumber: 0,
				updatedAt: new Date().toISOString(),
			};
			paths.push(transcriptPath);
		}
		if (paths.length > 0) {
			await writeCursorsRegistry({ version: 1, cursors }, dir, CURSORS_FILE);
		}
		return { rewound: paths.length, paths };
	});
}

/**
 * Saves the merged plan+reference discovery cursor to discovery-cursors.json,
 * keyed by the bare transcriptPath (no plan:/linear: prefix).
 */
export async function saveDiscoveryCursor(cursor: TranscriptCursor, cwd?: string): Promise<void> {
	const dir = await ensureJolliMemoryDir(cwd);
	// The mark-carrying read below and the upsert's own read-modify-write have to be
	// one critical section: two writers that each read the prior marks before either
	// writes would still clobber one another, which is the exact race the lock is for.
	await withSessionsLock(cwd, async () => {
		// Carry forward any per-extractor marks the incoming cursor does not name. This
		// upsert replaces the whole cursor object, and callers on the shared-cursor path
		// build a bare {path, lineNumber, updatedAt} — so without this merge every
		// extractor's high-water mark would be erased on each advance of the shared
		// cursor, and the marks would never survive long enough to do their job.
		// (An OLDER dist writing this file still erases them; that is unavoidable and is
		// why a missing mark reads as a full rewind rather than as the shared number.)
		const registry = await loadCursorsRegistry(dir, DISCOVERY_CURSORS_FILE);
		const priorMarks = registry.cursors[cursor.transcriptPath]?.extractors;
		const merged: TranscriptCursor =
			cursor.extractors === undefined && priorMarks !== undefined
				? { ...cursor, extractors: priorMarks }
				: cursor;
		await upsertCursorInFile(merged, dir, DISCOVERY_CURSORS_FILE);
	});
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
 * Extractors that existed before per-extractor marks did, and are therefore
 * covered by a legacy bare `lineNumber`.
 *
 * A legacy cursor's single number means "plans and references are both scanned
 * this far" — that was the only pair sharing the file. Crediting it to them is
 * what keeps this change from re-scanning every transcript in the corpus on
 * upgrade. It must NEVER be extended to an extractor added later: that is exactly
 * the stranding this mechanism exists to prevent, since the dist that wrote the
 * legacy number could not have run the newer extractor.
 */
const LEGACY_COVERED_EXTRACTORS: ReadonlyArray<DiscoveryExtractor> = ["plans", "references"];

/**
 * Resolve a cursor's per-extractor marks, seeding legacy records.
 *
 * Returns marks for every extractor the record can account for. An extractor
 * absent from the result has never run against this transcript and must resume
 * from line 0.
 */
function effectiveExtractorMarks(cursor: TranscriptCursor | null): Partial<Record<DiscoveryExtractor, number>> {
	if (cursor === null) return {};
	if (cursor.extractors !== undefined) return { ...cursor.extractors };
	const seeded: Partial<Record<DiscoveryExtractor, number>> = {};
	for (const extractor of LEGACY_COVERED_EXTRACTORS) seeded[extractor] = cursor.lineNumber;
	return seeded;
}

/**
 * Line to resume `extractor` from for `transcriptPath`.
 *
 * Zero means "scan from the top", which is the correct answer both for a
 * transcript never seen and for an extractor that has never run here — including
 * when a bare `lineNumber` written by an older dist claims progress the extractor
 * never actually made.
 */
export async function loadExtractorCursorLine(
	transcriptPath: string,
	extractor: DiscoveryExtractor,
	cwd?: string,
): Promise<number> {
	const cursor = await loadDiscoveryCursor(transcriptPath, cwd);
	return effectiveExtractorMarks(cursor)[extractor] ?? 0;
}

/**
 * Advance `extractor`'s high-water mark for `transcriptPath`.
 *
 * Two invariants, both load-bearing:
 *
 *   - **Monotonic per extractor.** A mark never moves backwards, so a retry after
 *     a partially-failed scan resumes where the last successful pass ended and a
 *     late-arriving stale value cannot undo real progress.
 *   - **The shared `lineNumber` tracks the SLOWEST extractor.** That field remains
 *     the contract for dists that only understand it. `min()` makes such a dist
 *     re-read lines some extractor already handled — harmless, every extractor is
 *     idempotent — whereas `max()` would have it skip lines no extractor reached,
 *     which is silent data loss. Same reasoning as `migrateDiscoveryCursors`.
 */
export async function saveExtractorCursor(
	transcriptPath: string,
	extractor: DiscoveryExtractor,
	lineNumber: number,
	cwd?: string,
): Promise<void> {
	const dir = await ensureJolliMemoryDir(cwd);
	// Same critical section as saveDiscoveryCursor: both advance a record in
	// discovery-cursors.json by reading it, folding new information in, and writing
	// the whole registry back. Leaving either one outside the lock would defeat it
	// for BOTH — an unlocked read-modify-write clobbers a locked one just as easily
	// as two unlocked ones clobber each other. Monotonicity does not save us here:
	// the marks that get lost are the OTHER extractors' entries in the same record,
	// and losing one reads as a full rewind for that extractor.
	await withSessionsLock(cwd, async () => {
		const registry = await loadCursorsRegistry(dir, DISCOVERY_CURSORS_FILE);
		const existing = registry.cursors[transcriptPath] ?? null;

		const marks = effectiveExtractorMarks(existing);
		// Kept in a local as well as on `marks`: reading it back out of the partial
		// record below would need a `??` fallback that can never fire.
		const advancedMark = Math.max(marks[extractor] ?? 0, lineNumber);
		marks[extractor] = advancedMark;

		// The shared field must not overtake an extractor that has no mark yet. Its floor
		// is whatever the record already claimed (legacy seeding covers a bare
		// lineNumber), or 0 when there is no record at all — a brand-new cursor cannot
		// assert that the OTHER extractors have made progress, and claiming they have
		// makes a dist reading only this field skip lines nobody processed. That is
		// exactly the straddling-fetch protection the Codex discovery path relies on.
		const legacyFloor = existing?.lineNumber ?? 0;
		const values = [...LEGACY_COVERED_EXTRACTORS.map((e) => marks[e] ?? legacyFloor), advancedMark];
		const next: TranscriptCursor = {
			transcriptPath,
			lineNumber: Math.min(...values),
			updatedAt: new Date().toISOString(),
			...(existing?.anchorId !== undefined ? { anchorId: existing.anchorId } : {}),
			extractors: marks,
		};
		await writeCursorsRegistry(
			{ version: 1, cursors: { ...registry.cursors, [transcriptPath]: next } },
			dir,
			DISCOVERY_CURSORS_FILE,
		);
	});
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
	await withSessionsLock(cwd, async () => {
		const legacy = await loadCursorsRegistry(dir, CURSORS_FILE);
		const prefixedKeys = Object.keys(legacy.cursors).filter(
			(k) => k.startsWith("plan:") || k.startsWith("linear:"),
		);
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
	});
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
 * Drops a `localAgentPath` that the incoming `localAgentTool` would orphan.
 *
 * `localAgentPath` names ONE tool's binary (see `LocalAgentOverride` in
 * `core/localagent/DetectAgents.ts`), but the persisted config records only the
 * path — never its owner. So a path left behind by a previous tool is
 * INDISTINGUISHABLE at read time from a path deliberately set for the current
 * one: `{tool: "cursor", path: "…/codex"}` and `{tool: "cursor",
 * path: "…/my-cursor"}` are the same two fields. That is why the ownership rule
 * cannot be enforced by the readers (`callLocalAgent`, `jolli doctor`,
 * `BackfillEngine`) — an override short-circuits discovery entirely
 * (`resolveExecutable`), so a stale path becomes the ONLY candidate and the new
 * tool is probed at the old tool's binary.
 *
 * It is enforced here instead, at the single write chokepoint every surface
 * funnels through — CLI commands, the VS Code extension (which bundles this
 * module), and the IntelliJ plugin (via `ide-bridge config-save`) — so no writer
 * can forget it and no new writer has to remember.
 *
 * Two deliberate exemptions:
 *   - The tool is UNCHANGED — re-saving the same tool must not discard the user's
 *     override. The VS Code Settings panel writes `localAgentTool` on every Apply.
 *     BOTH sides of that comparison go through `?? "claude-code"`, mirroring the
 *     ownership fallback in `localAgentOverrideFrom`: an update that clears the
 *     field is asking for the default, so clearing it on a config that was
 *     already defaulted is not a tool change and must not drop the override.
 *   - The update supplies `localAgentPath` ITSELF — setting both together is how
 *     a tool + its explicit binary are configured in one write, so the incoming
 *     path is the new owner's and stays.
 *
 * Both fields are tested for presence with `in`, never `=== undefined`. An
 * explicit `undefined` IS a write — "clear this back to the default" — and
 * `JSON.stringify` duly drops the key. Treating it as absent would let
 * `{localAgentTool: undefined}` sail past this guard on a config holding
 * `{tool: "codex", path: "…/codex"}`, persisting the path with no tool: read
 * back, `localAgentOverrideFrom` reports `{tool: "claude-code", path: "…/codex"}`
 * and Claude Code gets probed at Codex's binary — the exact orphan state this
 * function exists to make unrepresentable. No writer does that today; the point
 * of enforcing it here is that no future one has to know.
 */
function dropOrphanedLocalAgentPath(
	existing: JolliMemoryConfig,
	update: Partial<JolliMemoryConfig>,
): Partial<JolliMemoryConfig> {
	if (!("localAgentTool" in update) || "localAgentPath" in update) return update;
	if ((existing.localAgentTool ?? "claude-code") === (update.localAgentTool ?? "claude-code")) return update;
	if (existing.localAgentPath === undefined) return update;
	log.info(
		"Clearing localAgentPath (was set for %s, switching to %s)",
		existing.localAgentTool ?? "claude-code",
		update.localAgentTool,
	);
	return { ...update, localAgentPath: undefined };
}

/**
 * Saves a partial config update to a specific directory.
 * Creates the directory if needed, merges with existing config, writes atomically.
 *
 * Switching `localAgentTool` also clears a now-orphaned `localAgentPath` — see
 * {@link dropOrphanedLocalAgentPath} for why that invariant lives here and not
 * in the code that reads those two fields.
 *
 * @param update - Partial config fields to save
 * @param targetDir - Directory to write config.json into
 */
export async function saveConfigScoped(update: Partial<JolliMemoryConfig>, targetDir: string): Promise<void> {
	await withConfigLock(targetDir, async () => {
		await saveConfigScopedUnlocked(update, targetDir);
	});
	log.info("Config saved to %s", targetDir);
}

/**
 * What a {@link updateConfigTransactional} decision function returns: the fields to
 * write (or null to write nothing) plus a value handed back to the caller.
 */
export interface ConfigTransaction<T> {
	readonly update: Partial<JolliMemoryConfig> | null;
	readonly result: T;
}

/**
 * Read-decide-write against the machine-global config in ONE critical section.
 *
 * `saveConfig` alone is not enough for a conditional write. It re-reads under the
 * lock so concurrent updates to *different* fields merge safely, but a caller that
 * decides **whether** to write from a snapshot it loaded earlier has already left
 * the lock: two processes both observe "unset", both pass the gate, and the second
 * write wins. That is exactly the shape of the plugin provider seed — a first-wins
 * gate on `aiProvider` — which two plugin hosts starting their first session
 * together could resolve either way. `decide` runs INSIDE the lock against a fresh
 * read, so the gate it applies is the state the write lands on.
 *
 * Returns `decide`'s own `result`, so a caller can report what it did (which field
 * moved, what the previous value was) without re-reading afterwards.
 *
 * Caveat inherited from `withConfigLock`: the lock is best-effort with a timeout, so
 * under heavy contention this degrades to the non-atomic behavior rather than
 * failing. That is the right direction for a session-start path that must not block.
 */
export async function updateConfigTransactional<T>(
	decide: (current: JolliMemoryConfig) => ConfigTransaction<T>,
): Promise<T> {
	return updateConfigTransactionalScoped(decide, getGlobalConfigDir());
}

/** {@link updateConfigTransactional} against an explicit config directory. */
export async function updateConfigTransactionalScoped<T>(
	decide: (current: JolliMemoryConfig) => ConfigTransaction<T>,
	targetDir: string,
): Promise<T> {
	return withConfigLock(targetDir, async () => {
		const { update, result } = decide(await loadConfigFromDir(targetDir));
		if (update !== null) {
			// Re-reads the file a second time inside the same lock. Harmless (the two
			// reads cannot disagree) and worth the duplicate to keep the merge and the
			// orphaned-path invariant in one place.
			await saveConfigScopedUnlocked(update, targetDir);
			log.info("Config saved to %s", targetDir);
		}
		return result;
	});
}

/** Caller must hold `config.lock` for `targetDir`. */
async function saveConfigScopedUnlocked(update: Partial<JolliMemoryConfig>, targetDir: string): Promise<void> {
	// Re-read under the lock: two plugin SessionStart processes may update
	// different provider fields at the same time.
	const existing = await loadConfigFromDir(targetDir);
	// Fields set to undefined are omitted by JSON.stringify, effectively
	// removing them from the persisted config file.
	const merged = { ...existing, ...dropOrphanedLocalAgentPath(existing, update) };
	await atomicWrite(join(targetDir, CONFIG_FILE), JSON.stringify(merged, null, "\t"));
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
 * Returns the stable per-machine telemetry `installId`, minting and persisting
 * one on first call (JOLLI-1785). Stored machine-global in
 * `~/.jolli/jollimemory/config.json` so there is ONE anonymous identity per
 * machine shared across all surfaces (cli / vscode / intellij). The returned
 * `created` flag is true only on the run that minted it — the caller uses it
 * to fire the once-per-machine `app_installed` telemetry event.
 *
 * Contains no PII: a random UUID, never derived from anything user-controlled.
 */
export async function getOrCreateInstallId(): Promise<{ readonly installId: string; readonly created: boolean }> {
	return getOrCreateInstallIdInDir(getGlobalConfigDir());
}

/**
 * Scoped variant of {@link getOrCreateInstallId} — operates on an explicit
 * config directory so it can be unit-tested without touching the real
 * `~/.jolli/jollimemory`. Production code calls the global wrapper above.
 */
export async function getOrCreateInstallIdInDir(
	dir: string,
): Promise<{ readonly installId: string; readonly created: boolean }> {
	const config = await loadConfigFromDir(dir);
	if (config.installId) {
		return { installId: config.installId, created: false };
	}
	// Mint race-free across concurrent first-runs (e.g. CLI post-commit worker +
	// VS Code activate, or two git hooks): the OS-atomic exclusive create of the
	// `install-id` sentinel is the single arbiter. Exactly one process wins it
	// (so `created:true` — and thus `app_installed` — fires once per machine);
	// the loser adopts the winner's id, so both converge instead of each minting
	// its own and clobbering the config. Pre-existing installs already carry
	// `config.installId` and return above without ever touching the sentinel.
	const sentinel = join(dir, INSTALL_ID_FILE);
	const candidate = randomUUID();
	await mkdir(dir, { recursive: true });
	let installId: string;
	let created: boolean;
	// Stage-then-link rather than a plain `writeFile(sentinel, …, "wx")`: the
	// exclusive create publishes the path BEFORE the bytes land, so a loser that
	// reads in that window sees an empty file and falls back to its own
	// candidate — every caller then mints a different id. `link()` is equally
	// atomic (EEXIST when someone else won) but publishes a file that already
	// holds the winner's id, so there is no empty window to observe.
	const staging = `${sentinel}.${randomUUID()}.tmp`;
	try {
		await writeFile(staging, candidate, { flag: "wx" });
		try {
			await link(staging, sentinel);
			installId = candidate;
			created = true;
		} catch {
			installId = await readInstallIdSentinel(sentinel, candidate);
			created = false;
		}
	} catch (err) {
		// The STAGING write is the only step here with no fallback of its own, and
		// it fails for reasons that have nothing to do with identity: an EACCES on
		// `~/.jolli/jollimemory` (a root-owned directory from a `sudo npm` run is the
		// common one), ENOSPC, a read-only volume. Every caller of this treats the
		// install id as a detail of something else — `jolli login` builds a URL with
		// it, `jolli telemetry status` prints it — so letting the throw escape turns
		// an unwritable config directory into a failed sign-in.
		//
		// Degrade to whatever is already published, or to a process-local id when
		// nothing is: `created` stays false either way, so the once-per-machine
		// `app_installed` event cannot fire off an id that was never persisted.
		log.warn("could not stage the install-id sentinel: %s", errMsg(err));
		installId = await readInstallIdSentinel(sentinel, candidate);
		created = false;
	} finally {
		// Same reasoning as the catch above — a cleanup failure must not be the
		// thing that fails the caller. A leftover `.tmp` is inert (a fresh random
		// name every run, and nothing reads the pattern).
		await rm(staging, { force: true }).catch(() => {});
	}
	if (config.installId !== installId) {
		// Best-effort for the same reason: on the ENOSPC/EACCES path above the
		// config write is likely to fail too, and the id is already usable in
		// memory. The next run re-attempts both.
		await saveConfigScoped({ installId }, dir).catch((err: unknown) => {
			log.warn("could not persist the install id: %s", errMsg(err));
		});
	}
	return { installId, created };
}

/** Read the install-id sentinel, falling back to `fallback` if missing/empty/unreadable. */
async function readInstallIdSentinel(path: string, fallback: string): Promise<string> {
	try {
		const v = (await readFile(path, "utf-8")).trim();
		return v.length > 0 ? v : fallback;
	} catch {
		return fallback;
	}
}

/**
 * Machine-global first-seen ledger for the `ai_source_detected` telemetry event
 * (JOLLI-1785). Records `source` in the global config's `telemetrySeenSources`
 * and returns `true` only the first time a given source is seen on this machine,
 * so the caller fires `ai_source_detected` once per source rather than every run.
 */
export async function markAiSourceSeen(source: string): Promise<boolean> {
	return markAiSourceSeenInDir(getGlobalConfigDir(), source);
}

/** Scoped variant of {@link markAiSourceSeen} for unit tests. */
export async function markAiSourceSeenInDir(dir: string, source: string): Promise<boolean> {
	return withConfigLock(dir, async () => {
		const seen = (await loadConfigFromDir(dir)).telemetrySeenSources ?? [];
		if (seen.includes(source)) {
			return false;
		}
		await saveConfigScopedUnlocked({ telemetrySeenSources: [...seen, source] }, dir);
		return true;
	});
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
 * Counts active (non-stale) queue entries that produce a memory summary —
 * every op EXCEPT `ingest` (wiki/graph rendering). Used by the queue-status /
 * PR-wait path so building a PR never blocks on Memory Bank wiki generation.
 */
export async function countActiveSummaryQueueEntries(cwd?: string): Promise<number> {
	const queueDir = join(getJolliMemoryDir(cwd), GIT_OP_QUEUE_DIR);
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
			// Count as active unless PROVABLY stale (`age > STALE`). A missing/unparseable
			// `createdAt` makes `age` NaN and `NaN > STALE` false, so such an op counts as
			// active — the PR-wait path must wait for it rather than silently omit a pending
			// summary. The wait's own timeout bounds the downside of a genuinely stuck op.
			if (!(age > GIT_OP_QUEUE_STALE_MS) && !isIngestOperation(op)) {
				count++;
			}
		} catch {
			// Corrupt entry — ignore (treated as neither active-summary nor countable).
		}
	}
	return count;
}

/**
 * Single-pass count of active (non-stale) queue entries split by kind — summary
 * (every op except `ingest`) vs `ingest` (wiki/graph). One directory scan keeps
 * the two counts mutually consistent: deriving ingest as `total - summary` from
 * two independent scans can skew if an entry is enqueued between them. Uses the
 * same "active unless provably stale" rule as {@link countActiveSummaryQueueEntries}.
 */
export async function countActiveQueueEntriesByKind(cwd?: string): Promise<{ summary: number; ingest: number }> {
	const queueDir = join(getJolliMemoryDir(cwd), GIT_OP_QUEUE_DIR);
	let files: string[];
	try {
		files = await readdir(queueDir);
	} catch {
		return { summary: 0, ingest: 0 };
	}

	const now = Date.now();
	let summary = 0;
	let ingest = 0;
	for (const file of files.filter((f) => f.endsWith(".json"))) {
		try {
			const content = await readFile(join(queueDir, file), "utf-8");
			const op = JSON.parse(content) as GitOperation;
			const age = now - new Date(op.createdAt).getTime();
			if (!(age > GIT_OP_QUEUE_STALE_MS)) {
				if (isIngestOperation(op)) ingest++;
				else summary++;
			}
		} catch {
			// Corrupt entry — neither active-summary nor active-ingest.
		}
	}
	return { summary, ingest };
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
 * Process-local monotonic sequence — disambiguates two enqueues within the same
 * millisecond *in the same process*. It does NOT disambiguate across processes
 * (each fresh node process starts at 0), which is why the filename also carries
 * {@link PROCESS_NONCE}.
 */
let enqueueSeq = 0;

/**
 * Per-process random nonce. The git hooks run as separate node processes
 * (post-commit, post-merge, the QueueWorker re-enqueue) that can each enqueue
 * in the same millisecond with the same tag — `{ms}-00000001-ingest` from two
 * processes would collide and one atomicWrite would overwrite the other, losing
 * a queue entry. Adding a process-unique segment makes the filename unique
 * across processes without disturbing the timestamp-first sort order.
 */
const PROCESS_NONCE = randomBytes(4).toString("hex");

/**
 * Enqueues a git operation for Worker processing.
 * Each entry is written as a separate file to avoid concurrent-write conflicts.
 * Filename format: `{timestamp}-{seq}-{nonce}-{tag}.json`. The `{timestamp}`
 * prefix drives the chronological drain sort; `{seq}` + `{nonce}` only guarantee
 * uniqueness (within and across processes) for same-millisecond enqueues.
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
		const fileName = `${timestamp}-${seq}-${PROCESS_NONCE}-${tag}.json`;
		await atomicWrite(join(queueDir, fileName), JSON.stringify(op, null, "\t"));
		log.info("Enqueued queue operation: type=%s tag=%s file=%s", op.type, tag, fileName);
		return true;
	} catch (error: unknown) {
		log.error("Failed to enqueue queue operation type=%s tag=%s: %s", op.type, tag, (error as Error).message);
		return false;
	}
}

/**
 * Reads all queued git operations, sorted by filename (timestamp order),
 * WITHOUT touching the queue. Nothing is pruned and nothing is deleted.
 *
 * For callers that need to know what is queued but are not going to process it
 * — the QueueWorker's blocked-route gate is the one that matters, since it
 * exits leaving the entries for a capable runtime and must not quietly delete
 * the oldest ones on the way out. Use {@link dequeueAllGitOperations} when you
 * ARE the drain.
 */
export async function peekAllGitOperations(cwd?: string): Promise<ReadonlyArray<GitOperation>> {
	const queueDir = join(getJolliMemoryDir(cwd), GIT_OP_QUEUE_DIR);
	let files: string[];
	try {
		files = await readdir(queueDir);
	} catch {
		return [];
	}
	const results: GitOperation[] = [];
	for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
		try {
			results.push(JSON.parse(await readFile(join(queueDir, file), "utf-8")) as GitOperation);
		} catch (error: unknown) {
			log.warn("Failed to read queue entry %s: %s — skipping", file, (error as Error).message);
		}
	}
	return results;
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
 * Filters out sessions older than `staleMs` (default {@link SESSION_STALE_MS}).
 * Returns the active sessions and the transcript paths of pruned sessions.
 *
 * The window is a parameter only for the read path ({@link loadAllSessions}). The
 * WRITE callers — `saveSession` and `pruneStaleSessions` — deliberately keep the
 * default, because what they do with the result is delete rows from disk: a caller
 * that widened the window there would not be reading more, it would be changing how
 * long the registry retains anything.
 */
function pruneStale(
	sessions: Readonly<Record<string, SessionInfo>>,
	staleMs: number = SESSION_STALE_MS,
): {
	activeSessions: Record<string, SessionInfo>;
	stalePaths: string[];
} {
	const now = Date.now();
	const activeSessions: Record<string, SessionInfo> = {};
	const stalePaths: string[] = [];

	for (const [id, session] of Object.entries(sessions)) {
		const age = now - new Date(session.updatedAt).getTime();
		if (age > staleMs) {
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

/**
 * Legacy fields removed from PlanEntry (`editCount` is plan-only) and NoteEntry.
 * `branch` is stripped: working-area context (plans/notes/references) is
 * worktree-scoped, not branch-scoped — it follows the worktree across branch
 * switches and is associated to a branch only at commit (recorded on
 * `CommitSummary.branch`), exactly like Conversations and uncommitted code. So a
 * `branch` on a working-area entry never persists past a load->save.
 */
const LEGACY_PLAN_FIELDS = ["ignored", "branch", "editCount"] as const;
const LEGACY_NOTE_FIELDS = ["ignored", "branch"] as const;
/** Reference committed/guard rows became dead fields (a live row is uncommitted). */
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
 *     `contentHashAtCommit` guard. `branch` is stripped — working-area entries
 *     are worktree-scoped, not branch-scoped (branch lives on CommitSummary).
 *   - references: also drop committed / guard rows — detected ONLY by the
 *     `commitHash` / `contentHashAtCommit` fields, deliberately NOT by a
 *     `-<8hex>` key shape (an active ticket id can legitimately end in 8 digits;
 *     see the predicate below) — a reference row is now always
 *     active/uncommitted — and strip the now-dead fields from survivors.
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
		// Passed through untouched, deliberately: skills are a post-legacy artifact
		// type, so there are no dead fields to strip and no `ignored` rows to purge.
		// They follow the plan/note lifecycle, so guarded (`commitHash` +
		// `contentHashAtCommit`) rows MUST survive — the reference branch above drops
		// those, and copying that here would delete every archive guard on load.
		// NB this rebuild is field-by-field: omitting a map erases it on every load.
		...(raw.skills !== undefined ? { skills: raw.skills } : {}),
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
	await withPlansLock(cwd, async () => {
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
	});
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
	await withPlansLock(cwd, async () => {
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
	});
}

/**
 * Updates the commitHash for a skill entry in the registry (used after squash/rebase).
 *
 * Same guard-entry migration semantics as {@link associatePlanWithCommit} — see that
 * function's doc-comment for the rationale. `archivedKey` is the pointer stored on
 * `CommitSummary.skills`, `<mapKey>-<oldShortHash>`, so splitting it yields the
 * registry key directly.
 *
 * `archivedTotals` is preserved alongside `contentHashAtCommit`: it records how much
 * of the row a commit already claimed, and a rewrite of commit metadata does not
 * un-claim any of it. Dropping it here would make the row's whole history look
 * uncommitted again and republish it onto the next commit.
 */
export async function associateSkillWithCommit(
	archivedKey: string,
	commitHash: string,
	cwd?: string,
	/**
	 * Hashes this rewrite is collapsing. A guard sitting on any of them must move,
	 * even when `archivedKey`'s own embedded hash no longer matches it.
	 *
	 * Needed because a hoisted ref keeps the archivedKey of the commit that ORIGINALLY
	 * archived it, while the guard has since been migrated. Matching the embedded hash
	 * alone therefore worked once and then silently stopped, stranding the row on a
	 * commit that no longer existed — where nothing could ever archive it again.
	 */
	collapsedHashes?: ReadonlyArray<string>,
): Promise<void> {
	const split = splitArchivedKey(archivedKey);
	if (!split) {
		log.debug("associateSkillWithCommit: %s is not an archived key, skipping", archivedKey);
		return;
	}
	await withPlansLock(cwd, async () => {
		const registry = await loadPlansRegistry(cwd);
		const skills = registry.skills;
		const guard = skills?.[split.baseKey];
		const at = guard?.commitHash;
		const anchored =
			at !== undefined &&
			at !== null &&
			(at.startsWith(split.oldShortHash) ||
				(collapsedHashes ?? []).some((h) => h.startsWith(at) || at.startsWith(h)));
		if (!guard?.contentHashAtCommit || !anchored) {
			log.debug("associateSkillWithCommit: no matching guard for %s, skipping", archivedKey);
			return;
		}
		const updated: PlansRegistry = {
			...registry,
			skills: {
				...(skills as NonNullable<PlansRegistry["skills"]>),
				[split.baseKey]: { ...guard, commitHash },
			},
		};
		await savePlansRegistry(updated, cwd);
		log.info("associateSkillWithCommit: migrated guard %s → %s", split.baseKey, commitHash.substring(0, 8));
	});
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
 *
 * Deliberately NOT widened with `title` for the IDE payload: this shape is the
 * worker's, ~20 of its test fixtures are typed against it, and a second caller's
 * display need is not a reason to move it. The `active-for-commit` handler joins
 * titles from the registry itself — CLI-side either way, which is the part that
 * matters (see AGENTS.md → "IDE hosts are adapters").
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
export async function upsertReferenceEntry(ref: Reference, cwd: string): Promise<void> {
	const mapKey = `${ref.source}:${ref.nativeId}`;
	const now = new Date().toISOString();

	// Whole markdown-write + load→save under plans.lock so a concurrent StopHook /
	// QueueWorker / Codex-discovery write can't clobber this reference (and vice versa).
	//
	// The markdown write MUST be inside the lock, not just the plans.json pair. For an
	// `accumulateBody` source it is a read-modify-write: `writeReferenceMarkdown` folds
	// the body already on disk into this write, so two interleaved writers each render
	// from the same pre-merge body and the later `writeFile` silently drops the other's
	// query. That is reachable — `jollimemory:search` is keyed on the TOOL, not on the
	// agent, so the Claude Stop hook and the Codex discovery tick contend for one file.
	// (Before accumulation existed the file was a pure function of `ref`; interleaved
	// writers produced identical bytes and the lock-free write was harmless.)
	//
	// The near-write reread + per-key merge below is retained as residual mitigation for
	// the best-effort path where the lock couldn't be acquired — but note it mitigates
	// plans.json ONLY. It works because a registry row is overwritten wholesale (an
	// idempotent per-key set); an accumulating markdown body is folded, so nothing here
	// covers a lost update on the markdown if the lock is unavailable.
	await withPlansLock(cwd, async () => {
		// `title`/`url`, not `ref.title`/`ref.url`: for a source declaring
		// `titleFallbackPattern` the markdown may have kept the pair already stored (a later
		// transcript that could not re-harvest the real name re-derives the synthesized one
		// AND the fallback link). Storing the incoming values here would leave this row
		// disagreeing with the file it points at — and the row is what the sidebar renders
		// and what the click opens.
		const { sourcePath, title, url } = await writeReferenceMarkdown(ref, cwd);
		const beforeRegistry = await loadPlansRegistry(cwd);
		const beforeReferences = referencesOf(beforeRegistry);
		const existing = beforeReferences[mapKey];

		const next: ReferenceEntry =
			existing !== undefined
				? {
						...existing,
						title,
						url,
						sourcePath,
						sourceToolName: ref.toolName,
						updatedAt: now,
					}
				: {
						source: ref.source,
						nativeId: ref.nativeId,
						title,
						url,
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
			// Carried explicitly because this object is rebuilt field-by-field rather
			// than spread. A map omitted here is silently erased by any reference
			// write, with nothing failing to compile — the field is optional.
			...(freshRegistry.skills !== undefined ? { skills: freshRegistry.skills } : {}),
		};
		await savePlansRegistry(out, cwd);
		log.info("upsertReferenceEntry: %s (%s)", mapKey, existing === undefined ? "new" : "updated");
	});
}

// ─── Skill usage registry helpers ───────────────────────────────────────────

/** Read `skills` from the registry, defaulting to an empty map when absent. */
function skillsOf(reg: PlansRegistry): Readonly<Record<string, SkillEntry>> {
	return reg.skills ?? {};
}

/**
 * Upsert a skill usage row into plans.json.skills, keyed `<source>:<skill>`.
 *
 * A skill entered N times is ONE row: {@link writeSkillMarkdown} folds this pass
 * into the file already on disk and returns the authoritative post-fold counters,
 * which this function copies onto the row. The row is an index over that file —
 * it never carries history the file does not.
 *
 * Skills follow the plan/note lifecycle: a committed row is GUARDED
 * (`commitHash` + `contentHashAtCommit` set), not deleted, so `commitHash: null`
 * is preserved on update and only archival sets it.
 *
 * The markdown write is inside `withPlansLock` for the same reason
 * `writeReferenceMarkdown` is: it is a read-modify-write, so two unsynchronized
 * writers each fold into the same pre-merge body and the later one drops the
 * earlier one's invocations. Reachable in practice — the Claude Stop hook and the
 * hookless discovery tick can both be capturing for one project at once.
 */
export async function upsertSkillEntry(use: SkillUse, cwd: string): Promise<void> {
	const mapKey = `${use.source}:${use.skill}`;

	await withPlansLock(cwd, async () => {
		const folded = await writeSkillMarkdown(use, cwd);
		const beforeRegistry = await loadPlansRegistry(cwd);
		const existing = skillsOf(beforeRegistry)[mapKey];

		const next: SkillEntry = {
			source: use.source,
			skill: use.skill,
			...(use.plugin !== undefined || existing?.plugin !== undefined
				? { plugin: use.plugin ?? existing?.plugin }
				: {}),
			entryPaths: folded.entryPaths,
			invocations: folded.invocations,
			invocationCount: folded.invocationCount,
			firstUsedAt: folded.firstUsedAt,
			lastUsedAt: folded.lastUsedAt,
			// From the FOLD, not from `use`: the incoming value covers ONE session, while
			// the row must carry the total across every session that used this skill.
			// Reading `use.usage` here was an under-count — the last session scanned won.
			...(folded.usage !== undefined ? { usage: folded.usage } : {}),
			...(folded.usageBySession !== undefined ? { usageBySession: folded.usageBySession } : {}),
			...(folded.detection !== undefined ? { detection: folded.detection } : {}),
			sourcePath: folded.sourcePath,
			// Never resurrect a guard: archival owns these three fields. What makes the
			// row uncommitted again is the counters above growing past `archivedTotals`,
			// not the guard being cleared — see uncommittedDelta.
			commitHash: existing?.commitHash ?? null,
			...(existing?.contentHashAtCommit !== undefined
				? { contentHashAtCommit: existing.contentHashAtCommit }
				: {}),
			// Seed a baseline for a row guarded by a version that predates the field: the
			// counters BEFORE this fold are exactly what that archive froze. Without this
			// the row would keep reading as fully committed forever (uncommittedDelta's
			// legacy rule), which is the bug the baseline exists to fix.
			...(existing?.archivedTotals !== undefined
				? { archivedTotals: existing.archivedTotals }
				: existing !== undefined && isLegacyArchived(existing)
					? { archivedTotals: archivedTotalsOf(existing) }
					: {}),
		};

		// Near-write reread — only overwrites our own mapKey, so a concurrent writer
		// touching other mapKeys between our two loads is preserved.
		const freshRegistry = await loadPlansRegistry(cwd);
		const out: PlansRegistry = {
			...freshRegistry,
			skills: { ...skillsOf(freshRegistry), [mapKey]: next },
		};
		await savePlansRegistry(out, cwd);
		log.info(
			"upsertSkillEntry: %s (%s, ×%d)",
			mapKey,
			existing === undefined ? "new" : "updated",
			next.invocationCount,
		);
	});
}

// ─── Active-entry queries for prompt assembly ───────────────────────────────

/**
 * Active plans in the current worktree — uncommitted, not guard-archived, and
 * still backed by a file on disk.
 *
 * The existence check is part of the rule, not a caller's optimisation: the
 * archive loop in `QueueWorker.archivePlansForCommit` skips a row whose
 * `sourcePath` is gone (it cannot read content it does not have), so a row that
 * fails it is one the next commit provably will NOT claim. Leaving it in made
 * every consumer of this "what would the next commit archive?" set wrong in the
 * same way — VS Code's Next-Memory preview listed it and fed it to the relevance
 * ranker, and IntelliJ's Working Memory review had grown its own Kotlin
 * `File(sourcePath).exists()` filter to compensate. One predicate, here.
 */
export async function detectActivePlansForBranch(cwd: string, _branch: string): Promise<ReadonlyArray<PlanEntry>> {
	const registry = await loadPlansRegistry(cwd);
	const candidates: PlanEntry[] = [];
	for (const entry of Object.values(registry.plans)) {
		if (entry.commitHash !== null) continue;
		if (entry.contentHashAtCommit !== undefined) continue;
		candidates.push(entry);
	}
	// Registry filters first, disk last: the stat is the only I/O here, and the
	// cheap predicates above usually leave nothing to stat. Concurrent because
	// these are independent paths and the caller is on the commit path.
	const onDisk = await Promise.all(candidates.map((entry) => pathExists(entry.sourcePath)));
	return candidates.filter((_, index) => onDisk[index]);
}

/** `stat`-based existence probe — the module's async idiom, not `existsSync`. */
async function pathExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Active skills in the current worktree — those with usage no commit has claimed.
 *
 * Deliberately NOT the guard predicate plans and notes use. A plan is archived once
 * and finished, so "has a commitHash" answers it; a skill can be entered again after
 * being archived, and its row keeps accumulating. Gating on the guard therefore hid
 * a re-used skill from this group forever after its first commit.
 */
export async function detectActiveSkillsForBranch(cwd: string, _branch: string): Promise<ReadonlyArray<SkillEntry>> {
	const registry = await loadPlansRegistry(cwd);
	const entries: SkillEntry[] = [];
	for (const entry of Object.values(registry.skills ?? {})) {
		if (uncommittedDelta(entry) === undefined) continue;
		entries.push(entry);
	}
	return entries;
}

/**
 * Active notes in the current worktree — uncommitted, not guard-archived, and
 * still backed by a readable file.
 *
 * The `sourcePath` check is the same rule, and for the same reason, as the one
 * on {@link detectActivePlansForBranch}: `QueueWorker.associateNotesWithCommit`
 * skips a row with no `sourcePath` or a missing file ("has no readable source
 * file — skipping"), because there is no content to snapshot. A row that fails
 * it is one the next commit provably will NOT claim, so leaving it in this set
 * makes every consumer overstate the next memory — and feeds a phantom row to
 * the relevance ranker.
 */
export async function detectActiveNotesForBranch(cwd: string, _branch: string): Promise<ReadonlyArray<NoteEntry>> {
	const registry = await loadPlansRegistry(cwd);
	// Paired with the resolved path so the disk probe below needs no non-null
	// assertion — `NoteEntry.sourcePath` is optional, and absent means the same
	// thing to the worker as missing-on-disk.
	const candidates: Array<{ entry: NoteEntry; sourcePath: string }> = [];
	for (const entry of Object.values(registry.notes ?? {})) {
		if (entry.commitHash !== null) continue;
		if (entry.contentHashAtCommit !== undefined) continue;
		if (entry.sourcePath === undefined) continue;
		candidates.push({ entry, sourcePath: entry.sourcePath });
	}
	// Registry filters first, disk last — see detectActivePlansForBranch.
	const onDisk = await Promise.all(candidates.map((c) => pathExists(c.sourcePath)));
	return candidates.filter((_, index) => onDisk[index]).map((c) => c.entry);
}
