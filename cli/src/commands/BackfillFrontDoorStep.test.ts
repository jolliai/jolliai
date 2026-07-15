import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackfillReport, MissingCommitInfo } from "../backfill/BackfillEngine.js";
import { runBackfillFrontDoorStep } from "./BackfillFrontDoorStep.js";

const h = vi.hoisted(() => ({
	loadConfig: vi.fn(),
	resolveLlmCredentialSource: vi.fn(),
	readRepoProfile: vi.fn(),
	updateRepoProfile: vi.fn(),
	listMissingCommits: vi.fn(),
	repoHasAnyMemory: vi.fn(),
	runBackfill: vi.fn(),
	promptText: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({ loadConfig: h.loadConfig }));
vi.mock("../core/LlmClient.js", () => ({ resolveLlmCredentialSource: h.resolveLlmCredentialSource }));
vi.mock("../core/RepoProfile.js", () => ({
	readRepoProfile: h.readRepoProfile,
	updateRepoProfile: h.updateRepoProfile,
}));
vi.mock("../backfill/BackfillEngine.js", () => ({
	listMissingCommits: h.listMissingCommits,
	repoHasAnyMemory: h.repoHasAnyMemory,
	runBackfill: h.runBackfill,
}));
vi.mock("./CliUtils.js", () => ({ promptText: h.promptText }));

const CWD = "/repo";

function commit(hash: string, subject: string, ts = 0): MissingCommitInfo {
	return { commitHash: hash, subject, ts };
}

function report(over: Partial<BackfillReport> = {}): BackfillReport {
	return { total: 0, generated: 0, skipped: 0, errors: 0, outcomes: [], ...over };
}

describe("runBackfillFrontDoorStep", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	const loggedText = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		// Defaults for the happy path; individual tests override.
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant" });
		h.resolveLlmCredentialSource.mockReturnValue("anthropic");
		h.readRepoProfile.mockResolvedValue({});
		h.repoHasAnyMemory.mockResolvedValue(true);
		h.listMissingCommits.mockResolvedValue([commit("a1b2c3d4", "Add branch-match tier")]);
		h.runBackfill.mockResolvedValue(report({ total: 1, generated: 1 }));
		h.promptText.mockResolvedValue(""); // Enter → yes
	});

	afterEach(() => {
		logSpy.mockRestore();
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("stays silent and offers nothing when there is no LLM credential", async () => {
		h.resolveLlmCredentialSource.mockReturnValue(null);
		await runBackfillFrontDoorStep(CWD);
		expect(h.listMissingCommits).not.toHaveBeenCalled();
		expect(h.promptText).not.toHaveBeenCalled();
	});

	it("does not offer when the repo was permanently dismissed", async () => {
		h.readRepoProfile.mockResolvedValue({ backfillDismissed: true });
		await runBackfillFrontDoorStep(CWD);
		expect(h.listMissingCommits).not.toHaveBeenCalled();
		expect(h.promptText).not.toHaveBeenCalled();
	});

	it("does not prompt when there are no missing commits", async () => {
		h.listMissingCommits.mockResolvedValue([]);
		await runBackfillFrontDoorStep(CWD);
		expect(h.repoHasAnyMemory).not.toHaveBeenCalled();
		expect(h.promptText).not.toHaveBeenCalled();
	});

	it("shows the empty-repo headline and the commit list", async () => {
		h.repoHasAnyMemory.mockResolvedValue(false);
		h.listMissingCommits.mockResolvedValue([commit("a1b2c3d4", "Add tier"), commit("e5f6a7b8", "Fix worker")]);
		h.promptText.mockResolvedValue("n"); // don't actually build
		await runBackfillFrontDoorStep(CWD);
		const out = loggedText();
		expect(out).toContain("no memories yet");
		expect(out).toContain("a1b2c3d");
		expect(out).toContain("Add tier");
		expect(out).toContain("e5f6a7b");
	});

	it("shows the gaps headline with the missing count", async () => {
		h.repoHasAnyMemory.mockResolvedValue(true);
		h.listMissingCommits.mockResolvedValue([commit("a1b2c3d4", "One"), commit("e5f6a7b8", "Two")]);
		h.promptText.mockResolvedValue("n");
		await runBackfillFrontDoorStep(CWD);
		const out = loggedText();
		expect(out).toContain("2 commits from the last month don't have a memory yet");
	});

	it("uses singular wording in the gaps headline for a single missing commit", async () => {
		h.repoHasAnyMemory.mockResolvedValue(true);
		h.listMissingCommits.mockResolvedValue([commit("a1b2c3d4", "Only one")]);
		h.promptText.mockResolvedValue("n");
		await runBackfillFrontDoorStep(CWD);
		expect(loggedText()).toContain("1 commit from the last month doesn't have a memory yet");
	});

	it("appends a cap note when the list is capped at COLD_START_CAP", async () => {
		h.listMissingCommits.mockResolvedValue(Array.from({ length: 10 }, (_, i) => commit(`hash${i}xxx`, `s${i}`)));
		h.promptText.mockResolvedValue("n");
		await runBackfillFrontDoorStep(CWD);
		expect(loggedText()).toContain("showing the 10 most recent");
	});

	it("builds with progress and reports success when the user accepts", async () => {
		h.listMissingCommits.mockResolvedValue([commit("a1b2c3d4", "Add tier"), commit("e5f6a7b8", "Fix worker")]);
		h.promptText.mockResolvedValue("y");
		h.runBackfill.mockImplementation(async (opts) => {
			opts.onCommitStart?.(1, 2, "a1b2c3d4", "Add tier");
			opts.onCommitStart?.(2, 2, "e5f6a7b8", "Fix worker");
			return report({ total: 2, generated: 2 });
		});
		await runBackfillFrontDoorStep(CWD);
		expect(h.runBackfill).toHaveBeenCalledTimes(1);
		expect(h.runBackfill.mock.calls[0][0].hashes).toEqual(["a1b2c3d4", "e5f6a7b8"]);
		// The AbortSignal must actually be threaded into the engine — otherwise Ctrl-C
		// could not cancel a real run even though the local handler fires.
		expect(h.runBackfill.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
		// Each commit is its own persistent line (not an in-place rewrite): both survive.
		expect(loggedText()).toContain("1/2  Add tier");
		expect(loggedText()).toContain("2/2  Fix worker");
		expect(loggedText()).toContain("Built 2 memories from your history");
	});

	it("renders progress with a truncated long subject and falls back to the hash when a subject is missing", async () => {
		h.promptText.mockResolvedValue("y");
		const longSubject = "x".repeat(120);
		h.runBackfill.mockImplementation(async (opts) => {
			opts.onCommitStart?.(1, 2, "a1b2c3d4", longSubject);
			opts.onCommitStart?.(2, 2, "e5f6a7b8ffff", undefined); // no subject → hash
			return report({ total: 2, generated: 2 });
		});
		await runBackfillFrontDoorStep(CWD);
		const out = loggedText();
		expect(out).toContain("…"); // long subject was truncated
		expect(out).toContain("e5f6a7b"); // missing subject → short hash
	});

	it("reports a friendly failure when the back-fill run rejects with a non-Error value", async () => {
		h.promptText.mockResolvedValue("y");
		h.runBackfill.mockRejectedValue("stringly-typed failure");
		await runBackfillFrontDoorStep(CWD);
		expect(loggedText()).toContain("Couldn't build memories right now");
	});

	it("uses singular wording for a single built memory", async () => {
		h.promptText.mockResolvedValue("");
		h.runBackfill.mockResolvedValue(report({ total: 1, generated: 1 }));
		await runBackfillFrontDoorStep(CWD);
		expect(loggedText()).toContain("Built 1 memory from your history");
	});

	it("skips without building or dismissing on 'not now'", async () => {
		h.promptText.mockResolvedValue("n");
		await runBackfillFrontDoorStep(CWD);
		expect(h.runBackfill).not.toHaveBeenCalled();
		expect(h.updateRepoProfile).not.toHaveBeenCalled();
		expect(loggedText()).toContain("run `jolli` again anytime");
	});

	it("records a sticky dismiss on 'don't ask again'", async () => {
		h.promptText.mockResolvedValue("d");
		await runBackfillFrontDoorStep(CWD);
		expect(h.updateRepoProfile).toHaveBeenCalledWith(CWD, { backfillDismissed: true });
		expect(h.runBackfill).not.toHaveBeenCalled();
		expect(loggedText()).toContain("won't ask again");
	});

	it("treats an unrecognized answer as 'not now' (no build, no dismiss)", async () => {
		h.promptText.mockResolvedValue("maybe later");
		await runBackfillFrontDoorStep(CWD);
		expect(h.runBackfill).not.toHaveBeenCalled();
		expect(h.updateRepoProfile).not.toHaveBeenCalled();
	});

	it("swallows a cold-start detection failure without prompting", async () => {
		h.listMissingCommits.mockRejectedValue(new Error("git blew up"));
		await expect(runBackfillFrontDoorStep(CWD)).resolves.toBeUndefined();
		expect(h.promptText).not.toHaveBeenCalled();
	});

	it("reports a Ctrl-C interruption as stopped-and-resumable", async () => {
		h.promptText.mockResolvedValue("y");
		let seenSignal: AbortSignal | undefined;
		h.runBackfill.mockImplementation(async (opts) => {
			// Simulate the user pressing Ctrl-C mid-run: the step's SIGINT handler is
			// registered by now, so this aborts the controller it passed in.
			seenSignal = opts.signal;
			process.emit("SIGINT");
			return report({ total: 3, generated: 1 });
		});
		await runBackfillFrontDoorStep(CWD);
		// The real handler must have aborted the very signal handed to the engine.
		expect(seenSignal?.aborted).toBe(true);
		expect(loggedText()).toContain("Stopped — 1 memory built and saved");
	});

	it("still confirms the dismiss even if persisting the flag fails", async () => {
		h.promptText.mockResolvedValue("d");
		h.updateRepoProfile.mockRejectedValue(new Error("disk full"));
		await expect(runBackfillFrontDoorStep(CWD)).resolves.toBeUndefined();
		expect(loggedText()).toContain("won't ask again");
	});

	it("a second Ctrl-C forces a hard exit (code 130)", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		h.promptText.mockResolvedValue("y");
		h.runBackfill.mockImplementation(async () => {
			process.emit("SIGINT"); // 1st → cooperative abort
			process.emit("SIGINT"); // 2nd → hard exit
			return report({ total: 3, generated: 1 });
		});
		await runBackfillFrontDoorStep(CWD);
		expect(exitSpy).toHaveBeenCalledWith(130);
		exitSpy.mockRestore();
	});

	it("reports a friendly failure when the back-fill run throws", async () => {
		h.promptText.mockResolvedValue("y");
		h.runBackfill.mockRejectedValue(new Error("storage down"));
		await runBackfillFrontDoorStep(CWD);
		expect(loggedText()).toContain("Couldn't build memories right now");
	});

	it("tolerates a repo-profile read failure and still offers", async () => {
		h.readRepoProfile.mockRejectedValue(new Error("fs error"));
		h.promptText.mockResolvedValue("n");
		await runBackfillFrontDoorStep(CWD);
		// Read failed → treated as not-dismissed → still detects + prompts.
		expect(h.promptText).toHaveBeenCalled();
	});
});
