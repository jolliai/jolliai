import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphJsonPath, readGraph, writeGraphArtifacts } from "./GraphArtifactStore.js";
import { assembleGraph, type DistilledGraph } from "./GraphSchema.js";

function tinyDistill(): DistilledGraph {
	return {
		categories: [{ id: "c", shortTitle: "C", summary: "Cat." }],
		topics: [{ slug: "t1", shortTitle: "T1", summary: "Topic.", title: "Topic One", categoryId: "c" }],
		units: [
			{
				id: "t1::u1",
				topicSlug: "t1",
				kinds: ["decision"],
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

async function freshDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "jolli-graph-"));
	dirs.push(root);
	return root;
}

describe("writeGraphArtifacts", () => {
	it("writes graph.json (the only artifact) under the hidden .jolli/graph layer", async () => {
		const root = await freshDir();
		const graph = assembleGraph(tinyDistill(), new Map(), ISO, "", { t1: "fp" });

		const result = await writeGraphArtifacts(root, graph);

		const graphJson = JSON.parse(await readFile(join(root, ".jolli", "graph", "graph.json"), "utf8"));
		expect(graphJson.stats.topics).toBe(1);
		expect(graphJson.topicFingerprints).toEqual({ t1: "fp" });
		expect(result.graphJsonPath).toBe(join(root, ".jolli", "graph", "graph.json"));
		// distill.json is no longer written — graph.json is the sole artifact + baseline.
		expect(existsSync(join(root, ".jolli", "graph", "distill.json"))).toBe(false);
	});

	it("writes atomically, leaving no .tmp sibling behind", async () => {
		const root = await freshDir();
		await writeGraphArtifacts(root, assembleGraph(tinyDistill(), new Map(), ISO, ""));

		// atomicWriteFile renames tmp → final, so no half-written sibling lingers.
		expect(existsSync(join(root, ".jolli", "graph", "graph.json.tmp"))).toBe(false);
	});
});

describe("readGraph", () => {
	it("round-trips a written graph", async () => {
		const root = await freshDir();
		const written = assembleGraph(tinyDistill(), new Map(), ISO, "", { t1: "fp" });
		await writeGraphArtifacts(root, written);

		const got = await readGraph(root);
		expect(got?.schemaVersion).toBe(3);
		expect(got?.topicFingerprints).toEqual({ t1: "fp" });
		expect(got?.units).toHaveLength(1);
	});

	it("returns null when no graph.json exists (missing → full rebuild)", async () => {
		const root = await freshDir();
		expect(await readGraph(root)).toBeNull();
	});

	it("returns null when graph.json is unparseable (corrupt → full rebuild)", async () => {
		const root = await freshDir();
		// Write a valid graph first so the .jolli/graph dir exists, then corrupt it.
		await writeGraphArtifacts(root, assembleGraph(tinyDistill(), new Map(), ISO, ""));
		await writeFile(graphJsonPath(root), "{ not valid json", "utf8");
		expect(await readGraph(root)).toBeNull();
	});
});
