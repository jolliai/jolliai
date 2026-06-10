/**
 * Pure MCP tool handlers (JOLLI-1226 P0). Each returns a plain
 * JSON-serializable object and throws a plain Error on bad input. No MCP SDK
 * coupling here so the handlers are unit-testable in isolation; McpServer.ts
 * adapts these into SDK tool responses.
 */

import type { BranchCatalog, RecallPayload } from "../core/ContextCompiler.js";
import { buildRecallPayload, compileTaskContext, listBranchCatalog } from "../core/ContextCompiler.js";
import { getCurrentBranch } from "../core/GitOps.js";
import type { SearchHitResult } from "../core/SearchIndex.js";
import { SearchIndex } from "../core/SearchIndex.js";
import { compareSourceRefs } from "../core/SourceTimeline.js";
import { getActiveStorage } from "../core/SummaryStore.js";
import { readTopicPage } from "../core/TopicPageStore.js";

export interface SearchArgs {
	query: string;
	branch?: string;
	type?: "topic" | "commit";
	limit?: number;
}

export async function runSearch(cwd: string, args: SearchArgs): Promise<{ hits: SearchHitResult[] }> {
	if (!args.query || !args.query.trim()) {
		throw new Error("`query` is required and must be non-empty");
	}
	// Pass the active storage so the index dir resolves to the SAME location the
	// compile warm-up wrote to — `<kbRoot>/.jolli/jollimemory/` in folder/dual-write
	// mode, the checkout's `.jolli/jollimemory/` in orphan-only. Without it,
	// resolveIndexDir falls back to cwd and a folder-mode server never sees the
	// warm index (see SearchIndex.resolveIndexDir).
	const index = await SearchIndex.openCached(cwd, getActiveStorage());
	const hits = await index.search({
		query: args.query,
		branch: args.branch,
		type: args.type,
		limit: args.limit,
	});
	return { hits };
}

export async function runRecall(cwd: string, args: { branch?: string }): Promise<RecallPayload> {
	const branch = args.branch ?? (await getCurrentBranch(cwd));
	const ctx = await compileTaskContext({ branch }, cwd);
	return buildRecallPayload(ctx);
}

export interface TimelineEntry {
	timestamp: string;
	branch: string;
	sourceType: string;
	sourceId: string;
}

export async function runDecisionTimeline(
	cwd: string,
	args: { slug: string },
): Promise<{ slug: string; title: string; timeline: TimelineEntry[] }> {
	if (!args.slug || !args.slug.trim()) {
		throw new Error("`slug` is required");
	}
	const page = await readTopicPage(args.slug, cwd);
	if (!page) {
		throw new Error(`Topic not found: ${args.slug}`);
	}
	// Order via the canonical comparator (epoch-parsed, with type/id tie-break)
	// so a topic whose sources carry mixed-timezone timestamps reads in the same
	// chronological order the ingest fold actually applied — a plain string
	// localeCompare would sort '…+09:00' vs '…Z' by their suffix, not by instant.
	const timeline = [...page.sourceRefs]
		.sort(compareSourceRefs)
		.map((r) => ({ timestamp: r.timestamp, branch: r.branch ?? "", sourceType: r.type, sourceId: r.id }));
	return { slug: args.slug, title: page.title, timeline };
}

export async function runListBranches(cwd: string): Promise<BranchCatalog> {
	return listBranchCatalog(cwd);
}
