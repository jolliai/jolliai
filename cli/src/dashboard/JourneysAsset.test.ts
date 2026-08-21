/**
 * `assets/js/*.js` is plain JavaScript bundled verbatim into the served page —
 * tsc never type-checks it, so reading `journey.cost` when the model sends
 * `costUsd` renders "undefined" in the browser with no compile-time signal.
 * This evaluates the real IIFEs against a model shaped like `buildCoaching`'s
 * output, as `FeedCardAsset.test.ts` does.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RosterCell } from "./DashboardModel.js";

interface JDNamespace {
	renderCoaching: (model: unknown) => void;
	coachTiles: (coaching: Record<string, unknown>) => string;
	renderFeedInto: (body: unknown, feed: unknown, timeZone: string) => void;
	openFeedModal: () => Promise<unknown>;
	reportRow: (coaching: Record<string, unknown>) => string;
	reportExpansion: (coaching: Record<string, unknown>) => string;
	adoptCard: (items: unknown) => string;
	queueList: (items: unknown) => string;
	patternsList: (patterns: unknown, context?: unknown) => string;
	renderJourneyTrace: (detail: unknown) => void;
	renderJourneyMeta: (journey: unknown, timeZone: string, waits?: unknown) => string;
	journeyGlyph: (journey: unknown) => string;
	esc: (text: unknown) => string;
	fmtUsd: (n: number) => string;
	weekdayDate: (ms: number, timeZone: string) => string;
	query: (model: unknown, over?: Record<string, unknown>) => string;
	withParams: (query: string, params: Record<string, string | undefined>) => string;
	stageBands: (journey: unknown) => Array<{ key: string; label: string; share: number }>;
	journeyFilters: (journeys: ReadonlyArray<unknown>) => Array<{ key: string; label: string; count: number }>;
	applyJourneyFilter: (key: string) => void;
	shouldGroupByDay: (journeys: ReadonlyArray<unknown>, timeZone: string) => boolean;
}

/** Minimal element stub: enough for the renderer to write into and be read back. */
interface FakeElement {
	innerHTML: string;
	textContent: string;
	style: Record<string, string>;
	onclick?: () => void;
	/** Every class name ever passed to `classList.add` / `.remove`, in call order —
	 *  not just the current membership, so a test can tell "opened" from "never touched". */
	classList: { add: (name: string) => void; remove: (name: string) => void };
	added: string[];
	removed: string[];
	querySelectorAll: (selector?: string) => ReadonlyArray<FakeRow>;
	querySelector: () => null;
	addEventListener: (type: string, handler: () => void) => void;
}

/** A `.jrow` button (or `.jfchip` button) stub, parsed out of `#jfeedBody`'s
 *  rendered HTML by `row()`'s / `chipRow()`'s own attribute order — see
 *  `querySelectorAll` below. Both stubs share this shape. */
interface FakeRow {
	getAttribute: (name: string) => string | null;
	addEventListener: (type: string, handler: () => void) => void;
}

/**
 * Evaluates format.js → charts.js → shell.js → journeys.js in load order against
 * a stub window/document. `renderCoaching` writes into `#app`; the feed renders
 * into `#jfeedBody`, so the harness hands out recording elements for both and
 * reads them back. Mirrors `FeedCardAsset.test.ts`'s `loadJD`, adapted to load
 * `journeys.js` last (`format.js` first, or `JD.esc` is undefined when
 * `journeys.js` runs) and `charts.js` ahead of `journeys.js` so `JD.spark` is
 * defined when `reportExpansion`'s summary sparkline runs.
 *
 * `fetch` is a free variable in journeys.js's `openFeedModal`/`openTrace`,
 * exactly as it is in shell.js's poll loop (see `ToolUsagePagingAsset.test.ts`)
 * — passing it as a `Function` parameter shadows the real global for this module
 * alone. `#jfeedBody`'s `querySelectorAll(".jrow")` is parsed from whatever
 * `row()` most recently rendered, so a click wired against a stub production
 * code returned is the SAME wiring the browser would attach.
 *
 * `fetchResponse` is the body served for NON-feed fetches (`/api/journey`, the
 * trace); `feedResponse` is the body served for `/api/journeys` (the feed).
 * They are separate because a trace test needs a valid feed to render rows AND
 * a valid detail to fill the sheet — one fixed body cannot be both. `feedResponse`
 * defaults to `fetchResponse` so the single-argument calls the feed tests make
 * keep working. Both default to `{}`, which makes a downstream read throw into
 * the `.catch` — the established way this file exercises a failed fetch, since
 * `fakeFetch` always resolves `ok: true`.
 */
function loadJD(
	fetchResponse: unknown = {},
	feedResponse: unknown = fetchResponse,
): {
	JD: JDNamespace;
	app: FakeElement;
	body: FakeElement;
	sub: FakeElement;
	title: FakeElement;
	overlay: FakeElement;
	feedBody: FakeElement;
	feedOverlay: FakeElement;
	fetchCalls: string[];
	clickRow: (index: number) => void;
	clickChip: (key: string) => void;
	clickPattern: (key: string) => void;
	clickQueueItem: (index: number) => void;
	clickReportCard: (kind: string) => void;
} {
	const elements = new Map<string, FakeElement>();
	const rowHandlers: Array<() => void> = [];
	/** Keyed by `data-filter`, not position — a chip's identity IS its key, unlike
	 *  a row, which only ever carries its rendered position. */
	const chipHandlers = new Map<string, () => void>();
	const patternHandlers = new Map<string, () => void>();
	/* One handler per `.jqueue-link`, in RENDERED order — mirrors `rowHandlers`
	 *  below. `clickQueueItem(index)` fires the index-th rendered button's own
	 *  handler, which (in production) reads that SAME button's `data-index`
	 *  attribute at click time — exactly the lockstep the queue sort must not
	 *  break: rendered position `i` must resolve `queueItems[i]`, not some
	 *  other position's item. */
	const queueHandlers: Array<() => void> = [];
	/** One handler per highlight card, keyed by `data-kind` (worth-sharing /
	 *  needs-help) — the pair is not positional, so its kind is its identity. */
	const cardHandlers = new Map<string, () => void>();
	const element = (): FakeElement => {
		const added: string[] = [];
		const removed: string[] = [];
		return {
			innerHTML: "",
			textContent: "",
			style: {},
			classList: {
				add: (name: string) => added.push(name),
				remove: (name: string) => removed.push(name),
			},
			added,
			removed,
			querySelectorAll: () => [],
			querySelector: () => null,
			addEventListener: () => undefined,
		};
	};
	const appEl = element();
	appEl.querySelectorAll = (selector?: string): ReadonlyArray<FakeRow> => {
		if (selector === ".jpatterns-group-action") {
			patternHandlers.clear();
			const matches = [
				...appEl.innerHTML.matchAll(
					/<button type="button" class="jpatterns-group-action" data-pattern-key="([^"]*)"[^>]*>/g,
				),
			];
			return matches.map(([, key]) => ({
				getAttribute: (name: string) => (name === "data-pattern-key" ? key : null),
				addEventListener: (_type: string, handler: () => void) => {
					patternHandlers.set(key, handler);
				},
			}));
		}
		if (selector === ".jqueue-link") {
			queueHandlers.length = 0;
			const matches = [
				...appEl.innerHTML.matchAll(/<button type="button" class="jqueue-link" data-index="([^"]*)">/g),
			];
			return matches.map(([, index]) => ({
				getAttribute: (name: string) => (name === "data-index" ? index : null),
				addEventListener: (_type: string, handler: () => void) => {
					queueHandlers.push(handler);
				},
			}));
		}
		if (selector === ".jcard-clickable") {
			cardHandlers.clear();
			const matches = [
				...appEl.innerHTML.matchAll(/<article class="jcard jcard-clickable" data-kind="([^"]*)">/g),
			];
			return matches.map(([, kind]) => ({
				getAttribute: (name: string) => (name === "data-kind" ? kind : null),
				addEventListener: (_type: string, handler: () => void) => {
					cardHandlers.set(kind, handler);
				},
			}));
		}
		return [];
	};
	elements.set("app", appEl);
	const feedEl = element();
	feedEl.querySelectorAll = (selector?: string): ReadonlyArray<FakeRow> => {
		if (selector === ".jrow") {
			rowHandlers.length = 0;
			const matches = [...feedEl.innerHTML.matchAll(/<button class="jrow"[^>]*data-index="([^"]*)"[^>]*>/g)];
			return matches.map(([, index]) => ({
				getAttribute: (name: string) => (name === "data-index" ? index : null),
				addEventListener: (_type: string, handler: () => void) => {
					rowHandlers.push(handler);
				},
			}));
		}
		if (selector === ".jfchip") {
			chipHandlers.clear();
			const matches = [
				...feedEl.innerHTML.matchAll(/<button type="button" data-filter="([^"]*)" class="jfchip[^"]*"[^>]*>/g),
			];
			return matches.map(([, key]) => ({
				getAttribute: (name: string) => (name === "data-filter" ? key : null),
				addEventListener: (_type: string, handler: () => void) => {
					chipHandlers.set(key, handler);
				},
			}));
		}
		return [];
	};
	elements.set("jfeedBody", feedEl);
	const doc = {
		getElementById: (id: string) => {
			if (!elements.has(id)) elements.set(id, element());
			return elements.get(id);
		},
		querySelectorAll: () => [],
		querySelector: () => null,
		addEventListener: () => undefined,
		createElement: element,
		body: element(),
	};
	const win = { JD: {}, document: doc, addEventListener: () => undefined, alert: () => undefined } as Record<
		string,
		unknown
	>;
	const fetchCalls: string[] = [];
	const fakeFetch = (url: string) => {
		fetchCalls.push(url);
		const body = url.indexOf("/api/journeys") === 0 ? feedResponse : fetchResponse;
		return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
	};
	for (const file of ["format.js", "charts.js", "shell.js", "journeys.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		new Function("window", "document", "fetch", src)(win, doc, fakeFetch);
	}
	return {
		JD: win.JD as unknown as JDNamespace,
		app: doc.getElementById("app") as FakeElement,
		body: doc.getElementById("jtraceBody") as FakeElement,
		sub: doc.getElementById("jtraceSub") as FakeElement,
		title: doc.getElementById("jtraceTitle") as FakeElement,
		overlay: doc.getElementById("ovJourney") as FakeElement,
		feedBody: doc.getElementById("jfeedBody") as FakeElement,
		feedOverlay: doc.getElementById("ovFeed") as FakeElement,
		fetchCalls,
		clickRow: (index: number) => {
			const handler = rowHandlers[index];
			if (!handler) throw new Error(`no wired .jrow at index ${index}`);
			handler();
		},
		clickChip: (key: string) => {
			const handler = chipHandlers.get(key);
			if (!handler) throw new Error(`no wired .jfchip for key ${key}`);
			handler();
		},
		clickPattern: (key: string) => {
			const handler = patternHandlers.get(key);
			if (!handler) throw new Error(`no wired .jpatterns-group-action for key ${key}`);
			handler();
		},
		clickQueueItem: (index: number) => {
			const handler = queueHandlers[index];
			if (!handler) throw new Error(`no wired .jqueue-link at rendered index ${index}`);
			handler();
		},
		clickReportCard: (kind: string) => {
			const handler = cardHandlers.get(kind);
			if (!handler) throw new Error(`no wired .jcard for kind ${kind}`);
			handler();
		},
	};
}

const journey = (over: Record<string, unknown> = {}) => ({
	id: "T\x00repo-a\x00JOLLI-9",
	groupedBy: "ticket",
	ticket: "JOLLI-9",
	branch: "feature/x",
	title: "add the journey model",
	repoIdentity: "repo-a",
	repoName: "repo-a",
	startedAtMs: 1_754_000_000_000,
	endedAtMs: 1_754_086_400_000,
	commitCount: 2,
	sessionCount: 3,
	turns: 40,
	durationMinutes: null,
	costUsd: 1.25,
	planFirst: true,
	shape: { kind: "plan-first", label: "plan-first · clean land" },
	decisions: [{ text: "chose A over B", commitHash: "h1" }],
	decisionCount: 1,
	availability: {
		duration: "unavailable",
		turns: "measured",
		cost: "measured",
		frictionSignals: "unavailable",
		waitTiming: "unavailable",
		reviewTiming: "unavailable",
	},
	...over,
});

/** The whole feed — a `JourneysModel`, exactly what `/api/journeys` returns. */
const journeysModelFixture = (over: Record<string, unknown> = {}) => ({
	journeys: [
		journey({ id: "A\x00repo-a\x00a", title: "drafted first", planFirst: true }),
		journey({ id: "B\x00repo-a\x00b", title: "straight through", planFirst: false }),
	],
	indexedCommits: 2,
	smoothestId: null,
	hardestId: null,
	windowStartMs: 1_753_900_000_000,
	windowEndMs: 1_754_100_000_000,
	...over,
});

/**
 * The page model `renderCoaching`/`openFeedModal` consume — `model.coaching`
 * plus the `timeZone`/`scope` the feed modal and trace read off it. The featured
 * pair are whole journeys, since they render in the report expansion on first
 * paint (ids alone would force a feed fetch before the page could draw them).
 */
const coachingFixture = (over: Record<string, unknown> = {}) => {
	const smooth = journey({ id: "s", title: "smooth one" });
	const hard = journey({ id: "h", title: "hard one" });
	return {
		coaching: {
			roster: {
				label: "You",
				planFirst: { availability: "measured", value: 50, trendPct: 10 },
				skills: { availability: "measured", value: 5, topName: "superpowers:brainstorming", distinctCount: 2 },
				cost: { availability: "measured", value: 3.5 },
				recall: { availability: "measured", value: 4 },
				// `RosterCell`, not a concrete inferred literal: the report-row tests
				// reassign this cell across measured/unavailable/trended shapes, which
				// a narrower inferred type would reject.
				turnaround: { availability: "measured", value: 45 } as RosterCell,
				// `value?` optional: the friction tests reassign this cell to an
				// `unavailable` shape with no `value`, which a concrete inferred
				// `{ availability: string; value: number }` would reject.
				friction: { availability: "measured", value: 2 } as { availability: string; value?: number },
			},
			adoptNext: [
				{
					key: "plan-first",
					title: "Plan first",
					detail: "3 of your last 5 journeys planned first",
					adopted: 3,
					window: 5,
				},
			],
			queue: [
				{
					key: "plan-first",
					title: "Write a plan before your next feature",
					detail: "1 of 3 journeys in this window planned first",
					journeyId: "B\x00repo-a\x00b",
					journeyTitle: "straight through",
					repoIdentity: "repo-a",
					journeyTicket: "JOLLI-42",
				},
				{
					key: "scope",
					title: "Break large work into smaller journeys",
					detail: "72 turns in one journey — split it into a few smaller ones",
					journeyId: "C\x00repo-a\x00c",
					journeyTitle: "big one",
					repoIdentity: "repo-a",
					journeyTicket: null,
				},
			],
			patterns: {
				established: [
					{ key: "plan-first", label: "Plan first", count: 4, weeks: 4, emerging: false },
					{ key: "straight-to-execute", label: "Straight to execute", count: 6, weeks: 5, emerging: false },
					{ key: "single-commit", label: "Single-commit journeys", count: 5, weeks: 4, emerging: false },
				],
				emerging: [{ key: "test-first", label: "Test first", count: 2, weeks: 2, emerging: true }],
			},
			hero: [
				{ date: "2026-01-01", costUsd: 1.2, turns: 8 },
				{ date: "2026-01-02", costUsd: 2.4, turns: 16 },
			],
			featured: { smoothest: smooth, hardest: hard },
			journeyCount: 2,
			flaggedCount: 1,
			awaitingCount: 1,
			indexedCommits: 2,
			windowStartMs: 1_753_900_000_000,
			windowEndMs: 1_754_100_000_000,
			...over,
		},
		timeZone: "UTC",
		scope: { kind: "all" },
	};
};

/** Flushes the microtask queue past `openTrace`'s two-`.then` fetch chain —
 *  mirrors `ToolUsagePagingAsset.test.ts`'s `settle`. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("coach report row (single subject)", () => {
	// §7.2 anti-ranking: under a single subject there is nothing to rank, so
	// `renderCoaching` must draw exactly one `.report-row` — the collapsed
	// shape `JD.reportRow` produces, replacing the old roster table's single row.
	it("renders exactly one report row", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		expect(app.innerHTML.match(/class="report-row"/g) ?? []).toHaveLength(1);
	});
});

/**
 * Parses each `.report-facet` block out of `JD.reportRow`'s markup into its
 * own `{ label, arrow }` pair, matching the exact concatenation `reportFacet`
 * emits (no whitespace between the nested spans). Used so an arrow-sense
 * assertion can be scoped to the ONE facet it claims to test — an unscoped
 * `html.toContain(arrow)` can't tell "the right facet emitted this arrow"
 * from "some other facet happened to emit the same arrow", which silently
 * misses a single-facet `betterWhenLower` regression as long as the other
 * facet's logic still happens to produce a matching arrow.
 */
function facetBlocks(html: string): Array<{ label: string; arrow: string }> {
	const matches = [
		...html.matchAll(
			/<span class="report-facet"><span class="report-facet-arrow">([^<]*)<\/span><span class="report-facet-value">[^<]*<\/span><span class="report-facet-label">([^<]*)<\/span><\/span>/g,
		),
	];
	return matches.map(([, arrow, label]) => ({ label, arrow }));
}

describe("report row", () => {
	it("renders one report row with initials and journey count", () => {
		const { JD } = loadJD();
		const html = JD.reportRow(coachingFixture().coaching);
		expect(html).toMatch(/class="[^"]*report-row/);
		expect(html).toContain("2 journeys"); // coachingFixture journeyCount = 2
	});

	it("renders a turnaround self-trend facet with a direction arrow", () => {
		const { JD } = loadJD();
		const c = coachingFixture().coaching;
		c.roster.turnaround = { availability: "measured", value: 45, trendPct: -12 };
		const html = JD.reportRow(c);
		expect(html).toContain("turnaround");
		expect(html).toMatch(/↘|↗|→/);
	});

	it("chooses the arrow sense per facet: turnaround improves falling, plan-first improves rising", () => {
		const { JD } = loadJD();
		const c = coachingFixture().coaching;
		// turnaround: negative trend (falling) is improving → ↘
		c.roster.turnaround = { availability: "measured", value: 45, trendPct: -12 };
		// plan-first: positive trend (rising) is improving → ↘
		c.roster.planFirst = { availability: "measured", value: 50, trendPct: 10 };
		let blocks = facetBlocks(JD.reportRow(c));
		// Scoped per-facet: each assertion is tied to ITS OWN facet's label, so a
		// single-site `betterWhenLower` flip (only turnaround, or only plan-first)
		// fails here even though the other facet's arrow still reads correctly.
		expect(blocks.find((b) => b.label === "turnaround")?.arrow).toBe("↘");
		expect(blocks.find((b) => b.label === "plan-first")?.arrow).toBe("↘");

		// Flip both trends to worsening and confirm each arrow flips to ↗ independently.
		c.roster.turnaround = { availability: "measured", value: 45, trendPct: 12 };
		c.roster.planFirst = { availability: "measured", value: 50, trendPct: -10 };
		blocks = facetBlocks(JD.reportRow(c));
		expect(blocks.find((b) => b.label === "turnaround")?.arrow).toBe("↗");
		expect(blocks.find((b) => b.label === "plan-first")?.arrow).toBe("↗");
	});

	it("shows a steady arrow when trend is zero or absent", () => {
		const { JD } = loadJD();
		const c = coachingFixture().coaching;
		c.roster.turnaround = { availability: "measured", value: 45, trendPct: 0 };
		let html = JD.reportRow(c);
		expect(html).toContain('<span class="report-facet-arrow">→</span>');

		c.roster.turnaround = { availability: "measured", value: 45 };
		html = JD.reportRow(c);
		expect(html).toContain('<span class="report-facet-arrow">→</span>');
	});

	it("omits a facet that was not measured, never as a zero", () => {
		const { JD } = loadJD();
		const c = coachingFixture().coaching;
		c.roster.turnaround = { availability: "unavailable" };
		const html = JD.reportRow(c);
		expect(html).not.toMatch(/turnaround[^<]*>[^<]*\b0\b/);
		expect(html).not.toContain("turnaround");
	});

	it("shows the flagged pill only when friction is positive", () => {
		const { JD } = loadJD();
		const c = coachingFixture().coaching;
		c.roster.friction = { availability: "measured", value: 2 };
		expect(JD.reportRow(c)).toContain("flagged");
		c.roster.friction = { availability: "measured", value: 0 };
		expect(JD.reportRow(c)).not.toContain("flagged");
	});

	it("renders exactly the turnaround and plan-first facets — friction never becomes a third facet", () => {
		const { JD } = loadJD();
		const c = coachingFixture().coaching;
		// Friction positive (also renders the separate `.report-flagged` pill) —
		// proves friction's presence doesn't leak into the facet list under any
		// label, rather than just checking a label ("red-zone") that was never
		// going to appear regardless of whether the constraint holds.
		c.roster.friction = { availability: "measured", value: 2 };
		const blocks = facetBlocks(JD.reportRow(c));
		expect(blocks).toHaveLength(2);
		expect(blocks.map((b) => b.label)).toEqual(["turnaround", "plan-first"]);
	});
});

describe("report expansion", () => {
	it("labels the two highlight cards worth sharing and needs help", () => {
		const { JD } = loadJD();
		const html = JD.reportExpansion(coachingFixture().coaching);
		expect(html).toContain("worth sharing");
		expect(html).toContain("needs help");
	});

	// The wrapper is `class="report-cards"`, a substring `/report-card/g` would
	// also match — so cards are counted by their `data-kind` attribute, which
	// only the individual `.jcard`s (from `card()`) carry, never the wrapper.
	it("suppresses the needs-help card when it is the same journey as worth-sharing", () => {
		const { JD } = loadJD();
		const only = journey({ id: "one", title: "only one" });
		const html = JD.reportExpansion(coachingFixture({ featured: { smoothest: only, hardest: only } }).coaching);
		expect(html.match(/data-kind="/g) ?? []).toHaveLength(1);
		expect(html).toContain('data-kind="worth-sharing"');
		expect(html).not.toContain('data-kind="needs-help"');
	});

	// Mutation proof for the suppression above: distinct ids must yield 2 cards —
	// confirms the count isn't just always 1 regardless of the id comparison.
	it("renders both cards when smoothest and hardest are distinct journeys", () => {
		const { JD } = loadJD();
		const html = JD.reportExpansion(coachingFixture().coaching); // smoothest "s", hardest "h"
		expect(html.match(/data-kind="/g) ?? []).toHaveLength(2);
	});

	it("draws a self-trend summary sparkline from the hero series", () => {
		const { JD } = loadJD();
		const html = JD.reportExpansion(coachingFixture().coaching);
		// coachingFixture().hero has 2 points → spark renders.
		expect(html).toContain("report-summary");
		expect(html).toContain("<polyline");
	});

	it("omits the summary entirely when the hero series has fewer than two points", () => {
		const { JD } = loadJD();
		const html = JD.reportExpansion(
			coachingFixture({ hero: [{ date: "2026-01-01", costUsd: 1.2, turns: 8 }] }).coaching,
		);
		expect(html).not.toContain("report-summary");
	});

	it("wraps the summary and cards in a report-expansion container", () => {
		const { JD } = loadJD();
		const html = JD.reportExpansion(coachingFixture().coaching);
		expect(html).toMatch(/^<div class="report-expansion">/);
	});
});

describe("coaching layers", () => {
	it("renders the coaching page in the reports / patterns / queue shape", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		expect(app.innerHTML).toContain("coach-page");
		expect(app.innerHTML).toContain("Reports");
		expect(app.innerHTML).toContain("Patterns");
		expect(app.innerHTML).toContain("Adopt next");
		expect(app.innerHTML).toContain("Coaching queue");
		expect(app.innerHTML).not.toContain("Open details");
	});

	it("renders single-subject panel subtitles, not team wording", () => {
		// Every panel head's question/method copy must read as single-subject:
		// "your own earlier line" rather than a cross-person comparison, and no
		// person-count threshold anywhere in the rendered page.
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		const html = app.innerHTML;
		expect(html).toContain("your earlier line"); // single-subject (report summary + shell sub voice)
		expect(html).toContain("What reliably lands fast, and what reliably drags?"); // Patterns question
		expect(html).toContain("Observational, not causal"); // Patterns method disclosure (carried from Task 7)
		expect(html).toContain("What is worth raising this week?"); // Queue question
		expect(html).not.toContain("each other"); // no cross-person wording
		expect(html).not.toContain("2+ people"); // no team threshold
	});

	it("renders ADOPT NEXT as a plain text list (title + evidence detail, no card/share widget)", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		expect(app.innerHTML).toContain("Adopt next");
		expect(app.innerHTML).toContain("Plan first");
		expect(app.innerHTML).toContain("3 of your last 5");
		// The bold title carries a trailing period, and the standalone "3 / 5" share
		// widget is gone (the count lives in the detail sentence).
		expect(app.innerHTML).toContain("jpatterns-adopt-item");
		expect(app.innerHTML).not.toContain("3 / 5");
	});

	it("renders the queue with its evidence link", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		expect(app.innerHTML).toContain("Coaching queue");
		expect(app.innerHTML).toContain("Write a plan before your next feature");
		expect(app.innerHTML).toContain("Break large work into smaller journeys");
		expect(app.innerHTML).toContain("Open the journey");
		// The evidence shows the journey's TICKET id when it has one (JOLLI-42),
		// and falls back to the journey title when the ticket is null ("big one").
		expect(app.innerHTML).toContain("JOLLI-42");
		expect(app.innerHTML).toContain("big one");
		// The evidence link carries its POSITION, never the NUL-joined id.
		expect(app.innerHTML).not.toContain("\x00");
	});

	it("uses the mockup link text and footer on the queue", () => {
		const { JD } = loadJD();
		const html = JD.queueList(coachingFixture().coaching.queue);
		expect(html).toContain("Open the journey it came from");
		expect(html).toContain("nothing is sent or logged");
		// Mutation proof: the old link text is gone, not just superseded by a
		// substring match — a lazy implementation could satisfy the assertions
		// above while still emitting the arrow-suffixed original.
		expect(html).not.toContain("Open the journey →");
	});

	it("sorts the queue with the blocker-like kind (scope) ahead of the ramp-like kind (plan-first)", () => {
		// The fixture lists plan-first before scope; the mockup's blocker → trend
		// → ramp → cost intent puts scope (blocker-like) first, so a correct sort
		// must visibly reverse the fixture's own order — not just happen to match
		// it, which would pass even with no sort at all.
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		const scopeAt = app.innerHTML.indexOf("Break large work into smaller journeys");
		const planFirstAt = app.innerHTML.indexOf("Write a plan before your next feature");
		expect(scopeAt).toBeGreaterThanOrEqual(0);
		expect(planFirstAt).toBeGreaterThanOrEqual(0);
		expect(scopeAt).toBeLessThan(planFirstAt);
	});

	it("resolves the clicked queue item from the SAME sorted order it was rendered in", async () => {
		// `data-index` indexes the RENDERED (sorted) array. If `queueList`'s order
		// and the click handler's backing array ever drift apart, this resolves
		// the wrong journey's trace with no error anywhere — the exact failure
		// mode the task-8 brief calls out.
		const { JD, clickQueueItem, fetchCalls } = loadJD();
		JD.renderCoaching(coachingFixture());
		// Rendered order after sort: [scope ("C\x00repo-a\x00c"), plan-first ("B\x00repo-a\x00b")].
		clickQueueItem(0);
		await settle();
		expect(fetchCalls[fetchCalls.length - 1]).toContain("repo=repo-a");
		expect(fetchCalls[fetchCalls.length - 1]).toContain(`id=${encodeURIComponent("C\x00repo-a\x00c")}`);

		clickQueueItem(1);
		await settle();
		expect(fetchCalls[fetchCalls.length - 1]).toContain("repo=repo-a");
		expect(fetchCalls[fetchCalls.length - 1]).toContain(`id=${encodeURIComponent("B\x00repo-a\x00b")}`);
	});

	it("keeps equal-priority queue items in their original relative order (stable sort)", () => {
		// Two items that both fall into the neutral fallback bucket (neither
		// `scope` nor `plan-first`) must not be reordered relative to each other —
		// an unstable sort could silently swap them on some engines/inputs.
		const { JD, app } = loadJD();
		JD.renderCoaching(
			coachingFixture({
				queue: [
					{
						key: "other-a",
						title: "first neutral item",
						detail: "detail a",
						journeyId: "A\x00repo-a\x00a",
						journeyTitle: "journey a",
						repoIdentity: "repo-a",
					},
					{
						key: "other-b",
						title: "second neutral item",
						detail: "detail b",
						journeyId: "B\x00repo-a\x00b",
						journeyTitle: "journey b",
						repoIdentity: "repo-a",
					},
				],
			}),
		);
		const firstAt = app.innerHTML.indexOf("first neutral item");
		const secondAt = app.innerHTML.indexOf("second neutral item");
		expect(firstAt).toBeGreaterThanOrEqual(0);
		expect(secondAt).toBeGreaterThanOrEqual(0);
		expect(firstAt).toBeLessThan(secondAt);
	});

	it("renders patterns split by the evidence bar", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		expect(app.innerHTML).toContain("Patterns");
		expect(app.innerHTML).toContain("WORKING");
		expect(app.innerHTML).toContain("Emerging 1 under the bar");
		expect(app.innerHTML).toContain("Single-commit journeys");
		expect(app.innerHTML).toContain("Plan first");
		expect(app.innerHTML).toContain("Straight to execute");
		// Adopt-next is a plain text list now (no "Open the window" feed card).
		expect(app.innerHTML).toContain("Adopt next");
		expect(app.innerHTML).not.toContain("Open the window");
		expect(app.innerHTML).not.toContain("Open details");
	});

	it("lists thin-evidence patterns under an Emerging group with counts", () => {
		const { JD } = loadJD();
		const html = JD.patternsList(coachingFixture().coaching.patterns, coachingFixture().coaching);
		expect(html).toContain("Emerging");
		// the fixture's emerging entry (test-first, count 2) shows with its count, not promoted
		expect(html).toMatch(/Emerging[\s\S]*Test first[\s\S]*2/);
		expect(html).not.toContain("2+ people");
		expect(html).not.toContain("each other");
	});

	it("opens the journeys feed filtered to the clicked WORKING pattern", async () => {
		const feed = journeysModelFixture({
			journeys: [
				journey({ id: "A\x00repo-a\x00a", title: "drafted first", planFirst: true }),
				journey({ id: "B\x00repo-a\x00b", title: "straight through", planFirst: false }),
			],
		});
		const { JD, feedBody, feedOverlay, clickPattern } = loadJD(feed);
		JD.renderCoaching(coachingFixture());

		clickPattern("plan-first");

		await settle();
		expect(feedOverlay.added).toContain("open");
		expect(feedBody.innerHTML).toContain("drafted first");
		expect(feedBody.innerHTML).not.toContain("straight through");
		expect(feedBody.innerHTML).toContain('data-filter="plan-first" class="jfchip on"');
	});

	it("opens the journeys feed filtered to a clicked EMERGING (below-the-bar) pattern", async () => {
		// Emerging patterns are explorable too — clicking the fixture's emerging
		// entry (test-first) must open the feed filtered to test-first journeys, not
		// fall through to "all". Thin-evidence does not mean un-clickable.
		const feed = journeysModelFixture({
			journeys: [
				journey({ id: "A\x00repo-a\x00a", title: "tested first", tested: { testFirst: true } }),
				journey({ id: "B\x00repo-a\x00b", title: "no tests", tested: { testFirst: false } }),
			],
		});
		const { JD, feedBody, feedOverlay, clickPattern } = loadJD(feed);
		JD.renderCoaching(coachingFixture());

		clickPattern("test-first");

		await settle();
		expect(feedOverlay.added).toContain("open");
		expect(feedBody.innerHTML).toContain("tested first");
		expect(feedBody.innerHTML).not.toContain("no tests");
		expect(feedBody.innerHTML).toContain('data-filter="test-first" class="jfchip on"');
	});

	it("renders nothing for a layer whose array is empty", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(
			coachingFixture({
				adoptNext: [],
				queue: [],
				patterns: { established: [], emerging: [] },
			}),
		);
		expect(app.innerHTML).not.toContain("Adopt next");
		expect(app.innerHTML).not.toContain("Coaching queue");
		expect(app.innerHTML).not.toContain("Patterns");
		// The report row itself still renders.
		expect(app.innerHTML).toContain("report-row");
	});

	it("escapes a hostile queue title", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(
			coachingFixture({
				queue: [
					{
						key: "plan-first",
						title: "Write a plan",
						detail: "detail",
						journeyId: "X\x00r\x00x",
						journeyTitle: "<img src=x onerror=alert(1)>",
						repoIdentity: "repo-a",
					},
				],
			}),
		);
		expect(app.innerHTML).not.toContain("<img src=x");
	});
});

describe("coaching header tiles", () => {
	it("renders the three coaching header tiles", () => {
		const { JD } = loadJD();
		const html = JD.coachTiles(coachingFixture().coaching);
		expect(html).toContain("Journeys");
		expect(html).toContain("Flagged journeys");
		expect(html).toContain("Awaiting an answer");
	});

	it("renders a dash for an unmeasured tile, never a zero", () => {
		const { JD } = loadJD();
		// Cast to a shape with optional counts: the fixture's literal type infers
		// `flaggedCount: number` (required), which `delete` rejects outright.
		const c = coachingFixture().coaching as { flaggedCount?: number; awaitingCount?: number } & Record<
			string,
			unknown
		>;
		delete c.flaggedCount; // unmeasured
		const html = JD.coachTiles(c);
		// the flagged tile shows — ; and no tile prints a bare 0 for the missing one
		expect(html).toContain("—");
	});

	it("paints flagged and awaiting as warnings only when positive", () => {
		const { JD } = loadJD();
		const c = coachingFixture().coaching as { flaggedCount?: number; awaitingCount?: number } & Record<
			string,
			unknown
		>;
		c.flaggedCount = 3;
		c.awaitingCount = 0;
		const html = JD.coachTiles(c);
		expect(html).toMatch(/coach-tile-warn[^"]*"[^>]*>[^<]*3/); // flagged warned
		// awaiting 0 is a measured fact, not a warning
		expect(html).not.toMatch(/coach-tile-warn[^"]*"[^>]*>[^<]*\b0\b/);
	});

	it("renders the tiles first inside the coach page", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		expect(app.innerHTML).toContain("coach-tiles");
		expect(app.innerHTML.indexOf("coach-tiles")).toBeLessThan(app.innerHTML.indexOf("coach-reports"));
	});
});

describe("renderFeedInto", () => {
	it("renders one row per journey with its title", () => {
		const { JD, feedBody } = loadJD();
		JD.renderFeedInto(feedBody, journeysModelFixture(), "UTC");
		expect(feedBody.innerHTML).toContain("drafted first");
		expect(feedBody.innerHTML).toContain("straight through");
	});

	it("badges the grouping so a branch journey cannot pass as a ticket one", () => {
		const { JD, feedBody } = loadJD();
		JD.renderFeedInto(
			feedBody,
			journeysModelFixture({ journeys: [journey({ groupedBy: "branch", ticket: null })] }),
			"UTC",
		);
		expect(feedBody.innerHTML).toContain('data-grouped-by="branch"');
		expect(feedBody.innerHTML).toContain("feature/x");
	});

	it("shows an empty state rather than an empty page", () => {
		const { JD, feedBody } = loadJD();
		JD.renderFeedInto(feedBody, journeysModelFixture({ journeys: [] }), "UTC");
		expect(feedBody.innerHTML).toMatch(/no journeys/i);
	});

	it("escapes a title that contains markup", () => {
		const { JD, feedBody } = loadJD();
		JD.renderFeedInto(
			feedBody,
			journeysModelFixture({ journeys: [journey({ title: "<img src=x onerror=alert(1)>" })] }),
			"UTC",
		);
		expect(feedBody.innerHTML).not.toContain("<img src=x");
	});
});

describe("journeyGlyph", () => {
	it("draws NO mark for an unavailable signal", () => {
		const { JD } = loadJD();
		const svg = JD.journeyGlyph(journey());
		expect(svg).not.toContain("glyph-flag");
		expect(svg).not.toContain("glyph-red-zone");
		expect(svg).not.toContain("glyph-review");
		expect(svg).not.toContain("glyph-wait");
	});

	it("labels the work bar as turns, never as time", () => {
		const { JD } = loadJD();
		const svg = JD.journeyGlyph(journey({ turns: 40 }));
		expect(svg).toContain("turns");
		expect(svg).not.toMatch(/\bminutes?\b/i);
	});

	it("marks the bar unmeasured when turns are missing, and never zero-width", () => {
		const { JD } = loadJD();
		const svg = JD.journeyGlyph(
			journey({ turns: null, availability: { ...journey().availability, turns: "unavailable" } }),
		);
		expect(svg).toContain('data-unmeasured="true"');
		expect(svg).not.toContain('width="0"');
	});

	it("draws one filled diamond per decision", () => {
		const { JD } = loadJD();
		const svg = JD.journeyGlyph(
			journey({
				decisions: [
					{ text: "a", commitHash: "h1" },
					{ text: "b", commitHash: "h2" },
				],
				decisionCount: 2,
			}),
		);
		expect(svg).toContain("glyph-decision-0");
		expect(svg).toContain("glyph-decision-1");
		// Hollow means "the agent decided alone", which local data cannot show.
		expect(svg).not.toContain("fill-transparent");
	});

	it("draws sessionCount - 1 separators", () => {
		const { JD } = loadJD();
		expect(JD.journeyGlyph(journey({ sessionCount: 3 }))).toContain("glyph-session-sep-1");
		expect(JD.journeyGlyph(journey({ sessionCount: 1 }))).not.toContain("glyph-session-sep-0");
	});

	/** Pulls a numeric attribute off the first tag in `svg` carrying `testid` as
	 *  its `data-testid`. */
	function attr(svg: string, testid: string, name: string): number {
		const tag = new RegExp(`data-testid="${testid}"[^>]*${name}="([\\d.]+)"`).exec(svg);
		const raw = tag?.[1] ?? new RegExp(`${name}="([\\d.]+)"[^>]*data-testid="${testid}"`).exec(svg)?.[1];
		if (raw === undefined) throw new Error(`no ${name} found for testid ${testid} in ${svg}`);
		return Number(raw);
	}

	// I3 regression: the old MAX_TURNS=120 ceiling was never reached in practice
	// (measured max well under it), so a low-but-measured turn count rendered a
	// bar within a few px of the unmeasured floor — width is the channel the
	// reader compares, so a measured journey must never look LESS measured than
	// an unmeasured one.
	it("renders a measured bar strictly wider than the unmeasured floor, even at the lowest turn count", () => {
		const { JD } = loadJD();
		const unmeasuredWidth = attr(
			JD.journeyGlyph(
				journey({ turns: null, availability: { ...journey().availability, turns: "unavailable" } }),
			),
			"glyph-duration",
			"width",
		);
		for (const turns of [0, 1, 5]) {
			const width = attr(JD.journeyGlyph(journey({ turns })), "glyph-duration", "width");
			expect(width).toBeGreaterThan(unmeasuredWidth);
		}
	});

	// Finding 3 regression: separators and decision diamonds used to be
	// positioned as fractions of the bar's OWN width, which piled them into a
	// narrow box whenever the bar itself was short (the common case after I3 —
	// most bars sit well under the full track). They must track the full
	// glyph width instead; the bar's rendered length is a different signal.
	it("spreads session separators across the full track, not the bar's own width", () => {
		const { JD } = loadJD();
		const svg = JD.journeyGlyph(journey({ turns: 1, sessionCount: 3 }));
		const barWidth = attr(svg, "glyph-duration", "width");
		const sepX = attr(svg, "glyph-session-sep-1", "x1");
		expect(sepX).toBeGreaterThan(barWidth);
	});
});

describe("report highlight cards", () => {
	it("renders the worth-sharing and needs-help cards when the model names them", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		expect(app.innerHTML).toContain("smooth one");
		expect(app.innerHTML).toContain("hard one");
		expect(app.innerHTML).toContain("report-cards");
	});

	it("renders no highlight-card section when neither is named", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture({ featured: { smoothest: null, hardest: null } }));
		expect(app.innerHTML).not.toContain("report-cards");
	});

	// I1(a): "worth sharing"/"needs help" alone is a verdict with no stated basis —
	// every card must say what it is ranked by.
	it("tells the reader what a featured card is ranked by", () => {
		const { JD, app } = loadJD();
		JD.renderCoaching(coachingFixture());
		expect(app.innerHTML.match(/jcard-rankedby/g) ?? []).toHaveLength(2);
		expect(app.innerHTML).toMatch(/ranked by/i);
	});

	it("renders one card when the same journey is both", () => {
		// A one-journey window makes it smoothest AND hardest. Two identical
		// cards would claim a comparison that was never made.
		const { JD, app } = loadJD();
		const only = journey({ id: "only", title: "the only one" });
		JD.renderCoaching(coachingFixture({ featured: { smoothest: only, hardest: only } }));
		// Match the class ATTRIBUTE, not the substring: `jcard-title` and
		// `jcard-figures` also contain "jcard", so /jcard/g counts 3 per card. The
		// highlight card is clickable (opens its trace), hence the second class.
		expect(app.innerHTML.match(/class="jcard jcard-clickable"/g) ?? []).toHaveLength(1);
	});

	it("still renders one card after the JSON round-trip production applies", () => {
		// Production inlines `JSON.stringify(model)` into the page and the browser
		// re-parses it, so the smoothest/hardest pair arrive as two DISTINCT
		// objects even when they are the same journey — the de-dup must survive
		// that boundary, which passing the same reference can never exercise.
		const { JD, app } = loadJD();
		const only = journey({ id: "only", title: "the only one" });
		const model = JSON.parse(
			JSON.stringify(coachingFixture({ featured: { smoothest: only, hardest: only } })),
		) as Parameters<JDNamespace["renderCoaching"]>[0];
		JD.renderCoaching(model);
		expect(app.innerHTML.match(/class="jcard jcard-clickable"/g) ?? []).toHaveLength(1);
	});

	it("opens the clicked highlight card's journey trace by its full NUL-separated id, resolved from the model", async () => {
		// The journey is resolved from the model by kind — NOT round-tripped through
		// a DOM attribute. A real journey id carries NUL separators, which the HTML
		// parser rewrites to U+FFFD inside an attribute, so an attribute-carried id
		// would 404 the trace ("Could not load this journey"). Clicking worth-sharing
		// must trace the SMOOTHEST journey and needs-help the HARDEST, id intact.
		const smoothId = "T\x00repo-a\x00JOLLI-2020";
		const hardId = "T\x00repo-a\x00JOLLI-2123";
		const { JD, clickReportCard, fetchCalls } = loadJD();
		JD.renderCoaching(
			coachingFixture({
				featured: {
					smoothest: journey({ id: smoothId, repoIdentity: "repo-a" }),
					hardest: journey({ id: hardId, repoIdentity: "repo-a" }),
				},
			}),
		);

		clickReportCard("worth-sharing");
		await settle();
		expect(fetchCalls[fetchCalls.length - 1]).toContain("repo=repo-a");
		expect(fetchCalls[fetchCalls.length - 1]).toContain(`id=${encodeURIComponent(smoothId)}`);

		clickReportCard("needs-help");
		await settle();
		expect(fetchCalls[fetchCalls.length - 1]).toContain("repo=repo-a");
		expect(fetchCalls[fetchCalls.length - 1]).toContain(`id=${encodeURIComponent(hardId)}`);
	});

	it("shows the true decision count while the glyph draws the capped feed list", () => {
		// The feed caps `decisions` at 8 while `decisionCount` always reports the
		// true total — a cut this page cannot see is a cut it would silently
		// misreport. A journey with 9 decisions must show 9 in the card's figures
		// AND 8 diamonds in the glyph, never the same number twice.
		const { JD, app } = loadJD();
		const many = journey({
			decisionCount: 9,
			decisions: Array.from({ length: 8 }, (_, i) => ({ text: `d${i}`, commitHash: "h" })),
		});
		JD.renderCoaching(coachingFixture({ featured: { smoothest: many, hardest: many } }));
		expect(app.innerHTML).toMatch(/<dt>Decisions<\/dt><dd>9<\/dd>/);
		// Scoped to the highlight card, not the whole page: `reportRow`'s own
		// journey-glyph strip (`reportStrip`) also draws this journey's glyph
		// (undeduplicated, since the strip is a taste, not a ranking) and would
		// otherwise double-count the same 8 decision diamonds.
		const cardsHtml = app.innerHTML.split('class="report-cards"')[1] ?? "";
		expect(cardsHtml.match(/class="glyph-decision"/g) ?? []).toHaveLength(8);
	});

	it("says a figure is not measured rather than printing a zero", () => {
		const { JD, app } = loadJD();
		const only = journey({ id: "only", durationMinutes: null, costUsd: null });
		only.availability = { ...only.availability, duration: "unavailable", cost: "unavailable" };
		JD.renderCoaching(coachingFixture({ featured: { smoothest: only, hardest: only } }));
		expect(app.innerHTML).toMatch(/not measured/i);
		expect(app.innerHTML).not.toMatch(/\$0\.00/);
		expect(app.innerHTML).not.toMatch(/\b0 min\b/);
	});

	it("labels duration as activity, never as elapsed time", () => {
		// The bucket count is an upper bound — one message in a quarter-hour fills
		// it — so calling it "duration" or "took" overstates what was measured.
		// The label lives on the featured card, so this journey must be named
		// smoothest/hardest for it to render at all.
		const { JD, app } = loadJD();
		const only = journey({ id: "only", durationMinutes: 45 });
		JD.renderCoaching(coachingFixture({ featured: { smoothest: only, hardest: only } }));

		// The duration figure is labelled as activity, never "took".
		expect(app.innerHTML).toMatch(/activity/i);
		expect(app.innerHTML).not.toMatch(/\btook\b/u);
		// Note: the patterns legend legitimately says "length is elapsed time" (it
		// describes the trace SEGMENT length, mockup wording) — a different thing
		// from the duration figure, so `elapsed` is not banned page-wide here.
	});
});

describe("renderJourneyTrace", () => {
	const detail = {
		journey: journey(),
		commits: [
			{
				commitHash: "h1",
				message: "one",
				committedAtMs: 1_754_000_000_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
			{
				commitHash: "h2",
				message: "two",
				committedAtMs: 1_754_086_400_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
		],
		decisions: Array.from({ length: 9 }, (_v, i) => ({ text: `decision ${i}`, commitHash: "h1" })),
	};

	it("keeps commits in order on the axis", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace(detail);
		const first = body.innerHTML.indexOf("one");
		const second = body.innerHTML.indexOf("two");
		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
	});

	it("renders EVERY decision, not the feed's capped list", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace(detail);
		expect(body.innerHTML).toContain("decision 8");
	});

	it("draws no review tick", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace(detail);
		expect(body.innerHTML).not.toMatch(/review/i);
	});

	it("escapes commit messages", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({
			...detail,
			commits: [{ ...detail.commits[0], message: "<img src=x onerror=alert(1)>" }],
		});
		expect(body.innerHTML).not.toContain("<img src=x");
	});

	it("renders the richer coaching sections without the retired footer actions", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace(detail);
		expect(body.innerHTML).toContain("What happened");
		expect(body.innerHTML).toContain("Decisions");
		expect(body.innerHTML).toContain("Receipts");
		// The "Share pattern" / "Pin to coaching queue" buttons were never wired to
		// anything and have been removed.
		expect(body.innerHTML).not.toContain("Share pattern");
		expect(body.innerHTML).not.toContain("Pin to coaching queue");
	});
});

describe("renderJourneyTrace — stats grid", () => {
	const base = {
		journey: journey(),
		commits: [
			{
				commitHash: "h1",
				message: "one",
				committedAtMs: 1_754_000_000_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
		],
		decisions: [],
	};

	it("shows sessions and est cost, and names unmeasured activity rather than 0", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace(base);
		expect(body.innerHTML).toContain("jtrace-stats");
		expect(body.innerHTML).toContain("<dt>sessions</dt><dd>3</dd>");
		expect(body.innerHTML).toContain("$1.25");
		// durationMinutes null + availability.duration unavailable → "not measured".
		expect(body.innerHTML).toContain("<dt>activity</dt><dd>not measured</dd>");
	});

	it("adds a waiting cell summing wait time", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...base, waits: [{ startedAtMs: 1, endedAtMs: 2, durationMinutes: 66 }] });
		expect(body.innerHTML).toContain("<dt>waiting</dt><dd>1.1h</dd>");
	});

	it("omits the waiting cell when nothing stalled", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...base, waits: [] });
		expect(body.innerHTML).not.toContain("<dt>waiting</dt>");
	});
});

describe("renderJourneyTrace — sheet legend", () => {
	const withSpan = {
		journey: journey(),
		commits: [
			{
				commitHash: "h1",
				message: "one",
				committedAtMs: 1_754_000_000_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
		],
		decisions: [{ text: "chose A", commitHash: "h1" }],
	};

	it("describes only glyphs the trace draws, and promises none it does not", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace(withSpan);
		expect(body.innerHTML).toContain("jtrace-sheet-legend");
		expect(body.innerHTML).toContain("decision recorded");
		// The trace draws no friction/degraded/landed glyph and no hollow-if-ratified
		// decision, and the band is a narrative frame — never "elapsed time".
		expect(body.innerHTML).not.toMatch(/degraded|\blanded\b|ratified|friction window|elapsed time/i);
	});

	it("shows a context-compacted entry only when a compaction falls in span", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...withSpan, compactions: [1_754_010_000_000] });
		expect(body.innerHTML).toContain("context compacted");
	});

	it("draws no legend for a zero-span (single-commit) journey", () => {
		const { JD, body } = loadJD();
		const zero = journey({ startedAtMs: 1_754_000_000_000, endedAtMs: 1_754_000_000_000 });
		JD.renderJourneyTrace({ journey: zero, commits: withSpan.commits, decisions: [] });
		expect(body.innerHTML).not.toContain("jtrace-sheet-legend");
	});
});

describe("renderJourneyTrace — receipts", () => {
	it("lists the commit's short hash when there is one", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({
			journey: journey(),
			commits: [
				{
					commitHash: "abcdef1234",
					message: "do it",
					committedAtMs: 1_754_000_000_000,
					repoIdentity: "repo-a",
					repoName: "repo-a",
				},
			],
			decisions: [],
		});
		expect(body.innerHTML).toContain("abcdef1");
	});

	it("keeps the session notes wording when there is no commit", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ journey: journey(), commits: [], decisions: [] });
		expect(body.innerHTML).toContain("no commit");
		expect(body.innerHTML).toContain("session notes kept");
	});
});

describe("renderJourneyMeta — waiting status", () => {
	it("shows 'waiting on an answer' when a wait reached the stall threshold", () => {
		const { JD } = loadJD();
		const html = JD.renderJourneyMeta(journey(), "UTC", [{ startedAtMs: 1, endedAtMs: 2, durationMinutes: 45 }]);
		expect(html).toContain("waiting on an answer");
	});

	it("shows no status when every wait is short", () => {
		const { JD } = loadJD();
		const html = JD.renderJourneyMeta(journey(), "UTC", [{ startedAtMs: 1, endedAtMs: 2, durationMinutes: 10 }]);
		expect(html).not.toContain("waiting on an answer");
	});

	it("shows no status when no waits are supplied", () => {
		const { JD } = loadJD();
		expect(JD.renderJourneyMeta(journey(), "UTC")).not.toContain("waiting on an answer");
	});
});

describe("renderJourneyTrace — waiting", () => {
	const detail = {
		journey: journey(),
		commits: [
			{
				commitHash: "h1",
				message: "one",
				committedAtMs: 1_754_000_000_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
		],
		decisions: [],
	};
	const waits = [
		{ startedAtMs: 1_754_000_000_000, endedAtMs: 1_754_000_300_000, durationMinutes: 5 },
		{ startedAtMs: 1_754_000_600_000, endedAtMs: 1_754_004_600_000, durationMinutes: 66 },
	];

	it("renders a 'waiting on you' entry per wait with its duration", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...detail, waits });
		expect(body.innerHTML).toContain("Waiting on you");
		expect((body.innerHTML.match(/class="jwait"/g) ?? []).length).toBe(2);
		expect(body.innerHTML).toContain("5m");
		expect(body.innerHTML).toContain("1.1h");
	});

	it("renders no section when there are no waits", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...detail, waits: [] });
		expect(body.innerHTML).not.toContain("Waiting on you");
	});

	// §3.2 vocabulary: the agent's idleness is measured, the human's activity is
	// not — the wording must never assert what the human was doing.
	it("never uses idle, away, or blocked wording", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...detail, waits });
		expect(body.innerHTML).toMatch(/waiting on you/i);
		expect(body.innerHTML).not.toMatch(/\bidle\b|\baway\b|blocked on you/i);
	});
});

describe("renderJourneyTrace — attribution", () => {
	const detail = {
		journey: journey(),
		commits: [
			{
				commitHash: "h1",
				message: "one",
				committedAtMs: 1_754_000_000_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
		],
		decisions: [],
	};

	it("renders the turn split with its counts", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...detail, attribution: { humanTurns: 3, agentTurns: 12 } });
		expect(body.innerHTML).toContain("You: 3 turns");
		expect(body.innerHTML).toContain("Agent: 12 turns");
	});

	it("uses the singular 'turn' for exactly one", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...detail, attribution: { humanTurns: 1, agentTurns: 1 } });
		expect(body.innerHTML).toContain("You: 1 turn");
		expect(body.innerHTML).toContain("Agent: 1 turn");
	});

	it("renders no line when the split is empty", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...detail, attribution: { humanTurns: 0, agentTurns: 0 } });
		expect(body.innerHTML).not.toContain("jtrace-attribution");
	});

	// Counts, never verdicts: it must not say who "drove" the work.
	it("never says drove, idle, or away", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace({ ...detail, attribution: { humanTurns: 3, agentTurns: 12 } });
		expect(body.innerHTML).not.toMatch(/\bdrove\b|\bidle\b|\baway\b/i);
	});
});

describe("renderJourneyTrace with a time axis", () => {
	const detail = (over: Record<string, unknown> = {}) => ({
		journey: journey({ startedAtMs: 1_754_000_000_000, endedAtMs: 1_754_086_400_000, ...over }),
		commits: [
			{
				commitHash: "h1",
				message: "one",
				committedAtMs: 1_754_000_000_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
			{
				commitHash: "h2",
				message: "two",
				committedAtMs: 1_754_086_400_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
		],
		decisions: [{ text: "keep the shim", commitHash: "h2" }],
	});

	it("draws an axis with one mark per commit when the journey has span", () => {
		const { JD, body } = loadJD();

		JD.renderJourneyTrace(detail());

		expect(body.innerHTML).toContain("<svg");
		expect((body.innerHTML.match(/class="jtrace-commit"/gu) ?? []).length).toBe(2);
	});

	// `role="img"` makes assistive tech treat the SVG subtree as opaque, so the
	// per-mark `<title>`s (and with them every 7-char hash) are invisible to a
	// screen reader unless the ordinal list is ALSO rendered — beneath the axis,
	// not replaced by it. The zero-span test above is the other half of this:
	// it must keep rendering the list ALONE, not doubled.
	it("keeps the ordinal list beneath the axis rather than replacing it", () => {
		const { JD, body } = loadJD();

		JD.renderJourneyTrace(detail());

		expect(body.innerHTML).toContain("<svg");
		expect(body.innerHTML).toContain("jtrace-band");
		expect(body.innerHTML).toContain("jtrace-hash");
	});

	// 60 of 228 journeys are commit-grouped, so this is a quarter of them, not an
	// edge case. A zero-length axis with a mark on it draws a measurement that
	// does not exist.
	it("draws NO axis for a zero-span journey and falls back to the ordinal list", () => {
		const { JD, body } = loadJD();
		const one = detail({ endedAtMs: 1_754_000_000_000 });
		one.commits = [one.commits[0]];

		JD.renderJourneyTrace(one);

		expect(body.innerHTML).not.toContain("<svg");
		expect(body.innerHTML).toContain("jtrace-band");
		expect(body.innerHTML).toContain("one");
	});

	it("places each decision at its OWN commit's position, not at one end", () => {
		const { JD, body } = loadJD();
		const two = detail();
		two.decisions = [
			{ text: "early call", commitHash: "h1" },
			{ text: "late call", commitHash: "h2" },
		];

		JD.renderJourneyTrace(two);
		const decisionX = [...body.innerHTML.matchAll(/class="jtrace-decision-mark"[^>]*cx="([\d.]+)"/gu)].map((m) =>
			Number(m[1]),
		);
		const commitX = [...body.innerHTML.matchAll(/class="jtrace-commit"[^>]*cx="([\d.]+)"/gu)].map((m) =>
			Number(m[1]),
		);

		// Two decisions on two different commits must land on two different x,
		// each equal to its own commit's. Hardcoding either end — the two bugs
		// this test exists for — collapses them onto one value.
		expect(decisionX).toHaveLength(2);
		expect(decisionX[0]).not.toBe(decisionX[1]);
		expect(decisionX).toEqual(commitX);
	});

	it("drops a decision naming a commit outside this journey rather than clamping it", () => {
		const { JD, body } = loadJD();
		const stray = detail();
		stray.decisions = [{ text: "from another journey", commitHash: "nope" }];

		JD.renderJourneyTrace(stray);

		expect(body.innerHTML).not.toContain("jtrace-decision-mark");
		// Dropped from the AXIS only — the full list below is uncapped and still
		// names it, which is where a reader can still see it.
		expect(body.innerHTML).toContain("from another journey");
	});

	it("still lists every decision in full below the axis", () => {
		const { JD, body } = loadJD();
		const many = detail();
		many.decisions = Array.from({ length: 9 }, (_v, i) => ({ text: `decision ${i}`, commitHash: "h1" }));

		JD.renderJourneyTrace(many);

		expect(body.innerHTML).toContain("decision 8");
	});

	it("never emits a raw NUL into the markup", () => {
		const { JD, body } = loadJD();

		JD.renderJourneyTrace(detail());

		expect(body.innerHTML).not.toContain("\x00");
	});
});

describe("renderJourneyTrace — context load", () => {
	const detail = (over: Record<string, unknown> = {}) => ({
		journey: journey({ startedAtMs: 1_754_000_000_000, endedAtMs: 1_754_086_400_000 }),
		commits: [
			{
				commitHash: "h1",
				message: "one",
				committedAtMs: 1_754_000_000_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
			{
				commitHash: "h2",
				message: "two",
				committedAtMs: 1_754_086_400_000,
				repoIdentity: "repo-a",
				repoName: "repo-a",
			},
		],
		decisions: [],
		...over,
	});

	it("draws one compaction marker per in-span instant", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace(detail({ compactions: [1_754_000_000_000, 1_754_043_200_000] }));
		expect((body.innerHTML.match(/class="jtrace-compaction"/g) ?? []).length).toBe(2);
	});

	it("places each compaction at its own timestamp, not at one end", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace(detail({ compactions: [1_754_000_000_000, 1_754_043_200_000] }));
		const xs = [...body.innerHTML.matchAll(/class="jtrace-compaction"[^>]*cx="([\d.]+)"/gu)].map((m) =>
			Number(m[1]),
		);
		expect(xs).toHaveLength(2);
		expect(xs[0]).not.toBe(xs[1]);
	});

	it("drops a compaction outside the journey's span from the axis", () => {
		const { JD, body } = loadJD();
		// After the journey's last commit — off the axis, like a decision naming a
		// commit outside the journey. The list below still records it.
		JD.renderJourneyTrace(detail({ compactions: [1_754_100_000_000] }));
		expect(body.innerHTML).not.toContain("jtrace-compaction");
		expect(body.innerHTML).toContain("Context load");
	});

	it("renders no section when there are no compactions", () => {
		const { JD, body } = loadJD();
		JD.renderJourneyTrace(detail({ compactions: [] }));
		expect(body.innerHTML).not.toContain("Context load");
		expect(body.innerHTML).not.toContain("jtrace-compaction");
	});

	// `role="img"` hides the SVG subtree from a screen reader, so the record must
	// survive in the list even when the zero-span journey draws no axis at all.
	it("keeps the list for a zero-span journey that draws no axis", () => {
		const { JD, body } = loadJD();
		const zero = detail({ compactions: [1_754_000_000_000] });
		zero.journey.endedAtMs = 1_754_000_000_000;
		zero.commits = [zero.commits[0]];
		JD.renderJourneyTrace(zero);
		expect(body.innerHTML).not.toContain("<svg");
		expect(body.innerHTML).toContain("Context load");
	});
});

describe("opening the feed modal", () => {
	it("fetches the feed only when the modal opens", async () => {
		const { JD, fetchCalls } = loadJD(journeysModelFixture());
		JD.renderCoaching(coachingFixture());
		expect(fetchCalls).toHaveLength(0);
		await JD.openFeedModal();
		expect(fetchCalls.filter((u) => u.startsWith("/api/journeys?"))).toHaveLength(1);
	});

	it("carries the rendered window into the feed request", async () => {
		const { JD, fetchCalls } = loadJD(journeysModelFixture());
		const m = coachingFixture();
		JD.renderCoaching(m);
		await JD.openFeedModal();
		// The same bounds the roster was rendered under — a second resolve can
		// straddle local midnight and group a different set.
		expect(fetchCalls[0]).toContain(`fromMs=${m.coaching.windowStartMs}`);
		expect(fetchCalls[0]).toContain(`toMs=${m.coaching.windowEndMs}`);
	});

	it("shows a message rather than an empty feed when the fetch fails", async () => {
		// The harness's default `{}` body makes the downstream read throw into the
		// `.catch` — the established way this file exercises a failed fetch, and the
		// only one available, since `fakeFetch` always resolves `ok: true`.
		const { JD, feedBody } = loadJD();
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();
		expect(feedBody.innerHTML).toContain("Could not load your journeys.");
		// An empty list here would read as "you have no journeys".
		expect(feedBody.innerHTML).not.toContain("jrow");
	});

	it("keeps row indices aligned with the filtered array", async () => {
		const fixture = journeysModelFixture();
		const { JD, feedBody, clickChip } = loadJD(fixture);
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();
		clickChip("plan-first");
		const indices = [...feedBody.innerHTML.matchAll(/data-index="(\d+)"/g)].map((m) => Number(m[1]));
		expect(indices).toEqual(indices.map((_, i) => i));
		// The filter must actually have removed something, or this asserts nothing.
		expect(indices.length).toBeLessThan(fixture.journeys.length);
	});
});

describe("opening a journey from the feed", () => {
	it("sends the feed's exact window bounds, not a fresh server-side resolve", async () => {
		// A journey id is only meaningful within the window that grouped it, so
		// the click must echo back the FEED's `windowStartMs`/`windowEndMs` as
		// `fromMs`/`toMs` rather than let `/api/journey` re-resolve a window from
		// a fresh clock read.
		const fixture = journeysModelFixture();
		const { JD, fetchCalls, clickRow } = loadJD(fixture);
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();
		clickRow(0);
		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls[1]).toContain(`fromMs=${fixture.windowStartMs}`);
		expect(fetchCalls[1]).toContain(`toMs=${fixture.windowEndMs}`);
	});

	/* The two ways the click shipped broken, both answered 404 by a route that
	   never ran. The assertions above could not see either: `toContain` matches a
	   param just as happily inside a malformed URL, and the stub DOM below hands
	   back attribute text without ever running an HTML parser. */
	it("starts the query with `?`, not `&`", async () => {
		// `JD.query(model, {})` returns "" on this view (no `model.stats`, so no
		// range; scope carries no repos), and `JD.withParams` used to pick its
		// separator by truthiness — so the non-empty PATH took the `&` branch and
		// produced `/api/journey&repo=…`. `url.pathname` was then the whole string,
		// matching no route, and the handler never ran.
		const { JD, fetchCalls, clickRow } = loadJD(journeysModelFixture());
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();
		clickRow(0);
		expect(fetchCalls[1].startsWith("/api/journey?")).toBe(true);
		expect(fetchCalls[1]).not.toContain("/api/journey&");
	});

	it("sends the journey id with its NUL separators intact", async () => {
		const fixture = journeysModelFixture();
		const { JD, fetchCalls, clickRow } = loadJD(fixture);
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();
		clickRow(0);
		expect(fetchCalls[1]).toContain(`id=${encodeURIComponent(fixture.journeys[0].id)}`);
		expect(fetchCalls[1]).toContain("%00");
	});

	/* Parser-independent, and deliberately so: this repo has no jsdom/happy-dom,
	   and the harness reads attributes out of the rendered STRING — so the very
	   step that corrupted the id (the HTML tokenizer rewriting NUL to U+FFFD)
	   cannot be reproduced in a test here. Asserting the markup carries no NUL in
	   the first place pins the same invariant without needing a real DOM, and is
	   what would have caught it. */
	it("never writes a raw NUL into the markup", async () => {
		const { JD, feedBody } = loadJD(journeysModelFixture());
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();
		expect(feedBody.innerHTML).not.toContain("\x00");
	});

	it("opens the sheet via the .open class, matching #ovContext's convention, not `hidden`", async () => {
		const { JD, overlay, clickRow } = loadJD(journeysModelFixture());
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();
		clickRow(0);
		expect(overlay.added).toContain("open");
		expect(overlay.removed).not.toContain("open");
	});

	// Open journey A successfully, then open journey B: A's title/badge/date/
	// cost must not survive into B's "Loading…" — nor sit, unlabeled as stale,
	// under a "Could not load this journey." body if B's fetch then fails. The
	// clearing happens synchronously in `openTrace`, before the fetch's `.then`
	// ever runs, so seeding stale content directly (rather than awaiting a real
	// successful open first) still exercises the exact statement this guards.
	it("clears the previous journey's title and meta line while the next fetch is in flight", async () => {
		const { JD, sub, title, clickRow } = loadJD(journeysModelFixture());
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();
		title.textContent = "stale title from a previous journey";
		sub.innerHTML = '<span class="jtrace-badge" data-grouped-by="ticket">STALE-1</span>';

		clickRow(1);

		expect(title.textContent).toBe("Journey");
		expect(sub.innerHTML).toBe("");
	});

	// The other tests in this file resolve the trace fetch with a body that makes
	// `detail.journey.title` throw into `openTrace`'s `.catch` before
	// `#jtraceSub`/`#jtraceTitle` are ever written — a renamed element id or a
	// misspelled `JD.renderJourneyMeta` would leave every one of them green.
	// This test gives the trace fetch a real `{journey, commits, decisions}`
	// payload (and the feed fetch a real JourneysModel) so the success path runs.
	it("wires a real fetch payload into the meta line and title, not just the {} smoke test", async () => {
		const real = journey({ title: "wire the meta line for real" });
		const detail = {
			journey: real,
			commits: [
				{
					commitHash: "h1",
					message: "one",
					committedAtMs: real.startedAtMs,
					repoIdentity: "repo-a",
					repoName: "repo-a",
				},
				{
					commitHash: "h2",
					message: "two",
					committedAtMs: real.endedAtMs,
					repoIdentity: "repo-a",
					repoName: "repo-a",
				},
			],
			decisions: [{ text: "chose A over B", commitHash: "h1" }],
		};
		const { JD, sub, title, clickRow } = loadJD(detail, journeysModelFixture());
		JD.renderCoaching(coachingFixture());

		await JD.openFeedModal();
		clickRow(0);
		await settle();

		expect(title.textContent).toBe("wire the meta line for real");
		expect(sub.innerHTML).toContain("JOLLI-9");
		expect(sub.innerHTML).toContain("$1.25");
	});
});

describe("renderJourneyMeta", () => {
	it("names every measured figure and says activity, never elapsed time", () => {
		const { JD } = loadJD();

		const html = JD.renderJourneyMeta(
			journey({
				durationMinutes: 45,
				sessionCount: 3,
				costUsd: 1.5,
				availability: { ...journey().availability, duration: "measured" },
			}),
			"UTC",
		);

		expect(html).toContain("45");
		expect(html).toContain("activity");
		expect(html).toContain("3 sessions");
		expect(html).toContain("$1.50");
		expect(html).not.toMatch(/\belapsed\b|\btook\b|\bduration\b/iu);
	});

	it("omits an unmeasured figure from the meta row rather than printing 'not measured' or a zero", () => {
		const { JD } = loadJD();

		const html = JD.renderJourneyMeta(
			journey({
				durationMinutes: null,
				costUsd: null,
				sessionCount: 3,
				availability: { duration: "unavailable", turns: "measured", cost: "unavailable" },
			}),
			"UTC",
		);

		// The meta row shows measured metrics only — a bare "not measured" here
		// reads as noise, so an unmeasured duration/cost is dropped outright.
		expect(html).not.toContain("not measured");
		expect(html).not.toContain("min activity");
		expect(html).not.toContain("$");
		expect(html).not.toMatch(/>0</u);
		// The measured metrics still render.
		expect(html).toContain("3 sessions");
	});

	// sessionCount rides the same session join that gates `duration`'s
	// availability but carries no availability flag of its own — a journey
	// whose sessions never landed on this machine must not read as one nobody
	// worked on.
	it("omits the sessions figure entirely rather than printing 0 sessions", () => {
		const { JD } = loadJD();

		const html = JD.renderJourneyMeta(journey({ sessionCount: 0 }), "UTC");

		expect(html).not.toMatch(/0 sessions?/);
	});

	it("badges the grouping so a branch journey cannot pass as a ticket one", () => {
		const { JD } = loadJD();

		const branch = JD.renderJourneyMeta(journey({ groupedBy: "branch", ticket: null }), "UTC");
		expect(branch).toContain("feature/x");
		expect(branch).toContain('data-grouped-by="branch"');

		const ticket = JD.renderJourneyMeta(journey({ groupedBy: "ticket", ticket: "JOLLI-9" }), "UTC");
		expect(ticket).toContain("JOLLI-9");
		expect(ticket).toContain('data-grouped-by="ticket"');
	});

	it("escapes a hostile branch name", () => {
		const { JD } = loadJD();

		const html = JD.renderJourneyMeta(journey({ groupedBy: "branch", ticket: null, branch: "<img src=x>" }), "UTC");

		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});
});

describe("stageBands", () => {
	it("shows a plan band only when the journey was plan-first", () => {
		const { JD } = loadJD();

		expect(JD.stageBands(journey({ planFirst: true })).map((b) => b.key)).toEqual([
			"frame",
			"plan",
			"execute",
			"verify",
		]);
		expect(JD.stageBands(journey({ planFirst: false })).map((b) => b.key)).toEqual(["frame", "execute", "verify"]);
	});

	// `landed` was removed from the model as structurally always true. The cloud
	// draws a `land` band gated on it; drawing one here would claim every journey
	// landed, and drawing the not-landed variant would claim the opposite.
	it("never emits a land band", () => {
		const { JD } = loadJD();

		for (const planFirst of [true, false]) {
			expect(JD.stageBands(journey({ planFirst })).some((b) => b.key === "land")).toBe(false);
		}
	});

	it("shares sum to exactly 1 in both variants", () => {
		const { JD } = loadJD();

		for (const planFirst of [true, false]) {
			const total = JD.stageBands(journey({ planFirst })).reduce((sum, b) => sum + b.share, 0);
			expect(total).toBeCloseTo(1, 10);
		}
	});
});

describe("journeyFilters", () => {
	it("counts all three chips over the unfiltered list", () => {
		const { JD } = loadJD();
		const list = [journey({ planFirst: true }), journey({ planFirst: false }), journey({ planFirst: false })];

		expect(JD.journeyFilters(list)).toEqual([
			{ key: "all", label: "all", count: 3 },
			{ key: "plan-first", label: "plan-first", count: 1 },
			{ key: "straight", label: "straight to execute", count: 2 },
		]);
	});

	// `no land` stays absent — it needs `landed`, removed from the model as
	// structurally always true (§1.3). `flagged` IS now derived from turn-abort
	// friction, but is availability-gated: a journey with no `friction` field
	// (or none measurable) never produces a chip, so a feed with nothing
	// measurable still shows exactly the three base chips.
	it("offers no flagged or no-land chip when friction is unmeasured", () => {
		const { JD } = loadJD();

		const keys = JD.journeyFilters([journey()]).map((chip) => chip.key);

		expect(keys).toEqual(["all", "plan-first", "straight"]);
	});

	it("lists a flagged chip counting only positive-evidence friction", () => {
		const { JD } = loadJD();
		const list = [
			journey({ friction: { availability: "measured", value: 2 } }),
			journey({ friction: { availability: "measured", value: 0 } }),
			journey(), // no friction at all
		];

		const chips = JD.journeyFilters(list);

		expect(chips.find((chip) => chip.key === "flagged")?.count).toBe(1);
	});

	it("counts zero without claiming anything about the work", () => {
		const { JD } = loadJD();

		const chips = JD.journeyFilters([journey({ planFirst: false })]);

		expect(chips.find((chip) => chip.key === "plan-first")?.count).toBe(0);
	});
});

describe("the feed with a filter applied", () => {
	// `drafted first` / `straight through` are chosen to be disjoint as strings —
	// neither is a substring of the other. The original fixtures ("planned one" /
	// "unplanned one") were NOT: "planned one" is a substring of "unplanned one",
	// so `toContain("planned one")` is satisfied by the unplanned row alone and
	// asserts nothing about the planned row's presence.
	it("renders only the matching rows and marks the active chip", async () => {
		const { JD, feedBody } = loadJD(journeysModelFixture());
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		JD.applyJourneyFilter("plan-first");

		expect(feedBody.innerHTML).toContain("drafted first");
		expect(feedBody.innerHTML).not.toContain("straight through");
		expect(feedBody.innerHTML).toContain('data-filter="plan-first" class="jfchip on"');
	});

	// `flagged` filters on positive evidence — a measured, non-zero abort. A
	// friction-free journey and an unmeasured one both stay out.
	it("filters to the friction journeys when the flagged chip is applied", async () => {
		const feed = journeysModelFixture({
			journeys: [
				journey({
					id: "F\x00repo-a\x00f",
					title: "friction journey",
					friction: { availability: "measured", value: 1 },
				}),
				journey({ id: "G\x00repo-a\x00g", title: "clean journey", planFirst: false }),
			],
		});
		const { JD, feedBody } = loadJD(feed);
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		JD.applyJourneyFilter("flagged");

		expect(feedBody.innerHTML).toContain("friction journey");
		expect(feedBody.innerHTML).not.toContain("clean journey");
	});

	it("returns to every row when the all chip is applied", async () => {
		const { JD, feedBody } = loadJD(journeysModelFixture());
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		JD.applyJourneyFilter("plan-first");
		JD.applyJourneyFilter("all");

		expect(feedBody.innerHTML).toContain("drafted first");
		expect(feedBody.innerHTML).toContain("straight through");
		// Pins the row SET, not just two substring probes: with disjoint titles
		// the two `toContain`s above already carry real weight, but this is what
		// catches a matcher that let through some OTHER third row rather than
		// exactly these two.
		expect((feedBody.innerHTML.match(/class="jrow"/g) ?? []).length).toBe(2);
	});

	// The featured pair ranks over the WHOLE window, not the filtered subset — a
	// "smoothest" that changed when you filtered would be a different claim each
	// time, and the card says it ranks the window. It sits in the report
	// expansion, so filtering the modal must not touch it.
	it("leaves the featured cards unfiltered", async () => {
		const { JD, app, feedBody } = loadJD(journeysModelFixture());
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		JD.applyJourneyFilter("plan-first");

		expect(feedBody.innerHTML).toContain("drafted first");
		expect(feedBody.innerHTML).not.toContain("straight through");
		// The expansion's featured cards still name the whole window's pair.
		expect(app.innerHTML).toContain("smooth one");
		expect(app.innerHTML).toContain("hard one");
	});

	// I2 regression: `row(journey, index)` takes `index` from `map`, i.e. the
	// position in whichever array was RENDERED. Once a filter can hide rows, the
	// unfiltered `feed.journeys` and the rendered array are different arrays with
	// different orders — indexing the wrong one opens a different journey's
	// trace while the sheet fills in without complaint, so this cannot be caught
	// by asserting on the visible text alone. The two journeys below are ordered
	// so the bug and the fix disagree: unfiltered index 0 is the STRAIGHT
	// journey, but under the plan-first filter the only rendered row (index 0)
	// must be the PLANNED one.
	it("resolves a row click against the FILTERED array, not the unfiltered one", async () => {
		const fixture = journeysModelFixture({
			journeys: [
				journey({ id: "S\x00repo-a\x00s", title: "straight one", planFirst: false }),
				journey({ id: "P\x00repo-a\x00p", title: "planned one", planFirst: true }),
			],
		});
		const { JD, fetchCalls, clickRow } = loadJD(fixture);
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		JD.applyJourneyFilter("plan-first");
		clickRow(0);

		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls[1]).toContain(`id=${encodeURIComponent("P\x00repo-a\x00p")}`);
		expect(fetchCalls[1]).not.toContain(`id=${encodeURIComponent("S\x00repo-a\x00s")}`);
	});

	// Exercises the actual DOM wiring (`element.addEventListener("click", …)` in
	// `renderFeedInto`), not just the `applyJourneyFilter` call the tests above
	// make directly — this is what would have caught a chip rendered without its
	// click handler ever attached.
	it("filters the feed when a chip is actually clicked", async () => {
		const { JD, feedBody, clickChip } = loadJD(journeysModelFixture());
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		clickChip("plan-first");

		expect(feedBody.innerHTML).toContain("drafted first");
		expect(feedBody.innerHTML).not.toContain("straight through");
	});

	// This is a DIFFERENT empty state from "shows an empty state rather than an
	// empty page" above: that one fires when the range itself has no journeys.
	// Here the range has journeys, but the filter hides all of them — a reader
	// applying `plan-first` to an all-straight-through window would otherwise
	// see chips and a silently empty `.jfeed` with no explanation. The chips
	// must stay visible so the reader can get back.
	it("says the filter matched nothing rather than rendering an empty feed", async () => {
		const fixture = journeysModelFixture({
			journeys: [journey({ id: "A\x00r\x00a", title: "straight through", planFirst: false })],
		});
		const { JD, feedBody, clickChip } = loadJD(fixture);
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		clickChip("plan-first");

		expect(feedBody.innerHTML).toMatch(/no journeys match this filter/i);
		expect(feedBody.innerHTML).toContain("jfchips");
	});
});

describe("shouldGroupByDay", () => {
	const onDay = (dayIndex: number) => journey({ endedAtMs: Date.UTC(2026, 0, 1 + dayIndex, 12) });

	it("groups when the window holds few enough days to stay scannable", () => {
		const { JD } = loadJD();

		expect(
			JD.shouldGroupByDay(
				Array.from({ length: 46 }, (_v, i) => onDay(i % 19)),
				"UTC",
			),
		).toBe(true);
	});

	// The cap's exact value is this task's entire content, so it gets pinned on
	// both sides. Without these, a cap of 20 or 50 — or a `<` where `<=` was
	// meant — passes every other test in this block unchanged.
	it("groups at exactly the cap", () => {
		const { JD } = loadJD();

		expect(
			JD.shouldGroupByDay(
				Array.from({ length: 31 }, (_v, i) => onDay(i)),
				"UTC",
			),
		).toBe(true);
	});

	it("stops grouping one day past the cap", () => {
		const { JD } = loadJD();

		expect(
			JD.shouldGroupByDay(
				Array.from({ length: 32 }, (_v, i) => onDay(i)),
				"UTC",
			),
		).toBe(false);
	});

	// Measured: 90d yields 52 header days and `all` yields 110, against 229 rows.
	// Grouping there is one header per two rows — a feed made mostly of headers.
	it("does not group when the window would be mostly headers", () => {
		const { JD } = loadJD();

		expect(
			JD.shouldGroupByDay(
				Array.from({ length: 114 }, (_v, i) => onDay(i % 52)),
				"UTC",
			),
		).toBe(false);
	});

	it("is decided by header count, not density", () => {
		const { JD } = loadJD();
		// Both have the same journeys-per-day ratio (2). Only the header count
		// differs, and only that may decide the outcome — density is flat at
		// 2.1-2.4 in every real window, so a density rule cannot discriminate.
		const dense = Array.from({ length: 20 }, (_v, i) => onDay(i % 10));
		const long = Array.from({ length: 120 }, (_v, i) => onDay(i % 60));

		expect(JD.shouldGroupByDay(dense, "UTC")).toBe(true);
		expect(JD.shouldGroupByDay(long, "UTC")).toBe(false);
	});
});

describe("the feed with day grouping", () => {
	it("emits one header per day, newest first, when grouping applies", async () => {
		const { JD, feedBody } = loadJD(
			journeysModelFixture({
				journeys: [
					journey({ id: "A\x00r\x00a", title: "later", endedAtMs: Date.UTC(2026, 0, 2, 12) }),
					journey({ id: "B\x00r\x00b", title: "earlier", endedAtMs: Date.UTC(2026, 0, 1, 12) }),
				],
			}),
		);
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		expect((feedBody.innerHTML.match(/class="jfday"/gu) ?? []).length).toBe(2);
		expect(feedBody.innerHTML.indexOf("later")).toBeLessThan(feedBody.innerHTML.indexOf("earlier"));
	});

	it("emits no day header at all when grouping does not apply", async () => {
		const { JD, feedBody } = loadJD(
			journeysModelFixture({
				journeys: Array.from({ length: 120 }, (_v, i) =>
					journey({ id: `J${i}\x00r\x00x`, endedAtMs: Date.UTC(2026, 0, 1 + (i % 60), 12) }),
				),
			}),
		);
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		expect(feedBody.innerHTML).not.toContain("jfday");
	});

	// This is the click-index trap one layer further along: day headers are
	// extra elements interleaved with the rows, so an implementation that counts
	// rendered ELEMENTS rather than tracking each row's position in the FILTERED
	// array would drift as soon as both a filter and grouping are active at once.
	it("resolves a row click against the filtered row's own journey when headers are interleaved", async () => {
		const straight = journey({
			id: "S\x00repo-a\x00s",
			title: "straight one",
			planFirst: false,
			endedAtMs: Date.UTC(2026, 0, 2, 12),
		});
		const plannedDay1 = journey({
			id: "P1\x00repo-a\x00p1",
			title: "planned day one",
			planFirst: true,
			endedAtMs: Date.UTC(2026, 0, 2, 9),
		});
		const plannedDay2 = journey({
			id: "P2\x00repo-a\x00p2",
			title: "planned day two",
			planFirst: true,
			endedAtMs: Date.UTC(2026, 0, 1, 9),
		});
		const fixture = journeysModelFixture({ journeys: [straight, plannedDay1, plannedDay2] });
		const { JD, fetchCalls, clickRow } = loadJD(fixture);
		JD.renderCoaching(coachingFixture());
		await JD.openFeedModal();

		JD.applyJourneyFilter("plan-first");
		// Filtered rows, in rendered order: plannedDay1 (index 0), plannedDay2
		// (index 1) — `straight` is filtered out entirely. A day header sits
		// ahead of each of them, so clicking the SECOND rendered `.jrow` must
		// still resolve to `plannedDay2`, not to whichever journey happens to be
		// second among all rendered DOM children.
		clickRow(1);

		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls[1]).toContain(`id=${encodeURIComponent(plannedDay2.id)}`);
		expect(fetchCalls[1]).not.toContain(`id=${encodeURIComponent(plannedDay1.id)}`);
		expect(fetchCalls[1]).not.toContain(`id=${encodeURIComponent(straight.id)}`);
	});
});
