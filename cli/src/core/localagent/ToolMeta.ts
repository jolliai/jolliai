import type { LocalAgentToolId } from "../../Types.js";

export interface LocalAgentToolMeta {
	/** Footer / UI display name, e.g. "Cursor" → footer "Local agent - Cursor". */
	readonly label: string;
	/** Actionable sign-in guidance shown by doctor when auth is missing. */
	readonly loginHint: string;
	/**
	 * Name of the desktop app whose login users confuse with this CLI's, when such
	 * an app exists AND the two credentials are known to be stored separately.
	 *
	 * This drives the single most load-bearing line of the auth-expiry remediation
	 * (see `hooks/AuthRemediation.ts`): the CLI's OAuth token drifts stale while the
	 * desktop app stays happily signed in, so without this note the user reads
	 * "authentication expired" as simply wrong. Set ONLY where the separation is
	 * verified — an unverified claim sends the user to check the wrong app, which is
	 * worse than staying silent. `cursor-agent` and `opencode` are deliberately
	 * unset: OpenCode ships no desktop app, and Cursor's IDE/CLI credential
	 * relationship has not been confirmed. Add one once verified.
	 */
	readonly separateDesktopApp?: string;
	/**
	 * Model choices jollimemory pins for this tool, or absent when it does not pin
	 * one and the tool keeps running whatever the user configured it with.
	 *
	 * Present for claude-code and codex; cursor-agent, opencode and kimi keep
	 * deferring to the user's own configuration. That split is a decision rather
	 * than a gap — cursor's catalogue is 200+ entries of which a free plan can use
	 * one, and opencode spends the user's own provider credit.
	 *
	 * The two pinned tools differ in a way callers must not average over:
	 *
	 * - **claude-code's ids are permanent aliases** (`sonnet` tracks the latest of
	 *   its family), so they never rot, and they cannot select a long-context
	 *   (`[1m]`) SKU, which is priced above the base model and must only ever be
	 *   chosen deliberately. Its envelope also names the model it actually ran
	 *   (`modelUsage`), so the pin can be VERIFIED rather than merely asserted.
	 * - **codex's ids are dated slugs** with no alias equivalent, so this list needs
	 *   a release when codex ships a generation — and codex reports no model, so its
	 *   recorded value is the one we REQUESTED, not one we observed.
	 *
	 * Ids are always the tool's OWN identifiers, never `resolveModelId`'s API model
	 * id, and never shared across tools: the namespaces are disjoint, which is why
	 * {@link defaultModel} is per tool.
	 */
	readonly models?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
	/**
	 * Which of this tool's own {@link models} it runs when the user has expressed no
	 * preference. Absent exactly when `models` is.
	 *
	 * Per tool rather than one global constant because model ids are the CLI's own
	 * namespace and two pinned tools share none — falling back to another tool's
	 * default is not a milder answer, it is an id this tool will refuse. Nothing in
	 * the type system ties this to `models`, so `ToolMeta.test.ts` asserts
	 * membership for every entry that declares either.
	 */
	readonly defaultModel?: string;
}

/**
 * The model `claude-code` runs when the user has expressed no preference.
 *
 * Named for claude-code specifically, NOT as a cross-tool fallback —
 * {@link localAgentToolDefaultModel} is what answers that question for a given
 * tool. The distinction became load-bearing with the second pinned tool: this
 * constant used to be what an unrecognised value fell back to for EVERY tool, so
 * a stored `sonnet` carried into codex would have emitted `-m sonnet` at a CLI
 * that has never heard of it.
 *
 * The Settings surfaces store the default as an ABSENT config value rather than
 * as this string (matching how `model` treats its own default), because they
 * always submit the effective value and would otherwise write it on any unrelated
 * save.
 */
export const DEFAULT_LOCAL_AGENT_MODEL = "sonnet";

/**
 * The one model id that means "send no model flag at all", i.e. run whatever the
 * tool itself is configured with.
 *
 * It exists so that inheriting the user's interactive model choice stays
 * reachable as an EXPLICIT choice rather than being the silent default. That
 * distinction is the whole point: a background, mechanical workload that inherits
 * a frontier long-context model costs an unpredictable amount that differs per
 * machine, which is what pinning is here to stop.
 */
export const LOCAL_AGENT_MODEL_INHERIT = "inherit";

export const LOCAL_AGENT_TOOLS: Record<LocalAgentToolId, LocalAgentToolMeta> = {
	"claude-code": {
		label: "Claude Code",
		loginHint: "Run `claude` once and sign in to your subscription.",
		separateDesktopApp: "Claude Desktop",
		// Labels and ORDER are kept identical to the Anthropic provider's own model
		// picker, which both Settings surfaces render a few rows away — two pickers
		// that name the same three model families differently read as two different
		// settings. Deliberately no version number in a label: an alias tracks the
		// latest of its family, so "Opus" resolved to claude-opus-4-8 when this was
		// written and will resolve to something else later.
		//
		// The default is NOT first, so nothing may infer it from position — see
		// `data-default` in SettingsHtmlBuilder and {@link localAgentToolDefaultModel}.
		defaultModel: DEFAULT_LOCAL_AGENT_MODEL,
		models: [
			{ id: "haiku", label: "Haiku — fastest" },
			{ id: DEFAULT_LOCAL_AGENT_MODEL, label: "Sonnet — balanced (default)" },
			{ id: "opus", label: "Opus — most capable" },
			// The one entry with no Anthropic counterpart: it selects no model at all
			// rather than a cheaper one, so it keeps its own wording.
			{ id: LOCAL_AGENT_MODEL_INHERIT, label: "Use Claude Code's own setting" },
		],
	},
	codex: {
		label: "Codex",
		loginHint: "Run `codex login` to sign in with your ChatGPT plan.",
		separateDesktopApp: "the ChatGPT app",
		// Balanced, not the frontier model, for the same reason claude-code defaults
		// to Sonnet: this is a background, mechanical workload.
		defaultModel: "gpt-5.6-terra",
		// Ordered cheapest-to-most-capable with the default in the MIDDLE, matching
		// the claude-code list above so the two pickers read the same way.
		//
		// Unlike claude's `sonnet` / `opus`, these are NOT permanent aliases — codex
		// has none. Every id here is a dated slug that will eventually retire, so
		// this list needs a release when codex ships a new generation. That is the
		// accepted cost of not fetching it: `codex app-server`'s `model/list` is an
		// undocumented private interface, costs ~2.2 s per call, and answers with a
		// built-in fallback list — wrong in BOTH directions, with no marker saying
		// so — whenever the CLI cannot parse the server's response (measured: a
		// codex a few versions behind listed two models it could not run and none of
		// the three it could). Entitlement also drifts under a fixed client, so a
		// fetched list is no more authoritative at call time than this one. What
		// makes either safe is the refusal classification in CodexBackend, not where
		// the list came from.
		//
		// 5.4 and 5.4-mini are deliberately absent: they retire 2026-08-31, and a
		// list that ships in a release cannot track that.
		models: [
			{ id: "gpt-5.6-luna", label: "GPT-5.6-Luna — fastest" },
			{ id: "gpt-5.6-terra", label: "GPT-5.6-Terra — balanced (default)" },
			{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol — most capable" },
			{ id: "gpt-5.5", label: "GPT-5.5 — previous generation" },
			{ id: LOCAL_AGENT_MODEL_INHERIT, label: "Use Codex's own setting" },
		],
	},
	"cursor-agent": { label: "Cursor", loginHint: "Run `cursor-agent login` to sign in to Cursor." },
	opencode: { label: "OpenCode", loginHint: "Run `opencode auth login` to connect a provider." },
	kimi: { label: "Kimi Code", loginHint: "Run `kimi login` to sign in to your Moonshot account." },
	// No `models` list on purpose: Hermes model ids are `provider/model` pairs over
	// a user-defined provider set, so any list shipped here would be a 400 on some
	// machine. `resolveLocalAgentModel` then yields "" and no `-m` is emitted, and
	// the user's own `model.default` answers — see HermesBackend decision 4.
	// The IntelliJ DEFAULT_TOOLS mirror carries this entry too (pinned by
	// `LocalAgentToolsTest`); the remaining IntelliJ Hermes work — the
	// `TranscriptSource` enum member and its UI wiring — is tracked by the
	// `KNOWN_JVM_TRANSCRIPT_SOURCE_GAPS` list in
	// `cli/src/core/TranscriptSourceJvmLockstep.test.ts`.
	hermes: { label: "Hermes", loginHint: "Run `hermes setup` (or `hermes model`) to configure a provider." },
};

// The `?? …` fallbacks below are unreachable per the `LocalAgentToolId` type,
// but the value on the wire is not: `localAgentTool` is read from the
// machine-global config.json (shared across CLI / VS Code / IntelliJ and, more
// importantly, across versions) and from persisted summary metadata. A newer
// build that adds a tool id, written then read back by an older build, or a
// hand-edited config, yields an id outside this map — indexing it unguarded
// throws a TypeError that hard-crashes `jolli status` / `jolli doctor` / the MCP
// status tool / footer rendering. Degrade to the generic label / no hint instead.
export function localAgentToolLabel(id: LocalAgentToolId): string {
	return LOCAL_AGENT_TOOLS[id]?.label ?? "Local agent";
}

export function localAgentToolLoginHint(id: LocalAgentToolId): string {
	return LOCAL_AGENT_TOOLS[id]?.loginHint ?? "Sign in to your local agent CLI.";
}

/**
 * The "this login is separate from the desktop app" clarification for `id`, or null
 * when the tool has no such app (or the separation is unverified — see
 * {@link LocalAgentToolMeta.separateDesktopApp}). Null is a normal outcome, not a
 * fallback: callers omit the line entirely rather than substituting a generic one.
 */
export function localAgentToolSeparateLoginNote(id: LocalAgentToolId): string | null {
	const app = LOCAL_AGENT_TOOLS[id]?.separateDesktopApp;
	return app === undefined ? null : `(This login is SEPARATE from ${app} — ${app} stays signed in on its own.)`;
}

/**
 * The model choices offered for `id`, or an EMPTY list when jollimemory does not
 * pin a model for that tool.
 *
 * An empty list is the signal every surface branches on rather than testing for
 * the string "claude-code": the dashboard card gates its row on this, the VS Code
 * panel tags each option with its tool and counts them, and `configure --set`
 * derives from it the list of pinned tools its help text names. So adding a second
 * pinned tool is a change to {@link LOCAL_AGENT_TOOLS} alone.
 */
export function localAgentToolModels(id: LocalAgentToolId): ReadonlyArray<{ id: string; label: string }> {
	return LOCAL_AGENT_TOOLS[id]?.models ?? [];
}

/**
 * The model `id` runs when the user has expressed no preference, or `""` for a
 * tool that pins none.
 *
 * The single authority for "which default", and the reason it is a function
 * rather than {@link DEFAULT_LOCAL_AGENT_MODEL}: each pinned tool's ids live in
 * its own CLI's namespace, so there is no value that is a sane default for two of
 * them at once.
 *
 * `""` for an unpinned tool is the same "emit no model flag" signal
 * {@link resolveLocalAgentModel} returns, so the two agree without a special case.
 */
export function localAgentToolDefaultModel(id: LocalAgentToolId): string {
	return LOCAL_AGENT_TOOLS[id]?.defaultModel ?? "";
}

/**
 * The model `id` should use for a stored value, resolved against that tool's OWN
 * list: the value when the tool offers it, {@link LOCAL_AGENT_MODEL_INHERIT} when
 * that is what was asked for, and the tool's default otherwise.
 *
 * The one place the "which model" question is answered, for the runner via
 * {@link resolveLocalAgentModel} and for storage via
 * {@link normalizeStoredLocalAgentModel}.
 *
 * There is deliberately no DISPLAY wrapper. Both Settings surfaces carry the raw
 * stored value and resolve it against the options they already render, marked
 * with each tool's own default — a server-resolved display value was what made an
 * untouched save destructive, since the panels submit whatever they were handed.
 */
function pickLocalAgentModel(id: LocalAgentToolId, configured: string | undefined): string {
	const value = configured?.trim() ?? "";
	if (value === LOCAL_AGENT_MODEL_INHERIT) return LOCAL_AGENT_MODEL_INHERIT;
	// Membership is checked against THIS tool's own list, never the flat union the
	// validators accept: the union deliberately lets another tool's id through (the
	// two settings are written in either order), and this is where that id must not
	// survive.
	return localAgentToolModels(id).some((m) => m.id === value) ? value : localAgentToolDefaultModel(id);
}

/**
 * Every model id any pinned tool offers, de-duplicated — the accept-set for the
 * three surfaces that take a `localAgentModel` from outside (`configure --set`,
 * the dashboard POST, the VS Code panel's save).
 *
 * A flat union rather than a per-tool check on purpose: `localAgentModel` and
 * `localAgentTool` are independent settings written in either order, so a
 * validator that demanded the model belong to the CURRENTLY stored tool would
 * reject a valid value merely because the tool has not been switched yet.
 * Applying the value to the tool actually in force is
 * {@link resolveLocalAgentModel}'s job, which falls back to the default for one
 * that tool does not offer — the flag has to stay valid, and "no flag" would mean
 * something different (inherit) than the user asked for.
 */
export const ALL_LOCAL_AGENT_MODEL_IDS: ReadonlyArray<string> = [
	...new Set(Object.values(LOCAL_AGENT_TOOLS).flatMap((meta) => (meta.models ?? []).map((m) => m.id))),
];

/**
 * What to STORE for a submitted model id: `undefined` (i.e. absent) for the
 * default, the empty string, and anything no pinned tool offers; the trimmed
 * value otherwise.
 *
 * The authority for the two SETTINGS PANELS, which had answered it differently
 * from each other — the dashboard rejected an unknown id outright where the VS
 * Code host dropped it.
 *
 * `configure --set` deliberately does NOT call this: it stores what was typed
 * VERBATIM, explicit default included, because typing a model's name is a choice
 * where selecting the default option in a picker is the absence of one. So one
 * config key really does have two persistence semantics by entry point, and that
 * is a decision (see specs/62), not drift this function failed to remove. It
 * matters more now than it used to: codex's ids are dated slugs, so when a
 * default rotates, an absent value follows it while a literal one stays pinned to
 * the model that used to be the default.
 *
 * Dropping rather than rejecting an unknown id is deliberate: every surface that
 * reaches this is a dropdown or a validated flag, so an unrecognised value means
 * a stale page or a hand-edited file, not a decision worth failing an unrelated
 * save over — and the default is the safe landing either way.
 */
export function normalizeStoredLocalAgentModel(
	id: LocalAgentToolId,
	submitted: string | undefined,
): string | undefined {
	const value = submitted?.trim() ?? "";
	// "Equal to the default" is now a per-tool question, which is why this takes the
	// tool. An unpinned tool's default is "", already handled by the first test.
	if (value === "" || value === localAgentToolDefaultModel(id)) return undefined;
	// Still the flat union, NOT this tool's list, and the reason is the CLI rather
	// than the panels: `configure --set localAgentModel=…` and `--set
	// localAgentTool=…` are two commands in either order, so rejecting a model the
	// currently-stored tool does not offer would fail a valid half-finished setup.
	//
	// Note this does NOT make a cross-tool choice survive a round trip through the
	// panels: they submit the EFFECTIVE value, which `pickLocalAgentModel` has
	// already collapsed to the shown tool's default. That is the correct outcome
	// there — the user saw the picker holding that default when they saved.
	return ALL_LOCAL_AGENT_MODEL_IDS.includes(value) ? value : undefined;
}

/**
 * The value to put in `tool`'s model flag for a stored `localAgentModel`, where
 * `""` means "emit no model flag at all".
 *
 * The single authority for what the RUNNER does with the stored value; the
 * surfaces use {@link normalizeStoredLocalAgentModel} for the storage half of the
 * same setting, and resolve the display half themselves.
 *
 * An unrecognised stored value falls back to the default rather than being passed
 * through, and that is the load-bearing case. This value comes from the
 * machine-global config.json, which is shared across surfaces AND across versions
 * — a newer build that adds a model id, written then read back by an older build,
 * or a hand-edited file, yields an id this build does not know. Passing it through
 * would send `--model <garbage>`, which the CLI answers with a 404 setup error,
 * i.e. every generation on the machine failing at once. Same reasoning as the
 * `?? …` fallbacks above, with a costlier failure mode.
 */
export function resolveLocalAgentModel(id: LocalAgentToolId, configured: string | undefined): string {
	if (localAgentToolModels(id).length === 0) return "";
	const picked = pickLocalAgentModel(id, configured);
	return picked === LOCAL_AGENT_MODEL_INHERIT ? "" : picked;
}
