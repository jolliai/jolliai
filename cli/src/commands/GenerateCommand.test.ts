import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as GitBranch from "../core/GitBranch.js";
import * as GitOps from "../core/GitOps.js";
import * as LlmClient from "../core/LlmClient.js";
import * as ReadStorageResolver from "../core/ReadStorageResolver.js";
import * as SessionTracker from "../core/SessionTracker.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import * as Summarizer from "../core/Summarizer.js";
import * as SummaryStore from "../core/SummaryStore.js";
import type { CommitSummary, E2eTestScenario, TopicSummary } from "../Types.js";
import * as CliUtils from "./CliUtils.js";
import { registerGenerateCommand } from "./GenerateCommand.js";

beforeEach(() => {
	process.exitCode = 0;
	vi.spyOn(SessionTracker, "loadConfig").mockResolvedValue({ apiKey: "sk-ant-test", model: "haiku" });
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

/** Runs `jolli generate <action>` capturing stdout; stdin comes from the CliUtils.readStdin spy. */
async function run(action: string): Promise<string> {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	const program = new Command();
	registerGenerateCommand(program);
	await program.parseAsync(["node", "jolli", "generate", action, "--cwd", "/repo"]);
	return logs.join("\n");
}

/** Stubs the stdin bridge with a raw request body. */
function stdin(raw: string): void {
	vi.spyOn(CliUtils, "readStdin").mockResolvedValue(raw);
}

/** Maps `git <args>` (space-joined) to canned results; unknown commands fail with exit 1. */
function mockGit(map: Record<string, string>): void {
	vi.spyOn(GitOps, "execGit").mockImplementation(async (args) => {
		const key = args.join(" ");
		return key in map
			? { stdout: map[key], stderr: "", exitCode: 0 }
			: { stdout: "", stderr: "unknown revision", exitCode: 1 };
	});
}

const topic = (title: string): TopicSummary => ({ title }) as unknown as TopicSummary;

describe("generate commit-message", () => {
	it("reads staged state from git and prints the generated message", async () => {
		mockGit({
			"diff --cached": "diff body",
			"diff --cached --name-only": "a.ts\n\n  b.ts  \n",
		});
		vi.spyOn(GitBranch, "getCurrentBranchSafe").mockReturnValue("feature/x");
		const gen = vi.spyOn(Summarizer, "generateCommitMessage").mockResolvedValue("Add feature");

		const out = await run("commit-message");

		expect(JSON.parse(out)).toEqual({ type: "commit-message", message: "Add feature" });
		expect(gen).toHaveBeenCalledWith({
			stagedDiff: "diff body",
			branch: "feature/x",
			stagedFiles: ["a.ts", "b.ts"],
			config: { apiKey: "sk-ant-test", model: "haiku" },
		});
		expect(process.exitCode).toBe(0);
	});

	it("prints a JSON error and sets exit code 1 when generation fails", async () => {
		mockGit({ "diff --cached": "", "diff --cached --name-only": "" });
		vi.spyOn(GitBranch, "getCurrentBranchSafe").mockReturnValue("main");
		vi.spyOn(Summarizer, "generateCommitMessage").mockRejectedValue(new Error("Anthropic API error 401"));

		const out = await run("commit-message");

		expect(JSON.parse(out)).toEqual({ type: "error", message: "Anthropic API error 401", errorName: "Error" });
		expect(process.exitCode).toBe(1);
	});
});

describe("generate squash-message", () => {
	it("string-merges subjects without touching storage when no LLM provider is configured", async () => {
		vi.spyOn(LlmClient, "resolveLlmCredentialSource").mockReturnValue(null);
		const getSummarySpy = vi.spyOn(SummaryStore, "getSummary");
		mockGit({
			"log -1 --pretty=format:%s aaaa1111": "Part of PROJ-1: Fix hook",
			"log -1 --pretty=format:%s bbbb2222": "Part of PROJ-1: Add tests",
			// cccc3333 is deliberately absent: an unknown hash contributes no subject.
		});
		stdin(JSON.stringify({ hashes: ["aaaa1111", "bbbb2222", "cccc3333"] }));

		const out = await run("squash-message");

		expect(JSON.parse(out)).toEqual({ type: "squash-message", message: "Part of PROJ-1: Fix hook; Add tests" });
		expect(getSummarySpy).not.toHaveBeenCalled();
	});

	it("collects topics + ticket from stored summaries and calls the LLM path", async () => {
		vi.spyOn(LlmClient, "resolveLlmCredentialSource").mockReturnValue("anthropic-config");
		vi.spyOn(ReadStorageResolver, "createReadStorage").mockResolvedValue({} as unknown as StorageProvider);
		vi.spyOn(SummaryStore, "getSummary").mockImplementation(async (hash) =>
			hash === "aaaa1111"
				? ({ topics: [{ title: "T1", trigger: "W1" }], ticketId: "PROJ-9" } as unknown as CommitSummary)
				: null,
		);
		mockGit({
			"log -1 --pretty=format:%s aaaa1111": "First subject",
			"log -1 --pretty=format:%s bbbb2222": "",
			"rev-list --count origin/main..HEAD": "5",
		});
		const gen = vi.spyOn(Summarizer, "generateSquashMessage").mockResolvedValue("Combined message");
		stdin(JSON.stringify({ hashes: ["aaaa1111", "bbbb2222"] }));

		const out = await run("squash-message");

		expect(JSON.parse(out)).toEqual({ type: "squash-message", message: "Combined message" });
		expect(gen).toHaveBeenCalledWith(
			expect.objectContaining({
				ticketId: "PROJ-9",
				isFullSquash: false,
				commits: [
					{ message: "First subject", topics: [{ title: "T1", trigger: "W1" }] },
					{ message: "(no message)", topics: [] },
				],
			}),
		);
	});

	it("falls back to string-merge when the LLM call fails, defaulting the branch count", async () => {
		vi.spyOn(LlmClient, "resolveLlmCredentialSource").mockReturnValue("anthropic-config");
		vi.spyOn(ReadStorageResolver, "createReadStorage").mockResolvedValue({} as unknown as StorageProvider);
		vi.spyOn(SummaryStore, "getSummary").mockResolvedValue(null);
		mockGit({
			"log -1 --pretty=format:%s aaaa1111": "Fix parser edge case",
			"log -1 --pretty=format:%s bbbb2222": "Add parser tests",
			// rev-list is absent → unparsable count → totalBranchCommits falls back
			// to hashes.length, classifying this squash as full.
		});
		const gen = vi.spyOn(Summarizer, "generateSquashMessage").mockRejectedValue(new Error("boom"));
		stdin(JSON.stringify({ hashes: ["aaaa1111", "bbbb2222"] }));

		const out = await run("squash-message");

		expect(JSON.parse(out)).toEqual({ type: "squash-message", message: "Fix parser edge case; Add parser tests" });
		expect(gen).toHaveBeenCalledWith(expect.objectContaining({ isFullSquash: true, ticketId: undefined }));
		expect(process.exitCode).toBe(0);
	});

	it("rejects a request without hashes", async () => {
		stdin(JSON.stringify({}));
		const out = await run("squash-message");
		expect(JSON.parse(out)).toEqual({
			type: "error",
			message: 'Request field "hashes" must be a non-empty array.',
			errorName: "Error",
		});
		expect(process.exitCode).toBe(1);
	});

	it("rejects an empty hashes array", async () => {
		stdin(JSON.stringify({ hashes: [] }));
		const out = await run("squash-message");
		expect(JSON.parse(out)).toMatchObject({ type: "error" });
		expect(process.exitCode).toBe(1);
	});

	it("rejects non-hex hashes", async () => {
		stdin(JSON.stringify({ hashes: ["$(rm -rf /)"] }));
		const out = await run("squash-message");
		expect(JSON.parse(out)).toEqual({
			type: "error",
			message: 'Request field "hashes" must contain hex commit hashes only.',
			errorName: "Error",
		});
		expect(process.exitCode).toBe(1);
	});
});

describe("generate e2e-test", () => {
	it("passes topics, commit message, and diff through to the generator", async () => {
		const scenarios: E2eTestScenario[] = [{ title: "t", steps: ["s1"], expectedResults: ["e1"] }];
		const gen = vi.spyOn(Summarizer, "generateE2eTest").mockResolvedValue(scenarios);
		stdin(JSON.stringify({ topics: [topic("T1")], commitMessage: "msg", diff: "diff body" }));

		const out = await run("e2e-test");

		expect(JSON.parse(out)).toEqual({
			type: "e2e-test",
			scenarios: [{ title: "t", steps: ["s1"], expectedResults: ["e1"] }],
		});
		expect(gen).toHaveBeenCalledWith(
			expect.objectContaining({ topics: [{ title: "T1" }], commitMessage: "msg", diff: "diff body" }),
		);
	});

	it("rejects a non-array topics field", async () => {
		stdin(JSON.stringify({ topics: "nope", commitMessage: "msg", diff: "" }));
		const out = await run("e2e-test");
		expect(JSON.parse(out)).toEqual({
			type: "error",
			message: 'Request field "topics" must be an array.',
			errorName: "Error",
		});
		expect(process.exitCode).toBe(1);
	});

	it("rejects a missing commitMessage field", async () => {
		stdin(JSON.stringify({ topics: [], diff: "" }));
		const out = await run("e2e-test");
		expect(JSON.parse(out)).toEqual({
			type: "error",
			message: 'Request field "commitMessage" must be a string.',
			errorName: "Error",
		});
		expect(process.exitCode).toBe(1);
	});
});

describe("generate recap", () => {
	it("passes topics and commit message through to the generator", async () => {
		const gen = vi.spyOn(Summarizer, "generateRecap").mockResolvedValue("A recap paragraph.");
		stdin(JSON.stringify({ topics: [topic("T1")], commitMessage: "msg" }));

		const out = await run("recap");

		expect(JSON.parse(out)).toEqual({ type: "recap", recap: "A recap paragraph." });
		expect(gen).toHaveBeenCalledWith(expect.objectContaining({ topics: [{ title: "T1" }], commitMessage: "msg" }));
	});

	it("treats an empty stdin body as an empty request and fails field validation", async () => {
		stdin("");
		const out = await run("recap");
		expect(JSON.parse(out)).toEqual({
			type: "error",
			message: 'Request field "topics" must be an array.',
			errorName: "Error",
		});
		expect(process.exitCode).toBe(1);
	});
});

describe("generate translate", () => {
	it("translates the given content", async () => {
		const gen = vi.spyOn(Summarizer, "translateToEnglish").mockResolvedValue("# Title");
		stdin(JSON.stringify({ content: "# Titre" }));

		const out = await run("translate");

		expect(JSON.parse(out)).toEqual({ type: "translate", text: "# Title" });
		expect(gen).toHaveBeenCalledWith(expect.objectContaining({ content: "# Titre" }));
	});

	it("stringifies a non-Error rejection", async () => {
		vi.spyOn(Summarizer, "translateToEnglish").mockRejectedValue("plain failure");
		stdin(JSON.stringify({ content: "x" }));
		const out = await run("translate");
		expect(JSON.parse(out)).toEqual({ type: "error", message: "plain failure", errorName: "Error" });
		expect(process.exitCode).toBe(1);
	});
});

describe("generate request/action validation", () => {
	it("rejects an unknown action", async () => {
		const out = await run("write-novel");
		const parsed = JSON.parse(out);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain('Unknown generate action "write-novel"');
		expect(process.exitCode).toBe(1);
	});

	it("rejects malformed JSON on stdin", async () => {
		stdin("not json at all");
		const out = await run("translate");
		expect(JSON.parse(out)).toMatchObject({ type: "error" });
		expect(process.exitCode).toBe(1);
	});

	it("rejects a JSON array as the top-level request body", async () => {
		stdin("[1, 2, 3]");
		const out = await run("translate");
		expect(JSON.parse(out)).toEqual({
			type: "error",
			message: "Request body must be a JSON object.",
			errorName: "Error",
		});
		expect(process.exitCode).toBe(1);
	});
});
