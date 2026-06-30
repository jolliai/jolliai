import { describe, expect, it } from "vitest";
import { attributeCommits } from "./CommitAttributor.js";
import type { CommitTargetIndex } from "./CommitTargetIndex.js";
import type { RawEntry } from "./RawTranscriptScanner.js";

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const min = (n: number) => n * 60_000;

function entry(over: Partial<RawEntry> & { offsetMin: number }): RawEntry {
	const tsMs = T0 + min(over.offsetMin);
	return {
		sessionId: over.sessionId ?? "S1",
		transcriptPath: over.transcriptPath ?? "/p/S1.jsonl",
		source: "claude",
		lineNo: over.lineNo ?? Math.round(over.offsetMin),
		ts: new Date(tsMs).toISOString(),
		tsMs,
		gitBranch: over.gitBranch ?? "feat",
		cwd: over.cwd ?? "e:/repo",
		role: over.role,
		content: over.content,
		editedRel: over.editedRel ?? [],
		editedBase: over.editedBase ?? (over.editedRel ?? []).map((p) => p.split("/").pop() ?? p),
	};
}

/** Build a target index where each file maps to one commit committed at `commitOffsetMin`. */
function index(files: Record<string, { hash: string; commitOffsetMin: number }>): CommitTargetIndex {
	const fileToCommits = new Map<string, { ts: number; hash: string }[]>();
	const baseToCommits = new Map<string, { ts: number; hash: string }[]>();
	const commitMeta = new Map<string, { ts: number; subject: string }>();
	for (const [rel, { hash, commitOffsetMin }] of Object.entries(files)) {
		const ref = { ts: T0 + min(commitOffsetMin), hash };
		fileToCommits.set(rel, [ref]);
		baseToCommits.set(rel.split("/").pop() ?? rel, [ref]);
		commitMeta.set(hash, { ts: ref.ts, subject: `commit ${hash}` });
	}
	return { commitMeta, fileToCommits, baseToCommits };
}

describe("attributeCommits — file-overlap (HIGH)", () => {
	it("attributes an edited file to the commit that next touches it", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 10 } });
		const entries = [entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "editing foo" })];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		const a = res.attributed.get("C1");
		expect(a?.confidence).toBe("high");
		expect(a?.method).toBe("file-overlap");
		expect(a?.branch).toBe("feat");
		expect(a?.sessions).toHaveLength(1);
	});

	it("propagates to a discussion entry enclosed by two same-commit anchors", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 30 } });
		const entries = [
			entry({ offsetMin: 1, editedRel: ["foo.ts"], role: "assistant", content: "edit 1" }),
			entry({ offsetMin: 2, role: "human", content: "what about edge cases?" }), // no edit
			entry({ offsetMin: 3, editedRel: ["foo.ts"], role: "assistant", content: "edit 2" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		const a = res.attributed.get("C1");
		// All three conversational turns belong to C1 (the middle one via propagation).
		expect(a?.transcriptEntries).toBe(3);
		expect(a?.conversationTurns).toBe(1);
	});

	it("drops a contested entry between anchors of different commits", () => {
		const idx = index({
			"foo.ts": { hash: "C1", commitOffsetMin: 30 },
			"bar.ts": { hash: "C2", commitOffsetMin: 31 },
		});
		const entries = [
			entry({ offsetMin: 1, editedRel: ["foo.ts"], role: "assistant", content: "edit foo" }),
			entry({ offsetMin: 2, role: "human", content: "contested middle" }),
			entry({ offsetMin: 3, editedRel: ["bar.ts"], role: "assistant", content: "edit bar" }),
		];
		const res = attributeCommits(["C1", "C2"], new Map([["S1", entries]]), idx);
		// The middle turn is contested → excluded from both.
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(1);
		expect(res.attributed.get("C2")?.transcriptEntries).toBe(1);
	});

	it("propagates one-sided only within the reach window", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 120 } });
		const entries = [
			entry({ offsetMin: 0, editedRel: ["foo.ts"], role: "assistant", content: "anchor edit" }),
			entry({ offsetMin: 10, role: "human", content: "near (10m)" }), // within 30m reach
			entry({ offsetMin: 90, role: "human", content: "far (90m, but same segment? no)" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		// The 90m entry is in a separate segment (gap > 2h? no, 80m < 2h) but beyond
		// one-sided reach (30m) → excluded. Near entry included with the anchor.
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(2);
	});

	it("does not attribute a commit outside the target set", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 10 } });
		const entries = [entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "x" })];
		const res = attributeCommits(["OTHER"], new Map([["S1", entries]]), idx);
		expect(res.attributed.size).toBe(0);
		expect(res.skipped).toContain("OTHER");
	});

	it("skips a target whose attributed entries carry no conversational text", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 10 } });
		// edit entry with no role/content (pure tool call)
		const entries = [entry({ offsetMin: 5, editedRel: ["foo.ts"] })];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		expect(res.attributed.has("C1")).toBe(false);
		expect(res.skipped).toContain("C1");
	});
});

describe("attributeCommits — segmentation & branch", () => {
	it("splits segments on branch change so cross-branch anchors don't bleed", () => {
		const idx = index({
			"foo.ts": { hash: "C1", commitOffsetMin: 30 },
			"bar.ts": { hash: "C2", commitOffsetMin: 31 },
		});
		const entries = [
			entry({ offsetMin: 1, gitBranch: "a", editedRel: ["foo.ts"], role: "assistant", content: "on a" }),
			entry({ offsetMin: 2, gitBranch: "b", role: "human", content: "on b, no anchor" }),
		];
		const res = attributeCommits(["C1", "C2"], new Map([["S1", entries]]), idx);
		// The 'b' entry is in its own anchor-less segment → not attributed to C1.
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(1);
	});

	it("splits a segment on a >2h idle gap so a distant anchor doesn't bleed across", () => {
		const idx = index({
			"foo.ts": { hash: "C1", commitOffsetMin: 5 },
			"bar.ts": { hash: "C2", commitOffsetMin: 605 },
		});
		const entries = [
			entry({ offsetMin: 1, editedRel: ["foo.ts"], role: "assistant", content: "morning work" }),
			// 10h later — beyond the 2h gap → new segment.
			entry({ offsetMin: 600, editedRel: ["bar.ts"], role: "assistant", content: "evening work" }),
		];
		const res = attributeCommits(["C1", "C2"], new Map([["S1", entries]]), idx);
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(1);
		expect(res.attributed.get("C2")?.transcriptEntries).toBe(1);
	});

	it("tolerates entries without a timestamp", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 10 } });
		const noTs = {
			...entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "x" }),
			ts: undefined,
			tsMs: Number.NaN,
		};
		const res = attributeCommits(["C1"], new Map([["S1", [noTs]]]), idx);
		// No timestamp → no anchor (anchorForEntry bails on NaN) → skipped.
		expect(res.skipped).toContain("C1");
	});

	it("uses the modal branch of attributed entries", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 30 } });
		const entries = [
			entry({ offsetMin: 1, gitBranch: "feat-x", editedRel: ["foo.ts"], role: "assistant", content: "e1" }),
			entry({ offsetMin: 2, gitBranch: "feat-x", editedRel: ["foo.ts"], role: "assistant", content: "e2" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		expect(res.attributed.get("C1")?.branch).toBe("feat-x");
	});

	it("returns an empty branch when no attributed entry carries a gitBranch", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 30 } });
		const e = entry({ offsetMin: 1, editedRel: ["foo.ts"], role: "assistant", content: "e1" });
		const res = attributeCommits(["C1"], new Map([["S1", [{ ...e, gitBranch: undefined }]]]), idx);
		expect(res.attributed.get("C1")?.branch).toBe("");
	});

	it("excludes pure tool-call entries (no text) from the built session while keeping the commit", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 30 } });
		const entries = [
			entry({ offsetMin: 1, editedRel: ["foo.ts"] }), // pure tool call, no role/content
			entry({ offsetMin: 2, editedRel: ["foo.ts"], role: "assistant", content: "kept turn" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		const a = res.attributed.get("C1");
		// Both edits anchor C1, but only the one with text becomes a session entry.
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("kept turn");
	});
});

describe("attributeCommits — medium (time-window)", () => {
	it("attributes an anchor-less segment to the single commit right after it", () => {
		const idx = index({ "foo.ts": { hash: "C1", commitOffsetMin: 1000 } }); // unrelated file/commit
		// add a target commit C9 right after the discussion segment
		(idx.commitMeta as Map<string, { ts: number; subject: string }>).set("C9", { ts: T0 + min(20), subject: "C9" });
		const entries = [
			entry({ offsetMin: 5, role: "human", content: "let's plan the refactor" }),
			entry({ offsetMin: 8, role: "assistant", content: "here is the plan" }),
		];
		const res = attributeCommits(["C9"], new Map([["S1", entries]]), idx, { includeMedium: true });
		const a = res.attributed.get("C9");
		expect(a?.confidence).toBe("medium");
		expect(a?.method).toBe("time-window");
		expect(a?.transcriptEntries).toBe(2);
	});

	it("does not emit medium when includeMedium is off", () => {
		const idx = index({});
		(idx.commitMeta as Map<string, { ts: number; subject: string }>).set("C9", { ts: T0 + min(20), subject: "C9" });
		const entries = [entry({ offsetMin: 5, role: "human", content: "plan" })];
		const res = attributeCommits(["C9"], new Map([["S1", entries]]), idx);
		expect(res.attributed.has("C9")).toBe(false);
	});

	it("rejects a medium candidate on a different branch than the segment", () => {
		const idx = index({});
		// Candidate C9 is committed in-window but on branch "other"; segment is "feat".
		(idx.commitMeta as Map<string, { ts: number; subject: string; branch?: string }>).set("C9", {
			ts: T0 + min(20),
			subject: "C9",
			branch: "other",
		});
		const entries = [entry({ offsetMin: 5, gitBranch: "feat", role: "human", content: "plan" })];
		const res = attributeCommits(["C9"], new Map([["S1", entries]]), idx, { includeMedium: true });
		expect(res.attributed.has("C9")).toBe(false); // branch gate rejects
	});

	it("allows a medium candidate whose branch matches the segment", () => {
		const idx = index({});
		(idx.commitMeta as Map<string, { ts: number; subject: string; branch?: string }>).set("C9", {
			ts: T0 + min(20),
			subject: "C9",
			branch: "feat",
		});
		const entries = [entry({ offsetMin: 5, gitBranch: "feat", role: "human", content: "plan" })];
		const res = attributeCommits(["C9"], new Map([["S1", entries]]), idx, { includeMedium: true });
		expect(res.attributed.get("C9")?.confidence).toBe("medium");
	});

	it("ignores an anchor-less segment whose entries have no timestamps", () => {
		const idx = index({});
		(idx.commitMeta as Map<string, { ts: number; subject: string }>).set("C9", { ts: T0 + min(20), subject: "C9" });
		const noTs = { ...entry({ offsetMin: 5, role: "human", content: "plan" }), ts: undefined, tsMs: Number.NaN };
		const res = attributeCommits(["C9"], new Map([["S1", [noTs]]]), idx, { includeMedium: true });
		expect(res.attributed.has("C9")).toBe(false); // no usable timestamps → no medium window
	});

	it("does not emit medium when two commits compete for the same segment", () => {
		const idx = index({});
		(idx.commitMeta as Map<string, { ts: number; subject: string }>).set("C9", { ts: T0 + min(20), subject: "C9" });
		(idx.commitMeta as Map<string, { ts: number; subject: string }>).set("C8", { ts: T0 + min(25), subject: "C8" });
		const entries = [entry({ offsetMin: 5, role: "human", content: "plan" })];
		const res = attributeCommits(["C9", "C8"], new Map([["S1", entries]]), idx, { includeMedium: true });
		expect(res.attributed.size).toBe(0);
	});
});
