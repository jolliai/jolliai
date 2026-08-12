import type { JolliMemoryConfig, LocalAgentToolId } from "../../Types.js";
import { updateConfigTransactional } from "../SessionTracker.js";

/** The AI host a plugin bootstrap is acting for. */
export type PluginBootstrapHost = "claude" | "codex" | "cursor";

interface PluginHostProfile {
	/** Which host's own assets (`.claude/**` etc.) this bootstrap owns. */
	readonly host: PluginBootstrapHost;
	/** The local-agent CLI this host drives when it generates memories. */
	readonly localAgentTool: LocalAgentToolId;
	/**
	 * How the MODEL must be told to invoke one of this host's bundled skills, as a
	 * format string with `<name>` standing in for the bare skill name.
	 *
	 * Three hosts, three different forms, none of them derivable from the others:
	 * Claude and Codex namespace a plugin's skills as `jolli:<name>` and differ only
	 * in their invocation sigil, while Cursor namespaces nothing and the bundle
	 * carries the `jolli-` prefix in the directory name instead (see
	 * {@link file://../../install/CursorPluginSkills.ts}).
	 *
	 * Declared here rather than at each call site because the alternative is a
	 * hardcoded `clientKind === … ? … : clientKind === … ? … : null` ladder, and that
	 * pattern has already gone stale twice: `loginReminderText` and
	 * `formatRecallSuggestion` both kept two-arm ladders when a third host was added,
	 * so a Cursor user silently got NO login reminder and a recall hint naming the
	 * bare CLI. A table row cannot be half-added.
	 */
	readonly skillInvocation: `${string}<name>${string}`;
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
	"claude-plugin": { host: "claude", localAgentTool: "claude-code", skillInvocation: "/jolli:<name>" },
	"codex-plugin": { host: "codex", localAgentTool: "codex", skillInvocation: "$jolli:<name>" },
	// The Cursor plugin runs inside the Cursor IDE, but the CLI it can DRIVE to
	// generate a summary is `cursor-agent` — the IDE itself is not a headless
	// backend. Same relationship as the other two hosts: seed the tool that shares
	// this host's login, not the surface the user is typing into.
	//
	// `/jolli-<name>` and not `/jolli:<name>`: Cursor applies no namespace to a
	// plugin's skills, so this bundle carries the prefix in the directory name.
	"cursor-plugin": { host: "cursor", localAgentTool: "cursor-agent", skillInvocation: "/jolli-<name>" },
};

/**
 * Every tag {@link PLUGIN_HOSTS} answers for.
 *
 * Exists so one invariant can be pinned by a test instead of holding only in a
 * comment: for a plugin BUNDLE, the compile-time client kind and the install source
 * tag are the same string. That is what lets `SessionStartHook` look a client kind up
 * in this table (`pluginSkillInvocation(clientKind, …)`) even though the header above
 * describes it as source-tag-keyed. The invariant is one-directional and only holds
 * for bundles — the `/jolli:init` path still reports a `cli` kind under a plugin tag,
 * which is exactly why the table is keyed by tag — so a fourth host that ships a kind
 * without a matching tag would silently lose its reminder and its recall hint, the
 * failure this table replaced. `ClientHeader.test.ts` asserts the two lists agree.
 */
export const PLUGIN_HOST_SOURCE_TAGS: ReadonlyArray<string> = Object.keys(PLUGIN_HOSTS);

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
 * How to tell the model to invoke `skillName` on this plugin host, or undefined when
 * `sourceTag` is not a plugin tag.
 *
 * Undefined is the meaningful answer for `cli` / `vscode` / `intellij`: those surfaces
 * ship no bundled skills, so a caller must fall back to naming the CLI command rather
 * than inventing a slash form that would not resolve.
 */
export function pluginSkillInvocation(sourceTag: string | undefined, skillName: string): string | undefined {
	const template = sourceTag === undefined ? undefined : PLUGIN_HOSTS[sourceTag]?.skillInvocation;
	return template?.replace("<name>", skillName);
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
	/** The tool this host would drive — written only when nothing was configured. */
	readonly tool: LocalAgentToolId;
	/** `localAgentTool` held nothing and is now `tool`. */
	readonly seededTool: boolean;
	/**
	 * The tool `localAgentTool` already held and that this init LEFT ALONE, present
	 * only when it differs from {@link tool}. Undefined covers both "was unset" and
	 * "already matched" — neither is worth a word to anyone. The one case that is
	 * worth recording is a host initializing over another tool's configured value,
	 * because from then on this host's memories are generated by a CLI that is not
	 * its own, and nothing else in the install output explains why.
	 */
	readonly keptTool?: LocalAgentToolId;
	/** `aiProvider` was unset and is now `local-agent`. */
	readonly seededProvider: boolean;
}

/** The configured tool this init is declining to replace, if any. */
function keptToolOf(existing: LocalAgentToolId | undefined, tool: LocalAgentToolId): LocalAgentToolId | undefined {
	return existing === undefined || existing === tool ? undefined : existing;
}

/**
 * Provider write for an EXPLICIT plugin setup — `/jolli:init`, which runs
 * `enable` WITHOUT `--automatic`. Contrast `ensurePluginDefaultProvider` in
 * SessionStartHook, the automatic seed that runs on every session start.
 *
 * Both fields are FIRST-WINS: each is seeded only when it holds nothing, and a
 * value already on disk is never replaced.
 *
 *   - `localAgentTool` was an unconditional overwrite until it was measured in
 *     practice: a Cursor user whose configured tool was `codex` ran `/jolli` on a
 *     new repo and had it silently moved to `cursor-agent`, because running init
 *     inside a host was read as the user picking that host's CLI. It is not. The
 *     host a repository is set up from says nothing about which agent should
 *     generate its memories — the value on disk is a choice someone made once
 *     (often the only CLI they are signed into), and re-deciding it per repository
 *     makes the last host to see a repo the winner. Changing it stays an explicit
 *     `jolli configure --set localAgentTool=…`, which is what a user who wants
 *     this host's CLI runs. Reported through {@link PluginInitToolResult.keptTool}
 *     rather than acted on.
 *   - `aiProvider` was already first-wins, because it decides whose account pays.
 *     A user on `jolli` or `anthropic` must not be dragged onto `local-agent` just
 *     by initializing inside an agent.
 *
 * A consequence worth stating, because the overwrite used to hide it: seeding
 * `aiProvider` no longer drags the tool along with it. A config whose provider is
 * unset but whose tool is set now gets `aiProvider: local-agent` pointed at THAT
 * tool rather than at this host's — the right way round, since the tool is the
 * field the user expressed an opinion about.
 *
 * Both decisions are made INSIDE `config.lock` and reported from the state the
 * write actually landed on, not from the `config` snapshot the caller loaded. The
 * snapshot cannot be trusted for either gate: reading "unset" before the lock and
 * writing after it would overwrite whatever a concurrent writer — the other host's
 * session-start seed, or a `jolli configure --set` — had just chosen.
 *
 * The `config` argument is kept as a fast path only: when both fields already hold
 * a value there is nothing first-wins could write, so it returns without taking the
 * lock. Answering `keptTool` from that snapshot is safe precisely because no write
 * follows it — it feeds a log line, never a decision.
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
	if (config.localAgentTool !== undefined && config.aiProvider !== undefined) {
		return { tool, seededTool: false, keptTool: keptToolOf(config.localAgentTool, tool), seededProvider: false };
	}
	return updateConfigTransactional<PluginInitToolResult>((current) => {
		const seededTool = current.localAgentTool === undefined;
		const seededProvider = current.aiProvider === undefined;
		const result: PluginInitToolResult = {
			tool,
			seededTool,
			keptTool: keptToolOf(current.localAgentTool, tool),
			seededProvider,
		};
		if (!seededTool && !seededProvider) return { update: null, result };
		return {
			update: {
				...(seededProvider ? { aiProvider: "local-agent" as const } : {}),
				...(seededTool ? { localAgentTool: tool } : {}),
			},
			result,
		};
	});
}
