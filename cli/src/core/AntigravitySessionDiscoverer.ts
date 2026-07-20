/**
 * Antigravity Session Discoverer
 *
 * On-demand scanner for Antigravity conversations. Each conversation is a
 * per-conversation SQLite db under `~/.gemini/<variant>/conversations/<id>.db`
 * whose `trajectory_metadata_blob(id='main')` protobuf records the workspace
 * `file://` URI (used to scope the conversation to a repo). The readable
 * transcript is a sibling plaintext JSONL at
 * `~/.gemini/<variant>/brain/<id>/.system_generated/logs/transcript_full.jsonl`.
 *
 * Unlike Cursor (which needs a VS Code workspace-hash lookup), Antigravity
 * records the workspace path inside each conversation db, so attribution is a
 * direct per-db comparison against projectDir.
 *
 * The db is WAL-mode; reads go through `withSqliteDb` (node:sqlite, WAL-aware).
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getAntigravityVariants } from "./AntigravityDetector.js";
import { unwrapUserRequest } from "./AntigravityTranscriptReader.js";
import { listWorktrees } from "./GitOps.js";
import { normalizePathForCompare } from "./PathUtils.js";
import { classifyScanError, hasNodeSqliteSupport, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("AntigravityDiscoverer");

/** Conversations older than 48 hours are considered stale (matches other sources). */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

const TRANSCRIPT_RELPATH = [".system_generated", "logs", "transcript_full.jsonl"] as const;
const FILE_URI_PREFIX = "file://";

export interface AntigravityScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	/** Present only on a genuine (non-ENOENT) scan failure. */
	readonly error?: SqliteScanError;
}

/**
 * Recovers the workspace path from a `trajectory_metadata_blob`. The blob is
 * protobuf; rather than decode the full schema we locate the first `file://`
 * string-field *value* and read it using its length prefix.
 *
 * A protobuf `string` field is encoded as `<tag> <varint length> <bytes>`, so
 * the byte immediately before the value is the terminal byte of a length
 * varint. Reading that length gives the exact field bytes — robust even when
 * the following field's tag byte is itself printable (e.g. `0x3a` = ':'), which
 * a "scan until control byte" heuristic would run straight past.
 */
export function extractWorkspacePath(blob: Uint8Array): string | undefined {
	const buf = Buffer.from(blob);
	const idx = buf.toString("latin1").indexOf(FILE_URI_PREFIX);
	if (idx <= 0) return undefined;

	// Walk back over the length varint (its non-terminal bytes have MSB set).
	let start = idx - 1;
	while (start > 0 && (buf[start - 1] & 0x80) !== 0) start--;
	let len = 0;
	let shift = 0;
	for (let p = start; p <= idx - 1; p++) {
		len |= (buf[p] & 0x7f) << shift;
		shift += 7;
	}
	if (len < FILE_URI_PREFIX.length || idx + len > buf.length) return undefined;

	const value = buf.toString("utf8", idx, idx + len);
	if (!value.startsWith(FILE_URI_PREFIX)) return undefined;
	// Antigravity is VS Code-based; the recorded URI is percent-encoded
	// (`Uri.toString()`), so spaces / non-ASCII segments arrive as %XX and must
	// be decoded before the on-disk path comparison. Fall back to the raw slice
	// if the value carries a malformed %-escape.
	let path = value.slice(FILE_URI_PREFIX.length);
	try {
		path = decodeURIComponent(path);
	} catch {
		// malformed %-escape: keep the raw slice
	}
	// On Windows the drive is encoded as `file:///C:/…`, so the slice leaves a
	// spurious leading slash before the drive letter (`/C:/…`). Strip it so the
	// result matches a native `C:\…` path once normalized — otherwise
	// `normalizePathForCompare` keeps the leading `/` and the workspace never
	// matches projectDir. POSIX paths (`/Users/…`) have no drive letter and are
	// left untouched.
	if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
	return path;
}

/**
 * Streams the transcript line-by-line and returns the first USER_INPUT's
 * unwrapped request text as a title (undefined if none / unreadable). Streaming
 * with early-exit avoids loading a multi-MB transcript into memory just to read
 * a title, and the underlying fd is always destroyed.
 */
async function readTitle(transcriptPath: string): Promise<string | undefined> {
	try {
		const stream = createReadStream(transcriptPath, { encoding: "utf8" });
		const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		try {
			for await (const line of rl) {
				if (!line.trim()) continue;
				let obj: Record<string, unknown>;
				try {
					obj = JSON.parse(line);
				} catch {
					continue;
				}
				if (obj.type !== "USER_INPUT" || typeof obj.content !== "string") continue;
				const text = unwrapUserRequest(obj.content);
				if (text) return text.length > 120 ? `${text.slice(0, 120)}…` : text;
			}
		} finally {
			rl.close();
			stream.destroy();
		}
	} catch (err) {
		if (!isEnoent(err)) log.debug("readTitle stream failed for %s: %s", transcriptPath, errMsg(err));
	}
	return undefined;
}

/**
 * Resolves the normalized set of worktree roots for the repo containing
 * `projectDir`. Antigravity records the checkout the IDE was opened in, which is
 * frequently a *different* worktree than the one committing (e.g. the IDE sits
 * on the main checkout while commits happen from a linked feature worktree), so
 * a plain `workspacePath === projectDir` match drops the conversation. Matching
 * against every worktree root attributes the conversation to the same repo
 * regardless of which worktree runs the hook. Falls back to exact-match on
 * `projectDir` when git is unavailable or the dir is not inside a repo.
 */
async function resolveWorktreeRoots(projectDir: string): Promise<ReadonlySet<string>> {
	const roots = new Set<string>([normalizePathForCompare(projectDir)]);
	try {
		for (const wt of await listWorktrees(projectDir)) roots.add(normalizePathForCompare(wt));
	} catch (err) {
		log.debug("listWorktrees failed for %s (falling back to exact match): %s", projectDir, errMsg(err));
	}
	return roots;
}

/** Discovers Antigravity conversations relevant to the given project directory. */
export async function scanAntigravitySessions(projectDir: string, home?: string): Promise<AntigravityScanResult> {
	// Node < 22.5 lacks node:sqlite. Gate up front (like the detector) so the
	// aggregator's 60s tick on a Node 18 VS Code host degrades silently instead
	// of logging a scan failure for every conversation db. The QueueWorker path
	// already gates via isAntigravityInstalled(); this covers direct-scan callers.
	/* v8 ignore start -- only reachable on Node < 22.5; the discoverer suite is describe.skip there */
	if (!hasNodeSqliteSupport()) return { sessions: [] };
	/* v8 ignore stop */

	const worktreeRoots = await resolveWorktreeRoots(projectDir);
	const cutoffMs = Date.now() - SESSION_STALE_MS;
	// Keyed by conversation id. The same convId can exist under multiple variants
	// (a user who migrated between `antigravity` / `antigravity-ide` / `-cli`
	// keeps the id), which would otherwise surface the conversation once per
	// variant. Keep the most-recently-touched copy.
	const byConvId = new Map<string, { transcriptPath: string; mtimeMs: number }>();
	let firstError: SqliteScanError | undefined;

	for (const variant of getAntigravityVariants(home)) {
		let dbFiles: string[];
		try {
			dbFiles = readdirSync(variant.conversationsDir).filter((f) => f.endsWith(".db"));
		} catch (err) {
			log.debug("Cannot list %s: %s", variant.conversationsDir, errMsg(err));
			continue;
		}

		for (const dbFile of dbFiles) {
			const convId = dbFile.slice(0, -3);
			const dbPath = join(variant.conversationsDir, dbFile);

			// Cheap staleness gate first — a `stat` avoids opening SQLite for
			// conversations last touched > 48h ago (the common case for users
			// with a long Antigravity history).
			let mtimeMs: number;
			try {
				mtimeMs = statSync(dbPath).mtimeMs;
			} catch {
				continue;
			}
			if (mtimeMs < cutoffMs) continue;

			// Skip the SQLite open + blob parse when a newer variant of this same
			// conversation was already accepted.
			const existing = byConvId.get(convId);
			if (existing && existing.mtimeMs >= mtimeMs) continue;

			let workspacePath: string | undefined;
			try {
				workspacePath = await withSqliteDb(dbPath, (db) => {
					const row = db
						.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
						.get() as { data?: Uint8Array } | undefined;
					return row?.data ? extractWorkspacePath(row.data) : undefined;
				});
			} catch (err) {
				const scanError = classifyScanError(err);
				if (scanError) {
					log.warn("Antigravity db scan failed (%s) at %s: %s", scanError.kind, dbPath, scanError.message);
					firstError ??= scanError;
				}
				continue;
			}

			if (!workspacePath || !worktreeRoots.has(normalizePathForCompare(workspacePath))) continue;

			const transcriptPath = join(variant.brainDir, convId, ...TRANSCRIPT_RELPATH);
			if (!existsSync(transcriptPath)) {
				log.debug("Antigravity convo %s matches %s but has no transcript_full.jsonl yet", convId, projectDir);
				continue;
			}

			byConvId.set(convId, { transcriptPath, mtimeMs });
		}
	}

	// Read titles only for the survivors (one per conversation), not per variant.
	const out: SessionInfo[] = [];
	for (const [convId, { transcriptPath, mtimeMs }] of byConvId) {
		out.push({
			sessionId: convId,
			transcriptPath,
			updatedAt: new Date(mtimeMs).toISOString(),
			source: "antigravity",
			title: await readTitle(transcriptPath),
		});
	}

	log.debug("Discovered %d Antigravity session(s) for %s", out.length, projectDir);
	return firstError ? { sessions: out, error: firstError } : { sessions: out };
}

/**
 * Backwards-compatible wrapper that returns only the session array. Callers that
 * need to surface scan failures should call `scanAntigravitySessions` directly.
 */
export async function discoverAntigravitySessions(
	projectDir: string,
	home?: string,
): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanAntigravitySessions(projectDir, home);
	return sessions;
}
