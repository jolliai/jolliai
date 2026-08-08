/**
 * SettingsQuery — assembles the Settings page payload from `EnvFacts.ts`'s
 * async read plus the server's real bound port. Pure and synchronous, same
 * discipline as every other `build*` function in this directory: all I/O
 * already happened before this runs.
 *
 * Deliberate divergences from the mockup, all because the real system cannot
 * honestly claim what it draws:
 *   - No API key input field — an Anthropic key never reaches this page's
 *     payload, let alone a form on it (`jolli configure` sets it instead).
 *   - No Gemini option — `LocalAgentToolId` does not include it; the agent
 *     list is generated from `listPresentLocalAgents()`, never hand-written.
 *   - No Space-sharing state — `detectTier` cannot reach `"space"` yet, so
 *     there is nothing here to report beyond "not determined".
 */

import type { RepoHookStatus, SettingsModel } from "./DashboardModel.js";
import type { EnvFacts } from "./EnvFacts.js";

export function buildSettings(envFacts: EnvFacts, hooks: ReadonlyArray<RepoHookStatus>, port: number): SettingsModel {
	return {
		summarizer: { ...envFacts, mustAsk: envFacts.provider === "none" },
		hooks,
		privacy: {
			port,
			transcriptsLocal: true,
			summarizerLeaves: envFacts.provider === "apikey" || envFacts.provider === "account",
		},
	};
}
