/**
 * McpServer — exposes JolliMemory's search + context tools to AI agents over an
 * MCP transport. Pure glue: tool schemas + a dispatch table over
 * the McpTools handlers.
 *
 * Split into two phases because a worktree now serves N sessions
 * from ONE process:
 *
 *   - {@link prepareMcpRuntime} — the expensive, per-PROCESS half: the two cwd
 *     refusal guards, the Logger anchor, `setActiveStorage`, and the platform-tool
 *     manifest fetch. Measured at ~100 MB physical footprint against a real repo,
 *     versus an 11 MB bare-Node floor, which is the entire reason the daemon
 *     exists: it is what N sessions must stop paying N times.
 *   - {@link createMcpServer} — the cheap, per-CONNECTION half. Each MCP client
 *     runs its own `initialize` handshake and therefore needs its own `Server`
 *     object, but every one of them reads through the same prepared runtime.
 *
 * `startMcpServer` composes the two over stdio and is what a session gets when
 * the daemon is unavailable; `McpDaemon` composes them over a unix socket /
 * named pipe.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListToolsRequestSchema,
	type Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../commands/CliUtils.js";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { probeWorktree } from "../core/GitOps.js";
import { JolliMemoryPushClient, type PlatformToolManifestEntry } from "../core/JolliMemoryPushClient.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { track } from "../core/Telemetry.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";
import {
	buildJolliMenu,
	buildJolliPromptText,
	JOLLI_PROMPT_ARGUMENT,
	JOLLI_PROMPT_NAME,
	type JolliMenuItem,
} from "./JolliMenu.js";
import { isPluginBundleCwd } from "./McpCwdGuard.js";
import {
	runBindSpace,
	runDecisionTimeline,
	runGetPrDescription,
	runListBranches,
	runListSpaces,
	runPushMemory,
	runQueueStatus,
	runRecall,
	runSearch,
	runStatus,
} from "./McpTools.js";
import { isPlatformToolsEnabled } from "./PlatformTools.js";

const log = createLogger("McpServer");

/**
 * Exactly what a client may see in `tools/list`.
 *
 * Split from {@link ToolDefinition} so the internal fields below cannot reach the
 * wire by being added to one type. The platform-tool path already projected its
 * manifest entries down to these three keys for that reason (`binding` and `menu`
 * are backend routing / curation metadata); making the shape explicit means the
 * built-ins are held to the same rule instead of relying on their type happening to
 * carry nothing extra.
 */
export interface PublicToolDefinition {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolDefinition extends PublicToolDefinition {
	/**
	 * Whether this tool derives the repository it answers for from the server's cwd.
	 *
	 * REQUIRED, not optional, and that is the whole safety property. Outside a git
	 * worktree a repo-scoped tool does not fail — `StorageFactory` falls back to
	 * orphan-only storage and every read answers EMPTY BUT SUCCESSFUL, which reads to
	 * a model as "this branch has no memories" rather than "this server does not know
	 * which repository it serves". A tool that forgot to declare itself would inherit
	 * exactly that failure, silently. With no default, adding one is a compile error.
	 *
	 * `false` means "cwd contributes nothing": `list_spaces` asks the backend about the
	 * tenant, and every platform tool is a pure HTTP passthrough
	 * (`invokePlatformTool` — endpoint from the manifest, auth from the API key, args
	 * from the model). Those stay available outside a repository, which is the point of
	 * declaring this per tool rather than refusing to start the whole server.
	 */
	requiresRepo: boolean;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "bind_space",
		requiresRepo: true,
		description:
			'Bind this repo to a Jolli Space so `push_memory` can push to it. Idempotent — binding an already-bound repo returns `{type:"already_bound"}` rather than erroring.',
		inputSchema: {
			type: "object",
			properties: {
				space: {
					type: "string",
					description: "Jolli Space id (numeric), slug, or exact name to bind this repo to.",
				},
			},
			required: ["space"],
		},
	},
	{
		name: "list_spaces",
		requiresRepo: false,
		description:
			"List the Jolli Spaces this tenant can bind a repo to, plus the tenant's configured default space.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "push_memory",
		requiresRepo: true,
		description:
			'Push this branch\'s JolliMemory commit summaries to the bound Jolli Space as articles. If the repo isn\'t bound yet, returns {"type":"binding_required"} with the available spaces — call again with `space` set (or use `bind_space` first) to bind and push. If the user has turned outbound push off for this repo, returns {"type":"push_disabled"} — memory is still recorded locally; this is a deliberate setting, so do not retry, and tell the user to re-enable it instead.',
		inputSchema: {
			type: "object",
			properties: {
				baseBranch: {
					type: "string",
					description:
						"Base branch for the commit range (base..HEAD). Defaults to the repository's default branch.",
				},
				space: {
					type: "string",
					description:
						"Jolli Space id, slug, or name to bind this repo to before pushing, if not already bound.",
				},
			},
		},
	},
	{
		name: "search",
		requiresRepo: true,
		description:
			"Full-text search over this repo's historical decisions and implementations (topics + commits). Use to check how a topic was handled before.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Natural-language or keyword query." },
				branch: { type: "string", description: "Optional: restrict to one branch." },
				type: { type: "string", enum: ["topic", "commit"], description: "Optional: restrict result kind." },
				limit: { type: "number", description: "Max hits (default 20)." },
			},
			required: ["query"],
		},
	},
	{
		name: "recall",
		requiresRepo: true,
		description:
			"Recall the development context for a branch from raw commit summaries (decisions, plans, notes, commits) — the same data the recall skill surfaces, NOT the topic KB. Omit `branch` to recall the current branch.",
		inputSchema: {
			type: "object",
			properties: { branch: { type: "string", description: "Branch to recall; defaults to current." } },
		},
	},
	{
		name: "get_decision_timeline",
		requiresRepo: true,
		description: "Chronological evolution of a topic — its source events ordered oldest-first.",
		inputSchema: {
			type: "object",
			properties: { slug: { type: "string", description: "Topic stableSlug." } },
			required: ["slug"],
		},
	},
	{
		name: "list_branches",
		requiresRepo: true,
		description: "List all branches that have JolliMemory records, with their topic titles.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_pr_description",
		requiresRepo: true,
		description:
			"Build a GitHub PR title + description from the CURRENT branch's JolliMemory commit summaries — the same memory-rich body the VS Code extension writes. Use before `gh pr create` so the PR embeds the curated memory instead of a diff-derived summary. Always describes the current branch (the commit range is base..HEAD).",
		inputSchema: {
			type: "object",
			properties: {
				baseBranch: {
					type: "string",
					description:
						"Base branch for the commit range. Defaults to the repository's default branch (origin/HEAD), falling back to main.",
				},
				includeMarkers: {
					type: "boolean",
					description: "Wrap body in update markers for idempotent PR edits (default true).",
				},
			},
		},
	},
	{
		name: "queue_status",
		requiresRepo: true,
		description:
			'Report whether this repo\'s memory-summary generation is still in progress. Call before building a PR (get_pr_description) so freshly-committed summaries are included. Wiki/graph rendering is excluded from the verdict. Pass {"wait": true} to block until drained (default 120s, override with timeoutMs).',
		inputSchema: {
			type: "object",
			properties: {
				wait: { type: "boolean", description: "Block until the queue drains or the timeout elapses." },
				timeoutMs: { type: "number", description: "Max ms to wait when wait is true (default 120000)." },
			},
		},
	},
	{
		name: "status",
		requiresRepo: true,
		description:
			"Report Jolli Memory's installation & configuration health for this repo: which hooks are installed, the active hook runtime, data-migration state, account / API-key configuration, detected AI integrations with their session counts, the stored-memory count, and the orphan branch. This is the environment health check — pair it with queue_status (generation progress), not list_branches (recorded memory).",
		inputSchema: { type: "object", properties: {} },
	},
];

/** Route a validated tool call to its handler. Throws on unknown tool. */
export async function dispatchTool(cwd: string, name: string, args: Record<string, unknown>): Promise<unknown> {
	switch (name) {
		case "search":
			return runSearch(
				cwd,
				args as { query: string; branch?: string; type?: "topic" | "commit"; limit?: number },
			);
		case "recall":
			return runRecall(cwd, args as { branch?: string });
		case "get_decision_timeline":
			return runDecisionTimeline(cwd, args as { slug: string });
		case "list_branches":
			return runListBranches(cwd);
		case "get_pr_description":
			return runGetPrDescription(cwd, args as { baseBranch?: string; includeMarkers?: boolean });
		case "queue_status":
			return runQueueStatus(cwd, args as { wait?: boolean; timeoutMs?: number });
		case "status":
			return runStatus(cwd);
		case "push_memory":
			return runPushMemory(cwd, args as { baseBranch?: string; space?: string });
		case "list_spaces":
			return runListSpaces(cwd);
		case "bind_space":
			return runBindSpace(cwd, args as { space: string });
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

/**
 * The slice of the backend client the platform-tool path uses. Declared as an
 * interface so tests can inject a fake without constructing a live HTTP client.
 */
export interface PlatformToolClient {
	/** `undefined` when the fetch failed; `[]` when the tenant has no platform tools. */
	fetchManifest(): Promise<PlatformToolManifestEntry[] | undefined>;
	invokePlatformTool(tool: PlatformToolManifestEntry, args: Record<string, unknown>): Promise<unknown>;
}

/** Injectable dependencies for {@link startMcpServer}; the defaults wire the real implementations. */
export interface StartMcpServerDeps {
	/** Loads the config that gates platform-tool registration. Defaults to the machine-global config loader. */
	readonly loadConfig?: () => Promise<Pick<JolliMemoryConfig, "mcpPlatformToolsEnabled">>;
	/** Builds the backend client that fetches the manifest and relays tool calls. Defaults to a real client. */
	readonly createPlatformClient?: () => PlatformToolClient;
}

/**
 * Re-exported from the leaf module [`McpCwdGuard.ts`](McpCwdGuard.ts), where it
 * lives so the proxy can consult it without importing this module's storage and
 * search stack. That module is itself a one-line alias for
 * [`core/PluginBundlePaths`](../core/PluginBundlePaths.ts), which is where the
 * markers actually live — the Cursor plugin bootstrap needs the same predicate and
 * must not reach into `mcp/` for it.
 */
export { isPluginBundleCwd } from "./McpCwdGuard.js";

/**
 * The per-process half of an MCP server: everything that is identical for every
 * client of one worktree, so a daemon pays for it once instead of N times.
 *
 * Holds no per-connection state — see {@link createMcpServer} for that half.
 */
export interface McpRuntime {
	/** The git-worktree root every tool derives its repository from. */
	readonly cwd: string;
	/**
	 * Whether {@link cwd} is inside a git working tree, and therefore whether the
	 * `requiresRepo` built-ins may be served at all.
	 *
	 * Carried ON THE RUNTIME rather than computed once in {@link prepareMcpRuntime},
	 * because {@link rebuildPlatformHalf} re-enters {@link buildRuntime} with the same
	 * cwd: without it, a daemon refreshing its platform half would quietly re-advertise
	 * the nine repo-scoped tools it had withheld, and the next client would get the
	 * empty-but-successful answers the withholding exists to prevent.
	 */
	readonly insideRepo: boolean;
	/**
	 * The advertised tool list, in `tools/list` order: the built-ins this cwd can
	 * answer for, plus any backend platform tools.
	 *
	 * `PublicToolDefinition`, not `ToolDefinition` — every entry is projected down to
	 * name/description/inputSchema so no internal field (a built-in's `requiresRepo`, a
	 * manifest entry's `binding` / `menu`) can reach a client. That projection is also
	 * why this is always a fresh array rather than the static `TOOL_DEFINITIONS` handed
	 * over by reference. Nothing mutates it.
	 */
	readonly toolDefinitions: PublicToolDefinition[];
	/** Present only when the platform-tool gate is open. */
	readonly platformClient?: PlatformToolClient;
	/** Full manifest entries (with the internal `binding` / `menu` metadata) by name. */
	readonly platformByName: Map<string, PlatformToolManifestEntry>;
	/** Curated `/jolli` menu; empty when the platform-tool gate is closed. */
	readonly menu: JolliMenuItem[];
	/**
	 * True when the gate was OPEN and the manifest fetch FAILED — i.e. this
	 * runtime is missing tools it should have.
	 *
	 * Only a long-lived host acts on it. In a one-shot server the distinction is
	 * academic: the session simply has no platform tools, exactly as before. In
	 * the daemon it is the difference between one flaky request and every session
	 * on the worktree silently losing 22 tools for the daemon's whole lifetime, so
	 * `McpDaemon` retries the platform half (never the storage half) on the next
	 * connection.
	 *
	 * Two things are deliberately NOT degraded. A closed gate — that is a
	 * configured choice. And an EMPTY manifest from a healthy fetch: a tenant with
	 * no platform tools is a normal, permanent state, and reading it as degraded
	 * (which the first version did, having only the list length to go on) turned
	 * the bounded retry into a manifest fetch on every single connection, awaited
	 * in front of that client's server construction, for the daemon's lifetime.
	 */
	readonly platformDegraded: boolean;
}

/**
 * Runs the once-per-process setup and returns the shared runtime, or
 * `undefined` when one of the two cwd guards refuses to serve this directory.
 *
 * A refusal is NOT an error: the caller's contract is to exit quietly (stdio) or
 * to never bind a socket (daemon). Returning a sentinel rather than throwing
 * keeps both callers from having to distinguish "declined" from "broken".
 */
export async function prepareMcpRuntime(cwd: string, deps: StartMcpServerDeps = {}): Promise<McpRuntime | undefined> {
	// Re-entrancy guard: the local-agent backend spawns an agent CLI in
	// a throwaway temp cwd marked JOLLI_LOCAL_AGENT_CHILD=1. That nested CLI boots
	// the globally-registered `jolli mcp` here. Without this no-op, the storage init
	// below roots a FolderStorage at <localFolder>/<tempDirName>/, claiming a
	// spurious Memory Bank "repo" per summary call (the temp dir basename becomes
	// the repoName).
	//
	// `cwd` is passed explicitly — unlike the hook guards, this process is spawned
	// by the HOST rather than by our own child, so the env marker is subject to the
	// host's env policy: Codex passes MCP servers a 7-variable allowlist (HOME,
	// LOGNAME, PATH, SHELL, TMPDIR, USER, __CF_USER_TEXT_ENCODING — measured on
	// codex-cli 0.146.0) that drops it, which is how 136 stray folders accumulated
	// with the env-only guard already in place. The cwd sentinel is what actually
	// survives that hop. See AgentReentry for the full two-channel rationale.
	if (isLocalAgentChild(process.env, cwd)) {
		log.info("Local-agent child detected; skipping MCP server startup to avoid a spurious Memory Bank repo");
		return;
	}

	// Second cwd sentinel, same failure mode from the other direction: an AI host
	// that launches this server from a PLUGIN BUNDLE rather than the user's repo.
	// Every repo-scoped tool here derives its repository from `cwd`, so such a server
	// would answer `recall` / `search` / `status` for the plugin's cache directory —
	// silently, with empty-but-successful results, plus a placeholder Memory Bank repo
	// named after the bundle's version directory. Refusing is strictly better: the
	// host reports a server that would not start, and the skills' documented CLI
	// fallback (`run-cli`, which inherits the session cwd) is correct.
	//
	// Reachable today only by a plugin manifest that pins `cwd` to its own root, which
	// no shipped Jolli plugin does — Codex's MCP comes from the global
	// `~/.codex/config.toml` entry precisely so it is launched with the session cwd
	// (see codexRegistrar). This exists so that reintroducing such a manifest fails
	// loudly instead of shipping a server that quietly serves the wrong repository.
	if (isPluginBundleCwd(cwd)) {
		process.stderr.write(
			"jolli mcp: refusing to start — launched from an AI-host plugin bundle " +
				`(${cwd}) rather than a repository, so every memory tool would answer for the wrong project. ` +
				"Register the server through `jolli enable` (which lets the host launch it with the session " +
				"directory) instead of from a plugin manifest that pins its cwd.\n",
		);
		log.warn("Refusing MCP startup: cwd %s is inside an AI-host plugin bundle, not a repository", cwd);
		return;
	}

	// Third cwd sentinel — same failure it guards against, but NOT the same remedy.
	//
	// Outside a git worktree a repo-scoped tool does not fail: `StorageFactory` logs
	// "Not a claimable project (no git worktree …) — using orphan-only storage" and
	// every read answers EMPTY BUT SUCCESSFUL, which the cutover rule in AGENTS.md
	// names as worse than no data at all. A model cannot tell that apart from "this
	// branch genuinely has no memories".
	//
	// Measured, not hypothetical. Cursor imports Claude plugins wholesale — including
	// their `.mcp.json` — under its `enable_cc_plugin_import` gate, and it spawns MCP
	// servers from a SHARED process before any workspace folder is known
	// ("WARN No workspace folders found, using current path for . expansion" in
	// mcpprocess.log). The child therefore inherits the host's own cwd: on a real
	// install that was the user's HOME directory, so `~/.claude/plugins/.../Cli.js mcp`
	// came up rooted at `/Users/<me>` and served an empty repository while reporting
	// "Successfully connected". The bundle guard above cannot see it, because the cwd
	// is not a bundle path. Nothing recovers the workspace from inside that launch —
	// Cursor passes MCP servers no workspace env (`CURSOR_WORKSPACE_LABEL` goes to the
	// extension host only) and the spawn predates workspace resolution.
	//
	// WHY THIS ONE FILTERS INSTEAD OF REFUSING, unlike the two guards above. Those two
	// describe a server that is wrong about EVERYTHING it could answer — a bundle cache
	// or a throwaway agent temp dir is not a repository and has no backend identity
	// either. "Not a git repo" is narrower: the nine repo-scoped built-ins are unusable,
	// but `list_spaces` and every platform tool are not, because a platform tool is a
	// pure HTTP passthrough (`invokePlatformTool` — endpoint from the manifest, auth
	// from the API key, args from the model) with no input from cwd at all. Refusing
	// wholesale took ~23 of 32 tools offline to protect the other 9, on nine hosts whose
	// MCP registration is machine-global and therefore reached from ANY directory the
	// user opens a session in. Dropping the repo-scoped tools from `tools/list` protects
	// those 9 more thoroughly than a refusal does — the model never sees a tool it could
	// misread an empty answer from — while leaving the rest working.
	//
	// The residual ambiguity is accepted rather than guessed at: if a user's HOME *is* a
	// git repository (a dotfiles checkout), it passes and is served. That is right when
	// they really opened it and indistinguishable from a stray launch when they did not,
	// so HOME is not special-cased — that would refuse a legitimate project on a hunch.
	// `probeWorktree`, not `isInsideGitRepo`: the latter answers "any git context",
	// which calls a bare repo and the `.git` directory itself a working tree. Both
	// then fail `StorageFactory`'s stricter claimable-project check and land right
	// back in the empty-but-successful hole this guard exists to close. The probe
	// tests `--is-inside-work-tree`'s STDOUT instead.
	const probe = await probeWorktree(cwd);
	const insideRepo = probe === "inside";
	if (!insideRepo) {
		// Two different problems, and conflating them sends the user to check the wrong
		// thing. A missing `git` is not a statement about cwd at all — `execGit` reports
		// it as exit 127, and a daemon spawned by a GUI-launched IDE genuinely does get a
		// PATH without git on it.
		const reason =
			probe === "git-unavailable"
				? "`git` could not be executed from this process (a GUI-launched host often passes a " +
					"stripped PATH), so this server cannot tell which repository it serves"
				: `${cwd} is not inside a git worktree`;
		process.stderr.write(
			`jolli mcp: ${reason}, so this server is starting WITHOUT its repository tools ` +
				"(recall, search, status, …) — they would answer for no project at all, and empty results " +
				"look like real ones. Space and workflow tools still work. When the cause is the launch " +
				"directory, it usually means the AI host started the server before it knew which workspace " +
				"was open; register it with `jolli enable` in the repository you want served.\n",
		);
		log.warn("worktree probe returned %s for cwd %s — repo-scoped tools withheld", probe, cwd);
	}

	// BOTH of these are gated on `insideRepo`, and each for its own reason — the
	// filtering above changed which tools are served, not what a non-repo cwd is
	// allowed to be treated as.
	//
	//   setLogDir  — NOT a litter guard, and it is worth being precise about that:
	//     Logger never creates its directory. `enqueueLogWrite` stats
	//     `<dir>/.jolli/jollimemory/` and silently drops the line when it is absent, so
	//     anchoring a non-repo cwd could not have produced a stray `.jolli/` in the
	//     user's HOME to begin with. The gate is about what this server may CLAIM as
	//     its state root: outside a worktree there is no repository to anchor to, so it
	//     anchors to nothing. Skipping is a no-op in the measured case — `getJolliMemoryDir`
	//     falls back to `process.cwd()`, which is what `resolveProjectDir` already
	//     returned for a non-git cwd — and that coincidence is exactly why the
	//     invariant is stated here rather than left to the fallback happening to agree.
	//   createStorage — nothing that reads through it is reachable now: every
	//     storage-backed tool declares `requiresRepo`. Skipping it also avoids the
	//     per-read "Not a claimable project" WARN in a process that never exits.
	if (insideRepo) {
		// Anchor the Logger's global dir to this (already git-root-resolved) cwd so the
		// debug.log lands in the repo's `.jolli/`, not a stray store under the
		// subdirectory it was launched from. `cwd` is resolved by the `jolli mcp`
		// command via resolveProjectDir.
		setLogDir(cwd);

		// Establish the configured storage backend up front. The tool handlers read
		// through the store APIs without threading `storage`, so without this they'd
		// fall through resolveStorage to the orphan branch — wrong for folder-mode
		// users and a per-read WARN in this long-lived process.
		setActiveStorage(await createStorage(cwd, cwd));
	}

	return buildRuntime(cwd, await loadPlatformTools(deps, insideRepo), insideRepo);
}

/** The platform-tool half of a runtime — the only part that touches the network. */
export interface PlatformToolSet {
	readonly platformClient?: PlatformToolClient;
	readonly platformTools: PlatformToolManifestEntry[];
	readonly menu: JolliMenuItem[];
	/** Whether the config/env gate allowed a manifest fetch at all. */
	readonly gateOpen: boolean;
	/**
	 * Whether the fetch was attempted and failed — as opposed to answering that
	 * this tenant has no platform tools. Always false when the gate is closed,
	 * since nothing was attempted.
	 */
	readonly fetchFailed: boolean;
}

/**
 * Fetches and sanitises the backend-defined platform tools.
 *
 * Split out of {@link prepareMcpRuntime} so it can be retried on its own. The
 * fetch is best-effort and answers an empty list on failure, which used to cost
 * exactly one session its platform tools. Under a shared daemon that same blip
 * would otherwise be cached for every session on the worktree until the daemon
 * reaps — hours, silently, with `tools/list` simply 22 entries short. See
 * {@link McpRuntime.platformDegraded}.
 */
export async function loadPlatformTools(deps: StartMcpServerDeps = {}, insideRepo = true): Promise<PlatformToolSet> {
	// Opt-in gate. When it is closed we never construct a client or touch the
	// network, so the server behaves exactly as a git-memory-only server.
	const config = await (deps.loadConfig ?? loadConfig)();
	const gateOpen = isPlatformToolsEnabled(config);
	// The built-ins this cwd can actually answer for — the menu must be built from the
	// same list `tools/list` will advertise, or it would offer a route to a tool that
	// was withheld. Defaults to the full set so the `rebuildPlatformHalf` path and any
	// caller that does not care about the repo dimension keep today's behaviour.
	const availableBuiltIns = insideRepo ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((t) => !t.requiresRepo);
	let platformClient: PlatformToolClient | undefined;
	let platformTools: PlatformToolManifestEntry[] = [];
	let fetchFailed = false;
	// The curated `/jolli` menu is computed only inside the platform-tools gate, so
	// with the gate closed it stays empty and no prompt is ever registered.
	let menu: JolliMenuItem[] = [];
	if (gateOpen) {
		platformClient = (deps.createPlatformClient ?? (() => new JolliMemoryPushClient()))();
		const builtInNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
		const seenNames = new Set<string>();
		// `undefined` is the failure signal, and it is NOT the same as `[]`. Reading
		// an empty list as failure is what made the daemon's bounded retry unbounded
		// for every tenant that legitimately has no platform tools.
		const manifest = await platformClient.fetchManifest();
		fetchFailed = manifest === undefined;
		platformTools = (manifest ?? []).filter((tool) => {
			if (builtInNames.has(tool.name)) {
				// A built-in tool always wins a name collision: drop the backend tool
				// so the built-in handler stays reachable and its wire contract is
				// never shadowed by a same-named backend tool.
				log.warn("Ignoring platform tool whose name collides with a built-in tool: %s", tool.name);
				return false;
			}
			if (seenNames.has(tool.name)) {
				// Keep only the first entry per name so the advertised list and the
				// dispatch map agree — otherwise `tools/list` would show a duplicate a
				// client could select while `tools/call` always ran a different one.
				log.warn("Ignoring duplicate platform tool name from the manifest: %s", tool.name);
				return false;
			}
			seenNames.add(tool.name);
			return true;
		});
		// Menu = menu-flagged platform tools ∪ the local-tools inclusion list
		// (empty for now). Every item is one of the tools advertised below — so it is
		// fed the same repo-filtered list, or the menu could offer a route to a tool
		// `tools/list` withheld.
		menu = buildJolliMenu(platformTools, availableBuiltIns);
	}
	return { ...(platformClient ? { platformClient } : {}), platformTools, menu, gateOpen, fetchFailed };
}

/**
 * Rebuilds a runtime with a freshly-fetched platform half, reusing everything
 * else. The storage half is a process-global side effect that is already in
 * place, so this touches only the network-backed part — see
 * {@link McpRuntime.platformDegraded} for when a caller should bother.
 */
export async function rebuildPlatformHalf(runtime: McpRuntime, deps: StartMcpServerDeps = {}): Promise<McpRuntime> {
	// `runtime.insideRepo` threaded through both calls: a refresh must not
	// re-advertise the repo-scoped tools this runtime was built to withhold.
	return buildRuntime(runtime.cwd, await loadPlatformTools(deps, runtime.insideRepo), runtime.insideRepo);
}

/** Assembles the advertised tool list and dispatch map from the two halves. */
function buildRuntime(cwd: string, platform: PlatformToolSet, insideRepo: boolean): McpRuntime {
	const { platformClient, platformTools, menu, gateOpen, fetchFailed } = platform;
	// The built-ins this cwd can answer for. Outside a worktree the `requiresRepo`
	// ones are withheld rather than left to fail at call time: a tool the model cannot
	// see is a tool it cannot read an empty-but-successful answer from. The call-time
	// check in `createMcpServer` is the backstop for a client working from a cached
	// list, not the primary defence.
	const availableBuiltIns = insideRepo ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((t) => !t.requiresRepo);
	// Every advertised entry is projected down to the public schema
	// (name / description / inputSchema). Both sides carry fields that must never reach
	// a client's `tools/list`: a manifest entry has `binding` (backend routing) and
	// `menu` (curation), a built-in has `requiresRepo`. Dispatch still uses the full
	// entries via `platformByName`, so routing is unaffected.
	const advertise = ({ name, description, inputSchema }: PublicToolDefinition): PublicToolDefinition => ({
		name,
		description,
		inputSchema,
	});
	// Logged because the daemon is detached with stdio ignored: this line is the
	// only way to tell the states apart — gate closed, fetch failed, the tenant
	// simply has no platform tools, or the repo-scoped built-ins were withheld —
	// and they are all identical to a client counting entries in `tools/list`.
	log.info(
		"MCP runtime ready: %d/%d built-in (insideRepo=%s) + %d platform tool(s), gate=%s, manifest=%s",
		availableBuiltIns.length,
		TOOL_DEFINITIONS.length,
		insideRepo,
		platformTools.length,
		gateOpen ? "open" : "closed",
		gateOpen ? (fetchFailed ? "fetch-failed" : "ok") : "not-fetched",
	);
	return {
		cwd,
		insideRepo,
		toolDefinitions: [...availableBuiltIns.map(advertise), ...platformTools.map(advertise)],
		...(platformClient ? { platformClient } : {}),
		platformByName: new Map(platformTools.map((t) => [t.name, t] as const)),
		menu,
		platformDegraded: gateOpen && fetchFailed,
	};
}

/**
 * Builds one MCP `Server` for ONE client connection over the shared runtime.
 *
 * Per-connection rather than per-process because the MCP lifecycle is
 * per-connection: each client sends its own `initialize`, and the SDK's `Server`
 * binds to exactly one transport. Everything expensive already happened in
 * {@link prepareMcpRuntime}, so this is cheap enough to run per session.
 */
export function createMcpServer(runtime: McpRuntime): Server {
	const { cwd, insideRepo, toolDefinitions, platformClient, platformByName, menu } = runtime;

	// Allowlist of tool names we may put in telemetry. `req.params.name` is
	// client-controlled free text (the AI picks it), so an unknown-tool call
	// would otherwise leak that arbitrary string into `command_invoked{tool}`
	// via the catch path below — the same "external content in telemetry" leak
	// the telemetry contract forbids for `arguments`. Fold any unrecognized name to
	// "unknown" so only our own fixed identifiers are ever reported.
	//
	// Deliberately the FULL built-in list, not the repo-filtered one: a withheld tool
	// is still one of our own fixed identifiers, and folding it to "unknown" would hide
	// exactly the calls worth knowing about (a client working from a cached list).
	const knownToolNames = new Set<string>([...TOOL_DEFINITIONS.map((t) => t.name), ...platformByName.keys()]);
	const telemetryToolName = (name: string): string => (knownToolNames.has(name) ? name : "unknown");

	// Advertise the `prompts` capability only when the menu is non-empty. With an
	// empty menu (gate off, empty manifest, or no menu-flagged tools) the server is
	// byte-identical to a tools-only server: no capability, no handlers, no prompt.
	const promptsEnabled = menu.length > 0;
	const server = new Server(
		{ name: "jollimemory", version: VERSION },
		{ capabilities: promptsEnabled ? { tools: {}, prompts: {} } : { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		const start = Date.now();
		try {
			// Backstop for a client working from a cached `tools/list` (or one that
			// ignores it). Throwing names the reason; the alternative is `dispatchTool`
			// running against a non-repo cwd and returning the plausible-looking empty
			// result this whole path exists to prevent. Checked against the FULL
			// registry, so an unknown name still falls through to the dispatch table's
			// own "Unknown tool" error rather than being reported as a repo problem.
			if (!insideRepo && TOOL_DEFINITIONS.some((t) => t.name === name && t.requiresRepo)) {
				throw new Error(
					`${name} needs a git repository, and this server was started in ${cwd}, which is not ` +
						"inside one. Start the AI host from the repository you want served, or run " +
						"`jolli enable` there.",
				);
			}
			// Route backend-defined tools through the generic executor; everything
			// else is a built-in handled by the local dispatch table.
			const platformTool = platformByName.get(name);
			const result =
				platformClient && platformTool
					? await platformClient.invokePlatformTool(platformTool, args ?? {})
					: await dispatchTool(cwd, name, args ?? {});
			// Unify the error contract across tools. `push_memory` (and any backend
			// platform tool) reports failure as a structured `{ type: "error" }`
			// result rather than throwing, so flag it `isError` here to match the
			// thrown-error path that `list_spaces` / `bind_space` take. A
			// `binding_required` result is a legitimate "needs input" outcome, not
			// an error, so it stays a normal result.
			const isError =
				typeof result === "object" && result !== null && (result as { type?: unknown }).type === "error";
			// Per-tool-call telemetry. The session-level `command:"mcp"`
			// event (fired once at stdio disconnect) can't tell which tool the AI used;
			// emit one event per call, tagged with the tool `name`. NEVER include
			// `arguments` — they may carry user content. `ok` folds in push_memory's
			// structured `{type:"error"}` result, not just thrown errors. The
			// session-level mcp event is suppressed in TelemetryCommandHook so this
			// does not double-count.
			track("command_invoked", {
				command: "mcp",
				tool: telemetryToolName(name),
				duration_ms: Date.now() - start,
				ok: !isError,
			});
			return { content: [{ type: "text", text: JSON.stringify(result) }], ...(isError ? { isError: true } : {}) };
		} catch (err) {
			track("command_invoked", {
				command: "mcp",
				tool: telemetryToolName(name),
				duration_ms: Date.now() - start,
				ok: false,
			});
			const message = err instanceof Error ? err.message : String(err);
			log.warn("Tool %s failed: %s", name, message);
			return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
		}
	});

	if (promptsEnabled) {
		// One prompt, `jolli`, that steers the agent to the curated menu. `ListPrompts`
		// returns exactly this prompt; `GetPrompt` returns a steering message built
		// from the menu. The menu items are already-registered tools, so the prompt is
		// not a second execution path — it only tells the agent which tool to call.
		const jolliPrompt: Prompt = {
			name: JOLLI_PROMPT_NAME,
			description: "Browse and run Jolli actions from a curated menu.",
			arguments: [
				{
					name: JOLLI_PROMPT_ARGUMENT,
					description:
						"Optional free-text request; matched against a menu item so the agent can invoke it directly.",
					required: false,
				},
			],
		};
		server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [jolliPrompt] }));
		server.setRequestHandler(GetPromptRequestSchema, async (req) => {
			const { name, arguments: promptArgs } = req.params;
			if (name !== JOLLI_PROMPT_NAME) {
				throw new Error(`Unknown prompt: ${name}`);
			}
			const rawRequest = promptArgs?.[JOLLI_PROMPT_ARGUMENT];
			const request = typeof rawRequest === "string" ? rawRequest : undefined;
			return {
				description: "Curated Jolli action menu.",
				messages: [{ role: "user", content: { type: "text", text: buildJolliPromptText(menu, request) } }],
			};
		});
	}

	return server;
}

/**
 * Start the stdio MCP server. Resolves when the transport closes.
 *
 * The single-process path: one client, one server, one repository. It stays the
 * behaviour a session gets when the per-worktree daemon cannot be reached, so it
 * must keep working standalone — `McpProxy` falls back to exactly this call.
 */
export async function startMcpServer(cwd: string, deps: StartMcpServerDeps = {}): Promise<void> {
	const runtime = await prepareMcpRuntime(cwd, deps);
	// A guard declined this cwd and has already said why. Exit quietly — the
	// host reports a server that would not start, which is the intended signal.
	if (!runtime) return;

	const transport = new StdioServerTransport();
	await createMcpServer(runtime).connect(transport);
	log.info("MCP server connected over stdio (cwd=%s)", cwd);
}
