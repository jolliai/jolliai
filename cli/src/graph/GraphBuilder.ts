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

import type { StorageProvider } from "../core/StorageProvider.js";
import { readTopicIndex } from "../core/TopicIndexStore.js";
import type { SourceRef } from "../core/TopicKBTypes.js";
import { readTopicPage } from "../core/TopicPageStore.js";
import { createLogger } from "../Logger.js";
import type { LlmConfig } from "../Types.js";
import { writeGraphArtifacts } from "./GraphArtifactStore.js";
import { type DistillTopicInput, distillGraph, type GraphProgressReporter } from "./GraphDistiller.js";
import { assembleGraph, type SourceCommitRef, type TopicSourceMeta } from "./GraphSchema.js";

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
	readonly topics?: number;
	readonly units?: number;
	readonly edges?: number;
	readonly graphJsonPath?: string;
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

	const index = await readTopicIndex(cwd, storage);
	if (index.topics.length === 0) {
		log.debug("No topics in the index -- skipping knowledge graph build");
		return { built: false, reason: "no topics" };
	}

	const topicsInput: DistillTopicInput[] = [];
	const sources = new Map<string, TopicSourceMeta>();
	for (const entry of index.topics) {
		const page = await readTopicPage(entry.stableSlug, cwd, storage);
		const content = page?.content ?? "";
		topicsInput.push({ slug: entry.stableSlug, title: entry.title, summary: entry.summary, content });
		sources.set(entry.stableSlug, {
			sourceBranches: page?.relatedBranches ?? entry.relatedBranches ?? [],
			sourceCommits: commitRefs(page?.sourceRefs ?? entry.sourceRefs ?? []),
			overview: firstParagraph(content),
			fullBody: content,
		});
	}

	const kbRoot = storage.kbRoot ?? cwd;
	log.info("Building knowledge graph for %s: %d topic(s)", kbRoot, index.topics.length);
	const startedAt = performance.now();

	const distill = await distillGraph({ topics: topicsInput }, config, opts?.onProgress);
	const graph = assembleGraph(distill, sources, opts?.nowIso ?? new Date().toISOString());

	opts?.onProgress?.("writing graph.json");
	const { graphJsonPath } = await writeGraphArtifacts(kbRoot, graph, distill);

	log.info(
		"Knowledge graph built: %d categories, %d topics, %d units, %d edges in %dms -> %s",
		graph.stats.categories,
		graph.stats.topics,
		graph.stats.units,
		graph.stats.edges,
		Math.round(performance.now() - startedAt),
		graphJsonPath,
	);
	return {
		built: true,
		topics: graph.stats.topics,
		units: graph.stats.units,
		edges: graph.stats.edges,
		graphJsonPath,
	};
}
