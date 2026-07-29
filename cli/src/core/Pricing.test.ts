/**
 * Tests for `Pricing` — the estimated-USD-cost layer over normalised per-model
 * token usage. Pins the uniform formula, per-provider cached-rate direction
 * (Anthropic write ABOVE input, OpenAI read BELOW input), unpriced-model
 * handling (excluded, never guessed), and same-model summing.
 */

import { describe, expect, it } from "vitest";
import type { ModelTokenUsage } from "../Types.js";
import { estimateCostUsd, estimateModelCostUsd, MODEL_PRICES, PRICES_AS_OF } from "./Pricing.js";

const usage = (model: string, over: Partial<ModelTokenUsage> = {}): ModelTokenUsage => ({
	model,
	provider: "anthropic",
	input: 0,
	output: 0,
	cached: 0,
	...over,
});

describe("estimateModelCostUsd", () => {
	it("prices the three segments at the model's rates", () => {
		// Opus 4.8: $5/$25 input/output, $6.25 cached (per 1M).
		const cost = estimateModelCostUsd(
			usage("claude-opus-4-8", { input: 1_000_000, output: 1_000_000, cached: 1_000_000 }),
		);
		expect(cost).toBeCloseTo(5 + 25 + 6.25, 6);
	});

	it("scales linearly below 1M tokens", () => {
		const cost = estimateModelCostUsd(usage("claude-haiku-4-5", { input: 500_000, output: 200_000 }));
		// Haiku 4.5: $1 input, $5 output.
		expect(cost).toBeCloseTo(0.5 + 1.0, 6);
	});

	it("prices the Anthropic cached segment ABOVE the input rate (cache write)", () => {
		const price = MODEL_PRICES["claude-opus-4-8"];
		expect(price.cachedPerMTok).toBeGreaterThan(price.inputPerMTok);
	});

	it("prices the OpenAI cached segment BELOW the input rate (cache read)", () => {
		const price = MODEL_PRICES["gpt-5.5"];
		expect(price.cachedPerMTok).toBeLessThan(price.inputPerMTok);
	});

	it("returns null for a model absent from the table", () => {
		expect(estimateModelCostUsd(usage("some-unknown-model"))).toBeNull();
	});
});

describe("estimateCostUsd", () => {
	it("returns zero cost and no unpriced models for empty usage", () => {
		expect(estimateCostUsd([])).toEqual({ totalUsd: 0, unpricedModels: [] });
	});

	it("sums cost across multiple priced models", () => {
		const result = estimateCostUsd([
			usage("claude-opus-4-8", { output: 1_000_000 }), // $25
			usage("claude-haiku-4-5", { output: 1_000_000 }), // $5
		]);
		expect(result.totalUsd).toBeCloseTo(30, 6);
		expect(result.unpricedModels).toEqual([]);
	});

	it("sums repeated buckets of the same model", () => {
		const result = estimateCostUsd([
			usage("claude-opus-4-8", { output: 500_000 }),
			usage("claude-opus-4-8", { output: 500_000 }),
		]);
		// 2 × (500k · $25/1M) = $25.
		expect(result.totalUsd).toBeCloseTo(25, 6);
	});

	it("excludes unpriced models from the total and reports them once", () => {
		const result = estimateCostUsd([
			usage("claude-opus-4-8", { output: 1_000_000 }), // $25, counted
			usage("mystery-model", { output: 1_000_000 }), // excluded
			usage("mystery-model", { output: 1_000_000 }), // same unpriced model, dedup
		]);
		expect(result.totalUsd).toBeCloseTo(25, 6);
		expect(result.unpricedModels).toEqual(["mystery-model"]);
	});
});

describe("MODEL_PRICES coverage", () => {
	// claude-opus-5 was missing from the table while it was already the model
	// recorded in real transcripts, so every memory it produced was `unpriced` →
	// no `estimatedCostUsd` was stored → the UI silently fell back to Sonnet rates
	// and under-reported the cost of Opus work.
	it("prices claude-opus-5, the model real transcripts record today", () => {
		const price = MODEL_PRICES["claude-opus-5"];
		expect(price).toBeDefined();
		expect(price.inputPerMTok).toBe(5);
		expect(price.outputPerMTok).toBe(25);
		// 5-minute cache WRITE rate — 1.25x input, per the table's segment contract.
		expect(price.cachedPerMTok).toBe(6.25);
	});

	// Mythos 5 sits at the same rates as Fable 5 on the published pricing page
	// (limited availability). Pinned as a deliberate equality rather than left as two
	// coincidentally-identical rows: identical adjacent numbers are exactly what an
	// unverified copy looks like, and this table's `-pro` policy forbids guessing.
	it("prices claude-mythos-5 at the Fable 5 rates the pricing page lists for it", () => {
		expect(MODEL_PRICES["claude-mythos-5"]).toEqual({
			provider: "anthropic",
			inputPerMTok: 10,
			outputPerMTok: 50,
			cachedPerMTok: 12.5,
		});
		expect(MODEL_PRICES["claude-mythos-5"]).toEqual(MODEL_PRICES["claude-fable-5"]);
	});

	// Verified against developers.openai.com/api/docs/pricing on 2026-07-29. The
	// prior values for these three were placeholders copied off the GPT-5 tier and
	// were wrong (gpt-5.5 by 4x on input), so every Codex conversation on them was
	// costed too low. Pinned here so a future edit can't quietly re-guess them.
	it.each([
		["gpt-5.6-sol", 5, 30, 0.5],
		["gpt-5.6-terra", 2.5, 15, 0.25],
		["gpt-5.6-luna", 1, 6, 0.1],
		["gpt-5.5", 5, 30, 0.5],
		["gpt-5.4", 2.5, 15, 0.25],
		["gpt-5.4-mini", 0.75, 4.5, 0.075],
		["gpt-5.4-nano", 0.2, 1.25, 0.02],
		["gpt-5.3-codex", 1.75, 14, 0.175],
		["gpt-5.2-codex", 1.75, 14, 0.175],
		["gpt-5-mini", 0.25, 2, 0.025],
		["gpt-5-nano", 0.05, 0.4, 0.005],
	])("prices %s at the published list rate", (model, input, output, cached) => {
		expect(MODEL_PRICES[model]).toEqual({
			provider: "openai",
			inputPerMTok: input,
			outputPerMTok: output,
			cachedPerMTok: cached,
		});
	});

	it("prices the OpenAI cached segment BELOW input (a cache read, not a write)", () => {
		// Inverted from Anthropic, whose cached segment is a cache write at 1.25x input.
		// Getting this backwards would overstate Codex cost and understate Claude cost.
		// `-pro` is exempt: the page publishes no cached-input rate for those, so they
		// are billed at the full input rate (never below) — see the next test.
		for (const [model, price] of Object.entries(MODEL_PRICES)) {
			if (price.provider !== "openai" || model.endsWith("-pro")) continue;
			expect(price.cachedPerMTok, `${model} cached rate should be below input`).toBeLessThan(price.inputPerMTok);
		}
		for (const [model, price] of Object.entries(MODEL_PRICES)) {
			if (price.provider !== "anthropic") continue;
			expect(price.cachedPerMTok, `${model} cached rate should exceed input`).toBeGreaterThan(price.inputPerMTok);
		}
	});

	// Verified against developers.openai.com/api/docs/pricing on 2026-07-30: input and
	// output are published, the cached-input column shows "-". These rows were absent
	// while that dash was read as "unpriceable", which sent their WHOLE usage to the
	// flat Sonnet fallback — $3/$15 for a model billed $30/$180. Pinned so the rows
	// can't quietly disappear again.
	it.each([
		["gpt-5.5-pro", 30, 180],
		["gpt-5.4-pro", 30, 180],
		["gpt-5.2-pro", 21, 168],
		["gpt-5-pro", 15, 120],
	])("prices %s with its cached segment at the full input rate", (model, input, output) => {
		expect(MODEL_PRICES[model]).toEqual({
			provider: "openai",
			inputPerMTok: input,
			outputPerMTok: output,
			// No published discount: either the model doesn't cache (segment is always 0)
			// or it caches at list price. Equal to input is the only non-invented value.
			cachedPerMTok: input,
		});
	});

	it("costs a -pro conversation far above the Sonnet fallback it used to receive", () => {
		// The regression this row set fixes, stated in dollars: 1M in + 1M out on
		// gpt-5.5-pro is $210, where the unpriced path handed the display layer $0 and it
		// fell back to Sonnet's $3 + $15.
		const estimate = estimateCostUsd([
			{ model: "gpt-5.5-pro", provider: "openai", input: 1_000_000, output: 1_000_000, cached: 0 },
		]);
		expect(estimate.totalUsd).toBeCloseTo(210, 6);
		expect(estimate.unpricedModels).toEqual([]);
	});

	it("leaves no priced model without a cached rate", () => {
		for (const [model, price] of Object.entries(MODEL_PRICES)) {
			expect(price.cachedPerMTok, `${model} has no cached rate`).toBeGreaterThan(0);
		}
	});
});

describe("PRICES_AS_OF", () => {
	it("is an ISO date string", () => {
		expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
