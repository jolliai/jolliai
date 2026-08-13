import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallCount, TranscriptSource } from "../../Types.js";

// The registry is a module-level constant built from these two, so replacing the
// modules is what lets a case decide who answers, who declines and who throws.
vi.mock("./ToolCallExtractor.js", () => ({
	toolCallExtractor: { id: "tool-calls", supports: vi.fn(), extract: vi.fn() },
}));
vi.mock("./SkillExtractor.js", () => ({
	skillExtractor: { id: "skills", supports: vi.fn(), extract: vi.fn() },
}));

import type { SessionSignalInput } from "./SessionSignalExtractor.js";
import { extractSessionSignals } from "./SessionSignals.js";
import { skillExtractor } from "./SkillExtractor.js";
import { toolCallExtractor } from "./ToolCallExtractor.js";

const INPUT: SessionSignalInput = {
	source: "claude",
	sessionId: "s1",
	transcriptPath: "/tmp/s1.jsonl",
	content: {
		read: async () => ({
			entries: [],
			newCursor: { transcriptPath: "/tmp/s1.jsonl", lineNumber: 0, updatedAt: "2026-08-01T00:00:00.000Z" },
			totalLinesRead: 0,
		}),
		lines: async () => undefined,
	},
};

/** Both extractors as vi mocks, since the module mock erases their real identity. */
const tools = vi.mocked(toolCallExtractor);
const skills = vi.mocked(skillExtractor);

function bucket(name: string, calls: number): ToolCallCount {
	return { name, kind: "builtin", calls };
}

beforeEach(() => {
	vi.clearAllMocks();
	tools.supports.mockReturnValue(false);
	skills.supports.mockReturnValue(false);
});

describe("extractSessionSignals", () => {
	it("reports ABSENCE when no extractor supports the source", async () => {
		// `{}` rather than `{ tools: [] }`: in the database an empty list reads as "this
		// agent called no tools" and absence reads as "this agent cannot report them".
		const signals = await extractSessionSignals(INPUT);
		expect(signals).toEqual({});
		expect(tools.extract).not.toHaveBeenCalled();
		expect(skills.extract).not.toHaveBeenCalled();
	});

	it("does not call an extractor that declined the source", async () => {
		tools.supports.mockReturnValue(true);
		tools.extract.mockResolvedValue({ tools: [bucket("Bash", 1)] });

		await extractSessionSignals(INPUT);

		expect(tools.extract).toHaveBeenCalledTimes(1);
		expect(skills.extract).not.toHaveBeenCalled();
	});

	it("reports ABSENCE when every supporting extractor declined to answer", async () => {
		// Supported but silent is still "cannot say" — an extractor that returns `{}`
		// must not be upgraded to an empty list.
		tools.supports.mockReturnValue(true);
		skills.supports.mockReturnValue(true);
		tools.extract.mockResolvedValue({});
		skills.extract.mockResolvedValue({});

		expect(await extractSessionSignals(INPUT)).toEqual({});
	});

	it("keeps an EMPTY list one extractor did produce", async () => {
		// The positive claim "called no tools", which is worth storing.
		tools.supports.mockReturnValue(true);
		tools.extract.mockResolvedValue({ tools: [] });

		expect(await extractSessionSignals(INPUT)).toEqual({ tools: [] });
	});

	it("merges both extractors' buckets", async () => {
		tools.supports.mockReturnValue(true);
		skills.supports.mockReturnValue(true);
		tools.extract.mockResolvedValue({ tools: [bucket("Bash", 2)] });
		skills.extract.mockResolvedValue({ tools: [bucket("Read", 1)] });

		const signals = await extractSessionSignals(INPUT);

		expect(signals.tools).toEqual([bucket("Bash", 2), bucket("Read", 1)]);
	});

	it("folds one bucket both extractors reported, taking the larger count", async () => {
		// Two views of one set of records, never two tallies — see `mergeToolCalls`.
		tools.supports.mockReturnValue(true);
		skills.supports.mockReturnValue(true);
		tools.extract.mockResolvedValue({ tools: [{ name: "code-review", kind: "skill", calls: 1 }] });
		skills.extract.mockResolvedValue({ tools: [{ name: "code-review", kind: "skill", calls: 4 }] });

		const signals = await extractSessionSignals(INPUT);

		expect(signals.tools).toEqual([{ name: "code-review", kind: "skill", calls: 4 }]);
	});

	it("keeps the other extractor's findings when one THROWS", async () => {
		// These read real files belonging to other applications, which can be locked,
		// half-written or removed between the scan and this call.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		tools.supports.mockReturnValue(true);
		skills.supports.mockReturnValue(true);
		tools.extract.mockRejectedValue(new Error("locked"));
		skills.extract.mockResolvedValue({ tools: [bucket("Read", 1)] });

		const signals = await extractSessionSignals(INPUT);

		expect(signals.tools).toEqual([bucket("Read", 1)]);
		warn.mockRestore();
	});

	it("reports ABSENCE when every extractor throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		tools.supports.mockReturnValue(true);
		skills.supports.mockReturnValue(true);
		tools.extract.mockRejectedValue(new Error("locked"));
		skills.extract.mockRejectedValue(new Error("gone"));

		expect(await extractSessionSignals(INPUT)).toEqual({});
		warn.mockRestore();
	});

	it("asks every extractor about the source it was given", async () => {
		tools.supports.mockReturnValue(false);
		skills.supports.mockReturnValue(false);

		await extractSessionSignals({ ...INPUT, source: "kimi" as TranscriptSource });

		expect(tools.supports).toHaveBeenCalledWith("kimi");
		expect(skills.supports).toHaveBeenCalledWith("kimi");
	});

	it("hands each extractor the SAME content object, so the read is shared", async () => {
		// Sequential rather than concurrent for exactly this reason: the memo only
		// collapses the two reads if both extractors see one object.
		tools.supports.mockReturnValue(true);
		skills.supports.mockReturnValue(true);
		tools.extract.mockResolvedValue({});
		skills.extract.mockResolvedValue({});

		await extractSessionSignals(INPUT);

		expect(tools.extract.mock.calls[0][0].content).toBe(INPUT.content);
		expect(skills.extract.mock.calls[0][0].content).toBe(INPUT.content);
	});
});
