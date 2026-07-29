/**
 * GenerationFix — `canGenerateNow` local-agent probing.
 *
 * The interactive repair-ladder branches (`promptGenerationFix` / R1-R3) are
 * already exercised end-to-end via `GuidedFrontDoor.test.ts`, which mocks the
 * same underlying modules (`auth/Login.js`, `core/SessionTracker.js`,
 * `core/localagent/DetectAgents.js`, `./CliUtils.js`) that this module
 * imports. This file covers the specific bug this task fixes: `canGenerateNow`
 * must probe the CONFIGURED local-agent tool, not `claude` unconditionally.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as detect from "../core/localagent/DetectAgents.js";
import { canGenerateNow } from "./GenerationFix.js";

describe("canGenerateNow — configured tool, not claude", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("probes the configured tool, not claude", async () => {
		const spy = vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		await canGenerateNow({ aiProvider: "local-agent", localAgentTool: "codex" });
		expect(spy).toHaveBeenCalledWith("codex", { override: undefined });
	});

	it("reports usable for a Codex-only machine", async () => {
		vi.spyOn(detect, "isLocalAgentUsable").mockImplementation(async (t) => t === "codex");
		await expect(canGenerateNow({ aiProvider: "local-agent", localAgentTool: "codex" })).resolves.toBe(true);
	});

	it("reports unusable when the configured tool is broken even if claude works", async () => {
		vi.spyOn(detect, "isLocalAgentUsable").mockImplementation(async (t) => t === "claude-code");
		await expect(canGenerateNow({ aiProvider: "local-agent", localAgentTool: "opencode" })).resolves.toBe(false);
	});

	it("defaults to claude-code when localAgentTool is absent", async () => {
		const spy = vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		await canGenerateNow({ aiProvider: "local-agent" });
		expect(spy).toHaveBeenCalledWith("claude-code", { override: undefined });
	});

	it("passes an explicit localAgentPath through as a tool-SCOPED override", async () => {
		const spy = vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		await canGenerateNow({ aiProvider: "local-agent", localAgentTool: "cursor-agent", localAgentPath: "/opt/bin" });
		expect(spy).toHaveBeenCalledWith("cursor-agent", {
			override: { tool: "cursor-agent", path: "/opt/bin" },
		});
	});

	it("non-local-agent providers defer to resolveLlmCredentialSource (no local-agent probe)", async () => {
		const priorKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const spy = vi.spyOn(detect, "isLocalAgentUsable");
			await expect(canGenerateNow({ aiProvider: "anthropic", apiKey: "sk-ant-x" })).resolves.toBe(true);
			await expect(canGenerateNow({ aiProvider: "anthropic" })).resolves.toBe(false);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = priorKey;
		}
	});
});
