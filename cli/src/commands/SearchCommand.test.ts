import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHashList, registerSearchCommand } from "./SearchCommand.js";

vi.mock("../core/SummaryStore.js", () => ({
	getCatalogWithLazyBuild: vi.fn(async () => ({ version: 1, entries: [] })),
	getIndex: vi.fn(async () => null),
	getSummary: vi.fn(async () => null),
}));

import { getCatalogWithLazyBuild, getIndex } from "../core/SummaryStore.js";

const mockGetIndex = vi.mocked(getIndex);
const mockGetCatalog = vi.mocked(getCatalogWithLazyBuild);

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return {
		...actual,
		mkdir: vi.fn(async () => undefined),
		writeFile: vi.fn(async () => undefined),
	};
});

import { mkdir, writeFile } from "node:fs/promises";
import { getSummary } from "../core/SummaryStore.js";

const mockGetSummary = vi.mocked(getSummary);
const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);

// ─── parseHashList ───────────────────────────────────────────────────────────

describe("parseHashList", () => {
	it("returns null for empty/whitespace", () => {
		expect(parseHashList(undefined)).toBeNull();
		expect(parseHashList("")).toBeNull();
		expect(parseHashList("   ")).toBeNull();
	});

	it("parses single hex hash", () => {
		expect(parseHashList("abcd1234abcd1234abcd1234abcd1234abcd1234")).toEqual([
			"abcd1234abcd1234abcd1234abcd1234abcd1234",
		]);
	});

	it("parses comma-separated hashes", () => {
		expect(
			parseHashList("abcd1234abcd1234abcd1234abcd1234abcd1234,deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
		).toEqual(["abcd1234abcd1234abcd1234abcd1234abcd1234", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
	});

	it("rejects too-short hashes", () => {
		expect(parseHashList("abc")).toBeNull();
	});

	it("rejects 8-char abbreviations (must be the full 40-char SHA)", () => {
		// Regression: earlier the pattern was 4-64 chars and abbreviations relied
		// on `getSummary`'s git rev-parse + tree-hash fallback. That fallback
		// silently resolves to the wrong commit when two distinct commits share
		// a tree (cherry-pick, rebase). The CLI now rejects abbreviations at the
		// boundary so the contract is enforced — `hit.fullHash`, not `hit.hash`.
		expect(parseHashList("abcd1234")).toBeNull();
		expect(parseHashList("abcd1234,deadbeef")).toBeNull();
		// 39 chars: one shy of full SHA, still rejected.
		expect(parseHashList("abcd1234abcd1234abcd1234abcd1234abcd123")).toBeNull();
	});

	it("rejects trailing comma", () => {
		expect(parseHashList("abcd1234abcd1234abcd1234abcd1234abcd1234,")).toBeNull();
	});

	it("rejects whitespace inside hashes", () => {
		// Even a 40-char value gets rejected if there's whitespace inside.
		expect(parseHashList("abcd1234 abcd1234abcd1234abcd1234abcd123")).toBeNull();
	});

	it("rejects non-hex characters", () => {
		// 40-char string with a non-hex letter ("z") — would have passed the old
		// hex-only check based on length but for the wrong reason; explicit here.
		expect(parseHashList("zzz12345abcd1234abcd1234abcd1234abcd1234")).toBeNull();
	});

	it("normalizes mixed case to lowercase", () => {
		expect(parseHashList("AbCd1234abcd1234abcd1234abcd1234abcd1234")).toEqual([
			"abcd1234abcd1234abcd1234abcd1234abcd1234",
		]);
	});
});

// ─── registerSearchCommand integration ───────────────────────────────────────

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

describe("registerSearchCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	it("default JSON output for an empty repo", async () => {
		const { stdout } = await runCommand(["auth", "--cwd", "/tmp/jolli-search-test-empty"]);
		expect(stdout).toContain('"type": "search-catalog"');
	});

	it("text format prints human-readable header", async () => {
		const { stdout } = await runCommand(["auth", "--format", "text", "--cwd", "/tmp/jolli-search-test-empty"]);
		expect(stdout).toContain("Search catalog");
	});

	it("rejects unsafe shell chars in query (deny-list) and sets non-zero exit code", async () => {
		// `$(date)` violates the query deny-list ($ is blocked because it triggers
		// shell expansion inside double quotes). Pass as a single positional so
		// commander doesn't treat any token as a flag.
		const { stdout } = await runCommand(["foo$(date)", "--cwd", "/tmp/jolli-search-test-empty"]);
		expect(stdout).toContain('"type":"error"');
		expect(stdout).toContain("Invalid characters");
		// Exit code must be set even when --format json (callers shouldn't have to
		// parse JSON to know there was an error).
		expect(process.exitCode).toBe(1);
	});

	it("accepts natural-language punctuation in queries", async () => {
		// `?` `(` `)` `:` `,` `'` `!` were rejected by the old strict pattern but
		// must pass under the new deny-list. Use a sentence with a question mark.
		const { stdout } = await runCommand(["why did we choose X over Y?", "--cwd", "/tmp/jolli-search-test-empty"]);
		expect(stdout).not.toContain('"type":"error"');
		expect(stdout).toContain('"type": "search-catalog"');
	});

	it("accepts # and parentheses in queries (ticket lookup, parenthetical)", async () => {
		const { stdout } = await runCommand(["#789 (token bucket)", "--cwd", "/tmp/jolli-search-test-empty"]);
		expect(stdout).not.toContain('"type":"error"');
	});

	it("rejects invalid --hashes", async () => {
		const { stdout } = await runCommand(["auth", "--hashes", "xyz", "--cwd", "/tmp/jolli-search-test-empty"]);
		expect(stdout).toContain('"type":"error"');
	});

	it("rejects --hashes with abbreviated SHAs and tells the caller to use fullHash", async () => {
		// Earlier the CLI accepted 4-64 char hashes and `getSummary`'s tree-hash
		// fallback resolved them. That fallback can silently match the wrong
		// commit when two commits share a tree (cherry-pick, rebase). Now the
		// CLI rejects anything other than 40-char SHAs at the boundary.
		const { stdout } = await runCommand([
			"auth",
			"--hashes",
			"abcd1234,deadbeef",
			"--cwd",
			"/tmp/jolli-search-test-empty",
		]);
		expect(stdout).toContain('"type":"error"');
		expect(stdout).toContain("fullHash");
		expect(stdout).toContain("40-character");
	});

	it("requires query when --hashes is provided", async () => {
		const { stdout } = await runCommand([
			"--hashes",
			"abcd1234abcd1234abcd1234abcd1234abcd1234",
			"--cwd",
			"/tmp/jolli-search-test-empty",
		]);
		expect(stdout).toContain('"type":"error"');
		expect(stdout).toContain("query is required");
	});

	it("rejects invalid --since instead of silently disabling the filter", async () => {
		// Regression: earlier `--since=lastweek` parsed to null (treated as no
		// filter), broadening results instead of erroring. Now buildCatalog
		// throws, the action's outer try/catch emits a JSON error.
		const { stdout } = await runCommand(["auth", "--since", "lastweek", "--cwd", "/tmp/jolli-search-test-empty"]);
		expect(stdout).toContain('"type":"error"');
		expect(stdout).toContain("Invalid --since");
	});

	it("Phase 2 path: returns search result for picked hash", async () => {
		mockGetSummary.mockResolvedValueOnce({
			version: 4,
			commitHash: "abcd1234abcd1234abcd1234abcd1234abcd1234",
			commitMessage: "msg",
			commitAuthor: "dev",
			commitDate: "2026-04-01T00:00:00.000Z",
			branch: "x",
			generatedAt: "2026-04-01T00:00:00.000Z",
			recap: "Did auth work",
			topics: [
				{
					title: "Auth",
					trigger: "T",
					response: "R",
					decisions: "auth jwt",
				},
			],
		});
		const { stdout } = await runCommand([
			"auth",
			"--hashes",
			"abcd1234abcd1234abcd1234abcd1234abcd1234",
			"--cwd",
			"/tmp/jolli-search-test-found",
		]);
		expect(stdout).toContain('"type": "search"');
		expect(stdout).toContain("abcd1234abcd1234abcd1234abcd1234abcd1234");
	});

	it("--output writes file and prints confirmation", async () => {
		const { stdout } = await runCommand([
			"auth",
			"--output",
			"/tmp/out.json",
			"--cwd",
			"/tmp/jolli-search-test-empty",
		]);
		expect(mockWriteFile).toHaveBeenCalled();
		expect(mockMkdir).toHaveBeenCalled();
		expect(stdout).toContain("Search output written to");
	});

	it("Phase 2 text format renders the populated-results path", async () => {
		mockGetSummary.mockResolvedValueOnce({
			version: 4,
			commitHash: "abcd1234abcd1234abcd1234abcd1234abcd1234",
			commitMessage: "feat: add auth",
			commitAuthor: "dev",
			commitDate: "2026-04-01T00:00:00.000Z",
			branch: "feature/auth",
			generatedAt: "2026-04-01T00:00:00.000Z",
			recap: "Auth flow",
			topics: [
				{
					title: "Auth",
					trigger: "T",
					response: "R",
					decisions: "auth picked JWT",
				},
			],
		});
		const { stdout } = await runCommand([
			"auth",
			"--hashes",
			"abcd1234abcd1234abcd1234abcd1234abcd1234",
			"--format",
			"text",
			"--cwd",
			"/tmp/jolli-search-test-found",
		]);
		expect(stdout).toContain("Search hits");
		// Text renderer prints `hit.hash` (8-char display abbreviation), not the
		// 40-char fullHash — see renderResultText in SearchCommand.ts.
		expect(stdout).toContain("abcd1234 ");
		expect(stdout).toContain("feature/auth");
	});

	it("Phase 2 text format renders the empty-results path", async () => {
		mockGetSummary.mockResolvedValueOnce(null);
		const { stdout } = await runCommand([
			"auth",
			"--hashes",
			"abcd1234abcd1234abcd1234abcd1234abcd1234",
			"--format",
			"text",
			"--cwd",
			"/tmp/jolli-search-test-found",
		]);
		expect(stdout).toContain("none of the requested hashes resolved");
	});

	it("text format error path writes to stderr and sets exitCode", async () => {
		const { stdout, stderr } = await runCommand([
			"foo$(date)",
			"--format",
			"text",
			"--cwd",
			"/tmp/jolli-search-test-empty",
		]);
		// Text-format error goes to stderr, not stdout; exitCode is set non-zero.
		expect(stdout).toBe("");
		expect(stderr).toContain("Error:");
		expect(process.exitCode).not.toBe(0);
	});

	it("catches and reports runtime errors from the provider", async () => {
		mockGetSummary.mockImplementationOnce(async () => {
			throw new Error("simulated storage failure");
		});
		const { stdout } = await runCommand([
			"auth",
			"--hashes",
			"abcd1234abcd1234abcd1234abcd1234abcd1234",
			"--cwd",
			"/tmp/jolli-search-test-found",
		]);
		expect(stdout).toContain('"type":"error"');
		expect(stdout).toContain("simulated storage failure");
	});

	it("--output also works for Phase 2", async () => {
		mockGetSummary.mockResolvedValueOnce({
			version: 4,
			commitHash: "abcd1234abcd1234abcd1234abcd1234abcd1234",
			commitMessage: "msg",
			commitAuthor: "dev",
			commitDate: "2026-04-01T00:00:00.000Z",
			branch: "x",
			generatedAt: "2026-04-01T00:00:00.000Z",
			topics: [{ title: "t", trigger: "auth", response: "r", decisions: "d" }],
		});
		await runCommand([
			"auth",
			"--hashes",
			"abcd1234abcd1234abcd1234abcd1234abcd1234",
			"--output",
			"sub/dir/result.json",
			"--cwd",
			"/tmp/jolli-search-test-found",
		]);
		expect(mockWriteFile).toHaveBeenCalled();
	});

	it("--output skips mkdir when path has no parent", async () => {
		mockMkdir.mockClear();
		await runCommand(["auth", "--output", "result.json", "--cwd", "/tmp/jolli-search-test-empty"]);
		// dirname("result.json") === "." → mkdir is skipped
		expect(mockMkdir).not.toHaveBeenCalled();
		expect(mockWriteFile).toHaveBeenCalled();
	});

	it("default Phase 1 with --since and --limit echoes filter back", async () => {
		const { stdout } = await runCommand([
			"auth",
			"--since",
			"7d",
			"--limit",
			"50",
			"--budget",
			"4000",
			"--cwd",
			"/tmp/jolli-search-test-empty",
		]);
		const result = JSON.parse(stdout);
		expect(result.filter).toEqual({ since: "7d", limit: 50 });
	});

	it("Phase 1 text format renders entries WITHOUT decorations (falsy branches)", async () => {
		mockGetIndex.mockResolvedValueOnce({
			version: 3,
			entries: [
				{
					commitHash: "minimalcommithash01",
					parentCommitHash: null,
					branch: "x",
					commitMessage: "msg",
					commitDate: "2026-04-01T10:00:00.000Z",
					generatedAt: "2026-04-01T10:01:00.000Z",
				},
			],
		});
		mockGetCatalog.mockResolvedValueOnce({
			version: 1,
			entries: [
				{
					commitHash: "minimalcommithash01",
					// No recap, no ticketId
					topics: [{ title: "Plain Topic" }], // no category, importance, etc.
				},
			],
		});
		const { stdout } = await runCommand(["q", "--format", "text", "--cwd", "/tmp/jolli-search-test-minimal"]);
		expect(stdout).toContain("Plain Topic");
		// No ticket badge / recap / category / star.
		expect(stdout).not.toContain("[TKT");
		expect(stdout).not.toContain("[feature]");
		expect(stdout).not.toContain("★");
	});

	it("Phase 1 text format shows '(truncated)' marker when result is capped", async () => {
		const entries: Array<{
			commitHash: string;
			parentCommitHash: null;
			branch: string;
			commitMessage: string;
			commitDate: string;
			generatedAt: string;
		}> = [];
		for (let i = 0; i < 3; i++) {
			entries.push({
				commitHash: `cmt${i}aaa00000000000000`.slice(0, 16),
				parentCommitHash: null,
				branch: "x",
				commitMessage: `m${i}`,
				commitDate: `2026-04-0${i + 1}T10:00:00.000Z`,
				generatedAt: `2026-04-0${i + 1}T10:01:00.000Z`,
			});
		}
		mockGetIndex.mockResolvedValueOnce({ version: 3, entries });
		mockGetCatalog.mockResolvedValueOnce({ version: 1, entries: [] });
		const { stdout } = await runCommand([
			"q",
			"--limit",
			"2",
			"--format",
			"text",
			"--cwd",
			"/tmp/jolli-search-test-trunc",
		]);
		expect(stdout).toContain("(truncated)");
	});

	it("Phase 1 text format shows '(no commits matched)' on empty catalog", async () => {
		const { stdout } = await runCommand(["q", "--format", "text", "--cwd", "/tmp/jolli-search-test-none"]);
		expect(stdout).toContain("(no commits matched the filter)");
	});

	it("Phase 1 text format renders populated entries with all decorations", async () => {
		mockGetIndex.mockResolvedValueOnce({
			version: 3,
			entries: [
				{
					commitHash: "deadbeef00deadbeef00deadbeef00deadbeef00",
					parentCommitHash: null,
					branch: "feature/x",
					commitMessage: "msg",
					commitDate: "2026-04-01T10:00:00.000Z",
					generatedAt: "2026-04-01T10:01:00.000Z",
				},
			],
		});
		mockGetCatalog.mockResolvedValueOnce({
			version: 1,
			entries: [
				{
					commitHash: "deadbeef00deadbeef00deadbeef00deadbeef00",
					recap: "Recap line",
					ticketId: "PROJ-9",
					topics: [{ title: "Major Topic", category: "feature", importance: "major" }],
				},
			],
		});
		const { stdout } = await runCommand(["auth", "--format", "text", "--cwd", "/tmp/jolli-search-test-rendered"]);
		expect(stdout).toContain("Search catalog");
		expect(stdout).toContain("[PROJ-9]");
		expect(stdout).toContain("Recap line");
		expect(stdout).toContain("[feature]");
		expect(stdout).toContain("★");
	});

	it("non-Error thrown values are stringified safely in the catch path", async () => {
		mockGetSummary.mockImplementationOnce(async () => {
			throw "string error not an Error instance";
		});
		const { stdout } = await runCommand([
			"auth",
			"--hashes",
			"abcd1234abcd1234abcd1234abcd1234abcd1234",
			"--cwd",
			"/tmp/jolli-search-test-found",
		]);
		expect(stdout).toContain('"type":"error"');
		expect(stdout).toContain("string error");
	});
});
