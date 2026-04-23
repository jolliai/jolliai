import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../Types.js";
import {
	aggregateStats,
	aggregateTurns,
	collectAllTopics,
	collectSourceNodes,
	computeDurationDays,
	countTopics,
	deleteTopicInTree,
	formatDurationLabel,
	isLeafNode,
	updateTopicInTree,
} from "./SummaryTree.js";

/** Helper to create a minimal leaf node */
function leaf(overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 3,
		commitHash: "aaa",
		commitMessage: "msg",
		commitAuthor: "author",
		commitDate: "2026-03-01T10:00:00.000Z",
		branch: "main",
		generatedAt: "2026-03-01T10:00:10.000Z",
		transcriptEntries: 5,
		conversationTurns: 3,
		llm: { model: "test-model", inputTokens: 100, outputTokens: 50, apiLatencyMs: 1000, stopReason: "end_turn" },
		stats: { filesChanged: 2, insertions: 50, deletions: 10 },
		topics: [{ title: "Topic A", trigger: "t", response: "r", decisions: "d" }],
		...overrides,
	};
}

// ─── Scenario setup ──────────────────────────────────────────────────────────
// A = original commit (10:00)
// C = amend of A (10:05) — has own topics + children:[A]
// B = independent commit (10:20)
// D = squash of C+B (10:30) — pure container, children:[B, C] (newest first)

const A = leaf({
	commitHash: "aaa",
	commitMessage: "feat: login",
	commitDate: "2026-03-01T10:00:00.000Z",
	stats: { filesChanged: 3, insertions: 120, deletions: 5 },
	conversationTurns: 8,
	topics: [{ title: "Implement login", trigger: "t1", response: "r1", decisions: "d1" }],
});

const C: CommitSummary = {
	version: 3,
	commitHash: "ccc",
	commitMessage: "feat: login",
	commitAuthor: "author",
	commitDate: "2026-03-01T10:05:00.000Z",
	branch: "main",
	generatedAt: "2026-03-01T10:05:10.000Z",
	transcriptEntries: 2,
	conversationTurns: 1,
	stats: { filesChanged: 1, insertions: 3, deletions: 3 },
	topics: [{ title: "Fix indentation", trigger: "t2", response: "r2", decisions: "d2" }],
	children: [A],
};

const B = leaf({
	commitHash: "bbb",
	commitMessage: "feat: logout",
	commitDate: "2026-03-01T10:20:00.000Z",
	stats: { filesChanged: 2, insertions: 80, deletions: 2 },
	conversationTurns: 5,
	topics: [{ title: "Implement logout", trigger: "t3", response: "r3", decisions: "d3" }],
});

const D: CommitSummary = {
	version: 3,
	commitHash: "ddd",
	commitMessage: "feat: auth module",
	commitAuthor: "author",
	commitDate: "2026-03-01T10:30:00.000Z",
	branch: "main",
	generatedAt: "2026-03-01T10:30:03.000Z",
	// Pure container: no topics, stats, llm
	children: [B, C], // newest first
};

describe("SummaryTree", () => {
	describe("collectAllTopics", () => {
		it("returns own topics for a leaf node", () => {
			const topics = collectAllTopics(A);
			expect(topics).toHaveLength(1);
			expect(topics[0].title).toBe("Implement login");
			expect(topics[0].commitDate).toBe("2026-03-01T10:00:00.000Z");
		});

		it("returns children topics before own for an amend node", () => {
			const topics = collectAllTopics(C);
			expect(topics).toHaveLength(2);
			expect(topics[0].title).toBe("Implement login"); // A (older)
			expect(topics[1].title).toBe("Fix indentation"); // C own (newer)
		});

		it("returns all topics in chronological order for a squash node", () => {
			const topics = collectAllTopics(D);
			expect(topics).toHaveLength(3);
			// D.children = [B, C], reversed → [C, B] for chronological
			// C recurse: A(10:00) then C(10:05), then B(10:20)
			expect(topics[0].title).toBe("Implement login"); // A
			expect(topics[1].title).toBe("Fix indentation"); // C
			expect(topics[2].title).toBe("Implement logout"); // B
		});

		it("returns empty array for a container with no topics", () => {
			const empty: CommitSummary = {
				...D,
				children: [],
			};
			expect(collectAllTopics(empty)).toHaveLength(0);
		});
	});

	describe("aggregateStats", () => {
		it("returns own stats for a leaf node", () => {
			const stats = aggregateStats(A);
			expect(stats).toEqual({ filesChanged: 3, insertions: 120, deletions: 5 });
		});

		it("aggregates across amend tree", () => {
			const stats = aggregateStats(C);
			expect(stats).toEqual({ filesChanged: 4, insertions: 123, deletions: 8 });
		});

		it("aggregates across full squash tree", () => {
			const stats = aggregateStats(D);
			// D(0) + B(2,80,2) + C(1,3,3) + A(3,120,5)
			expect(stats).toEqual({ filesChanged: 6, insertions: 203, deletions: 10 });
		});

		it("does not mutate the original node stats", () => {
			const before = JSON.stringify(A.stats);
			aggregateStats(D);
			expect(JSON.stringify(A.stats)).toBe(before);
		});

		it("handles missing stats", () => {
			const noStats: CommitSummary = { ...D, stats: undefined };
			const stats = aggregateStats(noStats);
			// Only children contribute
			expect(stats.insertions).toBe(203);
		});
	});

	describe("aggregateTurns", () => {
		it("returns own turns for a leaf", () => {
			expect(aggregateTurns(A)).toBe(8);
		});

		it("sums across tree", () => {
			// D(0) + B(5) + C(1) + A(8) = 14
			expect(aggregateTurns(D)).toBe(14);
		});
	});

	describe("countTopics", () => {
		it("counts leaf topics", () => {
			expect(countTopics(A)).toBe(1);
		});

		it("counts across full tree", () => {
			expect(countTopics(D)).toBe(3);
		});
	});

	describe("collectSourceNodes", () => {
		it("returns the leaf itself", () => {
			const nodes = collectSourceNodes(A);
			expect(nodes).toHaveLength(1);
			expect(nodes[0].commitHash).toBe("aaa");
		});

		it("includes amend node and its child (newest first)", () => {
			const nodes = collectSourceNodes(C);
			expect(nodes).toHaveLength(2);
			expect(nodes[0].commitHash).toBe("ccc"); // C (newer, own data)
			expect(nodes[1].commitHash).toBe("aaa"); // A (older, from child)
		});

		it("skips pure container, collects all data nodes (newest first)", () => {
			const nodes = collectSourceNodes(D);
			expect(nodes).toHaveLength(3);
			expect(nodes.map((n) => n.commitHash)).toEqual(["bbb", "ccc", "aaa"]);
		});
	});

	describe("isLeafNode", () => {
		it("returns true for node without children", () => {
			expect(isLeafNode(A)).toBe(true);
		});

		it("returns false for node with children", () => {
			expect(isLeafNode(C)).toBe(false);
		});

		it("returns true for empty children array", () => {
			expect(isLeafNode({ ...A, children: [] })).toBe(true);
		});
	});

	describe("computeDurationDays", () => {
		it("returns 1 for a leaf node", () => {
			expect(computeDurationDays(A)).toBe(1);
		});

		it("returns 1 when all sources are same day", () => {
			expect(computeDurationDays(D)).toBe(1); // all on 2026-03-01
		});

		it("returns correct days for multi-day span", () => {
			const multiDay: CommitSummary = {
				...D,
				children: [
					{ ...B, commitDate: "2026-03-03T10:00:00.000Z", generatedAt: "2026-03-03T10:00:10.000Z" },
					{ ...A, commitDate: "2026-03-01T10:00:00.000Z", generatedAt: "2026-03-01T10:00:10.000Z" },
				],
			};
			expect(computeDurationDays(multiDay)).toBe(2);
		});

		it("falls back to commitDate when a source has no generatedAt (covers `||` right branch)", () => {
			// One child with empty generatedAt forces the fallback path inside the Set map.
			const mixed: CommitSummary = {
				...D,
				children: [
					{ ...B, commitDate: "2026-03-03T10:00:00.000Z", generatedAt: "" },
					{ ...A, commitDate: "2026-03-01T10:00:00.000Z", generatedAt: "2026-03-01T10:00:10.000Z" },
				],
			};
			expect(computeDurationDays(mixed)).toBe(2);
		});
	});

	describe("formatDurationLabel", () => {
		it("returns '1 day' for leaf node", () => {
			expect(formatDurationLabel(A)).toBe("1 day");
		});

		it("includes date range for multi-source same day", () => {
			const label = formatDurationLabel(D);
			// Multiple sources even on same day → shows range
			expect(label).toMatch(/^1 day \(/);
		});

		it("includes date range for multi-day span", () => {
			const multiDay: CommitSummary = {
				...D,
				children: [
					{ ...B, commitDate: "2026-03-05T10:00:00.000Z", generatedAt: "2026-03-05T10:00:10.000Z" },
					{ ...A, commitDate: "2026-03-01T10:00:00.000Z", generatedAt: "2026-03-01T10:00:10.000Z" },
				],
			};
			const label = formatDurationLabel(multiDay);
			expect(label).toMatch(/^2 days \(/);
			expect(label).toContain("Mar");
		});

		it("falls back to commitDate for timestamp computation when generatedAt is empty", () => {
			// Covers the `s.generatedAt || s.commitDate` right branch in formatDurationLabel.
			const mixed: CommitSummary = {
				...D,
				children: [
					{ ...B, commitDate: "2026-03-05T10:00:00.000Z", generatedAt: "" },
					{ ...A, commitDate: "2026-03-01T10:00:00.000Z", generatedAt: "2026-03-01T10:00:10.000Z" },
				],
			};
			const label = formatDurationLabel(mixed);
			expect(label).toMatch(/^2 days \(/);
		});
	});

	describe("updateTopicInTree", () => {
		it("updates a leaf topic by global index", () => {
			const result = updateTopicInTree(A, 0, { title: "Updated login" });
			expect(result).not.toBeNull();
			expect(result?.consumed).toBe(1);
			expect(result?.result.topics?.[0]?.title).toBe("Updated login");
			expect(A.topics?.[0]?.title).toBe("Implement login");
		});

		it("updates the oldest child topic before newer siblings", () => {
			const result = updateTopicInTree(D, 0, { decisions: "changed" });
			expect(result).not.toBeNull();
			const updatedTopics = collectAllTopics((result as NonNullable<typeof result>).result);
			expect(updatedTopics[0].title).toBe("Implement login");
			expect(updatedTopics[0].decisions).toBe("changed");
			expect(updatedTopics[1].decisions).toBe("d2");
			expect(updatedTopics[2].decisions).toBe("d3");
		});

		it("updates own topics after child topics have been consumed", () => {
			const result = updateTopicInTree(C, 1, { response: "new-response" });
			expect(result).not.toBeNull();
			expect(result?.consumed).toBe(2);
			expect(result?.result.topics?.[0]?.response).toBe("new-response");
			expect(result?.result.children?.[0]?.topics?.[0]?.response).toBe("r1");
		});

		it("updates only the targeted topic when a node has multiple own topics", () => {
			const multiTopicNode: CommitSummary = {
				...A,
				topics: [
					{ title: "Topic A", trigger: "t1", response: "r1", decisions: "d1" },
					{ title: "Topic B", trigger: "t2", response: "r2", decisions: "d2" },
				],
			};

			const result = updateTopicInTree(multiTopicNode, 1, { decisions: "updated" });

			expect(result).not.toBeNull();
			expect(result?.result.topics?.[0]?.decisions).toBe("d1");
			expect(result?.result.topics?.[1]?.decisions).toBe("updated");
		});

		it("returns the original tree unchanged when the global index is out of range", () => {
			const result = updateTopicInTree(D, 99, { title: "nope" });
			expect(result).not.toBeNull();
			expect(result?.consumed).toBe(3);
			expect(result?.result).toBe(D);
		});
	});

	describe("deleteTopicInTree", () => {
		it("deletes a leaf topic by global index", () => {
			const result = deleteTopicInTree(A, 0);
			expect(result).not.toBeNull();
			expect(result?.consumed).toBe(1);
			expect(result?.result.topics).toEqual([]);
			expect(A.topics).toHaveLength(1);
		});

		it("deletes an own topic after traversing child topics first", () => {
			const result = deleteTopicInTree(C, 1);
			expect(result).not.toBeNull();
			expect(result?.result.topics).toEqual([]);
			expect(result?.result.children?.[0]?.topics?.[0]?.title).toBe("Implement login");
		});

		it("deletes a child topic while preserving newer siblings", () => {
			const result = deleteTopicInTree(D, 0);
			expect(result).not.toBeNull();
			const remainingTopics = collectAllTopics((result as NonNullable<typeof result>).result);
			expect(remainingTopics.map((topic) => topic.title)).toEqual(["Fix indentation", "Implement logout"]);
			expect(result?.result.children?.[0]?.commitHash).toBe("bbb");
		});

		it("returns the original tree unchanged when deleting an out-of-range topic", () => {
			const result = deleteTopicInTree(D, 99);
			expect(result).not.toBeNull();
			expect(result?.consumed).toBe(3);
			expect(result?.result).toBe(D);
		});
	});
});
