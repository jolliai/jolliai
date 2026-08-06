/**
 * Separate file from AgentReentry.test.ts on purpose: that suite exercises the
 * guard against a REAL temp tree (which is the point — the sentinel is an fs
 * fact), and `vi.mock("node:fs")` is module-scoped, so the two cannot coexist.
 *
 * What is covered here is the one branch a real filesystem will not produce on
 * demand: `mkdtempSync` succeeding and the sentinel write then failing.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	mkdtempSync: vi.fn(),
	writeFileSync: vi.fn(),
	rmSync: vi.fn(),
	existsSync: vi.fn(() => false),
}));

vi.mock("node:fs", () => mocks);

import { createLocalAgentCwd } from "./AgentReentry.js";

describe("createLocalAgentCwd cleanup", () => {
	it("removes the freshly-created dir when the sentinel write fails, and rethrows unchanged", () => {
		const dir = "/tmp/jolli-localagent-abc123";
		mocks.mkdtempSync.mockReturnValue(dir);
		const failure = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		mocks.writeFileSync.mockImplementation(() => {
			throw failure;
		});

		// Rethrown identically: LlmClient classifies local-agent failures by error
		// class, so wrapping here would change how the caller reports this one.
		expect(() => createLocalAgentCwd()).toThrow(failure);
		expect(mocks.rmSync).toHaveBeenCalledWith(dir, { recursive: true, force: true });
	});

	it("leaves the dir in place on success", () => {
		const dir = "/tmp/jolli-localagent-def456";
		mocks.mkdtempSync.mockReturnValue(dir);
		mocks.writeFileSync.mockImplementation(() => undefined);
		mocks.rmSync.mockClear();

		expect(createLocalAgentCwd()).toBe(dir);
		expect(mocks.rmSync).not.toHaveBeenCalled();
	});
});
