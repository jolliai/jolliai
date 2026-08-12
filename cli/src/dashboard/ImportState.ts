/**
 * ImportState — the lifecycle record for a repo's orphan → SQLite memory
 * migration, and the resume cursor that makes it restartable.
 *
 * Both live in ONE `repo_state` row, key `'orphan-import'`. That key predates
 * this module as a completion receipt written once at the end of a successful
 * import; it is now a record with a `state` discriminator. Three consequences
 * worth stating, because each was a decision:
 *
 * - **Not a new key.** The key is already on disk in every database that has
 *   ever imported. Renaming it would orphan those rows — the readers below
 *   would find nothing and report "never migrated" for a fully-migrated repo —
 *   and unlike the tables, a `repo_state` value has no migration path.
 * - **Not a file.** The cursor is only meaningful if it advances in the SAME
 *   transaction as the rows it certifies, which a file cannot do. And the
 *   claim being recorded ("the database holds the first N memories of this
 *   ordering") is a claim ABOUT the database, so a second witness elsewhere
 *   could only ever disagree with it.
 * - **Not a schema change.** `repo_state` is `(repo_id, key TEXT, value TEXT)`
 *   with no constraint on `key`; its own DDL comment says adding a marker is
 *   an INSERT. `DASHBOARD_SCHEMA_VERSION` does not move.
 *
 * Naming: everything here says "import" because the persisted key does. The
 * USER-facing vocabulary is "migration" — see {@link describeImportState}.
 * That divergence is deliberate: `MigrationState` / `MigrationEngine` /
 * `.jolli/migration.json` already belong to the Memory Bank *folder*
 * migration (a different thing, with a Kotlin mirror), so reusing the word
 * internally would collide two unrelated concepts.
 */

import { createHash } from "node:crypto";

import { isPidAlive } from "../core/LockPrimitives.js";
import { createLogger, errMsg } from "../Logger.js";
import { canUseDashboardDb, type DashboardDbHandle, getDashboardDbPath } from "./DashboardDb.js";
import { classifyDbFiles } from "./DbDetection.js";
import { resolveRepoIdentityForCwd } from "./RepoRegistry.js";

const log = createLogger("ImportState");

/** The `repo_state` key. Load-bearing: it predates the lifecycle fields. */
export const IMPORT_STATE_KEY = "orphan-import";

/**
 * How long a `running` record may go without a heartbeat before the reader
 * stops calling it fresh.
 *
 * This is NOT a liveness verdict on its own — see {@link describeImportState}
 * for why a stale heartbeat with a live pid still reports "migrating". The
 * only thing this bounds is how confidently we can say a live pid is making
 * progress; pid recycling is the other reason it exists.
 */
export const IMPORT_STALE_MS = 10 * 60_000;

/** Where a resumable import got to, within one ordering of one repo's memories. */
export interface ImportCursor {
	/**
	 * Fingerprint of the ordering this cursor indexes into. A correctness
	 * requirement, not an optimisation: between two runs the orphan branch can
	 * gain, lose or rewrite summaries, and `nextIndex` would then point at a
	 * different memory. On a mismatch the cursor is discarded and the import
	 * starts over.
	 */
	readonly fingerprint: string;
	/**
	 * The mode that produced this cursor. A resume is only legal against the same
	 * one, and the fingerprint cannot stand in for it: the fingerprint describes
	 * the ORDERING, which is identical either way. A `catch-up` cursor resumed by
	 * a later `seed` run skipped the whole already-imported prefix — so
	 * `seedPhase1`'s shift moved those rows into the offset region, the settle pass
	 * (which only walks what the seed visits) never re-grounded them, and
	 * `groundOffsetResidue` NULLed their `parent_hash`/`child_pos`, turning every
	 * amend chain in the prefix into an independent root commit.
	 *
	 * Optional for cursors written before this field existed; absent is treated as
	 * "unknown mode", which never matches, so such a cursor is simply discarded and
	 * the import starts over — always safe, since every write is an upsert.
	 */
	readonly mode?: "seed" | "catch-up";
	/** Position in the ordering to resume from — counts skipped entries too. */
	readonly nextIndex: number;
	/**
	 * Memories actually WRITTEN so far, which is not the same number as
	 * `nextIndex`: a summary whose body does not parse advances the position
	 * without producing a row. Carried separately so a resumed run reports what
	 * it really stored instead of inheriting the position as a row count.
	 */
	readonly nodes?: number;
	/**
	 * Seed mode only: whether the whole-repo `child_pos += REORDER_OFFSET`
	 * shift has already run. It is NOT idempotent (a second pass reaches
	 * 2×OFFSET and trips `CHECK (child_pos < 2000000)`), so a resume must be
	 * able to tell. Written in the same transaction as the shift itself, which
	 * is what keeps the flag and the rows in agreement.
	 */
	readonly phase1Done: boolean;
}

/** The lifecycle record stored at {@link IMPORT_STATE_KEY}. */
export interface OrphanImportState {
	/** Absent on rows written before this module existed — read as `"done"`. */
	readonly state?: "running" | "done" | "failed";
	readonly startedAt?: number;
	readonly heartbeatAt?: number;
	readonly pid?: number;
	readonly done?: number;
	readonly total?: number;
	readonly cursor?: ImportCursor;
	/** `state: "failed"` only. */
	readonly error?: string;
	/** `state: "done"` only — the historical completion receipt, unchanged. */
	readonly at?: number;
	readonly nodes?: number;
	readonly updated?: number;
	readonly [extra: string]: unknown;
}

/**
 * Fingerprints an ordering of commit hashes.
 *
 * Deliberately the ORDERED HASH LIST and not the orphan tip: a tip moves for
 * reasons that do not touch the memory set at all (a plan edit, a note), and
 * invalidating a cursor for those would make a long import on an active repo
 * unable to ever finish. Order-sensitive, because `nextIndex` indexes into it.
 */
export function cursorFingerprint(ordered: ReadonlyArray<string>): string {
	return createHash("sha256").update(ordered.join("\n")).digest("hex");
}

/**
 * Writes the record. Caller supplies the transaction: for the cursor this is
 * mandatory (it must commit with the rows it certifies), and for the lifecycle
 * fields it is what makes a `running` record visible to a concurrent reader
 * mid-run.
 */
export function writeImportState(db: DashboardDbHandle, repoId: number, state: OrphanImportState): void {
	db.prepare(
		`INSERT INTO repo_state (repo_id, key, value) VALUES (?, ?, ?)
		 ON CONFLICT(repo_id, key) DO UPDATE SET value = excluded.value`,
	).run(repoId, IMPORT_STATE_KEY, JSON.stringify(state));
}

/** Reads the record for `repoId` on an already-open handle. */
export function readImportStateRow(db: DashboardDbHandle, repoId: number): OrphanImportState | null {
	const row = db
		.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = ?")
		.get(repoId, IMPORT_STATE_KEY) as { value: string } | undefined;
	if (!row) return null;
	try {
		return JSON.parse(row.value) as OrphanImportState;
	} catch {
		// A corrupt value is "cannot tell", never "never migrated": the caller
		// would otherwise advise a re-run that is not needed.
		return null;
	}
}

/**
 * What the database said, with "no record" and "cannot ask" kept distinct —
 * the same discipline (and the same case list) as `CutoverRouter.readCutoverRow`.
 * Collapsing them would report an unreadable database as a repo that has never
 * migrated, which reads as data loss.
 */
export type ImportStateAnswer =
	| { readonly kind: "record"; readonly state: OrphanImportState }
	| { readonly kind: "none" }
	| { readonly kind: "unavailable"; readonly reason: string };

/** Read-only, degradation-safe lookup for a surface that only wants to report. */
export async function readImportState(
	cwd: string,
	opts: { readonly dbPath?: string } = {},
): Promise<ImportStateAnswer> {
	if (!canUseDashboardDb()) {
		return { kind: "unavailable", reason: `Node ${process.versions.node} lacks flag-free node:sqlite` };
	}
	const dbPath = opts.dbPath ?? getDashboardDbPath();
	const fileState = classifyDbFiles(dbPath);
	if (fileState === "alarm-sidecars-only") {
		return { kind: "unavailable", reason: "database file missing but WAL/SHM remain — run jolli doctor --recover" };
	}
	// No database file is "never migrated", not "cannot ask": the answer is
	// certain, and it is the one the user can act on. (CutoverRouter treats the
	// same state as unavailable because there a missing file must not be read as
	// "this repo never cut over" — a different question with a different cost.)
	if (fileState === "absent") return { kind: "none" };
	try {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			// NO version or compatibility check, deliberately: this row is plain JSON
			// in `repo_state` and a newer format does not make it unreadable. Reporting
			// `unavailable` over a version number hid a migration verdict the user can
			// act on. See the compatibility note above `DASHBOARD_SCHEMA_VERSION`.
			const { identity } = await resolveRepoIdentityForCwd(cwd);
			const repo = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
				| { id: number }
				| undefined;
			if (!repo) return { kind: "none" };
			const row = db
				.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = ?")
				.get(repo.id, IMPORT_STATE_KEY) as { value: string } | undefined;
			if (!row) return { kind: "none" };
			return { kind: "record", state: JSON.parse(row.value) as OrphanImportState };
		} finally {
			db.close();
		}
	} catch (err) {
		log.debug("import state unreadable for %s: %s", cwd, errMsg(err));
		return { kind: "unavailable", reason: errMsg(err) };
	}
}

/** `2h ago` / `3d ago` — coarse on purpose; the exact stamp helps nobody here. */
function agoLabel(fromMs: number, nowMs: number): string {
	const mins = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/**
 * One user-facing line for `jolli status`.
 *
 * The liveness rule is three-state, and the middle state is the whole point:
 * a live pid whose heartbeat has gone stale reports "migrating, no progress
 * for Nm" rather than "interrupted". Requiring BOTH a live pid and a fresh
 * heartbeat would call a healthy long-running import dead — the import reads
 * thousands of git objects and the index-missing fallback reads them in one
 * un-instrumented span, so a quiet stretch is normal. Only a dead pid is
 * evidence of interruption.
 */
export function describeImportState(answer: ImportStateAnswer, nowMs: number = Date.now()): string {
	if (answer.kind === "unavailable") return `Unavailable (${answer.reason})`;
	if (answer.kind === "none") return "Not migrated — run `jolli dashboard`";
	const s = answer.state;
	// No `state` field means a pre-lifecycle row, which was only ever written on
	// success. Reading it as anything but "done" would tell a migrated repo to
	// migrate again.
	const state = s.state ?? "done";
	const progress = s.total ? `${s.done ?? 0}/${s.total}` : `${s.done ?? 0}`;
	if (state === "done") {
		const count = s.nodes ?? 0;
		const when = s.at ? `, ${agoLabel(s.at, nowMs)}` : "";
		return `Migrated (${count} ${count === 1 ? "memory" : "memories"}${when})`;
	}
	if (state === "failed") {
		return `Failed at ${progress} — ${s.error ?? "unknown error"} (run \`jolli dashboard\` to retry)`;
	}
	const alive = s.pid !== undefined && isPidAlive(String(s.pid));
	if (!alive) return `Interrupted at ${progress} — run \`jolli dashboard\` to resume`;
	const stale = s.heartbeatAt !== undefined && nowMs - s.heartbeatAt >= IMPORT_STALE_MS;
	const quiet = stale ? `, no progress for ${agoLabel(s.heartbeatAt as number, nowMs).replace(" ago", "")}` : "";
	return `Migrating — ${progress} memories${quiet} (pid ${s.pid})`;
}
