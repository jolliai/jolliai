import { describe, expect, it } from "vitest";
import type { EnvFacts } from "./EnvFacts.js";
import { buildSettings } from "./SettingsQuery.js";

const BASE: EnvFacts = { provider: "none", agentsPresent: [], keyConfigured: false, signedIn: false };

describe("buildSettings", () => {
	it("sets mustAsk only when no provider is configured", () => {
		expect(buildSettings(BASE, [], 1818).summarizer.mustAsk).toBe(true);
		expect(buildSettings({ ...BASE, provider: "local" }, [], 1818).summarizer.mustAsk).toBe(false);
	});

	it("echoes the real bound port rather than a literal", () => {
		expect(buildSettings(BASE, [], 18118).privacy.port).toBe(18118);
	});

	it("reports transcripts as always local", () => {
		expect(buildSettings(BASE, [], 1818).privacy.transcriptsLocal).toBe(true);
	});

	it("flags the summarizer as leaving the machine only for apikey/account, never local or none", () => {
		expect(buildSettings({ ...BASE, provider: "local" }, [], 1818).privacy.summarizerLeaves).toBe(false);
		expect(buildSettings({ ...BASE, provider: "none" }, [], 1818).privacy.summarizerLeaves).toBe(false);
		expect(buildSettings({ ...BASE, provider: "apikey" }, [], 1818).privacy.summarizerLeaves).toBe(true);
		expect(buildSettings({ ...BASE, provider: "account" }, [], 1818).privacy.summarizerLeaves).toBe(true);
	});

	it("passes the per-repo hook status through verbatim", () => {
		const hooks = [
			{
				repoIdentity: "r1",
				repoName: "acme-api",
				gitHookInstalled: true,
				claudeHookInstalled: true,
				geminiHookInstalled: false,
				mcpRegistered: true,
			},
		];
		expect(buildSettings(BASE, hooks, 1818).hooks).toEqual(hooks);
	});

	it("carries agentsPresent/localAgentTool/keyConfigured/signedIn through to the summarizer state", () => {
		const facts: EnvFacts = {
			provider: "local",
			localAgentTool: "codex",
			agentsPresent: [{ id: "codex", label: "Codex" }],
			keyConfigured: true,
			signedIn: false,
		};
		const settings = buildSettings(facts, [], 1818);
		expect(settings.summarizer).toEqual({ ...facts, mustAsk: false });
	});
});
