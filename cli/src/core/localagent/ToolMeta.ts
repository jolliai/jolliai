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
	 * Present for claude-code ONLY, and that is a decision rather than a gap. Two
	 * things make it the one tool that can be pinned honestly: its model-name space
	 * is one jollimemory already knows, and its response envelope names the model it
	 * actually ran (`modelUsage`), so a pinned model can be VERIFIED instead of
	 * merely asserted. codex, cursor-agent, opencode and kimi report no model at
	 * all, so pinning one there would be an unverifiable claim in a namespace this
	 * project does not own — they keep deferring to the user's own configuration.
	 *
	 * Ids are the tool's own aliases, never a resolved API model id: an alias means
	 * "latest of that family", so it does not rot when a dated model is retired, and
	 * it cannot select a long-context (`[1m]`) SKU, which is priced above the base
	 * model and must only ever be chosen deliberately.
	 */
	readonly models?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

/**
 * The model a pinned tool runs when the user has expressed no preference.
 *
 * The Settings surfaces store it as an ABSENT config value rather than as this
 * string (matching how `model` treats its own default), because they always
 * submit the effective value and would otherwise write it on any unrelated save.
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
		// `data-default` in SettingsHtmlBuilder and `defaultLocalAgentModelFor`.
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
	},
	"cursor-agent": { label: "Cursor", loginHint: "Run `cursor-agent login` to sign in to Cursor." },
	opencode: { label: "OpenCode", loginHint: "Run `opencode auth login` to connect a provider." },
	kimi: { label: "Kimi Code", loginHint: "Run `kimi login` to sign in to your Moonshot account." },
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
 * The single authority for that question, because every surface that accepts a
 * model has to answer it and they had each answered it differently — the
 * dashboard rejected an unknown id outright, the VS Code host dropped it, and
 * `configure --set` stored the default literally where both panels stored it as
 * absent. Those disagree about what `config.json` should look like for the same
 * user intent, which is the drift this module exists to prevent.
 *
 * Dropping rather than rejecting an unknown id is deliberate: every surface that
 * reaches this is a dropdown or a validated flag, so an unrecognised value means
 * a stale page or a hand-edited file, not a decision worth failing an unrelated
 * save over — and the default is the safe landing either way.
 */
export function normalizeStoredLocalAgentModel(submitted: string | undefined): string | undefined {
	const value = submitted?.trim() ?? "";
	if (value === "" || value === DEFAULT_LOCAL_AGENT_MODEL) return undefined;
	return ALL_LOCAL_AGENT_MODEL_IDS.includes(value) ? value : undefined;
}

/**
 * The EFFECTIVE model id to show in a picker for a stored value — the inverse of
 * {@link normalizeStoredLocalAgentModel}, and what both Settings surfaces send to
 * their page.
 *
 * Needed because the default is stored as ABSENT: a picker rendered from the raw
 * stored value would have nothing selected, display its first option anyway, and
 * then submit whatever the form state still held. For an id this build does not
 * know that meant the page displayed "Sonnet (default)" while holding the unknown
 * id, so every later save — including one that only touched an unrelated checkbox
 * — was rejected for a field the user had never edited.
 */
export function effectiveLocalAgentModel(configured: string | undefined): string {
	const value = configured?.trim() ?? "";
	if (value === LOCAL_AGENT_MODEL_INHERIT) return LOCAL_AGENT_MODEL_INHERIT;
	return normalizeStoredLocalAgentModel(value) ?? DEFAULT_LOCAL_AGENT_MODEL;
}

/**
 * The value to put in `tool`'s model flag for a stored `localAgentModel`, where
 * `""` means "emit no model flag at all".
 *
 * The single authority for what the RUNNER does with the stored value; the
 * surfaces use {@link effectiveLocalAgentModel} /
 * {@link normalizeStoredLocalAgentModel} for the display and storage halves of
 * the same setting.
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
	const models = localAgentToolModels(id);
	if (models.length === 0) return "";
	const value = configured?.trim() ?? "";
	if (value === LOCAL_AGENT_MODEL_INHERIT) return "";
	// Membership is checked against THIS tool's own list, not the flat union the
	// validators accept: with a second pinned tool, the union would let that tool's
	// id through every validator and then run it here, where this tool does not
	// offer it. Falling back to the default is what keeps the flag valid.
	return models.some((m) => m.id === value) ? value : DEFAULT_LOCAL_AGENT_MODEL;
}
