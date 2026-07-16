import { describe, expect, it, vi } from "vitest";
import { getBackend, registerBackend } from "./BackendRegistry.js";
import type { LocalAgentBackend } from "./Types.js";

const fake: LocalAgentBackend = {
	id: "fake-tool",
	discoverExecutable: async () => ({ file: "/x/claude", version: "9.9.9" }),
	buildInvocation: () => ({ file: "/x/claude", args: [], stdin: "", env: {}, cwd: "/tmp" }),
	parseResult: () => ({ text: "", inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, stopReason: null }),
};

describe("BackendRegistry", () => {
	it("returns a registered backend by id", () => {
		registerBackend(fake);
		expect(getBackend("fake-tool")).toBe(fake);
	});

	it("throws a setup error for an unknown tool id", () => {
		expect(() => getBackend("nope")).toThrowError(/unknown local agent tool/i);
	});

	it("lists (none registered) when the registry is empty", async () => {
		vi.resetModules();
		const fresh = await import("./BackendRegistry.js");
		expect(() => fresh.getBackend("nope")).toThrowError(/none registered/);
	});
});
