import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "../../../cli/src/graph/GraphSchema.js";
import { projectKnowledgeRepo } from "./KnowledgeProjection.js";

// Minimal KnowledgeGraph fixture with two categories and three topics.
// Field values are chosen to make all five spec-mandated assertions unambiguous.
function makeGraph(): KnowledgeGraph {
	return {
		schemaVersion: 2,
		generatedAt: "2026-01-01T00:00:00.000Z",
		source: "test",
		topicFingerprints: {},
		topicMetaFingerprints: {},
		stats: { categories: 2, topics: 3, units: 0, edges: 0, intraTopicEdges: 0, crossTopicEdges: 0, crossCategoryEdges: 0 },
		categories: [
			{ id: "cat-a", shortTitle: "Architecture", summary: "High-level design choices.", topicCount: 2, unitCount: 0, commitCount: 7 },
			{ id: "cat-b", shortTitle: "Testing", summary: "", topicCount: 1, unitCount: 0, commitCount: 3 },
		],
		topics: [
			{
				slug: "auth-flow",
				shortTitle: "Auth Flow",
				title: "Authentication Flow",
				summary: "OAuth flow.",
				categoryId: "cat-a",
				sourceBranches: [],
				// 5 distinct commits; "h-shared" is also cited by data-model below.
				sourceCommits: [
					{ hash: "h-a1", message: "a1" },
					{ hash: "h-a2", message: "a2" },
					{ hash: "h-a3", message: "a3" },
					{ hash: "h-a4", message: "a4" },
					{ hash: "h-shared", message: "shared" },
				],
				overview: "",
				fullBody: "",
				wikiFile: "topic--auth-flow.md",
				unitCount: 0,
				commitCount: 5,
			},
			{
				slug: "data-model",
				shortTitle: "Data Model Short",
				// empty title — tests the shortTitle fallback
				title: "",
				summary: "Schema decisions.",
				categoryId: "cat-a",
				sourceBranches: [],
				// 2 commits, one of which ("h-shared") is shared with auth-flow.
				sourceCommits: [
					{ hash: "h-shared", message: "shared" },
					{ hash: "h-d1", message: "d1" },
				],
				overview: "",
				fullBody: "",
				wikiFile: "topic--data-model.md",
				unitCount: 0,
				commitCount: 2,
			},
			{
				slug: "unit-tests",
				shortTitle: "Unit Tests",
				title: "Unit Test Patterns",
				summary: "Testing patterns.",
				categoryId: "cat-b",
				sourceBranches: [],
				// 3 distinct commits, none shared with cat-a topics.
				sourceCommits: [
					{ hash: "h-u1", message: "u1" },
					{ hash: "h-u2", message: "u2" },
					{ hash: "h-u3", message: "u3" },
				],
				overview: "",
				fullBody: "",
				wikiFile: "topic--unit-tests.md",
				unitCount: 0,
				commitCount: 3,
			},
		],
		units: [],
		edges: [],
	};
}

const REPO = { repoName: "my-project", kbRoot: "/home/user/mb/my-project" };

describe("projectKnowledgeRepo", () => {
	it("graph === null → categories is [], memoryCount 0, indexPath still set", () => {
		const result = projectKnowledgeRepo(null, REPO);
		expect(result.categories).toEqual([]);
		expect(result.memoryCount).toBe(0);
		expect(result.repoName).toBe("my-project");
		// indexPath must still be set even without a graph
		expect(result.indexPath).toBe("my-project/_wiki/_index.md");
	});

	it("category.summary === '' → projected KnowledgeCategory has NO description key", () => {
		const graph = makeGraph();
		const result = projectKnowledgeRepo(graph, REPO);
		const testingCat = result.categories.find((c) => c.name === "Testing");
		expect(testingCat).toBeDefined();
		expect("description" in (testingCat as object)).toBe(false);
	});

	it("category.summary non-empty → description is set", () => {
		const graph = makeGraph();
		const result = projectKnowledgeRepo(graph, REPO);
		const archCat = result.categories.find((c) => c.name === "Architecture");
		expect(archCat).toBeDefined();
		expect(archCat?.description).toBe("High-level design choices.");
	});

	it("category.commitCount maps to KnowledgeCategory.memoryCount; topic.commitCount maps to KnowledgeTopic.memoryCount (independent values)", () => {
		const graph = makeGraph();
		const result = projectKnowledgeRepo(graph, REPO);
		const archCat = result.categories.find((c) => c.name === "Architecture");
		expect(archCat).toBeDefined();
		// Category-level: sum of category.commitCount from the graph (7 for Architecture)
		expect(archCat?.memoryCount).toBe(7);
		// Topic-level: independent from category — auth-flow has 5, data-model has 2
		const authTopic = archCat?.topics.find((t) => t.stableSlug === "auth-flow");
		expect(authTopic?.memoryCount).toBe(5);
		const dataTopic = archCat?.topics.find((t) => t.stableSlug === "data-model");
		expect(dataTopic?.memoryCount).toBe(2);
		// Confirm the two sources differ (5 !== 7)
		expect(authTopic?.memoryCount).not.toBe(archCat?.memoryCount);
	});

	it("topics group under the correct category by categoryId", () => {
		const graph = makeGraph();
		const result = projectKnowledgeRepo(graph, REPO);
		const archCat = result.categories.find((c) => c.name === "Architecture");
		const testCat = result.categories.find((c) => c.name === "Testing");
		expect(archCat?.topics).toHaveLength(2);
		expect(testCat?.topics).toHaveLength(1);
		const archSlugs = archCat?.topics.map((t) => t.stableSlug);
		expect(archSlugs).toContain("auth-flow");
		expect(archSlugs).toContain("data-model");
		expect(testCat?.topics[0]?.stableSlug).toBe("unit-tests");
	});

	it("a topic with empty title falls back to shortTitle", () => {
		const graph = makeGraph();
		const result = projectKnowledgeRepo(graph, REPO);
		const archCat = result.categories.find((c) => c.name === "Architecture");
		const dataTopic = archCat?.topics.find((t) => t.stableSlug === "data-model");
		// The graph topic has title="" so we expect the shortTitle fallback
		expect(dataTopic?.title).toBe("Data Model Short");
	});

	it("wikiFile and indexPath are dirName-prefixed forward-slash-normalized relative paths", () => {
		const graph = makeGraph();
		const result = projectKnowledgeRepo(graph, REPO);
		// indexPath — relative, prefixed by the kbRoot basename (the on-disk
		// folder name), so resolveKbAbs(join(kbParent, path)) lands correctly.
		expect(result.indexPath).toBe("my-project/_wiki/_index.md");
		// wikiFile for auth-flow
		const archCat = result.categories.find((c) => c.name === "Architecture");
		const authTopic = archCat?.topics.find((t) => t.stableSlug === "auth-flow");
		expect(authTopic?.wikiFile).toBe("my-project/_wiki/topic--auth-flow.md");
	});

	it("repo-level memoryCount is the count of DISTINCT commit hashes across all topics", () => {
		const graph = makeGraph();
		const result = projectKnowledgeRepo(graph, REPO);
		// auth-flow {h-a1,h-a2,h-a3,h-a4,h-shared} ∪ data-model {h-shared,h-d1}
		// ∪ unit-tests {h-u1,h-u2,h-u3} = 9 distinct hashes. "h-shared" is cited by
		// two topics but counted once — NOT the naive sum of category.commitCount
		// (7 + 3 = 10), which double-counts the shared commit.
		expect(result.memoryCount).toBe(9);
	});

	it("a commit shared across multiple topics is counted once (dedup by hash)", () => {
		const graph = makeGraph();
		// Force a pathological overlap: every topic cites the very same commit.
		const onlyHash = [{ hash: "dup", message: "dup" }];
		const overlapped: KnowledgeGraph = {
			...graph,
			topics: graph.topics.map((t) => ({ ...t, sourceCommits: onlyHash })),
		};
		const result = projectKnowledgeRepo(overlapped, REPO);
		// Three topics, all citing "dup" → exactly 1 distinct commit.
		expect(result.memoryCount).toBe(1);
	});

	it("uses the kbRoot basename for paths and repoName for the repo label", () => {
		const graph = makeGraph();
		// repoName intentionally differs from the kbRoot basename ("z") to prove
		// paths follow the on-disk folder name, not repoName.
		const altRepo = { repoName: "other-repo", kbRoot: "/x/y/z" };
		const result = projectKnowledgeRepo(graph, altRepo);
		expect(result.repoName).toBe("other-repo");
		expect(result.indexPath).toBe("z/_wiki/_index.md");
		const cat = result.categories[0];
		expect(cat?.topics[0]?.wikiFile).toMatch(/^z\/_wiki\//);
	});

	it("Windows backslash paths are normalized to forward slashes", () => {
		const graph = makeGraph();
		// Simulate a Windows kbRoot (backslashes)
		const winRepo = { repoName: "win-repo", kbRoot: "C:\\Users\\user\\mb\\win-repo" };
		const result = projectKnowledgeRepo(graph, winRepo);
		expect(result.indexPath).not.toContain("\\");
		const archCat = result.categories.find((c) => c.name === "Architecture");
		const authTopic = archCat?.topics.find((t) => t.stableSlug === "auth-flow");
		expect(authTopic?.wikiFile).not.toContain("\\");
	});

	it("null graph still produces a dirName-prefixed relative indexPath", () => {
		const altRepo = { repoName: "r", kbRoot: "/a/b" };
		const result = projectKnowledgeRepo(null, altRepo);
		expect(result.indexPath).toBe("b/_wiki/_index.md");
	});
});
