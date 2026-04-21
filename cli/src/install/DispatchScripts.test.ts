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
