import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../../Types.js";
import { updateConfigTransactional } from "../SessionTracker.js";
import { applyPluginInitLocalAgentTool, pluginBootstrapHost, pluginDefaultLocalAgentTool } from "./PluginDefaults.js";

vi.mock("../SessionTracker.js", () => ({
	updateConfigTransactional: vi.fn(),
}));

const mockUpdateConfig = vi.mocked(updateConfigTransactional);

/**
 * Stands in for the real critical section: hands `decide` the config the lock would
 * see and records the update it asked for. `onDisk` is what a fresh read under the
 * lock returns, which is deliberately separate from the snapshot a test passes to
 * `applyPluginInitLocalAgentTool` — that gap is the whole subject of the last case
 * in this file.
 */
function fakeConfigLock(onDisk: JolliMemoryConfig = {}): { readonly writes: Array<Partial<JolliMemoryConfig>> } {
	const writes: Array<Partial<JolliMemoryConfig>> = [];
	mockUpdateConfig.mockImplementation(async (decide) => {
		const { update, result } = decide(onDisk);
		if (update !== null) writes.push(update);
		return result;
	});
	return { writes };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("pluginDefaultLocalAgentTool", () => {
	it("maps each plugin host to the agent CLI it drives", () => {
		expect(pluginDefaultLocalAgentTool("claude-plugin")).toBe("claude-code");
		expect(pluginDefaultLocalAgentTool("codex-plugin")).toBe("codex");
	});

	it("returns undefined for non-plugin surfaces, which derive their own default", () => {
		for (const tag of ["cli", "vscode", "intellij", "cursor", "", "CLAUDE-PLUGIN"]) {
			expect(pluginDefaultLocalAgentTool(tag)).toBeUndefined();
		}
		expect(pluginDefaultLocalAgentTool(undefined)).toBeUndefined();
	});
});

describe("pluginBootstrapHost", () => {
	it("resolves each plugin tag to the host whose assets it may write", () => {
		expect(pluginBootstrapHost("claude-plugin")).toBe("claude");
		expect(pluginBootstrapHost("codex-plugin")).toBe("codex");
	});

	// Never undefined, unlike pluginDefaultLocalAgentTool: repo-hooks-only mode
	// predates the host split and its only shipped callers pass `claude-plugin`, so a
	// hand-run `jolli enable --repo-hooks-only` must keep getting Claude's assets.
	it("falls back to claude for an unmapped or missing tag", () => {
		for (const tag of ["cli", "vscode", "intellij", ""]) {
			expect(pluginBootstrapHost(tag)).toBe("claude");
		}
		expect(pluginBootstrapHost(undefined)).toBe("claude");
	});
});

describe("applyPluginInitLocalAgentTool", () => {
	it("seeds both fields when nothing is configured yet", async () => {
		const { writes } = fakeConfigLock({});
		const result = await applyPluginInitLocalAgentTool("codex-plugin", {});
		expect(result).toEqual({ tool: "codex", changedTool: true, previousTool: undefined, seededProvider: true });
		expect(writes).toEqual([{ aiProvider: "local-agent", localAgentTool: "codex" }]);
	});

	// The whole point of the explicit path: an automatic seed from the OTHER host
	// (or a stale hand-edit) must not survive an init run inside this one.
	it("overwrites a local agent tool another host had already seeded", async () => {
		const onDisk: JolliMemoryConfig = { aiProvider: "local-agent", localAgentTool: "claude-code" };
		const { writes } = fakeConfigLock(onDisk);
		const result = await applyPluginInitLocalAgentTool("codex-plugin", onDisk);
		// previousTool is what lets the caller tell the user WHAT was replaced.
		expect(result).toEqual({
			tool: "codex",
			changedTool: true,
			previousTool: "claude-code",
			seededProvider: false,
		});
		expect(writes).toEqual([{ localAgentTool: "codex" }]);
	});

	// aiProvider decides whose account pays, so it stays first-wins even here.
	it("never drags an explicit paid provider onto local-agent", async () => {
		for (const aiProvider of ["anthropic", "jolli"] as const) {
			const { writes } = fakeConfigLock({ aiProvider });
			const result = await applyPluginInitLocalAgentTool("claude-plugin", { aiProvider });
			expect(result).toEqual({
				tool: "claude-code",
				changedTool: true,
				previousTool: undefined,
				seededProvider: false,
			});
			expect(writes).toEqual([{ localAgentTool: "claude-code" }]);
		}
	});

	it("writes nothing when the host's tool is already the configured one", async () => {
		const { writes } = fakeConfigLock({ aiProvider: "local-agent", localAgentTool: "claude-code" });
		const result = await applyPluginInitLocalAgentTool("claude-plugin", {
			aiProvider: "local-agent",
			localAgentTool: "claude-code",
		});
		expect(result).toEqual({ tool: "claude-code", changedTool: false, seededProvider: false });
		expect(writes).toEqual([]);
		// Fast path: nothing was writable, so the lock was never taken.
		expect(mockUpdateConfig).not.toHaveBeenCalled();
	});

	it("returns null and writes nothing for a non-plugin source tag", async () => {
		fakeConfigLock({});
		expect(await applyPluginInitLocalAgentTool("cli", {})).toBeNull();
		expect(await applyPluginInitLocalAgentTool(undefined, {})).toBeNull();
		expect(mockUpdateConfig).not.toHaveBeenCalled();
	});

	// Unlike the session-start seed, init reports its own outcome — swallowing the
	// failure here would tell the user setup succeeded when nothing was recorded.
	it("propagates a config-write failure to the caller", async () => {
		mockUpdateConfig.mockRejectedValueOnce(new Error("disk full"));
		await expect(applyPluginInitLocalAgentTool("claude-plugin", {})).rejects.toThrow("disk full");
	});

	// The race this function is shaped to lose safely: the caller's snapshot was read
	// before the lock, and by the time we hold it another writer has chosen a paid
	// provider. Deciding from the snapshot would write `aiProvider: local-agent` over
	// that choice and report seededProvider: true; deciding under the lock writes only
	// the tool. `previousTool` likewise has to come from the locked read — reporting
	// the snapshot's value would name a tool the user never had.
	it("honours the state under the lock, not the caller's stale snapshot", async () => {
		const { writes } = fakeConfigLock({ aiProvider: "jolli", localAgentTool: "opencode" });
		const result = await applyPluginInitLocalAgentTool("codex-plugin", {});
		expect(result).toEqual({
			tool: "codex",
			changedTool: true,
			previousTool: "opencode",
			seededProvider: false,
		});
		expect(writes).toEqual([{ localAgentTool: "codex" }]);
	});
});
