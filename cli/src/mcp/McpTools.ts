/**
 * Pure MCP tool handlers (JOLLI-1226 P0). Each returns a plain
 * JSON-serializable object and throws a plain Error on bad input. No MCP SDK
 * coupling here so the handlers are unit-testable in isolation; McpServer.ts
 * adapts these into SDK tool responses.
 */

import { loadAuthToken } from "../auth/AuthConfig.js";
import { VERSION } from "../commands/CliUtils.js";
import {
	buildHookRuntime,
	buildHookSummary,
	buildIntegrationRows,
	collectIntegrationScanErrors,
	describeIntegrationStatus,
	describeSchemaV5Status,
	type IntegrationScanError,
	resolveClaudeHookActive,
} from "../commands/StatusCommand.js";
import { isClaudePluginBuild } from "../core/ClientHeader.js";
import type { BranchCatalog } from "../core/ContextCompiler.js";
import { listBranchCatalog } from "../core/ContextCompiler.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import {
	BindingAlreadyExistsError,
	JolliMemoryPushClient,
	type JolliMemorySpace,
} from "../core/JolliMemoryPushClient.js";
import { type PushBranchResult, pushBranchToJolli, resolveSpaceId } from "../core/JolliMemoryPushOrchestrator.js";
import { localAgentToolLabel } from "../core/localagent/ToolMeta.js";
import { buildPrDescription, type PrDescriptionResult } from "../core/PrDescription.js";
import { getQueueStatus, type QueueStatus, waitForQueueDrained } from "../core/QueueStatus.js";
import { type RecallResult, resolveRecall } from "../core/RecallResolver.js";
import { searchHits } from "../core/SearchHits.js";
import type { SearchHitResult } from "../core/SearchIndex.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import { compareSourceRefs } from "../core/SourceTimeline.js";
import { clearSpaceBindingCache, loadSpaceBindingDisplay } from "../core/SpaceBindingCache.js";
import { getActiveStorage } from "../core/SummaryStore.js";
import { readTopicPage } from "../core/TopicPageStore.js";
import { getStatus } from "../install/Installer.js";
import type { LocalAgentToolId, StatusInfo } from "../Types.js";

export interface SearchArgs {
	query: string;
	branch?: string;
	type?: "topic" | "commit";
	limit?: number;
}

export async function runSearch(cwd: string, args: SearchArgs): Promise<{ hits: SearchHitResult[] }> {
	return { hits: await searchHits(cwd, args, getActiveStorage()) };
}

export async function runRecall(cwd: string, args: { branch?: string }): Promise<RecallResult> {
	return resolveRecall(args.branch, cwd);
}

export interface TimelineEntry {
	timestamp: string;
	branch: string;
	sourceType: string;
	sourceId: string;
}

export async function runDecisionTimeline(
	cwd: string,
	args: { slug: string },
): Promise<{ slug: string; title: string; timeline: TimelineEntry[] }> {
	if (!args.slug || !args.slug.trim()) {
		throw new Error("`slug` is required");
	}
	const page = await readTopicPage(args.slug, cwd);
	if (!page) {
		throw new Error(`Topic not found: ${args.slug}`);
	}
	// Order via the canonical comparator (epoch-parsed, with type/id tie-break)
	// so a topic whose sources carry mixed-timezone timestamps reads in the same
	// chronological order the ingest fold actually applied — a plain string
	// localeCompare would sort '…+09:00' vs '…Z' by their suffix, not by instant.
	const timeline = [...page.sourceRefs]
		.sort(compareSourceRefs)
		.map((r) => ({ timestamp: r.timestamp, branch: r.branch ?? "", sourceType: r.type, sourceId: r.id }));
	return { slug: args.slug, title: page.title, timeline };
}

export async function runListBranches(cwd: string): Promise<BranchCatalog> {
	return listBranchCatalog(cwd);
}

export interface GetPrDescriptionArgs {
	baseBranch?: string;
	includeMarkers?: boolean;
}

export async function runGetPrDescription(cwd: string, args: GetPrDescriptionArgs): Promise<PrDescriptionResult> {
	return buildPrDescription(cwd, {
		baseBranch: args.baseBranch,
		includeMarkers: args.includeMarkers,
	});
}

export interface QueueStatusArgs {
	wait?: boolean;
	timeoutMs?: number;
}

export async function runQueueStatus(cwd: string, args: QueueStatusArgs): Promise<QueueStatus & { waitedMs?: number }> {
	if (args.wait) {
		return waitForQueueDrained(cwd, { timeoutMs: args.timeoutMs });
	}
	return getQueueStatus(cwd);
}

export interface PushMemoryArgs {
	baseBranch?: string;
	space?: string;
}

/** Pushes `base..HEAD` commit summaries on the current branch to the bound Jolli Space. */
export async function runPushMemory(cwd: string, args: PushMemoryArgs): Promise<PushBranchResult> {
	return pushBranchToJolli({ cwd, baseBranch: args.baseBranch, space: args.space });
}

/** Lists the Jolli Spaces this tenant can bind a repo to, plus its configured default. */
export async function runListSpaces(
	_cwd: string,
): Promise<{ spaces: JolliMemorySpace[]; defaultSpaceId: number | null }> {
	return new JolliMemoryPushClient().listSpaces();
}

export type BindSpaceResult =
	| { type: "bound"; bindingId: number; jmSpaceId: number; repoName: string }
	| { type: "already_bound"; message: string };

/**
 * Binds this repo to a Jolli Space. Mirrors `jolli bind` (`JolliCloudCommands.ts`):
 * an already-existing binding is not an error condition — it comes back as
 * `{ type: "already_bound" }` rather than throwing.
 */
export async function runBindSpace(cwd: string, args: { space: string }): Promise<BindSpaceResult> {
	if (!args.space || !args.space.trim()) {
		throw new Error("`space` is required");
	}
	const client = new JolliMemoryPushClient();
	const repoUrl = await getCanonicalRepoUrl(cwd);
	const jmSpaceId = await resolveSpaceId(client, args.space);
	const repoName = deriveRepoNameFromUrl(repoUrl);
	try {
		const binding = await client.createBinding({ repoUrl, repoName, jmSpaceId });
		// Bind-only entry point: drop the local binding cache — the next probe
		// (or push echo) rebuilds it with the authoritative Space details.
		await clearSpaceBindingCache(cwd);
		return { type: "bound", ...binding };
	} catch (err) {
		if (err instanceof BindingAlreadyExistsError) {
			return { type: "already_bound", message: err.message };
		}
		throw err;
	}
}

/** One detected AI integration in a status report. */
export interface StatusIntegration {
	readonly name: string;
	readonly detected: boolean;
	/**
	 * The SINGLE display representation of this integration — a human descriptor
	 * that already embeds the session count with its unit (e.g. `"hook installed
	 * (15 sessions)"` / `"detected & enabled"` when there are none), mirroring the
	 * `jolli status` row wording. There is deliberately NO separate bare
	 * `sessionCount` field: a redundant raw number let renderers show a unit-less
	 * count for some integrations while Claude got `(N sessions)`, so the count now
	 * lives ONLY inside this string.
	 */
	readonly status: string;
	/**
	 * Per-channel scan failures for the dual-variant integrations (Copilot, Cline,
	 * Cursor). Present ONLY when at least one channel failed. The merged `status`
	 * descriptor stays healthy when just one channel is broken (so its session
	 * count is not masked), so a single-channel failure would otherwise be
	 * invisible to an MCP caller — it travels here instead. Mirrors the `jolli
	 * status` `↳ … scan failed` sub-lines and the VS Code STATUS tree's per-channel
	 * warning nodes. Single-channel sources never populate this: their failure
	 * already reads as `unavailable — <kind>` in `status`.
	 */
	readonly scanErrors?: readonly IntegrationScanError[];
}

/** Curated installation & configuration health report — the `status` MCP tool result. */
export interface StatusResult {
	readonly version: string;
	/** Extension is "enabled" when the git hook is installed. */
	readonly enabled: boolean;
	readonly hooks: {
		/** e.g. "5 Git + 2 Claude + 1 Gemini", or "none installed". */
		readonly summary: string;
		readonly git: boolean;
		readonly prePush: boolean;
		readonly claude: boolean;
		readonly gemini: boolean;
		/** Active hook runtime, e.g. "cli@1.0.0"; null when no source is registered. */
		readonly runtime: string | null;
	};
	readonly dataMigration: string;
	readonly account: {
		readonly signedIn: boolean;
		/**
		 * Whether a stored Jolli API key (`sk-jol-…`) is present. Surfaced ONLY when
		 * signed OUT — a sign-in already mints/implies a Jolli generation credential,
		 * so once `signedIn` is true this key's presence is redundant and omitted.
		 */
		readonly jolliApiKeyConfigured?: boolean;
		/**
		 * Whether an Anthropic key is available. Surfaced ONLY when
		 * `aiProvider === "anthropic"` — the sole provider that consumes it. Omitted
		 * for every other provider (jolli / local-agent / unset), where it is moot.
		 */
		readonly anthropicKeyConfigured?: boolean;
		/**
		 * The explicit AI provider choice, or null when unset (surfaces derive a
		 * default). `"local-agent"` means summaries are generated by driving a local
		 * agent CLI (the Claude Code subscription) and need NO Jolli/Anthropic key —
		 * so a caller must not report "no credential → memory generation disabled"
		 * when this is `"local-agent"`. A plain enum, never key-derived.
		 */
		readonly aiProvider: "anthropic" | "jolli" | "local-agent" | null;
		/**
		 * Human-readable label of the local agent CLI driving generation (e.g.
		 * "Claude Code", "Codex"). Surfaced ONLY when `aiProvider === "local-agent"`;
		 * mirrors the `jolli status` footer via `localAgentToolLabel`.
		 */
		readonly localAgentTool?: string;
		/** Public site host (protocol stripped); null when none is persisted. */
		readonly site: string | null;
		/** "Jolli Site" when a disk credential backs the URL, else "Last signed-in site"; null when no site. */
		readonly siteLabel: string | null;
	};
	readonly sessions: number;
	readonly integrations: StatusIntegration[];
	readonly storedMemories: number;
	readonly orphanBranch: string;
	/**
	 * The Jolli Space this repo's memories sync to, or null when the repo is not
	 * bound (or the binding is unknown / stale). Sourced from the local binding
	 * cache — a `git push` auto-syncs the branch's memories to this Space via the
	 * pre-push hook, so this drives the `syncing · Space "<name>"` snapshot line.
	 */
	readonly space: { readonly name: string } | null;
}

/**
 * Account/config facts resolved outside the pure summariser. Kept as plain
 * booleans + the raw site URL so `buildStatusSummary` does no I/O and never
 * touches secret material — the caller decides these from config.
 */
export interface StatusAccountInput {
	readonly signedIn: boolean;
	readonly jolliApiKeyConfigured: boolean;
	readonly anthropicKeyConfigured: boolean;
	/** Explicit `aiProvider` choice, or null when unset. A plain enum, not secret material. */
	readonly aiProvider: "anthropic" | "jolli" | "local-agent" | null;
	/** Configured local agent CLI id, or null when unset (defaults to "claude-code"). Only meaningful when `aiProvider === "local-agent"`. */
	readonly localAgentTool: LocalAgentToolId | null;
	/** Full persisted `jolliUrl` (with protocol) or null. Never derived from the API key. */
	readonly site: string | null;
	/** Whether an on-disk credential backs the site URL (drives siteLabel). */
	readonly diskBacked: boolean;
	readonly claudeEnabled: boolean;
}

/**
 * Curates a {@link StatusInfo} into the compact {@link StatusResult} the MCP
 * `status` tool returns. Pure: hook/integration wording is shared with
 * `jolli status` via `describeIntegrationStatus` / `describeSchemaV5Status` so
 * both surfaces stay in lockstep.
 */
export function buildStatusSummary(
	status: StatusInfo,
	ctx: {
		version: string;
		account: StatusAccountInput;
		isClaudePlugin: boolean;
		/** Bound Space name from the local binding cache; null/omitted when unbound. */
		space?: { name: string } | null;
	},
): StatusResult {
	// Hook summary / runtime / integration rows are built from the shared helpers
	// in StatusCommand so this tool and `jolli status` never drift. The plugin
	// manifest bootstrap does not count as a business Agent hook.
	const claudeHookActive = resolveClaudeHookActive(status, ctx.isClaudePlugin);
	const summary = buildHookSummary(status, claudeHookActive);
	const runtime = buildHookRuntime(status) ?? null;

	const integrations: StatusIntegration[] = buildIntegrationRows(status, {
		claudeEnabled: ctx.account.claudeEnabled,
		claudeHookActive,
	}).map(({ name, inputs }) => {
		// A merged row's `scanError` is gated on BOTH channels failing (so a
		// healthy channel's session count survives), which means a single broken
		// channel is invisible in `status`. Recover it into the structured field.
		const scanErrors = collectIntegrationScanErrors(status, name);
		return {
			name,
			detected: true,
			status: describeIntegrationStatus(inputs),
			...(scanErrors.length > 0 ? { scanErrors } : {}),
		};
	});

	const site = ctx.account.site ? ctx.account.site.replace(/^https?:\/\//, "") : null;
	const siteLabel = site ? (ctx.account.diskBacked ? "Jolli Site" : "Last signed-in site") : null;

	return {
		version: ctx.version,
		enabled: status.enabled,
		hooks: {
			summary,
			git: status.gitHookInstalled,
			prePush: status.prePushHookInstalled ?? false,
			claude: claudeHookActive,
			gemini: status.geminiHookInstalled,
			runtime,
		},
		dataMigration: describeSchemaV5Status(status.schemaV5),
		// Provider-contextual: surface only the credential that matters for the
		// active provider. `jolliApiKeyConfigured` shows only when signed OUT (a
		// sign-in already carries a Jolli credential); `anthropicKeyConfigured`
		// only for the Anthropic provider; `localAgentTool` only for local-agent.
		account: {
			signedIn: ctx.account.signedIn,
			...(ctx.account.signedIn ? {} : { jolliApiKeyConfigured: ctx.account.jolliApiKeyConfigured }),
			...(ctx.account.aiProvider === "anthropic"
				? { anthropicKeyConfigured: ctx.account.anthropicKeyConfigured }
				: {}),
			aiProvider: ctx.account.aiProvider,
			...(ctx.account.aiProvider === "local-agent"
				? { localAgentTool: localAgentToolLabel(ctx.account.localAgentTool ?? "claude-code") }
				: {}),
			site,
			siteLabel,
		},
		sessions: status.activeSessions,
		integrations,
		storedMemories: status.summaryCount,
		orphanBranch: status.orphanBranch,
		space: ctx.space ?? null,
	};
}

/**
 * Reports Jolli Memory's installation & configuration health for this repo —
 * the same data as `jolli status`, shaped as structured JSON for an AI host.
 * Reads the public site from `config.jolliUrl` (never decoded from the API key,
 * which would trip CodeQL's clear-text-logging taint) and exposes credential
 * presence as booleans only.
 */
export async function runStatus(cwd: string): Promise<StatusResult> {
	const status = await getStatus(cwd, getActiveStorage());
	const config = await loadConfigFromDir(getGlobalConfigDir());
	// Env-aware, matching `jolli status` / `jolli auth status`.
	const authToken = await loadAuthToken();
	// Bound Space name for the snapshot's `syncing · Space "<name>"` line. Read from
	// the local binding cache display path — no API-key decode, so this stays clear
	// of CodeQL's clear-text-logging gate (like the account.site handling below).
	const binding = await loadSpaceBindingDisplay(cwd);
	return buildStatusSummary(status, {
		version: VERSION,
		isClaudePlugin: isClaudePluginBuild(),
		space: binding ? { name: binding.spaceName } : null,
		account: {
			signedIn: !!authToken,
			jolliApiKeyConfigured: !!config.jolliApiKey,
			anthropicKeyConfigured: !!(config.apiKey || process.env.ANTHROPIC_API_KEY),
			aiProvider: config.aiProvider ?? null,
			localAgentTool: config.localAgentTool ?? null,
			site: config.jolliUrl ?? null,
			diskBacked: !!(config.authToken || config.jolliApiKey),
			claudeEnabled: config.claudeEnabled !== false,
		},
	});
}
