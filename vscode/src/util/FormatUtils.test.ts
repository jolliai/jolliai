import { afterEach, describe, expect, it, vi } from "vitest";
import {
	escMd,
	formatRelativeDate,
	formatShortRelativeDate,
	stripMarkdown,
} from "./FormatUtils.js";

describe("FormatUtils", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("formats recent dates as just now", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

		expect(formatRelativeDate("2026-03-30T11:59:45.000Z")).toContain(
			"just now",
		);
		expect(formatShortRelativeDate("2026-03-30T11:59:45.000Z")).toBe(
			"just now",
		);
	});

	it("formats minute, hour, day, month, and year ranges", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

		expect(formatRelativeDate("2026-03-30T11:15:00.000Z")).toContain(
			"45 minutes ago",
		);
		expect(formatRelativeDate("2026-03-30T09:00:00.000Z")).toContain(
			"3 hours ago",
		);
		expect(formatRelativeDate("2026-03-27T12:00:00.000Z")).toContain(
			"3 days ago",
		);
		expect(formatRelativeDate("2026-02-10T12:00:00.000Z")).toContain(
			"1 month ago",
		);
		expect(formatRelativeDate("2024-03-30T12:00:00.000Z")).toContain(
			"2 years ago",
		);

		expect(formatShortRelativeDate("2026-03-30T11:15:00.000Z")).toBe("45m ago");
		expect(formatShortRelativeDate("2026-03-30T09:00:00.000Z")).toBe("3h ago");
		expect(formatShortRelativeDate("2026-03-27T12:00:00.000Z")).toBe("3d ago");
		expect(formatShortRelativeDate("2026-02-10T12:00:00.000Z")).toBe("1mo ago");
		expect(formatShortRelativeDate("2024-03-30T12:00:00.000Z")).toBe("2y ago");
	});

	it("formats singular forms (exactly 1 minute, 1 hour, 1 day, 1 month, 1 year)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

		// Exactly 1 minute ago — covers diffMins === 1 branch (no "s")
		expect(formatRelativeDate("2026-03-30T11:59:00.000Z")).toContain(
			"1 minute ago",
		);

		// Exactly 1 hour ago — covers diffHours === 1 branch (no "s")
		expect(formatRelativeDate("2026-03-30T11:00:00.000Z")).toContain(
			"1 hour ago",
		);

		// Exactly 1 day ago — covers diffDays === 1 branch (no "s")
		expect(formatRelativeDate("2026-03-29T12:00:00.000Z")).toContain(
			"1 day ago",
		);

		// Exactly 1 month ago (30 days) — covers diffMonths === 1 branch (no "s")
		expect(formatRelativeDate("2026-02-28T12:00:00.000Z")).toContain(
			"1 month ago",
		);

		// Exactly 1 year ago (365 days) — covers diffYears === 1 branch (no "s")
		expect(formatRelativeDate("2025-03-30T12:00:00.000Z")).toContain(
			"1 year ago",
		);
	});

	it("formats plural months ago (e.g. 3 months)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

		// ~3 months ago (90 days)
		expect(formatRelativeDate("2026-03-15T12:00:00.000Z")).toContain(
			"3 months ago",
		);
	});

	it("surfaces invalid Date output for malformed timestamps", () => {
		expect(formatRelativeDate("not-a-date-value")).toBe(
			"NaN years ago (Invalid Date)",
		);
		expect(formatShortRelativeDate("also-not-a-date")).toBe("NaNy ago");
	});

	it("formatRelativeDate catch block returns iso substring when Date methods throw", () => {
		const spy = vi
			.spyOn(Date.prototype, "toLocaleString")
			.mockImplementation(() => {
				throw new Error("locale error");
			});

		expect(formatRelativeDate("2026-03-30T12:00:00Z")).toBe("2026-03-30");

		spy.mockRestore();
	});

	it("formatShortRelativeDate catch block returns iso substring when getTime throws", () => {
		const spy = vi.spyOn(Date.prototype, "getTime").mockImplementation(() => {
			throw new Error("getTime error");
		});

		expect(formatShortRelativeDate("2026-03-30T12:00:00Z")).toBe("2026-03-30");

		spy.mockRestore();
	});

	it("escapes markdown-special characters", () => {
		expect(escMd("\\`*_{}[]()#+-.!|<>")).toBe(
			"\\\\\\`\\*\\_\\{\\}\\[\\]\\(\\)\\#\\+\\-\\.\\!\\|\\<\\>",
		);
	});

	describe("stripMarkdown", () => {
		// Each rule has a concrete failure mode in the hover-card it guards
		// against. The test names spell out the user-visible symptom rather
		// than the rule's mechanics so a future reader trying to debug
		// "tooltip looks wrong" can find the relevant case quickly.

		it("strips ATX headings (## Foo → Foo) — Linear descriptions start with these", () => {
			expect(stripMarkdown("## Problem\n\nToday the call...")).toBe(
				"Problem\n\nToday the call...",
			);
			// All depths 1-6
			expect(stripMarkdown("###### Deep")).toBe("Deep");
		});

		it("strips bold markers (**foo** → foo) without affecting unpaired asterisks", () => {
			expect(stripMarkdown("This is **bold** text.")).toBe(
				"This is bold text.",
			);
			// Unpaired asterisk left alone (e.g. arithmetic, glob pattern).
			expect(stripMarkdown("rate is 5 * 3 per row")).toBe(
				"rate is 5 * 3 per row",
			);
		});

		it("strips italic markers (*foo* / _foo_) but spares underscores inside identifiers", () => {
			expect(stripMarkdown("an *italic* word")).toBe("an italic word");
			expect(stripMarkdown("an _italic_ word")).toBe("an italic word");
			// Identifier with internal underscores — must not become "snake case".
			expect(stripMarkdown("call my_helper_func()")).toBe(
				"call my_helper_func()",
			);
		});

		it("unwraps inline code spans (`foo` → foo)", () => {
			expect(stripMarkdown("Use `mcp__linear__get_issue` to fetch.")).toBe(
				"Use mcp__linear__get_issue to fetch.",
			);
		});

		it("does not eat underscores inside identifiers (mcp__linear__get_issue stays intact)", () => {
			// Regression: an unguarded `__bold__` rule matched inside
			// identifiers and produced "mcplineargetissue". The bold-
			// underscore regex now requires non-word characters on both
			// sides, matching the italic-underscore rule's behavior.
			expect(stripMarkdown("call mcp__linear__get_issue here")).toBe(
				"call mcp__linear__get_issue here",
			);
		});

		it("unwraps markdown links to just the label text", () => {
			expect(stripMarkdown("see [the spec](https://example.com/spec)")).toBe(
				"see the spec",
			);
		});

		it("unwraps Linear inline-issue tags to the visible ticketId", () => {
			// Linear MCP returns descriptions like:
			// <issue id="e143cd5b-…">PROJ-1404</issue>
			// — these read terribly as raw HTML in the preview.
			expect(
				stripMarkdown(
					'see <issue id="e143cd5b-fd3f-450c-92a7-044783011be4">PROJ-1404</issue> for context',
				),
			).toBe("see PROJ-1404 for context");
		});

		it("collapses 3+ consecutive newlines to a paragraph break", () => {
			// Linear's prose sometimes has extra blank lines that waste
			// vertical space in the limited hover-card height.
			expect(stripMarkdown("A\n\n\n\n\nB")).toBe("A\n\nB");
		});

		it("preserves single and double newlines so paragraphs survive intact", () => {
			expect(stripMarkdown("line1\nline2\n\npara2")).toBe(
				"line1\nline2\n\npara2",
			);
		});

		it("composes correctly on a realistic Linear issue description", () => {
			// Captures the exact regression the user reported: markdown
			// source bleeding through the hover-card.
			const input =
				'## Problem\n\nLike Plans/Notes (see <issue id="abc">PROJ-1404</issue>), Linear issues are often **the highest-density context**.';
			expect(stripMarkdown(input)).toBe(
				"Problem\n\nLike Plans/Notes (see PROJ-1404), Linear issues are often the highest-density context.",
			);
		});
	});
});
