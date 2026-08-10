/**
 * GenerationFix — `canGenerateNow` local-agent probing, plus the `jolliUrl`
 * sync on the first-run Jolli-key paste.
 *
 * The other interactive repair-ladder branches (`promptGenerationFix` / R1-R3)
 * are exercised end-to-end via `GuidedFrontDoor.test.ts`, which mocks the same
 * underlying modules (`auth/Login.js`, `core/SessionTracker.js`,
 * `core/localagent/DetectAgents.js`, `./CliUtils.js`) that this module imports.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as detect from "../core/localagent/DetectAgents.js";
import type { JolliMemoryConfig } from "../Types.js";
import { canGenerateNow, promptGenerationFix } from "./GenerationFix.js";

// Spread the originals: this file's `canGenerateNow` cases run under the same
// hoisted mocks, and they reach the real LlmClient, which imports SessionTracker.
const { mockPromptText, mockSaveConfigScoped, mockResolveJolliUrlForKey } = vi.hoisted(() => ({
	mockPromptText: vi.fn(),
	mockSaveConfigScoped: vi.fn(),
	mockResolveJolliUrlForKey: vi.fn(),
}));

vi.mock("./CliUtils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./CliUtils.js")>()),
	promptText: mockPromptText,
}));

vi.mock("../core/SessionTracker.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/SessionTracker.js")>()),
	getGlobalConfigDir: () => "/mock/global/config",
	saveConfigScoped: mockSaveConfigScoped,
}));

// `validateJolliApiKey` stays REAL — it is what rejects a bad paste before any
// save. Only the key→tenant rule is stubbed (it has its own coverage in
// JolliApiUtils.test.ts), because with the real one the two are redundant: every
// key `validateJolliApiKey` accepts also yields a tenant, so the "no tenant
// claim" branch below could not be reached through this path at all.
vi.mock("../core/JolliApiUtils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/JolliApiUtils.js")>()),
	resolveJolliUrlForKey: mockResolveJolliUrlForKey,
}));

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

/**
 * The first-run paste path. `jolliUrl` has to follow the key here for the same
 * reason it does in `configure --set` and the two IDE settings panels — and the
 * drift it prevents is visible in this very command, since the guided front
 * door's `✓ signed in · <site>` line reads `config.jolliUrl` a few steps later.
 */
describe("promptGenerationFix — Jolli key paste persists the key's tenant", () => {
	/** Builds a valid new-format sk-jol key whose embedded meta is the given object. */
	function buildKey(meta: Record<string, unknown>): string {
		return `sk-jol-${Buffer.from(JSON.stringify(meta)).toString("base64url")}.secret`;
	}

	/**
	 * Drives the R2 ladder down to the key prompt: provider is Jolli, neither
	 * provider has a key, so the menu is "1. Enter a Jolli key / 2. Skip" and an
	 * empty answer takes the default. Returns what `saveConfigScoped` received.
	 */
	async function pasteKey(key: string): Promise<Partial<JolliMemoryConfig> | undefined> {
		const priorEnvKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockPromptText.mockResolvedValueOnce("").mockResolvedValueOnce(key);
		try {
			await promptGenerationFix({ aiProvider: "jolli" });
		} finally {
			if (priorEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = priorEnvKey;
		}
		return mockSaveConfigScoped.mock.calls.at(-1)?.[0] as Partial<JolliMemoryConfig> | undefined;
	}

	afterEach(() => {
		vi.restoreAllMocks();
		mockPromptText.mockReset();
		mockSaveConfigScoped.mockReset();
		mockResolveJolliUrlForKey.mockReset();
	});

	it("writes the key's embedded tenant alongside the key", async () => {
		mockResolveJolliUrlForKey.mockReturnValue("https://acme.jolli.ai");
		const key = buildKey({ t: "acme", u: "https://acme.jolli.ai" });
		expect(await pasteKey(key)).toEqual({
			jolliApiKey: key,
			aiProvider: "jolli",
			jolliUrl: "https://acme.jolli.ai",
		});
	});

	// Conditional spread, not a plain field: `saveConfigScoped` merges shallowly,
	// so an explicit `undefined` would delete a jolliUrl the user still needs.
	it("omits jolliUrl when the key yields no tenant", async () => {
		mockResolveJolliUrlForKey.mockReturnValue(undefined);
		const key = buildKey({ t: "acme", u: "https://acme.jolli.ai" });
		const update = await pasteKey(key);
		expect(update).toEqual({ jolliApiKey: key, aiProvider: "jolli" });
		expect(update).not.toHaveProperty("jolliUrl");
	});

	// The real `validateJolliApiKey` runs first, so an off-allowlist tenant never
	// reaches the sync — no key AND no URL are written.
	it("saves nothing when the pasted key is rejected", async () => {
		const key = buildKey({ t: "evil", u: "https://evil.example.com" });
		expect(await pasteKey(key)).toBeUndefined();
		expect(mockResolveJolliUrlForKey).not.toHaveBeenCalled();
	});
});
