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
 * fourteen hosts ({@link TRANSCRIPT_SOURCES}), only three of which ship a plugin
 * bundle; everything else is *observed* by whichever artifact happens to be
 * running, so eleven of fourteen report the surface of the observer.
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
 *  - **Per-connection**, for MCP: the `initialize` handshake's `clientInfo.name`
 *    through {@link resolveClientInfoAgent}. The only channel that works in the
 *    shared `mcp-serve` daemon, where several hosts' sessions reach ONE process
 *    and env inference is disabled — the handshake is per-connection, the env is
 *    frozen at spawn from whichever proxy arrived first. It also beats env on
 *    the single-session path: a declaration outranks an inherited marker.
 *
 * So the gap is a CLI command run from a host with no marker of its own:
 * `kimi` (measured: none exists — see below), `copilot-chat`, `cline` (the
 * VS Code extension) and `devin` (probe blocked) are attributed at commit time
 * but not on `command_invoked`. Closing one means a real capture of
 * that host's environment, added to {@link AGENT_ENV_MARKERS} — an unmeasured
 * key would be the guessing this module exists to refuse, and a wrong marker is
 * worse than the omission it replaces. Cursor was in this list until its
 * environment was actually captured; {@link AGENT_ENV_FAMILIES} records what
 * that took, and it is the worked example for closing another.
 *
 * One of these has been probed and is CLOSED AS UNCLOSABLE by env: **kimi sets
 * no environment variable at all in the shells it spawns** (kimi-code 0.34.0,
 * macOS, 2026-08 — measured in BOTH modes: a one-shot `--prompt` run and an
 * interactive TUI session each dumped their shell child's full env, and both
 * held zero `KIMI_*` and zero `MOONSHOT_*`; the two-mode check matters because
 * cline demonstrably varies its vars by mode, `CLINE_NO_INTERACTIVE`). The only kimi-shaped strings in that env were
 * the user's own PATH entry (`~/.kimi-code/bin`, equally present in a human
 * shell — a PATH sniff would label people as the agent) and the parent process
 * name `kimi-code` (rejected as a signal for the reasons under
 * {@link AGENT_ENV_FAMILIES}: a `ps` spawn on hook-hot paths, and detached
 * workers are reparented away). Kimi therefore stays commit-time-attributed
 * only — re-probe on a major kimi release rather than re-deriving this, and do
 * not add a guessed key.
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

import { type CommitTrigger, isTranscriptSource, TRANSCRIPT_SOURCES, type TranscriptSource } from "../Types.js";
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
	// Probed 2026-08-20 (one-shot agent runs dumping their shell child's full
	// env; the human-shell control held none of these — see the sweep notes
	// below for each host's complete inventory and the caveats):
	["ANTIGRAVITY_AGENT", "antigravity"],
	["COPILOT_CLI", "copilot"],
	["CLINE_WRAPPER_PATH", "cline-cli"],
	["CLINE_CONNECTOR_CLI_LAUNCH", "cline-cli"],
];

/**
 * Provenance for the 2026-08-20 marker sweep (macOS; same probe as kimi's —
 * the agent writes `env` to a file, so nothing depends on output formatting).
 *
 * **antigravity** (`agy` cli-1.1.16, Antigravity's headless CLI): nine
 * `ANTIGRAVITY_*` vars — AGENT=1 (the gate), CONVERSATION_ID, TRAJECTORY_ID,
 * PROJECT_ID, CSRF_TOKEN, LS_ADDRESS, LS_VERSION, AGENTAPI_EXE,
 * SOURCE_METADATA. Two things make this the clean case: the vocabulary has ONE
 * antigravity token (no CLI/IDE variant to confuse — if the IDE's agent sets
 * the same var the answer is identical, and if it does not, IDE work is merely
 * unattributed), and the dump held **no `GEMINI_*` var at all**, so Google's
 * own CLI marker cannot be tripped by Antigravity — a collision that would have
 * mislabelled antigravity work as gemini's, checked for explicitly.
 *
 * **copilot** (GitHub Copilot CLI 1.0.80): COPILOT_CLI=1 (the mapped key,
 * self-naming the CLI variant), COPILOT_AGENT_SESSION_ID,
 * COPILOT_CLI_BINARY_VERSION. Caveat: the sibling source `copilot-chat`
 * (VS Code) is UNMEASURED — the mapping rests on `COPILOT_CLI` naming the CLI
 * itself. Falsifier: a Copilot Chat terminal command observed carrying
 * COPILOT_CLI would demote this to a family key; until then the worst case is
 * family-internal (cli vs chat), never human-vs-agent.
 *
 * **cline-cli** (standalone `cline`): CLINE_WRAPPER_PATH (the CLI's own bin
 * wrapper — set by the launcher, so present in every mode) and
 * CLINE_CONNECTOR_CLI_LAUNCH (launcher JSON) are mapped; CLINE_BUILD_ENV and
 * CLINE_NO_INTERACTIVE were also present but are NOT mapped — BUILD_ENV says
 * nothing about which variant, and NO_INTERACTIVE varies by mode. Same caveat
 * shape as copilot: the `cline` VS Code extension is unmeasured, and the
 * mapped keys are launcher artifacts the extension has no reason to set.
 *
 * **devin**: probe blocked — two consecutive runs died on a server-side
 * retryable API error (`cognition.ai/retryable: true`) before any command ran.
 * Not a measurement of absence; re-run the probe when the service cooperates
 * (`devin --respect-workspace-trust false -p "<probe>"`).
 */

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
 * One Cursor context is measured unattributed, and the scope of that claim
 * matters: an MCP server the **Cursor IDE** spawned carries no `CURSOR_*`
 * variable at all (two live servers, both from the IDE's plugin cache). The
 * likely mechanism is that `CURSOR_AGENT` / `CURSOR_CONVERSATION_ID` are
 * per-conversation, while the IDE spawns MCP servers from a shared process
 * before any workspace is known — the `WARN No workspace folders found` that
 * AGENTS.md records for the same launch — so there is no conversation yet to
 * name. Inference, not measurement.
 *
 * An MCP server `cursor-agent` spawned is **NOT measured**, and the two halves
 * should not be assumed alike: `cursor-agent`'s shell-command children DO carry
 * both markers (row 2 above), so if it spawns MCP the same way, such a server
 * resolves to `cursor-cli` with no code change — this function reads whatever
 * env a process was handed and does not care which parent handed it over. Treat
 * the unattributed case as "the IDE's MCP servers", not as "Cursor's".
 *
 * Neither is rescued by the Cursor plugin's bootstrap, and that is worth being
 * exact about too: the bootstrap attributes the events IT emits
 * (`onboarding_progressed`, `app_installed`) structurally. It is a different
 * process from the MCP server and does not label the server's tool calls.
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

/**
 * MCP `initialize` handshake `clientInfo.name` → agent, per CONNECTION.
 *
 * This is what attributes MCP tool calls, and it is the only signal that can:
 * the env markers are structurally unavailable there (measured — of the hosts
 * checked, only Claude passes a marker to an MCP child, and the shared
 * `mcp-serve` daemon may not read its env at all, since one daemon serves
 * several hosts' sessions and its env is frozen at spawn). `clientInfo` is the
 * host DECLARING itself, once per connection, which is exactly the granularity
 * a shared daemon needs.
 *
 * Keys are exact strings, each traceable to a probe capture (a minimal MCP
 * server that logs the raw `initialize` request — the probe recipe lives with
 * the design note). Guessing a key is worse than omitting it: `codex` here
 * would have been the obvious guess and is WRONG — the measured value is
 * `codex-mcp-client`. An unmapped name degrades to an absent property (unknown),
 * never to a pass-through — `clientInfo.name` is an arbitrary host-authored
 * string, and forwarding it verbatim would break the never-free-form rule. The
 * `oninitialized` log line in `createMcpServer` records unmapped names locally,
 * which is how the next host's exact string gets captured organically.
 *
 * Captured 2026-08-20 on macOS:
 *   claude-code       claude  2.1.212, `claude -p … --strict-mcp-config`
 *   codex-mcp-client  codex   0.147.0, `codex exec -c mcp_servers.probe…`
 *
 * One captured name is deliberately NOT mapped: `cursor-agent` declares
 * `{"name":"Cursor","version":"1.0.0"}` — a family name with a hardcoded
 * version, and the Cursor IDE's own clientInfo is unmeasured (the IDE spawns
 * MCP from a shared process; no one-shot command reaches it, and its logs
 * record only the server's info). If the IDE also says "Cursor", mapping it
 * would collapse `cursor`/`cursor-cli` — the split this vocabulary exists to
 * keep — so it waits, exactly like `CURSOR_TRACE_ID` did. The oninitialized
 * log line captures the IDE's string the first time this dist serves one.
 */
export const CLIENTINFO_AGENTS: ReadonlyMap<string, TelemetryAgent> = new Map([
	["claude-code", "claude"],
	["codex-mcp-client", "codex"],
]);

/**
 * Coerce an MCP client's self-declared name to a known agent token, or
 * `undefined`. The clientInfo counterpart of {@link resolveTelemetryAgent}: same
 * contract (closed set in, absent out), different key space — clientInfo names
 * are the hosts' own spellings, not our vocabulary.
 */
/**
 * Env var a skill's run-cli recipe sets on the ONE command it invokes:
 * `JOLLI_INVOKED_VIA=skill:<bare-name>`. The `via` telemetry dimension — how a
 * command was reached (a skill, vs typed directly), as distinct from which host
 * ran it (`agent`). `TelemetryCommandHook` consumes it: read once, validated
 * against {@link SKILL_VIA_NAMES}, then DELETED from the process env so a child
 * the command spawns (a detached daemon, a chained worker) cannot inherit a
 * claim that was only ever about this invocation.
 */
export const JOLLI_INVOKED_VIA_ENV = "JOLLI_INVOKED_VIA";

/**
 * The bare skill names that may appear in a `skill:<name>` via value.
 *
 * BARE names (`recall`, not `jolli-recall`) for a renderer reason: the Codex
 * plugin generator rewrites `jolli-<name>` substrings to `jolli:<name>` across
 * every shared skill body, so the prefixed spelling would ship corrupted in
 * that bundle. Bare names also make the value host-neutral — all three plugin
 * bundles and the installed copies emit the same token.
 *
 * A hand-kept copy of the union of every skill name Jolli ships — the
 * installed registry plus both plugin bundles' own skills — kept deliberately: this
 * module is a leaf that `Telemetry`, `TelemetryStartup` and the hooks all
 * import, and deriving the list live would drag `install/SkillInstaller` (the
 * whole install stack) into every one of them. The same trade
 * `ClientHeader.PLUGIN_BUNDLE_KINDS` makes, policed the same way:
 * `TelemetryAgent.test.ts` asserts it equals the bare-name union of
 * `SkillInstaller.INSTALLED_SKILL_NAMES`, `CODEX_PLUGIN_SKILL_NAMES` and
 * `CURSOR_PLUGIN_SKILL_NAMES`, so the copy cannot drift silently when a skill
 * is added or retired in ANY of the three.
 *
 * Every shipped run-cli recipe now carries its prefix (pinned per builder and
 * per committed bundle file), so the set also includes names whose skills are
 * currently MCP-only (`timeline`, `push`) — they emit nothing today, and being
 * in the set means a future recipe there is a skill-template change only.
 */
export const SKILL_VIA_NAMES: ReadonlyArray<string> = [
	"recall",
	"search",
	"local-run",
	"remote-run",
	"jolli",
	"init",
	"login",
	"logout",
	"status",
	"timeline",
	"push",
	"dashboard",
];

const SKILL_VIA_SET: ReadonlySet<string> = new Set(SKILL_VIA_NAMES);

/**
 * Validate a raw `JOLLI_INVOKED_VIA` value to a wire-safe `via` token, or
 * `undefined`. Same contract as every other gate in this module: closed set in,
 * absent out, never a pass-through — the env var is settable by anything, so an
 * unrecognised value (wrong prefix, unknown name, free text) is dropped whole
 * rather than partially honoured.
 */
export function resolveInvokedVia(value: string | undefined): string | undefined {
	if (value === undefined || !value.startsWith("skill:")) return undefined;
	const name = value.slice("skill:".length);
	return SKILL_VIA_SET.has(name) ? value : undefined;
}

/** Who set a commit in motion, plus which host when the answer is an agent. */
export interface CommitOrigin {
	readonly trigger: CommitTrigger;
	/** Present only when `trigger === "agent"` and the family/marker named one host. */
	readonly agent?: TelemetryAgent;
}

/**
 * Resolve who set a commit in motion, at ENQUEUE time — inside the post-commit
 * hook, whose process env and stdio are the last place the truth exists. The
 * worker that drains the entry cannot re-derive any of this: it may be a
 * chain-spawned survivor of an earlier commit (so its env belongs to that
 * commit), and it never has the committing terminal's TTY.
 *
 * Precedence, and why each step beats the next:
 *
 *  1. **The IDE's Commit button** (`fromPluginUi` — the `plugin-source` marker
 *     both IDE bridges write immediately before running `git commit`). Beats
 *     the env markers deliberately: an extension host cold-started from inside
 *     an agent session inherits that agent's marker for the window's whole
 *     life, so a button commit would otherwise be labelled as the agent's work.
 *     The marker is written milliseconds before THIS commit by the click
 *     handler itself — the most specific signal there is — and the hook deletes
 *     it after reading, so it cannot leak onto a later terminal commit. `ui`
 *     also deliberately carries NO agent.
 *  2. **An agent's markers** ({@link detectAgentFromEnv}) — the hook is git's
 *     child, git is the committer's child, so the env chain is short and
 *     current. Beats the TTY check because an agent session never gives the
 *     hook a TTY, while a human's always does — so when a marker is present,
 *     the TTY answer is already known to be false.
 *  3. **A TTY** — a human typing `git commit`.
 *  4. **`unknown`** — GUI git clients, cron, CI. NOT "terminal": absence of a
 *     TTY is an absence, and the whole dimension's rule is that absence reads
 *     as unknown rather than as the nearest plausible value.
 */
export function resolveCommitOrigin(opts: {
	readonly fromPluginUi: boolean;
	readonly isTTY: boolean;
	readonly env?: NodeJS.ProcessEnv;
}): CommitOrigin {
	if (opts.fromPluginUi) return { trigger: "ui" };
	const agent = detectAgentFromEnv(opts.env ?? process.env);
	if (agent) return { trigger: "agent", agent };
	return { trigger: opts.isTTY ? "terminal" : "unknown" };
}

export function resolveClientInfoAgent(name: string | undefined): TelemetryAgent | undefined {
	// A Map, not a plain object: the name is host-authored input, and a bare
	// object index would answer `Object` for "constructor" — a truthy Function
	// leaking through a lookup typed as a token. Map.get has no prototype chain.
	return name === undefined ? undefined : CLIENTINFO_AGENTS.get(name);
}

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
