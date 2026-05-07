/**
 * Tests for PagefindRunner — runs the Pagefind indexer against the built site output.
 *
 * Covers all acceptance criteria from Task 9:
 *   - runPagefind runs `npx pagefind --site out/` inside buildDir
 *   - runPagefind returns { success: true, output, pagesIndexed } on exit code 0
 *   - runPagefind parses the number of pages indexed from the output
 *   - runPagefind returns { success: false, output } on non-zero exit codes
 *   - stdout and stderr are combined into the output string
 *   - errors are returned (not thrown) on non-zero exit codes
 *   - null stdout/stderr are handled gracefully
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockSpawnSync } = vi.hoisted(() => ({
	mockSpawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: mockSpawnSync,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a mock spawnSync result with the given exit code and output. */
function makeSpawnResult(status: number, stdout = "", stderr = "") {
	return {
		status,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
		pid: 1234,
		output: [],
		signal: null,
	};
}

// ─── runPagefind ──────────────────────────────────────────────────────────────

describe("PagefindRunner.runPagefind", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls spawnSync with npx pagefind --site out/ and the correct cwd", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0, "Indexed 10 pages"));

		await runPagefind("/my/build/dir");

		const call = mockSpawnSync.mock.calls[0];
		const invocation = `${call[0]} ${(call[1] ?? []).join(" ")}`;
		expect(invocation).toContain("npx");
		expect(invocation).toContain("pagefind");
		expect(call[2]).toEqual(expect.objectContaining({ cwd: "/my/build/dir", stdio: "pipe" }));
	});

	it("returns { success: true } when pagefind exits with code 0", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0, "Indexed 5 pages"));

		const result = await runPagefind("/build/dir");

		expect(result.success).toBe(true);
	});

	it("returns { success: false } when pagefind exits with non-zero code", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(1, "", "Error: site not found"));

		const result = await runPagefind("/build/dir");

		expect(result.success).toBe(false);
	});

	it("parses pagesIndexed from output matching 'Indexed N pages'", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0, "Indexed 42 pages"));

		const result = await runPagefind("/build/dir");

		expect(result.pagesIndexed).toBe(42);
	});

	it("parses pagesIndexed from output matching 'Found N pages'", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0, "Found 7 pages in the site"));

		const result = await runPagefind("/build/dir");

		expect(result.pagesIndexed).toBe(7);
	});

	it("parses pagesIndexed from output matching singular 'page'", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0, "Indexed 1 page"));

		const result = await runPagefind("/build/dir");

		expect(result.pagesIndexed).toBe(1);
	});

	it("returns pagesIndexed as undefined when output has no page count", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0, "Build complete"));

		const result = await runPagefind("/build/dir");

		expect(result.pagesIndexed).toBeUndefined();
	});

	it("does not include pagesIndexed on failure", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(1, "", "fatal error"));

		const result = await runPagefind("/build/dir");

		expect(result.pagesIndexed).toBeUndefined();
	});

	it("includes stdout in output on success", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0, "Indexed 3 pages", ""));

		const result = await runPagefind("/build/dir");

		expect(result.output).toContain("Indexed 3 pages");
	});

	it("includes stderr in output on failure", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(1, "", "Error: out/ not found"));

		const result = await runPagefind("/build/dir");

		expect(result.output).toContain("Error: out/ not found");
	});

	it("combines stdout and stderr into output", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(1, "partial stdout", "error details"));

		const result = await runPagefind("/build/dir");

		expect(result.output).toContain("partial stdout");
		expect(result.output).toContain("error details");
	});

	it("does not throw on non-zero exit code", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(1, "", "fatal error"));

		expect(() => runPagefind("/build/dir")).not.toThrow();
	});

	it("handles null stdout and stderr gracefully", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawnSync.mockReturnValue({
			status: 0,
			stdout: null,
			stderr: null,
			pid: 1234,
			output: [],
			signal: null,
		});

		const result = await runPagefind("/build/dir");

		expect(result.success).toBe(true);
		expect(result.output).toBe("");
		expect(result.pagesIndexed).toBeUndefined();
	});
});
