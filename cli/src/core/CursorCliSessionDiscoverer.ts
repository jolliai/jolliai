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
 * Pure JSON path → no node:sqlite, no WAL trap, no Node-18 feature gate.
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

export async function scanCursorCliSessions(
	projectDir: string,
	chatsDir: string = getCursorCliChatsDir(),
	projectsDir: string = getCursorCliProjectsDir(),
): Promise<CursorCliScanResult> {
	let hashes: string[];
	try {
		hashes = await readdir(chatsDir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const target = normalizePathForCompare(projectDir);
	const sessions: SessionInfo[] = [];

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
	// The target repo's sessions all share one bucket; remember it once resolved and
	// try it first for the rest (see resolveTranscriptPath).
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
			if (typeof meta.cwd !== "string" || normalizePathForCompare(meta.cwd) !== target) continue;
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
				sessionId: uuid,
				transcriptPath: resolved.path,
				updatedAt: new Date(updatedAtMs).toISOString(),
				source: "cursor-cli",
				...(title ? { title } : {}),
			});
		}
	}
	return { sessions };
}

/** QueueWorker wrapper — strips the error channel. */
export async function discoverCursorCliSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanCursorCliSessions(projectDir);
	if (error) log.warn("Cursor CLI scan error (%s): %s", error.kind, error.message);
	return sessions;
}
