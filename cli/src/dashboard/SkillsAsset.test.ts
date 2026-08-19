/** Runtime coverage for the plain-JavaScript Skills page. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_ROWS_LIMIT } from "./DashboardModel.js";

interface SkillRow {
	readonly name: string;
	readonly kind: "skill";
	readonly sessions: number;
	readonly calls: number;
	readonly agents: ReadonlyArray<{ source: string; calls: number }>;
}

interface FakeButton {
	onclick?: () => void;
}

/**
 * The rows region, as `draw` sees it. `offsetHeight` is what the page measures to cap
 * the region once Show more is pressed, and `scrollTop` is what it carries across a
 * repaint — neither exists without a layout, so the harness supplies both.
 */
interface FakeList {
	scrollTop: number;
	offsetHeight: number;
}

interface Harness {
	readonly requests: string[];
	readonly list: FakeList;
	html: () => string;
	render: (model: unknown) => void;
	clickMore: () => boolean;
	respondWith: (handler: (path: string) => Promise<unknown>) => void;
}

const row = (i: number): SkillRow => ({
	name: `skill${String(i).padStart(3, "0")}`,
	kind: "skill",
	sessions: 1,
	calls: 1,
	agents: [{ source: "claude", calls: 1 }],
});

/**
 * The band's own day series, DELIBERATELY WIDER than `detail`'s two data points.
 *
 * That gap is what makes the pane charts' axis testable: they must lay out the
 * window's days, not their own data's extent. The skill below runs on `2026-01-01`
 * and `2026-01-02` only, so a chart that still starts at `2025-12-30` is one reading
 * the window.
 */
const WINDOW_DAYS = ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03"];

function model(rows: ReadonlyArray<SkillRow>, total: number): unknown {
	return {
		view: "skills",
		timeZone: "Asia/Shanghai",
		stats: {
			toolUsage: {
				skills: rows,
				skillsTotal: total,
				skillCallsTotal: total,
				skillAgents: [{ source: "claude", sessions: total, calls: total }],
				sessionsWithTools: total,
				sessionsInWindow: total,
				skillDays: WINDOW_DAYS.map((date) => ({ date, bySeries: { skill000: 1 } })),
			},
		},
	};
}

const detail = {
	name: "skill000",
	sessions: 2,
	calls: 2,
	agents: [{ source: "claude", sessions: 2, calls: 2 }],
	usage: { input: 2, output: 2, cached: 0, confidence: "attributed", sessions: 2 },
	sessionSeries: [
		{ atMs: Date.parse("2025-12-31T20:00:00Z"), tokens: 2 },
		{ atMs: Date.parse("2026-01-01T20:00:00Z"), tokens: 2 },
	],
	outcomes: { measured: 1, failed: 0, assumed: 1 },
	invocations: [
		{ atMs: Date.parse("2025-12-31T20:00:00Z"), ok: true, outcomeKnown: true },
		{ atMs: Date.parse("2026-01-01T20:00:00Z"), ok: true, outcomeKnown: false },
	],
	entryPaths: ["tool"],
	repos: ["jolliai"],
	firstCallAtMs: Date.parse("2025-12-31T20:00:00Z"),
	lastCallAtMs: Date.parse("2026-01-01T20:00:00Z"),
};

function loadHarness(): Harness {
	const requests: string[] = [];
	let html = "";
	let moreButton: FakeButton | null = null;
	/* 320 stands in for a laid-out first page. Any positive number does — what the
	   assertions read is that the cap equals what was measured, not the figure itself —
	   and a test sets it to 0 to stand in for a page that was never laid out. */
	const list: FakeList = { scrollTop: 0, offsetHeight: 320 };
	const app = {
		get innerHTML() {
			return html;
		},
		set innerHTML(next: string) {
			html = next;
			/* A repaint replaces the node, so the browser's own offset goes to 0 here. That
			   is what makes the restore observable: an assertion that survives this reset
			   can only have been written back by `draw`. */
			list.scrollTop = 0;
		},
		querySelector: (selector: string) => {
			if (selector === ".sk-list") return list;
			if (selector === "[data-skillmore]") {
				if (html.includes("data-skillmore")) {
					moreButton = {};
					return moreButton;
				}
				moreButton = null;
			}
			return null;
		},
		querySelectorAll: () => [] as ReadonlyArray<never>,
	};
	const document = { getElementById: (id: string) => (id === "app" ? app : null) };
	const window = {
		JD: {} as Record<string, unknown>,
		location: new URL("http://127.0.0.1/skills"),
		history: {
			replaceState: (_state: unknown, _title: string, href: string) => {
				window.location = new URL(href);
			},
		},
	};
	let responder = (path: string): Promise<unknown> =>
		Promise.resolve(path.startsWith("/api/skill-detail") ? detail : { list: "skill", offset: 0, rows: [] });
	const esc = (value: unknown) =>
		String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	Object.assign(window.JD, {
		esc,
		fmtTokens: (n: number) => String(n),
		seriesColor: () => "#000",
		sourceIndex: () => 0,
		stackedBars: () => "",
		dayKey: (atMs: number, timeZone: string) =>
			new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
				atMs,
			),
		/* The real one, because the assertions read the labels it produces — and it is
		   pure string work over a day key, so there is nothing to stub. */
		dayLabel: (key: string) => {
			const parts = String(key).split("-");
			const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
			const month = months[Number(parts[1]) - 1];
			return month && parts[2] ? `${month} ${Number(parts[2])}` : String(key);
		},
		/* Stubbed down to one `day=value` pair per bucket: the SVG geometry belongs to
		   `charts.js`, while what this page owns is WHICH days it hands over and what it
		   put in each — so that is what the fake keeps legible. */
		dayBars: (days: ReadonlyArray<string>, values: ReadonlyArray<number>, opts?: { fmt?: (n: number) => string }) =>
			`<svg class="sk-daybars">${days
				.map((day, index) => {
					const value = values[index] ?? 0;
					return `<rect><title>${day}=${opts?.fmt ? opts.fmt(value) : String(value)}</title></rect>`;
				})
				.join("")}</svg>`,
		query: () => "?range=month",
		withParams: (path: string, params: Record<string, string>) => {
			const url = new URL(path, "http://127.0.0.1");
			for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
			return url.pathname + url.search;
		},
		getJson: (path: string) => {
			requests.push(path);
			return responder(path);
		},
	});
	const source = readFileSync(new URL("./assets/js/skills.js", import.meta.url), "utf8");
	new Function("window", "document", source)(window, document);
	return {
		requests,
		list,
		html: () => html,
		render: (next: unknown) => {
			(window.JD as { renderSkills: (model: unknown) => void }).renderSkills(next);
		},
		clickMore: () => {
			if (!moreButton?.onclick) return false;
			moreButton.onclick();
			return true;
		},
		respondWith: (handler) => {
			responder = handler;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Skills page asset", () => {
	it("renders detail dates in the dashboard time zone without masking render exceptions as request failures", async () => {
		const h = loadHarness();
		h.render(model([row(0)], 1));
		await settle();

		expect(h.html()).toContain("Jan 1");
		expect(h.html()).toContain("outcome not recorded");
		expect(h.html()).not.toContain("Could not reach the dashboard server");
	});

	it("draws both pane charts over the band's window days rather than their own data's extent", async () => {
		const h = loadHarness();
		h.render(model([row(0)], 1));
		await settle();
		const html = h.html();

		/* Both charts walk the WHOLE window. The regression this pins had the cadence
		   chart bucketing by UTC epoch week and labelling its axis with the bucket edge,
		   so it printed a date a week before anything had happened while the cost chart
		   beside it printed the first real data point — two axes on one panel. */
		for (const day of WINDOW_DAYS) {
			expect(html.split(`<title>${day}=`).length - 1).toBe(2);
		}
		/* Quiet days are drawn as zero, never dropped: bars lay out by index, so a
		   skipped day would shift every later one and compress the axis. */
		expect(html).toContain("<title>2025-12-30=0 sessions</title>");
		expect(html).toContain("<title>2026-01-01=1 session</title>");
		/* The cost chart sums the same day's sessions and reads the same buckets. */
		expect(html).toContain("<title>2025-12-30=0</title>");
		expect(html).toContain("<title>2026-01-02=2</title>");

		/* One axis, stated twice — and it is the window's, matching the band above. The
		   record's own dates stay the data's, which is the distinction that used to be
		   spelled as two disagreeing axes. */
		expect(html.split("<span>Dec 30</span>").length - 1).toBe(2);
		expect(html.split("<span>Jan 3</span>").length - 1).toBe(2);
		/* The record's dates stay the DATA's — `Jan 1` is on no axis here. That split is
		   the honest version of what used to be spelled as two disagreeing axes. */
		expect(html).toContain("<b>First used</b><span>Jan 1</span>");
		expect(html).toContain("<b>Last used</b><span>Jan 2</span>");
	});

	it("falls back to the skill's own days when the payload carried no band series", async () => {
		const h = loadHarness();
		const bandless = model([row(0)], 1) as { stats: { toolUsage: { skillDays: unknown[] } } };
		bandless.stats.toolUsage.skillDays = [];
		h.render(bandless);
		await settle();
		const html = h.html();

		/* Narrower than the window but honest — the two days this skill ran, drawn on an
		   axis that claims exactly them. Refusing to draw would cost the reader more than
		   a short axis does, and the band emits a point per day of any window that
		   exists, so this is reachable only from a payload with no band at all. */
		expect(html).toContain("<title>2026-01-01=1 session</title>");
		expect(html).toContain("<title>2026-01-02=1 session</title>");
		expect(html).not.toContain("<title>2025-12-30=");
		expect(html.split("<span>Jan 1</span>").length - 1).toBe(3);
	});

	it("says how many sessions attributed no spend, so an empty day in the cost chart reads", async () => {
		const h = loadHarness();
		h.respondWith((path) =>
			Promise.resolve(
				path.startsWith("/api/skill-detail")
					? /* One priced session and one without: most agents attribute no spend at all,
					     so a session missing from the cost chart is the common case rather than an
					     edge one, and on a shared axis it shows up as a gap needing an explanation. */
						{
							...detail,
							sessionSeries: [{ atMs: Date.parse("2025-12-31T20:00:00Z") }, detail.sessionSeries[1]],
							usage: { input: 1, output: 1, cached: 0, confidence: "attributed", sessions: 1 },
						}
					: { list: "skill", offset: 0, rows: [] },
			),
		);
		h.render(model([row(0)], 1));
		await settle();

		expect(h.html()).toContain("1 session attributed no spend, so it is not in this chart");
		/* Still counted by the cadence chart, which is the whole point of saying it. */
		expect(h.html()).toContain("<title>2026-01-01=1 session</title>");
	});

	it("pages beyond the server's 200-row per-request cap and preserves the expansion on poll", async () => {
		const all = Array.from({ length: 205 }, (_, i) => row(i));
		const h = loadHarness();
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			const url = new URL(path, "http://127.0.0.1");
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const requested = Number(url.searchParams.get("limit") ?? TOOL_ROWS_LIMIT);
			const limit = Math.min(requested, 200);
			return Promise.resolve({
				list: "skill",
				offset,
				rows: all.slice(offset, offset + limit),
				totalCount: all.length,
			});
		});
		const first = model(all.slice(0, TOOL_ROWS_LIMIT), all.length);
		h.render(first);
		await settle();

		for (let clicks = 0; clicks < 30 && h.clickMore(); clicks++) await settle();
		expect(h.html()).toContain("Showing 205 of 205 skills");
		expect(h.html()).not.toContain("data-skillmore");
		expect(h.requests.some((path) => path.includes("offset=200"))).toBe(true);

		h.requests.length = 0;
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.html()).toContain("Showing 205 of 205 skills");
		expect(h.requests.filter((path) => path.includes("/api/tool-usage"))).toEqual([
			expect.stringContaining("offset=0"),
			expect.stringContaining("offset=200"),
		]);
	});

	it("keeps rows on failure, retries, and deduplicates a shifted boundary row", async () => {
		const all = Array.from({ length: 10 }, (_, i) => row(i));
		const h = loadHarness();
		let fail = true;
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			if (fail) {
				fail = false;
				return Promise.reject(new Error("offline"));
			}
			return Promise.resolve({ list: "skill", offset: 8, rows: [all[7], all[8], all[9]], totalCount: 10 });
		});
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.clickMore()).toBe(true);
		await settle();
		expect(h.html()).toContain("Showing 8 of 10 skills — could not load more");
		expect(h.html()).toContain("Try again");

		expect(h.clickMore()).toBe(true);
		await settle();
		expect(h.html()).toContain("Showing 10 of 10 skills");
		expect(h.html().match(/data-skill="skill007"/g)).toHaveLength(1);
	});

	it("caps the rows region only once Show more is pressed, at the height the first page measured", async () => {
		const all = Array.from({ length: 20 }, (_, i) => row(i));
		const h = loadHarness();
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			const url = new URL(path, "http://127.0.0.1");
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const limit = Number(url.searchParams.get("limit") ?? TOOL_ROWS_LIMIT);
			return Promise.resolve({
				list: "skill",
				offset,
				rows: all.slice(offset, offset + limit),
				totalCount: all.length,
			});
		});
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();

		/* The state every page load opens in. The column IS the whole first page, so it
		   needs no window onto itself, and the page's own bar is the only one on screen. */
		expect(h.html()).toContain('<div class="sk-list">');
		expect(h.html()).not.toContain("sk-scroll");

		expect(h.clickMore()).toBe(true);
		await settle();
		/* Capped at what the first page OCCUPIED, never at a declared constant: the region
		   keeps the size it opened at, the twelve new rows land inside it, and the page
		   below does not move. A constant would be a few pixels wrong on the corpora that
		   carry the inferred footnote — and wrong LOW means a scrollbar on the first page,
		   which is the one state that may not have one. */
		expect(h.html()).toContain('<div class="sk-list sk-scroll" style="max-height:320px">');
		expect(h.html()).toContain("Showing 16 of 20 skills");
		/* The control that did this stays OUT of the region it capped. */
		expect(h.html()).toContain('<div class="sk-paging">');

		/* And the reader's place inside that region survives a repaint — the 30 s poll
		   replaces the node, so without the carry the column would jump back to its first
		   row every half minute, mid-read. The harness zeroes `scrollTop` on every write
		   for exactly this reason, so 120 here can only have been written back. */
		h.list.scrollTop = 120;
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.list.scrollTop).toBe(120);
		expect(h.html()).toContain("sk-scroll");
	});

	it("leaves the rows region uncapped when the first page measured nothing", async () => {
		const all = Array.from({ length: 20 }, (_, i) => row(i));
		const h = loadHarness();
		/* A page that has not been laid out measures 0, and capping there would collapse
		   the region and hide every row — so nothing is recorded and the column simply
		   stays tall. Uncapped is the safe way to be wrong; `stats.js` guards its own
		   card cap the same way. */
		h.list.offsetHeight = 0;
		h.respondWith((path) =>
			path.startsWith("/api/skill-detail")
				? Promise.resolve(detail)
				: Promise.resolve({ list: "skill", offset: 8, rows: all.slice(8, 16), totalCount: all.length }),
		);
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.clickMore()).toBe(true);
		await settle();

		expect(h.html()).toContain("Showing 16 of 20 skills");
		expect(h.html()).toContain('<div class="sk-list">');
		expect(h.html()).not.toContain("sk-scroll");
		expect(h.html()).not.toContain("max-height");
	});
});
