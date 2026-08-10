window.JD = window.JD || {};

((JD) => {
	var RANGE_SUB = { today: "Today", week: "Last 7 days", "2w": "Last 14 days", month: "Last 30 days", "3m": "Last 90 days" };

	/* Prose name for the window a model was built over. A custom range has no
	   name, so it states its own bounds — which are the resolved ones, so a
	   clamped request reads as the window it actually got. */
	function rangeSub(stats) {
		return RANGE_SUB[stats.range] || stats.rangeFrom + " → " + stats.rangeTo;
	}

	/* The mockup's group-by axes. `lockTier: 1` reads the memory-enriched commit
	   columns; `project` is unlocked here because repo grouping needs no memory. */
	var GROUPS = [
		{ key: "model", label: "Model", memoryOnly: false },
		{ key: "agent", label: "Agent", memoryOnly: false },
		{ key: "project", label: "Project", memoryOnly: false },
		{ key: "branch", label: "Branch", memoryOnly: true },
		{ key: "ticket", label: "Ticket", memoryOnly: true },
		{ key: "category", label: "Work category", memoryOnly: true },
	];

	/* Per-axis footnote, quoting the mockup's own wording where it applies. */
	var AXIS_NOTE = {
		model: "Token coverage: <b>Claude ✓</b> · Codex, Cursor, Copilot report sessions only until usage parsing lands.",
		agent: "Sessions and tokens per agent. Cost shown where the transcript reports usage.",
		project: "Tokens per repository, across every agent.",
		branch: "A commit reachable from several branches counts on each — the axis answers where spend landed.",
		ticket: "Commits with no ticket are grouped as <span class=\"mono\">(no ticket)</span>.",
		category: "Work category is the dominant topic category of each commit's memory.",
	};

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

		var html =
			'<section class="card span12" aria-label="Spend"><div class="card-head">' +
			widgetIcon("--s4", '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-4 4"/>') +
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
		/* `detailRepo` names the memory's owning repo without scoping the page it
		   lands on — see wireTree in memories.js. Whatever scope THIS page carries
		   rides along through JD.query, so a repo-filtered dashboard still opens a
		   repo-filtered tree. */
		var openHref = (card) =>
			"/memories" +
			JD.withParams(JD.query(model, {}), { hash: card.commitHash, detailRepo: card.repoIdentity });
		var row = (card) => {
			var meta = [];
			if (card.category) meta.push('<span class="mem-activity-category">' + esc(card.category) + "</span>");
			if (card.turns != null) meta.push('<span class="tag metric num">' + esc(card.turns) + " turns</span>");
			if (card.branch && view === "time") meta.push('<span class="tag mono">' + esc(card.branch) + "</span>");
			if (model.scope.kind !== "repo") meta.push('<span class="tag">' + esc(card.repoName) + "</span>");
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

	/* The captured/gap/decision counts atop Memory Activity. `totalCommits` is
	   present at every tier, but this card never renders below the memory tier
	   (see the early return above), so `memoriesCreated`/`decisionsCaptured`
	   are never actually undefined here — the null checks are for a stale or
	   hand-built model, not a real code path. Gaps are commits with no memory
	   row at all (see CommitRow.root_hash), not commits missing turns/tokens —
	   a sparse-but-real memory must not count as a gap. */
	function memoryCoverageStats(model) {
		var captured = model.stats.memoriesCreated;
		var total = model.stats.totalCommits;
		var decisionsCount = model.stats.decisionsCaptured;
		if (captured == null || total == null) return "";
		var gaps = Math.max(0, total - captured);
		return (
			'<div class="mem-activity-stats">' +
			'<div class="mas-item"><b class="num">' +
			captured +
			'</b><span>of ' +
			total +
			" captured</span></div>" +
			(gaps > 0
				? '<div class="mas-item mas-warn"><b class="num">' + gaps + "</b><span>" + (gaps === 1 ? "gap" : "gaps") + "</span></div>"
				: "") +
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
	   chevron, no button element. */
	function widgetHead(icon, title, sub) {
		return (
			'<div class="card-head">' +
			icon +
			"<div><h2>" +
			title +
			'</h2><div class="sub">' +
			sub +
			"</div></div></div>"
		);
	}

	/* Decisions (span6) — the corpus of decisions itself: kept count, a
	   cumulative step chart, the latest one verbatim. Distinct from the KPI
	   sub-line (gone with the KPI strip) and from the feed's per-commit
	   `decision` line — this is the standalone widget those always implied but
	   never had. Pairs with the Recall lockedCard below: what got kept, and
	   whether it came back. Carries no "recalled" figure — see DecisionsCard's
	   doc comment in DashboardModel.ts. */
	function decisionsCard(model) {
		var esc = JD.esc;
		var decisions = model.stats.decisions;
		var icon = widgetIcon(
			"--s1",
			'<path d="M9 18h6M10 22h4M12 2a6 6 0 0 0-4 10.4c.6.5 1 1.3 1 2.1V16h6v-1.5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 2Z"/>',
		);
		var head =
			'<section class="card span6" aria-label="Decisions"><div class="card-head">' + icon + "<div><h2>Decisions</h2>" +
			'<div class="sub">What Jolli decided to keep, and whether it came back</div></div>';

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

		if (decisions.latest) {
			html +=
				'<div class="dec-quote"><span class="qlab">Latest · ' +
				esc(decisions.latest.repoName) +
				"</span>“" +
				JD.mdInline(esc(decisions.latest.gist || decisions.latest.text)) +
				"”</div>";
		}

		return (
			html +
			'<div class="w-foot"><span class="w-chip">kept, not merged</span>' +
			'<span class="w-measure" aria-hidden="false">ⓘ across <b>' +
			decisions.repoCount +
			(decisions.repoCount === 1 ? " repo</b>" : " repos</b>") +
			" in this window</span></div></section>"
		);
	}

	/* Recall (span6) — pairs with Decisions: what got kept, and whether it came
	   back. One row per call, written by the surface that served it (see
	   RecallUsage), so unlike Skills/MCPs this card carries no coverage caveat:
	   a `jolli recall` in a plain terminal counts exactly as much as the MCP
	   tool in a Claude session. The one thing it cannot attribute to a session
	   is a call made outside any agent — hence the wording of the footnote. */
	function recallCard(model) {
		var esc = JD.esc;
		var usage = model.stats.recallUsage;
		var icon = widgetIcon("--s2", '<path d="M3 12a9 9 0 1 0 2.6-6.3"/><path d="M3 4v5h5"/>');
		var head =
			'<section class="card span6" aria-label="Recall"><div class="card-head">' +
			icon +
			"<div><h2>Recall</h2>" +
			'<div class="sub">What prior memory got pulled back into a session</div></div>';

		var totalCalls = usage.usedCalls + usage.setAsideCalls;
		var noReceipt = usage.callsWithoutReceipt || 0;
		/* Receipts only exist from the day they shipped, and nothing can rebuild
		   them — but the CALL survives in the transcripts, so a window with only
		   history says "recall ran N times, outcome not recorded" rather than the
		   empty panel, which read as "recall was never used".
		   Still no hit rate — that cannot be derived from a call count — but it
		   DOES now carry the chart. The original "no chart either" was right while
		   the daily series knew nothing about receipt-less calls; now that the
		   `jollimemory` reference's own timestamps reach `daily[].estimated`, the
		   days those calls fell on are real data, and withholding the chart was
		   the reason a window of pure history looked like the feature was dead. */
		var hasEstimatedDays = (usage.daily || []).some((d) => d.estimated > 0);
		if (totalCalls === 0 && noReceipt > 0) {
			return (
				head +
				'<div class="hdr-stat"><b class="num">' +
				noReceipt +
				" called</b><span>" +
				esc(rangeSub(model.stats)) +
				"</span></div>" +
				'<div class="spacer"></div></div>' +
				(hasEstimatedDays
					? '<div style="margin-top:8px">' +
						JD.recallBars(usage.daily, usage.receiptsSinceDate) +
						'<div class="legend" style="margin-top:6px">' +
						'<span><i style="background:var(--heat-track)"></i>called, outcome not recorded (at least)</span>' +
						"</div></div>"
					: "") +
				'<div class="locked-panel"><p><b>Recall ran ' +
				noReceipt +
				"&times; here, but nothing recorded what it returned.</b></p>" +
				'<p class="why">These calls come from the agent transcripts. Whether each one ' +
				"served usable context is only recorded from the call itself, which older " +
				"runs pre-date — newer calls show their hit rate here." +
				(hasEstimatedDays
					? " The chart above places them by date, from the one channel that timestamps each call — " +
						"a repeated query collapses to a single entry there, so each day is a floor, not a count."
					: "") +
				(usage.skillInvocations > 0
					? " The <code>jolli-recall</code> skill ran <b>" + usage.skillInvocations + "</b>&times; in the same window."
					: "") +
				(usage.skillRunsWithoutTrace > 0
					? " <b>" +
						usage.skillRunsWithoutTrace +
						"</b> of those left no other trace — the skill's CLI fallback, which older builds recorded nowhere."
					: "") +
				"</p></div></section>"
			);
		}
		if (totalCalls === 0) {
			return (
				head +
				'<div class="spacer"></div></div>' +
				'<div class="locked-panel"><p><b>No recall calls recorded in this window.</b></p>' +
				'<p class="why">Run <code>jolli recall</code>, or let an agent call the recall tool, ' +
				"and it shows up here as it happens." +
				/* "without recalling anything" is only safe to say when nothing
				   suggests otherwise: a skill run with no trace is just as likely to
				   have recalled through the CLI fallback and had its receipt land
				   with no session to attribute it to. */
				(usage.skillInvocations > 0
					? usage.skillRunsWithoutTrace > 0
						? " The <code>jolli-recall</code> skill ran <b>" +
							usage.skillInvocations +
							"</b>&times; here, <b>" +
							usage.skillRunsWithoutTrace +
							"</b> of them leaving no record of what came back."
						: " The <code>jolli-recall</code> skill ran <b>" +
							usage.skillInvocations +
							"</b>&times; in this window without recalling anything."
					: "") +
				"</p></div></section>"
			);
		}

		var html =
			head +
			'<div class="hdr-stat"><b class="num">' +
			usage.usedCalls +
			' used</b><span>' +
			esc(rangeSub(model.stats)) +
			"</span></div>" +
			'<div class="spacer"></div></div>';

		html +=
			'<div style="display:flex;gap:20px;align-items:flex-start;margin-top:8px;flex-wrap:wrap">' +
			'<div style="flex:1;min-width:220px">' +
			JD.recallBars(usage.daily, usage.receiptsSinceDate) +
			'<div class="legend" style="margin-top:6px">' +
			'<span><i style="background:var(--accent)"></i>the model used it</span>' +
			'<span><i style="background:var(--muted)"></i>set aside</span>' +
			/* Only when the window actually holds such a day: this is the rare
			   channel (pre-receipt history), and a permanent third legend entry
			   would suggest every chart has one. */
			(hasEstimatedDays
				? '<span><i style="background:var(--heat-track)"></i>outcome not recorded</span>'
				: "") +
			"</div></div>" +
			'<div style="min-width:170px">' +
			statRows(
				[
					["Used", usage.usedCalls],
					["Context served", usage.contextServedPct + "%"],
					[
						"Memories",
						usage.distinctMemoriesUsed + (usage.staleMemoriesUsed > 0 ? " · " + usage.staleMemoriesUsed + " older than 30d" : ""),
					],
				].concat(
					/* The skill's own row, on the card FACE. It is not a call and must
					   never move the three figures above — but computing it and then
					   printing it only inside the ⓘ's `title` attribute was how six
					   recall rows in the database rendered as "3 used" with nothing
					   visible to account for the other three. A hover is not a surface.
					   Suppressed at zero, like every other conditional figure here. */
					usage.skillInvocations > 0
						? [
								[
									"Skill runs",
									usage.skillInvocations +
										(usage.skillRunsWithoutTrace > 0
											? " · " + usage.skillRunsWithoutTrace + " with no recorded outcome"
											: ""),
								],
							]
						: [],
				),
			) +
			"</div></div>";

		/* ONE line, which is what the design carries: the coverage ratio and
		   nothing else. The four `·`-joined clauses this used to print were added
		   one at a time, each defensible alone, and together they were unreadable
		   — a reader could not tell which number the caveats even applied to.
		   They are not deleted, they move to the ⓘ's hover: a caveat that
		   qualifies a figure belongs next to it, but it does not belong in the
		   reader's way every time they glance at the card. */
		var note = "<b>" + usage.sessionsWithContext + "</b> of " + usage.sessionsInWindow + " sessions got prior context";

		/* Plain text, not markup — this becomes a `title` attribute, where tags
		   would render literally. */
		var detail = [];
		if (usage.bySurface.length > 0) {
			detail.push(
				usage.bySurface
					.map((row) => row.calls + " via " + (row.surface === "mcp" ? "the recall tool" : "the CLI"))
					.join(", "),
			);
		}
		/* Skill invocations sit OUTSIDE the counts above on purpose: a skill run
		   that goes on to recall already wrote its own receipt, so folding it in
		   would count that call twice. What it adds is the gap — invoked, never
		   recalled — which is why it is only worth mentioning when there is one. */
		if (usage.skillInvocations > usage.usedCalls + usage.setAsideCalls) {
			detail.push("the jolli-recall skill ran " + usage.skillInvocations + "×, more often than recall was called");
		}
		/* The gap's most likely explanation, stated where the gap is stated. */
		if (usage.skillRunsWithoutTrace > 0) {
			detail.push(
				usage.skillRunsWithoutTrace +
					" skill " +
					(usage.skillRunsWithoutTrace === 1 ? "run" : "runs") +
					" left no MCP call and no attributable receipt — typically the CLI fallback on a host that reports no session id",
			);
		}
		/* Mixed window: some calls have receipts, some pre-date them. Kept so the
		   percentage above is read as covering only the receipted ones. */
		if (noReceipt > 0) {
			detail.push(
				noReceipt +
					" further " +
					(noReceipt === 1 ? "call is" : "calls are") +
					" in the transcripts with no recorded outcome",
			);
		}
		/* Only when there actually IS such a call, counted server-side. Printed
		   unconditionally, it raised a caveat that did not apply — on a machine
		   whose every recall carries a session id it described a situation that
		   cannot occur. The first attempt at a condition tested
		   `sessionsWithContext === 0`, which reads as "no session claims these
		   calls" but actually means "not one receipt in the window names a
		   session" — so the mixed window this caveat is FOR (some calls inside a
		   session, some at a shell prompt) was precisely the case it stayed
		   silent for. `callsWithoutSession` is the statement itself. */
		if (usage.callsWithoutSession > 0) {
			detail.push(
				usage.callsWithoutSession +
					(usage.callsWithoutSession === 1 ? " recall ran" : " recalls ran") +
					" outside an agent session, counting above but belonging to no session",
			);
		}
		return (
			html +
			'<div class="w-foot"><span class="w-measure"' +
			(detail.length > 0 ? ' title="' + esc(detail.join(" · ")) + '"' : "") +
			">ⓘ " +
			note +
			"</span></div></section>"
		);
	}

	/* Ranked rows shared by Skills and MCP servers: label (+ optional kind),
	   value, a bare colour bar underneath sized against the top row. */
	function rankedList(rows, colorVar, valueOf, labelOf, kindOf, unit) {
		if (rows.length === 0) return "";
		var top = valueOf(rows[0]) || 1;
		var html = '<ul class="ranklist">';
		rows.forEach((row) => {
			var value = valueOf(row);
			// The name truncates with an ellipsis (see .rl-name), so the full text
			// has to survive somewhere the reader can get at it.
			var label = labelOf(row);
			html +=
				'<li><div class="rl-top"><span class="rl-name mono" title="' +
				JD.esc(label) +
				'">' +
				JD.esc(label) +
				"</span>" +
				(kindOf ? '<span class="rl-kind">' + JD.esc(kindOf(row)) + "</span>" : "") +
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

	/* Skills (span6) — split out of the old combined "Skills & tools" card so
	   each half gets its own icon, stat line and footer, matching jolli-design's
	   per-card anatomy. Claude-only by construction, like the card it replaces. */
	function skillsCard(model) {
		var usage = model.stats.toolUsage;
		var icon = widgetIcon(
			"--s2",
			'<path d="m12 3-1.9 4.6L5 9l4.1 3.4L7.8 17 12 14.4 16.2 17l-1.3-4.6L19 9l-5.1-1.4Z"/>',
		);
		var html =
			'<section class="card span4" aria-label="Skills">' +
			widgetHead(icon, "Skills", "What actually runs, from local transcripts");

		if (usage.skills.length === 0) {
			return (
				html +
				'<div class="empty-note">No skill invocations recorded in this window. Only Claude transcripts ' +
				"carry them.</div></section>"
			);
		}

		var totalRuns = usage.skills.reduce((sum, r) => sum + r.calls, 0);
		html +=
			'<div class="sub" style="margin-top:2px">' +
			totalRuns +
			(totalRuns === 1 ? " run · " : " runs · ") +
			usage.skills.length +
			(usage.skills.length === 1 ? " skill</div>" : " skills</div>");

		html += rankedList(
			usage.skills,
			"--s2",
			(r) => r.calls,
			(r) => "/" + r.name,
			null,
			"run",
		);

		return (
			html +
			'<div class="w-foot"><span class="w-measure">ⓘ from <b>' +
			usage.sessionsWithTools +
			"</b> of " +
			usage.sessionsInWindow +
			(usage.sessionsInWindow === 1 ? " session</b>" : " sessions") +
			" in this window</span></div></section>"
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
			'<div class="chips" role="group" aria-label="Split by" style="margin-top:10px">' +
			'<button type="button" class="chip" data-mcpsplit="server" aria-pressed="' +
			String(view === "server") +
			'">By server</button>' +
			'<button type="button" class="chip" data-mcpsplit="tool" aria-pressed="' +
			String(view === "tool") +
			'">By tool</button></div>'
		);
	}

	function mcpViewList(usage, view) {
		if (view === "tool") {
			if (usage.mcpTools.length === 0) return '<div class="empty-note">No individual MCP tool calls recorded in this window.</div>';
			return rankedList(
				usage.mcpTools,
				"--s1",
				(r) => r.calls,
				(r) => r.name,
				(r) => r.sessions + (r.sessions === 1 ? " session" : " sessions"),
				"call",
			);
		}
		return rankedList(
			usage.servers,
			"--s1",
			(r) => r.calls,
			(r) => r.server,
			(r) => r.tools + (r.tools === 1 ? " tool" : " tools"),
			"call",
		);
	}

	/* MCP servers (span6). Claude-only by construction, so the coverage line
	   is mandatory: without it, "3 sessions" reads as 3 of everything rather
	   than 3 of the sessions this build can actually see inside. Deliberately
	   no "N of M servers called" figure — that needs the full registered-server
	   list, which lives in MCP registration config, not in captured tool calls;
	   see ToolUsage in DashboardModel. */
	function mcpCard(model) {
		var esc = JD.esc;
		var usage = model.stats.toolUsage;
		var icon = widgetIcon(
			"--s1",
			'<path d="M12 22v-6M9 8V2M15 8V2M6 8h12l-1 6a5 5 0 0 1-10 0Z"/>',
		);
		var html =
			'<section class="card span4" aria-label="MCPs">' +
			widgetHead(icon, "MCPs", "What the agent is calling");

		if (usage.servers.length === 0) {
			return (
				html +
				'<div class="empty-note">No MCP calls recorded in this window. Only Claude transcripts carry them.' +
				"</div></section>"
			);
		}

		var totalCalls = usage.servers.reduce((sum, r) => sum + r.calls, 0);
		html +=
			'<div class="sub" style="margin-top:2px">' +
			usage.servers.length +
			(usage.servers.length === 1 ? " server · " : " servers · ") +
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

		var note = "from <b>" + usage.sessionsWithTools + "</b> of " + usage.sessionsInWindow + " sessions in this window";
		if (usage.uncoveredSources.length > 0) {
			note +=
				" · <b>" +
				esc(usage.uncoveredSources.join(", ")) +
				"</b> record no tool calls, so a server used only from those agents will not appear here";
		}
		if (usage.recallCalls) {
			note +=
				" · recall count is MCP-tool calls only — a bare <code>jolli recall</code> run or the skill's CLI " +
				"fallback isn't recorded here";
		}
		note +=
			" · older activity is reconstructed from commits and stored summaries; recent sessions are exact";
		return html + '<div class="w-foot"><span class="w-measure mcp-card-note">ⓘ ' + note + "</span></div></section>";
	}

	/* Where your tokens went (span4) — input/output/cache, day-bucketed. Reuses
	   `JD.stackedBars` (the same chart Cost & tokens draws) rather than a
	   one-off SVG, so the two cards read as the same chart language. `cached`
	   is one combined figure, not a cache-write/cache-read split — the database
	   only stores one column for it (see `TokenBreakdown` in DashboardModel.ts),
	   so splitting it would mean assuming a ratio instead of measuring one. */
	var TOKEN_TYPE_KEYS = ["Input", "Output", "Cache"];
	var TOK_VIEW_LABEL = { model: "Model", project: "Project" };

	/* Split-by tabs, inside the card and nowhere else. Picking "By model"/"By
	   repo" re-fetches exactly the way Cost & tokens' own group-by chips do,
	   because both read `JD.dimension`. */
	function tokensViewChips(view) {
		return (
			'<div class="chips" role="group" aria-label="Split by" style="margin-top:10px">' +
			'<button type="button" class="chip" data-toksplit="type" aria-pressed="' +
			String(view === "type") +
			'">By type</button>' +
			'<button type="button" class="chip" data-toksplit="model" aria-pressed="' +
			String(view === "model") +
			'">By model</button>' +
			'<button type="button" class="chip" data-toksplit="repo" aria-pressed="' +
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

	function tokensCard(model) {
		var stats = model.stats;
		var tb = stats.tokenBreakdown;
		var total = tb.input + tb.output + tb.cached;
		var icon = widgetIcon("--s3", '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>');
		var html =
			'<section class="card span4" aria-label="Where your tokens went">' +
			widgetHead(icon, "Where your tokens went", JD.esc(rangeSub(stats)));

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

	/* Feed-card category colours. The first five and their palette slots are the
	   mockup's (`CAT_VAR`: bugfix→s2, feature→s1, refactor→s3, tech-debt→s4,
	   docs→s5); the rest are categories our summarizer actually emits. A fixed
	   order rather than a hash — same reasoning as `JD.sourceIndex`: the colour
	   for a category must not move when the set of categories changes. Anything
	   unlisted lands on the last slot. */
	var CATEGORY_ORDER = ["feature", "bugfix", "refactor", "tech-debt", "docs", "ux", "performance", "devops"];
	function catColor(category) {
		var index = CATEGORY_ORDER.indexOf(category);
		return JD.seriesColor(index >= 0 ? index : CATEGORY_ORDER.length);
	}

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
		/* Cross-repo scope: name the repo, the way the session feed does. */
		if (model.scope.kind !== "repo" && card.repoName) chips += '<span class="tag">' + esc(card.repoName) + "</span>";

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
			'<div class="spacer"></div>' +
			JD.scopeChip(model) +
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

	JD.renderStats = (model) => {
		var stats = model.stats;
		/* Order follows jolli-design's own Dashboard route (confirmed against a
		   real screenshot of it): the equal-third band (what runs, what's
		   called, what it cost in tokens) leads, then spend over time, then
		   decisions/recall, then the feed, then the two lower-priority cards. */
		var html = skillsCard(model);
		html += mcpCard(model);
		html += tokensCard(model);

		html += costCard(model);

		/* Decisions pairs with Recall — what got kept, and whether it came back. */
		html += decisionsCard(model);
		html += recallCard(model);

		/* The session-activity card (heatmap, hour histogram, records, share card)
		   was removed — `stats.heatmap` / `stats.hours` / `stats.fun` stay in the
		   payload, so restoring it is a render change only. */
		html += feedCard(model);

		document.getElementById("app").innerHTML = html;

		/* Group-by chips: re-fetch the model along the picked axis (the axis is a
		   server-side query, so it needs a round trip). */
		document.querySelectorAll(".chips .chip[data-dim]").forEach((chip) => {
			chip.onclick = () => {
				JD.dimension = chip.getAttribute("data-dim");
				JD.refreshNow(JD.renderPage);
			};
		});

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

	};
})(window.JD);
