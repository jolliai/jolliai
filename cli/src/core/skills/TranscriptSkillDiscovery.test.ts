import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadExtractorCursorLine, loadPlansRegistry, upsertSkillEntry } from "../SessionTracker.js";
import {
	ATTRIBUTED_TURN,
	COMMAND_BODY,
	COMMAND_TAGS,
	TOOL_BODY,
	TOOL_CALL,
	TOOL_RESULT,
	USAGE_OTHER_SKILL,
	USAGE_SPLIT_LINE_1,
	USAGE_SPLIT_LINE_2,
	USAGE_SUBAGENT_TURN,
} from "./__fixtures__/claudeTranscript.js";
import { scanSkillsFrom, scanSkillsWithCursor } from "./TranscriptSkillDiscovery.js";

// Partial mock: every other export stays real (the tests below read the registry and
// the cursors back through them), only the persist call is made steerable so a
// mid-scan failure can be injected.
vi.mock("../SessionTracker.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../SessionTracker.js")>();
	return { ...actual, upsertSkillEntry: vi.fn(actual.upsertSkillEntry) };
});

describe("scanSkillsFrom", () => {
	let tempDir: string;
	let projectsDir: string;
	const SESSION_ID = "4650ec72-9bc5-405a-bedd-ba32a8d99690";

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "skill-discovery-test-"));
		projectsDir = join(tempDir, "projects", "-some-project");
		await mkdir(projectsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function writeTranscript(lines: ReadonlyArray<string>): Promise<string> {
		const path = join(projectsDir, `${SESSION_ID}.jsonl`);
		await writeFile(path, `${lines.join("\n")}\n`, "utf-8");
		return path;
	}

	/** Subagent transcripts live in a sibling directory named after the session id. */
	async function writeSubagent(agentId: string, lines: ReadonlyArray<string>): Promise<string> {
		const dir = join(projectsDir, SESSION_ID, "subagents");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `agent-${agentId}.jsonl`);
		await writeFile(path, `${lines.join("\n")}\n`, "utf-8");
		return path;
	}

	it("persists a discovered skill into the registry", async () => {
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY, ATTRIBUTED_TURN]);
		await scanSkillsFrom(path, 0, tempDir, "claude");
		const registry = await loadPlansRegistry(tempDir);
		const entry = registry.skills?.["claude:superpowers:brainstorming"];
		expect(entry?.invocationCount).toBe(1);
		expect(entry?.plugin).toBe("superpowers");
		expect(entry?.commitHash).toBeNull();
	});

	it("returns the line count so the caller can advance its own cursor", async () => {
		// Mirrors scanPlansFrom: the scan does not own the discovery cursor.
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
		expect(await scanSkillsFrom(path, 0, tempDir, "claude")).toBe(3);
	});

	it("persists both entry paths from one transcript", async () => {
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY, COMMAND_TAGS, COMMAND_BODY]);
		await scanSkillsFrom(path, 0, tempDir, "claude");
		const registry = await loadPlansRegistry(tempDir);
		expect(Object.keys(registry.skills ?? {}).sort()).toEqual([
			"claude:j:specs-pr-review",
			"claude:superpowers:brainstorming",
		]);
	});

	it("does not double-count when the same lines are scanned twice", async () => {
		// A catch-up pass or a cursor rewind re-reads lines; invocations dedupe on
		// their timestamp so the count stays honest.
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
		await scanSkillsFrom(path, 0, tempDir, "claude");
		await scanSkillsFrom(path, 0, tempDir, "claude");
		const registry = await loadPlansRegistry(tempDir);
		expect(registry.skills?.["claude:superpowers:brainstorming"]?.invocationCount).toBe(1);
	});

	it("resumes from the given line without re-persisting earlier invocations", async () => {
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
		await scanSkillsFrom(path, 3, tempDir, "claude");
		const registry = await loadPlansRegistry(tempDir);
		expect(registry.skills).toBeUndefined();
	});

	it("captures a subagent's own skill invocation", async () => {
		// Subagent records live in a separate file and are never duplicated into the
		// parent, so a scan of the session file alone cannot see them.
		const inSubagent = TOOL_CALL.replace(
			'"skill":"superpowers:brainstorming"',
			'"skill":"superpowers:test-driven-development"',
		)
			.replace('"toolu_019BtdUXtkPLcwtXEUiUv1Dc"', '"toolu_SUB"')
			.replace('"isSidechain":false', '"isSidechain":true');
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
		await writeSubagent("a1a3e7f45ea8dabb0", [inSubagent]);

		await scanSkillsFrom(path, 0, tempDir, "claude");
		const registry = await loadPlansRegistry(tempDir);
		expect(Object.keys(registry.skills ?? {}).sort()).toEqual([
			"claude:superpowers:brainstorming",
			"claude:superpowers:test-driven-development",
		]);
	});

	it("scans every subagent file, not just the first", async () => {
		const mk = (skill: string, id: string) =>
			TOOL_CALL.replace('"skill":"superpowers:brainstorming"', `"skill":"${skill}"`).replace(
				'"toolu_019BtdUXtkPLcwtXEUiUv1Dc"',
				`"toolu_${id}"`,
			);
		const path = await writeTranscript([]);
		await writeSubagent("aaa", [mk("a:one", "A")]);
		await writeSubagent("bbb", [mk("b:two", "B")]);

		await scanSkillsFrom(path, 0, tempDir, "claude");
		const registry = await loadPlansRegistry(tempDir);
		expect(Object.keys(registry.skills ?? {}).sort()).toEqual(["claude:a:one", "claude:b:two"]);
	});

	it("ignores non-transcript files in the subagents directory", async () => {
		// Every agent-<id>.jsonl has an agent-<id>.meta.json sibling.
		const path = await writeTranscript([]);
		const dir = join(projectsDir, SESSION_ID, "subagents");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "agent-x.meta.json"), '{"agentType":"Explore"}', "utf-8");
		await expect(scanSkillsFrom(path, 0, tempDir, "claude")).resolves.toBe(0);
		expect((await loadPlansRegistry(tempDir)).skills).toBeUndefined();
	});

	it("skips an unreadable subagent file and still scans the rest", async () => {
		// readdir lists the name, readFile then fails on it — the real case is a file
		// removed between the listing and the read, reproduced deterministically here
		// with a directory wearing the transcript name. One bad entry must not cost the
		// session its own skills, nor the sibling subagent's.
		const inSubagent = TOOL_CALL.replace(
			'"skill":"superpowers:brainstorming"',
			'"skill":"superpowers:test-driven-development"',
		).replace('"toolu_019BtdUXtkPLcwtXEUiUv1Dc"', '"toolu_SUB"');
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
		await writeSubagent("zzz", [inSubagent]);
		await mkdir(join(projectsDir, SESSION_ID, "subagents", "agent-broken.jsonl"), { recursive: true });

		await expect(scanSkillsFrom(path, 0, tempDir, "claude")).resolves.toBe(3);
		expect(Object.keys((await loadPlansRegistry(tempDir)).skills ?? {}).sort()).toEqual([
			"claude:superpowers:brainstorming",
			"claude:superpowers:test-driven-development",
		]);
	});

	it("is a no-op for a transcript with no subagents directory", async () => {
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
		await expect(scanSkillsFrom(path, 0, tempDir, "claude")).resolves.toBe(3);
	});

	it("is a no-op for a missing transcript file", async () => {
		await expect(scanSkillsFrom(join(projectsDir, "gone.jsonl"), 0, tempDir, "claude")).resolves.toBe(0);
	});

	it("is a no-op for a source with no skill concept on disk", async () => {
		// Gemini, Antigravity, Cline and Devin have no skills at all — there is
		// nothing to capture, as distinct from something not yet implemented.
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
		await expect(scanSkillsFrom(path, 0, tempDir, "gemini")).resolves.toBe(0);
		expect((await loadPlansRegistry(tempDir)).skills).toBeUndefined();
	});

	it("attaches attributed token usage to the persisted row", async () => {
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY, USAGE_SPLIT_LINE_1, USAGE_SPLIT_LINE_2]);
		await scanSkillsFrom(path, 0, tempDir, "claude");
		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		// One response across two lines — counted once, cache_read excluded.
		expect(entry?.usage).toEqual({ input: 1, cached: 4162, output: 797, confidence: "attributed" });
	});

	it("bills subagent spend to the dispatching skill", async () => {
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY, USAGE_SPLIT_LINE_1]);
		await writeSubagent("aaa", [USAGE_SUBAGENT_TURN]);
		await scanSkillsFrom(path, 0, tempDir, "claude");
		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		expect(entry?.usage?.cached).toBe(34162);
	});

	it("leaves usage absent when the transcript attributes nothing to that skill", async () => {
		// An absent field is honest; a zero would claim the skill cost nothing.
		const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY, USAGE_OTHER_SKILL]);
		await scanSkillsFrom(path, 0, tempDir, "claude");
		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		expect(entry).toBeDefined();
		expect(entry?.usage).toBeUndefined();
	});

	it("sums one skill's spend across two sessions instead of letting the later one win", async () => {
		// scanSkillsFrom runs per transcript, so a skill used in two sessions is folded
		// twice. Replacing the number on each fold reports only the last session's
		// spend — a silent under-count that grows with how much work happened earlier.
		const a = join(projectsDir, "sessA.jsonl");
		const b = join(projectsDir, "sessB.jsonl");
		const bTurn = USAGE_OTHER_SKILL.replace("superpowers:writing-plans", "superpowers:brainstorming").replace(
			"msg_OTHER",
			"msg_B",
		);
		await writeFile(a, `${[TOOL_CALL, TOOL_RESULT, TOOL_BODY, USAGE_SPLIT_LINE_1].join("\n")}\n`, "utf-8");
		await writeFile(b, `${[TOOL_CALL, TOOL_RESULT, TOOL_BODY, bTurn].join("\n")}\n`, "utf-8");

		await scanSkillsFrom(a, 0, tempDir, "claude");
		await scanSkillsFrom(b, 0, tempDir, "claude");

		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		// 4162 (session A) + 500 (session B)
		expect(entry?.usage?.cached).toBe(4662);
		expect(entry?.usage?.output).toBe(2797);
	});

	it("does not double-count when one session is rescanned", async () => {
		// Attribution recomputes the whole session from line 0 on every pass, so its
		// contribution must REPLACE that session's prior entry, never add to it.
		const a = join(projectsDir, "sessA.jsonl");
		await writeFile(a, `${[TOOL_CALL, TOOL_RESULT, TOOL_BODY, USAGE_SPLIT_LINE_1].join("\n")}\n`, "utf-8");
		await scanSkillsFrom(a, 0, tempDir, "claude");
		await scanSkillsFrom(a, 0, tempDir, "claude");
		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		expect(entry?.usage?.cached).toBe(4162);
	});

	it("keeps the per-session split so a detached conversation can be subtracted", async () => {
		// The commit-level figures get corrected when a conversation is detached, using
		// the per-session usage persisted at write time. Skill figures need the same
		// record or they go stale the moment a user detaches anything.
		const a = join(projectsDir, "sessA.jsonl");
		await writeFile(a, `${[TOOL_CALL, TOOL_RESULT, TOOL_BODY, USAGE_SPLIT_LINE_1].join("\n")}\n`, "utf-8");
		await scanSkillsFrom(a, 0, tempDir, "claude");
		const entry = (await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"];
		expect(entry?.usageBySession?.["claude:sessA"]).toEqual({
			input: 1,
			cached: 4162,
			output: 797,
			confidence: "attributed",
		});
	});

	it("does not persist anything for a transcript with no skill activity", async () => {
		const plain =
			'{"type":"assistant","timestamp":"2026-07-12T11:00:00.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1,"output_tokens":1}}}';
		const path = await writeTranscript([plain]);
		await scanSkillsFrom(path, 0, tempDir, "claude");
		expect((await loadPlansRegistry(tempDir)).skills).toBeUndefined();
	});

	describe("scanSkillsWithCursor", () => {
		// The cursor protocol is the half that fails PERMANENTLY when it is wrong:
		// discovery-cursors.json is monotonic, so a mark advanced over unscanned lines
		// strands them forever. These pin the three rules every discovery site inherits
		// by calling this helper instead of open-coding the load/scan/save triple.

		it("persists skills and advances the skills mark", async () => {
			const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
			await scanSkillsWithCursor(path, tempDir, "claude");

			expect((await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"]).toBeDefined();
			expect(await loadExtractorCursorLine(path, "skills", tempDir)).toBe(3);
		});

		it("resumes from the mark instead of rescanning from line 0", async () => {
			const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
			await scanSkillsWithCursor(path, tempDir, "claude");
			// A second pass over an unchanged file has no new lines to read, so the count
			// must not move — the fold dedupes on timestamp, and the mark caps the window.
			await scanSkillsWithCursor(path, tempDir, "claude");

			expect(
				(await loadPlansRegistry(tempDir)).skills?.["claude:superpowers:brainstorming"]?.invocationCount,
			).toBe(1);
		});

		it("leaves the plans/references shared cursor free to sit behind it", async () => {
			// The skills mark is independent: nothing here may advance the shared
			// lineNumber past what the plan/reference pair actually scanned.
			const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
			await scanSkillsWithCursor(path, tempDir, "claude");

			expect(await loadExtractorCursorLine(path, "plans", tempDir)).toBe(0);
			expect(await loadExtractorCursorLine(path, "references", tempDir)).toBe(0);
		});

		it("holds the mark when the transcript cannot be read", async () => {
			// Never throws — every caller is a hook or a UI tick — and a failed pass must
			// leave the window for the next one rather than skipping it.
			const missing = join(projectsDir, "does-not-exist.jsonl");
			await expect(scanSkillsWithCursor(missing, tempDir, "claude")).resolves.toBeUndefined();
			expect(await loadExtractorCursorLine(missing, "skills", tempDir)).toBe(0);
		});

		it("swallows a mid-scan failure and holds the mark", async () => {
			// The scan itself can throw — a plans.lock timeout is the live example. The
			// helper must neither propagate it into the hook nor advance the mark over
			// lines it never finished persisting.
			const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
			vi.mocked(upsertSkillEntry).mockRejectedValueOnce(new Error("plans.lock timeout"));

			await expect(scanSkillsWithCursor(path, tempDir, "claude")).resolves.toBeUndefined();
			expect(await loadExtractorCursorLine(path, "skills", tempDir)).toBe(0);
		});

		it("is a no-op for a source with no skill scanner", async () => {
			const path = await writeTranscript([TOOL_CALL, TOOL_RESULT, TOOL_BODY]);
			await scanSkillsWithCursor(path, tempDir, "gemini");

			expect((await loadPlansRegistry(tempDir)).skills).toBeUndefined();
			expect(await loadExtractorCursorLine(path, "skills", tempDir)).toBe(0);
		});
	});
});
