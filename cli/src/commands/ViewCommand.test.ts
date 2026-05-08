import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerViewCommand } from "./ViewCommand.js";

vi.mock("../core/SummaryStore.js", async () => {
	const actual = await vi.importActual<typeof import("../core/SummaryStore.js")>("../core/SummaryStore.js");
	return {
		// Real AmbiguousHashError so the command's `instanceof` check passes
		// against errors thrown by mocked getSummary.
		AmbiguousHashError: actual.AmbiguousHashError,
		getIndex: vi.fn(async () => null),
		getSummary: vi.fn(async () => null),
	};
});

import { AmbiguousHashError, getIndex, getSummary } from "../core/SummaryStore.js";

const mockGetIndex = vi.mocked(getIndex);
const mockGetSummary = vi.mocked(getSummary);

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerViewCommand(program);
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
		await makeProgram().parseAsync(["node", "jolli", "view", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { stdout, stderr };
}

describe("registerViewCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	it("renders a 'use a longer prefix' message and exits non-zero when --commit is ambiguous", async () => {
		// getSummary throws when an abbreviated hash collides with multiple
		// index entries. ViewCommand should surface this as a git-style hint
		// listing the colliding hashes, rather than letting the error abort
		// the process with a stack trace.
		const collidingHashes = [
			"abcdef1234567890abcdef1234567890abcdef12",
			"abcdef9876543210abcdef9876543210abcdef98",
		];
		mockGetSummary.mockRejectedValueOnce(new AmbiguousHashError("abcdef", collidingHashes));

		const { stdout } = await runCommand(["--commit", "abcdef", "--cwd", "/tmp/jolli-view-test"]);

		expect(stdout).toContain("abbreviation `abcdef` is ambiguous");
		expect(stdout).toContain("please use a longer prefix");
		// Both colliding hashes are shown so the user can pick.
		for (const hash of collidingHashes) {
			expect(stdout).toContain(hash);
		}
		expect(process.exitCode).toBe(1);
	});

	it("propagates non-Ambiguous errors instead of swallowing them", async () => {
		// Defensive: only AmbiguousHashError is caught and rendered. Anything
		// else (e.g. a transient I/O error) should bubble up so it isn't
		// silently masked as "no summary found".
		mockGetSummary.mockRejectedValueOnce(new Error("disk on fire"));

		await expect(runCommand(["--commit", "deadbeef", "--cwd", "/tmp/jolli-view-test"])).rejects.toThrow(
			"disk on fire",
		);
	});

	it("renders 'No summary found' when --commit is a SHA with no match", async () => {
		// Sanity: the new error-handling branch did not regress the plain
		// not-found message for non-numeric input.
		mockGetSummary.mockResolvedValueOnce(null);

		const { stdout } = await runCommand(["--commit", "abcdef12", "--cwd", "/tmp/jolli-view-test"]);

		expect(stdout).toContain("No summary found for commit abcdef12");
		// SHA path doesn't set a non-zero exit code (consistent with prior behavior).
		expect(process.exitCode).toBeUndefined();
	});

	it("stays silent when --commit is a numeric index that doesn't exist", async () => {
		// Numeric path goes through getIndex, not getSummary. resolveCommit
		// already prints its own "No summary at index" message; ViewCommand
		// must not double-print "No summary found for commit 99".
		mockGetIndex.mockResolvedValueOnce({ version: 3, entries: [] });

		const { stdout } = await runCommand(["--commit", "99", "--cwd", "/tmp/jolli-view-test"]);

		expect(stdout).not.toContain("No summary found for commit 99");
	});
});
