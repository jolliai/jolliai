/**
 * Cursor CLI (cursor-agent) Session Discoverer (+ colocated detection)
 *
 * cursor-agent is a DIFFERENT product from Cursor IDE (the `cursor` source).
 * Storage (verified on a real macOS install — see the JOLLI-2023 design spec):
 *   - Authoritative index: ~/.cursor/chats/<md5(cwd)>/<uuid>/meta.json
 *       { cwd, createdAtMs, updatedAtMs, title, hasConversation }  (epoch MS)
 *   - Transcript text:     ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl
 *       plaintext JSONL — located by uuid (the encoded-cwd dir name is a lossy
 *       `/`↔`-` encoding, so we never decode it; the uuid is globally unique).
 * The co-located store.db is a protobuf Merkle-DAG + WAL — deliberately NOT read.
 * Pure JSON path → no node:sqlite, no WAL trap, no Node-floor feature gate.
 *
 * Directory attribution is exact-equality on meta.cwd via normalizePathForCompare,
 * mirroring Devin/OpenCode/Cline CLI: a session started from a repo *subdirectory*
 * is NOT attributed to the repo root. This is the known, intentional hookless
 * limitation — see the "subdirectory" contract test.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
import { normalizePathForCompare } from "./PathUtils.js";

const log = createLogger("CursorCliDiscoverer");
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export interface CursorCliScanError {
	readonly kind: "fs" | "parse";
	readonly message: string;
}
export interface CursorCliScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: CursorCliScanError;
}

interface CursorCliMeta {
	readonly cwd?: string;
	readonly updatedAtMs?: number;
	readonly createdAtMs?: number;
	readonly title?: string;
}

/** ~/.cursor (home-relative on all platforms; cursor-agent uses ~/.cursor on every OS). */
export function getCursorCliDir(home: string = homedir()): string {
	return join(home, ".cursor");
}
export function getCursorCliChatsDir(home: string = homedir()): string {
	return join(getCursorCliDir(home), "chats");
}
export function getCursorCliProjectsDir(home: string = homedir()): string {
	return join(getCursorCliDir(home), "projects");
}

/** Detected when the chats/ dir exists — pure JSON/JSONL, so no hasNodeSqliteSupport() gate. */
export async function isCursorCliInstalled(home: string = homedir()): Promise<boolean> {
	try {
		return (await stat(getCursorCliChatsDir(home))).isDirectory();
	} catch {
		return false;
	}
}

/** Is projects/<bucket>/agent-transcripts/<uuid>/<uuid>.jsonl a readable file? */
async function transcriptInBucket(projectsDir: string, bucket: string, uuid: string): Promise<string | undefined> {
	const candidate = join(projectsDir, bucket, "agent-transcripts", uuid, `${uuid}.jsonl`);
	try {
		return (await stat(candidate)).isFile() ? candidate : undefined;
	} catch {
		return undefined; // not this project bucket
	}
}

/**
 * Locate the plaintext JSONL transcript for `uuid` under projects/<any>/agent-transcripts/,
 * returning both the path and the bucket it lived in.
 * `projectBuckets` is the projects/ listing, read once by the caller — re-reading it
 * per session was O(sessions × dirents) for no benefit (the listing is stable per scan).
 * Every session of a single repo lives in the *same* projects/<encoded-cwd> bucket, but
 * the encoding is lossy so we can't derive it — instead the caller feeds back the last
 * `preferredBucket` we resolved, which we try first, collapsing the per-session lookup
 * from O(buckets) to O(1) once the repo's bucket is known.
 */
async function resolveTranscriptPath(
	projectsDir: string,
	projectBuckets: readonly string[],
	uuid: string,
	preferredBucket?: string,
): Promise<{ path: string; bucket: string } | undefined> {
	if (preferredBucket !== undefined) {
		const hit = await transcriptInBucket(projectsDir, preferredBucket, uuid);
		if (hit !== undefined) return { path: hit, bucket: preferredBucket };
	}
	for (const p of projectBuckets) {
		const hit = await transcriptInBucket(projectsDir, p, uuid);
		if (hit !== undefined) return { path: hit, bucket: p };
	}
	return undefined;
}

/**
 * Scans ~/.cursor/chats for cursor-agent sessions attributed to `projectDir`.
 *
 * @param windowMs Optional staleness window, in milliseconds. Defaults to
 * `SESSION_STALE_MS` (48h), the window shared by every discovery-based source.
 * The dashboard's history back-fill passes a wider one (7 days) so it can reach
 * further into the past. Callers that must NOT widen simply omit it: the VS Code
 * / IntelliJ "Active Conversations" sidebar, `jolli status`, and above all the
 * post-commit summary generation in `hooks/QueueWorker.ts`, which uses this
 * session set to decide which conversations belong to the commit being
 * summarised. Widening it there folds week-old unrelated conversations into that
 * commit's stored memory, which is written to the git orphan branch and is
 * persistent — and it fails invisibly, with no error, just wrong content.
 */
export async function scanCursorCliSessions(
	projectDir: string,
	chatsDir: string = getCursorCliChatsDir(),
	projectsDir: string = getCursorCliProjectsDir(),
	windowMs?: number,
): Promise<CursorCliScanResult> {
	const { sessions, error } = await scanCursorCliSessionsOnDisk(chatsDir, projectsDir, windowMs);
	const mine = cursorCliSessionsForRepo(sessions, projectDir);
	return error ? { sessions: mine, error } : { sessions: mine };
}

/** A machine-wide cursor-agent scan: every in-window session, plus a genuine failure. */
export interface CursorCliDiskScanResult {
	readonly sessions: ReadonlyArray<DiskSession>;
	readonly error?: CursorCliScanError;
}

/**
 * Scans `~/.cursor/chats` once and returns every in-window cursor-agent session, each
 * carrying the `cwd` its `meta.json` recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. The `chats/<md5(cwd)>/` buckets cannot
 * be derived from a repo path (the hash input is not part of cursor-agent's
 * contract), so every bucket has to be opened and every `meta.json` parsed — once per
 * registered repo, under the old repo-scoped shape. Callers scan once and narrow with
 * {@link cursorCliSessionsForRepo}.
 *
 * ## One cost moved rather than removed
 *
 * The repo-scoped version resolved a session's transcript path only AFTER the cwd
 * matched, so a machine-wide scan does that lookup for sessions no repo will claim.
 * It is bounded — `resolveTranscriptPath` tries the remembered bucket first, and
 * every session under one `chats/<hash>` shares a cwd and therefore a bucket, so the
 * lookup stays O(1) after the first hit in each bucket — and it is paid ONCE for the
 * run instead of once per repo. With two or more registered repos this is strictly
 * cheaper; with exactly one it does more `stat` calls than before. That trade is
 * deliberate: the back-fill is the multi-repo caller, and the single-repo path
 * (`discoverCursorCliSessions`, the post-commit hook) still goes through the wrapper
 * above, which scans and narrows in one call just as it always did.
 */
export async function scanCursorCliSessionsOnDisk(
	chatsDir: string = getCursorCliChatsDir(),
	projectsDir: string = getCursorCliProjectsDir(),
	windowMs?: number,
): Promise<CursorCliDiskScanResult> {
	let hashes: string[];
	try {
		hashes = await readdir(chatsDir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const staleMs = windowMs ?? SESSION_STALE_MS;
	const cutoffMs = Date.now() - staleMs;
	const sessions: DiskSession[] = [];

	// Read the projects/ listing once — resolveTranscriptPath reuses it for every
	// matching session. A MISSING projects/ dir (ENOENT) is benign: chats can exist
	// before any transcript is written, so it degrades to an empty listing and every
	// session skips. Any OTHER failure (EACCES, or cursor-agent renaming projects/)
	// is a whole-source failure — with no buckets no transcript can be resolved — so
	// surface it via the error channel instead of silently reporting "0 sessions".
	// Mirrors the ENOENT-vs-other split on the chats readdir above; without it a
	// permission/schema-drift failure looks healthy-empty to the aggregator's
	// failedSources set and the status "Cursor" row.
	let projectBuckets: string[];
	try {
		projectBuckets = await readdir(projectsDir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
		}
		projectBuckets = [];
	}
	// Every session under one chats/<hash> shares a cwd and therefore one projects/
	// bucket, so remembering the last resolved bucket keeps the lookup O(1) within a
	// hash. Carried across hashes too — a miss just falls through to the full sweep.
	let preferredBucket: string | undefined;

	for (const hash of hashes) {
		let uuids: string[];
		try {
			uuids = await readdir(join(chatsDir, hash));
		} catch {
			continue; // a stray file at chats/<hash> — skip
		}
		for (const uuid of uuids) {
			let meta: CursorCliMeta;
			try {
				meta = JSON.parse(await readFile(join(chatsDir, hash, uuid, "meta.json"), "utf8")) as CursorCliMeta;
			} catch (error: unknown) {
				log.debug("Skipping %s: meta.json read/parse failed (%s)", uuid, (error as Error).message);
				continue;
			}
			// The cwd is CARRIED, not matched — `cursorCliSessionsForRepo` does that. A
			// session without one can never be attributed, so it is still dropped here.
			if (typeof meta.cwd !== "string") continue;
			const updatedAtMs = meta.updatedAtMs ?? meta.createdAtMs;
			if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) {
				log.warn("Skipping Cursor CLI session %s: non-finite updatedAtMs", uuid);
				continue;
			}
			if (updatedAtMs < cutoffMs) continue;
			const resolved = await resolveTranscriptPath(projectsDir, projectBuckets, uuid, preferredBucket);
			if (!resolved) {
				log.debug("Skipping Cursor CLI session %s: no transcript JSONL found", uuid);
				continue;
			}
			preferredBucket = resolved.bucket;
			const title = meta.title?.trim();
			sessions.push({
				session: {
					sessionId: uuid,
					transcriptPath: resolved.path,
					updatedAt: new Date(updatedAtMs).toISOString(),
					source: "cursor-cli",
					...(title ? { title } : {}),
				},
				dirs: [meta.cwd],
			});
		}
	}
	return { sessions };
}

/**
 * Narrows a machine-wide cursor-agent scan to one repo.
 *
 * Attribution is EXACT equality on `meta.cwd`, verbatim from when it ran inside the
 * scan — mirroring Devin/OpenCode/Cline CLI's spelling but NOT the prefix/containment
 * rule: a session started from a repo *subdirectory* is not attributed to the root.
 * That is the known, intentional hookless limitation — see the "subdirectory"
 * contract test.
 */
export function cursorCliSessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const target = normalizePathForCompare(projectDir);
	return sessionsForRepo(scanned, (dir) => normalizePathForCompare(dir) === target);
}

/**
 * QueueWorker wrapper — strips the error channel.
 *
 * `windowMs` is forwarded verbatim. QueueWorker itself must keep omitting it —
 * see `scanCursorCliSessions` for why widening the post-commit window corrupts
 * stored memory.
 */
export async function discoverCursorCliSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	// The two `undefined`s keep the ~/.cursor chats/projects defaults; only the
	// trailing staleness window is being overridden here.
	const { sessions, error } = await scanCursorCliSessions(projectDir, undefined, undefined, windowMs);
	if (error) log.warn("Cursor CLI scan error (%s): %s", error.kind, error.message);
	return sessions;
}
