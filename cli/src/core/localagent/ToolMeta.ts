import type { LocalAgentToolId } from "../../Types.js";

export interface LocalAgentToolMeta {
	/** Footer / UI display name, e.g. "Cursor" → footer "Local agent - Cursor". */
	readonly label: string;
	/** Actionable sign-in guidance shown by doctor when auth is missing. */
	readonly loginHint: string;
}

export const LOCAL_AGENT_TOOLS: Record<LocalAgentToolId, LocalAgentToolMeta> = {
	"claude-code": { label: "Claude Code", loginHint: "Run `claude` once and sign in to your subscription." },
	codex: { label: "Codex", loginHint: "Run `codex login` to sign in with your ChatGPT plan." },
	"cursor-agent": { label: "Cursor", loginHint: "Run `cursor-agent login` to sign in to Cursor." },
	opencode: { label: "OpenCode", loginHint: "Run `opencode auth login` to connect a provider." },
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
