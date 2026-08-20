import { describe, expect, it } from "vitest";
import type { CommitSummary, SkillCommitRef, SkillSource } from "../Types.js";
import {
	buildLiveSkillsMarkdown,
	buildSkillsAggregateMarkdown,
	buildSkillsSummaryLabel,
	buildSkillsTable,
	type SkillTableRow,
	skillsAggregateFileName,
} from "./SkillsAggregateMarkdown.js";

const row = (over: Partial<SkillTableRow> = {}): SkillTableRow => ({
	skill: "superpowers:brainstorming",
	source: "claude",
	invocationCount: 2,
	usage: { input: 79, cached: 59796, output: 33944, confidence: "attributed" },
	...over,
});

describe("skillsAggregateFileName", () => {
	it("names the per-commit aggregate by short hash", () => {
		expect(skillsAggregateFileName("abc12345")).toBe("skills--abc12345.md");
	});
});

describe("buildSkillsTable", () => {
	it("renders one row per skill with count, total, and the three-way split", () => {
		// 79 + 59796 + 33944 = 93819
		expect(buildSkillsTable([row()])).toEqual([
			"| Skill | Agent | × | Tokens | Input | Output | Cached |",
			"|---|---|---|---|---|---|---|",
			"| superpowers:brainstorming | Claude Code | 2 | 93.8k | 79 | 33.9k | 59.8k |",
		]);
	});

	it("escapes a pipe in a skill id so the row keeps its column count", () => {
		// Skill ids arrive from transcripts written by other programs — the same
		// untrusted input sanitizeSkillIdForPath exists for. One unescaped `|` splits
		// the row into extra columns and misaligns every remaining cell against its
		// header, silently, with no malformed-file signal anywhere.
		const lines = buildSkillsTable([row({ skill: "weird|name" })]);
		expect(lines[2]).toBe("| weird\\|name | Claude Code | 2 | 93.8k | 79 | 33.9k | 59.8k |");
		// Seven cells, exactly as many as the header declares.
		expect(lines[2].split(/(?<!\\)\|/).filter((c) => c !== "")).toHaveLength(7);
	});

	it("escapes the backslash BEFORE the pipe, so a `\\|` id cannot smuggle a live pipe", () => {
		// Escaping only the pipe was incomplete in exactly one shape: `\|` became `\\|`,
		// which Markdown reads as an escaped backslash followed by a LIVE pipe — the
		// escape produced the very cell split it was added to prevent. Backslash-first
		// makes every pre-existing backslash inert before any pipe is escaped.
		const lines = buildSkillsTable([row({ skill: "weird\\|name" })]);
		expect(lines[2]).toBe("| weird\\\\\\|name | Claude Code | 2 | 93.8k | 79 | 33.9k | 59.8k |");
		// Still seven cells: no unescaped delimiter survived.
		expect(lines[2].split(/(?<!\\)\|/).filter((c) => c !== "")).toHaveLength(7);
	});

	it("leaves a lone backslash inert rather than escaping the character after it", () => {
		const lines = buildSkillsTable([row({ skill: "a\\b" })]);
		expect(lines[2]).toContain("| a\\\\b |");
	});

	it("collapses a newline in a skill id, which would otherwise end the table row", () => {
		// Worse than a pipe: a newline terminates the row outright, so every following
		// row is parsed as body text instead of table content.
		const lines = buildSkillsTable([row({ skill: "two\nlines" })]);
		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe("| two lines | Claude Code | 2 | 93.8k | 79 | 33.9k | 59.8k |");
	});

	it("shows an em dash, never a zero, in EVERY token cell when nothing could be attributed", () => {
		// Codex heuristics attribute no tokens. A rendered 0 would read as a
		// measurement of nothing rather than as an absence of measurement — and a row
		// that dashed only the total while zeroing the split would say exactly that
		// about the three components.
		const lines = buildSkillsTable([row({ usage: undefined })]);
		expect(lines[2]).toBe("| superpowers:brainstorming | Claude Code | 2 | — | — | — | — |");
		expect(lines[2]).not.toContain("0");
	});

	it("marks every component of an estimated figure with a tilde", () => {
		// The marker qualifies how the number was arrived at, not its magnitude, so
		// splitting the column must not leave three unqualified cells behind.
		const lines = buildSkillsTable([row({ usage: { input: 10, cached: 0, output: 90, confidence: "estimated" } })]);
		expect(lines[2]).toBe("| superpowers:brainstorming | Claude Code | 2 | ~100 | ~10 | ~90 | ~0 |");
	});

	it("orders heaviest first by TOTAL, then by name on a tie", () => {
		// The sort key is the total, which is why that column survived the split.
		const lines = buildSkillsTable([
			row({ skill: "b-light", usage: { input: 1, cached: 0, output: 1, confidence: "attributed" } }),
			row({ skill: "heavy" }),
			row({ skill: "a-light", usage: { input: 1, cached: 0, output: 1, confidence: "attributed" } }),
		]);
		expect(lines.slice(2)).toEqual([
			"| heavy | Claude Code | 2 | 93.8k | 79 | 33.9k | 59.8k |",
			"| a-light | Claude Code | 2 | 2 | 1 | 1 | 0 |",
			"| b-light | Claude Code | 2 | 2 | 1 | 1 | 0 |",
		]);
	});

	it("still orders by name when NO row has a total to sort by", () => {
		// Every unattributed row totals 0, so the name tie-break carries the whole
		// ordering — the common shape for a host that attributes nothing at all.
		const none = { usage: undefined };
		const lines = buildSkillsTable([
			row({ skill: "zebra", ...none }),
			row({ skill: "alpha", ...none }),
			row({ skill: "mango", ...none }),
		]);
		expect(lines.slice(2).map((l) => l.split(" | ")[0])).toEqual(["| alpha", "| mango", "| zebra"]);
	});

	it("keeps two rows that share a skill id instead of collapsing them", () => {
		// The renderer takes an array, not a map: an equal-name tie must stay a tie so
		// both rows reach the table and their counts stay distinguishable.
		const lines = buildSkillsTable([
			row({ skill: "same", invocationCount: 1, usage: undefined }),
			row({ skill: "same", invocationCount: 7, usage: undefined }),
		]);
		expect(lines.slice(2)).toEqual([
			"| same | Claude Code | 1 | — | — | — | — |",
			"| same | Claude Code | 7 | — | — | — | — |",
		]);
	});

	it("daggers an inferred row and spells the footnote out once", () => {
		const lines = buildSkillsTable([row({ detection: "heuristic", usage: undefined }), row()]);
		expect(lines).toContain("| superpowers:brainstorming † | Claude Code | 2 | — | — | — | — |");
		expect(lines.filter((l) => l.startsWith("†"))).toHaveLength(1);
	});

	it("omits the footnote entirely when every row was observed", () => {
		expect(buildSkillsTable([row()]).some((l) => l.includes("†"))).toBe(false);
	});

	it("names each host by its display label rather than its wire id", () => {
		// The column is read by a person, so it shows what `skillSourceLabel` shows
		// everywhere else — "Claude Code", not the `claude` the registry keys on.
		const lines = buildSkillsTable([
			row({ skill: "a", source: "claude", usage: undefined }),
			row({ skill: "b", source: "opencode", usage: undefined }),
			row({ skill: "c", source: "codex", usage: undefined }),
			row({ skill: "d", source: "cursor", usage: undefined }),
			row({ skill: "e", source: "kimi", usage: undefined }),
		]);
		expect(lines.slice(2).map((l) => l.split(" | ")[1])).toEqual([
			"Claude Code",
			"OpenCode",
			"Codex",
			"Cursor",
			"Kimi",
		]);
	});

	it("shows an em dash, never the string `undefined`, for a row with no source", () => {
		// Reachable from the untyped ide-bridge producer: `skillTableRows` casts the
		// caller's JSON to SkillTableRow without checking fields, so an older IntelliJ
		// sends rows with no source. Dashed for the same reason an unattributed token
		// figure is — an absent field is honest, and inventing a host would credit one
		// agent's work to another.
		const lines = buildSkillsTable([row({ source: undefined, usage: undefined })]);
		expect(lines[2]).toBe("| superpowers:brainstorming | — | 2 | — | — | — | — |");
		expect(lines[2]).not.toContain("undefined");
	});

	it("escapes a pipe smuggled in through an unknown source's fallback label", () => {
		// `skillSourceLabel` falls back to capitalising the RAW source string, which is
		// host-supplied transcript text — so the Agent cell needs the same escaping the
		// Skill cell has, or an unknown host can split the row.
		// Cast because SkillSource cannot express it — which is the point: this stands
		// for a host the union does not know, arriving through the untyped bridge.
		const lines = buildSkillsTable([row({ source: "we|ird" as SkillSource, usage: undefined })]);
		expect(lines[2]).toContain("| We\\|ird |");
		expect(lines[2].split(/(?<!\\)\|/).filter((c) => c !== "")).toHaveLength(7);
	});

	it("distinguishes the same skill run by two different hosts", () => {
		// The registry keys a row `<source>:<skill>`, so this is two legitimate rows,
		// not a duplicate. The input is deliberately reverse source order: equal-token,
		// equal-name rows must still render deterministically across callers that supply
		// their refs in different orders.
		const lines = buildSkillsTable([
			row({ skill: "jolli", source: "codex", usage: undefined }),
			row({ skill: "jolli", source: "claude", usage: undefined }),
		]);
		expect(lines.slice(2)).toEqual([
			"| jolli | Claude Code | 2 | — | — | — | — |",
			"| jolli | Codex | 2 | — | — | — | — |",
		]);
	});

	it("renders a header-only table for an empty set", () => {
		expect(buildSkillsTable([])).toEqual([
			"| Skill | Agent | × | Tokens | Input | Output | Cached |",
			"|---|---|---|---|---|---|---|",
		]);
	});
});

describe("buildSkillsSummaryLabel", () => {
	it("counts the skills and sums their tokens", () => {
		// 2 × 93819 = 187638
		expect(buildSkillsSummaryLabel([row(), row({ skill: "other" })])).toBe("2 skills · 187.6k tokens");
	});

	it("singularises a lone skill", () => {
		expect(buildSkillsSummaryLabel([row()])).toBe("1 skill · 93.8k tokens");
	});

	it("marks the SUM as an estimate when any single member is estimated", () => {
		// The marker qualifies the whole figure — dropping it because the other members
		// were measured would present a partly-guessed total as measured.
		const label = buildSkillsSummaryLabel([
			row({ usage: { input: 1, cached: 0, output: 0, confidence: "attributed" } }),
			row({ skill: "other", usage: { input: 2, cached: 0, output: 0, confidence: "estimated" } }),
		]);
		expect(label).toBe("2 skills · ~3 tokens");
	});

	it("shows only the count when nothing could be attributed", () => {
		// A rendered 0 would read as a measurement of nothing rather than as an absence
		// of measurement, which is what a heuristic source actually reports.
		expect(buildSkillsSummaryLabel([row({ usage: undefined })])).toBe("1 skill");
	});

	it("still totals the members that DID attribute when one member did not", () => {
		expect(buildSkillsSummaryLabel([row(), row({ skill: "other", usage: undefined })])).toBe(
			"2 skills · 93.8k tokens",
		);
	});
});

describe("buildSkillsAggregateMarkdown", () => {
	const summary = {
		commitHash: "abc12345def",
		branch: "feature/x",
		generatedAt: "2026-07-30T07:00:00.000Z",
		commitMessage: "Add the thing",
	} as CommitSummary;

	it("carries the commit's identity in frontmatter and title", () => {
		const md = buildSkillsAggregateMarkdown(summary, []);
		expect(md).toContain("type: skill-usage");
		expect(md).toContain("commitHash: abc12345def");
		expect(md).toContain("branch: feature/x");
		expect(md).toContain("# Skills used — abc12345");
		expect(md).toContain("_Add the thing_");
	});

	it("shares its table with the live view, byte for byte", () => {
		// The sidebar row opens the live variant before a commit and this file after
		// one. A table that changed shape at commit time would make the user re-read a
		// surface they had already learned. Typed as the ARCHIVED snapshot here and fed
		// to the live renderer too — both are structurally SkillTableRow, which is the
		// whole point of the narrow parameter.
		const archived = (over: Partial<SkillCommitRef> = {}): SkillCommitRef => ({
			archivedKey: "claude:superpowers:brainstorming-abc12345",
			source: "claude",
			skill: "superpowers:brainstorming",
			entryPaths: ["tool"],
			invocationCount: 2,
			firstUsedAt: "2026-07-30T06:00:00.000Z",
			lastUsedAt: "2026-07-30T07:00:00.000Z",
			usage: { input: 79, cached: 59796, output: 33944, confidence: "attributed" },
			...over,
		});
		const skills = [archived(), archived({ skill: "other", detection: "heuristic", usage: undefined })];
		const table = buildSkillsTable(skills).join("\n");
		expect(buildSkillsAggregateMarkdown(summary, skills)).toContain(table);
		expect(buildLiveSkillsMarkdown(skills)).toContain(table);
	});
});

describe("buildLiveSkillsMarkdown", () => {
	it("says the work is uncommitted and claims no commit identity", () => {
		// There is no hash yet: this renders the working registry, not a stored
		// artifact. Inventing frontmatter here would make an untitled buffer look like
		// a committed record.
		const md = buildLiveSkillsMarkdown([row()]);
		expect(md).toContain("# Skills used — uncommitted");
		expect(md).toContain("Archived onto the memory when you commit.");
		expect(md).not.toContain("commitHash:");
		expect(md.startsWith("---")).toBe(false);
	});

	it("renders the rows it was given", () => {
		expect(buildLiveSkillsMarkdown([row()])).toContain(
			"| superpowers:brainstorming | Claude Code | 2 | 93.8k | 79 | 33.9k | 59.8k |",
		);
	});
});
