/**
 * TokenCost
 *
 * Single source of truth for conversation token/cost formatting, shared by the
 * CLI Markdown builder (pushed Space article + clipboard export) and the VS Code
 * token meter / sidebar token bar (which re-export these via SummaryUtils). The
 * two surfaces must never disagree on the same underlying token counts, so the
 * constants and formatters live here rather than in the VS Code layer.
 */

import type { ConversationTokenBreakdown } from "../Types.js";

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
