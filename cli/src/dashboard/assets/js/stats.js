window.JD = window.JD || {};

((JD) => {
	/* Four ranked series plus an "Other" bucket — exactly the five colours the
	   palette has. See `JD.topSeries` in charts.js for why it is four and not
	   five, and why extending the palette is not an option. */
	var SERIES_LIMIT = 4;

	var RANGE_SUB = { today: "Today", week: "Last 7 days", "2w": "Last 14 days", month: "Last 30 days", "3m": "Last 90 days" };

	/* Prose name for the window a model was built over. A custom range has no
	   name, so it states its own bounds — which are the resolved ones, so a
	   clamped request reads as the window it actually got. */
	function rangeSub(stats) {
		return RANGE_SUB[stats.range] || stats.rangeFrom + " → " + stats.rangeTo;
	}

	/* The Spend card's SINGLE source of cost. Each day's measured total is spread
	   across that day's series keys by token share — an estimate, stated as one in
	   the card — and the bars, the legend, the headline and the footer all read
	   this one result. That is the point: the card used to take its headline from
	   `kpis.cost`, which windows `sessions` on their update time, while the bars
	   below it came from memories/commits windowed on committer date. Two clocks,
	   two populations, one card claiming both numbers answered the same question.

	   It deliberately does NOT total `estCostUsd`, close as that is. `bySeries`
	   carries TOKENS, so a day with real cost but zero tokens — the category axis
	   apportions a commit across its topics and rounds — spreads to nothing and
	   draws no bar. Money that is not drawn must not be in the headline either,
	   or the card is back to disagreeing with itself, just by less. */
	function apportionedCost(stats) {
		/* Prototype-less throughout, same reason as memoryActivityCard's grouping:
		   series keys are user-controlled strings (branch, ticket, model, repo). A
		   branch named `constructor` makes a plain object hand back an inherited
		   function, so `+=` writes NaN onto Object.prototype and Object.keys() never
		   lists it — silently dropping that series from the chart. And `bySeries`
		   comes off JSON.parse, so it has a prototype: read it with a typeof test
		   rather than trusting `|| 0` to catch a function. */
		var byKey = Object.create(null);
		var total = 0;
		var series = stats.series.map((point) => {
			var read = (key) => (typeof point.bySeries[key] === "number" ? point.bySeries[key] : 0);
			var tokenTotal = stats.seriesKeys.reduce((sum, key) => sum + read(key), 0);
			var bySeries = Object.create(null);
			var dayCost = 0;
			stats.seriesKeys.forEach((key) => {
				var cost = tokenTotal > 0 ? (point.estCostUsd * read(key)) / tokenTotal : 0;
				bySeries[key] = cost;
				byKey[key] = (byKey[key] || 0) + cost;
				dayCost += cost;
			});
			total += dayCost;
			return { date: point.date, bySeries: bySeries, cost: dayCost };
		});
		var ranked = stats.seriesKeys
			.map((key) => ({ key: key, cost: byKey[key] || 0 }))
			.sort((a, b) => b.cost - a.cost);
		return { series: series, byKey: byKey, ranked: ranked, total: total };
	}

	/* Which clock the series is on. The memory-driven axes window on committer
	   date; the session-driven ones on session activity. Reading `seriesDimension`
	   rather than the requested dimension is what keeps this honest — below the
	   memory tier a memory axis falls back to `model`, and the label follows. */
	function seriesClockNote(stats) {
		var byCommit =
			stats.seriesDimension === "branch" ||
			stats.seriesDimension === "ticket" ||
			stats.seriesDimension === "category";
		return byCommit ? "by commit date" : "by session activity";
	}

	/* What the series is split BY, as a word. The Spend card names it twice — the
	   chart's `aria-label` and the "largest …" figure — and both said "model" on
	   every axis, so on `?dimension=branch` a screen reader announced a branch
	   name as a model and the sighted label read "largest model: fix-auth-refresh".

	   Reads `seriesDimension` rather than the requested dimension, for the same
	   reason `seriesClockNote` above does: below the memory tier a memory axis
	   falls back to `model` server-side, and the word has to follow the data that
	   was actually drawn, not the one that was asked for.

	   An unrecognised dimension degrades to the neutral "series" instead of
	   asserting a wrong noun — the server owns this vocabulary and can extend it,
	   and an older page reading a newer server must not mislabel the axis. The
	   whitelist is an ARRAY, so a dimension colliding with an Object.prototype
	   member cannot hand back an inherited value the way a plain-object map would. */
	var AXIS_NOUNS = ["model", "agent", "project", "branch", "ticket", "category"];
	function axisNoun(stats) {
		return AXIS_NOUNS.indexOf(stats.seriesDimension) >= 0 ? stats.seriesDimension : "series";
	}

	/* Spend is the cost-only companion to Tokens. It never reuses the token
	   chart: each day allocates its measured total cost across working models by
	   that day's token share, which is explicitly an estimate. */
	function costCard(model) {
		var esc = JD.esc;
		var stats = model.stats;
		var spend = apportionedCost(stats);
		/* WHICH WINDOW and WHICH CLOCK — the two things that change what these
		   numbers mean — ride in the head's `title=` hint rather than as a visible
		   sub, the move every other card in the band already made. Each head on
		   the page is then one line.

		   RAW text, not `esc`aped: `hintAttr` wraps first and escapes per line, so
		   pre-escaping would double-encode.

		   It used to append `prices as of <date>`; that is a property of the price
		   table, constant across every window and every card, so it read as noise
		   on the line a user scans to orient themselves. `stats.pricesAsOf` is
		   still sent, for a surface that wants to state it once. */
		var hint = rangeSub(stats) + " · " + seriesClockNote(stats) + " · estimated from local transcripts";

		/* Dollar in a circle — Lucide `circle-dollar-sign`. It was an axes-plus-
		   trend-line glyph, which is the same "it's a chart" statement Tokens'
		   bar chart already makes one band up; the only thing that distinguishes
		   these two widgets is that this one is denominated in money, so that is
		   what the icon has to say. */
		/* span12: this card has a ROW to itself now, so a half-width one left the
		   other half empty. It was span6 while it shared a row — first with Tokens,
		   then with Decisions — and kept that width through both pairings because
		   nothing on it needed twelve columns. That reasoning was about a card with a
		   NEIGHBOUR; Decisions grew to span8 and took the seat, so what governs the
		   width now is the row, not the content. The bars are a 660-wide viewBox drawn
		   at `width="100%"`, so they scale into it rather than clip. */
		var html =
			'<section class="card span12" aria-label="Spend">' +
			widgetHead(
				widgetIcon(
					"--s4",
					'<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/>' +
						'<path d="M12 18V6"/>',
				),
				"Spend",
				null,
				hint,
				'<div class="num" style="font-size:18px;font-weight:650;color:var(--good-text)">' +
					JD.fmtUsd(spend.total) +
					'</div><div class="sub">estimated spend<br>this window</div>',
			);

		html += '<div class="chart-box" style="margin-top:12px">';
		if (stats.seriesKeys.length === 0) {
			html += '<div class="empty-note">No estimated spend data yet.</div>';
		} else {
			/* Legend and bars read the SAME rolled-up keys, in the same order — the
			   colour of a legend swatch is its index in this array and nothing else,
			   so two arrays here would mislabel every series after the first. */
			var top = JD.topSeries(spend.series, stats.seriesKeys, SERIES_LIMIT);
			html += '<div class="legend">';
			top.keys.forEach((key, index) => {
				html +=
					'<span><i style="background:' +
					JD.seriesColor(index) +
					'"></i><span class="mono lg-key" title="' +
					esc(key) +
					'">' +
					esc(key) +
					'</span> <b class="num">' +
					JD.fmtUsd(top.byKey[key] || 0) +
					"</b></span>";
			});
			html += "</div>" + JD.stackedBars(top.series, top.keys, "estimated spend by " + axisNoun(stats), JD.fmtUsd);
		}
		html += "</div>";

		/* Comparison row — vs the prior window, the largest key this window, and
		   the single busiest day by cost.

		   `costTrendPct` is server-computed and self-trend only, but it is now the
		   SAME population as the headline it sits under: the server sums the prior
		   window's series along this same dimension, by the rule `apportionedCost`
		   uses here (`drawnCost` in DashboardQuery.ts). It used to trend
		   `sessions.est_cost_usd` instead — a different clock on the memory axes —
		   so a "$0.00" headline could carry a "↑ 200%" beside it. */
		if (stats.seriesKeys.length > 0) {
			/* `largest`, not `top` — `var` is FUNCTION-scoped, so reusing the name
			   the roll-up above bound would put two different shapes on one binding
			   and leave this block working only because it runs second. Reordering
			   the chart and comparison blocks would then read `.key`/`.cost` off a
			   `topSeries` result and print "largest model: undefined, NaN%".
			   Biome cannot catch it: `cli/biome.json` excludes `src/dashboard/assets`. */
			var largest = spend.ranked[0];
			var totalCost = spend.total;
			/* From the apportioned series, not `estCostUsd`: the busiest day is
			   printed as a share of the headline, so a day counted one way against
			   a total counted the other can read as more than 100%. */
			var busiest = spend.series.reduce(
				(best, p) => (p.cost > best.v ? { date: p.date, v: p.cost } : best),
				{ date: undefined, v: 0 },
			);
			html += '<div class="cmpline" style="display:flex;gap:20px;flex-wrap:wrap;margin-top:10px;font-size:11.5px;color:var(--muted)">';
			html +=
				'<span>vs prior period<b style="display:block;font-size:12.5px;color:var(--ink);font-weight:650">' +
				(stats.costTrendPct === undefined
					? "no prior window to compare"
					: (stats.costTrendPct < 0 ? "↓ " : "↑ ") + Math.abs(stats.costTrendPct) + "%") +
				"</b></span>";
			if (largest && totalCost > 0) {
				html +=
					"<span>largest " +
					axisNoun(stats) +
					'<b style="display:block;font-size:12.5px;color:var(--ink);font-weight:650">' +
					esc(largest.key) +
					", " +
					Math.round((largest.cost / totalCost) * 100) +
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

		/* No footer. Two notes used to sit here — "estimated, not a bill" and
		   "model splits are apportioned by token share" — and the card states
		   both of them earlier, where they are read rather than scrolled past:
		   the subtitle already says "estimated from local transcripts", which
		   carries the not-a-bill point in the same breath as where the numbers
		   came from, and the legend presents the per-key figures as a split of
		   one measured daily total. A caveat printed below the chart corrects a
		   reading the reader has already made. */
		return html + "</section>";
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
	   row's TITLE and by the Decisions card's title, so a decision and the row it
	   came from lead to the same place. Both are the thing being named rather
	   than a separate "Open memory →" affordance beside it: the title is what a
	   reader aims at, and a per-row action column of identical links is a column
	   of the same word repeated.

	   `detailRepo` names the memory's owning repo without scoping the page it
	   lands on — see wireTree in memories.js. Whatever scope THIS page carries
	   rides along through JD.query, so a repo-filtered dashboard still opens a
	   repo-filtered tree. */
	function memoryHref(model, commitHash, repoIdentity, anchor) {
		return (
			"/memories" +
			JD.withParams(JD.query(model, {}), { hash: commitHash, detailRepo: repoIdentity }) +
			(anchor ? "#" + anchor : "")
		);
	}

	/* The id `memories.js` puts on the detail pane's topics section — the one whose
	   header reads "What changed and why". One fixed anchor serves both callers,
	   and neither could address anything finer: Memory Activity's "N decisions"
	   knows only HOW MANY a memory recorded (`MemoryCard.decisionCount`), never
	   which topic they sit under, and the Decisions card's Latest title names a
	   topic that carries no index on the wire.

	   It used to land on the decision block itself. That was one level too deep —
	   `.decide` renders below its topic's own heading and trigger prose, so the
	   scroll left the reader mid-topic with nothing above the fold saying which
	   topic the decision belongs to. */
	var TOPICS_ANCHOR = "what-changed";

	/* The id `memories.js` puts on each individual topic — `topic-<index>`, where the
	   index is the position in `collectDisplayTopics(summary)`. Its topic list is a
	   straight 1:1 map of that array, so the index the server sends addresses the
	   element this prefix names. Spelled here beside TOPICS_ANCHOR because both are
	   the other page's ids and belong together. */
	var TOPIC_ANCHOR_PREFIX = "topic-";

	/* What the list is: the window's memories, or the most recent slice of them.
	   The distinction is `memoryCardsCapped`, and it has to come from the server —
	   the feed is cut at MEMORY_CARDS_LIMIT before it is serialised, so a count of
	   20 here means "20 in the window" and "the 20 most recent of 300" equally.

	   Both wordings have shipped wrong. "N memories in this window" claimed the
	   page size was the window total, directly above the coverage line that prints
	   the real one; the fix for that then said "showing the N most recent"
	   unconditionally, which asserts a truncation that usually has not happened —
	   and reads "showing the 1 most recent" at N=1. Neither is "N of M": the
	   coverage line's `memoriesCreated` counts COMMITS carrying a memory while
	   this list counts memory rows, so that framing would be a third inaccuracy. */
	function memoryActivitySub(count, capped) {
		if (capped) return "showing the " + count + " most recent";
		return count === 1 ? "1 memory in this window" : count + " memories in this window";
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
					'<a class="tag metric num" href="' +
						memoryHref(model, card.commitHash, card.repoIdentity, TOPICS_ANCHOR) +
						'" target="_blank" rel="noopener">' +
						esc(card.decisionCount) +
						(card.decisionCount === 1 ? " decision</a>" : " decisions</a>"),
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
				'"><div class="mem-activity-copy"><a class="mem-activity-title" href="' +
				openHref(card) +
				'" target="_blank" rel="noopener">' +
				esc(card.title) +
				'</a><div class="mem-activity-meta">' +
				meta.join("") +
				"</div></div><div class=\"mem-activity-action\"><time>" +
				esc(cardWhen(card.committedAtMs, model.timeZone)) +
				"</time></div></article>"
			);
		};
		var body = groups.map((group) => '<section class="mem-activity-group"><h3>' + esc(group.label) + "</h3>" + group.cards.map(row).join("") + "</section>").join("");
		return (
			'<section class="card span12 mem-activity" aria-label="Memory Activity"><div class="card-head">' +
			widgetIcon("--s4", '<path d="M7 3h10v18H7z"/><path d="M9 7h6M9 11h6M9 15h4"/>') +
			'<div><h2>Memory Activity</h2><div class="sub">' +
			memoryActivitySub(cards.length, model.stats.memoryCardsCapped) +
			"</div></div><div class=\"spacer\"></div>" +
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
	/* `aside` is the card's headline figure, right-aligned on the head's own row —
	   the shape Spend built inline, now shared so Decisions reads the same way.
	   Tokens read it that way while it held the span6 seat and gave it back when
	   the two swapped bands; the users are whoever is at span6, not either card.

	   Two numbers in it are MEASURED, not chosen, and both come from Spend at
	   `span6`. `flex:1 1 220px` (not 300) is what decides whether the figure sits
	   beside the title or wraps under it: half a row on a ~1200px viewport is
	   ~410px of head, enough for icon + 220 + the figure and not for icon + 300 +
	   the figure. `margin-left:auto` is the other half — a WRAPPED flex line
	   places its one item at the START, so without it a figure that did wrap
	   lands left-aligned under a sub still styled to sit at the right edge.

	   Both apply ONLY when there is an aside; a head without one keeps its plain
	   `<div>` so the `span4` cards are untouched. That narrowness is the reason
	   `.hdr-stat` — the rule this generalises — was dropped in the first place: a
	   right-aligned headline does not fit a third of the row beside a two-line
	   title (see the decisions section in main.css). Pass an aside from a
	   `span6`-or-wider card with a single-line title, and from nowhere else. */
	function widgetHead(icon, title, sub, hint, aside) {
		return (
			'<div class="card-head">' +
			icon +
			(aside ? '<div style="flex:1 1 220px;min-width:0">' : "<div>") +
			"<h2" +
			(hint ? ' class="has-hint" title="' + hintAttr(hint) + '"' : "") +
			">" +
			title +
			"</h2>" +
			(sub ? '<div class="sub">' + sub + "</div>" : "") +
			"</div>" +
			(aside
				? '<div class="spacer"></div><div style="text-align:right;margin-left:auto">' + aside + "</div>"
				: "") +
			"</div>"
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

	/* The left-aligned headline both memory-tier cards of the Decisions band carry —
	   Decisions itself (span8) and Memory Top Search Terms (span4): a big figure with
	   a qualifying line under it. They do NOT share a width, only this headline; no
	   card on the page is span6 (see main.css, where the class is documented as
	   unused).

	   It replaced `widgetHead`'s right-aligned `aside` on these two. That slot is
	   still there and still correct for Spend, whose head is one line and whose
	   figure is a single number; here the sub is a whole sentence naming two
	   denominators, and a sentence right-aligned against a card edge reads as a
	   caption for the title rather than for the number. */
	function cardHeadline(figure, sub) {
		return (
			'<div class="card-headline"><div class="num">' +
			figure +
			"</div>" +
			(sub ? '<div class="sub">' + sub + "</div>" : "") +
			"</div>"
		);
	}

	/* What this card counts and why it is worth looking at.
	   "What Jolli decided to keep" is gone: it described the STORE rather than
	   the reader's own work, and the card's subject is the decisions the reader's
	   sessions made — Jolli is what banked them, not what made them.

	   The last sentence exists because the card prints two numbers that look like
	   they should match and do not: `kept` counts DECISIONS while the grid counts
	   MEMORIES, and one memory can record several. Without it the card invites the
	   reader to find a bug that is not there. */
	var DECISIONS_HINT =
		"Decisions your sessions made, accumulating across the range — the knowledge Jolli banked, " +
		"with the receipts behind it. One square is one memory; a memory can record more than one decision, " +
		"so the kept count runs ahead of the filled squares.";

	/* Decisions (span8) — the corpus of decisions itself: a kept count, a waffle of
	   the window's memories (filled = recorded a decision), and the selected
	   memory's own detail underneath.

	   The waffle replaced a cumulative step chart, and the detail region replaced a
	   one-line "Latest ·" quote. Both changes are the same change: the card used to
	   assert a total and show one example of it, and now it shows the whole
	   population and lets the reader pick which example they want. That is also why
	   the cells are not capped — the count of squares IS the "N memories" figure in
	   the sub-line, so a truncated column would make the card contradict itself.

	   Carries no "recalled" figure — see DecisionsCard's doc comment in
	   DashboardModel.ts. */
	function decisionsCard(model) {
		var esc = JD.esc;
		var decisions = model.stats.decisions;
		var icon = widgetIcon(
			"--s4",
			'<path d="M9 18h6M10 22h4M12 2a6 6 0 0 0-4 10.4c.6.5 1 1.3 1 2.1V16h6v-1.5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 2Z"/>',
		);
		var open = '<section class="card span8" aria-label="Decisions">';

		if (!decisions) {
			return (
				open +
				widgetHead(icon, "Decisions", null, DECISIONS_HINT) +
				'<div class="locked-panel"><p><b>Decisions need a summarized commit.</b></p>' +
				"<p class=\"why\">Each decision is mined from a commit's memory — enable Jolli Memory to start " +
				"recording them.</p>" +
				'<button type="button" class="cta ghost" disabled>Enable Jolli Memory</button></div></section>'
			);
		}

		/* `N kept`, not a bare `N`: the sub under it names the nouns and the window,
		   so the figure has to carry the verb or it reads as a second total of
		   whatever the card counted.

		   Both denominators come from `stats`, NOT from a copy on the card: they are
		   the same `memoriesCreated` / `totalCommits` Memory Activity prints one card
		   down, and two copies of one figure on one page is how they come to differ. */
		var created = model.stats.memoriesCreated;
		var total = model.stats.totalCommits;
		var html =
			open +
			widgetHead(icon, "Decisions", null, DECISIONS_HINT) +
			cardHeadline(
				decisions.keptCount + " kept",
				created == null
					? ""
					: esc(created) +
							(created === 1 ? " memory, of " : " memories, of ") +
							esc(total) +
							(total === 1 ? " commit in this window" : " commits in this window"),
			);

		var selected = selectedDecisionCell(model);
		html +=
			'<div class="dec-chart">' +
			JD.decisionWaffle(decisions.perDay, selected ? { selectedKey: JD.decisionCellKey(selected) } : {}) +
			"</div>";

		/* The window's own bounds, off the payload rather than the range control:
		   `perDay` is what the picture above actually drew, so its first and last day
		   are the only labels that cannot disagree with it. */
		var firstDay = decisions.perDay[0];
		var lastDay = decisions.perDay[decisions.perDay.length - 1];
		if (firstDay && lastDay) {
			html +=
				'<div class="dec-axis"><span>' +
				esc(firstDay.date) +
				"</span><span>" +
				esc(lastDay.date) +
				"</span></div>";
		}
		html +=
			'<div class="heat-legend dec-legend"><span><i style="background:var(--s4)"></i>recorded a decision</span>' +
			'<span><i style="background:var(--heat-track)"></i>none recorded</span></div>';

		html += decisionDetail(model, selected);

		/* The footer carried a "kept, not merged" chip beside the repo count. It
		   was removed: it answered a question about how decisions are STORED that
		   nothing else on the page raises, so under the detail region it read as a
		   status on that memory rather than a note about the corpus.
		   The repo-count measure stays — it qualifies the numbers above it. */
		return (
			html +
			'<div class="w-foot"><span class="w-measure" aria-hidden="false">ⓘ across <b>' +
			decisions.repoCount +
			(decisions.repoCount === 1 ? " repo</b>" : " repos</b>") +
			" in this window</span></div></section>"
		);
	}

	/* Which cell the detail region is showing.

	   `JD.decisionCell` is the reader's click; `decisions.selected` is the server's
	   default (the last memory of the last day that has one, picked there because
	   "the last one" needs the tie-breakers only the query has). The click WINS, but
	   only while it still names a cell in the window on screen — changing the range
	   or the repo scope, or a poll that lands after that commit was rebased away,
	   must fall back rather than leave the region describing something the grid no
	   longer contains.

	   Both searches match on `JD.decisionCellKey`, never on the hash: under an
	   all-repos scope two repos can carry the same hash, and matching half the
	   identity returns whichever of them the payload happened to list first. */
	function selectedDecisionCell(model) {
		var decisions = model.stats.decisions;
		if (!decisions) return null;
		var want = JD.decisionCell;
		if (want) {
			for (var i = 0; i < decisions.perDay.length; i++) {
				var cells = decisions.perDay[i].cells;
				for (var j = 0; j < cells.length; j++) {
					if (JD.decisionCellKey(cells[j]) === want) return cells[j];
				}
			}
		}
		var fallback = decisions.selected;
		if (!fallback) return null;
		var fallbackKey = JD.decisionCellKey(fallback);
		for (var d = 0; d < decisions.perDay.length; d++) {
			var row = decisions.perDay[d].cells;
			for (var c = 0; c < row.length; c++) {
				if (JD.decisionCellKey(row[c]) === fallbackKey) return row[c];
			}
		}
		return null;
	}

	/* Which of the two "nothing is selected" states this is — and they are two
	   facts, not one.

	   They used to share one sentence, so "No memories in this window." printed
	   under a full waffle whose own sub-line said "38 memories": a card
	   contradicting itself on two adjacent lines, on first paint, with nothing to
	   click that would clear it. The cause is upstream — the payload simply omits
	   `selected` when the server could not read a default (see
	   `pickDefaultSelection`), and on the wire that is indistinguishable from an
	   empty window UNLESS the cells are consulted. They are right here, so this is
	   where the two are told apart.

	   The second sentence is an instruction rather than a diagnosis on purpose: the
	   reader cannot act on "this window's newest memories are children of squashed
	   ones", and every cell on screen is still clickable. */
	function emptyDetailReason(model) {
		var perDay = (model.stats.decisions || {}).perDay || [];
		var cells = 0;
		for (var i = 0; i < perDay.length; i++) cells += perDay[i].cells.length;
		return cells === 0 ? "No memories in this window." : "Pick a square to see the decisions behind it.";
	}

	/* The selected memory's detail. Three states, and none of them may be blank:

	   - the server inlined this cell's detail (the default selection) or a click has
	     already fetched it → render it;
	   - a click is in flight → say so, because the region is the only feedback the
	     click has;
	   - the window holds no memory at all → say THAT, which is a different fact from
	     "this memory recorded no decisions" and from "Jolli is not enabled". */
	function decisionDetail(model, cell) {
		var esc = JD.esc;
		if (!cell) {
			return '<div class="dec-detail is-empty">' + emptyDetailReason(model) + "</div>";
		}
		/* The HEAD is built from the CELL, which the payload already carries, so the
		   panel names the memory the moment it is clicked. Only the list waits on the
		   request — a panel that blanked entirely while loading would make every click
		   look like it had cleared the card. */
		var detail = detailForCell(model, cell);
		var chips = "";
		if (detail && detail.category)
			chips += '<span class="mem-activity-category">' + esc(detail.category) + "</span>";
		/* The repo chip earns its space only when the page is showing more than one —
		   under a single-repo scope every row would repeat what the topbar says. The
		   same rule Memory Activity's rows use. */
		if (JD.scopeIdentities(model).length !== 1 && detail && detail.repoName)
			chips += '<span class="tag">' + esc(detail.repoName) + "</span>";
		return (
			'<div class="dec-detail"><div class="dec-detail-head"><a class="dec-jump" href="' +
			memoryHref(model, cell.commitHash, cell.repoIdentity, TOPICS_ANCHOR) +
			'" target="_blank" rel="noopener"><strong>' +
			esc(cell.title || cell.commitHash.slice(0, 8)) +
			"</strong></a>" +
			chips +
			"</div>" +
			decisionList(model, cell, detail) +
			"</div>"
		);
	}

	/* The list under the head. Four states, and only one of them is silence-shaped:

	   - loaded with decisions → the rows;
	   - loaded with none → SAID, because a third of the squares are that and a blank
	     panel would read as a failure;
	   - still loading → said, because the click has no other feedback;
	   - failed → said, with the memory still named above it. */
	function decisionList(model, cell, detail) {
		var esc = JD.esc;
		if (!detail) {
			return JD.decisionCellError === JD.decisionCellKey(cell)
				? '<p class="dec-none">Could not load this memory\'s decisions.</p>'
				: '<p class="dec-none">Loading decisions…</p>';
		}
		var lines = detail.decisions || [];
		if (lines.length === 0) return '<p class="dec-none">This memory recorded no decisions.</p>';
		/* Each row is a LINK to the memory that recorded it, so it takes a link's
		   affordances — a hover ground, a focus ring, a pointer — rather than being a
		   `<li>` the reader cannot act on. The leading dot is decorative and marked as
		   such; a real list marker would be indented by the UA and would not line up
		   with the heading above. */
		return (
			'<div class="dec-list">' +
			lines
				.map(
					(line) =>
						'<a class="dec-row" href="' +
						/* ITS OWN topic, not the section header. Every row pointed at
						   `#what-changed` while this region showed one "latest decision";
						   listing several made that seven rows scrolling to one place. */
						memoryHref(model, cell.commitHash, cell.repoIdentity, TOPIC_ANCHOR_PREFIX + line.topicIndex) +
						'" target="_blank" rel="noopener"><span class="dec-dot" aria-hidden="true"></span><span>' +
						JD.mdInline(esc(line.title)) +
						"</span></a>",
				)
				.join("") +
			"</div>"
		);
	}

	/* One memory's detail, from whichever of the two places holds it: the payload's
	   inlined DEFAULT selection, or the click cache. ONE function, because "is it
	   already here?" has to have one answer — the renderer and the fetch both ask it,
	   and a fetch that disagreed would re-request something already on screen.

	   Takes the CELL, and keys on `JD.decisionCellKey`. Keyed on the hash alone this
	   was the sharpest edge of the collision: two repos sharing a hash have one cache
	   entry between them, so the second cell's click found the first repo's detail
	   already "to hand", never fetched, and rendered another project's decisions under
	   its own title. */
	function detailForCell(model, cell) {
		var key = JD.decisionCellKey(cell);
		var inlined = (model.stats.decisions || {}).selected;
		if (inlined && JD.decisionCellKey(inlined) === key) return inlined;
		return (JD.decisionCellDetail || {})[key] || null;
	}

	/* What this card counts, and the two things a reader will otherwise get wrong.

	   The scope sentence is not boilerplate: the MCPs card on this same page promises
	   it never reads tool ARGUMENTS out of a transcript, and a card listing search
	   text would read as that promise being broken. These are the reader's own
	   searches, observed where Jolli answered them.

	   The second is that a term is not a query. Several differently-worded searches
	   collapse onto one label, so a reader who opens a row and finds phrasings they
	   do not recognise as "the search" has not found a bug — that IS what a term is. */
	var TERMS_TINT = "--accent";

	var SEARCH_TERMS_HINT =
		"What you searched your own memory for, over the range. The query text stays on this machine. " +
		"A term is a phrase shared by several searches rather than one of them — open a row to read " +
		"the queries behind it.";

	/* Memory Top Search Terms (span4) — the one-third seat beside Decisions' span8.
	   Its rows page nowhere: the server sends the top few and the footer states the
	   whole, which is why this list passes no `list` to `rankedList` (no paging) and
	   uses the click for its own expansion instead of a jump to a detail page. */
	function searchTermsCard(model) {
		var esc = JD.esc;
		var terms = model.stats.searchTerms;
		/* `--accent`, the tint the mockup gives this card. It is not one of the
		   `--s1..--s5` series the other widgets draw from: this card is about the
		   reader's own actions rather than a category of their work, and the accent is
		   what the page already uses for "you did this". */
		var icon = widgetIcon(
			TERMS_TINT,
			'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>',
		);
		var open = '<section class="card span4" aria-label="Memory Top Search Terms">';
		var head = widgetHead(icon, "Memory Top Search Terms", null, SEARCH_TERMS_HINT);

		if (!terms) {
			return (
				open +
				head +
				'<div class="locked-panel"><p><b>Search needs memories to search.</b></p>' +
				'<p class="why">Enable Jolli Memory, and the searches you run against it appear here.</p>' +
				'<button type="button" class="cta ghost" disabled>Enable Jolli Memory</button></div></section>'
			);
		}

		/* Both figures are the server's own COUNT/SUM, never a sum of the rows on
		   screen: `rows` is capped, so adding up what is visible would under-report
		   the moment a seventh term exists. Same rule as the Skills card's sub-line.

		   "agent sessions", not "sessions": the count is DISTINCT over a session id
		   that is NULL for a search typed into a plain terminal, so a bare-terminal
		   search raises `searches` without raising this. Naming the qualifier is what
		   keeps the two numbers from reading as a contradiction. */
		var html =
			open +
			head +
			cardHeadline(
				esc(terms.searches) + (terms.searches === 1 ? " search" : " searches"),
				esc(terms.distinctQueries) +
					(terms.distinctQueries === 1 ? " distinct query · " : " distinct queries · ") +
					esc(terms.sessions) +
					(terms.sessions === 1 ? " agent session" : " agent sessions"),
			);

		if (terms.rows.length === 0) {
			return (
				html +
				'<div class="dec-detail is-empty">No searches in this window — run <code>jolli search</code>, ' +
				"or ask your agent to search, and they appear here.</div></section>"
			);
		}

		html += rankedList(
			terms.rows,
			TERMS_TINT,
			(row) => row.searches,
			null,
			(row) => row.term,
			null,
			"search",
			null,
			{
				plainLabel: true,
				expansionHtmlOf: searchTermExpansion,
				/* The whole row is the toggle, so it carries the same button semantics
				   the Skills/MCP rows use for their jump. */
				rowAttrs: (row) =>
					/* A row with nothing to reveal is plain text, not a dead button — see
					   `searchTermRevealsMore` for what counts as nothing. */
					!searchTermRevealsMore(row)
						? ""
						: /* `rl-term` on top of `rl-click`: the term underlines on hover to
							 say it discloses something, which the Skills/MCP rows must not
							 do — theirs navigate, and an underline there would promise a
							 link that opens a page rather than a panel. */
							' class="rl-click rl-term" tabindex="0" role="button" aria-expanded="' +
							String(JD.searchTermOpen === row.term) +
							'" data-search-term="' +
							JD.esc(row.term) +
							'"',
			},
		);

		/* `of {termCount}`, the server's own count of TERMS — not `distinctQueries`,
		   which is the figure in the sub-line above and counts phrasings. Several
		   phrasings collapse onto one term, so that denominator claimed rows that do
		   not exist ("Showing 3 of 43 terms" for a window holding three terms, all of
		   them on screen). No "Show more" — this list does not page, so a button that
		   could only ever be pressed once would be chrome pretending to be an
		   affordance. */
		html +=
			'<div class="more-row is-done"><span class="more-count">Showing ' +
			terms.rows.length +
			" of " +
			esc(terms.termCount) +
			(terms.termCount === 1 ? " term" : " terms") +
			"</span></div>";
		return html + "</section>";
	}

	/* One term's expansion — the queries it was extracted from.

	   No fetch and no state machine: these are the same strings the card already
	   loaded to compute the term, so a request to show them would be a round trip for
	   something in memory. That replaced an expansion which re-ran the SEARCH, needed
	   a per-repo Orama index, could not compare BM25 scores across repos, and answered
	   "what would this find today" to a question about what was asked. */
	/* Whether opening a row would show anything the row is not already showing.
	   Both halves of the disclosure ask this, so neither can offer a panel the other
	   renders empty.

	   Several phrasings: always. One phrasing: normally NOT — a lone query IS its own
	   label, so the panel would repeat the row verbatim. The exception is the case
	   this predicate exists for: `SEARCH_TERM_MAX` is 48 characters and a query is a
	   sentence, so `clampLabel` cuts most single-query labels and appends `…`. The
	   full text is right there in `queries[0]` and the row cannot show it — which
	   made the three longest rows on the card the only ones a reader could not open,
	   the exact opposite of where the text was. Keyed on the ellipsis rather than on
	   `queries[0] !== row.term`: `clampLabel` also trims, so a query with a leading
	   space would otherwise read as clamped. A query whose own text ends in `…` opens
	   a panel repeating it, which is the harmless direction to be wrong in. */
	function searchTermRevealsMore(row) {
		var queries = row.queries || [];
		if (queries.length > 1) return true;
		return queries.length === 1 && /…$/.test(row.term);
	}

	function searchTermExpansion(row) {
		if (JD.searchTermOpen !== row.term) return "";
		var queries = row.queries || [];
		/* The other half of the button `rowAttrs` withholds — see
		   `searchTermRevealsMore`. */
		if (!searchTermRevealsMore(row)) return "";
		return (
			'<div class="rl-expand">' +
			queries.map((query) => "<div>" + JD.esc(query) + "</div>").join("") +
			"</div>"
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

	/* Ranked rows shared by Skills and MCP servers: an optional lead mark, the
	   label, an optional kind, the value, and a bare colour bar underneath sized
	   against the top row. `list` names which pageable list this is, so
	   `capToolLists` can find the <ul> again after the render.

	   The two optional slots are on OPPOSITE sides of the label and are not
	   interchangeable. Skills puts its agent marks in the LEAD, where an icon
	   reads as an attribute of the name it precedes; the MCP lists put a count in
	   the trailing kind, where it reads as a qualifier. A single slot with a CSS
	   `order` flip was the cheaper version of this and is the wrong one — it
	   leaves the DOM saying the opposite of the screen, which is what a screen
	   reader and a copy-paste both get.

	   The two slots return different things, and each has exactly ONE contract —
	   a parameter that is raw for some callers and escaped for others is the trap
	   this avoids. The LEAD returns HTML, because it carries markup: its only
	   producer is `agentBadges`, which escapes the names inside its own marks.
	   The KIND returns `{ text, title }` and is escaped here, because its only
	   producer is `withAgents` and that text is transcript-derived. The row LABEL
	   is escaped here for the same reason.

	   Arguments run in the row's own left-to-right order (lead, label, kind,
	   value) so a call site reads like the row it builds.

	   `options` is a trailing OBJECT rather than a ninth positional argument, and
	   that is not a style preference: eight positions is already the limit of what a
	   call site can be read against, and a ninth would be a bare function literal
	   with nothing at the call site to say which slot it filled. It carries
	   `expansionHtmlOf(row)` today — a block rendered INSIDE the `<li>`, after the
	   bar. Not inside `.rl-top`: that is a flex row, and an extra child there spends
	   one of its 8px gaps and takes the width off the only thing that gives, which is
	   the name (see the truncation note above). */
	/* The plural of a row's unit, for the ONE place the page derives one instead of
	   writing both forms out.

	   Everywhere else — every headline, every sub-line, `standup.js` — spells the
	   singular and the plural as two literals, so English is the author's problem
	   and this function is not needed. `rankedList` cannot do that: it takes the
	   unit as a parameter, so it has to build the plural itself, and a bare `+ "s"`
	   is right for `run`, `call`, `tool` and `server` and wrong for the fifth unit
	   the page ever passed. The Search Terms card read `3 searchs`.

	   Sibilants only (`s`, `sh`, `ch`, `x`, `z` → `es`). Deliberately not an English
	   pluralizer: no `-y → -ies`, no irregulars. A unit that needs one of those is a
	   unit whose call site should pass the plural explicitly rather than grow a rule
	   table into a dashboard asset. */
	function pluralUnit(unit, value) {
		if (value === 1) return unit;
		return /(s|sh|ch|x|z)$/.test(unit) ? unit + "es" : unit + "s";
	}

	function rankedList(rows, colorVar, valueOf, leadHtmlOf, labelOf, kindOf, unit, list, options) {
		if (rows.length === 0) return "";
		var opts = options || {};
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
			/* TWO of the three lists open a detail view, and the third deliberately does
			   not: `skill` links into the Skills page and `server` into the MCPs page,
			   while the MCP TOOL list has no page of its own — a server is what
			   `/api/mcp-detail` answers about, and a row that looks clickable and does
			   nothing is worse than a row that does not.
			 *
			 * The attribute names the page's own selection parameter (`data-skill` →
			   `?skill=`, `data-mcp` → `?mcp=`), which is what the binder at the foot of
			   this file reads back. The server row's own identity is `row.server`, not
			   `row.name` — `McpServerRow` has no `name` field. */
			var clickable = opts.rowAttrs ? opts.rowAttrs(row) : "";
			if (list === "skill") {
				clickable =
					' class="rl-click" tabindex="0" role="button" data-skill="' +
					JD.esc(row.name) +
					'" title="Open detail for ' +
					JD.esc(row.name) +
					'"';
			} else if (list === "server") {
				clickable =
					' class="rl-click" tabindex="0" role="button" data-mcp="' +
					JD.esc(row.server) +
					'" title="Open detail for ' +
					JD.esc(row.server) +
					'"';
			}
			html +=
				"<li" +
				clickable +
				'><div class="rl-top">' +
				// Emitted for every row of a list that HAS a lead, including rows whose
				// own lead comes back empty. The span is a fixed-width column (see
				// .rl-lead), so skipping it on a row with no agents would put that row's
				// name 40px left of its neighbours' — the raggedness the fixed width
				// exists to remove, reintroduced by the empty case.
				(leadHtmlOf ? '<span class="rl-lead">' + leadHtmlOf(row) + "</span>" : "") +
				'<span class="rl-name' +
					/* Monospace is for IDENTIFIERS — a skill name, an MCP server — where
					   the shape of the string is part of reading it. A search term is
					   prose someone typed, and setting it in code type makes a phrase
					   look like a symbol. Opt-out rather than opt-in so the three
					   existing lists keep the face they shipped with. */
					(opts.plainLabel ? "" : " mono") +
					'" title="' +
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
				pluralUnit(unit, value) +
				"</span></div>" +
				'<div class="rl-bar"><i style="width:' +
				Math.round((value / top) * 100) +
				"%;background:var(" +
				colorVar +
				')"></i></div>' +
				(opts.expansionHtmlOf ? opts.expansionHtmlOf(row) : "") +
				"</li>";
		});
		return html + "</ul>";
	}

	/* Which agents are behind one ranked row — `claude`, or `codex · claude` when
	   more than one contributed. The names are `sessions.source` verbatim, the
	   same tag the Tokens chart's Agent axis prints, so the two panels can be
	   read against each other without a mapping in the reader's head.

	   This is the MCP lists' form of that signal, in the trailing kind slot;
	   Skills states the same thing as brand marks in the row's LEAD instead (see
	   `agentBadges`). Between them they are the only per-agent signal on either
	   card — the `by agent · 12 claude` header line that carried the same split
	   with volume was removed, so nothing states a whole-window per-agent total
	   any more.

	   Counts are deliberately left OFF the per-row tag: the row already prints
	   its own total beside the name, and a second set of numbers at that size
	   reads as noise. */
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

	/* The Skills row's LEAD: one brand mark per agent that ran the skill, in
	   place of the name list `agentTag` writes. It sits ahead of the skill name
	   rather than after it, which is where an icon belongs — the mark qualifies
	   the name, and reading it first means the eye picks up "who" before "what"
	   without scanning to the end of a truncating label. "Who ran this" is also a
	   question a logo answers faster than a word at 11px. The name is not lost:
	   it is each mark's tooltip and its accessible name, via `JD.sourceBadge`.

	   Ordered as the server sent them, which is `sortAgents` — by volume, so the
	   agent that ran the skill most leads. */
	/* How many marks the lead shows before it collapses the rest into `+N`.

	   The cap exists for ALIGNMENT, not for width: a lead that grows with the
	   agent count puts every skill name at a different x, and the names are the
	   column a reader scans. Two marks plus the row's 4px gap is exactly the
	   fixed width `.rl-lead` reserves, and `+N` occupies the second slot when it
	   is needed — so the name starts in the same place whether a skill was run by
	   one agent or five. Two rather than one because a skill shared between
	   Claude and Codex is a real and interesting case, where "+1" would hide the
	   more informative half of it. */
	var LEAD_AGENT_MARKS = 2;

	function agentBadges(row) {
		var agents = row.agents || [];
		if (agents.length === 0) return "";
		if (agents.length <= LEAD_AGENT_MARKS) return agents.map((a) => JD.sourceBadge(a.source)).join("");
		/* Past the cap the leading (highest-volume) agent keeps its mark and the
		   remainder becomes a count. The names are not dropped — they are the
		   counter's tooltip, which is the same bargain every mark makes. */
		var rest = agents.slice(1);
		return (
			JD.sourceBadge(agents[0].source) +
			'<span class="src-more" title="' +
			JD.esc(rest.map((a) => JD.sourceLabel(a.source)).join(", ")) +
			'">+' +
			rest.length +
			"</span>"
		);
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

	/* Skills (span4) — split out of the old combined "Skills & tools" card so
	   each half gets its own icon, stat line and footer, matching jolli-design's
	   per-card anatomy. Every row names the agents that ran it, rather than the
	   fixed list this used to carry (hard-coded to Claude, stale the day Codex
	   landed). The server still computes `ToolUsage.uncoveredSources` — the
	   agents whose transcripts cannot record a tool call at all — but no card
	   prints it: it was a second sentence in a footer that already states its own
	   denominator, and it named parser capability where a reader expects data. */
	/* Skill invocations only — NOT commands or subagents. `parseToolUse` promotes
	   a call to a skill row exactly when the tool is `Skill` and carries an
	   `input.skill` (TranscriptParser.ts); a subagent is the `Task` tool and
	   classifies as a builtin, and a slash command is a prompt expansion that
	   never becomes a tool call at all. Widening this sentence means widening
	   that classifier first. */
	/* The dagger is explained HERE rather than on the row, because this card has no
	   room for a footnote and the rows are already at their narrowest — the Skills page
	   the rows link into prints the full sentence under the figures it qualifies. The
	   mark itself still has to appear on the row: a skill shown clean here and daggered
	   one click later reads as two different measurements of the same thing. */
	var SKILLS_HINT =
		"Skill invocations, counted from the tool calls in your local transcripts. A skill invoked inside a " +
		"subagent counts once, against the session that spawned it. A † marks a skill whose use was inferred " +
		"from a command that read its file rather than observed, so its run count is per session.";

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
			agentBadges,
			/* The dagger rides IN the label rather than in a slot of its own. Both slots
			   are taken here — the lead carries `agentBadges`, and the kind is null on
			   purpose (see `rankedList`) — and the label is plain text escaped downstream,
			   which a bare `†` survives. It also lands in the row's `title`, so the mark
			   is reachable on hover even before the card head explains it. */
			(r) => "/" + r.name + (r.detection === "heuristic" ? " †" : ""),
			null,
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
			(usage.sessionsInWindow === 1 ? " session" : " sessions") +
			" in this window" +
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
					null,
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
				null,
				(r) => r.server,
				withAgents((r) => r.tools + (r.tools === 1 ? " tool" : " tools")),
				"call",
				"server",
			) + toolMoreRow(usage, "server")
		);
	}

	/* MCP servers (span4). Only some agents' transcripts can be read for tool
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
		   list (since removed from the card face too), and "the recall count is
		   MCP-tool calls only".

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
		JD.getJson(
			JD.withParams("/api/tool-usage" + JD.query(model, {}), {
				list: list,
				offset: String(rows.length),
				nowMs: model.generatedAtMs,
			}),
		)
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
			JD.withParams("/api/tool-usage" + JD.query(model, {}), {
				list: list,
				offset: "0",
				limit: String(width),
				nowMs: model.generatedAtMs,
			}),
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

		var top = JD.topSeries(stats.series, stats.seriesKeys, SERIES_LIMIT);
		var html = '<div class="legend" style="margin-top:8px">';
		top.keys.forEach((key, index) => {
			html +=
				'<span><i style="background:' +
				JD.seriesColor(index) +
				'"></i><span class="mono lg-key" title="' +
				JD.esc(key) +
				'">' +
				JD.esc(key) +
				'</span> <b class="num">' +
				JD.fmtTokens(top.byKey[key] || 0) +
				"</b></span>";
		});
		html += "</div>";
		return html + '<div class="chart-box" style="margin-top:16px">' + JD.stackedBars(top.series, top.keys, "tokens by " + wantDim) + "</div>";
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
		/* The empty state keeps a bare head: there is no figure to right-align,
		   and an aside reading "0" beside "No token data yet" says the same
		   nothing twice. */
		if (total === 0) {
			return (
				'<section class="card span4" aria-label="Tokens">' +
				widgetHead(icon, "Tokens", null, TOKENS_HINT) +
				'<div class="empty-note">No token data yet — Claude sessions report tokens; other agents count ' +
				"sessions only.</div></section>"
			);
		}

		/* Below the title, not right-aligned in the head — this card leads the
		   equal-third band now, and `widgetHead`'s aside is measured for a
		   `span6`-or-wider head: a third of a row has no room for icon + title +
		   figure on one line, which is the same reason Decisions kept its count
		   below the title while it held this seat. Same shape and 22px size it used
		   there, so the band has one way of printing a headline figure — inline,
		   because the `.bignum` class this markup carried across the swap has never
		   had a rule in main.css and was this card's only user, so it was dropped
		   rather than given one. The cache share rides on the sub as a second clause
		   rather than a second line — the aside's `<br>` was what made two lines
		   read as one right-aligned block, and there is no such block here. */
		var html =
			'<section class="card span4" aria-label="Tokens">' +
			widgetHead(icon, "Tokens", null, TOKENS_HINT) +
			'<div class="num" style="font-size:22px;font-weight:650;margin-top:2px">' +
			JD.fmtTokens(total) +
			'<div class="sub" style="font-weight:400;margin-top:2px">captured tokens · ' +
			Math.round((tb.cached / total) * 100) +
			"% of them cache</div></div>";

		var view = JD.tokSplitView || "type";
		html += tokensViewChips(view);
		html += tokensViewBody(stats, view);

		/* No footer. The three chips that were here — "Claude only", "cache is one
		   combined figure", "volume, not spend" — were caveats about how the
		   figures are SOURCED, not facts about this window, and the card already
		   answers each of them where a reader is looking: the legend names Input /
		   Output / Cache as three separate series, so the combined-cache point is
		   made by the chart rather than asserted under it; the headline says
		   "captured tokens"; and the ⓘ on the card head explains the rest. A
		   caveat that has to be read after the chart to correct it belongs in the
		   head, not in a strip below the fold. */
		return html + "</section>";
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

	/* Selecting a waffle cell.

	   The detail region for the DEFAULT cell rides on the payload, so the first paint
	   costs nothing; every other cell is one fetch, cached on `JD` so the 30 s repaint
	   neither loses it nor asks again. That split is what lets the cells stay uncapped
	   — see MemoryCell in DashboardModel.ts for why `category` and the bullets cannot
	   travel per cell.

	   ⚠ ONE listener on the waffle, never one per cell, and that follows from the same
	   "uncapped" rule. The cell count is the window's memory count, so a year on a busy
	   repo is a few thousand buttons — and `renderStats` rebuilds `#app` wholesale
	   every 30 s, so a per-cell binding is that many closures allocated and assigned on
	   every poll, for a control the reader touches once. Delegation makes the wiring
	   cost independent of the corpus.

	   No keydown handler: these are real `<button>` elements, so Enter and Space
	   already produce a click. The pair this replaced was written for a `div` carrying
	   `role="button"`, and against a real button it merely fired `pick` twice. */
	function wireDecisionCells(model) {
		var waffle = document.querySelector(".dec-waffle");
		if (!waffle) return;
		waffle.onclick = (event) => {
			var target = event.target;
			var cell = target && target.closest ? target.closest("[data-decision-cell]") : null;
			if (!cell) return;
			var hash = cell.getAttribute("data-decision-cell");
			var repo = cell.getAttribute("data-decision-repo");
			/* Both attributes, because either one alone is ambiguous across repos —
			   the short-circuit below is a REFUSAL to select, so a key missing its
			   repo half made the second of two same-hash cells permanently unclickable. */
			var key = JD.decisionCellKey({ repoIdentity: repo, commitHash: hash });
			/* Re-picking the cell already on screen is a no-op — EXCEPT when its last
			   fetch FAILED. The region is then showing "Could not load this memory's
			   decisions.", and clicking it again is the reader asking to retry; guarding
			   on the key alone made that the one cell the retry could not reach, so the
			   message sat there until they selected something else and came back. */
			if (JD.decisionCell === key && JD.decisionCellError !== key) return;
			JD.decisionCell = key;
			JD.decisionCellError = null;
			/* FETCH FIRST, paint second. The paint used to be a full `renderPage`
			   placed AHEAD of this call, so the request did not leave until every
			   card on the page had been rebuilt — all of that landed inside what the
			   reader experiences as "Loading decisions…". Measured, the server side
			   is 0.7 ms for the query and 14–35 ms for the round trip, so the wait
			   was never the network. */
			loadDecisionCell(model, repo, hash);
			paintDecisionSelection(model);
		};
	}

	/* Fetches one cell's detail, unless it is already to hand.

	   "Already to hand" includes the payload's inlined default, which is why this
	   asks `detailForCell` rather than only the cache — clicking back to the default
	   cell must not produce a request for something already on screen. */
	function loadDecisionCell(model, repoIdentity, commitHash) {
		var cell = { repoIdentity: repoIdentity, commitHash: commitHash };
		var key = JD.decisionCellKey(cell);
		if (detailForCell(model, cell)) return;
		JD.decisionCellDetail = JD.decisionCellDetail || {};
		/* `detailRepo`, NOT `repo`: `JD.query` already emits `repo=` for the page's
		   SCOPE, and a second one makes two — `URLSearchParams.get` returns the first,
		   so the endpoint received the scope's repo TOKEN (a display name) where it
		   expected this memory's identity and answered 404 for every click. The
		   `/memories` deep link carries the same field under the same name for exactly
		   this reason. */
		fetch("/api/memory-decisions" + JD.withParams(JD.query(model, {}), { detailRepo: repoIdentity, hash: commitHash }))
			.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
			.then((detail) => {
				JD.decisionCellDetail[key] = detail;
				repaintIfStillSelected(model, key);
			})
			.catch(() => {
				JD.decisionCellError = key;
				repaintIfStillSelected(model, key);
			});
	}

	/* Paints an answer only if it is still the answer to the question on screen —
	   a reader who clicked past this cell while the request was in flight must not
	   have the region yanked back to an older one.

	   ⚠ It asks `selectedDecisionCell`, NOT `JD.decisionCell`. Those differ for the
	   one cell nobody clicks: the DEFAULT selection leaves `JD.decisionCell` unset,
	   so a guard written as `JD.decisionCell === key` rejected the default
	   cell's own response and the panel sat on "Loading decisions…" until the next
	   30 s repaint happened to pick the cached answer up. The renderer decides what
	   is selected; anything guarding a paint has to ask it the same way. */
	function repaintIfStillSelected(model, key) {
		var cell = selectedDecisionCell(model);
		if (cell && JD.decisionCellKey(cell) === key) paintDecisionSelection(model);
	}

	/* Repaints ONLY what a selection changes: the ring, and the detail region.
	   `JD.renderPage` rebuilds every card on the page — slower than the request it
	   was waiting for, and destructive besides: it replaces the element under the
	   pointer, taking the focus ring off the button the reader just activated.

	   Returns quietly when the card is not on screen (another view, or a tier below
	   memory), so a late callback cannot throw into a page that has moved on. */
	function paintDecisionSelection(model) {
		var cell = selectedDecisionCell(model);
		if (!cell) return;
		var key = JD.decisionCellKey(cell);
		document.querySelectorAll("[data-decision-cell]").forEach((el) => {
			if (!el.classList) return;
			/* Rebuilt from the element's OWN two attributes, the same pair the ring is
			   rendered from — comparing the hash attribute alone lit a ring on every
			   repo that shares the hash, so one click showed two selections. */
			var elKey = JD.decisionCellKey({
				repoIdentity: el.getAttribute("data-decision-repo"),
				commitHash: el.getAttribute("data-decision-cell"),
			});
			el.classList.toggle("is-selected", elKey === key);
		});
		var region = document.querySelector(".dec-detail");
		if (region) region.outerHTML = decisionDetail(model, cell);
	}

	/* Expanding a search term.

	   A single-open accordion: two open expansions in a span4 card push the rest of
	   the list off the screen, and the question the expansion answers is about ONE
	   term. Clicking the open one closes it.

	   Pure view state — the queries are already on the payload, so this neither
	   fetches nor caches. It used to do both, against an endpoint that re-ran the
	   search; the whole machine went with it. */
	function wireSearchTerms(model) {
		document.querySelectorAll("[data-search-term]").forEach((rowEl) => {
			var term = rowEl.getAttribute("data-search-term");
			var toggle = () => {
				JD.searchTermOpen = JD.searchTermOpen === term ? null : term;
				JD.renderPage(model);
			};
			rowEl.onclick = toggle;
			rowEl.onkeydown = (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					toggle();
				}
			};
		});
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
		/* Three bands over the feed. The equal-third band leads with the three
		   summary widgets — what ran, what was called, how much of the model it
		   took. Under it, the memory band: what the work banked, and what the reader
		   went back and asked their memory for. Spend takes the row below that.

		   Spend takes the row under them, alone. It lost its seat beside Decisions when
		   Decisions grew to two thirds, and its chart does not mind the full width (it
		   draws with `preserveAspectRatio="none"`). It stays ABOVE the memory band
		   rather than below it because the three cards over it are all "what ran and
		   what it cost" — Spend closes that thought, and the memory band below opens a
		   different one.

		   Decisions and Search are paired because they are two halves of that second
		   thought — what got written down, and what got looked up — and because both
		   are memory-tier cards that go dark together. They are NOT equals: Decisions
		   takes eight columns for a per-day chart of every memory in the window plus
		   the selected one's decisions, Search four for six ranked rows.

		   What the arrangement gives up is Tokens sitting BESIDE Spend — they are
		   one question in two units (see TOKENS_HINT, and the reason a rising cached
		   share moves them in opposite directions), and that comparison is a scroll
		   apart rather than side by side. */
		var html = skillsCard(model);
		html += mcpCard(model);
		html += tokensCard(model);

		html += costCard(model);

		html += decisionsCard(model); // span8
		html += searchTermsCard(model); // span4

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

		wireDecisionCells(model);
		wireSearchTerms(model);

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

		/* The Skills and MCP-server rows LINK INTO their own pages, each of which has a
		   reading pane. They used to open a modal over this card — a second renderer of
		   the same figures, and one that could not be shared or reloaded. `?skill=` and
		   `?mcp=` are those pages' own selection state, so this navigation and a click
		   over there land on the identical view.

		   Re-bound on every repaint like the button above, because a repaint replaces
		   the whole of `#app` and takes the old rows' handlers with it.

		   Keyboard as well as pointer: the row carries `role="button"` and a tabindex,
		   so leaving it click-only would put a focusable control on the page that the
		   keyboard cannot activate.

		   ONE BINDER, TABLE-DRIVEN, because the two differ only in which attribute
		   carries the identity and which view receives it — and a second copy of this
		   loop is a second place for the `JD.viewPath` rule below to be forgotten. */
		[
			{ attribute: "data-skill", param: "skill", view: "skills" },
			{ attribute: "data-mcp", param: "mcp", view: "mcps" },
		].forEach((link) => {
			document.querySelectorAll("[" + link.attribute + "]").forEach((row) => {
				var open = () => {
					/* Through `JD.viewPath`, never a literal "/skills": that table is the one
					   place a view's URL is spelled, so the nav row and this link cannot end up
					   disagreeing about where the page lives. */
					var params = {};
					params[link.param] = row.getAttribute(link.attribute);
					window.location.href = JD.viewPath(link.view) + JD.withParams(JD.query(model, {}), params);
				};
				row.onclick = open;
				row.onkeydown = (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						open();
					}
				};
			});
		});
	};

	/* Registered unconditionally — every view loads this module, and the hook's own
	   `view !== "stats"` guard is what scopes it. See `JD.carryForwardHooks`. */
	JD.carryForwardHooks.push(carryForwardToolLists);
})(window.JD);
