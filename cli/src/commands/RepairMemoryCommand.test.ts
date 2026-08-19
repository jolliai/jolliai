import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/repair/RepairPlan.js", () => ({ buildRepairPlan: vi.fn() }));
vi.mock("../core/repair/RepairExecutor.js", () => ({ executeRepairs: vi.fn() }));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: vi.fn() }));
vi.mock("../core/StorageFactory.js", () => ({ createStorage: vi.fn() }));
vi.mock("../core/SummaryStore.js", () => ({ setActiveStorage: vi.fn() }));
vi.mock("../Logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../Logger.js")>();
	return { ...actual, setLogDir: vi.fn() };
});

import { readManualDisableFlag } from "../core/RepoProfile.js";
import { executeRepairs } from "../core/repair/RepairExecutor.js";
import { buildRepairPlan } from "../core/repair/RepairPlan.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { setLogDir } from "../Logger.js";
import { registerRepairMemoryCommand } from "./RepairMemoryCommand.js";

function program(): Command {
	const p = new Command();
	p.exitOverride();
	registerRepairMemoryCommand(p);
	return p;
}

async function run(...args: string[]): Promise<string[]> {
	const lines: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	});
	try {
		await program().parseAsync(["node", "jolli", "repair-memory", "--cwd", "/repo", ...args]);
	} finally {
		log.mockRestore();
	}
	return lines;
}

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = undefined;
	vi.mocked(readManualDisableFlag).mockResolvedValue(false);
	vi.mocked(createStorage).mockResolvedValue({ kind: "configured" } as never);
});

describe("repair-memory", () => {
	it("establishes the configured backend before reading or writing anything", async () => {
		// Without this every store call falls through resolveStorage to the system
		// of record, bypassing DualWriteStorage — so on an uncutover repo the
		// Memory Bank copy silently misses every repaired tree. It must land
		// BEFORE buildRepairPlan, which reads.
		vi.mocked(buildRepairPlan).mockResolvedValue([] as never);

		await run();

		expect(createStorage).toHaveBeenCalledWith("/repo", "/repo");
		expect(setActiveStorage).toHaveBeenCalledWith({ kind: "configured" });
		expect(vi.mocked(setActiveStorage).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(buildRepairPlan).mock.invocationCallOrder[0] as number,
		);
	});

	it("reports an unavailable backend as a message, not a stack trace", async () => {
		// createStorage throws for a `blocked` cutover state. That is a rejected
		// precondition, so it must not reach Cli.ts's top-level handler.
		vi.mocked(createStorage).mockRejectedValue(new Error("cutover is blocked"));
		const err = vi.spyOn(console, "error").mockImplementation(() => {});

		await run();

		expect(err).toHaveBeenCalledWith("cutover is blocked");
		expect(process.exitCode).toBe(1);
		expect(buildRepairPlan).not.toHaveBeenCalled();
		err.mockRestore();
	});

	it("sets the log dir to --cwd, not process.cwd(), so repair log lines land in the right project", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([] as never);

		await run("--status");

		expect(setLogDir).toHaveBeenCalledWith("/repo");
	});

	it("--status reports without executing", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{
				kind: "remount",
				targetHash: "newhash1",
				targetSubject: "the target commit",
				source: {
					oldHash: "oldhash1",
					root: { commitMessage: "the stranded commit" },
					conversationCount: 26,
					skillCount: 7,
				},
			},
		] as never);

		const lines = await run("--status");

		expect(executeRepairs).not.toHaveBeenCalled();
		expect(lines.join("\n")).toMatch(/26 conversation/);
	});

	it("repairs by default", async () => {
		// `executeRepairs` returns outcomes carrying the SAME action reference it
		// was handed (see `RepairExecutor.ts`) — reuse the plan's own action here
		// rather than a fresh literal, matching that real contract.
		const action = {
			kind: "remount",
			targetHash: "n",
			targetSubject: "t",
			source: { oldHash: "o", root: { commitMessage: "m" }, conversationCount: 0, skillCount: 0 },
		};
		vi.mocked(buildRepairPlan).mockResolvedValue([action] as never);
		vi.mocked(executeRepairs).mockResolvedValue([{ action, ok: true }] as never);

		await run();

		expect(executeRepairs).toHaveBeenCalledOnce();
	});

	it("passes useLlm false for --no-llm", async () => {
		const action = { kind: "migrate", targetHash: "n", targetSubject: "t", sources: [], needsLlm: true };
		vi.mocked(buildRepairPlan).mockResolvedValue([action] as never);
		vi.mocked(executeRepairs).mockResolvedValue([{ action, ok: true }] as never);

		await run("--no-llm");

		expect(vi.mocked(executeRepairs).mock.calls[0]?.[2]).toMatchObject({ useLlm: false });
	});

	it("renders an unpaired action with its reason and the --from/--to hint", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{
				kind: "unpaired",
				source: {
					oldHash: "abcdef1234",
					root: { commitMessage: "a stranded commit" },
					conversationCount: 1,
					skillCount: 0,
				},
				reason: "conflict",
			},
		] as never);

		const lines = await run("--status");

		expect(lines.join("\n")).toContain("abcdef12: no target (conflict) — pass --from/--to");
	});

	it("renders an unsupported action by printing its reason verbatim, not paraphrasing it", async () => {
		const reason =
			"2 stranded trees pair to newtarge, which already has its own memory; remounting several trees onto one target is not supported";
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{ kind: "unsupported", targetHash: "newtargethash", targetSubject: "t", sources: [], reason },
		] as never);

		const lines = await run("--status");

		expect(lines.join("\n")).toContain(reason);
	});

	it("reports a migrate action's per-source totals and marks it as calling the LLM", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{
				kind: "migrate",
				targetHash: "targethash1",
				targetSubject: "the target commit subject",
				needsLlm: true,
				sources: [
					{
						oldHash: "a1source",
						root: { commitMessage: "first stranded subject" },
						conversationCount: 3,
						skillCount: 1,
					},
					{
						oldHash: "b1source",
						root: { commitMessage: "second stranded subject" },
						conversationCount: 5,
						skillCount: 2,
					},
				],
			},
		] as never);

		const lines = await run("--status");

		const out = lines.join("\n");
		// Both ends of every pairing, so the user can review it before it is
		// written — the count alone named neither.
		expect(out).toContain("migrate → targetha  the target commit subject");
		expect(out).toContain("← a1source  first stranded subject");
		expect(out).toContain("← b1source  second stranded subject");
		expect(out).toContain("restores 8 conversation(s), 3 skill(s) [calls the LLM]");
	});

	it("omits the LLM tag for a single-source migrate", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{
				kind: "migrate",
				targetHash: "targethash1",
				targetSubject: "t",
				needsLlm: false,
				sources: [{ oldHash: "a1", root: { commitMessage: "m" }, conversationCount: 3, skillCount: 1 }],
			},
		] as never);

		const lines = await run("--status");

		expect(lines.join("\n")).toContain("restores 3 conversation(s), 1 skill(s)");
		expect(lines.join("\n")).not.toContain("[calls the LLM]");
	});

	it("passes --from/--to together as an override to buildRepairPlan", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([] as never);

		await run("--from", "abc123", "--to", "def456");

		expect(buildRepairPlan).toHaveBeenCalledWith("/repo", { from: "abc123", to: "def456" });
	});

	it("prints outcomes and exits non-zero when a repair fails", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{
				kind: "remount",
				targetHash: "n",
				targetSubject: "t",
				source: { oldHash: "o", root: { commitMessage: "m" }, conversationCount: 0, skillCount: 0 },
			},
		] as never);
		vi.mocked(executeRepairs).mockResolvedValue([
			{
				action: {
					kind: "remount",
					targetHash: "n",
					targetSubject: "t",
					source: { oldHash: "o", root: { commitMessage: "m" }, conversationCount: 0, skillCount: 0 },
				},
				ok: false,
				error: "boom",
			},
		] as never);

		const lines = await run();

		expect(lines.join("\n")).toContain("✗ boom");
		expect(process.exitCode).toBe(1);
	});

	it("requires --from and --to together", async () => {
		const lines: string[] = [];
		const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		try {
			await program().parseAsync(["node", "jolli", "repair-memory", "--cwd", "/repo", "--from", "abc"]);
		} finally {
			err.mockRestore();
		}
		expect(buildRepairPlan).not.toHaveBeenCalled();
		expect(lines.join("\n")).toContain("--from and --to must be given together");
		expect(process.exitCode).toBe(1);
	});

	it("refuses to repair a manually-disabled repo, and never calls buildRepairPlan", async () => {
		vi.mocked(readManualDisableFlag).mockResolvedValue(true);
		const errLines: string[] = [];
		const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			errLines.push(a.map(String).join(" "));
		});
		try {
			await run();
		} finally {
			err.mockRestore();
		}

		expect(buildRepairPlan).not.toHaveBeenCalled();
		expect(executeRepairs).not.toHaveBeenCalled();
		expect(errLines.join("\n")).toContain("manually disabled");
		expect(errLines.join("\n")).toContain("jolli enable");
		expect(process.exitCode).toBe(1);
	});

	it("still reports on --status even when the repo is manually disabled (read-only)", async () => {
		vi.mocked(readManualDisableFlag).mockResolvedValue(true);
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{
				kind: "remount",
				targetHash: "n",
				targetSubject: "t",
				source: { oldHash: "o", root: { commitMessage: "m" }, conversationCount: 1, skillCount: 0 },
			},
		] as never);

		const lines = await run("--status");

		expect(buildRepairPlan).toHaveBeenCalledOnce();
		expect(lines.join("\n")).toMatch(/remount/);
	});

	it("renders a source whose stored summary carries no commit message", async () => {
		// The subject is read off the STORED summary, which a very old memory may
		// not have — the row must still be reviewable rather than blank.
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{
				kind: "migrate",
				targetHash: "targethash1",
				targetSubject: null,
				needsLlm: false,
				sources: [{ oldHash: "a1source", root: {}, conversationCount: 0, skillCount: 0 }],
			},
		] as never);

		const lines = await run("--status");

		expect(lines.join("\n")).toContain("migrate → targetha  (no commit message)");
		expect(lines.join("\n")).toContain("← a1source  (no commit message)");
	});

	it("reports 'no stranded memory trees' when the plan is empty", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([] as never);

		const lines = await run("--status");

		expect(lines.join("\n")).toContain("No stranded memory trees.");
		expect(executeRepairs).not.toHaveBeenCalled();
	});

	// `buildRepairPlan` throws for rejected user input (`--from` matching
	// nothing, an unresolvable or unreachable `--to`). Letting it escape
	// reaches `Cli.ts`'s handler, which renders it as
	// `Fatal error: Error: <message>` plus a stack -- a fault report for an
	// argument the tool is deliberately refusing.
	it("prints a bad --from/--to as a plain message, not a fatal stack trace", async () => {
		vi.mocked(buildRepairPlan).mockRejectedValue(new Error("no stranded memory tree found for abc"));
		const errors: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			errors.push(a.map(String).join(" "));
		});

		await run("--from", "abc", "--to", "def");

		spy.mockRestore();
		expect(errors).toEqual(["no stranded memory tree found for abc"]);
		expect(process.exitCode).toBe(1);
		expect(executeRepairs).not.toHaveBeenCalled();
	});
});
