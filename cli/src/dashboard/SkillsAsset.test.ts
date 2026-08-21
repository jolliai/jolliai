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

/** Just the two edges `isRowRevealed` reads off a `getBoundingClientRect`. */
interface FakeRect {
	top: number;
	bottom: number;
}

/**
 * The rows region, as `draw` sees it. `scrollTop` is what the page carries across a
 * repaint and `rect` is the box a row's own is compared against — neither exists without a
 * layout, so the harness supplies both.
 *
 * There used to be an `offsetHeight` here as well: the page measured the region's own
 * height and wrote it back as a `max-height` cap once the rest of the list landed. The
 * fixed frame took that over (the region's height comes from the flex chain now), so
 * nothing reads it and the field is gone with the mechanism.
 */
interface FakeList {
	scrollTop: number;
	rect: FakeRect;
}

/**
 * The selected row. Returned only while the rendered HTML actually carries an
 * `aria-current` row, which is what lets a test see the "selection names a skill still
 * in the unfetched tail" case the reveal has to survive.
 */
interface FakeRow {
	rect: FakeRect;
	readonly scrollIntoViewCalls: Array<Record<string, unknown> | undefined>;
}

interface Harness {
	readonly requests: string[];
	readonly list: FakeList;
	readonly currentRow: FakeRow;
	html: () => string;
	render: (model: unknown) => void;
	/** Rewrites `?skill=`, standing in for a click or an arrival from the Stats card. */
	selectSkill: (name: string | null) => void;
	/** Shrinks the browser window, for the half of the reveal the panel cannot see. */
	setViewportHeight: (height: number) => void;
	/** Advances the page-owned retry clock without waiting in real time. */
	advanceTimersBy: (milliseconds: number) => void;
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

/** A row's box, expressed against the harness's default 100–600 panel. */
const INSIDE_PANEL: FakeRect = { top: 200, bottom: 233 };
const BELOW_PANEL: FakeRect = { top: 1400, bottom: 1433 };

function loadHarness(): Harness {
	const requests: string[] = [];
	let html = "";
	let timerClock = 0;
	let nextTimerId = 1;
	const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
	const advanceTimersBy = (milliseconds: number) => {
		const target = timerClock + milliseconds;
		for (;;) {
			let dueId: number | undefined;
			let dueAt = Number.POSITIVE_INFINITY;
			for (const [id, timer] of timers) {
				if (timer.at <= target && timer.at < dueAt) {
					dueId = id;
					dueAt = timer.at;
				}
			}
			if (dueId === undefined) break;
			const timer = timers.get(dueId);
			timers.delete(dueId);
			timerClock = dueAt;
			timer?.run();
		}
		timerClock = target;
	};
	/* `rect` makes it a 500px-tall panel sitting well inside the 800px window below, so
	   the viewport half of `isRowRevealed` is satisfied by default and a test that wants
	   to exercise it says so by shrinking `innerHeight`. */
	const list: FakeList = { scrollTop: 0, rect: { top: 100, bottom: 600 } };
	/* Far below the panel by default — the arrival case, where the selection came from
	   the Stats card and names a skill ranked past the first screenful. */
	const currentRow: FakeRow = { rect: BELOW_PANEL, scrollIntoViewCalls: [] };
	const rowNode = {
		getBoundingClientRect: () => currentRow.rect,
		scrollIntoView: (options?: Record<string, unknown>) => {
			currentRow.scrollIntoViewCalls.push(options);
		},
	};
	const listNode = Object.assign(list, { getBoundingClientRect: () => list.rect });
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
			if (selector === ".sk-list") return listNode;
			/* Present only when a row really carries the marker — `listHtml` writes it for
			   the selected skill alone, so a selection whose row is still in the unfetched
			   tail finds nothing here, exactly as in a browser. */
			if (selector === '.sk-row[aria-current="true"]')
				return html.includes('aria-current="true"') ? rowNode : null;
			return null;
		},
		querySelectorAll: () => [] as ReadonlyArray<never>,
	};
	const document = { getElementById: (id: string) => (id === "app" ? app : null) };
	const window = {
		JD: {} as Record<string, unknown>,
		location: new URL("http://127.0.0.1/skills"),
		innerHeight: 800,
		setTimeout: (run: () => void, delay = 0) => {
			const id = nextTimerId++;
			timers.set(id, { at: timerClock + Math.max(0, delay), run });
			return id;
		},
		clearTimeout: (id: number) => timers.delete(id),
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
		/* `stackedBarsFrame`, not `stackedBars` — the band moved to the text-free entry
		   point so its height could be pinned while its width follows the page. Shaped
		   rather than empty, on the same principle as `dayBars` below: the SVG geometry is
		   `charts.js`', and what THIS page owns is laying the frame's ticks and endpoints
		   out as HTML beside the plot, so the fake returns identifiable values for exactly
		   those and leaves `svg` a marker carrying what it was handed. */
		stackedBarsFrame: (series: ReadonlyArray<{ date: string }>, keys: ReadonlyArray<string>) => ({
			svg: `<svg class="sk-bandbars" data-keys="${esc(keys.join(","))}" data-days="${series.length}"></svg>`,
			/* Top-down, as the real one documents. */
			ticks: ["4", "3", "2", "1", "0"],
			firstDay: series.length > 0 ? String(series[0].date) : "",
			lastDay: series.length > 1 ? String(series[series.length - 1].date) : "",
		}),
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
		currentRow,
		html: () => html,
		render: (next: unknown) => {
			(window.JD as { renderSkills: (model: unknown) => void }).renderSkills(next);
		},
		selectSkill: (name: string | null) => {
			const url = new URL(window.location.href);
			if (name) url.searchParams.set("skill", name);
			else url.searchParams.delete("skill");
			window.location = url;
		},
		setViewportHeight: (height: number) => {
			window.innerHeight = height;
		},
		advanceTimersBy,
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

	it("asks for nothing when the model's own page is already every skill", async () => {
		const h = loadHarness();
		h.render(model([row(0)], 1));
		await settle();

		/* The common small-corpus case, and the one the automatic read must not tax: the
		   payload already carries the whole column, so the first paint is the only paint. */
		expect(h.requests.filter((path) => path.includes("/api/tool-usage"))).toEqual([]);
		/* Nothing is loading and nothing is missing, so the band says nothing. A permanent
		   `Showing 1 of 1 skill` would restate the header line above it. */
		expect(h.html()).not.toContain("sk-paging");
		expect(h.html()).not.toContain("Showing");
	});

	it("reads the whole list on arrival with no button, paging past the server's per-request cap", async () => {
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
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));

		/* Before anything lands: the model's page, and a line saying the rest is coming.
		   That line is the whole of what replaced the button — no control, because the
		   reader is not being asked for anything. */
		expect(h.html()).toContain("Showing 8 of 205 skills — loading the rest…");
		expect(h.html()).not.toContain("data-skillmore");
		expect(h.html()).not.toContain("Show more");

		await settle();

		/* Every skill, with no click anywhere in this test. Two requests, because the
		   route clamps a page at 200 rows and the read keeps going while the server's own
		   positions outrun what it has in hand. */
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(205);
		expect(h.html()).toContain('data-skill="skill204"');
		expect(h.requests.some((path) => path.includes("offset=200"))).toBe(true);
		/* And a complete column says nothing at all: the header already prints the count. */
		expect(h.html()).not.toContain("sk-paging");
		expect(h.html()).not.toContain("Showing");

		/* An explicit model refresh re-reads the same width rather than collapsing back
		   to the payload's own page — a new model is a new list to verify, not a reset. */
		h.requests.length = 0;
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(205);
		expect(h.requests.filter((path) => path.includes("/api/tool-usage"))).toEqual([
			expect.stringContaining("offset=0"),
			expect.stringContaining("offset=200"),
		]);
	});

	it("finishes a list read that a re-render started during", async () => {
		const all = Array.from({ length: 20 }, (_, i) => row(i));
		const h = loadHarness();
		/* A no-op until the list read is actually in flight, so a regression that never
		   starts one fails on the row count below rather than on a null call. */
		let release: (value: unknown) => void = () => {};
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			/* Held open so the re-render below lands squarely mid-flight. */
			return new Promise((resolve) => {
				release = resolve;
			});
		});
		const payload = model(all.slice(0, TOOL_ROWS_LIMIT), all.length);
		h.render(payload);

		/* Opening a skill re-renders and bumps the render counter. While the list read was
		   staled by that counter, this voided it — and with the button gone nothing would
		   ever restart it, so the column sat at eight rows saying "loading the rest…" for
		   the life of the payload. The read belongs to the PAYLOAD, which has not changed. */
		h.render(payload);
		release({ list: "skill", offset: 0, rows: all, totalCount: all.length });
		await settle();

		expect(h.html().match(/class="sk-row"/g)).toHaveLength(20);
		expect(h.html()).not.toContain("loading the rest");
	});

	it("restarts a shifted offset partition instead of silently dropping its displaced row", async () => {
		const all = Array.from({ length: 10 }, (_, i) => row(i));
		const h = loadHarness();
		let served = 0;
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			served++;
			/* A short first answer, then a second page whose top row has slipped back
			   across the boundary — the rank shifting under a read in flight. The stop is
			   the SERVER's position, so the short page does not end the read the way a
			   caller-fixed width used to. */
			return Promise.resolve(
				served === 1
					? { list: "skill", offset: 0, rows: all.slice(0, 8), totalCount: 10 }
					: served === 2
						? { list: "skill", offset: 8, rows: [all[7], all[8]], totalCount: 10 }
						: { list: "skill", offset: 0, rows: all, totalCount: 10 },
			);
		});
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();

		expect(served).toBe(3);
		/* The repeated boundary row proves the first partition moved, so that pass is
		   discarded. The stable second pass returns all ten — the displaced last skill is
		   not hidden by shrinking the server's total to nine. */
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(10);
		expect(h.html().match(/data-skill="skill007"/g)).toHaveLength(1);
		expect(h.html()).toContain('data-skill="skill009"');
		expect(h.html()).not.toContain("sk-paging");
	});

	it("bounds an unstable partition instead of spinning or publishing a partial pass", async () => {
		const all = Array.from({ length: 10 }, (_, i) => row(i));
		const h = loadHarness();
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			const url = new URL(path, "http://127.0.0.1");
			const offset = Number(url.searchParams.get("offset") ?? 0);
			return Promise.resolve({
				list: "skill",
				offset,
				rows: offset === 0 ? all.slice(0, 8) : [all[7], all[8]],
				totalCount: all.length,
			});
		});
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();

		/* Initial pass plus two clean retries, two pages each. The third repeated
		   boundary becomes a recoverable failure instead of another synchronous pass. */
		expect(h.requests.filter((path) => path.includes("/api/tool-usage"))).toHaveLength(6);
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(TOOL_ROWS_LIMIT);
		expect(h.html()).toContain("Showing 8 of 10 skills — could not load the rest");
	});

	it("keeps the rows it has when the read fails and retries the same payload after 30 seconds", async () => {
		const all = Array.from({ length: 10 }, (_, i) => row(i));
		const h = loadHarness();
		let fail = true;
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			if (fail) {
				fail = false;
				return Promise.reject(new Error("offline"));
			}
			return Promise.resolve({ list: "skill", offset: 0, rows: all, totalCount: 10 });
		});
		const payload = model(all.slice(0, TOOL_ROWS_LIMIT), all.length);
		h.render(payload);
		await settle();

		/* A short column has to say it is short — eight rows with nothing else on screen
		   is indistinguishable from a reader who owns eight skills. No `Try again`: the
		   page-owned timer below is the retry, so a control would duplicate it. */
		expect(h.html()).toContain("Showing 8 of 10 skills — could not load the rest");
		expect(h.html()).not.toContain("Try again");
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(TOOL_ROWS_LIMIT);

		/* A repaint of the SAME payload does not re-ask. Opening a pane re-renders, so
		   without that guard every click on a failed column would fire the failing
		   request again. */
		h.requests.length = 0;
		h.render(payload);
		await settle();
		expect(h.requests.filter((path) => path.includes("/api/tool-usage"))).toEqual([]);
		expect(h.html()).toContain("could not load the rest");

		/* Skills is deliberately outside the global page poll. The page's own timer must
		   therefore retry this SAME payload, neither early nor only after a model refresh. */
		h.advanceTimersBy(29_999);
		await settle();
		expect(h.requests.filter((path) => path.includes("/api/tool-usage"))).toEqual([]);
		h.advanceTimersBy(1);
		await settle();
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(10);
		expect(h.html()).not.toContain("could not load the rest");
	});

	it("cancels a failed payload's pending retry when a refreshed payload takes ownership", async () => {
		const all = Array.from({ length: 10 }, (_, i) => row(i));
		const h = loadHarness();
		let fail = true;
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			if (fail) {
				fail = false;
				return Promise.reject(new Error("offline"));
			}
			return Promise.resolve({ list: "skill", offset: 0, rows: all, totalCount: all.length });
		});
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.html()).toContain("could not load the rest");

		/* A new model starts its own successful read and cancels the old timer. Advancing
		   past the old deadline must not issue a stale third request or repaint old data. */
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(all.length);
		h.requests.length = 0;
		h.advanceTimersBy(30_000);
		await settle();
		expect(h.requests.filter((path) => path.includes("/api/tool-usage"))).toEqual([]);
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(all.length);
	});

	it("reads past the former 25-request safety ceiling instead of finalising a partial list", async () => {
		const all = Array.from({ length: 5001 }, (_, i) => row(i));
		const h = loadHarness();
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			const url = new URL(path, "http://127.0.0.1");
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const requested = Number(url.searchParams.get("limit") ?? TOOL_ROWS_LIMIT);
			return Promise.resolve({
				list: "skill",
				offset,
				rows: all.slice(offset, offset + Math.min(requested, 200)),
				totalCount: all.length,
			});
		});
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();

		expect(h.requests.filter((path) => path.includes("/api/tool-usage"))).toHaveLength(26);
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(all.length);
		expect(h.html()).toContain('data-skill="skill5000"');
		expect(h.html()).not.toContain("could not load the rest");
	});

	it("bounds a response stream whose total grows as fast as its offset", async () => {
		const h = loadHarness();
		h.respondWith((path) => {
			if (path.startsWith("/api/skill-detail")) return Promise.resolve(detail);
			const url = new URL(path, "http://127.0.0.1");
			const offset = Number(url.searchParams.get("offset") ?? 0);
			return Promise.resolve({ list: "skill", offset, rows: [row(offset)], totalCount: offset + 2 });
		});
		h.render(
			model(
				Array.from({ length: TOOL_ROWS_LIMIT }, (_, i) => row(i)),
				10,
			),
		);
		await settle();

		/* The initial ten-row corpus gets the 25-request minimum. Every answer moves the
		   target one position away, so only the backstop can terminate this attempt. */
		expect(h.requests.filter((path) => path.includes("/api/tool-usage"))).toHaveLength(25);
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(TOOL_ROWS_LIMIT);
		expect(h.html()).toContain("could not load the rest");
	});

	it("never writes a cap onto the rows region, and carries the reader's place across a repaint", async () => {
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

		/* ONE SHAPE, BOTH PAINTS. The region used to be laid out free on the model's own
		   page and then re-emitted with a MEASURED `max-height` (plus an `sk-scroll` marker)
		   once the tail landed, because the page scrolled and the rows had to earn a window
		   of their own. The page is a fixed frame now: `.sk-list` takes its height from the
		   flex chain, scrolls unconditionally, and there is no pixel value for JS to write.
		   Asserted before the fetch as well as after, because "the tag changed when the tail
		   arrived" is exactly the old behaviour. */
		expect(h.html()).toContain('<div class="sk-list">');
		expect(h.html()).not.toContain("sk-scroll");
		expect(h.html()).not.toContain("max-height");

		await settle();
		expect(h.html()).toContain('<div class="sk-list">');
		expect(h.html()).not.toContain("sk-scroll");
		expect(h.html()).not.toContain("max-height");
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(20);

		/* The reader's place inside the region still survives a repaint, which is the half of
		   the old behaviour that outlived the cap — an explicit model refresh replaces the
		   node, so without the carry the column would jump back to its first row every half
		   minute, mid-read. The harness zeroes `scrollTop` on every write for exactly this
		   reason, so 120 here can only have been written back. */
		h.list.scrollTop = 120;
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.list.scrollTop).toBe(120);
	});

	it("reveals a selection that arrived in the address, and only once the row exists", async () => {
		const all = Array.from({ length: 20 }, (_, i) => row(i));
		const h = loadHarness();
		h.respondWith((path) =>
			path.startsWith("/api/skill-detail")
				? Promise.resolve(detail)
				: Promise.resolve({ list: "skill", offset: 0, rows: all, totalCount: all.length }),
		);
		/* The Stats card links in with `?skill=`, and can name any skill in the window —
		   here the last one, which the model's own first page does not carry. */
		h.selectSkill("skill019");
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));

		/* Nothing to scroll to yet: the row is in the tail still being fetched. This paint
		   must NOT count as the reveal, or the arriving tail would never get one. */
		expect(h.html()).not.toContain('aria-current="true"');
		expect(h.currentRow.scrollIntoViewCalls).toEqual([]);

		await settle();
		/* The tail landed, the row exists, and it is 800px below a 500px panel — centred,
		   which also walks the page's own scroll so a panel hanging out of the viewport
		   comes with it. */
		expect(h.html()).toContain('aria-current="true"');
		expect(h.currentRow.scrollIntoViewCalls).toEqual([{ block: "center" }]);
	});

	it("does not move the column for a row that is already on screen", async () => {
		const all = Array.from({ length: 20 }, (_, i) => row(i));
		const h = loadHarness();
		h.respondWith((path) =>
			path.startsWith("/api/skill-detail")
				? Promise.resolve(detail)
				: Promise.resolve({ list: "skill", offset: 0, rows: all, totalCount: all.length }),
		);
		/* Clicking a row in the list is the high-frequency action here, and such a row is
		   on screen by definition — centring it would slide the column under the pointer. */
		h.currentRow.rect = INSIDE_PANEL;
		h.selectSkill("skill002");
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();

		expect(h.html()).toContain('aria-current="true"');
		expect(h.currentRow.scrollIntoViewCalls).toEqual([]);
	});

	it("scrolls a row the panel shows but the browser window cuts off", async () => {
		const all = Array.from({ length: 20 }, (_, i) => row(i));
		const h = loadHarness();
		h.respondWith((path) =>
			path.startsWith("/api/skill-detail")
				? Promise.resolve(detail)
				: Promise.resolve({ list: "skill", offset: 0, rows: all, totalCount: all.length }),
		);
		/* Inside the panel's own 100–600 window, so a panel-only check would call this
		   revealed — but the window is 400px tall here, standing in for the real page,
		   where the band above the panel pushes its lower ~93px off screen (measured). */
		h.currentRow.rect = { top: 520, bottom: 553 };
		h.setViewportHeight(400);
		h.selectSkill("skill010");
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();

		expect(h.currentRow.scrollIntoViewCalls).toEqual([{ block: "center" }]);
	});

	it("reveals once per selection, so neither a repaint nor a refresh drags the reader back", async () => {
		const all = Array.from({ length: 20 }, (_, i) => row(i));
		const h = loadHarness();
		h.respondWith((path) =>
			path.startsWith("/api/skill-detail")
				? Promise.resolve(detail)
				: Promise.resolve({ list: "skill", offset: 0, rows: all, totalCount: all.length }),
		);
		h.selectSkill("skill019");
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.currentRow.scrollIntoViewCalls).toHaveLength(1);

		/* An explicit model refresh. Every path here repaints the whole page, so without the
		   once-per-selection guard a reader browsing the list would be yanked back to the
		   selected row twice a minute. */
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.currentRow.scrollIntoViewCalls).toHaveLength(1);
	});

	it("forgets the reveal when the pane closes, so re-opening the same skill scrolls again", async () => {
		const all = Array.from({ length: 20 }, (_, i) => row(i));
		const h = loadHarness();
		h.respondWith((path) =>
			path.startsWith("/api/skill-detail")
				? Promise.resolve(detail)
				: Promise.resolve({ list: "skill", offset: 0, rows: all, totalCount: all.length }),
		);
		/* Arriving with no `?skill=` opens the top row, which is on screen — so this first
		   render answers the default-selection question without scrolling, and the counts
		   below belong to the deliberate selections alone. */
		h.currentRow.rect = INSIDE_PANEL;
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.currentRow.scrollIntoViewCalls).toEqual([]);

		h.currentRow.rect = BELOW_PANEL;
		h.selectSkill("skill019");
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.currentRow.scrollIntoViewCalls).toHaveLength(1);

		/* Clicking the current row again closes the pane. Re-opening the same skill after
		   scrolling elsewhere — from the band's key, say — has to move the column again,
		   which it cannot do if the selection is still remembered as revealed. */
		h.selectSkill(null);
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		h.selectSkill("skill019");
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.currentRow.scrollIntoViewCalls).toHaveLength(2);
	});

	/* There was a sibling of the test above here: "leaves the rows region uncapped when the
	   first page measured nothing", which set the harness list's `offsetHeight` to 0 to stand
	   in for a page that had never been laid out and asserted that no cap was recorded. Both
	   the measurement and the guard are gone with the fixed frame, and its assertions are the
	   ones the test above now makes unconditionally.
	 *
	 * NOT COVERED HERE: the pane's two clamped paragraphs (`proseBlock` / `bindProse`) and the
	 * agent list's roll-up at `AGENT_ROWS_SHOWN`. This harness reads rendered HTML as a string
	 * and has no node to dispatch a click at, so the half of that behaviour that matters — the
	 * `aria-expanded` toggle, which is the whole contract `main.css` keys off — is not
	 * reachable from here. `src/dashboard/assets/**` is excluded from coverage, so this is a
	 * gap by choice rather than one the thresholds would have caught. */
});
