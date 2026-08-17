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
 *                     2. full import of every source @Tᵢ (re-runnable) — THE
 *                        gate: an import that fails throws and nothing freezes
 *                     3. full per-source compare @Tᵢ — a REPORT, not a gate
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
 * Step 3 is deliberately NOT a veto, and that is a decision rather than an
 * omission. It used to be: any single path that would not read back kept the
 * repo at `uncutover` forever. On a real branch that is not a safety property,
 * it is a permanent block — a handful of paths the import can NEVER store
 * (a summary whose embedded `children[]` names a commit with no summary file of
 * its own, a body rewritten in place after the row was written) are stable and
 * self-sustaining, so every attempt fails on the same path and the repo can
 * never leave the legacy branch. The gate that means something is step 2: an
 * import that hit a real fault THROWS, and nothing downstream of it runs. What
 * step 3 answers is "what will stop being served after the freeze", which is
 * information the user needs and not a reason to refuse — the fence FREEZES the
 * branch rather than deleting it, so those bytes stay recoverable by hand.
 * The findings are logged and recorded on the `CutoverRecord`.
 *
 * The refusals that survive are asked of the IMPORT rather than of the compare:
 * a source the import stored nothing from did not land, and freezing there
 * strands the whole repo. Neither is spelled "the compare disagreed on every
 * path" — a repo holding one dirty summary mismatches 1-of-1 and would be
 * refused by that spelling, which is the permanent block this design exists to
 * remove (measured on a real repo). There are two, and they are one rule seen
 * from two sides rather than a rule plus an escalation:
 *   - `summaries/` listed, zero summary rows → refuse. The original, unchanged.
 *     Summaries ARE the memories, so nothing else landing excuses their absence.
 *   - ANY family listed, zero rows of EVERY kind → refuse. Covers only the
 *     branch the first cannot see, one carrying no summary at all (reachable:
 *     ide-bridge `write-plan`). Strictly narrower, so it cannot block a repo
 *     whose import partially works.
 * Neither is a per-family veto and neither may become one — see `storedNothing`.
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
import {
	type CutoverBlockCode,
	type CutoverBlockRecord,
	clearCutoverBlockRow,
	cutoverBlockWitness,
	readCutoverBlockRow,
	writeCutoverBlockRow,
} from "./CutoverBlock.js";
import type { CutoverRecord } from "./CutoverRouter.js";
import {
	canUseDashboardDb,
	getDashboardDbPath,
	inTransaction,
	withDashboardDb,
	withReadonlyDashboardDb,
} from "./DashboardDb.js";
import { classifyDbFiles } from "./DbDetection.js";
import { IMPORT_FAMILIES, importTakesPath } from "./ImportablePaths.js";
import { existingWorktrees, type RegisteredRepo, readRepoRegistry, resolveRepoIdentityForCwd } from "./RepoRegistry.js";
import { countMemoriesAbsentFromListing, importRepoMemory, type SotImportResult } from "./SotImport.js";

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

/**
 * The pinned tip of a source that has NO orphan branch at all.
 *
 * A repo that never generated a memory — a fresh `jolli enable`, or one whose
 * branch was deleted — used to be `not-ready` forever, which is the same
 * permanent block as a dirty path and worse: there is nothing to migrate, so
 * there is nothing that could ever make the answer change. It cuts over
 * instead, and the freeze is not a formality — it is what stops an old runtime
 * from CREATING the branch afterwards and writing memories nothing reads.
 *
 * The empty string rather than null so it survives `Record<string, string>` on
 * the record and the fence unchanged. Every comparison against a live tip must
 * fold `resolveCommittish`'s null onto it, or a source with no branch reads as
 * having moved on the very next check (`null !== ""`).
 */
export const NO_ORPHAN_TIP = "";

/**
 * What a source with no orphan branch is imported FROM.
 *
 * Not "skip the import": the import is also what registers the repo's row in
 * the database, and the CAS's recording transaction looks that row up — so
 * skipping it made a branch-less repo report `not-ready` from the one step
 * that runs after the fence is already up. A provider that lists nothing runs
 * the whole import for zero artifacts, which is the honest shape of "there was
 * nothing to migrate". `catch-up` never deletes, so it also cannot mistake an
 * empty listing for a prune instruction.
 */
const EMPTY_ORPHAN_STORAGE: StorageProvider = {
	// No `kind`: it is optional on the interface, and this is not any of the
	// real backends. Claiming one would be a lie the moment something branches
	// on it (nothing does today — the import only calls readFile /
	// batchReadFiles / listFiles).
	async readFile() {
		return null;
	},
	async batchReadFiles(paths) {
		return new Map(paths.map((p) => [p, null]));
	},
	async listFiles() {
		return [];
	},
	/* v8 ignore start -- the import never writes and never asks; these three exist to satisfy the interface, and writeFiles is loud rather than a silent no-op so a caller that reaches for it cannot believe the write landed */
	async writeFiles() {
		throw new Error("no orphan branch: this source is read-only during cutover");
	},
	async exists() {
		return false;
	},
	async ensure() {},
	/* v8 ignore stop */
};

/**
 * Does this source's pinned tip list any SUMMARY the import would take?
 *
 * The denominator for the original refusal, unchanged. `importTakesPath` is what
 * makes it honest: a branch holding only `summaries/x.json.bak` lists a path the
 * import is DESIGNED to ignore, so counting it would refuse a repo whose import
 * was correct and complete.
 */
async function listsSummaries(pinned: StorageProvider): Promise<boolean> {
	const listed = await pinned.listFiles("summaries/");
	return listed.some((p) => importTakesPath("summaries/", p));
}

/**
 * Does this source's pinned tip list ANY artifact the import would take, in any
 * of the eight families?
 *
 * The denominator for the SECOND refusal, which exists only to cover a branch
 * {@link listsSummaries} cannot see at all: one carrying no summary. That is a
 * reachable shape, not a hypothetical — the ide-bridge `write-plan` action calls
 * `storePlans` directly, with no commit and no summary behind it, so an IDE can
 * put `plans/` on the branch before anything else exists. Such a source answered
 * "lists nothing" to the only test there was, so the freeze went ahead however
 * little the database had taken.
 *
 * Short-circuits on the first family that has one, and is only ever reached when
 * the import already reported storing nothing at all — so the extra `listFiles`
 * calls are off the normal path entirely.
 */
async function listsImportable(pinned: StorageProvider): Promise<boolean> {
	for (const family of IMPORT_FAMILIES) {
		const listed = await pinned.listFiles(family);
		if (listed.some((p) => importTakesPath(family, p))) return true;
	}
	return false;
}

/**
 * Did the import write NO row of any kind?
 *
 * Deliberately the whole-import question, never a per-family one. "The tip lists
 * notes and the import stored no notes" is a per-family veto, and a per-family
 * veto is the permanent block this design exists to remove — one un-importable
 * note would strand the repo forever, with every retry failing on the same file.
 * What is safe to refuse is an import that landed NOTHING while the branch had
 * something to give: that is not a partial result, it is a non-result.
 *
 * Pairs ONLY with {@link listsImportable}, never with {@link listsSummaries}.
 * Weakening the summary refusal to this — "nodes is 0 but a plan imported, so
 * something landed" — would let a repo whose summaries ALL failed freeze on the
 * strength of one plan file, with every memory it has reported as unreconciled.
 * The summaries are the memories; one doc is not evidence they arrived.
 *
 * `updated` / `skipped` / `pruned` are deliberately absent: they count changes
 * and non-events, not rows written. A converged re-run legitimately reports
 * `updated: 0` while having every row already in place.
 */
function storedNothing(r: SotImportResult): boolean {
	return (
		r.nodes === 0 &&
		r.transcripts === 0 &&
		r.docs === 0 &&
		r.planProgress === 0 &&
		r.topics === 0 &&
		r.commitTopics === 0 &&
		r.aliases === 0 &&
		r.links === 0
	);
}

/** One registered migration source: a clone with its own orphan branch. */
export interface CutoverSource {
	/** The clone's main worktree root — where its orphan branch lives. */
	readonly root: string;
	/** The pinned orphan tip Tᵢ, or {@link NO_ORPHAN_TIP} when there is no branch. */
	readonly tip: string;
}

export type CutoverOutcome =
	| {
			readonly status: "committed";
			readonly record: CutoverRecord;
			/**
			 * EVERY distinct unreconciled path, uncapped — unlike
			 * `record.unreconciled.sample`, which stops at
			 * {@link UNRECONCILED_SAMPLE_CAP}.
			 *
			 * Here because this is the only moment the full set exists: the record
			 * is what survives, and it deliberately stores a sample (see the cap's
			 * docstring). The recovery instruction the command prints is
			 * `git show <tip>:<path>`, so a path that reaches neither the output nor
			 * the record cannot be recovered at all — and pointing the user at
			 * `debug.log` for the remainder was FALSE, since that line is rendered
			 * through the same 50-path cap. An interactive report is neither a
			 * rolling log nor a stored row, so it is the one place the whole list
			 * belongs.
			 */
			readonly unreconciled: ReadonlyArray<string>;
	  }
	| { readonly status: "already-cutover" }
	| {
			readonly status: "not-ready";
			readonly reason: string;
			/**
			 * Present only when another identical attempt CANNOT answer differently —
			 * the two import refusals, never the compare and never a transient fault.
			 *
			 * The persisted half of this lives in `repo_state`; see
			 * {@link ./CutoverBlock} for why a memo is the only form of backoff that
			 * cannot suppress a retry that would now succeed. Carried out here as well
			 * because `maybeAutoCutover` logs one line per deferred repo, and
			 * "deferred, will retry" and "deferred, and nothing will change until an
			 * input does" are different facts about that repo.
			 */
			readonly stable?: CutoverBlockCode;
	  }
	| { readonly status: "retry-exhausted"; readonly reason: string };

export interface CutoverOptions {
	readonly dbPath?: string;
	readonly nowMs?: number;
	/** Tip-moved retries before giving up (retries are normal, not errors). */
	readonly maxRetries?: number;
	/**
	 * Per-source compare, injected so tests can pin protocol behavior without
	 * a full orphan fixture. Defaults to {@link compareSourceContainment}.
	 * MUST implement containment (orphan ⊆ DB), never equality — see header.
	 */
	readonly compare?: (orphan: StorageProvider, sqlite: SqliteStorage) => Promise<CompareVerdict>;
	/** Critical-section lock budget; test seam for {@link CAS_LOCK_TIMEOUT_MS}. */
	readonly lockTimeoutMs?: number;
}

/** What one source's compare found. `ok` is exactly `unreconciled.length === 0`. */
export interface CompareVerdict {
	readonly ok: boolean;
	/** One line for the user: the FIRST finding, or the count on success. */
	readonly detail: string;
	/** How many paths were visited — the denominator the caller judges against. */
	readonly checked: number;
	/** Every visited path the database did not reproduce, in compare order. */
	readonly unreconciled: ReadonlyArray<string>;
}

/**
 * The default compare: every path the IMPORT WOULD TAKE is read back from the
 * database. Byte-exact for every family except summaries, which use the
 * measured criterion (children are reassembled from CURRENT child rows —
 * fresher than the parent file's stale embedded copies) — shell-equal with an
 * identical child set and order. Containment by construction: paths only the
 * database has are never visited.
 *
 * "What the import would take", not "every file on the branch", and the
 * difference is the whole point — see `ImportablePaths`. The old form demanded
 * the database answer for files the import is designed never to store, which it
 * can never do, on every attempt, forever.
 *
 * EVERY finding is collected rather than the first one returned. That is what
 * makes this a report: the caller no longer refuses on a finding, so "the first
 * bad path" is not an answer any more — the user needs the whole list of what
 * stops being served, and the caller needs the count to tell a few dirty paths
 * apart from a database that answered for nothing. `detail` keeps naming the
 * first finding, because one line is what a command prints.
 */
export async function compareSourceContainment(
	orphan: StorageProvider,
	sqlite: SqliteStorage,
): Promise<CompareVerdict> {
	let checked = 0;
	const unreconciled: string[] = [];
	let firstDetail = "";
	const note = (path: string, detail: string): void => {
		if (firstDetail === "") firstDetail = detail;
		unreconciled.push(path);
	};
	for (const prefix of IMPORT_FAMILIES) {
		const listed = await orphan.listFiles(prefix);
		const paths = listed.filter((p) => importTakesPath(prefix, p));
		const dropped = listed.length - paths.length;
		// Not silent: a path the compare stops asking about is a deliberate
		// narrowing, and this is the only place it can be seen.
		if (dropped > 0) {
			log.info("compare: %d path(s) under %s are not importable — not compared", dropped, prefix);
		}
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
			if (a == null || b == null) {
				note(path, `${path}: missing from the database`);
				continue;
			}
			if (path.startsWith("summaries/") && summariesEquivalent(a, b)) continue;
			note(path, `${path}: content differs`);
		}
		// The two synthesized union views are not importable paths, so the loop
		// above never yields them. They still have to be compared — by containment,
		// against the whole-repo view the database renders. AFTER the pages, so a
		// concrete missing page is what the user is told about: a page the database
		// lacks also makes the index disagree, and "topics/index.json: content
		// differs" points at a synthesized view rather than at the file to look at.
		for (const view of TOPIC_UNION_VIEWS) {
			if (!listed.includes(view)) continue;
			checked++;
			const verdict = await compareUnionView(view, orphan, sqlite, listed);
			if (!verdict.ok) note(view, verdict.detail);
		}
	}
	// index.json / catalog.json are synthesized views; their entries are
	// covered by the summaries family above, so they are deliberately not
	// byte-compared (entry order and stale copies are allowlisted).
	if (unreconciled.length === 0) return { ok: true, detail: `${checked} path(s) contained`, checked, unreconciled };
	return { ok: false, detail: firstDetail, checked, unreconciled };
}

/**
 * `topics/index.json` / `topics/processed.json` — the two synthesized UNION
 * views. Both are rendered from every row of the repo id, so equality against
 * one source's file can never hold for a repo with more than one source; the
 * criterion is CONTAINMENT (every entry the source lists is in the database),
 * the same thing the family loop asserts for every other path. A topic PAGE is
 * NOT one of these: `topic_source_refs.pos` exists precisely to preserve its
 * array order, so pages stay byte-exact.
 *
 * `topics/index.json` gets one extra narrowing, for the same reason the whole
 * importable-path rule exists: the database renders this view from
 * `topic_pages`, and a row only exists where a PAGE FILE was imported. An index
 * entry whose `topics/<slug>.json` is not on the branch therefore cannot be in
 * the database on any run — the page and the index are two independent writes,
 * and `saveTopicIndex` never prunes entries pointing at absent pages, so the
 * state is stable and self-sustaining. Such entries are dropped from the SOURCE
 * side before comparing, and named in the log: their `title` / `summary` /
 * `sourceRefs` stop being served after the freeze. That is a real (small) loss,
 * mitigated by the fence FREEZING the branch rather than deleting it — the
 * bytes stay recoverable by hand — and by those entries' pages already being
 * unopenable.
 */
async function compareUnionView(
	view: string,
	orphan: StorageProvider,
	sqlite: SqliteStorage,
	listed: ReadonlyArray<string>,
): Promise<{ ok: boolean; detail: string }> {
	const a = await orphan.readFile(view);
	// Nothing on the source side to contain.
	if (a == null) return { ok: true, detail: "" };
	const b = await sqlite.readFile(view);
	if (a === b) return { ok: true, detail: "" };
	if (view === "topics/index.json") {
		const { filtered, kept, dropped } = dropUnbackedTopicEntries(a, listed);
		if (dropped.length > 0) {
			// WARN, not info: every other narrowing in this file drops something the
			// database was never meant to hold, but these entries carry `title` /
			// `summary` / `sourceRefs` that really do stop being served. The whole
			// reason the admission check came out is that a verdict nobody can see
			// is a verdict nobody can act on — a content loss must not be quieter
			// than the refusals it replaced.
			log.warn(
				"compare: %d topic index entr%s have no page file on the branch and will not be served after the freeze: %s",
				dropped.length,
				dropped.length === 1 ? "y" : "ies",
				dropped.join(", "),
			);
		}
		// `b == null` is a REAL state, not a failure: the database renders no index
		// at all until it holds at least one topic page. It is contained exactly
		// when nothing survived the filter — never by comparing against a
		// synthesized empty document, which would also have to guess at the
		// index's other fields (`schemaVersion`) and would fail on them.
		if (b == null) {
			return kept === 0 ? { ok: true, detail: "" } : { ok: false, detail: `${view}: missing from the database` };
		}
		if (jsonContains(filtered, b)) return { ok: true, detail: "" };
		return { ok: false, detail: `${view}: content differs` };
	}
	if (b != null && jsonContains(a, b)) return { ok: true, detail: "" };
	return { ok: false, detail: b == null ? `${view}: missing from the database` : `${view}: content differs` };
}

/**
 * Drops index entries whose `topics/<stableSlug>.json` is absent from `listed`.
 *
 * An unparsable index returns unchanged, so the comparison falls back to the
 * STRICTER form — a parse failure must never widen what is accepted.
 */
function dropUnbackedTopicEntries(
	indexJson: string,
	listed: ReadonlyArray<string>,
): { filtered: string; kept: number; dropped: string[] } {
	try {
		const parsed = JSON.parse(indexJson) as { topics?: Array<{ stableSlug?: string }> };
		// Same verdict as the `catch` below, and for the same reason: a document
		// this function cannot interpret must fall back to the STRICTER form. The
		// `kept: 1` is what keeps a null database side a failure — returning 0 here
		// would widen acceptance on exactly the input we understand least.
		/* v8 ignore next -- a well-formed index always carries the array */
		if (!Array.isArray(parsed.topics)) return { filtered: indexJson, kept: 1, dropped: [] };
		const pages = new Set(listed);
		const dropped: string[] = [];
		const topics = parsed.topics.filter((t) => {
			const slug = typeof t?.stableSlug === "string" ? t.stableSlug : "";
			if (slug && pages.has(`topics/${slug}.json`)) return true;
			dropped.push(slug || "(no stableSlug)");
			return false;
		});
		if (dropped.length === 0) return { filtered: indexJson, kept: topics.length, dropped };
		return { filtered: JSON.stringify({ ...parsed, topics }), kept: topics.length, dropped };
	} catch {
		// Unparsable: fall back to the UNFILTERED document, so the comparison is
		// the stricter one. `kept: 1` keeps a null database side a failure here.
		return { filtered: indexJson, kept: 1, dropped: [] };
	}
}

/**
 * How many unreconciled paths a log line and the stored record carry.
 *
 * The COUNT is always the exact number of DISTINCT paths; only the list is a
 * sample. A branch can carry hundreds of unreconcilable paths, and neither
 * `debug.log` nor a `repo_state` row is the right place for all of them — the
 * frozen branch itself is, and it is still there.
 */
const UNRECONCILED_SAMPLE_CAP = 50;

/** `a, b, c … (+N more)` — the bounded rendering of a findings list. */
function previewPaths(paths: ReadonlyArray<string>): string {
	if (paths.length <= UNRECONCILED_SAMPLE_CAP) return paths.join(", ");
	return `${paths.slice(0, UNRECONCILED_SAMPLE_CAP).join(", ")} (+${paths.length - UNRECONCILED_SAMPLE_CAP} more)`;
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

/**
 * The reason string for a step 2 / step 3 failure, told from the caller's side.
 *
 * Once ANY source is fenced the repo is already `legacy-fenced` — a working
 * state, not a broken one (it writes SQLite and reads the database) — so the
 * only thing the user needs is that re-running finishes the CAS.
 */
function importOrCompareFailure(err: unknown, fenced: boolean): string {
	const detail = `import/compare failed: ${errMsg(err)}`;
	return fenced ? `${detail} — this repo is legacy-fenced; re-run \`jolli cutover\` to finish` : detail;
}

/** The two synthesized union views — see the containment note in the compare. */
const TOPIC_UNION_VIEWS = new Set(["topics/index.json", "topics/processed.json"]);

/**
 * Does `db` contain everything `source` lists?
 *
 * Arrays are compared as SETS (their order in a synthesized view falls out of a
 * query, and a union interleaves two sources' rows); objects need every key the
 * source carries, and may carry more; leaves must be equal. Deliberately one-
 * directional: extra entries in `db` are the whole point of a union view, and
 * an entry only the database has is never a reason to refuse a cutover — the
 * frozen tips are what must be readable back, nothing more.
 */
function jsonContains(source: string, db: string): boolean {
	try {
		return contains(JSON.parse(source), JSON.parse(db));
	} catch {
		return false;
	}
}

function contains(a: unknown, b: unknown): boolean {
	if (Array.isArray(a)) {
		if (!Array.isArray(b)) return false;
		const have = new Set(b.map((v) => canonJson(v)));
		return a.every((v) => have.has(canonJson(v)));
	}
	if (a && typeof a === "object") {
		if (!b || typeof b !== "object" || Array.isArray(b)) return false;
		const other = b as Record<string, unknown>;
		return Object.entries(a as Record<string, unknown>).every(([k, v]) => k in other && contains(v, other[k]));
	}
	return canonJson(a) === canonJson(b);
}

function canonJson(x: unknown): string {
	if (Array.isArray(x)) return JSON.stringify(x.map(canonJson).sort());
	if (x && typeof x === "object") {
		return JSON.stringify(
			Object.fromEntries(
				Object.entries(x as Record<string, unknown>)
					.sort()
					.map(([k, v]) => [k, canonJson(v)]),
			),
		);
	}
	return JSON.stringify(x);
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
	// READ-ONLY, and tolerant of a database this build cannot open. A writable
	// open runs `migrateDashboardDb`, so a probe — a diagnostic — would migrate
	// the schema as a side effect of being asked a question. (A NEWER format is
	// not one of the cases this tolerates: there is no version gate, so such a
	// file opens and writes normally — see `DASHBOARD_SCHEMA_VERSION`.) An absent
	// or unreadable database has no cutover record, which is "no drift to report".
	let record: CutoverRecord | null;
	try {
		record = await withReadonlyDashboardDb((db) => {
			const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
				| { id: number }
				| undefined;
			if (!row) return null;
			const state = db
				.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = 'cutover'")
				.get(row.id) as { value: string } | undefined;
			return state ? (JSON.parse(state.value) as CutoverRecord) : null;
		}, dbOpts);
	} catch (err) {
		log.info("cutover probe: no readable dashboard database (%s)", errMsg(err));
		return [];
	}
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
		// Same fold as the CAS: a source recorded with NO_ORPHAN_TIP still has no
		// branch, and `null !== ""` would report drift on every probe forever.
		// The other direction is real drift and the reason this matters — a branch
		// that did not exist at cutover and does now was created by a writer that
		// never saw the fence.
		if ((currentTip ?? NO_ORPHAN_TIP) === recordedTip) continue;
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

/** Pins every source's current orphan tip — step 1, and the witness's other half. */
async function pinSources(roots: ReadonlyArray<string>): Promise<CutoverSource[]> {
	const sources: CutoverSource[] = [];
	for (const root of roots) {
		// No branch is a legal state to cut over FROM, not a refusal — see
		// NO_ORPHAN_TIP. Steps 2 and 3 skip such a source; step 4 still checks
		// it, so a branch that appears mid-run is caught as a moved tip.
		const tip = await resolveCommittish(ORPHAN_BRANCH, root);
		sources.push({ root, tip: tip ?? NO_ORPHAN_TIP });
	}
	return sources;
}

/**
 * Records a refusal another attempt cannot change. Best-effort by contract.
 *
 * Looks the repo row up itself rather than taking `runCutover`'s preflight id: the
 * import that just ran is what REGISTERS that row, so a first-ever cutover has no
 * id at preflight and would silently never record a block. A failure to store it
 * must not turn a clean refusal into a throw — the cost is one repeated attempt.
 */
async function recordCutoverBlock(
	identity: string,
	code: CutoverBlockCode,
	reason: string,
	sources: ReadonlyArray<CutoverSource>,
	dbOpts: { dbPath?: string },
): Promise<void> {
	try {
		await withDashboardDb((db) => {
			const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
				| { id: number }
				| undefined;
			if (!row) return;
			writeCutoverBlockRow(db, row.id, {
				code,
				reason,
				witness: cutoverBlockWitness(sources),
				at: Date.now(),
			});
		}, dbOpts);
	} catch (err) {
		log.warn("could not record the cutover block for %s: %s", identity, errMsg(err));
	}
}

/**
 * The record for `cwd`, but ONLY while it still applies — otherwise null.
 *
 * "Applies" is decided by re-deriving the witness, never by elapsed time: an
 * orphan tip that moved or a different core version means the refusal has to be
 * re-earned, so the answer is null and the caller attempts immediately with no
 * window at all. See {@link ./CutoverBlock} for why that is the only backoff shape
 * allowed here.
 *
 * For CALLERS THAT CHOOSE whether to attempt — `maybeAutoCutover`. `runCutover`
 * itself never consults this: `jolli cutover` typed by hand is the documented
 * bypass for every gate in this engine, and a user who is looking at the reason
 * on screen is exactly who should be able to make it try again.
 *
 * Never throws, for the same reason `maybeAutoCutover` does not: a repo whose
 * block cannot be read is a repo that gets attempted.
 */
export async function readCutoverBlock(
	cwd: string,
	opts: { readonly dbPath?: string } = {},
): Promise<CutoverBlockRecord | null> {
	const dbOpts = opts.dbPath ? { dbPath: opts.dbPath } : {};
	// A database that is not there yet cannot hold a record, and this runs ahead of
	// EVERY automatic attempt — so the absence is answered here rather than left to
	// the catch below, which would log a warning per call on every machine that has
	// not built one. Same classification the router uses for the same reason.
	if (!canUseDashboardDb()) return null;
	if (classifyDbFiles(opts.dbPath ?? getDashboardDbPath()) === "absent") return null;
	try {
		const { identity } = await resolveRepoIdentityForCwd(cwd);
		// The row FIRST, and the witness only if there is one: this runs ahead of
		// every automatic attempt, and the common case is no record at all — which
		// one indexed query answers, without forking git for a single tip.
		const record = await withReadonlyDashboardDb((db) => {
			const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
				| { id: number }
				| undefined;
			return row ? readCutoverBlockRow(db, row.id) : null;
		}, dbOpts);
		if (!record) return null;
		const registry = await readRepoRegistry();
		const repo = registry.repos.find((r) => r.repoIdentity === identity);
		if (!repo) return null;
		const witness = cutoverBlockWitness(await pinSources(await collectSources(repo)));
		if (witness === record.witness) return record;
		log.info("cutover block for %s no longer applies — an input changed since it was recorded", cwd);
		return null;
	} catch (err) {
		log.warn("could not read the cutover block for %s: %s", cwd, errMsg(err));
		return null;
	}
}

/**
 * Runs (or resumes) the cutover for the repo at `cwd`. Re-runnable at every
 * stage: prepare re-imports, a fenced repo re-verifies and finishes the CAS.
 */
export async function runCutover(cwd: string, opts: CutoverOptions = {}): Promise<CutoverOutcome> {
	const nowMs = opts.nowMs ?? Date.now();
	const maxRetries = opts.maxRetries ?? 3;
	const compare = opts.compare ?? compareSourceContainment;
	// NO machine-local admission check, and its absence is the decision. This
	// used to refuse the whole cutover when any surface registered in
	// `dist-paths/` was below a fence-aware version floor, on the theory that an
	// old surface would keep writing the frozen branch. The cost of that theory
	// was total: one un-upgraded fork-editor extension pinned every repo on the
	// machine at `uncutover` forever, with the reason only ever reaching
	// `debug.log` — the SQLite read path was unreachable in practice.
	//
	// The risk it guarded moves downstream to `probeCutoverDrift`, which reports
	// a write that bypassed the fence AND catch-up imports it, so such a memory
	// is reported rather than stranded. That trade only holds because the probe
	// RUNS ON ITS OWN: `maybeAutoCutover` calls it (throttled) every time it
	// finds a repo already in `cutover`. Leaving it reachable only from
	// `jolli cutover --probe` would have swapped a visible refusal for a silent
	// loss — after the fence reads come from SQLite, so a bypassed write shows no
	// symptom the user could know to investigate. Do not remove that call site
	// without restoring a guard here.
	const { identity } = await resolveRepoIdentityForCwd(cwd);
	const registry = await readRepoRegistry();
	const repo = registry.repos.find((r) => r.repoIdentity === identity);
	if (!repo) return { status: "not-ready", reason: "repo is not registered — run jolli enable first" };

	const dbOpts = opts.dbPath ? { dbPath: opts.dbPath } : {};
	// No try/catch here, and its absence is the point: this open used to be wrapped
	// because a database written by a newer build made EVERY writable open throw,
	// which turned `jolli cutover` into a stack trace that changed nothing. The
	// database no longer refuses a build over its version (see the compatibility
	// note in `DashboardDb`), so the only errors left are real I/O faults, and those
	// should propagate.
	// One open answers both questions AND retires any stale block record. Clearing
	// it HERE — before step 1, not at each of the many non-blocking exits — is what
	// keeps the invariant to one write site and one clear site: this run is about
	// to re-derive the answer, so whatever a previous run concluded stops being
	// this build's claim the moment we get past here. Every outcome except the two
	// refusals below therefore leaves no record, including a throw, which is the
	// conservative direction (unknown → attempt again).
	const preflight = await withDashboardDb((db) => {
		const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as
			| { id: number }
			| undefined;
		if (!row) return { repoId: null, committed: false };
		const committed =
			db.prepare("SELECT 1 AS ok FROM repo_state WHERE repo_id = ? AND key = 'cutover'").get(row.id) !==
			undefined;
		if (!committed) clearCutoverBlockRow(db, row.id);
		return { committed };
	}, dbOpts);
	if (preflight.committed) return { status: "already-cutover" };

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
	// Reset at the top of every step 3, never appended across attempts: a retry
	// re-imports and re-compares from scratch, and carrying the previous
	// attempt's findings would record paths a later import had already fixed.
	let unreconciled: string[] = [];

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		// 1. Pin every source's tip. Shared with `readCutoverBlock`'s witness on
		// purpose: the memo compares what THIS step pinned, so a second spelling of
		// "the current tips" is a way for the two to disagree and for a block to
		// outlive its inputs.
		sources = await pinSources(roots);

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
		// A source with no branch has no listing to reconcile against, so the
		// question does not arise — and asking it would run `ls-tree` on an empty
		// committish.
		let seedLegal = fencedRoots.size === 0 && sources.length === 1 && sources[0].tip !== NO_ORPHAN_TIP;
		if (seedLegal) {
			// The shared predicate, not a hand-inlined copy of it: this listing is
			// compared against database rows the IMPORT wrote, so it has to be the
			// import's own idea of what a summary file is.
			const listed = new Set(
				(await new GitRefStorage(sources[0].tip, sources[0].root).listFiles("summaries/"))
					.filter((p) => importTakesPath("summaries/", p))
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
		// bytes is reported by step 3 as unreconciled rather than imported over.
		// The protection is what makes that the right way round — the database
		// row is the NEWER one, so the frozen file losing the comparison is the
		// correct outcome, not a fault to fix by rolling the row back.
		// Steps 2 and 3 answer `not-ready` rather than throwing. On a RETRY they
		// run with the fence already up, and both can fail for reasons that have
		// nothing to do with this repo's readiness — a
		// concurrent QueueWorker holding the writer past `busy_timeout`, a git read
		// failure. Letting that escape lands in `CutoverCommand`'s uncaught
		// commander action: a stack trace, and no word to the user that the repo is
		// now `legacy-fenced` and that re-running finishes the CAS. That is the one
		// outcome the lock-timeout and null-row guards below were both written to
		// prevent; they just never covered the two steps the retry re-executes.
		try {
			for (const source of sources) {
				// A GitRefStorage on an empty committish would ask git to resolve
				// `:<path>` and fail every read; the empty provider imports zero
				// artifacts while still registering the repo row the CAS needs.
				const pinned =
					source.tip === NO_ORPHAN_TIP ? EMPTY_ORPHAN_STORAGE : new GitRefStorage(source.tip, source.root);
				const fenceMs = fencedRoots.get(source.root);
				const result = await withDashboardDb(
					(db) =>
						importRepoMemory(db, {
							repo,
							storage: pinned,
							nowMs,
							mode: seedLegal ? "seed" : "catch-up",
							...(fenceMs !== undefined && Number.isFinite(fenceMs)
								? { protectNewerThanMs: fenceMs }
								: {}),
						}),
					dbOpts,
				);
				// THE gate — asked of the import, never of the compare. An import that
				// wrote nothing while the branch lists something to write did not land
				// (every artifact malformed, a storage backend answering nothing), and
				// freezing there strands the whole repo. Deliberately NOT "the compare
				// disagreed on everything": a repo whose single summary is dirty
				// mismatches 1-of-1, which is the permanent block this whole design
				// exists to remove.
				//
				// TWO tests, and the split is the decision. The first is the original,
				// unchanged: summaries are the memories, so a branch that lists them
				// and a database that took none is a failed import no matter what else
				// landed. Relaxing it to "nodes is 0 but a plan imported" was tried and
				// is wrong — see `storedNothing`.
				//
				// The second exists only for the branch the first cannot SEE: one
				// carrying no summary at all, which `listsSummaries` answers "lists
				// nothing" to, so the gate could never fire however little the import
				// took. Reachable via ide-bridge `write-plan` — see `listsImportable`.
				// It is strictly narrower than the first (it needs EVERY counter zero),
				// which is what keeps it from being a per-family veto and from
				// permanently blocking a repo whose import is partially working.
				//
				// Both reasons say "not committing a cutover", NOT "not freezing a
				// branch": a resume re-runs this step with the fence ALREADY up (see
				// the resume path above), so on that path the branch is frozen and the
				// repo sits in legacy-fenced — a WORKING state. What is withheld here
				// is the CAS, which is true of the fresh and the resumed run alike.
				//
				// Both are recorded as a BLOCK, which the two refusals above are the
				// only outcomes in this engine to earn: they are a function of the
				// pinned tip and of this build's importer, so the identical attempt
				// answers identically. See {@link ./CutoverBlock} — including why the
				// witness is sound only while `storedNothing` counts rows written.
				if (result.nodes === 0 && (await listsSummaries(pinned))) {
					const reason =
						`the import stored no memories from ${source.root} although its orphan tip lists some ` +
						`(${result.skipped} artifact(s) skipped) — not committing a cutover the database did not take`;
					await recordCutoverBlock(identity, "no-summary-rows", reason, sources, dbOpts);
					return { status: "not-ready", reason, stable: "no-summary-rows" };
				}
				if (storedNothing(result) && (await listsImportable(pinned))) {
					const reason =
						`the import stored nothing from ${source.root} although its orphan tip lists artifacts ` +
						`(${result.skipped} artifact(s) skipped) — not committing a cutover the database did not take`;
					await recordCutoverBlock(identity, "stored-nothing", reason, sources, dbOpts);
					return { status: "not-ready", reason, stable: "stored-nothing" };
				}
			}

			// 3. Full compare at the pinned tips — a REPORT (see header). Findings
			// are collected across every source, warned about once, and recorded on
			// the CutoverRecord; they do NOT refuse the switch.
			const sqlite = new SqliteStorage(identity, opts.dbPath);
			unreconciled = [];
			// DISTINCT paths, across every source. Sibling clones of one project
			// share a repo id and compare against the same database, so a path both
			// of them carry — most of all the two synthesized union views, which
			// exist on every clone's branch — is reported once per clone. Without
			// this the `count` the record calls exact would be a finding tally, the
			// 50-entry sample would spend its slots on repeats, and `jolli cutover`
			// would print "2 path(s)" above the same path twice.
			const seen = new Set<string>();
			for (const source of sources) {
				if (source.tip === NO_ORPHAN_TIP) continue;
				const verdict = await compare(new GitRefStorage(source.tip, source.root), sqlite);
				// No refusal of any kind here — see the header. Whatever did not read
				// back is reported, recorded, and stays readable on the frozen
				// branch; the import above already answered "did this land".
				//
				// A loop rather than `push(...verdict.unreconciled)`: the spread
				// passes every element as an argument, which throws RangeError past
				// the engine's argument cap. Unlikely at this size, and free to
				// avoid.
				if (!verdict.ok) {
					for (const path of verdict.unreconciled) {
						if (seen.has(path)) continue;
						seen.add(path);
						unreconciled.push(path);
					}
				}
			}
			if (unreconciled.length > 0) {
				// WARN and name them: after the fence these paths are no longer
				// served, and this line plus the record are the only places that
				// says so. The branch is frozen rather than deleted, so the bytes
				// stay recoverable by hand.
				log.warn(
					"cutover: %d path(s) do not read back from the database and will not be served after the freeze: %s",
					unreconciled.length,
					previewPaths(unreconciled),
				);
			}
		} catch (err) {
			return { status: "not-ready", reason: importOrCompareFailure(err, fencedRoots.size > 0) };
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
				// Fold null onto the sentinel: a source that had no branch when it
				// was pinned must compare EQUAL to still having none, and a branch
				// that appeared since must compare as moved.
				const current = (await resolveCommittish(ORPHAN_BRANCH, source.root)) ?? NO_ORPHAN_TIP;
				if (current !== source.tip) {
					moved = source.root;
					break;
				}
			}
			if (moved === null) {
				// The transaction itself can throw — `BEGIN IMMEDIATE` raises
				// "database is locked" whenever another writer (a hook, `jolli
				// enable`) holds SQLite's writer lock past `busy_timeout`, and a
				// migration entry can fail on a damaged file. (A schema-ahead file is
				// NOT one of these: there is no version gate, so a newer format opens
				// and writes normally — see `DASHBOARD_SCHEMA_VERSION`.) This was the ONE post-fence
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
							// Absent when there were none, so a clean cutover's record is
							// byte-identical to what every earlier build wrote.
							...(unreconciled.length > 0
								? {
										unreconciled: {
											count: unreconciled.length,
											sample: unreconciled.slice(0, UNRECONCILED_SAMPLE_CAP),
										},
									}
								: {}),
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
				// The full list rides alongside the record, never inside it — see the
				// field's docstring on `CutoverOutcome`.
				return { status: "committed", record, unreconciled: [...unreconciled] };
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
