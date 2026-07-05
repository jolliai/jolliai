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
import { getActiveStorage } from "../core/SummaryStore.js";
import { readTopicPage } from "../core/TopicPageStore.js";

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
		return { type: "bound", ...binding };
	} catch (err) {
		if (err instanceof BindingAlreadyExistsError) {
			return { type: "already_bound", message: err.message };
		}
		throw err;
	}
}
