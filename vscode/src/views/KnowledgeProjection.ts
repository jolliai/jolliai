/**
 * KnowledgeProjection — pure function that maps a KnowledgeGraph (or null) plus
 * repo identity to the KnowledgeRepo shape the sidebar Knowledge view consumes.
 *
 * No VS Code APIs, no disk I/O. Callers supply the graph (already read) and the
 * repo identity; this file only shapes data.
 */

import { basename, join } from "node:path";
import { toForwardSlash } from "../../../cli/src/core/PathUtils.js";
import type { KnowledgeGraph } from "../../../cli/src/graph/GraphSchema.js";
import type { KnowledgeCategory, KnowledgeRepo, KnowledgeTopic } from "./SidebarMessages.js";

/**
 * Projects a compiled KnowledgeGraph (or null when no graph exists yet) plus
 * repo identity into the KnowledgeRepo shape the sidebar Knowledge view renders.
 *
 * When `graph` is null, returns an empty-category KnowledgeRepo so the client
 * can render the "Build Knowledge Wiki" CTA.
 */
export function projectKnowledgeRepo(
	graph: KnowledgeGraph | null,
	repo: { repoName: string; kbRoot: string },
): KnowledgeRepo {
	// `kb:openFile` resolves its path via `resolveKbAbs(p) = join(kbParent, p)`,
	// so the path must be RELATIVE and prefixed by the repo's on-disk folder
	// name — the basename of kbRoot (= `<kbParent>/<dirName>`), which can differ
	// from `repoName` when the folder carries a `-2`/`-3` suffix. Emitting an
	// absolute path here would double the parent (join concatenates absolute
	// segments) and the file would silently fail to open.
	const dirName = basename(repo.kbRoot);
	const indexPath = toForwardSlash(join(dirName, "_wiki", "_index.md"));

	if (!graph) {
		return { repoName: repo.repoName, memoryCount: 0, indexPath, categories: [] };
	}

	const categories: KnowledgeCategory[] = graph.categories.map((cat) => {
		const topics: KnowledgeTopic[] = graph.topics
			.filter((t) => t.categoryId === cat.id)
			.map((t) => ({
				title: t.title || t.shortTitle,
				stableSlug: t.slug,
				memoryCount: t.commitCount,
				wikiFile: toForwardSlash(join(dirName, "_wiki", t.wikiFile)),
			}));

		const base = {
			name: cat.shortTitle,
			topicCount: cat.topicCount,
			memoryCount: cat.commitCount,
			topics,
		};

		// Omit `description` entirely when summary is empty or whitespace-only.
		if (cat.summary.trim() === "") return base;
		return { ...base, description: cat.summary };
	});

	// Repo-level memory count = DISTINCT commit hashes across all topics. A single
	// commit can be cited by more than one topic (it appears in each topic's
	// `sourceCommits`), so summing per-category `commitCount` double-counts shared
	// commits and inflates the badge. Dedup by hash via a Set instead.
	const distinctHashes = new Set<string>();
	for (const topic of graph.topics) {
		for (const sc of topic.sourceCommits) {
			distinctHashes.add(sc.hash);
		}
	}
	const memoryCount = distinctHashes.size;

	return { repoName: repo.repoName, memoryCount, indexPath, categories };
}
