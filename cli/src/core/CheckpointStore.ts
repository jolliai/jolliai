/**
 * CheckpointStore — the `.jolli/checkpoints/` namespace: volatile, branch-local
 * "checkpoint" memories captured BEFORE a commit exists.
 *
 * A checkpoint is the pre-commit sibling of a `CommitSummary`: same topic shape,
 * but no commit hash, and a different lifetime. It is deliberately **folder-only**
 * — never written to the orphan branch, never listed in `.jolli/index.json`, and
 * a brand-new type (`CheckpointRecord`) so it can never perturb the `CommitSummary`
 * / `SummaryIndexEntry` schema the CLI, VS Code, and IntelliJ plugins share.
 *
 * Lifetime: a checkpoint is retired when a durable commit-summary lands on the
 * same branch — {@link archiveSupersededCheckpoints} moves it into
 * `.jolli/checkpoints/.archived/` (stamped with the superseding commit). The
 * archive call is a no-op when the repo has no checkpoints, so wiring it into the
 * shared commit path costs existing (checkpoint-free) repos nothing.
 *
 * Pure `fs` + `path` + AtomicWrite — no LLM, no git, no CLI runtime — so hosts
 * can read/list checkpoints as cheaply as they read the folder canonical layer.
 */

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { DiffStats, LlmCallMetadata, TopicSummary, TranscriptSource } from "../Types.js";
import { atomicWriteFile } from "./AtomicWrite.js";

const log = createLogger("CheckpointStore");

/** Schema version for the checkpoint JSON — independent of the commit-summary schema. */
export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

/**
 * A pre-commit checkpoint memory. Mirrors the topic-bearing core of a
 * `CommitSummary` but is anchored to a synthetic `id` (not a commit hash) and
 * carries its own volatile lifetime markers.
 */
export interface CheckpointRecord {
	readonly version: typeof CHECKPOINT_SCHEMA_VERSION;
	readonly kind: "checkpoint";
	/** Synthetic, filesystem-safe id (the on-disk filename stem). */
	readonly id: string;
	/** Branch the working tree was on when captured. */
	readonly branch: string;
	/** ISO 8601 — when the working-tree state was captured. Drives newest-first sort + supersede cutoff. */
	readonly createdAt: string;
	/** ISO 8601 — when the LLM produced the topics. */
	readonly generatedAt: string;
	readonly recap?: string;
	readonly topics: ReadonlyArray<TopicSummary>;
	readonly diffStats: DiffStats;
	readonly transcriptEntries?: number;
	readonly conversationTurns?: number;
	readonly llm?: LlmCallMetadata;
	/** Source integration of the capturing session(s) (`"claude"` today). */
	readonly source?: TranscriptSource;
	/** Provenance — the session id(s) the checkpoint was generated from. */
	readonly sessionIds?: ReadonlyArray<string>;
	/** Set only on archived records: when it was retired. */
	readonly archivedAt?: string;
	/** Set only on archived records: the commit hash whose summary superseded it. */
	readonly supersededBy?: string;
}

function checkpointsDir(kbRoot: string): string {
	return join(kbRoot, ".jolli", "checkpoints");
}

function archivedDir(kbRoot: string): string {
	return join(checkpointsDir(kbRoot), ".archived");
}

/** True when `id` is a bare filename stem that can't escape the checkpoints dir. */
function isSafeId(id: string): boolean {
	return Boolean(id) && !id.includes("/") && !id.includes("\\") && !id.includes("..");
}

/** Rejects ids that would escape the checkpoints dir — defence in depth at the fs boundary. */
function assertSafeId(id: string): void {
	if (!isSafeId(id)) {
		throw new Error(`unsafe checkpoint id: ${JSON.stringify(id)}`);
	}
}

/** Parse + minimally validate one checkpoint file; returns null (with a warn) on any fault so a corrupt file never breaks a listing. */
async function readOne(path: string): Promise<CheckpointRecord | null> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		log.warn("Failed to read checkpoint %s: %s", path, (err as Error).message);
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as CheckpointRecord;
		if (parsed?.kind !== "checkpoint" || typeof parsed.id !== "string" || typeof parsed.branch !== "string") {
			log.warn("Skipping malformed checkpoint %s (missing kind/id/branch)", path);
			return null;
		}
		// The `id` becomes a path segment (archive/delete build `<dir>/<id>.json`),
		// and it comes from the file CONTENT, not the validated filename. Drop a
		// record whose stored id could escape the checkpoints dir instead of letting
		// `archiveSupersededCheckpoints` write/rm outside it — defence in depth.
		if (!isSafeId(parsed.id)) {
			log.warn("Skipping checkpoint %s with unsafe id %s", path, JSON.stringify(parsed.id));
			return null;
		}
		return parsed;
	} catch (err) {
		log.warn("Skipping unparseable checkpoint %s: %s", path, (err as Error).message);
		return null;
	}
}

/** Write (or overwrite) a checkpoint under `<kbRoot>/.jolli/checkpoints/<id>.json`. */
export async function writeCheckpoint(kbRoot: string, record: CheckpointRecord): Promise<void> {
	assertSafeId(record.id);
	const dir = checkpointsDir(kbRoot);
	await mkdir(dir, { recursive: true });
	await atomicWriteFile(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
	log.info("Wrote checkpoint %s on %s (%d topic(s))", record.id, record.branch, record.topics.length);
}

/**
 * List active checkpoints (newest-captured first), optionally filtered to one
 * branch. Archived records (under `.archived/`) are never returned. A missing
 * checkpoints dir yields `[]`.
 */
export async function listCheckpoints(kbRoot: string, opts?: { branch?: string }): Promise<CheckpointRecord[]> {
	const dir = checkpointsDir(kbRoot);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const out: CheckpointRecord[] = [];
	for (const name of names) {
		// `.archived` is a directory (no `.json` suffix) → skipped here.
		if (!name.endsWith(".json")) continue;
		const rec = await readOne(join(dir, name));
		if (!rec) continue;
		if (opts?.branch !== undefined && rec.branch !== opts.branch) continue;
		out.push(rec);
	}
	out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return out;
}

/** Read one active checkpoint by id, or null if absent/corrupt. */
export async function getCheckpoint(kbRoot: string, id: string): Promise<CheckpointRecord | null> {
	assertSafeId(id);
	return readOne(join(checkpointsDir(kbRoot), `${id}.json`));
}

/** Delete one active checkpoint by id. Idempotent (missing file is a no-op). */
export async function deleteCheckpoint(kbRoot: string, id: string): Promise<void> {
	assertSafeId(id);
	await rm(join(checkpointsDir(kbRoot), `${id}.json`), { force: true });
}

/**
 * Retire the branch's active checkpoints — a durable commit summary now
 * supersedes them. Each is moved into `.jolli/checkpoints/.archived/`, stamped
 * with `archivedAt` and (when given) the `supersededBy` commit hash.
 *
 * `opts.before` (an ISO timestamp, or a lazy async resolver of one) restricts
 * archival to checkpoints captured at or before that instant, so back-filling a
 * memory for an *old* commit — or a rebase replay of one — doesn't wipe
 * checkpoints for work done since. Every commit path (live and in-process) should
 * pass the commit's own date; a resolver is accepted so a caller can defer the
 * lookup (e.g. a git call for the commit date) until we know checkpoints actually
 * exist, keeping the checkpoint-free hot path free of that cost.
 *
 * Returns the number archived. A repo with no checkpoints returns 0 without
 * touching disk beyond a single `readdir` — cheap enough for the hot commit path.
 */
export async function archiveSupersededCheckpoints(
	kbRoot: string,
	branch: string,
	opts?: { readonly before?: string | (() => Promise<string | null>); readonly supersededBy?: string },
): Promise<number> {
	const active = await listCheckpoints(kbRoot, { branch });
	// Resolve `before` only after we know there's something to archive, so a lazy
	// resolver (e.g. a git commit-date lookup) never runs for a checkpoint-free repo.
	if (active.length === 0) return 0;
	let before: string | undefined;
	if (typeof opts?.before === "function") {
		const resolved = await opts.before();
		// A resolver was supplied but couldn't produce a bound (e.g. an unparseable
		// commit date). The caller ASKED to scope archival — archiving everything
		// here could wipe checkpoints captured for later work, which is the opposite
		// of the intent — so archive nothing rather than falling back to "all".
		if (resolved === null) return 0;
		before = resolved;
	} else {
		before = opts?.before;
	}
	const toArchive = before === undefined ? active : active.filter((c) => c.createdAt <= before);
	if (toArchive.length === 0) return 0;

	const dir = checkpointsDir(kbRoot);
	const arch = archivedDir(kbRoot);
	await mkdir(arch, { recursive: true });
	const archivedAt = new Date().toISOString();
	let n = 0;
	for (const c of toArchive) {
		const stamped: CheckpointRecord = {
			...c,
			archivedAt,
			...(opts?.supersededBy ? { supersededBy: opts.supersededBy } : {}),
		};
		try {
			await atomicWriteFile(join(arch, `${c.id}.json`), JSON.stringify(stamped, null, 2));
			await rm(join(dir, `${c.id}.json`), { force: true });
			n++;
		} catch (err) {
			log.warn("Failed to archive checkpoint %s: %s", c.id, (err as Error).message);
		}
	}
	if (n > 0) log.info("Archived %d superseded checkpoint(s) on %s", n, branch);
	return n;
}

/**
 * Upper bound (inclusive) for checkpoint archival, derived from a commit's
 * author date. Returns null when the date can't be parsed.
 *
 * Git author dates (`%aI`) are SECOND-precision, so a naive `new Date(...)
 * .toISOString()` yields `…ss.000Z`. Checkpoint `createdAt` values carry real
 * milliseconds, so a checkpoint captured in the commit's OWN second — the common
 * desktop capture-then-commit flow — has a lexicographically greater timestamp
 * than a `…000Z` bound and would escape the `c.createdAt <= before` filter,
 * lingering forever as a stale "active" checkpoint. Round the bound up to the end
 * of the commit's second so the whole second is inclusive; a checkpoint captured
 * more than a second after the commit is still left untouched.
 */
export function commitSecondUpperBound(dateStr: string): string | null {
	const d = new Date(dateStr);
	if (Number.isNaN(d.getTime())) return null;
	d.setMilliseconds(999);
	return d.toISOString();
}
