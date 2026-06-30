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

/**
 * Build a target index from commit specs. `files` are repo-relative paths; the
 * file→commit history is derived so attributionLowerBound works. `ts` is author
 * time in minutes from T0.
 */
function index(commits: { hash: string; offsetMin: number; files: string[]; branch?: string }[]): CommitTargetIndex {
	const commitMeta = new Map<string, { ts: number; subject: string; branch?: string }>();
	const commitFiles = new Map<string, string[]>();
	const fileToCommits = new Map<string, { ts: number; hash: string }[]>();
	const baseToCommits = new Map<string, { ts: number; hash: string }[]>();
	const push = (m: Map<string, { ts: number; hash: string }[]>, k: string, v: { ts: number; hash: string }) => {
		const l = m.get(k);
		if (l) l.push(v);
		else m.set(k, [v]);
	};
	for (const c of commits) {
		const ts = T0 + min(c.offsetMin);
		commitMeta.set(c.hash, { ts, subject: `c ${c.hash}`, ...(c.branch ? { branch: c.branch } : {}) });
		commitFiles.set(c.hash, c.files);
		for (const f of c.files) {
			push(fileToCommits, f, { ts, hash: c.hash });
			push(baseToCommits, f.split("/").pop() ?? f, { ts, hash: c.hash });
		}
	}
	for (const l of fileToCommits.values()) l.sort((a, b) => a.ts - b.ts);
	for (const l of baseToCommits.values()) l.sort((a, b) => a.ts - b.ts);
	return { commitMeta, commitFiles, fileToCommits, baseToCommits };
}

describe("attributeCommits — file-overlap window model", () => {
	it("attributes a session that edited the commit's files within (L, T]", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "editing foo" })];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		const a = res.attributed.get("C1");
		expect(a?.confidence).toBe("high");
		expect(a?.method).toBe("file-overlap");
		expect(a?.sessions).toHaveLength(1);
	});

	it("② caps attribution at the commit time — later entries are excluded", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "before commit" }),
			entry({ offsetMin: 20, role: "human", content: "after commit — must be excluded" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		const a = res.attributed.get("C1");
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("before commit");
	});

	it("① floors at the previous commit of the files — sibling commits don't bleed", () => {
		// foo.ts committed by C0 @5m and C1 @30m. C1's window = (5m, 30m].
		const idx = index([
			{ hash: "C0", offsetMin: 5, files: ["foo.ts"] },
			{ hash: "C1", offsetMin: 30, files: ["foo.ts"] },
		]);
		const entries = [
			entry({ offsetMin: 3, editedRel: ["foo.ts"], role: "assistant", content: "C0 work (before L)" }),
			entry({ offsetMin: 20, editedRel: ["foo.ts"], role: "assistant", content: "C1 work (in window)" }),
		];
		const res = attributeCommits(["C0", "C1"], new Map([["S1", entries]]), idx);
		// C1 only gets the 20m entry (3m belongs to C0's window, before C1's L=5m).
		const c1 = res.attributed.get("C1");
		expect(c1?.transcriptEntries).toBe(1);
		expect(c1?.sessions[0].entries[0].content).toBe("C1 work (in window)");
	});

	it("recovers a commit even when its files were first committed by a sibling (the recall fix)", () => {
		// bar.ts is committed first by SIB @8m, then by C @20m. The work session edits
		// bar.ts at 12m — in C's window (8m, 20m]. Old first-committer logic gave this
		// to SIB; the window model correctly attributes it to C.
		const idx = index([
			{ hash: "SIB", offsetMin: 8, files: ["bar.ts"] },
			{ hash: "C", offsetMin: 20, files: ["bar.ts"] },
		]);
		const entries = [entry({ offsetMin: 12, editedRel: ["bar.ts"], role: "assistant", content: "work for C" })];
		const res = attributeCommits(["C"], new Map([["S1", entries]]), idx);
		expect(res.attributed.get("C")?.method).toBe("file-overlap");
	});

	it("skips a commit no session touched (→ engine diff-only)", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [entry({ offsetMin: 5, editedRel: ["other.ts"], role: "assistant", content: "unrelated" })];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		expect(res.attributed.has("C1")).toBe(false);
		expect(res.skipped).toContain("C1");
	});

	it("skips a target absent from the index (no files)", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const res = attributeCommits(["UNKNOWN"], new Map(), idx);
		expect(res.skipped).toContain("UNKNOWN");
	});

	it("matches by basename when the edit's relative path differs", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["cli/src/foo.ts"] }]);
		// edit recorded under a different relative path but same basename
		const entries = [
			entry({
				offsetMin: 5,
				editedRel: ["other/foo.ts"],
				editedBase: ["foo.ts"],
				role: "assistant",
				content: "x",
			}),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		expect(res.attributed.get("C1")?.method).toBe("file-overlap");
	});

	it("excludes pure tool-call entries (no text) from the built session", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 4, editedRel: ["foo.ts"] }), // pure tool call, no role/content
			entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "kept turn" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		const a = res.attributed.get("C1");
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("kept turn");
	});

	it("splits the in-window slice on a >2h idle gap (keeps the touching segment)", () => {
		const idx = index([{ hash: "C1", offsetMin: 200, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 10, role: "human", content: "early unrelated chat" }),
			// >2h gap → new segment; this later segment edits foo.ts
			entry({ offsetMin: 190, editedRel: ["foo.ts"], role: "assistant", content: "the actual work" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		const a = res.attributed.get("C1");
		// Only the touching segment (190m) is collected, not the early-chat segment.
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("the actual work");
	});

	it("skips a commit whose only in-window touch is a non-conversational tool call", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [entry({ offsetMin: 5, editedRel: ["foo.ts"] })]; // edit only, no role/content
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		expect(res.attributed.has("C1")).toBe(false);
		expect(res.skipped).toContain("C1");
	});

	it("uses the modal branch of attributed entries", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 5, gitBranch: "feat-x", editedRel: ["foo.ts"], role: "assistant", content: "e1" }),
			entry({ offsetMin: 6, gitBranch: "feat-x", role: "human", content: "q" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		expect(res.attributed.get("C1")?.branch).toBe("feat-x");
	});

	it("splits a session on a branch change so each branch segment is collected", () => {
		// Adjacent entries on different (both-known) branches break the segment;
		// both segments edit foo.ts in-window, so both slices are collected.
		const idx = index([{ hash: "C1", offsetMin: 30, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 5, gitBranch: "a", editedRel: ["foo.ts"], role: "assistant", content: "on a" }),
			entry({ offsetMin: 6, gitBranch: "b", editedRel: ["foo.ts"], role: "assistant", content: "on b" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(2);
	});

	it("modalBranch ignores blank-branch entries and keeps the first on a tie", () => {
		const idx = index([{ hash: "C1", offsetMin: 30, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 5, gitBranch: "x", editedRel: ["foo.ts"], role: "assistant", content: "e1" }),
			entry({ offsetMin: 6, gitBranch: "", role: "human", content: "blank branch" }),
			entry({ offsetMin: 7, gitBranch: "y", role: "human", content: "y1" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		// x and y each occur once; the first to reach the max (x) wins; "" is skipped.
		expect(res.attributed.get("C1")?.branch).toBe("x");
	});

	it("drops an entry that has text content but no role", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 5, editedRel: ["foo.ts"], content: "content but no role" }),
			entry({ offsetMin: 6, editedRel: ["foo.ts"], role: "assistant", content: "kept" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		const a = res.attributed.get("C1");
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("kept");
	});
});

describe("attributeCommits — time-window MEDIUM (③, opt-in)", () => {
	it("attributes an in-window segment ending just before the commit when no file edit matches", () => {
		const idx = index([{ hash: "C1", offsetMin: 30, files: ["foo.ts"], branch: "feat" }]);
		// session discusses, edits NOTHING in foo.ts, ends ~5m before commit
		const entries = [
			entry({ offsetMin: 24, gitBranch: "feat", role: "human", content: "let's plan" }),
			entry({ offsetMin: 25, gitBranch: "feat", role: "assistant", content: "ok" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx, { includeMedium: true });
		const a = res.attributed.get("C1");
		expect(a?.confidence).toBe("medium");
		expect(a?.method).toBe("time-window");
	});

	it("does not emit MEDIUM by default (includeMedium off)", () => {
		const idx = index([{ hash: "C1", offsetMin: 30, files: ["foo.ts"] }]);
		const entries = [entry({ offsetMin: 25, role: "human", content: "plan" })];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx);
		expect(res.attributed.has("C1")).toBe(false);
	});

	it("MEDIUM branch gate rejects a segment on a different known branch", () => {
		const idx = index([{ hash: "C1", offsetMin: 30, files: ["foo.ts"], branch: "main" }]);
		const entries = [entry({ offsetMin: 25, gitBranch: "feat", role: "human", content: "on feat, not main" })];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx, { includeMedium: true });
		expect(res.attributed.has("C1")).toBe(false);
	});

	it("MEDIUM ignores a segment that ended long before the commit", () => {
		const idx = index([{ hash: "C1", offsetMin: 600, files: ["foo.ts"], branch: "feat" }]);
		// segment ends at 25m, commit at 600m (~9.6h later, > 2h gap) → not "led into it"
		const entries = [entry({ offsetMin: 25, gitBranch: "feat", role: "human", content: "stale" })];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx, { includeMedium: true });
		expect(res.attributed.has("C1")).toBe(false);
	});

	it("MEDIUM collects the in-window segment and skips a later out-of-window one", () => {
		const idx = index([{ hash: "C1", offsetMin: 100, files: ["foo.ts"], branch: "feat" }]);
		const entries = [
			entry({ offsetMin: 95, gitBranch: "feat", role: "human", content: "in window" }),
			// >2h gap → new segment; offset 300 is AFTER the commit (100) → out of window → empty slice.
			entry({ offsetMin: 300, gitBranch: "feat", role: "human", content: "after commit" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx, { includeMedium: true });
		const a = res.attributed.get("C1");
		expect(a?.confidence).toBe("medium");
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("in window");
	});

	it("MEDIUM keeps a segment whose two entries share a timestamp", () => {
		// Equal timestamps exercise the `tsMs > segEnd` false branch (segEnd not bumped).
		const idx = index([{ hash: "C1", offsetMin: 30, files: ["foo.ts"], branch: "feat" }]);
		const entries = [
			entry({ offsetMin: 25, lineNo: 1, gitBranch: "feat", role: "human", content: "a" }),
			entry({ offsetMin: 25, lineNo: 2, gitBranch: "feat", role: "assistant", content: "b" }),
		];
		const res = attributeCommits(["C1"], new Map([["S1", entries]]), idx, { includeMedium: true });
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(2);
	});
});
