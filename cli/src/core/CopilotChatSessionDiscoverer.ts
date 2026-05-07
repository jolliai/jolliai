/**
 * VS Code Copilot Chat session discoverer.
 *
 * Two scans run in sequence; results are concatenated:
 *
 *   Scan A — chat panel "New Chat" with copilotcli-backend models:
 *     ~/.copilot/session-state/<sid>/events.jsonl
 *     gated by vscode.metadata.json.workspaceFolder.folderPath === projectDir
 *
 *   Scan B — chat panel "New Chat" with non-copilotcli-backend models:
 *     <userDataDir>/User/workspaceStorage/<wsHash>/chatSessions/<sid>.jsonl
 *     wsHash resolved via VscodeWorkspaceLocator from projectDir
 *
 * Sessions older than 48h are excluded (matches every other discovery-based
 * source: OpenCode / Cursor / Copilot CLI). The deprecated .json snapshot
 * format is explicitly NOT read — see spec for rationale.
 *
 * The standalone `copilot` source (CopilotSessionDiscoverer reading
 * session-store.db) covers the "New Copilot CLI Session" entry point, which
 * is just a vscode-spawned terminal running the copilot binary.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import type { CopilotChatScanError } from "./CopilotChatTranscriptReader.js";
import {
	findVscodeWorkspaceHash,
	getVscodeWorkspaceStorageDir,
	normalizePathForMatch,
} from "./VscodeWorkspaceLocator.js";

const log = createLogger("CopilotChatDiscoverer");

const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export type { CopilotChatScanError };

export interface CopilotChatScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: CopilotChatScanError;
}

interface VscodeMetadata {
	workspaceFolder?: { folderPath?: string };
}

/**
 * Scan A: ~/.copilot/session-state/<sid>/events.jsonl gated by folderPath.
 * Returns sessions and an optional error when readdir of the root fails for
 * non-ENOENT reasons.
 */
async function scanSessionState(projectDir: string): Promise<CopilotChatScanResult> {
	const root = join(homedir(), ".copilot", "session-state");
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		log.error("readdir %s failed (%s): %s", root, code ?? "unknown", (error as Error).message);
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const target = normalizePathForMatch(projectDir);
	const sessions: SessionInfo[] = [];

	for (const sid of entries) {
		const sessionDir = join(root, sid);
		const metaPath = join(sessionDir, "vscode.metadata.json");
		const eventsPath = join(sessionDir, "events.jsonl");

		let meta: VscodeMetadata;
		try {
			meta = JSON.parse(await readFile(metaPath, "utf8")) as VscodeMetadata;
		} catch (error: unknown) {
			log.debug("Skipping %s: vscode.metadata.json read/parse failed (%s)", sid, (error as Error).message);
			continue;
		}

		const folderPath = meta.workspaceFolder?.folderPath;
		if (typeof folderPath !== "string" || folderPath.length === 0) continue;
		if (normalizePathForMatch(folderPath) !== target) continue;

		let mtimeMs: number;
		try {
			mtimeMs = (await stat(eventsPath)).mtimeMs;
		} catch (error: unknown) {
			log.debug("Skipping %s: events.jsonl stat failed (%s)", sid, (error as Error).message);
			continue;
		}
		if (mtimeMs < cutoffMs) continue;

		sessions.push({
			sessionId: sid,
			transcriptPath: eventsPath,
			updatedAt: new Date(mtimeMs).toISOString(),
			source: "copilot-chat",
		});
	}

	return { sessions };
}

/**
 * Scan B: <wsHash>/chatSessions/<sid>.jsonl. Skips .json snapshot files
 * (deprecated). Returns sessions and an optional error on non-ENOENT readdir
 * failure.
 */
async function scanChatSessions(projectDir: string): Promise<CopilotChatScanResult> {
	const wsHash = await findVscodeWorkspaceHash("Code", projectDir);
	if (wsHash === null) {
		log.debug("No vscode workspace matched %s", projectDir);
		return { sessions: [] };
	}
	const dir = join(getVscodeWorkspaceStorageDir("Code"), wsHash, "chatSessions");

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		log.error("readdir %s failed (%s): %s", dir, code ?? "unknown", (error as Error).message);
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const sessions: SessionInfo[] = [];

	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue; // skip .json snapshots and other suffixes
		const path = join(dir, entry);
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(path)).mtimeMs;
		} catch (error: unknown) {
			log.debug("Skipping %s: stat failed (%s)", entry, (error as Error).message);
			continue;
		}
		if (mtimeMs < cutoffMs) continue;
		const sessionId = entry.slice(0, -".jsonl".length);
		sessions.push({
			sessionId,
			transcriptPath: path,
			updatedAt: new Date(mtimeMs).toISOString(),
			source: "copilot-chat",
		});
	}

	return { sessions };
}

/**
 * Runs Scan A then Scan B; concatenates sessions; returns the first error
 * encountered (subsequent are debug-logged).
 */
export async function scanCopilotChatSessions(projectDir: string): Promise<CopilotChatScanResult> {
	const a = await scanSessionState(projectDir);
	const b = await scanChatSessions(projectDir);
	const sessions = [...a.sessions, ...b.sessions];
	const error = a.error ?? b.error;
	if (a.error && b.error) {
		log.debug("Both scans errored; reporting Scan A's, dropped Scan B's: %s", b.error.message);
	}
	if (sessions.length > 0) {
		log.info("Discovered %d Copilot Chat session(s) for %s", sessions.length, projectDir);
	}
	return { sessions, error };
}

/** Convenience wrapper used by QueueWorker — strips the error channel. */
export async function discoverCopilotChatSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanCopilotChatSessions(projectDir);
	if (error) {
		log.warn("Copilot Chat scan error (%s) — sessions excluded from this run: %s", error.kind, error.message);
	}
	return sessions;
}
