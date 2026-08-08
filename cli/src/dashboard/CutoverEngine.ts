/**
 * CutoverEngine — the critical section that makes SQLite the source of truth.
 *
 * The protocol's shape is fixed by one failure path: a long-started worker
 * holds its storage object, writes orphan AFTER the compare passed, and the
 * cutover state lands right after — that memory never reaches the database
 * and nobody notices. The fix is NOT a long critical section ("take the lock,
 * re-import and compare inside it"): the worker's lock budget is 30 s and its
 * queue entries are deleted fire-and-forget, so a minutes-long hold converts
 * "occasional silent miss" into "every commit during cutover loses its
 * summary". Instead:
 *
 *   outside the lock  1. pin every source's orphan tip Tᵢ (reads go through
 *                        `<sha>:<path>`, never a ref name)
 *                     2. full import of every source @Tᵢ (re-runnable)
 *                     3. full per-source compare @Tᵢ — the one moment that
 *                        can prove the database holds everything
 *   fence             write the fence pair into EVERY source's profile.json
 *                     (any failure means the fence did not go up — stay in
 *                     prepare and retry; entering half-fenced strands clones)
 *   inside the lock   4. take every source's orphan-write.lock in stable
 *                        common-dir order → rev-parse each tip → all == Tᵢ →
 *                        one small transaction writes repo_state 'cutover'
 *                        (tips, evidence, incrementing version) → release in
 *                        reverse. Any tip moved → release, catch-up import
 *                        the moved source at its new tip, retry.
 *
 * The critical section is a rev-parse per source plus one transaction —
 * milliseconds, far under any writer's budget. Retry is the NORMAL path for
 * an active repo, not an error.
 *
 * One-way rules that must never soften:
 * - After the fence, gap-fill is ONLY `catch-up` (seed's reconciliation would
 *   delete every memory written to SQLite during the fence — they were never
 *   on orphan), and the compare criterion is CONTAINMENT (orphan ⊆ DB): the
 *   database legitimately grows rows the frozen branch never saw.
 * - `legacy-fenced` never goes back to `prepare`. It is not a failure state —
 *   it writes SQLite and reads the database; resume just finishes the CAS.
 * - The fence is never auto-revoked. Old clients must never write the frozen
 *   branch again, so there is no "unfence", only doctor's manual path.
 */

import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { execGit } from "../core/GitOps.js";
import { GitRefStorage, resolveCommittish } from "../core/GitRefStorage.js";
import { acquireOrphanWriteLock, releaseOrphanWriteLock } from "../core/Locks.js";
import { readCutoverFence, writeCutoverFence } from "../core/RepoProfile.js";
import { invalidateSotRouteCache } from "../core/SotStorageResolver.js";
import { SqliteStorage } from "../core/SqliteStorage.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import { createLogger, errMsg, ORPHAN_BRANCH } from "../Logger.js";
import type { CutoverRecord } from "./CutoverRouter.js";
import { DashboardSchemaAheadError, inTransaction, withDashboardDb } from "./DashboardDb.js";
import { existingWorktrees, type RegisteredRepo, readRepoRegistry, resolveRepoIdentityForCwd } from "./RepoRegistry.js";
import { countMemoriesAbsentFromListing, importRepoMemory } from "./SotImport.js";

const log = createLogger("CutoverEngine");

/**
 * Lock budget for the CAS's critical section, well above the 1 s default.
 *
 * The default is sized for ordinary write paths that take the lock, write, and
 * release. This one waits behind them — a post-LLM store or a transcript batch
 * legitimately holds the lock for seconds — and it is not on any blocking path
 * (an interactive `jolli cutover`), so waiting is strictly cheaper than the
 * retry it would otherwise cost.
 */
const CAS_LOCK_TIMEOUT_MS = 15_000;

/** One registered migration source: a clone with its own orphan branch. */
export interface CutoverSource {
	/** The clone's main worktree root — where its orphan branch lives. */
	readonly root: string;
	/** The pinned orphan tip Tᵢ. */
	readonly tip: string;
}

export type CutoverOutcome =
	| { readonly status: "committed"; readonly record: CutoverRecord }
	| { readonly status: "already-cutover" }
	| { readonly status: "not-ready"; readonly reason: string }
	| { readonly status: "retry-exhausted"; readonly reason: string };

export interface CutoverOptions {
	readonly dbPath?: string;
	readonly nowMs?: number;
	/** Tip-moved retries before giving up (retries are normal, not errors). */
	readonly maxRetries?: number;
	/** Admission floor override — see {@link FENCE_AWARE_MIN_VERSION}. */
	readonly minSurfaceVersion?: string;
	/**
	 * Per-source compare, injected so tests can pin protocol behavior without
	 * a full orphan fixture. Defaults to {@link compareSourceContainment}.
	 * MUST implement containment (orphan ⊆ DB), never equality — see header.
	 */
	readonly compare?: (orphan: StorageProvider, sqlite: SqliteStorage) => Promise<{ ok: boolean; detail: string }>;
	/** Critical-section lock budget; test seam for {@link CAS_LOCK_TIMEOUT_MS}. */
	readonly lockTimeoutMs?: number;
}

/**
 * The default compare: every path the frozen tip lists must read back from
 * the database. Byte-exact for every family except summaries, which use the
 * measured criterion (children are reassembled from CURRENT child rows —
 * fresher than the parent file's stale embedded copies) — shell-equal with an
 * identical child set and order. Containment by construction: paths only the
 * database has are never visited.
 */
export async function compareSourceContainment(
	orphan: StorageProvider,
	sqlite: SqliteStorage,
): Promise<{ ok: boolean; detail: string }> {
	// Every family the orphan tree can carry. A family missing from this list is
	// not "unchecked", it is INVISIBLE: containment only ever visits paths the
	// list produces, so an absent family reports ok having read nothing — which
	// is how archived skills came within one release of being certified and then
	// silently unreadable.
	const families = [
		"summaries/",
		"transcripts/",
		"plans/",
		"notes/",
		"references/",
		"skills/",
		"plan-progress/",
		"topics/",
	];
	let checked = 0;
	for (const prefix of families) {
		const paths = await orphan.listFiles(prefix);
		// batchReadFiles is optional on the interface; GitRefStorage has it, but
		// keep an injected fake honest with a per-path fallback.
		const want = orphan.batchReadFiles
			? await orphan.batchReadFiles(paths)
			: new Map(await Promise.all(paths.map(async (p) => [p, await orphan.readFile(p)] as const)));
		const got = await sqlite.batchReadFiles(paths);
		for (const path of paths) {
			const a = want.get(path);
			const b = got.get(path);
			checked++;
			if (a === b) continue;
			if (a == null || b == null) return { ok: false, detail: `${path}: missing from the database` };
			if (path.startsWith("summaries/") && summariesEquivalent(a, b)) continue;
			// `topics/index.json` ALONE. It is a synthesized view whose entry order
			// falls out of a query, so order-insensitive equality is the right
			// criterion there. A topic PAGE is not that: `topic_source_refs.pos`
			// exists precisely to preserve its array order, and the `startsWith`
			// this used to carry swallowed every page into the loose compare,
			// certifying a reordered page as contained.
			if (path === "topics/index.json" && jsonSetEquivalent(a, b)) continue;
			return { ok: false, detail: `${path}: content differs` };
		}
	}
	// index.json / catalog.json are synthesized views; their entries are
	// covered by the summaries family above, so they are deliberately not
	// byte-compared (entry order and stale copies are allowlisted).
	return { ok: true, detail: `${checked} path(s) contained` };
}

/** The refined summary criterion: byte-equal with children emptied on both sides, same child set/order. */
function summariesEquivalent(a: string, b: string): boolean {
	try {
		const empty = (json: string): { bytes: string; childHashes: string[] } => {
			const o = JSON.parse(json) as Record<string, unknown>;
			const hashes: string[] = [];
			const strip = (n: Record<string, unknown>): void => {
				for (const c of (n.children as Record<string, unknown>[]) ?? []) {
					hashes.push(c.commitHash as string);
					strip(c);
				}
				if ("children" in n) n.children = [];
			};
			strip(o);
			return { bytes: JSON.stringify(o), childHashes: hashes };
		};
		const ea = empty(a);
		const eb = empty(b);
		return ea.bytes === eb.bytes && JSON.stringify(ea.childHashes) === JSON.stringify(eb.childHashes);
	} catch {
		return false;
	}
}

/** Order-insensitive JSON equivalence for the synthesized topic index. */
function jsonSetEquivalent(a: string, b: string): boolean {
	try {
		const canon = (x: unknown): string => {
			if (Array.isArray(x)) {
				return JSON.stringify(x.map(canon).sort());
			}
			if (x && typeof x === "object") {
				return JSON.stringify(
					Object.fromEntries(
						Object.entries(x as Record<string, unknown>)
							.sort()
							.map(([k, v]) => [k, canon(v)]),
					),
				);
			}
			return JSON.stringify(x);
		};
		return canon(JSON.parse(a)) === canon(JSON.parse(b));
	} catch {
		return false;
	}
}

/**
 * The first release whose surfaces understand the fence protocol. Admission
 * is decided by what is INSTALLED ON THIS MACHINE, not by what has shipped:
 * dist-paths records every registered surface as `source@version`, so "every
 * surface here is fence-aware" is locally decidable. An older surface would
 * keep writing the frozen branch (it reads only the derived disable bit at
 * its NEXT start, and running hosts not even that), so the cutover refuses
 * to begin until the machine is clean.
 */
export const FENCE_AWARE_MIN_VERSION = "0.99.9";

/** Machine-local admission: every installed surface must be fence-aware. */
export async function checkCutoverAdmission(
	minVersion: string = FENCE_AWARE_MIN_VERSION,
): Promise<{ ok: boolean; stale: Array<{ source: string; version: string }> }> {
	const { traverseDistPaths } = await import("../install/DistPathResolver.js");
	const { compareSemver } = await import("../install/SemverCompare.js");
	const stale = traverseDistPaths()
		// `available` is what makes "installed" true. A dist-paths entry outlives
		// the surface that wrote it (uninstall the VS Code extension and the file
		// stays, pointing at a deleted directory), and `pickBestDistPath` filters
		// those out for the same reason. Counting a ghost as stale would refuse
		// the cutover forever with advice the user cannot act on: upgrade a
		// surface that is not installed.
		.filter((info) => info.available)
		.filter((info) => {
			try {
				return compareSemver(info.version, minVersion) < 0;
			} catch {
				return true; // unparsable version — treat as too old, never as fine
			}
		})
		.map((info) => ({ source: info.source, version: info.version }));
	return { ok: stale.length === 0, stale };
}

/** What the drift probe found for one source. */
export interface DriftReport {
	readonly root: string;
	readonly recordedTip: string;
	readonly currentTip: string | null;
}

/**
 * The post-cutover safety net: something bypassed the fence (an old client,
 * an un-restarted host) and wrote the frozen branch. Compares each source's
 * current orphan tip against the tips the CAS recorded; a mismatch is
 * reported AND catch-up imported so the memory is not stranded — but the
 * recorded tip is deliberately NOT updated: drift keeps being reported until
 * a human deals with the bypassing writer, otherwise the next probe would
 * read "all clear" while the writer is still live.
 */
export async function probeCutoverDrift(
	cwd: string,
	opts: { readonly dbPath?: string; readonly nowMs?: number } = {},
): Promise<DriftReport[]> {
	const { identity } = await resolveRepoIdentityForCwd(cwd);
	const dbOpts = opts.dbPath ? { dbPath: opts.dbPath } : {};
	const record = await withDashboardDb((db) => {
		const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
			| { id: number }
			| undefined;
		if (!row) return null;
		const state = db.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = 'cutover'").get(row.id) as
			| { value: string }
			| undefined;
		return state ? (JSON.parse(state.value) as CutoverRecord) : null;
	}, dbOpts);
	if (!record) return [];
	const registry = await readRepoRegistry();
	const repo = registry.repos.find((r) => r.repoIdentity === identity);
	const drifted: DriftReport[] = [];
	for (const [root, recordedTip] of Object.entries(record.tips)) {
		// A checkout that no longer exists is not drift. `git worktree remove` after
		// the cutover leaves its recorded tip unresolvable forever, and reporting
		// that as "someone bypassed the fence" made `--probe` fail with exit 1 on
		// every run with nothing the user could do to clear it. Drift means the
		// branch MOVED, which only a present checkout can tell us.
		if (!existsSync(root)) {
			log.info("cutover drift check skipped for %s: checkout no longer exists", root);
			continue;
		}
		const currentTip = await resolveCommittish(ORPHAN_BRANCH, root);
		if (currentTip === recordedTip) continue;
		drifted.push({ root, recordedTip, currentTip });
		log.warn(
			"cutover drift: %s orphan tip %s != recorded %s — someone bypassed the fence",
			root,
			currentTip,
			recordedTip,
		);
		if (currentTip && repo) {
			// catch-up ONLY: the database is full of post-cutover rows the frozen
			// branch never saw; seed's reconciliation would delete them all.
			//
			// And catch-up alone is not enough: the bytes on a drifted tip are what
			// a fence-bypassing writer put there, so importing them unprotected
			// would roll a post-fence regenerated summary (or plan, transcript,
			// doc) back to its pre-fence body — silently, and against a branch
			// nothing will ever re-fix. Everything the database stamped at or after
			// the freeze outranks this source. The fence file is the authority on
			// when that was; `committedAt` is the fallback for a record whose
			// worktree lost its profile.json (`readCutoverFence` fails open).
			// An UNPARSABLE `at` degrades exactly like a missing one — `??` only
			// covers the absent case, and NaN would sail through as "no protection".
			const fence = await readCutoverFence(root).catch(() => null);
			const fromFence = fence ? Date.parse(fence.at) : Number.NaN;
			const fenceMs = Number.isFinite(fromFence) ? fromFence : Date.parse(record.committedAt);
			const pinned = new GitRefStorage(currentTip, root);
			await withDashboardDb(
				(db) =>
					importRepoMemory(db, {
						repo,
						storage: pinned,
						nowMs: opts.nowMs ?? Date.now(),
						mode: "catch-up",
						...(Number.isFinite(fenceMs) ? { protectNewerThanMs: fenceMs } : {}),
					}),
				dbOpts,
			);
		}
	}
	return drifted;
}

/**
 * Distinct clones (by git common dir) among the repo's registered worktrees.
 *
 * `git rev-parse --git-common-dir` prints a path RELATIVE to the worktree it
 * was run in — for a main worktree that's almost always the bare string
 * `.git`, identical across every independent clone of the same project. Two
 * unrelated clones would therefore collide on the same dedup key and one of
 * them would silently drop out of `roots`, never get imported, locked, or
 * fenced, and keep writing the frozen orphan branch after cutover. Resolving
 * against the worktree root and canonicalizing with `realpath` (which also
 * collapses symlinks) gives each clone's `.git` its own absolute key while
 * still collapsing `git worktree add` siblings that share one common dir.
 */
async function collectSources(repo: RegisteredRepo): Promise<string[]> {
	const byCommonDir = new Map<string, string>();
	for (const worktree of existingWorktrees(repo)) {
		const res = await execGit(["rev-parse", "--git-common-dir"], worktree);
		if (res.exitCode !== 0) continue;
		const raw = res.stdout.trim();
		if (!raw) continue;
		let key: string;
		try {
			key = await realpath(resolvePath(worktree, raw));
		} catch {
			continue; // common dir vanished mid-scan — drop it, don't fabricate a collision
		}
		if (!byCommonDir.has(key)) byCommonDir.set(key, worktree);
	}
	// Stable order — the lock-acquisition order, so two concurrent cutovers
	// cannot deadlock waiting on each other's half-taken lock sets.
	return [...byCommonDir.keys()].sort().map((key) => byCommonDir.get(key) as string);
}

/**
 * Runs (or resumes) the cutover for the repo at `cwd`. Re-runnable at every
 * stage: prepare re-imports, a fenced repo re-verifies and finishes the CAS.
 */
export async function runCutover(cwd: string, opts: CutoverOptions = {}): Promise<CutoverOutcome> {
	const nowMs = opts.nowMs ?? Date.now();
	const maxRetries = opts.maxRetries ?? 3;
	const compare = opts.compare ?? compareSourceContainment;
	const admission = await checkCutoverAdmission(opts.minSurfaceVersion);
	if (!admission.ok) {
		const list = admission.stale.map((s) => `${s.source}@${s.version}`).join(", ");
		return {
			status: "not-ready",
			reason: `stale surfaces installed on this machine: ${list} — upgrade them first (old surfaces would keep writing the frozen branch)`,
		};
	}
	const { identity } = await resolveRepoIdentityForCwd(cwd);
	const registry = await readRepoRegistry();
	const repo = registry.repos.find((r) => r.repoIdentity === identity);
	if (!repo) return { status: "not-ready", reason: "repo is not registered — run jolli enable first" };

	const dbOpts = opts.dbPath ? { dbPath: opts.dbPath } : {};
	// A database written by a NEWER build cannot be migrated down, so every
	// writable open throws — including the CAS this cutover would end with.
	// That is a readiness fact, not a crash: `resolveCutoverRoute` already
	// reports it as a warning on the read side, and letting the raw error escape
	// here made `jolli cutover` print a stack trace and do nothing, which reads
	// as "the command has no effect". Caught around the FIRST open only: if this
	// one succeeds, no later open in this run can hit the condition.
	let alreadyCommitted: boolean;
	try {
		alreadyCommitted = await withDashboardDb((db) => {
			const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
				| { id: number }
				| undefined;
			if (!row) return false;
			return (
				db.prepare("SELECT 1 AS ok FROM repo_state WHERE repo_id = ? AND key = 'cutover'").get(row.id) !==
				undefined
			);
		}, dbOpts);
	} catch (err) {
		if (err instanceof DashboardSchemaAheadError) return { status: "not-ready", reason: errMsg(err) };
		throw err;
	}
	if (alreadyCommitted) return { status: "already-cutover" };

	const roots = await collectSources(repo);
	if (roots.length === 0) return { status: "not-ready", reason: "no live worktree found for this repo" };

	// Resume path: for EACH source, a `cutoverFence` already on disk there
	// means the freeze already happened for it — never re-seed it (that
	// reconciliation would delete fence-era SQLite-only memories), never
	// unfence it. Checked per-root rather than just at `cwd`: an earlier run
	// can have fenced only SOME sources before failing partway (disk error,
	// crash), and resuming from any one of them must still notice — and fence
	// — whichever sources never made it, rather than skip fencing entirely
	// and complete the CAS half-fenced (see the header's one-way rules).
	//
	// The value is the freeze time, kept because step 2 needs it: a source that
	// is already fenced has a frozen tip, so every row the database stamped after
	// it outranks anything this import could read back (see the protect argument
	// there). An unparsable `at` stores NaN and degrades to unprotected catch-up,
	// which still never deletes.
	const fencedRoots = new Map<string, number>();
	for (const root of roots) {
		const fence = await readCutoverFence(root);
		if (fence !== null) fencedRoots.set(root, Date.parse(fence.at));
	}
	let sources: CutoverSource[] = [];

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		// 1. Pin every source's tip.
		sources = [];
		for (const root of roots) {
			const tip = await resolveCommittish(ORPHAN_BRANCH, root);
			if (!tip) return { status: "not-ready", reason: `no orphan branch in ${root}` };
			sources.push({ root, tip });
		}

		// 2. Import each source at its pinned tip. Seed (with reconciliation)
		// only before the fence and only for a single-source repo — seed prunes
		// against ONE listing, so a second source (or fence-era rows) would be
		// swept as "gone".
		//
		// `fencedRoots` alone is not sufficient evidence: it comes from
		// profile.json, which `readRaw` fails OPEN (a wiped or corrupt file
		// reads as `{}`), and per-project state is exactly the kind of thing
		// users delete. Losing the fence re-legalizes seed, whose reconciliation
		// would then delete every fence-era SQLite-only memory — permanently,
		// since the branch it reconciles against is frozen. So ask the database
		// too: if it holds memories this source does not list, something wrote
		// them where the branch could not see, which is precisely the state a
		// prune must not run in. One listing plus one count, and it can only
		// ever refuse to prune (a false positive costs stale rows a later
		// legitimate seed removes).
		let seedLegal = fencedRoots.size === 0 && sources.length === 1;
		if (seedLegal) {
			const listed = new Set(
				(await new GitRefStorage(sources[0].tip, sources[0].root).listFiles("summaries/"))
					.filter((p) => p.endsWith(".json"))
					.map((p) => p.slice("summaries/".length, -".json".length)),
			);
			// Fail CLOSED — see `countMemoriesAbsentFromListing`. Refusing costs a
			// catch-up pass that leaves stale rows a later legitimate seed removes;
			// failing open costs every fence-era memory, permanently.
			const unlisted = await withDashboardDb(
				(db) => countMemoriesAbsentFromListing(db, identity, listed),
				dbOpts,
			).catch(() => Number.POSITIVE_INFINITY);
			if (!Number.isFinite(unlisted)) {
				log.warn(
					"could not count database memories against the orphan tip — seeding cannot be proven safe, so this run catches up instead",
				);
				seedLegal = false;
			} else if (unlisted > 0) {
				log.warn(
					"%d database memor%s absent from the orphan tip — seeding would delete %s, so this run catches up instead",
					unlisted,
					unlisted === 1 ? "y is" : "ies are",
					unlisted === 1 ? "it" : "them",
				);
				seedLegal = false;
			}
		}
		//
		// Protection is per-source and only for a source that is ALREADY fenced —
		// which on attempt 0 is only a resume, and on a retry is every source this
		// run just froze. Its tip cannot legally move again, so anything the
		// database stamped at or after the freeze is newer than what this import
		// can read; without the guard, a retry (or a resume after a bypassing
		// write) would roll a post-fence regenerated summary back to its pre-fence
		// body. An unfenced source omits it and wins, which is the pre-cutover
		// contract — passing the fence time there would wrongly protect rows
		// against the branch that is still the source of truth.
		//
		// Deliberate consequence: a protected row that DISAGREES with the frozen
		// bytes then fails step 3's containment compare, so the run ends
		// `not-ready` and the repo stays `legacy-fenced`. That is the intended
		// trade — legacy-fenced writes SQLite and reads the database, so it costs
		// a stuck cutover and a named path in the reason, where importing anyway
		// costs the regenerated memory with nothing to recover it from.
		for (const source of sources) {
			const pinned = new GitRefStorage(source.tip, source.root);
			const fenceMs = fencedRoots.get(source.root);
			await withDashboardDb(
				(db) =>
					importRepoMemory(db, {
						repo,
						storage: pinned,
						nowMs,
						mode: seedLegal ? "seed" : "catch-up",
						...(fenceMs !== undefined && Number.isFinite(fenceMs) ? { protectNewerThanMs: fenceMs } : {}),
					}),
				dbOpts,
			);
		}

		// 3. Full compare at the pinned tips (containment — see header).
		const sqlite = new SqliteStorage(identity, opts.dbPath);
		for (const source of sources) {
			const verdict = await compare(new GitRefStorage(source.tip, source.root), sqlite);
			if (!verdict.ok) {
				return { status: "not-ready", reason: `compare failed for ${source.root}: ${verdict.detail}` };
			}
		}

		// Fence: every source gets the pair, or the fence did not go up. Only
		// sources not already fenced need a write — re-fencing one would
		// pointlessly overwrite its original `tips` snapshot — but every
		// unfenced source MUST get one before we proceed, even on a resume
		// where some sources were already fenced by an earlier, partial run.
		if (sources.some((s) => !fencedRoots.has(s.root))) {
			const tips = Object.fromEntries(sources.map((s) => [s.root, s.tip]));
			try {
				for (const source of sources) {
					if (fencedRoots.has(source.root)) continue;
					await writeCutoverFence(source.root, {
						reason: "cutover to sqlite",
						at: new Date(nowMs).toISOString(),
						tips,
					});
					// One-way from here: a retry after this point must never
					// re-seed this source (fence-era SQLite-only rows would be
					// reconciled away).
					fencedRoots.set(source.root, nowMs);
				}
			} catch (err) {
				return { status: "not-ready", reason: `fence write failed — staying in prepare: ${String(err)}` };
			}
			// The route just moved `uncutover` → `legacy-fenced`, so anything this
			// process resolved in the last few seconds now points at a branch that
			// is frozen. The memo is TTL-bounded, but this is the one moment we
			// know the answer changed, and step 4 below writes through the storage
			// layer in the same process.
			invalidateSotRouteCache();
		}

		// 4. The critical section: locks in stable order, verify, one transaction.
		const locked: string[] = [];
		try {
			// Contention here is ORDINARY, not exceptional: legitimate writers hold
			// this lock across whole post-LLM write sections (the worker's page +
			// index guard, a multi-MB `saveTranscriptsBatch`, `migrateV1toV3`'s
			// entire read-build-write), and the budget below is measured in
			// seconds. Treat a timeout exactly like a moved tip — release, retry,
			// and end in `retry-exhausted` — rather than throwing out of a function
			// whose contract is the CutoverOutcome union: the throw escapes
			// `runCutover` and CutoverCommand's uncaught action, crashing AFTER the
			// fence is already up, with none of the "you are legacy-fenced, re-run
			// to finish" guidance. State stays safe either way; the difference is
			// whether the user is told that.
			// The one deliberate bare `acquireOrphanWriteLock` left in the tree,
			// and it needs to stay bare: the CAS holds N DIFFERENT sources' locks
			// at once, which `withRequiredOrphanWriteLock` cannot express without
			// N levels of nesting. It is safe unwrapped because it is top-level
			// (never reached from inside another guarded section) and nothing
			// inside the section performs an orphan write — a rev-parse per source
			// and one SQLite transaction. Anything else that acquires this lock
			// directly is a bug; use the wrappers in `SummaryStore`/`Locks`.
			let contended: string | null = null;
			for (const source of sources) {
				if (
					!(await acquireOrphanWriteLock(source.root, {
						timeoutMs: opts.lockTimeoutMs ?? CAS_LOCK_TIMEOUT_MS,
					}))
				) {
					contended = source.root;
					break;
				}
				locked.push(source.root);
			}
			if (contended !== null) {
				log.info(
					"orphan-write.lock busy in %s during attempt %d — retrying (an active writer holds it)",
					contended,
					attempt,
				);
				continue;
			}
			let moved: string | null = null;
			for (const source of sources) {
				const current = await resolveCommittish(ORPHAN_BRANCH, source.root);
				if (current !== source.tip) {
					moved = source.root;
					break;
				}
			}
			if (moved === null) {
				// The transaction itself can throw — `BEGIN IMMEDIATE` raises
				// "database is locked" whenever another writer (a hook, `jolli
				// enable`) holds SQLite's writer lock past `busy_timeout`, and a
				// schema-ahead handle throws outright. This was the ONE post-fence
				// step with no error handling, which defeats the policy the lock
				// timeout and the null-row check below both spell out: after the
				// fence is up, every exit must be a CutoverOutcome carrying the
				// "re-run to finish the CAS" guidance, never a stack trace out of
				// CutoverCommand's uncaught action.
				let record: CutoverRecord | null;
				try {
					record = await withDashboardDb((db) => {
						// Step 2's import registers the row, so a miss here is
						// near-unreachable — but the reachability argument lives in
						// another function's side effect, and by this point the fence
						// is already up: a throw would escape runCutover and crash
						// CutoverCommand with none of the "you are legacy-fenced,
						// re-run to finish" guidance (same reasoning as the lock
						// timeout above). A null check is cheaper than that.
						const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
							| { id: number }
							| undefined;
						if (!row) return null;
						const prior = db
							.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = 'cutover-version'")
							.get(row.id) as { value: string } | undefined;
						const version = prior ? Number(prior.value) + 1 : 1;
						const rec: CutoverRecord = {
							tips: Object.fromEntries(sources.map((s) => [s.root, s.tip])),
							cutoverVersion: version,
							committedAt: new Date(nowMs).toISOString(),
							schemaVersion: 1,
						};
						inTransaction(db, () => {
							db.prepare(
								`INSERT INTO repo_state (repo_id, key, value) VALUES (?, 'cutover', ?)
							 ON CONFLICT(repo_id, key) DO UPDATE SET value = excluded.value`,
							).run(row.id, JSON.stringify(rec));
							db.prepare(
								`INSERT INTO repo_state (repo_id, key, value) VALUES (?, 'cutover-version', ?)
							 ON CONFLICT(repo_id, key) DO UPDATE SET value = excluded.value`,
							).run(row.id, String(version));
						});
						return rec;
					}, dbOpts);
				} catch (err) {
					return {
						status: "not-ready",
						reason:
							`could not record the cutover in the dashboard DB (${errMsg(err)}); the fence is up, ` +
							"writes go to SQLite — re-run to finish the CAS",
					};
				}
				if (record === null) {
					return {
						status: "not-ready",
						reason:
							"repo row vanished from the dashboard DB mid-cutover; the fence is up, writes go to " +
							"SQLite — re-run jolli enable, then re-run to finish the CAS",
					};
				}
				log.info("cutover committed for %s at version %d", identity, record.cutoverVersion);
				// `legacy-fenced` → `cutover`. Same reason as the fence above; both
				// transitions are announced because a long-lived caller (the daemon
				// driving `jolli cutover`) has no other signal that the route moved.
				invalidateSotRouteCache();
				return { status: "committed", record };
			}
			log.info("orphan tip moved in %s during attempt %d — retrying (normal for an active repo)", moved, attempt);
		} finally {
			for (const root of [...locked].reverse()) {
				await releaseOrphanWriteLock(root);
			}
		}
		// A tip moved: loop re-pins, catch-up imports (fenced now || multi), and
		// retries. The fence stays up — one-way by design.
	}
	return {
		status: "retry-exhausted",
		reason:
			"orphan tips kept moving or their write lock stayed busy; the fence is up, writes go to SQLite — " +
			"re-run to finish the CAS",
	};
}
