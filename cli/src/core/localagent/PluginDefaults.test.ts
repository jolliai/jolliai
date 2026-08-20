import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../../Types.js";
import { updateConfigTransactional } from "../SessionTracker.js";
import {
	applyPluginInitLocalAgentTool,
	pluginBootstrapAgent,
	pluginBootstrapHost,
	pluginDefaultLocalAgentTool,
	pluginSkillInvocation,
} from "./PluginDefaults.js";

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
		// The Cursor IDE is not a headless backend; `cursor-agent` is the CLI that
		// shares its login and can actually be driven to generate a summary.
		expect(pluginDefaultLocalAgentTool("cursor-plugin")).toBe("cursor-agent");
	});

	// `"cursor"` is in this list on purpose and is NOT a typo for `"cursor-plugin"`:
	// it is the IntelliJ/VS Code install source tag for the Cursor editor, which
	// derives its own provider default and must not be seeded from this table.
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
		expect(pluginBootstrapHost("cursor-plugin")).toBe("cursor");
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

describe("pluginBootstrapAgent", () => {
	it("resolves each plugin tag to the same host token", () => {
		expect(pluginBootstrapAgent("claude-plugin")).toBe("claude");
		expect(pluginBootstrapAgent("codex-plugin")).toBe("codex");
		expect(pluginBootstrapAgent("cursor-plugin")).toBe("cursor");
	});

	// The one difference from pluginBootstrapHost, and the reason both exist. There
	// the claude fallback is right — a hand-run --repo-hooks-only must still get
	// Claude's assets. Here it would be a lie: that run proves nothing about which
	// host the user is typing into, and telemetry omits an unknown host rather than
	// guessing one. Reusing pluginBootstrapHost would tag every bare run as claude.
	it("answers undefined for an unmapped or missing tag instead of falling back to claude", () => {
		for (const tag of ["cli", "vscode", "intellij", ""]) {
			expect(pluginBootstrapAgent(tag)).toBeUndefined();
			expect(pluginBootstrapHost(tag)).toBe("claude");
		}
		expect(pluginBootstrapAgent(undefined)).toBeUndefined();
	});
});

/*
 * The three hosts name the same skill three different ways, and none of the forms is
 * derivable from the others: Claude and Codex both namespace a plugin's skills as
 * `jolli:<name>` and differ only in their sigil, while Cursor namespaces nothing, so
 * the prefix lives in the bundle's directory name.
 *
 * This exists because the two callers used to spell that out as a hardcoded ladder,
 * and both ladders stopped at two hosts when the third shipped — leaving a Cursor user
 * with no login reminder at all and a recall hint naming the bare CLI. Both failures
 * were silent.
 */
describe("pluginSkillInvocation", () => {
	it("renders each host's own invocation form", () => {
		expect(pluginSkillInvocation("claude-plugin", "init")).toBe("/jolli:init");
		expect(pluginSkillInvocation("codex-plugin", "init")).toBe("$jolli:init");
		expect(pluginSkillInvocation("cursor-plugin", "init")).toBe("/jolli-init");
	});

	it("substitutes the skill name rather than hardcoding one", () => {
		expect(pluginSkillInvocation("claude-plugin", "recall")).toBe("/jolli:recall");
		expect(pluginSkillInvocation("cursor-plugin", "remote-run")).toBe("/jolli-remote-run");
	});

	// Undefined is the meaningful answer, not a miss: these surfaces ship no bundled
	// skills, so a caller must fall back to naming the CLI command instead of inventing
	// a slash form that resolves to nothing.
	it("returns undefined for surfaces with no bundled skills", () => {
		for (const tag of ["cli", "vscode", "intellij", "cursor", "shared", ""]) {
			expect(pluginSkillInvocation(tag, "init")).toBeUndefined();
		}
		expect(pluginSkillInvocation(undefined, "init")).toBeUndefined();
	});
});

describe("applyPluginInitLocalAgentTool", () => {
	it("seeds both fields when nothing is configured yet", async () => {
		const { writes } = fakeConfigLock({});
		const result = await applyPluginInitLocalAgentTool("codex-plugin", {});
		expect(result).toEqual({ tool: "codex", seededTool: true, keptTool: undefined, seededProvider: true });
		expect(writes).toEqual([{ aiProvider: "local-agent", localAgentTool: "codex" }]);
	});

	// The rule this function exists to hold: initializing inside a host does not
	// re-decide which agent generates memories. Measured the other way round first —
	// a Cursor user configured on `codex` ran the front door and was silently moved
	// to `cursor-agent`, per repository.
	it("keeps a local agent tool the config already holds", async () => {
		const onDisk: JolliMemoryConfig = { aiProvider: "local-agent", localAgentTool: "claude-code" };
		const { writes } = fakeConfigLock(onDisk);
		const result = await applyPluginInitLocalAgentTool("codex-plugin", onDisk);
		// keptTool is what lets the caller record WHOSE CLI now generates this host's
		// memories — a fact no other line of the install output carries.
		expect(result).toEqual({
			tool: "codex",
			seededTool: false,
			keptTool: "claude-code",
			seededProvider: false,
		});
		expect(writes).toEqual([]);
	});

	// aiProvider decides whose account pays, so it stays first-wins too.
	it("never drags an explicit paid provider onto local-agent", async () => {
		for (const aiProvider of ["anthropic", "jolli"] as const) {
			const { writes } = fakeConfigLock({ aiProvider });
			const result = await applyPluginInitLocalAgentTool("claude-plugin", { aiProvider });
			expect(result).toEqual({
				tool: "claude-code",
				seededTool: true,
				keptTool: undefined,
				seededProvider: false,
			});
			expect(writes).toEqual([{ localAgentTool: "claude-code" }]);
		}
	});

	// The inverse pairing, and the one the overwrite used to hide: seeding the
	// provider must not drag the tool with it. The user picked `opencode`; turning
	// generation on for them means turning on THAT tool, not this host's.
	it("seeds a missing provider without touching a tool that is already set", async () => {
		const { writes } = fakeConfigLock({ localAgentTool: "opencode" });
		const result = await applyPluginInitLocalAgentTool("cursor-plugin", { localAgentTool: "opencode" });
		expect(result).toEqual({
			tool: "cursor-agent",
			seededTool: false,
			keptTool: "opencode",
			seededProvider: true,
		});
		expect(writes).toEqual([{ aiProvider: "local-agent" }]);
	});

	it("writes nothing when the host's tool is already the configured one", async () => {
		const { writes } = fakeConfigLock({ aiProvider: "local-agent", localAgentTool: "claude-code" });
		const result = await applyPluginInitLocalAgentTool("claude-plugin", {
			aiProvider: "local-agent",
			localAgentTool: "claude-code",
		});
		expect(result).toEqual({ tool: "claude-code", seededTool: false, keptTool: undefined, seededProvider: false });
		expect(writes).toEqual([]);
		// Fast path: nothing was writable, so the lock was never taken.
		expect(mockUpdateConfig).not.toHaveBeenCalled();
	});

	// Same fast path, different config: both fields hold a value, so first-wins can
	// write neither — including the case where the held tool is another host's.
	it("skips the lock when both fields are set, even under a foreign tool", async () => {
		const onDisk: JolliMemoryConfig = { aiProvider: "jolli", localAgentTool: "kimi" };
		fakeConfigLock(onDisk);
		const result = await applyPluginInitLocalAgentTool("cursor-plugin", onDisk);
		expect(result).toEqual({
			tool: "cursor-agent",
			seededTool: false,
			keptTool: "kimi",
			seededProvider: false,
		});
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
	// before the lock, and by the time we hold it another writer has chosen both a
	// paid provider and a tool. Deciding from the snapshot would write
	// `aiProvider: local-agent` over that choice and overwrite the tool it never saw;
	// deciding under the lock writes nothing at all. `keptTool` likewise has to come
	// from the locked read — the snapshot's value would name a tool the user never had.
	it("honours the state under the lock, not the caller's stale snapshot", async () => {
		const { writes } = fakeConfigLock({ aiProvider: "jolli", localAgentTool: "opencode" });
		const result = await applyPluginInitLocalAgentTool("codex-plugin", {});
		expect(result).toEqual({
			tool: "codex",
			seededTool: false,
			keptTool: "opencode",
			seededProvider: false,
		});
		expect(writes).toEqual([]);
	});
});
