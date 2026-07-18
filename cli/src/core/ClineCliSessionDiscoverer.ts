import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getClineCliSessionsDir } from "./ClineCliDetector.js";
import type { ClineScanError } from "./ClineTranscriptShared.js";
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

export async function scanClineCliSessions(
	projectDir: string,
	sessionsDir: string = getClineCliSessionsDir(),
): Promise<ClineCliScanResult> {
	let ids: string[];
	try {
		ids = await readdir(sessionsDir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const target = normalizePathForCompare(projectDir);
	const sessions: SessionInfo[] = [];

	for (const id of ids) {
		const sidecarPath = join(sessionsDir, id, `${id}.json`);
		let meta: ClineCliSidecar;
		try {
			meta = JSON.parse(await readFile(sidecarPath, "utf8")) as ClineCliSidecar;
		} catch (error: unknown) {
			log.debug("Skipping %s: sidecar read/parse failed (%s)", id, (error as Error).message);
			continue;
		}
		const root = meta.workspace_root ?? meta.cwd;
		if (typeof root !== "string" || normalizePathForCompare(root) !== target) continue;
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
			sessionId: meta.session_id ?? id,
			transcriptPath: messagesPath,
			updatedAt: new Date(mtimeMs).toISOString(),
			source: "cline-cli",
			...(title ? { title } : {}),
		});
	}
	return { sessions };
}

/** QueueWorker wrapper — strips the error channel. */
export async function discoverClineCliSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanClineCliSessions(projectDir);
	if (error) log.warn("Cline CLI scan error (%s): %s", error.kind, error.message);
	return sessions;
}
