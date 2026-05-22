/**
 * Tests for PagefindRunner — runs the Pagefind indexer against the built site output.
 *
 * Covers:
 *   - runPagefind runs `npx pagefind --site <site>` inside buildDir
 *   - runPagefind returns { success: true, output, pagesIndexed } on exit code 0
 *   - runPagefind parses the number of pages indexed from the output
 *   - runPagefind returns { success: false, output } on non-zero exit codes
 *   - stdout and stderr are combined into the output string
 *   - errors are returned (not thrown) on non-zero exit codes
 *   - missing stdout/stderr streams are handled gracefully
 *   - errors emitted by spawn (e.g. ENOENT) are surfaced as { success: false }
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockSpawn } = vi.hoisted(() => ({
	mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: mockSpawn,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FakeChildOptions {
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	hasStdout?: boolean;
	hasStderr?: boolean;
	error?: Error;
}

/**
 * Returns a stub ChildProcess that emits the configured stdout/stderr chunks
 * once a listener is attached, then either fires `error` (when `error` is
 * given) or `close` with the configured exit code. The microtask delay lets
 * `runPagefind` register its listeners before any events fire.
 */
function makeFakeChild(opts: FakeChildOptions = {}): EventEmitter & {
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
} {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter | null;
		stderr: EventEmitter | null;
	};
	child.stdout = opts.hasStdout === false ? null : new EventEmitter();
	child.stderr = opts.hasStderr === false ? null : new EventEmitter();

	queueMicrotask(() => {
		if (opts.stdout && child.stdout) {
			child.stdout.emit("data", Buffer.from(opts.stdout));
		}
		if (opts.stderr && child.stderr) {
			child.stderr.emit("data", Buffer.from(opts.stderr));
		}
		if (opts.error) {
			child.emit("error", opts.error);
			return;
		}
		child.emit("close", opts.exitCode ?? 0);
	});

	return child;
}

// ─── runPagefind ──────────────────────────────────────────────────────────────

describe("PagefindRunner.runPagefind", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls spawn with npx pagefind and the correct cwd", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, stdout: "Indexed 10 pages" }));

		await runPagefind("/my/build/dir");

		const call = mockSpawn.mock.calls[0];
		const invocation = `${call[0]} ${(call[1] ?? []).join(" ")}`;
		expect(invocation).toContain("npx");
		expect(invocation).toContain("pagefind");
		expect(call[2]).toEqual(expect.objectContaining({ cwd: "/my/build/dir", stdio: "pipe" }));
	});

	it("forwards custom site and outputPath as CLI args", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, stdout: "Indexed 3 pages" }));

		await runPagefind("/build", ".next-pagefind/server/app", "public/_pagefind");

		const call = mockSpawn.mock.calls[0];
		const invocation = `${call[0]} ${(call[1] ?? []).join(" ")}`;
		expect(invocation).toContain("--site .next-pagefind/server/app");
		expect(invocation).toContain("--output-path public/_pagefind");
	});

	it("returns { success: true } when pagefind exits with code 0", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, stdout: "Indexed 5 pages" }));

		const result = await runPagefind("/build/dir");
		expect(result.success).toBe(true);
	});

	it("returns { success: false } when pagefind exits with non-zero code", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 1, stderr: "Error: site not found" }));

		const result = await runPagefind("/build/dir");
		expect(result.success).toBe(false);
	});

	it("parses pagesIndexed from output matching 'Indexed N pages'", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, stdout: "Indexed 42 pages" }));

		const result = await runPagefind("/build/dir");
		expect(result.pagesIndexed).toBe(42);
	});

	it("parses pagesIndexed from output matching 'Found N pages'", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, stdout: "Found 7 pages in the site" }));

		const result = await runPagefind("/build/dir");
		expect(result.pagesIndexed).toBe(7);
	});

	it("parses pagesIndexed from output matching singular 'page'", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, stdout: "Indexed 1 page" }));

		const result = await runPagefind("/build/dir");
		expect(result.pagesIndexed).toBe(1);
	});

	it("returns pagesIndexed as undefined when output has no page count", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, stdout: "Build complete" }));

		const result = await runPagefind("/build/dir");
		expect(result.pagesIndexed).toBeUndefined();
	});

	it("does not include pagesIndexed on failure", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 1, stderr: "fatal error" }));

		const result = await runPagefind("/build/dir");
		expect(result.pagesIndexed).toBeUndefined();
	});

	it("includes stdout in output on success", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, stdout: "Indexed 3 pages" }));

		const result = await runPagefind("/build/dir");
		expect(result.output).toContain("Indexed 3 pages");
	});

	it("includes stderr in output on failure", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 1, stderr: "Error: out/ not found" }));

		const result = await runPagefind("/build/dir");
		expect(result.output).toContain("Error: out/ not found");
	});

	it("combines stdout and stderr into output", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 1, stdout: "partial stdout", stderr: "error details" }));

		const result = await runPagefind("/build/dir");
		expect(result.output).toContain("partial stdout");
		expect(result.output).toContain("error details");
	});

	it("does not throw on non-zero exit code", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 1, stderr: "fatal error" }));

		await expect(runPagefind("/build/dir")).resolves.toEqual(expect.objectContaining({ success: false }));
	});

	it("handles missing stdout and stderr streams gracefully", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, hasStdout: false, hasStderr: false }));

		const result = await runPagefind("/build/dir");
		expect(result.success).toBe(true);
		expect(result.output).toBe("");
		expect(result.pagesIndexed).toBeUndefined();
	});

	it("returns { success: false } when spawn emits an error (e.g. ENOENT)", async () => {
		const { runPagefind } = await import("./PagefindRunner.js");
		mockSpawn.mockReturnValue(makeFakeChild({ error: new Error("spawn ENOENT") }));

		const result = await runPagefind("/build/dir");
		expect(result.success).toBe(false);
		expect(result.output).toContain("spawn ENOENT");
	});
});
