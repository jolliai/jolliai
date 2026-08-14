window.JD = window.JD || {};

((JD) => {
	var RANGE_SUB = { today: "Today", week: "Last 7 days", "2w": "Last 14 days", month: "Last 30 days", "3m": "Last 90 days" };

	/* Prose name for the window a model was built over. A custom range has no
	   name, so it states its own bounds — which are the resolved ones, so a
	   clamped request reads as the window it actually got. */
	function rangeSub(stats) {
		return RANGE_SUB[stats.range] || stats.rangeFrom + " → " + stats.rangeTo;
	}

	/* Totals per series key, for the ranked-bar axes. */
	function rankRows(stats) {
		/* Prototype-less, same reason as memoryActivityCard's grouping: series keys
		   are user-controlled strings (branch, ticket, model, repo). A branch named
		   `constructor` makes `totals[key] || {…}` hand back an inherited function,
		   so the row is never created — `+=` writes NaN onto Object.prototype and
		   Object.keys() never lists it, silently dropping that series from the chart. */
		var totals = Object.create(null);
		stats.series.forEach((point) => {
			stats.seriesKeys.forEach((key) => {
				totals[key] = totals[key] || { key: key, tokens: 0, cost: 0 };
				/* bySeries comes off JSON.parse, so it has a prototype — read it the
				   same defensive way rather than trusting `|| 0` to catch a function. */
				var value = point.bySeries[key];
				totals[key].tokens += typeof value === "number" ? value : 0;
			});
		});
		// Cost is only known per day, not per key, so spread it by token share —
		// stated in the axis note rather than presented as an exact per-key cost.
		var grandTokens = 0;
		var grandCost = 0;
		stats.series.forEach((p) => {
			grandTokens += p.tokens;
			grandCost += p.estCostUsd;
		});
		var rows = Object.keys(totals).map((key) => totals[key]);
		rows.forEach((row) => {
			row.cost = grandTokens > 0 ? (grandCost * row.tokens) / grandTokens : 0;
		});
		return rows.sort((a, b) => b.tokens - a.tokens);
	}

	/* Spend is the cost-only companion to Tokens. It never reuses the token
	   chart: each day allocates its measured total cost across working models by
	   that day's token share, which is explicitly an estimate. */
	function costCard(model) {
		var esc = JD.esc;
		var stats = model.stats;
		var sub =
			esc(rangeSub(stats)) +
			" · estimated from local transcripts" +
			(stats.pricesAsOf ? ' · prices as of <span class="mono">' + esc(stats.pricesAsOf) + "</span>" : "");
		var costKpi = stats.kpis.find((k) => k.key === "cost");
		var ranked = rankRows(stats);
		var costSeries = stats.series.map((point) => {
			var tokenTotal = stats.seriesKeys.reduce((sum, key) => sum + (point.bySeries[key] || 0), 0);
			/* Prototype-less: keys are user-controlled series names — see rankRows. */
			var bySeries = Object.create(null);
			stats.seriesKeys.forEach((key) => {
				bySeries[key] = tokenTotal > 0 ? (point.estCostUsd * (point.bySeries[key] || 0)) / tokenTotal : 0;
			});
			return { date: point.date, bySeries: bySeries };
		});

		/* Dollar in a circle — Lucide `circle-dollar-sign`. It was an axes-plus-
		   trend-line glyph, which is the same "it's a chart" statement Tokens'
		   bar chart already makes one card up; the only thing that distinguishes
		   these two widgets is that this one is denominated in money, so that is
		   what the icon has to say. */
		var html =
			'<section class="card span12" aria-label="Spend"><div class="card-head">' +
			widgetIcon(
				"--s4",
				'<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/>' +
					'<path d="M12 18V6"/>',
			) +
			'<div style="flex:1 1 300px;min-width:0">' +
			"<h2>Spend</h2>" +
			'<div class="sub" style="margin-top:5px">' +
			sub +
			"</div></div>" +
			'<div class="spacer"></div>' +
			'<div style="text-align:right"><div class="num" style="font-size:18px;font-weight:650;color:var(--good-text)">' +
			(costKpi ? costKpi.value : "$0.00") +
			'</div><div class="sub">estimated spend<br>this window</div></div>' +
			"</div>";

		html += '<div class="chart-box" style="margin-top:12px">';
		if (stats.seriesKeys.length === 0) {
			html += '<div class="empty-note">No estimated spend data yet.</div>';
		} else {
			html += '<div class="legend">';
			stats.seriesKeys.forEach((key, index) => {
				var row = ranked.find((r) => r.key === key);
				html +=
					'<span><i style="background:' +
					JD.seriesColor(index) +
					'"></i><span class="mono lg-key" title="' +
					esc(key) +
					'">' +
					esc(key) +
					'</span> <b class="num">' +
					(row ? JD.fmtUsd(row.cost) : "") +
					"</b></span>";
			});
			html += "</div>" + JD.stackedBars(costSeries, stats.seriesKeys, "estimated spend by model");
		}
		html += "</div>";

		/* Comparison row — vs the prior window (server-computed, self-trend only),
		   the largest key this window, and the single busiest day by cost. */
		if (stats.seriesKeys.length > 0) {
			var top = ranked[0];
			var totalCost = ranked.reduce((sum, r) => sum + r.cost, 0);
			var busiest = stats.series.reduce(
				(best, p) => (p.estCostUsd > best.v ? { date: p.date, v: p.estCostUsd } : best),
				{ date: undefined, v: 0 },
			);
			html += '<div class="cmpline" style="display:flex;gap:20px;flex-wrap:wrap;margin-top:10px;font-size:11.5px;color:var(--muted)">';
			html +=
				'<span>vs prior period<b style="display:block;font-size:12.5px;color:var(--ink);font-weight:650">' +
				(stats.costTrendPct === undefined
					? "no prior window to compare"
					: (stats.costTrendPct < 0 ? "↓ " : "↑ ") + Math.abs(stats.costTrendPct) + "%") +
				"</b></span>";
			if (top && totalCost > 0) {
				html +=
					"<span>largest model" +
					'<b style="display:block;font-size:12.5px;color:var(--ink);font-weight:650">' +
					esc(top.key) +
					", " +
					Math.round((top.cost / totalCost) * 100) +
					"%</b></span>";
			}
			if (busiest.v > 0) {
				html +=
					'<span>busiest day<b style="display:block;font-size:12.5px;color:var(--ink);font-weight:650">' +
					esc(busiest.date) +
					" · " +
					JD.fmtUsd(busiest.v) +
					"</b></span>";
			}
			html += "</div>";
		}

		return (
			html +
			'<div class="w-foot"><span class="w-chip">estimated, not a bill</span>' +
			'<span class="w-measure">ⓘ model splits are apportioned by token share</span></div></section>'
		);
	}

	/* Time view's group header: "Today · Jul 31" / "Yesterday · Jul 30" for the
	   two nearest calendar days (relative to when the model was generated, in
	   the viewer's zone), the bare "Jul 29" day string beyond that — matching
	   the mockup's reverse-chronological grouping. */
	function timeGroupLabel(ms, model) {
		var dayFmt = { month: "short", day: "numeric", timeZone: model.timeZone };
		var day = new Date(ms).toLocaleDateString("en-US", dayFmt);
		var today = new Date(model.generatedAtMs).toLocaleDateString("en-US", dayFmt);
		if (day === today) return "Today · " + day;
		var yesterday = new Date(model.generatedAtMs - 86400000).toLocaleDateString("en-US", dayFmt);
		if (day === yesterday) return "Yesterday · " + day;
		return day;
	}

	/* The deep link into one memory's detail pane. Shared by the Memory Activity
	   row's "Open memory →" and by the Decisions card's title, so a decision and
	   the row it came from lead to the same place.

	   `detailRepo` names the memory's owning repo without scoping the page it
	   lands on — see wireTree in memories.js. Whatever scope THIS page carries
	   rides along through JD.query, so a repo-filtered dashboard still opens a
	   repo-filtered tree. */
	function memoryHref(model, commitHash, repoIdentity) {
		return "/memories" + JD.withParams(JD.query(model, {}), { hash: commitHash, detailRepo: repoIdentity });
	}

	/* Memory Activity: Branch answers "what landed on this line of work?" while
	   Time answers "what did I capture lately?". Both views use the same memory
	   cards already loaded for the feed, so toggling never causes a fetch. */
	function memoryActivityCard(model) {
		var cards = model.stats.memoryCards || [];
		/* No fallback branch here. Its only caller is feedCard, gated on exactly
		   `tier !== "installed" && cards.length > 0` — so a guard for the negation
		   of that would be unreachable. */
		var esc = JD.esc;
		var view = JD.memoryActivityView || "time";
		var groups = [];
		/* Prototype-less: keys are branch names, and a branch called `constructor`
		   (or `__proto__`) makes a plain object hand back an inherited value that
		   the `.cards.push` below throws on — taking the whole page blank. */
		var byKey = Object.create(null);
		cards.forEach((card) => {
			var key = view === "branch" ? card.branch || "No branch" : card.committedAtMs;
			if (view === "time") key = timeGroupLabel(card.committedAtMs, model);
			if (!byKey[key]) { byKey[key] = { label: key, cards: [] }; groups.push(byKey[key]); }
			byKey[key].cards.push(card);
		});
		var openHref = (card) => memoryHref(model, card.commitHash, card.repoIdentity);
		var row = (card) => {
			var meta = [];
			if (card.category) meta.push('<span class="mem-activity-category">' + esc(card.category) + "</span>");
			if (card.turns != null) meta.push('<span class="tag metric num">' + esc(card.turns) + " turns</span>");
			/* Counted the way the "N decisions" figure above this list counts (one
			   per topic that recorded any), not per decision bullet — see
			   MemoryCard.decisionCount. Absent rather than "0 decisions": every
			   other item here is conditional, and a row of zeros is noise. */
			if (card.decisionCount)
				meta.push(
					'<span class="tag metric num">' +
						esc(card.decisionCount) +
						(card.decisionCount === 1 ? " decision</span>" : " decisions</span>"),
				);
			if (card.branch && view === "time") meta.push('<span class="tag mono">' + esc(card.branch) + "</span>");
			/* The repo tag earns its space only when the page is showing more than
			   one: under a single-repo scope every row would carry the same name the
			   topbar picker already states. `!== 1`, not `=== 0` — a two-repo
			   selection needs the tag as much as an unscoped page does. */
			if (JD.scopeIdentities(model).length !== 1) meta.push('<span class="tag">' + esc(card.repoName) + "</span>");
			return (
				'<article class="mem-activity-row" style="--memory-color:' +
				(catColor(card.category || "feature")) +
				'"><div class="mem-activity-copy"><div class="mem-activity-title">' +
				esc(card.title) +
				'</div><div class="mem-activity-meta">' +
				meta.join("") +
				"</div></div><div class=\"mem-activity-action\"><time>" +
				esc(cardWhen(card.committedAtMs, model.timeZone)) +
				'</time><a href="' +
				openHref(card) +
				'" target="_blank" rel="noopener">Open memory →</a></div></article>'
			);
		};
		var body = groups.map((group) => '<section class="mem-activity-group"><h3>' + esc(group.label) + "</h3>" + group.cards.map(row).join("") + "</section>").join("");
		return (
			'<section class="card span12 mem-activity" aria-label="Memory Activity"><div class="card-head">' +
			widgetIcon("--s4", '<path d="M7 3h10v18H7z"/><path d="M9 7h6M9 11h6M9 15h4"/>') +
			'<div><h2>Memory Activity</h2><div class="sub">' +
			cards.length +
			" memories in this window</div></div><div class=\"spacer\"></div>" +
			'<div class="seg seg-sm" role="group" aria-label="Memory Activity view"><button type="button" data-memory-activity-view="branch" aria-pressed="' +
			String(view === "branch") +
			'">Branch</button><button type="button" data-memory-activity-view="time" aria-pressed="' +
			String(view === "time") +
			'">Time</button></div></div>' +
			memoryCoverageStats(model) +
			'<div class="mem-activity-list">' +
			body +
			"</div></section>"
		);
	}

	/* The captured/decision counts atop Memory Activity. `totalCommits` is
	   present at every tier, but this card never renders below the memory tier
	   (see the early return above), so `memoriesCreated`/`decisionsCaptured`
	   are never actually undefined here — the null checks are for a stale or
	   hand-built model, not a real code path.

	   A third figure used to sit between these two: `totalCommits - memoriesCreated`,
	   rendered in the warning colour as "N gaps". It was removed — the deficit it
	   flagged is not something this page offers any way to act on, and the "of N"
	   denominator already states the coverage. Both of its inputs are still on the
	   model, so this is a render decision and nothing else. */
	function memoryCoverageStats(model) {
		var captured = model.stats.memoriesCreated;
		var total = model.stats.totalCommits;
		var decisionsCount = model.stats.decisionsCaptured;
		if (captured == null || total == null) return "";
		return (
			'<div class="mem-activity-stats">' +
			'<div class="mas-item"><b class="num">' +
			captured +
			'</b><span>of ' +
			total +
			" captured</span></div>" +
			(decisionsCount != null
				? '<div class="mas-item"><b class="num">' +
					decisionsCount +
					"</b><span>" +
					(decisionsCount === 1 ? "decision" : "decisions") +
					"</span></div>"
				: "") +
			"</div>"
		);
	}

	/* Icon badge shared by the newer widget headers (Decisions, Skills, MCP
	   servers) — jolli-design's own cards each tint their icon to that card's
	   theme colour rather than reusing one accent everywhere; confirmed against
	   a real screenshot of its Dashboard route, not guessed from tokens alone. */
	function widgetIcon(colorVar, pathD) {
		return (
			'<span class="w-icon" style="background:color-mix(in srgb, var(' +
			colorVar +
			') 16%, var(--surface));color:var(' +
			colorVar +
			')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
			'stroke-linecap="round" stroke-linejoin="round">' +
			pathD +
			"</svg></span>"
		);
	}

	/* Card-head for the three widgets in the equal-third band (Skills / MCPs /
	   Tokens). Inert on purpose: the expand-to-flyout interaction these three
	   used to carry was removed, so the head must not look clickable — no
	   chevron, no button element.

	   `sub` renders under the title; `hint` renders as a `title=` tooltip on it.
	   All three cards in this band pass a hint and no sub today, so the band's
	   heads are one line each. They stay SEPARATE arguments rather than collapsing
	   to "the sub, but hovered", because they are not the same kind of text and a
	   card that wants both is one call away: a hint EXPLAINS the card (read once,
	   noise thereafter), while a sub QUALIFIES its numbers. Tokens is the case
	   that proves the distinction is real — it carried `Last 30 days` as a visible
	   sub until the window moved to being read off the topbar range control alone.

	   A native `title` rather than the page's own `JD.showTip`: that helper is
	   positioned at the pointer for chart readouts and needs listeners rebound on
	   every 30 s refresh tick, and this needs no such thing. `esc` is what makes
	   it safe in an attribute — it escapes both quote characters. */
	function widgetHead(icon, title, sub, hint) {
		return (
			'<div class="card-head">' +
			icon +
			"<div><h2" +
			(hint ? ' class="has-hint" title="' + hintAttr(hint) + '"' : "") +
			">" +
			title +
			"</h2>" +
			(sub ? '<div class="sub">' + sub + "</div>" : "") +
			"</div></div>"
		);
	}

	/** Roughly where a hint tooltip wraps. Characters, not pixels — see below. */
	var HINT_WRAP_COLS = 58;

	/* A `title=` value, hard-wrapped.
	 *
	 * A native tooltip does NOT wrap on its own: a two-sentence hint renders as
	 * one line that runs past the card, past the next card, and off the viewport.
	 * It DOES honour newlines, so the wrapping has to be in the string. `&#10;`
	 * rather than a literal newline because this string is inlined into the served
	 * page — a character reference is inert to anything that reformats the markup
	 * on the way, and reads identically to the browser.
	 *
	 * Wrapping by character count is deliberately crude: the tooltip is drawn by
	 * the OS in a font this page does not choose or measure, so a pixel-accurate
	 * wrap is not available at any price. Breaking only between words is what
	 * keeps the crude version acceptable — a word longer than the column takes its
	 * own line rather than being cut. Escape per line, then join, so `esc` never
	 * sees (and cannot mangle) the separators. */
	function hintAttr(text) {
		var lines = [];
		var line = "";
		String(text)
			.split(" ")
			.forEach((word) => {
				if (line && (line + " " + word).length > HINT_WRAP_COLS) {
					lines.push(line);
					line = word;
					return;
				}
				line = line ? line + " " + word : word;
			});
		if (line) lines.push(line);
		return lines.map((each) => JD.esc(each)).join("&#10;");
	}

	/* Decisions (span12) — the corpus of decisions itself: kept count, a
	   cumulative step chart, and the latest one as a single TITLE line.
	   Distinct from the KPI sub-line (gone with the KPI strip) and from the
	   feed's per-commit `decision` line — this is the standalone widget those
	   always implied but never had. Carries no "recalled" figure — see
	   DecisionsCard's doc comment in DashboardModel.ts.

	   Full width because it is now alone on its row: it was a span6 paired with
	   the Recall card, and removing that one (JOLLI-2193) left six empty columns
	   beside it. The step chart stretches to fill them, which is also the only
	   part of this card that gains anything from the width. */
	function decisionsCard(model) {
		var esc = JD.esc;
		var decisions = model.stats.decisions;
		var icon = widgetIcon(
			"--s1",
			'<path d="M9 18h6M10 22h4M12 2a6 6 0 0 0-4 10.4c.6.5 1 1.3 1 2.1V16h6v-1.5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 2Z"/>',
		);
		var head =
			'<section class="card span12" aria-label="Decisions"><div class="card-head">' + icon + "<div><h2>Decisions</h2>" +
			/* "…and whether it came back" until JOLLI-2193: the second half was the
			   Recall card beside it, and the payload no longer carries a reuse
			   signal of any kind, so the promise had nothing behind it. */
			'<div class="sub">What Jolli decided to keep</div></div>';

		if (!decisions) {
			return (
				head +
				'<div class="spacer"></div></div>' +
				'<div class="locked-panel"><p><b>Decisions need a summarized commit.</b></p>' +
				"<p class=\"why\">Each decision is mined from a commit's memory — enable Jolli Memory to start " +
				"recording them.</p>" +
				'<button type="button" class="cta ghost" disabled>Enable Jolli Memory</button></div></section>'
			);
		}

		var html =
			head +
			'<div class="hdr-stat"><b class="num">' +
			decisions.keptCount +
			' kept</b><span>decisions · ' +
			esc(rangeSub(model.stats)) +
			"</span></div>" +
			'<div class="spacer"></div></div>';

		/* Cumulative step chart over `perDay` — an empty window still draws a
		   flat baseline rather than an empty box. */
		var w = 300;
		var h = 60;
		var total = decisions.perDay.reduce((sum, d) => sum + d.count, 0) || 1;
		var cum = 0;
		var points = [];
		decisions.perDay.forEach((day, i) => {
			var x = decisions.perDay.length > 1 ? (i / (decisions.perDay.length - 1)) * w : 0;
			points.push(x + "," + (h - 4 - (cum / total) * (h - 8)));
			cum += day.count;
			points.push(x + "," + (h - 4 - (cum / total) * (h - 8)));
		});
		var poly = points.join(" ");
		html +=
			'<div class="stepchart"><svg viewBox="0 0 ' +
			w +
			" " +
			h +
			'" preserveAspectRatio="none"><polyline points="' +
			poly +
			'" fill="none" stroke="var(--s1)" stroke-width="2"/>' +
			'<polygon points="' +
			poly +
			" " +
			w +
			"," +
			h +
			" 0," +
			h +
			'" fill="color-mix(in srgb, var(--s1) 12%, transparent)"/></svg></div>';

		/* Title only (JOLLI-2192), and it opens that memory (JOLLI-2197) — the same
		   deep link the memory's own row carries, so the decision and the row lead
		   to one place. An in-page scroll to the row was tried first and reads as a
		   no-op: the newest decision's commit is usually the newest memory, so the
		   scroll lands on the row already at the top of the list.

		   Skipped entirely when the title came back empty, which needs a payload
		   carrying neither a topic title nor a parseable decision line. */
		if (decisions.latest && decisions.latest.title) {
			html +=
				'<div class="dec-quote"><span class="qlab">Latest · ' +
				esc(decisions.latest.repoName) +
				'</span><a class="dec-jump" href="' +
				memoryHref(model, decisions.latest.commitHash, decisions.latest.repoIdentity) +
				'" target="_blank" rel="noopener"><strong>' +
				esc(decisions.latest.title) +
				"</strong></a></div>";
		}

		/* The footer carried a "kept, not merged" chip beside the repo count. It
		   was removed: it answered a question about how decisions are STORED that
		   nothing else on the page raises, so under the latest-decision quote it
		   read as a status on that decision rather than a note about the corpus.
		   The repo-count measure stays — it qualifies the numbers above it. */
		return (
			html +
			'<div class="w-foot"><span class="w-measure" aria-hidden="false">ⓘ across <b>' +
			decisions.repoCount +
			(decisions.repoCount === 1 ? " repo</b>" : " repos</b>") +
			" in this window</span></div></section>"
		);
	}

	/* Page size for every ranked tool list — mirrors TOOL_ROWS_LIMIT in
	   DashboardModel.ts. How many rows exist and whether another page can be fetched
	   are still the server's `*Total` counts, never this number.

	   It has TWO readers now, and only the first is cosmetic. The scroll cap measures
	   this many rendered rows, so a drift there costs a slightly wrong cap height and
	   nothing else. But `verifyToolList` also slices a collapsed list back to it —
	   the width it claims is "exactly what a freshly opened card shows" — and that
	   card's rows came from the server at TOOL_ROWS_LIMIT. Drift makes the two
	   disagree: the collapse says "start again from the first page" while showing a
	   different first page. Keep them equal. */
	var TOOL_PAGE_SIZE = 8;

	/* The three pageable ranked lists, and everything that differs between them:
	   which array on `toolUsage` holds the loaded rows, which count they page
	   against, what identifies a row (for the append dedupe) and the noun the
	   footer prints. Table-driven because the Skills and MCPs cards would
	   otherwise each spell the same four decisions out, and only one of them would
	   get fixed. */
	var TOOL_LISTS = {
		skill: { rows: "skills", total: "skillsTotal", key: (r) => r.name, noun: "skills", card: "skills" },
		server: { rows: "servers", total: "serversTotal", key: (r) => r.server, noun: "servers", card: "mcps" },
		tool: { rows: "mcpTools", total: "mcpToolsTotal", key: (r) => r.name, noun: "tools", card: "mcps" },
	};

	/* Per-list paging state — in flight, failed, which row index a click just grew
	   the list from, and where a carried-over list was scrolled to.

	   Kept ON `toolUsage`, never on JD: the 30 s `/api/model` poll replaces that
	   object, and every one of those facts is about the payload beside it. A
	   module-level flag would survive the swap and either strand the new payload at
	   page 1 or scroll it to a row index the new list does not have.

	   What DOES survive a poll is decided per list, once, by
	   `carryForwardToolLists` — which writes a deliberately minimal entry rather
	   than moving this object across. */
	function toolPaging(usage, list) {
		usage.paging = usage.paging || {};
		usage.paging[list] = usage.paging[list] || {};
		return usage.paging[list];
	}

	/* "Showing 8 of 15 servers" plus the button that fetches the next page.

	   Deliberately NOT `JD.moreToggle`, for the same reason the Memories tree's
	   footer is not: that one expands rows the server already sent, so it can
	   promise "Show all N" and offer "Show fewer". This costs a round trip per
	   click, so it says only what one click will do.

	   Absent entirely on a list that has never paged and never could — a footer
	   that can only ever read "N of N" is noise on the far more common
	   small-corpus page. But once a click HAS grown the list it stays, count only,
	   because the card's height is part of the layout: the three cards share one
	   equal-third band, and dropping a 40px row the moment the last page lands
	   made the card visibly shrink under the reader on the one click that was
	   supposed to change nothing but the rows (measured in a real browser). It is
	   also the only place the reader is told they have reached the end. */
	function toolMoreRow(usage, list) {
		var spec = TOOL_LISTS[list];
		var shown = (usage[spec.rows] || []).length;
		var total = usage[spec.total] || 0;
		var state = toolPaging(usage, list);
		if (!shown) return "";
		var count =
			'<span class="more-count">Showing ' +
			shown +
			" of " +
			total +
			" " +
			spec.noun +
			/* The failure belongs next to the count it stopped from growing, not in a
			   toast: this button still being here IS the reason it matters. */
			(state.error && !state.loading ? " — could not load more" : "") +
			"</span>";
		if (shown >= total) return state.grown ? '<div class="more-row is-done">' + count + "</div>" : "";
		var label = state.loading ? "Loading…" : state.error ? "Try again" : "Show more";
		return (
			'<div class="more-row">' +
			count +
			'<button type="button" class="cta ghost sm" data-toolmore="' +
			JD.esc(list) +
			'"' +
			(state.loading ? " disabled" : "") +
			">" +
			label +
			"</button></div>"
		);
	}

	/* Ranked rows shared by Skills and MCP servers: label (+ optional kind),
	   value, a bare colour bar underneath sized against the top row. `list` names
	   which pageable list this is, so `capToolLists` can find the <ul> again after
	   the render. */
	function rankedList(rows, colorVar, valueOf, labelOf, kindOf, unit, list) {
		if (rows.length === 0) return "";
		// The real maximum, not `rows[0]` — that is only the biggest value when the
		// list's rank order happens to be the metric the bars measure, and Skills
		// deliberately ranks by adoption while printing runs (see `byAdoption` in
		// DashboardQuery). Row 0 as the denominator therefore produced widths past
		// 100%, which `.rl-bar`'s `overflow: hidden` clamps rather than reveals:
		// measured on the MCPs card at 68 calls in row 0, codegraph's 149 asked for
		// 219% and dbhub's 76 for 112%, so three distinct volumes all painted as one
		// full bar. A too-wide bar is the failure that hides itself; a short bar in
		// row 0 is the honest signal that rank and volume disagree.
		var top = rows.reduce((max, row) => Math.max(max, valueOf(row)), 0) || 1;
		var html = '<ul class="ranklist"' + (list ? ' data-toollist="' + JD.esc(list) + '"' : "") + ">";
		rows.forEach((row) => {
			var value = valueOf(row);
			// The name truncates with an ellipsis (see .rl-name), so the full text
			// has to survive somewhere the reader can get at it.
			var label = labelOf(row);
			/* `{ text, title }`, not a bare string: the meta slot folds a long agent
			   list into `+N` and has to carry the full one somewhere reachable.

			   Tested on `.text`, not on the object: `withAgents` returns one
			   unconditionally, so a row with nothing to put in the slot would otherwise
			   get an EMPTY `.rl-kind` — and an empty flex item is not free, it spends
			   one of `.rl-top`'s 8px gaps and takes those pixels off the only thing
			   that gives (the name, which truncates). A bare string was falsy here and
			   so emitted no slot at all; this keeps that. */
			var kind = kindOf ? kindOf(row) : null;
			html +=
				'<li><div class="rl-top"><span class="rl-name mono" title="' +
				JD.esc(label) +
				'">' +
				JD.esc(label) +
				"</span>" +
				(kind && kind.text
					? '<span class="rl-kind"' +
						(kind.title ? ' title="' + JD.esc(kind.title) + '"' : "") +
						">" +
						JD.esc(kind.text) +
						"</span>"
					: "") +
				'<span class="rl-val num">' +
				value +
				" " +
				unit +
				(value === 1 ? "" : "s") +
				"</span></div>" +
				'<div class="rl-bar"><i style="width:' +
				Math.round((value / top) * 100) +
				"%;background:var(" +
				colorVar +
				')"></i></div></li>';
		});
		return html + "</ul>";
	}

	/* Which agents are behind one ranked row — `claude`, or `codex · claude` when
	   more than one contributed. The names are `sessions.source` verbatim, the
	   same tag the Tokens chart's Agent axis prints, so the two panels can be
	   read against each other without a mapping in the reader's head.

	   Counts are deliberately left OFF the per-row tag: the row already prints
	   its own total beside the name, and a second set of numbers at that size
	   reads as noise. This is now the ONLY per-agent signal on either card — the
	   `by agent · 12 claude` header line that carried the same split with volume
	   was removed, so nothing states a whole-window per-agent total any more. */
	/**
	 * How many agent names ride on a row before the rest fold into `+N`.
	 *
	 * `.rl-kind` is `flex: none` — it neither shrinks nor truncates, and only
	 * `.rl-name` gives. So an unbounded list of names does not ellipsis, it pushes:
	 * measured in a real browser with eight agents on one row, the tool NAME was
	 * squeezed to 0px wide (gone, with no ellipsis to show for it) and the row still
	 * overflowed its card, arming a horizontal scrollbar on both the list and the
	 * page. Two names plus a count is a bounded width that leaves the name room.
	 *
	 * Not solved with `min-width: 0` + ellipsis on `.rl-kind` instead: that makes
	 * the name and the agents compete for the same pixels, so a busy row loses both
	 * halves at once — every truncating label on this page keeps exactly one thing
	 * that gives, and here that is the name.
	 */
	var ROW_AGENT_LIMIT = 2;

	function agentTag(agents) {
		if (!agents || agents.length === 0) return "";
		var names = agents.map((a) => a.source);
		if (names.length <= ROW_AGENT_LIMIT) return names.join(" · ");
		return names.slice(0, ROW_AGENT_LIMIT).join(" · ") + " +" + (names.length - ROW_AGENT_LIMIT);
	}

	/** Every agent on the row, for the `title` the folded tag hides them behind. */
	function agentTagFull(agents) {
		if (!agents || agents.length === 0) return "";
		return agents.map((a) => a.source).join(" · ");
	}

	/* Append the agent tag to a row's existing meta slot without losing it — the MCP
	   lists already spend that slot on tool/session counts.

	   Returns the visible text AND the untruncated one, because `+3` is only honest
	   if the three are reachable. `title` is left empty when nothing was folded, so
	   a row with one agent does not carry a tooltip repeating what it already says.
	   A native `title`, like `.rl-name`'s: same kind of information (the label you
	   are already looking at, in full) and so the same affordance. */
	function withAgents(metaOf) {
		return (row) => {
			var meta = metaOf ? metaOf(row) : "";
			var join = (tag) => (meta && tag ? meta + " · " + tag : meta || tag);
			var text = join(agentTag(row.agents));
			var full = join(agentTagFull(row.agents));
			return { text: text, title: full === text ? "" : full };
		};
	}

	/*
	 * `agentLine` used to render the per-agent header line on both cards —
	 * `by agent · 12 claude`, one `<b>calls</b> source` part per agent, from the
	 * server's own untruncated `skillAgents` / `mcpAgents` grouping rather than
	 * from the visible rows (those are cut to a page, so summing them
	 * under-reports an agent whose tools all rank lower).
	 *
	 * Removed: it restated at card level what every row beneath it already names
	 * through `agentTag`, and on a single-agent machine — the common case — it was
	 * one line saying the same word as every row below it.
	 *
	 * `skillAgents` / `mcpAgents` are still in the payload and still computed by
	 * `agentTotals` in DashboardQuery, so restoring the line is a render change
	 * only. They now have NO reader on this page; the whole-window per-agent split
	 * with volume is not stated anywhere.
	 */

	/* The "…so this list is not everything" caveat, shared by both cards.
	   `uncoveredSources` is a PARSER capability the server computed, not "these
	   agents happened to call nothing" — see ToolUsage in DashboardModel. */
	function uncoveredNote(usage, noun) {
		if (usage.uncoveredSources.length === 0) return "";
		return (
			" · <b>" +
			JD.esc(usage.uncoveredSources.join(", ")) +
			"</b> record no tool calls, so " +
			noun +
			" used only from those agents will not appear here"
		);
	}

	/* Skills (span6) — split out of the old combined "Skills & tools" card so
	   each half gets its own icon, stat line and footer, matching jolli-design's
	   per-card anatomy. Every row names the agents that ran it; which agents can
	   be read at all is the footer's `uncoveredSources` caveat, not a fixed list
	   here (it was hard-coded to Claude and went stale the day Codex landed). */
	/* Skill invocations only — NOT commands or subagents. `parseToolUse` promotes
	   a call to a skill row exactly when the tool is `Skill` and carries an
	   `input.skill` (TranscriptParser.ts); a subagent is the `Task` tool and
	   classifies as a builtin, and a slash command is a prompt expansion that
	   never becomes a tool call at all. Widening this sentence means widening
	   that classifier first. */
	var SKILLS_HINT =
		"Skill invocations, counted from the tool calls in your local transcripts. A skill invoked inside a " +
		"subagent counts once, against the session that spawned it.";

	function skillsCard(model) {
		var usage = model.stats.toolUsage;
		/* Puzzle piece — a skill is a part that slots into a run. Was a star,
		   which was this page's "decision" mark at the time and read as a rating
		   here. Lucide `puzzle`, like every other icon in this band. */
		var icon = widgetIcon(
			"--s2",
			'<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 ' +
				"2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 " +
				"1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 " +
				".474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 " +
				'1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
		);
		var html =
			'<section class="card span4" aria-label="Skills">' + widgetHead(icon, "Skills", null, SKILLS_HINT);

		if (usage.skills.length === 0) {
			return (
				html +
				'<div class="empty-note">No skill invocations recorded in this window.' +
				uncoveredNote(usage, "a skill") +
				"</div></section>"
			);
		}

		/* Both figures come off the server's own COUNT/SUM, never off the rows on
		   screen: `usage.skills` is ONE PAGE, so summing it read "12 runs · 8
		   skills" on a machine with 30 skills — and changed every time the reader
		   clicked Show more, which is the kind of wrong a header line cannot be. */
		var totalRuns = usage.skillCallsTotal;
		var totalSkills = usage.skillsTotal;
		html +=
			'<div class="sub" style="margin-top:2px">' +
			totalRuns +
			(totalRuns === 1 ? " run · " : " runs · ") +
			totalSkills +
			(totalSkills === 1 ? " skill</div>" : " skills</div>");

		html += rankedList(
			usage.skills,
			"--s2",
			(r) => r.calls,
			(r) => "/" + r.name,
			withAgents(null),
			"run",
			"skill",
		);
		html += toolMoreRow(usage, "skill");

		return (
			html +
			'<div class="w-foot"><span class="w-measure">ⓘ from <b>' +
			usage.sessionsWithTools +
			"</b> of " +
			usage.sessionsInWindow +
			(usage.sessionsInWindow === 1 ? " session</b>" : " sessions") +
			" in this window" +
			uncoveredNote(usage, "a skill") +
			"</span></div></section>"
		);
	}

	/* By server / by tool split, inside the MCPs card. `usage.mcpTools` is not a
	   second query — it is the same session_tool_use rows as `usage.servers`,
	   grouped by individual tool name (already `server.tool`, see
	   TranscriptParser) instead of rolled up to the server. So unlike Tokens'
	   By model/By repo this is pure view state, never a re-fetch (see the
	   `data-mcpsplit` handler). */
	function mcpViewChips(view) {
		return (
			'<div class="seg seg-sm" role="group" aria-label="Split by" style="margin-top:10px">' +
			'<button type="button" data-mcpsplit="server" aria-pressed="' +
			String(view === "server") +
			'">By server</button>' +
			'<button type="button" data-mcpsplit="tool" aria-pressed="' +
			String(view === "tool") +
			'">By tool</button></div>'
		);
	}

	function mcpViewList(usage, view) {
		if (view === "tool") {
			if (usage.mcpTools.length === 0) return '<div class="empty-note">No individual MCP tool calls recorded in this window.</div>';
			return (
				rankedList(
					usage.mcpTools,
					"--s1",
					(r) => r.calls,
					(r) => r.name,
					withAgents((r) => r.sessions + (r.sessions === 1 ? " session" : " sessions")),
					"call",
					"tool",
				) + toolMoreRow(usage, "tool")
			);
		}
		return (
			rankedList(
				usage.servers,
				"--s1",
				(r) => r.calls,
				(r) => r.server,
				withAgents((r) => r.tools + (r.tools === 1 ? " tool" : " tools")),
				"call",
				"server",
			) + toolMoreRow(usage, "server")
		);
	}

	/* MCP servers (span6). Only some agents' transcripts can be read for tool
	   calls, which is why the footer says "N of M sessions" rather than a bare
	   count: "3 sessions" alone reads as 3 of everything rather than 3 of the
	   sessions this build can actually see inside. Each row also names the
	   agents behind it, which is the finer version of the same honesty —
	   "codegraph · codex" answers a question a whole-card caveat cannot, and is
	   now the only place that honesty is spelled out (the footer's uncovered-
	   sources clause was trimmed — see the note there). Deliberately no
	   "N of M servers called" figure:
	   that needs the full registered-server list, which lives in MCP
	   registration config, not in captured tool calls; see ToolUsage in
	   DashboardModel. */
	/* What this card can and cannot see. The second sentence is the load-bearing
	   one: the rows come from CAPTURED CALLS, so "not listed" means "made no call
	   we can read", never "not configured" — and it cannot mean the latter,
	   because the registered-server list lives in each host's own config file and
	   not in any transcript (see ToolUsage in DashboardModel.ts). */
	var MCPS_HINT =
		"MCP tool calls read from your local transcripts — which tool, and how often, never the arguments or the " +
		"results. Only servers that actually made a call in this window appear.";

	function mcpCard(model) {
		var usage = model.stats.toolUsage;
		/* Plug — Lucide `plug`, the shape this card already used, redrawn to the
		   canonical path so it sits at the same weight as its two neighbours. */
		var icon = widgetIcon(
			"--s1",
			'<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
		);
		var html =
			'<section class="card span4" aria-label="MCPs">' + widgetHead(icon, "MCPs", null, MCPS_HINT);

		if (usage.servers.length === 0) {
			return (
				html +
				'<div class="empty-note">No MCP calls recorded in this window.' +
				uncoveredNote(usage, "a server") +
				"</div></section>"
			);
		}

		/* Server and call totals for the WHOLE window, from the server's own
		   COUNT/SUM — see the same note on the Skills card. Measured on a real
		   database: 15 servers and 375 calls, of which the first page can account
		   for 8 and 61. */
		var totalCalls = usage.serverCallsTotal;
		var totalServers = usage.serversTotal;
		html +=
			'<div class="sub" style="margin-top:2px">' +
			totalServers +
			(totalServers === 1 ? " server · " : " servers · ") +
			totalCalls +
			(totalCalls === 1 ? " call</div>" : " calls</div>");

		if (usage.recallCalls) {
			html +=
				'<div class="sub" style="margin-top:2px">↳ <b class="num">' +
				usage.recallCalls.calls +
				"</b> recall " +
				(usage.recallCalls.calls === 1 ? "call" : "calls") +
				" from " +
				usage.recallCalls.sessions +
				(usage.recallCalls.sessions === 1 ? " session" : " sessions") +
				"</div>";
		}

		var view = JD.mcpSplitView === "tool" ? "tool" : "server";
		html += mcpViewChips(view);
		html += mcpViewList(usage, view);

		/* ONE line, no hover. The coverage ratio is the whole footer: the same
		   shape the Skills card carries, and mandatory for the reason on this
		   card's own comment above — without a denominator, "12 calls" reads as
		   twelve out of everything rather than twelve out of the sessions this
		   build can see inside.

		   Deliberately NO `title` on it. A hover is not a surface: it is invisible
		   until pointed at, unreachable on touch, and it accumulated exactly the
		   `·`-joined caveats that were unreadable when they were on the card face.
		   If a caveat matters enough to say, it goes in the head's ⓘ (which
		   EXPLAINS the card) or on the face; if it does not, it is not written.
		   Two that used to hang here are now unwritten: the `uncoveredSources`
		   list, and "the recall count is MCP-tool calls only".

		   Never held the page-wide clause either ("older activity is reconstructed
		   from commits and stored summaries") — that described the activity
		   timeline, while these rows are captured tool calls and nothing here is
		   reconstructed from a commit. That clause has since been dropped from the
		   footer as well; see `CoverageNote` in DashboardModel.ts. */
		return (
			html +
			'<div class="w-foot"><span class="w-measure mcp-card-note">ⓘ from <b>' +
			usage.sessionsWithTools +
			"</b> of " +
			usage.sessionsInWindow +
			" sessions in this window</span></div></section>"
		);
	}

	/* Past its first page a ranked list scrolls INSIDE the card rather than
	   growing it. The three cards sit in one equal-third band, so a list that
	   grows re-flows the two beside it and pushes everything below the fold — the
	   card's size is part of the layout, not a consequence of its contents.

	   The cap is MEASURED off the rendered rows (the height of exactly
	   TOOL_PAGE_SIZE of them) rather than written as a CSS length: a row is a line
	   of variable-length text plus a bar, so its height is a font measurement, not
	   a constant, and a hard-coded one would either clip row 8 or leave a scrollbar
	   under a list that has nothing to scroll.

	   A list still on its first page gets NO cap at all — that is what keeps the
	   default 8 rows free of a scrollbar, which a `max-height` set unconditionally
	   would not (a cap equal to the content still arms the scroll container, and a
	   sub-pixel row height rounds the wrong way). */
	function capToolLists() {
		document.querySelectorAll("[data-toollist]").forEach((list) => {
			var items = list.children;
			if (!items || items.length <= TOOL_PAGE_SIZE) return;
			var first = items[0];
			var last = items[TOOL_PAGE_SIZE - 1];
			var height = last.offsetTop + last.offsetHeight - first.offsetTop;
			/* 0 while the card has no layout yet (a hidden tab, a detached render).
			   Capping to 0 would hide every row; leaving it uncapped only costs the
			   card its fixed height until the next repaint. */
			if (!height) return;
			list.style.maxHeight = height + "px";
			list.classList.add("rl-scroll");
		});
	}

	/* Scrolls a just-grown list so the rows the click actually fetched are at the
	   top of the visible window. Without it the card looks unchanged: the new rows
	   are there but below the fold, and the only visible difference is the footer
	   count — which reads as a button that half-worked. */
	function revealToolRows(usage) {
		if (!usage || !usage.paging) return;
		Object.keys(TOOL_LISTS).forEach((list) => {
			var state = usage.paging[list];
			if (!state || state.revealFrom == null) return;
			var at = state.revealFrom;
			/* Cleared whether or not the scroll lands — it describes ONE click, and a
			   sticky value would re-scroll the reader on every 30 s repaint. */
			state.revealFrom = null;
			var el = document.querySelector('[data-toollist="' + list + '"]');
			if (!el) return;
			var items = el.children;
			if (at <= 0 || at >= items.length) return;
			el.scrollTop = items[at].offsetTop - items[0].offsetTop;
		});
	}

	/**
	 * Where each ranked list is scrolled to, read BEFORE a repaint replaces them.
	 *
	 * Every repaint on this page rewrites the whole of `#app`, so a grown list's
	 * `<ul>` is destroyed and its replacement starts at row 1. That makes an
	 * expanded list look collapsed rather than scrolled — the cap shows exactly one
	 * page of rows, so row 1 at the top is indistinguishable from never having
	 * clicked. And because a repaint is what EVERY control on the page ends in, one
	 * card's Show more reset the reader's position in the other two: measured on a
	 * real page, expanding MCPs to 11 rows, scrolling to 120, then clicking Skills'
	 * Show more left MCPs' rows, cap and footer untouched with `scrollTop` back at 0.
	 *
	 * Snapshotting here, in the renderer, rather than at each control: the paging
	 * state used to carry a per-list `restoreScroll` (since removed) that the 30 s
	 * poll set on the one list it carried, and extending THAT would mean every
	 * future caller of `renderPage` remembering to fill it in for the lists it is
	 * NOT touching — forget one and the position is silently lost again. The poll
	 * needs no special case now: `carryForwardHooks` run before the swap, so by the
	 * time the repaint reads these offsets the old rows are still on screen.
	 */
	function snapshotToolScroll() {
		var offsets = {};
		Object.keys(TOOL_LISTS).forEach((list) => {
			var el = document.querySelector('[data-toollist="' + list + '"]');
			if (el && el.scrollTop) offsets[list] = el.scrollTop;
		});
		return offsets;
	}

	/* Puts every list back where the reader had it. Runs after `capToolLists`, which
	   is what arms the scroll container: assigning `scrollTop` to a list with no
	   `max-height` yet is silently a no-op — and so is assigning it to a list this
	   repaint collapsed, which is what makes a collapse still land at row 1.

	   Before `revealToolRows`, so the one list a click just grew wins: its reveal is
	   a deliberate jump to the new rows, where this is only "do not move". */
	function restoreToolScroll(offsets) {
		Object.keys(offsets).forEach((list) => {
			var el = document.querySelector('[data-toollist="' + list + '"]');
			if (el) el.scrollTop = offsets[list];
		});
	}

	/**
	 * Fetches ONE more page of a ranked tool list and appends it.
	 *
	 * The paging is SQL-side (`/api/tool-usage` → `buildToolUsagePage`), so this
	 * is the only way past the first page: the model carries 8 rows and the
	 * totals, never the rest of the list.
	 *
	 * Re-renders the whole stats page rather than splicing the new rows into the
	 * existing <ul>. A ranked list's bars are sized against the list's true
	 * maximum, and a later page can carry a BIGGER value than the top row — Skills
	 * ranks by adoption while printing runs (see `rankedList`) — so appending in
	 * place would leave every bar already on screen measured against a denominator
	 * that had moved.
	 *
	 * Never chained or auto-fired: one click, one page. The first page is already
	 * a working card, and anything past it earns its round trip when asked for.
	 */
	function loadMoreToolRows(model, list) {
		var spec = TOOL_LISTS[list];
		var usage = model.stats && model.stats.toolUsage;
		if (!spec || !usage) return;
		var state = toolPaging(usage, list);
		if (state.loading) return;
		var rows = usage[spec.rows] || [];
		if (rows.length >= (usage[spec.total] || 0)) return;
		state.loading = true;
		state.error = false;
		JD.renderPage(model);
		JD.getJson(JD.withParams("/api/tool-usage" + JD.query(model, {}), { list: list, offset: String(rows.length) }))
			.then((page) => {
				/* A 30 s model refresh can finish while this page is in flight. That
				   refresh replaces the global model and deliberately resets every tool
				   list to its fresh first page; an older response must not repaint the
				   superseded model over it. Identity is enough because refreshNow replaces
				   the object rather than mutating it. */
				if (window.__JOLLI_DASHBOARD__ !== model) return;
				state.loading = false;
				var incoming = (page && page.rows) || [];
				/* Re-read per page, not remembered from the first render: the window
				   keeps gaining calls while the dashboard is open, so "is there more"
				   has to be asked against a total as fresh as the rows beside it. */
				usage[spec.total] = page.totalCount;
				/* Deduped by row identity. An offset can repeat a row — a call arriving
				   mid-browse shifts one across the page boundary — but it can never
				   invent one, so a repeat is dropped and an all-repeats page is the
				   "nothing new" case below. */
				/* Null-prototype because tool names are data. `__proto__` and
				   `constructor` are valid strings, not inherited rows that should be
				   treated as already loaded. */
				var seen = Object.create(null);
				rows.forEach((row) => {
					seen[spec.key(row)] = true;
				});
				var fresh = incoming.filter((row) => !seen[spec.key(row)]);
				if (fresh.length === 0) {
					/* Nothing past this offset that we do not already hold, whatever the
					   total says. Believe the rows: pin the total to what is loaded, so
					   the footer loses its button rather than offering a click that cannot
					   add anything — but keeps its row, so the card does not resize on a
					   click that found nothing. */
					usage[spec.total] = rows.length;
					state.grown = true;
					JD.renderPage(model);
					return;
				}
				state.revealFrom = rows.length;
				/* Sticky for the life of this payload: it is what keeps the footer (and
				   so the card's height) in place once the last page lands. */
				state.grown = true;
				usage[spec.rows] = rows.concat(fresh);
				JD.renderPage(model);
			})
			.catch(() => {
				if (window.__JOLLI_DASHBOARD__ !== model) return;
				state.loading = false;
				state.error = true;
				JD.renderPage(model);
			});
	}

	/* Which renderer paints each pageable list. Both cards read
	   `model.stats.toolUsage` and nothing else, which is what lets a comparison
	   below run them against a stub model. */
	var TOOL_CARDS = { skills: (usage) => skillsCard({ stats: { toolUsage: usage } }), mcps: mcpCardFor };

	/* The MCPs card renders ONE of its two lists — whichever chip is pressed — so a
	   comparison about `tool` while the reader is looking at `server` would compare
	   HTML that does not contain the rows in question, and call every change
	   invisible forever. The view is forced to the list being asked about and put
	   straight back; nothing on screen is re-rendered in between. */
	function mcpCardFor(usage, list) {
		var previous = JD.mcpSplitView;
		JD.mcpSplitView = list;
		try {
			return mcpCard({ stats: { toolUsage: usage } });
		} finally {
			JD.mcpSplitView = previous;
		}
	}

	/**
	 * One card's HTML, as the card that owns `list` would paint it.
	 *
	 * Rendering is the comparison: "has this card changed" is answered by the real
	 * renderer rather than by a hand-kept list of the fields it prints, so a stat
	 * line added to either card joins the check by existing. A field list would
	 * have gone stale the first time someone added one, and it would have gone
	 * stale SILENTLY — the failure is a card that stops noticing it is out of date.
	 */
	function toolCardHtml(usage, list) {
		return TOOL_CARDS[TOOL_LISTS[list].card](usage, list);
	}

	/**
	 * A `toolUsage` reduced to what a comparison should see: one payload's
	 * aggregates, another's rows, and a paging state that is identical on both
	 * sides.
	 *
	 * Normalising the paging is what keeps the check about DATA. `loading` and
	 * `error` describe one request, not the card's contents, and `grown` is kept
	 * because it is not decoration either: it is what holds the footer row in place
	 * once a list has reached its end, and so part of the card's height.
	 */
	function comparableUsage(aggregatesFrom, rowsFrom) {
		var merged = Object.assign({}, aggregatesFrom);
		var paging = {};
		Object.keys(TOOL_LISTS).forEach((list) => {
			merged[TOOL_LISTS[list].rows] = rowsFrom[TOOL_LISTS[list].rows] || [];
			paging[list] = { grown: !!((rowsFrom.paging || {})[list] || {}).grown };
		});
		merged.paging = paging;
		return merged;
	}

	/**
	 * Re-reads ONE expanded list at the width it is displayed at, and collapses it
	 * back to the first page if anything about its card would now paint differently.
	 *
	 * Resolves `true` when it changed something (so the caller repaints once for all
	 * three lists rather than up to three times).
	 *
	 * A failed read keeps the expanded rows and says nothing: the aggregates beside
	 * them were already checked and matched, the next poll asks again 30 s later, and
	 * a card that empties itself over a transient fetch failure is a worse answer
	 * than one that is briefly a poll behind.
	 */
	function verifyToolList(model, list, width) {
		var spec = TOOL_LISTS[list];
		var usage = model.stats.toolUsage;
		return JD.getJson(
			JD.withParams("/api/tool-usage" + JD.query(model, {}), { list: list, offset: "0", limit: String(width) }),
		)
			.then((page) => {
				/* Superseded — a later poll already replaced the model this answer was
				   about. Same identity test, same reason, as `loadMoreToolRows`. */
				if (window.__JOLLI_DASHBOARD__ !== model) return false;
				/* A body that parsed but carries no total cannot be compared: the footer
				   would read "of 0", so every field-for-field identical list would look
				   changed. Unverifiable is the failed-read case, not the changed one. */
				if (!page || typeof page.totalCount !== "number") return false;
				var state = (usage.paging || {})[list] || {};
				/* A Show more click overlapped this read, in either order, and both orders
				   are only resolvable by waiting: its response rewrites these rows from the
				   array it captured BEFORE the collapse (so collapsing now is undone a
				   moment later), and if it has already landed, this read is narrower than
				   what is on screen — which can only ever say "changed" and would throw
				   away a click that just succeeded. The next poll asks again. */
				if (state.loading) return false;
				if ((usage[spec.rows] || []).length !== width) return false;
				var rows = page.rows || [];
				var candidate = Object.assign({}, usage);
				candidate[spec.rows] = rows;
				candidate[spec.total] = page.totalCount;
				candidate.paging = usage.paging;
				/* Wrapped separately from the read below, because the two failures are not
				   the same answer wearing different clothes. A failed READ is expected and
				   documented (keep the rows, say nothing); a renderer that THROWS is a bug,
				   and letting it fall into that same silent `.catch` would spend this
				   feature's whole lifetime looking like an offline blip. */
				var cardChanged;
				try {
					var before = toolCardHtml(comparableUsage(usage, usage), list);
					cardChanged = toolCardHtml(comparableUsage(candidate, candidate), list) !== before;
				} catch (e) {
					console.warn("jolli dashboard: could not compare the re-read " + list + " list", e);
					return false;
				}
				if (!cardChanged) return false;
				/* Changed — back to exactly the state a freshly opened card is in: the
				   first page, no scroll cap, no sticky footer. The rows come from THIS
				   response rather than from the poll's own first page, so the count in the
				   footer and the rows above it are answers to the same question at the
				   same moment.

				   Collapsing is the asked-for behaviour, not a shortcut around
				   re-expanding: a reader watching row 30 has no way to tell a re-fetched
				   page 4 from the one they were already reading, whereas a card that
				   visibly returns to 8 rows says "this changed, start again". */
				usage[spec.rows] = rows.slice(0, TOOL_PAGE_SIZE);
				usage[spec.total] = page.totalCount;
				/* Reset rather than deleted, which is the same thing to `toolPaging` and
				   one fewer shape for the rest of this module to consider. */
				if (usage.paging) usage.paging[list] = {};
				return true;
			})
			.catch(() => false);
	}

	/**
	 * Keeps the Skills / MCPs lists a reader has expanded across the 30 s poll,
	 * instead of silently dropping them back to 8 rows.
	 *
	 * The poll re-reads `/api/model`, whose tool lists are always the FIRST page —
	 * so before this, three clicks' worth of rows lasted at most 30 s, and the card
	 * shrank under whoever was reading it for no reason they could see.
	 *
	 * Two checks, in cost order, and a list has to pass both to stay expanded:
	 *
	 *   1. Everything on the card OTHER than its rows, compared synchronously. Both
	 *      sides are handed the outgoing rows, which leaves the aggregates as the
	 *      only thing that can differ. A change here needs no round trip to act on —
	 *      the card is repainting whatever the rows say.
	 *   2. The rows themselves, re-read at the width they are displayed at
	 *      (`/api/tool-usage?limit=<rows on screen>`) and compared against them.
	 *      This is the only asynchronous part, and it runs AFTER the fresh model is
	 *      adopted, because that identity is how its response knows whether it is
	 *      still relevant.
	 *
	 * The width is taken from `rows.length`, never from a click counter. They agree
	 * until a page comes back holding a row already on screen (which the append
	 * dedupes, see `loadMoreToolRows`), and from then on a counter asks for more
	 * rows than are displayed — so every later comparison would be N fresh rows
	 * against N-1 rendered ones, i.e. "changed" forever.
	 *
	 * Nothing is persisted: this is one browser tab's reading position. A reload or
	 * a range/repo click is a full navigation, which is exactly the point where an
	 * expansion should not follow the reader.
	 *
	 * COST, since only correctness is argued above: an expansion is a standing charge
	 * for as long as the tab stays open, not a one-off. Every 30 s each expanded list
	 * costs one `/api/tool-usage` read — up to three concurrent, each up to
	 * `TOOL_USAGE_MAX_LIMIT` (200) rows, and that SQL folds per-agent shares for every
	 * row it returns. Unmeasurable against a local database today, which is why the
	 * cap is the thing holding it down rather than a fetch budget here; a reader who
	 * clicks Show more is asking for it, and the collapse on any change is what stops
	 * a stale expansion from being paid for indefinitely.
	 */
	function carryForwardToolLists(fresh, previous) {
		/* Every page loads this module, so the hook has to be what knows it only
		   applies to Stats. */
		if (!fresh || fresh.view !== "stats") return null;
		var freshUsage = fresh.stats && fresh.stats.toolUsage;
		var prevUsage = previous && previous.stats && previous.stats.toolUsage;
		if (!freshUsage || !prevUsage) return null;
		var pending = [];
		Object.keys(TOOL_LISTS).forEach((list) => {
			var spec = TOOL_LISTS[list];
			var prevRows = prevUsage[spec.rows] || [];
			/* Never expanded: the fresh payload already carries this list's whole first
			   page, so there is nothing to keep and nothing to ask about. */
			if (prevRows.length <= TOOL_PAGE_SIZE) return;
			/* Check 1: the card apart from its rows. Both sides are handed the outgoing
			   rows, so the aggregates are the only thing left that can differ.

			   Wrapped per list, and BEFORE the first write below, so a renderer that
			   throws on one card costs that card its expansion and nothing else. The
			   alternative is a half-carried payload: rows moved across with no entry in
			   `pending`, so check 2 never runs and the list keeps rows nothing verified
			   for as long as the tab stays open. Skipping is the pre-existing behaviour;
			   the seam's own guard in shell.js is what stops a throw from stranding the
			   whole poll on the outgoing model. */
			var matches;
			try {
				var onScreen = toolCardHtml(comparableUsage(prevUsage, prevUsage), list);
				matches = toolCardHtml(comparableUsage(freshUsage, prevUsage), list) === onScreen;
			} catch (e) {
				/* Reported, not just swallowed: a renderer that throws here degrades to the
				   pre-existing collapse, which looks exactly like this feature not existing
				   — so it would fail every 30 s forever with no signal anywhere. */
				console.warn("jolli dashboard: could not compare the " + list + " card; not carrying it over", e);
				return;
			}
			if (!matches) return;
			var prevState = (prevUsage.paging || {})[list] || {};
			freshUsage[spec.rows] = prevRows;
			freshUsage.paging = freshUsage.paging || {};
			/* Rebuilt, not moved: `loading` and `error` belong to a request that this
			   swap has just orphaned (its own identity guard will drop the response), so
			   carrying `loading` would leave the button disabled with nothing left to
			   finish it, and carrying `error` would keep reporting a failure whose
			   subject is gone. `revealFrom` is dropped for the same kind of reason — it
			   describes one click's scroll, and re-applying it here would yank the reader
			   to a row boundary on a repaint that changed nothing.

			   No scroll offset either: `snapshotToolScroll` reads it off the live DOM at
			   the top of every repaint, and this runs before the swap, so the rows the
			   reader is looking at are still on screen when it does. */
			freshUsage.paging[list] = { grown: !!prevState.grown };
			pending.push(list);
		});
		if (pending.length === 0) return null;
		/* Check 2, once the fresh model is the current one — see JD.carryForwardHooks. */
		return () => {
			var model = window.__JOLLI_DASHBOARD__;
			if (model !== fresh) return;
			var usage = model.stats.toolUsage;
			var reads = pending.map((list) => verifyToolList(model, list, usage[TOOL_LISTS[list].rows].length));
			Promise.all(reads).then((changed) => {
				if (window.__JOLLI_DASHBOARD__ !== model) return;
				/* One repaint for all three, and only if something actually moved.

				   That repaint replaces every <ul>, including the lists that PASSED and are
				   still showing the reader's rows — they keep their position because
				   `renderStats` snapshots and restores every list's offset, not because
				   anything is re-armed here. A list that DID collapse lands at row 1 out of
				   the same mechanism: its <ul> is no longer scrollable, so the restore is a
				   no-op on it. */
				if (!changed.some(Boolean)) return;
				JD.renderPage(model);
			});
		};
	}

	/* Tokens (span4) — input/output/cache, day-bucketed. Reuses
	   `JD.stackedBars` (the same chart Cost & tokens draws) rather than a
	   one-off SVG, so the two cards read as the same chart language. `cached`
	   is one combined figure, not a cache-write/cache-read split — the database
	   only stores one column for it (see `TokenBreakdown` in DashboardModel.ts),
	   so splitting it would mean assuming a ratio instead of measuring one. */
	var TOKEN_TYPE_KEYS = ["Input", "Output", "Cache"];
	var TOK_VIEW_LABEL = { model: "Model", project: "Project" };

	/* Split-by tabs, inside the card and nowhere else. Picking "By model"/"By
	   repo" writes `JD.dimension` and re-fetches, because the axis is a
	   server-side query. These are the only controls that set it — the generic
	   group-by chips they used to be described as matching were never rendered. */
	function tokensViewChips(view) {
		return (
			'<div class="seg seg-sm" role="group" aria-label="Split by" style="margin-top:10px">' +
			'<button type="button" data-toksplit="type" aria-pressed="' +
			String(view === "type") +
			'">By type</button>' +
			'<button type="button" data-toksplit="model" aria-pressed="' +
			String(view === "model") +
			'">By model</button>' +
			'<button type="button" data-toksplit="repo" aria-pressed="' +
			String(view === "repo") +
			'">By repo</button></div>'
		);
	}

	/* Legend + chart for the current split. "By type" is local (from
	   `tokenBreakdown`, already in the model); "By model"/"By repo" reuse Cost &
	   tokens' own `stats.series`, so this can render an empty-note rather than a
	   second query when that card's group-by is on a different axis. */
	function tokensViewBody(stats, view) {
		var tb = stats.tokenBreakdown;
		if (view === "type") {
			var html = '<div class="legend" style="margin-top:8px">';
			[
				["Input", tb.input],
				["Output", tb.output],
				["Cache", tb.cached],
			].forEach((pair, index) => {
				html +=
					'<span><i style="background:' +
					JD.seriesColor(index) +
					'"></i>' +
					pair[0] +
					' <b class="num">' +
					JD.fmtTokens(pair[1]) +
					"</b></span>";
			});
			html += "</div>";
			var series = tb.perDay.map((day) => ({
				date: day.date,
				bySeries: { Input: day.input, Output: day.output, Cache: day.cached },
			}));
			return html + '<div class="chart-box" style="margin-top:16px">' + JD.stackedBars(series, TOKEN_TYPE_KEYS, "tokens by type") + "</div>";
		}

		var wantDim = view === "model" ? "model" : "project";
		if (stats.seriesDimension !== wantDim) {
			return (
				'<div class="empty-note">Switch Cost &amp; tokens’ group-by to "' +
				TOK_VIEW_LABEL[wantDim] +
				'" to see this split — the two cards share one query.</div>'
			);
		}
		if (stats.seriesKeys.length === 0) return '<div class="empty-note">No token data yet in this window.</div>';

		var ranked = rankRows(stats);
		var html = '<div class="legend" style="margin-top:8px">';
		stats.seriesKeys.forEach((key, index) => {
			var row = ranked.find((r) => r.key === key);
			html +=
				'<span><i style="background:' +
				JD.seriesColor(index) +
				'"></i><span class="mono lg-key" title="' +
				JD.esc(key) +
				'">' +
				JD.esc(key) +
				'</span> <b class="num">' +
				JD.fmtTokens(row ? row.tokens : 0) +
				"</b></span>";
		});
		html += "</div>";
		return html + '<div class="chart-box" style="margin-top:16px">' + JD.stackedBars(stats.series, stats.seriesKeys, "tokens by " + wantDim) + "</div>";
	}

	/* Why this card counts tokens while Spend counts dollars — the one thing a
	   reader cannot infer from the bars, since a rising cached share moves the two
	   in opposite directions. */
	var TOKENS_HINT =
		"How your tokens are actually used, by day. Cache reads bill at 10% of input, so a rising cached share " +
		"lowers cost while tokens climb — which is why this widget counts tokens and Spend counts dollars.";

	function tokensCard(model) {
		var stats = model.stats;
		var tb = stats.tokenBreakdown;
		var total = tb.input + tb.output + tb.cached;
		/* Bar chart — Lucide `chart-column`, matching what the card draws. It was
		   a CLOCK, which belongs to elapsed time and said nothing about token
		   volume; the clock is still correct on the session feed below, which is
		   the card it was presumably copied from. */
		var icon = widgetIcon("--s3", '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>');
		var html =
			'<section class="card span4" aria-label="Tokens">' +
			widgetHead(icon, "Tokens", null, TOKENS_HINT);

		if (total === 0) {
			return (
				html +
				'<div class="empty-note">No token data yet — Claude sessions report tokens; other agents count ' +
				"sessions only.</div></section>"
			);
		}

		html +=
			'<div class="bignum num" style="font-size:22px;font-weight:650;margin-top:2px">' +
			JD.fmtTokens(total) +
			'<div class="sub" style="font-weight:400;margin-top:2px">captured tokens, ' +
			Math.round((tb.cached / total) * 100) +
			"% of them cache</div></div>";

		var view = JD.tokSplitView || "type";
		html += tokensViewChips(view);
		html += tokensViewBody(stats, view);

		return (
			html +
			'<div class="w-foot"><span class="w-chip">Claude only</span>' +
			'<span class="w-chip">cache is one combined figure</span>' +
			'<span class="w-measure">ⓘ volume, not spend</span></div></section>'
		);
	}

	/* Shared label/value stat list — same `.records` markup activityCard already
	   uses, so a card's summary rows read as the same component as the rest of
	   the page. */
	function statRows(rows) {
		return (
			'<ul class="records" style="margin-top:14px">' +
			rows.map((r) => "<li><span>" + r[0] + '</span><b class="num">' + r[1] + "</b></li>").join("") +
			"</ul>"
		);
	}

	/* Feed-card category colours. Shared with the standup board — the order and
	   the rationale live on `JD.categoryColor` in shell.js, because both pages
	   paint the same category chip for the same commits. */
	var catColor = JD.categoryColor;

	/* "Jul 27 · 4:54pm" — the mockup's row timestamp. Absolute, not relative: the
	   feed is scanned for "when did this land", and the range control already
	   frames the window. */
	function cardWhen(ms, timeZone) {
		var date = new Date(ms);
		var day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timeZone });
		var time = date
			.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timeZone })
			.replace(/\s/g, "")
			.toLowerCase();
		return day + " · " + time;
	}

	/* One memory card: the commit, the decision behind it, and its cost/diff
	   chips. `reuse` ("recalled by N teammates") is deliberately never emitted —
	   nothing records recall receipts yet, and the stylesheet only reveals that
	   chip at the Space tier. */
	function memoryCard(card, model) {
		var esc = JD.esc;
		var chips = "";
		if (card.estCostUsd != null)
			chips += '<span class="tag metric num">' + esc(JD.fmtUsd(card.estCostUsd)) + " est</span>";
		if (card.turns != null) chips += '<span class="tag metric num">' + esc(card.turns) + " turns</span>";
		if (card.insertions != null || card.deletions != null)
			chips +=
				'<span class="tag metric num mono">+' +
				esc(card.insertions || 0) +
				" −" +
				esc(card.deletions || 0) +
				"</span>";
		if (card.branch) chips += '<span class="tag mono">' + esc(card.branch) + "</span>";
		if (card.model) chips += '<span class="tag mono">' + esc(card.model) + "</span>";
		/* Cross-repo scope: name the repo, the way the session feed does. Anything
		   but exactly one repo in scope counts as cross-repo — see the same test
		   in memoryActivityCard's row(). */
		if (JD.scopeIdentities(model).length !== 1 && card.repoName)
			chips += '<span class="tag">' + esc(card.repoName) + "</span>";

		return (
			'<div class="fcard"><div class="row1"><span class="title">' +
			esc(card.title) +
			"</span>" +
			(card.category
				? '<span class="tag"><i style="background:' +
					catColor(card.category) +
					'"></i>' +
					esc(card.category) +
					" · " +
					esc(card.severity) +
					"</span>"
				: "") +
			'<span class="when">' +
			esc(cardWhen(card.committedAtMs, model.timeZone)) +
			"</span></div>" +
			(card.decision ? '<div class="decision"><b>Decision:</b> ' + JD.mdInline(esc(card.decision)) + "</div>" : "") +
			'<div class="fchips">' +
			chips +
			"</div></div>"
		);
	}

	/* "What my agents did" — the feed slot, one shape per tier.
	   With memory on it hands the slot to the Memory Activity card (Branch/Time
	   over the memory cards); the raw-session feed below is the memory-off shape,
	   plus the prompt explaining what memory would add.

	   Everything past the hand-off is memory-OFF only. The branches that used to
	   re-test `memory` there were dead the moment the early return landed, and a
	   dead `memory` test is exactly what hid the missing session-activity card —
	   so they are gone rather than left looking live. */
	function feedCard(model) {
		var stats = model.stats;
		var cards = stats.memoryCards || [];
		/* This is the prominent memory surface in the dashboard. Rendering the
		   Branch/Time card lower down made the requested controls effectively
		   invisible behind the old feed. */
		if (model.tier !== "installed" && cards.length > 0) return memoryActivityCard(model);
		/* The feed sits above hot files, tools and efficiency, so a full window of
		   it buries every card below. Newest page by default, the rest on a click. */
		var rows = stats.recentSessions;
		var shown = JD.feedExpanded ? rows.length : Math.min(rows.length, JD.PAGE_SIZE);
		var toggle = rows.length > JD.PAGE_SIZE ? JD.moreToggle("feedMore", shown, rows.length, "sessions") : "";
		var html =
			'<section class="card" aria-label="What my agents did"><div class="card-head">' +
			widgetIcon("--good-text", '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>') +
			"<div><h2>What my agents did</h2>" +
			'<div class="sub">' +
			JD.esc(rangeSub(stats)) +
			" · from local agent logs" +
			"</div></div>" +
			'</div><div class="feed">';

		/* The feed follows the range, so an empty one means "none in this window"
		   — saying "none recorded yet" would read as "nothing was ever captured". */
		if (stats.recentSessions.length === 0)
			html += '<div class="empty-note">No sessions in this window.</div>';
		stats.recentSessions.slice(0, shown).forEach((session) => {
			html += JD.sessionRow(session, model);
		});
		/* The toggle rides inside the feed here so the unlock panel stays the last
		   thing in the card — it is the call to action, not a list footer. */
		html += toggle;
		if (model.tier === "installed")
			html +=
				'<div class="locked-panel" style="margin-top:4px"><p><b>These sessions produced commits — but the join is off.</b></p>' +
				'<p class="why">Enable Jolli Memory to turn raw sessions into memory cards: what changed, the decisions made, and cost per commit, branch and ticket.</p></div>';
		return html + "</div></section>";
	}

	/* Nothing is enrolled yet. This is the instruction the Repositories page used
	   to carry, and it moved here when that page was removed: Dashboard is now
	   the landing page in every state, so it is what a fresh install sees. Six
	   cards of zeroes would technically be accurate and would explain nothing.

	   `repos` (not `stats`) is the test, because it is the only field that
	   distinguishes "no repository is enrolled" from "this window is quiet" —
	   every stats figure reads zero in both. And `repos` now carries PAUSED repos
	   too, so this fires only when the registry is genuinely empty: an all-paused
	   dashboard renders its (still-counting) numbers instead of claiming nothing
	   is enrolled. */
	function noReposCard() {
		return (
			'<section class="card span12"><div class="empty"><div class="inner"><div class="chip">◆</div>' +
			"<h2>No repositories yet</h2><p>Jolli attaches memory to your commits. Run <code>jolli enable</code> " +
			"inside the repository you want to start with — it appears here once enabled, and this page fills in " +
			"from your next AI session and commit.</p></div></div></section>"
		);
	}

	JD.renderStats = (model) => {
		var stats = model.stats;
		/* Read before anything writes to #app — see `snapshotToolScroll`. Taken even
		   on the no-repos path below, which is cheap and keeps the one rule ("read
		   first, always") rather than a second thing to remember. */
		var toolScroll = snapshotToolScroll();
		if ((model.repos || []).length === 0) {
			document.getElementById("app").innerHTML = noReposCard();
			return;
		}
		/* Order follows jolli-design's own Dashboard route (confirmed against a
		   real screenshot of it): the equal-third band (what runs, what's
		   called, what it cost in tokens) leads, then spend over time, then
		   decisions, then the feed, then the two lower-priority cards. Decisions
		   used to be paired with a Recall card beside it; that card was removed
		   (JOLLI-2193) along with its whole query path, so Decisions took the
		   whole row rather than leaving six empty columns. */
		var html = skillsCard(model);
		html += mcpCard(model);
		html += tokensCard(model);

		html += costCard(model);

		html += decisionsCard(model);

		/* The session-activity card (heatmap, hour histogram, records, share card)
		   was removed — `stats.heatmap` / `stats.hours` / `stats.fun` stay in the
		   payload, so restoring it is a render change only. */
		html += feedCard(model);

		document.getElementById("app").innerHTML = html;

		/* Card tabs and the table toggle are pure view state over the SAME model,
		   so they re-render locally instead of re-querying. */
		var tableToggle = document.getElementById("tableToggle");
		if (tableToggle) {
			tableToggle.onclick = () => {
				JD.m1Table = !JD.m1Table;
				JD.renderPage(model);
			};
		}
		document.querySelectorAll("[data-memory-activity-view]").forEach((button) => {
			button.onclick = () => {
				JD.memoryActivityView = button.getAttribute("data-memory-activity-view");
				JD.renderPage(model);
			};
		});

		/* Tokens' own split-by tabs. "By type" is local (from `tokenBreakdown`,
		   already in the model); "By model"/"By repo" share Cost & tokens' series
		   query, so picking one re-fetches exactly like that card's own group-by
		   chips do. */
		document.querySelectorAll("[data-toksplit]").forEach((button) => {
			button.onclick = () => {
				var view = button.getAttribute("data-toksplit");
				if (view !== (JD.tokSplitView || "type")) JD.track("chart_split_changed", { card: "tokens", split: view });
				JD.tokSplitView = view;
				var wantDim = view === "model" ? "model" : view === "repo" ? "project" : null;
				if (wantDim && JD.dimension !== wantDim) {
					JD.dimension = wantDim;
					JD.refreshNow(JD.renderPage);
					return;
				}
				JD.renderPage(model);
			};
		});

		/* MCPs' own split-by tabs. Unlike Tokens' By model/By repo, both views are
		   already in the one `toolUsage` payload — `mcpTools` is the same
		   session_tool_use rows as `servers`, just grouped by individual tool
		   instead of rolled up — so this is pure view state, never a re-fetch. */
		document.querySelectorAll("[data-mcpsplit]").forEach((button) => {
			button.onclick = () => {
				var value = button.getAttribute("data-mcpsplit");
				if (value !== (JD.mcpSplitView || "server")) JD.track("chart_split_changed", { card: "mcp", split: value });
				JD.mcpSplitView = value;
				JD.renderPage(model);
			};
		});

		/* Same kind of state: the feed's collapsed page is a view choice over the
		   model already loaded, so it re-renders rather than re-queries. */
		var feedMore = document.getElementById("feedMore");
		if (feedMore) {
			feedMore.onclick = () => {
				JD.feedExpanded = !JD.feedExpanded;
				JD.renderPage(model);
			};
		}

		/* The Skills / MCPs lists are the one thing on this page that pages in SQL,
		   so their "Show more" is a fetch rather than a view toggle. Capped first
		   (both run on every repaint, so a list grown by an earlier click keeps its
		   height and its scrollbar), then the reveal, which needs the cap in place
		   to have anything to scroll. */
		capToolLists();
		restoreToolScroll(toolScroll);
		revealToolRows(stats.toolUsage);
		document.querySelectorAll("[data-toolmore]").forEach((button) => {
			button.onclick = () => loadMoreToolRows(model, button.getAttribute("data-toolmore"));
		});
	};

	/* Registered unconditionally — every view loads this module, and the hook's own
	   `view !== "stats"` guard is what scopes it. See `JD.carryForwardHooks`. */
	JD.carryForwardHooks.push(carryForwardToolLists);
})(window.JD);
