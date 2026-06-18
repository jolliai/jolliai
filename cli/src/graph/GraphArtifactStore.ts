/**
 * GraphArtifactStore — reads/writes the knowledge-graph data in a repo's Memory
 * Bank folder, in the hidden canonical layer:
 *
 *   <kbRoot>/.jolli/graph/graph.json    the merged graph the viz renders, AND the
 *                                       incremental baseline (carries topicFingerprints)
 *
 * Folder-local and regenerable (like the disposable search index), written with
 * `fs` directly — NOT dual-written to the orphan branch. Only DATA is written
 * here: the viz runtime (JS/CSS) is referenced externally by the VS Code webview
 * (loaded from `assets/graph/` via `asWebviewUri`), which inlines just this
 * graph.json. There is no self-contained HTML artifact.
 *
 * Single file by design: graph.json is a superset of the old `distill.json` (the
 * raw distilled layer is the `{categories,topics,units,edges}` subset, restored
 * via `toDistilled`). Keeping one file means one write — no cross-file torn-write
 * where a new graph.json pairs with a stale distill.json baseline. (A single
 * file can still tear on the Windows EPERM fallback in `atomicWriteFile`, but a
 * parse failure on read degrades to a full rebuild → self-heals; the orphan
 * branch is always the system of record, so no data is lost.)
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../core/AtomicWrite.js";
import { createLogger } from "../Logger.js";
import type { KnowledgeGraph } from "./GraphSchema.js";

const log = createLogger("GraphArtifactStore");
const GRAPH_DIR = [".jolli", "graph"];

export interface WriteGraphResult {
	readonly graphJsonPath: string;
}

/** Absolute path to a repo's graph.json under `rootDir` (the per-repo kbRoot). */
export function graphJsonPath(rootDir: string): string {
	return join(rootDir, ...GRAPH_DIR, "graph.json");
}

/**
 * Writes `graph.json` (the merged graph + incremental baseline) under `rootDir`
 * (the per-repo Memory Bank folder, i.e. kbRoot). Atomic (tmp + rename) so a read
 * during compile, or a crash mid-write, never leaves a truncated graph.json that
 * breaks the webview/export.
 */
export async function writeGraphArtifacts(rootDir: string, graph: KnowledgeGraph): Promise<WriteGraphResult> {
	const graphDir = join(rootDir, ...GRAPH_DIR);
	await mkdir(graphDir, { recursive: true });
	const path = graphJsonPath(rootDir);
	await atomicWriteFile(path, JSON.stringify(graph, null, "\t"));
	return { graphJsonPath: path };
}

/**
 * Reads a repo's prior `graph.json` for use as the incremental baseline. Returns
 * the parsed object (an `unknown`-shaped `KnowledgeGraph`; the caller runs
 * `toDistilled` to field-validate it) or `null` when the file is missing or
 * unparseable — both cases degrade to a full rebuild. Never throws.
 */
export async function readGraph(rootDir: string): Promise<KnowledgeGraph | null> {
	let raw: string;
	try {
		raw = await readFile(graphJsonPath(rootDir), "utf8");
	} catch {
		return null; // missing (ENOENT) or unreadable — full rebuild
	}
	try {
		return JSON.parse(raw) as KnowledgeGraph;
	} catch {
		log.warn("Prior graph.json failed to parse -- treating as no baseline (full rebuild)");
		return null;
	}
}
