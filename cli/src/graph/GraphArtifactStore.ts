/**
 * GraphArtifactStore — writes the knowledge-graph data to a repo's Memory Bank
 * folder, in the hidden canonical layer:
 *
 *   <kbRoot>/.jolli/graph/graph.json    final merged graph (the data the viz renders)
 *   <kbRoot>/.jolli/graph/distill.json  raw LLM-distilled layer (kept for future incremental)
 *
 * Folder-local and regenerable (like the disposable search index), written with
 * `fs` directly — NOT dual-written to the orphan branch. Only DATA is written
 * here: the viz runtime (JS/CSS) is referenced externally by the VS Code webview
 * (loaded from `assets/graph/` via `asWebviewUri`), which inlines just this
 * graph.json. There is no self-contained HTML artifact.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../core/AtomicWrite.js";
import type { DistilledGraph, KnowledgeGraph } from "./GraphSchema.js";

const GRAPH_DIR = [".jolli", "graph"];

export interface WriteGraphResult {
	readonly graphJsonPath: string;
}

/**
 * Writes `graph.json` (the final merged graph) and `distill.json` (the raw
 * distilled layer) under `rootDir` (the per-repo Memory Bank folder, i.e. kbRoot).
 */
export async function writeGraphArtifacts(
	rootDir: string,
	graph: KnowledgeGraph,
	distill: DistilledGraph,
): Promise<WriteGraphResult> {
	const graphDir = join(rootDir, ...GRAPH_DIR);
	await mkdir(graphDir, { recursive: true });
	const graphJsonPath = join(graphDir, "graph.json");
	// Atomic (tmp + rename) so a read during compile, or a crash mid-write, never
	// leaves a truncated graph.json/distill.json that breaks the webview/export.
	await atomicWriteFile(graphJsonPath, JSON.stringify(graph, null, "\t"));
	await atomicWriteFile(join(graphDir, "distill.json"), JSON.stringify(distill, null, "\t"));
	return { graphJsonPath };
}
