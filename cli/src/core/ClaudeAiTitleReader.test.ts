import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaudeAiTitle } from "./ClaudeAiTitleReader.js";

describe("readClaudeAiTitle", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claude-aititle-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns undefined when the file does not exist", async () => {
		const result = await readClaudeAiTitle(join(dir, "missing.jsonl"));
		expect(result).toBeUndefined();
	});

	it("returns undefined when no ai-title line is present", async () => {
		const file = join(dir, "no-title.jsonl");
		writeFileSync(file, '{"type":"user","content":"hi"}\n{"type":"assistant","content":"hi"}\n');
		const result = await readClaudeAiTitle(file);
		expect(result).toBeUndefined();
	});

	it("returns the aiTitle from a single ai-title line", async () => {
		const file = join(dir, "single.jsonl");
		writeFileSync(file, '{"type":"ai-title","aiTitle":"Refactor session storage","sessionId":"s1"}\n');
		const result = await readClaudeAiTitle(file);
		expect(result).toBe("Refactor session storage");
	});

	it("returns the LAST ai-title when multiple are present", async () => {
		const file = join(dir, "multi.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"ai-title","aiTitle":"Initial draft","sessionId":"s1"}',
				'{"type":"user","content":"keep going"}',
				'{"type":"ai-title","aiTitle":"Final scope","sessionId":"s1"}',
				"",
			].join("\n"),
		);
		const result = await readClaudeAiTitle(file);
		expect(result).toBe("Final scope");
	});

	it("ignores malformed JSON lines without throwing", async () => {
		const file = join(dir, "malformed.jsonl");
		writeFileSync(
			file,
			["not json", '{"type":"ai-title","aiTitle":"Real","sessionId":"s1"}', "also not json", ""].join("\n"),
		);
		const result = await readClaudeAiTitle(file);
		expect(result).toBe("Real");
	});

	it("returns undefined when aiTitle is empty / non-string", async () => {
		const file = join(dir, "empty.jsonl");
		writeFileSync(file, ['{"type":"ai-title","aiTitle":""}', '{"type":"ai-title","aiTitle":123}', ""].join("\n"));
		const result = await readClaudeAiTitle(file);
		expect(result).toBeUndefined();
	});

	// Pinpoints the `obj.type === "ai-title"` true-branch combined with the
	// `aiTitle` non-string sub-branch — the pre-filter passes, JSON.parse
	// succeeds, type matches, but aiTitle is missing entirely (vs. just
	// being empty or non-string in the row above). Distinct branch path.
	it("ignores ai-title rows that lack the aiTitle field entirely", async () => {
		const file = join(dir, "missing-aititle.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"ai-title","sessionId":"s1"}', // pre-filter passes; parse OK; type matches; aiTitle absent
				'{"type":"ai-title","aiTitle":"valid one","sessionId":"s1"}', // this should win
				"",
			].join("\n"),
		);
		const result = await readClaudeAiTitle(file);
		expect(result).toBe("valid one");
	});

	// Pre-filter passes (line contains the fragment text) but the parsed
	// JSON has no `type` field at all — `obj.type !== "ai-title"` short-
	// circuits to true via `undefined !== "ai-title"`. Distinct from the
	// Lines whose `type` is something other than exact `"ai-title"` cannot
	// pass the pre-filter — the literal substring requires the closing
	// quote. Pin the pre-filter rejection so the absence of an explicit
	// post-parse `type !== "ai-title"` check stays sound.
	it("pre-filter rejects close-but-not-equal type values (e.g. ai-title-other)", async () => {
		const file = join(dir, "other-type.jsonl");
		writeFileSync(
			file,
			[
				// Pre-filter rejects: the literal `"type":"ai-title"` does
				// not appear (the closing quote after `ai-title` is missing).
				'{"type":"ai-title-other","aiTitle":"never-seen","sessionId":"s1"}',
				// Valid row — pre-filter passes, this title wins.
				'{"type":"ai-title","aiTitle":"actual","sessionId":"s1"}',
				"",
			].join("\n"),
		);
		const result = await readClaudeAiTitle(file);
		expect(result).toBe("actual");
	});

	// Silent-failure observability coverage: lines with the ai-title
	// fragment that fail JSON.parse still trip the inner catch block (so
	// parseSkipped increments and the end-of-stream debug log fires) but
	// do not abort the scan — a subsequent valid ai-title line still wins.
	it("counts and ignores ai-title fragment lines that fail JSON.parse, finishing the scan", async () => {
		const file = join(dir, "fragment-malformed.jsonl");
		writeFileSync(
			file,
			[
				// Pre-filter catches the fragment but JSON.parse rejects.
				'{"type":"ai-title" malformed',
				// Pre-filter catches the fragment, parse OK, but type !== ai-title.
				'{"foo":"bar","type":"ai-title-other","aiTitle":"ignored"}',
				// Final valid row — must still be returned.
				'{"type":"ai-title","aiTitle":"OK","sessionId":"s"}',
				"",
			].join("\n"),
		);
		const result = await readClaudeAiTitle(file);
		expect(result).toBe("OK");
	});

	it("returns undefined and does not throw when readlines is given a path it cannot open as a regular file", async () => {
		// Stream-open against a directory triggers the outer non-ENOENT
		// branch — the catch logs at debug and returns undefined rather
		// than letting the error propagate.
		const result = await readClaudeAiTitle(dir);
		expect(result).toBeUndefined();
	});
});
