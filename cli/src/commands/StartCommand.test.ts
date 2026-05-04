/**
 * Tests for StartCommand — registers `jolli start` and `jolli dev` commands.
 *
 * Covers:
 *   - Source_Root does not exist: prints error and sets exitCode = 1
 *   - site.json parse error: prints error and sets exitCode = 1
 *   - No markdown or OpenAPI files: prints warning and continues
 *   - npm install failure: prints error output and sets exitCode = 1
 *   - jolli start: build + pagefind + serve
 *   - jolli dev: dev server with hot reload
 *   - Skips npm install when node_modules already exists
 *   - Defaults source-root to process.cwd() when not provided
 */

import { resolve } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuildDir } from "./StartCommand.js";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────

const {
	mockExistsSync,
	mockReadSiteJson,
	mockInitNextraProject,
	mockMirrorContent,
	mockGenerateMetaFiles,
	mockRenderOpenApiFiles,
	mockNeedsInstall,
	mockRunNpmInstall,
	mockRunNpmBuild,
	mockRunNpmDev,
	mockRunPagefind,
	mockRunServe,
} = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockReadSiteJson: vi.fn(),
	mockInitNextraProject: vi.fn(),
	mockMirrorContent: vi.fn(),
	mockGenerateMetaFiles: vi.fn(),
	mockRenderOpenApiFiles: vi.fn(),
	mockNeedsInstall: vi.fn(),
	mockRunNpmInstall: vi.fn(),
	mockRunNpmBuild: vi.fn(),
	mockRunNpmDev: vi.fn(),
	mockRunPagefind: vi.fn(),
	mockRunServe: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: mockExistsSync,
}));

vi.mock("../site/SiteJsonReader.js", () => ({
	readSiteJson: mockReadSiteJson,
}));

vi.mock("../site/NextraProjectWriter.js", () => ({
	initNextraProject: mockInitNextraProject,
}));

vi.mock("../site/ContentMirror.js", () => ({
	clearDir: vi.fn(),
	mirrorContent: mockMirrorContent,
}));

vi.mock("../site/MetaGenerator.js", () => ({
	generateMetaFiles: mockGenerateMetaFiles,
}));

vi.mock("../site/OpenApiRenderer.js", () => ({
	renderOpenApiFiles: mockRenderOpenApiFiles,
}));

vi.mock("../site/NpmRunner.js", () => ({
	needsInstall: mockNeedsInstall,
	runNpmInstall: mockRunNpmInstall,
	runNpmBuild: mockRunNpmBuild,
	runNpmDev: mockRunNpmDev,
	runServe: mockRunServe,
}));

vi.mock("../site/PagefindRunner.js", () => ({
	runPagefind: mockRunPagefind,
}));

// ─── Default mock values ──────────────────────────────────────────────────────

const DEFAULT_SITE_JSON_RESULT = {
	config: { title: "Test Site", description: "A test site", nav: [] },
	usedDefault: false,
};

const DEFAULT_MIRROR_RESULT = {
	markdownFiles: ["index.md"],
	openapiFiles: [],
	imageFiles: [],
	ignoredFiles: [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeProgram(): Promise<Command> {
	const { registerStartCommand, registerBuildCommand, registerDevCommand } = await import("./StartCommand.js");
	const program = new Command();
	program.exitOverride();
	registerStartCommand(program);
	registerBuildCommand(program);
	registerDevCommand(program);
	return program;
}

function setupSuccessfulRun(
	overrides: { needsInstall?: boolean; markdownFiles?: string[]; openapiFiles?: string[] } = {},
): void {
	mockExistsSync.mockReturnValue(true);
	mockReadSiteJson.mockResolvedValue(DEFAULT_SITE_JSON_RESULT);
	mockInitNextraProject.mockResolvedValue({ isNew: false });
	mockMirrorContent.mockResolvedValue({
		...DEFAULT_MIRROR_RESULT,
		markdownFiles: overrides.markdownFiles ?? DEFAULT_MIRROR_RESULT.markdownFiles,
		openapiFiles: overrides.openapiFiles ?? DEFAULT_MIRROR_RESULT.openapiFiles,
	});
	mockGenerateMetaFiles.mockResolvedValue(undefined);
	mockRenderOpenApiFiles.mockResolvedValue(undefined);
	mockNeedsInstall.mockReturnValue(overrides.needsInstall ?? false);
	mockRunNpmInstall.mockResolvedValue({ success: true, output: "" });
	mockRunNpmBuild.mockResolvedValue({ success: true, output: "" });
	mockRunNpmDev.mockResolvedValue({ success: true, output: "" });
	mockRunPagefind.mockResolvedValue({ success: true, output: "Indexed 5 pages", pagesIndexed: 5 });
	mockRunServe.mockResolvedValue({ success: true, output: "" });
}

// ─── Shared pipeline tests (apply to both start and dev) ─────────────────────

describe.each([
	{ cmd: "start", label: "jolli start" },
	{ cmd: "build", label: "jolli build" },
	{ cmd: "dev", label: "jolli dev" },
])("$label — shared pipeline", ({ cmd }) => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
	let originalExitCode: number | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		originalExitCode = process.exitCode as number | undefined;
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		consoleWarnSpy.mockRestore();
	});

	it("prints an error when source-root does not exist", async () => {
		mockExistsSync.mockReturnValue(false);
		const program = await makeProgram();
		await program.parseAsync([cmd, "/nonexistent"], { from: "user" });

		expect(consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")).toContain("/nonexistent");
		expect(process.exitCode).toBe(1);
	});

	it("does not proceed past validation when source-root does not exist", async () => {
		mockExistsSync.mockReturnValue(false);
		const program = await makeProgram();
		await program.parseAsync([cmd, "/nonexistent"], { from: "user" });

		expect(mockReadSiteJson).not.toHaveBeenCalled();
	});

	it("prints an error when site.json is invalid JSON", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadSiteJson.mockRejectedValue(new Error("Failed to parse"));
		const program = await makeProgram();
		await program.parseAsync([cmd, "/my-docs"], { from: "user" });

		expect(consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")).toContain("Failed to parse");
		expect(process.exitCode).toBe(1);
	});

	it("handles non-Error rejection from readSiteJson", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadSiteJson.mockRejectedValue("string error");
		const program = await makeProgram();
		await program.parseAsync([cmd, "/my-docs"], { from: "user" });

		expect(consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")).toContain("string error");
		expect(process.exitCode).toBe(1);
	});

	it("prints a warning when no content files are found", async () => {
		setupSuccessfulRun({ markdownFiles: [], openapiFiles: [] });
		const program = await makeProgram();
		await program.parseAsync([cmd, "/my-docs"], { from: "user" });

		expect(consoleWarnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")).toContain(
			"No markdown or OpenAPI files found",
		);
	});

	it("prints npm error and sets exitCode = 1 when npm install fails", async () => {
		setupSuccessfulRun({ needsInstall: true });
		mockRunNpmInstall.mockResolvedValue({ success: false, output: "npm ERR!" });
		const program = await makeProgram();
		await program.parseAsync([cmd, "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});

	it("skips npm install when needsInstall returns false", async () => {
		setupSuccessfulRun({ needsInstall: false });
		const program = await makeProgram();
		await program.parseAsync([cmd, "/my-docs"], { from: "user" });

		expect(mockRunNpmInstall).not.toHaveBeenCalled();
	});

	it("runs npm install when needsInstall returns true", async () => {
		setupSuccessfulRun({ needsInstall: true });
		const program = await makeProgram();
		await program.parseAsync([cmd, "/my-docs"], { from: "user" });

		expect(mockRunNpmInstall).toHaveBeenCalledOnce();
	});

	it("defaults source-root to process.cwd()", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync([cmd], { from: "user" });

		expect(mockExistsSync).toHaveBeenCalledWith(process.cwd());
	});

	it("passes the correct buildDir to initNextraProject", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync([cmd, "/my-docs"], { from: "user" });

		const [calledBuildDir] = mockInitNextraProject.mock.calls[0] as [string, unknown, unknown];
		expect(calledBuildDir).toBe(getBuildDir(resolve("/my-docs")));
	});

	it("passes the correct contentDir to mirrorContent", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync([cmd, "/my-docs"], { from: "user" });

		const [, calledContentDir] = mockMirrorContent.mock.calls[0] as [string, string];
		expect(calledContentDir).toBe(`${getBuildDir(resolve("/my-docs"))}/content`);
	});
});

// ─── jolli build specific tests ──────────────────────────────────────────────

describe("jolli build", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let originalExitCode: number | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		originalExitCode = process.exitCode as number | undefined;
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	it("runs build and pagefind but not serve", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		expect(mockRunNpmBuild).toHaveBeenCalledOnce();
		expect(mockRunPagefind).toHaveBeenCalledOnce();
		expect(mockRunServe).not.toHaveBeenCalled();
		expect(mockRunNpmDev).not.toHaveBeenCalled();
	});

	it("prints next-step message on success", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("jolli start");
	});

	it("sets exitCode = 1 when next build fails", async () => {
		setupSuccessfulRun();
		mockRunNpmBuild.mockResolvedValue({ success: false, output: "Build failed" });
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
		expect(mockRunPagefind).not.toHaveBeenCalled();
	});

	it("sets exitCode = 1 when pagefind fails", async () => {
		setupSuccessfulRun();
		mockRunPagefind.mockResolvedValue({ success: false, output: "Pagefind error" });
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});

	it("does not set exitCode on a successful run", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(0);
	});
});

// ─── jolli start specific tests ──────────────────────────────────────────────

describe("jolli start", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let originalExitCode: number | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		originalExitCode = process.exitCode as number | undefined;
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	it("runs build, pagefind, and serve", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["start", "/my-docs"], { from: "user" });

		expect(mockRunNpmBuild).toHaveBeenCalledOnce();
		expect(mockRunPagefind).toHaveBeenCalledOnce();
		expect(mockRunServe).toHaveBeenCalledOnce();
		expect(mockRunNpmDev).not.toHaveBeenCalled();
	});

	it("passes staticExport: true to initNextraProject", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["start", "/my-docs"], { from: "user" });

		const [, , options] = mockInitNextraProject.mock.calls[0] as [string, unknown, { staticExport?: boolean }];
		expect(options.staticExport).toBe(true);
	});

	it("sets exitCode = 1 when next build fails", async () => {
		setupSuccessfulRun();
		mockRunNpmBuild.mockResolvedValue({ success: false, output: "Build failed" });
		const program = await makeProgram();
		await program.parseAsync(["start", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
		expect(mockRunPagefind).not.toHaveBeenCalled();
	});

	it("sets exitCode = 1 when pagefind fails", async () => {
		setupSuccessfulRun();
		mockRunPagefind.mockResolvedValue({ success: false, output: "Pagefind error" });
		const program = await makeProgram();
		await program.parseAsync(["start", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
		expect(mockRunServe).not.toHaveBeenCalled();
	});

	it("prints pages indexed count", async () => {
		setupSuccessfulRun();
		mockRunPagefind.mockResolvedValue({ success: true, output: "", pagesIndexed: 42 });
		const program = await makeProgram();
		await program.parseAsync(["start", "/my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("42");
	});

	it("prints concise progress messages", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["start", "/my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("Loaded site config");
		expect(output).toContain("Mirrored");
		expect(output).toContain("Generated navigation");
	});

	it("does not set exitCode on a successful run", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["start", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(0);
	});
});

// ─── jolli dev specific tests ────────────────────────────────────────────────

describe("jolli dev", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let originalExitCode: number | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		originalExitCode = process.exitCode as number | undefined;
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	it("runs next dev, not build/pagefind/serve", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["dev", "/my-docs"], { from: "user" });

		expect(mockRunNpmDev).toHaveBeenCalledOnce();
		expect(mockRunNpmBuild).not.toHaveBeenCalled();
		expect(mockRunPagefind).not.toHaveBeenCalled();
		expect(mockRunServe).not.toHaveBeenCalled();
	});

	it("passes staticExport: false to initNextraProject", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["dev", "/my-docs"], { from: "user" });

		const [, , options] = mockInitNextraProject.mock.calls[0] as [string, unknown, { staticExport?: boolean }];
		expect(options.staticExport).toBe(false);
	});

	it("sets exitCode = 1 when dev server fails", async () => {
		setupSuccessfulRun();
		mockRunNpmDev.mockResolvedValue({ success: false, output: "Dev error" });
		const program = await makeProgram();
		await program.parseAsync(["dev", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});

	it("handles dev server failure without output", async () => {
		setupSuccessfulRun();
		mockRunNpmDev.mockResolvedValue({ success: false, output: "" });
		const program = await makeProgram();
		await program.parseAsync(["dev", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});

	it("prints concise progress messages", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["dev", "/my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("Loaded site config");
		expect(output).toContain("Mirrored");
	});

	it("does not set exitCode on a successful run", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["dev", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(0);
	});
});

// ─── Additional branch coverage tests ────────────────────────────────────────

describe("StartCommand additional branches", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let originalExitCode: number | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		originalExitCode = process.exitCode as number | undefined;
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = originalExitCode;
		consoleSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	it("renders OpenAPI files when openapiFiles is non-empty", async () => {
		setupSuccessfulRun({ openapiFiles: ["api/spec.yaml"] });
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		expect(mockRenderOpenApiFiles).toHaveBeenCalledOnce();
	});

	it("does not render OpenAPI files when openapiFiles is empty", async () => {
		setupSuccessfulRun({ openapiFiles: [] });
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		expect(mockRenderOpenApiFiles).not.toHaveBeenCalled();
	});

	it("includes downgraded count in mirrored message", async () => {
		setupSuccessfulRun();
		mockMirrorContent.mockResolvedValue({
			...DEFAULT_MIRROR_RESULT,
			downgradedCount: 3,
		});
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("3 downgraded");
	});

	it("updates sidebar index key when renamedToIndex is set", async () => {
		setupSuccessfulRun();
		mockReadSiteJson.mockResolvedValue({
			config: {
				title: "Test",
				description: "D",
				nav: [],
				sidebar: { "/": { intro: "Introduction" } },
			},
			usedDefault: false,
		});
		mockMirrorContent.mockResolvedValue({
			...DEFAULT_MIRROR_RESULT,
			renamedToIndex: "intro",
		});
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		// Should call generateMetaFiles with updated sidebar
		const sidebarArg = mockGenerateMetaFiles.mock.calls[0][1] as Record<string, Record<string, string>>;
		expect(sidebarArg?.["/"]?.index).toBe("Introduction");
		expect(sidebarArg?.["/"]?.intro).toBeUndefined();
	});

	it("extracts page count from build output", async () => {
		setupSuccessfulRun();
		mockRunNpmBuild.mockResolvedValue({
			success: true,
			output: "Generating static pages (0/10)\nGenerating static pages (5/10)\nGenerating static pages (10/10)",
		});
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("Built 10 pages");
	});

	it("prints generic success when no page count in build output", async () => {
		setupSuccessfulRun();
		mockRunNpmBuild.mockResolvedValue({ success: true, output: "Build complete" });
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("Built successfully");
	});

	it("sets exitCode = 1 when serve fails with output", async () => {
		setupSuccessfulRun();
		mockRunServe.mockResolvedValue({ success: false, output: "Serve error details" });
		const program = await makeProgram();
		await program.parseAsync(["start", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
		const errOutput = consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(errOutput).toContain("Serve error details");
	});

	it("handles serve failure without output", async () => {
		setupSuccessfulRun();
		mockRunServe.mockResolvedValue({ success: false, output: "" });
		const program = await makeProgram();
		await program.parseAsync(["start", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});

	it("shows verbose npm install error when --verbose is set", async () => {
		setupSuccessfulRun({ needsInstall: true });
		mockRunNpmInstall.mockResolvedValue({ success: false, output: "detailed npm error" });
		const program = await makeProgram();
		await program.parseAsync(["build", "--verbose", "/my-docs"], { from: "user" });

		const errOutput = consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(errOutput).toContain("detailed npm error");
	});

	it("shows verbose build error when --verbose is set", async () => {
		setupSuccessfulRun();
		mockRunNpmBuild.mockResolvedValue({ success: false, output: "detailed build error" });
		const program = await makeProgram();
		await program.parseAsync(["build", "--verbose", "/my-docs"], { from: "user" });

		const errOutput = consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(errOutput).toContain("detailed build error");
	});

	it("shows verbose pagefind error when --verbose is set", async () => {
		setupSuccessfulRun();
		mockRunPagefind.mockResolvedValue({ success: false, output: "detailed pagefind error" });
		const program = await makeProgram();
		await program.parseAsync(["build", "--verbose", "/my-docs"], { from: "user" });

		const errOutput = consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(errOutput).toContain("detailed pagefind error");
	});

	it("passes --migrate option to readSiteJson", async () => {
		setupSuccessfulRun();
		const program = await makeProgram();
		await program.parseAsync(["build", "--migrate", "/my-docs"], { from: "user" });

		const opts = mockReadSiteJson.mock.calls[0][1] as { migrate?: boolean };
		expect(opts.migrate).toBe(true);
	});

	it("prints error and sets exitCode when renderer is unknown", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadSiteJson.mockResolvedValue({
			config: { title: "T", description: "D", nav: [], renderer: "bad" },
			usedDefault: false,
		});
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
		const errOutput = consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(errOutput).toContain("Unknown renderer");
	});

	it("prints error for unknown renderer as string", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadSiteJson.mockResolvedValue({
			config: { title: "T", description: "D", nav: [], renderer: "nope" },
			usedDefault: false,
		});
		const program = await makeProgram();
		await program.parseAsync(["dev", "/my-docs"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});

	it("does not call initProject when renderer is unknown", async () => {
		mockExistsSync.mockReturnValue(true);
		mockReadSiteJson.mockResolvedValue({
			config: { title: "T", description: "D", nav: [], renderer: "invalid" },
			usedDefault: false,
		});
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		expect(mockInitNextraProject).not.toHaveBeenCalled();
	});

	it("handles pagefind without pagesIndexed field", async () => {
		setupSuccessfulRun();
		mockRunPagefind.mockResolvedValue({ success: true, output: "Done" });
		const program = await makeProgram();
		await program.parseAsync(["build", "/my-docs"], { from: "user" });

		const output = consoleSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("Indexed 0 pages");
	});
});
