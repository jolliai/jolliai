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

	it("prices the date-suffixed Haiku id (transcripts record it verbatim) same as the un-suffixed row", () => {
		const suffixed = estimateModelCostUsd(usage("claude-haiku-4-5-20251001", { input: 500_000, output: 200_000 }));
		const plain = estimateModelCostUsd(usage("claude-haiku-4-5", { input: 500_000, output: 200_000 }));
		expect(suffixed).not.toBeNull();
		expect(suffixed).toBe(plain);
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

describe("PRICES_AS_OF", () => {
	it("is an ISO date string", () => {
		expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
