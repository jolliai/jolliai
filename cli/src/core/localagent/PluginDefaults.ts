import type { JolliMemoryConfig, LocalAgentToolId } from "../../Types.js";
import { updateConfigTransactional } from "../SessionTracker.js";

/** The AI host a plugin bootstrap is acting for. */
export type PluginBootstrapHost = "claude" | "codex";

interface PluginHostProfile {
	/** Which host's own assets (`.claude/**` etc.) this bootstrap owns. */
	readonly host: PluginBootstrapHost;
	/** The local-agent CLI this host drives when it generates memories. */
	readonly localAgentTool: LocalAgentToolId;
}

/**
 * Everything that varies per plugin host, in one table.
 *
 * Keyed by *install source tag*, NOT by the compile-time client kind. The two
 * signals agree on the SessionStart path (the bootstrap hook runs in-process from
 * the plugin's own bundle), but they diverge on the `/jolli:init` path: that
 * recipe shells out through `run-cli`, which dispatches to whichever registered
 * dist won the version race, and the plugin recipes deliberately drop
 * `JOLLI_DIST_PREFER_SOURCE` so an equal-versioned `cli` wins. So
 * `__JOLLI_CLIENT_KIND__` reads "cli" there even though a plugin initiated the
 * call, while the `--source-tag` the recipe passes explicitly survives both
 * paths. Read the host off the tag.
 */
const PLUGIN_HOSTS: Readonly<Record<string, PluginHostProfile>> = {
	"claude-plugin": { host: "claude", localAgentTool: "claude-code" },
	"codex-plugin": { host: "codex", localAgentTool: "codex" },
};

/**
 * The tool a plugin host drives, or undefined when `sourceTag` is not a plugin tag.
 *
 * Tags absent from {@link PLUGIN_HOSTS} (`cli`, `vscode`, `intellij`, anything
 * unknown) resolve to `undefined`: those surfaces derive their own provider default
 * from an interactive picker or a detection probe and must never be seeded here.
 */
export function pluginDefaultLocalAgentTool(sourceTag: string | undefined): LocalAgentToolId | undefined {
	return sourceTag === undefined ? undefined : PLUGIN_HOSTS[sourceTag]?.localAgentTool;
}

/**
 * Which host a repo-hooks-only (plugin bootstrap) install is acting for. Decides
 * whether that install may touch the host-specific assets — today, whether it
 * writes `.claude/**`.
 *
 * Unlike {@link pluginDefaultLocalAgentTool} this never returns undefined:
 * repo-hooks-only mode always acts for SOME host, and an unmapped tag falls back to
 * `"claude"` deliberately. That mode's only callers are the Claude plugin's
 * SessionStart bootstrap and its `/jolli:init` recipe (both pass `claude-plugin`),
 * so "unmapped" in practice means a hand-run `jolli enable --repo-hooks-only` with
 * no tag — which installed the Claude menu and agent hooks before this split and
 * must keep doing so. Returning `undefined` here and skipping host assets would
 * silently change that.
 */
export function pluginBootstrapHost(sourceTag: string | undefined): PluginBootstrapHost {
	return (sourceTag === undefined ? undefined : PLUGIN_HOSTS[sourceTag]?.host) ?? "claude";
}

/** Outcome of {@link applyPluginInitLocalAgentTool}, for the caller's report line. */
export interface PluginInitToolResult {
	readonly tool: LocalAgentToolId;
	/** `localAgentTool` was moved to `tool` (false when it already matched). */
	readonly changedTool: boolean;
	/**
	 * The value `localAgentTool` held before the move, or undefined when it held
	 * nothing. Present so the caller can tell "filled in a blank" from "replaced a
	 * choice the user made" — only the latter is worth telling the user about.
	 */
	readonly previousTool?: LocalAgentToolId;
	/** `aiProvider` was unset and is now `local-agent`. */
	readonly seededProvider: boolean;
}

/**
 * Provider write for an EXPLICIT plugin setup — `/jolli:init`, which runs
 * `enable` WITHOUT `--automatic`. This is the authoritative "this is my agent"
 * moment; contrast `ensurePluginDefaultProvider` in SessionStartHook, the
 * automatic first-wins seed that never overwrites anything.
 *
 * Two fields, two deliberately different policies:
 *
 *   - `localAgentTool` always moves to the initiating host's tool, even when it
 *     already holds another one. Running init inside an agent IS the user picking
 *     that agent, and this is the friendlier form of
 *     `jolli configure --set localAgentTool=…`. Only *automatic* paths must never
 *     overwrite — two hosts each re-seeding on every session start is exactly the
 *     tug-of-war this split exists to prevent.
 *   - `aiProvider` keeps first-wins and is seeded only when unset, because it
 *     decides whose account pays. A user already on `jolli` or `anthropic` must
 *     not be dragged onto `local-agent` just by initializing inside an agent.
 *     While the provider is not `local-agent` the tool write is inert — but it is
 *     the right value to have waiting if they switch later.
 *
 * Because the tool write is an overwrite, it reports {@link
 * PluginInitToolResult.previousTool} so the caller can say so out loud. A silent
 * overwrite would leave a user who deliberately configured another agent with no
 * user-visible trace of the change at all (the log line lands in `debug.log`).
 *
 * Both decisions are made INSIDE `config.lock` and reported from the state the
 * write actually landed on, not from the `config` snapshot the caller loaded. The
 * snapshot cannot be trusted for `aiProvider`, whose policy is first-wins: reading
 * "unset" before the lock and writing `local-agent` after it would drag a user onto
 * the plugin's provider when a concurrent writer — the other host's session-start
 * seed, or a `jolli configure --set` — had just chosen `jolli` or `anthropic`. It
 * also matters for the report: `previousTool` is what the caller tells the user it
 * replaced, so a stale snapshot would name the wrong tool.
 *
 * The `config` argument is kept as a fast path only: when it already shows both the
 * matching tool AND a set provider there is nothing this function could write, so it
 * returns without taking the lock.
 *
 * Returns null when `sourceTag` is not a plugin tag, having written nothing.
 * Throws on a config-write failure: unlike the session-start seed (which must
 * never block startup), init is user-invoked and reports its own outcome, so a
 * silent no-op there would be reported to the user as success.
 */
export async function applyPluginInitLocalAgentTool(
	sourceTag: string | undefined,
	config: Pick<JolliMemoryConfig, "aiProvider" | "localAgentTool">,
): Promise<PluginInitToolResult | null> {
	const tool = pluginDefaultLocalAgentTool(sourceTag);
	if (tool === undefined) return null;
	if (config.localAgentTool === tool && config.aiProvider !== undefined) {
		return { tool, changedTool: false, seededProvider: false };
	}
	return updateConfigTransactional<PluginInitToolResult>((current) => {
		const previousTool = current.localAgentTool;
		const changedTool = previousTool !== tool;
		const seededProvider = current.aiProvider === undefined;
		if (!changedTool && !seededProvider) {
			return { update: null, result: { tool, changedTool: false, seededProvider: false } };
		}
		return {
			update: seededProvider ? { aiProvider: "local-agent", localAgentTool: tool } : { localAgentTool: tool },
			result: { tool, changedTool, previousTool, seededProvider },
		};
	});
}
