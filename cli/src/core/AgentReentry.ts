/**
 * Re-entrancy guard for the local-agent provider.
 *
 * The local-agent backend drives a locally-installed agent CLI (`claude`,
 * `codex`, `cursor-agent`, `opencode`). But most jollimemory users also have
 * jollimemory's own integration installed for those same hosts (hooks, the
 * `jolli` plugin, the globally-registered `jolli mcp` server). Without a guard,
 * the CLI that jollimemory spawns re-triggers jollimemory against the throwaway
 * temp cwd — a SessionStart hook runs `jolli enable`, the host boots
 * `jolli mcp`, etc. — which claims a spurious Memory Bank "repo" named after
 * the temp dir, once per summary call.
 *
 * ## Two independent channels, because env alone is not enough
 *
 * {@link LOCAL_AGENT_CHILD_ENV} covers everything the agent CLI spawns *itself*
 * (hooks inherit env). It does NOT survive an env-sanitizing host: Codex spawns
 * MCP servers with an 11-variable allowlist — `HOME LANG LOGNAME PATH PWD SHELL
 * SHLVL TMPDIR USER _ __CF_USER_TEXT_ENCODING` — so `jolli mcp` starts with the
 * marker stripped. That is what produced 136 stray `jolli-localagent-…` folders
 * under the user's Memory Bank after the env-only guard was already in place.
 *
 * {@link LOCAL_AGENT_SENTINEL} closes that hole: the temp cwd itself carries a
 * marker file, and cwd is the one thing every host preserves (Codex is even
 * handed it explicitly via `-C`). Any future host with its own env policy is
 * covered without a new special case.
 *
 * Each jollimemory entry point a nested agent could re-trigger checks
 * {@link isLocalAgentChild} and no-ops, cutting the recursion at the source.
 * The write-boundary gate in `KBPathResolver.isClaimableProject` is the backstop
 * for anything that still slips through — a guard is only as good as its
 * coverage, and a temp cwd is not a git repo either way.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Env var marking a process spawned (directly or transitively) by the local-agent backend. */
export const LOCAL_AGENT_CHILD_ENV = "JOLLI_LOCAL_AGENT_CHILD";

/**
 * Marker file written into the local-agent temp cwd. A dotfile on purpose: the
 * temp cwd is kept otherwise empty because `claude` folds a cwd `CLAUDE.md`
 * into its system prompt, and a dotfile is inert to every backend.
 */
export const LOCAL_AGENT_SENTINEL = ".jolli-local-agent-child";

/**
 * Prefix for the local-agent temp cwd. Shared with `LlmClient.callLocalAgent`,
 * which recognizes (and safely removes) only directories created here.
 */
export const LOCAL_AGENT_TMP_PREFIX = "jolli-localagent-";

/**
 * Creates the throwaway cwd a local-agent spawn runs in, carrying the sentinel.
 *
 * Every backend goes through this one function so a future fifth backend cannot
 * create a temp cwd that forgets the marker — the failure mode that leaks a
 * permanent Memory Bank folder per call, silently and unrecoverably.
 *
 * A fresh empty cwd is required in the first place because agent CLIs
 * auto-discover instruction files (`CLAUDE.md`, `AGENTS.md`) from cwd and fold
 * them into the system prompt; running in the repo would pollute the summary
 * and burn tokens. Removed again by `LlmClient.callLocalAgent`.
 */
export function createLocalAgentCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), LOCAL_AGENT_TMP_PREFIX));
	writeFileSync(join(cwd, LOCAL_AGENT_SENTINEL), "", "utf-8");
	return cwd;
}

/**
 * True when the current process descends from a local-agent spawn and must not
 * re-enter jollimemory (skip hooks / enable / storage init).
 *
 * `cwd` is **opt-in**, and the split is deliberate:
 *
 *  - **Hooks / `jolli enable` / plugin bootstrap** are spawned by the agent CLI
 *    itself, which is our own direct child with the env we set — env is reliable
 *    there, so they call this with no `cwd` and stay env-only.
 *  - **`jolli mcp` is spawned by the HOST**, not by our child, so the host's env
 *    policy applies and the marker can vanish. That call site passes `cwd`
 *    explicitly to consult the sentinel.
 *
 * Keeping the fs probe opt-in also means the guard cannot be flipped by a caller
 * (or a test) that stubs `existsSync` wholesale for unrelated reasons.
 *
 * Checks `cwd` itself and deliberately does NOT walk up to a parent: a stray
 * sentinel higher in the tree would otherwise silently disable jollimemory for
 * every repo nested beneath it. The backends control cwd exactly, and hosts
 * spawn their MCP servers in that same cwd (verified for Codex: actual process
 * cwd equals the `-C` directory), so the narrower check is the sufficient one.
 */
export function isLocalAgentChild(env: NodeJS.ProcessEnv = process.env, cwd?: string): boolean {
	if (env[LOCAL_AGENT_CHILD_ENV] === "1") return true;
	return cwd !== undefined && existsSync(join(cwd, LOCAL_AGENT_SENTINEL));
}
