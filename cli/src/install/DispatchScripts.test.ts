import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir };
});

import { installHookScripts } from "./DispatchScripts.js";

describe("installHookScripts", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jolli-dispatch-test-"));
		mockHomedir.mockReturnValue(tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("should write all three dispatch scripts", async () => {
		const result = await installHookScripts();
		expect(result).toBe(true);

		const globalDir = join(tempDir, ".jolli", "jollimemory");
		const resolveDistPath = await readFile(join(globalDir, "resolve-dist-path"), "utf-8");
		expect(resolveDistPath).toContain("#!/bin/bash");
		expect(resolveDistPath).toContain("dist-paths");

		const runHook = await readFile(join(globalDir, "run-hook"), "utf-8");
		expect(runHook).toContain("HOOK_TYPE");
		expect(runHook).toContain("post-commit");
	});

	// Regression: every git/agent hook the installer wires up must have a matching
	// dispatch arm, or `run-hook <type>` falls through to the `*)` error arm and the
	// hook silently never runs. post-merge was added without its dispatch arm.
	it("should have a dispatch arm execing the right entry for every hook type", async () => {
		await installHookScripts();
		const globalDir = join(tempDir, ".jolli", "jollimemory");
		const runHook = await readFile(join(globalDir, "run-hook"), "utf-8");

		const expected: Record<string, string> = {
			"post-commit": "PostCommitHook.js",
			"post-merge": "PostMergeHook.js",
			"post-rewrite": "PostRewriteHook.js",
			"prepare-commit-msg": "PrepareMsgHook.js",
			stop: "StopHook.js",
			"session-start": "SessionStartHook.js",
			"gemini-after-agent": "GeminiAfterAgentHook.js",
		};
		for (const [hookType, entry] of Object.entries(expected)) {
			const arm = new RegExp(
				`${hookType.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\)\\s+exec node "\\$DIST/${entry}"`,
			);
			expect(runHook, `missing dispatch arm for ${hookType} → ${entry}`).toMatch(arm);
		}

		const runCli = await readFile(join(globalDir, "run-cli"), "utf-8");
		expect(runCli).toContain("Cli.js");
	});

	it("should be idempotent (safe to call twice)", async () => {
		const first = await installHookScripts();
		const second = await installHookScripts();
		expect(first).toBe(true);
		expect(second).toBe(true);
	});

	it("should return false when directory creation fails", async () => {
		// Point homedir to a path that cannot be created (file exists where dir is expected)
		const blockingFile = join(tempDir, ".jolli");
		await writeFile(blockingFile, "blocking", "utf-8");

		const result = await installHookScripts();
		expect(result).toBe(false);
	});
});
