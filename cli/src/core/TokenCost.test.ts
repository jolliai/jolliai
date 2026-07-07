import { describe, expect, it } from "vitest";
import {
	estimateConversationCostUsd,
	formatExactCostUsd,
	formatSonnetCostEstimate,
	formatTokensCompact,
	formatTokensExact,
	SONNET_CACHE_WRITE_PER_TOKEN,
	SONNET_INPUT_PER_TOKEN,
	SONNET_OUTPUT_PER_TOKEN,
} from "./TokenCost.js";

describe("formatTokensCompact", () => {
	it("renders raw counts under 1000", () => {
		expect(formatTokensCompact(500)).toBe("500");
		expect(formatTokensCompact(0)).toBe("0");
	});
	it("renders k for thousands", () => {
		expect(formatTokensCompact(1_000)).toBe("1k");
		expect(formatTokensCompact(5000)).toBe("5k");
		expect(formatTokensCompact(96499)).toBe("96k");
	});
	it("renders M for millions", () => {
		expect(formatTokensCompact(1443000)).toBe("1.4M");
		expect(formatTokensCompact(2000000)).toBe("2M");
	});
	it("promotes the k→M boundary at 999_500", () => {
		expect(formatTokensCompact(999_500)).toBe("1M");
		expect(formatTokensCompact(999_499)).toBe("999k");
	});
});

describe("formatSonnetCostEstimate", () => {
	it("renders <$0.01 below one cent", () => {
		expect(formatSonnetCostEstimate(0.001)).toBe("<$0.01");
	});
	it("renders ≈$ at and above one cent", () => {
		expect(formatSonnetCostEstimate(0.01)).toBe("≈$0.01");
		expect(formatSonnetCostEstimate(4.329)).toBe("≈$4.33");
	});
});

describe("formatTokensExact", () => {
	it("inserts thousands separators", () => {
		expect(formatTokensExact(3_000_000)).toBe("3,000,000");
		expect(formatTokensExact(1_200_000)).toBe("1,200,000");
		expect(formatTokensExact(96_499)).toBe("96,499");
	});
	it("leaves counts under 1000 unseparated", () => {
		expect(formatTokensExact(0)).toBe("0");
		expect(formatTokensExact(999)).toBe("999");
		expect(formatTokensExact(1_000)).toBe("1,000");
	});
});

describe("formatExactCostUsd", () => {
	it("renders two decimals at and above one cent", () => {
		expect(formatExactCostUsd(21.75)).toBe("$21.75");
		expect(formatExactCostUsd(0.01)).toBe("$0.01");
		expect(formatExactCostUsd(4.329)).toBe("$4.33");
	});
	it("renders four decimals for a sub-cent value instead of $0.00", () => {
		expect(formatExactCostUsd(0.0034)).toBe("$0.0034");
		expect(formatExactCostUsd(0.001)).toBe("$0.0010");
	});
	it("floors a positive value too small for four decimals to <$0.0001 instead of $0.0000", () => {
		expect(formatExactCostUsd(0.00003)).toBe("<$0.0001");
		expect(formatExactCostUsd(0.0000001)).toBe("<$0.0001");
		// The rounding boundary: 0.00005 rounds up to $0.0001, below it floors.
		expect(formatExactCostUsd(0.00005)).toBe("$0.0001");
	});
	it("renders $0.00 for exactly zero", () => {
		expect(formatExactCostUsd(0)).toBe("$0.00");
	});
});

describe("estimateConversationCostUsd", () => {
	it("prices each segment at its own rate when a breakdown is given", () => {
		const cost = estimateConversationCostUsd({ input: 1_000_000, output: 1_000_000, cached: 1_000_000 }, 3_000_000);
		expect(cost).toBeCloseTo(
			SONNET_INPUT_PER_TOKEN * 1e6 + SONNET_OUTPUT_PER_TOKEN * 1e6 + SONNET_CACHE_WRITE_PER_TOKEN * 1e6,
			6,
		);
		expect(cost).toBeCloseTo(3 + 15 + 3.75, 6);
	});
	it("falls back to the input rate on the total when no breakdown", () => {
		expect(estimateConversationCostUsd(undefined, 1_000_000)).toBeCloseTo(3, 6);
	});
});
