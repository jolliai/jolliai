import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudePlanScanner } from "./ClaudePlanScanner.js";

/**
 * A Claude transcript line carrying one Write/Edit `tool_use`.
 *
 * `filePathLiteral` is spliced in RAW rather than passed through `JSON.stringify`:
 * the escape sequences inside that literal are exactly what the scanner has to
 * decode, and re-encoding would hand it a different string than the one on disk.
 */
const writeTool = (filePathLiteral: string, name: "Write" | "Edit" = "Write"): string =>
	`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"${name}","input":{"file_path":"${filePathLiteral}","content":"x"}}]}}`;

let dir: string;
let transcript: string;
const cwd = "/work/repo";

const write = (...lines: string[]): void => writeFileSync(transcript, `${lines.join("\n")}\n`, "utf-8");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "claude-plan-scan-"));
	transcript = join(dir, "session.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ClaudePlanScanner", () => {
	it("keys a ~/.claude/plans/ write by slug rather than by path", async () => {
		write(writeTool("/Users/dev/.claude/plans/refactor-storage.md"));
		const res = await claudePlanScanner.scan(transcript, 0, cwd);
		expect([...res.slugs]).toEqual(["refactor-storage"]);
		expect(res.externalPlans.size).toBe(0);
	});

	it("collects any other .md write as an external plan path", async () => {
		write(writeTool("/work/repo/docs/design.md", "Edit"));
		const res = await claudePlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual(["/work/repo/docs/design.md"]);
		expect(res.slugs.size).toBe(0);
	});

	it("decodes every JSON escape in the captured path, unicode included", async () => {
		// The capture is a substring of a JSON string literal, so any escape the format
		// allows can appear. A plain backslash-unescape would leave `\u8bbe` verbatim.
		write(writeTool(String.raw`C:\\work\\\u8bbe\u8ba1.md`));
		const res = await claudePlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([String.raw`C:\work\设计.md`]);
	});

	it("drops a path whose escape sequence cannot be decoded", async () => {
		// `\x` is not a JSON escape, so the re-parse throws. Recording the raw, still
		// escaped substring instead would put a path that exists nowhere on disk into
		// the plan set, so skipping the target is the only honest option.
		write(writeTool(String.raw`/work/repo/bad\xescape.md`));
		const res = await claudePlanScanner.scan(transcript, 0, cwd);
		expect(res.externalPlans.size).toBe(0);
		expect(res.totalLines).toBe(1);
	});

	it("reads a plan-mode slug field on its own", async () => {
		write('{"type":"user","toolUseResult":{"plan":"...","slug":"pipeline-redesign"}}');
		const res = await claudePlanScanner.scan(transcript, 0, cwd);
		expect([...res.slugs]).toEqual(["pipeline-redesign"]);
	});

	it("ignores an empty slug field", async () => {
		// The cheap `includes` pre-filter admits it; the capture requires at least one
		// character, and a blank slug would key a plan file that cannot be resolved.
		write('{"type":"user","toolUseResult":{"slug":""}}');
		const res = await claudePlanScanner.scan(transcript, 0, cwd);
		expect(res.slugs.size).toBe(0);
	});

	it("honours the fromLine / toLine window and still reports the full line count", async () => {
		// `totalLines` is the caller's cursor, so it counts every line the stream
		// yielded — not just the ones the window admitted.
		write(writeTool("/a/one.md"), writeTool("/a/two.md"), writeTool("/a/three.md"), writeTool("/a/four.md"));
		const res = await claudePlanScanner.scan(transcript, 1, cwd, 3);
		expect([...res.externalPlans].sort()).toEqual(["/a/three.md", "/a/two.md"]);
		expect(res.totalLines).toBe(4);
	});

	it("ignores a Write to a non-markdown target", async () => {
		write(writeTool("/work/repo/src/index.ts"));
		const res = await claudePlanScanner.scan(transcript, 0, cwd);
		expect(res.externalPlans.size).toBe(0);
		expect(res.slugs.size).toBe(0);
	});

	it("ignores a .md file_path belonging to a tool other than Write/Edit", async () => {
		// Reading a plan is not writing one; only the two mutating tools count.
		write(
			'{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/work/repo/docs/design.md"}}]}}',
		);
		const res = await claudePlanScanner.scan(transcript, 0, cwd);
		expect(res.externalPlans.size).toBe(0);
	});
});
