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
	 */
	readonly cachedPerMTok: number;
}

/**
 * The date this table was last verified against published pricing. Stored on
 * every summary that carries a cost estimate so a reader can tell how stale the
 * figure is. Bump it whenever a price below changes.
 */
export const PRICES_AS_OF = "2026-07-04";

/**
 * List prices, keyed by the exact model identifier that appears in the
 * transcript (`message.model` for Claude, `turn_context.payload.model` for
 * Codex). Anthropic figures are from the published pricing table; the cached
 * rate is the 5-minute cache-*write* rate (1.25× input). OpenAI GPT-5-family
 * figures are best-known list prices and MUST be re-verified before shipping
 * user-facing cost — treat them as provisional (see the note on each).
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
	// ── Anthropic (input / output verified; cached = 1.25× input cache-write) ──
	"claude-fable-5": { provider: "anthropic", inputPerMTok: 10, outputPerMTok: 50, cachedPerMTok: 12.5 },
	"claude-opus-4-8": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25, cachedPerMTok: 6.25 },
	"claude-opus-4-7": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25, cachedPerMTok: 6.25 },
	"claude-opus-4-6": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25, cachedPerMTok: 6.25 },
	"claude-opus-4-5": { provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25, cachedPerMTok: 6.25 },
	"claude-sonnet-5": { provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15, cachedPerMTok: 3.75 },
	"claude-sonnet-4-6": { provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15, cachedPerMTok: 3.75 },
	"claude-sonnet-4-5": { provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15, cachedPerMTok: 3.75 },
	"claude-haiku-4-5": { provider: "anthropic", inputPerMTok: 1, outputPerMTok: 5, cachedPerMTok: 1.25 },
	// ── OpenAI / Codex (PROVISIONAL — re-verify before shipping) ──────────────
	// cached = cache-read rate (~0.1× input). gpt-5.4 / gpt-5.5 are post-cutoff;
	// numbers mirror the GPT-5 list tier and must be confirmed against OpenAI's
	// current pricing page. Unknown models simply fall through to "unpriced".
	"gpt-5.5": { provider: "openai", inputPerMTok: 1.25, outputPerMTok: 10, cachedPerMTok: 0.125 },
	"gpt-5.4": { provider: "openai", inputPerMTok: 1.25, outputPerMTok: 10, cachedPerMTok: 0.125 },
	"gpt-5.2-codex": { provider: "openai", inputPerMTok: 1.25, outputPerMTok: 10, cachedPerMTok: 0.125 },
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
