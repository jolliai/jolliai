/**
 * EnvFacts — the async half of the Settings page: which summarizer provider
 * is configured, which local agents are present on this machine, and whether
 * a credential is on file.
 *
 * Read once per request by `DashboardServer.ts`'s model builder (the same
 * seam `usage` already uses) and threaded through `QueryOptions` — the query
 * layer itself (`SettingsQuery.ts`) stays synchronous and does no I/O of its
 * own, same discipline as `buildDashboardModel` reading `usage` instead of
 * fetching it.
 *
 * Deliberately cheap: `listPresentLocalAgents()` is a filesystem presence
 * check with no subprocess (~4 ms for all four tools, per its own docstring);
 * the config read is one small JSON file. Neither ever spawns a probe —
 * `isLocalAgentUsable`/`canGenerateNow` do that, and belong behind a
 * "Check again" button (`/api/summarizer-check`, a later phase), never in a
 * per-request read that runs on every page render.
 */

import { listPresentLocalAgents, localAgentOverrideFrom } from "../core/localagent/DetectAgents.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import type { SettingsSummarizerState, SummarizerProvider } from "./DashboardModel.js";

const PROVIDER_MAP: Readonly<Record<string, SummarizerProvider>> = {
	"local-agent": "local",
	anthropic: "apikey",
	jolli: "account",
};

/** Everything `SettingsQuery.ts` needs that requires I/O to answer. */
export type EnvFacts = Omit<SettingsSummarizerState, "mustAsk">;

export async function readEnvironmentFacts(configDir: string = getGlobalConfigDir()): Promise<EnvFacts> {
	const config = await loadConfigFromDir(configDir);
	return {
		provider: config.aiProvider ? (PROVIDER_MAP[config.aiProvider] ?? "none") : "none",
		...(config.localAgentTool ? { localAgentTool: config.localAgentTool } : {}),
		agentsPresent: listPresentLocalAgents(localAgentOverrideFrom(config)),
		keyConfigured: Boolean(config.apiKey),
		signedIn: Boolean(config.jolliApiKey),
	};
}
