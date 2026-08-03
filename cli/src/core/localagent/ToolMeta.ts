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
}

export const LOCAL_AGENT_TOOLS: Record<LocalAgentToolId, LocalAgentToolMeta> = {
	"claude-code": {
		label: "Claude Code",
		loginHint: "Run `claude` once and sign in to your subscription.",
		separateDesktopApp: "Claude Desktop",
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
