/**
 * Runtime test for the Skills / MCPs cards' "Show more" paging in `stats.js`.
 *
 * These lists are the one thing on the stats page that pages in SQL: the model
 * carries {@link TOOL_ROWS_LIMIT} rows plus the whole window's totals, and every
 * row past that comes from `/api/tool-usage`. Three behaviours have no other
 * cover, and each one fails silently in the browser:
 *
 *   - the footer must appear only while `rows.length < *Total`, and print the
 *     SERVER's totals rather than a sum of the rows on screen;
 *   - a fetched page must be appended and deduped (an offset can repeat a row
 *     that shifted across the boundary, never invent one);
 *   - past the first page the list must scroll INSIDE the card — a measured
 *     `max-height` — while a list still on its first page gets no cap and so no
 *     scrollbar.
 *
 * `assets/js/*.js` is plain JavaScript served verbatim, so tsc never sees it;
 * this drives the real IIFEs against a stub document, following the same pattern
 * as `FeedCardAsset.test.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_ROWS_LIMIT } from "./DashboardModel.js";

interface FakeStyle {
	maxHeight?: string;
	[key: string]: string | undefined;
}

/** A ranked-list <ul> stub: laid-out children, a class list and a scroll position. */
interface FakeList {
	readonly children: ReadonlyArray<{ offsetTop: number; offsetHeight: number }>;
	readonly style: FakeStyle;
	readonly classes: string[];
	classList: { add: (name: string) => void };
	scrollTop: number;
}

interface FakeButton {
	getAttribute: (name: string) => string | null;
	onclick?: () => void;
}

interface Harness {
	// biome-ignore lint/suspicious/noExplicitAny: the asset scripts are plain JS; the model is deliberately untyped.
	readonly JD: any;
	/** #app's innerHTML after the last render. */
	html: () => string;
	/** Renders, and returns the wired "Show more" buttons keyed by list. */
	render: (model: unknown) => Map<string, FakeButton>;
	/** The <ul> stub `capToolLists` / `revealToolRows` will find for one list. */
	list: (name: string) => FakeList;
	/** Every URL `JD.getJson` was asked for, in order. */
	readonly fetched: string[];
	/** Replaces the browser's current model, as `JD.refreshNow` does after a poll. */
	setCurrentModel: (model: unknown) => void;
}

/**
 * One row of laid-out geometry per loaded row, so the measured cap is
 * predictable: row i sits at `i * 50` and is 40 tall, making eight rows
 * `7 * 50 + 40 = 390`.
 */
const ROW_PITCH = 50;
const ROW_HEIGHT = 40;

function loadHarness(rowCounts: Record<string, number> = {}): Harness {
	const fetched: string[] = [];
	const lists = new Map<string, FakeList>();
	for (const [name, count] of Object.entries(rowCounts)) {
		const children = Array.from({ length: count }, (_, i) => ({
			offsetTop: i * ROW_PITCH,
			offsetHeight: ROW_HEIGHT,
		}));
		const classes: string[] = [];
		const style: FakeStyle = {};
		lists.set(name, {
			children,
			style,
			classes,
			classList: { add: (cls: string) => classes.push(cls) },
			scrollTop: 0,
		});
	}
	let buttons = new Map<string, FakeButton>();

	const element = () => ({
		innerHTML: "",
		style: {} as Record<string, string>,
		querySelectorAll: () => [] as ReadonlyArray<never>,
		querySelector: () => null,
		addEventListener: () => undefined,
	});
	const elements = new Map<string, ReturnType<typeof element>>();
	const doc = {
		getElementById: (id: string) => {
			if (!elements.has(id)) elements.set(id, element());
			return elements.get(id);
		},
		// Only the two selectors this test is about are answered; every other
		// wiring query in renderStats gets an empty list, as it does in
		// FeedCardAsset's harness.
		querySelectorAll: (selector: string) => {
			if (selector === "[data-toollist]") return [...lists.values()];
			if (selector === "[data-toolmore]") {
				buttons = new Map();
				// Built from the rendered HTML, so a card that stopped emitting its
				// footer stops producing a button here too.
				for (const match of (elements.get("app")?.innerHTML ?? "").matchAll(/data-toolmore="([a-z]+)"/g)) {
					const list = match[1] as string;
					buttons.set(list, { getAttribute: (name) => (name === "data-toolmore" ? list : null) });
				}
				return [...buttons.values()];
			}
			return [] as ReadonlyArray<never>;
		},
		querySelector: (selector: string) => {
			const hit = /^\[data-toollist="([a-z]+)"\]$/.exec(selector);
			return hit ? (lists.get(hit[1] as string) ?? null) : null;
		},
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
	// biome-ignore lint/suspicious/noExplicitAny: see the Harness comment.
	const JD = win.JD as any;
	JD.getJson = (path: string) => {
		fetched.push(path);
		return Promise.resolve({ rows: [], totalCount: 0 });
	};
	const render = (model: unknown): Map<string, FakeButton> => {
		// `main.js` seeds this once at boot. Local re-renders keep the same object;
		// only refreshNow replaces it, which the paging code detects by identity.
		if (!("__JOLLI_DASHBOARD__" in win)) win.__JOLLI_DASHBOARD__ = model;
		const app = doc.getElementById("app");
		if (app) app.innerHTML = "";
		JD.renderStats(model);
		// `renderPage` is main.js's job in the browser; here it is the real
		// re-render, which is what every paging handler ends in.
		JD.renderPage = render;
		return buttons;
	};
	JD.renderPage = render;
	return {
		JD,
		html: () => doc.getElementById("app")?.innerHTML ?? "",
		render,
		list: (name: string) => {
			const hit = lists.get(name);
			if (!hit) throw new Error(`no list stub for ${name}`);
			return hit;
		},
		fetched,
		setCurrentModel: (model: unknown) => {
			win.__JOLLI_DASHBOARD__ = model;
		},
	};
}

const skillRow = (i: number) => ({
	name: `skill${String(i).padStart(2, "0")}`,
	kind: "skill",
	sessions: 20 - i,
	calls: 20 - i,
	agents: [{ source: "claude", calls: 20 - i }],
});

const serverRow = (i: number) => ({
	server: `server${String(i).padStart(2, "0")}`,
	sessions: 20 - i,
	calls: 20 - i,
	tools: 1,
	agents: [{ source: "claude", calls: 20 - i }],
});

function model(toolUsageOver: Record<string, unknown> = {}): unknown {
	return {
		schemaVersion: 1,
		view: "stats",
		tier: "memory",
		generatedAtMs: Date.parse("2026-07-30T12:00:00Z"),
		timeZone: "UTC",
		scope: { kind: "all" },
		// One enrolled repo, because `renderStats` short-circuits an empty registry
		// to `noReposCard()` — every card below, paging footer included, is then
		// never rendered and each assertion here fails against the empty state
		// rather than against the behaviour it names. See the comment on that card.
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
			memoryCards: [],
			range: "month",
			rangeFrom: "2026-07-01",
			rangeTo: "2026-07-30",
			toolUsage: {
				skills: Array.from({ length: TOOL_ROWS_LIMIT }, (_, i) => skillRow(i)),
				skillsTotal: TOOL_ROWS_LIMIT + 4,
				skillCallsTotal: 200,
				servers: Array.from({ length: TOOL_ROWS_LIMIT }, (_, i) => serverRow(i)),
				serversTotal: TOOL_ROWS_LIMIT + 7,
				serverCallsTotal: 375,
				mcpTools: Array.from({ length: TOOL_ROWS_LIMIT }, (_, i) => ({ ...skillRow(i), kind: "mcp" })),
				mcpToolsTotal: 42,
				skillAgents: [{ source: "claude", sessions: 4, calls: 200 }],
				mcpAgents: [{ source: "claude", sessions: 4, calls: 375 }],
				sessionsWithTools: 4,
				sessionsInWindow: 4,
				uncoveredSources: [],
				...toolUsageOver,
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
		},
	};
}

/** One microtask hop past the stubbed fetch, plus the render it ends in. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("tool-usage lists — header totals", () => {
	it("prints the window's totals, not a sum of the page on screen", () => {
		const h = loadHarness();
		h.render(model());
		// The page holds 8 skills worth 116 runs; the window holds 12 worth 200.
		// Summing the rows — what this used to do — made the header disagree with
		// the footer and change on every Show more click.
		expect(h.html()).toContain("200 runs · 12 skills");
		expect(h.html()).toContain("15 servers · 375 calls");
	});

	it("keeps the singular/plural wording on a one-row window", () => {
		const h = loadHarness();
		h.render(
			model({
				skills: [skillRow(0)],
				skillsTotal: 1,
				skillCallsTotal: 1,
				servers: [serverRow(0)],
				serversTotal: 1,
				serverCallsTotal: 1,
			}),
		);
		expect(h.html()).toContain("1 run · 1 skill");
		expect(h.html()).toContain("1 server · 1 call");
	});
});

describe("tool-usage lists — the Show more footer", () => {
	it("offers one page per click, naming what is loaded against the window's total", () => {
		const h = loadHarness();
		h.render(model());
		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT} of ${TOOL_ROWS_LIMIT + 4} skills`);
		expect(h.html()).toContain('data-toolmore="skill"');
		// Not JD.moreToggle's promise: this costs a round trip, so it never claims
		// to finish the list in one click.
		expect(h.html()).not.toContain(`Show all ${TOOL_ROWS_LIMIT + 4}`);
		expect(h.html()).toContain("Show more");
	});

	it("shows nothing once every row is loaded", () => {
		const h = loadHarness();
		h.render(
			model({
				skillsTotal: TOOL_ROWS_LIMIT,
				serversTotal: TOOL_ROWS_LIMIT,
				mcpToolsTotal: TOOL_ROWS_LIMIT,
			}),
		);
		// A footer that can only ever read "N of N" is noise on the common
		// small-corpus page.
		expect(h.html()).not.toContain("data-toolmore");
		expect(h.html()).not.toContain("Showing");
	});

	it("pages the MCPs card along whichever split is on screen", () => {
		const h = loadHarness();
		h.JD.mcpSplitView = "server";
		h.render(model());
		expect(h.html()).toContain('data-toolmore="server"');
		expect(h.html()).not.toContain('data-toolmore="tool"');

		h.JD.mcpSplitView = "tool";
		h.render(model());
		expect(h.html()).toContain('data-toolmore="tool"');
		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT} of 42 tools`);
		expect(h.html()).not.toContain('data-toolmore="server"');
	});
});

describe("tool-usage lists — fetching a page", () => {
	it("asks for the next offset, carrying the page's scope and range", async () => {
		const h = loadHarness();
		h.JD.getJson = (path: string) => {
			h.fetched.push(path);
			return Promise.resolve({ list: "skill", offset: TOOL_ROWS_LIMIT, rows: [skillRow(9)], totalCount: 9 });
		};
		const buttons = h.render(model());
		buttons.get("skill")?.onclick?.();
		await settle();
		// The window params ride along because the rows are an aggregate OVER a
		// window: paging with a different one would append rows counted from a
		// different set.
		expect(h.fetched).toEqual([`/api/tool-usage?range=month&dimension=model&list=skill&offset=${TOOL_ROWS_LIMIT}`]);
	});

	it("appends the page and moves the footer, keeping the card's other rows", async () => {
		const h = loadHarness();
		const fresh = [skillRow(9), skillRow(10)];
		// `totalCount` is re-read per page, not remembered from the first render:
		// the window keeps gaining rows while the dashboard is open.
		h.JD.getJson = () => Promise.resolve({ list: "skill", offset: TOOL_ROWS_LIMIT, rows: fresh, totalCount: 13 });
		const buttons = h.render(model());
		buttons.get("skill")?.onclick?.();
		await settle();
		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT + 2} of 13 skills`);
		expect(h.html()).toContain("skill09");
		expect(h.html()).toContain("skill10");
		// The MCPs card is untouched — a click on one list must not reset another.
		expect(h.html()).toContain('data-toolmore="server"');
	});

	it("does not confuse a prototype property with an already-loaded tool", async () => {
		const h = loadHarness();
		const special = { ...skillRow(9), name: "__proto__" };
		h.JD.getJson = () =>
			Promise.resolve({
				list: "skill",
				offset: TOOL_ROWS_LIMIT,
				rows: [special],
				totalCount: TOOL_ROWS_LIMIT + 1,
			});
		const buttons = h.render(model());
		buttons.get("skill")?.onclick?.();
		await settle();
		expect(h.html()).toContain("/__proto__");
	});

	it("keeps the footer, count only, once the last page has landed", async () => {
		const h = loadHarness();
		h.JD.getJson = () =>
			Promise.resolve({
				list: "skill",
				offset: TOOL_ROWS_LIMIT,
				rows: [skillRow(9), skillRow(10), skillRow(11), skillRow(12)],
				totalCount: TOOL_ROWS_LIMIT + 4,
			});
		const buttons = h.render(model());
		buttons.get("skill")?.onclick?.();
		await settle();
		// The button is gone — there is nothing left to fetch — but the ROW stays, or
		// the card visibly shrinks on the one click that was supposed to change
		// nothing but its rows (measured in a real browser: 729px → 689px).
		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT + 4} of ${TOOL_ROWS_LIMIT + 4} skills`);
		expect(h.html()).toContain('class="more-row is-done"');
		expect(h.html()).not.toContain('data-toolmore="skill"');
	});

	it("drops a row the page repeats, and retires the footer when every row is a repeat", async () => {
		const h = loadHarness();
		// A call arriving mid-browse shifts a row across the offset boundary, so the
		// next page can hand back one the client already holds. It can never invent
		// one, which is why an all-repeats page means "nothing after this".
		h.JD.getJson = () =>
			Promise.resolve({ list: "skill", offset: TOOL_ROWS_LIMIT, rows: [skillRow(0)], totalCount: 99 });
		const buttons = h.render(model());
		buttons.get("skill")?.onclick?.();
		await settle();
		expect(h.html()).not.toContain('data-toolmore="skill"');
		// Believe the rows over the total: offering a click that cannot add anything
		// is a button that visibly does nothing.
		expect(h.html()).not.toContain("of 99 skills");
		// The row still holds its place, same as any other last page.
		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT} of ${TOOL_ROWS_LIMIT} skills`);
	});

	it("states a failed load next to the count it stopped from growing", async () => {
		const h = loadHarness();
		h.JD.getJson = () => Promise.reject(new Error("offline"));
		const buttons = h.render(model());
		buttons.get("skill")?.onclick?.();
		await settle();
		expect(h.html()).toContain("could not load more");
		expect(h.html()).toContain("Try again");
		// Still the same loaded count — the failure did not pretend to grow it.
		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT} of ${TOOL_ROWS_LIMIT + 4} skills`);
	});

	it("ignores a second click while the first is still in flight", async () => {
		const h = loadHarness();
		let calls = 0;
		h.JD.getJson = () => {
			calls += 1;
			return new Promise(() => undefined);
		};
		const buttons = h.render(model());
		const button = buttons.get("skill");
		button?.onclick?.();
		// The re-render disables the button, but the handler must hold the invariant
		// itself — the disabled attribute is a hint, not the guard.
		h.render(model());
		button?.onclick?.();
		await settle();
		expect(calls).toBe(1);
	});

	it("does not repaint an old page response over a newer polled model", async () => {
		const h = loadHarness();
		let resolvePage: ((page: unknown) => void) | undefined;
		h.JD.getJson = () =>
			new Promise((resolve) => {
				resolvePage = resolve;
			});
		const oldModel = model();
		const buttons = h.render(oldModel);
		buttons.get("skill")?.onclick?.();

		// Mirror refreshNow: replace the global object before rendering the poll's
		// fresh first page. The in-flight response still closes over `oldModel`.
		const freshModel = model({ skillsTotal: TOOL_ROWS_LIMIT });
		h.setCurrentModel(freshModel);
		h.render(freshModel);
		resolvePage?.({ list: "skill", offset: TOOL_ROWS_LIMIT, rows: [skillRow(9)], totalCount: TOOL_ROWS_LIMIT + 1 });
		await settle();

		expect(h.html()).not.toContain("skill09");
		expect(h.html()).not.toContain('data-toolmore="skill"');
	});
});

describe("tool-usage lists — the scroll cap", () => {
	it("leaves a first-page list uncapped, so the default rows carry no scrollbar", () => {
		const h = loadHarness({ skill: TOOL_ROWS_LIMIT });
		h.render(model());
		expect(h.list("skill").style.maxHeight).toBeUndefined();
		expect(h.list("skill").classes).toEqual([]);
	});

	it("caps a grown list to the measured height of its first page", () => {
		const h = loadHarness({ skill: TOOL_ROWS_LIMIT + 4 });
		h.render(model());
		// Measured off the real rows, never a CSS constant: a row is a line of
		// variable-length text plus a bar, so its height is a font measurement.
		expect(h.list("skill").style.maxHeight).toBe(`${(TOOL_ROWS_LIMIT - 1) * ROW_PITCH + ROW_HEIGHT}px`);
		expect(h.list("skill").classes).toEqual(["rl-scroll"]);
	});

	it("leaves an unlaid-out list alone rather than capping it to zero", () => {
		const h = loadHarness({ skill: TOOL_ROWS_LIMIT + 4 });
		// A hidden card measures 0 — capping to that would hide every row, where
		// staying uncapped only costs the card its fixed height until the next paint.
		for (const child of h.list("skill").children as Array<{ offsetTop: number; offsetHeight: number }>) {
			child.offsetTop = 0;
			child.offsetHeight = 0;
		}
		h.render(model());
		expect(h.list("skill").style.maxHeight).toBeUndefined();
		expect(h.list("skill").classes).toEqual([]);
	});

	it("scrolls the rows a click just fetched into view, once", async () => {
		const h = loadHarness({ skill: TOOL_ROWS_LIMIT + 1 });
		h.JD.getJson = () =>
			Promise.resolve({ list: "skill", offset: TOOL_ROWS_LIMIT, rows: [skillRow(9)], totalCount: 9 });
		const buttons = h.render(model());
		expect(h.list("skill").scrollTop).toBe(0);
		buttons.get("skill")?.onclick?.();
		await settle();
		// The new rows start at the top of the visible window; without this the card
		// looks unchanged and only the footer count moves.
		expect(h.list("skill").scrollTop).toBe(TOOL_ROWS_LIMIT * ROW_PITCH);

		// And not again on the next repaint — a sticky reveal would yank the reader
		// back to that row on every 30 s model poll.
		h.list("skill").scrollTop = 120;
		h.render(model({ skills: Array.from({ length: TOOL_ROWS_LIMIT + 1 }, (_, i) => skillRow(i)) }));
		expect(h.list("skill").scrollTop).toBe(120);
	});
});
