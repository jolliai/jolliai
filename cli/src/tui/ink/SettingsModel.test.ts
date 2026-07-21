import { describe, expect, it } from "vitest";
import {
	ALL_CONFIG_ROWS,
	configRowsFor,
	csv,
	GLOBAL_INSTRUCTIONS_ROW,
	modelTier,
	nextInCycle,
	parseMaxTokens,
} from "./SettingsModel.js";

describe("csv", () => {
	it("splits, trims, and drops empty entries", () => {
		expect(csv("vendor, dist ,, node_modules")).toEqual(["vendor", "dist", "node_modules"]);
		expect(csv("")).toEqual([]);
		expect(csv("  ")).toEqual([]);
	});
});

describe("parseMaxTokens", () => {
	it("treats blank as unset (clears the cap)", () => {
		expect(parseMaxTokens("")).toBeUndefined();
		expect(parseMaxTokens("   ")).toBeUndefined();
	});

	it("accepts a positive integer", () => {
		expect(parseMaxTokens("8192")).toBe(8192);
		expect(parseMaxTokens(" 4096 ")).toBe(4096);
	});

	it("throws on non-integer, zero/negative, or trailing-garbage input", () => {
		// Number() (not parseInt) — "8192abc" must NOT sneak through as 8192.
		expect(() => parseMaxTokens("8192abc")).toThrow(/positive integer/);
		expect(() => parseMaxTokens("0")).toThrow(/positive integer/);
		expect(() => parseMaxTokens("-5")).toThrow(/positive integer/);
		expect(() => parseMaxTokens("1.5")).toThrow(/positive integer/);
	});
});

describe("nextInCycle", () => {
	it("advances and wraps around", () => {
		expect(nextInCycle(["a", "b", "c"], "a")).toBe("b");
		expect(nextInCycle(["a", "b", "c"], "c")).toBe("a");
	});

	it("falls back to the first value for an unrecognized current", () => {
		expect(nextInCycle(["a", "b"], "zzz")).toBe("a");
	});
});

describe("modelTier", () => {
	it("defaults an unset model to sonnet", () => {
		expect(modelTier(undefined)).toBe("sonnet");
		expect(modelTier("")).toBe("sonnet");
	});

	it("passes through a known tier alias unchanged", () => {
		expect(modelTier("haiku")).toBe("haiku");
		expect(modelTier("opus")).toBe("opus");
	});

	it("reverse-maps a pinned full model ID to its tier (no silent downgrade)", () => {
		// A user who ran `configure --set model=claude-sonnet-4-6` must cycle as
		// "sonnet", not snap to "haiku" on the first Space.
		expect(modelTier("claude-sonnet-4-6")).toBe("sonnet");
	});

	it("returns an unrecognized custom ID verbatim", () => {
		expect(modelTier("some-future-model")).toBe("some-future-model");
	});

	it("the Model row reads through modelTier so cycling never downgrades a pinned ID", () => {
		const modelRow = ALL_CONFIG_ROWS.find((r) => r.key === "model");
		expect(modelRow).toBeDefined();
		const current = modelRow?.read({ model: "claude-sonnet-4-6" } as never);
		expect(current).toBe("sonnet");
		// Space advances from the resolved tier: sonnet → opus, never → haiku.
		expect(nextInCycle(modelRow?.kind === "enum" ? modelRow.values : [], current ?? "")).toBe("opus");
	});
});

describe("configRowsFor", () => {
	it("returns config rows for the three config sub-views", () => {
		expect(configRowsFor("summary").map((r) => r.key)).toContain("aiProvider");
		expect(configRowsFor("memory").map((r) => r.key)).toContain("localFolder");
		expect(configRowsFor("others").map((r) => r.key)).toContain("excludePatterns");
	});

	it("returns no rows for host/skill/plugin sub-views", () => {
		expect(configRowsFor("agents")).toEqual([]);
		expect(configRowsFor("skills")).toEqual([]);
		expect(configRowsFor("plugins")).toEqual([]);
	});
});

describe("ALL_CONFIG_ROWS", () => {
	it("includes Global Instructions (edited from the agents tab) for key lookup", () => {
		expect(ALL_CONFIG_ROWS).toContain(GLOBAL_INSTRUCTIONS_ROW);
		expect(ALL_CONFIG_ROWS.filter((r) => r.key === "globalInstructions")).toHaveLength(1);
	});
});
