import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalPlanDirs, getClaudePlansDir } from "./PlanPaths.js";

describe("getClaudePlansDir", () => {
	it("defaults to the real home's ~/.claude/plans", () => {
		expect(getClaudePlansDir()).toBe(join(homedir(), ".claude", "plans"));
	});

	it("uses an explicit home when given (so callers stay testable)", () => {
		expect(getClaudePlansDir("/custom/home")).toBe(join("/custom/home", ".claude", "plans"));
	});
});

describe("canonicalPlanDirs", () => {
	it("defaults to the real home and contains the Claude plans dir", () => {
		expect(canonicalPlanDirs()).toEqual([getClaudePlansDir()]);
	});

	it("is a pure function of the given home", () => {
		expect(canonicalPlanDirs("/custom/home")).toEqual([join("/custom/home", ".claude", "plans")]);
	});
});
