import { describe, expect, it } from "vitest";
import { attributeCommits } from "./CommitAttributor.js";
import type { CommitTargetIndex } from "./CommitTargetIndex.js";
import type { RawEntry } from "./RawTranscriptScanner.js";

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const min = (n: number) => n * 60_000;
const ROOTS = ["e:/repo"];

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
		cwd: "cwd" in over ? over.cwd : "e:/repo",
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

const sess = (entries: RawEntry[], sid = "S1") => new Map([[sid, entries]]);

describe("attributeCommits — file-overlap window model (HIGH)", () => {
	it("attributes a session that edited the commit's files within (L, T]", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "editing foo" })];
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ROOTS });
		const a = res.attributed.get("C1");
		expect(a?.confidence).toBe("high");
		expect(a?.method).toBe("file-overlap");
		expect(a?.sessions).toHaveLength(1);
		expect(a?.branch).toBe("feat");
	});

	it("② caps attribution at the commit time — later entries are excluded", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "before commit" }),
			entry({ offsetMin: 20, role: "human", content: "after commit — must be excluded" }),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { minTier: "low", worktreeRoots: ROOTS });
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
		const res = attributeCommits(["C0", "C1"], sess(entries), idx, { minTier: "low", worktreeRoots: ROOTS });
		// C1 only gets the 20m entry (3m belongs to C0's window, before C1's L=5m).
		const c1 = res.attributed.get("C1");
		expect(c1?.transcriptEntries).toBe(1);
		expect(c1?.sessions[0].entries[0].content).toBe("C1 work (in window)");
	});

	it("recovers a commit even when its files were first committed by a sibling (the recall fix)", () => {
		const idx = index([
			{ hash: "SIB", offsetMin: 8, files: ["bar.ts"] },
			{ hash: "C", offsetMin: 20, files: ["bar.ts"] },
		]);
		const entries = [entry({ offsetMin: 12, editedRel: ["bar.ts"], role: "assistant", content: "work for C" })];
		const res = attributeCommits(["SIB", "C"], sess(entries), idx, { worktreeRoots: ROOTS });
		expect(res.attributed.get("C")?.method).toBe("file-overlap");
	});

	it("skips a commit no session touched (→ engine diff-only)", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [entry({ offsetMin: 5, editedRel: ["other.ts"], role: "assistant", content: "unrelated" })];
		const res = attributeCommits(["C1"], sess(entries), idx, { minTier: "low", worktreeRoots: ROOTS });
		expect(res.attributed.has("C1")).toBe(false);
		expect(res.skipped).toContain("C1");
	});

	it("skips a target absent from the index (no files)", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const res = attributeCommits(["UNKNOWN"], new Map(), idx, { worktreeRoots: ROOTS });
		expect(res.skipped).toContain("UNKNOWN");
	});

	it("matches by basename when the edit's relative path differs", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["cli/src/foo.ts"] }]);
		const entries = [
			entry({
				offsetMin: 5,
				editedRel: ["other/foo.ts"],
				editedBase: ["foo.ts"],
				role: "assistant",
				content: "x",
			}),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ROOTS });
		expect(res.attributed.get("C1")?.method).toBe("file-overlap");
	});

	it("excludes pure tool-call entries (no text) from the built session", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 4, editedRel: ["foo.ts"] }), // pure tool call, no role/content
			entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "kept turn" }),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ROOTS });
		const a = res.attributed.get("C1");
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("kept turn");
	});

	it("splits the in-window slice on a >2h idle gap (keeps only the touching segment at HIGH)", () => {
		const idx = index([{ hash: "C1", offsetMin: 200, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 10, role: "human", content: "early unrelated chat" }),
			// >2h gap → new segment; this later segment edits foo.ts
			entry({ offsetMin: 190, editedRel: ["foo.ts"], role: "assistant", content: "the actual work" }),
		];
		// minTier high: the early-chat segment has no anchor → dropped; only the work segment survives.
		const res = attributeCommits(["C1"], sess(entries), idx, { minTier: "high", worktreeRoots: ROOTS });
		const a = res.attributed.get("C1");
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("the actual work");
	});

	it("skips a commit whose only in-window touch is a non-conversational tool call", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [entry({ offsetMin: 5, editedRel: ["foo.ts"] })]; // edit only, no role/content
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ROOTS });
		expect(res.attributed.has("C1")).toBe(false);
		expect(res.skipped).toContain("C1");
	});

	it("splits a session on a branch change so each branch segment is collected", () => {
		const idx = index([{ hash: "C1", offsetMin: 30, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 5, gitBranch: "a", editedRel: ["foo.ts"], role: "assistant", content: "on a" }),
			entry({ offsetMin: 6, gitBranch: "b", editedRel: ["foo.ts"], role: "assistant", content: "on b" }),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ROOTS });
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(2);
	});
});

describe("attributeCommits — effective worktree", () => {
	it("narrows to the worktree that edited the commit's files (other worktrees excluded)", () => {
		const idx = index([{ hash: "C1", offsetMin: 20, files: ["foo.ts"] }]);
		const bySession = new Map([
			["S1", [entry({ offsetMin: 10, editedRel: ["foo.ts"], role: "assistant", content: "work in wt1" })]],
			[
				"S2",
				[
					entry({
						sessionId: "S2",
						transcriptPath: "/p/S2.jsonl",
						cwd: "e:/repo-wt2",
						offsetMin: 12,
						role: "human",
						content: "unrelated chat in wt2",
					}),
				],
			],
		]);
		const res = attributeCommits(["C1"], bySession, idx, {
			minTier: "low",
			worktreeRoots: ["e:/repo", "e:/repo-wt2"],
		});
		const a = res.attributed.get("C1");
		// Even at minTier "low", the wt2 chat is excluded — its worktree has no anchor.
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("work in wt1");
	});

	it("normalizes a subdirectory cwd to its worktree root (no split)", () => {
		const idx = index([{ hash: "C1", offsetMin: 20, files: ["foo.ts"] }]);
		const bySession = new Map([
			["S1", [entry({ offsetMin: 10, editedRel: ["foo.ts"], role: "assistant", content: "root work" })]],
			[
				"S2",
				[
					entry({
						sessionId: "S2",
						transcriptPath: "/p/S2.jsonl",
						cwd: "e:/repo/cli", // launched from a subdir of the same worktree
						offsetMin: 12,
						editedRel: ["foo.ts"],
						role: "assistant",
						content: "subdir work",
					}),
				],
			],
		]);
		const res = attributeCommits(["C1"], bySession, idx, { worktreeRoots: ROOTS });
		// Both cwds normalize to worktree root "e:/repo" → both anchored, both collected.
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(2);
	});

	it("falls back to the cwd itself when it matches no worktree root", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "x" })];
		// worktreeRoots doesn't contain the entry cwd → key falls back to the cwd.
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ["e:/somewhere-else"] });
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(1);
	});

	it("handles an entry with no cwd (worktree key '')", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 5, cwd: undefined, editedRel: ["foo.ts"], role: "assistant", content: "x" }),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ROOTS });
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(1);
	});
});

describe("attributeCommits — cursor slicing", () => {
	// Two commits with DISJOINT files (so C2's window reaches back past C1) in ONE worktree.
	const idx = index([
		{ hash: "C1", offsetMin: 10, files: ["a.ts"] },
		{ hash: "C2", offsetMin: 30, files: ["b.ts"] },
	]);
	// One long session: two turns of C1 work, then two of C2 work, all one segment.
	const entries = () => [
		entry({ offsetMin: 4, lineNo: 1, editedRel: ["a.ts"], role: "assistant", content: "C1 work a" }),
		entry({ offsetMin: 6, lineNo: 2, role: "human", content: "C1 work b" }),
		entry({ offsetMin: 24, lineNo: 3, editedRel: ["b.ts"], role: "assistant", content: "C2 work a" }),
		entry({ offsetMin: 26, lineNo: 4, role: "human", content: "C2 work b" }),
	];

	it("a neighbor candidate truncates the window (no bleed into C2)", () => {
		const res = attributeCommits(["C1", "C2"], sess(entries()), idx, {
			minTier: "low",
			emitOnly: new Set(["C2"]),
			worktreeRoots: ROOTS,
		});
		const c2 = res.attributed.get("C2");
		// C1 (@10m) owns everything up to 10m, so C2 gets only its own two ≥24m turns.
		expect(c2?.sessions[0].entries.map((e) => e.content)).toEqual(["C2 work a", "C2 work b"]);
	});

	it("WITHOUT the neighbor as a candidate, C2 wrongly absorbs C1's turns (the bug being fixed)", () => {
		const res = attributeCommits(["C2"], sess(entries()), idx, {
			minTier: "low",
			emitOnly: new Set(["C2"]),
			worktreeRoots: ROOTS,
		});
		// No C1 boundary → C2's 7-day window swallows the earlier "C1 work" turns too.
		expect(res.attributed.get("C2")?.transcriptEntries).toBe(4);
	});

	it("slices one long session into contiguous per-commit blocks (no interleaving)", () => {
		const res = attributeCommits(["C1", "C2"], sess(entries()), idx, { minTier: "low", worktreeRoots: ROOTS });
		const c1 = res.attributed.get("C1");
		const c2 = res.attributed.get("C2");
		// Each commit gets a contiguous 2-turn block; the split is clean, not interleaved.
		expect(c1?.sessions[0].entries.map((e) => e.content)).toEqual(["C1 work a", "C1 work b"]);
		expect(c2?.sessions[0].entries.map((e) => e.content)).toEqual(["C2 work a", "C2 work b"]);
	});

	it("skips a commit whose only anchor is claimed by a later neighbor commit", () => {
		// C2's file was edited at 15m, but C1 committed at 16m (after that edit) — the
		// cursor assigns the 15m slice to C1, leaving C2 with nothing → diff-only.
		const idx2 = index([
			{ hash: "C1", offsetMin: 16, files: ["a.ts"] },
			{ hash: "C2", offsetMin: 20, files: ["foo.ts"] },
		]);
		const entries2 = [
			entry({ offsetMin: 14, editedRel: ["a.ts"], role: "assistant", content: "C1 anchor" }),
			entry({ offsetMin: 15, editedRel: ["foo.ts"], role: "assistant", content: "C2 edit, claimed by C1" }),
		];
		const res = attributeCommits(["C1", "C2"], sess(entries2), idx2, {
			minTier: "low",
			emitOnly: new Set(["C2"]),
			worktreeRoots: ROOTS,
		});
		expect(res.attributed.has("C2")).toBe(false);
		expect(res.skipped).toContain("C2");
	});
});

describe("attributeCommits — confidence tiers", () => {
	it("MEDIUM (branch-match): an on-effBranch turn in an anchor-free segment", () => {
		const idx = index([{ hash: "C1", offsetMin: 400, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 10, gitBranch: "feat", role: "human", content: "feat planning" }), // seg1, no anchor, on effBranch
			// >2h gap → new segment; a pure tool-call anchor (no role/content) fixes effWt/effBranch
			entry({ offsetMin: 350, gitBranch: "feat", editedRel: ["foo.ts"] }),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { minTier: "medium", worktreeRoots: ROOTS });
		const a = res.attributed.get("C1");
		expect(a?.confidence).toBe("medium");
		expect(a?.method).toBe("branch-match");
		expect(a?.transcriptEntries).toBe(1); // only the conversational planning turn survives
		expect(a?.sessions[0].entries[0].content).toBe("feat planning");
	});

	it("LOW (time-window): an off-branch, anchor-free turn is kept only at minTier low", () => {
		const idx = index([{ hash: "C1", offsetMin: 400, files: ["foo.ts"] }]);
		const mk = () => [
			entry({ offsetMin: 10, gitBranch: "main", role: "human", content: "planning on main" }), // LOW
			entry({ offsetMin: 350, gitBranch: "feat", editedRel: ["foo.ts"], role: "assistant", content: "the work" }), // HIGH anchor
		];
		const low = attributeCommits(["C1"], sess(mk()), idx, { minTier: "low", worktreeRoots: ROOTS });
		const a = low.attributed.get("C1");
		// Weakest kept tier is LOW → the whole attribution is reported as low/time-window.
		expect(a?.confidence).toBe("low");
		expect(a?.method).toBe("time-window");
		expect(a?.transcriptEntries).toBe(2);

		const high = attributeCommits(["C1"], sess(mk()), idx, { minTier: "high", worktreeRoots: ROOTS });
		const b = high.attributed.get("C1");
		// minTier high drops the LOW turn → only the file-overlap turn remains.
		expect(b?.confidence).toBe("high");
		expect(b?.transcriptEntries).toBe(1);
		expect(b?.sessions[0].entries[0].content).toBe("the work");
	});

	it("rolls confidence up to the WEAKEST tier kept, never overclaiming", () => {
		// HIGH anchor turn + a MEDIUM (on-branch, anchor-free) turn → reported medium.
		const idx = index([{ hash: "C1", offsetMin: 400, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 10, gitBranch: "feat", role: "human", content: "feat planning (MED)" }),
			entry({
				offsetMin: 350,
				gitBranch: "feat",
				editedRel: ["foo.ts"],
				role: "assistant",
				content: "work (HIGH)",
			}),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { minTier: "medium", worktreeRoots: ROOTS });
		expect(res.attributed.get("C1")?.confidence).toBe("medium");
	});

	it("does NOT mark a turn HIGH when the segment's anchor is owned by a neighbor commit", () => {
		// Cprev floors C's window at 10m; Cmid (edits other.ts @18m) steals the foo.ts
		// edit @15m via the cursor. C legitimately owns only the discussion turn @25m,
		// which must NOT be reported as file-overlap just because @15m sits in its segment.
		const idx = index([
			{ hash: "Cprev", offsetMin: 10, files: ["foo.ts"] },
			{ hash: "Cmid", offsetMin: 20, files: ["other.ts"] },
			{ hash: "C", offsetMin: 30, files: ["foo.ts"] },
		]);
		const entries = [
			entry({ offsetMin: 15, lineNo: 1, editedRel: ["foo.ts"], role: "assistant", content: "foo edit" }),
			entry({ offsetMin: 18, lineNo: 2, editedRel: ["other.ts"], role: "assistant", content: "other edit" }),
			entry({ offsetMin: 25, lineNo: 3, gitBranch: "feat", role: "human", content: "C discussion" }),
		];
		const res = attributeCommits(["Cprev", "Cmid", "C"], sess(entries), idx, {
			minTier: "low",
			emitOnly: new Set(["C"]),
			worktreeRoots: ROOTS,
		});
		const c = res.attributed.get("C");
		// @15m foo edit is owned by Cmid → C's @25m turn is branch-match, not file-overlap.
		expect(c?.sessions[0].entries.map((e) => e.content)).toEqual(["C discussion"]);
		expect(c?.confidence).toBe("medium");
		expect(c?.method).toBe("branch-match");
	});

	it("effBranch is the anchors' modal branch, not stolen by dominant main chatter", () => {
		const idx = index([{ hash: "C1", offsetMin: 400, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 10, gitBranch: "main", role: "human", content: "m1" }),
			entry({ offsetMin: 12, gitBranch: "main", role: "human", content: "m2" }),
			entry({ offsetMin: 14, gitBranch: "main", role: "human", content: "m3" }),
			// branch change → new segment; the sole anchor is on "feat"
			entry({ offsetMin: 16, gitBranch: "feat", editedRel: ["foo.ts"], role: "assistant", content: "feat work" }),
		];
		const low = attributeCommits(["C1"], sess(entries), idx, { minTier: "low", worktreeRoots: ROOTS });
		// Despite 3 main turns vs 1 feat turn, effBranch = the anchor's branch.
		expect(low.attributed.get("C1")?.branch).toBe("feat");

		const med = attributeCommits(["C1"], sess(entries), idx, { minTier: "medium", worktreeRoots: ROOTS });
		// At medium, the 3 main turns (LOW) are dropped; only the feat anchor turn remains.
		expect(med.attributed.get("C1")?.transcriptEntries).toBe(1);
	});

	it("keeps the anchors' branch even when the index %S branch differs (rename-safe)", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"], branch: "new-name-after-rename" }]);
		const entries = [
			entry({ offsetMin: 5, gitBranch: "old-name", editedRel: ["foo.ts"], role: "assistant", content: "x" }),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ROOTS });
		expect(res.attributed.get("C1")?.branch).toBe("old-name");
	});

	it("falls back to the in-window modal branch when anchors carry no branch", () => {
		const idx = index([{ hash: "C1", offsetMin: 20, files: ["foo.ts"] }]);
		const entries = [
			entry({
				offsetMin: 10,
				gitBranch: "",
				editedRel: ["foo.ts"],
				role: "assistant",
				content: "anchor no branch",
			}),
			entry({ offsetMin: 12, gitBranch: "feat", role: "human", content: "later turn with branch" }),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { minTier: "low", worktreeRoots: ROOTS });
		expect(res.attributed.get("C1")?.branch).toBe("feat");
	});

	it("does NOT attribute a commit with no file anchor, even on a matching branch", () => {
		const idx = index([{ hash: "C1", offsetMin: 30, files: ["foo.ts"], branch: "feat" }]);
		const entries = [
			entry({ offsetMin: 25, gitBranch: "feat", role: "human", content: "just discussing, no edits" }),
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { minTier: "low", worktreeRoots: ROOTS });
		expect(res.attributed.has("C1")).toBe(false);
		expect(res.skipped).toContain("C1");
	});
});

describe("attributeCommits — emit scope & defaults", () => {
	it("emits for every candidate when emitOnly is omitted", () => {
		const idx = index([{ hash: "C1", offsetMin: 10, files: ["foo.ts"] }]);
		const entries = [entry({ offsetMin: 5, editedRel: ["foo.ts"], role: "assistant", content: "x" })];
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ROOTS });
		expect(res.attributed.has("C1")).toBe(true);
	});

	it("does not emit a candidate that is only a cursor boundary (not in emitOnly)", () => {
		const idx = index([
			{ hash: "C1", offsetMin: 10, files: ["a.ts"] },
			{ hash: "C2", offsetMin: 30, files: ["b.ts"] },
		]);
		const entries = [
			entry({ offsetMin: 5, editedRel: ["a.ts"], role: "assistant", content: "C1 work" }),
			entry({ offsetMin: 25, editedRel: ["b.ts"], role: "assistant", content: "C2 work" }),
		];
		const res = attributeCommits(["C1", "C2"], sess(entries), idx, {
			emitOnly: new Set(["C2"]),
			worktreeRoots: ROOTS,
		});
		expect(res.attributed.has("C1")).toBe(false); // boundary only
		expect(res.attributed.has("C2")).toBe(true);
	});

	it("treats each distinct cwd as its own worktree when worktreeRoots is omitted", () => {
		const idx = index([{ hash: "C1", offsetMin: 20, files: ["foo.ts"] }]);
		const bySession = new Map([
			[
				"S1",
				[
					entry({
						offsetMin: 10,
						cwd: "e:/repoA",
						editedRel: ["foo.ts"],
						role: "assistant",
						content: "A work",
					}),
				],
			],
			[
				"S2",
				[
					entry({
						sessionId: "S2",
						transcriptPath: "/p/S2.jsonl",
						cwd: "e:/repoB", // a different cwd → a different worktree key
						offsetMin: 12,
						role: "human",
						content: "B chat (no edit)",
					}),
				],
			],
		]);
		// No worktreeRoots → each cwd is its own key. Only repoA anchored C1, so repoB's
		// chat is excluded (were the keys wrongly merged, it would leak in at minTier low).
		const res = attributeCommits(["C1"], bySession, idx, { minTier: "low" });
		const a = res.attributed.get("C1");
		expect(a?.transcriptEntries).toBe(1);
		expect(a?.sessions[0].entries[0].content).toBe("A work");
	});

	it("defaults minTier to low (window-collect-all) — the unified tier", () => {
		const idx = index([{ hash: "C1", offsetMin: 400, files: ["foo.ts"] }]);
		const entries = [
			entry({ offsetMin: 10, gitBranch: "main", role: "human", content: "planning on main" }), // LOW
			entry({ offsetMin: 350, gitBranch: "feat", editedRel: ["foo.ts"], role: "assistant", content: "work" }), // HIGH
		];
		const res = attributeCommits(["C1"], sess(entries), idx, { worktreeRoots: ROOTS });
		// No minTier → low default keeps the LOW planning turn too; confidence rolls
		// up to the weakest kept tier (low).
		expect(res.attributed.get("C1")?.confidence).toBe("low");
		expect(res.attributed.get("C1")?.transcriptEntries).toBe(2);
	});
});
