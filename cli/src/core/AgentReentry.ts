/**
 * Re-entrancy guard for the local-agent provider.
 *
 * The local-agent backend drives a locally-installed `claude` CLI. But most
 * jollimemory users also have jollimemory's own Claude integration installed
 * (the `jolli` Claude Code plugin / hooks / MCP). Without a guard, the `claude`
 * that jollimemory spawns re-triggers jollimemory against the throwaway temp
 * cwd — the plugin's SessionStart hook runs `jolli enable`, a Stop hook records
 * a session, etc. — which historically claimed a spurious Memory Bank "repo"
 * named after the temp dir (one per summary call).
 *
 * The backend sets {@link LOCAL_AGENT_CHILD_ENV} on the spawned child. Because
 * child processes inherit their parent's environment, every hook / CLI process
 * that the nested `claude` itself spawns also sees it. Each jollimemory entry
 * point that a nested `claude` could re-trigger checks {@link isLocalAgentChild}
 * and no-ops, cutting the recursion at the source — independent of whether the
 * temp cwd happens to be a git repo or which hook modes a future `claude`
 * fires.
 */

/** Env var marking a process spawned (directly or transitively) by the local-agent backend. */
export const LOCAL_AGENT_CHILD_ENV = "JOLLI_LOCAL_AGENT_CHILD";

/**
 * True when the current process descends from a local-agent `claude` spawn and
 * must not re-enter jollimemory (skip hooks / enable / storage init).
 */
export function isLocalAgentChild(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[LOCAL_AGENT_CHILD_ENV] === "1";
}
