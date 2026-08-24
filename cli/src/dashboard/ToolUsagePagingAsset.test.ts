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
	/**
	 * Drives the REAL `JD.refreshNow` with `fresh` as the polled payload, so the
	 * carry-forward seam is exercised through shell.js's own ordering rather than
	 * through a copy of it in this file. `fetch` is injected into the asset scripts'
	 * scope, which is what makes that possible without touching a global.
	 */
	poll: (fresh: unknown) => Promise<void>;
	/** The model the page is currently rendered from — the poll replaces it. */
	// biome-ignore lint/suspicious/noExplicitAny: as JD above.
	current: () => any;
}

/**
 * One row of laid-out geometry per loaded row, so the measured cap is
 * predictable: row i sits at `i * 50` and is 40 tall, making eight rows
 * `7 * 50 + 40 = 390`.
 */
const ROW_PITCH = 50;
const ROW_HEIGHT = 40;
const GENERATED_AT_MS = Date.parse("2026-07-30T12:00:00Z");

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

	const element = (id?: string) => {
		let html = "";
		return {
			get innerHTML() {
				return html;
			},
			set innerHTML(next: string) {
				html = next;
				// In the browser, rewriting #app destroys every ranked <ul>, and each
				// replacement starts at row 1. These stubs are reused across renders, so
				// that has to be modelled at the ASSIGNMENT — the renderer snapshots the
				// offsets just before it, and resetting any earlier would make the
				// snapshot read zeroes and hide a broken restore.
				if (id === "app") for (const stub of lists.values()) stub.scrollTop = 0;
			},
			style: {} as Record<string, string>,
			querySelectorAll: () => [] as ReadonlyArray<never>,
			querySelector: () => null,
			addEventListener: () => undefined,
		};
	};
	const elements = new Map<string, ReturnType<typeof element>>();
	const doc = {
		getElementById: (id: string) => {
			if (!elements.has(id)) elements.set(id, element(id));
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
	/** The payload the next `JD.refreshNow` will receive from `/api/model`. */
	let polled: unknown = null;
	const fakeFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(polled) });
	for (const file of ["format.js", "shell.js", "charts.js", "stats.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		// `fetch` is a free variable in shell.js, so passing it here shadows the real
		// global for these modules alone — no process-wide stub to undo.
		new Function("window", "document", "fetch", src)(win, doc, fakeFetch);
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
		// Deliberately NOT clearing #app first: `renderStats` assigns it on every
		// path, and that assignment is what resets the list stubs' scroll (see the
		// innerHTML setter). Clearing here would fire the reset BEFORE the renderer
		// reads the offsets it is meant to restore.
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
		poll: async (fresh: unknown) => {
			polled = fresh;
			JD.refreshNow(render);
			await settle();
		},
		current: () => win.__JOLLI_DASHBOARD__,
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
		generatedAtMs: GENERATED_AT_MS,
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
				serverToolsTotal: 41,
				skillAgents: [{ source: "claude", sessions: 4, calls: 200 }],
				mcpAgents: [{ source: "claude", sessions: 4, calls: 375 }],
				sessionsWithTools: 4,
				sessionsInWindow: 4,
				uncoveredSources: [],
				...toolUsageOver,
			},
			tokenBreakdown: { input: 0, output: 0, cached: 0, perDay: [] },
		},
	};
}

/** One microtask hop past the stubbed fetch, plus the render it ends in. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ranked rows — the per-agent tag", () => {
	const FIVE_AGENTS = ["claude", "codex", "cursor-agent", "opencode", "kimi"].map((source) => ({ source, calls: 5 }));

	it("folds past two agents into a +N, with the full list behind a tooltip", () => {
		const h = loadHarness();
		h.render(
			model({
				servers: [{ ...serverRow(0), agents: FIVE_AGENTS }],
				serversTotal: 1,
				serverCallsTotal: 20,
			}),
		);
		// `.rl-kind` is `flex: none` — it never shrinks and never ellipsises, so an
		// unbounded name list does not truncate, it PUSHES. Measured in a real browser
		// at 1200px with eight agents: the slot wanted 402px of a 261px row, which left
		// the tool name -203px, i.e. rendered at 0 wide with no ellipsis to show for it,
		// and armed a horizontal scrollbar on the list and the page. Folded: 131px.
		expect(h.html()).toContain("1 tool · claude · codex +3");
		// `+3` is only honest if the three are reachable.
		expect(h.html()).toContain('title="1 tool · claude · codex · cursor-agent · opencode · kimi"');
	});

	it("leaves two or fewer agents whole, and gives them no tooltip", () => {
		const h = loadHarness();
		h.render(
			model({
				servers: [
					{
						...serverRow(0),
						agents: [
							{ source: "claude", calls: 5 },
							{ source: "codex", calls: 3 },
						],
					},
				],
				serversTotal: 1,
				serverCallsTotal: 8,
			}),
		);
		// No `title` at all: a tooltip repeating the text under the pointer is noise,
		// and it would claim there is more to see when there is not.
		expect(h.html()).toContain('<span class="rl-kind">1 tool · claude · codex</span>');
		expect(h.html()).not.toContain("+0");
	});

	it("emits no meta slot at all for a row with nothing to put in it", () => {
		const h = loadHarness();
		// `agents: []` is the shape `DashboardQuery`'s defensive `?? []` can hand a
		// row. Read on a Skills row because Skills passes NO kind at all, so this is
		// the list where an accidental empty slot would show up first; the MCP lists
		// always spend theirs on a tool/session count.
		h.render(model({ skills: [{ ...skillRow(0), agents: [] }], skillsTotal: 1, skillCallsTotal: 20 }));
		// An empty `.rl-kind` is not free: it is still a flex item, so it spends one of
		// `.rl-top`'s 8px gaps and takes those pixels off the name, which is the only
		// thing in the row that truncates. `withAgents` returns its object
		// unconditionally, so the emptiness has to be tested on `.text`.
		//
		// Asserted as name-then-value with nothing between, rather than as "no
		// `rl-kind` anywhere": `html()` is the whole page, and the MCPs card below
		// carries a populated slot on every one of its rows.
		expect(h.html()).toContain('title="/skill00">/skill00</span><span class="rl-val num">20 runs</span>');
	});

	it("folds a Skills row too, in the LEAD rather than the meta slot", () => {
		const h = loadHarness();
		h.render(model({ skills: [{ ...skillRow(0), agents: FIVE_AGENTS }], skillsTotal: 1, skillCallsTotal: 20 }));
		// Skills states its agents as brand marks AHEAD of the name (`agentBadges`),
		// not as the name list the MCP lists put in the trailing slot. So the fold
		// that keeps a five-agent row from pushing the name to 0 wide happens in
		// `.rl-lead`, past `LEAD_AGENT_MARKS` — and it folds harder, to one mark plus
		// a count, because that slot's width is what holds every skill name at the
		// same x.
		expect(h.html()).toContain('<span class="src-more" title="codex, cursor-agent, opencode, kimi">+4</span>');
		// `+4` is only honest if the four are reachable, which is what that title is
		// for — the same bargain `.rl-kind`'s tooltip makes on an MCP row.
		//
		// And nothing lands in the trailing slot: asserted as name-then-value with
		// nothing between, rather than as "no `rl-kind` anywhere", because `html()`
		// is the whole page and the MCPs card below carries a populated one.
		expect(h.html()).toContain('title="/skill00">/skill00</span><span class="rl-val num">20 runs</span>');
	});
});

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
		expect(h.fetched).toEqual([
			`/api/tool-usage?range=month&dimension=model&list=skill&offset=${TOOL_ROWS_LIMIT}&nowMs=${GENERATED_AT_MS}`,
		]);
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
		// back to that row on every 30 s model poll. The repaint replaces the <ul>, so
		// what puts the list back at 120 is `restoreToolScroll`, whose whole job is "do
		// not move". A second reveal would land on TOOL_ROWS_LIMIT * ROW_PITCH instead,
		// which is a different number precisely so the two cannot be confused: 0 is not
		// available as the assertion here, because every repaint now restores.
		h.list("skill").scrollTop = 120;
		h.render(model({ skills: Array.from({ length: TOOL_ROWS_LIMIT + 1 }, (_, i) => skillRow(i)) }));
		expect(h.list("skill").scrollTop).toBe(120);
	});
});

/** Skills in the window — the model's own `skillsTotal`, so a poll can reuse it. */
const SKILLS_TOTAL = TOOL_ROWS_LIMIT + 4;
/** Rows on screen after the one Show more click these tests make. */
const GROWN = TOOL_ROWS_LIMIT + 2;

/**
 * One Show more click on the Skills list, leaving it displaying {@link GROWN} of
 * {@link SKILLS_TOTAL}. Returns the rows a verification read hands back for
 * "nothing changed" — the first page plus what the click appended.
 */
async function expandSkills(h: Harness): Promise<Array<Record<string, unknown>>> {
	const appended = [skillRow(TOOL_ROWS_LIMIT), skillRow(TOOL_ROWS_LIMIT + 1)];
	h.JD.getJson = (path: string) => {
		h.fetched.push(path);
		return Promise.resolve({ list: "skill", offset: TOOL_ROWS_LIMIT, rows: appended, totalCount: SKILLS_TOTAL });
	};
	const buttons = h.render(model());
	buttons.get("skill")?.onclick?.();
	await settle();
	return [...Array.from({ length: TOOL_ROWS_LIMIT }, (_, i) => skillRow(i)), ...appended];
}

/** Answers the poll's verification read, and records the URL it asked for. */
function verifyWith(h: Harness, answer: unknown): void {
	h.JD.getJson = (path: string) => {
		h.fetched.push(path);
		return Promise.resolve(answer);
	};
}

describe("tool-usage lists — carrying an expansion across the 30 s poll", () => {
	it("keeps the rows, re-reading the list at the width on screen", async () => {
		const h = loadHarness({ skill: GROWN });
		const onScreen = await expandSkills(h);
		expect(h.html()).toContain(`Showing ${GROWN} of ${SKILLS_TOTAL} skills`);

		h.fetched.length = 0;
		verifyWith(h, { list: "skill", offset: 0, rows: onScreen, totalCount: SKILLS_TOTAL });
		await h.poll(model());

		// From the top, as wide as the list is displayed. The width is the rows on
		// screen and never a click count: a page that came back holding a row already
		// loaded is deduped, and from then on a counter asks for more rows than are
		// displayed, which reads as "changed" forever.
		expect(h.fetched).toEqual([
			`/api/tool-usage?range=month&dimension=model&list=skill&offset=0&limit=${GROWN}&nowMs=${GENERATED_AT_MS}`,
		]);
		// Nothing moved, so the poll left the card exactly as the reader had it. Before
		// this, `/api/model`'s first page silently replaced it every 30 s.
		expect(h.html()).toContain(`Showing ${GROWN} of ${SKILLS_TOTAL} skills`);
		expect(h.html()).toContain("skill09");
	});

	it("collapses to the first page when a re-read row disagrees with the one on screen", async () => {
		const h = loadHarness({ skill: GROWN });
		const onScreen = await expandSkills(h);
		// One row busier than the copy on screen: its run count and every bar width
		// beside it move, so the card is out of date.
		const changed = onScreen.map((row, i) => (i === 0 ? { ...row, calls: 999 } : row));
		verifyWith(h, { list: "skill", offset: 0, rows: changed, totalCount: SKILLS_TOTAL });
		await h.poll(model());

		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT} of ${SKILLS_TOTAL} skills`);
		expect(h.html()).toContain("999 runs");
		// Back to eight rows: a reader watching row 10 has no way to tell a re-fetched
		// page from the one they were already reading, whereas a card that visibly
		// returns to its first page says "this changed, start again".
		expect(h.html()).not.toContain("skill09");
	});

	it("collapses without a re-read when anything else on the card moved", async () => {
		const h = loadHarness({ skill: GROWN });
		await expandSkills(h);
		h.fetched.length = 0;
		verifyWith(h, { list: "skill", offset: 0, rows: [], totalCount: 0 });
		// One more skill run landed in the window. The card repaints whatever the rows
		// turn out to be, so confirming them would only delay it.
		await h.poll(model({ skillCallsTotal: 201 }));

		expect(h.fetched).toEqual([]);
		expect(h.html()).toContain(`201 runs · ${SKILLS_TOTAL} skills`);
		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT} of ${SKILLS_TOTAL} skills`);
	});

	it("asks nothing about a list still on its first page", async () => {
		const h = loadHarness();
		h.render(model());
		h.fetched.length = 0;
		await h.poll(model());
		// The polled payload already carries the whole first page of all three lists,
		// so there is nothing to keep and nothing to ask about.
		expect(h.fetched).toEqual([]);
	});

	it("leaves the other cards' rows and scroll alone when one card pages", async () => {
		const SERVERS_TOTAL = TOOL_ROWS_LIMIT + 7;
		const h = loadHarness({ skill: GROWN, server: GROWN });
		const moreServers = [serverRow(TOOL_ROWS_LIMIT), serverRow(TOOL_ROWS_LIMIT + 1)];
		h.JD.getJson = (path: string) => {
			h.fetched.push(path);
			return Promise.resolve(
				path.includes("list=server")
					? { list: "server", offset: TOOL_ROWS_LIMIT, rows: moreServers, totalCount: SERVERS_TOTAL }
					: {
							list: "skill",
							offset: TOOL_ROWS_LIMIT,
							rows: [skillRow(8), skillRow(9)],
							totalCount: SKILLS_TOTAL,
						},
			);
		};
		h.render(model()).get("server")?.onclick?.();
		await settle();
		// The reader is part-way down the MCPs list and then pages the SKILLS card.
		h.list("server").scrollTop = 300;
		h.fetched.length = 0;
		h.render(h.current()).get("skill")?.onclick?.();
		await settle();

		// One request, for the clicked list only. The three lists are independent in
		// the payload, so paging one must not re-read — or reset — another.
		expect(h.fetched).toEqual([
			`/api/tool-usage?range=month&dimension=model&list=skill&offset=${TOOL_ROWS_LIMIT}&nowMs=${GENERATED_AT_MS}`,
		]);
		expect(h.html()).toContain(`Showing ${GROWN} of ${SKILLS_TOTAL} skills`);
		expect(h.html()).toContain(`Showing ${GROWN} of ${SERVERS_TOTAL} servers`);
		// And the untouched card does not move. A Show more ends in a whole-page
		// repaint, so before the offsets were snapshotted this reset the reader's
		// position in the other two cards — and because the cap shows exactly one page
		// of rows, row 1 at the top made an expanded list look collapsed.
		expect(h.list("server").scrollTop).toBe(300);
	});

	it("puts a carried list back where the reader had scrolled it", async () => {
		const h = loadHarness({ skill: GROWN });
		const onScreen = await expandSkills(h);
		h.list("skill").scrollTop = 260;
		verifyWith(h, { list: "skill", offset: 0, rows: onScreen, totalCount: SKILLS_TOTAL });
		await h.poll(model());
		// Without this the card is unchanged and still interrupts the reader: the
		// repaint replaces the <ul>, so a list scrolled to row 10 restarts at row 1.
		expect(h.list("skill").scrollTop).toBe(260);
	});

	it("keeps a sibling list's scroll when another list collapses", async () => {
		const h = loadHarness({ skill: GROWN, server: GROWN });
		const moreSkills = [skillRow(TOOL_ROWS_LIMIT), skillRow(TOOL_ROWS_LIMIT + 1)];
		const moreServers = [serverRow(TOOL_ROWS_LIMIT), serverRow(TOOL_ROWS_LIMIT + 1)];
		const SERVERS_TOTAL = TOOL_ROWS_LIMIT + 7;
		// Both cards grown, so the poll has one list to collapse and one to keep.
		h.JD.getJson = (path: string) =>
			Promise.resolve(
				path.includes("list=skill")
					? { list: "skill", offset: TOOL_ROWS_LIMIT, rows: moreSkills, totalCount: SKILLS_TOTAL }
					: { list: "server", offset: TOOL_ROWS_LIMIT, rows: moreServers, totalCount: SERVERS_TOTAL },
			);
		h.render(model()).get("skill")?.onclick?.();
		await settle();
		h.render(h.current()).get("server")?.onclick?.();
		await settle();

		const skillsShown = [...Array.from({ length: TOOL_ROWS_LIMIT }, (_, i) => skillRow(i)), ...moreSkills];
		const serversShown = [...Array.from({ length: TOOL_ROWS_LIMIT }, (_, i) => serverRow(i)), ...moreServers];
		// The reader is part-way down the MCPs list when the poll fires.
		h.list("server").scrollTop = 300;
		h.JD.getJson = (path: string) =>
			Promise.resolve(
				path.includes("list=skill")
					? {
							list: "skill",
							offset: 0,
							rows: skillsShown.map((row, i) => (i === 0 ? { ...row, calls: 999 } : row)),
							totalCount: SKILLS_TOTAL,
						}
					: { list: "server", offset: 0, rows: serversShown, totalCount: SERVERS_TOTAL },
			);
		await h.poll(model());

		// Skills moved and collapsed; MCP servers passed and kept the reader's rows.
		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT} of ${SKILLS_TOTAL} skills`);
		expect(h.html()).toContain(`Showing ${GROWN} of ${SERVERS_TOTAL} servers`);
		// One list collapsing repaints the whole page, which replaces the MCPs <ul> too.
		// The untouched card keeps the reader's position because every repaint snapshots
		// and restores each list's offset — otherwise it snaps back to row 1 on a repaint
		// it had no part in: the same interruption this carry-over exists to prevent, one
		// repaint later.
		expect(h.list("server").scrollTop).toBe(300);
	});

	it("verifies the MCPs split the reader has switched away from", async () => {
		const h = loadHarness({ tool: GROWN });
		const appended = [
			{ ...skillRow(TOOL_ROWS_LIMIT), kind: "mcp" },
			{ ...skillRow(TOOL_ROWS_LIMIT + 1), kind: "mcp" },
		];
		h.JD.mcpSplitView = "tool";
		h.JD.getJson = () => Promise.resolve({ list: "tool", offset: TOOL_ROWS_LIMIT, rows: appended, totalCount: 42 });
		const buttons = h.render(model());
		buttons.get("tool")?.onclick?.();
		await settle();
		expect(h.html()).toContain(`Showing ${GROWN} of 42 tools`);

		// The reader switches to By server, so the expanded `tool` list is off screen.
		h.JD.mcpSplitView = "server";
		h.render(h.current());

		const onScreen = [
			...Array.from({ length: TOOL_ROWS_LIMIT }, (_, i) => ({ ...skillRow(i), kind: "mcp" })),
			...appended,
		];
		verifyWith(h, {
			list: "tool",
			offset: 0,
			rows: onScreen.map((row, i) => (i === 0 ? { ...row, calls: 999 } : row)),
			totalCount: 42,
		});
		await h.poll(model());

		// It collapsed even though nothing about it was painted. The comparison forces
		// the split to the list it is asking about — without that, a change to the list
		// the reader switched away from is invisible for as long as the tab stays open.
		h.JD.mcpSplitView = "tool";
		h.render(h.current());
		expect(h.html()).toContain(`Showing ${TOOL_ROWS_LIMIT} of 42 tools`);
	});

	it("keeps the expanded rows when the re-read fails, and says nothing about it", async () => {
		const h = loadHarness({ skill: GROWN });
		await expandSkills(h);
		h.JD.getJson = () => Promise.reject(new Error("offline"));
		await h.poll(model());
		// The aggregates beside them were already checked and matched, and the next
		// poll asks again in 30 s — a card that empties itself over a transient failure
		// is the worse answer.
		expect(h.html()).toContain(`Showing ${GROWN} of ${SKILLS_TOTAL} skills`);
		// Not the Show more failure state: the reader never asked for this read.
		expect(h.html()).not.toContain("could not load more");
	});

	it("treats a body carrying no total as unverifiable rather than as a change", async () => {
		const h = loadHarness({ skill: GROWN });
		const onScreen = await expandSkills(h);
		verifyWith(h, { list: "skill", offset: 0, rows: onScreen });
		await h.poll(model());
		// An absent total renders "of 0", which would make even a field-for-field
		// identical list look changed — the same collapse for a reason that is not the
		// reader's.
		expect(h.html()).toContain(`Showing ${GROWN} of ${SKILLS_TOTAL} skills`);
	});

	it("leaves every other view alone", () => {
		const h = loadHarness({ skill: GROWN });
		h.render(model());
		// Every view loads stats.js, so the hook itself is what has to know its scope.
		expect(h.JD.carryForwardHooks).toHaveLength(1);
		expect(h.JD.carryForwardHooks[0]({ view: "memories" }, h.current())).toBeNull();
		expect(h.JD.carryForwardHooks[0]({ view: "stats" }, {})).toBeNull();
	});

	it("does not collapse a list a Show more click is still growing", async () => {
		const h = loadHarness({ skill: GROWN });
		const onScreen = await expandSkills(h);
		let resolveVerify: ((page: unknown) => void) | undefined;
		h.JD.getJson = (path: string) =>
			path.includes("offset=0")
				? new Promise((resolve) => {
						resolveVerify = resolve;
					})
				: new Promise(() => undefined);
		await h.poll(model());

		// The reader clicks Show more while the verification read is in flight. That
		// click's response rewrites these rows from the array it captured a moment ago,
		// so a collapse now would be silently undone by it.
		h.render(h.current()).get("skill")?.onclick?.();
		resolveVerify?.({
			list: "skill",
			offset: 0,
			rows: onScreen.map((row, i) => (i === 0 ? { ...row, calls: 999 } : row)),
			totalCount: SKILLS_TOTAL,
		});
		await settle();

		expect(h.html()).toContain(`Showing ${GROWN} of ${SKILLS_TOTAL} skills`);
		expect(h.html()).not.toContain("999 runs");
	});

	it("does not collapse over a read narrower than the list it is comparing", async () => {
		const h = loadHarness({ skill: GROWN });
		const onScreen = await expandSkills(h);
		let resolveVerify: ((page: unknown) => void) | undefined;
		h.JD.getJson = (path: string) => {
			if (path.includes("offset=0")) {
				return new Promise((resolve) => {
					resolveVerify = resolve;
				});
			}
			return Promise.resolve({
				list: "skill",
				offset: GROWN,
				rows: [skillRow(GROWN), skillRow(GROWN + 1)],
				totalCount: SKILLS_TOTAL + 2,
			});
		};
		await h.poll(model());

		// This time the click LANDS first, so the list is wider than the read in flight.
		h.render(h.current()).get("skill")?.onclick?.();
		await settle();
		expect(h.html()).toContain(`Showing ${GROWN + 2} of ${SKILLS_TOTAL + 2} skills`);

		resolveVerify?.({
			list: "skill",
			offset: 0,
			rows: onScreen.map((row, i) => (i === 0 ? { ...row, calls: 999 } : row)),
			totalCount: SKILLS_TOTAL,
		});
		await settle();
		// Comparing a 10-row read against 12 rendered rows can only ever say
		// "changed", and collapsing would throw away the click that just succeeded.
		expect(h.html()).toContain(`Showing ${GROWN + 2} of ${SKILLS_TOTAL + 2} skills`);
	});
});
