/**
 * GraphBuilder — entrypoint for the knowledge-graph feature. Reads the canonical
 * topic KB (index + pages) via the active StorageProvider, runs the LLM
 * distillation, assembles + validates the graph, and writes the artifacts.
 *
 * Sourced from the structured `TopicPage` objects (NOT re-parsed `_wiki`
 * markdown): storage-mode agnostic, no hardcoded path, and immune to the
 * prototype's `## Overview`/`## Affected Files` empty-field defect.
 *
 * Called non-fatally right after `renderTopicKBWiki` in the manual compile paths
 * (CompileCommand.compileSingleRepo, MultiRepoCompile.compileAllRepos). A throw
 * here degrades to "no graph this run" and never fails the compile.
 */

import { createHash } from "node:crypto";
import { createFolderStorageAtRoot } from "../core/StorageFactory.js";
import type { StorageProvider } from "../core/StorageProvider.js";
import { readTopicIndex } from "../core/TopicIndexStore.js";
import type { SourceRef } from "../core/TopicKBTypes.js";
import { readTopicPage } from "../core/TopicPageStore.js";
import { createLogger } from "../Logger.js";
import type { LlmConfig } from "../Types.js";
import { readGraph, writeGraphArtifacts } from "./GraphArtifactStore.js";
import {
	type DistillTopicInput,
	distillGraph,
	distillGraphIncremental,
	type GraphProgressReporter,
} from "./GraphDistiller.js";
import {
	assembleGraph,
	type DistilledGraph,
	diffTopics,
	GRAPH_SCHEMA_VERSION,
	isFingerprintMap,
	type SourceCommitRef,
	type TopicSourceMeta,
	toDistilled,
} from "./GraphSchema.js";

const log = createLogger("GraphBuilder");

export interface BuildGraphOptions {
	/** Injectable timestamp for determinism in tests. */
	readonly nowIso?: string;
	/** Optional one-line progress reporter for UI surfaces (see GraphProgressReporter). */
	readonly onProgress?: GraphProgressReporter;
}

export interface BuildGraphResult {
	readonly built: boolean;
	readonly reason?: string;
	/** Which path produced the graph (absent when nothing was built). */
	readonly mode?: "full" | "incremental";
	readonly topics?: number;
	readonly units?: number;
	readonly edges?: number;
	readonly graphJsonPath?: string;
}

/**
 * Per-topic content fingerprint for incremental dirty detection. Hashes the
 * EXACT inputs the distiller consumes — `title`/`summary` from the index entry,
 * `content` from the page — so a "should recompute" change is never missed. The
 * NUL separators keep field boundaries unambiguous.
 */
export function topicFingerprint(title: string, summary: string, content: string): string {
	return createHash("sha256").update(`${title}\u0000${summary}\u0000${content}`).digest("hex");
}

/**
 * Per-topic fingerprint of the JOIN metadata graph.json carries but the content
 * fingerprint excludes: `sourceBranches` + `sourceCommits` hashes. These are NOT
 * LLM inputs, so they can change while {@link topicFingerprint} stays put — and
 * the rolled-up `commitCount` is derived from them. When the content diff is a
 * no-op but this changes, GraphBuilder does a NO-LLM reassemble instead of
 * skipping, so the on-disk metadata never goes stale. (`overview` / `fullBody`
 * are derived from `content`, already covered by the content fingerprint.)
 */
export function topicMetaFingerprint(meta: TopicSourceMeta): string {
	const branches = meta.sourceBranches.join(",");
	const commits = meta.sourceCommits.map((c) => c.hash).join(",");
	return createHash("sha256").update(`${branches}\u0000${commits}`).digest("hex");
}

/** Shallow equality of two fingerprint maps (same keys, same values). */
function sameFingerprints(a: Record<string, string>, b: Record<string, string>): boolean {
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((k) => a[k] === b[k]);
}

/** Distinct commit refs (summary-type sources) for a topic, in first-seen order. */
function commitRefs(refs: ReadonlyArray<SourceRef>): SourceCommitRef[] {
	const seen = new Set<string>();
	const out: SourceCommitRef[] = [];
	for (const r of refs) {
		if (r.type !== "summary") continue;
		// Dedup on the FULL id (two distinct commits can share an 8-char prefix);
		// the 8-char form is display-only.
		if (seen.has(r.id)) continue;
		seen.add(r.id);
		out.push({ hash: r.id.slice(0, 8), message: "" });
	}
	return out;
}

/** First prose paragraph of a topic page body, capped — a lightweight overview. */
function firstParagraph(content: string): string {
	const block = content
		.split(/\n\s*\n/)
		.map((b) => b.trim())
		.find((b) => b.length > 0 && !b.startsWith("#"));
	return (block ?? "").slice(0, 600);
}

/**
 * Builds the knowledge graph for one repo and writes its artifacts. Gated on
 * folder-capable storage (the visible artifact + webview need the folder layer),
 * mirroring how `renderTopicKBWiki` is a no-op on orphan-only storage.
 */
export async function buildKnowledgeGraph(
	cwd: string,
	storage: StorageProvider,
	config: LlmConfig,
	opts?: BuildGraphOptions,
): Promise<BuildGraphResult> {
	if (!storage.renderTopicWiki) {
		log.debug("Active storage has no folder layer -- skipping knowledge graph build");
		return { built: false, reason: "orphan-only storage (no folder layer)" };
	}

	const kbRoot = storage.kbRoot ?? cwd;
	const now = opts?.nowIso ?? new Date().toISOString();
	const startedAt = performance.now();

	// Read topic inputs from the FOLDER (canonical JSON under <kbRoot>/.jolli), never
	// through the passed storage. In dual-write mode the passed storage reads the
	// orphan branch — but graph.json (the incremental baseline) lives in and is derived
	// from the folder, and the manual sweep already reads the folder. If the two trigger
	// paths read different sources, their topic summaries drift and each recomputes the
	// other's fingerprints as "dirty", re-distilling in a loop. Pinning every build to
	// the folder keeps the baseline self-consistent (and matches the direction of
	// retiring the orphan branch). The folder is always populated here: dual-write
	// mirrors to it during the ingest that precedes this build, and the folder-layer
	// gate above guarantees a folder exists.
	const reader = createFolderStorageAtRoot(kbRoot);

	const index = await readTopicIndex(cwd, reader);

	// Incremental decision: reuse the prior graph.json as the baseline only when
	// its schemaVersion matches, its topicFingerprints are a usable string map,
	// AND it field-validates (toDistilled → null on a structural mismatch, e.g. a
	// units-shape change shipped without a version bump). Any of these failing
	// means there is no usable baseline → one-time full distillation that heals it
	// (distinct from a recoverable incremental failure, which keeps the old graph).
	// Read BEFORE the empty-index gate: an empty index over a non-empty baseline is
	// "the last topic was just deleted", not "nothing was ever built".
	const prevGraph = await readGraph(kbRoot);
	const prevDistill: DistilledGraph | null =
		prevGraph && prevGraph.schemaVersion === GRAPH_SCHEMA_VERSION && isFingerprintMap(prevGraph.topicFingerprints)
			? toDistilled(prevGraph)
			: null;

	if (index.topics.length === 0) {
		// All topics deleted → the deletion case, taken to zero topics. Overwrite the
		// stale graph.json with an empty (referentially-trivial) graph so the viz stops
		// showing phantom topics — NO LLM. A bare skip here would leave the last good
		// graph on disk forever. Nothing-ever-built (no usable baseline, or a baseline
		// that is already empty) still skips.
		if (prevDistill && prevDistill.topics.length > 0) {
			log.info("All topics deleted (was %d) -- writing empty knowledge graph", prevDistill.topics.length);
			const empty = assembleGraph({ categories: [], topics: [], units: [], edges: [] }, new Map(), now, {}, {});
			opts?.onProgress?.("writing graph.json");
			const { graphJsonPath } = await writeGraphArtifacts(kbRoot, empty);
			return { built: true, mode: "incremental", topics: 0, units: 0, edges: 0, graphJsonPath };
		}
		log.debug("No topics in the index -- skipping knowledge graph build");
		return { built: false, reason: "no topics" };
	}

	const topicsInput: DistillTopicInput[] = [];
	const sources = new Map<string, TopicSourceMeta>();
	const fingerprints: Record<string, string> = {};
	const metaFingerprints: Record<string, string> = {};
	for (const entry of index.topics) {
		const page = await readTopicPage(entry.stableSlug, cwd, reader);
		const content = page?.content ?? "";
		topicsInput.push({ slug: entry.stableSlug, title: entry.title, summary: entry.summary, content });
		fingerprints[entry.stableSlug] = topicFingerprint(entry.title, entry.summary, content);
		const meta: TopicSourceMeta = {
			sourceBranches: page?.relatedBranches ?? entry.relatedBranches ?? [],
			sourceCommits: commitRefs(page?.sourceRefs ?? entry.sourceRefs ?? []),
			overview: firstParagraph(content),
			fullBody: content,
		};
		sources.set(entry.stableSlug, meta);
		metaFingerprints[entry.stableSlug] = topicMetaFingerprint(meta);
	}

	let distill: DistilledGraph;
	let mode: "full" | "incremental";
	if (prevDistill) {
		const diff = diffTopics(prevGraph?.topicFingerprints ?? {}, fingerprints);
		if (diff.dirty.length === 0 && diff.added.length === 0 && diff.deleted.length === 0) {
			// Content unchanged for every topic. But the join metadata (sourceBranches /
			// sourceCommits → commitCount) is NOT in the content fingerprint, so it can
			// drift on its own (a new commit folded into a topic whose summary regenerated
			// identically, a branch rename). If it ALSO matches → true no-op, skip. If it
			// drifted → NO-LLM reassemble: reuse the distilled layer verbatim, re-join the
			// fresh metadata so the on-disk source/commitCount fields never go stale. A
			// missing/corrupt baseline meta map (older write, hand-edit) counts as drifted
			// → one reassemble heals it.
			const prevMeta = isFingerprintMap(prevGraph?.topicMetaFingerprints)
				? prevGraph.topicMetaFingerprints
				: null;
			if (prevMeta && sameFingerprints(prevMeta, metaFingerprints)) {
				log.info("Knowledge graph unchanged (%d topics) -- skipping rebuild", index.topics.length);
				return { built: false, reason: "no changes", topics: index.topics.length };
			}
			log.info("Knowledge graph content unchanged but source metadata drifted -- reassembling (no LLM)");
			mode = "incremental";
			distill = prevDistill;
			const graph = assembleGraph(distill, sources, now, fingerprints, metaFingerprints);
			opts?.onProgress?.("writing graph.json");
			const { graphJsonPath } = await writeGraphArtifacts(kbRoot, graph);
			log.info(
				"Knowledge graph built (incremental, no LLM): %d categories, %d topics, %d units, %d edges in %dms -> %s",
				graph.stats.categories,
				graph.stats.topics,
				graph.stats.units,
				graph.stats.edges,
				Math.round(performance.now() - startedAt),
				graphJsonPath,
			);
			return {
				built: true,
				mode,
				topics: graph.stats.topics,
				units: graph.stats.units,
				edges: graph.stats.edges,
				graphJsonPath,
			};
		}
		log.info(
			"Building knowledge graph incrementally for %s: %d dirty, %d new, %d deleted, %d clean",
			kbRoot,
			diff.dirty.length,
			diff.added.length,
			diff.deleted.length,
			diff.clean.length,
		);
		mode = "incremental";
		// DECISION: an incremental failure (delta/edges LLM error, or an
		// assembleGraph validation throw below) is NOT caught here to fall back to
		// a full rebuild. It bubbles to CompileCommand's non-fatal try/catch →
		// "no graph this round, keep the last good graph.json, retry next commit".
		// Why no auto-full fallback:
		//   - Full re-runs every LLM call (N+2) — exactly what incremental avoids;
		//     one transient hiccup shouldn't trigger a 44-call rebuild.
		//   - On a transient LLM error, full hits the same LLM and likely fails too,
		//     burning double the tokens.
		//   - An assembleGraph validation throw can only mean a merge bug (the
		//     incremental path is built to always emit a referentially-sound graph).
		//     Auto-full would mask that bug AND pay "incremental + full" every build;
		//     keeping the old graph is cheap, safe, and surfaces the bug.
		// "No usable baseline" (handled above via the schemaVersion / isFingerprintMap
		// / toDistilled gate → full) is a DIFFERENT case: there's no starting point to
		// build from, so a one-time full is correct — that is not a fallback.
		distill = await distillGraphIncremental({ topics: topicsInput }, prevDistill, diff, config, opts?.onProgress);
	} else {
		log.info("Building knowledge graph for %s: %d topic(s) (full)", kbRoot, index.topics.length);
		mode = "full";
		distill = await distillGraph({ topics: topicsInput }, config, opts?.onProgress);
	}

	const graph = assembleGraph(distill, sources, now, fingerprints, metaFingerprints);

	opts?.onProgress?.("writing graph.json");
	const { graphJsonPath } = await writeGraphArtifacts(kbRoot, graph);

	log.info(
		"Knowledge graph built (%s): %d categories, %d topics, %d units, %d edges in %dms -> %s",
		mode,
		graph.stats.categories,
		graph.stats.topics,
		graph.stats.units,
		graph.stats.edges,
		Math.round(performance.now() - startedAt),
		graphJsonPath,
	);
	return {
		built: true,
		mode,
		topics: graph.stats.topics,
		units: graph.stats.units,
		edges: graph.stats.edges,
		graphJsonPath,
	};
}
