#!/usr/bin/env node
/**
 * Hermes' `on_session_end` shell-hook — the event-driven capture path for the sixth
 * discovered source.
 *
 * ## Why Hermes has its own file
 *
 * Every other source falls into one of two camps: either an AI-agent hook (Claude's
 * `StopHook`, Cursor's `CursorStopHook`) that runs on a session-end signal, or a
 * post-commit scan that walks whatever store the source keeps on disk. Hermes has both
 * — a signal AND a store — and skipping the signal would mean references, tokens and
 * skill-usage numbers only refresh at commit time, well after the sidebar's user has
 * moved on. So this hook exists for the same reason Cursor's does, and does the same
 * three things.
 *
 * ## What Hermes' wire protocol tells us — measured, not inferred
 *
 * From `agent/shell_hooks.py` (Hermes v0.20.5, `shell_hooks.py:29–39` documents the
 * stdin envelope; `agent/turn_finalizer.py` emits the `on_session_end` event):
 *
 *   stdin (JSON) = {
 *     hook_event_name: "on_session_end",
 *     tool_name:       "",
 *     tool_input:      {},
 *     session_id:      "sess_abc123",   // Hermes' `sessions.id` — the same PK the
 *                                       // discoverer indexes on
 *     cwd:             "/path/to/repo", // Hermes' own `sessions.cwd` at end-of-turn
 *     extra:           { task_id, turn_id, completed, interrupted }
 *   }
 *
 * That is enough to route ({ sessionId, cwd }) and to reach the transcript, because
 * the transcript for Hermes is not a file — it is the shared `state.db` this session
 * was written to during the turn. Every consumer here derives it: `saveSession`
 * stores `<dbPath>#<sessionId>` as the synthetic path, and both `recordSessionFromHook`
 * and `discoverHermesConversations` reach the same rows through the same reader.
 *
 * ## The three rules the shell-hook contract forces
 *
 *   - **Nothing on stdout.** Hermes parses stdout as JSON and any recognised shape
 *     (`{decision: "block"}`, `{context: "…"}`, `{action: "modify"}`) changes control
 *     flow. An accidental print — a stray `console.log`, an unhandled promise
 *     rejection — could block a tool call or inject text into the model's next
 *     prompt. The hook never writes to stdout; even the entry guard is a basename
 *     check because the bundle's `import.meta.url` also points at argv[1].
 *   - **Fail open, silently.** Hermes' default is fail-open (per its own header),
 *     and it also honours `fail_closed: true` on `pre_tool_call` — none of which is
 *     relevant to `on_session_end`, but the shape of "throw = block" applies as a
 *     habit: this file swallows every error into a log line and returns 0.
 *   - **Never install into a repository that did not ask.** Same rule as Cursor's:
 *     `isGitHookInstalled` is the opt-in gate, and a Hermes conversation in a
 *     browsed-but-not-enabled repo must not create `.jolli/jollimemory/` in it.
 *
 * @see file://./CursorStopHook.ts for the sibling hook this mirrors.
 * @see file://./StopHook.ts for Claude's original.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { resolveStateRoot } from "../core/GitOps.js";
import { discoverHermesSessions, isHermesInstalled } from "../core/HermesSessionDiscoverer.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig, saveSession } from "../core/SessionTracker.js";
import { recordSessionFromHook } from "../dashboard/ProducerHooks.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { spawnHidden } from "../util/Subprocess.js";
import { readStdin } from "./HookUtils.js";

const log = createLogger("HermesStopHook");

/**
 * What the payload names about the conversation that just ended.
 *
 * The `transcriptPath` here is the SYNTHETIC form `<dbPath>#<sessionId>` — the same
 * shape every Hermes consumer already speaks. Its real form is a row-set in the
 * shared `state.db` and asking for a file path here would misrepresent what the
 * session actually is; the synthetic path lets every consumer resolve back through
 * `parseSyntheticPath`.
 */
export interface HermesStopIdentity {
	readonly sessionId: string;
	readonly cwd: string;
	readonly transcriptPath?: string;
}

/** Narrows a parsed payload to the fields this hook reads. */
function asPayload(parsed: unknown): Record<string, unknown> {
	return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Route the payload to a `(sessionId, cwd)` pair, or `null` when either is missing.
 *
 * Hermes always sets both on `on_session_end` (measured against
 * `agent/turn_finalizer.py`'s emitter — the two fields are not optional there), so
 * this is a hard reject rather than a fallback: a payload missing either field is
 * from a hook event we do not recognise, not a Hermes session we would otherwise
 * skip.
 */
export function extractStopIdentity(parsed: unknown): { sessionId: string; cwd: string } | null {
	const payload = asPayload(parsed);
	const sessionId = stringField(payload, "session_id");
	const cwd = stringField(payload, "cwd");
	if (sessionId === undefined || cwd === undefined) return null;
	return { sessionId, cwd };
}

/**
 * Resolve the `<dbPath>#<sessionId>` synthetic path for this session, by asking the
 * discoverer which of the profile databases actually contains the row.
 *
 * Hermes stores every profile's conversations in a different SQLite file
 * (`<HERMES_HOME>/state.db` for the default profile, `<HERMES_HOME>/profiles/<name>/state.db`
 * for each named one), and the payload does not carry the DB path — the discoverer's
 * enumeration is the only source of truth for which file this row is in. A miss here
 * is not a bug: a session whose profile the discoverer no longer sees (config change
 * mid-turn, transient FS error) simply lands as a metadata-only row without the
 * transcript backing.
 */
async function resolveTranscriptPath(worktreeRoot: string, sessionId: string): Promise<string | undefined> {
	try {
		const sessions = await discoverHermesSessions(worktreeRoot);
		return sessions.find((s) => s.sessionId === sessionId)?.transcriptPath;
	} catch (error: unknown) {
		log.info("Hermes stop hook: transcript resolution failed: %s", (error as Error).message);
		return undefined;
	}
}

/**
 * Detach the reference-discovery pass into its own process for the same reason the
 * Cursor path does: `Promise.race` is not a deadline for Node work, and a plans-lock
 * poll can keep the hook alive past what Hermes' own 5-second timeout expects.
 *
 * Reuses the shared discovery worker; a Hermes-only worker would only differ in
 * which `discover*` call it makes, and the shared one already routes by argv.
 */
export function launchHermesDiscovery(worktreeRoot: string): void {
	// The shared worker lives beside this file after the bundle lays them out;
	// resolve by URL, never argv[1] — argv[1] points at THIS bundle, so respawning
	// it would recurse.
	const workerPath = join(dirname(fileURLToPath(import.meta.url)), "HermesDiscoveryWorker.js");
	if (!existsSync(workerPath)) {
		log.error("Hermes discovery worker not found: %s — reference discovery is left to the scan paths", workerPath);
		return;
	}
	try {
		const child = spawnHidden(process.execPath, [workerPath, "--cwd", worktreeRoot], {
			detached: true,
			stdio: "ignore",
			cwd: worktreeRoot,
		});
		child.once("error", (error: Error) => {
			log.error("Failed to start Hermes discovery worker: %s", error.message);
		});
		child.unref();
		log.debug("Hermes discovery worker spawned (PID: %d)", child.pid ?? -1);
	} catch (error: unknown) {
		log.error("Failed to start Hermes discovery worker: %s", (error as Error).message);
	}
}

export async function main(): Promise<void> {
	// Same guard the sibling hooks carry: a jollimemory-spawned local-agent driving
	// Hermes is our own machinery, and recording its turns would attribute our work
	// to the user's.
	if (isLocalAgentChild()) return;
	setLogDir(homedir());
	try {
		const raw = await readStdin();
		let parsed: unknown = {};
		if (raw.trim()) {
			try {
				parsed = JSON.parse(raw);
			} catch (error: unknown) {
				log.info("Hermes stop hook: unparseable payload: %s", (error as Error).message);
				return;
			}
		}

		const identity = extractStopIdentity(parsed);
		if (identity === null) {
			log.info("Hermes stop hook: payload named no session_id or cwd — nothing to record");
			return;
		}
		const worktreeRoot = resolveStateRoot(identity.cwd);
		setLogDir(worktreeRoot);

		if (!(await isGitHookInstalled(worktreeRoot))) {
			log.debug("Hermes stop hook skipped — %s has not been set up (run `jolli enable`)", worktreeRoot);
			return;
		}
		if (await readManualDisableFlag(worktreeRoot)) {
			log.info("Hermes stop hook skipped — repository manually disabled");
			return;
		}
		const config = await loadConfig();
		if (config.hermesEnabled === false) {
			log.info("Hermes integration disabled — skipping session tracking");
			return;
		}
		if (!(await isHermesInstalled())) {
			log.info("Hermes stop hook: Hermes state.db not found — skipping");
			return;
		}

		const transcriptPath = await resolveTranscriptPath(worktreeRoot, identity.sessionId);
		const sessionBase = {
			sessionId: identity.sessionId,
			updatedAt: new Date().toISOString(),
			source: "hermes" as const,
		};
		log.info("Hermes stop hook: session %s in %s", identity.sessionId, basename(worktreeRoot) || worktreeRoot);

		if (transcriptPath !== undefined) {
			const sessionInfo: SessionInfo = {
				sessionId: sessionBase.sessionId,
				transcriptPath,
				updatedAt: sessionBase.updatedAt,
				source: sessionBase.source,
			};
			try {
				await saveSession(sessionInfo, worktreeRoot);
			} catch (error: unknown) {
				log.error("Failed to save Hermes session: %s", (error as Error).message);
			}
			await recordSessionFromHook(worktreeRoot, sessionInfo);
		} else {
			// See `resolveTranscriptPath`: this is a real state where the discoverer
			// could not locate the row, not a bug. `sessions.json` requires a
			// resumable path so we skip it, and the dashboard row lands minimally —
			// the next post-commit or 60s tick fills it in when the row becomes
			// visible again.
			log.warn("Hermes stop hook: transcript unresolved — recording metadata-only row");
			await recordSessionFromHook(worktreeRoot, sessionBase);
		}

		launchHermesDiscovery(worktreeRoot);
	} catch (error: unknown) {
		// See header rule two. Everything up to here has already routed through a
		// per-step try/catch, so this outer catch is the belt-and-braces for anything
		// synchronous (import failure, cwd resolution) that could otherwise leak a
		// stack to stderr on hook exit.
		log.info("Hermes stop hook failed: %s", (error as Error).message);
	}
}

/**
 * True only when THIS module is the process entry point.
 *
 * See {@link file://./CursorStopHook.ts}'s identical guard for the two shipped bugs
 * that make the basename check load-bearing inside an esbuild bundle.
 */
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;
	if (pathResolve(argv1) !== pathResolve(fileURLToPath(import.meta.url))) return false;
	const entryName = basename(argv1).toLowerCase();
	return entryName === "hermesstophook.js" || entryName === "hermesstophook.ts";
}

if (isMainScript()) {
	void main();
}
/* v8 ignore stop */
