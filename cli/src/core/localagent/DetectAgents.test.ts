import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../../Types.js";
import * as registry from "./BackendRegistry.js";
import { isLocalAgentUsable, listPresentLocalAgents, localAgentOverrideFrom } from "./DetectAgents.js";
import { LocalAgentSetupError } from "./Types.js";

/** Records every `overridePath` each backend method was handed. */
let seenPresence: Record<string, string | undefined>;
let seenDiscover: Record<string, string | undefined>;

/** Builds a fake backend whose presence and probe results are scripted. */
function fake(id: string, present: boolean, usable = true) {
	return {
		id,
		isPresent: (overridePath?: string) => {
			seenPresence[id] = overridePath;
			return present;
		},
		discoverExecutable: (overridePath?: string) => {
			seenDiscover[id] = overridePath;
			return usable
				? Promise.resolve({ file: `/bin/${id}`, version: "1.0.0" })
				: Promise.reject(new LocalAgentSetupError(`No compatible ${id}`));
		},
		buildInvocation: () => {
			throw new Error("not used");
		},
		parseResult: () => {
			throw new Error("not used");
		},
	};
}

function stub(map: Record<string, boolean>) {
	vi.spyOn(registry, "getBackend").mockImplementation((id: string) => fake(id, map[id] ?? false) as never);
}

beforeEach(() => {
	seenPresence = {};
	seenDiscover = {};
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("listPresentLocalAgents", () => {
	it("returns all present tools in LOCAL_AGENT_TOOLS order when all are present", () => {
		stub({ "claude-code": true, codex: true, "cursor-agent": true, opencode: true, kimi: true });
		expect(listPresentLocalAgents().map((a) => a.id)).toEqual([
			"claude-code",
			"codex",
			"cursor-agent",
			"opencode",
			"kimi",
		]);
	});

	it("uses LOCAL_AGENT_TOOLS order, NOT BackendRegistry order", () => {
		// BuiltinBackends registers Claude, Cursor, Codex, OpenCode, Kimi. If this
		// ever starts reading the registry, Cursor would precede Codex and this fails.
		stub({ "claude-code": true, codex: true, "cursor-agent": true, opencode: true, kimi: true });
		const ids = listPresentLocalAgents().map((a) => a.id);
		expect(ids.indexOf("codex")).toBeLessThan(ids.indexOf("cursor-agent"));
	});

	it("returns only the present tools", () => {
		stub({ "claude-code": false, codex: true, "cursor-agent": false, opencode: true });
		expect(listPresentLocalAgents().map((a) => a.id)).toEqual(["codex", "opencode"]);
	});

	it("returns an empty array when nothing is present", () => {
		stub({});
		expect(listPresentLocalAgents()).toEqual([]);
	});

	it("carries the display label from LOCAL_AGENT_TOOLS", () => {
		stub({ "claude-code": true });
		expect(listPresentLocalAgents()[0]).toEqual({ id: "claude-code", label: "Claude Code" });
	});

	it("treats a throwing backend as absent rather than failing the sweep", () => {
		vi.spyOn(registry, "getBackend").mockImplementation((id: string) => {
			if (id === "codex") throw new Error("registry exploded");
			return fake(id, true) as never;
		});
		expect(listPresentLocalAgents().map((a) => a.id)).toEqual(["claude-code", "cursor-agent", "opencode", "kimi"]);
	});

	/**
	 * An override is a path for ONE tool. Handing it to the whole sweep as a bare
	 * string used to short-circuit each backend's enumeration to that verbatim
	 * path, so a Codex path reported Claude Code, Cursor and OpenCode installed
	 * too — and each was then probed at Codex's binary.
	 */
	it("hands the override path ONLY to the tool it names", () => {
		stub({ "claude-code": true, codex: true, "cursor-agent": true, opencode: true });

		listPresentLocalAgents({ tool: "codex", path: "/custom/bin/codex" });

		expect(seenPresence).toEqual({
			"claude-code": undefined,
			codex: "/custom/bin/codex",
			"cursor-agent": undefined,
			opencode: undefined,
		});
	});

	it("passes no override to any tool when none is configured", () => {
		stub({ "claude-code": true, codex: true });
		listPresentLocalAgents();
		expect(Object.values(seenPresence).every((v) => v === undefined)).toBe(true);
	});
});

describe("localAgentOverrideFrom", () => {
	const cfg = (c: Partial<JolliMemoryConfig>) => c as JolliMemoryConfig;

	it("is undefined when no explicit path is configured", () => {
		expect(localAgentOverrideFrom(cfg({ localAgentTool: "codex" }))).toBeUndefined();
	});

	it("binds the path to the configured tool", () => {
		expect(localAgentOverrideFrom(cfg({ localAgentTool: "codex", localAgentPath: "/p" }))).toEqual({
			tool: "codex",
			path: "/p",
		});
	});

	it("defaults an absent localAgentTool to claude-code, matching every other reader", () => {
		expect(localAgentOverrideFrom(cfg({ localAgentPath: "/p" }))).toEqual({
			tool: "claude-code",
			path: "/p",
		});
	});
});

describe("isLocalAgentUsable", () => {
	it("is true when the tool resolves", async () => {
		vi.spyOn(registry, "getBackend").mockImplementation((id: string) => fake(id, true, true) as never);
		await expect(isLocalAgentUsable("codex")).resolves.toBe(true);
	});

	it("is false when the tool fails to resolve", async () => {
		vi.spyOn(registry, "getBackend").mockImplementation((id: string) => fake(id, true, false) as never);
		await expect(isLocalAgentUsable("codex")).resolves.toBe(false);
	});

	it("is false for an unknown tool id rather than throwing", async () => {
		vi.spyOn(registry, "getBackend").mockImplementation(() => {
			throw new LocalAgentSetupError("Unknown local agent tool");
		});
		await expect(isLocalAgentUsable("codex")).resolves.toBe(false);
	});

	it("applies an override that names the probed tool", async () => {
		vi.spyOn(registry, "getBackend").mockImplementation((id: string) => fake(id, true, true) as never);
		await isLocalAgentUsable("codex", { override: { tool: "codex", path: "/custom/codex" } });
		expect(seenDiscover.codex).toBe("/custom/codex");
	});

	it("drops an override that names a DIFFERENT tool, falling back to auto-discovery", async () => {
		// Probing Cursor with the path the user configured for Codex would answer a
		// question nobody asked — and, since an override short-circuits discovery,
		// answer it wrongly in both directions.
		vi.spyOn(registry, "getBackend").mockImplementation((id: string) => fake(id, true, true) as never);
		await isLocalAgentUsable("cursor-agent", { override: { tool: "codex", path: "/custom/codex" } });
		expect(seenDiscover["cursor-agent"]).toBeUndefined();
	});
});
