import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getClineCliSessionsDir } from "./ClineCliDetector.js";
import type { ClineScanError } from "./ClineTranscriptShared.js";
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
import { normalizePathForCompare } from "./PathUtils.js";

const log = createLogger("ClineCliDiscoverer");
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export type { ClineScanError };

export interface ClineCliScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: ClineScanError;
}

interface ClineCliSidecar {
	readonly session_id?: string;
	readonly cwd?: string;
	readonly workspace_root?: string;
	readonly messages_path?: string;
	readonly metadata?: { readonly title?: string };
}

/**
 * @param windowMs Optional session-staleness window in milliseconds, defaulting to
 * the 48-hour {@link SESSION_STALE_MS}. Only the dashboard's history back-fill passes
 * a wider one (7 days); every caller that must NOT widen simply omits it — the
 * "Active Conversations" sidebar, `jolli status`, and above all the post-commit
 * summary generation in `hooks/QueueWorker.ts`, which uses this window to decide
 * which conversations belong to the commit being summarised. A wider window there
 * would pull unrelated week-old conversations into that commit's stored memory,
 * which is persisted to the git orphan branch and fails silently — no error, just
 * wrong content.
 */
export async function scanClineCliSessions(
	projectDir: string,
	sessionsDir: string = getClineCliSessionsDir(),
	windowMs?: number,
): Promise<ClineCliScanResult> {
	const { sessions, error } = await scanClineCliSessionsOnDisk(sessionsDir, windowMs);
	const mine = clineCliSessionsForRepo(sessions, projectDir);
	return error ? { sessions: mine, error } : { sessions: mine };
}

/** A machine-wide Cline CLI scan: every in-window session, plus a genuine failure. */
export interface ClineCliDiskScanResult {
	readonly sessions: ReadonlyArray<DiskSession>;
	readonly error?: ClineScanError;
}

/**
 * Scans Cline CLI's sessions directory once and returns the in-window sessions, each
 * carrying the workspace root its sidecar recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. `~/.cline/sessions/` holds every
 * project's sessions in one flat directory keyed by session id, so the workspace root
 * is only knowable by opening each sidecar JSON — which a repo-scoped scan then does
 * again for the next repo. Callers scan once and narrow with
 * {@link clineCliSessionsForRepo}.
 *
 * One cost moves rather than disappearing: the repo-scoped version `stat`ed a
 * session's messages file only AFTER its workspace root matched, so this now stats
 * sessions no repo will claim. It is one `stat` per session, paid once for the run
 * instead of once per repo — cheaper from two repos on, marginally dearer with one.
 * The single-repo callers still go through the wrapper above, which scans and narrows
 * in one call exactly as before.
 */
export async function scanClineCliSessionsOnDisk(
	sessionsDir: string = getClineCliSessionsDir(),
	windowMs?: number,
): Promise<ClineCliDiskScanResult> {
	let ids: string[];
	try {
		ids = await readdir(sessionsDir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const staleMs = windowMs ?? SESSION_STALE_MS;
	const cutoffMs = Date.now() - staleMs;
	const sessions: DiskSession[] = [];

	for (const id of ids) {
		const sidecarPath = join(sessionsDir, id, `${id}.json`);
		let meta: ClineCliSidecar;
		try {
			meta = JSON.parse(await readFile(sidecarPath, "utf8")) as ClineCliSidecar;
		} catch (error: unknown) {
			log.debug("Skipping %s: sidecar read/parse failed (%s)", id, (error as Error).message);
			continue;
		}
		// A sidecar with no workspace root of either spelling can never be attributed,
		// so it is dropped here rather than carried with an empty directory list.
		const root = meta.workspace_root ?? meta.cwd;
		if (typeof root !== "string") continue;
		// Trust the sidecar's messages_path only when absolute — a relative value
		// (or one synced from another machine) would stat against process.cwd() and
		// silently drop a live session. Fall back to the canonical per-session path.
		const messagesPath =
			typeof meta.messages_path === "string" && isAbsolute(meta.messages_path)
				? meta.messages_path
				: join(sessionsDir, id, `${id}.messages.json`);
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(messagesPath)).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs < cutoffMs) continue;
		const title = meta.metadata?.title?.trim();
		sessions.push({
			session: {
				sessionId: meta.session_id ?? id,
				transcriptPath: messagesPath,
				updatedAt: new Date(mtimeMs).toISOString(),
				source: "cline-cli",
				...(title ? { title } : {}),
			},
			dirs: [root],
		});
	}
	return { sessions };
}

/**
 * Narrows a machine-wide Cline CLI scan to one repo.
 *
 * Attribution is EXACT equality on the sidecar's `workspace_root` (falling back to
 * `cwd`), verbatim from when it ran inside the scan — deliberately not the
 * prefix/containment rule the SQLite-backed sources use. A session started from a
 * subdirectory is NOT attributed; see this source's "subdirectory" contract test.
 */
export function clineCliSessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const target = normalizePathForCompare(projectDir);
	return sessionsForRepo(scanned, (dir) => normalizePathForCompare(dir) === target);
}

/**
 * QueueWorker wrapper — strips the error channel.
 *
 * @param windowMs Optional staleness window in milliseconds, forwarded verbatim; see
 * {@link scanClineCliSessions} for the default and for who may widen it.
 */
export async function discoverClineCliSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	// `undefined` for sessionsDir so the scan applies its own detector default —
	// spelling it here would duplicate that default at the call site.
	const { sessions, error } = await scanClineCliSessions(projectDir, undefined, windowMs);
	if (error) log.warn("Cline CLI scan error (%s): %s", error.kind, error.message);
	return sessions;
}
