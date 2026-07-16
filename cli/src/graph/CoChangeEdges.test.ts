import { describe, expect, it } from "vitest";
import { computeCoChangeTopicEdges } from "./CoChangeEdges.js";
import type { DistilledTopic, DistilledUnit } from "./GraphSchema.js";

function topic(slug: string, categoryId: string): DistilledTopic {
	return { slug, categoryId, shortTitle: slug, summary: "s", title: slug };
}

function unit(id: string, topicSlug: string, files: string[]): DistilledUnit {
	return {
		id,
		topicSlug,
		kinds: ["decision"],
		shortTitle: id,
		summary: "s",
		anchors: { files, commits: [] },
	};
}

describe("computeCoChangeTopicEdges", () => {
	it("returns [] for fewer than two topics", () => {
		expect(computeCoChangeTopicEdges([], [])).toEqual([]);
		expect(computeCoChangeTopicEdges([unit("u", "t1", ["a.ts"])], [topic("t1", "c1")])).toEqual([]);
	});

	it("links two topics in DIFFERENT categories that share a file", () => {
		const topics = [topic("t1", "c1"), topic("t2", "c2")];
		const units = [unit("u1", "t1", ["a.ts", "b.ts"]), unit("u2", "t2", ["b.ts", "c.ts"])];
		const edges = computeCoChangeTopicEdges(units, topics);
		expect(edges).toEqual([
			{ fromTopic: "t1", toTopic: "t2", kind: "co-change", sharedFiles: ["b.ts"], sharedFileCount: 1 },
		]);
	});

	it("does NOT link two topics in the SAME category even if they share files", () => {
		const topics = [topic("t1", "c1"), topic("t2", "c1")];
		const units = [unit("u1", "t1", ["a.ts"]), unit("u2", "t2", ["a.ts"])];
		expect(computeCoChangeTopicEdges(units, topics)).toEqual([]);
	});

	it("excludes god files (touched by >= godFileCategoryThreshold categories)", () => {
		// god.ts is touched by c1/c2/c3 (3 categories, == default threshold) -> dropped.
		// real.ts is touched only by t1(c1)+t2(c2) -> kept, so t1<->t2 still links on it.
		const topics = [topic("t1", "c1"), topic("t2", "c2"), topic("t3", "c3")];
		const units = [
			unit("u1", "t1", ["god.ts", "real.ts"]),
			unit("u2", "t2", ["god.ts", "real.ts"]),
			unit("u3", "t3", ["god.ts"]),
		];
		const edges = computeCoChangeTopicEdges(units, topics);
		// Only t1<->t2 on real.ts; every god.ts pairing is filtered out.
		expect(edges).toEqual([
			{ fromTopic: "t1", toTopic: "t2", kind: "co-change", sharedFiles: ["real.ts"], sharedFileCount: 1 },
		]);
	});

	it("honors minSharedFiles", () => {
		const topics = [topic("t1", "c1"), topic("t2", "c2")];
		const units = [unit("u1", "t1", ["a.ts", "b.ts"]), unit("u2", "t2", ["a.ts", "b.ts"])];
		expect(computeCoChangeTopicEdges(units, topics, { godFileCategoryThreshold: 99, minSharedFiles: 3 })).toEqual(
			[],
		);
		const ok = computeCoChangeTopicEdges(units, topics, { godFileCategoryThreshold: 99, minSharedFiles: 2 });
		expect(ok).toHaveLength(1);
		expect(ok[0].sharedFiles).toEqual(["a.ts", "b.ts"]);
		expect(ok[0].sharedFileCount).toBe(2);
	});

	it("emits canonical ordering (fromTopic < toTopic) regardless of topic input order", () => {
		const topics = [topic("zebra", "c2"), topic("alpha", "c1")];
		const units = [unit("u1", "zebra", ["x.ts"]), unit("u2", "alpha", ["x.ts"])];
		const edges = computeCoChangeTopicEdges(units, topics);
		expect(edges[0].fromTopic).toBe("alpha");
		expect(edges[0].toTopic).toBe("zebra");
	});

	it("sorts sharedFiles deterministically", () => {
		const topics = [topic("t1", "c1"), topic("t2", "c2")];
		const units = [unit("u1", "t1", ["z.ts", "a.ts", "m.ts"]), unit("u2", "t2", ["m.ts", "z.ts", "a.ts"])];
		expect(computeCoChangeTopicEdges(units, topics)[0].sharedFiles).toEqual(["a.ts", "m.ts", "z.ts"]);
	});

	it("ignores units whose topic is not in the topic list", () => {
		const topics = [topic("t1", "c1"), topic("t2", "c2")];
		const units = [
			unit("u1", "t1", ["a.ts"]),
			unit("u2", "t2", ["a.ts"]),
			unit("orphan", "ghost", ["a.ts"]), // topic "ghost" absent -> skipped
		];
		const edges = computeCoChangeTopicEdges(units, topics);
		expect(edges).toHaveLength(1);
		expect(edges).toContainEqual(expect.objectContaining({ fromTopic: "t1", toTopic: "t2", sharedFileCount: 1 }));
	});

	it("unions files across multiple units of the same topic", () => {
		const topics = [topic("t1", "c1"), topic("t2", "c2")];
		// t1 has TWO units; their files union before intersecting with t2.
		const units = [unit("u1a", "t1", ["a.ts"]), unit("u1b", "t1", ["b.ts"]), unit("u2", "t2", ["b.ts"])];
		const edges = computeCoChangeTopicEdges(units, topics);
		expect(edges).toEqual([
			{ fromTopic: "t1", toTopic: "t2", kind: "co-change", sharedFiles: ["b.ts"], sharedFileCount: 1 },
		]);
	});

	it("skips topics that have no (non-god) files", () => {
		const topics = [topic("t1", "c1"), topic("t2", "c2")];
		const units = [unit("u1", "t1", []), unit("u2", "t2", ["a.ts"])];
		expect(computeCoChangeTopicEdges(units, topics)).toEqual([]);
	});

	it("emits one edge per unordered topic pair across many categories", () => {
		const topics = [topic("t1", "c1"), topic("t2", "c2"), topic("t3", "c3")];
		const units = [
			unit("u1", "t1", ["shared.ts"]),
			unit("u2", "t2", ["shared.ts"]),
			unit("u3", "t3", ["shared.ts"]),
		];
		// shared.ts touched by 3 categories -> it's a god file at default threshold -> no edges.
		expect(computeCoChangeTopicEdges(units, topics)).toEqual([]);
		// Raise the threshold so shared.ts is no longer a god file -> all three pairs link.
		const edges = computeCoChangeTopicEdges(units, topics, { godFileCategoryThreshold: 4, minSharedFiles: 1 });
		expect(edges.map((e) => `${e.fromTopic}-${e.toTopic}`).sort()).toEqual(["t1-t2", "t1-t3", "t2-t3"]);
	});
});
