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
 * `copilot`, `cline`, `devin` and `antigravity` are attributed at commit time
 * but not on `command_invoked`. Closing one means a real capture of that host's
 * environment, added to {@link AGENT_ENV_MARKERS} — an unmeasured key would be
 * the guessing this module exists to refuse, and a wrong marker is worse than
 * the omission it replaces. Cursor was in this list until its environment was
 * actually captured; {@link AGENT_ENV_FAMILIES} records what that took, and it
 * is the worked example for closing another.
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
 * constant cannot drift, and `TELEMETRY.md` is the repo's public statement of
 * what is collected — a wrong number here is a wrong public fact.
 *
 * **Deliberately hand-written, and deliberately NOT derived from
 * `cli/package.json`.** It is a fact about history: once this dimension has
 * shipped, the answer is frozen forever, so tracking the current build would
 * rewrite it on every release and destroy the only thing it records. That also
 * means it starts life as a PREDICTION — the release this lands in is not
 * knowable while writing it — and a prediction that goes wrong fails silently:
 * nothing in the build can tell a correct guess from a stale one.
 *
 * `TelemetryAgent.test.ts` narrows that hole as far as it can go, by asserting
 * this is never BELOW `cli/package.json`'s version. The feature cannot ship in a
 * release older than the constant, so if main's version overtakes it while this
 * is still unreleased, the guess has been overtaken too and the test says so.
 * The remaining gap is genuine: nothing can distinguish "ships next release, as
 * predicted" from "will ship two releases later", so a release that moves this
 * must update the constant AND re-run `npm run gen:telemetry-doc`.
 */
export const AGENT_DIMENSION_SINCE_VERSION = "0.99.14";

/**
 * Env markers that name **exactly one** host, each set by that host itself.
 *
 * Drawn from `CaptureProgress.AGENT_ENV_KEYS`, which the post-commit hook uses
 * to decide whether a human is watching stdout — a different question off the
 * same signal. Deliberately NOT imported from it, and the two must not be
 * merged: that list only needs "is an agent driving this", so one entry per
 * family is enough, while this one has to name WHICH host and therefore splits
 * families (see {@link AGENT_ENV_FAMILIES}) and refuses ambiguous keys.
 *
 * Keeping them separate is not hypothetical tidiness — that list's Cursor entry
 * (`CURSOR_TRACE_ID`) turns out not to exist; see
 * {@link AMBIGUOUS_AGENT_ENV_KEYS}. So treat "it is in that list" as a lead, not
 * as evidence: every entry here should be traceable to a capture. `CODEX_THREAD_ID`
 * is (present across interactive TUI and `codex exec`, sandboxed and full-access
 * alike, and scoped to command execution so Codex's own lifecycle hooks cannot
 * mistake themselves for the agent's shell), and `CLAUDECODE` was confirmed on a
 * live machine, including in an MCP server Claude Code had spawned.
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
 * A host family whose presence marker cannot name the variant on its own, plus
 * the markers that do.
 *
 * Cursor is the only one, and it is the reason this shape exists rather than a
 * second flat entry: `cursor` (the IDE) and `cursor-cli` (`cursor-agent`) must
 * stay separate tokens — `surface` can never draw that line, and drawing it is
 * part of what makes this dimension worth having — so collapsing them to a
 * single "cursor" would spend the value we are here to gain.
 */
export interface AgentEnvFamily {
	/** Set in every one of this family's contexts, and in no other. */
	readonly familyKey: string;
	/** Evidence for one variant each. Must be mutually exclusive. */
	readonly variants: ReadonlyArray<readonly [string, TelemetryAgent]>;
}

/**
 * Measured on Cursor (macOS, 2026-08) by dumping `CURSOR_*` in the three
 * contexts that matter, which is what makes the split safe. The parent process
 * is recorded beside each because it is what proves the three samples really
 * came from three different places, rather than three runs of one shell:
 *
 *   IDE agent    parent `Cursor Helper (Plugin): extension-host`
 *                CURSOR_AGENT, CURSOR_CONVERSATION_ID, CURSOR_LAYOUT,
 *                CURSOR_RIPGREP_PATH, CURSOR_WORKSPACE_LABEL
 *   cursor-agent parent `~/.local/bin/agent`
 *                CURSOR_AGENT, CURSOR_ASKPASS_SECRET, CURSOR_ASKPASS_SOCKET,
 *                CURSOR_CONVERSATION_ID, CURSOR_INVOKED_AS, CURSOR_RIPGREP_PATH
 *   human shell  parent `Cursor Helper: terminal pty-host`
 *                (nothing at all)
 *
 * Those parent names separate the three contexts more sharply than the env does,
 * and were still rejected as the SIGNAL. Reading them costs a `ps` subprocess on
 * macOS (no `/proc`, and Node exposes only `ppid`) on a path that runs ahead of
 * every command dispatch and inside `<5ms` git hooks. They are display strings
 * that vary by platform and version, and `agent` is a basename from one install
 * layout. Decisively, the parent link is broken exactly where env inheritance is
 * most useful: `QueueWorker` is a DETACHED spawn, so it is reparented away from
 * whatever committed, while the env it was handed survives intact.
 *
 * `CURSOR_AGENT` is the family gate because the third row is what makes it
 * usable: it is absent when a person types in Cursor's own integrated terminal,
 * so mapping it cannot label human work as an agent's — a failure that would be
 * worse than the gap it replaces, since it attacks the field's whole meaning.
 *
 * The variant keys are chosen for semantics, not just for having differed once:
 * a CLI has no workspace label or editor layout, and `CURSOR_INVOKED_AS` names
 * how the binary was started. `CURSOR_LAYOUT` (IDE) and the `CURSOR_ASKPASS_*`
 * pair (CLI) discriminated identically and are held in reserve — one key per
 * side keeps a future rename degrading to *unknown* rather than to a coin flip.
 * `CURSOR_CONVERSATION_ID` and `CURSOR_RIPGREP_PATH` appear on both sides and so
 * could serve as the gate, but neither says "agent" in its name.
 *
 * One Cursor context stays unattributed and is not covered by any of this: an
 * MCP server Cursor spawned carries no `CURSOR_*` variable at all (measured on
 * two live servers). That path is attributed only by the Cursor plugin's own
 * bootstrap, which is structural.
 */
export const AGENT_ENV_FAMILIES: ReadonlyArray<AgentEnvFamily> = [
	{
		familyKey: "CURSOR_AGENT",
		variants: [
			["CURSOR_WORKSPACE_LABEL", "cursor"],
			["CURSOR_INVOKED_AS", "cursor-cli"],
		],
	},
];

/**
 * Markers that mark an agent session but not **which** agent, and that no
 * variant marker rescues — so they are deliberately unmapped.
 *
 *  - `AI_AGENT` is generic. Claude Code sets it, and while its VALUE encodes a
 *    host (`claude-code_2-1-234_agent` / `…_harness`, captured live), parsing a
 *    value prefix is a guess until other hosts have been sampled — and for
 *    Claude it is redundant with `CLAUDECODE` anyway.
 *  - `CURSOR_TRACE_ID` was this list's original reason to exist, as the Cursor
 *    family marker that could not name a variant. The capture above found it in
 *    **none** of the three contexts, so it is kept here only as a guard: if some
 *    other Cursor build does set it, it still cannot discriminate, and
 *    `CURSOR_AGENT` is the marker that actually appears. Note
 *    `CaptureProgress.AGENT_ENV_KEYS` still keys Cursor off it, which is a
 *    separate, pre-existing bug in a different feature.
 *
 * Listed rather than merely absent so each omission reads as a decision.
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
	const claim = (agent: TelemetryAgent): boolean => {
		if (found !== undefined && found !== agent) return false;
		found = agent;
		return true;
	};
	for (const [key, agent] of AGENT_ENV_MARKERS) {
		if (!isTruthyEnv(env[key])) continue;
		if (!claim(agent)) return undefined;
	}
	for (const family of AGENT_ENV_FAMILIES) {
		if (!isTruthyEnv(env[family.familyKey])) continue;
		// A present family gate that resolves to no single variant abandons the
		// WHOLE answer rather than contributing nothing. Contributing nothing would
		// let another host's marker win an environment this family is also present
		// in — reporting a confident single host for a nested session — and it would
		// equally let a future Cursor build that renamed both variant keys fall
		// through to whatever else happened to be set.
		const matched = new Set(family.variants.filter(([key]) => isTruthyEnv(env[key])).map(([, agent]) => agent));
		const [only] = matched;
		if (matched.size !== 1 || only === undefined) return undefined;
		if (!claim(only)) return undefined;
	}
	return found;
}
