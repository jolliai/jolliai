/** Runtime coverage for the plain-JavaScript MCPs page. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_ROWS_LIMIT } from "./DashboardModel.js";

interface FakeRect {
	top: number;
	bottom: number;
}

interface FakeList {
	scrollTop: number;
	rect: FakeRect;
	getBoundingClientRect: () => FakeRect;
}

interface FakeRow {
	rect: FakeRect;
	readonly scrollIntoViewCalls: Array<Record<string, unknown> | undefined>;
	getBoundingClientRect: () => FakeRect;
	scrollIntoView: (options?: Record<string, unknown>) => void;
}

interface FakeClickable {
	onclick?: () => void;
	onkeydown?: (event: { key: string; preventDefault: () => void }) => void;
	getAttribute: (name: string) => string | null;
	setAttribute?: (name: string, value: string) => void;
	removeAttribute?: (name: string) => void;
	classList?: { contains: (name: string) => boolean };
	focus?: () => void;
}

interface Harness {
	readonly requests: string[];
	readonly list: FakeList;
	readonly currentRow: FakeRow;
	html: () => string;
	render: (model: unknown) => void;
	selectServer: (name: string | null) => void;
	selectedServer: () => string | null;
	clickServer: (name: string) => void;
	clickFocusedLegend: (name: string) => void;
	focusedSelection: () => { name: string | null; legend: boolean; replaced: boolean };
	useTargetedDom: () => void;
	clickProse: () => void;
	proseExpanded: () => string | null;
	advanceTimersBy: (milliseconds: number) => void;
	respondWith: (handler: (path: string) => Promise<unknown>) => void;
}

const GENERATED_AT_MS = Date.parse("2026-07-30T15:59:00Z");

const serverNames = ["Other", "__proto__", "constructor", "b", "c"];
const serverRows = serverNames.map((server, index) => ({
	server,
	sessions: 10 - index,
	calls: 10 - index,
	tools: 1,
	agents: [{ source: "claude", calls: 10 - index }],
}));

const serverRow = (index: number) => ({
	server: `server${String(index).padStart(3, "0")}`,
	sessions: 20 - index,
	calls: 20 - index,
	tools: 1,
	agents: [{ source: "claude", calls: 20 - index }],
});

const dangerousSeries = Object.fromEntries([
	["Other", 10],
	["__proto__", 9],
	["constructor", 8],
	["b", 7],
	["c", 1],
]);

function model(
	rows: ReadonlyArray<(typeof serverRows)[number]> = serverRows,
	total = rows.length,
	usageOver: Record<string, unknown> = {},
): unknown {
	return {
		view: "mcps",
		generatedAtMs: GENERATED_AT_MS,
		timeZone: "UTC",
		stats: {
			range: "today",
			toolUsage: {
				servers: rows,
				serversTotal: total,
				serverCallsTotal: 35,
				serverToolsTotal: 5,
				// Includes one legacy MCP row without a server. The MCPs header must not.
				mcpToolsTotal: 6,
				serverDays: [{ date: "2026-07-30", bySeries: dangerousSeries }],
				mcpAgents: [{ source: "claude", sessions: 10, calls: 35 }],
				sessionsWithTools: 10,
				sessionsInWindow: 10,
				uncoveredSources: [],
				...usageOver,
			},
		},
	};
}

const detail = {
	server: "Other",
	sessions: 2,
	calls: 7,
	toolCount: 1,
	tools: [{ name: "call", sessions: 2, calls: 7 }],
	agents: [{ source: "claude", calls: 7 }],
	daySeries: [
		{ date: "2026-07-28", sessions: 1, calls: 2 },
		{ date: "2026-07-29", sessions: 0, calls: 0 },
		{ date: "2026-07-30", sessions: 1, calls: 5 },
	],
	sessionSeries: [
		{ atMs: Date.parse("2026-07-28T09:00:00Z"), calls: 2 },
		{ atMs: Date.parse("2026-07-30T09:00:00Z"), calls: 5 },
	],
	firstCallAtMs: Date.parse("2026-07-28T09:00:00Z"),
	lastCallAtMs: Date.parse("2026-07-30T09:00:00Z"),
	repos: ["jolli"],
};

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
	const list: FakeList = {
		scrollTop: 0,
		rect: { top: 100, bottom: 600 },
		getBoundingClientRect: () => list.rect,
	};
	const currentRow: FakeRow = {
		rect: { top: 1400, bottom: 1433 },
		scrollIntoViewCalls: [],
		getBoundingClientRect: () => currentRow.rect,
		scrollIntoView: (options) => currentRow.scrollIntoViewCalls.push(options),
	};
	let selectionNodes: FakeClickable[] = [];
	let proseNodes: FakeClickable[] = [];
	let clickedNode: FakeClickable | null = null;
	let targetedDom = false;
	let targetedBandHtml = "";
	const bandNode = {
		replaceWith: (next: { readonly html?: string }) => {
			targetedBandHtml = next.html ?? "";
		},
	};
	const paneNode = { innerHTML: "" };
	const app = {
		get innerHTML() {
			return html;
		},
		set innerHTML(next: string) {
			html = next;
			list.scrollTop = 0;
		},
		querySelector: (selector: string) => {
			if (selector === ".sk-list") return list;
			if (selector === ".sk-band") return targetedDom ? bandNode : null;
			if (selector === ".sk-pane") return targetedDom ? paneNode : null;
			if (selector === '.sk-row[aria-current="true"]') {
				return html.includes('aria-current="true"') ||
					selectionNodes.some(
						(node) => node.classList?.contains("sk-row") && node.getAttribute("aria-current") === "true",
					)
					? currentRow
					: null;
			}
			return null;
		},
		querySelectorAll: (selector: string): FakeClickable[] => {
			if (selector === ".sk-row") return selectionNodes.filter((node) => node.classList?.contains("sk-row"));
			if (selector === "[data-mcp]") {
				const selectionHtml = targetedBandHtml
					? targetedBandHtml + html.slice(Math.max(0, html.indexOf("<aside")))
					: html;
				selectionNodes = Array.from(
					selectionHtml.matchAll(/<button\b[^>]*data-mcp="([^"]+)"[^>]*>/g),
					(match) => {
						const tag = match[0];
						const server = match[1] as string;
						const classes = /class="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [];
						const attributes = new Map<string, string>([["data-mcp", server]]);
						if (tag.includes('aria-current="true"')) attributes.set("aria-current", "true");
						const node: FakeClickable = {
							getAttribute: (name) => attributes.get(name) ?? null,
							setAttribute: (name, value) => attributes.set(name, value),
							removeAttribute: (name) => attributes.delete(name),
							classList: { contains: (name) => classes.includes(name) },
							focus: () => {
								document.activeElement = node;
							},
						};
						return node;
					},
				);
				return selectionNodes;
			}
			if (selector === ".sk-clamp") {
				proseNodes = Array.from(
					html.matchAll(/class="([^"]*\bsk-clamp\b[^"]*)"[^>]*aria-expanded="(true|false)"/g),
					(match) => {
						const classes = (match[1] as string).split(/\s+/);
						const attributes = new Map([["aria-expanded", match[2] as string]]);
						return {
							getAttribute: (name: string) => attributes.get(name) ?? null,
							setAttribute: (name: string, value: string) => attributes.set(name, value),
							classList: { contains: (name: string) => classes.includes(name) },
						};
					},
				);
				return proseNodes;
			}
			return [];
		},
	};
	const document = {
		activeElement: null as FakeClickable | null,
		getElementById: (id: string) => (id === "app" ? app : null),
		createElement: (_tag: string) => {
			let content = "";
			return {
				set innerHTML(next: string) {
					content = next;
				},
				get firstChild() {
					return { html: content };
				},
			};
		},
	};
	const win = {
		JD: {} as Record<string, unknown>,
		location: new URL("http://127.0.0.1/mcps"),
		innerHeight: 800,
		setTimeout: (run: () => void, delay = 0) => {
			const id = nextTimerId++;
			timers.set(id, { at: timerClock + Math.max(0, delay), run });
			return id;
		},
		clearTimeout: (id: number) => timers.delete(id),
		history: {
			replaceState: (_state: unknown, _title: string, href: string) => {
				win.location = new URL(href);
			},
		},
	};
	let responder = (path: string): Promise<unknown> => {
		if (path.startsWith("/api/mcp-detail")) {
			const server = new URL(path, "http://127.0.0.1").searchParams.get("server") ?? detail.server;
			return Promise.resolve({ ...detail, server });
		}
		return Promise.resolve({ list: "server", offset: 0, rows: [], totalCount: 0 });
	};
	const esc = (value: unknown) =>
		String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	Object.assign(win.JD, {
		esc,
		seriesColor: () => "#000",
		sourceIndex: () => 0,
		query: () => "?range=today",
		withParams: (path: string, params: Record<string, unknown>) => {
			const url = new URL(path, "http://127.0.0.1");
			for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
			return url.pathname + url.search;
		},
		getJson: (path: string) => {
			requests.push(path);
			return responder(path);
		},
		dayKey: (atMs: number, timeZone: string) =>
			new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
				atMs,
			),
		dayLabel: (key: string) => key,
		dayBars: (days: ReadonlyArray<string>, values: ReadonlyArray<number>) =>
			`<svg>${days.map((day, index) => `<title>${day}=${values[index] ?? 0}</title>`).join("")}</svg>`,
		stackedBarsFrame: (
			series: ReadonlyArray<{ readonly bySeries: Readonly<Record<string, number>> }>,
			keys: ReadonlyArray<string>,
		) => ({
			svg: `<svg data-keys="${esc(keys.join("|"))}" data-total="${keys.reduce(
				(sum, key) => sum + (series[0]?.bySeries[key] ?? 0),
				0,
			)}"></svg>`,
			ticks: ["40", "30", "20", "10", "0"],
			firstDay: "2026-07-30",
			lastDay: "",
		}),
	});
	const source = readFileSync(new URL("./assets/js/mcps.js", import.meta.url), "utf8");
	new Function("window", "document", source)(win, document);
	return {
		requests,
		list,
		currentRow,
		html: () => html,
		render: (next: unknown) => {
			(win.JD as { renderMcps: (value: unknown) => void }).renderMcps(next);
		},
		selectServer: (name) => {
			const url = new URL(win.location.href);
			if (name) url.searchParams.set("mcp", name);
			else url.searchParams.delete("mcp");
			win.location = url;
		},
		selectedServer: () => win.location.searchParams.get("mcp"),
		clickServer: (name) => {
			const node = selectionNodes.find((candidate) => candidate.getAttribute("data-mcp") === name);
			if (!node?.onclick) throw new Error(`no wired MCP selection for ${name}`);
			node.onclick();
		},
		clickFocusedLegend: (name) => {
			const node = selectionNodes.find(
				(candidate) =>
					candidate.classList?.contains("sk-legend") && candidate.getAttribute("data-mcp") === name,
			);
			if (!node?.onclick) throw new Error(`no wired MCP legend for ${name}`);
			clickedNode = node;
			document.activeElement = node;
			node.onclick();
		},
		focusedSelection: () => ({
			name: document.activeElement?.getAttribute("data-mcp") ?? null,
			legend: document.activeElement?.classList?.contains("sk-legend") ?? false,
			replaced: document.activeElement !== null && document.activeElement !== clickedNode,
		}),
		useTargetedDom: () => {
			targetedDom = true;
		},
		clickProse: () => {
			if (!proseNodes[0]?.onclick) throw new Error("no wired prose block");
			proseNodes[0].onclick();
		},
		proseExpanded: () => proseNodes[0]?.getAttribute("aria-expanded") ?? null,
		advanceTimersBy,
		respondWith: (handler) => {
			responder = handler;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MCPs page asset", () => {
	it("anchors its detail request and charts every server-side day, including zero days", async () => {
		const h = loadHarness();
		h.render(model());
		await settle();

		expect(h.requests[0]).toBe(`/api/mcp-detail?range=today&server=Other&nowMs=${GENERATED_AT_MS}`);
		for (const day of detail.daySeries) {
			expect(h.html()).toContain(`<title>${day.date}=${day.sessions}</title>`);
		}
		// The per-session chart's titles are rendered locally rather than through
		// `JD.dayBars`, and they carry the SESSION's date plus its call count.
		for (const point of detail.sessionSeries) {
			const dayKey = new Intl.DateTimeFormat("en-CA", {
				timeZone: "UTC",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).format(point.atMs);
			expect(h.html()).toContain(
				`<title>${dayKey} · ${point.calls} ${point.calls === 1 ? "call" : "calls"}</title>`,
			);
		}
		expect(h.html()).toContain(
			'<b title="Lower bound: only the last call per session and tool is recorded.">First seen</b>',
		);
		expect(h.html()).toContain("of all MCP calls");
	});

	it("renders epoch-zero record timestamps instead of treating them as absent", async () => {
		const h = loadHarness();
		h.respondWith((path) =>
			Promise.resolve(path.startsWith("/api/mcp-detail") ? { ...detail, firstCallAtMs: 0, lastCallAtMs: 0 } : {}),
		);
		h.render(model());
		await settle();

		expect(h.html()).toContain("First seen");
		expect(h.html()).toContain("Last seen");
		expect(h.html()).toContain("1970-01-01");
	});

	it("discloses when the per-session chart retains only the newest sessions", async () => {
		const h = loadHarness();
		h.respondWith((path) =>
			Promise.resolve(path.startsWith("/api/mcp-detail") ? { ...detail, sessions: 401 } : {}),
		);
		h.render(model());
		await settle();

		expect(h.html()).toContain("Most recent 2 of 401 sessions shown; totals and daily cadence remain exact.");
	});

	it("uses the named-server tool total in its header", () => {
		const h = loadHarness();
		h.render(model());
		expect(h.html()).toContain("<b>35</b> calls · <b>5</b> servers · <b>5</b> tools");
		expect(h.html()).not.toContain("<b>6</b> tools");
	});

	it("keeps prototype-shaped and real Other server names distinct from the roll-up", () => {
		const h = loadHarness();
		h.render(model());
		const html = h.html();

		for (const name of ["Other", "__proto__", "constructor"]) {
			expect(html).toContain(`data-mcp="${name}"`);
		}
		// Four real series plus a collision-free aggregate, conserving 10+9+8+7+1.
		expect(html).toContain('data-keys="Other|__proto__|constructor|b|Other "');
		expect(html).toContain('data-total="35"');
		expect(html).toContain("<b>Other (1 server)</b> 1");
		expect(html).not.toContain("<b>Other </b>");
	});

	it("states when the tool list is capped and spells out session counts", async () => {
		const h = loadHarness();
		h.respondWith((path) =>
			Promise.resolve(
				path.startsWith("/api/mcp-detail")
					? {
							...detail,
							toolCount: 3,
							tools: [
								{ name: "search", calls: 4, sessions: 1 },
								{ name: "recall", calls: 3, sessions: 2 },
							],
						}
					: { list: "server", rows: [] },
			),
		);
		h.render(model());
		await settle();

		expect(h.html()).toContain("2 busiest of 3 tools called; the figures above stay exact.");
		expect(h.html()).toContain('<span class="mcp-tool-sess">1 session</span>');
		expect(h.html()).toContain('<span class="mcp-tool-sess">2 sessions</span>');
		expect(h.html()).not.toContain(" sess</span>");
	});

	it("restarts a shifted list partition instead of losing the displaced server", async () => {
		const all = Array.from({ length: 10 }, (_, index) => serverRow(index));
		const h = loadHarness();
		let served = 0;
		h.respondWith((path) => {
			if (path.startsWith("/api/mcp-detail")) return Promise.resolve({ ...detail, server: "server000" });
			served++;
			return Promise.resolve(
				served === 1
					? { list: "server", offset: 0, rows: all.slice(0, 8), totalCount: 10 }
					: served === 2
						? { list: "server", offset: 8, rows: [all[7], all[8]], totalCount: 10 }
						: { list: "server", offset: 0, rows: all, totalCount: 10 },
			);
		});
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();

		expect(served).toBe(3);
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(all.length);
		expect(h.html()).toContain('data-mcp="server009"');
		expect(h.requests.filter((path) => path.startsWith("/api/tool-usage"))).toEqual([
			expect.stringContaining(`nowMs=${GENERATED_AT_MS}`),
			expect.stringContaining(`nowMs=${GENERATED_AT_MS}`),
			expect.stringContaining(`nowMs=${GENERATED_AT_MS}`),
		]);
	});

	it("bounds a growing list response instead of spinning or publishing a partial pass", async () => {
		const firstPage = Array.from({ length: TOOL_ROWS_LIMIT }, (_, index) => serverRow(index));
		const h = loadHarness();
		h.respondWith((path) => {
			if (path.startsWith("/api/mcp-detail")) return Promise.resolve({ ...detail, server: "server000" });
			const offset = Number(new URL(path, "http://127.0.0.1").searchParams.get("offset") ?? 0);
			return Promise.resolve({ list: "server", offset, rows: [serverRow(offset)], totalCount: offset + 2 });
		});
		h.render(model(firstPage, 10));
		await settle();

		expect(h.requests.filter((path) => path.startsWith("/api/tool-usage"))).toHaveLength(25);
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(TOOL_ROWS_LIMIT);
		expect(h.html()).toContain("Showing 8 of 10 servers — could not load the rest");
	});

	it("keeps the first page on a failed tail read and retries it after 30 seconds", async () => {
		const all = Array.from({ length: 10 }, (_, index) => serverRow(index));
		const h = loadHarness();
		let fail = true;
		h.respondWith((path) => {
			if (path.startsWith("/api/mcp-detail")) return Promise.resolve({ ...detail, server: "server000" });
			if (fail) {
				fail = false;
				return Promise.reject(new Error("offline"));
			}
			return Promise.resolve({ list: "server", offset: 0, rows: all, totalCount: all.length });
		});
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		await settle();
		expect(h.html()).toContain("Showing 8 of 10 servers — could not load the rest");

		h.advanceTimersBy(29_999);
		await settle();
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(TOOL_ROWS_LIMIT);
		h.advanceTimersBy(1);
		await settle();
		expect(h.html().match(/class="sk-row"/g)).toHaveLength(all.length);
		expect(h.html()).not.toContain("could not load the rest");
	});

	it("lets the current row close the pane without the default selection reopening it", async () => {
		const h = loadHarness();
		const payload = model();
		h.render(payload);
		await settle();
		const detailReads = () => h.requests.filter((path) => path.startsWith("/api/mcp-detail")).length;
		const beforeClose = detailReads();

		h.clickServer("Other");
		await settle();
		expect(h.selectedServer()).toBeNull();
		expect(h.html()).not.toContain('aria-current="true"');
		expect(h.html()).toContain("Select an MCP server");

		h.render(payload);
		await settle();
		expect(h.selectedServer()).toBeNull();
		expect(detailReads()).toBe(beforeClose);
	});

	it("opens the prose block by default and preserves a manual collapse across repaints", async () => {
		const h = loadHarness();
		const payload = model();
		h.render(payload);
		await settle();
		// The basis line reads on first arrival: the reader should not have to click to see
		// what the page is claiming.
		expect(h.proseExpanded()).toBe("true");

		// A click collapses it; a repaint MUST preserve that (module-scoped `openProse`).
		h.clickProse();
		expect(h.proseExpanded()).toBe("false");
		h.render(payload);
		expect(h.html()).toMatch(/sk-basis sk-clamp[^>]*aria-expanded="false"/);
	});

	it("reveals a selected server once its row arrives in the fetched tail", async () => {
		const all = Array.from({ length: 10 }, (_, index) => serverRow(index));
		const h = loadHarness();
		h.respondWith((path) =>
			Promise.resolve(
				path.startsWith("/api/mcp-detail")
					? { ...detail, server: "server009" }
					: { list: "server", offset: 0, rows: all, totalCount: all.length },
			),
		);
		h.selectServer("server009");
		h.render(model(all.slice(0, TOOL_ROWS_LIMIT), all.length));
		expect(h.currentRow.scrollIntoViewCalls).toEqual([]);
		await settle();

		expect(h.html()).toContain('data-mcp="server009" aria-current="true"');
		expect(h.currentRow.scrollIntoViewCalls).toEqual([{ block: "center" }]);
	});

	it("reveals a legend selection and restores keyboard focus after its targeted repaint", () => {
		const h = loadHarness();
		h.render(model());
		h.currentRow.scrollIntoViewCalls.length = 0;
		h.useTargetedDom();

		h.clickFocusedLegend("__proto__");

		expect(h.currentRow.scrollIntoViewCalls).toEqual([{ block: "center" }]);
		expect(h.focusedSelection()).toEqual({ name: "__proto__", legend: true, replaced: true });
	});

	it("moves focus to the list row when deselection removes an out-of-band legend", () => {
		const h = loadHarness();
		h.selectServer("c");
		h.render(model());
		h.useTargetedDom();

		h.clickFocusedLegend("c");

		expect(h.focusedSelection()).toEqual({ name: "c", legend: false, replaced: true });
	});

	it("describes a 404 as an empty window instead of a stale dashboard", async () => {
		const h = loadHarness();
		h.respondWith((path) =>
			path.startsWith("/api/mcp-detail")
				? Promise.reject({ status: 404 })
				: Promise.resolve({ list: "server", rows: [] }),
		);
		h.render(model());
		await settle();

		expect(h.html()).toContain("No captured calls for this MCP server in this window.");
		expect(h.html()).not.toContain("restart it");
	});
});
