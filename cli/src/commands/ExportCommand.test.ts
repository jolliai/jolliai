import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExportCommand } from "./ExportCommand.js";

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

describe("registerExportCommand — ambiguous --commit handling", () => {
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
});
