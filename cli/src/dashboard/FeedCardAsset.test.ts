/**
 * Runtime smoke test for the "What my agents did" feed renderer.
 *
 * `assets/js/*.js` is plain JavaScript bundled verbatim into the served page —
 * tsc never type-checks it, so reading `card.cost` when the model sends
 * `estCostUsd` would render "undefined" in the browser with no compile-time
 * signal. This evaluates the real IIFEs against a model shaped like
 * `buildDashboardModel`'s output and asserts the markup, following the same
 * pattern as `graph/KindBadgesAsset.test.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MEMORY_CARD_MAJOR_LINES } from "./DashboardModel.js";

interface SeriesPoint {
	readonly date: string;
	readonly bySeries: Record<string, number>;
}

interface JDNamespace {
	renderStats: (model: unknown) => void;
	repoToken: (model: unknown, identity: string) => string;
	withParams: (query: string, params: Record<string, string | undefined>) => string;
	stackedBars: (
		series: ReadonlyArray<SeriesPoint>,
		keys: ReadonlyArray<string>,
		valueLabel: string,
		fmt?: (n: number) => string,
	) => string;
	topSeries: (
		series: ReadonlyArray<SeriesPoint>,
		keys: ReadonlyArray<string>,
		limit: number,
	) => { keys: ReadonlyArray<string>; series: ReadonlyArray<SeriesPoint>; byKey: Record<string, number> };
	fmtUsd: (n: number) => string;
}

/** Minimal element stub: enough for the renderer to write into and be read back. */
interface FakeElement {
	innerHTML: string;
	style: Record<string, string>;
	onclick?: () => void;
	querySelectorAll: () => ReadonlyArray<never>;
	querySelector: () => null;
	addEventListener: () => void;
}

/**
 * Evaluates format.js → shell.js → charts.js → stats.js in load order against a
 * stub window/document. `renderStats` writes into `#app`, so the harness hands
 * out recording elements and reads that one back.
 */
function loadJD(): { JD: JDNamespace; app: FakeElement } {
	const elements = new Map<string, FakeElement>();
	const element = (): FakeElement => ({
		innerHTML: "",
		style: {},
		querySelectorAll: () => [],
		querySelector: () => null,
		addEventListener: () => undefined,
	});
	const doc = {
		getElementById: (id: string) => {
			if (!elements.has(id)) elements.set(id, element());
			return elements.get(id);
		},
		querySelectorAll: () => [],
		// Answered because `renderStats` snapshots and restores each ranked list's
		// scroll offset by looking its <ul> up on the DOCUMENT (see
		// `snapshotToolScroll` in stats.js), and unlike `revealToolRows` it does so
		// unconditionally — there is no paging state to short-circuit on. `null` is
		// the honest answer: this harness renders to a string and has no lists to
		// scroll, so every offset is absent and every restore a no-op.
		querySelector: () => null,
		addEventListener: () => undefined,
		createElement: element,
		body: element(),
	};
	const win = { JD: {}, document: doc, addEventListener: () => undefined, alert: () => undefined } as Record<
		string,
		unknown
	>;
	for (const file of ["format.js", "shell.js", "charts.js", "stats.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		new Function("window", "document", src)(win, doc);
	}
	return { JD: win.JD as unknown as JDNamespace, app: doc.getElementById("app") as FakeElement };
}

const { JD, app } = loadJD();

const CARD = {
	repoIdentity: "https://github.com/jolliai/jolliai",
	commitHash: "h1",
	title: "fix: token refresh race in gateway retries",
	category: "bugfix",
	severity: "minor" as const,
	committedAtMs: Date.parse("2026-07-27T16:54:00Z"),
	decision: "Keep jittered backoff; contention was the disease.",
	estCostUsd: 2.29,
	turns: 3,
	insertions: 58,
	deletions: 11,
	branch: "fix-auth-refresh",
	model: "claude-fable-5",
	repoName: "jolliai",
};

/** A model with just the fields the stats page reads. */
function model(over: Record<string, unknown> = {}, statsOver: Record<string, unknown> = {}): unknown {
	return {
		schemaVersion: 1,
		view: "stats",
		tier: "memory",
		generatedAtMs: Date.parse("2026-07-30T12:00:00Z"),
		timeZone: "UTC",
		scope: { kind: "repo", repoIdentities: ["https://github.com/jolliai/jolliai"] },
		repos: [
			{
				repoIdentity: "https://github.com/jolliai/jolliai",
				repoName: "jolliai",
				worktreeRoot: "/w",
				sessionsThisWeek: 3,
			},
		],
		usage: { available: false },
		stats: {
			series: [],
			seriesKeys: [],
			seriesDimension: "model",
			heatmap: [],
			hours: [],
			fun: { legendarySessionMinutes: 0, biggestDayTokens: 0, nightOwlSharePct: 0 },
			recentSessions: [],
			memoryCards: [CARD],
			range: "month",
			rangeFrom: "2026-07-01",
			rangeTo: "2026-07-30",
			// Field-for-field with `ToolUsage`. Nothing type-checks that: this builder
			// returns `unknown` on purpose (the asset scripts are plain JS), so the
			// fixture had drifted to a `sourcesWithoutToolData` key no renderer has
			// read since that field was renamed `uncoveredSources`, and was missing
			// `mcpTools` outright. A renderer reading a field the server always sends
			// is right to do so unguarded — the fixture is what has to keep up.
			toolUsage: {
				skills: [],
				skillsTotal: 0,
				skillCallsTotal: 0,
				servers: [],
				serversTotal: 0,
				serverCallsTotal: 0,
				mcpTools: [],
				mcpToolsTotal: 0,
				skillAgents: [],
				mcpAgents: [],
				sessionsWithTools: 0,
				sessionsInWindow: 0,
				uncoveredSources: [],
			},
			tokenBreakdown: { input: 0, output: 0, cached: 0, perDay: [] },
			...statsOver,
		},
		...over,
	};
}

/** The prominent Memory Activity section rendered in place of the old feed. */
function feedHtml(m: unknown): string {
	app.innerHTML = "";
	JD.renderStats(m);
	const html = app.innerHTML;
	const start = Math.max(
		html.indexOf('aria-label="Memory Activity"'),
		html.indexOf('aria-label="What my agents did"'),
	);
	expect(start).toBeGreaterThan(-1);
	return html.slice(start, html.indexOf("</section>", start));
}

describe("Memory Activity — memory tier", () => {
	it("renders the Time view, metadata and a link for every captured memory", () => {
		const html = feedHtml(model());
		expect(html).toContain('data-memory-activity-view="branch"');
		expect(html).toContain('data-memory-activity-view="time"');
		// The row shows the memory's TITLE; the decision/recap line was removed.
		expect(html).toContain("fix: token refresh race in gateway retries");
		expect(html).not.toContain("Keep jittered backoff; contention was the disease.");
		expect(html).toContain("bugfix");
		expect(html).toContain("3 turns");
		expect(html).toContain("fix-auth-refresh");
		// The TITLE is the link — there is no separate "Open memory →" action.
		expect(html).not.toContain("Open memory");
		// `detailRepo`, not `repo`: the link names which repo owns the memory
		// without scoping the Memories tree to it (see wireTree in memories.js).
		expect(html).toContain("&hash=h1&detailRepo=https%3A%2F%2Fgithub.com%2Fjolliai%2Fjolliai");
		expect(html).toContain(
			'<a class="mem-activity-title" href="/memories?repo=jolliai&range=month&dimension=model&hash=h1&detailRepo=https%3A%2F%2Fgithub.com%2Fjolliai%2Fjolliai" target="_blank" rel="noopener">fix: token refresh race in gateway retries</a>',
		);
		// The whole point of the runtime test: a renamed model field would show up here.
		expect(html).not.toContain("undefined");
		expect(html).not.toContain("NaN");
	});

	it("shows no session rows and no reuse chip", () => {
		const html = feedHtml(model());
		expect(html).not.toContain("sess-row");
		// Recall receipts do not exist yet; the chip must never be emitted.
		expect(html).not.toContain("tag reuse");
	});

	it("prints an absolute timestamp in the viewer's zone", () => {
		expect(feedHtml(model())).toContain("Jul 27 · 4:54pm");
		expect(feedHtml(model({ timeZone: "Asia/Shanghai" }))).toContain("Jul 28 · 12:54am");
	});

	it("omits chips the summary never recorded, rather than rendering blanks", () => {
		const bare = {
			repoIdentity: CARD.repoIdentity,
			commitHash: "h2",
			title: "chore: tidy",
			severity: "minor" as const,
			committedAtMs: CARD.committedAtMs,
			repoName: "jolliai",
		};
		const html = feedHtml(model({}, { memoryCards: [bare] }));
		expect(html).toContain("chore: tidy");
		expect(html).not.toContain("est");
		expect(html).not.toContain("undefined");
	});

	it("names the repo per card only when the page spans repos", () => {
		expect(feedHtml(model())).not.toContain(">jolliai</span>");
		const all = feedHtml(model({ scope: { kind: "all" } }));
		expect(all).toContain(">jolliai</span>");
	});

	it("labels a large diff as major, matching the documented threshold", () => {
		const big = { ...CARD, insertions: MEMORY_CARD_MAJOR_LINES, deletions: 0, severity: "major" as const };
		expect(feedHtml(model({}, { memoryCards: [big] }))).toContain("bugfix");
	});

	it("shows captured/decision counts when the backend supplies coverage data", () => {
		const html = feedHtml(model({}, { memoriesCreated: 110, totalCommits: 173, decisionsCaptured: 48 }));
		expect(html).toContain('<div class="mas-item"><b class="num">110</b><span>of 173 captured</span></div>');
		expect(html).toContain('<div class="mas-item"><b class="num">48</b><span>decisions</span></div>');
	});

	it("states no gap figure, even when commits in the window went uncaptured", () => {
		// The "N gaps" chip was removed: it flagged a deficit this page offers no
		// way to act on, and the "of 173" denominator already reports the
		// coverage. Both of its inputs are still on the model, so a re-render is
		// all that would bring it back — which is exactly why this is pinned.
		const html = feedHtml(model({}, { memoriesCreated: 110, totalCommits: 173, decisionsCaptured: 48 }));
		expect(html).not.toContain("mas-warn");
		expect(html).not.toContain("gaps");
		expect(html).not.toContain(">63<");
	});

	it("renders no coverage row when the backend hasn't supplied it", () => {
		expect(feedHtml(model())).not.toContain("mem-activity-stats");
	});

	it("shows the decisions this commit recorded, singular when there is one", () => {
		// The chip is an <a>, not a <span>: it jumps to `#what-changed` on the
		// detail page rather than making the reader find the decisions themselves.
		expect(feedHtml(model({}, { memoryCards: [{ ...CARD, decisionCount: 3 }] }))).toContain("3 decisions</a>");
		expect(feedHtml(model({}, { memoryCards: [{ ...CARD, decisionCount: 1 }] }))).toContain("1 decision</a>");
	});

	it("links the decision count at the topics section, not the top of the memory", () => {
		const html = feedHtml(model({}, { memoryCards: [{ ...CARD, decisionCount: 3 }] }));
		expect(html).toContain(
			'<a class="tag metric num" href="/memories?repo=jolliai&range=month&dimension=model&hash=h1&detailRepo=https%3A%2F%2Fgithub.com%2Fjolliai%2Fjolliai#what-changed" target="_blank" rel="noopener">3 decisions</a>',
		);
		// The title link is the same memory WITHOUT the anchor — the two chips
		// lead to different places in one page on purpose.
		expect(html).toContain('rel="noopener">fix: token refresh race in gateway retries</a>');
	});

	// Absent, not zero: the server omits the field when the commit recorded none,
	// and a row of zeros is noise beside the chips that are already conditional.
	it("prints no decision chip when the commit recorded none", () => {
		const html = feedHtml(model());
		expect(html).not.toContain("decisions</a>");
		expect(html).not.toContain("decision</a>");
		expect(html).not.toContain("#what-changed");
	});

	it("labels the two nearest days Today/Yesterday, and leaves older groups as a bare date", () => {
		// generatedAtMs is 2026-07-30T12:00:00Z, so these land on today, yesterday, and three days back.
		// Uses app.innerHTML directly, not feedHtml: a mem-activity-group is itself a nested <section>, so
		// feedHtml's "slice to the next </section>" would stop at the first group instead of the card's end.
		const todayCard = { ...CARD, commitHash: "h-today", committedAtMs: Date.parse("2026-07-30T09:00:00Z") };
		const yesterdayCard = { ...CARD, commitHash: "h-yday", committedAtMs: Date.parse("2026-07-29T09:00:00Z") };
		const olderCard = { ...CARD, commitHash: "h-older", committedAtMs: Date.parse("2026-07-27T09:00:00Z") };
		app.innerHTML = "";
		JD.renderStats(model({}, { memoryCards: [todayCard, yesterdayCard, olderCard] }));
		expect(app.innerHTML).toContain("<h3>Today · Jul 30</h3>");
		expect(app.innerHTML).toContain("<h3>Yesterday · Jul 29</h3>");
		expect(app.innerHTML).toContain("<h3>Jul 27</h3>");
	});
});

describe("feed card — local tier", () => {
	const sessions = [
		{
			sessionId: "s1",
			source: "claude",
			title: "claude session",
			messageCount: 2,
			updatedAtMs: Date.parse("2026-07-30T11:00:00Z"),
			repoName: "jolliai",
			isLive: false,
		},
	];

	it("falls back to session rows plus the enable prompt when memory is off", () => {
		const html = feedHtml(model({ tier: "installed" }, { memoryCards: [], recentSessions: sessions }));
		expect(html).toContain("from local agent logs");
		expect(html).toContain("sess-row");
		expect(html).toContain("These sessions produced commits — but the join is off.");
		expect(html).not.toContain("fcard");
	});

	it("says the window is empty rather than implying nothing was ever captured", () => {
		const html = feedHtml(model({ tier: "installed" }, { memoryCards: [], recentSessions: [] }));
		expect(html).toContain("No sessions in this window.");
	});

	it("shows sessions without the enable prompt when memory is on but produced no cards", () => {
		// Memory is enabled, the window simply holds no summarized commits — telling
		// this user to enable memory would be wrong.
		const html = feedHtml(model({}, { memoryCards: [], recentSessions: sessions }));
		expect(html).toContain("sess-row");
		expect(html).not.toContain("the join is off");
	});
});

/**
 * JOLLI-2190: the equal-third band's subtitles.
 *
 * Skills and MCPs describe what their card IS — read once, then noise on every
 * later visit — so they moved onto the title as a hover tooltip. Tokens' did
 * NOT: its subtitle is the window its numbers cover, which is a figure, and the
 * same one every other card on the page states in the open.
 */
/**
 * The daily chart Tokens and Spend share labels its two ENDPOINTS only.
 *
 * It used to label every other bar with a bare day-of-month — fine at 7 days,
 * unreadable at 90, and monthless, so `12` could be any month. Two labelled ends
 * state the window exactly and do not get denser as the range grows. Between
 * them, the per-bar `<title>` is what keeps a bar identifiable, so it must
 * survive.
 */
describe("stacked bar chart axis", () => {
	const chart = (): string => {
		app.innerHTML = "";
		JD.renderStats(
			model(
				{},
				{
					series: [
						{ date: "2026-07-28", tokens: 10, estCostUsd: 1, bySeries: { input: 10 } },
						{ date: "2026-07-29", tokens: 20, estCostUsd: 2, bySeries: { input: 20 } },
						{ date: "2026-07-30", tokens: 30, estCostUsd: 3, bySeries: { input: 30 } },
					],
					seriesKeys: ["input"],
				},
			),
		);
		// The card ICONS are svgs too, so anchor on this chart's own viewBox.
		// Rendered here by Spend, which draws `stats.series` directly; the Tokens
		// card draws the identical chart from the same helper.
		const open = app.innerHTML.indexOf('<svg viewBox="0 0 660');
		expect(open).toBeGreaterThan(-1);
		return app.innerHTML.slice(open, app.innerHTML.indexOf("</svg>", open));
	};

	it("labels the first and last day, and nothing between", () => {
		const svg = chart();
		expect(svg).toContain(">Jul 28</text>");
		expect(svg).toContain(">Jul 30</text>");
		// The middle day gets no tick — that is the whole point.
		expect(svg).not.toContain(">Jul 29</text>");
		// Anchored to the plot edges, not centred on a bar.
		expect(svg).toContain('text-anchor="start"');
	});

	it("spells the month from the day key, never through a Date", () => {
		// `new Date("2026-07-28")` is UTC midnight while getDate() reads local, so
		// west of UTC every label would render a day early. The key is already the
		// right day in the payload's own zone.
		expect(chart()).not.toContain(">Jul 27</text>");
	});

	it("keeps every bar identifiable by hover", () => {
		// The whole reason dropping the axis is safe: the FULL date survives on
		// every segment, where the axis only ever carried a day number.
		const svg = chart();
		for (const day of ["2026-07-28", "2026-07-29", "2026-07-30"]) {
			expect(svg, day).toContain(`<title>${day} · input ·`);
		}
	});

	it("reserves exactly one label row under the baseline", () => {
		// Baseline (214) + the label row + the 8px margin the right edge uses.
		expect(chart()).toContain('viewBox="0 0 660 238"');
	});
});

describe("Decisions card footer", () => {
	const footer = (): string => {
		app.innerHTML = "";
		JD.renderStats(model({}, { decisionsCaptured: 4, decisions: { keptCount: 4, repoCount: 2, perDay: [] } }));
		const start = app.innerHTML.indexOf('aria-label="Decisions"');
		expect(start).toBeGreaterThan(-1);
		const foot = app.innerHTML.indexOf('<div class="w-foot"', start);
		return app.innerHTML.slice(foot, app.innerHTML.indexOf("</section>", foot));
	};

	it("states the repo count and nothing about how decisions are stored", () => {
		// "kept, not merged" sat directly under the latest-decision quote, where it
		// read as a status on THAT decision rather than a note about the corpus.
		expect(footer()).toContain("across <b>2 repos</b> in this window");
		expect(footer()).not.toContain("kept, not merged");
		expect(footer()).not.toContain("w-chip");
	});
});

/**
 * Every card built on `widgetHead` — the three in the equal-third band plus
 * Decisions, which kept the head when it moved down to share a row with Spend.
 * The shape is what they have in common (one-line title, explanation in a
 * `title=` hint, no visible sub), not the column count.
 */
const WIDGET_HEAD_CARDS = ["Skills", "MCPs", "Decisions", "Tokens"];

describe("widget card heads", () => {
	/** A card's tooltip text with the hard wraps taken back out. */
	const hintOf = (label: string): string => {
		const title = /title="([^"]*)"/.exec(headOf(label));
		expect(title, label).not.toBeNull();
		return (title as RegExpExecArray)[1].split("&#10;").join(" ");
	};

	/** The tooltip's lines, as the browser will break them. */
	const hintLines = (label: string): string[] =>
		((/title="([^"]*)"/.exec(headOf(label)) as RegExpExecArray)[1] || "").split("&#10;");

	/**
	 * One card's head, sliced at the `card-head` div's OWN close — depth-counted,
	 * not "the first `</div></div>` after the title".
	 *
	 * The naive scan is right only for a head with no aside. A head that carries
	 * one (the right-aligned figure a `span6` card passes `widgetHead`) nests two
	 * more divs inside the card-head, so the first `</div></div>` falls INSIDE the
	 * aside: the slice ended early AND pulled the aside's own `.sub` in with it,
	 * which is exactly what the cases below assert a head does not have. Nothing
	 * caught it because the default fixture leaves `decisions` absent and
	 * `tokenBreakdown` at zero, so both of those cards render their bare-head
	 * branch — `statsOver` is what reaches the other one.
	 */
	const headOf = (label: string, statsOver: Record<string, unknown> = {}): string => {
		app.innerHTML = "";
		JD.renderStats(model({}, statsOver));
		const html = app.innerHTML;
		const start = html.indexOf(`aria-label="${label}"`);
		expect(start, label).toBeGreaterThan(-1);
		const open = html.indexOf('<div class="card-head">', start);
		expect(open, label).toBeGreaterThan(-1);
		let depth = 0;
		const tags = /<div\b|<\/div>/g;
		tags.lastIndex = open;
		for (let m = tags.exec(html); m; m = tags.exec(html)) {
			depth += m[0] === "</div>" ? -1 : 1;
			if (depth === 0) return html.slice(start, m.index + "</div>".length);
		}
		throw new Error(`unbalanced card-head for ${label}`);
	};

	/**
	 * The head up to the aside — `<h2>` plus the visible sub under it, if any.
	 *
	 * The `.sub` cases below mean "no visible sub UNDER THE TITLE", and an aside
	 * carries a `.sub` of its own by design (the noun line beside its figure), so
	 * they have to be scoped here rather than to the whole head. `widgetHead`
	 * emits `<div class="spacer">` only in the aside branch, immediately after the
	 * title wrapper closes, which makes it the exact boundary.
	 */
	const titleBlockOf = (label: string, statsOver: Record<string, unknown> = {}): string => {
		const head = headOf(label, statsOver);
		const aside = head.indexOf('<div class="spacer">');
		return aside === -1 ? head : head.slice(0, aside);
	};

	it("puts the Skills explanation in the title's tooltip", () => {
		const head = headOf("Skills");
		expect(head).toContain('class="has-hint"');
		expect(hintOf("Skills")).toContain("Skill invocations, counted from the tool calls");
		// Scope claim, pinned: only `Skill` tool calls become skill rows — a
		// subagent is the `Task` builtin and a slash command is never a tool call
		// — so the copy must not widen to either without the classifier widening.
		expect(head).not.toContain("command");
		expect(titleBlockOf("Skills")).not.toContain('<div class="sub">');
	});

	it("puts the MCPs explanation in the title's tooltip", () => {
		const head = headOf("MCPs");
		expect(head).toContain('class="has-hint"');
		expect(hintOf("MCPs")).toContain("never the arguments or the results");
		// The rows come from captured CALLS, so the copy says "only servers that
		// called". It must not claim a configured-but-idle server is listed: that
		// needs the registered-server list, which no transcript carries.
		expect(hintOf("MCPs")).toContain("Only servers that actually made a call");
		expect(head).not.toContain("errored");
		expect(titleBlockOf("MCPs")).not.toContain('<div class="sub">');
	});

	it("explains what Tokens counts, and no longer restates the window", () => {
		// `Last 30 days` came off the card: the topbar range control is the one
		// place the window is set, and it says so there. What the tooltip carries
		// instead is the thing the bars cannot show — why this card counts tokens
		// while Spend counts dollars. Tokens has been out to Spend's row and back
		// into the band since, and the head shape rode along both times.
		const head = headOf("Tokens");
		expect(head).toContain('class="has-hint"');
		expect(hintOf("Tokens")).toContain("Cache reads bill at 10% of input");
		expect(hintOf("Tokens")).toContain("this widget counts tokens and Spend counts dollars");
		expect(head).not.toContain("Last 30 days");
		expect(titleBlockOf("Tokens")).not.toContain('<div class="sub">');
	});

	it("puts the Decisions explanation in the title's tooltip", () => {
		// Took Tokens' seat in the band, and with it the band's head: what was a
		// visible sub is now a one-line title carrying its sentence as a hint. The
		// window went the same way `Last 30 days` did on Tokens. The two have since
		// swapped back — Decisions now sits beside Spend — and the head shape is
		// what survived the round trip, which is why this case still applies.
		const head = headOf("Decisions");
		expect(head).toContain('class="has-hint"');
		expect(hintOf("Decisions")).toContain("Decisions your sessions made, accumulating across the range");
		expect(hintOf("Decisions")).toContain("the knowledge Jolli banked, with the receipts behind it");
		// "What Jolli decided to keep" is gone: it described the store rather than
		// the reader's work.
		expect(hintOf("Decisions")).not.toContain("What Jolli decided to keep");
		expect(head).not.toContain("Last 30 days");
		expect(titleBlockOf("Decisions")).not.toContain('<div class="sub">');
	});

	/**
	 * The two POPULATED heads, which nothing above reaches: the default fixture
	 * leaves `decisions` absent and `tokenBreakdown` at zero, so every case up to
	 * here renders a locked panel or an empty note and its bare head. The band swap
	 * moved the aside from one card to the other, and this pair is what holds each
	 * end of it — without them the swap's whole visible consequence is untested.
	 */
	const DECISIONS_DATA = { decisions: { keptCount: 4, repoCount: 1, perDay: [] } };
	const TOKENS_DATA = { tokenBreakdown: { input: 700, output: 200, cached: 100, perDay: [] } };

	it("hands Decisions' kept count to the head's aside at span6", () => {
		const head = headOf("Decisions", DECISIONS_DATA);
		// The spacer is `widgetHead`'s aside branch, and nothing else emits it.
		expect(head).toContain('<div class="spacer"></div>');
		expect(head).toContain("4 kept");
		// 18px, the size Spend's figure uses beside it in the same band — a headline
		// figure that disagreed with its own row's other card would read as a
		// different kind of number.
		expect(head).toContain("font-size:18px");
		// And it is no longer under the title, which is what the seat change bought.
		expect(titleBlockOf("Decisions", DECISIONS_DATA)).not.toContain("4 kept");
		// The slice really is the WHOLE head. An aside nests two more divs, so the
		// scan this replaced — "to the first `</div></div>`" — stopped inside it and
		// left every negative assertion over a head weaker than it reads.
		expect(head.split("<div").length).toBe(head.split("</div>").length);
	});

	it("keeps Tokens' total under the title, with no aside at span4", () => {
		// The other end of the swap: a third of a row has no room for icon + title +
		// figure on one line, so this card gives the aside back.
		expect(headOf("Tokens", TOKENS_DATA)).not.toContain('<div class="spacer">');
		app.innerHTML = "";
		JD.renderStats(model({}, TOKENS_DATA));
		const from = app.innerHTML.indexOf('aria-label="Tokens"');
		const card = app.innerHTML.slice(from, app.innerHTML.indexOf("</section>", from));
		// 22px below the head, the band's own way of printing a headline figure.
		expect(card).toContain('style="font-size:22px;font-weight:650;margin-top:2px">1.0k');
		// The cache share rides on that figure's sub as a second clause, not as the
		// `<br>`-separated second line the aside used.
		expect(card).toContain("captured tokens · 10% of them cache");
		expect(card).not.toContain("captured tokens<br>");
		// `.bignum` has never had a rule in main.css — the styling is inline, and
		// the class rode along one swap too many before it was dropped.
		expect(card).not.toContain("bignum");
	});

	it("hard-wraps every tooltip — a native one does not wrap itself", () => {
		// Unwrapped, a two-sentence hint renders as one line that runs past the
		// card and off the viewport.
		for (const label of WIDGET_HEAD_CARDS) {
			const lines = hintLines(label);
			expect(lines.length, label).toBeGreaterThan(1);
			for (const line of lines) expect(line.length, `${label}: ${line}`).toBeLessThanOrEqual(70);
		}
	});

	it("breaks only between words", () => {
		// The wrap is by character count against a font the page cannot measure,
		// so word boundaries are what keep it acceptable.
		for (const label of WIDGET_HEAD_CARDS) {
			for (const line of hintLines(label)) {
				expect(line.startsWith(" "), label).toBe(false);
				expect(line.endsWith(" "), label).toBe(false);
			}
		}
	});

	it("leaves no visible subtitle on any card in the band", () => {
		for (const label of WIDGET_HEAD_CARDS) {
			expect(headOf(label), label).not.toContain('<div class="sub">');
		}
	});
});

describe("per-row repo tag", () => {
	// The tag is what tells one repo's rows from another's, so it must appear
	// whenever the page is showing more than one — and must NOT appear under a
	// single-repo scope, where every row would repeat the topbar picker's label.
	// `JD.scopeChip` used to state the scope in the card head instead; it went
	// with the arrival of that picker.
	it("names the repo on every card when the page is unscoped", () => {
		expect(feedHtml(model({ scope: { kind: "all" } }))).toContain(">jolliai</span>");
	});

	it("names the repo when several are in scope", () => {
		const two = { kind: "repo", repoIdentities: ["https://github.com/jolliai/jolliai", "local:other"] };
		expect(feedHtml(model({ scope: two }))).toContain(">jolliai</span>");
	});

	it("drops the tag under a single-repo scope", () => {
		// The card's own title still renders — this asserts the TAG is gone, not
		// that the row vanished.
		const html = feedHtml(model());
		expect(html).toContain("fix: token refresh race in gateway retries");
		expect(html).not.toContain(">jolliai</span>");
	});
});

describe("Memory Activity", () => {
	it("renders the Time view and a detail link for each captured memory", () => {
		app.innerHTML = "";
		JD.renderStats(model());
		expect(app.innerHTML).toContain('aria-label="Memory Activity"');
		expect(app.innerHTML).toContain('data-memory-activity-view="branch"');
		expect(app.innerHTML).toContain('data-memory-activity-view="time"');
		expect(app.innerHTML).toContain("&hash=h1&detailRepo=https%3A%2F%2Fgithub.com%2Fjolliai%2Fjolliai");
		// One link per row, and it is the title: an action column of identical
		// "Open memory →" links was the same word repeated down the card.
		expect(app.innerHTML).toContain('<a class="mem-activity-title"');
		expect(app.innerHTML).not.toContain("Open memory");
	});
});

describe("repo URL token", () => {
	const m = model();

	it("uses the short name when it identifies one repo", () => {
		expect(JD.repoToken(m, "https://github.com/jolliai/jolliai")).toBe("jolliai");
	});

	it("keeps the identity when two repos share a name — the server refuses to guess", () => {
		const dupes = model({
			repos: [
				{
					repoIdentity: "https://github.com/one/jolli",
					repoName: "jolli",
					worktreeRoot: "/a",
					sessionsThisWeek: 0,
				},
				{
					repoIdentity: "https://github.com/two/jolli",
					repoName: "jolli",
					worktreeRoot: "/b",
					sessionsThisWeek: 0,
				},
			],
		});
		expect(JD.repoToken(dupes, "https://github.com/one/jolli")).toBe("https://github.com/one/jolli");
	});

	it("passes an unknown identity through", () => {
		expect(JD.repoToken(m, "local:unknown")).toBe("local:unknown");
	});
});

/** The MCPs / Skills card markup, for one `toolUsage` override. */
function usageHtml(label: string, toolUsage: Record<string, unknown>): string {
	app.innerHTML = "";
	JD.renderStats(
		model(
			{},
			{
				toolUsage: {
					skills: [],
					servers: [],
					mcpTools: [],
					skillAgents: [],
					mcpAgents: [],
					sessionsWithTools: 1,
					sessionsInWindow: 1,
					uncoveredSources: [],
					...toolUsage,
				},
			},
		),
	);
	const html = app.innerHTML;
	const start = html.indexOf(`aria-label="${label}"`);
	expect(start).toBeGreaterThan(-1);
	return html.slice(start, html.indexOf("</section>", start));
}

/** Every `width:N%` a ranked list emitted, in row order. */
function barWidths(html: string): ReadonlyArray<number> {
	return [...html.matchAll(/width:(\d+)%/g)].map((m) => Number(m[1]));
}

/** The Decisions card, sliced out of the same rendered page. */
function decisionsHtml(decisions: Record<string, unknown> | undefined): string {
	app.innerHTML = "";
	JD.renderStats(model({}, { decisions }));
	const html = app.innerHTML;
	const start = html.indexOf('aria-label="Decisions"');
	expect(start).toBeGreaterThan(-1);
	return html.slice(start, html.indexOf("</section>", start));
}

const LATEST = {
	title: "Verify before documenting an exact ticket match",
	commitHash: "h1",
	repoName: "jolliai",
	repoIdentity: "https://github.com/jolliai/jolliai",
	committedAtMs: Date.parse("2026-07-27T16:54:00Z"),
};

const DECISIONS = { keptCount: 4, repoCount: 1, latest: LATEST, perDay: [{ date: "2026-07-30", count: 4 }] };

describe("Decisions card", () => {
	it("shows the decision's topic title, opening that memory in a new tab", () => {
		const html = decisionsHtml(DECISIONS);
		expect(html).toContain("<strong>Verify before documenting an exact ticket match</strong>");
		expect(html).toContain('class="dec-jump"');
		// The SAME deep link the memory's own row carries, so the decision and the
		// row lead to one place. `detailRepo`, not `repo`: it names the owning repo
		// without scoping the Memories tree to it.
		expect(html).toContain("/memories?");
		expect(html).toContain("hash=h1&detailRepo=https%3A%2F%2Fgithub.com%2Fjolliai%2Fjolliai");
		expect(html).toContain('target="_blank" rel="noopener"');
	});

	it("lands on the memory's topics, at the same anchor the feed's count uses", () => {
		// `#what-changed` is the topics section's own header in `memories.js`. One
		// anchor serves both callers, and neither can address anything finer: the
		// feed's chip knows a decision COUNT, and `DecisionRecord` carries no topic
		// index — `buildDecisionsCard`'s ordering settles which topic it MEANS, not
		// where the link goes.
		expect(decisionsHtml(DECISIONS)).toContain(
			'href="/memories?repo=jolliai&range=month&dimension=model&hash=h1&detailRepo=https%3A%2F%2Fgithub.com%2Fjolliai%2Fjolliai#what-changed"',
		);
	});

	// The card used to render the whole decisions block through an inline-only
	// markdown renderer — measured at ~1,900 characters on a real memory.
	it("renders no decision prose and no quote marks", () => {
		const html = decisionsHtml({ ...DECISIONS, latest: { ...LATEST, text: "picked sqlite because…" } });
		expect(html).not.toContain("picked sqlite");
		expect(html).not.toContain("“");
		expect(html).not.toContain("undefined");
	});

	// Needs a payload carrying neither a topic title nor a parseable decision
	// line — an empty quote block would be worse than none.
	it("omits the quote entirely when the title came back empty", () => {
		expect(decisionsHtml({ ...DECISIONS, latest: { ...LATEST, title: "" } })).not.toContain("dec-quote");
	});

	it("renders the card with no quote at all when the window holds no decisions", () => {
		const html = decisionsHtml({ keptCount: 0, repoCount: 0, perDay: [] });
		expect(html).toContain("0 kept");
		expect(html).not.toContain("dec-quote");
	});
});

/**
 * The per-row agent marks. Skills leads its rows with them; the two MCP lists
 * keep text in the trailing slot they already spend on counts. Those are two
 * different slots on opposite sides of the label, which is what `rankedList`'s
 * `leadHtmlOf` / `kindHtmlOf` pair is for — the marks are ahead of the name in
 * the DOM, not flipped there by CSS, so these cases assert real source order.
 */
describe("agent marks on ranked rows", () => {
	const skillRow = (agents: ReadonlyArray<{ source: string; calls: number }>) => ({
		skills: [{ name: "code-review", kind: "skill", sessions: 3, calls: 4, agents }],
		skillsTotal: 1,
		skillCallsTotal: 4,
	});

	it("puts one brand mark per agent on a skill row, naming each", () => {
		const html = usageHtml("Skills", skillRow([{ source: "claude", calls: 3 }]));
		// Claude's mark is its own hex on both themes, so the hue is part of the
		// contract, not a token.
		expect(html).toContain('stroke="#D97757"');
		// The name is not lost with the text — it is the mark's tooltip and its
		// accessible name.
		expect(html).toContain('role="img" title="claude" aria-label="claude"');
		// And the bare source name no longer sits in the row as text.
		expect(html).not.toContain('<span class="rl-kind">claude</span>');
	});

	it("emits the mark ahead of the skill name in the markup, not just on screen", () => {
		const html = usageHtml("Skills", skillRow([{ source: "claude", calls: 3 }]));
		expect(html).toContain('<div class="rl-top"><span class="rl-lead">');
		// A CSS `order` flip would pass a screenshot and fail this: what a screen
		// reader announces and what a copy-paste yields is the source order.
		expect(html.indexOf("rl-lead")).toBeLessThan(html.indexOf("rl-name"));
	});

	// The lead is a fixed-width COLUMN, so a row with no agents still reserves it
	// — dropping the span would put that row's name 40px left of its neighbours'.
	it("reserves the lead column on a row with no agents", () => {
		const html = usageHtml("Skills", skillRow([]));
		expect(html).toContain('<div class="rl-top"><span class="rl-lead"></span>');
		expect(html).not.toContain("src-mark");
	});

	// Past two agents the lead collapses, because a lead that grows with the
	// agent count is what makes the name column ragged.
	it("collapses past two agents into the leader's mark plus a counter", () => {
		const html = usageHtml(
			"Skills",
			skillRow([
				{ source: "claude", calls: 30 },
				{ source: "codex", calls: 8 },
				{ source: "cursor", calls: 2 },
			]),
		);
		// The leader keeps its mark; the other two become "+2".
		expect(html).toContain('stroke="#D97757"');
		expect(html).toContain(">+2</span>");
		expect(html).not.toContain('stroke="#10A37F"');
		// Their names are the counter's tooltip rather than being dropped.
		expect(html).toContain('title="codex, cursor"');
	});

	it("shows both marks at exactly two agents, with no counter", () => {
		const html = usageHtml(
			"Skills",
			skillRow([
				{ source: "claude", calls: 30 },
				{ source: "codex", calls: 8 },
			]),
		);
		expect(html).toContain('stroke="#D97757"');
		expect(html).toContain('stroke="#10A37F"');
		expect(html).not.toContain("src-more");
	});

	it("keeps the server's order when two agents ran one skill", () => {
		const html = usageHtml(
			"Skills",
			skillRow([
				{ source: "codex", calls: 30 },
				{ source: "claude", calls: 4 },
			]),
		);
		// `sortAgents` ranks by volume, so codex leads — the marks must not resort.
		expect(html.indexOf('stroke="#10A37F"')).toBeLessThan(html.indexOf('stroke="#D97757"'));
	});

	// Kimi ships no mark on any surface yet. The row must still say who ran it.
	it("falls back to the agent's initial when no mark ships for it", () => {
		const html = usageHtml("Skills", skillRow([{ source: "kimi", calls: 2 }]));
		expect(html).toContain('<span class="src-letter" aria-hidden="true">K</span>');
		expect(html).toContain('aria-label="kimi"');
	});

	// The MCP lists keep TEXT in the trailing slot, and it still goes through
	// JD.esc — that slot stopped escaping for them when it started taking markup.
	it("leaves the MCP lists on escaped text after the name", () => {
		const html = usageHtml("MCPs", {
			servers: [
				{ server: "<img src=x>", sessions: 2, calls: 30, tools: 3, agents: [{ source: "codex", calls: 30 }] },
			],
			serversTotal: 1,
			serverCallsTotal: 30,
		});
		expect(html).toContain('<span class="rl-kind">3 tools · codex</span>');
		expect(html).not.toContain("<img src=x>");
		// And no lead: an MCP row's agent stays inside that text, so the lead slot
		// is Skills-only rather than something every list grew.
		expect(html).not.toContain("rl-lead");
		expect(html.indexOf("rl-name")).toBeLessThan(html.indexOf("rl-kind"));
	});
});

describe("MCPs card footer", () => {
	const withServers = (over: Record<string, unknown> = {}) =>
		usageHtml("MCPs", {
			servers: [{ server: "jollimemory", sessions: 2, calls: 30, tools: 3, agents: [] }],
			serversTotal: 1,
			serverCallsTotal: 30,
			sessionsWithTools: 2,
			sessionsInWindow: 9,
			...over,
		});

	it("says only how many sessions the figures came from", () => {
		const html = withServers();
		// The note ends where the sentence ends — nothing follows it in the footer.
		expect(html).toContain(
			'<span class="w-measure mcp-card-note">ⓘ from <b>2</b> of 9 sessions in this window</span>',
		);
	});

	// The caveats removed from these cards. Each is asserted separately because
	// they came from different branches of the old note.
	it("drops the uncovered-sources, recall-scope and reconstructed-history caveats", () => {
		const html = withServers({
			uncoveredSources: ["copilot-chat"],
			recallCalls: { calls: 4, sessions: 2 },
		});
		expect(html).not.toContain("record no tool calls");
		expect(html).not.toContain("MCP-tool calls only");
		expect(html).not.toContain("reconstructed from commits");
		// The recall LINE above the list is a different figure and stays.
		expect(html).toContain("recall calls");
	});

	// The uncovered-sources caveat is gone from EVERY branch now, empty states
	// included — it named a parser capability where a reader expects data, in a
	// footer that already states its own denominator. The server still computes
	// `uncoveredSources`; nothing prints it.
	it.each(["Skills", "MCPs"] as const)("prints no uncovered-sources caveat on the %s card", (label) => {
		const populated = usageHtml(label, {
			skills: [{ name: "jolli-recall", kind: "skill", sessions: 1, calls: 2, agents: [] }],
			skillsTotal: 1,
			skillCallsTotal: 2,
			uncoveredSources: ["copilot-chat"],
		});
		const empty = usageHtml(label, { skills: [], servers: [], uncoveredSources: ["copilot-chat"] });
		for (const html of [populated, empty]) {
			expect(html).not.toContain("record no tool calls");
			expect(html).not.toContain("will not appear here");
			expect(html).not.toContain("copilot-chat");
		}
		expect(empty).toContain("recorded in this window.");
	});

	// `<b>` is opened before the numerator and closed by "</b> of ", so the
	// singular branch used to emit a second, unpaired `</b>`. Browsers swallow
	// it, which is why it survived — assert the tags balance rather than the
	// prose.
	it("balances its bold tags on the singular session count", () => {
		const html = usageHtml("Skills", {
			skills: [{ name: "jolli-recall", kind: "skill", sessions: 1, calls: 2, agents: [] }],
			skillsTotal: 1,
			skillCallsTotal: 2,
			sessionsWithTools: 1,
			sessionsInWindow: 1,
		});
		const foot = html.slice(html.indexOf("w-foot"));
		expect(foot).toContain("of 1 session in this window");
		expect((foot.match(/<b>/g) ?? []).length).toBe((foot.match(/<\/b>/g) ?? []).length);
	});
});

describe("ranked list bars", () => {
	// The bug this pins is a two-layer one, and the renderer owns the second layer:
	// the server ranks the MCP lists by calls now, but `rankedList` used `rows[0]`
	// as the denominator, so ANY list whose order is not its bar metric painted
	// widths above 100% — which `.rl-bar`'s `overflow: hidden` clamps into a
	// full bar instead of showing as broken.
	it("sizes MCP server bars against the busiest row, proportionally", () => {
		const html = usageHtml("MCPs", {
			servers: [
				{ server: "codegraph", sessions: 27, calls: 150, tools: 1, agents: [{ source: "codex", calls: 150 }] },
				{ server: "dbhub", sessions: 9, calls: 75, tools: 7, agents: [{ source: "codex", calls: 75 }] },
				{ server: "jollimemory", sessions: 32, calls: 30, tools: 3, agents: [{ source: "claude", calls: 30 }] },
			],
			mcpAgents: [{ source: "codex", sessions: 2, calls: 225 }],
		});
		expect(barWidths(html)).toEqual([100, 50, 20]);
		expect(html.indexOf("codegraph")).toBeLessThan(html.indexOf("jollimemory"));
	});

	it("never emits a bar past 100% when rank order and bar metric disagree", () => {
		// Skills deliberately ranks by adoption while printing runs, so its first row
		// is not its biggest value — the case that produced 219%-wide bars.
		const html = usageHtml("Skills", {
			skills: [
				{ name: "code-review", kind: "skill", sessions: 3, calls: 4, agents: [{ source: "claude", calls: 4 }] },
				{
					name: "simplify",
					kind: "skill",
					sessions: 1,
					calls: 200,
					agents: [{ source: "claude", calls: 200 }],
				},
			],
			skillAgents: [{ source: "claude", sessions: 4, calls: 204 }],
		});
		const widths = barWidths(html);
		expect(Math.max(...widths)).toBe(100);
		expect(widths).toEqual([2, 100]);
	});
});

describe("JD.withParams (shell.js)", () => {
	// The separator is the whole point: `JD.query` returns "" for an unscoped page
	// and "?repo=…" for a scoped one, and appending "&hash=…" to the empty form
	// produces a URL whose params are silently dropped.
	it("opens the query string when there is none and extends it when there is", () => {
		expect(JD.withParams("", { hash: "h1" })).toBe("?hash=h1");
		expect(JD.withParams("?repo=jolliai", { hash: "h1" })).toBe("?repo=jolliai&hash=h1");
	});
	it("url-encodes values and drops empty ones", () => {
		expect(JD.withParams("", { hash: "h1", detailRepo: "https://github.com/jolliai/jolliai" })).toBe(
			"?hash=h1&detailRepo=https%3A%2F%2Fgithub.com%2Fjolliai%2Fjolliai",
		);
		expect(JD.withParams("?repo=x", { hash: "", detailRepo: undefined })).toBe("?repo=x");
	});
});

/** The Spend card, sliced out of the rendered stats page. */
function spendHtml(statsOver: Record<string, unknown>): string {
	app.innerHTML = "";
	JD.renderStats(model({}, statsOver));
	const html = app.innerHTML;
	const start = html.indexOf('aria-label="Spend"');
	expect(start).toBeGreaterThan(-1);
	return html.slice(start, html.indexOf("</section>", start));
}

/**
 * One ordinary day plus the day that used to break the card: real cost, but
 * every series key at zero tokens. Cost is apportioned by token share, so that
 * day draws no bar at all — and the headline must not claim it either.
 */
const SPEND_SERIES = {
	seriesKeys: ["alpha", "beta"],
	series: [
		{ date: "2026-07-29", tokens: 100, estCostUsd: 4, bySeries: { alpha: 60, beta: 40 } },
		{ date: "2026-07-30", tokens: 0, estCostUsd: 5, bySeries: { alpha: 0, beta: 0 } },
	],
};

describe("Spend card — headline, legend and footer read one source", () => {
	it("totals what the bars draw, not `estCostUsd`, so an undrawable day cannot inflate it", () => {
		const html = spendHtml(SPEND_SERIES);
		// 4.00 is the drawn total; 9.00 would be the sum of estCostUsd.
		expect(html).toContain("$4.00");
		expect(html).not.toContain("$9.00");
	});

	it("splits the headline across the legend exactly", () => {
		const html = spendHtml(SPEND_SERIES);
		expect(html).toContain("$2.40"); // alpha: 60/100 of the drawn $4.00
		expect(html).toContain("$1.60"); // beta:  40/100
	});

	it("names a busiest day that cannot exceed the headline", () => {
		const html = spendHtml(SPEND_SERIES);
		// Asserted POSITIVELY on purpose. The undrawable day carries the larger
		// `estCostUsd` ($5.00), so a footer reading that field would name a
		// busiest day worth more than the whole window — but it would also read
		// `estCostUsd` off the apportioned series, where the field does not
		// exist, and render no footer at all. A `not.toContain` passes on that.
		expect(html).toContain("busiest day");
		expect(html).toContain("2026-07-29 · $4.00");
	});

	it("states which clock the series is on", () => {
		expect(spendHtml({ ...SPEND_SERIES, seriesDimension: "branch" })).toContain("by commit date");
		expect(spendHtml({ ...SPEND_SERIES, seriesDimension: "category" })).toContain("by commit date");
		// Not the requested dimension — the effective one. Below the memory tier a
		// memory axis falls back to `model`, and the label has to follow it.
		expect(spendHtml({ ...SPEND_SERIES, seriesDimension: "model" })).toContain("by session activity");
		expect(spendHtml({ ...SPEND_SERIES, seriesDimension: "agent" })).toContain("by session activity");
	});

	it("names the axis it actually drew, in both places it says one", () => {
		// Both the chart's aria-label and the "largest …" figure said "model" on
		// every axis, so `?dimension=branch` announced a branch name as a model.
		const branch = spendHtml({ ...SPEND_SERIES, seriesDimension: "branch" });
		expect(branch).toContain("estimated spend by branch");
		expect(branch).toContain("largest branch");
		expect(branch).not.toContain("model");
		const project = spendHtml({ ...SPEND_SERIES, seriesDimension: "project" });
		expect(project).toContain("estimated spend by project");
		expect(project).toContain("largest project");
		// The effective dimension, not the requested one — same rule as the clock
		// note above, and the case that has to keep saying "model".
		const model = spendHtml({ ...SPEND_SERIES, seriesDimension: "model" });
		expect(model).toContain("estimated spend by model");
		expect(model).toContain("largest model");
	});

	it("degrades an unknown dimension to a neutral noun rather than a wrong one", () => {
		// An older page against a newer server. Naming the axis wrongly is worse
		// than not naming it, and `constructor` is the shape that would hand back
		// an inherited value from a plain-object lookup table.
		for (const dim of ["quantum", "constructor"]) {
			const html = spendHtml({ ...SPEND_SERIES, seriesDimension: dim });
			expect(html).toContain("estimated spend by series");
			expect(html).toContain("largest series");
			expect(html).not.toContain("function Object");
		}
	});

	it("renders no stray undefined or NaN", () => {
		const html = spendHtml(SPEND_SERIES);
		expect(html).not.toContain("undefined");
		expect(html).not.toContain("NaN");
	});
});

describe("Memory Activity — subtitle counts the page, and says so", () => {
	const twoCards = [CARD, { ...CARD, commitHash: "h2" }];

	it("counts the window when the list is NOT capped", () => {
		const html = feedHtml(model({}, { memoryCards: twoCards, memoryCardsCapped: false }));
		expect(html).toContain("2 memories in this window");
		// Claiming a truncation that did not happen is its own inaccuracy.
		expect(html).not.toContain("showing the");
	});

	it("says 'showing the N most recent' only when the server capped the list", () => {
		const html = feedHtml(model({}, { memoryCards: twoCards, memoryCardsCapped: true }));
		expect(html).toContain("showing the 2 most recent");
		// The original wording printed the page size as though it were the window
		// total, directly above the coverage line that prints the real one.
		expect(html).not.toContain("memories in this window");
	});

	it("keeps the uncapped singular readable", () => {
		const html = feedHtml(model({}, { memoryCards: [CARD], memoryCardsCapped: false }));
		expect(html).toContain("1 memory in this window");
		expect(html).not.toContain("1 memories");
	});
});

/** Axis tick labels, in draw order (bottom gridline first). */
function axisTicks(svg: string): ReadonlyArray<string> {
	return [...svg.matchAll(/class="num">([^<]*)<\/text>/g)].map((m) => m[1]);
}

/** Every `var(--sN)` fill in the legend, in render order. */
function legendColors(html: string): ReadonlyArray<string> {
	const legend = html.slice(
		html.indexOf('<div class="legend'),
		html.indexOf("</div>", html.indexOf('<div class="legend')),
	);
	return [...legend.matchAll(/background:(var\(--s\d\))/g)].map((m) => m[1]);
}

const DAY = (date: string, bySeries: Record<string, number>) => ({ date, bySeries });

describe("JD.stackedBars — the caller owns the unit", () => {
	it("formats the axis and the tooltip with the supplied formatter", () => {
		const svg = JD.stackedBars([DAY("2026-07-29", { a: 2.4 })], ["a"], "spend", JD.fmtUsd);
		// The defect: one chart function served both cards and hardcoded the token
		// formatter, so money lost its `$` and its cents.
		expect(axisTicks(svg).every((t) => t.startsWith("$"))).toBe(true);
		expect(svg).toContain("· a · $2.40");
		expect(svg).not.toContain("· a · 2.4<");
	});

	it("still formats tokens when no formatter is passed", () => {
		const svg = JD.stackedBars([DAY("2026-07-29", { a: 1_200_000 })], ["a"], "tokens");
		expect(svg).toContain("· a · 1.2M");
		expect(axisTicks(svg).some((t) => t.endsWith("M"))).toBe(true);
		expect(svg).not.toContain("$");
	});

	it("lands the axis on round ticks and never clips the tallest bar", () => {
		// 8.7M used to read 0 / 2.2M / 4.3M / 6.5M / 8.7M — four arbitrary numbers.
		const svg = JD.stackedBars([DAY("2026-07-29", { a: 8_700_000 })], ["a"], "tokens");
		expect(axisTicks(svg)).toEqual(["0", "2.5M", "5.0M", "7.5M", "10.0M"]);
	});

	it("scales the step to the data, so a sub-dollar window is not flattened", () => {
		// Regression on the seed, not just the ladder: the bar loop started `max`
		// at 1, a "one token" floor that drew every sub-$1 window against a $1
		// axis — four ticks of headroom above a $0.37 chart.
		const svg = JD.stackedBars([DAY("2026-07-29", { a: 0.37 })], ["a"], "spend", JD.fmtUsd);
		expect(axisTicks(svg)).toEqual(["$0.00", "$0.10", "$0.20", "$0.30", "$0.40"]);
	});

	it("survives a series key that shadows Object.prototype", () => {
		// `topSeries` was hardened for this and hands a SHORT series straight back,
		// so the raw JSON.parse'd object — prototype and all — reaches this function
		// unchanged. `|| 0` then treats the inherited `constructor` function as a
		// value on the day it is absent: it clears the `<= 0` guard, and every
		// geometry expression downstream of it becomes NaN.
		const svg = JD.stackedBars(
			[DAY("2026-07-29", { constructor: 40 }), DAY("2026-07-30", { a: 60 })],
			["constructor", "a"],
			"tokens",
		);
		expect(svg).not.toContain("NaN");
		expect(svg).toContain("· constructor · 40");
		expect(axisTicks(svg)).toEqual(["0", "20", "40", "60", "80"]);
	});

	it("keeps the no-data axis on integers", () => {
		// The seed moved into `niceAxisMax`, so this is the case that would
		// otherwise read 0 / 0.25 / 0.5 / 0.75 / 1 tokens.
		expect(axisTicks(JD.stackedBars([DAY("2026-07-29", { a: 0 })], ["a"], "tokens"))).toEqual([
			"0",
			"1",
			"2",
			"3",
			"4",
		]);
	});
});

describe("JD.topSeries — ranked head plus a conserving Other bucket", () => {
	const wide = {
		keys: Array.from({ length: 23 }, (_, i) => `branch-${i}`),
		series: [DAY("2026-07-29", Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`branch-${i}`, i + 1])))],
	};

	it("caps the visible series at limit + Other", () => {
		const top = JD.topSeries(wide.series, wide.keys, 4);
		expect(top.keys).toHaveLength(5);
		expect(top.keys[top.keys.length - 1]).toBe("Other");
		// Ranked by total, so the largest series keeps the first colour.
		expect(top.keys.slice(0, 4)).toEqual(["branch-22", "branch-21", "branch-20", "branch-19"]);
	});

	it("conserves the total — the tail is merged, never dropped", () => {
		const top = JD.topSeries(wide.series, wide.keys, 4);
		const before = wide.keys.reduce((sum, k) => sum + wide.series[0].bySeries[k], 0);
		const after = top.keys.reduce((sum, k) => sum + top.series[0].bySeries[k], 0);
		// 1..23. Dropping the tail instead of merging would lose 190 of 276 —
		// and make the Spend headline smaller than its own chart.
		expect(before).toBe(276);
		expect(after).toBe(276);
		expect(top.byKey.Other).toBe(190);
	});

	it("passes a short series through untouched, with no Other bucket", () => {
		const short = [DAY("2026-07-29", { a: 1, b: 2 })];
		const top = JD.topSeries(short, ["a", "b"], 4);
		expect(top.keys).toEqual(["a", "b"]);
		expect(top.series).toBe(short);
		expect(top.byKey).toEqual({ a: 1, b: 2 });
	});

	it("survives a series key that shadows Object.prototype", () => {
		// A branch really can be called `constructor`. Against a plain object the
		// lookup hands back an inherited function, `+=` writes NaN, and the series
		// silently vanishes from the chart.
		const nasty = [DAY("2026-07-29", { constructor: 5, toString: 3, a: 1 })];
		const top = JD.topSeries(nasty, ["constructor", "toString", "a"], 2);
		expect(top.keys).toEqual(["constructor", "toString", "Other"]);
		expect(top.byKey.constructor).toBe(5);
		expect(top.byKey.Other).toBe(1);
	});

	it("does not let a series named Other collide with the roll-up bucket", () => {
		// Series keys are user-controlled — a branch or a repo really can be named
		// `Other`. Reusing the literal destroyed it in three places at once: its
		// total was overwritten by the bucket's, its daily value was overwritten
		// per point, and `keys` listed one string twice — so the legend drew two
		// identical swatches and `stackedBars` summed that segment twice, lifting
		// every bar and the axis above a headline computed before the roll-up.
		const clash = [DAY("2026-07-29", { Other: 10, b: 4, c: 3, d: 2, e: 1 })];
		const top = JD.topSeries(clash, ["Other", "b", "c", "d", "e"], 4);
		expect(new Set(top.keys).size).toBe(top.keys.length);
		// The real series keeps rank, colour and its own total.
		expect(top.keys[0]).toBe("Other");
		expect(top.byKey.Other).toBe(10);
		// The bucket lands beside it under a free name, holding only the tail.
		const bucket = top.keys[top.keys.length - 1];
		expect(bucket).not.toBe("Other");
		expect(top.byKey[bucket]).toBe(1);
		// Conservation still holds, which is the property the whole roll-up exists for.
		expect(top.keys.reduce((sum, k) => sum + top.series[0].bySeries[k], 0)).toBe(20);
	});
});

describe("Spend card — the chart is readable back to its legend", () => {
	const wideSpend = {
		seriesKeys: Array.from({ length: 23 }, (_, i) => `branch-${i}`),
		series: [
			{
				date: "2026-07-29",
				tokens: 276,
				estCostUsd: 27.6,
				bySeries: Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`branch-${i}`, i + 1])),
			},
		],
	};

	it("shows at most five series and never reuses a colour", () => {
		const colors = legendColors(spendHtml(wideSpend));
		expect(colors).toHaveLength(5);
		// The bug: seriesColor cycles a five-colour palette, so 23 series reused
		// every colour ~5x and the stack could not be read back.
		expect(new Set(colors).size).toBe(5);
	});

	it("keeps the headline equal to the bars after the roll-up", () => {
		const html = spendHtml(wideSpend);
		// Rolling up must not change the total: $27.60 is the whole window.
		expect(html).toContain("$27.60");
		expect(html).toContain("Other");
	});

	it("renders the axis in dollars", () => {
		expect(axisTicks(spendHtml(SPEND_SERIES)).every((t) => t.startsWith("$"))).toBe(true);
	});
});
