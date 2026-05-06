/**
 * Tests for OutputFilter — filters child process output for user-friendly display.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("OutputFilter", () => {
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── Verbose mode ────────────────────────────────────────────────────────

	it("passes all output through in verbose mode", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(true);

		filter.write("Some random output\n");

		expect(stdoutSpy).toHaveBeenCalledWith("Some random output\n");
	});

	it("shows suppressed patterns in verbose mode", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(true);

		filter.write("npm warn some warning\n");

		expect(stdoutSpy).toHaveBeenCalled();
	});

	// ── Non-verbose: suppression ────────────────────────────────────────────

	it("suppresses TypeScript detection messages", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("We detected TypeScript in your project\n");

		const allCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(allCalls.some((c: string) => c.includes("TypeScript"))).toBe(false);
	});

	it("suppresses npm warn messages", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("npm warn deprecated some-package@1.0.0\n");

		const allCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(allCalls.some((c: string) => c.includes("npm warn"))).toBe(false);
	});

	it("suppresses webpack hot-update messages", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("webpack 5.90.0 compiled, hot-update.js chunk\n");

		const allCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(allCalls.some((c: string) => c.includes("hot-update"))).toBe(false);
	});

	it("suppresses Next.js version banner", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("Next.js 14.2.3\n");

		const allCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(allCalls.some((c: string) => c.includes("Next.js"))).toBe(false);
	});

	it("suppresses Ready in messages", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("Ready in 3.2s\n");

		const allCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(allCalls.some((c: string) => c.includes("Ready in"))).toBe(false);
	});

	it("suppresses empty lines", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("\n\n  \n");

		const allCalls = [...stdoutSpy.mock.calls, ...stderrSpy.mock.calls];
		expect(allCalls).toHaveLength(0);
	});

	it("suppresses Compiling messages", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("Compiling /page ...\n");

		const allCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(allCalls.some((c: string) => c.includes("Compiling"))).toBe(false);
	});

	it("suppresses npm audit messages", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("Run `npm audit` for details.\n");

		const allCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(allCalls.some((c: string) => c.includes("npm audit"))).toBe(false);
	});

	it("suppresses node_modules lines", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("  node_modules/some-package/index.js\n");

		const allCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(allCalls.some((c: string) => c.includes("node_modules"))).toBe(false);
	});

	it("suppresses nextra git warnings", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("warn  nextra  Init git repository failed\n");

		const allCalls = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(allCalls.some((c: string) => c.includes("nextra"))).toBe(false);
	});

	// ── Non-verbose: error pass-through ─────────────────────────────────────

	it("shows error lines with ⨯ prefix", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("⨯ something went wrong\n");

		expect(stderrSpy).toHaveBeenCalled();
		const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(output).toContain("something went wrong");
	});

	it("shows Module not found errors", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("Module not found: Can't resolve '@theme/Tabs'\n");

		expect(stderrSpy).toHaveBeenCalled();
		const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(output).toContain("Module not found");
	});

	it("shows Build error messages", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("Build error occurred\n");

		expect(stderrSpy).toHaveBeenCalled();
	});

	it("shows Failed to compile messages", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("Failed to compile\n");

		expect(stderrSpy).toHaveBeenCalled();
	});

	it("shows Error: messages", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("Error: Something bad happened\n");

		expect(stderrSpy).toHaveBeenCalled();
	});

	it("shows 500 HTTP errors", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("GET /api/test 500 in 123ms\n");

		expect(stderrSpy).toHaveBeenCalled();
	});

	// ── URL extraction ──────────────────────────────────────────────────────

	it("extracts localhost URL and prints it immediately", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("- Local: http://localhost:3000\n");

		expect(filter.getUrl()).toBe("http://localhost:3000");
		const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(output).toContain("http://localhost:3000");
	});

	it("returns undefined from getUrl when no URL seen", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("Some text without URLs\n");

		expect(filter.getUrl()).toBeUndefined();
	});

	it("extracts URL only once (first seen)", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("http://localhost:3000\n");
		filter.write("http://localhost:4000\n");

		expect(filter.getUrl()).toBe("http://localhost:3000");
	});

	it("extracts URL in verbose mode without extra message", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(true);

		filter.write("- Local: http://localhost:3000\n");

		expect(filter.getUrl()).toBe("http://localhost:3000");
		// In verbose mode, should NOT print the extra "Server running at" message
		const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(output).not.toContain("Server running at");
	});

	// ── ANSI escape codes ───────────────────────────────────────────────────

	it("strips ANSI escape codes before processing", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		// Error with ANSI codes
		filter.write("\x1b[31m⨯ error here\x1b[0m\n");

		expect(stderrSpy).toHaveBeenCalled();
		const output = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(output).toContain("error here");
	});

	// ── write return value ──────────────────────────────────────────────────

	it("always returns true from write", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		expect(filter.write("anything")).toBe(true);
	});

	// ── Multi-line input ────────────────────────────────────────────────────

	it("processes multiple lines from a single write call", async () => {
		const { createOutputFilter } = await import("./OutputFilter.js");
		const filter = createOutputFilter(false);

		filter.write("⨯ error one\nReady in 3s\n⨯ error two\n");

		const errorOutput = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(errorOutput).toContain("error one");
		expect(errorOutput).toContain("error two");
	});
});
