import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getClineStorageDirs } from "./ClineDetector.js";
import type { ClineScanError } from "./ClineTranscriptShared.js";
import { normalizePathForCompare } from "./PathUtils.js";

const log = createLogger("ClineDiscoverer");
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export type { ClineScanError };

export interface ClineScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: ClineScanError;
}

interface TaskHistoryEntry {
	readonly id?: string;
	readonly ts?: number;
	readonly task?: string;
	readonly cwdOnTaskInitialization?: string;
}

async function scanFlavor(storageDir: string, target: string, cutoffMs: number): Promise<SessionInfo[]> {
	const historyPath = join(storageDir, "state", "taskHistory.json");
	let entries: TaskHistoryEntry[];
	try {
		const parsed = JSON.parse(await readFile(historyPath, "utf8")) as unknown;
		entries = Array.isArray(parsed) ? (parsed as TaskHistoryEntry[]) : [];
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const out: SessionInfo[] = [];
	for (const e of entries) {
		if (typeof e.id !== "string" || typeof e.cwdOnTaskInitialization !== "string") continue;
		if (normalizePathForCompare(e.cwdOnTaskInitialization) !== target) continue;
		// `ts` is the task's updatedAt (always present in real taskHistory). Require
		// it: an entry without a numeric ts has no basis to be judged fresh, so treat
		// it as stale rather than surfacing it with a fabricated `Date.now()` stamp.
		if (typeof e.ts !== "number" || e.ts < cutoffMs) continue;
		const title = e.task?.trim();
		out.push({
			sessionId: e.id,
			transcriptPath: join(storageDir, "tasks", e.id, "api_conversation_history.json"),
			updatedAt: new Date(e.ts).toISOString(),
			source: "cline",
			...(title ? { title } : {}),
		});
	}
	return out;
}

export async function scanClineSessions(
	projectDir: string,
	storageDirs: string[] = getClineStorageDirs(),
): Promise<ClineScanResult> {
	const target = normalizePathForCompare(projectDir);
	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const sessions: SessionInfo[] = [];
	let error: ClineScanError | undefined;
	for (const dir of storageDirs) {
		try {
			sessions.push(...(await scanFlavor(dir, target, cutoffMs)));
		} catch (err: unknown) {
			log.warn("Cline flavor scan failed at %s: %s", dir, (err as Error).message);
			// Malformed taskHistory.json throws a SyntaxError (parse); anything else
			// reaching here is a filesystem error (e.g. EACCES) — don't mislabel it.
			const kind = err instanceof SyntaxError ? "parse" : "fs";
			error = error ?? { kind, message: (err as Error).message };
		}
	}
	return error ? { sessions, error } : { sessions };
}

/** QueueWorker wrapper — strips the error channel. */
export async function discoverClineSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanClineSessions(projectDir);
	if (error) log.warn("Cline scan error (%s): %s", error.kind, error.message);
	return sessions;
}
