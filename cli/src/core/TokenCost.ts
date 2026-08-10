/**
 * TokenCost
 *
 * Single source of truth for conversation token/cost formatting, shared by the
 * CLI Markdown builder (pushed Space article + clipboard export) and the VS Code
 * token meter / sidebar token bar (which re-export these via SummaryUtils). The
 * two surfaces must never disagree on the same underlying token counts, so the
 * constants and formatters live here rather than in the VS Code layer.
 */

import type { CommitSummary, ConversationTokenBreakdown, ModelTokenUsage } from "../Types.js";
import { estimateModelCostUsd } from "./Pricing.js";

/** Formats a token count compactly (e.g. `1443000` -> `1.4M`, `2000000` -> `2M`, `96000` -> `96k`). */
export function formatTokensCompact(n: number): string {
	// 999_500 is the point at which `Math.round(n / 1_000)` would round up to
	// 1000 — promote to the `M` form so a count like 999_800 renders `1M`, not
	// the nonsensical `1000k`.
	if (n >= 999_500) {
		return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (n >= 1_000) {
		return `${Math.round(n / 1_000)}k`;
	}
	return String(n);
}

// Rough per-token $ constants at Sonnet pricing (per token, not per-million).
// `cached` (= cache_creation) is priced at the cache-write rate, which is
// pricier than a standard input token but cheaper than treating it as fresh
// input twice over. This is a ballpark estimate, not a billing-accurate
// figure — actual cost varies by model and by any cache-read savings not
// represented here.
export const SONNET_INPUT_PER_TOKEN = 3 / 1_000_000;
export const SONNET_OUTPUT_PER_TOKEN = 15 / 1_000_000;
export const SONNET_CACHE_WRITE_PER_TOKEN = 3.75 / 1_000_000;

/** Formats a cache-aware $ estimate at Sonnet pricing as `"≈$X.XX"` / `"<$0.01"`. */
export function formatSonnetCostEstimate(costUsd: number): string {
	return costUsd >= 0.01 ? `≈$${costUsd.toFixed(2)}` : "<$0.01";
}

/**
 * Formats an exact token count with thousands separators (e.g. `3000000` ->
 * `"3,000,000"`). Used by the pushed-memory Markdown "Task usage" line, which
 * shows precise figures rather than the compact `formatTokensCompact` form the
 * space-constrained UI token bar uses.
 */
export function formatTokensExact(n: number): string {
	return Math.round(n)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats an exact USD cost for the pushed-memory Markdown "Task usage" line:
 * two decimals at or above a cent (`"$21.75"`), and four decimals for a sub-cent
 * value (`"$0.0034"`) so a real small amount shows instead of a misleading
 * `"$0.00"`. A positive value too small to survive four decimals (below
 * `$0.00005`, which would itself round to `"$0.0000"`) renders as the floor
 * `"<$0.0001"` — mirroring {@link formatSonnetCostEstimate}'s `"<$0.01"` — so a
 * real cost never displays as an all-zeros figure. Unlike that function there is
 * no `≈` prefix: the article surfaces the precise computed figure. The value is
 * still a Sonnet-pricing estimate (see {@link estimateConversationCostUsd});
 * precision here is about not rounding the number away, not billing accuracy.
 */
export function formatExactCostUsd(costUsd: number): string {
	if (costUsd >= 0.01) return `$${costUsd.toFixed(2)}`;
	if (costUsd >= 0.00005) return `$${costUsd.toFixed(4)}`;
	if (costUsd > 0) return "<$0.0001";
	return "$0.00";
}

/**
 * Cache-aware cost estimate (USD) at Sonnet pricing. With a breakdown, each
 * segment is priced at its own rate; without one, the total is priced at the
 * input rate (a floor — we never fabricate a split we don't have). Pair with
 * {@link formatSonnetCostEstimate} to render.
 */
export function estimateConversationCostUsd(breakdown: ConversationTokenBreakdown | undefined, total: number): number {
	return breakdown
		? breakdown.input * SONNET_INPUT_PER_TOKEN +
				breakdown.output * SONNET_OUTPUT_PER_TOKEN +
				breakdown.cached * SONNET_CACHE_WRITE_PER_TOKEN
		: total * SONNET_INPUT_PER_TOKEN;
}

/**
 * Sums the token segments of a node's per-model buckets whose model has no entry
 * in the host price table, or null when every bucket is priced (or the node
 * records no buckets to inspect).
 *
 * These are exactly the tokens `estimatedCostUsd` deliberately left out of its
 * total rather than guessing a rate for, so they are what a stored cost still
 * owes. Membership is probed through `estimateModelCostUsd`'s null return — the
 * same predicate the write-time estimate uses — rather than by reading
 * `MODEL_PRICES` here, so the two can never disagree about what "unpriced" means.
 *
 * A node carrying a cost but no `conversationModels` (hand-edited or otherwise
 * off-contract data — write time only stores a cost alongside buckets) returns
 * null: there is nothing to inspect, so the stored figure is taken at face value.
 */
function unpricedSegments(models: ReadonlyArray<ModelTokenUsage> | undefined): ConversationTokenBreakdown | null {
	let input = 0;
	let output = 0;
	let cached = 0;
	for (const m of models ?? []) {
		if (estimateModelCostUsd(m) !== null) continue;
		input += m.input;
		output += m.output;
		cached += m.cached;
	}
	return input + output + cached > 0 ? { input, output, cached } : null;
}

/** What fed {@link estimateSummaryCostUsd}'s figure, so a caller's tooltip can describe it honestly. */
export type SummaryCostMode = "stored" | "sonnet" | "mixed";

/**
 * A memory's cache-aware $ estimate over its WHOLE consolidation tree,
 * preferring the cost computed at WRITE time from each node's actual model(s)
 * via the host price table, and falling back to the flat Sonnet-rate estimate
 * for whatever the stored cost does not cover — legacy memories, or a
 * conversation whose model is absent from the price table.
 *
 * Lives here, not on a surface, because every surface showing a memory's cost
 * must show the same number: the editor's token meter and the local web
 * dashboard disagreed by two orders of magnitude ($12.21 against $0.06) for
 * exactly as long as the dashboard read the ROOT node's own `estimatedCostUsd`
 * while the editor summed the tree. A squash root's own cost is a fraction of
 * the work folded beneath it.
 *
 * The preference is resolved PER NODE, not once for the whole tree. A tree-wide
 * "any stored cost wins" test silently under-reports a mixed consolidation: the
 * token headline beside this figure aggregates EVERY node, so a squash whose root
 * carries a stored cost while a folded legacy child does not would price only the
 * root and show that total next to the full tree's tokens. Summing per node keeps
 * the two figures over the same set. (The Sonnet formula is linear per segment, so
 * summing per-node fallbacks equals estimating from their aggregate — no drift
 * against pricing from the aggregate for an all-fallback tree.)
 *
 * A stored cost is a LOWER bound, not proof of full coverage, so the per-node
 * preference is resolved per MODEL bucket rather than per node — see
 * {@link unpricedSegments}.
 */
export function estimateSummaryCostUsd(summary: CommitSummary): { usd: number; mode: SummaryCostMode } {
	let usd = 0;
	let storedNodes = 0;
	let fallbackNodes = 0;
	const walk = (node: CommitSummary): void => {
		const own = node.estimatedCostUsd ?? 0;
		const tokens = node.conversationTokens ?? 0;
		if (own > 0) {
			usd += own;
			storedNodes++;
			// A positive stored cost does NOT mean the node is fully priced. Write time
			// records `estimatedCostUsd` as a lower bound: `estimateCostUsd` prices only
			// the buckets present in the host price table and EXCLUDES the rest rather
			// than guessing (see Pricing.ts's `-pro` note, Types.ts on
			// `estimatedCostUsd`, and conversationUsageFields in QueueWorker). Treating
			// `own > 0` as full coverage therefore under-reports every node that mixed a
			// priced model with an unpriced one — the unpriced bucket's tokens sit in the
			// headline total beside this figure while contributing $0 to it. Price
			// exactly those buckets at the flat rate, the same treatment a wholly
			// unpriced node gets below, and let them tip the mode to "mixed" so the
			// tooltip stops claiming the figure is fully model-priced.
			const unpriced = unpricedSegments(node.conversationModels);
			if (unpriced) {
				usd += estimateConversationCostUsd(unpriced, unpriced.input + unpriced.output + unpriced.cached);
				fallbackNodes++;
			}
		} else if (tokens > 0) {
			// No stored cost but real tokens — this node needs the flat-rate fallback.
			// Nodes with neither contribute nothing and must NOT tip the mode either way.
			usd += estimateConversationCostUsd(node.conversationTokenBreakdown, tokens);
			fallbackNodes++;
		}
		for (const child of node.children ?? []) walk(child);
	};
	walk(summary);
	return { usd, mode: storedNodes > 0 ? (fallbackNodes > 0 ? "mixed" : "stored") : "sonnet" };
}
