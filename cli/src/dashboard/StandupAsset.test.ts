/**
 * Runtime smoke test for the Standup board renderer.
 *
 * Same reason as `FeedCardAsset.test.ts`: `assets/js/*.js` is plain JavaScript
 * served verbatim, so tsc never sees it and a model field read under the wrong
 * name renders "undefined" in the browser with no compile-time signal.
 *
 * What it pins here is the author-filter disclosure, plus the three shape rules
 * the columns were trimmed to (JOLLI-2198 / 2200 / 2201).
 *
 * The disclosure is the load-bearing one: the board is what a user reads their
 * standup off, so "filtered to you" and "could not tell who you are, showing
 * everyone" must be distinguishable ON THE PAGE — a silent unfiltered board is
 * how a teammate's commit ends up in someone else's standup. That mattered when
 * the page still drafted markdown for the clipboard, and it did not stop
 * mattering when the draft sheet was removed; the reading is now the paste.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface JDNamespace {
	renderStandup: (model: unknown) => void;
	standupPagerLabel: (fromKey: string, toKey: string) => string;
}

interface FakeElement {
	innerHTML: string;
	textContent: string;
	value: string;
	style: Record<string, string>;
	onclick?: () => void;
	classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
	focus: () => void;
	select: () => void;
	querySelectorAll: () => ReadonlyArray<never>;
	querySelector: () => null;
	addEventListener: () => void;
}

/** Evaluates format.js → shell.js → standup.js in load order against a stub DOM. */
function loadJD(): { JD: JDNamespace; element: (id: string) => FakeElement } {
	const elements = new Map<string, FakeElement>();
	const make = (): FakeElement => {
		const classes = new Set<string>();
		return {
			innerHTML: "",
			textContent: "",
			value: "",
			style: {},
			classList: {
				add: (c: string) => void classes.add(c),
				remove: (c: string) => void classes.delete(c),
				contains: (c: string) => classes.has(c),
			},
			focus: () => undefined,
			select: () => undefined,
			querySelectorAll: () => [],
			querySelector: () => null,
			addEventListener: () => undefined,
		};
	};
	const doc = {
		getElementById: (id: string) => {
			if (!elements.has(id)) elements.set(id, make());
			return elements.get(id);
		},
		querySelectorAll: () => [],
		addEventListener: () => undefined,
		createElement: make,
		body: make(),
	};
	const win = { JD: {}, document: doc, addEventListener: () => undefined } as Record<string, unknown>;
	for (const file of ["format.js", "shell.js", "standup.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		new Function("window", "document", src)(win, doc);
	}
	return { JD: win.JD as unknown as JDNamespace, element: (id) => doc.getElementById(id) as FakeElement };
}

const nowMs = Date.parse("2026-07-30T12:00:00Z");

/** The seven local day keys of the default window, newest first (as the server emits them). */
const WINDOW_DAYS = ["2026-07-30", "2026-07-29", "2026-07-28", "2026-07-27", "2026-07-26", "2026-07-25", "2026-07-24"];

/** A full seven-day `days` array, with only the named days carrying commits. */
function days(byDay: Record<string, unknown[]> = {}): unknown[] {
	return WINDOW_DAYS.map((day) => ({ day, commits: byDay[day] ?? [] }));
}

/** One commit row, defaulted so a test names only the fields it cares about. */
function commit(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		hash: "abc1234def",
		message: "feat: my work",
		committedAtMs: nowMs - 26 * 3_600_000,
		repoName: "jolliai",
		branch: "main",
		...over,
	};
}

function model(standupOver: Record<string, unknown> = {}): unknown {
	return {
		schemaVersion: 1,
		view: "standup",
		tier: "memory",
		generatedAtMs: nowMs,
		timeZone: "UTC",
		scope: { kind: "all" },
		repos: [],
		usage: { available: false },
		standup: {
			today: "2026-07-30",
			yesterday: "2026-07-29",
			windowFrom: "2026-07-24",
			windowTo: "2026-07-30",
			offset: 0,
			days: days({ "2026-07-29": [commit()] }),
			hasNewer: false,
			hasOlder: false,
			workspaces: [],
			insights: [],
			...standupOver,
		},
	};
}

describe("standup pager label", () => {
	it("collapses a same-month window to a single month name", () => {
		const { JD } = loadJD();
		expect(JD.standupPagerLabel("2026-07-24", "2026-07-30")).toBe("Jul 24 – 30");
	});

	it("names both months across a month boundary", () => {
		const { JD } = loadJD();
		expect(JD.standupPagerLabel("2026-07-28", "2026-08-03")).toBe("Jul 28 – Aug 3");
	});

	it("includes the year on both ends across a year boundary", () => {
		const { JD } = loadJD();
		expect(JD.standupPagerLabel("2025-12-29", "2026-01-04")).toBe("Dec 29, 2025 – Jan 4, 2026");
	});
});

describe("standup author disclosure", () => {
	it("names the identity the board was filtered to", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ authoredBy: "me@example.com" }));
		expect(element("app").innerHTML).toContain("yours only");
		expect(element("app").innerHTML).toContain("me@example.com");
	});

	it("says the board is unfiltered when no identity was resolved", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model());
		expect(element("app").innerHTML).toContain("every author");
		expect(element("app").innerHTML).not.toContain("yours only");
	});
});

describe("standup column shape", () => {
	// JOLLI-2198. The button was the draft sheet's only trigger, so its removal
	// is also the sheet's: a page that still built the markdown behind an element
	// nothing can click is dead weight the next reader has to disprove.
	it("offers no copy-as-standup affordance", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ authoredBy: "me@example.com" }));
		const html = element("app").innerHTML;
		expect(html).not.toContain("copyStandup");
		expect(html).not.toContain("share-note");
		expect(html).not.toContain("Copy as standup");
	});

	// One column per day in the window, in the server's newest-first order. The
	// column's stable, locale-independent handle is `data-day` (an ISO date); the
	// aria-label carries the HUMAN-READABLE title instead — a region landmark named
	// by a bare ISO string reads badly to a screen reader. Today and Yesterday get
	// their named titles.
	it("renders one column per window day, newest first, with Today/Yesterday titles", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ authoredBy: "me@example.com" }));
		const html = element("app").innerHTML;
		for (const day of WINDOW_DAYS) expect(html).toContain(`data-day="${day}"`);
		// The accessible name is the readable title, never the raw ISO date.
		expect(html).toContain('aria-label="Today"');
		expect(html).not.toContain('aria-label="Standup for');
		// Newest first: Today's column markup precedes the oldest day's.
		expect(html.indexOf('data-day="2026-07-30"')).toBeLessThan(html.indexOf('data-day="2026-07-24"'));
		expect(html).toContain(">Today<");
		expect(html).toContain(">Yesterday<");
		// Dated columns read in English (en-US pinned), matching the Today/Yesterday titles.
		expect(html).toContain("Jul 24");
	});

	// A quiet day is still a column — the grid stays a stable seven wide rather
	// than collapsing — and it says so rather than rendering blank.
	it("renders a quiet day as an empty column", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model());
		const html = element("app").innerHTML;
		expect(html).toContain("No commits.");
		// The day that does carry a commit shows it, and its count.
		expect(html).toContain("feat: my work");
		expect(html).toContain("· 1 commit");
	});

	// A commit lands in the column for its own day, not another.
	it("buckets a commit into its own day column", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(
			model({
				days: days({
					"2026-07-30": [commit({ hash: "todayc", message: "fix: today's landing" })],
					"2026-07-26": [commit({ hash: "satc", message: "chore: saturday" })],
				}),
			}),
		);
		const html = element("app").innerHTML;
		// Today's column (first) holds today's commit; it precedes Saturday's.
		expect(html.indexOf("fix: today&#39;s landing")).toBeLessThan(html.indexOf("chore: saturday"));
	});

	// Memory Activity's grouping IS the day; here the day is already the column, so
	// a second axis inside one makes two identical lists read as different ones.
	it("renders the day columns flat, with no group headers", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ authoredBy: "me@example.com" }));
		expect(element("app").innerHTML).not.toContain("ghead");
	});

	// The heading and its count already say what the column holds. An EMPTY `.sub`
	// is not the same as none — it carries a bottom margin, so it would hold a gap open.
	it("gives the day columns no caption element", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ authoredBy: "me@example.com" }));
		const html = element("app").innerHTML;
		expect(html).not.toContain("Memory Activity lists");
		expect(html).not.toContain('<div class="sub"></div>');
	});

	// The four fields Memory Activity's row carries, in its order.
	it("carries Memory Activity's field set on a memory-tier row", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(
			model({
				days: days({
					"2026-07-29": [
						commit({ turns: 12, workCategory: "bugfix", estCostUsd: 2.29, insertions: 58, deletions: 11 }),
					],
				}),
			}),
		);
		const html = element("app").innerHTML;
		expect(html).toContain("mem-activity-category");
		expect(html).toContain("bugfix");
		expect(html).toContain("12 turns");
		expect(html).toContain("main");
		expect(html).toContain("jolliai");
		// Dropped in favour of Memory Activity's set — the card shows neither. Both
		// negations name a value, not a unit: a bare "est" or "+" is a substring of
		// too much surrounding markup to mean anything.
		expect(html).not.toContain("2.29");
		expect(html).not.toContain("+58");
	});

	// JOLLI-2200. Titles only — the decision text belongs to the Decisions card,
	// and a TODO is not work that landed (JOLLI-2201). No insight kind reaches a column.
	it("renders commit rows only, never an insight's text", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(
			model({
				insights: [
					{
						kind: "decision",
						text: "chose the lock-free path",
						commitHash: "abc1234def",
						repoName: "jolliai",
					},
					{ kind: "todo", text: "wire the retry path", commitHash: "abc1234def", repoName: "jolliai" },
				],
			}),
		);
		const html = element("app").innerHTML;
		expect(html).toContain("feat: my work");
		expect(html).not.toContain("chose the lock-free path");
		expect(html).not.toContain("wire the retry path");
		expect(html).not.toContain("<b>Decision:</b>");
	});
});

/**
 * The board is two columns, and the third can never come back by accident.
 *
 * `blocker` / `question` / `gotcha` are not producible — `TOPIC_INSIGHTS_CTE`
 * derives insights from each topic's own `decisions`/`todo` text and nothing
 * writes the other three — so the Risks column always said "Nothing flagged".
 * These cases feed the renderer insights of every kind anyway, including the
 * three it can never really receive: if a filter for them is ever re-added, the
 * column reappears here rather than in a user's browser.
 *
 * The same payload also pins the OTHER reason no kind is routed any more: not
 * one of the five reaches the page, `todo` included (JOLLI-2201). The cases
 * above state that per column; this block states it against every kind at once.
 */
describe("standup columns", () => {
	const everyKind = [
		{
			kind: "decision",
			text: "chose the lock",
			commitHash: "abc1234def",
			repoName: "jolliai",
			committedAtMs: nowMs,
		},
		{ kind: "todo", text: "drop the shim", commitHash: "abc1234def", repoName: "jolliai", committedAtMs: nowMs },
		{
			kind: "blocker",
			text: "waiting on infra",
			commitHash: "abc1234def",
			repoName: "jolliai",
			committedAtMs: nowMs,
		},
		{ kind: "question", text: "which zone?", commitHash: "abc1234def", repoName: "jolliai", committedAtMs: nowMs },
		{
			kind: "gotcha",
			text: "status is lossy",
			commitHash: "abc1234def",
			repoName: "jolliai",
			committedAtMs: nowMs,
		},
	];

	it("renders the seven day columns and no Risks/Blockers column", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ insights: everyKind }));
		const html = element("app").innerHTML;
		for (const day of WINDOW_DAYS) expect(html).toContain(`data-day="${day}"`);
		expect(html).not.toContain("Risks");
		expect(html).not.toContain("Blockers");
	});

	it("renders no insight row of any kind, risk or otherwise", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ insights: everyKind }));
		const html = element("app").innerHTML;
		expect(html).not.toContain("waiting on infra");
		expect(html).not.toContain("which zone?");
		expect(html).not.toContain("status is lossy");
		expect(html).not.toContain("kind-blocker");
		expect(html).not.toContain("tag age");
		// The two producible kinds are just as unrouted: a TODO is not work that
		// landed (JOLLI-2201), and a decision belongs to the Decisions card.
		expect(html).not.toContain("drop the shim");
		expect(html).not.toContain("chose the lock");
	});

	it("shows the locked upsell for neither column below the memory tier", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ insights: undefined }));
		expect(element("app").innerHTML).not.toContain("locked-panel");
	});
});
