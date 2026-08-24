/**
 * CutoverRouter — the four-state routing decision at the heart of phase D.
 *
 * Returns an explicit union — `uncutover` / `legacy-fenced` / `cutover` /
 * `blocked` — never a boolean and never three states. `legacy-fenced` is the
 * state a boolean collapses into "not cut over", which would route fenced
 * writes back onto the frozen branch: the exact loss the protocol exists to
 * prevent. `blocked` must never degrade to orphan (a fenced repo's database
 * being unavailable means writes have NOWHERE safe to go), and its converse
 * is just as load-bearing: a repo with NO fence trace has never had its
 * orphan frozen, so a broken database on this machine must not stop it —
 * one surface upgrading the schema must not halt every healthy repo.
 *
 * The FIRST verdict is the local fence trace in profile.json, not the
 * database, for two reasons that map to the two traps above: during
 * `legacy-fenced` the `cutover` row does not exist yet (it is written by the
 * CAS), and an unreadable database must not be interpreted for repos that
 * never cut over. Only when the database opens, the schema is compatible and
 * the repo resolves to a registered row is `repo_state` consulted at all —
 * "state absent" and "state unreadable" are different answers and are never
 * both encoded as null.
 */

import { readCutoverFence } from "../core/RepoProfile.js";
import { createLogger, errMsg } from "../Logger.js";
import { canUseDashboardDb, getDashboardDbPath } from "./DashboardDb.js";
import { classifyDbFiles } from "./DbDetection.js";
import { resolveRepoIdentityForCwd } from "./RepoRegistry.js";

const log = createLogger("CutoverRouter");

/**
 * Per-process memo of cwd → repo identity.
 *
 * {@link hasCutoverRow} is the D6 second witness and runs on EVERY orphan
 * write, where `resolveRepoIdentity` forks `git` to read the canonical remote.
 * A worktree's identity cannot change under a live process (it is the remote
 * URL, or a hash of the path), so the resolution is memoized here the same way
 * and for the same reason `ProducerHooks` memoizes it on the hook path.
 *
 * Keyed by the caller's `cwd`, not by the worktree root: resolving the root
 * would itself be the git call this avoids, and two `cwd`s inside one worktree
 * simply get one entry each.
 */
const identityCache = new Map<string, string>();

/** Test seam: clears the identity memo between cases that reuse a cwd. */
export function resetCutoverRouterCaches(): void {
	identityCache.clear();
}

async function cachedIdentity(cwd: string): Promise<string> {
	const cached = identityCache.get(cwd);
	if (cached !== undefined) return cached;
	const { identity } = await resolveRepoIdentityForCwd(cwd);
	identityCache.set(cwd, identity);
	return identity;
}

/** The evidence row the CAS writes into repo_state key='cutover'. */
export interface CutoverRecord {
	/** Per-source frozen tips at commit time, keyed by source root. */
	readonly tips: Readonly<Record<string, string>>;
	readonly cutoverVersion: number;
	readonly committedAt: string;
	readonly schemaVersion: number;
	/**
	 * What the compare found and the switch went ahead anyway: paths on the
	 * frozen tips that the database does not reproduce, so they stop being
	 * served here. Absent when there were none — which is every clean cutover,
	 * so a record written by an older build parses unchanged.
	 *
	 * `count` is the exact number of DISTINCT paths (a path several sibling
	 * clones each fail to reproduce is one finding, not one per clone); `sample`
	 * is capped (`UNRECONCILED_SAMPLE_CAP` in `CutoverEngine`). The full set is
	 * not stored anywhere because it does not need to be: the fence FREEZES the
	 * branch rather than deleting it, so the authoritative copy of every one of
	 * these paths is still on a tip this same record pins — which is why
	 * `reportUnreconciled` prints {@link tips} alongside the list, and why the
	 * paths themselves need carry no source attribution.
	 */
	readonly unreconciled?: {
		readonly count: number;
		readonly sample: ReadonlyArray<string>;
	};
}

export type CutoverRoute =
	| {
			readonly state: "uncutover";
			/** Set when the database was unreachable — safe, but worth surfacing. */
			readonly warning?: string;
	  }
	| { readonly state: "legacy-fenced" }
	| { readonly state: "cutover"; readonly record: CutoverRecord }
	| { readonly state: "blocked"; readonly reason: string };

/**
 * True when this route has moved the system of record OFF the (freezable) orphan
 * branch — i.e. a long-lived process holding a pre-cutover storage object must
 * rebuild it against SQLite. Only a committed `cutover` or a pending
 * `legacy-fenced` do so: `uncutover` keeps the orphan branch authoritative, and
 * `blocked` means the database is unreachable, where rebuilding would only turn
 * readable-but-stale reads into a hard throw.
 *
 * This is a PRODUCT rule (AGENTS.md: rules live in `cli/src`, hosts are adapters),
 * so both the daemon's `ActiveStorageHeal` and the VS Code bridge route through
 * it rather than each restating the state set — the two had drifted to opposite
 * polarities of the same condition, which a fifth route state would silently
 * break in whichever place forgot to update.
 */
export function routeMovesOffOrphanBranch(
	route: CutoverRoute | null | undefined,
): route is Extract<CutoverRoute, { state: "cutover" | "legacy-fenced" }> {
	return route?.state === "cutover" || route?.state === "legacy-fenced";
}

/** What the database said, with "no row" and "cannot ask" kept distinct. */
type DbAnswer =
	| { readonly kind: "row"; readonly record: CutoverRecord }
	| { readonly kind: "no-row" }
	| { readonly kind: "unavailable"; readonly reason: string };

async function readCutoverRow(cwd: string, dbPath: string): Promise<DbAnswer> {
	if (!canUseDashboardDb()) {
		return { kind: "unavailable", reason: `Node ${process.versions.node} lacks flag-free node:sqlite` };
	}
	const fileState = classifyDbFiles(dbPath);
	if (fileState === "alarm-sidecars-only") {
		return { kind: "unavailable", reason: "database file missing but WAL/SHM remain — run jolli doctor --recover" };
	}
	if (fileState === "absent") {
		return { kind: "unavailable", reason: "database file does not exist" };
	}
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			// NO version or compatibility check here, and its absence is the decision:
			// a file whose format is ahead of this build still answers this question
			// correctly (the `cutover` row is plain JSON in `repo_state`), and
			// answering "cannot ask" instead used to route a cut-over repo's writes
			// back onto its frozen orphan branch — the exact loss the protocol exists
			// to prevent. Compatibility is a release-line concern; see the note at the
			// top of `DashboardDb.ts`.
			const identity = await cachedIdentity(cwd);
			const repo = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
				| { id: number }
				| undefined;
			if (!repo) return { kind: "no-row" };
			const row = db.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = 'cutover'").get(repo.id) as
				| { value: string }
				| undefined;
			if (!row) return { kind: "no-row" };
			return { kind: "row", record: JSON.parse(row.value) as CutoverRecord };
		} finally {
			db.close();
		}
	} catch (err) {
		return { kind: "unavailable", reason: errMsg(err) };
	}
}

/**
 * True exactly when the CAS's `cutover` row exists for `cwd`'s repo identity.
 *
 * The write-time second witness for the orphan fence: the fence in
 * profile.json is PER-CLONE, and a clone the cutover never enumerated (or a
 * fresh clone made after it) carries no fence at all — its only trace that the
 * identity's orphan history is frozen is this row, which is keyed by the
 * remote identity every clone shares. Deliberately quiet and boolean: an
 * unavailable database answers `false` (an unfenced repo must never be blocked
 * by a broken database, and the caller has already consulted the fence), so
 * unlike {@link resolveCutoverRoute} it logs nothing on the everyday
 * "database not created yet" path that every pre-dashboard write hits.
 */
export async function hasCutoverRow(cwd: string, opts: { readonly dbPath?: string } = {}): Promise<boolean> {
	const answer = await readCutoverRow(cwd, opts.dbPath ?? getDashboardDbPath());
	return answer.kind === "row";
}

/**
 * Resolves the routing state for one repo. Every storage-construction site
 * routes through this; the answer is per-call so long-lived processes still
 * need the write-time version check (the D6 invariant) on top.
 */
export async function resolveCutoverRoute(cwd: string, opts: { readonly dbPath?: string } = {}): Promise<CutoverRoute> {
	const fence = await readCutoverFence(cwd).catch(() => null);
	const answer = await readCutoverRow(cwd, opts.dbPath ?? getDashboardDbPath());

	if (answer.kind === "row") {
		// The CAS committed: SQLite is this repo's source of truth. The fence
		// being present too is the normal end state (it is never auto-revoked);
		// the row outranks it because it is written strictly after fencing.
		return { state: "cutover", record: answer.record };
	}
	if (fence !== null) {
		if (answer.kind === "no-row") {
			// Fenced but not yet committed — the third state a boolean loses.
			// Writes go to SQLite only; the orphan branch stays frozen.
			return { state: "legacy-fenced" };
		}
		// Fenced (or committed elsewhere) with an unusable database: there is
		// no safe backend. Falling back to orphan writes the frozen branch.
		return { state: "blocked", reason: answer.reason };
	}
	if (answer.kind === "unavailable") {
		// Never fenced: the orphan branch is still this repo's source of truth
		// and carrying on with it is safe AND correct. Warn, never block —
		// blocking here would let one surface's schema bump halt every healthy
		// repo on the machine.
		log.warn("database unavailable for un-cutover repo (%s) — orphan remains authoritative", answer.reason);
		return { state: "uncutover", warning: answer.reason };
	}
	return { state: "uncutover" };
}
