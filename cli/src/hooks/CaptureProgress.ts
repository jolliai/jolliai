/**
 * CaptureProgress — a per-commit progress stream that lets an interactive
 * caller watch the memory-capture pipeline live and print its lifecycle to
 * stdout, WITHOUT changing the fact that the QueueWorker still does the work in
 * a detached background process.
 *
 * The worker appends newline-delimited JSON events to
 * `<jolliMemoryDir>/capture-progress/<hash>.ndjson` as it advances through the
 * pipeline (start → diff → references → analyzing → stored → end). The
 * post-commit hook, when it detects it is running inside a place a human will
 * see stdout (a TTY, or an AI-agent session such as Claude Code), tails that
 * file and prints each milestone until a terminal event or a timeout. The
 * detached worker keeps running regardless; the watcher is a pure observer, so
 * an interrupted or timed-out watch never loses the summary.
 *
 * Emission is ALWAYS best-effort: a progress-write failure must never break
 * summary generation. Watching is gated (see {@link shouldShowCommitFeedback})
 * so non-interactive commits — VS Code SCM, IntelliJ, GitHub Desktop — keep the
 * old fast, silent, non-blocking behavior.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive, readLockOwnerPid, releaseIfOwned } from "../core/LockPrimitives.js";
import { loadConfig } from "../core/SessionTracker.js";
import { getJolliMemoryDir } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
import { AUTH_FAILURE_CAPTURE_TEXT } from "./AuthRemediation.js";

/** Lifecycle milestones a commit's capture passes through. */
export type CaptureStep =
	| "start"
	| "diff"
	| "references"
	| "analyzing"
	| "plan-progress"
	| "stored"
	| "skipped"
	| "failed"
	| "end";

/** Structured payload attached to a progress event (all optional). */
export interface CaptureEventData {
	readonly filesChanged?: number;
	readonly insertions?: number;
	readonly deletions?: number;
	/** Linked context tags — plan slugs and reference native ids. */
	readonly references?: ReadonlyArray<string>;
	readonly notes?: number;
	readonly topics?: number;
	/**
	 * Set on the `stored` event when the summary landed as an empty placeholder
	 * because the local-agent `claude` login expired (a `local-agent-auth`
	 * failure). The watcher then prints sign-in guidance instead of the success
	 * line — memory was NOT really captured for this commit.
	 */
	readonly authExpired?: boolean;
}

/** One line in the per-commit progress stream. */
export interface CaptureProgressEvent {
	readonly step: CaptureStep;
	readonly hash: string;
	readonly ts: number;
	/** When true, the watcher stops after emitting this event. */
	readonly terminal?: boolean;
	readonly data?: CaptureEventData;
}

/** `commitFeedback` config values (source of truth: {@link JolliMemoryConfig}). */
export type CommitFeedbackMode = NonNullable<JolliMemoryConfig["commitFeedback"]>;

const PROGRESS_DIRNAME = "capture-progress";

/** Files older than this are pruned opportunistically at each entry's start. */
export const CAPTURE_PROGRESS_MAX_AGE_MS = 60 * 60 * 1000;

export const DEFAULT_FEEDBACK_TIMEOUT_MS = 90_000;
/**
 * Shorter ceiling for AI-agent sessions: the watcher BLOCKS `git commit` while
 * it tails, and an agent cannot walk away — 90 s of silence is unacceptable
 * there. The detached worker keeps running regardless; only the watch gives up
 * earlier and prints the accurate "continues in the background" line.
 */
export const AGENT_FEEDBACK_TIMEOUT_MS = 15_000;
export const DEFAULT_FEEDBACK_POLL_MS = 300;

/** Env vars whose presence marks an interactive AI-agent session (auto mode). */
const AGENT_ENV_KEYS = ["CLAUDECODE", "AI_AGENT", "CURSOR_TRACE_ID", "GEMINI_CLI", "OPENCODE"] as const;

/** `<jolliMemoryDir>/capture-progress`. */
export function captureProgressDir(cwd?: string): string {
	return join(getJolliMemoryDir(cwd), PROGRESS_DIRNAME);
}

/** Absolute path to a commit's progress file. */
export function captureProgressPath(cwd: string | undefined, hash: string): string {
	return join(captureProgressDir(cwd), `${hash}.ndjson`);
}

/**
 * Absolute path to a commit's capture lock. The QueueWorker writes its PID
 * into this file for the duration of the capture (see
 * {@link acquireCaptureLock} / {@link releaseCaptureLock}) so a watcher can
 * probe the worker's liveness without importing the worker module (which
 * would be circular).
 */
export function captureLockPath(cwd: string, hash: string): string {
	const key = createHash("sha256").update(hash).digest("hex");
	return join(captureProgressDir(cwd), `${key}.lock`);
}

/**
 * Writes the current process's PID into the per-hash capture lock, marking
 * "this worker is actively capturing `hash`". Best-effort — a failure only
 * degrades the watcher's dead-worker detection, never the pipeline itself.
 * Called by the QueueWorker at the start of {@link processQueueEntry}.
 */
export function acquireCaptureLock(cwd: string | undefined, hash: string): void {
	if (cwd === undefined) return;
	try {
		const dir = captureProgressDir(cwd);
		mkdirSync(dir, { recursive: true });
		writeFileSync(captureLockPath(cwd, hash), String(process.pid), "utf-8");
	} catch {
		// best-effort: liveness probe degrades, pipeline unaffected
	}
}

/**
 * Removes the per-hash capture lock — only when this process owns it (PID
 * match), so a successor worker's fresh lock is never deleted by a stale
 * release. Called by the QueueWorker in the `finally` block after the
 * terminal progress event. Best-effort; an orphaned lock is pruned by
 * {@link pruneStaleCaptureProgress} once it ages out.
 */
export async function releaseCaptureLock(cwd: string | undefined, hash: string): Promise<void> {
	if (cwd === undefined) return;
	await releaseIfOwned(captureLockPath(cwd, hash), "capture lock");
}

/**
 * True when a capture lock for `hash` exists but the process that wrote it is no
 * longer alive — i.e. the detached worker was force-killed (SIGKILL, crash,
 * machine sleep) mid-capture and can never emit its terminal event. A watcher
 * uses this to stop early instead of waiting out the full feedback timeout. An
 * absent lock (worker not started yet, or finished and released) is NOT dead —
 * only a present-but-orphaned lock is.
 */
export async function isCaptureWorkerDead(cwd: string | undefined, hash: string): Promise<boolean> {
	if (cwd === undefined) return false;
	const pid = await readLockOwnerPid(captureLockPath(cwd, hash));
	return pid !== null && !isPidAlive(pid);
}

/**
 * Appends one progress event for `hash`. Best-effort — any failure (unwritable
 * dir, full disk) is swallowed so the worker's pipeline is never affected.
 */
export function emitCaptureProgress(
	cwd: string | undefined,
	hash: string,
	step: CaptureStep,
	opts: { readonly data?: CaptureEventData; readonly terminal?: boolean } = {},
): void {
	try {
		const dir = captureProgressDir(cwd);
		mkdirSync(dir, { recursive: true });
		const event: CaptureProgressEvent = {
			step,
			hash,
			ts: Date.now(),
			...(opts.terminal ? { terminal: true } : {}),
			...(opts.data ? { data: opts.data } : {}),
		};
		appendFileSync(join(dir, `${hash}.ndjson`), `${JSON.stringify(event)}\n`, "utf-8");
	} catch {
		// Best-effort: progress emission must never break the worker.
	}
}

/** Reads all well-formed events from a progress file (missing file → `[]`). */
export function readCaptureEvents(path: string): CaptureProgressEvent[] {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const events: CaptureProgressEvent[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as CaptureProgressEvent);
		} catch {
			// Skip a torn final line (append not yet flushed) or corruption.
		}
	}
	return events;
}

/**
 * Deletes stale files older than `maxAgeMs` from the capture-progress dir.
 * Best-effort. Covers both artifact kinds that live here:
 *   - `<hash>.ndjson` — the per-commit progress stream.
 *   - `<sha256>.lock`  — {@link acquireCaptureLock}'s per-hash lock file. A
 *     force-killed worker leaves its `.lock` behind and that hash never re-runs,
 *     so the lock would otherwise linger forever. The same mtime/age threshold
 *     is the safety margin: a live lock is refreshed well within `maxAgeMs`, so
 *     only genuinely abandoned locks age out.
 */
export function pruneStaleCaptureProgress(cwd: string | undefined, maxAgeMs: number, nowMs: number = Date.now()): void {
	let names: string[];
	try {
		names = readdirSync(captureProgressDir(cwd));
	} catch {
		return; // dir missing / unreadable — nothing to prune
	}
	for (const name of names) {
		if (!name.endsWith(".ndjson") && !name.endsWith(".lock")) continue;
		const full = join(captureProgressDir(cwd), name);
		try {
			if (nowMs - statSync(full).mtimeMs > maxAgeMs) unlinkSync(full);
		} catch {
			// ignore per-file errors
		}
	}
}

function normalizeMode(v: string | undefined): CommitFeedbackMode | undefined {
	return v === "on" || v === "off" || v === "auto" ? v : undefined;
}

/** True when any agent-marker env var is set to a truthy value. */
export function isAgentSession(env: Record<string, string | undefined>): boolean {
	return AGENT_ENV_KEYS.some((k) => isTruthyEnv(env[k]));
}

function isTruthyEnv(v: string | undefined): boolean {
	return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Decides whether the post-commit hook should print live capture feedback.
 *
 * Precedence: the `JOLLI_COMMIT_FEEDBACK` env override beats the config
 * `commitFeedback`, which beats the `"auto"` default. In `"auto"` the hook
 * shows feedback only where a human will see stdout — a real TTY, or an
 * AI-agent session (Claude Code sets `CLAUDECODE`/`AI_AGENT`). GUI git clients
 * set none of these, so they keep the silent, non-blocking behavior.
 */
export function shouldShowCommitFeedback(
	mode: CommitFeedbackMode | undefined,
	env: Record<string, string | undefined>,
	isTTY: boolean | undefined,
): boolean {
	const resolved = normalizeMode(env.JOLLI_COMMIT_FEEDBACK) ?? mode ?? "auto";
	if (resolved === "on") return true;
	if (resolved === "off") return false;
	if (isTTY === true) return true;
	return AGENT_ENV_KEYS.some((k) => isTruthyEnv(env[k]));
}

/** Renders one event as a stdout line, or `null` to print nothing for it. */
export function formatCaptureLine(event: CaptureProgressEvent): string | null {
	const d = event.data ?? {};
	switch (event.step) {
		case "start":
			return `● Jolli Memory · capturing context for ${event.hash.slice(0, 7)}…`;
		case "diff": {
			if (!d.filesChanged) return null;
			const files = `${d.filesChanged} file${d.filesChanged === 1 ? "" : "s"} changed`;
			const hasDelta = Boolean(d.insertions) || Boolean(d.deletions);
			const delta = hasDelta ? `  (+${d.insertions ?? 0} −${d.deletions ?? 0})` : "";
			return `  indexing ${files}${delta}`;
		}
		case "references": {
			const tags = (d.references ?? []).map((r) => (r.startsWith("#") ? r : `#${r}`));
			return tags.length === 0 ? null : `  found links to: ${tags.join(", ")}`;
		}
		case "analyzing":
			return "  analyzing semantic intent of the change…";
		case "plan-progress":
			return "  evaluating plan progress…";
		case "stored":
			// An auth-expired placeholder is NOT a real capture — show the fix
			// instead of the success line. Shares wording with the SessionStart
			// reminder via AuthRemediation.
			return d.authExpired ? AUTH_FAILURE_CAPTURE_TEXT : "✓ Jolli Memory updated";
		case "skipped":
			return "  (no changes to capture)";
		case "failed":
			return "⚠ Jolli Memory: capture did not complete (see .jolli/jollimemory/debug.log)";
		case "end":
			return null;
	}
}

export interface WatchCaptureOptions {
	readonly onEvent: (event: CaptureProgressEvent) => void;
	readonly timeoutMs?: number;
	readonly pollMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly readEvents?: (path: string) => CaptureProgressEvent[];
	readonly now?: () => number;
	/** Probe for a force-killed worker; defaults to {@link isCaptureWorkerDead}. */
	readonly workerDead?: () => Promise<boolean>;
}

/** How a {@link watchCaptureProgress} loop ended. */
export type WatchEnd = "terminal" | "timeout" | "worker-dead";

/**
 * Tails `hash`'s progress file, invoking `onEvent` for each new event in order,
 * until a terminal event arrives, `timeoutMs` elapses, or the detached worker is
 * detected dead. New events written before the watch began are still delivered
 * (each poll re-reads from the start and skips already-delivered lines), so no
 * early event is lost. The worker-death check turns the worst case (a
 * force-killed worker that can never emit its terminal event) from a full
 * `timeoutMs` block into a prompt exit; a live-but-slow worker still runs to the
 * timeout.
 */
export async function watchCaptureProgress(
	cwd: string | undefined,
	hash: string,
	opts: WatchCaptureOptions,
): Promise<{ ended: WatchEnd; count: number }> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_FEEDBACK_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_FEEDBACK_POLL_MS;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const read = opts.readEvents ?? readCaptureEvents;
	const clock = opts.now ?? Date.now;
	const workerDead = opts.workerDead ?? (() => isCaptureWorkerDead(cwd, hash));
	const path = captureProgressPath(cwd, hash);
	const start = clock();
	let emitted = 0;
	for (;;) {
		const events = read(path);
		for (; emitted < events.length; emitted++) {
			const ev = events[emitted];
			opts.onEvent(ev);
			if (ev.terminal) return { ended: "terminal", count: emitted + 1 };
		}
		if (clock() - start >= timeoutMs) return { ended: "timeout", count: emitted };
		if (await workerDead()) return { ended: "worker-dead", count: emitted };
		await sleep(pollMs);
	}
}

export interface CommitFeedbackDeps {
	readonly loadConfigFn?: () => Promise<JolliMemoryConfig>;
	readonly env?: Record<string, string | undefined>;
	readonly isTTY?: boolean;
	readonly write?: (line: string) => void;
	readonly timeoutMs?: number;
	readonly pollMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly readEvents?: (path: string) => CaptureProgressEvent[];
	readonly now?: () => number;
	readonly workerDead?: () => Promise<boolean>;
}

/**
 * Top-level glue for the post-commit hook: resolve the gate, and if enabled,
 * watch the commit's capture and print each milestone. The closing line is
 * accurate to how the watch ended so the user is never left on a dangling
 * "capturing…" nor wrongly told work continues:
 *   - a terminal `stored`/`skipped`/`failed` already printed its own line;
 *   - a force-killed worker prints an interrupted notice (not "in background");
 *   - a timeout with the worker still alive prints "continues in the background".
 * All state comes through `deps` so this is fully testable.
 */
export async function runCommitFeedback(cwd: string, hash: string, deps: CommitFeedbackDeps = {}): Promise<void> {
	const load = deps.loadConfigFn ?? loadConfig;
	const env = deps.env ?? process.env;
	const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
	const write = deps.write ?? ((line: string) => void process.stdout.write(`${line}\n`));

	let mode: CommitFeedbackMode | undefined;
	try {
		mode = (await load()).commitFeedback;
	} catch {
		mode = undefined;
	}
	if (!shouldShowCommitFeedback(mode, env, isTTY)) return;

	let sawStored = false;
	let sawSkipped = false;
	let sawFailed = false;
	// Agent sessions BLOCK `git commit` for the duration of the watch, so they
	// get a much shorter ceiling than a human TTY (where the user sees live
	// progress and voluntarily waits). Explicit deps.timeoutMs still wins (tests).
	const timeoutMs = deps.timeoutMs ?? (isAgentSession(env) ? AGENT_FEEDBACK_TIMEOUT_MS : undefined);
	const { ended } = await watchCaptureProgress(cwd, hash, {
		timeoutMs,
		pollMs: deps.pollMs,
		sleep: deps.sleep,
		readEvents: deps.readEvents,
		now: deps.now,
		workerDead: deps.workerDead,
		onEvent: (ev) => {
			if (ev.step === "stored") sawStored = true;
			if (ev.step === "skipped") sawSkipped = true;
			if (ev.step === "failed") sawFailed = true;
			const line = formatCaptureLine(ev);
			if (line !== null) write(line);
		},
	});
	// A resolved capture (stored / skipped / failed) already printed its own line.
	if (sawStored || sawSkipped || sawFailed) return;
	// Otherwise the watch ended without a resolution: distinguish a dead worker
	// (nothing more is coming) from a still-running one (past the timeout).
	if (ended === "worker-dead") {
		write("⚠ Jolli Memory: capture was interrupted before finishing (see .jolli/jollimemory/debug.log)");
	} else {
		write("  analysis continues in the background…");
	}
}
