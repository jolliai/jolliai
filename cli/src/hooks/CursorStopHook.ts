#!/usr/bin/env node
/**
 * The Cursor plugin's `stop` hook — the event-driven capture path for both Cursor
 * surfaces.
 *
 * ## What it replaced, and what the probe answered
 *
 * This shipped first as a PROBE, because a capture hook has to know WHICH conversation
 * just ended and WHICH repository it belongs to, and neither was answerable from the
 * docs. Five real invocations (Cursor IDE 3.16.29 ×3, cursor-agent 2026.08.11 ×2)
 * settled every open question, and the answers are better than the design assumed:
 *
 *   - **Identity** — `conversation_id` and `session_id` are both present and IDENTICAL,
 *     and equal the transcript's UUID, which is the key BOTH discoverers index on
 *     (`composerData:<id>` for the IDE, `chats/<hash>/<uuid>/` for the CLI).
 *   - **Transcript** — `transcript_path` is IN THE PAYLOAD, with `CURSOR_TRANSCRIPT_PATH`
 *     carrying the same value in the environment. So the bucket-probing locator
 *     (`resolveCursorTranscriptPath`) is not needed on this path at all; it remains what
 *     the SCAN paths use, where no host is there to tell us.
 *   - **Repository** — `workspace_roots[0]` was present and correct 5/5, `CURSOR_PROJECT_DIR`
 *     was set to the same workspace, and `cwd` was the workspace too (not the plugin
 *     bundle), matching the `_getHookCwd` reading that `stop` is one of the two events
 *     handed `workspace.folders[0]`. All three still go through
 *     {@link pickCursorProjectDir}'s screening — a marketplace cache is a real checkout,
 *     so a bundle-valued candidate must be rejected however it arrived.
 *   - **cursor-agent DOES fire this event** (2 of the 5). Only `cursor-agent -p` does not,
 *     which is why the scan paths stay and are not superseded by this hook.
 *
 * ## The one thing that must not be got wrong: WHICH source
 *
 * `cursor` (the IDE's Agents Window) and `cursor-cli` (`cursor-agent`) write the same
 * transcript but are indexed by two DISJOINT discoverers — measured on a real machine,
 * 4 IDE + 6 CLI, zero overlap. Every downstream identity is `(source, sessionId)`, so a
 * hook that recorded a cursor-agent conversation as `cursor` would not overwrite the
 * discoverer's row, it would sit BESIDE it: two sessions, doubled tokens, doubled tool
 * calls, and nothing to flag it. See {@link resolveCursorSource} for how the two are
 * told apart.
 *
 * ## What it does, and what it deliberately does not
 *
 * The same three things Claude's `StopHook` does, through the same functions — this hook
 * contributes no extraction logic of its own:
 *
 *   1. `saveSession` → `sessions.json` (which also prunes >48 h rows and their cursors).
 *   2. `recordSessionFromHook` → the dashboard database, via `sessionEventFromInfo`, the
 *      same function the 7-day back-fill uses. Sessions, per-model usage, tool/MCP calls
 *      and skill invocations all land from one whole-transcript read.
 *   3. A detached `CursorDiscoveryWorker` runs `discoverCursorConversations` →
 *      `plans.json.skills`, so the SKILLS panel sees a skill while the work is still
 *      current rather than at the next commit, without keeping this synchronous hook
 *      alive behind a contended plans lock.
 *
 * It does NOT read the payload's `input_tokens` / `output_tokens` / `model`, even though
 * they are there. Those are PER GENERATION (one measured at 199,933 input with 80,256
 * cache reads — the whole context, not an increment), while `session_model_usage` and
 * `session_tool_use` are replaced WHOLESALE per session by `projectSession`. Writing a
 * turn's numbers would overwrite the session's totals with the last turn's, and summing
 * them across turns would multiply the context by the turn count. The transcript read in
 * (2) is already the correct whole-session answer; the payload is used for identity and
 * routing only.
 *
 * ## Four rules it inherits
 *
 *   - **Nothing on stdout.** Cursor's command hooks are fail-open and this one has no
 *     output contract worth exercising.
 *   - **`setLogDir` before the first log line.** The logger falls back to `process.cwd()`,
 *     which on this host can be a plugin cache.
 *   - **Never throw.** A hook must not be able to break a session, so `main` swallows.
 *   - **Never install into a repository that did not ask.** `runCursorPluginBootstrap`
 *     gates everything on `isGitHookInstalled`, because a Cursor window opens for every
 *     repository in the sidebar. This hook honours the same gate for the same reason:
 *     without it, merely chatting in a browsed-but-not-enabled repo would create
 *     `.jolli/jollimemory/` in it.
 *
 * @see file://./CursorPluginBootstrapHook.ts for the `sessionStart` sibling.
 * @see file://./StopHook.ts for the Claude original this mirrors.
 */

import { existsSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { getCursorHomeDir } from "../core/CursorTranscriptLocator.js";
import { resolveStateRoot } from "../core/GitOps.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig, saveSession } from "../core/SessionTracker.js";
import { recordSessionFromHook } from "../dashboard/ProducerHooks.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { SessionInfo, TranscriptSource } from "../Types.js";
import { spawnHidden } from "../util/Subprocess.js";
import { pickCursorProjectDir } from "./CursorProjectDir.js";
import { readStdin } from "./HookUtils.js";

const log = createLogger("CursorStopHook");

/** The env var Cursor sets when the hook is running under `cursor-agent`. */
const INVOKED_AS_CLI = "cursor-agent";

/** What the payload tells us about the conversation that just ended. */
export interface CursorStopIdentity {
	/** Cursor's conversation UUID — the key both discoverers index on. */
	readonly sessionId: string;
	/** Absolute path of the `agent-transcripts` JSONL, when either hook channel named it. */
	readonly transcriptPath?: string;
}

/** Narrows a parsed payload to the fields this hook reads. */
function asPayload(parsed: unknown): Record<string, unknown> {
	return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

/** A non-blank string field, or undefined. */
function stringField(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The conversation's identity, or `null` when the payload named no id.
 *
 * `conversation_id` before `session_id` because it is the field that NAMES what is being
 * identified; measured, the two are the same UUID on every record, so the order is about
 * intent rather than about picking a winner. Both are read so a build that drops either
 * one still works.
 *
 * The transcript falls back to `CURSOR_TRANSCRIPT_PATH`, which carried the identical
 * value on all five captures. Two independent channels for one fact is worth the four
 * lines: without a transcript the session still records (`sessionEventFromInfo` degrades
 * to a bare row), but with no tool calls, no skills and no message count — a row that
 * looks like an empty conversation rather than an unread one.
 */
export function extractStopIdentity(parsed: unknown, env: NodeJS.ProcessEnv): CursorStopIdentity | null {
	const payload = asPayload(parsed);
	const sessionId = stringField(payload, "conversation_id") ?? stringField(payload, "session_id");
	if (sessionId === undefined) return null;
	const transcriptPath = stringField(payload, "transcript_path") ?? env.CURSOR_TRANSCRIPT_PATH?.trim();
	return transcriptPath ? { sessionId, transcriptPath } : { sessionId };
}

/**
 * Whether this conversation belongs to `cursor-cli` rather than `cursor`.
 *
 * Two signals, and the order is about RACES rather than about trust:
 *
 *   1. `CURSOR_INVOKED_AS === "cursor-agent"` — set on both cursor-agent captures and on
 *      neither IDE capture. Definitive at the instant the hook runs, with nothing on disk
 *      to be written yet.
 *   2. `~/.cursor/chats/<hash>/<sessionId>/` exists — the same index
 *      `CursorCliSessionDiscoverer` walks, so classifying by it cannot disagree with the
 *      discoverer that would otherwise claim the conversation.
 *
 * The env var alone would be enough today and the directory probe alone would be more
 * principled; taking the env var FIRST and the probe only in its absence is what makes
 * the answer both race-free and robust to a build that stops setting it. The failure this
 * closes is not a crash — it is the silent duplicate described in the header, which
 * nothing downstream can detect because two sources genuinely are two conversations.
 *
 * Any I/O failure answers `false` (i.e. `cursor`), matching the IDE-is-the-default shape
 * of every other Cursor surface.
 *
 * The bucket probe uses async `access`, never `existsSync`: this runs on Cursor's
 * synchronous stop hook, and when `CURSOR_INVOKED_AS` is unset (every IDE conversation,
 * plus any build that stops setting it) the loop touches every `chats/<hash>` bucket —
 * blocking the event loop on that many sync syscalls per stop. Async keeps the fail-open
 * hook from stalling on a machine with many cursor-agent chat buckets.
 */
export async function resolveCursorSource(
	env: NodeJS.ProcessEnv,
	sessionId: string,
	cursorHome: string = getCursorHomeDir(),
): Promise<TranscriptSource> {
	if (env.CURSOR_INVOKED_AS?.trim() === INVOKED_AS_CLI) return "cursor-cli";
	try {
		const chatsDir = join(cursorHome, "chats");
		for (const hash of await readdir(chatsDir)) {
			if (await pathExists(join(chatsDir, hash, sessionId))) return "cursor-cli";
		}
	} catch {
		// No `chats/` at all is the normal state on an IDE-only machine.
	}
	return "cursor";
}

/** Async existence check, so the stop-hook path never blocks on sync fs I/O. */
async function pathExists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * Starts the optional skill-discovery pass outside Cursor's synchronous stop hook.
 *
 * A `Promise.race` is not a deadline for Node work: losing the race does not cancel the
 * discovery promise, and plans-lock polling owns referenced timers that can keep this
 * process alive until its own timeout. A detached, ignored-stdio child is the actual
 * process boundary the hook needs — after `unref()` the discovery can finish without
 * extending the lifetime of this command.
 *
 * Resolve the fixed sibling entry, never `process.argv[1]`: this function is bundled
 * into `CursorStopHook.js`, so argv[1] names the hook and respawning it would recurse.
 */
export function launchCursorDiscovery(worktreeRoot: string): void {
	const workerPath = join(dirname(fileURLToPath(import.meta.url)), "CursorDiscoveryWorker.js");
	if (!existsSync(workerPath)) {
		log.error("Cursor discovery worker not found: %s — skill discovery is left to the scan paths", workerPath);
		return;
	}

	try {
		const child = spawnHidden(process.execPath, [workerPath, "--cwd", worktreeRoot], {
			detached: true,
			stdio: "ignore",
			cwd: worktreeRoot,
		});
		// A successful existsSync can still race an uninstall. Without an error listener,
		// that asynchronous spawn failure would become an uncaught EventEmitter error in
		// the hook process.
		child.once("error", (error: Error) => {
			log.error("Failed to start Cursor discovery worker: %s", error.message);
		});
		child.unref();
		log.debug("Cursor discovery worker spawned (PID: %d)", child.pid ?? -1);
	} catch (error: unknown) {
		// Spawn can also fail synchronously (invalid cwd, exhausted descriptors). The
		// session row is already durable, and the regular scan paths will catch up.
		log.error("Failed to start Cursor discovery worker: %s", (error as Error).message);
	}
}

export async function main(): Promise<void> {
	// Same guard as the bootstrap: a jollimemory-spawned agent driving `cursor-agent`
	// is our own machinery, and recording its turns would attribute our work to the user's.
	if (isLocalAgentChild()) return;
	// Before the first log line, for the reason in the header: the logger's fallback is
	// cwd, and on this host that can be the plugin bundle.
	setLogDir(homedir());
	try {
		const raw = await readStdin();
		let parsed: unknown = {};
		if (raw.trim()) {
			try {
				parsed = JSON.parse(raw);
			} catch (error: unknown) {
				log.info("Cursor stop hook: unparseable payload: %s", (error as Error).message);
				return;
			}
		}

		const projectDir = pickCursorProjectDir(
			parsed as { workspace_roots?: unknown },
			process.env,
			process.cwd(),
		).dir;
		if (projectDir === null) {
			log.info("Cursor stop hook: no usable workspace in the payload, env or cwd — nothing to record");
			return;
		}
		// Anchored like Claude's Stop hook: the workspace may be a subdirectory of the
		// worktree, and an unanchored path forks a stray `.jolli/` store beside the real one.
		const worktreeRoot = resolveStateRoot(projectDir);
		setLogDir(worktreeRoot);

		// The opt-in gate. See the header's fourth rule — a Cursor window opens for every
		// repository in the sidebar, so "the user chatted here" is not consent to write.
		if (!(await isGitHookInstalled(worktreeRoot))) {
			log.debug("Cursor stop hook skipped — %s has not been set up (run /jolli-init)", worktreeRoot);
			return;
		}
		if (await readManualDisableFlag(worktreeRoot)) {
			log.info("Cursor stop hook skipped — repository manually disabled");
			return;
		}
		// ONE toggle for both sources, matching how they are presented everywhere else.
		const config = await loadConfig();
		if (config.cursorEnabled === false) {
			log.info("Cursor integration disabled — skipping session tracking");
			return;
		}

		const identity = extractStopIdentity(parsed, process.env);
		if (identity === null) {
			log.warn("Cursor stop hook: payload named no conversation id — nothing to record");
			return;
		}
		const source = await resolveCursorSource(process.env, identity.sessionId);
		const sessionBase = {
			sessionId: identity.sessionId,
			updatedAt: new Date().toISOString(),
			source,
		};
		log.info(
			"Cursor stop hook: %s session %s in %s",
			source,
			identity.sessionId,
			basename(worktreeRoot) || worktreeRoot,
		);

		if (identity.transcriptPath) {
			const sessionInfo: SessionInfo = {
				sessionId: sessionBase.sessionId,
				transcriptPath: identity.transcriptPath,
				updatedAt: sessionBase.updatedAt,
				source: sessionBase.source,
			};
			// Each step is independently guarded: a failing registry write must not cost
			// the dashboard row, and neither must cost the background skill pass.
			try {
				await saveSession(sessionInfo, worktreeRoot);
			} catch (error: unknown) {
				log.error("Failed to save Cursor session: %s", (error as Error).message);
			}
			// Never throws and skips itself on a runtime below the `node:sqlite` floor.
			await recordSessionFromHook(worktreeRoot, sessionInfo);
		} else {
			// A pathless row cannot enter sessions.json: every consumer of that registry
			// expects a resumable transcript path. The dashboard accepts the smaller shape
			// and later discovery enriches the same `(source, sessionId)` identity.
			log.warn("Cursor stop hook: no transcript path — recording a metadata-only session row");
			await recordSessionFromHook(worktreeRoot, sessionBase);
		}

		// KNOWN, ACCEPTED: this runs from the plugin's own pinned `dist`, while post-commit
		// and the VS Code tick run from whichever registered runtime is newest. That is the
		// shape Claude's Stop hook carries a single-owner gate for — an older dist advancing
		// a high-water mark past a record its matcher does not recognise. It is milder here:
		// skills ride their own per-extractor mark, and a mark this dist cannot write at all
		// reads as a full rewind rather than as a skip. Revisit if Cursor references land on
		// the SHARED cursor, where the Claude failure is reproduced exactly.
		launchCursorDiscovery(worktreeRoot);
	} catch (error: unknown) {
		// Fail-open, and silent on stdout. See the header's third rule.
		log.info("Cursor stop hook failed: %s", (error as Error).message);
	}
}

/**
 * True only when THIS module is the process entry point.
 *
 * The basename check is not redundant with the path comparison — see the identical
 * guard in {@link file://./CursorPluginBootstrapHook.ts} for the two shipped bugs that
 * make it load-bearing inside an esbuild bundle.
 */
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;
	if (pathResolve(argv1) !== pathResolve(fileURLToPath(import.meta.url))) return false;
	const entryName = basename(argv1).toLowerCase();
	return entryName === "cursorstophook.js" || entryName === "cursorstophook.ts";
}

if (isMainScript()) {
	void main();
}
/* v8 ignore stop */
