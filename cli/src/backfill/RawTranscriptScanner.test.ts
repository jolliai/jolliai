import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cwdInRoots, relativizeUnderCwd, scanClaudeTranscripts } from "./RawTranscriptScanner.js";

describe("relativizeUnderCwd", () => {
	it("returns the path relative to cwd in forward-slash form", () => {
		expect(relativizeUnderCwd("e:/repo/src/foo.ts", "e:/repo")).toBe("src/foo.ts");
		expect(relativizeUnderCwd("e:\\repo\\src\\foo.ts", "e:\\repo")).toBe("src/foo.ts");
	});
	it("is case-insensitive on the cwd prefix but preserves case in the slice", () => {
		expect(relativizeUnderCwd("E:/Repo/Src/Foo.ts", "e:/repo")).toBe("Src/Foo.ts");
	});
	it("returns null when the path is not under cwd, and '' when equal", () => {
		expect(relativizeUnderCwd("e:/other/x.ts", "e:/repo")).toBeNull();
		expect(relativizeUnderCwd("e:/repo", "e:/repo")).toBe("");
		expect(relativizeUnderCwd("e:/repo/x.ts", undefined)).toBeNull();
	});
});

describe("cwdInRoots", () => {
	it("accepts cwd equal to or nested under a root", () => {
		const pred = cwdInRoots(["e:/repo", "e:/wt2"]);
		expect(pred("e:/repo")).toBe(true);
		expect(pred("e:/repo/sub")).toBe(true);
		expect(pred("E:\\WT2")).toBe(true);
		expect(pred("e:/elsewhere")).toBe(false);
		expect(pred(undefined)).toBe(false);
	});
});

describe("scanClaudeTranscripts", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bf-scan-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeProject(name: string, file: string, lines: object[]): void {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, file), `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot-json\n`);
	}

	const base = (over: object) => ({
		timestamp: "2026-06-01T00:00:00.000Z",
		cwd: "e:/repo",
		gitBranch: "feat",
		sessionId: "S1",
		...over,
	});

	it("parses edits and conversational turns; filters by cwd; sorts by ts", () => {
		writeProject("proj", "S1.jsonl", [
			base({ timestamp: "2026-06-01T00:02:00.000Z", type: "user", message: { role: "user", content: "hello" } }),
			base({
				timestamp: "2026-06-01T00:01:00.000Z",
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "editing foo" },
						{ type: "tool_use", name: "Edit", input: { file_path: "e:/repo/src/foo.ts" } },
					],
				},
			}),
			// cwd outside the repo → filtered out
			base({ cwd: "e:/other", type: "user", message: { role: "user", content: "ignored" } }),
		]);

		return scanClaudeTranscripts(cwdInRoots(["e:/repo"]), root).then((bySession) => {
			const entries = bySession.get("S1");
			expect(entries).toBeDefined();
			// 2 in-repo signal lines (the e:/other one is filtered, the "not-json" skipped)
			expect(entries).toHaveLength(2);
			// sorted ascending by ts: 00:01 (edit), 00:02 (hello)
			expect(entries?.[0].editedRel).toEqual(["src/foo.ts"]);
			expect(entries?.[0].editedBase).toEqual(["foo.ts"]);
			expect(entries?.[1].content).toBe("hello");
		});
	});

	it("keeps an edit line that has no timestamp (sorted last) without crashing", async () => {
		writeProject("proj", "S2.jsonl", [
			{
				cwd: "e:/repo",
				gitBranch: "feat",
				sessionId: "S2",
				type: "assistant",
				// no timestamp field
				message: {
					role: "assistant",
					content: [{ type: "tool_use", name: "Edit", input: { file_path: "e:/repo/x.ts" } }],
				},
			},
			{
				timestamp: "2026-06-01T00:00:00.000Z",
				cwd: "e:/repo",
				gitBranch: "feat",
				sessionId: "S2",
				type: "user",
				message: { role: "user", content: "later turn" },
			},
		]);
		const bySession = await scanClaudeTranscripts(cwdInRoots(["e:/repo"]), root);
		const entries = bySession.get("S2");
		expect(entries).toHaveLength(2);
		// The timestamped entry sorts before the NaN-timestamp edit line.
		expect(entries?.[0].content).toBe("later turn");
		expect(Number.isNaN(entries?.[1].tsMs ?? 0)).toBe(true);
	});

	it("handles non-edit tools, non-commit Bash, and edits outside cwd", async () => {
		writeProject("proj", "S3.jsonl", [
			base({
				timestamp: "2026-06-01T00:01:00.000Z",
				sessionId: "S3",
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", name: "Read", input: { file_path: "e:/repo/r.ts" } }, // not an edit
						{ type: "tool_use", name: "Bash", input: { command: "npm test" } }, // not a git commit
						{ type: "tool_use", name: "Edit", input: { file_path: "/elsewhere/out.ts" } }, // outside cwd → fallback
						{ type: "tool_use", name: "Edit", input: {} }, // missing file_path → ignored
						{ type: "not_a_block" },
					],
				},
			}),
		]);
		const bySession = await scanClaudeTranscripts(cwdInRoots(["e:/repo"]), root);
		const e = bySession.get("S3")?.[0];
		expect(e).toBeDefined();
		// Only the out-of-cwd edit registers, kept as a forward-slashed absolute path.
		expect(e?.editedRel).toEqual(["/elsewhere/out.ts"]);
	});

	it("breaks ts ties by line order and parses string message content", async () => {
		writeProject("proj", "S4.jsonl", [
			base({
				timestamp: "2026-06-01T00:00:00.000Z",
				sessionId: "S4",
				type: "user",
				message: { role: "user", content: "first" },
			}),
			// same timestamp → tiebreak on lineNo; string content (not array)
			base({
				timestamp: "2026-06-01T00:00:00.000Z",
				sessionId: "S4",
				type: "user",
				message: { role: "user", content: "second" },
			}),
		]);
		const entries = (await scanClaudeTranscripts(cwdInRoots(["e:/repo"]), root)).get("S4");
		expect(entries?.map((e) => e.content)).toEqual(["first", "second"]);
	});

	it("drops signal-less lines and orders two timestamp-less entries by line", async () => {
		writeProject("proj", "S5.jsonl", [
			// no message, no timestamp, no tool → signal-less → dropped
			{ cwd: "e:/repo", sessionId: "S5", type: "system", foo: "bar" },
			// two edit-only lines without timestamps → both NaN → tiebreak on lineNo
			{
				cwd: "e:/repo",
				sessionId: "S5",
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", name: "Edit", input: { file_path: "e:/repo/a.ts" } }],
				},
			},
			{
				cwd: "e:/repo",
				sessionId: "S5",
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", name: "Edit", input: { file_path: "e:/repo/b.ts" } }],
				},
			},
		]);
		const entries = (await scanClaudeTranscripts(cwdInRoots(["e:/repo"]), root)).get("S5");
		expect(entries).toHaveLength(2); // signal-less line dropped
		expect(entries?.[0].editedRel).toEqual(["a.ts"]);
		expect(entries?.[1].editedRel).toEqual(["b.ts"]);
	});

	it("returns an empty map when the projects root does not exist", async () => {
		const bySession = await scanClaudeTranscripts(() => true, join(root, "nope"));
		expect(bySession.size).toBe(0);
	});

	it("skips an unreadable transcript path without aborting the scan", async () => {
		const dir = join(root, "proj");
		mkdirSync(dir, { recursive: true });
		// A directory named like a transcript → readFile throws EISDIR → caught + skipped.
		mkdirSync(join(dir, "weird.jsonl"));
		const bySession = await scanClaudeTranscripts(() => true, root);
		expect(bySession.size).toBe(0);
	});

	it("skips non-jsonl files and unreadable dirs gracefully", async () => {
		mkdirSync(join(root, "proj"), { recursive: true });
		writeFileSync(join(root, "proj", "notes.txt"), "ignore me");
		writeFileSync(join(root, "loose.jsonl"), "ignored-at-root");
		const bySession = await scanClaudeTranscripts(() => true, root);
		expect(bySession.size).toBe(0);
	});
});
