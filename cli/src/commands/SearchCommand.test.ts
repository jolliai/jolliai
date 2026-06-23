import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSearchCommand } from "./SearchCommand.js";

// Mock SearchHits so we don't need a real repo/index on disk.
vi.mock("../core/SearchHits.js", () => ({
	searchHits: vi.fn(async () => []),
}));

// Mock StorageFactory so the command's `createStorage` call is hermetic (does not
// read the developer's real ~/.jolli config) and returns a stable sentinel that
// flows through setActiveStorage → getActiveStorage into the searchHits 3rd arg.
const fakeStorage = { __fake: "storage" } as unknown as import("../core/StorageProvider.js").StorageProvider;
vi.mock("../core/StorageFactory.js", () => ({
	createStorage: vi.fn(async () => fakeStorage),
}));

import { searchHits } from "../core/SearchHits.js";

const mockSearchHits = vi.mocked(searchHits);

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return {
		...actual,
		mkdir: vi.fn(async () => undefined),
		writeFile: vi.fn(async () => undefined),
	};
});

import { mkdir, writeFile } from "node:fs/promises";

const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);

// ─── test harness ────────────────────────────────────────────────────────────

function makeProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerSearchCommand(program);
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
		await makeProgram().parseAsync(["node", "jolli", "search", ...args]);
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { stdout, stderr };
}

async function runWithStdin(args: string[], stdinPayload: string): Promise<{ stdout: string; stderr: string }> {
	const { Readable } = await import("node:stream");
	const origStdin = process.stdin;
	const stream = Readable.from([stdinPayload]);
	Object.defineProperty(process, "stdin", { value: stream, configurable: true });
	try {
		return await runCommand(args);
	} finally {
		Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
	}
}

// ─── registerSearchCommand ────────────────────────────────────────────────────

describe("registerSearchCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	// ─── {hits} JSON output ───────────────────────────────────────────────────

	it("emits {hits} JSON for a valid query (empty hit list from mock)", async () => {
		const { stdout } = await runCommand(["auth", "--format", "json", "--cwd", "/tmp/jolli-search-test"]);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty("hits");
		expect(Array.isArray(parsed.hits)).toBe(true);
	});

	it("passes query and options through to searchHits", async () => {
		await runCommand(["auth flow", "--limit", "5", "--branch", "main", "--type", "topic", "--cwd", "/tmp/t"]);
		expect(mockSearchHits).toHaveBeenCalledWith(
			"/tmp/t",
			expect.objectContaining({ query: "auth flow", limit: 5, branch: "main", type: "topic" }),
			fakeStorage,
		);
	});

	it("emits populated hits in JSON output", async () => {
		mockSearchHits.mockResolvedValueOnce([
			{
				id: "id1",
				type: "topic",
				title: "Auth flow design",
				snippet: "We chose JWT",
				branch: "feature/auth",
				commitDate: "2026-04-01T10:00:00.000Z",
				slug: "auth-flow-design",
				hash: "abcd1234",
				score: 0.9,
			},
		]);
		const { stdout } = await runCommand(["auth", "--cwd", "/tmp/t"]);
		const parsed = JSON.parse(stdout);
		expect(parsed.hits).toHaveLength(1);
		expect(parsed.hits[0].title).toBe("Auth flow design");
		expect(parsed.hits[0].hash).toBe("abcd1234");
	});

	// ─── empty query → non-zero exit ─────────────────────────────────────────

	it("rejects empty positional query with non-zero exit", async () => {
		const { stdout } = await runCommand(["--cwd", "/tmp/t"]);
		const parsed = JSON.parse(stdout);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("query is required");
		expect(process.exitCode).toBe(1);
	});

	it("--arg-stdin with empty stdin rejects with non-zero exit", async () => {
		const { code: _code, ...result } = await (async () => {
			const r = await runWithStdin(["--arg-stdin", "--cwd", "/tmp/t"], "");
			return { ...r, code: process.exitCode };
		})();
		const parsed = JSON.parse(result.stdout);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("query is required");
		expect(process.exitCode).toBe(1);
	});

	// ─── isSafeQuery validation (gated on --arg-stdin only) ───────────────────

	it("accepts unsafe shell chars on the direct argv path (MCP parity — no shell, no validation)", async () => {
		// isSafeQuery only guards the --arg-stdin here-doc bridge: that is the one
		// path where the query is interpolated into a shell. A direct argv query
		// never re-enters a shell and flows straight into the in-process index, so
		// it must accept `$`/backticks exactly like the MCP `search` tool — that is
		// the documented "CLI fallback === MCP primary" parity.
		const { stdout } = await runCommand(["foo$(date)", "--cwd", "/tmp/t"]);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty("hits");
		expect(mockSearchHits).toHaveBeenCalledWith(
			"/tmp/t",
			expect.objectContaining({ query: "foo$(date)" }),
			fakeStorage,
		);
		expect(process.exitCode).toBeUndefined();
	});

	it("accepts natural-language punctuation in queries", async () => {
		const { stdout } = await runCommand(["why did we choose X over Y?", "--cwd", "/tmp/t"]);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty("hits");
	});

	it("accepts # and parentheses in queries", async () => {
		const { stdout } = await runCommand(["#789 (token bucket)", "--cwd", "/tmp/t"]);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty("hits");
	});

	// ─── text format ──────────────────────────────────────────────────────────

	it("text format prints one line per hit", async () => {
		mockSearchHits.mockResolvedValueOnce([
			{
				id: "id1",
				type: "commit",
				title: "Auth refactor",
				snippet: "Rewrote auth",
				branch: "feature/auth",
				commitDate: "2026-04-01T10:00:00.000Z",
				slug: "auth-refactor",
				hash: "deadbeef",
				score: 0.8,
			},
		]);
		const { stdout } = await runCommand(["auth", "--format", "text", "--cwd", "/tmp/t"]);
		expect(stdout).toContain("deadbeef");
		expect(stdout).toContain("feature/auth");
		expect(stdout).toContain("2026-04-01");
		expect(stdout).toContain("Auth refactor");
	});

	it("text format renders empty-hits path", async () => {
		// mockSearchHits returns [] by default
		const { stdout } = await runCommand(["notfound", "--format", "text", "--cwd", "/tmp/t"]);
		expect(stdout).toContain("(no hits matched the query)");
	});

	it("text format error path writes to stderr and sets exitCode", async () => {
		// Trigger the text-format emitError path via the --arg-stdin validation
		// (the one path where unsafe chars are still rejected), since a direct argv
		// unsafe query is now accepted (MCP parity).
		const { stdout, stderr } = await runWithStdin(
			["--arg-stdin", "--format", "text", "--cwd", "/tmp/t"],
			"$(date)\n",
		);
		expect(stdout).toBe("");
		expect(stderr).toContain("Error:");
		expect(process.exitCode).toBe(1);
	});

	// ─── --output ─────────────────────────────────────────────────────────────

	it("--output writes file and prints confirmation", async () => {
		const { stdout } = await runCommand(["auth", "--output", "sub/dir/out.json", "--cwd", "/tmp/t"]);
		expect(mockMkdir).toHaveBeenCalled();
		expect(mockWriteFile).toHaveBeenCalled();
		expect(stdout).toContain("Search output written to");
	});

	it("--output skips mkdir when path has no parent dir", async () => {
		mockMkdir.mockClear();
		await runCommand(["auth", "--output", "result.json", "--cwd", "/tmp/t"]);
		// dirname("result.json") === "." → mkdir is skipped
		expect(mockMkdir).not.toHaveBeenCalled();
		expect(mockWriteFile).toHaveBeenCalled();
	});

	// ─── runtime errors ───────────────────────────────────────────────────────

	it("catches and reports runtime errors from searchHits", async () => {
		mockSearchHits.mockImplementationOnce(async () => {
			throw new Error("simulated storage failure");
		});
		const { stdout } = await runCommand(["auth", "--cwd", "/tmp/t"]);
		const parsed = JSON.parse(stdout);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("simulated storage failure");
		expect(process.exitCode).toBe(1);
	});

	it("non-Error thrown values are stringified safely in the catch path", async () => {
		mockSearchHits.mockImplementationOnce(async () => {
			throw "string error not an Error instance";
		});
		const { stdout } = await runCommand(["auth", "--cwd", "/tmp/t"]);
		const parsed = JSON.parse(stdout);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("string error");
	});

	// ─── --arg-stdin ──────────────────────────────────────────────────────────

	it("--arg-stdin reads query from stdin verbatim (shell metacharacters rejected at validation)", async () => {
		const { stdout } = await runWithStdin(["--arg-stdin", "--cwd", "/tmp/t"], "$(date)\n");
		const parsed = JSON.parse(stdout);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("Invalid characters");
	});

	it("--arg-stdin with safe query calls searchHits", async () => {
		const { stdout } = await runWithStdin(["--arg-stdin", "--cwd", "/tmp/t"], "why did we choose X?\n");
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty("hits");
		expect(mockSearchHits).toHaveBeenCalledWith(
			"/tmp/t",
			expect.objectContaining({ query: "why did we choose X?" }),
			fakeStorage,
		);
	});

	it("rejects --arg-stdin combined with positional words (mutually exclusive)", async () => {
		const { stdout } = await runCommand(["--arg-stdin", "auth", "--cwd", "/tmp/t"]);
		const parsed = JSON.parse(stdout);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("mutually exclusive");
		expect(process.exitCode).toBe(1);
	});

	it("runs with medium- and long-length queries (telemetry query_len_bucket branches)", async () => {
		// 20–79 chars → "medium"; ≥80 chars → "long". Both must run the search path
		// cleanly; the search_performed emit is a no-op (telemetry uninitialized in tests).
		await runCommand(["a".repeat(40), "--cwd", "/tmp/t"]);
		await runCommand(["a".repeat(120), "--cwd", "/tmp/t"]);
		expect(mockSearchHits).toHaveBeenCalled();
	});
});
