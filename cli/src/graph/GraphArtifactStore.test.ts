import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeGraphArtifacts } from "./GraphArtifactStore.js";
import { assembleGraph, type DistilledGraph } from "./GraphSchema.js";

function tinyDistill(): DistilledGraph {
	return {
		categories: [{ id: "c", shortTitle: "C", summary: "Cat." }],
		topics: [{ slug: "t1", shortTitle: "T1", summary: "Topic.", title: "Topic One", categoryId: "c" }],
		units: [
			{
				id: "t1::u1",
				topicSlug: "t1",
				kind: "decision",
				shortTitle: "U1",
				summary: "Unit one.",
				anchors: { files: [], commits: [] },
			},
		],
		edges: [],
	};
}

const ISO = "2026-06-15T00:00:00.000Z";
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("writeGraphArtifacts", () => {
	it("writes graph.json + distill.json under the hidden .jolli/graph layer", async () => {
		const root = await mkdtemp(join(tmpdir(), "jolli-graph-"));
		dirs.push(root);
		const distill = tinyDistill();
		const graph = assembleGraph(distill, new Map(), ISO);

		const result = await writeGraphArtifacts(root, graph, distill);

		const graphJson = JSON.parse(await readFile(join(root, ".jolli", "graph", "graph.json"), "utf8"));
		expect(graphJson.stats.topics).toBe(1);
		const distillJson = JSON.parse(await readFile(join(root, ".jolli", "graph", "distill.json"), "utf8"));
		expect(distillJson.units).toHaveLength(1);
		expect(result.graphJsonPath).toBe(join(root, ".jolli", "graph", "graph.json"));
	});

	it("writes atomically, leaving no .tmp sibling behind", async () => {
		const root = await mkdtemp(join(tmpdir(), "jolli-graph-"));
		dirs.push(root);
		const distill = tinyDistill();
		await writeGraphArtifacts(root, assembleGraph(distill, new Map(), ISO), distill);

		// atomicWriteFile renames tmp → final, so no half-written sibling lingers.
		const graphDir = join(root, ".jolli", "graph");
		expect(existsSync(join(graphDir, "graph.json.tmp"))).toBe(false);
		expect(existsSync(join(graphDir, "distill.json.tmp"))).toBe(false);
	});
});
