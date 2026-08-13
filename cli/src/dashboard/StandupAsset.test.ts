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
			yesterdaySessions: [],
			yesterdayCommits: [
				{
					hash: "abc1234def",
					message: "feat: my work",
					committedAtMs: nowMs - 26 * 3_600_000,
					repoName: "jolliai",
					branch: "main",
				},
			],
			todaySessions: [],
			todayCommits: [],
			workspaces: [],
			insights: [],
			...standupOver,
		},
	};
}

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

	// JOLLI-2201. A TODO is work that has NOT happened; the column states what
	// landed today, so an unfinished item in it is a claim the board cannot make.
	it("keeps TODOs out of Today and counts today's commits instead", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(
			model({
				todayCommits: [
					{
						hash: "0f0f0f0abc",
						message: "fix: today's landing",
						committedAtMs: nowMs - 3_600_000,
						repoName: "jolliai",
						branch: "main",
					},
				],
				insights: [
					{
						kind: "todo",
						text: "wire the retry path",
						commitHash: "abc1234def",
						repoName: "jolliai",
						committedAtMs: nowMs - 26 * 3_600_000,
					},
				],
			}),
		);
		const html = element("app").innerHTML;
		expect(html).toContain("fix: today&#39;s landing");
		expect(html).not.toContain("wire the retry path");
		expect(html).not.toContain("TODO");
	});

	// Yesterday is commits-only too, at BOTH tiers. Below the memory tier it used
	// to carry the raw session trail; Memory Activity never lists a session, and
	// the two are required to agree.
	it("keeps session rows out of Yesterday at the raw tier", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(
			model({
				insights: undefined,
				yesterdaySessions: [
					{
						title: "an agent run",
						source: "claude",
						messageCount: 40,
						updatedAtMs: nowMs - 26 * 3_600_000,
						repoName: "jolliai",
						isLive: false,
					},
				],
			}),
		);
		const html = element("app").innerHTML;
		expect(html).toContain("feat: my work");
		expect(html).not.toContain("an agent run");
		expect(html).toContain("· 1 commit");
	});

	// Memory Activity's grouping IS the day; here the day is already the column, so
	// a second axis inside one makes two identical lists read as different ones.
	it("renders both day columns flat, with no group headers", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ authoredBy: "me@example.com" }));
		expect(element("app").innerHTML).not.toContain("ghead");
	});

	// The heading and its count already say what the column holds. An EMPTY `.sub`
	// is not the same as none — it carries a bottom margin, so it would hold the
	// caption's gap open.
	it("gives the day columns no caption, and no empty caption element", () => {
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
				yesterdayCommits: [
					{
						hash: "abc1234def",
						message: "feat: my work",
						committedAtMs: nowMs - 26 * 3_600_000,
						repoName: "jolliai",
						branch: "main",
						turns: 12,
						workCategory: "bugfix",
						estCostUsd: 2.29,
						insertions: 58,
						deletions: 11,
					},
				],
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

	// Same rule for the two other non-completed sources the column used to carry.
	it("keeps live sessions and uncommitted work out of Today", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(
			model({
				todaySessions: [
					{
						title: "still going",
						source: "claude",
						messageCount: 12,
						updatedAtMs: nowMs - 60_000,
						repoName: "jolliai",
						isLive: true,
					},
				],
				workspaces: [{ repoName: "jolliai", branch: "main", filesChanged: 3, insertions: 40, deletions: 2 }],
			}),
		);
		const html = element("app").innerHTML;
		expect(html).not.toContain("still going");
		expect(html).not.toContain("Uncommitted on");
		expect(html).toContain("Nothing yet.");
	});

	// JOLLI-2200. Titles only — the decision text belongs to the Decisions card.
	it("renders Yesterday outcomes without their decision detail", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(
			model({
				insights: [
					{
						kind: "decision",
						text: "chose the lock-free path",
						commitHash: "abc1234def",
						repoName: "jolliai",
						committedAtMs: nowMs - 26 * 3_600_000,
					},
				],
			}),
		);
		const html = element("app").innerHTML;
		expect(html).toContain("feat: my work");
		expect(html).not.toContain("chose the lock-free path");
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

	it("renders exactly Yesterday and Today", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ insights: everyKind }));
		const html = element("app").innerHTML;
		expect(html).toContain('aria-label="Yesterday"');
		expect(html).toContain('aria-label="Today"');
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
