(() => {
	var JD = window.JD;

	/* The page model the coaching view rendered under. `openFeedModal` reads the
	   window bounds from it, `openTrace` reads scope/timeZone, and the feed's
	   row clicks need it to open the trace. Parked once in `renderCoaching`
	   rather than threaded through every click handler. */
	var pageModel = null;
	/* The whole `JourneysModel` the feed modal fetched. Set once per page load
	   (the modal's own "already fetched" guard reads it); `openTrace` reads the
	   window bounds back off it so a trace always resolves under the grouping
	   the feed actually drew. */
	JD.feedModel = null;

	/* Mark vocabulary ported from the cloud's JourneyGlyph. Two marks are
	   deliberately absent rather than drawn empty — friction and review are
	   pinned unavailable locally, and an unmeasured signal must draw NOTHING.
	   A zero-length bar or a hollow tick is a measurement claim nobody made. */
	var FEED_WIDTH = 170;
	var HEIGHT = 16;
	/* Bar width when the work signal was never measured. Fixed and neutral, so
	   an unmeasured journey does not read as an instantaneous one. */
	var UNMEASURED_BAR = 26;
	/* Floor for a MEASURED bar — strictly greater than UNMEASURED_BAR, so a
	   measured journey can never render narrower than one nothing was measured
	   on. Width is the channel the reader compares; a measured bar reading
	   *smaller* than an unmeasured one would be a worse lie than a constant bar. */
	var MIN_MEASURED_BAR = 30;
	/* The bar encodes TURNS, not minutes: duration is measurable on ~6% of
	   local journeys and turns on 99%, so a duration bar would render every row
	   identically. Because the mark's meaning changed, every label changed with
	   it — nothing here may say "time".
	   Recalibrated from a live measurement of summed turns per journey: p90 is
	   ~30 and the observed max is well under 120 (the old ceiling), which had
	   put roughly three-quarters of bars within a few px of UNMEASURED_BAR — a
	   feed whose primary visual barely varied. 40 sits just above that p90, so
	   the common case still spans real width instead of pooling near the floor. */
	var MAX_TURNS = 40;

	JD.journeyGlyph = (journey) => {
		var track = FEED_WIDTH - 10;
		var measured = journey.availability.turns !== "unavailable" && journey.turns !== null;
		/* sqrt, not linear: it spreads the common low-turn case (most journeys)
		   across more of the track instead of a linear scale, which would still
		   crowd everything under ~10 turns into a few px above the floor. */
		var barWidth = measured
			? Math.round(
					MIN_MEASURED_BAR +
						Math.sqrt(Math.min(journey.turns, MAX_TURNS) / MAX_TURNS) * (track - MIN_MEASURED_BAR),
				)
			: UNMEASURED_BAR;
		var label = measured ? journey.turns + " turns" : "turns not measured";
		var parts = [
			'<rect class="glyph-bar" data-testid="glyph-duration" data-unmeasured="' +
				(measured ? "false" : "true") +
				'" x="1" y="7" rx="1.5" height="3" width="' +
				barWidth +
				'"/>',
		];
		/* Positioned along the full TRACK, not `barWidth`: an unmeasured bar is a
		   fixed 26px and a measured one is frequently just as short, so anchoring
		   these marks to the bar's own (often tiny) width piled them into a
		   narrow box on the left. The bar's rendered width is a separate signal
		   (the work-bar length) from where a session boundary or decision
		   actually falls along the journey's timeline. */
		var separators = Math.max(0, (journey.sessionCount || 0) - 1);
		for (var i = 0; i < separators; i++) {
			var x = Math.round((track / (separators + 1)) * (i + 1));
			parts.push(
				'<line class="glyph-sep" data-testid="glyph-session-sep-' +
					i +
					'" x1="' +
					x +
					'" x2="' +
					x +
					'" y1="3" y2="14"/>',
			);
		}
		var decisions = journey.decisions || [];
		for (var d = 0; d < decisions.length; d++) {
			var cx = Math.max(6, Math.round((track * (d + 1)) / (decisions.length + 1)));
			/* Always filled. Hollow means `agentAlone` in the cloud's vocabulary,
			   and local data carries no attribution evidence — a hollow diamond
			   would accuse the agent of deciding alone on no evidence. */
			parts.push(
				'<rect class="glyph-decision" data-testid="glyph-decision-' +
					d +
					'" x="' +
					(cx - 2.5) +
					'" y="6" width="5" height="5" rx="1" transform="rotate(45 ' +
					cx +
					' 8.5)"/>',
			);
		}
		return (
			'<svg class="jglyph" role="img" width="' +
			FEED_WIDTH +
			'" height="' +
			HEIGHT +
			'" viewBox="0 0 ' +
			FEED_WIDTH +
			" " +
			HEIGHT +
			'" aria-label="' +
			JD.esc(label) +
			'">' +
			parts.join("") +
			"</svg>"
		);
	};

	/* Shared by `groupBadge` (the feed's `.jbadge`) and `renderJourneyMeta` (the
	   trace sheet's `.jtrace-badge`) so the two badges cannot drift on wording
	   again: a commit-grouped journey reads "single commit", never a branch
	   name, and a journey never grouped by ticket has no ticket to be null. */
	function groupBadgeText(journey) {
		return journey.groupedBy === "ticket"
			? journey.ticket
			: journey.groupedBy === "branch"
				? journey.branch
				: "single commit";
	}

	/* The grouping badge. A branch journey must never present itself as a
	   ticket journey — an INFERRED grouping must not render as a STATED one. */
	function groupBadge(journey) {
		var text = groupBadgeText(journey);
		return '<span class="jbadge" data-grouped-by="' + journey.groupedBy + '">' + JD.esc(text || "—") + "</span>";
	}

	/* A figure the model reports as unavailable is NAMED as unmeasured. Printing
	   a 0 or a dash instead turns "we never measured this" into "we measured
	   nothing", which are different claims. */
	function figure(value, availability, format) {
		return availability === "unavailable" || value === null ? "not measured" : format(value);
	}

	/* The sheet's one-line summary. Every figure runs through `figure()`, so an
	   unmeasured one says "not measured" rather than 0 — a zero here would claim
	   an instant journey, a free one, or one nobody worked on.

	   "activity", never "duration" or "elapsed": the figure counts fifteen-minute
	   buckets in which a session spoke, so it is an upper bound, and one message
	   fills a whole bucket. */
	JD.renderJourneyMeta = (journey, timeZone, waits) => {
		var badge = groupBadgeText(journey);
		var parts = [JD.weekdayDate(journey.startedAtMs, timeZone)];
		/* This one-line meta row shows MEASURED metrics only — an unmeasured one
		   is omitted entirely, never printed as "not measured". A bare "not
		   measured" here reads as noise the user cannot act on (the card's own
		   `figures` dl still carries the measured/unmeasured distinction where a
		   labelled field needs it). `sessionCount` was already omitted this way —
		   it has no availability flag and "0 sessions" would claim nobody worked
		   on it — and `duration`/`cost` now follow the same rule. The guard mirrors
		   `figure()`'s own "not measured" test, negated. */
		if (journey.availability.duration !== "unavailable" && journey.durationMinutes !== null) {
			parts.push(journey.durationMinutes + " min activity");
		}
		if (journey.sessionCount) {
			parts.push(journey.sessionCount + (journey.sessionCount === 1 ? " session" : " sessions"));
		}
		if (journey.availability.cost !== "unavailable" && journey.costUsd !== null) {
			parts.push(JD.fmtUsd(journey.costUsd));
		}
		/* The only status this sheet asserts is "waiting on an answer", and only
		   when a wait actually reached the stall threshold. §3.2 vocabulary: the
		   agent's idleness is measured, so the wording is about the agent waiting,
		   never "blocked" (no signal for it) or what the human was doing. `waits`
		   is optional — the feed cards call this without it and get no status. */
		var awaiting = (waits || []).some((wait) => wait.durationMinutes >= WAIT_STALL_MINUTES);
		return (
			'<span class="jtrace-badge" data-grouped-by="' +
			JD.esc(journey.groupedBy) +
			'">' +
			JD.esc(badge || "—") +
			"</span>" +
			'<span class="jtrace-shape">' +
			JD.esc(journey.shape.label) +
			"</span>" +
			(awaiting ? '<span class="jtrace-status">waiting on an answer</span>' : "") +
			parts.map((part) => '<span class="jtrace-meta">' + JD.esc(part) + "</span>").join("")
		);
	};

	/* "Smoothest"/"Hardest" alone is a verdict with no stated basis. The score
	   ranks on turns and duration (whichever is measured — see frictionIndex),
	   so every card says so, instead of letting the reader assume "hardest"
	   means wall-clock time when it may be turns alone. */
	var RANKED_BY_SUBTITLE = "Ranked by turns + activity";

	/* The stage band is a NARRATIVE FRAME, not measured phases. The cloud says so
	   of its own: the widths are "a constant visual grammar so every trace reads
	   as the same object", not a claim that someone spent 44% of the task
	   executing. Only ONE thing in it is data-backed here — whether the `plan`
	   band appears, which is `planFirst`.

	   There is no `land` band. The cloud gates one on `landed`, which this model
	   does not carry: it was removed as structurally always true, because
	   unreachable commits are filtered out before a journey is folded. Drawing
	   the band would claim every journey landed; drawing the not-landed variant
	   would claim the opposite. Omission is the only honest option, and it stays
	   until `landed` means "reached the default branch". */
	JD.stageBands = (journey) =>
		journey.planFirst
			? [
					{ key: "frame", label: "frame", share: 0.12 },
					{ key: "plan", label: "plan", share: 0.18 },
					{ key: "execute", label: "execute", share: 0.5 },
					{ key: "verify", label: "verify", share: 0.2 },
				]
			: [
					{ key: "frame", label: "frame", share: 0.1 },
					{ key: "execute", label: "execute", share: 0.65 },
					{ key: "verify", label: "verify", share: 0.25 },
				];

	function card(journey, kind, heading) {
		return (
			'<article class="jcard jcard-clickable" data-kind="' +
			kind +
			'">' +
			"<h3>" + JD.esc(heading) + "</h3>" +
			'<p class="jcard-rankedby">' + JD.esc(RANKED_BY_SUBTITLE) + "</p>" +
			'<p class="jcard-title">' + JD.esc(journey.title) + "</p>" +
			groupBadge(journey) +
			JD.journeyGlyph(journey) +
			'<dl class="jcard-figures">' +
			"<dt>Turns</dt><dd>" +
			figure(journey.turns, journey.availability.turns, (v) => String(v)) +
			"</dd>" +
			"<dt>Activity</dt><dd>" +
			figure(journey.durationMinutes, journey.availability.duration, (v) => v + " min") +
			"</dd>" +
			"<dt>Cost</dt><dd>" +
			figure(journey.costUsd, journey.availability.cost, JD.fmtUsd) +
			"</dd>" +
			"<dt>Decisions</dt><dd>" + journey.decisionCount + "</dd>" +
			"</dl>" +
			"</article>"
		);
	}

	/* The mockup's chips are `flagged` and `no land`. Neither exists here.
	   `flagged` needs a friction signal, which is tier C and not derived yet;
	   `no land` needs `landed`, which the model does not carry — it was removed
	   as structurally always true. A chip built on either would be a filter that
	   silently matches nothing, which is worse than no chip.

	   plan-first is the local substitute because it is the one distinction that
	   is both measured and actionable — it is the practice the adopt-next card
	   pushes. Measured on the live database: 229 journeys, 55 plan-first, 174
	   straight to execute. */
	JD.journeyFilters = (journeys) => {
		var chips = [
			{ key: "all", label: "all", count: journeys.length },
			{ key: "plan-first", label: "plan-first", count: journeys.filter((j) => j.planFirst).length },
			{ key: "straight", label: "straight to execute", count: journeys.filter((j) => !j.planFirst).length },
		];
		var singleCommit = journeys.filter((j) => j.commitCount === 1).length;
		if (singleCommit > 0) {
			chips.push({ key: "single-commit", label: "single-commit", count: singleCommit });
		}
		var testFirst = journeys.filter((j) => j.tested && j.tested.testFirst === true).length;
		if (testFirst > 0) {
			chips.push({ key: "test-first", label: "test first", count: testFirst });
		}
		/* `flagged` is the one availability-gated chip: it renders only when at
		   least one journey's friction is measurable, and counts only positive
		   evidence — a measured, non-zero abort. An all-Claude window has no
		   friction to flag, and a "flagged 0" would be the §3.3a failure mode, a
		   filter that silently matches nothing. */
		var measurable = journeys.some((j) => j.friction && j.friction.availability !== "unavailable");
		if (measurable) {
			chips.push({
				key: "flagged",
				label: "flagged",
				count: journeys.filter((j) => j.friction && j.friction.value > 0).length,
			});
		}
		return chips;
	};

	var MATCHERS = {
		all: () => true,
		"plan-first": (journey) => journey.planFirst,
		straight: (journey) => !journey.planFirst,
		"single-commit": (journey) => journey.commitCount === 1,
		"test-first": (journey) => journey.tested && journey.tested.testFirst === true,
		flagged: (journey) => journey.friction && journey.friction.value > 0,
	};

	var activeFilter = "all";

	function chipRow(journeys) {
		return (
			'<div class="jfchips">' +
			JD.journeyFilters(journeys)
				.map(
					(chip) =>
						'<button type="button" data-filter="' +
						JD.esc(chip.key) +
						'" class="jfchip' +
						(chip.key === activeFilter ? " on" : "") +
						'">' +
						JD.esc(chip.label) +
						" " +
						chip.count +
						"</button>",
				)
				.join("") +
			"</div>"
		);
	}

	/* Re-renders the MODAL feed with the chosen filter. The featured pair in the
	   roster expansion is unaffected by the feed's filter on purpose: it ranks
	   the window, and a "smoothest" that changed as you filtered would be a
	   different claim on every click while the card's own subtitle still said it
	   ranked the window. */
	JD.applyJourneyFilter = (key) => {
		activeFilter = MATCHERS[key] ? key : "all";
		if (!JD.feedModel) return;
		JD.renderFeedInto(document.getElementById("jfeedBody"), JD.feedModel, pageModel.timeZone);
	};

	/* The row carries its POSITION, not its identity. A journey id joins its parts
	   with NUL (`SEP` in JourneyKey.ts), and NUL cannot survive a round trip
	   through markup: the HTML tokenizer replaces every NUL in the input stream
	   with U+FFFD, so an id written into an attribute here read back out of
	   `getAttribute` as `T�…�JOLLI-2123` and the detail route answered
	   404 for a journey the feed had just rendered. `JD.esc` does not (and should
	   not) help — it escapes the five markup characters, and NUL is not one.
	   Reading the journey out of the model the click handler already closes over
	   removes the round trip altogether, so no encoding has to be kept in sync
	   between the two ends. */
	function row(journey, index) {
		return (
			'<button class="jrow" type="button" data-index="' +
			index +
			'">' +
			'<span class="jrow-title">' +
			JD.esc(journey.title) +
			"</span>" +
			groupBadge(journey) +
			JD.journeyGlyph(journey) +
			'<span class="jrow-shape">' +
			JD.esc(journey.shape.label) +
			"</span>" +
			'<span class="jrow-meta">' +
			journey.commitCount +
			" commits</span>" +
			"</button>"
		);
	}

	/* Day grouping is capped by HEADER COUNT, not by density.

	   Density is flat in every window this page offers — measured on the live
	   database, journeys per active day: 7d 2.2, 30d 2.4, 90d 2.2, all 2.1. A
	   density threshold therefore cannot tell the windows apart; it would fire
	   everywhere or nowhere. Header count does separate them: 7d yields 5 header
	   days, 30d 19, 90d 52, and the all-history window 110 against 229 rows,
	   which is a feed made mostly of headers.

	   31 admits the two windows a reader scans day by day, excludes the two they
	   skim, sits clear of the largest admitted value, and needs no range name —
	   so a custom range is decided by its own shape. */
	var DAY_HEADER_CAP = 31;

	JD.shouldGroupByDay = (journeys, timeZone) => {
		var days = {};
		journeys.forEach((journey) => {
			days[JD.dayKey(journey.endedAtMs, timeZone)] = true;
		});
		return Object.keys(days).length <= DAY_HEADER_CAP;
	};

	var TRACE_WIDTH = 560;
	var TRACE_HEIGHT = 96;
	var AXIS_Y = 64;
	var BAND_Y = 16;
	var BAND_H = 18;
	/* A wait this long is a real stall where the agent sat waiting on the human,
	   not reading/typing latency. Mirrors `WAIT_STALL_MINUTES` in CoachingQuery.ts
	   — the same threshold the roster's awaiting-response count uses. */
	var WAIT_STALL_MINUTES = 30;

	/* One commit's x on the axis. Callers must not reach here with a zero span —
	   `renderJourneyTrace` checks first — because the division would be by zero
	   and every mark would land on NaN, which SVG renders as nothing at all: a
	   silently empty chart rather than a visible failure. */
	function commitX(committedAtMs, startedAtMs, spanMs) {
		return Math.round(((committedAtMs - startedAtMs) / spanMs) * (TRACE_WIDTH - 24) * 10) / 10 + 12;
	}

	function ordinalList(commits) {
		return (
			'<ol class="jtrace-bands">' +
			commits
				.map(
					(commit, index) =>
						'<li class="jtrace-band"><span class="jtrace-ord">' + (index + 1) + "</span>" +
						'<span class="jtrace-msg">' + JD.esc((commit.message || "").split("\n")[0]) + "</span>" +
						'<code class="jtrace-hash">' + JD.esc(commit.commitHash.slice(0, 7)) + "</code></li>",
				)
				.join("") +
			"</ol>"
		);
	}

	/* The trace's bands are a NARRATIVE frame with fixed widths, not measured
	   phases: local data carries no per-phase timing, so placing a band by
	   timestamp would draw a measurement that does not exist — they are drawn
	   as fixed-share segments above the axis, not positioned by any commit's
	   time. Commits and decisions ARE positioned by time; that is the point of
	   the axis. */
	function traceSvg(detail) {
		var journey = detail.journey;
		var spanMs = journey.endedAtMs - journey.startedAtMs;
		var x = 0;
		var bands = JD.stageBands(journey)
			.map((band) => {
				var width = Math.round((TRACE_WIDTH - 24) * band.share);
				var rect =
					'<rect class="jtrace-stage" x="' + (x + 12) + '" y="' + BAND_Y +
					'" width="' + (width - 2) + '" height="' + BAND_H + '" rx="4"/>' +
					'<text class="jtrace-stage-label" x="' + (x + 12 + width / 2) + '" y="' + (BAND_Y + BAND_H / 2) +
					'" text-anchor="middle" dominant-baseline="central">' + JD.esc(band.label) + "</text>";
				x += width;
				return rect;
			})
			.join("");
		var byCommit = {};
		detail.commits.forEach((commit) => {
			byCommit[commit.commitHash] = commitX(commit.committedAtMs, journey.startedAtMs, spanMs);
		});
		var marks = detail.commits
			.map(
				(commit) =>
					'<circle class="jtrace-commit" cx="' + byCommit[commit.commitHash] + '" cy="' + AXIS_Y + '" r="4">' +
					"<title>" + JD.esc((commit.message || "").split("\n")[0]) + "</title></circle>",
			)
			.join("");
		/* A decision is placed at ITS OWN commit's time. Rendering them all at the
		   axis origin — which is what skipping the lookup gives — would draw every
		   decision as if it had been taken before any work happened. A decision
		   naming a commit outside this journey is dropped rather than clamped. */
		var decisionMarks = detail.decisions
			.filter((entry) => byCommit[entry.commitHash] !== undefined)
			.map(
				(entry) =>
					'<circle class="jtrace-decision-mark" cx="' + byCommit[entry.commitHash] + '" cy="' + (AXIS_Y - 14) +
					'" r="3"><title>' + JD.esc(entry.text) + "</title></circle>",
			)
			.join("");
		/* A compaction is an INSTANT on the timeline, not a phase: its marker is
		   positioned by its timestamp, like a commit. Instants outside the
		   journey's span are dropped rather than clamped — the same rule the
		   decision diamonds use, and for the same reason: clamping would draw a
		   measurement at a time it did not happen. Drawn BELOW the axis so they
		   never pile onto a decision diamond sharing an x. */
		var compactionMarks = (detail.compactions || [])
			.filter((atMs) => atMs >= journey.startedAtMs && atMs <= journey.endedAtMs)
			.map(
				(atMs) =>
					'<circle class="jtrace-compaction" cx="' + commitX(atMs, journey.startedAtMs, spanMs) + '" cy="' +
					(AXIS_Y + 14) +
					'" r="3"><title>Context compacted</title></circle>',
			)
			.join("");
		return (
			'<svg class="jtrace-svg" role="img" viewBox="0 0 ' + TRACE_WIDTH + " " + TRACE_HEIGHT +
			'" aria-label="Journey trace: stage bands are a narrative frame, not measured phases">' +
			bands +
			'<line class="jtrace-axis" x1="12" y1="' + AXIS_Y + '" x2="' + (TRACE_WIDTH - 12) + '" y2="' + AXIS_Y + '"/>' +
			marks +
			decisionMarks +
			compactionMarks +
			"</svg>"
		);
	}

	function fmtMinutes(minutes) {
		return minutes >= 60 ? (minutes / 60).toFixed(1).replace(/\.0$/, "") + "h" : minutes + "m";
	}

	/* The sheet's OWN legend, honest about EXACTLY what `traceSvg` draws. The
	   shared `LEGEND_ITEMS` is the mini-strip vocabulary and promises glyphs
	   neither surface renders (friction window, degraded context, landed) — so it
	   is deliberately not reused here. Only entries whose glyph is actually
	   present are shown, and the stage-band line states outright that it is a
	   narrative frame, not measured time (the bands are fixed shares, not
	   timings), so no reader mistakes a band width for a duration. */
	function sheetLegend(detail) {
		var journey = detail.journey;
		// No span → no SVG is drawn (ordinal list only), so nothing to explain.
		if (journey.endedAtMs <= journey.startedAtMs) return "";
		var items = [
			["band", "frame → execute → verify (a narrative frame, not measured time)"],
			["commit", "commit"],
		];
		// A decision mark needs a commit in this journey to anchor to; a journey's
		// own decisions name its own commits, so any decision + any commit means a
		// mark is drawn.
		if ((detail.decisions || []).length > 0 && (detail.commits || []).length > 0) {
			items.push(["decision", "decision recorded"]);
		}
		if ((detail.compactions || []).some((atMs) => atMs >= journey.startedAtMs && atMs <= journey.endedAtMs)) {
			items.push(["compaction", "context compacted"]);
		}
		return (
			'<div class="jtrace-sheet-legend">' +
			items
				.map(
					(item) =>
						'<span class="jsheet-legend-item"><span class="jsheet-legend-mark jsheet-legend-' +
						item[0] +
						'" aria-hidden="true"></span>' +
						JD.esc(item[1]) +
						"</span>",
				)
				.join("") +
			"</div>"
		);
	}

	/* The stats grid, replacing the mockup's four boxes with only what is
	   measurable. `activity`, not `elapsed`: the first-to-last span overstates by
	   7.6-26x on resumed sessions (see `readSessionBuckets`), so the whole
	   dashboard uses fifteen-minute activity buckets and this sheet follows. Every
	   figure runs through `figure()`, so an unmeasured one says "not measured"
	   rather than a 0 that would claim an instant or free journey. `waiting` is
	   the summed wait time (absent, not "0", when nothing stalled) — the honest
	   remainder of the mockup's "where the time went" bar, whose per-phase split
	   is not measured locally and is deferred. `degraded context` is omitted for
	   the same reason: there is no local signal for it yet. */
	function statsGrid(journey, waits) {
		var cells = [
			["activity", figure(journey.durationMinutes, journey.availability.duration, (v) => v + " min")],
			["est cost", figure(journey.costUsd, journey.availability.cost, JD.fmtUsd)],
		];
		if (journey.sessionCount) {
			cells.push(["sessions", String(journey.sessionCount)]);
		}
		var waitTotal = (waits || []).reduce((sum, wait) => sum + (wait.durationMinutes || 0), 0);
		if (waitTotal > 0) {
			cells.push(["waiting", fmtMinutes(waitTotal)]);
		}
		return (
			'<dl class="jtrace-stats">' +
			cells.map((cell) => "<dt>" + JD.esc(cell[0]) + "</dt><dd>" + JD.esc(cell[1]) + "</dd>").join("") +
			"</dl>"
		);
	}

	JD.renderJourneyTrace = (detail, timeZone) => {
		var journey = detail.journey;
		/* A commit-grouped journey holds one commit, so its span is zero — 60 of
		   228 journeys measured. No axis: a zero-length axis with a mark on it
		   draws a measurement nobody made, and an axis whose ends are the same
		   instant reads as work finished instantaneously. In that case the
		   ordinal list is the whole record and renders alone.

		   When there IS a span, the axis is drawn ABOVE the list rather than
		   instead of it: `role="img"` makes assistive tech treat the SVG
		   subtree as opaque, so the per-mark `<title>`s (and with them every
		   7-char hash) are invisible to a screen reader if the list is the
		   axis's only alternative. The axis is an overview; the list stays the
		   record. */
		var head =
			journey.endedAtMs > journey.startedAtMs
				? traceSvg(detail) + ordinalList(detail.commits)
				: ordinalList(detail.commits);
		/* Every decision, uncapped — unlike the feed row's glyph, which caps at
		   what fits a diamond mark. This sheet is the one place a reader can see
		   the whole list. */
		var decisions = detail.decisions
			.map((entry) => '<li class="jtrace-decision">' + JD.esc(entry.text) + "</li>")
			.join("");
		/* §3.2 vocabulary: a wait reads "waiting on you" — the agent's idleness
		   is measured, the human's activity is not. The words `idle` / `away` /
		   `blocked on you` must never appear here. */
		var waits = (detail.waits || [])
			.map(
				(wait) =>
					'<li class="jwait">' +
					'<span class="jwait-duration">' +
					(wait.durationMinutes >= 60
						? (wait.durationMinutes / 60).toFixed(1).replace(/\.0$/, "") + "h"
						: wait.durationMinutes + "m") +
					"</span>" +
					'<span class="jwait-time">' + JD.esc(JD.weekdayDate(wait.startedAtMs, timeZone)) + "</span>" +
					"</li>",
			)
			.join("");
		/* The turn split, counted, never a verdict: it records how many user and
		   assistant messages there were, and deliberately does not say who "drove"
		   the work (§5 step 4 is semi-explicit — the roles are explicit, the
		   verdict is not). */
		var attribution = "";
		var split = detail.attribution;
		if (split && split.humanTurns + split.agentTurns > 0) {
			attribution =
				'<p class="jtrace-attribution">' +
				JD.esc(
					"You: " +
						split.humanTurns +
						(split.humanTurns === 1 ? " turn" : " turns") +
						" · Agent: " +
						split.agentTurns +
						(split.agentTurns === 1 ? " turn" : " turns"),
				) +
				"</p>";
		}
		/* The compaction list is the RECORD the axis markers' `<title>`s cannot be
		   for a screen reader — `role="img"` hides the SVG subtree, so the list
		   sits below like the ordinal list does. Named "Context load" (§3.3's
		   element), not "auto-compact", which is an event kind, not a heading. */
		var compactions = (detail.compactions || [])
			.map(
				(atMs) =>
					'<li class="jcompaction"><span class="jcompaction-time">' +
					JD.esc(JD.weekdayDate(atMs, timeZone)) +
					"</span></li>",
			)
			.join("");
		var narrative =
			journey.planFirst
				? "Started with a plan, then moved through execution and verification."
				: "Prompted by the ticket and went straight to execution.";
		var decisionBlock = decisions
			? '<ul class="jtrace-decisions">' + decisions + "</ul>"
			: '<p class="jtrace-empty-copy">none recorded — small change, no forks in the road.</p>';
		var receiptItems = (detail.commits || [])
			.map(
				(commit) =>
					'<span class="jtrace-receipt"><code>' +
					JD.esc((commit.commitHash || "").slice(0, 7)) +
					"</code> · " +
					JD.esc((commit.message || "").split("\n")[0]) +
					"</span>",
			)
			.join("");
		document.getElementById("jtraceBody").innerHTML =
			'<div class="jtrace-visual">' +
			attribution +
			head +
			sheetLegend(detail) +
			"</div>" +
			statsGrid(journey, detail.waits) +
			'<section class="jtrace-section"><h4>What happened</h4><p>' +
			JD.esc(narrative) +
			"</p></section>" +
			'<section class="jtrace-section"><h4>Decisions ' +
			detail.decisions.length +
			"</h4>" +
			decisionBlock +
			"</section>" +
			(waits ? '<h4>Waiting on you</h4><ul class="jwait-list">' + waits + "</ul>" : "") +
			(compactions ? '<h4>Context load</h4><ul class="jcompaction-list">' + compactions + "</ul>" : "") +
			'<section class="jtrace-section"><h4>Receipts</h4><div class="jtrace-receipts">' +
			// A journey with no commit is not a failed one — a blocked or
			// still-open arc keeps its session notes. Matches the mockup copy.
			(receiptItems || '<span class="jtrace-empty-copy">no commit — session notes kept</span>') +
			"</div></section>";
	};

	function openTrace(model, repoIdentity, journeyId) {
		var overlay = document.getElementById("ovJourney");
		/* Blank the previous journey's meta line and title HERE, in the same
		   statement block as the body's "Loading…" — not just the body. Left
		   in place, they still name journey A's ticket, date, and cost while
		   journey B's fetch is in flight, and stay put under a "Could not load
		   this journey." body if B's fetch fails. A stale meta line is worse
		   than an empty one: it is indistinguishable from a correct one, while
		   an empty line is visibly incomplete. */
		document.getElementById("jtraceSub").innerHTML = "";
		document.getElementById("jtraceTitle").textContent = "Journey";
		document.getElementById("jtraceBody").innerHTML = '<div class="jempty">Loading…</div>';
		overlay.classList.add("open");
		/* `JD.query(model, {})` carries the page's own scope (repo/dimension); the
		   journeys view has no `model.stats`, so it carries no range at all. The
		   window this journey was GROUPED under lives on `pageModel.coaching` —
		   the same bounds the feed was fetched under — so it rides as its own
		   params rather than through `JD.query`. Forwarding it matters: the detail
		   route RE-ASSEMBLES the window, and the grouping is window-dependent, so
		   a different range answers about a different journey — a tab left open
		   across local midnight must not 404 on a journey it is still displaying.
		   Always send both, never let the route fall back to a fresh clock read. */
		var query = JD.withParams("/api/journey" + JD.query(model, {}), {
			repo: repoIdentity,
			id: journeyId,
			fromMs: pageModel.coaching.windowStartMs,
			toMs: pageModel.coaching.windowEndMs,
		});
		fetch(query)
			.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
			.then((detail) => {
				document.getElementById("jtraceTitle").textContent = detail.journey.title;
				document.getElementById("jtraceSub").innerHTML = JD.renderJourneyMeta(
					detail.journey,
					model.timeZone,
					detail.waits,
				);
				JD.renderJourneyTrace(detail, model.timeZone);
			})
			.catch(() => {
				/* Say the read failed. A silent empty sheet reads as "this journey
				   has nothing in it", which is a different and false statement. */
				document.getElementById("jtraceBody").innerHTML =
					'<div class="jempty">Could not load this journey.</div>';
			});
	}

	/* A self-trend facet in the collapsed report row (§B). `betterWhenLower`
	   flips which arrow means "improving", because turnaround improves as it
	   falls and plan-first improves as it rises. An unmeasured cell renders
	   nothing (not a zero), the same gate the old roster cell applied. */
	function reportFacet(label, cell, format, betterWhenLower) {
		if (!cell || cell.availability !== "measured" || cell.value == null) return "";
		var arrow = "→";
		if (cell.trendPct != null && cell.trendPct !== 0) {
			var improving = betterWhenLower ? cell.trendPct < 0 : cell.trendPct > 0;
			arrow = improving ? "↘" : "↗";
		}
		return (
			'<span class="report-facet">' +
			'<span class="report-facet-arrow">' +
			arrow +
			"</span>" +
			'<span class="report-facet-value">' +
			JD.esc(format(cell.value)) +
			"</span>" +
			'<span class="report-facet-label">' +
			JD.esc(label) +
			"</span>" +
			"</span>"
		);
	}

	/* Up to 8 glyphs from the featured pair + nothing else on load (the full
	   set lives behind the feed modal). Single subject: the strip is a taste,
	   not the whole history. */
	function reportStrip(coaching) {
		var picks = [];
		if (coaching.featured && coaching.featured.smoothest) picks.push(coaching.featured.smoothest);
		if (coaching.featured && coaching.featured.hardest) picks.push(coaching.featured.hardest);
		var glyphs = picks
			.slice(0, 8)
			.map((j) => JD.journeyGlyph(j))
			.join("");
		var overflow =
			coaching.journeyCount > picks.length
				? '<span class="report-strip-more">+' + (coaching.journeyCount - picks.length) + "</span>"
				: "";
		return '<span class="report-strip">' + glyphs + overflow + "</span>";
	}

	function reportInitials(label) {
		return String(label || "You")
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.map((p) => p.charAt(0).toUpperCase())
			.join("");
	}

	/* The collapsed shape of the single-subject report row (§B, part 1): an
	   initials avatar, the subject's name, its journey count, a journey
	   mini-strip, self-trend facets (turnaround + plan-first — red-zone is
	   deliberately omitted, there is no local signal for it), and a flagged
	   pill. */
	JD.reportRow = (coaching) => {
		var r = coaching.roster;
		var flagged =
			r.friction && r.friction.availability === "measured" && r.friction.value > 0
				? '<span class="report-flagged">' + r.friction.value + " flagged</span>"
				: "";
		return (
			'<div class="report-row">' +
			'<span class="report-avatar" aria-hidden="true">' +
			JD.esc(reportInitials(r.label)) +
			"</span>" +
			'<span class="report-name">' +
			JD.esc(r.label) +
			"</span>" +
			'<span class="report-count">' +
			coaching.journeyCount +
			" journeys</span>" +
			reportStrip(coaching) +
			'<span class="report-facets">' +
			reportFacet(
				"turnaround",
				r.turnaround,
				(value) => (value >= 60 ? (value / 60).toFixed(1).replace(/\.0$/, "") + "h" : value + "m"),
				true,
			) +
			reportFacet("plan-first", r.planFirst, (value) => value + "%", false) +
			flagged +
			"</span>" +
			"</div>"
		);
	};

	/* The two highlight cards. smoothest → "worth sharing" (positive), hardest →
	   "needs help" (warning). Suppress needs-help when it is the SAME journey as
	   worth-sharing — the window held one candidate, and two identical cards would
	   claim a comparison that was never made (same rule the old `featured` had).
	   Reuses `card()` verbatim so a journey's figures are rendered in exactly one
	   place. */
	function reportCards(coaching) {
		var f = coaching.featured || {};
		var cards = [];
		if (f.smoothest) cards.push(card(f.smoothest, "worth-sharing", "worth sharing"));
		if (f.hardest && (!f.smoothest || f.hardest.id !== f.smoothest.id))
			cards.push(card(f.hardest, "needs-help", "needs help"));
		return cards.length === 0 ? "" : '<div class="report-cards">' + cards.join("") + "</div>";
	}

	/* The self-trend summary: one line + sparkline over the per-day hero series.
	   Fewer than two points draws no line (`JD.spark` refuses it), and the whole
	   summary is omitted then rather than showing an empty box. */
	function reportSummary(coaching) {
		var pts = coaching.hero || [];
		if (pts.length < 2) return "";
		var spark = JD.spark(
			pts.map((p) => p.turns),
			260,
			40,
			"--s1",
		);
		if (!spark) return "";
		return (
			'<div class="report-summary">' +
			'<span class="report-summary-measure">turns / commit</span>' +
			'<span class="report-summary-against">vs your earlier line</span>' +
			spark +
			"</div>"
		);
	}

	/* The Reports "how this is measured" note. Single-subject wording ("You" /
	   "your own earlier line", shapes-not-people) taken straight from the mockup —
	   this deck IS the single subject, so nothing here is team-shaped. The last
	   sentence is the deliberate "journeys are not captured yet" caveat: the
	   session→ticket→commit join and decision-ratification are not stored. */
	var REPORTS_METHOD =
		"A journey is one task walked with the agent, ticket-scoped, so several sessions stitch into one arc. Turnaround is how fast a waiting agent gets unblocked and red-zone share is work done in a degraded context window, each measured against your own earlier line. Shapes label journeys, never people, and there is deliberately no composite score: a total over these fields would be a ranking of you against yourself with the arithmetic hidden. The journey object is intent rather than capture: stitching sessions into an arc needs a session-to-ticket-to-commit join that is not stored, and whether a decision was ratified is not captured at all.";
	function reportsFooter(coaching) {
		var count = coaching.journeyCount;
		var chips = [
			// Single subject: one report, never "N reports · M people".
			"1 report · " + count + (count === 1 ? " journey" : " journeys"),
			"vs your own baseline",
			"journeys are not captured yet",
		];
		return (
			'<div class="jpatterns-foot">' +
			chips.map((chip) => '<span class="jpatterns-foot-chip">' + JD.esc(chip) + "</span>").join("") +
			measuredButton("jreports-measured-btn") +
			'<a class="jbrowse-record" href="/memories">Browse the record →</a>' +
			'</div><p class="jreports-method" hidden>' +
			JD.esc(REPORTS_METHOD) +
			"</p>"
		);
	}

	/* The always-open expansion body (§B, part 2): a self-trend summary bar, the
	   two highlight cards, the trace legend, and the footer. Recent journeys stay
	   behind the feed modal (Browse the record) — bringing the inline list onto
	   this page needs a journey list in the main model, which is a backend change. */
	JD.reportExpansion = (coaching) => {
		return (
			'<div class="report-expansion">' +
			reportSummary(coaching) +
			reportCards(coaching) +
			traceLegend() +
			reportsFooter(coaching) +
			"</div>"
		);
	};

	/* The whole feed, rendered into the modal body — the body of the old
	   `renderJourneys` feed loop, moved verbatim. `body` is the modal's
	   `#jfeedBody`, and the rows/chips wire exactly as they did on the page. */
	JD.renderFeedInto = (body, feed, timeZone) => {
		/* An empty range is a DIFFERENT empty state from "the filter matched
		   nothing": here there is nothing to filter, so the chips (which would
		   all read 0) stay hidden rather than implying a choice the reader never
		   made. */
		if (feed.journeys.length === 0) {
			body.innerHTML = '<div class="jempty">No journeys in this range.</div>';
			return;
		}
		/* `rows` is the FILTERED list, and it is what `row()`'s index is taken
		   from below — the click handler must resolve against this SAME array,
		   never `feed.journeys`. Once a filter can hide rows, `index` is only
		   the position in whichever array was actually rendered; indexing the
		   unfiltered list opens a different journey's trace while the sheet
		   fills in without complaint. */
		var rows = feed.journeys.filter(MATCHERS[activeFilter] || MATCHERS.all);
		/* Grouped over `rows` — the FILTERED list — not `feed.journeys`. Headers
		   describe what the reader can see; grouping the unfiltered list would
		   emit a header for a day whose only journeys the active filter hides,
		   a header with nothing under it. */
		var grouped = JD.shouldGroupByDay(rows, timeZone);
		var lastDay = null;
		/* `row(journey, index)` still takes `index` from `rows` — the SAME array
		   the click handler below resolves against — even though a `.jfday`
		   header is interleaved ahead of some rows. The header is markup, not a
		   member of `rows`, so it must never advance `index`; doing so would
		   silently open the wrong journey's trace as soon as both a filter and
		   grouping are active together. */
		/* `lastDay` only catches ADJACENT repeats, so this dedupes correctly only
		   because `rows` arrives sorted by `endedAtMs` descending (`JourneysQuery.ts`)
		   and `.filter` above preserves that order. A non-contiguous order — the
		   same day appearing, then a different day, then the first day again —
		   would emit a repeated header for that day instead of being caught here.
		   Do not "fix" that by sorting: sorting is forbidden on this surface. */
		var feedHtml = rows
			.map((journey, index) => {
				var markup = row(journey, index);
				if (!grouped) return markup;
				var key = JD.dayKey(journey.endedAtMs, timeZone);
				if (key === lastDay) return markup;
				lastDay = key;
				return '<div class="jfday">' + JD.esc(JD.weekdayDate(journey.endedAtMs, timeZone)) + "</div>" + markup;
			})
			.join("");
		/* A filter that matches nothing must still say so — the chips stay
		   visible above an empty `.jfeed` otherwise, with nothing telling the
		   reader why the feed below them is blank. This is a DIFFERENT empty
		   state from an empty range: here the range HAS journeys, but the filter
		   is what emptied the view, so the message — and the still-visible chips
		   — must let the reader get back rather than read as "no data at all". */
		body.innerHTML =
			chipRow(feed.journeys) +
			'<div class="jfeed">' +
			(rows.length === 0 ? '<div class="jempty">No journeys match this filter.</div>' : feedHtml) +
			"</div>";
		Array.prototype.forEach.call(body.querySelectorAll(".jrow"), (element) => {
			element.addEventListener("click", () => {
				var journey = rows[Number(element.getAttribute("data-index"))];
				if (journey) openTrace(pageModel, journey.repoIdentity, journey.id);
			});
		});
		Array.prototype.forEach.call(body.querySelectorAll(".jfchip"), (element) => {
			element.addEventListener("click", () => {
				JD.applyJourneyFilter(element.getAttribute("data-filter"));
			});
		});
	};

	/* Opens the feed modal, fetching the whole feed on first open.
	 *
	 * The window bounds come from the model the roster rendered under, not from a
	 * fresh resolve: two `resolveWindow` calls can straddle local midnight and
	 * disagree about what "30d" means, which would group a different set than the
	 * roster's counts describe — and would 404 the detail route for a row the
	 * feed had just drawn. */
	function ensureFeedModel(loadingTarget) {
		if (JD.feedModel) return Promise.resolve(JD.feedModel);
		if (loadingTarget) loadingTarget.innerHTML = '<div class="jempty">Loading…</div>';
		/* `fromMs`/`toMs`, never `from`/`to` — the server's `parseWindow` claims
		   the latter pair for the range picker, where they are date strings, so
		   epoch milliseconds under those names are silently misread. Same param
		   names `openTrace` already sends to `/api/journey`. */
		var query = JD.withParams("/api/journeys" + JD.query(pageModel, {}), {
			fromMs: pageModel.coaching.windowStartMs,
			toMs: pageModel.coaching.windowEndMs,
		});
		return fetch(query)
			.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
			.then((feed) => {
				JD.feedModel = feed;
				return feed;
			})
			.catch((error) => Promise.reject(error));
	}

	JD.openFeedModal = () => {
		var overlay = document.getElementById("ovFeed");
		var body = document.getElementById("jfeedBody");
		overlay.classList.add("open");
		return ensureFeedModel(body)
			.then((feed) => {
				JD.renderFeedInto(body, feed, pageModel.timeZone);
			})
			.catch(() => {
				/* Never an empty list: that reads as "you have no journeys", which
				   is a different and false statement. */
				body.innerHTML = '<div class="jempty">Could not load your journeys.</div>';
			});
	};

	/* The ADOPT NEXT card: one row per recommendable practice. Renders nothing
	   when there is nothing to recommend — an empty card would claim a verdict. */
	JD.adoptCard = (items) => {
		if (!items || items.length === 0) return "";
		var rows = items
			.map(
				(item) =>
					'<li class="jadopt-item">' +
					'<span class="jadopt-title">' + JD.esc(item.title) + "</span>" +
					'<span class="jadopt-detail">' + JD.esc(item.detail) + "</span>" +
					'<span class="jadopt-share">' + item.adopted + " / " + item.window + "</span>" +
					"</li>",
			)
			.join("");
		return '<section class="jadopt"><h3>Adopt next</h3><ul class="jadopt-list">' + rows + "</ul></section>";
	};

	/* The coaching queue: self-directed items, each evidence-linked to the
	   journey it was drawn from. The link carries only its POSITION (`data-index`),
	   never the id — a journey id joins its parts with NUL, which cannot round-trip
	   through markup (see `row()`'s comment), so the click handler resolves the
	   journey out of the `items` array it already closed over. */
	JD.queueList = (items) => {
		if (!items || items.length === 0) return "";
		function queueTone(item) {
			if (item.key === "scope") return "scope";
			if (item.key === "plan-first") return "practice";
			return "note";
		}
		function queueTag(item) {
			if (item.key === "scope") return "SCOPE";
			if (item.key === "plan-first") return "PRACTICE";
			return String(item.key || "note").replace(/-/g, " ").toUpperCase();
		}
		// Single-subject: no per-person avatar/initials badge. Each card is a
		// signal about the reader's OWN journeys, so the row leads with the signal,
		// not a person.
		var rows = items
			.map(
				(item, index) =>
					'<li class="jqueue-card" data-queue-tone="' +
					queueTone(item) +
					'">' +
					'<div class="jqueue-copy">' +
					'<div class="jqueue-row-top">' +
					'<span class="jqueue-title">' + JD.esc(item.title) + "</span>" +
					'<span class="jqueue-tag">' + JD.esc(queueTag(item)) + "</span>" +
					"</div>" +
					'<span class="jqueue-detail">' + JD.esc(item.detail) + "</span>" +
					'<div class="jqueue-evidence-row">' +
					'<span class="jqueue-evidence">' +
					JD.esc(item.journeyTicket || item.journeyTitle) +
					"</span>" +
					'<button type="button" class="jqueue-link" data-index="' + index + '">Open the journey it came from</button>' +
					"</div>" +
					"</div>" +
					"</li>",
			)
			.join("");
		var count = items.length;
		return (
			'<section class="jqueue">' +
			'<div class="jqueue-head"><div class="jqueue-title-wrap"><h3>Coaching queue</h3></div>' +
			'<p class="coach-panel-q">What is worth raising this week?</p></div>' +
			'<ul class="jqueue-list">' + rows + "</ul>" +
			'<div class="jqueue-foot">' +
			'<span class="jqueue-foot-chip">' + count + " drafted, one per report</span>" +
			'<span class="jqueue-foot-chip">nothing is sent or logged</span>' +
			'<span class="jqueue-foot-chip">drafted, not measured</span>' +
			measuredButton("jqueue-measured-btn") +
			"</div>" +
			'<p class="jqueue-method" hidden>' +
			JD.esc(QUEUE_METHOD) +
			"</p>" +
			"</section>"
		);
	};

	/* Sort priority mirrors the mockup's blocker → trend → ramp → cost intent,
	   mapped onto the local kinds this queue actually produces. `scope` (work
	   that needs to be broken up) is the blocker-like kind and sorts first;
	   `plan-first` (a positive habit to ramp up) is the ramp-like kind and
	   sorts later; anything else falls into the neutral middle bucket the
	   mockup's own trend items occupy. No local kind produces a cost-like
	   item today — the slot is kept so one lands in the right place without
	   a second change here, per the "do not invent kinds with no data" rule:
	   this ONLY reorders existing items, it never fabricates a "cost" row. */
	function queuePriority(item) {
		if (item.key === "scope") return 0;
		if (item.key === "cost") return 3;
		if (item.key === "plan-first") return 2;
		return 1;
	}

	function countMeta(pattern) {
		return (
			pattern.count +
			(pattern.count === 1 ? " journey" : " journeys") +
			" · " +
			pattern.weeks +
			(pattern.weeks === 1 ? " week" : " weeks")
		);
	}

	function patternOutcome(pattern) {
		if (pattern.emerging) return "below evidence bar";
		if (pattern.key === "plan-first") return "repeatable";
		if (pattern.key === "straight-to-execute") return "dominant";
		if (pattern.key === "single-commit") return "stays small";
		if (pattern.key === "test-first") return "repeatable";
		return "evidence met";
	}

	function patternFilterKey(pattern) {
		if (pattern.key === "straight-to-execute") return "straight";
		return pattern.key;
	}

	/* Which established patterns read as friction rather than a win — they render
	   under DRAGGING with a warning-toned outcome. Front-end only and keyed by the
	   4 patterns the data layer produces today; a data-driven polarity is a
	   backend concern for when the quantified outcomes land. `single-commit` is
	   neutral-to-positive ("stays small"), so it sits under WORKING. */
	var DRAGGING_KEYS = { "straight-to-execute": true };
	function isDragging(pattern) {
		return !!DRAGGING_KEYS[pattern.key];
	}

	/* `tone` drives the row's `data-pattern-tone` (working / dragging / emerging),
	   which the stylesheet keys the outcome badge's colour off — green for
	   working, amber for dragging, muted for emerging. */
	function patternGroup(title, items, clickable, tone) {
		if (!items || items.length === 0) return "";
		return (
			'<section class="jpatterns-group"><p class="jpatterns-group-title">' +
			JD.esc(title) +
			"</p>" +
			items
				.map(
					(pattern) =>
						(clickable
							? '<button type="button" class="jpatterns-group-action" data-pattern-key="' +
								JD.esc(patternFilterKey(pattern)) +
								'"><div class="jpatterns-group-row" data-pattern-tone="' +
								tone +
								'"><div class="jpatterns-group-copy"><p class="jpatterns-group-name">'
							: '<div class="jpatterns-group-row" data-pattern-tone="' +
								tone +
								'"><div class="jpatterns-group-copy"><p class="jpatterns-group-name">') +
						JD.esc(pattern.label) +
						'</p><p class="jpatterns-group-meta">' +
						JD.esc(countMeta(pattern)) +
						'</p></div><span class="jpatterns-group-outcome">' +
						JD.esc(patternOutcome(pattern)) +
						"</span></div>" +
						(clickable ? "</button>" : ""),
				)
				.join("") +
			"</section>"
		);
	}

	JD.openPatternJourneys = (key) =>
		JD.openFeedModal().then(() => {
			JD.applyJourneyFilter(key);
		});

	/* The trace legend — what the mini journey strips (and the trace sheet) draw.
	   Static: it explains the vocabulary, it is not data. Each mark's class is
	   styled in main.css. */
	var LEGEND_ITEMS = [
		["solid", "agent working, length is elapsed time"],
		["dashed", "waiting on an answer"],
		["break", "session break"],
		["decision", "decision recorded, hollow if nobody ratified it"],
		["friction", "friction window"],
		["degraded", "degraded context"],
		["landed", "landed"],
		["nocommit", "no commit, which is not a failure"],
	];
	function traceLegend() {
		return (
			'<div class="jtrace-legend">' +
			LEGEND_ITEMS.map(
				(item) =>
					'<span class="jlegend-item"><span class="jlegend-mark jlegend-' +
					item[0] +
					'" aria-hidden="true"></span>' +
					JD.esc(item[1]) +
					"</span>",
			).join("") +
			"</div>"
		);
	}

	/* The observational disclaimer, moved from the old always-on method line into
	   a footer control the reader expands. The wording is unchanged so the
	   "correlation, not causation / medians, not means" caveat is not lost. */
	/* The "how this is measured" control — an info glyph plus a label span. The
	   label is a SEPARATE element because the toggle swaps its text ("how this is
	   measured" ↔ "less") and must not wipe the icon (which `textContent` on the
	   button would). Shared by Patterns / Reports / Queue via their own class. */
	function measuredButton(cls) {
		return (
			'<button type="button" class="' +
			cls +
			' jmeasure-btn" aria-expanded="false">' +
			'<svg class="jmeasure-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>' +
			'<span class="jmeasure-label">how this is measured</span></button>'
		);
	}

	var PATTERNS_METHOD =
		"Observational, not causal: these are correlations in your own history, not proof of what caused them. Medians, not means, so one outlier journey does not skew the read.";
	/* The Coaching-queue "how this is measured" note. Single-subject rewrite of
	   the mockup copy: no "who needs the most work", no manager / 1:1 / multi-person
	   status ranking — ordered by what is blocked in YOUR own journeys. */
	var QUEUE_METHOD =
		"One starter per report, drafted from a friction signal or a practice gap in your own journeys, ordered by what is blocked first rather than by how much work is left. Every item names the journey it came from and opens that journey's full trace, because a drafted claim you repeat without checking it is a machine's summary passed off as an observation. Nothing here is posted anywhere and nothing is logged — there is no channel to post to, so these are notes for you to edit before you act. The wording is a draft and is expected to be wrong sometimes, which is why acting on it is one click, not three.";
	function patternsFooter(journeyCount, surfaced) {
		var chips = [];
		if (journeyCount != null) {
			chips.push(
				journeyCount + (journeyCount === 1 ? " journey" : " journeys") + " · " + surfaced + " surfaced",
			);
		}
		// The single-subject evidence bar — journeys over weeks, never "2+ people".
		chips.push("bar: 4+ journeys · 3+ weeks");
		chips.push("observational, not experiments");
		return (
			'<div class="jpatterns-foot">' +
			chips.map((chip) => '<span class="jpatterns-foot-chip">' + JD.esc(chip) + "</span>").join("") +
			measuredButton("jpatterns-measured-btn") +
			'<a class="jbrowse-record" href="/memories">Browse the record →</a>' +
			'</div><p class="jpatterns-method" hidden>' +
			JD.esc(PATTERNS_METHOD) +
			"</p>"
		);
	}

	/* Adopt-next is a plain text list, not cards/widgets: each row is a bold
	   recommendation title followed by its evidence detail. The "Open the window"
	   feed card was removed — the footer's "Browse the record" is the one feed
	   entry point now. */
	function patternAdoptCards(items) {
		if (!items || items.length === 0) return "";
		var rows = items
			.map(
				(item) =>
					'<li class="jpatterns-adopt-item"><span class="jpatterns-adopt-item-title">' +
					JD.esc(item.title) +
					".</span> <span class=\"jpatterns-adopt-item-detail\">" +
					JD.esc(item.detail) +
					"</span></li>",
			)
			.join("");
		return (
			'<div class="jpatterns-adopt"><p class="jpatterns-adopt-kicker">Adopt next</p>' +
			'<ul class="jpatterns-adopt-rows">' +
			rows +
			"</ul></div>"
		);
	}

	/* Patterns, split by the §3.4 evidence bar. The coaching view keeps them in
	   one composite card rather than hiding the main comparison behind a modal. */
	JD.patternsList = (patterns, context) => {
		if (!patterns) return "";
		var established = patterns.established || [];
		var emerging = patterns.emerging || [];
		if (established.length === 0 && emerging.length === 0) return "";
		// Established patterns split by polarity into WORKING (wins) and DRAGGING
		// (friction). Emerging stays its own below-the-bar group. Every group is
		// clickable — see the note on `patternGroup`.
		var working = established.filter((pattern) => !isDragging(pattern));
		var dragging = established.filter(isDragging);
		var journeyCount = context ? context.journeyCount : null;
		var surfaced = established.length + emerging.length;
		return (
			'<section class="jpatterns"><div class="jpatterns-head"><div class="jpatterns-title-wrap"><h3>Patterns</h3></div>' +
			'<p class="coach-panel-q">What reliably lands fast, and what reliably drags?</p></div>' +
			'<div class="jpatterns-list">' +
			patternGroup("WORKING", working, true, "working") +
			patternGroup("DRAGGING", dragging, true, "dragging") +
			// Emerging patterns are clickable too — they still open the feed filtered
			// to that pattern's journeys. Every pattern key maps into `MATCHERS` via
			// `patternFilterKey` (and an unknown key falls back to "all", never an
			// empty list), so drilling in is safe. The "below evidence bar" outcome
			// still marks them as thin-evidence; being explorable is not the same as
			// being promoted above the bar.
			patternGroup("Emerging " + emerging.length + " under the bar", emerging, true, "emerging") +
			"</div>" +
			patternAdoptCards(context ? context.adoptNext : []) +
			traceLegend() +
			patternsFooter(journeyCount, surfaced) +
			"</section>"
		);
	};

	/* The header tiles. `Reports` (the mockup's 4th) is dropped — it is always 1
	   for a single subject. An absent count is `—`, never 0 (an unmeasured
	   signal must not read as "measured nothing"); a measured 0 IS shown, and is
	   never a warning. */
	JD.coachTiles = (coaching) => {
		var days = Math.max(1, Math.round((coaching.windowEndMs - coaching.windowStartMs) / 86400000));
		function tile(label, value, warn, delta) {
			var shown = value == null ? "—" : String(value);
			var warned = warn && value != null && value > 0 ? " coach-tile-warn" : "";
			return (
				'<div class="coach-tile">' +
				'<span class="coach-tile-value' + warned + '">' + JD.esc(shown) + "</span>" +
				'<span class="coach-tile-label">' + JD.esc(label) + "</span>" +
				(delta ? '<span class="coach-tile-delta">' + JD.esc(delta) + "</span>" : "") +
				"</div>"
			);
		}
		return (
			'<div class="coach-tiles">' +
			tile("Journeys", coaching.journeyCount, false, days + "d window") +
			tile("Flagged journeys", coaching.flaggedCount, true) +
			tile("Awaiting an answer", coaching.awaitingCount, true) +
			"</div>"
		);
	};

	JD.renderCoaching = (model) => {
		pageModel = model;
		var data = model.coaching;
		var app = document.getElementById("app");
		if (!data) {
			app.innerHTML = '<div class="jempty">No coaching data in this range.</div>';
			return;
		}
		var reports =
			'<section class="coach-panel coach-reports">' +
			'<div class="coach-panel-head"><h3>Reports</h3>' +
			'<p class="coach-panel-q">Where do you need enablement rather than evaluation?</p></div>' +
			JD.reportRow(data) +
			JD.reportExpansion(data) +
			"</section>";
		var patterns = data.patterns && ((data.patterns.established || []).length || (data.patterns.emerging || []).length)
			? '<section class="coach-panel coach-patterns">' + JD.patternsList(data.patterns, data) + "</section>"
			: "";
		/* Sorted ONCE, ahead of both consumers below: `queueList`'s render order
		   and the click handler's `data-index` lookup must stay the SAME array,
		   or a click opens the wrong journey's trace with no error anywhere
		   (`data-index` indexes the RENDERED array, and `Array#sort` is stable —
		   equal-priority items keep their original relative order). */
		var queue = (data.queue || []).slice().sort((a, b) => queuePriority(a) - queuePriority(b));
		var bottom = JD.queueList(queue);
		app.innerHTML =
			'<div class="coach-page">' +
			JD.coachTiles(data) +
			reports +
			patterns +
			bottom +
			"</div>";
		Array.prototype.forEach.call(app.querySelectorAll(".jfeed-btn"), (element) => {
			element.addEventListener("click", () => JD.openFeedModal());
		});
		/* The Reports "You" row opens the journeys feed (the whole list). */
		Array.prototype.forEach.call(app.querySelectorAll(".report-row"), (element) => {
			element.addEventListener("click", () => JD.openFeedModal());
		});
		/* "Browse the record" is a link to the Memories page — a real navigation
		   (deep-linkable, reload-safe) that carries the current repo scope, exactly
		   like the sidebar nav. Not the journeys feed modal. */
		Array.prototype.forEach.call(app.querySelectorAll(".jbrowse-record"), (element) => {
			element.addEventListener("click", (event) => {
				if (event && event.preventDefault) event.preventDefault();
				window.location.href = JD.viewPath("memories") + JD.query(pageModel, { range: undefined, offset: undefined });
			});
		});
		/* "how this is measured" toggles the observational disclaimer that used to
		   sit always-on above the patterns. Expand-in-place rather than a modal —
		   it is one sentence. */
		var wireMeasured = (btnSelector, noteSelector) => {
			Array.prototype.forEach.call(app.querySelectorAll(btnSelector), (element) => {
				element.addEventListener("click", () => {
					var note = app.querySelector(noteSelector);
					if (!note) return;
					// Dashboard hides via the `[hidden]` ATTRIBUTE (there is no `.hidden`
					// class rule here — that is the VS Code webview convention). Default
					// state is hidden; a click reveals, "less" hides again.
					var willShow = note.hidden;
					note.hidden = !willShow;
					element.setAttribute("aria-expanded", willShow ? "true" : "false");
					// Expanded → the button becomes the collapse control ("less"). Swap
					// only the label span so the info icon survives (setting the button's
					// own textContent would wipe the icon).
					var label = element.querySelector(".jmeasure-label") || element;
					label.textContent = willShow ? "less" : "how this is measured";
				});
			});
		};
		wireMeasured(".jpatterns-measured-btn", ".jpatterns-method");
		wireMeasured(".jqueue-measured-btn", ".jqueue-method");
		wireMeasured(".jreports-measured-btn", ".jreports-method");
		/* The two highlight cards (worth sharing / needs help) open the same
		   journey-trace sheet a feed row does. The journey is resolved from the
		   MODEL by kind, never from a DOM attribute — a journey id carries NUL
		   separators (`T\0repo\0ticket`), and the HTML parser rewrites NUL in an
		   attribute to U+FFFD, so a round-tripped id no longer matches and the
		   trace fetch 404s ("Could not load this journey"). Same reason the feed
		   and queue keep their journey objects in JS and put only a position in the
		   DOM. */
		Array.prototype.forEach.call(app.querySelectorAll(".jcard-clickable"), (element) => {
			element.addEventListener("click", () => {
				var featured = (pageModel.coaching && pageModel.coaching.featured) || {};
				var journey = element.getAttribute("data-kind") === "needs-help" ? featured.hardest : featured.smoothest;
				if (journey) openTrace(pageModel, journey.repoIdentity, journey.id);
			});
		});
		Array.prototype.forEach.call(app.querySelectorAll(".jpatterns-group-action"), (element) => {
			element.addEventListener("click", () => {
				JD.openPatternJourneys(element.getAttribute("data-pattern-key"));
			});
		});
		/* Queue evidence links resolve the journey by POSITION (see `queueList`'s
		   comment), opening the trace the same way a feed row does. `queueItems`
		   is the SAME sorted array `queueList` just rendered — not `data.queue`
		   — so a rendered position and its `data-index` always name the same item. */
		var queueItems = queue;
		Array.prototype.forEach.call(app.querySelectorAll(".jqueue-link"), (element) => {
			element.addEventListener("click", () => {
				var item = queueItems[Number(element.getAttribute("data-index"))];
				if (item) openTrace(pageModel, item.repoIdentity, item.journeyId);
			});
		});
		document.getElementById("jtraceClose").addEventListener("click", () => {
			document.getElementById("ovJourney").classList.remove("open");
		});
		document.getElementById("jfeedClose").addEventListener("click", () => {
			document.getElementById("ovFeed").classList.remove("open");
		});
		/* Escape closes whichever sheet is open. Inline `onkeydown` is forbidden
		   under the webview CSP, so it is wired here, like the close buttons. */
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				document.getElementById("ovFeed").classList.remove("open");
				document.getElementById("ovJourney").classList.remove("open");
			}
		});
	};
})();
