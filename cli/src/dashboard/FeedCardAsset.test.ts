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
	scopeChip: (model: unknown) => string;
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
		scope: { kind: "repo", repoIdentity: "https://github.com/jolliai/jolliai" },
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
			recentSessions: [],
			memoryCards: [CARD],
			range: "month",
			rangeFrom: "2026-07-01",
			rangeTo: "2026-07-30",
			toolUsage: {
				skills: [],
				servers: [],
				sessionsWithTools: 0,
				sessionsInWindow: 0,
				sourcesWithoutToolData: [],
			},
			recallUsage: {
				usedCalls: 0,
				setAsideCalls: 0,
				contextServedPct: 0,
				distinctMemoriesUsed: 0,
				staleMemoriesUsed: 0,
				sessionsWithContext: 0,
				callsWithoutSession: 0,
				sessionsInWindow: 0,
				bySurface: [],
				skillInvocations: 0,
				daily: [],
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

	it("shows captured/gap/decision counts when the backend supplies coverage data", () => {
		const html = feedHtml(model({}, { memoriesCreated: 110, totalCommits: 173, decisionsCaptured: 48 }));
		expect(html).toContain('<div class="mas-item"><b class="num">110</b><span>of 173 captured</span></div>');
		expect(html).toContain('<div class="mas-item mas-warn"><b class="num">63</b><span>gaps</span></div>');
		expect(html).toContain('<div class="mas-item"><b class="num">48</b><span>decisions</span></div>');
	});

	it("omits the gap chip when every commit in the window is captured", () => {
		const html = feedHtml(model({}, { memoriesCreated: 5, totalCommits: 5, decisionsCaptured: 2 }));
		expect(html).toContain("of 5 captured");
		expect(html).not.toContain("mas-warn");
	});

	it("renders no coverage row when the backend hasn't supplied it", () => {
		expect(feedHtml(model())).not.toContain("mem-activity-stats");
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

describe("scope chip", () => {
	it("names the repo and the window instead of saying 'this repo'", () => {
		expect(JD.scopeChip(model())).toBe('<span class="chip" style="cursor:default">jolliai · this month</span>');
	});

	it("says 'all repos' when the page is not scoped", () => {
		expect(JD.scopeChip(model({ scope: { kind: "all" } }))).toContain("all repos · this month");
	});

	it("states its bounds for a custom range, which has no short name", () => {
		expect(JD.scopeChip(model({}, { range: "custom" }))).toContain("jolliai · 2026-07-01 – 2026-07-30");
	});

	it("falls back to the identity when the repo is no longer listed", () => {
		expect(JD.scopeChip(model({ repos: [] }))).toContain("https://github.com/jolliai/jolliai");
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

/** The Recall card, sliced out of the same rendered page. */
function recallHtml(recallUsage: Record<string, unknown>): string {
	app.innerHTML = "";
	JD.renderStats(
		model(
			{},
			{
				recallUsage: {
					usedCalls: 0,
					setAsideCalls: 0,
					contextServedPct: 0,
					distinctMemoriesUsed: 0,
					staleMemoriesUsed: 0,
					sessionsWithContext: 0,
					sessionsInWindow: 0,
					bySurface: [],
					skillInvocations: 0,
					daily: [],
					...recallUsage,
				},
			},
		),
	);
	const html = app.innerHTML;
	const start = html.indexOf('aria-label="Recall"');
	expect(start).toBeGreaterThan(-1);
	return html.slice(start, html.indexOf("</section>", start));
}

describe("Recall card", () => {
	it("invites a CLI run in the empty state — recall is no longer MCP-only", () => {
		const html = recallHtml({});
		expect(html).toContain("No recall calls recorded in this window");
		expect(html).toContain("jolli recall");
		expect(html).not.toContain("Only Claude transcripts");
	});

	it("names the skill runs that never recalled, when that is all there is", () => {
		expect(recallHtml({ skillInvocations: 2 })).toContain("without recalling anything");
	});

	it("splits served calls by the surface that answered them", () => {
		const html = recallHtml({
			usedCalls: 3,
			setAsideCalls: 1,
			contextServedPct: 75,
			sessionsWithContext: 2,
			sessionsInWindow: 4,
			bySurface: [
				{ surface: "mcp", calls: 3 },
				{ surface: "cli", calls: 1 },
			],
			daily: [{ date: "2026-07-30", used: 3, setAside: 1 }],
		});
		expect(html).toContain("3 used");
		// The footnote is ONE line now — the coverage ratio. The surface split moved
		// into the ⓘ's hover, as plain text (a `title` attribute renders no tags).
		expect(html).toContain("<b>2</b> of 4 sessions got prior context");
		expect(html).toContain("3 via the recall tool, 1 via the CLI");
		expect(html).not.toContain("<b>3</b> via the recall tool");
		// Two sessions DO account for the calls here, so the session-less caveat
		// does not apply and must not be raised.
		expect(html).not.toContain("belongs to no session");
		expect(html).not.toContain("undefined");
		expect(html).not.toContain("NaN");
	});

	it("raises the session-less caveat exactly when such a call exists", () => {
		const withSessions = recallHtml({
			usedCalls: 2,
			setAsideCalls: 0,
			contextServedPct: 100,
			sessionsWithContext: 2,
			callsWithoutSession: 0,
			sessionsInWindow: 3,
			bySurface: [{ surface: "cli", calls: 2 }],
			daily: [{ date: "2026-07-30", used: 2, setAside: 0 }],
		});
		expect(withSessions).not.toContain("belonging to no session");
		// `jolli recall` from a plain shell, or a host that publishes no session id.
		const sessionless = recallHtml({
			usedCalls: 2,
			setAsideCalls: 0,
			contextServedPct: 100,
			sessionsWithContext: 0,
			callsWithoutSession: 2,
			sessionsInWindow: 3,
			bySurface: [{ surface: "cli", calls: 2 }],
			daily: [{ date: "2026-07-30", used: 2, setAside: 0 }],
		});
		expect(sessionless).toContain("2 recalls ran outside an agent session");
	});

	it("raises it in a MIXED window too — the case the old condition stayed silent for", () => {
		// The condition used to be `sessionsWithContext === 0`, which reads as "no
		// session claims these calls" but means "not ONE receipt names a session".
		// A window with both kinds of call — the very situation the caveat exists to
		// explain — therefore never showed it.
		const mixed = recallHtml({
			usedCalls: 5,
			setAsideCalls: 0,
			contextServedPct: 100,
			sessionsWithContext: 3,
			callsWithoutSession: 1,
			sessionsInWindow: 4,
			bySurface: [{ surface: "cli", calls: 5 }],
			daily: [{ date: "2026-07-30", used: 5, setAside: 0 }],
		});
		expect(mixed).toContain("1 recall ran outside an agent session");
	});

	it("says `call is` for one receipt-less call and `calls are` for several", () => {
		const one = recallHtml({
			usedCalls: 1,
			setAsideCalls: 0,
			contextServedPct: 100,
			callsWithoutReceipt: 1,
			bySurface: [{ surface: "cli", calls: 1 }],
			daily: [{ date: "2026-07-30", used: 1, setAside: 0 }],
		});
		expect(one).toContain("1 further call is in the transcripts");
		const many = recallHtml({
			usedCalls: 1,
			setAsideCalls: 0,
			contextServedPct: 100,
			callsWithoutReceipt: 3,
			bySurface: [{ surface: "cli", calls: 1 }],
			daily: [{ date: "2026-07-30", used: 1, setAside: 0 }],
		});
		expect(many).toContain("3 further calls are in the transcripts");
	});

	it("flags skill runs that outnumber the recalls they were supposed to make", () => {
		const html = recallHtml({
			usedCalls: 1,
			setAsideCalls: 0,
			contextServedPct: 100,
			skillInvocations: 4,
			bySurface: [{ surface: "mcp", calls: 1 }],
			daily: [{ date: "2026-07-30", used: 1, setAside: 0 }],
		});
		// In the hover detail now, and reworded to fit a plain-text attribute.
		expect(html).toContain("the jolli-recall skill ran 4×, more often than recall was called");
	});

	it("stays quiet about the skill when every invocation did recall", () => {
		const html = recallHtml({
			usedCalls: 2,
			setAsideCalls: 0,
			contextServedPct: 100,
			skillInvocations: 2,
			bySurface: [{ surface: "mcp", calls: 2 }],
			daily: [{ date: "2026-07-30", used: 2, setAside: 0 }],
		});
		expect(html).not.toContain("more often than recall");
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
