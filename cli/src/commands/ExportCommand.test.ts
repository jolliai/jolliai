import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExportCommand, registerExportPromptCommand } from "./ExportCommand.js";

vi.mock("../core/SummaryExporter.js", () => ({
	exportSummaries: vi.fn(),
}));

vi.mock("../core/SummaryStore.js", async () => {
	const actual = await vi.importActual<typeof import("../core/SummaryStore.js")>("../core/SummaryStore.js");
	return {
		// Real AmbiguousHashError so the command's `instanceof` check matches.
		AmbiguousHashError: actual.AmbiguousHashError,
	};
});

import { exportSummaries } from "../core/SummaryExporter.js";
import { AmbiguousHashError } from "../core/SummaryStore.js";

const mockExport = vi.mocked(exportSummaries);

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerExportCommand(program);
	return program;
}

function makePromptProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerExportPromptCommand(program);
	return program;
}

async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const origLog = console.log;
	const origErr = console.error;
	console.log = (msg: string) => {
		stdout += `${msg}\n`;
	};
	console.error = (msg: string) => {
		stderr += `${msg}\n`;
	};
	try {
		await makeProgram().parseAsync(["node", "jolli", "export", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { stdout, stderr };
}

async function runPromptCommand(args: string[]): Promise<{ stdout: string; stderr: string; written: string }> {
	let stdout = "";
	let stderr = "";
	let written = "";
	const origLog = console.log;
	const origErr = console.error;
	const origWrite = process.stdout.write.bind(process.stdout);
	console.log = (msg: string) => {
		stdout += `${msg}\n`;
	};
	console.error = (msg: string) => {
		stderr += `${msg}\n`;
	};
	process.stdout.write = ((chunk: string | Uint8Array) => {
		written += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as typeof process.stdout.write;
	try {
		await makePromptProgram().parseAsync(["node", "jolli", "export-prompt", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
		process.stdout.write = origWrite;
	}
	return { stdout, stderr, written };
}

describe("registerExportCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	it("renders 'use a longer prefix' and exits non-zero when --commit is ambiguous", async () => {
		// SummaryExporter calls getSummary, which now throws AmbiguousHashError
		// when an abbreviated SHA collides with multiple index entries. Without
		// this catch ExportCommand would crash with an unhandled rejection;
		// users get the same friendly hint as `jolli view`.
		const collidingHashes = [
			"abcdef1234567890abcdef1234567890abcdef12",
			"abcdef9876543210abcdef9876543210abcdef98",
		];
		mockExport.mockRejectedValueOnce(new AmbiguousHashError("abcdef", collidingHashes));

		const { stdout, stderr } = await runCommand(["--commit", "abcdef", "--cwd", "/tmp/jolli-export-test"]);

		// Hint goes to stderr (matches `jolli view`'s convention so piped
		// stdout consumers stay clean); stdout doesn't get the prose.
		expect(stderr).toContain("abbreviation `abcdef` is ambiguous");
		expect(stderr).toContain("please use a longer prefix");
		expect(stdout).not.toContain("abbreviation");
		for (const hash of collidingHashes) {
			expect(stderr).toContain(hash);
		}
		expect(process.exitCode).toBe(1);
	});

	it("propagates non-Ambiguous errors from exportSummaries", async () => {
		// Defensive: the catch only handles AmbiguousHashError. Anything else
		// (storage failure, fs error) bubbles up so it isn't masked as "no
		// summaries found to export".
		mockExport.mockRejectedValueOnce(new Error("disk full"));
		await expect(runCommand(["--commit", "abc12345", "--cwd", "/tmp/jolli-export-test"])).rejects.toThrow(
			"disk full",
		);
	});

	it("prints a friendly note and exits cleanly when there are no summaries", async () => {
		mockExport.mockResolvedValueOnce({
			outputDir: "/tmp/empty-out",
			filesWritten: 0,
			filesSkipped: 0,
			filesErrored: 0,
			totalSummaries: 0,
			indexPath: "/tmp/empty-out/index.md",
		});

		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-export-test"]);

		expect(stdout).toContain("No summaries found to export.");
		expect(process.exitCode).toBeUndefined();
	});

	it("prints success summary on a successful export", async () => {
		mockExport.mockResolvedValueOnce({
			outputDir: "/tmp/ok-out",
			filesWritten: 3,
			filesSkipped: 1,
			filesErrored: 0,
			totalSummaries: 4,
			indexPath: "/tmp/ok-out/index.md",
		});

		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-export-test"]);

		expect(stdout).toContain("Exported to /tmp/ok-out");
		expect(stdout).toContain("New: 3");
		expect(stdout).toContain("Skipped: 1");
		expect(stdout).toContain("Total: 4");
		expect(stdout).toContain("Index: /tmp/ok-out/index.md");
		expect(stdout).not.toContain("Errored:");
	});

	it("includes 'Errored: N' segment when some files failed but others wrote", async () => {
		// Partial-failure path: keeps the success summary but flags the errored count.
		mockExport.mockResolvedValueOnce({
			outputDir: "/tmp/partial-out",
			filesWritten: 2,
			filesSkipped: 0,
			filesErrored: 1,
			totalSummaries: 3,
			indexPath: "/tmp/partial-out/index.md",
		});

		const { stdout } = await runCommand(["--cwd", "/tmp/jolli-export-test"]);

		expect(stdout).toContain("Errored: 1");
		expect(process.exitCode).toBeUndefined();
	});

	it("exits non-zero with an error message when every file failed", async () => {
		// Total-failure path: nothing landed on disk so we surface to stderr
		// with a non-zero exit code that scripts can detect.
		mockExport.mockResolvedValueOnce({
			outputDir: "/tmp/fail-out",
			filesWritten: 0,
			filesSkipped: 2,
			filesErrored: 5,
			totalSummaries: 7,
			indexPath: "/tmp/fail-out/index.md",
		});

		const { stdout, stderr } = await runCommand(["--cwd", "/tmp/jolli-export-test"]);

		expect(stderr).toContain("Export failed");
		expect(stderr).toContain("5 failed");
		expect(stderr).toContain("2 already on disk");
		expect(stdout).not.toContain("Exported to");
		expect(process.exitCode).toBe(1);
	});

	it("forwards --commit and --project to exportSummaries", async () => {
		mockExport.mockResolvedValueOnce({
			outputDir: "/tmp/p-out",
			filesWritten: 1,
			filesSkipped: 0,
			filesErrored: 0,
			totalSummaries: 1,
			indexPath: "/tmp/p-out/index.md",
		});

		await runCommand(["--commit", "deadbeef", "--project", "demo", "--cwd", "/tmp/jolli-export-test"]);

		expect(mockExport).toHaveBeenCalledWith({
			commit: "deadbeef",
			project: "demo",
			cwd: "/tmp/jolli-export-test",
		});
	});
});

describe("registerExportPromptCommand", () => {
	let tmpDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		tmpDir = await mkdtemp(join(tmpdir(), "jolli-export-prompt-"));
	});

	afterEach(async () => {
		process.exitCode = undefined;
		vi.unstubAllGlobals();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("prints usage guidance when no flags are given", async () => {
		const { stdout } = await runPromptCommand([]);

		expect(stdout).toContain("--action");
		expect(stdout).toContain("--output");
		expect(stdout).toContain("Available actions:");
	});

	it("prints a single template to stdout for a known --action", async () => {
		const { written } = await runPromptCommand(["--action", "translate"]);

		expect(written).toContain("Translate the following Markdown");
	});

	it("errors and exits non-zero for unknown --action without --output", async () => {
		const { stderr } = await runPromptCommand(["--action", "no-such-action"]);

		expect(stderr).toContain('unknown action "no-such-action"');
		expect(process.exitCode).toBe(1);
	});

	it("writes manifest.json + per-prompt .md files when --output is given", async () => {
		const { stdout } = await runPromptCommand(["--output", tmpDir]);

		const files = await readdir(tmpDir);
		expect(files).toContain("manifest.json");
		expect(files).toContain("translate.md");
		expect(files).toContain("summarize.md");

		const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8")) as {
			cliVersion: string;
			prompts: ReadonlyArray<{ action: string; placeholders: ReadonlyArray<string> }>;
		};
		expect(manifest.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
		expect(manifest.prompts.length).toBeGreaterThan(1);
		expect(stdout).toContain("Exported");
		expect(stdout).toContain("Manifest:");
	});

	it("filters to a single prompt when --action and --output are both provided", async () => {
		await runPromptCommand(["--action", "translate", "--output", tmpDir]);

		const files = await readdir(tmpDir);
		expect(files).toContain("translate.md");
		expect(files).not.toContain("summarize.md");

		const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8")) as {
			prompts: ReadonlyArray<{ action: string }>;
		};
		expect(manifest.prompts).toHaveLength(1);
		expect(manifest.prompts[0].action).toBe("translate");
	});

	it("errors when --action is unknown even with --output", async () => {
		const { stderr } = await runPromptCommand(["--action", "missing", "--output", tmpDir]);

		expect(stderr).toContain('unknown action "missing"');
		expect(process.exitCode).toBe(1);
	});

	it("falls back to reading cli/package.json when the build-time version is undefined", async () => {
		// Vite normally inlines __CLI_PKG_VERSION__; stubbing it as undefined
		// exercises the fs fallback path in readCliVersion.
		vi.stubGlobal("__CLI_PKG_VERSION__", undefined);

		await runPromptCommand(["--output", tmpDir]);

		const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8")) as {
			cliVersion: string;
		};
		// The fallback should pull the real version from cli/package.json, not
		// the catch-all "unknown".
		expect(manifest.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("falls back to 'unknown' when both the global and the package.json read fail", async () => {
		vi.stubGlobal("__CLI_PKG_VERSION__", undefined);
		// Forces the readFile path to throw, exercising the catch arm of
		// readCliVersion. The mock is scoped to a fresh module so the global
		// readFile elsewhere is untouched after this test ends.
		vi.resetModules();
		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				readFile: vi.fn().mockRejectedValue(new Error("no such file")),
			};
		});
		const { registerExportPromptCommand: register } = await import("./ExportCommand.js");
		const program = new Command();
		program.exitOverride();
		register(program);

		const origLog = console.log;
		console.log = () => {};
		try {
			await program.parseAsync(["node", "jolli", "export-prompt", "--output", tmpDir]);
		} finally {
			console.log = origLog;
		}

		const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8")) as {
			cliVersion: string;
		};
		expect(manifest.cliVersion).toBe("unknown");

		vi.doUnmock("node:fs/promises");
		vi.resetModules();
	});

	it("falls back to 'unknown' when the package.json has no version field", async () => {
		// Exercises the `parsed.version ?? "unknown"` nullish branch on a
		// well-formed JSON file that simply omits `version`.
		vi.stubGlobal("__CLI_PKG_VERSION__", undefined);
		vi.resetModules();
		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				readFile: vi.fn().mockResolvedValue("{}"),
			};
		});
		const { registerExportPromptCommand: register } = await import("./ExportCommand.js");
		const program = new Command();
		program.exitOverride();
		register(program);

		const origLog = console.log;
		console.log = () => {};
		try {
			await program.parseAsync(["node", "jolli", "export-prompt", "--output", tmpDir]);
		} finally {
			console.log = origLog;
		}

		const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8")) as {
			cliVersion: string;
		};
		expect(manifest.cliVersion).toBe("unknown");

		vi.doUnmock("node:fs/promises");
		vi.resetModules();
	});

	it("renders `placeholders: []` for templates that have no placeholders", async () => {
		// All shipped templates carry at least one `{{slot}}`, so the empty-list
		// branch in formatPromptMarkdown is only reachable by feeding a curated
		// template map. Mock PromptTemplates so the fresh module sees one entry
		// with a placeholder-free body.
		vi.resetModules();
		vi.doMock("../core/PromptTemplates.js", () => ({
			TEMPLATES: new Map([["literal", { action: "literal", version: 1, template: "no slots here" }]]),
		}));
		const { registerExportPromptCommand: register } = await import("./ExportCommand.js");
		const program = new Command();
		program.exitOverride();
		register(program);

		const origLog = console.log;
		console.log = () => {};
		try {
			await program.parseAsync(["node", "jolli", "export-prompt", "--output", tmpDir]);
		} finally {
			console.log = origLog;
		}

		const md = await readFile(join(tmpDir, "literal.md"), "utf-8");
		expect(md).toContain("placeholders: []");

		vi.doUnmock("../core/PromptTemplates.js");
		vi.resetModules();
	});
});
