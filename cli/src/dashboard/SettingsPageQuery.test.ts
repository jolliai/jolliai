import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JolliMemoryConfig } from "../Types.js";
import { buildSettingsPageModel, maskApiKey } from "./SettingsPageQuery.js";

let dir: string;

function writeConfig(config: JolliMemoryConfig): string {
	const configDir = mkdtempSync(join(dir, "cfg-"));
	writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
	return configDir;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-setq-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("maskApiKey", () => {
	it("returns empty for an absent key", () => {
		expect(maskApiKey(undefined)).toBe("");
		expect(maskApiKey("")).toBe("");
	});

	it("returns a short non-prefixed value verbatim", () => {
		expect(maskApiKey("short")).toBe("short");
		expect(maskApiKey("sixteencharacter")).toBe("sixteencharacter"); // 16, no known prefix
	});

	it("masks an Anthropic key as first-12 + **** + last-4", () => {
		expect(maskApiKey("sk-ant-abcdefghijklmnop")).toBe("sk-ant-abcde****mnop");
	});

	it("masks a Jolli key even when short", () => {
		expect(maskApiKey("sk-jol-1234567890")).toBe("sk-jol-12345****7890");
	});
});

describe("buildSettingsPageModel", () => {
	it("uses defaults for an empty config (all agents on, anthropic provider)", async () => {
		const configDir = writeConfig({});
		const m = await buildSettingsPageModel(configDir, undefined);
		expect(m.agents.claudeEnabled).toBe(true);
		expect(m.agents.kimiEnabled).toBe(true);
		expect(m.agents.globalInstructions).toBe("default");
		expect(m.summary.aiProvider).toBe("anthropic");
		expect(m.summary.signedIn).toBe(false);
		expect(m.summary.hasJolliKey).toBe(false);
		expect(m.summary.apiKeyMasked).toBe("");
		expect(m.summary.localAgentTool).toBe("claude-code");
		expect(m.summary.localAgentTools.some((t) => t.id === "claude-code")).toBe(true);
		// The EFFECTIVE model, not the stored one: the default is stored as absent,
		// and a picker rendered from "" would have nothing selected.
		expect(m.summary.localAgentModel).toBe("sonnet");
		// Keyed by tool because switching the picker is a client-side state change
		// that never refetches this payload. Only pinned tools appear.
		expect(m.summary.localAgentModels["claude-code"]?.length).toBeGreaterThan(0);
		expect(m.summary.localAgentModels.codex).toBeUndefined();
		expect(m.others.dcoSignoff).toBe(false);
		expect(m.memoryBank.compileExcludeFolders).toBe("");
		expect(m.memoryBank.syncTranscripts).toBe(false);
		expect(m.memoryBank.state).toBeUndefined();
	});

	it("respects disabled agents and a disabled global-instructions value", async () => {
		const configDir = writeConfig({ claudeEnabled: false, geminiEnabled: false, globalInstructions: "disabled" });
		const m = await buildSettingsPageModel(configDir, undefined);
		expect(m.agents.claudeEnabled).toBe(false);
		expect(m.agents.geminiEnabled).toBe(false);
		expect(m.agents.codexEnabled).toBe(true);
		expect(m.agents.globalInstructions).toBe("disabled");
	});

	it("derives jolli provider from an auth token and reads hasJolliKey/site label", async () => {
		const configDir = writeConfig({
			authToken: "tok",
			jolliApiKey: "sk-jol-abcdefghijklmnop",
			jolliUrl: "https://acme.jolli.ai",
		});
		const m = await buildSettingsPageModel(configDir, undefined);
		expect(m.summary.aiProvider).toBe("jolli");
		expect(m.summary.signedIn).toBe(true);
		expect(m.summary.hasJolliKey).toBe(true);
		expect(m.summary.jolliApiKeyMasked).toBe("sk-jol-abcde****mnop");
		expect(m.summary.jolliSiteLabel).toBe("acme.jolli.ai");
	});

	it("honours an explicit provider and echoes model/maxTokens/localAgentTool", async () => {
		const configDir = writeConfig({
			aiProvider: "local-agent",
			localAgentTool: "codex",
			model: "opus",
			maxTokens: 4096,
			apiKey: "sk-ant-abcdefghijklmnop",
		});
		const m = await buildSettingsPageModel(configDir, undefined);
		expect(m.summary.aiProvider).toBe("local-agent");
		expect(m.summary.localAgentTool).toBe("codex");
		expect(m.summary.model).toBe("opus");
		// `model` is the Anthropic-API setting and must NOT leak into the
		// local-agent picker — different namespaces, deliberately separate fields.
		expect(m.summary.localAgentModel).toBe("sonnet");
		expect(m.summary.maxTokens).toBe(4096);
		expect(m.summary.apiKeyMasked).toBe("sk-ant-abcde****mnop");
	});

	it("serialises memory-bank + others list fields to their display form", async () => {
		const configDir = writeConfig({
			localFolder: "/mem/bank",
			compileExcludeFolders: ["archive", "tmp-*"],
			excludePatterns: ["*.lock", "dist/**"],
			syncTranscripts: true,
			autoSyncEnabled: true,
			syncPollIntervalSec: 5400,
			dcoSignoff: true,
		});
		const m = await buildSettingsPageModel(configDir, undefined);
		expect(m.memoryBank.localFolder).toBe("/mem/bank");
		expect(m.memoryBank.compileExcludeFolders).toBe("archive, tmp-*");
		expect(m.memoryBank.syncTranscripts).toBe(true);
		expect(m.memoryBank.autoSyncEnabled).toBe(true);
		expect(m.memoryBank.syncPollIntervalSec).toBe(5400);
		expect(m.others.excludePatterns).toBe("*.lock, dist/**");
		expect(m.others.dcoSignoff).toBe(true);
	});

	it("ignores a malformed jolliUrl for the site label", async () => {
		const configDir = writeConfig({ jolliUrl: "not a url", authToken: "t" });
		const m = await buildSettingsPageModel(configDir, undefined);
		expect(m.summary.jolliSiteLabel).toBeUndefined();
	});

	it("reports the memory-bank state and repoLabel when the launch cwd is a git project", async () => {
		const repo = mkdtempSync(join(dir, "repo-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		const configDir = writeConfig({});
		const m = await buildSettingsPageModel(configDir, repo);
		// Every git repo now carries a state line — the healthy `ok` arm is no longer
		// suppressed (it was, on a mistaken read of VS Code, which shows all three).
		expect(m.memoryBank.state).toBeDefined();
		expect(typeof m.memoryBank.state?.severity).toBe("string");
		expect(typeof m.memoryBank.state?.text).toBe("string");
		expect(typeof m.memoryBank.repoLabel).toBe("string");
		expect((m.memoryBank.repoLabel ?? "").length).toBeGreaterThan(0);
	});

	it("omits the memory-bank state when the launch cwd is not a git project", async () => {
		const plain = mkdtempSync(join(dir, "plain-"));
		const configDir = writeConfig({});
		const m = await buildSettingsPageModel(configDir, plain);
		expect(m.memoryBank.state).toBeUndefined();
		expect(m.memoryBank.repoLabel).toBeUndefined();
	});

	it("surfaces a degraded state line when the Memory Bank folder is inside the repo", async () => {
		const repo = mkdtempSync(join(dir, "repo-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		// A localFolder INSIDE the repo trips the write-boundary gate → degraded.
		const configDir = writeConfig({ localFolder: join(repo, "inside-bank") });
		const m = await buildSettingsPageModel(configDir, repo);
		expect(m.memoryBank.state).toBeDefined();
		expect(m.memoryBank.state?.severity).toBe("warn");
		expect(m.memoryBank.repoLabel).toBeTruthy();
	});
});

describe("buildSettingsPageModel — local-agent model", () => {
	it("echoes an explicitly stored model", async () => {
		const configDir = writeConfig({ aiProvider: "local-agent", localAgentModel: "haiku" });
		const m = await buildSettingsPageModel(configDir, undefined);
		expect(m.summary.localAgentModel).toBe("haiku");
	});

	it("treats a blank stored model as the default", async () => {
		// A hand-edited or half-written config must not leave the picker unselected.
		const configDir = writeConfig({ aiProvider: "local-agent", localAgentModel: "   " });
		const m = await buildSettingsPageModel(configDir, undefined);
		expect(m.summary.localAgentModel).toBe("sonnet");
	});

	it("carries the inherit escape hatch in the offered choices", async () => {
		const configDir = writeConfig({});
		const m = await buildSettingsPageModel(configDir, undefined);
		expect(m.summary.localAgentModels["claude-code"]?.map((x) => x.id)).toContain("inherit");
	});
});
