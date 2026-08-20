/**
 * TelemetryAgent — the `agent` telemetry dimension: **which AI host the user was
 * actually working in**, as distinct from which of our build artifacts sent the
 * event.
 *
 * ## Why `surface` cannot answer this
 *
 * `surface` comes from `__JOLLI_CLIENT_KIND__`, a compile-time constant each
 * bundler `define`s, so the complete set of values a running process can emit
 * equals the set of build configurations that exist — six. This product supports
 * thirteen hosts ({@link TRANSCRIPT_SOURCES}), only three of which ship a plugin
 * bundle; everything else is *observed* by whichever artifact happens to be
 * running, so ten of thirteen report the surface of the observer.
 *
 * Worse than invisible, they are misattributed. Repo hooks are installed as
 * source-neutral `run-hook` calls and resolved at trigger time by
 * `pickBestDistPath` — highest core version wins, with plugin tags deliberately
 * absent from the tie-break order — so a **Gemini** session's hook can be
 * executed by the claude-plugin bundle and arrive tagged
 * `surface: "claude-plugin"` on a session Claude was never in.
 *
 * `surface` answers "which of our artifacts ran, at which version", which is
 * what min-version upgrade gating needs. This module adds the second dimension
 * rather than widening the first.
 *
 * ## Three rules this module exists to enforce
 *
 * **Never defaulted.** An absent `agent` reads as *unknown*. Defaulting it to
 * `cli` (or anything) would disguise "not measured" as a positive claim about
 * the user's host, which silently corrupts every future comparison — and unlike
 * a wrong value, an omission is recoverable later.
 *
 * **Never free-form.** {@link resolveTelemetryAgent} is the only way a value
 * reaches the wire, and it answers from the closed {@link TELEMETRY_AGENTS} set.
 * An unrecognised host is omitted, never passed through. That is what keeps the
 * dimension inside the content-free contract: a fixed, low-cardinality
 * enumeration of tool names is not identity, content, a path, or user input.
 *
 * **Never guessed.** A partially-known case must not fall through to a wrong
 * value — see {@link AMBIGUOUS_AGENT_ENV_KEYS} for the two markers that name a
 * family rather than a host, and {@link detectAgentFromEnv} for why two distinct
 * markers at once yields nothing.
 *
 * ## What is attributed today, and what is not
 *
 * Three channels reach the wire, and they cover different events:
 *
 *  - **Structural**, strongest: a plugin's SessionStart bootstrap only ever runs
 *    inside its own host, so `claude-plugin` / `codex-plugin` / `cursor-plugin`
 *    are known outright (`pluginBootstrapAgent`). This is what attributes
 *    `onboarding_progressed` and `app_installed`.
 *  - **Env markers**, via {@link detectAgentFromEnv} at `bootstrapTelemetry`:
 *    attributes everything a short-lived CLI process emits, `command_invoked`
 *    included, since the bootstrap runs ahead of command dispatch. Four hosts
 *    today. This channel is **opt-in** (`inferAgentFromEnv`) because a marker is
 *    inherited by every descendant and never expires, so it only names the
 *    current host in a process the host itself just launched — see that flag for
 *    the long-lived cases it is off for.
 *  - **Per-session**, for a pass that has narrowed which transcript it is
 *    walking: the QueueWorker loop passes `session.source` explicitly, which is
 *    how all thirteen hosts — Gemini included, fed by its AfterAgent hook rather
 *    than by a disk scan — can reach `ai_source_detected`.
 *
 * So the gap is a CLI command run from a host with no marker of its own: `kimi`,
 * `copilot`, `cline`, `devin`, `antigravity` and the two Cursor tokens are
 * attributed at commit time but not on `command_invoked`. Closing one means a
 * real capture of that host's environment, added to {@link AGENT_ENV_MARKERS} —
 * an unmeasured key would be the guessing this module exists to refuse, and a
 * wrong marker is worse than the omission it replaces.
 *
 * ## The vocabulary is derived, not restated
 *
 * {@link TELEMETRY_AGENTS} *is* `TRANSCRIPT_SOURCES`, the closed enumeration the
 * discoverers, readers and session registry already share
 * (`SessionSourceDefinition.source` is typed `TranscriptSource`, so a fourteenth
 * host must be added there before it can be registered at all). A hand-written
 * copy of this list is a known rot pattern in this repo — the Codex plugin's
 * copy of a similar list went stale exactly that way when `kimi` shipped — and
 * `TelemetryAgent.test.ts` additionally asserts from the other direction that
 * every registered `SESSION_SOURCES` entry is spellable here.
 */

import { isTranscriptSource, TRANSCRIPT_SOURCES, type TranscriptSource } from "../Types.js";
import { isLocalAgentChild } from "./AgentReentry.js";

/**
 * The closed agent vocabulary. Identical to {@link TRANSCRIPT_SOURCES} by
 * construction — aliased rather than copied so a fourteenth host cannot ship
 * with a silently stale list here.
 */
export const TELEMETRY_AGENTS = TRANSCRIPT_SOURCES;

/** One AI host the work can have happened in. */
export type TelemetryAgent = TranscriptSource;

/**
 * The first client version that emits `agent` — the **watershed**. Rows before
 * it are not missing the field; the fact was never measured, and nothing can
 * recover it (`surface: "cli"` cannot be resolved into "kimi" versus "someone
 * typed `jolli push` by hand"). Every `agent`-sliced chart must start here, or
 * the instrument coming online reads as adoption exploding from zero.
 *
 * Stamped into `TELEMETRY.md` by `TelemetryDoc`, so the disclosure and this
 * constant cannot drift. Update it only if this dimension ships in a different
 * release than planned — never on an ordinary version bump, since the watershed
 * is a fact about history rather than about the current build.
 */
export const AGENT_DIMENSION_SINCE_VERSION = "0.99.14";

/**
 * Env markers that name **exactly one** host, each set by that host itself.
 *
 * Taken from `CaptureProgress.AGENT_ENV_KEYS`, which the post-commit hook
 * already trusts to decide whether a human is watching stdout — the same
 * measured set, read for a different question. `CODEX_THREAD_ID` in particular
 * is the measured Codex entry (present across interactive TUI and `codex exec`,
 * sandboxed and full-access alike, and scoped to command execution so Codex's
 * own lifecycle hooks cannot mistake themselves for the agent's shell).
 *
 * Order carries no meaning: {@link detectAgentFromEnv} requires the matches to
 * agree rather than taking the first, so a precedence here could only hide an
 * ambiguity.
 */
export const AGENT_ENV_MARKERS: ReadonlyArray<readonly [string, TelemetryAgent]> = [
	["CLAUDECODE", "claude"],
	["CODEX_THREAD_ID", "codex"],
	["GEMINI_CLI", "gemini"],
	["OPENCODE", "opencode"],
];

/**
 * Markers that mark an agent session but not **which** agent, so they are
 * deliberately unmapped:
 *
 *  - `AI_AGENT` is generic — Claude Code sets it, and it names no host at all.
 *  - `CURSOR_TRACE_ID` names the Cursor *family*, and we have no measurement
 *    separating the IDE (`cursor`) from `cursor-agent` (`cursor-cli`). That
 *    distinction is part of what makes this dimension worth adding — `surface`
 *    can never draw it — so collapsing the two would spend the value we are
 *    here to gain. Mapping it needs a real capture of both, not a guess.
 *
 * They are listed rather than merely absent so the omission reads as a decision.
 * Cursor is therefore a **known gap** in env-based attribution; the Cursor
 * plugin's own bootstrap still attributes structurally.
 */
export const AMBIGUOUS_AGENT_ENV_KEYS: ReadonlyArray<string> = ["AI_AGENT", "CURSOR_TRACE_ID"];

/** Same truthiness rule `CaptureProgress` applies to these markers. */
function isTruthyEnv(v: string | undefined): boolean {
	return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Coerce an arbitrary value to a known agent token, or `undefined`.
 *
 * The single gate every value passes through on its way to the wire. Anything
 * that is not a member of {@link TELEMETRY_AGENTS} — a non-string, a host we do
 * not know, a typo, free-form user input — answers `undefined`, which callers
 * turn into an omitted property rather than a default.
 */
export function resolveTelemetryAgent(value: unknown): TelemetryAgent | undefined {
	return isTranscriptSource(value) ? value : undefined;
}

/**
 * The host driving this process, read from its environment, or `undefined`.
 *
 * Two refusals are as load-bearing as the mapping:
 *
 * **Disagreement is unknown.** Distinct markers from two hosts mean one agent
 * shelled out to another, and "which host is the user working in" genuinely has
 * no single answer there — so it answers none. (Repeated markers for the *same*
 * host are not a disagreement.)
 *
 * **A local-agent child is not the user's host.** When we spawn `claude` or
 * `codex` outbound to generate a summary, that CLI sets its own marker in every
 * descendant, including a `jolli` we invoke from inside it. Attributing those to
 * the user's host would conflate this dimension with the outbound one it must
 * stay distinct from (`LocalAgentToolId` — if the outbound direction ever needs a
 * name, call it `summarizer`, never `agent`). Env-only, matching the documented
 * pattern for hooks and other direct children of an agent CLI.
 */
export function detectAgentFromEnv(env: NodeJS.ProcessEnv = process.env): TelemetryAgent | undefined {
	if (isLocalAgentChild(env)) return undefined;
	let found: TelemetryAgent | undefined;
	for (const [key, agent] of AGENT_ENV_MARKERS) {
		if (!isTruthyEnv(env[key])) continue;
		if (found !== undefined && found !== agent) return undefined;
		found = agent;
	}
	return found;
}
