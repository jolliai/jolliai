/**
 * On-demand, display-time compression of a mined decision into one sentence
 * for the Decisions card's "Latest" quote. Deliberately NOT part of summary
 * generation: the full `decisions` text (1 sentence to a multi-bullet
 * paragraph) is already stored verbatim, and this only runs against whatever
 * is currently `latest` when the Stats page is rendered -- so historical
 * commits need no backfill.
 *
 * The Stats page polls `/api/model` every 30s (see shell.js PAGE_REFRESH_MS),
 * and `latest` typically doesn't change between polls, so results are cached in
 * this module-level Map for the life of the long-lived dashboard server process
 * (same idiom as DashboardQuery's partsFormatterCache and ProducerHooks'
 * identityCache). Three properties of that cache are deliberate:
 *
 *   - **Keyed on the commit hash AND the text.** A regenerated summary keeps its
 *     hash while replacing its decision, so a hash-only key served the gist of
 *     the OLD decision next to the new text, permanently.
 *   - **Failures are cached too.** This is the only route on an unauthenticated
 *     GET that spends money, and without a negative entry every 30 s poll (or
 *     every hit from anything else able to reach loopback) re-attempted the call.
 *     Cost is now bounded by the number of distinct decisions ever seen, not by
 *     request volume. The undefined case is "show the raw text", which is a fine
 *     answer to keep for the life of a process.
 *   - **Bounded.** An unbounded map on a process that lives for hours, keyed by
 *     something a caller can vary (scope × range each pick a different `latest`),
 *     is a slow leak.
 */

import { callLlm, llmCredentials } from "../core/LlmClient.js";
import { resolveModelId } from "../core/Summarizer.js";
import { createLogger } from "../Logger.js";
import type { JolliMemoryConfig } from "../Types.js";

const log = createLogger("DecisionGist");

const MAX_TOKENS = 80;
const TIMEOUT_MS = 5000;

/** Cap on distinct cached gists. FIFO eviction — recency is not worth a second map. */
const GIST_CACHE_MAX = 256;

/** `undefined` value = "we tried and got nothing"; absent key = "not tried". */
const gistCache = new Map<string, string | undefined>();

/** Cheap, collision-tolerant fingerprint of the decision text (djb2). */
function textFingerprint(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	return (hash >>> 0).toString(36);
}

function rememberGist(key: string, gist: string | undefined): void {
	if (gistCache.size >= GIST_CACHE_MAX) {
		const oldest = gistCache.keys().next();
		if (!oldest.done) gistCache.delete(oldest.value);
	}
	gistCache.set(key, gist);
}

/**
 * Returns a one-sentence gist of `text` for the given `commitHash`, or
 * `undefined` on any failure (missing credentials, LLM error, timeout, empty
 * response) -- callers fall back to showing the raw `text` in that case.
 */
export async function getDecisionGist(
	commitHash: string,
	text: string,
	config: JolliMemoryConfig,
): Promise<string | undefined> {
	const key = `${commitHash}:${textFingerprint(text)}`;
	if (gistCache.has(key)) return gistCache.get(key);

	let result: Awaited<ReturnType<typeof callLlm>>;
	try {
		result = await callLlm({
			action: "decision-gist",
			params: { text },
			maxTokens: MAX_TOKENS,
			timeoutMs: TIMEOUT_MS,
			model: resolveModelId(config.model ?? "haiku"),
			...llmCredentials(config),
		});
	} catch (error) {
		log.warn("Decision gist LLM call failed: %s", (error as Error).message);
		rememberGist(key, undefined);
		return undefined;
	}

	const gist = result.text?.trim();
	rememberGist(key, gist || undefined);
	return gist || undefined;
}
