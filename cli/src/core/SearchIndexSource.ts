/**
 * Projects JolliMemory's two on-disk sources — the topic KB (topics/index.json
 * + topic pages) and the raw commit catalog (catalog.json, joined with
 * index.json for branch/date) — into the flat SearchDoc shape the Orama index
 * consumes. The ONLY module that knows these source layouts; SearchIndex stays
 * source-agnostic.
 */

import { createHash } from "node:crypto";
import type { SearchDoc } from "./SearchIndexTypes.js";
import { SEARCH_SCHEMA_VERSION } from "./SearchIndexTypes.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getCatalogWithLazyBuild, getIndex } from "./SummaryStore.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import { readTopicPage } from "./TopicPageStore.js";

/** Build every SearchDoc from current source data. */
export async function collectSearchDocs(cwd: string, storage?: StorageProvider): Promise<SearchDoc[]> {
	const [topicDocs, commitDocs] = await Promise.all([
		collectTopicDocs(cwd, storage),
		collectCommitDocs(cwd, storage),
	]);
	return [...topicDocs, ...commitDocs];
}

async function collectTopicDocs(cwd: string, storage?: StorageProvider): Promise<SearchDoc[]> {
	const index = await readTopicIndex(cwd, storage);
	const docs = await Promise.all(
		index.topics.map(async (entry) => {
			const page = await readTopicPage(entry.stableSlug, cwd, storage);
			const content = page?.content ?? entry.summary;
			const branches = [...(page?.relatedBranches ?? entry.relatedBranches)];
			const category = dominantSourceType(page?.sourceRefs ?? entry.sourceRefs);
			const doc: SearchDoc = {
				id: `topic:${entry.stableSlug}`,
				type: "topic",
				title: entry.title,
				content: `${entry.title}\n${content}`,
				decisions: "",
				branch: branches,
				category,
				commitDate: page?.lastUpdatedAt ?? entry.lastUpdatedAt,
				slug: entry.stableSlug,
				hash: "",
			};
			return doc;
		}),
	);
	return docs;
}

async function collectCommitDocs(cwd: string, storage?: StorageProvider): Promise<SearchDoc[]> {
	const [index, catalog] = await Promise.all([getIndex(cwd, storage), getCatalogWithLazyBuild(cwd, storage)]);
	if (!index) return [];

	// Join: catalog has recap/topics/decisions; index has branch/date. Key = commitHash.
	const metaByHash = new Map(index.entries.map((e) => [e.commitHash, e]));

	const docs: SearchDoc[] = [];
	for (const entry of catalog.entries) {
		const meta = metaByHash.get(entry.commitHash);
		if (!meta) continue; // catalog entry without an index head — skip (not browsable)

		const topicTitles = (entry.topics ?? []).map((t) => t.title).join("\n");
		const decisions = (entry.topics ?? [])
			.map((t) => t.decisions)
			.filter((d): d is string => Boolean(d))
			.join("\n");
		const bodyParts = [meta.commitMessage, entry.recap, topicTitles, decisions].filter(Boolean);

		docs.push({
			id: `commit:${entry.commitHash}`,
			type: "commit",
			title: meta.commitMessage,
			content: bodyParts.join("\n"),
			decisions,
			branch: [meta.branch],
			category: "commit",
			commitDate: meta.commitDate,
			slug: "",
			hash: entry.commitHash,
		});
	}
	return docs;
}

function dominantSourceType(refs: ReadonlyArray<{ type: string }>): string {
	if (refs.length === 0) return "topic";
	const counts = new Map<string, number>();
	for (const r of refs) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Cheap signature of source state. Changes whenever a source count or its
 * newest timestamp changes — enough to detect "data moved since last persist"
 * without rebuilding to compare. Used by SearchIndex's staleness check.
 */
export async function computeSourceSignature(cwd: string, storage?: StorageProvider): Promise<string> {
	const [index, catalog, topicIndex] = await Promise.all([
		getIndex(cwd, storage),
		getCatalogWithLazyBuild(cwd, storage),
		readTopicIndex(cwd, storage),
	]);
	const indexCount = index?.entries.length ?? 0;
	const newestGeneratedAt = (index?.entries ?? []).reduce(
		(max, e) => (e.generatedAt > max ? e.generatedAt : max),
		"",
	);
	const topicNewest = topicIndex.topics.reduce((max, t) => (t.lastUpdatedAt > max ? t.lastUpdatedAt : max), "");
	// Counts + newest timestamps catch adds/removes/re-summarizes, but NOT an
	// in-place content edit that preserves them — e.g. a WebView recap edit
	// rewrites `recap` while keeping the index entry's `generatedAt` and every
	// count. So fold a digest of the searchable catalog content (recap + per-topic
	// title/decisions) into the signature; any in-place edit changes it and the
	// stale index is rebuilt. The catalog is already loaded here, so this is CPU
	// only — no extra I/O.
	const contentDigest = createHash("sha1")
		.update(
			catalog.entries
				.map(
					(e) =>
						`${e.commitHash}\x00${e.recap ?? ""}\x00${(e.topics ?? [])
							.map((t) => `${t.title}${t.decisions ?? ""}`)
							.join("")}`,
				)
				.join(""),
		)
		.digest("hex");
	return [
		SEARCH_SCHEMA_VERSION,
		indexCount,
		catalog.entries.length,
		topicIndex.topics.length,
		newestGeneratedAt,
		topicNewest,
		contentDigest,
	].join("|");
}
