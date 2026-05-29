import { describe, expect, it } from "vitest";
import { formatIssues } from "./SiteJsonFormatter.js";
import type { ValidationIssueLocated } from "./SiteJsonValidator.js";
import { locateIssues, validateSiteJsonShape } from "./SiteJsonValidator.js";

/**
 * Strips ANSI escape sequences so assertions about output text aren't
 * tangled with the color codes. Used to verify content while letting
 * dedicated tests assert the color codes themselves.
 */
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeIssue(overrides: Partial<ValidationIssueLocated> = {}): ValidationIssueLocated {
	return {
		severity: "error",
		code: "synthetic",
		path: [],
		message: "synthetic message",
		line: 2,
		column: 3,
		endLine: 2,
		endColumn: 10,
		...overrides,
	};
}

describe("formatIssues — empty + dispatching", () => {
	it("returns empty string when there are no issues", () => {
		expect(formatIssues("anything", [])).toBe("");
		expect(formatIssues("", [], { format: "github" })).toBe("");
	});

	it("defaults to human format", () => {
		const out = formatIssues("{}\n", [makeIssue({ line: 1, column: 1, endLine: 1, endColumn: 3 })]);
		// Human format has the header / code-frame shape; github format is
		// a single `::error ...` line. Confirm by inspecting markers.
		expect(out).toMatch(/^site\.json:1:1 —/);
		expect(out).toContain(" | ");
	});

	it("uses the provided filename in the header", () => {
		const out = formatIssues("{}\n", [makeIssue({ line: 1, column: 1, endLine: 1, endColumn: 3 })], {
			filename: "configs/site.json",
		});
		expect(out.startsWith("configs/site.json:1:1")).toBe(true);
	});
});

describe("formatIssues — human format layout", () => {
	const sample = `{
  "title": "Acme",
  "navigation": [
    { "article": "Bad" }
  ]
}
`;

	it("includes header, message, code-frame, and (optional) hint sections", () => {
		const issues = locateIssues(sample, validateSiteJsonShape(JSON.parse(sample)));
		const out = formatIssues(sample, issues);
		const plain = stripAnsi(out);

		// Header: filename:line:col — severity[code]
		expect(plain).toMatch(/site\.json:4:5 — error\[article-without-href\]/);
		// Message included
		expect(plain).toContain("Article is missing a required `href`");
		// Code frame includes the surrounding lines with line numbers.
		// Pattern: `<n> | <content>` with one space after `|` plus the
		// content's own JSON indentation (2 spaces for line 3, 4 spaces
		// for line 4).
		expect(plain).toMatch(/3 \| {3}"navigation": \[/);
		expect(plain).toMatch(/> 4 \| {5}\{ "article": "Bad" \}/);
		// Pointer line uses ^ characters
		expect(plain).toContain("^");
		// Hint section
		expect(plain).toContain("hint:");
	});

	it("does not under-reach when the issue is on line 1", () => {
		const text = `["not an object"]`;
		const issues = locateIssues(text, validateSiteJsonShape(JSON.parse(text)));
		const out = formatIssues(text, issues);
		const plain = stripAnsi(out);
		// Should include line 1 and not crash; no "line 0" or "line -1".
		expect(plain).toMatch(/1 \|/);
		expect(plain).not.toMatch(/-1|0 \|/);
	});

	it("does not over-reach when the issue is near the end of the file", () => {
		const text = `{\n  "title": "x"\n}`;
		const out = formatIssues(text, [makeIssue({ line: 3, column: 1, endLine: 3, endColumn: 2 })]);
		const plain = stripAnsi(out);
		// File has 3 lines — frame should stop at line 3.
		expect(plain).not.toMatch(/4 \|/);
	});

	it("renders multiple issues separated by a blank line", () => {
		const text = `{}\n`;
		const out = formatIssues(text, [
			makeIssue({ line: 1, column: 1, endLine: 1, endColumn: 2, message: "first" }),
			makeIssue({ line: 1, column: 1, endLine: 1, endColumn: 2, message: "second" }),
		]);
		// Two blocks, separated by a blank line — sanity check via counting headers.
		const headerMatches = stripAnsi(out).match(/site\.json:1:1 —/g);
		expect(headerMatches).toHaveLength(2);
	});

	it("right-aligns line numbers in the gutter for consistent column alignment", () => {
		const text = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");
		const out = formatIssues(text, [makeIssue({ line: 10, column: 1, endLine: 10, endColumn: 5 })]);
		const plain = stripAnsi(out);
		// Lines 8, 9 (single digit) should be right-aligned to the width of "12" (2 chars).
		expect(plain).toMatch(/ {2} 8 \|/);
		expect(plain).toMatch(/ {2} 9 \|/);
		expect(plain).toMatch(/> 10 \|/);
	});
});

describe("formatIssues — ANSI coloring", () => {
	const text = `{\n  "x": 1\n}\n`;

	it("emits no ANSI codes when color is false (default)", () => {
		const out = formatIssues(text, [makeIssue({ line: 2, column: 3, endLine: 2, endColumn: 6 })]);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: testing absence of ANSI
		expect(out).not.toMatch(/\x1b\[/);
	});

	it("emits ANSI codes when color is true", () => {
		const out = formatIssues(
			text,
			[makeIssue({ line: 2, column: 3, endLine: 2, endColumn: 6, severity: "error" })],
			{ color: true },
		);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: testing presence of ANSI
		expect(out).toMatch(/\x1b\[31m/); // red for error
		// biome-ignore lint/suspicious/noControlCharactersInRegex: testing presence of ANSI
		expect(out).toMatch(/\x1b\[0m/); // reset
	});

	it("uses yellow (33) for warnings instead of red", () => {
		const out = formatIssues(
			text,
			[makeIssue({ line: 2, column: 3, endLine: 2, endColumn: 6, severity: "warning" })],
			{ color: true },
		);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: testing presence of ANSI
		expect(out).toMatch(/\x1b\[33m/); // yellow for warning
		// biome-ignore lint/suspicious/noControlCharactersInRegex: testing absence of ANSI
		expect(out).not.toMatch(/\x1b\[31m/); // no red
	});
});

describe("formatIssues — github format", () => {
	const issues: ValidationIssueLocated[] = [
		{
			severity: "error",
			code: "article-without-href",
			path: ["navigation", 0, "href"],
			message: "Article is missing a required href field.",
			hint: 'Add `"href": "page-name"`.',
			line: 4,
			column: 5,
			endLine: 4,
			endColumn: 23,
		},
		{
			severity: "warning",
			code: "deprecated-foo",
			path: ["x"],
			message: "deprecated, multi-line\nmessage",
			line: 2,
			column: 1,
			endLine: 2,
			endColumn: 5,
		},
	];

	it("emits one GitHub workflow-command line per issue", () => {
		const out = formatIssues("", issues, { format: "github", filename: "site.json" });
		const lines = out.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^::error /);
		expect(lines[1]).toMatch(/^::warning /);
	});

	it("includes filename, line, col, endLine, endColumn, and title=code", () => {
		const out = formatIssues("", [issues[0]], { format: "github", filename: "configs/site.json" });
		expect(out).toContain("file=configs/site.json");
		expect(out).toContain("line=4");
		expect(out).toContain("col=5");
		expect(out).toContain("endLine=4");
		expect(out).toContain("endColumn=23");
		expect(out).toContain("title=article-without-href");
	});

	it("appends the hint after the message with %0A separator", () => {
		const out = formatIssues("", [issues[0]], { format: "github" });
		expect(out).toContain("%0AHint%3A");
	});

	it("escapes commas, colons, and newlines in the message", () => {
		const out = formatIssues("", [issues[1]], { format: "github" });
		expect(out).toContain("%0A"); // newline
		// No raw newline in the message portion of the output line.
		const lines = out.split("\n");
		expect(lines).toHaveLength(1);
	});

	it("ignores color option in github format (no ANSI codes)", () => {
		const out = formatIssues("", [issues[0]], { format: "github", color: true });
		// biome-ignore lint/suspicious/noControlCharactersInRegex: testing absence of ANSI
		expect(out).not.toMatch(/\x1b\[/);
	});
});

describe("formatIssues — end-to-end with validator", () => {
	it("produces a polished error block for a real site.json mistake", () => {
		const text = `{
  "title": "Acme",
  "navigation": [
    { "article": "OK", "href": "ok" },
    { "article": "REST API", "openapi": "/api/openapi.yaml" }
  ]
}
`;
		const issues = locateIssues(text, validateSiteJsonShape(JSON.parse(text)));
		const out = formatIssues(text, issues);
		const plain = stripAnsi(out);

		// Both issues from navigation[1] are surfaced.
		expect(plain).toContain("article-with-openapi");
		expect(plain).toContain("article-without-href");
		// Both anchor on line 5 (where the broken entry sits).
		expect(plain).toMatch(/site\.json:5:\d+ — error\[article-with-openapi\]/);
		expect(plain).toMatch(/site\.json:5:\d+ — error\[article-without-href\]/);
		// The code frame shows the broken entry's source.
		expect(plain).toContain("REST API");
		// Hints are present.
		expect(plain).toContain("hint:");
	});
});
