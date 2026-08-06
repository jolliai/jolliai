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
import type { JolliMemoryConfig, LocalAgentToolId } from "../Types.js";
import { buildAuthFailureCaptureText } from "./AuthRemediation.js";
import { type BlockedSandboxId, buildSandboxFailureCaptureText } from "./SandboxRemediation.js";

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
	 * because the configured local-agent login expired (a `local-agent-auth`
	 * failure). The watcher then prints tool-specific sign-in guidance.
	 */
	readonly authExpired?: boolean;
	/** Tool whose authentication failed; absent on legacy progress events. */
	readonly localAgentTool?: LocalAgentToolId;
	/**
	 * Why a `stored` event landed as an empty `llm-failed` placeholder, for every
	 * failure that is NOT the auth subcase (out of credits, 5xx, timeout, an
	 * unparseable response). Absent on a healthy capture.
	 *
	 * Carried inline because this is the only surface that shows it: the stored
	 * summary keeps a `SummaryErrorKind` and no message, so the webview banner can
	 * only offer a generic "regenerate me", and the actual reason otherwise
	 * survives in debug.log alone. Without it the commit printed the plain success
	 * line over a blank memory.
	 */
	readonly llmFailure?: string;
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

/**
 * Env vars whose presence marks an interactive AI-agent session (auto mode).
 *
 * `CODEX_THREAD_ID` is the Codex entry. Measured on codex-cli 0.146.0, it is the
 * only marker present across every way Codex runs a command — interactive TUI and
 * `codex exec`, sandboxed and `danger-full-access` alike — and it is scoped to the
 * command-execution environment: Codex's own lifecycle hooks do NOT see it, so it
 * cannot make a hook mistake itself for the agent's shell. The `CODEX_SANDBOX*`
 * pair is deliberately not used as a marker: it is absent under full access and
 * present for the plain `codex sandbox` subcommand, so it both misses and misfires.
 */
const AGENT_ENV_KEYS = [
	"CLAUDECODE",
	"AI_AGENT",
	"CURSOR_TRACE_ID",
	"GEMINI_CLI",
	"OPENCODE",
	"CODEX_THREAD_ID",
] as const;

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
 * Suffixes swept by {@link pruneStaleCaptureProgress} — every artifact kind that
 * lands in this directory:
 *   - `.ndjson` — the per-commit capture progress stream.
 *   - `.lock`   — {@link acquireCaptureLock}'s per-hash lock, and the pre-push
 *     worker's per-push lock. A force-killed worker leaves its lock behind and
 *     that hash never re-runs, so it would otherwise linger forever.
 *   - `.json`   — the pre-push worker's request/result hand-off files.
 *   - `.tmp`    — a `write + rename` whose process died between the two steps.
 *
 * `.ndjson` does NOT match `.json` (the dot is part of the suffix), so both
 * entries are required.
 */
const PRUNABLE_SUFFIXES = [".ndjson", ".lock", ".json", ".tmp"] as const;

/**
 * Deletes stale files older than `maxAgeMs` from the capture-progress dir.
 * Best-effort. The mtime/age threshold is the safety margin: anything a live
 * worker still touches is refreshed well within `maxAgeMs`, so only genuinely
 * abandoned artifacts age out.
 */
export function pruneStaleCaptureProgress(cwd: string | undefined, maxAgeMs: number, nowMs: number = Date.now()): void {
	let names: string[];
	try {
		names = readdirSync(captureProgressDir(cwd));
	} catch {
		return; // dir missing / unreadable — nothing to prune
	}
	for (const name of names) {
		if (!PRUNABLE_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
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

/**
 * The sandbox denying this process network access, or `null` when nothing in the
 * environment says one does. The hook and the worker it spawns share the commit's
 * environment, so what the watcher reads here holds for the worker too — which is
 * what lets the closing line speak for the background work as well as the watch.
 * See {@link buildSandboxFailureCaptureText} for why that matters.
 */
export function networkBlockedSandbox(env: Record<string, string | undefined>): BlockedSandboxId | null {
	return isTruthyEnv(env.CODEX_SANDBOX_NETWORK_DISABLED) ? "codex" : null;
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
 * AI-agent session (Claude Code sets `CLAUDECODE`/`AI_AGENT`, Codex sets
 * `CODEX_THREAD_ID`; see {@link AGENT_ENV_KEYS}). Note that no agent gives the
 * command a TTY, so for those the marker is the only thing that opens the gate.
 * GUI git clients set neither, so they keep the silent, non-blocking behavior.
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

/**
 * Longest failure reason kept on the commit output's first line. The reason is
 * an arbitrary `Error.message` — a multi-line stack or a wall of provider JSON
 * would otherwise wreck the block this is printed into, so it is collapsed to
 * one line and clipped.
 */
const MAX_CAPTURE_REASON_CHARS = 140;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/**
 * ANSI escape sequences (OSC, CSI, the two-byte forms) and every other C0/C1
 * control character, so none of them reach the terminal.
 *
 * Not paranoia about a hostile string: `LocalAgentSetupError` carries a 2 KB
 * tail of the agent CLI's own **stderr**, and those CLIs colour their output, so
 * colour codes in this reason are the expected case rather than an exotic one.
 * Printed raw they leak styling into the rest of the commit block, and an OSC
 * sequence retitles the terminal window. Collapsing whitespace does not catch
 * any of it — ESC is not `\s`.
 *
 * Built with `RegExp` + `String.fromCharCode` so no literal control byte lands
 * in this file: git would classify the source as binary and lose diff/blame on
 * it. Same idiom, same reason, as `SAFE_SEGMENT_RE` in
 * `sync/VaultPathClassifier.ts`.
 */
const CONTROL_SEQUENCES = new RegExp(
	[
		// OSC: ESC ] … terminated by BEL, by ST (ESC \), or by end of string.
		`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`,
		// CSI: ESC [ params intermediates final.
		`${ESC}\\[[0-9;?]*[ -/]*[@-~]`,
		// Two-byte escapes (ESC c, ESC 7, …).
		`${ESC}[0-~]`,
		// Anything else non-printable, including a stray ESC with no sequence —
		// EXCEPT 0x09-0x0d, the whitespace controls. Those are left for the `\s`
		// collapse below to turn into spaces, because they separate words: deleting
		// a newline outright would weld "line one" and "line two" together.
		`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
	].join("|"),
	"g",
);

function buildLlmFailureCaptureText(reason: string): string {
	// Sequences are DELETED, not spaced out: an ANSI sequence is zero-width, and
	// `error<ESC>[0m:` must not become `error :`. Word separation is preserved by
	// leaving the whitespace controls to the collapse — see CONTROL_SEQUENCES.
	const oneLine = reason.replace(CONTROL_SEQUENCES, "").replace(/\s+/g, " ").trim();
	const clipped =
		oneLine.length > MAX_CAPTURE_REASON_CHARS ? `${oneLine.slice(0, MAX_CAPTURE_REASON_CHARS - 1)}…` : oneLine;
	return [
		`⚠ Jolli Memory: couldn't generate memory — ${clipped}`,
		"  → The commit was recorded; use Regenerate in the Jolli Memory panel to retry.",
	].join("\n");
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
			// A placeholder is NOT a real capture — show what went wrong instead of
			// the success line. Auth first: `classifyLlmFailure` already narrowed
			// that subcase and its remedy has actionable fix steps, so the raw
			// message would be strictly less useful. Legacy events did not carry the
			// tool and therefore retain the historical Claude default.
			if (d.authExpired) return buildAuthFailureCaptureText(d.localAgentTool ?? "claude-code");
			if (d.llmFailure) return buildLlmFailureCaptureText(d.llmFailure);
			return "✓ Jolli Memory updated";
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
 * A network-denied sandbox overrides every unresolved ending above with one
 * sandbox notice, because there the worker is provably doomed too and none of
 * those three lines would be true — see {@link buildSandboxFailureCaptureText}.
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
	// A sandbox that denies network access dooms the worker as surely as the watch,
	// so its notice replaces (never joins) whichever unresolved ending we reach.
	const blockedSandbox = networkBlockedSandbox(env);
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
			if (ev.step === "stored") {
				// An auth-expired placeholder inside a network-denied sandbox is almost
				// certainly the backend failing to reach its own auth endpoint, not a
				// stale login. Telling the user to sign in again would send them to fix
				// the wrong thing, so let the sandbox notice below speak for it.
				if (ev.data?.authExpired === true && blockedSandbox !== null) return;
				sawStored = true;
			}
			if (ev.step === "skipped") sawSkipped = true;
			if (ev.step === "failed") {
				sawFailed = true;
				// Under a blocking sandbox the generic `failed` line is suppressed here
				// so the sandbox notice below is the single, accurate account of it.
				if (blockedSandbox !== null) return;
			}
			const line = formatCaptureLine(ev);
			if (line !== null) write(line);
		},
	});
	// A capture that resolved with an outcome (stored / skipped) already printed its
	// own line, and its success rules out the sandbox diagnosis below.
	if (sawStored || sawSkipped) return;
	if (blockedSandbox !== null) {
		write(buildSandboxFailureCaptureText(blockedSandbox));
		return;
	}
	// A `failed` event already printed its own line and needs no closing one.
	if (sawFailed) return;
	// Otherwise the watch ended without a resolution: distinguish a dead worker
	// (nothing more is coming) from a still-running one (past the timeout).
	if (ended === "worker-dead") {
		write("⚠ Jolli Memory: capture was interrupted before finishing (see .jolli/jollimemory/debug.log)");
	} else {
		write("  analysis continues in the background…");
	}
}
