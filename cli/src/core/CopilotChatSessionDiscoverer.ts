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
 * Sessions older than 48h are excluded by default (matches every other
 * discovery-based source: OpenCode / Cursor / Copilot CLI); a caller may widen
 * that with the optional `windowMs` argument. The deprecated .json snapshot
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
import { mapWithConcurrency, withIoBudget } from "../util/Concurrency.js";
import type { CopilotChatScanError } from "./CopilotChatTranscriptReader.js";
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
import {
	getVscodeWorkspaceStorageDir,
	listVscodeWorkspaceFolders,
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
 * Scan A: ~/.copilot/session-state/<sid>/events.jsonl, carrying each session's
 * recorded `workspaceFolder.folderPath`. Returns sessions and an optional error when
 * readdir of the root fails for non-ENOENT reasons.
 *
 * Machine-wide, so this `stat`s the events file of sessions no repo will claim — the
 * repo-scoped version checked the folder first. One `stat` per session, paid once for
 * the run rather than once per repo.
 *
 * `windowMs` overrides the staleness window — see `scanCopilotChatSessions` for
 * what may and may not widen it. Scan B has its own copy of this gate; both must
 * honour the override or half the discovery silently stays at 48h.
 */
async function scanSessionState(windowMs?: number): Promise<CopilotChatDiskScanResult> {
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

	const staleMs = windowMs ?? SESSION_STALE_MS;
	const cutoffMs = Date.now() - staleMs;

	// One metadata read plus one `stat` per session, all independent — fanned out
	// rather than looped, each unit taking a slot from the shared budget so this cannot
	// widen the process-wide total on its own.
	const scanned = await mapWithConcurrency(entries, async (sid): Promise<DiskSession | null> => {
		const sessionDir = join(root, sid);
		const metaPath = join(sessionDir, "vscode.metadata.json");
		const eventsPath = join(sessionDir, "events.jsonl");

		let meta: VscodeMetadata;
		try {
			meta = JSON.parse(await withIoBudget(0, () => readFile(metaPath, "utf8"))) as VscodeMetadata;
		} catch (error: unknown) {
			log.debug("Skipping %s: vscode.metadata.json read/parse failed (%s)", sid, (error as Error).message);
			return null;
		}

		// The folder is CARRIED, not matched. A session that records none can never be
		// attributed, so it is still dropped here.
		const folderPath = meta.workspaceFolder?.folderPath;
		if (typeof folderPath !== "string" || folderPath.length === 0) return null;

		let mtimeMs: number;
		try {
			mtimeMs = (await withIoBudget(0, () => stat(eventsPath))).mtimeMs;
		} catch (error: unknown) {
			log.debug("Skipping %s: events.jsonl stat failed (%s)", sid, (error as Error).message);
			return null;
		}
		if (mtimeMs < cutoffMs) return null;

		return {
			session: {
				sessionId: sid,
				transcriptPath: eventsPath,
				updatedAt: new Date(mtimeMs).toISOString(),
				source: "copilot-chat",
			},
			dirs: [folderPath],
		};
	});

	return { sessions: scanned.filter((session): session is DiskSession => session !== null) };
}

/**
 * Scan B: every workspace's `<wsHash>/chatSessions/<sid>.jsonl`, each session
 * carrying the folder that workspace opens. Skips `.json` snapshot files
 * (deprecated). Returns sessions and the first non-ENOENT readdir failure.
 *
 * This is the half that had to be INVERTED to become machine-wide. It used to
 * resolve one `wsHash` from `projectDir` and read that single directory — an
 * approach that can only ever answer for the repo you already hold, so serving N
 * repos meant re-reading every `workspace.json` on the machine N times. Listing the
 * workspaces once and carrying each one's folder gives every repo its answer from the
 * same pass.
 *
 * ## `onlyFolder` is the repo-scoped callers' way back to their old cost
 *
 * Reading every workspace is right for the back-fill and pure loss for a caller that
 * holds one repo — the 60 s sidebar tick, `jolli status`, the post-commit summary. Each
 * of those used to resolve its own `wsHash` and `readdir` one `chatSessions/`; without
 * this parameter they instead pay a `readdir` per workspace plus a `stat` per session
 * file, machine-wide, on every tick.
 *
 * It is a FILTER on the same loop rather than a second code path, which is what keeps
 * the two answers from drifting: `normalizePathForMatch` equality is the attribution
 * rule either way, the same one {@link copilotChatSessionsForRepo} applies afterwards,
 * so a directed scan returns exactly the subset the machine-wide one would have been
 * narrowed to. Note it is deliberately NOT `findVscodeWorkspaceHash`, which stops at
 * the FIRST match — a folder opened under two workspace entries (routine: VS Code mints
 * a new one per window identity) would have lost the second one's sessions.
 *
 * Every `workspace.json` is still read even when directed; that is what the folder is
 * matched against, and it is a tiny JSON file. What the filter removes is the
 * `readdir` + per-file `stat` for workspaces this repo does not own.
 *
 * `windowMs` overrides the staleness window — the second of this file's two cutoff
 * sites; see `scanSessionState` for the first.
 */
async function scanChatSessions(windowMs?: number, onlyFolder?: string): Promise<CopilotChatDiskScanResult> {
	const workspaces = await listVscodeWorkspaceFolders("Code");
	const storageDir = getVscodeWorkspaceStorageDir("Code");
	const staleMs = windowMs ?? SESSION_STALE_MS;
	const cutoffMs = Date.now() - staleMs;
	const target = onlyFolder === undefined ? undefined : normalizePathForMatch(onlyFolder);
	let error: CopilotChatScanError | undefined;

	// The workspace listing stays SEQUENTIAL: it is one `readdir` per workspace, and it
	// is where `error` is decided — "the first failure" has to mean the first in
	// workspace order, which a fan-out would make depend on scheduling instead.
	const candidates: Array<{ readonly path: string; readonly sessionId: string; readonly folderPath: string }> = [];
	for (const ws of workspaces) {
		if (target !== undefined && normalizePathForMatch(ws.folderPath) !== target) continue;
		const dir = join(storageDir, ws.hash, "chatSessions");

		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			// A workspace with no chat sessions yet has no chatSessions/ — routine, and
			// now the common case rather than the exception, since every workspace on the
			// machine is visited instead of just the one that matched a repo.
			if (code === "ENOENT") continue;
			log.error("readdir %s failed (%s): %s", dir, code ?? "unknown", (err as Error).message);
			// One unreadable workspace must not lose the others: record the first failure
			// and keep scanning, the way the Cline flavour loop already does.
			error = error ?? { kind: "fs", message: (err as Error).message };
			continue;
		}

		for (const entry of entries) {
			if (!entry.endsWith(".jsonl")) continue; // skip .json snapshots and other suffixes
			candidates.push({
				path: join(dir, entry),
				sessionId: entry.slice(0, -".jsonl".length),
				folderPath: ws.folderPath,
			});
		}
	}

	// The per-session `stat`s ARE fanned out, and across every workspace at once rather
	// than per workspace: session counts are lopsided, so a per-workspace fan-out would
	// leave the busiest one running alone. Order is preserved, so the result is
	// identical to what the nested loops produced.
	const scanned = await mapWithConcurrency(
		candidates,
		async ({ path, sessionId, folderPath }): Promise<DiskSession | null> => {
			let mtimeMs: number;
			try {
				mtimeMs = (await withIoBudget(0, () => stat(path))).mtimeMs;
			} catch (err: unknown) {
				log.debug("Skipping %s: stat failed (%s)", sessionId, (err as Error).message);
				return null;
			}
			if (mtimeMs < cutoffMs) return null;
			return {
				session: {
					sessionId,
					transcriptPath: path,
					updatedAt: new Date(mtimeMs).toISOString(),
					source: "copilot-chat" as const,
				},
				dirs: [folderPath],
			};
		},
	);
	const sessions = scanned.filter((session): session is DiskSession => session !== null);

	return error ? { sessions, error } : { sessions };
}

/**
 * Runs Scan A then Scan B; concatenates sessions; returns the first error
 * encountered (subsequent are debug-logged).
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
 *
 * Both scans receive it: a change that widens only one leaves half the discovery
 * at 48h with nothing to signal it.
 */
export async function scanCopilotChatSessions(projectDir: string, windowMs?: number): Promise<CopilotChatScanResult> {
	// Scan B is DIRECTED at this repo's own workspaces — see `scanChatSessions`'s
	// `onlyFolder`. Scan A cannot be: its sessions live under `~/.copilot/session-state/`,
	// keyed by session id, so every one has to be read before its recorded folder is
	// known. That half was machine-wide before this change too, so nothing regressed
	// there.
	const { sessions, error } = await scanBothHalves(windowMs, projectDir);
	const mine = copilotChatSessionsForRepo(sessions, projectDir);
	if (mine.length > 0) {
		log.debug("Discovered %d Copilot Chat session(s) for %s", mine.length, projectDir);
	}
	return { sessions: mine, error };
}

/** A machine-wide Copilot Chat scan: both halves' sessions, plus the first failure. */
export interface CopilotChatDiskScanResult {
	readonly sessions: ReadonlyArray<DiskSession>;
	readonly error?: CopilotChatScanError;
}

/**
 * Runs both scans and concatenates them, each session carrying the workspace folder it
 * belongs to. Returns the first error encountered.
 *
 * `onlyFolder` directs Scan B at one repo's workspaces; omitting it scans the machine.
 * Shared by the two entry points below so the merge, the error precedence and the
 * "both failed" log line exist once.
 */
async function scanBothHalves(windowMs?: number, onlyFolder?: string): Promise<CopilotChatDiskScanResult> {
	const a = await scanSessionState(windowMs);
	const b = await scanChatSessions(windowMs, onlyFolder);
	const sessions = [...a.sessions, ...b.sessions];
	const error = a.error ?? b.error;
	if (a.error && b.error) {
		log.debug("Both scans errored; reporting Scan A's, dropped Scan B's: %s", b.error.message);
	}
	return error ? { sessions, error } : { sessions };
}

/**
 * Runs both scans machine-wide and concatenates them, each session carrying the
 * workspace folder it belongs to. Returns the first error encountered.
 *
 * MACHINE-WIDE and repo-agnostic on purpose — see {@link scanChatSessions} for why
 * the second half had to be inverted to get here. Callers scan once and narrow with
 * {@link copilotChatSessionsForRepo}.
 */
export async function scanCopilotChatSessionsOnDisk(windowMs?: number): Promise<CopilotChatDiskScanResult> {
	return scanBothHalves(windowMs);
}

/**
 * Narrows a machine-wide Copilot Chat scan to one repo.
 *
 * Attribution is exact equality under `normalizePathForMatch` — the VS Code family's
 * own normalisation, and the same comparison both halves used before: Scan A against
 * the session's recorded `folderPath`, Scan B against the folder its workspace opens
 * (which `findVscodeWorkspaceHash` used to compare with the identical call).
 */
export function copilotChatSessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const target = normalizePathForMatch(projectDir);
	return sessionsForRepo(scanned, (dir) => normalizePathForMatch(dir) === target);
}

/**
 * Convenience wrapper used by QueueWorker — strips the error channel.
 *
 * `windowMs` is forwarded verbatim. QueueWorker itself must keep omitting it —
 * see `scanCopilotChatSessions` for why widening the post-commit window corrupts
 * stored memory.
 */
export async function discoverCopilotChatSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanCopilotChatSessions(projectDir, windowMs);
	if (error) {
		log.warn("Copilot Chat scan error (%s) — sessions excluded from this run: %s", error.kind, error.message);
	}
	return sessions;
}
