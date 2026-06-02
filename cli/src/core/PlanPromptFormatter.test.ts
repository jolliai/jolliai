import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readFile: mockReadFile };
});

import type { PlanEntry } from "../Types.js";
import { formatPlansBlock } from "./PlanPromptFormatter.js";

function makePlan(overrides: Partial<PlanEntry> = {}): PlanEntry {
	return {
		slug: "my-plan",
		title: "My Plan",
		sourcePath: "/abs/path/my-plan.md",
		addedAt: "2026-05-13T00:00:00Z",
		updatedAt: "2026-05-14T00:00:00Z",
		branch: "main",
		commitHash: null,
		...overrides,
	};
}

beforeEach(() => {
	mockReadFile.mockReset();
});

describe("formatPlansBlock", () => {
	it("returns empty string when no plans", async () => {
		expect(await formatPlansBlock([])).toBe("");
	});

	it("renders one plan with title, updated-at, and content", async () => {
		mockReadFile.mockResolvedValue("# My Plan\n\nGoal: foo");
		const out = await formatPlansBlock([makePlan()]);
		expect(out).toContain("<plans>");
		expect(out).toContain("</plans>");
		expect(out).toContain('slug="my-plan"');
		expect(out).toContain("<title>My Plan</title>");
		expect(out).toContain("<content>");
		expect(out).toContain("Goal: foo");
	});

	it("escapes XML-special characters in slug, title, and body", async () => {
		mockReadFile.mockResolvedValue("body has <script>alert(1)</script>");
		const out = await formatPlansBlock([makePlan({ slug: 'with "quote"', title: "Title <tag>" })]);
		expect(out).toContain("with &quot;quote&quot;");
		expect(out).toContain("Title &lt;tag&gt;");
		expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	it("preserves SUMMARIZE sentinels in body verbatim (escape does not transform =)", async () => {
		mockReadFile.mockResolvedValue("# Discussion\n\nReferenced ===SUMMARY=== explicitly.");
		const out = await formatPlansBlock([makePlan()]);
		expect(out).toContain("===SUMMARY===");
	});

	it("truncates per-plan body when over maxCharsPerPlan", async () => {
		const big = "x".repeat(50000);
		mockReadFile.mockResolvedValue(big);
		const out = await formatPlansBlock([makePlan()], { maxCharsPerPlan: 1000 });
		expect(out).toContain("…[truncated,");
		expect(out.length).toBeLessThan(big.length);
	});

	it("drops oldest plans when maxTotalChars exceeded", async () => {
		const plans = [
			makePlan({ slug: "old", updatedAt: "2026-05-14T01:00:00Z" }),
			makePlan({ slug: "mid", updatedAt: "2026-05-14T02:00:00Z" }),
			makePlan({ slug: "new", updatedAt: "2026-05-14T03:00:00Z" }),
		];
		mockReadFile.mockImplementation(async () => "y".repeat(2500));
		const out = await formatPlansBlock(plans, { maxCharsPerPlan: 3000, maxTotalChars: 6000 });
		expect(out).toContain('slug="new"');
		expect(out).not.toContain('slug="old"');
	});

	it("returns empty when total budget cannot fit even a single plan", async () => {
		mockReadFile.mockResolvedValue("x".repeat(5000));
		const out = await formatPlansBlock([makePlan()], { maxCharsPerPlan: 100, maxTotalChars: 50 });
		expect(out).toBe("");
	});

	it("omits <content> when the body is empty (unreadable file)", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		const out = await formatPlansBlock([makePlan()]);
		expect(out).toContain('slug="my-plan"');
		expect(out).not.toContain("<content>");
	});
});
