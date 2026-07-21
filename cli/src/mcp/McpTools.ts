/**
 * Pure MCP tool handlers (JOLLI-1226 P0). Each returns a plain
 * JSON-serializable object and throws a plain Error on bad input. No MCP SDK
 * coupling here so the handlers are unit-testable in isolation; McpServer.ts
 * adapts these into SDK tool responses.
 */

import type { BranchCatalog } from "../core/ContextCompiler.js";
import { listBranchCatalog } from "../core/ContextCompiler.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import {
	BindingAlreadyExistsError,
	JolliMemoryPushClient,
	type JolliMemorySpace,
} from "../core/JolliMemoryPushClient.js";
import { type PushBranchResult, pushBranchToJolli, resolveSpaceId } from "../core/JolliMemoryPushOrchestrator.js";
import { buildPrDescription, type PrDescriptionResult } from "../core/PrDescription.js";
import { getQueueStatus, type QueueStatus, waitForQueueDrained } from "../core/QueueStatus.js";
import { type RecallResult, resolveRecall } from "../core/RecallResolver.js";
import { searchHits } from "../core/SearchHits.js";
import type { SearchHitResult } from "../core/SearchIndex.js";
import { compareSourceRefs } from "../core/SourceTimeline.js";
import { clearSpaceBindingCache } from "../core/SpaceBindingCache.js";
import { getActiveStorage, getIndex } from "../core/SummaryStore.js";
import type { SourceRef } from "../core/TopicKBTypes.js";
import { readTopicPage } from "../core/TopicPageStore.js";
import type { SummaryIndexEntry } from "../Types.js";

export interface SearchArgs {
	query: string;
	branch?: string;
	type?: "topic" | "commit";
	limit?: number;
}

export async function runSearch(cwd: string, args: SearchArgs): Promise<{ hits: SearchHitResult[] }> {
	return { hits: await searchHits(cwd, args, getActiveStorage()) };
}

export async function runRecall(cwd: string, args: { branch?: string }): Promise<RecallResult> {
	return resolveRecall(args.branch, cwd);
}

export interface TimelineEntry {
	timestamp: string;
	branch: string;
	sourceType: string;
	sourceId: string;
}

/** A topic page's readable detail + its collapsed source timeline — everything a
 *  human browser needs to read a topic (the `content` markdown), plus the
 *  chronological sources behind it. */
export interface TopicDetail {
	slug: string;
	title: string;
	content: string;
	relatedBranches: string[];
	lastUpdatedAt: string;
	timeline: TimelineEntry[];
}

/** Read a topic page's full detail (readable `content` + ordered source timeline).
 *  Backs the TUI Memory Bank browser — unlike {@link runDecisionTimeline} it also
 *  returns the human-readable page body, which the timeline-only view dropped. */
export async function getTopicDetail(cwd: string, slug: string): Promise<TopicDetail> {
	if (!slug || !slug.trim()) throw new Error("`slug` is required");
	const page = await readTopicPage(slug, cwd);
	if (!page) throw new Error(`Topic not found: ${slug}`);
	const index = await getIndex(cwd, getActiveStorage());
	const timeline = collapseTimelineRefs(page.sourceRefs, index?.entries ?? [])
		.sort(compareSourceRefs)
		.map((r) => ({ timestamp: r.timestamp, branch: r.branch ?? "", sourceType: r.type, sourceId: r.id }));
	return {
		slug,
		title: page.title,
		content: page.content,
		relatedBranches: page.relatedBranches,
		lastUpdatedAt: page.lastUpdatedAt,
		timeline,
	};
}

/** Trailing `-<hex7|hex8>` plan-archive suffix (same shapes PlanSlug.extractBaseSlug accepts). */
const PLAN_ARCHIVE_SUFFIX = /-[0-9a-f]{7,8}$/;

function epochOf(iso: string): number {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Collapses a topic page's raw sourceRefs into the logical events a user would
 * recognize as "what actually happened":
 *  - summary refs are folded through the index's `parentCommitHash` chain to
 *    their live v4 Hoist head. An amend/squash re-ingests the new hash while
 *    the page keeps the superseded one, so without folding the same logical
 *    commit shows twice — once under a hash `git log` no longer knows.
 *  - plan refs are deduped to one entry per base slug (per-commit snapshots
 *    carry a `-<shortHash>` suffix), keeping the earliest snapshot's timestamp
 *    so the plan sorts where planning started, not where its last snapshot
 *    happened to be registered.
 */
export function collapseTimelineRefs(
	refs: ReadonlyArray<SourceRef>,
	entries: ReadonlyArray<SummaryIndexEntry>,
): SourceRef[] {
	const byHash = new Map(entries.map((e) => [e.commitHash, e]));
	const resolveHead = (hash: string): string => {
		let current = hash;
		const seen = new Set<string>([current]);
		for (;;) {
			const parent = byHash.get(current)?.parentCommitHash;
			if (parent == null || seen.has(parent)) return current;
			seen.add(parent);
			current = parent;
		}
	};
	const out = new Map<string, SourceRef>();
	for (const ref of refs) {
		if (ref.type === "summary") {
			const head = resolveHead(ref.id);
			const entry = byHash.get(head);
			const key = `summary:${head}`;
			if (!out.has(key)) {
				out.set(key, {
					...ref,
					id: head,
					timestamp: entry?.commitDate ?? ref.timestamp,
					branch: entry?.branch ?? ref.branch,
				});
			}
		} else if (ref.type === "plan") {
			const key = `plan:${ref.id.replace(PLAN_ARCHIVE_SUFFIX, "")}`;
			const prev = out.get(key);
			if (!prev || epochOf(ref.timestamp) < epochOf(prev.timestamp)) out.set(key, ref);
		} else {
			const key = `${ref.type}:${ref.id}`;
			if (!out.has(key)) out.set(key, ref);
		}
	}
	return [...out.values()];
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
	// Collapse amend-superseded hashes and plan snapshots first, then order via
	// the canonical comparator (epoch-parsed, with type/id tie-break) so a topic
	// whose sources carry mixed-timezone timestamps reads in the same
	// chronological order the ingest fold actually applied — a plain string
	// localeCompare would sort '…+09:00' vs '…Z' by their suffix, not by instant.
	const index = await getIndex(cwd, getActiveStorage());
	const timeline = collapseTimelineRefs(page.sourceRefs, index?.entries ?? [])
		.sort(compareSourceRefs)
		.map((r) => ({ timestamp: r.timestamp, branch: r.branch ?? "", sourceType: r.type, sourceId: r.id }));
	return { slug: args.slug, title: page.title, timeline };
}

export async function runListBranches(cwd: string): Promise<BranchCatalog> {
	return listBranchCatalog(cwd);
}

export interface GetPrDescriptionArgs {
	baseBranch?: string;
	includeMarkers?: boolean;
}

export async function runGetPrDescription(cwd: string, args: GetPrDescriptionArgs): Promise<PrDescriptionResult> {
	return buildPrDescription(cwd, {
		baseBranch: args.baseBranch,
		includeMarkers: args.includeMarkers,
	});
}

export interface QueueStatusArgs {
	wait?: boolean;
	timeoutMs?: number;
}

export async function runQueueStatus(cwd: string, args: QueueStatusArgs): Promise<QueueStatus & { waitedMs?: number }> {
	if (args.wait) {
		return waitForQueueDrained(cwd, { timeoutMs: args.timeoutMs });
	}
	return getQueueStatus(cwd);
}

export interface PushMemoryArgs {
	baseBranch?: string;
	space?: string;
}

/** Pushes `base..HEAD` commit summaries on the current branch to the bound Jolli Space. */
export async function runPushMemory(cwd: string, args: PushMemoryArgs): Promise<PushBranchResult> {
	return pushBranchToJolli({ cwd, baseBranch: args.baseBranch, space: args.space });
}

/** Lists the Jolli Spaces this tenant can bind a repo to, plus its configured default. */
export async function runListSpaces(
	_cwd: string,
): Promise<{ spaces: JolliMemorySpace[]; defaultSpaceId: number | null }> {
	return new JolliMemoryPushClient().listSpaces();
}

export type BindSpaceResult =
	| { type: "bound"; bindingId: number; jmSpaceId: number; repoName: string }
	| { type: "already_bound"; message: string };

/**
 * Binds this repo to a Jolli Space. Mirrors `jolli bind` (`JolliCloudCommands.ts`):
 * an already-existing binding is not an error condition — it comes back as
 * `{ type: "already_bound" }` rather than throwing.
 */
export async function runBindSpace(cwd: string, args: { space: string }): Promise<BindSpaceResult> {
	if (!args.space || !args.space.trim()) {
		throw new Error("`space` is required");
	}
	const client = new JolliMemoryPushClient();
	const repoUrl = await getCanonicalRepoUrl(cwd);
	const jmSpaceId = await resolveSpaceId(client, args.space);
	const repoName = deriveRepoNameFromUrl(repoUrl);
	try {
		const binding = await client.createBinding({ repoUrl, repoName, jmSpaceId });
		// Bind-only entry point: drop the local binding cache — the next probe
		// (or push echo) rebuilds it with the authoritative Space details.
		await clearSpaceBindingCache(cwd);
		return { type: "bound", ...binding };
	} catch (err) {
		if (err instanceof BindingAlreadyExistsError) {
			return { type: "already_bound", message: err.message };
		}
		throw err;
	}
}
