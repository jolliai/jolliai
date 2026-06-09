import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexPlanScanner } from "./CodexPlanScanner.js";

// A Codex apply_patch transcript line: payload.input carries the raw patch text.
const applyPatch = (input: string): string =>
	JSON.stringify({
		type: "response_item",
		timestamp: "2026-06-08T00:00:00.000Z",
		payload: { type: "custom_tool_call", name: "apply_patch", call_id: "c1", input },
	});

const patch = (...bodyLines: string[]): string => ["*** Begin Patch", ...bodyLines, "*** End Patch"].join("\n");

let dir: string;
let transcript: string;
const cwd = "/work/repo";

const write = (...lines: string[]): void => writeFileSync(transcript, `${lines.join("\n")}\n`, "utf-8");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codex-plan-scan-"));
	transcript = join(dir, "rollout.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CodexPlanScanner", () => {
	it("collects Add File .md as an absolute external path; slugs stays empty", async () => {
		write(applyPatch(patch("*** Add File: docs/a.md", "+# Plan A")));
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/a.md")]);
		expect(res.slugs.size).toBe(0);
		expect(res.totalLines).toBe(1);
	});

	it("collects Update File .md and ignores Delete File and non-.md targets", async () => {
		write(
			applyPatch(
				patch(
					"*** Update File: b.md",
					"*** Delete File: c.md",
					"*** Update File: src/x.ts",
					"*** Add File: .jolli/jollimemory/plans.json",
				),
			),
		);
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "b.md")]);
	});

	it("collects Move to .md target; a stale Update source is also collected (driver existsSync filters it)", async () => {
		write(applyPatch(patch("*** Update File: docs/a.md", "*** Move to: docs/b.md")));
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans].sort()).toEqual([pathResolve(cwd, "docs/a.md"), pathResolve(cwd, "docs/b.md")]);
	});

	it("collects Move to .md even when the Update source is non-.md", async () => {
		write(applyPatch(patch("*** Update File: a.txt", "*** Move to: docs/b.md")));
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/b.md")]);
	});

	it("collects only the .md target from a multi-file patch", async () => {
		write(applyPatch(patch("*** Add File: docs/plan.md", "+# P", "*** Update File: src/code.ts", "+code")));
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/plan.md")]);
	});

	it("treats the whole post-colon segment (including spaces) as the path", async () => {
		write(applyPatch(patch("*** Add File: docs/20260204 - Space plan.md")));
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/20260204 - Space plan.md")]);
	});

	it("passes through an absolute path header via resolve", async () => {
		const abs = pathResolve(cwd, "docs/abs.md");
		write(applyPatch(patch(`*** Add File: ${abs}`)));
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([abs]);
	});

	it("matches .md case-insensitively (.MD)", async () => {
		write(applyPatch(patch("*** Add File: docs/Plan.MD")));
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/Plan.MD")]);
	});

	it("ignores a header with an empty path after the colon", async () => {
		write(applyPatch(patch("*** Add File:   ")));
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect(res.externalPlans.size).toBe(0);
	});

	it("only recognizes apply_patch via custom_tool_call (not function_call / shell)", async () => {
		write(
			// function_call named apply_patch — NOT custom_tool_call → ignored
			JSON.stringify({
				payload: { type: "function_call", name: "apply_patch", input: patch("*** Add File: docs/x.md") },
			}),
			// shell function_call whose arguments merely mention apply_patch → ignored
			JSON.stringify({
				payload: { type: "function_call", name: "shell", arguments: "apply_patch docs/y.md" },
			}),
			// custom_tool_call but a different tool name → ignored
			JSON.stringify({
				payload: { type: "custom_tool_call", name: "other", input: patch("*** Add File: docs/z.md") },
			}),
		);
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect(res.externalPlans.size).toBe(0);
	});

	it("does NOT treat an indented hunk context line as a header (column-0 match)", async () => {
		// An Update hunk's CONTEXT line (single leading space) whose text reads like
		// a header — e.g. when editing a doc that documents the apply_patch format.
		// The real Add target (docs/real.md) must be collected; the context-line
		// look-alike (docs/ctx.md) must NOT.
		// Edit a NON-.md file whose body contains header-look-alike CONTEXT lines
		// (single leading space). Only the real column-0 Add target is collected.
		write(
			applyPatch(
				patch(
					"*** Add File: docs/real.md",
					"+# Real",
					"*** Update File: docs/format.txt",
					"@@",
					" *** Add File: docs/ctx.md",
					" *** Move to: docs/ctx2.md",
				),
			),
		);
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/real.md")]);
	});

	it("does NOT treat +/- prefixed body lines as headers", async () => {
		write(
			applyPatch(
				patch(
					"*** Update File: docs/format.txt",
					"+*** Add File: docs/added.md",
					"-*** Update File: docs/removed.md",
				),
			),
		);
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		// The only column-0 header targets a .txt → nothing collected; the +/- body
		// look-alikes are not headers.
		expect(res.externalPlans.size).toBe(0);
	});

	it("skips malformed JSON lines and lines whose input is not a string, without throwing", async () => {
		write(
			"{not json",
			JSON.stringify({ payload: { type: "custom_tool_call", name: "apply_patch", input: 42 } }),
			JSON.stringify({ payload: { type: "custom_tool_call", name: "apply_patch" } }), // missing input
			"apply_patch but not json either {",
			applyPatch(patch("*** Add File: docs/ok.md")),
		);
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/ok.md")]);
	});

	it("skips lines without the apply_patch substring (pre-filter) and non-object payloads", async () => {
		write(
			JSON.stringify({ payload: { type: "message", text: "hello" } }),
			JSON.stringify({ payload: "string-payload-with-apply_patch" }),
			JSON.stringify({ notPayload: true, foo: "apply_patch" }),
			JSON.stringify("apply_patch top-level non-object"),
		);
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect(res.externalPlans.size).toBe(0);
		expect(res.totalLines).toBe(4);
	});

	it("handles CRLF-terminated transcript lines", async () => {
		writeFileSync(transcript, `${applyPatch(patch("*** Add File: docs/crlf.md"))}\r\n`, "utf-8");
		const res = await codexPlanScanner.scan(transcript, 0, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/crlf.md")]);
	});

	it("honours fromLine: header lines at or before fromLine are skipped", async () => {
		write(
			applyPatch(patch("*** Add File: docs/old.md")), // line 1
			applyPatch(patch("*** Add File: docs/new.md")), // line 2
		);
		const res = await codexPlanScanner.scan(transcript, 1, cwd);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/new.md")]);
		expect(res.totalLines).toBe(2);
	});

	it("honours toLine: a header past the upper bound is NOT collected, before it IS", async () => {
		write(
			applyPatch(patch("*** Add File: docs/in.md")), // line 1 (<= toLine)
			applyPatch(patch("*** Add File: docs/out.md")), // line 2 (> toLine)
		);
		const res = await codexPlanScanner.scan(transcript, 0, cwd, 1);
		expect([...res.externalPlans]).toEqual([pathResolve(cwd, "docs/in.md")]);
		// totalLines is the first out-of-range line number reached before early-close
		// (not used as the Codex cursor).
		expect(res.totalLines).toBe(2);
	});
});
