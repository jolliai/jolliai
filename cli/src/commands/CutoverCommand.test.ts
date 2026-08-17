/**
 * CutoverCommand — thin reporting over the engine/router; what's pinned here
 * is the mapping from each outcome to exit code and message, especially that
 * blocked/not-ready/drift set a non-zero exit (scripts gate on it).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../dashboard/CutoverEngine.js", () => ({
	runCutover: vi.fn(),
	probeCutoverDrift: vi.fn(),
	// Defaults to "no block", which is every state except the two import refusals.
	readCutoverBlock: vi.fn().mockResolvedValue(null),
	// The real sentinel, not a stand-in: the tip line filters on it, and a mock
	// leaving it `undefined` would make a branch-less source pass the filter and
	// print `git show :<path>`.
	NO_ORPHAN_TIP: "",
}));
vi.mock("../dashboard/CutoverRouter.js", () => ({
	resolveCutoverRoute: vi.fn(),
}));
vi.mock("../Logger.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, setLogDir: vi.fn() };
});

import { Command } from "commander";
import { probeCutoverDrift, readCutoverBlock, runCutover } from "../dashboard/CutoverEngine.js";
import { resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { registerCutoverCommand } from "./CutoverCommand.js";

async function run(...args: string[]): Promise<string[]> {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
		lines.push(line);
	});
	try {
		const program = new Command();
		program.exitOverride();
		registerCutoverCommand(program);
		await program.parseAsync(["node", "jolli", "cutover", "--cwd", "/repo", ...args]);
	} finally {
		spy.mockRestore();
	}
	return lines;
}

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = undefined;
});

describe("jolli cutover", () => {
	it("reports a committed cutover and asks for restarts", async () => {
		vi.mocked(runCutover).mockResolvedValue({
			status: "committed",
			record: { tips: {}, cutoverVersion: 3, committedAt: "t", schemaVersion: 1 },
			unreconciled: [],
		});
		const lines = await run();
		expect(lines.join("\n")).toContain("version 3");
		expect(lines.join("\n")).toContain("Restart IDEs");
		expect(process.exitCode).toBeUndefined();
	});

	it("not-ready and retry-exhausted exit non-zero with the reason", async () => {
		vi.mocked(runCutover).mockResolvedValue({ status: "not-ready", reason: "stale surfaces" });
		expect((await run()).join("\n")).toContain("stale surfaces");
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
		vi.mocked(runCutover).mockResolvedValue({ status: "retry-exhausted", reason: "tips kept moving" });
		expect((await run()).join("\n")).toContain("tips kept moving");
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
		vi.mocked(runCutover).mockResolvedValue({ status: "already-cutover" });
		expect((await run()).join("\n")).toContain("nothing to do");
		expect(process.exitCode).toBeUndefined();
	});

	it("prints the unreconciled note on commit AND on --status", async () => {
		// The record stores a CAPPED sample; the commit run also carries the full
		// set alongside it. Both are exercised here because they render
		// differently, and the difference is the point of carrying both.
		const all = ["summaries/a.json", "notes/b.md", ...Array.from({ length: 5 }, (_, i) => `plans/p${i}.md`)];
		const record = {
			tips: { "/repo": "a".repeat(40), "/clone2": "b".repeat(40) },
			cutoverVersion: 4,
			committedAt: "t",
			schemaVersion: 1,
			unreconciled: { count: 7, sample: ["summaries/a.json", "notes/b.md"] },
		};
		vi.mocked(runCutover).mockResolvedValue({ status: "committed", record, unreconciled: all });
		const committed = (await run()).join("\n");
		expect(committed).toContain("7 path(s) on the frozen branch");
		// EVERY path, not the record's two — each one is a `git show` argument the
		// user may need, and this run is the only place the whole set exists.
		for (const path of all) expect(committed).toContain(path);
		expect(committed).not.toContain("more");
		// The REAL tips, one runnable line per clone — this is the only place in
		// the product that prints them, so a placeholder here leaves the user with
		// no way to reach the frozen bytes the note is telling them about.
		expect(committed).toContain(`git -C "/repo" show ${"a".repeat(40)}:<path>`);
		expect(committed).toContain(`git -C "/clone2" show ${"b".repeat(40)}:<path>`);
		expect(committed).not.toContain("<frozen tip>");
		// A finding is not a failure — the switch happened.
		expect(process.exitCode).toBeUndefined();

		// The same note on a later status query: the run that first reported it
		// may have been an automatic one nobody watched. Here only the stored
		// sample exists, so the tail is acknowledged — and NOT by pointing at
		// `debug.log`, which renders through the same cap and therefore never
		// held the remainder either.
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "cutover", record });
		const status = (await run("--status")).join("\n");
		expect(status).toContain("7 path(s) on the frozen branch");
		expect(status).toContain("and 5 more");
		expect(status).not.toContain("debug.log");
	});

	it("offers no git line when every source froze nothing", async () => {
		// A repo with no orphan branch pins NO_ORPHAN_TIP, and `git show :<path>`
		// is not a command — better to print the findings and stop than to hand
		// the user a line that cannot run.
		vi.mocked(runCutover).mockResolvedValue({
			status: "committed",
			record: {
				tips: { "/repo": "" },
				cutoverVersion: 1,
				committedAt: "t",
				schemaVersion: 1,
				unreconciled: { count: 1, sample: ["summaries/a.json"] },
			},
			unreconciled: ["summaries/a.json"],
		});
		const out = (await run()).join("\n");
		expect(out).toContain("1 path(s) on the frozen branch");
		expect(out).not.toContain("git -C");
		expect(out).not.toContain("read one with");
	});

	it("says nothing about unreconciled paths when there are none", async () => {
		vi.mocked(runCutover).mockResolvedValue({
			status: "committed",
			record: { tips: {}, cutoverVersion: 1, committedAt: "t", schemaVersion: 1 },
			unreconciled: [],
		});
		expect((await run()).join("\n")).not.toContain("frozen branch");
	});

	it("--status renders each of the four states; blocked exits non-zero", async () => {
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover" });
		expect((await run("--status")).join("\n")).not.toContain("warning");
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover", warning: "db unreadable" });
		let out = (await run("--status")).join("\n");
		expect(out).toContain("uncutover");
		expect(out).toContain("db unreadable");
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "legacy-fenced" });
		expect((await run("--status")).join("\n")).toContain("finish the commit");
		vi.mocked(resolveCutoverRoute).mockResolvedValue({
			state: "cutover",
			record: { tips: {}, cutoverVersion: 2, committedAt: "T", schemaVersion: 1 },
		});
		expect((await run("--status")).join("\n")).toContain("version 2");
		expect(process.exitCode).toBeUndefined();
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "blocked", reason: "no database" });
		out = (await run("--status")).join("\n");
		expect(out).toContain("BLOCKED");
		expect(process.exitCode).toBe(1);
	});

	/**
	 * `uncutover` alone cannot distinguish "nothing has tried yet" from "the engine
	 * already refused, and will keep skipping until the branch changes" — and this
	 * command is where the sweep's warning sends the user to ask which it is.
	 */
	describe("--status reports a recorded block", () => {
		const BLOCK = {
			code: "stored-nothing" as const,
			reason: "the import stored nothing from /repo although its orphan tip lists artifacts",
			witness: "1.0.0|/repo@abc",
			at: Date.parse("2026-08-18T01:02:03.000Z"),
		};

		it("on uncutover, with the code, the date and the bypass", async () => {
			vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover" });
			vi.mocked(readCutoverBlock).mockResolvedValue(BLOCK);
			const out = (await run("--status")).join("\n");
			expect(out).toContain("blocked: the import stored nothing");
			expect(out).toContain("stored-nothing");
			expect(out).toContain("2026-08-18T01:02:03.000Z");
			expect(out).toContain("jolli cutover");
		});

		it("on legacy-fenced too — the CAS is still outstanding there", async () => {
			vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "legacy-fenced" });
			vi.mocked(readCutoverBlock).mockResolvedValue(BLOCK);
			expect((await run("--status")).join("\n")).toContain("blocked:");
		});

		it("but never on a repo that is already cut over — there is nothing to block", async () => {
			vi.mocked(resolveCutoverRoute).mockResolvedValue({
				state: "cutover",
				record: { tips: {}, cutoverVersion: 2, committedAt: "T", schemaVersion: 1 },
			});
			vi.mocked(readCutoverBlock).mockResolvedValue(BLOCK);
			expect((await run("--status")).join("\n")).not.toContain("blocked:");
		});

		it("and stays quiet when there is none", async () => {
			vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover" });
			vi.mocked(readCutoverBlock).mockResolvedValue(null);
			expect((await run("--status")).join("\n")).not.toContain("blocked:");
		});
	});

	it("--probe is quiet when clean and loud (non-zero) on drift", async () => {
		vi.mocked(probeCutoverDrift).mockResolvedValue([]);
		expect((await run("--probe")).join("\n")).toContain("no drift");
		expect(process.exitCode).toBeUndefined();
		vi.mocked(probeCutoverDrift).mockResolvedValue([
			{ root: "/r", recordedTip: "a".repeat(40), currentTip: "b".repeat(40) },
			{ root: "/gone", recordedTip: "a".repeat(40), currentTip: null },
		]);
		const out = (await run("--probe")).join("\n");
		expect(out).toContain("DRIFT in /r");
		expect(out).toContain("(unresolvable)");
		expect(out).toContain("bypassed the fence");
		expect(process.exitCode).toBe(1);
	});
});
