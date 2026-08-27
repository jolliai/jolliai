/* MCPs page — a chart band, a chooser column, and a reading pane.
 *
 * THE SKILLS PAGE'S TWIN, DELIBERATELY. It takes that page's grammar wholesale (the
 * `.sk-*` classes, the URL-borne selection, the read-the-whole-list-on-arrival column,
 * the shared day axis) because the two answer the same shape of question about the same
 * table: which of my things did my agents reach for, how often, and when. Every rule in
 * `skills.js`'s header applies here and is not restated — read that file first.
 *
 * WHAT IS NOT SHARED IS THE CODE. The two pages have separate modules and separate
 * state, and that is not an oversight: a shared module would have to carry a "which
 * list" parameter through every function, and the two panes differ in what the RECORD
 * holds rather than in presentation (see below). The shared part is the stylesheet, and
 * `main.css`'s browser-page block is where that sharing is declared.
 *
 * WHAT THE RECORD CANNOT SAY HERE, and why three of the Skills pane's sections have no
 * counterpart:
 *
 *   - **No cost.** Nothing writes an MCP row's token columns, so there is no spend to
 *     attribute — not "we do not show it", but "it was never measured".
 *   - **No outcomes.** `skill_invocations` gives a skill a row per invocation with its
 *     own `ok`; MCP has no such table, so whether a call succeeded is not on record.
 *   - **No arguments, no results.** Same absence, and the one the page states out loud
 *     in its basis line: a reader who expects a call log has to be told there is none
 *     rather than left to read an empty section as a bug.
 *
 * `tools` is the section that exists here and nowhere else. A server is a NAMESPACE, so
 * "which of its tools do I actually use" is the question this page is opened for, and it
 * is the one figure a server row cannot carry.
 *
 * THE TWO CHARTS COUNT DIFFERENT THINGS, and the difference is the point: `Call cadence`
 * counts SESSIONS by day (how often it was reached for) and `Calls per session` counts
 * CALLS per session in arrival order (how hard it was worked in each). A busy day with
 * one session and a quiet day with four are the two shapes those charts exist to tell
 * apart.
 *
 * The two DELIBERATELY carry different X axes: the cadence chart is on the band's own
 * day buckets so a reader can line it up with the top chart, while `Calls per session`
 * is one bar per session in arrival order because the record holds one instant per
 * session and a per-day rewrite of it would drop the exact "session A made 40 calls"
 * signal this section is opened for. The two endpoint labels below each chart name the
 * span they cover, so the axes cannot be misread as the same clock.
 */
(function (JD) {
	"use strict";

	/* Series kept in the band before the rest rolls into "Other" — `skills.js`'s
	   constant and its reason: the categorical ramp holds five CVD-validated colours. */
	var BAND_SERIES = 4;
	/* A failed tail read retries without opting this page into the global model poll. */
	var REST_RETRY_MS = 30000;
	/* An absolute backstop against an unbounded request loop on a corrupt response
	   stream. Real reads stop on offset/total equality. */
	var MAX_LIST_REQUESTS = 1000;

	/* Everything an async answer can land in, so the two fetches below do not have to
	   re-render each other's half. Module-scoped for the reason `skills.js` states: an
	   explicit model refresh re-enters `renderMcps`, and a local would be re-seeded from
	   the payload, dropping a pane the reader is in the middle of. */
	var state = { rows: null, paneName: null, pane: null, paneError: null };

	/* Which render is current — the staleness guard for THE PANE'S detail fetch alone.
	   The list read next door is staled by a new PAYLOAD instead (see `collectRows`). */
	var seq = 0;

	var rowsTotal = null;
	var renderedModel = null;
	/* The model whose full list has already been asked for — the guard that keeps the
	   automatic read to ONE per payload. The model OBJECT, not a row count, because a
	   row click re-renders the same payload and must not re-read the list. */
	var fetchedModel = null;
	var restLoading = false;
	var restError = false;
	var restRetryTimer = null;

	/* Whether the pane's one long fixed paragraph is open. Module state rather than DOM
	   state because every path here repaints the whole pane; keyed by the block's own
	   class, which `bindProse` reads back off the event target. Defaults to OPEN because
	   the mockup shows the sentence in full and a first-time reader needs to see what the
	   page is claiming without a click; a click still collapses it back. */
	var openProse = { "sk-basis": true };

	/* Whether "the address names no server" has already been answered for this page
	   load. Nav is a full page reload, so this starts false on every arrival. */
	var defaultAnswered = false;

	/* The server the column has already been scrolled to, so a selection is revealed
	   ONCE rather than on every repaint. */
	var scrolledToServer = null;
	var paneHeightObserver = null;

	/** Mirrors the reading pane's natural height onto the chooser card. The page, not
	 *  the detail card, owns vertical scrolling; only the chooser's unbounded row list
	 *  may scroll inside its measured card. */
	function syncBottomCardHeights(app) {
		var nav = app.querySelector(".sk-nav");
		var pane = app.querySelector(".sk-pane");
		if (!nav || !pane || !nav.style || !pane.getBoundingClientRect) return;
		if (window.matchMedia && window.matchMedia("(max-width: 899px)").matches) {
			nav.style.height = "";
			return;
		}
		var height = pane.getBoundingClientRect().height || pane.offsetHeight || 0;
		if (height > 0) nav.style.height = height + "px";
	}

	function observeBottomCardHeights(app) {
		if (paneHeightObserver) paneHeightObserver.disconnect();
		paneHeightObserver = null;
		syncBottomCardHeights(app);
		var pane = app.querySelector(".sk-pane");
		if (!pane || !window.ResizeObserver) return;
		paneHeightObserver = new window.ResizeObserver(() => syncBottomCardHeights(app));
		paneHeightObserver.observe(pane);
	}

	/** The selected server, read from the address rather than from a variable. */
	function selectedServer() {
		try {
			return new URLSearchParams(window.location.search).get("mcp") || null;
		} catch (_err) {
			return null;
		}
	}

	/**
	 * Writes the selection into the address without adding a history entry.
	 *
	 * `?mcp=`, not `?server=`: the query string is shared with the topbar's own
	 * parameters (`repo`, `range`, `dimension`), and `server` reads as if it named the
	 * dashboard server rather than one row of this page.
	 */
	function setSelectedServer(name) {
		try {
			var url = new URL(window.location.href);
			if (name) url.searchParams.set("mcp", name);
			else url.searchParams.delete("mcp");
			window.history.replaceState(null, "", url.toString());
		} catch (_err) {
			/* A blocked History API must not stop the pane from opening — the render
			   below reads `state.paneName`, which is set either way. */
		}
	}

	/** The rows the column is showing: the fetched list once it lands, else the model's own page. */
	function visibleRows(model) {
		return state.rows || modelFirstPage(model);
	}

	/** The page the model already carries, which IS the column's first page. */
	function modelFirstPage(model) {
		var usage = (model.stats && model.stats.toolUsage) || {};
		return usage.servers || [];
	}

	/**
	 * The server to open when the address names none — the top row, which is the
	 * server's own volume ranking.
	 *
	 * Written into the ADDRESS, not just into `state`, for the reason `skills.js` gives:
	 * every render re-reads the address, so a selection living only in `state` is wiped
	 * by the next one. An empty list leaves the question open.
	 */
	function defaultSelection(model) {
		if (defaultAnswered) return null;
		var rows = visibleRows(model);
		if (rows.length === 0) return null;
		defaultAnswered = true;
		setSelectedServer(rows[0].server);
		return rows[0].server;
	}

	/** Extracted from `renderMcps` so the row-click handler can start a new detail
	 *  fetch without going through the full render. Mirror of `skills.js`'s `fetchDetail`. */
	function fetchDetail(app, model) {
		var selected = state.paneName;
		if (!selected) return;
		var mine = ++seq;
		JD.getJson(
			JD.withParams("/api/mcp-detail" + JD.query(model, {}), {
				server: selected,
				/* The page model and its chooser rows were resolved against this clock.
				   Carry it into the detail read so `today` cannot cross midnight between
				   the render and a click and turn a visible row into a 404. */
				nowMs: model.generatedAtMs,
			}),
		)
			.then(
				(detail) => {
					if (mine !== seq || state.paneName !== selected) return false;
					state.pane = detail;
					return true;
				},
				/* THE TWO-CALLBACK FORM, never a trailing `.catch`, with the repaint moved
				   out of both — `skills.js` carries the measurement: under a shared handler a
				   render fault in a chart was reported to the reader as a dashboard that had
				   stopped, because `paneErrorText` reads a missing `status` that way. */
				(err) => {
					if (mine !== seq || state.paneName !== selected) return false;
					state.paneError = paneErrorText(err);
					return true;
				},
			)
			.then((changed) => {
				if (changed) drawPane(app, model);
			});
	}

	function renderMcps(model) {
		var app = document.getElementById("app");
		if (!app) return;
		if (renderedModel !== model) {
			cancelRowsRetry();
			renderedModel = model;
			var freshUsage = (model.stats && model.stats.toolUsage) || {};
			rowsTotal = freshUsage.serversTotal || 0;
			restLoading = false;
			restError = false;
		}
		var selected = selectedServer();
		if (!selected) selected = defaultSelection(model);
		/* A different server invalidates the cached pane, so the reader never sees the
		   previous server's figures under the new server's name. */
		if (state.paneName !== selected) state = { rows: state.rows, paneName: selected, pane: null, paneError: null };

		/* The rest of the list, on nobody's ask. Skipped when the model's first page
		   already IS every server, which is the common case: a machine runs far fewer
		   servers than skills, so this page usually costs no request at all. The flags
		   move BEFORE the draw so the loading line is on screen for the whole flight. */
		var needsRest = serverTotal(model) > modelFirstPage(model).length && fetchedModel !== model;
		if (needsRest) {
			fetchedModel = model;
			restLoading = true;
			restError = false;
		}

		draw(app, model);

		if (needsRest) fetchRows(app, model);
		fetchDetail(app, model);
	}

	/**
	 * Reads the whole ranked list, from the top.
	 *
	 * `skills.js`'s `collectRows` with the identity changed from `row.name` to
	 * `row.server`; every rule there holds here. The stop is the SERVER's position rather
	 * than a row count fixed when the read began, a repeated identity restarts the pass
	 * (an offset partition that moved would otherwise skip the row it displaced), and
	 * what stales the read is a new PAYLOAD rather than the render counter `seq`.
	 */
	function collectRows(model) {
		var rows = [];
		var names = Object.create(null);
		var offset = 0;
		var total = serverTotal(model);
		var restartsLeft = 2;
		var requestBudget = Math.min(
			MAX_LIST_REQUESTS,
			Math.max(25, Math.ceil(total / Math.max(1, modelFirstPage(model).length)) * (restartsLeft + 1)),
		);

		function restart() {
			if (restartsLeft <= 0) return Promise.reject(new Error("MCP server list changed while it was being read"));
			restartsLeft--;
			rows = [];
			names = Object.create(null);
			offset = 0;
			return next();
		}

		function next() {
			if (renderedModel !== model) return Promise.resolve({ rows: rows, total: total });
			if (offset >= total) {
				if (rows.length === total) return Promise.resolve({ rows: rows, total: total });
				return restart();
			}
			if (requestBudget <= 0) {
				return Promise.reject(new Error("MCP server list kept growing while it was being read"));
			}
			requestBudget--;
			return JD.getJson(
				JD.withParams("/api/tool-usage" + JD.query(model, {}), {
					list: "server",
					offset: String(offset),
					limit: String(total - offset),
					nowMs: model.generatedAtMs,
				}),
			).then((page) => {
				if (renderedModel !== model) return { rows: rows, total: total };
				var incoming = (page && page.rows) || [];
				if (page && typeof page.totalCount === "number") total = page.totalCount;
				var repeated = false;
				incoming.forEach((row) => {
					if (!names[row.server]) {
						names[row.server] = true;
						rows.push(row);
					} else repeated = true;
				});
				offset += incoming.length;
				if (repeated || (incoming.length === 0 && offset < total)) return restart();
				return next();
			});
		}

		return next();
	}

	function cancelRowsRetry() {
		if (restRetryTimer === null) return;
		window.clearTimeout(restRetryTimer);
		restRetryTimer = null;
	}

	/** Retries only the list tail; the open detail pane and the rest of the page stay put. */
	function scheduleRowsRetry(app, model) {
		cancelRowsRetry();
		restRetryTimer = window.setTimeout(() => {
			restRetryTimer = null;
			if (renderedModel !== model || fetchedModel !== model || !restError || restLoading) return;
			restLoading = true;
			restError = false;
			draw(app, model);
			fetchRows(app, model);
		}, REST_RETRY_MS);
	}

	function fetchRows(app, model) {
		cancelRowsRetry();
		collectRows(model)
			.then(
				(result) => {
					if (renderedModel !== model) return false;
					state.rows = result.rows;
					rowsTotal = result.total;
					restLoading = false;
					restError = false;
					cancelRowsRetry();
					return true;
				},
				() => {
					if (renderedModel !== model) return false;
					/* THE ROWS ARE LEFT ALONE — a list that empties itself over one failed
					   fetch is worse than a short one. Only the loading line moves. */
					restLoading = false;
					restError = true;
					scheduleRowsRetry(app, model);
					return true;
				},
			)
			.then((changed) => {
				if (changed) draw(app, model);
			});
	}

	function serverTotal(model) {
		if (rowsTotal !== null) return rowsTotal;
		var usage = (model.stats && model.stats.toolUsage) || {};
		return usage.serversTotal || 0;
	}

	/**
	 * What to tell the reader when the detail could not be loaded. No `status` means
	 * nothing reached the dashboard; 404 is the valid answer that this server has no
	 * captured call in the selected window; every other status is a server refusal.
	 */
	function paneErrorText(err) {
		if (err && err.status === 404) return "No captured calls for this MCP server in this window.";
		if (err && typeof err.status === "number") {
			return (
				"Could not load this MCP server — the dashboard answered " +
				err.status +
				". If it has been running since before this view existed, restart it." +
				" This view needs a current server."
			);
		}
		return "Could not reach the dashboard server. It may have stopped — run `jolli dashboard` again.";
	}

	/** Whether the current row is already somewhere the reader can see it. */
	function isRowRevealed(list, row) {
		if (!row.getBoundingClientRect || !list || !list.getBoundingClientRect) return true;
		var rect = row.getBoundingClientRect();
		var box = list.getBoundingClientRect();
		if (rect.top < box.top || rect.bottom > box.bottom) return false;
		var viewportHeight = window.innerHeight || 0;
		if (!viewportHeight) return true;
		return rect.top >= 0 && rect.bottom <= viewportHeight;
	}

	/**
	 * Brings the selected row into view, ONCE per selection — `skills.js`'s
	 * `revealSelectedRow`, and its reasons hold unchanged: the Stats card's MCP rows can
	 * link in with a server selected that sits far down the column, and the band's key
	 * can select one outside its top four. Not recorded when the row is absent, because
	 * the selection may name a server still in the list's in-flight tail.
	 */
	function revealSelectedRow(app, list) {
		var name = state.paneName;
		if (!name) {
			scrolledToServer = null;
			return;
		}
		if (scrolledToServer === name) return;
		var row = app.querySelector('.sk-row[aria-current="true"]');
		if (!row) return;
		scrolledToServer = name;
		if (isRowRevealed(list, row)) return;
		if (row.scrollIntoView) row.scrollIntoView({ block: "center" });
	}

	/**
	 * Rewrites ONLY the reading pane, leaving the band chart's SVG, the row column and its
	 * scroll offset in place. Used when the detail fetch lands for the currently selected
	 * server — nothing above the pane changed between the two frames, and rebuilding the
	 * band SVG and the list every time was where the row-click flicker came from. Falls
	 * back to the full `draw` if the pane node is missing, so a caller that lands here
	 * before the frame has been rendered cannot silently no-op. Prose handlers are re-bound
	 * because the clamped paragraph lives inside the pane and its listener rode the old
	 * node down. Mirror of `drawPane` in `skills.js`. */
	function drawPane(app, model) {
		var pane = app.querySelector(".sk-pane");
		if (!pane) {
			draw(app, model);
			return;
		}
		var usage = (model.stats && model.stats.toolUsage) || {};
		pane.innerHTML = paneHtml(usage, model.timeZone);
		bindProse(app);
		syncBottomCardHeights(app);
	}

	/** Chart/list linking helper: marks bar rects belonging to the selected series with
	 *  `data-active` so the CSS in `main.css` keeps them at full opacity while the others
	 *  fade. Mirror of `skills.js`'s `applyBandActive`; the rule is one line, one comment. */
	function applyBandActive(app) {
		var name = state.paneName || "";
		var rects = app.querySelectorAll(".sk-band .sk-bandbars rect[data-series]");
		Array.prototype.forEach.call(rects, (rect) => {
			if (name && rect.getAttribute("data-series") === name) rect.setAttribute("data-active", "");
			else rect.removeAttribute("data-active");
		});
	}

	/** Redraws ONLY `.sk-band`, leaving the nav column and pane in place. Needed on
	 *  selection change because a server outside the top four swaps into the fourth slot
	 *  — a pure attribute toggle would leave that case wrong. Rebinds selection because
	 *  the legend buttons ride the new band. Mirror of `skills.js`'s `drawBand`. */
	function drawBand(app, model) {
		var band = app.querySelector(".sk-band");
		if (!band) return;
		var usage = (model.stats && model.stats.toolUsage) || {};
		var host = document.createElement("div");
		host.innerHTML = bandHtml(usage);
		var next = host.firstChild;
		band.replaceWith(next);
		applyBandActive(app);
		bindSelection(app, model);
	}

	/** Restores keyboard focus after `drawBand` replaces the legend buttons. Compare
	 *  attributes directly instead of building a selector from a user-authored server
	 *  name; fall back to the matching list row if deselection removes the legend. */
	function restoreSelectionFocus(app, name) {
		var legend = null;
		var row = null;
		Array.prototype.forEach.call(app.querySelectorAll("[data-mcp]"), (element) => {
			if (element.getAttribute("data-mcp") !== name) return;
			if (element.classList && element.classList.contains("sk-legend")) legend = element;
			else if (element.classList && element.classList.contains("sk-row")) row = element;
		});
		var target = legend || row;
		if (target && target.focus) target.focus();
	}

	/** The selection-only repaint (list aria-current + band + pane). Called from the
	 *  row-click handler in place of the old full `renderMcps(model)`, which tore down
	 *  the whole `.browser-page` section on every click. Mirror of `skills.js`'s
	 *  `updateSelection`. */
	function updateSelection(app, model, focusedLegendName) {
		var name = state.paneName;
		Array.prototype.forEach.call(app.querySelectorAll(".sk-row"), (row) => {
			if (row.getAttribute("data-mcp") === name) row.setAttribute("aria-current", "true");
			else row.removeAttribute("aria-current");
		});
		revealSelectedRow(app, app.querySelector(".sk-list"));
		drawBand(app, model);
		drawPane(app, model);
		if (focusedLegendName !== null) restoreSelectionFocus(app, focusedLegendName);
	}

	function draw(app, model) {
		var usage = (model.stats && model.stats.toolUsage) || {};
		var rows = visibleRows(model);
		/* The rows' offset is carried across by hand: the write below replaces the node
		   that holds it, and only that node scrolls. Without it the column snapped back
		   to its first row on every repaint that reaches HERE — a row click, the tail of
		   the list arriving, an explicit refresh. The detail-fetch path no longer reaches
		   this function (see `drawPane` above), so it needs no carry-across at all — the
		   list node is untouched there. */
		var previous = app.querySelector(".sk-list");
		var offset = previous ? previous.scrollTop : 0;
		app.innerHTML =
			'<section class="browser-page mcp-page">' +
			bandHtml(usage) +
			'<aside class="sk-nav" aria-label="MCP server browser">' +
			navHeadHtml(usage) +
			'<div class="sk-list">' +
			listHtml(rows) +
			"</div>" +
			navPagingHtml(rows, usage) +
			navFootHtml(usage) +
			"</aside>" +
			'<article class="sk-pane" aria-label="MCP server detail">' +
			paneHtml(usage, model.timeZone) +
			"</article>" +
			"</section>";
		var list = app.querySelector(".sk-list");
		if (list) {
			if (offset > 0) list.scrollTop = offset;
			/* AFTER the restore: this measures where the row actually sits, and a new
			   selection is the one thing allowed to overrule the carried-across offset. */
			revealSelectedRow(app, list);
		}
		bindSelection(app, model);
		bindProse(app);
		applyBandActive(app);
		observeBottomCardHeights(app);
	}

	// ── The band ────────────────────────────────────────────────────────────────

	/**
	 * Every server's adoption, day by day.
	 *
	 * `skills.js`'s `bandHtml` against `usage.serverDays`, including the rule
	 * `JD.topSeries` cannot express: a SELECTED server outside the top four is swapped
	 * into the fourth slot, because otherwise "highlight this server" fails for exactly
	 * the servers the roll-up hides, and dimming the Other segments instead would claim
	 * several servers' aggregate is one server.
	 */
	function bandHtml(usage) {
		var series = usage.serverDays || [];

		var totals = Object.create(null);
		series.forEach((point) => {
			Object.keys(point.bySeries || {}).forEach((name) => {
				totals[name] = (totals[name] || 0) + point.bySeries[name];
			});
		});
		var names = Object.keys(totals);
		var selected = state.paneName && totals[state.paneName] !== undefined ? state.paneName : null;
		/* `data-selected` on the band is what dims non-active rects (see `skills.js`'s
		   `bandHtml` — one comment for both). Empty when nothing is selected. */
		var head =
			'<div class="sk-band" data-selected="' +
			(selected ? JD.esc(selected) : "") +
			'"><div class="sk-nav-head" style="padding:0 0 10px;border-bottom:0">' +
			"<b>All MCP servers, day by day</b> · sessions that made at least one captured call " +
			"through each server · a session using several servers counts once per server</div>";

		/* THE EMPTY TEST IS "no series", NOT "no points": `serverDays` carries one point
		   per day of the window whether or not anything ran, so a `series.length` test
		   would draw an axis and an empty legend for a window with no MCP calls. */
		if (names.length === 0) {
			return head + '<div class="empty-note">No MCP server calls recorded in this window.</div></div>';
		}
		var ranked = names.slice().sort((a, b) => totals[b] - totals[a] || (a < b ? -1 : a > b ? 1 : 0));
		var kept = ranked.slice(0, BAND_SERIES);
		if (selected && kept.indexOf(selected) === -1) kept = kept.slice(0, BAND_SERIES - 1).concat([selected]);
		var keptSet = Object.create(null);
		kept.forEach((name) => {
			keptSet[name] = true;
		});

		/* A server is user-controlled and can really be named `Other`. The roll-up
		   therefore takes the first free INTERNAL key, matching `JD.topSeries`; otherwise
		   the aggregate overwrites the real server. Its visible label below says how many
		   servers it contains, so a collision cannot leave two identical legend rows. */
		var otherKey = "Other";
		while (otherKey in totals) otherKey += " ";
		var rolled = series.map((point) => {
			var bySeries = Object.create(null);
			var other = 0;
			Object.keys(point.bySeries || {}).forEach((name) => {
				if (keptSet[name]) bySeries[name] = point.bySeries[name];
				else other += point.bySeries[name];
			});
			bySeries[otherKey] = other;
			return { date: point.date, bySeries: bySeries };
		});
		var keys = kept.concat([otherKey]);
		var otherNames = names.filter((name) => !keptSet[name]);
		var otherTotal = otherNames.reduce((sum, name) => sum + totals[name], 0);
		var otherLabel = "Other (" + otherNames.length + (otherNames.length === 1 ? " server)" : " servers)");

		var legend = keys
			.map((key, index) => {
				var value = key === otherKey ? otherTotal : totals[key];
				var label = key === otherKey ? otherLabel : key;
				var body =
					'<i style="background:' + JD.seriesColor(index) + '"></i><b>' + JD.esc(label) + "</b> " + value;
				/* Other is a span, not a button: an aggregate of several servers is not a
				   subject a reader can open. */
				if (key === otherKey)
					return '<span class="sk-legend' + (selected ? " sk-dim" : "") + '">' + body + "</span>";
				return (
					'<button type="button" class="sk-legend' +
					(selected && key !== selected ? " sk-dim" : "") +
					'" data-mcp="' +
					JD.esc(key) +
					'" aria-pressed="' +
					String(key === selected) +
					'">' +
					body +
					"</button>"
				);
			})
			.join("");

		/* `stackedBarsFrame`, NOT `stackedBars`, for the reason `skills.js` states: this
		   chart's height is a budget the pane below it shares, and the plain entry point
		   keeps its axis text inside the viewBox so it can only be bounded through its
		   WIDTH. An integer formatter, because "0.5" on an axis counting sessions is a
		   claim the unit cannot make. */
		var frame = JD.stackedBarsFrame(rolled, keys, "server sessions", (n) => String(Math.round(n)));
		var ticks = frame.ticks.map((tick) => "<span>" + JD.esc(tick) + "</span>").join("");
		var axis =
			'<div class="sk-axis"><span>' +
			JD.esc(frame.firstDay) +
			"</span>" +
			(frame.lastDay ? "<span>" + JD.esc(frame.lastDay) + "</span>" : "") +
			"</div>";
		return (
			head +
			'<div class="sk-bandrow"><div class="chart-box"><div class="sk-bandplot">' +
			'<div class="sk-bandticks">' +
			ticks +
			'</div><div class="sk-bandmain">' +
			frame.svg +
			axis +
			'</div></div></div><div class="sk-key">' +
			legend +
			"</div></div></div>"
		);
	}

	// ── The chooser column ──────────────────────────────────────────────────────

	/**
	 * `128 calls · 4 servers · 16 tools`.
	 *
	 * THE FIGURES ARE THE SERVER'S, never a sum over the rows on screen: `usage.servers`
	 * is one page, so a header computed from it would change every time more rows
	 * arrived. `serverToolsTotal` is scoped to the named servers this page can actually
	 * list; `mcpToolsTotal` also includes legacy MCP rows with no server and belongs to
	 * the Stats page's general "by tool" list.
	 */
	function navHeadHtml(usage) {
		var calls = usage.serverCallsTotal || 0;
		var servers = rowsTotal === null ? usage.serversTotal || 0 : rowsTotal;
		var tools = usage.serverToolsTotal || 0;
		return (
			'<div class="sk-nav-head"><b>' +
			calls +
			(calls === 1 ? "</b> call · <b>" : "</b> calls · <b>") +
			servers +
			(servers === 1 ? "</b> server · <b>" : "</b> servers · <b>") +
			tools +
			(tools === 1 ? "</b> tool</div>" : "</b> tools</div>")
		);
	}

	/**
	 * The list. THE ORDER IS THE SERVER'S (calls, then sessions) and the header is NOT a
	 * sort control — `skills.js` carries the reasoning, which survives the column holding
	 * every row: the tail is still absent while it is in flight and after a failed read,
	 * and a header that silently sorts a partial list is the same lie arriving less often.
	 */
	function listHtml(rows) {
		if (rows.length === 0) return '<div class="empty-note">No MCP server calls recorded in this window.</div>';
		var selected = state.paneName;
		var html =
			'<div class="sk-cols" aria-hidden="true"><span>Server</span><span>Calls</span><span>Tools</span></div>' +
			'<ul class="ranklist">';
		rows.forEach((row) => {
			html +=
				'<li><button type="button" class="sk-row" data-mcp="' +
				JD.esc(row.server) +
				'"' +
				(row.server === selected ? ' aria-current="true"' : "") +
				' aria-label="' +
				(row.server === selected ? "Clear selection of " : "Read ") +
				JD.esc(row.server) +
				": " +
				row.calls +
				(row.calls === 1 ? " call through " : " calls through ") +
				row.tools +
				(row.tools === 1 ? " tool" : " tools") +
				'">' +
				'<span class="sk-name mono" title="' +
				JD.esc(row.server) +
				'">' +
				JD.esc(row.server) +
				"</span>" +
				'<span class="num">' +
				row.calls +
				"</span>" +
				'<span class="num sk-tok">' +
				row.tools +
				"</span>" +
				"</button></li>";
		});
		return html + "</ul>";
	}

	/** The loading line's band, pinned BELOW the rows — see `skills.js`'s `navPagingHtml`. */
	function navPagingHtml(rows, usage) {
		if (rows.length === 0) return "";
		var body = restStatusHtml(rows, usage);
		return body ? '<div class="sk-paging">' + body + "</div>" : "";
	}

	/** `Showing 8 of 11 servers — loading the rest…`, and only while that is true. */
	function restStatusHtml(rows, usage) {
		if (!restLoading && !restError) return "";
		var shown = rows.length;
		var total = rowsTotal === null ? (usage && usage.serversTotal) || shown : rowsTotal;
		/* A total the column already meets has nothing left to report, whichever flag is
		   still up — a stale `restError` beside a full list would call it short. */
		if (shown >= total) return "";
		return (
			'<div class="more-row"><span class="more-count">Showing ' +
			shown +
			" of " +
			total +
			(total === 1 ? " server" : " servers") +
			(restLoading ? " — loading the rest…" : " — could not load the rest; retrying shortly") +
			"</span></div>"
		);
	}

	/**
	 * The coverage denominator, in the grammar the Skills and MCPs cards print. Without
	 * it every figure above reads as if it covered every session — and on this page that
	 * matters twice over, because a server absent from the list may simply have been
	 * called only from an agent whose transcripts cannot be read.
	 */
	function navFootHtml(usage) {
		var withTools = usage.sessionsWithTools || 0;
		var inWindow = usage.sessionsInWindow || 0;
		return (
			'<div class="w-foot"><span class="w-measure">ⓘ from <b>' +
			withTools +
			"</b> of " +
			inWindow +
			(inWindow === 1 ? " session" : " sessions") +
			" in this window</span></div>"
		);
	}

	// ── The reading pane ────────────────────────────────────────────────────────

	function paneHtml(usage, timeZone) {
		if (!state.paneName) {
			return '<div class="sk-pane-empty">Select an MCP server to read which of its tools your agents called, and when.</div>';
		}
		if (state.paneError) return '<div class="sk-pane-empty">' + JD.esc(state.paneError) + "</div>";
		var detail = state.pane;
		if (!detail) return '<div class="sk-pane-empty">Loading…</div>';

		var callsTotal = usage.serverCallsTotal || 0;
		var share = callsTotal ? Math.round((detail.calls / callsTotal) * 100) : 0;

		var html =
			'<div class="sk-panebody"><div class="sk-title mono">' +
			JD.esc(detail.server) +
			'<span class="sk-kind">mcp server</span>' +
			"</div>" +
			'<div class="sk-figs">' +
			fig(detail.calls, "tool calls") +
			fig(detail.sessions, "sessions") +
			fig(detail.toolCount, "tools called") +
			fig(share + "%", "of all MCP calls") +
			"</div>";

		html += section("Call cadence", cadenceHtml(detail));
		html += section("Calls per session", volumeHtml(detail, timeZone));
		html += section("Tools called", toolsHtml(detail));
		html += section("The record", recordHtml(detail, timeZone));
		html += section("Who called it", agentsHtml(detail));

		html += proseBlock(
			"sk-basis",
			"MCP rows come from captured transcript tool calls grouped by server. This page shows which " +
				"server, which tool name and how often; it deliberately does not render arguments, results, " +
				"or servers that made no captured call in this window.",
		);
		return html + "</div>";
	}

	function fig(value, label) {
		return '<div class="sk-fig"><b class="num">' + JD.esc(String(value)) + "</b><span>" + label + "</span></div>";
	}

	/** One of the pane's long fixed paragraphs, shown as a single line until clicked. */
	function proseBlock(cls, text) {
		var open = openProse[cls] === true;
		return (
			'<div class="' +
			cls +
			' sk-clamp" role="button" tabindex="0" aria-expanded="' +
			(open ? "true" : "false") +
			'" title="' +
			JD.esc(text) +
			'">' +
			JD.esc(text) +
			"</div>"
		);
	}

	function section(title, body) {
		return '<div class="sk-sec"><h4>' + title + "</h4>" + body + "</div>";
	}

	function line(label, value, swatch, labelTitle) {
		/* `title="value"` on the span so a truncated value in `.sk-facts` is readable on
		   hover. Same rule `skills.js`'s `line` carries — the two grids share the CSS that
		   truncates the cell, so both need the recovery. */
		return (
			'<div class="sk-line">' +
			(swatch ? '<i style="background:' + swatch + '"></i>' : "") +
			"<b" +
			(labelTitle ? ' title="' + JD.esc(labelTitle) + '"' : "") +
			">" +
			JD.esc(label) +
			'</b><span title="' +
			JD.esc(value) +
			'">' +
			JD.esc(value) +
			"</span></div>"
		);
	}

	/** `Aug 17`, routed through the day key so the record and the axes agree by construction. */
	function shortDay(atMs, timeZone) {
		return JD.dayLabel(JD.dayKey(atMs, timeZone));
	}

	/** A day-bucketed chart plus the two endpoint labels — the shape both charts share. */
	function barsHtml(days, values, label, fmt) {
		if (days.length === 0) return "";
		return (
			JD.dayBars(days, values, { label: label, fmt: fmt }) +
			'<div class="sk-axis"><span>' +
			JD.esc(JD.dayLabel(days[0])) +
			"</span>" +
			/* One label on a single-day window: the same day at both ends would read as a
			   range that is not one. */
			(days.length > 1 ? "<span>" + JD.esc(JD.dayLabel(days[days.length - 1])) + "</span>" : "") +
			"</div>"
		);
	}

	/**
	 * Sessions per day over the window — "was it reached for more or less".
	 *
	 * Every day of the window is drawn, empty ones included, for the reason the band
	 * walks the window: bars are laid out by index, so dropping a quiet day compresses
	 * the axis and makes a fortnight's gap look like a busy stretch.
	 */
	function cadenceHtml(detail) {
		var points = detail.daySeries || [];
		if (points.length === 0) return '<div class="sk-note">No daily record survives for this server.</div>';
		return barsHtml(
			points.map((point) => point.date),
			points.map((point) => point.sessions),
			"Sessions per day",
			(n) => n + (n === 1 ? " session" : " sessions"),
		);
	}

	/**
	 * Calls per session in arrival order — "how hard was each session working it".
	 *
	 * ONE BAR PER SESSION on an INDEX axis, not a time axis: `session_tool_use` stores one
	 * instant per (session, tool) and it is the last call, so an even-time chart would
	 * misplace bars by up to the session's own span. The two endpoint labels below carry
	 * the dates of the first and last session, so a reader can still see the span the
	 * bars cover without the chart claiming a spacing it does not have.
	 */
	function volumeHtml(detail, timeZone) {
		var sessions = detail.sessionSeries || [];
		if (sessions.length === 0) return '<div class="sk-note">No per-session record survives for this server.</div>';
		var hidden = Math.max(0, (detail.sessions || 0) - sessions.length);
		var max = 0;
		sessions.forEach((point) => {
			if (point.calls > max) max = point.calls;
		});
		var BAR_W = 0.58;
		var svg =
			'<svg class="sk-daybars" viewBox="0 0 ' +
			Math.max(1, sessions.length) +
			' 100" preserveAspectRatio="none" role="img" aria-label="Calls per session, in time order">';
		sessions.forEach((point, index) => {
			/* Floors at 20 so a single-call session is still a visible bar rather than a
			   hairline; identical rule to `JD.dayBars`, kept here rather than shared
			   because the X axis is session index, not a day key. */
			var height = point.calls > 0 ? Math.max(20, max > 0 ? (point.calls / max) * 100 : 100) : 6;
			svg +=
				'<rect x="' +
				(index + (1 - BAR_W) / 2).toFixed(3) +
				'" y="' +
				(100 - height).toFixed(2) +
				'" width="' +
				BAR_W +
				'" height="' +
				height.toFixed(2) +
				'" fill="var(--accent)"><title>' +
				JD.esc(shortDay(point.atMs, timeZone) + " · " + point.calls + (point.calls === 1 ? " call" : " calls")) +
				"</title></rect>";
		});
		svg += "</svg>";
		return (
			svg +
			'<div class="sk-axis"><span>' +
			JD.esc(shortDay(sessions[0].atMs, timeZone)) +
			"</span>" +
			(sessions.length > 1
				? "<span>" + JD.esc(shortDay(sessions[sessions.length - 1].atMs, timeZone)) + "</span>"
				: "") +
			"</div>" +
			(hidden > 0
				? '<div class="sk-note">Most recent ' +
					sessions.length +
					" of " +
					detail.sessions +
					" sessions shown; totals and daily cadence remain exact.</div>"
				: "")
		);
	}

	/**
	 * The server's tools, busiest first.
	 *
	 * THE SESSION COUNTS DO NOT ADD UP TO THE PANE'S `sessions` FIGURE, and that is
	 * correct rather than a rounding artefact: a session that called three of this
	 * server's tools counts in all three rows. The column is read row by row, so it is
	 * printed without a total — see `McpServerToolRow.sessions`.
	 */
	function toolsHtml(detail) {
		var tools = detail.tools || [];
		if (tools.length === 0) return '<div class="sk-note">No tool name was recorded for this server.</div>';
		var rows = tools
			.map(
				(tool) =>
					'<div class="mcp-tool"><b class="mono" title="' +
					JD.esc(tool.name) +
					'">' +
					JD.esc(tool.name) +
					"</b><span>" +
					tool.calls +
					'</span><span class="mcp-tool-sess">' +
					tool.sessions +
					(tool.sessions === 1 ? " session" : " sessions") +
					"</span></div>",
			)
			.join("");
		var hidden = (detail.toolCount || tools.length) - tools.length;
		/* The cap changes what is drawn, never what is claimed — the same rule the
		   Skills pane's capped agent list and outcome strip follow. `toolCount` is the
		   server's real total, so this says what is missing rather than implying the
		   list is complete. */
		var note =
			hidden > 0
				? '<div class="sk-note">' +
					tools.length +
					" busiest of " +
					(detail.toolCount || tools.length) +
					" tools called; the figures above stay exact.</div>"
				: "";
		return '<div class="mcp-tools">' + rows + "</div>" + note;
	}

	/**
	 * Everything that is a fact rather than a trend.
	 *
	 * `First seen` IS A FLOOR AND SAYS SO. `session_tool_use` stores one instant per
	 * (session, tool) and it is the LAST call, so the earliest such instant is the last
	 * call of the earliest session — at or after the true first call. Measured, the two
	 * agree at day resolution for 140 of 141 (session, server) pairs, which is why a
	 * DATE is printed and the qualifier rides in the label's tooltip rather than
	 * replacing the figure. `Payloads` states an absence, in the row grammar, because a
	 * reader looking for a call log needs to be told there is none.
	 */
	function recordHtml(detail, timeZone) {
		var rows = "";
		if (detail.firstCallAtMs != null)
			rows += line(
				"First seen",
				shortDay(detail.firstCallAtMs, timeZone),
				null,
				"Lower bound: only the last call per session and tool is recorded.",
			);
		if (detail.lastCallAtMs != null) rows += line("Last seen", shortDay(detail.lastCallAtMs, timeZone));
		if ((detail.repos || []).length > 0) rows += line("Ran in", detail.repos.join(", "));
		rows += line("Payloads", "not recorded");
		return '<div class="sk-facts">' + rows + "</div>";
	}

	/**
	 * Rows of the agent split shown in full before the rest are rolled into one line —
	 * `skills.js`'s cap, for its reason: this is the pane's one list whose length is a
	 * property of the machine rather than of the record's own ceilings.
	 */
	var AGENT_ROWS_SHOWN = 5;

	/** Per-agent calls, most first. The swatch is the agent's colour, page-wide. */
	function agentsHtml(detail) {
		var agents = (detail.agents || []).slice().sort((a, b) => b.calls - a.calls);
		if (agents.length === 0) return '<div class="sk-note">No agent recorded against this server.</div>';
		var html = agents
			.slice(0, AGENT_ROWS_SHOWN)
			.map((agent) =>
				line(
					agent.source,
					agent.calls + (agent.calls === 1 ? " call" : " calls"),
					JD.seriesColor(JD.sourceIndex(agent.source)),
				),
			)
			.join("");
		var rest = agents.slice(AGENT_ROWS_SHOWN);
		if (rest.length === 0) return html;
		/* The rolled-up line carries its own CALL TOTAL, not just a count of agents: the
		   section is a split of the calls, so "3 further agents" alone would drop calls
		   out of a total the four figures above still count in full. */
		var restCalls = rest.reduce((sum, agent) => sum + agent.calls, 0);
		return (
			html +
			'<div class="sk-note">' +
			rest.length +
			(rest.length === 1 ? " further agent called it, " : " further agents called it, ") +
			restCalls +
			(restCalls === 1 ? " call" : " calls") +
			" between them.</div>"
		);
	}

	// ── Interaction ─────────────────────────────────────────────────────────────

	/**
	 * One binder for the list rows AND the band's key: both carry `data-mcp`, and a click
	 * on either toggles, so the empty pane stays reachable once something has been opened.
	 */
	function bindSelection(app, model) {
		Array.prototype.forEach.call(app.querySelectorAll("[data-mcp]"), (element) => {
			element.onclick = () => {
				var name = element.getAttribute("data-mcp");
				var focusedLegendName =
					document.activeElement === element &&
					element.classList &&
					element.classList.contains("sk-legend")
						? name
						: null;
				var next = state.paneName === name ? null : name;
				/* The reader has now answered "which server" themselves, so the default pick
				   must not run again — otherwise the click that closes the pane re-opens the
				   top row on the very next render. */
				defaultAnswered = true;
				setSelectedServer(next);
				state.paneName = next;
				state.pane = null;
				state.paneError = null;
				/* Targeted repaint (band + list highlights + pane) plus the detail refetch —
				   NOT `renderMcps(model)`, which would tear down the whole `.browser-page`
				   section on every click (the visible flicker readers reported, plus the
				   loss of the nav column's scroll position). Same rewrite as `skills.js`. */
				updateSelection(app, model, focusedLegendName);
				fetchDetail(app, model);
			};
		});
	}

	/**
	 * Wires the clamped paragraph. It toggles the attribute and does NOT re-render: a
	 * repaint would cost the rows their scroll offset for a result CSS reaches from
	 * `aria-expanded` alone. Space is prevented (it would scroll the column the reader is
	 * reading), Enter is not.
	 */
	function bindProse(app) {
		Array.prototype.forEach.call(app.querySelectorAll(".sk-clamp"), (element) => {
			var toggle = () => {
				openProse["sk-basis"] = openProse["sk-basis"] !== true;
				element.setAttribute("aria-expanded", openProse["sk-basis"] ? "true" : "false");
				syncBottomCardHeights(app);
			};
			element.onclick = toggle;
			element.onkeydown = (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				toggle();
			};
		});
	}

	JD.renderMcps = renderMcps;
})(window.JD);
