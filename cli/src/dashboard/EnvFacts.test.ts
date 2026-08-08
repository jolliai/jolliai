import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as detect from "../core/localagent/DetectAgents.js";
import { readEnvironmentFacts } from "./EnvFacts.js";

describe("readEnvironmentFacts", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-envfacts-"));
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([{ id: "claude-code", label: "Claude Code" }]);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function writeConfig(config: Record<string, unknown>): void {
		writeFileSync(join(dir, "config.json"), JSON.stringify(config));
	}

	it("reports 'none' with no signal when config.json does not exist", async () => {
		const facts = await readEnvironmentFacts(dir);
		expect(facts.provider).toBe("none");
		expect(facts.keyConfigured).toBe(false);
		expect(facts.signedIn).toBe(false);
		expect(facts.localAgentTool).toBeUndefined();
	});

	it("maps aiProvider onto the Settings-facing provider union", async () => {
		writeConfig({ aiProvider: "local-agent", localAgentTool: "codex" });
		const local = await readEnvironmentFacts(dir);
		expect(local.provider).toBe("local");
		expect(local.localAgentTool).toBe("codex");

		writeConfig({ aiProvider: "anthropic", apiKey: "sk-ant-x" });
		const apikey = await readEnvironmentFacts(dir);
		expect(apikey.provider).toBe("apikey");
		expect(apikey.keyConfigured).toBe(true);

		writeConfig({ aiProvider: "jolli", jolliApiKey: "sk-jol-x" });
		const account = await readEnvironmentFacts(dir);
		expect(account.provider).toBe("account");
		expect(account.signedIn).toBe(true);
	});

	it("falls back to 'none' for an aiProvider value outside the known map", async () => {
		writeConfig({ aiProvider: "some-future-provider" });
		const facts = await readEnvironmentFacts(dir);
		expect(facts.provider).toBe("none");
	});

	it("never echoes the actual key material — only presence", async () => {
		writeConfig({ aiProvider: "anthropic", apiKey: "sk-ant-super-secret" });
		const facts = await readEnvironmentFacts(dir);
		expect(JSON.stringify(facts)).not.toContain("sk-ant-super-secret");
		expect(facts.keyConfigured).toBe(true);
	});

	it("carries the present local agents from listPresentLocalAgents verbatim", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "codex", label: "Codex" },
		]);
		const facts = await readEnvironmentFacts(dir);
		expect(facts.agentsPresent).toEqual([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "codex", label: "Codex" },
		]);
	});
});
