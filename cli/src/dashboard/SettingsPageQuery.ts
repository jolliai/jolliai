/**
 * SettingsPageQuery — assembles the Settings page payload
 * ({@link SettingsPageModel}) that the shipped Settings page reads. Mirrors the
 * VS Code settings panel's five tabs (AI Agents / AI Summary / Sync to Jolli /
 * Memory Bank / Others), NOT the mockup-era `SettingsQuery.buildSettings`.
 *
 * Two hard rules, both about the API key:
 *   - Only the MASKED key ever reaches this payload. The full key stays in
 *     config.json; `SettingsMutations.applySettings` re-reads it on save.
 *   - Nothing here decodes or logs a key, so this stays clear of the CodeQL
 *     `js/clear-text-logging` gate — the same reason `jolli status` never
 *     decodes the key.
 *
 * Cheap by construction: one config read plus a `peekKBPath` folder-state probe
 * (never a subprocess). The slow bits — the local-agent `--version` probe and
 * the `git rev-list` missing-summaries count — live behind their own endpoints,
 * not in this per-render read.
 */

import { getProjectRootDir } from "../core/GitOps.js";
import { extractRepoName, resolveMemoryBankState } from "../core/KBPathResolver.js";
import { effectiveLocalAgentModel, LOCAL_AGENT_TOOLS, localAgentToolModels } from "../core/localagent/ToolMeta.js";
import { describeMemoryBank } from "../core/MemoryBankStatusText.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import type { JolliMemoryConfig, LocalAgentToolId } from "../Types.js";
import type { SettingsPageModel } from "./DashboardModel.js";

/**
 * Masks an API key for display: first up-to-12 chars + `****` + last 4. Ported
 * verbatim from `vscode/src/views/SettingsWebviewPanel.ts` so a key masked here
 * compares equal to one masked there on the round-trip. Empty string for an
 * absent key.
 */
export function maskApiKey(key: string | undefined): string {
	if (!key) return "";
	const hasKnownPrefix = key.startsWith("sk-ant-") || key.startsWith("sk-jol-");
	if (!hasKnownPrefix && key.length <= 16) return key;
	const prefixLen = Math.min(12, key.length - 4);
	if (prefixLen <= 0) return key;
	return `${key.substring(0, prefixLen)}****${key.substring(key.length - 4)}`;
}

/**
 * Resolves the AI provider the same way the VS Code panel does: an explicit
 * value wins; otherwise "jolli" when signed in (an auth token is on file), else
 * "anthropic".
 */
function resolveProvider(config: JolliMemoryConfig): "anthropic" | "jolli" | "local-agent" {
	if (config.aiProvider === "anthropic" || config.aiProvider === "jolli" || config.aiProvider === "local-agent") {
		return config.aiProvider;
	}
	return config.authToken ? "jolli" : "anthropic";
}

/**
 * A short, non-secret label for the Jolli site the user is signed in to. Derives
 * the host from `jolliUrl` (never decodes the key). Absent when no site is known.
 */
function jolliSiteLabel(config: JolliMemoryConfig): string | undefined {
	const url = config.jolliUrl;
	if (!url) return undefined;
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}

/** The local-agent tools this build knows, in `LOCAL_AGENT_TOOLS` order. */
function localAgentTools(): ReadonlyArray<{ readonly id: LocalAgentToolId; readonly label: string }> {
	return (Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[]).map((id) => ({
		id,
		label: LOCAL_AGENT_TOOLS[id].label,
	}));
}

/** Model choices per tool id, omitting the tools jollimemory does not pin one for. */
function localAgentModels(): Readonly<Record<string, ReadonlyArray<{ id: string; label: string }>>> {
	const out: Record<string, ReadonlyArray<{ id: string; label: string }>> = {};
	for (const id of Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[]) {
		const models = localAgentToolModels(id);
		if (models.length > 0) out[id] = models;
	}
	return out;
}

/**
 * Builds the Settings payload. `launchCwd` is the server's own repo root
 * (`process.cwd()` in production) — it drives ONLY the Memory Bank state line
 * and its `repoLabel`; when it is not a git project the state is omitted rather
 * than shown as a misleading verdict.
 */
export async function buildSettingsPageModel(
	configDir: string | undefined,
	launchCwd: string | undefined,
): Promise<SettingsPageModel> {
	const config = await loadConfigFromDir(configDir ?? getGlobalConfigDir());

	const memoryBankState = await resolveLaunchRepoState(launchCwd, config);

	return {
		agents: {
			claudeEnabled: config.claudeEnabled !== false,
			codexEnabled: config.codexEnabled !== false,
			geminiEnabled: config.geminiEnabled !== false,
			openCodeEnabled: config.openCodeEnabled !== false,
			cursorEnabled: config.cursorEnabled !== false,
			devinEnabled: config.devinEnabled !== false,
			copilotEnabled: config.copilotEnabled !== false,
			clineEnabled: config.clineEnabled !== false,
			antigravityEnabled: config.antigravityEnabled !== false,
			kimiEnabled: config.kimiEnabled !== false,
			globalInstructions:
				config.globalInstructions === "enabled"
					? "enabled"
					: config.globalInstructions === "disabled"
						? "disabled"
						: "default",
		},
		summary: {
			aiProvider: resolveProvider(config),
			...(config.model ? { model: config.model } : {}),
			...(typeof config.maxTokens === "number" ? { maxTokens: config.maxTokens } : {}),
			apiKeyMasked: maskApiKey(config.apiKey),
			jolliApiKeyMasked: maskApiKey(config.jolliApiKey),
			signedIn: Boolean(config.authToken),
			hasJolliKey: Boolean(config.jolliApiKey),
			...(jolliSiteLabel(config) ? { jolliSiteLabel: jolliSiteLabel(config) } : {}),
			localAgentTool: config.localAgentTool ?? "claude-code",
			localAgentTools: localAgentTools(),
			// The EFFECTIVE value, resolved by the shared helper rather than by a
			// local `|| DEFAULT`: an id this build does not know has to render as
			// the default too, or the page shows one model while holding another
			// and every later save is rejected for a field nobody edited.
			localAgentModel: effectiveLocalAgentModel(config.localAgentModel),
			localAgentModels: localAgentModels(),
		},
		memoryBank: {
			...(config.localFolder ? { localFolder: config.localFolder } : {}),
			compileExcludeFolders: config.compileExcludeFolders ? config.compileExcludeFolders.join(", ") : "",
			syncTranscripts: Boolean(config.syncTranscripts),
			...(config.autoSyncEnabled !== undefined ? { autoSyncEnabled: config.autoSyncEnabled } : {}),
			...(typeof config.syncPollIntervalSec === "number"
				? { syncPollIntervalSec: config.syncPollIntervalSec }
				: {}),
			...memoryBankState,
		},
		others: {
			dcoSignoff: config.dcoSignoff === true,
			excludePatterns: config.excludePatterns ? config.excludePatterns.join(", ") : "",
		},
	};
}

/**
 * The Memory Bank `state` + `repoLabel` slice, or `{}` when `launchCwd` is not a
 * git project (no honest verdict to show). All three severities are reported —
 * including the healthy `ok` arm, whose text is the resolved per-repo folder
 * ("where memories land") — matching the VS Code panel, which renders ok / warn /
 * off alike (a ✓ line for ok). An earlier version dropped the ok arm on the
 * mistaken belief that VS Code hid it; it does not.
 */
type LaunchRepoState = Partial<Pick<SettingsPageModel["memoryBank"], "state" | "repoLabel">>;

// The launch repo is fixed for the server's lifetime, and its git-derived state
// (root, name, Memory Bank folder verdict) only moves when `localFolder` does —
// but computing it spawns several git subprocesses (~2 s cold on Windows).
// Uncached it ran on EVERY settings-model fetch, so reopening the modal re-paid
// the full cost and, colliding with the 30 s page poll, could stall long enough
// to look hung ("Loading settings…" that never resolves). Memoised by
// (launchCwd, localFolder): an Apply that changes the folder re-keys and
// recomputes once; a server restart clears it.
let launchStateCache: { readonly key: string; readonly value: LaunchRepoState } | null = null;

async function resolveLaunchRepoState(
	launchCwd: string | undefined,
	config: JolliMemoryConfig,
): Promise<LaunchRepoState> {
	if (!launchCwd) return {};
	const key = `${launchCwd}\u0000${config.localFolder ?? ""}`;
	if (launchStateCache?.key === key) return launchStateCache.value;
	let value: LaunchRepoState;
	try {
		const repoRoot = await getProjectRootDir(launchCwd);
		const display = describeMemoryBank(resolveMemoryBankState(repoRoot, { localFolder: config.localFolder }));
		value = { state: display, repoLabel: extractRepoName(repoRoot) };
	} catch {
		value = {};
	}
	launchStateCache = { key, value };
	return value;
}

/**
 * Drops the memoised launch-repo state. A host MUST call this after an action
 * that changes which folder the launch repo resolves to WITHOUT changing
 * `localFolder` — today "Migrate to Memory Bank", which archives the current
 * folder and re-migrates into the freed base `<repo>` slot. The cache key is
 * `(launchCwd, localFolder)`, so a migrate leaves the key unchanged and the
 * stale (now-archived) path would keep being served until a server restart.
 * MemoryBankRebuild deliberately leaves this invalidation to the host.
 */
export function clearLaunchRepoStateCache(): void {
	launchStateCache = null;
}
