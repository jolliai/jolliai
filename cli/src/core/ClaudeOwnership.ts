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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
 * summary down over a state file that the next Stop hook rewrites anyway.
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
			const ledger = await loadClaudeOwners(globalDir);
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
			return acquired;
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
