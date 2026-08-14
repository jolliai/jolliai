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

interface JDNamespace {
	renderStats: (model: unknown) => void;
	repoToken: (model: unknown, identity: string) => string;
	withParams: (query: string, params: Record<string, string | undefined>) => string;
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
			kpis: [],
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
		expect(html).toContain("Open memory →");
		// `detailRepo`, not `repo`: the link names which repo owns the memory
		// without scoping the Memories tree to it (see wireTree in memories.js).
		expect(html).toContain("&hash=h1&detailRepo=https%3A%2F%2Fgithub.com%2Fjolliai%2Fjolliai");
		expect(html).toContain('" target="_blank" rel="noopener">Open memory →');
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
		expect(feedHtml(model({}, { memoryCards: [{ ...CARD, decisionCount: 3 }] }))).toContain("3 decisions</span>");
		expect(feedHtml(model({}, { memoryCards: [{ ...CARD, decisionCount: 1 }] }))).toContain("1 decision</span>");
	});

	// Absent, not zero: the server omits the field when the commit recorded none,
	// and a row of zeros is noise beside the chips that are already conditional.
	it("prints no decision chip when the commit recorded none", () => {
		const html = feedHtml(model());
		expect(html).not.toContain("decisions</span>");
		expect(html).not.toContain("decision</span>");
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

describe("equal-third card subtitles", () => {
	/** A card's tooltip text with the hard wraps taken back out. */
	const hintOf = (label: string): string => {
		const title = /title="([^"]*)"/.exec(headOf(label));
		expect(title, label).not.toBeNull();
		return (title as RegExpExecArray)[1].split("&#10;").join(" ");
	};

	/** The tooltip's lines, as the browser will break them. */
	const hintLines = (label: string): string[] =>
		((/title="([^"]*)"/.exec(headOf(label)) as RegExpExecArray)[1] || "").split("&#10;");

	const headOf = (label: string): string => {
		app.innerHTML = "";
		JD.renderStats(model());
		const start = app.innerHTML.indexOf(`aria-label="${label}"`);
		expect(start, label).toBeGreaterThan(-1);
		// To the end of the head's title block — `</div></div>` closes the
		// title wrapper and, for a hover card, the card-head with it.
		const h2 = app.innerHTML.indexOf("<h2", start);
		return app.innerHTML.slice(start, app.innerHTML.indexOf("</div></div>", h2) + "</div></div>".length);
	};

	it("puts the Skills explanation in the title's tooltip", () => {
		const head = headOf("Skills");
		expect(head).toContain('class="has-hint"');
		expect(hintOf("Skills")).toContain("Skill invocations, counted from the tool calls");
		// Scope claim, pinned: only `Skill` tool calls become skill rows — a
		// subagent is the `Task` builtin and a slash command is never a tool call
		// — so the copy must not widen to either without the classifier widening.
		expect(head).not.toContain("command");
		expect(head).not.toContain('<div class="sub">');
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
		expect(head).not.toContain('<div class="sub">');
	});

	it("explains what Tokens counts, and no longer restates the window", () => {
		// `Last 30 days` came off the card: the topbar range control is the one
		// place the window is set, and it says so there. What the tooltip carries
		// instead is the thing the bars cannot show — why this card counts tokens
		// while Spend counts dollars.
		const head = headOf("Tokens");
		expect(head).toContain('class="has-hint"');
		expect(hintOf("Tokens")).toContain("Cache reads bill at 10% of input");
		expect(hintOf("Tokens")).toContain("this widget counts tokens and Spend counts dollars");
		expect(head).not.toContain("Last 30 days");
		expect(head).not.toContain('<div class="sub">');
	});

	it("hard-wraps every tooltip — a native one does not wrap itself", () => {
		// Unwrapped, a two-sentence hint renders as one line that runs past the
		// card and off the viewport.
		for (const label of ["Skills", "MCPs", "Tokens"]) {
			const lines = hintLines(label);
			expect(lines.length, label).toBeGreaterThan(1);
			for (const line of lines) expect(line.length, `${label}: ${line}`).toBeLessThanOrEqual(70);
		}
	});

	it("breaks only between words", () => {
		// The wrap is by character count against a font the page cannot measure,
		// so word boundaries are what keep it acceptable.
		for (const label of ["Skills", "MCPs", "Tokens"]) {
			for (const line of hintLines(label)) {
				expect(line.startsWith(" "), label).toBe(false);
				expect(line.endsWith(" "), label).toBe(false);
			}
		}
	});

	it("leaves no visible subtitle on any card in the band", () => {
		for (const label of ["Skills", "MCPs", "Tokens"]) {
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
		expect(app.innerHTML).toContain("Open memory →");
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

	// The three caveats JOLLI-2191 removed. Each is asserted separately because
	// they came from three different branches of the old note.
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

	// The empty state is a different element with no session count to trim to,
	// so it keeps the caveat that says why the list may be short.
	it("keeps the coverage caveat in the empty state", () => {
		const html = usageHtml("MCPs", { servers: [], uncoveredSources: ["copilot-chat"] });
		expect(html).toContain("No MCP calls recorded in this window.");
		expect(html).toContain("record no tool calls");
	});

	// Same helper, still printed by the other card that has one.
	it("leaves the Skills card's own caveat alone", () => {
		const html = usageHtml("Skills", {
			skills: [{ name: "jolli-recall", kind: "skill", sessions: 1, calls: 2, agents: [] }],
			skillsTotal: 1,
			skillCallsTotal: 2,
			uncoveredSources: ["copilot-chat"],
		});
		expect(html).toContain("record no tool calls");
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
