/**
 * Claude ownership ledger — which worktree roots a Claude session actually
 * visited, and where in the transcript each of them first appeared.
 *
 * MACHINE-GLOBAL on purpose (`~/.jolli/jollimemory/claude-owners.json`). The
 * question it answers is asked by a worktree that never ran the session: Claude
 * was launched in checkout A, the user `cd`-ed into checkout B mid-conversation,
 * and the commit lands in B. B's own `.jolli/jollimemory/` holds nothing about
 * that session — its Stop hook never fired — so a per-worktree ledger would be
 * a second copy of `sessions.json` and would fix nothing. One shared file lets
 * A's hook record B's edge and B's post-commit read find it.
 *
 * Storage only. What counts as a `cwd`, and which line it was first seen on,
 * is a later task's job.
 */

import { readFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { createLogger, errMsg } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { withClaudeOwnersLock } from "./Locks.js";
import { getGlobalConfigDir } from "./SessionTracker.js";

const log = createLogger("ClaudeOwnership");

const CLAUDE_OWNERS_FILE = "claude-owners.json";

/** One worktree root's participation in one Claude session. */
export interface ClaudeOwnerEdge {
	readonly firstSeenAt: string;
	/**
	 * Line index (against `splitTranscriptLines`) of the first line whose `cwd`
	 * belonged to this owner. Becomes a cursor lower bound, so it must never be
	 * re-derived with a different notion of "line N".
	 */
	readonly firstSeenLine: number;
	readonly lastSeenAt: string;
	readonly firstSeenCwd?: string;
	readonly lastSeenCwd?: string;
}

export interface ClaudeOwnedSession {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly source: "claude";
	readonly owners: Readonly<Record<string, ClaudeOwnerEdge>>;
}

export interface ClaudeOwnersLedger {
	readonly version: 1;
	readonly sessions: Readonly<Record<string, ClaudeOwnedSession>>;
}

const EMPTY: ClaudeOwnersLedger = { version: 1, sessions: {} };

/**
 * Hard cap on how many sessions the machine-global ledger retains. The file is
 * read, JSON-parsed and linearly scanned on the post-commit hot path and on
 * every dashboard memory-detail render, and it is otherwise append-only — one
 * entry per Claude session ever seen on this machine — so without a ceiling it
 * grows unbounded and steadily slows both. When the cap is exceeded the oldest
 * sessions (by their most recent `lastSeenAt`) are evicted: an old session's
 * transcript file is the first thing the agent's own retention prunes, so its
 * edge can no longer be acted on anyway. Generous enough that a still-relevant
 * session is never evicted in practice.
 */
const MAX_LEDGER_SESSIONS = 2000;

/** A session's recency = the newest `lastSeenAt` across its owner edges. */
function sessionRecency(session: ClaudeOwnedSession): string {
	let newest = "";
	for (const e of Object.values(session.owners)) {
		if (e.lastSeenAt > newest) newest = e.lastSeenAt;
	}
	return newest;
}

/**
 * Keeps `sessions` within {@link MAX_LEDGER_SESSIONS}, always retaining `keep`
 * (the session being written this call) plus the most-recent others. Exported
 * so its eviction can be unit-tested with a small cap without seeding thousands
 * of entries. ISO timestamps are compared with `<`/`>`, never `localeCompare`,
 * which would reorder under some locales (generated-artifact lesson).
 */
export function capLedgerSessions(
	sessions: Readonly<Record<string, ClaudeOwnedSession>>,
	keep: string,
	max: number = MAX_LEDGER_SESSIONS,
): Record<string, ClaudeOwnedSession> {
	const keys = Object.keys(sessions);
	if (keys.length <= max) return { ...sessions };
	const others = keys
		.filter((k) => k !== keep)
		.sort((a, b) => {
			const ra = sessionRecency(sessions[a]);
			const rb = sessionRecency(sessions[b]);
			return ra < rb ? 1 : ra > rb ? -1 : 0;
		});
	const survivors = new Set<string>([keep, ...others.slice(0, Math.max(0, max - 1))]);
	const out: Record<string, ClaudeOwnedSession> = {};
	for (const k of keys) {
		if (survivors.has(k)) out[k] = sessions[k];
	}
	return out;
}

export function claudeOwnersPath(globalDir?: string): string {
	return join(globalDir ?? getGlobalConfigDir(), CLAUDE_OWNERS_FILE);
}

function sessionKey(sessionId: string): string {
	return `claude:${sessionId}`;
}

/**
 * True when `session` is structurally sound enough for `claudeSessionsOwnedBy`
 * to walk its `owners` map safely — i.e. `owners` is itself a plain object
 * (not null, not an array). A torn or hand-edited ledger can carry a session
 * whose `owners` is missing, `null`, or a wrong-shaped value; that session is
 * dropped rather than coerced, matching the "malformed reads as absent"
 * posture the whole-file check already has.
 */
function hasValidOwners(session: unknown): session is ClaudeOwnedSession {
	if (!session || typeof session !== "object" || Array.isArray(session)) return false;
	const owners = (session as { owners?: unknown }).owners;
	return !!owners && typeof owners === "object" && !Array.isArray(owners);
}

/**
 * Reads the ledger. A missing or unparseable file reads as empty: this is
 * consulted from the post-commit path, where throwing would take the whole
 * summary down over a state file. Reading empty is safe for a LOOKUP (it returns
 * no owners); it is emphatically NOT safe as the basis of a WRITE — a write that
 * started from this empty snapshot would overwrite every other session's edges
 * with the one it is recording. The write path therefore uses
 * {@link readLedgerForWrite}, which distinguishes "absent" from "present but
 * corrupt" and quarantines the latter rather than overwriting it.
 * The same never-throw posture extends to each individual session: one whose
 * `owners` field is missing or malformed is dropped rather than surfaced, so
 * every session `loadClaudeOwners` returns is safe for a caller to index into
 * without checking first.
 */
export async function loadClaudeOwners(globalDir?: string): Promise<ClaudeOwnersLedger> {
	try {
		const raw = JSON.parse(await readFile(claudeOwnersPath(globalDir), "utf-8")) as Partial<ClaudeOwnersLedger>;
		if (!raw || typeof raw !== "object" || typeof raw.sessions !== "object" || raw.sessions === null) return EMPTY;
		const sessions: Record<string, ClaudeOwnedSession> = {};
		for (const [key, session] of Object.entries(raw.sessions)) {
			if (hasValidOwners(session)) sessions[key] = session;
		}
		return { version: 1, sessions };
	} catch (err) {
		log.debug("claude-owners.json unreadable (%s) — treating as empty", errMsg(err));
		return EMPTY;
	}
}

/**
 * Reads the ledger for the WRITE path, distinguishing THREE outcomes a merge
 * must treat differently:
 *
 *   - present & parseable — the base to merge into (`corrupt`/`unavailable` both
 *     false).
 *   - genuinely absent (ENOENT) — normal on a fresh machine; an empty base
 *     (`corrupt`/`unavailable` both false, `ledger` = EMPTY).
 *   - present but the CONTENT is bad — read succeeded, but parse failed, the
 *     top-level shape is wrong, OR any single session entry is malformed:
 *     `corrupt: true`, quarantine before overwriting. A torn per-session entry
 *     counts here (unlike the lenient READ path) precisely because this base is
 *     about to be rewritten — see the loop below.
 *   - could not be READ at all — a transient I/O error (EACCES, EMFILE/ENFILE
 *     under FD exhaustion, EIO): `unavailable: true`. The file was NEVER read,
 *     so it is NOT evidence of corruption; treating it as corrupt would move a
 *     healthy ledger aside and rewrite it from empty over a momentary error.
 *
 * The merge must never overwrite from an empty base for either of the last two:
 * doing so replaces every session's edges with the single one being written,
 * and because the per-transcript `owners` marks have already advanced past the
 * lines those edges came from, the loss is unrecoverable. `corrupt` says
 * "quarantine, then start fresh"; `unavailable` says "leave it entirely alone
 * and retry next pass".
 */
async function readLedgerForWrite(
	globalDir?: string,
): Promise<{ ledger: ClaudeOwnersLedger; corrupt: boolean; unavailable: boolean }> {
	let text: string;
	try {
		text = await readFile(claudeOwnersPath(globalDir), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { ledger: EMPTY, corrupt: false, unavailable: false };
		}
		// A failed READ is not a failed PARSE: the bytes on disk are unknown, so
		// they must not be classified corrupt (which would quarantine + rewrite).
		log.debug("claude-owners.json could not be read (%s) — deferring the write", errMsg(err));
		return { ledger: EMPTY, corrupt: false, unavailable: true };
	}
	try {
		const raw = JSON.parse(text) as Partial<ClaudeOwnersLedger>;
		if (!raw || typeof raw !== "object" || typeof raw.sessions !== "object" || raw.sessions === null) {
			return { ledger: EMPTY, corrupt: true, unavailable: false };
		}
		const sessions: Record<string, ClaudeOwnedSession> = {};
		for (const [key, session] of Object.entries(raw.sessions)) {
			// A per-session entry whose `owners` is malformed is corruption too, not
			// something to filter away. The READ path (`loadClaudeOwners`) drops it
			// because a lookup has nothing to gain from a torn entry, but the WRITE
			// path must NOT: merging from a silently-filtered base and rewriting the
			// file permanently deletes that session on the next successful write.
			// Treat it exactly like a top-level shape failure — quarantine the whole
			// file (preserving the torn entry for recovery) rather than overwrite it.
			// Same "present-but-corrupt" posture, applied consistently to both
			// granularities.
			if (!hasValidOwners(session)) {
				return { ledger: EMPTY, corrupt: true, unavailable: false };
			}
			sessions[key] = session;
		}
		return { ledger: { version: 1, sessions }, corrupt: false, unavailable: false };
	} catch {
		return { ledger: EMPTY, corrupt: true, unavailable: false };
	}
}

/**
 * Moves a present-but-corrupt ledger aside so a fresh one can be written without
 * destroying the sessions it held (they remain in the quarantine file for manual
 * recovery). Returns `false` when the file could not be moved — in which case the
 * caller MUST NOT overwrite it, since that would be the very data loss this
 * guards against.
 */
async function quarantineCorruptLedger(globalDir?: string): Promise<boolean> {
	const path = claudeOwnersPath(globalDir);
	const dest = `${path}.corrupt-${Date.now()}`;
	try {
		await rename(path, dest);
		log.warn(
			"claude-owners.json was unparseable; quarantined to %s and starting fresh — prior sessions' edges are preserved there for recovery",
			basename(dest),
		);
		return true;
		/* v8 ignore start -- reached only when the rename itself fails (a read-only
		 * parent, a vanished directory): fault-injection-only, and the behaviour it
		 * guards — never overwrite a file we could not move aside — is asserted through
		 * the caller's return value in the reachable corrupt-file test. */
	} catch (err) {
		log.warn(
			"claude-owners.json is unparseable and could not be quarantined (%s); refusing to overwrite it",
			errMsg(err),
		);
		return false;
	}
	/* v8 ignore stop */
}

/**
 * Folds `edges` into the ledger. Set-union / max-progress ONLY: an existing
 * edge keeps its `firstSeenAt` / `firstSeenLine` / `firstSeenCwd` and takes the
 * newer `lastSeenAt` / `lastSeenCwd`. A later pass extends an edge; it never
 * rewinds one, because the first-seen position is the lower bound a future
 * commit will read from and moving it forward would silently skip that
 * owner's earliest turns.
 *
 * Returns `true` when the write landed DURABLY (under the lock), `false` when
 * the lock timed out and the merge ran best-effort — in which case a concurrent
 * peer may have clobbered it, so the caller must not advance any cursor past the
 * evidence these edges came from. An empty edge map is a durable no-op (`true`):
 * there was nothing to lose, so the caller may advance freely.
 */
export async function recordClaudeOwners(
	input: {
		readonly sessionId: string;
		readonly transcriptPath: string;
		readonly edges: ReadonlyMap<string, ClaudeOwnerEdge>;
	},
	globalDir?: string,
): Promise<boolean> {
	if (input.edges.size === 0) return true;
	return await withClaudeOwnersLock(
		async (acquired) => {
			// Read inside the lock: a snapshot taken before it would merge a peer's
			// write away, which is the exact race the lock exists for.
			const { ledger, corrupt, unavailable } = await readLedgerForWrite(globalDir);
			if (unavailable) {
				// A transient I/O error read no bytes, so it is no evidence the file is
				// corrupt. Overwriting it (or quarantining it) would destroy every other
				// session's edges over a momentary failure. Leave it untouched and report
				// non-durable so the caller keeps its cursor mark put and re-emits these
				// edges next pass, once the file is readable again.
				return false;
			}
			if (corrupt) {
				// A present-but-unparseable file must not be overwritten with just this
				// session. Move it aside first; if that fails, abort the write entirely
				// and leave the caller's cursor mark put so nothing is lost.
				/* v8 ignore next -- the abort fires only when quarantine's rename failed
				 * (fault-injection-only; see quarantineCorruptLedger). */
				if (!(await quarantineCorruptLedger(globalDir))) return false;
			}
			const key = sessionKey(input.sessionId);
			const existing = ledger.sessions[key];
			const owners: Record<string, ClaudeOwnerEdge> = { ...(existing?.owners ?? {}) };
			for (const [root, incoming] of input.edges) {
				const prior = owners[root];
				owners[root] = prior
					? {
							...prior,
							lastSeenAt: incoming.lastSeenAt > prior.lastSeenAt ? incoming.lastSeenAt : prior.lastSeenAt,
							...(incoming.lastSeenCwd !== undefined ? { lastSeenCwd: incoming.lastSeenCwd } : {}),
						}
					: incoming;
			}
			const next: ClaudeOwnersLedger = {
				version: 1,
				sessions: capLedgerSessions(
					{
						...ledger.sessions,
						[key]: {
							sessionId: input.sessionId,
							transcriptPath: input.transcriptPath,
							source: "claude",
							owners,
						},
					},
					key,
				),
			};
			await atomicWriteFile(claudeOwnersPath(globalDir), JSON.stringify(next, null, "\t"));
			// A recovered-from-corrupt write started from an emptied base, so it is
			// NOT a durable merge of prior state: report non-durable so the caller
			// leaves its cursor mark put and re-emits these edges next pass into the
			// now-fresh (or peer-repopulated) ledger.
			return corrupt ? false : acquired;
		},
		globalDir === undefined ? {} : { globalDir },
	);
}

/**
 * Every Claude session this worktree root is an owner of, with that root's own
 * edge. Callers MUST pass a `resolveStateRoot()`-normalised root — the keys
 * were written that way, and a raw `process.cwd()` on macOS (`/var/…` vs
 * `/private/var/…`) matches nothing while looking perfectly reasonable.
 */
export async function claudeSessionsOwnedBy(
	ownerRoot: string,
	globalDir?: string,
): Promise<ReadonlyArray<{ sessionId: string; transcriptPath: string; edge: ClaudeOwnerEdge }>> {
	const ledger = await loadClaudeOwners(globalDir);
	const mine: { sessionId: string; transcriptPath: string; edge: ClaudeOwnerEdge }[] = [];
	for (const session of Object.values(ledger.sessions)) {
		// Optional chaining here is belt-and-suspenders: `loadClaudeOwners` already
		// drops a session whose `owners` is malformed, but a future direct writer
		// of the file must not be able to reopen this throw.
		const edge = session.owners?.[ownerRoot];
		if (edge) mine.push({ sessionId: session.sessionId, transcriptPath: session.transcriptPath, edge });
	}
	return mine;
}
