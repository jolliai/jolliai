/**
 * Pricing — estimated USD cost of conversation token usage.
 *
 * No AI-agent transcript records a dollar cost directly (neither Claude Code nor
 * Codex); they record raw token counts plus the model. Cost is therefore always
 * an estimate of `tokens × per-model price`. This module owns that estimate: a
 * single editable price table + a uniform cost formula.
 *
 * The uniform formula is `input·inRate + cached·cachedRate + output·outRate`. For
 * it to hold across providers, callers must normalise usage into the three
 * disjoint, non-overlapping segments the formula expects:
 *   - `input`  — tokens billed at the full input rate (uncached input only).
 *   - `cached` — tokens billed at the model's cached rate.
 *   - `output` — tokens billed at the output rate (fold reasoning tokens in here).
 *
 * The two providers reach that normalisation differently — see the notes on each
 * table entry and on {@link ModelPrice.cachedPerMTok}:
 *   - Anthropic transcripts already report `input_tokens` net of cache, and the
 *     `cached` segment carries `cache_creation_input_tokens` — a cache *write*,
 *     billed ABOVE the input rate (~1.25×). (`cache_read_input_tokens` is a
 *     cumulative running total and is excluded upstream — see
 *     `ClaudeTranscriptParser.parseUsageTokens`.)
 *   - OpenAI/Codex reports `input_tokens` *inclusive* of the cached portion, so
 *     the parser must subtract `cached_input_tokens` out of `input` before it
 *     reaches here; the `cached` segment is a cache *read*, billed BELOW the
 *     input rate (~0.1×).
 *
 * Prices change over time and there is no official machine-readable pricing API
 * (Anthropic's `GET /v1/models` returns capabilities/context windows, not price),
 * so this table is hand-maintained. {@link PRICES_AS_OF} stamps it. Estimates
 * assume standard list pricing — no promotional/intro, batch, or volume
 * discounts (e.g. Sonnet's intro rate). Surface that caveat next to any figure.
 *
 * Official pricing pages — re-verify against these when editing a rate, and bump
 * {@link PRICES_AS_OF}. Copying a neighbouring row's numbers is how every OpenAI
 * rate in this table came to be wrong by up to 4x before 2026-07-29:
 *   - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 *   - OpenAI:    https://developers.openai.com/api/docs/pricing
 *
 * One deliberate divergence from the Anthropic page: Sonnet 5 is priced here at
 * its standard $3/$15 rate, not the $2/$10 introductory rate in effect through
 * 2026-08-31 — consistent with the no-promotional-pricing rule above, and it
 * makes the estimate an upper bound for Sonnet 5 work until that date.
 */

import type { ModelTokenUsage, TokenProvider } from "../Types.js";

/** Per-model list price, in USD per 1,000,000 tokens, for each billing segment. */
export interface ModelPrice {
	readonly provider: TokenProvider;
	/** Full input rate ($/1M) for uncached input tokens. */
	readonly inputPerMTok: number;
	/** Output rate ($/1M). Reasoning tokens are billed at this rate. */
	readonly outputPerMTok: number;
	/**
	 * Cached-segment rate ($/1M). NOT derived from `inputPerMTok` — set
	 * explicitly per model because the cached segment means opposite things by
	 * provider: an Anthropic cache *write* (~1.25× input, so higher) vs an
	 * OpenAI cache *read* (~0.1× input, so lower). Keeping it a literal keeps the
	 * table transparent and the formula uniform.
	 *
	 * A third case: OpenAI's `-pro` models publish no cached-input rate, so theirs
	 * is set EQUAL to input — see the note above those rows.
	 */
	readonly cachedPerMTok: number;
}

/**
 * The date this table was last verified against published pricing. Stored on
 * every summary that carries a cost estimate so a reader can tell how stale the
 * figure is. Bump it whenever a price below changes.
 */
export const PRICES_AS_OF = "2026-07-30";

/**
 * List prices, keyed by the exact model identifier that appears in the
 * transcript (`message.model` for Claude, `turn_context.payload.model` for
 * Codex). Anthropic figures are from the published pricing table; the cached
 * rate is the 5-minute cache-*write* rate (1.25× input). OpenAI figures are the
 * published list prices, verified on the date in {@link PRICES_AS_OF}.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
	// ── Anthropic (input / output verified; cached = 1.25× input cache-write) ──
	"claude-fable-5": { provider: "anthropic", inputPerMTok: 10, outputPerMTok: 50, cachedPerMTok: 12.5 },
	// Mythos 5 is listed on the pricing page as limited-availability at the SAME
	// rates as Fable 5 ($10 / $12.50 5m-write / $50) — verified there, not inferred
	// from the neighbouring row. Stated explicitly because identical numbers next to
	// each other are exactly what an unverified copy looks like, and the `-pro`
	// policy at the bottom of this table forbids guessing a rate.
	"claude-mythos-5": { provider: "anthropic", inputPerMTok: 10, outputPerMTok: 50, cachedPerMTok: 12.5 },
	"claude-opus-5": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25, cachedPerMTok: 6.25 },
	"claude-opus-4-8": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25, cachedPerMTok: 6.25 },
	"claude-opus-4-7": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25, cachedPerMTok: 6.25 },
	"claude-opus-4-6": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25, cachedPerMTok: 6.25 },
	"claude-opus-4-5": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25, cachedPerMTok: 6.25 },
	"claude-sonnet-5": { provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15, cachedPerMTok: 3.75 },
	"claude-sonnet-4-6": { provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15, cachedPerMTok: 3.75 },
	"claude-sonnet-4-5": { provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15, cachedPerMTok: 3.75 },
	"claude-haiku-4-5": { provider: "anthropic", inputPerMTok: 1, outputPerMTok: 5, cachedPerMTok: 1.25 },
	// Date-suffixed twin of the row above. Two lookups reach this key: the compile
	// estimate resolves the `haiku` alias to this exact id (see MODEL_ALIAS_MAP in
	// Summarizer), and an agent transcript that ran Haiku records it verbatim.
	// Without the entry both fall through — the estimate to the sonnet fallback
	// (~3× over) and the transcript cost to "unpriced". opus/sonnet aliases resolve
	// to un-suffixed ids already in the table, so only haiku needs the twin today.
	"claude-haiku-4-5-20251001": { provider: "anthropic", inputPerMTok: 1, outputPerMTok: 5, cachedPerMTok: 1.25 },
	// ── OpenAI / Codex ────────────────────────────────────────────────────────
	// Verified against developers.openai.com/api/docs/pricing on 2026-07-29.
	// `cached` is OpenAI's cached-input rate — a cache READ (0.1× input), the
	// opposite direction from Anthropic's cache-write rate above; the parser
	// subtracts the cached portion out of `input` before it reaches here, so the
	// two segments stay disjoint (see the module header).
	//
	// The previous values for the three pre-existing rows were placeholders that
	// mirrored the GPT-5 list tier and were all wrong — gpt-5.5 by 4× on input
	// and 3× on output — which silently under-reported the cost of every Codex
	// conversation on those models. Re-verify against the page above when adding
	// a row rather than copying a neighbour's numbers.
	"gpt-5.6-sol": { provider: "openai", inputPerMTok: 5, outputPerMTok: 30, cachedPerMTok: 0.5 },
	"gpt-5.6-terra": { provider: "openai", inputPerMTok: 2.5, outputPerMTok: 15, cachedPerMTok: 0.25 },
	"gpt-5.6-luna": { provider: "openai", inputPerMTok: 1, outputPerMTok: 6, cachedPerMTok: 0.1 },
	"gpt-5.5": { provider: "openai", inputPerMTok: 5, outputPerMTok: 30, cachedPerMTok: 0.5 },
	"gpt-5.4": { provider: "openai", inputPerMTok: 2.5, outputPerMTok: 15, cachedPerMTok: 0.25 },
	"gpt-5.4-mini": { provider: "openai", inputPerMTok: 0.75, outputPerMTok: 4.5, cachedPerMTok: 0.075 },
	"gpt-5.4-nano": { provider: "openai", inputPerMTok: 0.2, outputPerMTok: 1.25, cachedPerMTok: 0.02 },
	"gpt-5.3-codex": { provider: "openai", inputPerMTok: 1.75, outputPerMTok: 14, cachedPerMTok: 0.175 },
	"gpt-5.2": { provider: "openai", inputPerMTok: 1.75, outputPerMTok: 14, cachedPerMTok: 0.175 },
	"gpt-5.2-codex": { provider: "openai", inputPerMTok: 1.75, outputPerMTok: 14, cachedPerMTok: 0.175 },
	"gpt-5.1": { provider: "openai", inputPerMTok: 1.25, outputPerMTok: 10, cachedPerMTok: 0.125 },
	"gpt-5.1-codex-max": { provider: "openai", inputPerMTok: 1.25, outputPerMTok: 10, cachedPerMTok: 0.125 },
	"gpt-5.1-codex": { provider: "openai", inputPerMTok: 1.25, outputPerMTok: 10, cachedPerMTok: 0.125 },
	"gpt-5": { provider: "openai", inputPerMTok: 1.25, outputPerMTok: 10, cachedPerMTok: 0.125 },
	"gpt-5-codex": { provider: "openai", inputPerMTok: 1.25, outputPerMTok: 10, cachedPerMTok: 0.125 },
	"gpt-5-mini": { provider: "openai", inputPerMTok: 0.25, outputPerMTok: 2, cachedPerMTok: 0.025 },
	"gpt-5-nano": { provider: "openai", inputPerMTok: 0.05, outputPerMTok: 0.4, cachedPerMTok: 0.005 },
	// ── OpenAI `-pro`: cached segment at the FULL input rate ──────────────────
	// The pricing page states input and output for these but shows "-" in the
	// cached-input column, with no note explaining the dash. They were absent from
	// this table for that reason — but absence is the worse error of the two:
	// an unpriced model contributes $0 here, so the display layer prices its ENTIRE
	// usage at the flat Sonnet fallback (see `estimateCost` in SummaryHtmlBuilder and
	// `estimateConversationCostUsd`) — $3/$15 against gpt-5.5-pro's real $30/$180, a
	// ~10x understatement across every segment. Pricing the two published segments
	// correctly and the undocumented one at the full input rate keeps the error inside
	// the cached segment alone.
	//
	// The input rate is also the only non-invented value available for that segment:
	// the dash means either the model does not support prompt caching (then `cached`
	// is always 0 and the rate never applies) or it caches with no discount (then the
	// input rate is exactly right). Both readings are consistent with billing at the
	// input rate; neither supports a discount, which is what a made-up number would
	// imply. Same spirit as the no-promotional-pricing rule: prefer the upper bound.
	"gpt-5.5-pro": { provider: "openai", inputPerMTok: 30, outputPerMTok: 180, cachedPerMTok: 30 },
	"gpt-5.4-pro": { provider: "openai", inputPerMTok: 30, outputPerMTok: 180, cachedPerMTok: 30 },
	"gpt-5.2-pro": { provider: "openai", inputPerMTok: 21, outputPerMTok: 168, cachedPerMTok: 21 },
	"gpt-5-pro": { provider: "openai", inputPerMTok: 15, outputPerMTok: 120, cachedPerMTok: 15 },
};

/** Result of estimating cost across a set of per-model usage buckets. */
export interface CostEstimate {
	/** Total estimated cost in USD across all priced models. */
	readonly totalUsd: number;
	/**
	 * Models present in the usage that have no entry in {@link MODEL_PRICES}.
	 * Their tokens are excluded from `totalUsd` (never guessed). A non-empty list
	 * means the estimate is a lower bound — surface it rather than hide it.
	 */
	readonly unpricedModels: ReadonlyArray<string>;
}

/** Estimated USD cost of one model's normalised token usage, or null if unpriced. */
export function estimateModelCostUsd(usage: ModelTokenUsage): number | null {
	const price = MODEL_PRICES[usage.model];
	if (!price) return null;
	return (
		(usage.input * price.inputPerMTok + usage.cached * price.cachedPerMTok + usage.output * price.outputPerMTok) /
		1_000_000
	);
}

/**
 * Estimates total USD cost across per-model usage buckets. Unpriced models are
 * skipped (never guessed) and reported in {@link CostEstimate.unpricedModels} so
 * the caller can flag the total as a lower bound. Same-model buckets are summed.
 */
export function estimateCostUsd(usageByModel: ReadonlyArray<ModelTokenUsage>): CostEstimate {
	let totalUsd = 0;
	const unpriced = new Set<string>();
	for (const usage of usageByModel) {
		const cost = estimateModelCostUsd(usage);
		if (cost === null) {
			unpriced.add(usage.model);
		} else {
			totalUsd += cost;
		}
	}
	return { totalUsd, unpricedModels: [...unpriced] };
}
