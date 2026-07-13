import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "../Types.js";
import type { LlmCallResult } from "./LlmClient.js";

vi.mock("./LlmClient.js", () => ({ callLlm: vi.fn() }));
vi.mock("./GitOps.js", () => ({ execGit: vi.fn(), getDiffContent: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

import { readFile } from "node:fs/promises";
import {
	assessContextRelevance,
	buildChangeBlock,
	buildChangeSignal,
	buildDecisionFromAiRelevance,
	buildItemsBlock,
	type ContextItem,
	computeChangeFingerprint,
	extractCandidateRepr,
	extractSymbols,
	keptContextRelevanceRefs,
	parseRankContextResponse,
	rankContextRelevance,
	stripFrontmatter,
} from "./ContextRelevance.js";
import { execGit, getDiffContent } from "./GitOps.js";
import { callLlm } from "./LlmClient.js";

const mockCallLlm = vi.mocked(callLlm);
const mockExecGit = vi.mocked(execGit);
const mockGetDiff = vi.mocked(getDiffContent);
const mockReadFile = vi.mocked(readFile);

const config = { apiKey: "sk-ant-test" } as LlmConfig;

function llmText(text: string): LlmCallResult {
	return {
		text,
		inputTokens: 0,
		outputTokens: 0,
		cachedTokens: 0,
		apiLatencyMs: 0,
		source: "direct",
	} as unknown as LlmCallResult;
}

function item(kind: ContextItem["kind"], id: string, title: string, content: string): ContextItem {
	return { kind, id, title, content };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("stripFrontmatter", () => {
	it("removes a leading YAML frontmatter block", () => {
		expect(stripFrontmatter('---\ntitle: "x"\n---\nBody here')).toBe("Body here");
	});
	it("leaves content without frontmatter untouched", () => {
		expect(stripFrontmatter("No frontmatter\nline two")).toBe("No frontmatter\nline two");
	});
});

describe("extractSymbols", () => {
	it("extracts declared symbols from added lines only, deduped", () => {
		const diff = [
			"+++ b/x.ts",
			"+export function doThing() {}",
			"-function removed() {}",
			" const ctx = 1;",
			"+class Foo {}",
			"+function doThing() {}",
		].join("\n");
		expect(extractSymbols(diff)).toEqual(["doThing", "Foo"]);
	});
	it("respects the max cap", () => {
		const diff = Array.from({ length: 10 }, (_, i) => `+const v${i} = ${i};`).join("\n");
		expect(extractSymbols(diff, 3)).toHaveLength(3);
	});
});

describe("extractCandidateRepr", () => {
	it("returns small plan/note content whole", () => {
		const repr = extractCandidateRepr(item("note", "n1", "Note", "short body"));
		expect(repr).toBe("short body");
	});
	it("strips frontmatter for references", () => {
		const ref = item("reference", "linear:X-1", "X-1", '---\nsource: "linear"\n---\n## Problem\nfoo');
		expect(extractCandidateRepr(ref)).toBe("## Problem\nfoo");
	});
	it("skeletonizes large documents with meta/title/sections/files, fence-aware", () => {
		const big = [
			"Intro paragraph describing the plan goal.",
			"",
			"## Section One",
			"First sentence of one. More text.",
			"```ts",
			"## not-a-heading-inside-fence",
			"const inFence = require('./ignored.ts');",
			"```",
			"## Section Two",
			"Touches src/core/Real.ts here.",
			"x".repeat(7000),
		].join("\n");
		const repr = extractCandidateRepr(item("plan", "p1", "Big Plan", big));
		expect(repr).toContain("mechanical skeleton");
		expect(repr).toContain("Title: Big Plan");
		expect(repr).toContain("Section One");
		expect(repr).toContain("Section Two");
		// fence contents excluded from headings and file paths
		expect(repr).not.toContain("not-a-heading-inside-fence");
		expect(repr).not.toContain("ignored.ts");
		expect(repr).toContain("src/core/Real.ts");
	});
});

describe("buildItemsBlock", () => {
	it("assigns 1-based index and maps back to ids", () => {
		const { block, indexToId, dropped } = buildItemsBlock([
			item("plan", "p1", "A", "aa"),
			item("note", "n1", "B", "bb"),
		]);
		expect(block).toContain("[1] (plan) A");
		expect(block).toContain("[2] (note) B");
		expect(indexToId.get(1)).toBe("p1");
		expect(indexToId.get(2)).toBe("n1");
		expect(dropped).toBe(0);
	});
	it("drops tail items beyond the total budget", () => {
		const items = [item("note", "n1", "First", "x".repeat(50)), item("note", "n2", "Second", "y".repeat(50))];
		const { indexToId, dropped } = buildItemsBlock(items, 60);
		expect(indexToId.size).toBe(1);
		expect(dropped).toBe(1);
	});
});

describe("buildChangeBlock", () => {
	it("renders message, files, and symbols", () => {
		const block = buildChangeBlock({ commitMessage: "Fix X", changedFiles: ["a/b.ts"], symbols: ["doThing"] });
		expect(block).toContain("Commit message: Fix X");
		expect(block).toContain("a/b.ts");
		expect(block).toContain("doThing");
	});
	it("handles empty message/files/symbols", () => {
		expect(buildChangeBlock({ commitMessage: "", changedFiles: [], symbols: [] })).toBe("Commit message: (none)");
	});
});

describe("parseRankContextResponse", () => {
	it("parses well-formed item blocks (index + tier + reason)", () => {
		const text = [
			"===ITEM===",
			"index: 1",
			"tier: high",
			"reason: overlaps graph",
			"===ITEM===",
			"index: 2",
			"tier: low",
			"reason: unrelated",
		].join("\n");
		const parsed = parseRankContextResponse(text);
		expect(parsed).toEqual([
			{ index: 1, tier: "high", reason: "overlaps graph" },
			{ index: 2, tier: "low", reason: "unrelated" },
		]);
	});
	it("skips blocks with no parseable index and defaults a missing tier to mid", () => {
		const text = ["===ITEM===", "tier: high", "===ITEM===", "index: 3"].join("\n");
		const parsed = parseRankContextResponse(text);
		expect(parsed).toEqual([{ index: 3, tier: "mid", reason: "" }]);
	});
	it("normalizes tier tokens (high/low prefixes kept; med / medium / unknown → mid)", () => {
		const mk = (t: string) =>
			parseRankContextResponse(["===ITEM===", "index: 1", `tier: ${t}`, "reason: x"].join("\n"))[0].tier;
		expect(mk("HIGH")).toBe("high");
		expect(mk("Low")).toBe("low");
		expect(mk("med")).toBe("mid");
		expect(mk("medium")).toBe("mid");
		expect(mk("banana")).toBe("mid");
		// Defensive: if the model slips into the old free-text "not relevant"
		// vocabulary, it maps to low (the soft-exclude tier), not a kept "mid".
		expect(mk("none")).toBe("low");
		expect(mk("not relevant")).toBe("low");
		expect(mk("unrelated")).toBe("low");
	});
});

describe("rankContextRelevance", () => {
	it("returns [] for no items", async () => {
		expect(
			await rankContextRelevance({ commitMessage: "m", changedFiles: [], symbols: [] }, [], { config }),
		).toEqual([]);
	});

	it("ranks by score desc with tier and autoExclude", async () => {
		mockCallLlm.mockResolvedValue(
			llmText(
				[
					"===ITEM===",
					"index: 1",
					"tier: low",
					"reason: unrelated",
					"===ITEM===",
					"index: 2",
					"tier: high",
					"reason: direct hit",
				].join("\n"),
			),
		);
		const items = [item("plan", "p1", "Low", "aa"), item("note", "n1", "High", "bb")];
		const res = await rankContextRelevance({ commitMessage: "m", changedFiles: [], symbols: [] }, items, {
			config,
		});
		expect(res[0]).toMatchObject({ id: "n1", rank: 1, tier: "high", relevant: true });
		expect(res[1]).toMatchObject({ id: "p1", rank: 2, tier: "low", autoExclude: true });
	});

	it("conservatively keeps items the LLM omitted", async () => {
		mockCallLlm.mockResolvedValue(llmText(["===ITEM===", "index: 1", "tier: high", "reason: x"].join("\n")));
		const items = [item("plan", "p1", "Has", "aa"), item("note", "n1", "Omitted", "bb")];
		const res = await rankContextRelevance({ commitMessage: "m", changedFiles: [], symbols: [] }, items, {
			config,
		});
		const omitted = res.find((r) => r.id === "n1");
		expect(omitted?.relevant).toBe(true);
		expect(omitted?.autoExclude).toBe(false);
	});

	it("fails open (keeps all) when the LLM call throws", async () => {
		mockCallLlm.mockRejectedValue(new Error("boom"));
		const items = [item("plan", "p1", "A", "aa"), item("note", "n1", "B", "bb")];
		const res = await rankContextRelevance({ commitMessage: "m", changedFiles: [], symbols: [] }, items, {
			config,
		});
		expect(res).toHaveLength(2);
		expect(res.every((r) => r.relevant && !r.autoExclude)).toBe(true);
		// fail-open keeps everything at neutral "mid" — never a fabricated "high"
		// (which the live overlay would render as a green High chip on all items).
		expect(res.every((r) => r.tier === "mid")).toBe(true);
		expect(res.map((r) => r.id)).toEqual(["p1", "n1"]);
	});
});

describe("buildChangeSignal", () => {
	it("collects changed files and symbols", async () => {
		mockExecGit.mockResolvedValue({ stdout: "cli/src/a.ts\ncli/src/b.ts", stderr: "", exitCode: 0 });
		mockGetDiff.mockResolvedValue("+export function newFn() {}");
		const sig = await buildChangeSignal("Fix a", "HEAD~1", "HEAD", "/repo");
		expect(sig.changedFiles).toEqual(["cli/src/a.ts", "cli/src/b.ts"]);
		expect(sig.symbols).toContain("newFn");
		expect(sig.commitMessage).toBe("Fix a");
	});
	it("leaves fields empty when git fails", async () => {
		mockExecGit.mockResolvedValue({ stdout: "", stderr: "bad", exitCode: 1 });
		mockGetDiff.mockRejectedValue(new Error("no diff"));
		const sig = await buildChangeSignal("m", "a", "b", "/repo");
		expect(sig.changedFiles).toEqual([]);
		expect(sig.symbols).toEqual([]);
	});
});

describe("review-fix regressions", () => {
	it("uses the model's tier directly (high/mid/low), ordering high → low", async () => {
		mockCallLlm.mockResolvedValue(
			llmText(
				[
					"===ITEM===",
					"index: 1",
					"tier: mid",
					"reason: a",
					"===ITEM===",
					"index: 2",
					"tier: high",
					"reason: b",
					"===ITEM===",
					"index: 3",
					"tier: low",
					"reason: c",
				].join("\n"),
			),
		);
		const items = [
			item("plan", "p1", "A", "x"),
			item("note", "n1", "B", "y"),
			item("reference", "linear:R", "C", "z"),
		];
		const res = await rankContextRelevance({ commitMessage: "m", changedFiles: [], symbols: [] }, items, {
			config,
		});
		// Ordered by tier (high → mid → low), not input order.
		expect(res.map((r) => r.id)).toEqual(["n1", "p1", "linear:R"]);
		expect(res.map((r) => r.tier)).toEqual(["high", "mid", "low"]);
		// "low" is the soft-exclude tier; high/mid are kept.
		expect(res.map((r) => r.autoExclude)).toEqual([false, false, true]);
		expect(res.find((r) => r.id === "linear:R")?.relevant).toBe(false);
	});

	it("all-unrelated context: every item is low → every item auto-excludes (no fabricated High)", async () => {
		// The reported bug: several plans that merely share foundational files with
		// the change are all unrelated. The model now returns "low" for each, and
		// "low" is the soft-exclude tier — so positional tiering no longer fabricates
		// a High out of the least-unrelated one.
		mockCallLlm.mockResolvedValue(
			llmText(
				[
					"===ITEM===",
					"index: 1",
					"tier: low",
					"reason: only shares a CSS file",
					"===ITEM===",
					"index: 2",
					"tier: low",
					"reason: different feature",
					"===ITEM===",
					"index: 3",
					"tier: low",
					"reason: unrelated bug",
				].join("\n"),
			),
		);
		const items = [
			item("plan", "p1", "A", "x"),
			item("note", "n1", "B", "y"),
			item("reference", "linear:R", "C", "z"),
		];
		const res = await rankContextRelevance({ commitMessage: "m", changedFiles: [], symbols: [] }, items, {
			config,
		});
		expect(res.map((r) => r.tier)).toEqual(["low", "low", "low"]);
		expect(res.every((r) => r.autoExclude)).toBe(true);
	});

	it("captures the lead paragraph as Overview even when a title is present", () => {
		const big = ["Lead prose about the goal.", "", "## S1", "body", "z".repeat(7000)].join("\n");
		const repr = extractCandidateRepr(item("note", "n1", "Titled Note", big));
		expect(repr).toContain("Overview: Lead prose about the goal.");
	});

	it("does not close a ``` fence on a ~~~ line inside it", () => {
		const big = [
			"## Real",
			"text.",
			"```",
			"~~~",
			"## fake-in-fence",
			"```",
			"## After",
			`more. ${"q".repeat(7000)}`,
		].join("\n");
		const repr = extractCandidateRepr(item("plan", "p1", "P", big));
		expect(repr).not.toContain("fake-in-fence");
		expect(repr).toContain("After");
	});

	it("skeletonizes a large reference no larger than the reference whole-cap", () => {
		const big = `---\nsource: linear\n---\n## H\n${"z".repeat(8000)}`;
		const repr = extractCandidateRepr(item("reference", "linear:R", "R", big));
		expect(repr.length).toBeLessThanOrEqual(4000 + 16);
	});
	it("defaults an item with no tier field to mid (conservative keep, not excluded)", () => {
		const p = parseRankContextResponse(["===ITEM===", "index: 1", "reason: x"].join("\n"));
		expect(p[0].tier).toBe("mid");
	});
});

describe("assessContextRelevance", () => {
	function planEntry(slug: string, title: string) {
		return { slug, title, sourcePath: `/x/${slug}.md`, addedAt: "", updatedAt: "", commitHash: null } as never;
	}
	const twoPlans = () => ({ plans: [planEntry("p1", "P1"), planEntry("p2", "P2")], notes: [], references: [] });
	const rankTwo = () =>
		llmText(
			[
				"===ITEM===",
				"index: 1",
				"tier: high",
				"reason: hit",
				"===ITEM===",
				"index: 2",
				"tier: low",
				"reason: unrelated",
			].join("\n"),
		);
	beforeEach(() => {
		mockReadFile.mockResolvedValue("some content");
	});

	it("soft-excludes the bottom-ranked not-relevant item into excludedContext", async () => {
		mockCallLlm.mockResolvedValue(rankTwo());
		const decision = await assessContextRelevance(
			twoPlans(),
			{ commitMessage: "m", changedFiles: ["a.ts"], symbols: [] },
			config,
		);
		expect(decision.plans.map((p) => p.slug)).toEqual(["p1"]);
		expect(decision.excludedContext).toEqual([
			{ kind: "plan", key: "p2", title: "P2", reason: "unrelated", tier: "low" },
		]);
	});

	it("falls back to title content when the source file is unreadable", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		mockCallLlm.mockResolvedValue(llmText(["===ITEM===", "index: 1", "tier: high", "reason: x"].join("\n")));
		const decision = await assessContextRelevance(
			{ plans: [planEntry("p1", "P1")], notes: [], references: [] },
			{ commitMessage: "m", changedFiles: ["a.ts"], symbols: [] },
			config,
		);
		expect(decision.plans).toHaveLength(1);
	});

	it("returns raw entries and empty results when there are no items", async () => {
		const decision = await assessContextRelevance(
			{ plans: [], notes: [], references: [] },
			{ commitMessage: "m", changedFiles: [], symbols: [] },
			config,
		);
		expect(decision.results).toEqual([]);
		expect(decision.excludedContext).toEqual([]);
	});

	it("ranks notes and references too: kept ones land in their kind arrays with full results", async () => {
		mockCallLlm.mockResolvedValue(
			llmText(
				[
					"===ITEM===",
					"index: 1",
					"tier: high",
					"reason: note matches",
					"===ITEM===",
					"index: 2",
					"tier: high",
					"reason: ref matches",
				].join("\n"),
			),
		);
		const note = {
			id: "n1",
			title: "N1",
			format: "markdown",
			sourcePath: "/x/n1.md",
			addedAt: "",
			updatedAt: "",
			commitHash: null,
		} as never;
		const ref = { source: "linear", nativeId: "X-1", title: "Ref", sourcePath: "/x/r.md" } as never;
		const decision = await assessContextRelevance(
			{ plans: [], notes: [note], references: [ref] },
			{ commitMessage: "m", changedFiles: ["a.ts"], symbols: [] },
			config,
		);
		expect(decision.notes).toEqual([note]);
		expect(decision.references).toEqual([ref]);
		expect(decision.results.map((r) => `${r.kind}:${r.id}`)).toEqual(["note:n1", "reference:linear:X-1"]);
	});

	it("soft-excludes a bottom-ranked note into excludedContext with its note title", async () => {
		mockCallLlm.mockResolvedValue(rankTwo());
		const note = {
			id: "n1",
			title: "N1",
			format: "markdown",
			sourcePath: "/x/n1.md",
			addedAt: "",
			updatedAt: "",
			commitHash: null,
		} as never;
		const decision = await assessContextRelevance(
			{ plans: [planEntry("p1", "P1")], notes: [note], references: [] },
			{ commitMessage: "m", changedFiles: ["a.ts"], symbols: [] },
			config,
		);
		expect(decision.notes).toEqual([]);
		expect(decision.excludedContext).toEqual([
			{ kind: "note", key: "n1", title: "N1", reason: "unrelated", tier: "low" },
		]);
	});

	it("soft-excludes a bottom-ranked reference with the nativeId-lead audit title", async () => {
		mockCallLlm.mockResolvedValue(rankTwo());
		const ref = { source: "linear", nativeId: "X-1", title: "Ref", sourcePath: "/x/r.md" } as never;
		const decision = await assessContextRelevance(
			{ plans: [planEntry("p1", "P1")], notes: [], references: [ref] },
			{ commitMessage: "m", changedFiles: ["a.ts"], symbols: [] },
			config,
		);
		expect(decision.references).toEqual([]);
		expect(decision.excludedContext).toEqual([
			// The reference's audit title carries the nativeId lead (sidebar label parity).
			{ kind: "reference", key: "linear:X-1", title: "X-1 — Ref", reason: "unrelated", tier: "low" },
		]);
	});
});

describe("computeChangeFingerprint", () => {
	it("is stable regardless of changed-file order", () => {
		expect(computeChangeFingerprint({ commitMessage: "m", changedFiles: ["a.ts", "b.ts"], symbols: [] })).toBe(
			computeChangeFingerprint({ commitMessage: "m", changedFiles: ["b.ts", "a.ts"], symbols: [] }),
		);
	});
	it("ignores the commit message (panel has none pre-commit) and keys only on files", () => {
		// Same files, different message → same fingerprint (so panel↔worker match).
		expect(computeChangeFingerprint({ commitMessage: "m1", changedFiles: ["a.ts"], symbols: [] })).toBe(
			computeChangeFingerprint({ commitMessage: "m2", changedFiles: ["a.ts"], symbols: [] }),
		);
		// Different files → different fingerprint.
		expect(computeChangeFingerprint({ commitMessage: "m", changedFiles: ["a.ts"], symbols: [] })).not.toBe(
			computeChangeFingerprint({ commitMessage: "m", changedFiles: ["b.ts"], symbols: [] }),
		);
	});
});

describe("buildDecisionFromAiRelevance (worker reuse of the panel ranking)", () => {
	const pe = (slug: string, title: string) =>
		({ slug, title, sourcePath: "", addedAt: "", updatedAt: "", commitHash: null }) as never;
	const ne = (id: string, title: string) =>
		({ id, title, format: "markdown", addedAt: "", updatedAt: "", commitHash: null }) as never;

	it("routes items by the entries' exclude decision, keeping registry order", () => {
		const raw = { plans: [pe("p1", "P1"), pe("p2", "P2")], notes: [], references: [] };
		const decision = buildDecisionFromAiRelevance(raw, [
			{ kind: "plans", key: "p1", tier: "high", reason: "direct hit", excluded: false },
			{ kind: "plans", key: "p2", tier: "low", reason: "unrelated", excluded: true },
		]);
		expect(decision.plans.map((p) => p.slug)).toEqual(["p1"]);
		expect(decision.excludedContext).toEqual([
			{ kind: "plan", key: "p2", title: "P2", reason: "unrelated", tier: "low" },
		]);
		expect(decision.results).toEqual([
			{
				id: "p1",
				kind: "plan",
				relevant: true,
				score: 0,
				tier: "high",
				reason: "direct hit",
				rank: 1,
				autoExclude: false,
			},
			{
				id: "p2",
				kind: "plan",
				relevant: false,
				score: 0,
				tier: "low",
				reason: "unrelated",
				rank: 2,
				autoExclude: true,
			},
		]);
	});

	it("a dismissed exclusion lands KEPT with its ORIGINAL tier + reason (user veto, verdict preserved)", () => {
		const raw = { plans: [], notes: [ne("n1", "N1")], references: [] };
		const decision = buildDecisionFromAiRelevance(raw, [
			{ kind: "notes", key: "n1", tier: "low", reason: "different subsystem", excluded: true, dismissed: true },
		]);
		// Not excluded (the veto wins) …
		expect(decision.notes).toHaveLength(1);
		expect(decision.excludedContext).toEqual([]);
		// … and the AI's original verdict rides along, so the summary shows
		// "Low · different subsystem" on the kept item (nothing is lost).
		expect(decision.results).toEqual([
			{
				id: "n1",
				kind: "note",
				relevant: true,
				score: 0,
				tier: "low",
				reason: "different subsystem",
				rank: 1,
				autoExclude: false,
			},
		]);
		expect(keptContextRelevanceRefs(decision)).toEqual([
			{ kind: "note", key: "n1", tier: "low", reason: "different subsystem" },
		]);
	});

	it("items with no persisted entry are kept plain (no result entry)", () => {
		const raw = { plans: [pe("p1", "P1")], notes: [], references: [] };
		const decision = buildDecisionFromAiRelevance(raw, []);
		expect(decision.plans).toHaveLength(1);
		expect(decision.excludedContext).toEqual([]);
		expect(decision.results).toEqual([]);
	});

	it("prefixes a reference's excludedContext title with the nativeId (matches the sidebar label)", () => {
		const ref = {
			source: "linear",
			nativeId: "JOLLI-776",
			title: "JolliMemory: array-based",
			sourcePath: "",
		} as never;
		const raw = { plans: [], notes: [], references: [ref] };
		const decision = buildDecisionFromAiRelevance(raw, [
			{ kind: "references", key: "linear:JOLLI-776", tier: "low", reason: "unrelated", excluded: true },
		]);
		expect(decision.excludedContext).toEqual([
			{
				kind: "reference",
				key: "linear:JOLLI-776",
				title: "JOLLI-776 — JolliMemory: array-based",
				reason: "unrelated",
				tier: "low",
			},
		]);
		expect(decision.references).toEqual([]);
	});

	it("keptContextRelevanceRefs projects kept results only and drops empty-reason entries", () => {
		const raw = { plans: [pe("p1", "P1"), pe("p2", "P2")], notes: [ne("n1", "N1")], references: [] };
		const decision = buildDecisionFromAiRelevance(raw, [
			{ kind: "plans", key: "p1", tier: "high", reason: "direct hit", excluded: false },
			{ kind: "plans", key: "p2", tier: "low", reason: "unrelated", excluded: true },
			// Fabricated fail-open shape (empty reason) must not reach the artifact.
			{ kind: "notes", key: "n1", tier: "high", reason: "", excluded: false },
		]);
		expect(keptContextRelevanceRefs(decision)).toEqual([
			{ kind: "plan", key: "p1", tier: "high", reason: "direct hit" },
		]);
	});
});
