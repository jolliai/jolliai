/**
 * Backfill — one-time bootstrap and post-restart gap recovery for the
 * dashboard database.
 *
 * Both run in a command process (`jolli dashboard`, `jolli enable`) — never in
 * the read-only HTTP service — and both feed the same `StatsWriter`, so an
 * imported fact and a live-written fact are indistinguishable in the DB.
 *
 * ## Correctness model (why cursors are not the mechanism)
 *
 * A high-water cursor only works for append-only, monotonically increasing
 * data. Git history is not that: rebase/squash rewrite it, branches get
 * deleted, and sessions update out of order. So the backbone is:
 *
 *   - adds/changes  → idempotent UPSERT (deterministic event ids)
 *   - deletes       → set reconciliation: prune rows not in the currently
 *                     reachable set (FK CASCADE removes children)
 *   - cursors       → a fast path ONLY: "HEAD unchanged → skip collection".
 *
 * A conservative cursor that re-scans too much is harmless (idempotent); a
 * cursor that skips too much is impossible because it is only consulted for
 * the skip decision, never as the sole selector of what to import.
 */

import { createHash } from "node:crypto";
import { execGit, getHeadHash } from "../core/GitOps.js";
import { GitRefStorage, resolveCommittish } from "../core/GitRefStorage.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import { getIndex } from "../core/SummaryStore.js";
import { createLogger, errMsg, ORPHAN_BRANCH } from "../Logger.js";
import {
	collectCommitEvents,
	// collectRepoGraph,  // parked with `repo_graphs` — see SotSchema
	collectSessionEvents,
	collectSummaryEvents,
	collectWorktreeEvent,
	type SessionLoader,
} from "./DashboardCollector.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { inTransaction, withDashboardDb } from "./DashboardDb.js";
import type { CommitCreatedEvent, ProducerKind, StatsEvent, StatsEventEnvelope } from "./DashboardModel.js";
import { existingWorktrees, type RegisteredRepo, readRepoCutoverFence } from "./RepoRegistry.js";
import {
	countMemoriesAbsentFromListing,
	EMPTY_IMPORT_RESULT,
	hasCutoverRecord,
	importRepoMemory,
	resolveProtectNewerThanMs,
	type SotImportResult,
} from "./SotImport.js";
import { applyToDb } from "./StatsWriter.js"; // recordRepoGraph parked — see SotSchema

const log = createLogger("Backfill");

/**
 * Events per write transaction. Small on purpose: every batch takes SQLite's
 * single writer lock, and a hook or the extension tick may be waiting on it —
 * a whole-import transaction would starve them for the length of the import.
 */
const BATCH_SIZE = 200;

/** `ingest_cursors.source` keys. */
const CURSOR_GIT = "git-commits";
const CURSOR_SESSIONS = "sessions";
const CURSOR_SUMMARIES = "summaries";
const CURSOR_SOT = "sot-import";

/**
 * Content fingerprint of the summary index — the summaries cursor value.
 *
 * The orphan-branch index is small and rewritten wholesale on every store, so
 * "did anything change" is exactly "did its JSON change". A hash rather than a
 * tip commit because FolderStorage-backed repos have no orphan tip to point at.
 * Returns null when there is no index (nothing to sweep).
 */
async function summaryIndexFingerprint(cwd: string, storage: StorageProvider): Promise<string | null> {
	const index = await getIndex(cwd, storage).catch(() => null);
	if (!index) return null;
	return createHash("sha256").update(JSON.stringify(index)).digest("hex");
}

/**
 * Change signal for one checkout — its HEAD plus every local branch tip.
 *
 * HEAD alone is not enough, and the difference is not academic: deleting a
 * branch, rebasing it, or committing to it from another worktree moves no HEAD
 * that this pass can see. A HEAD-only cursor calls that "unchanged" and skips
 * the sweep entirely, so commits that are no longer reachable stay in the DB
 * (prune never runs) and branch reachability keeps whatever it was told last —
 * both indefinitely, until the checked-out branch happens to move for an
 * unrelated reason. Branch tips cover all three cases for one extra
 * `for-each-ref` per checkout.
 *
 * The tips are hashed rather than listed: a repo with hundreds of branches would
 * otherwise write a cursor value of unbounded length. HEAD stays in the clear as
 * the readable part of the value.
 *
 * A `for-each-ref` failure degrades to HEAD alone — a cursor that is too
 * conservative only costs an extra sweep, which is idempotent (see the module
 * header), whereas one that is too eager loses data.
 */
async function checkoutFingerprint(path: string): Promise<string | null> {
	const head = await getHeadHash(path).catch((err) => {
		log.warn("HEAD unreadable for %s: %s", path, errMsg(err));
		return null;
	});
	if (!head) return null;
	const refs = await execGit(["for-each-ref", "refs/heads", "--format=%(refname) %(objectname)"], path);
	if (refs.exitCode !== 0) {
		log.debug("branch tips unreadable for %s: %s", path, refs.stderr.trim());
		return head;
	}
	return `${head}+${createHash("sha256").update(refs.stdout).digest("hex")}`;
}

export interface BackfillOptions {
	readonly repo: RegisteredRepo;
	/** Test seam: path override for the dashboard DB. */
	readonly dbPath?: string;
	readonly producerKind?: ProducerKind;
	readonly now?: () => number;
	/** Test seams, forwarded to the collector. */
	readonly loadSessions?: SessionLoader;
	/** Test seam: read source for the SOT import; defaults to the orphan branch. */
	readonly storage?: StorageProvider;
	/**
	 * Progress for one repo. `memories` events come from the SOT import and are
	 * fired one per memory, inside its batch transaction — see
	 * {@link SotImportOptions.onProgress} for why the callback must not touch
	 * the database.
	 */
	readonly onProgress?: (progress: RepoProgress) => void;
}

/**
 * What a backfill is working through right now, for one repo.
 *
 * `done: 0` is a **phase-start marker**, emitted BEFORE the work begins. That
 * is the only kind of event the slow phases can offer: measured on a two-repo
 * machine, collecting git history took 22 s and 11 s while the memory
 * migration it precedes took about a second each. An event that fires when a
 * phase finishes cannot break the silence during it.
 */
export interface RepoProgress {
	readonly repoName: string;
	readonly kind: "commits" | "summaries" | "memories" | "sessions";
	readonly done: number;
	/** Absent on phase-start markers, and on a `memories` pass with no readable `index.json`. */
	readonly total?: number;
	/**
	 * Qualifier for a phase-start marker, e.g. which checkout is being scanned.
	 * A repo with two checkouts spends the git scan twice, and without this the
	 * two are one motionless line.
	 */
	readonly detail?: string;
}

/** {@link RepoProgress} plus the repo's place in a multi-repo run. */
export interface BackfillProgress extends RepoProgress {
	/** 1-based. */
	readonly repoIndex: number;
	readonly repoTotal: number;
}

export interface BackfillResult {
	/** 'bootstrapped' = full import ran; 'recovered' = incremental pass; 'skipped' = the repo errored out. */
	readonly mode: "bootstrapped" | "recovered" | "skipped";
	readonly eventsApplied: number;
	/** Row counts from the v7 SOT import; absent when the repo was skipped. */
	readonly sotImport?: SotImportResult;
	/** Present on every result, so a caller can name the repo in its output. */
	readonly repoName: string;
	/**
	 * Why this repo was skipped. Set only on `mode: "skipped"` — the failure
	 * used to reach `log.error` and nothing else, which made a repo that failed
	 * to import indistinguishable, on screen, from one that had nothing to do.
	 */
	readonly error?: string;
}

/** Reads one repo's bootstrap state, defaulting to 'pending' for an unknown repo. */
function readBootstrapState(db: DashboardDbHandle, repoIdentity: string): string {
	const row = db.prepare("SELECT bootstrap_state FROM repos WHERE repo_identity = ?").get(repoIdentity) as
		| { bootstrap_state?: string }
		| undefined;
	return row?.bootstrap_state ?? "pending";
}

function readCursor(db: DashboardDbHandle, repoIdentity: string, source: string): string | undefined {
	const row = db
		.prepare(
			`SELECT c.cursor FROM ingest_cursors c JOIN repos r ON r.id = c.repo_id
			  WHERE r.repo_identity = ? AND c.source = ?`,
		)
		.get(repoIdentity, source) as { cursor?: string } | undefined;
	return row?.cursor;
}

function writeCursor(db: DashboardDbHandle, repoIdentity: string, source: string, cursor: string, nowMs: number): void {
	db.prepare(
		`INSERT INTO ingest_cursors (repo_id, source, cursor, updated_at_ms)
		 VALUES ((SELECT id FROM repos WHERE repo_identity = ?), ?, ?, ?)
		 ON CONFLICT(repo_id, source) DO UPDATE SET cursor = excluded.cursor, updated_at_ms = excluded.updated_at_ms`,
	).run(repoIdentity, source, cursor, nowMs);
}

/**
 * Prunes commit rows that are no longer reachable from any tracked ref — the
 * delete half of set reconciliation, run whenever a full commit collection has
 * the complete reachable set in hand. FK CASCADE removes branch links and
 * session links with the row.
 */
export function pruneUnreachableCommits(
	db: DashboardDbHandle,
	repoIdentity: string,
	reachable: ReadonlySet<string>,
): number {
	const rows = db
		.prepare("SELECT c.hash FROM commits c JOIN repos r ON r.id = c.repo_id WHERE r.repo_identity = ?")
		.all(repoIdentity) as ReadonlyArray<{
		hash: string;
	}>;
	const stale = rows.filter((r) => !reachable.has(r.hash));
	if (stale.length === 0) return 0;
	const remove = db.prepare(
		"DELETE FROM commits WHERE repo_id = (SELECT id FROM repos WHERE repo_identity = ?) AND hash = ?",
	);
	inTransaction(db, () => {
		for (const row of stale) remove.run(repoIdentity, row.hash);
	});
	log.info("pruned %d unreachable commits for %s", stale.length, repoIdentity);
	return stale.length;
}

/** Wraps events in envelopes and applies them in small batches. */
function applyBatches(
	db: DashboardDbHandle,
	events: ReadonlyArray<StatsEvent>,
	producerKind: ProducerKind,
	now: () => number,
	onChunk?: (done: number, total: number) => void,
): number {
	let applied = 0;
	for (let start = 0; start < events.length; start += BATCH_SIZE) {
		const batch: StatsEventEnvelope[] = events
			.slice(start, start + BATCH_SIZE)
			.map((event) => ({ event, producerKind }));
		const result = applyToDb(db, batch, { producerKind, now });
		applied += result.projected;
		onChunk?.(Math.min(start + BATCH_SIZE, events.length), events.length);
	}
	return applied;
}

/** The `repo.enabled` projection for a registry entry. */
function repoEnabledEvent(repo: RegisteredRepo): StatsEvent {
	return {
		type: "repo.enabled",
		repoIdentity: repo.repoIdentity,
		repoName: repo.repoName,
		worktreeRoot: repo.worktreeRoot,
		...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
		enabledAt: repo.enabledAt,
	};
}

/**
 * Projects ONE repo's registry state — enabled or disabled — and nothing else.
 *
 * The registry (`repos.json`) and the `repos` table are two stores, and only
 * the projection makes the second agree with the first. Every read surface
 * filters on `repos.disabled_at IS NULL`, so a registry write that is never
 * projected is invisible in both directions: an enabled repo whose row does not
 * exist has no memories, no KPIs and no page (every gated route redirects), and
 * a disabled repo whose `disabled_at` is still NULL keeps counting in every KPI
 * and picker. `jolli enable` gets the projection for free from the full
 * backfill it runs; a long-lived server mutating the registry over HTTP does
 * not, and that is exactly the caller this exists for.
 *
 * Cheap by construction — two rows, no git, no import — so it is safe to await
 * inside a request handler before answering. The heavier memory import stays
 * `backfillRepo`'s job.
 */
export function projectRepoRegistryState(
	db: DashboardDbHandle,
	repo: RegisteredRepo,
	opts: { readonly now?: () => number } = {},
): void {
	const event: StatsEvent = repo.disabledAt
		? { type: "repo.disabled", repoIdentity: repo.repoIdentity, disabledAt: repo.disabledAt }
		: repoEnabledEvent(repo);
	applyBatches(db, [event], "bootstrap", opts.now ?? Date.now);
}

/**
 * Ensures one repo's data is present and current: a full bootstrap when it has
 * never completed, an incremental recovery otherwise. Idempotent and resumable
 * — a crash mid-import leaves `bootstrap_state = 'in-progress'`, and the next
 * run simply collects and applies again (UPSERTs make the redo harmless).
 */
export async function backfillRepo(opts: BackfillOptions): Promise<BackfillResult> {
	const now = opts.now ?? Date.now;
	const producerKind = opts.producerKind ?? "bootstrap";
	const repo = opts.repo;
	// Every checkout of this project that still exists, newest first. Identity is
	// the normalized remote, so two clones share one entry — sweeping only
	// `worktreeRoot` would silently ignore the other one's commits and branches.
	const worktrees = existingWorktrees(repo);
	// The newest checkout is "the" repo for anything that must pick one: HEAD-based
	// cursors, the summary index (dual-written per repo, so identical in each
	// clone), sessions (recorded per project, not per checkout) and the knowledge
	// graph.
	const cwd = worktrees[0];

	// Read before opening the DB: `withDashboardDb` closes its handle in a
	// `finally`, which for an async callback runs before the awaits inside it
	// resolve — so an async read placed inside the callback would come back to an
	// already-closed handle.
	// PARKED with `repo_graphs` (see SotSchema): nothing reads the artifact since
	// the graph page was removed, and collecting it reads graph.json off disk.
	// const knowledgeGraph = await collectRepoGraph(cwd);

	// One provider shared by the summary sweep and the SOT import, PINNED to the
	// orphan tip resolved right here. Reading by branch name instead is a race:
	// a writer advancing the branch mid-import makes the run see a mixture of
	// two versions, and a seed-mode reconciliation would then prune rows for
	// paths that merely do not exist at the older tip it listed. One provider
	// (rather than per-read fallback inside SummaryStore) also keeps a repo with
	// hundreds of summaries from burying the output in identical warnings.
	// `--storage` (tests) overrides it.
	const orphanTip = opts.storage ? null : await resolveCommittish(ORPHAN_BRANCH, cwd);
	const orphanStorage = opts.storage ?? (orphanTip ? new GitRefStorage(orphanTip, cwd) : null);

	// Once this repo is fenced for cutover, new memories land in SQLite only —
	// the orphan branch stops moving. Read before opening the DB, so the async
	// call cannot sit inside the handle's lifetime.
	//
	// Asked of EVERY checkout rather than of `cwd`, which is only the newest —
	// see `readRepoCutoverFence`. The `sotMode` decision below has database-side
	// witnesses to fall back on, but `protectNewerThanMs` has none: a fence
	// missed here silently turns the import into an unprotected one, and
	// catch-up does not skip a stale body, it writes it over the fresh one.
	const fence = await readRepoCutoverFence(repo);

	return withDashboardDb(
		async (db) => {
			// Project the registry entry first so FK targets exist with real names.
			let applied = applyBatches(db, [repoEnabledEvent(repo)], producerKind, now);

			// After the repo row (FK target), and idempotent on the artifact's own
			// build stamp — so every recovery pass can offer it unconditionally and
			// an unchanged graph.json costs one comparison.
			// if (knowledgeGraph) recordRepoGraph(db, repo.repoIdentity, knowledgeGraph);

			const state = readBootstrapState(db, repo.repoIdentity);
			const isBootstrap = state !== "done";

			// Fast path: nothing moved since the last pass. Sessions and worktree
			// state are cheap enough to always re-project, so only the expensive git
			// sweep is gated.
			// The cursor must cover EVERY checkout, not just the primary one: commits
			// landing in the second clone move only its HEAD, and a cursor built from
			// the primary alone would report "unchanged" and skip them entirely.
			// No phase marker here: the fingerprint sweep below is sub-second, and
			// the per-checkout markers inside the collection loop are the ones that
			// matter. Emitting one here too printed the same label twice.
			const fingerprints: string[] = [];
			for (const path of worktrees) {
				const fingerprint = await checkoutFingerprint(path);
				if (fingerprint) fingerprints.push(`${path}@${fingerprint}`);
			}
			const gitCursor = fingerprints.length > 0 ? fingerprints.sort().join(" ") : null;
			const commitCursor = readCursor(db, repo.repoIdentity, CURSOR_GIT);
			const commitsUnchanged = !isBootstrap && gitCursor !== null && commitCursor === gitCursor;

			if (isBootstrap) {
				db.prepare("UPDATE repos SET bootstrap_state = 'in-progress' WHERE repo_identity = ?").run(
					repo.repoIdentity,
				);
			}

			if (!commitsUnchanged) {
				// Collect from EVERY checkout, then MERGE before writing. Merging is not
				// an optimisation: `commit.created` treats `branches` as authoritative
				// and replaces the stored set (that is how a deleted branch is pruned),
				// so applying each checkout's events in turn would leave the last sweep's
				// branch set as the only one — silently wiping branch names that only the
				// other clone knows. Observed on a two-clone repo: 7 of 26 branches
				// unique to the second checkout vanished that way.
				const merged = new Map<string, CommitCreatedEvent>();
				// A checkout whose `git log` failed contributes nothing, which is
				// indistinguishable from "this checkout reaches no commits" once the events
				// are merged. Prune and the cursor advance are therefore both gated on a
				// COMPLETE union; an incomplete one may only ADD rows.
				let collectionComplete = true;
				for (const [i, worktree] of worktrees.entries()) {
					// Per checkout, because each one pays its own `git log --numstat`
					// — measured 6-12 s apiece, and it is a single opaque subprocess
					// with nothing to report from inside it.
					opts.onProgress?.({
						repoName: repo.repoName,
						kind: "commits",
						done: 0,
						...(worktrees.length > 1 ? { detail: `checkout ${i + 1} of ${worktrees.length}` } : {}),
					});
					let events: ReadonlyArray<CommitCreatedEvent>;
					try {
						events = await collectCommitEvents({ repoIdentity: repo.repoIdentity, cwd: worktree });
					} catch (err) {
						// Not fatal for the repo: sessions and memories still import, and the
						// commits already stored stay stored. Only this pass's destructive half
						// is forfeited.
						collectionComplete = false;
						log.warn("commit collection failed for %s: %s", worktree, errMsg(err));
						continue;
					}
					for (const event of events) {
						const seen = merged.get(event.hash);
						if (!seen) {
							merged.set(event.hash, event);
							continue;
						}
						// Union the reachability; keep the first checkout's metadata, which
						// is identical for a given hash apart from `branches`.
						merged.set(event.hash, {
							...seen,
							branches: [...new Set([...(seen.branches ?? []), ...(event.branches ?? [])])],
						});
					}
				}
				const commitEvents = [...merged.values()];
				applied += applyBatches(db, commitEvents, producerKind, now, (done, total) =>
					opts.onProgress?.({ repoName: repo.repoName, kind: "commits", done, total }),
				);
				if (collectionComplete) {
					const reachable = new Set(commitEvents.map((e) => e.hash));
					// Prune against the UNION: pruning per worktree would delete commits that
					// only the other checkout can reach, and the next pass would re-add them —
					// a delete/insert cycle on every run.
					pruneUnreachableCommits(db, repo.repoIdentity, reachable);
					// The cursor rides with the prune, not with the upserts: it is derived from
					// HEAD plus the ref list, which can resolve fine while `git log` fails, and
					// advancing it on an incomplete pass makes the NEXT pass skip collection
					// altogether — turning a transient read failure into a permanent blank.
					if (gitCursor) writeCursor(db, repo.repoIdentity, CURSOR_GIT, gitCursor, now());
				} else {
					log.warn(
						"skipping commit prune and cursor advance for %s -- at least one checkout could not be read",
						repo.repoName,
					);
				}
			}

			// Summaries (memory tier): the index is small and rewritten wholesale,
			// so its content hash is the whole change signal — unchanged means no
			// summary was added, merged or migrated since the last pass. On change,
			// the sweep is a full re-read: summaries are consolidated (squash/amend
			// fold children into new roots), so per-entry cursors cannot work, and
			// idempotent UPSERTs make the redo harmless.
			const indexFingerprint = orphanStorage ? await summaryIndexFingerprint(cwd, orphanStorage) : null;
			const summariesCursor = readCursor(db, repo.repoIdentity, CURSOR_SUMMARIES);
			if (orphanStorage && indexFingerprint && (isBootstrap || summariesCursor !== indexFingerprint)) {
				// INSIDE the gate. The marker used to fire unconditionally, which made
				// "Indexing stored memories…" appear on every launch for a phase that
				// then did nothing — and a phase marker is the caller's evidence that
				// there is work worth narrating.
				opts.onProgress?.({ repoName: repo.repoName, kind: "summaries", done: 0 });
				const summaryEvents = await collectSummaryEvents({
					repoIdentity: repo.repoIdentity,
					cwd,
					storage: orphanStorage,
				});
				applied += applyBatches(db, summaryEvents, producerKind, now);
				writeCursor(db, repo.repoIdentity, CURSOR_SUMMARIES, indexFingerprint, now());
			}

			// Sessions: always re-project the currently discoverable set. A global
			// max-updatedAt cursor would miss an old session updated out of order,
			// so the cursor only records progress for observability — it is never
			// used to skip.
			opts.onProgress?.({ repoName: repo.repoName, kind: "sessions", done: 0 });
			const sessionEvents = await collectSessionEvents({
				repoIdentity: repo.repoIdentity,
				cwd,
				...(opts.loadSessions ? { loadSessions: opts.loadSessions } : {}),
			});
			applied += applyBatches(db, sessionEvents, producerKind, now, (done, total) =>
				opts.onProgress?.({ repoName: repo.repoName, kind: "sessions", done, total }),
			);
			const maxUpdated = sessionEvents.reduce((max, e) => Math.max(max, e.updatedAtMs), 0);
			if (maxUpdated > 0) writeCursor(db, repo.repoIdentity, CURSOR_SESSIONS, String(maxUpdated), now());

			// Worktree: transient, recomputed every pass — from the PRIMARY checkout
			// only. `worktree_status` is keyed `(repo_id, branch_key)`, so two
			// checkouts sitting on the same branch would silently overwrite each
			// other's dirty state, last writer winning. Reporting one checkout
			// truthfully beats reporting an arbitrary one of two. Per-checkout dirty
			// state needs the worktree path in that primary key — a schema change, and
			// deliberately not smuggled into a defect fix.
			const worktree = await collectWorktreeEvent(repo.repoIdentity, cwd, now);
			if (worktree) applied += applyBatches(db, [worktree], producerKind, now);

			// SOT tables (v7): the orphan branch imported verbatim into
			// memory_nodes/revisions, transcripts, docs, plan_progress and the topic
			// KB. Independent of the event pipeline above — the importer writes base
			// tables directly (a bulk load is not a producer event) and is keyed on
			// business identity, so it converges on every re-run.
			//
			// Gated on the ORPHAN TIP, not on the summary index. The index fingerprint
			// cannot serve here — docs and topics change without `index.json` moving —
			// but the tip commit is a hash of the whole tree this importer reads
			// (summaries, transcripts, plans, notes, references, skills, topics AND the
			// index), so an unchanged tip means every input byte is unchanged. Cheap
			// too: it was already resolved above to pin the provider.
			//
			// Convergence is not a reason to re-run it. A converged seed pass still
			// rewrites the whole repo: phase 1 shifts every child_pos, the settle
			// re-upserts every row, and `writeTopics`/`writeLinks` DELETE and re-INSERT
			// unconditionally — measured on this repo, 2967 topic rows and 2908 link
			// rows rewritten by a pass that reported `updated: 0`, for 4.6 s of every
			// `jolli dashboard`. Catch-up costs less (it returns early on identical
			// content) but still re-reads every summary body off the branch.
			// `seed` while the orphan branch is still the source of truth, so a file
			// gone from the branch means the memory is gone and the row must follow.
			// Once fenced, new memories exist ONLY in SQLite — indistinguishable from
			// "deleted" to a reconciliation pass reading the (now-frozen) branch — so
			// this flips to `catch-up`, which never deletes.
			// No orphan tip means nothing to import FROM — and, deliberately, nothing
			// to prune either. A missing branch is either a repo that never had
			// memories (nothing to do) or a branch deletion, and destroying the
			// database's rows because a branch vanished would make an accident
			// permanent. Skipping is the recoverable choice.
			// A fenced repo's tip is frozen at the fence time, so everything the
			// database stamped after it outranks this source.
			//
			// The CAS's own `committedAt` is the fallback, exactly as in
			// `CutoverEngine`'s drift import: a fence that is absent OR carries an
			// unparsable stamp would otherwise leave `protectNewerThanMs` off, and an
			// unprotected catch-up does not skip a stale body — it writes it over the
			// fresh one. The mode decision below has its own witnesses; this one had
			// none.
			const protectMs = resolveProtectNewerThanMs(db, repo.repoIdentity, fence?.atMs);
			// `seed` reconciles: a memory the READ SOURCE no longer lists is deleted. That
			// source is ONE checkout's orphan branch (`cwd` = the newest surviving one),
			// while `repo_id` is shared by every clone of the identity — so with two clones
			// whose branches differ, a seed pass deletes the memories only the OTHER clone
			// has. The commit tier avoids this by merging every checkout before pruning;
			// the importer reads a single pinned provider and cannot, so multi-checkout
			// repos drop to the never-deleting mode instead. A genuinely removed memory
			// then lingers until a single-checkout pass, which is the same trade the
			// missing-branch case below already makes: a stale row beats a permanent
			// deletion nobody asked for.
			const multiCheckout = worktrees.length > 1;
			if (multiCheckout && !fence) {
				log.info(
					"%s has %d checkouts -- importing memories in catch-up mode (no reconciliation)",
					repo.repoName,
					worktrees.length,
				);
			}
			// The fence is NOT sufficient evidence on its own, and this sweep runs on
			// every `jolli dashboard` — so it is the path where losing that evidence
			// hurts. `readCutoverFence` fails open, and `profile.json` is per-project
			// gitignored state that `git clean -xdf` removes. On a cut-over repo that
			// alone flips this decision back to `seed`, whose reconciliation then
			// deletes every memory written since the fence — permanently, because the
			// branch it reconciles against is frozen and will never list them.
			//
			// So ask the database too, exactly as the cutover CAS does before it
			// picks the same mode. Two witnesses, both cheap, both able only to
			// REFUSE the prune: the recorded cutover (which survives the deletion of
			// `.jolli/`, since it lives in the machine-global DB), and a count of
			// stored memories the pinned tip does not list (which also covers a
			// pre-cutover writer that landed rows the branch never saw).
			let seedLegal = !fence && !multiCheckout;
			if (seedLegal && orphanStorage) {
				if (hasCutoverRecord(db, repo.repoIdentity)) {
					log.warn(
						"%s has a recorded cutover but no fence on disk (profile.json wiped?) -- importing in catch-up mode; seeding would delete every memory written since the cutover",
						repo.repoName,
					);
					seedLegal = false;
				} else {
					const listed = new Set(
						(await orphanStorage.listFiles("summaries/"))
							.filter((p) => p.endsWith(".json"))
							.map((p) => p.slice("summaries/".length, -".json".length)),
					);
					// No try/catch: a throw here aborts this repo's pass, which is the
					// fail-closed outcome — the alternative is treating an unreadable
					// listing as "the branch lists nothing", i.e. prune everything.
					const unlisted = countMemoriesAbsentFromListing(db, repo.repoIdentity, listed);
					if (unlisted > 0) {
						log.warn(
							"%d of %s's stored memor%s absent from the orphan tip -- importing in catch-up mode; seeding would delete %s",
							unlisted,
							repo.repoName,
							unlisted === 1 ? "y is" : "ies are",
							unlisted === 1 ? "it" : "them",
						);
						seedLegal = false;
					}
				}
			}
			const sotMode = seedLegal ? "seed" : "catch-up";
			// The mode rides in the cursor: a repo that gains a second checkout (or a
			// fence) switches to catch-up with the tip standing still, and the two
			// modes do not write the same rows — catch-up never deletes. A tip-only
			// cursor would skip that first differing pass.
			// `--storage` (tests) has no tip and is deliberately ungated: the seam
			// exists to feed the importer arbitrary content, which by definition does
			// not move a commit hash.
			const sotCursor = orphanTip ? `${orphanTip}#${sotMode}` : null;
			// `!isBootstrap` for the same reason the commit tier carries it: a repo
			// whose bootstrap never completed may hold a cursor from a previous
			// database generation, and re-importing costs a pass while trusting it
			// costs the repo's memories.
			const sotUnchanged =
				!isBootstrap && sotCursor !== null && readCursor(db, repo.repoIdentity, CURSOR_SOT) === sotCursor;
			const sotImport = orphanStorage
				? sotUnchanged
					? // Nothing to do, and nothing worth printing — but the caller still
						// reports a memory count, so answer it from the database rather
						// than with the zero an absent result would produce ("Migrated 0
						// memories" on a healthy repo reads as data loss).
						{
							...EMPTY_IMPORT_RESULT,
							nodes: (
								db
									.prepare(
										`SELECT COUNT(*) AS n FROM memories
										  WHERE repo_id = (SELECT id FROM repos WHERE repo_identity = ?)`,
									)
									.get(repo.repoIdentity) as { n: number }
							).n,
						}
					: await importRepoMemory(db, {
							repo,
							nowMs: now(),
							storage: orphanStorage,
							mode: sotMode,
							...(protectMs !== undefined ? { protectNewerThanMs: protectMs } : {}),
							...(opts.onProgress
								? {
										onProgress: (p) =>
											opts.onProgress?.({
												repoName: repo.repoName,
												kind: "memories",
												done: p.done,
												...(p.total !== undefined ? { total: p.total } : {}),
											}),
									}
								: {}),
						})
				: undefined;
			// AFTER the import returned, never before: `importRepoMemory` resumes from
			// its own per-batch cursor, and a run killed halfway leaves rows the next
			// pass must still write. Advancing on entry would call that partial state
			// "current" and freeze it until the branch happened to move again.
			if (sotCursor && sotImport && !sotUnchanged) {
				writeCursor(db, repo.repoIdentity, CURSOR_SOT, sotCursor, now());
			}

			db.prepare("UPDATE repos SET bootstrap_state = 'done', last_ingested_at = ? WHERE repo_identity = ?").run(
				new Date(now()).toISOString(),
				repo.repoIdentity,
			);

			const mode = isBootstrap ? "bootstrapped" : "recovered";
			log.info("%s %s: %d events applied", mode, repo.repoName, applied);
			return { mode, eventsApplied: applied, sotImport, repoName: repo.repoName } as BackfillResult;
		},
		{ dbPath: opts.dbPath },
	);
}

/**
 * Backfills every repo in the list, independently — one broken repo (deleted
 * worktree, git failure) must not stop the others from importing.
 */
export async function backfillRepos(
	repos: ReadonlyArray<RegisteredRepo>,
	opts: Omit<BackfillOptions, "repo" | "onProgress"> & {
		/** Same events as the per-repo callback, plus where this repo sits in the run. */
		readonly onProgress?: (progress: BackfillProgress) => void;
	},
): Promise<ReadonlyArray<BackfillResult>> {
	// Pulled out of the spread: the two callbacks have different shapes, and
	// letting the wide one ride along on `...rest` would hand `backfillRepo` a
	// function expecting fields it never supplies.
	const { onProgress: forward, ...rest } = opts;
	const results: BackfillResult[] = [];
	for (const [i, repo] of repos.entries()) {
		// The index is injected here rather than passed down, so `backfillRepo`
		// stays ignorant of the list it happens to be in.
		const perRepo = forward
			? { onProgress: (p: RepoProgress) => forward({ ...p, repoIndex: i + 1, repoTotal: repos.length }) }
			: {};
		try {
			results.push(await backfillRepo({ ...rest, ...perRepo, repo }));
		} catch (err) {
			log.error("backfill failed for %s: %s", repo.repoName, errMsg(err));
			// Carried on the result, not just logged: the caller is the only thing
			// with a terminal, and a repo that failed to import must not look
			// identical to one that had nothing to do.
			results.push({ mode: "skipped", eventsApplied: 0, repoName: repo.repoName, error: errMsg(err) });
		}
	}
	return results;
}
