/* Skills page — a chart band, a chooser column, and a reading pane.
 *
 * THE SELECTION LIVES IN THE URL (`?skill=`), not in a module variable. It survives
 * the 30 s poll for free, it can be shared and reloaded, and it is what the Stats
 * card's rows link into — so "open this skill" has one implementation rather than a
 * modal here and a link there.
 *
 * THE FIRST ROW OPENS when the address names no skill, and that question is answered
 * ONCE per page load. The left-hand nav links to a bare `/skills`, so arriving that
 * way left a list with no current row beside a pane holding one sentence — the same
 * page the Stats card opens fully populated, which reads as a load that failed. It is
 * answered once because "no skill in the address" ALSO means "the reader just closed
 * the pane": answering it again there would re-open the first row on the click that
 * closed it, and the row's own toggle would be unusable.
 *
 * THE FIGURES ARE THE SERVER'S, never a sum over the rows on screen: `usage.skills`
 * is ONE PAGE, so a header line computed from it changes every time more rows arrive
 * (`stats.js:993` records the same rule for the card).
 *
 * HOW A TOKEN FIGURE MAY BE STATED comes from `core/SkillsAggregateMarkdown.ts`,
 * which already renders these numbers in the VS Code sidebar, the memory detail and
 * every committed memory: an em dash where nothing could be attributed (never a
 * zero), a `~` on an estimate, untouched otherwise. A second dialect would make one
 * number read two ways in one product.
 *
 * WHAT THE CHARTS MAY CLAIM is still decided by the grain the record holds, even now
 * that two of them share an axis. Spend is attributed PER SESSION, so a day's cost bar
 * is a SUM over that day's sessions — an aggregate of the recorded grain, never a
 * subdivision of it, and a per-RUN cost curve remains a thing that does not exist to
 * draw. Outcomes take NO date axis at all: the strip is one tick per recorded run in
 * time order, because a run's result is not a quantity a day can hold, and stretching
 * it over the window would draw an empty day as a claim about runs there were none of.
 *
 * ALL THREE CHARTS SHARE ONE TIME AXIS, and they share it by reading the SAME array
 * rather than by each deriving the same bounds. `ToolUsage.skillDays` is the band's own
 * series — one point per LOCAL DAY of the window, emitted whether or not anything ran
 * (`buildSkillDays` walks the window, not the data) — and `windowDays` hands its day
 * keys to the pane's two charts as their buckets. So the reader can read straight down
 * the page: the same column is the same day in all three.
 *
 * THAT IS A FIX, not a preference. The pane's charts used to answer three different
 * questions with three different axes, and the panel contradicted itself on screen.
 * `cadenceHtml` bucketed by UTC epoch WEEK (`Math.floor(atMs / 604800000)`, so a
 * boundary that always lands on a Thursday 00:00 UTC, one clock the rest of the page
 * never uses) and then labelled its axis with the BUCKET EDGE — a date no data point
 * had to sit on. `costHtml` labelled its axis with its first and last real point.
 * Measured on one machine: the record said `First used Aug 13`, the cost chart said
 * `Aug 13`, and the cadence chart above them both said `Aug 6` — a week earlier than
 * anything that had happened, because the earliest session fell in the Aug 6–13 UTC
 * bucket. Neither chart was reachable from the band's `Jul 22 → Aug 20` either.
 *
 * WHAT THE CHARTS COUNT still differs, and that difference is real: cadence counts
 * every session, cost counts only the sessions whose spend could be attributed (most
 * agents attribute none). That used to show up as an unexplained gap between two axes;
 * now the axes agree and `costHtml` says the gap out loud instead.
 */
(function (JD) {
	"use strict";

	/* How many rows ONE Show more click adds — matching the model's own first page (the
	   Stats card's `TOOL_ROWS_LIMIT`), so the column pages in the size it opened at.

	   IT WAS 60, and that number quietly deleted the control it was paging: one fetch
	   loaded past it in a single go, so on any real corpus `shown >= total` held on the
	   first paint and the button never existed (measured: 23 skills, every range, all
	   ≤ 60 — the column read "Showing 23 of 23 skills" with nothing to click, which
	   reads as a broken control rather than as a finished list). The design mock pages
	   at its first page for this reason and its button is on screen doing its job. */
	var PAGE_ROWS = 8;

	/* Series kept in the band before the rest rolls into "Other". FIVE is the whole
	   reason: the categorical ramp holds five CVD-validated colours, so four plus
	   Other is what can be told apart. */
	var BAND_SERIES = 4;

	/* The `†` a row takes when any entry behind it was inferred rather than observed,
	   and the sentence that spells it out.

	   ONE SENTENCE, THREE PLACES, and that is the point: it rides in the dagger's
	   `title` on every marked row, is printed once under the column, and is stated
	   again in the pane. `core/SkillsAggregateMarkdown.ts` makes the same split
	   between its `†` and its footnote, and `buildSkillsSummaryLabel` leaves the
	   marker to its caller for the same reason — a dagger where a footnote is in
	   reach, words where it is not. Here the footnote IS in reach: it sits at the end of
	   the rows, which on the first screenful is the page's own scroll and after a Show
	   more is the bottom of the rows' own window — either way, the scroll that reaches
	   the last row reaches it. So the column gets both. The paging row is NOT in there —
	   it is a control, and a control may not be reachable only by scrolling the rows it
	   pages; see `navPagingHtml`.

	   IT NAMES THE COUNT, not just the inference. A reader who learns only "this was
	   inferred" still reads `47 runs` as 47 runs; the count is the figure the
	   heuristic actually changes, since Codex CLI reports one entry per session however
	   many paged reads produced it. That is the half worth the characters. */
	var INFERRED_TITLE =
		"Inferred from a file read rather than an observed invocation: a person reading the skill file " +
		"looks the same, and the run count is per session rather than per call.";
	var INFERRED_MARK = ' <span class="sk-inferred" title="' + INFERRED_TITLE + '">†</span>';

	/* Everything an async answer can land in, so the two fetches below do not have to
	   re-render each other's half. Module-scoped because the poll re-enters
	   `renderSkills`, and a local would be re-seeded from the payload on every tick —
	   dropping a pane the reader is in the middle of. */
	var state = { rows: null, paneName: null, pane: null, paneError: null };

	/* Which render is current. An answer from an earlier one must not paint over a
	   later one — the same staleness any polled surface has. */
	var seq = 0;

	/* How many rows the column asks the server for, or ZERO while the model's own first
	   page is still the whole column — the state every page load opens in, so the common
	   case costs no request at all and the first paint is the only paint.

	   Grown by Show more, and THE POLL READS THE SAME FIGURE: the 30 s refresh re-fetches
	   this list, so a fixed `PAGE_ROWS` there would silently throw away every click the
	   reader had made and shrink the column back under them. Reset by a range change for
	   free, since changing the range is a full page load.

	   Its two companions are the button's own state. `moreError` is deliberately set
	   by the POLL's failure too: once the column is short of the total, "could not
	   load more" is the honest label for a list that may be missing rows, whoever
	   asked last. */
	var pageWidth = 0;
	/* The next ranked position for a Show more read. Usually equal to rows.length;
	   kept separately because a row can shift across an offset boundary and be
	   deduped without changing the server position already consumed. */
	var pageOffset = 0;
	/* The freshest total belongs to the latest page response. A new polled model
	   resets it before that model's expanded list is verified. */
	var rowsTotal = null;
	var renderedModel = null;
	var moreLoading = false;
	var moreError = false;

	/* The height the rows region is capped at once the reader has paged past the column's
	   first screenful — MEASURED off that screenful, never declared.
	 *
	 * THE FIRST PAGE MUST NOT SCROLL. What it comes to in pixels is not something this
	 * file can know: it is `PAGE_ROWS` rows plus the column header, plus a footnote that
	 * is present only on a corpus with an inferred row. A declared constant is therefore
	 * a few pixels wrong on one of those shapes, and being wrong LOW grows a scrollbar on
	 * exactly the state that is supposed to have none. So the first paint is laid out
	 * free, its own height is read back, and that becomes the cap: Show more then grows
	 * the list INSIDE the region it opened at, instead of pushing the page down.
	 *
	 * `offsetHeight` is the BORDER box, and `.jd * { box-sizing: border-box }` makes
	 * `max-height` mean the same box — so the cap is exactly the height just measured. If
	 * that reset ever goes, this becomes 16px of padding short and the first page scrolls.
	 *
	 * RE-MEASURED ON EVERY UNPAGED PAINT rather than latched once, so it tracks what the
	 * first page actually looks like now: a poll can bring in the row that adds the
	 * footnote, and a window resize between load and click would otherwise leave a stale
	 * figure. A HIDDEN page measures 0 and is never recorded (`stats.js` guards its own
	 * cap the same way) — capping at 0 would collapse the region and hide every row, so
	 * null stands for "no cap yet" and an uncapped column is the safe way to be wrong. */
	var listCapPx = null;

	/* Whether "the address names no skill" has already been answered for this page
	   load — see the header. Nav is a full page reload, so this starts false on every
	   arrival; it is set by the default pick AND by any click, because a click is the
	   reader answering the same question themselves. */
	var defaultAnswered = false;

	/** The selected skill, read from the address rather than from a variable. */
	function selectedSkill() {
		try {
			return new URLSearchParams(window.location.search).get("skill") || null;
		} catch (_err) {
			return null;
		}
	}

	/**
	 * Writes the selection into the address without adding a history entry.
	 *
	 * `replaceState`, not `pushState`: choosing a skill is a view state of one page,
	 * so Back should leave the page rather than walk the reader through every skill
	 * they looked at.
	 */
	function setSelectedSkill(name) {
		try {
			var url = new URL(window.location.href);
			if (name) url.searchParams.set("skill", name);
			else url.searchParams.delete("skill");
			window.history.replaceState(null, "", url.toString());
		} catch (_err) {
			/* A blocked History API must not stop the pane from opening — the render
			   below reads `state.paneName`, which is set either way. */
		}
	}

	/**
	 * The rows the column is showing: the fetched page once it lands, else the first
	 * page the model already carries (`skills` view shares the Stats payload, so the
	 * first paint is never empty for a window that has data).
	 *
	 * One helper rather than the same expression twice, because the default pick below
	 * must name a row the reader can actually see — picking from a different list would
	 * open a skill with no current row anywhere in the column.
	 */
	function visibleRows(model) {
		return state.rows || modelFirstPage(model);
	}

	/**
	 * The page the model already carries, which IS the column's first page — the Stats
	 * payload this view shares, capped at the card's `TOOL_ROWS_LIMIT`.
	 *
	 * Named rather than inlined because two callers ask different questions of it: the
	 * fallback above ("what do I draw before a fetch lands") and the fetch guard in
	 * `renderSkills` ("is a fetch needed at all"). The second is what keeps a fresh page
	 * load at zero requests, so the two must read the same list.
	 */
	function modelFirstPage(model) {
		var usage = (model.stats && model.stats.toolUsage) || {};
		return usage.skills || [];
	}

	/**
	 * The skill to open when the address names none — the top row, which is the
	 * server's adoption order.
	 *
	 * IT IS WRITTEN INTO THE ADDRESS, not just into `state`: every render re-reads the
	 * address, so a selection living only in `state` is wiped by the next one, and a
	 * reload or a shared link would land back on the empty pane.
	 *
	 * AN EMPTY LIST LEAVES THE QUESTION OPEN (the flag stays down): there is no row to
	 * open, and "no skill invocations in this window" is what both halves of the page
	 * already say. A wider range is a fresh page load, so it asks again from scratch.
	 *
	 * The fetched page below is deliberately NOT re-asked: `skills` and `skillsTotal`
	 * come from one WHERE, so an empty first page means a total of zero and no further
	 * page is ever requested — there is no late arrival that could hold the top row.
	 */
	function defaultSelection(model) {
		if (defaultAnswered) return null;
		var rows = visibleRows(model);
		if (rows.length === 0) return null;
		defaultAnswered = true;
		setSelectedSkill(rows[0].name);
		return rows[0].name;
	}

	function renderSkills(model) {
		var app = document.getElementById("app");
		if (!app) return;
		var mine = ++seq;
		if (renderedModel !== model) {
			renderedModel = model;
			var freshUsage = (model.stats && model.stats.toolUsage) || {};
			rowsTotal = freshUsage.skillsTotal || 0;
			if (pageWidth === 0) pageOffset = modelFirstPage(model).length;
		}
		var selected = selectedSkill();
		if (!selected) selected = defaultSelection(model);
		/* A different skill invalidates the cached pane, so the reader never sees the
		   previous skill's figures under the new skill's name. */
		if (state.paneName !== selected) state = { rows: state.rows, paneName: selected, pane: null, paneError: null };

		draw(app, model);

		/* ONLY once a click has asked for more than the model already carries. The model's
		   first page IS the column's first page, so an unconditional fetch re-requests
		   rows already in hand — and while `PAGE_ROWS` was 60 it also loaded straight past
		   the paging control, which is what made the control unreachable. */
		if (pageWidth > modelFirstPage(model).length) {
			fetchRows(app, model, mine, [], 0, Math.min(pageWidth, skillTotal(model)));
		}

		if (!selected) return;
		JD.getJson(JD.withParams("/api/skill-detail" + JD.query(model, {}), { name: selected }))
			.then(
				(detail) => {
					if (mine !== seq || state.paneName !== selected) return false;
					state.pane = detail;
					return true;
				},
				/* THE TWO-CALLBACK FORM, never a trailing `.catch`, and the repaint moved out
				   of both: this handler must see the REQUEST's failure and nothing else.
				   While the repaint sat inside the success callback, a throw from ANY chart
				   in the pane landed here instead — and `paneErrorText` reads a missing
				   `status` as "nothing reached a server", so a `ReferenceError` in a tick
				   title was reported to the reader as a dashboard that had stopped, while it
				   was answering fine. A render fault is now unhandled and reaches the
				   console, which is where a bug in this file belongs. */
				(err) => {
					if (mine !== seq || state.paneName !== selected) return false;
					state.paneError = paneErrorText(err);
					return true;
				},
			)
			.then((changed) => {
				if (changed) draw(app, model);
			});
	}

	/**
	 * Reads enough ranked pages to reach `wanted`, starting at one explicit server
	 * offset and deduping against rows already held.
	 *
	 * Show more starts after the current page and appends. The poll starts from zero and
	 * rebuilds the width on screen; when that width exceeds the route's per-request cap,
	 * the short response advances `offset` and the next request finishes it. Progress is
	 * measured in raw server rows while identity dedupe is measured by skill name, so a
	 * row shifting across a page boundary neither duplicates nor stalls the control.
	 */
	function collectRows(model, mine, initialRows, initialOffset, wanted) {
		var rows = initialRows.slice();
		var names = Object.create(null);
		rows.forEach((row) => {
			names[row.name] = true;
		});
		var offset = initialOffset;
		var total = skillTotal(model);

		function next() {
			if (mine !== seq || rows.length >= wanted || offset >= total) {
				if (offset >= total && rows.length < total) total = rows.length;
				return Promise.resolve({ rows: rows, offset: offset, total: total });
			}
			return JD.getJson(
				JD.withParams("/api/tool-usage" + JD.query(model, {}), {
					list: "skill",
					offset: String(offset),
					limit: String(wanted - rows.length),
				}),
			).then((page) => {
				if (mine !== seq) return { rows: rows, offset: offset, total: total };
				var incoming = (page && page.rows) || [];
				if (page && typeof page.totalCount === "number") total = page.totalCount;
				incoming.forEach((row) => {
					if (!names[row.name]) {
						names[row.name] = true;
						rows.push(row);
					}
				});
				offset += incoming.length;
				if (incoming.length === 0) total = rows.length;
				return next();
			});
		}

		return next();
	}

	function fetchRows(app, model, mine, initialRows, initialOffset, wanted) {
		collectRows(model, mine, initialRows, initialOffset, wanted)
			.then(
				(result) => {
					if (mine !== seq) return false;
					state.rows = result.rows;
					pageWidth = result.rows.length;
					pageOffset = result.offset;
					rowsTotal = result.total;
					moreLoading = false;
					moreError = false;
					return true;
				},
				/* Two callbacks, for the reason `renderSkills` states: under a trailing
				   `.catch` a throw from the repaint would land here and paint "could not
				   load more" over a page of rows that had just arrived intact. */
				() => {
					if (mine !== seq) return false;
					/* THE ROWS ARE LEFT ALONE — a list that empties itself over one failed
					   fetch is worse than a short one, and the poll asks again in 30 s. Only
					   the button's state moves, because a click that silently stayed on
					   "Loading…" forever is the one failure the reader cannot wait out. */
					moreLoading = false;
					moreError = true;
					return true;
				},
			)
			.then((changed) => {
				if (changed) draw(app, model);
			});
	}

	/**
	 * One more page, on the reader's ask.
	 *
	 * Deliberately NOT `renderSkills`, which would also re-fetch the open pane's detail
	 * — a second round trip for a pane whose skill has not changed. This grows the
	 * width, paints the button as busy, and re-reads the rows and nothing else.
	 */
	function loadMoreRows(app, model) {
		if (moreLoading) return;
		var current = visibleRows(model);
		var shown = current.length;
		var total = skillTotal(model);
		if (shown >= total) return;
		pageWidth = Math.min(shown + PAGE_ROWS, total);
		moreLoading = true;
		moreError = false;
		/* Paint the busy label before the request, so a slow answer is visibly pending
		   rather than a click that appeared to do nothing. */
		draw(app, model);
		fetchRows(app, model, seq, current, pageOffset || shown, pageWidth);
	}

	function skillTotal(model) {
		if (rowsTotal !== null) return rowsTotal;
		var usage = (model.stats && model.stats.toolUsage) || {};
		return usage.skillsTotal || 0;
	}

	/**
	 * What to tell the reader when the detail could not be loaded.
	 *
	 * The two failures need OPPOSITE advice, and they used to be reported as one:
	 *
	 *   - **No `status`** — `fetch` itself rejected, so nothing reached a server. Its
	 *     message is the browser's own "Failed to fetch", which said nothing about a
	 *     server having gone away and read as "HTTP Failed to fetch" once a caller
	 *     labelled it. The dashboard is not running any more; start it again.
	 *   - **A `status`** — a server answered and refused. A build predating this route
	 *     404s exactly as a skill with no calls in the window does, and only the first
	 *     of those is fixed by restarting.
	 *
	 * `status` rather than a message pattern, because the message is a browser string
	 * on one path and a server's `error` field on the other — neither is ours to match on.
	 *
	 * IT IS ONLY EVER ASKED ABOUT THE REQUEST, which is what makes that reading sound.
	 * `renderSkills` calls it from the fetch's own rejection callback, never from a
	 * `.catch` spanning the repaint as well: "no `status`, so the server is gone" is a
	 * fair reading of a failed fetch and a plainly false one for an error thrown while
	 * drawing a chart, and it was reported to readers as a stopped dashboard for as long
	 * as the two shared a handler.
	 */
	function paneErrorText(err) {
		if (err && typeof err.status === "number") {
			return (
				"Could not load this skill — the dashboard answered " +
				err.status +
				". If it has been running since before this view existed, restart it." +
				" This view needs a current server."
			);
		}
		return "Could not reach the dashboard server. It may have stopped — run `jolli dashboard` again.";
	}

	/**
	 * Whether the reader has asked for rows beyond the page the column opened with.
	 *
	 * `pageWidth` is the one thing that answers it: it is zero for the whole life of a
	 * page load that never presses Show more, and only `loadMoreRows` (and the fetch it
	 * starts) ever raises it. Row COUNTS cannot answer it — the poll can return a
	 * different number of first-page rows without the reader having asked for anything.
	 */
	function isPaged() {
		return pageWidth > 0;
	}

	/**
	 * The rows region's opening tag — a scroll region ONLY once Show more has been
	 * pressed, and then only as tall as the first page measured.
	 *
	 * THE FIRST SCREENFUL HAS ONE SCROLLBAR, the window's. That is the whole rule: a
	 * column showing everything it has needs no window onto itself, and a second bar
	 * there on arrival is one more scroll region for the reader to discover before they
	 * have asked for anything. A click asking for more rows than the column opened with
	 * is what puts them behind a window — an outcome the reader can attribute to what
	 * they just did.
	 *
	 * THE CAP IS AN INLINE STYLE because it is a measured pixel value (see `listCapPx`),
	 * which no stylesheet constant can stand in for; `.sk-list.sk-scroll` in `main.css`
	 * carries everything about it that is not that number, including the visible
	 * scrollbar the platform will not draw. With no cap recorded yet the region stays
	 * uncapped — the safe direction, since an uncapped column is merely tall.
	 */
	function listOpenTag() {
		if (!isPaged() || listCapPx === null) return '<div class="sk-list">';
		return '<div class="sk-list sk-scroll" style="max-height:' + Math.round(listCapPx) + 'px">';
	}

	function draw(app, model) {
		var usage = (model.stats && model.stats.toolUsage) || {};
		var rows = visibleRows(model);
		/* THE ROWS' OFFSET IS CARRIED ACROSS BY HAND, because the write below replaces the
		   node that holds it — and only that node scrolls, so this is the whole of it.
		 *
		 * Every path here repaints the WHOLE page — a row click, that row's detail landing
		 * moments later, a Show more, the 30 s poll — so without this the column snapped
		 * back to its first row on all four. Clicking the 18th skill scrolled the list away
		 * from the row that was just clicked, which also takes the `aria-current` row off
		 * screen; and the poll did it unprompted every 30 s, mid-read.
		 *
		 * A whole-page repaint is what this view is built on (`renderSkills` re-reads the
		 * address on every render), so restoring the offset is the fix that fits it —
		 * repainting only the changed region, as `memories.js` does, is a bigger change
		 * for the same outcome here. */
		var previous = app.querySelector(".sk-list");
		var offset = previous ? previous.scrollTop : 0;
		app.innerHTML =
			'<section class="skills-page">' +
			bandHtml(usage) +
			'<aside class="sk-nav" aria-label="Skills browser">' +
			navHeadHtml(usage) +
			listOpenTag() +
			listHtml(rows) +
			"</div>" +
			navPagingHtml(rows, usage) +
			navFootHtml(usage) +
			"</aside>" +
			'<article class="sk-pane" aria-label="Skill detail">' +
			paneHtml(usage, model.timeZone) +
			"</article>" +
			"</section>";
		/* Both halves address the NEW node. The measurement runs BEFORE the restore for no
		   reason beyond reading order — they touch different properties — but it must run
		   while the region is still uncapped, which `isPaged` is what guarantees.
		 *
		 * The restore is conditional because assigning 0 to a fresh render is a no-op that
		 * would still cost a layout write. A shrunk list (the poll returning fewer rows) is
		 * clamped by the browser, so this cannot leave the column past its own content. */
		var list = app.querySelector(".sk-list");
		if (list) {
			if (!isPaged() && rows.length > 0 && list.offsetHeight > 0) listCapPx = list.offsetHeight;
			if (offset > 0) list.scrollTop = offset;
		}
		bindSelection(app, model);
		bindMore(app, model);
	}

	// ── The band ────────────────────────────────────────────────────────────────

	/**
	 * Every skill's adoption, day by day.
	 *
	 * THE KEPT SET FOLLOWS THE SELECTION, which is the one rule `JD.topSeries` cannot
	 * express: a selected skill outside the top four is swapped into the fourth slot,
	 * because otherwise "highlight this skill" fails for exactly the skills the
	 * roll-up hides — and dimming the Other segments instead would claim several
	 * skills' aggregate is one skill.
	 */
	function bandHtml(usage) {
		var series = usage.skillDays || [];
		var head =
			'<div class="sk-band"><div class="sk-nav-head" style="padding:0 0 10px;border-bottom:0">' +
			"<b>All skills, day by day</b> · sessions that reached for each skill · " +
			"a session using several skills counts once per skill</div>";

		var totals = {};
		series.forEach((point) => {
			Object.keys(point.bySeries || {}).forEach((name) => {
				totals[name] = (totals[name] || 0) + point.bySeries[name];
			});
		});
		var names = Object.keys(totals);
		/* THE EMPTY TEST IS "no series", NOT "no points". `skillDays` carries one point
		   per day of the window whether or not anything ran, so it is never empty once
		   a window exists — a `series.length` test (what the week buckets needed, since
		   they were derived from the data's own range) would draw an axis, four
		   gridlines and an empty legend for a window with no skill use at all. */
		if (names.length === 0) {
			return head + '<div class="empty-note">No skill invocations recorded in this window.</div></div>';
		}
		var selected = state.paneName && totals[state.paneName] !== undefined ? state.paneName : null;
		var ranked = names.slice().sort((a, b) => totals[b] - totals[a] || (a < b ? -1 : a > b ? 1 : 0));
		var kept = ranked.slice(0, BAND_SERIES);
		if (selected && kept.indexOf(selected) === -1) kept = kept.slice(0, BAND_SERIES - 1).concat([selected]);
		var keptSet = {};
		kept.forEach((name) => {
			keptSet[name] = true;
		});

		var rolled = series.map((point) => {
			var bySeries = {};
			var other = 0;
			Object.keys(point.bySeries || {}).forEach((name) => {
				if (keptSet[name]) bySeries[name] = point.bySeries[name];
				else other += point.bySeries[name];
			});
			bySeries.Other = other;
			return { date: point.date, bySeries: bySeries };
		});
		var keys = kept.concat(["Other"]);
		var otherTotal = names.reduce((sum, name) => sum + (keptSet[name] ? 0 : totals[name]), 0);

		var legend = keys
			.map((key, index) => {
				var value = key === "Other" ? otherTotal : totals[key];
				var body =
					'<i style="background:' + JD.seriesColor(index) + '"></i><b>' + JD.esc(key) + "</b> " + value;
				/* Other is a span, not a button: an aggregate of several skills is not a
				   subject a reader can open. */
				if (key === "Other") return '<span class="sk-legend' + (selected ? " sk-dim" : "") + '">' + body + "</span>";
				return (
					'<button type="button" class="sk-legend' +
					(selected && key !== selected ? " sk-dim" : "") +
					'" data-skill="' +
					JD.esc(key) +
					'" aria-pressed="' +
					String(key === selected) +
					'">' +
					body +
					"</button>"
				);
			})
			.join("");

		return (
			head +
			'<div class="sk-bandrow"><div class="chart-box">' +
			/* An integer formatter, not the default `fmtTokens`: "0.5" on an axis counting
			   sessions is a claim the unit cannot make. */
			JD.stackedBars(rolled, keys, "skill sessions", (n) => String(Math.round(n))) +
			'</div><div class="sk-key">' +
			legend +
			"</div></div></div>"
		);
	}

	// ── The chooser column ──────────────────────────────────────────────────────

	function navHeadHtml(usage) {
		var runs = usage.skillCallsTotal || 0;
		var skills = rowsTotal === null ? usage.skillsTotal || 0 : rowsTotal;
		var agents = (usage.skillAgents || []).length;
		return (
			'<div class="sk-nav-head"><b>' +
			runs +
			(runs === 1 ? "</b> run · <b>" : "</b> runs · <b>") +
			skills +
			(skills === 1 ? "</b> skill · <b>" : "</b> skills · <b>") +
			agents +
			(agents === 1 ? "</b> agent</div>" : "</b> agents</div>")
		);
	}

	/**
	 * The list. THE ORDER IS THE SERVER'S (adoption) and the header is NOT a sort
	 * control: these rows are one page of a ranked list, so re-sorting them by tokens
	 * would name a "heaviest" that may sit unloaded on the next page.
	 */
	function listHtml(rows) {
		if (rows.length === 0) return '<div class="empty-note">No skill invocations recorded in this window.</div>';
		var selected = state.paneName;
		var html =
			'<div class="sk-cols" aria-hidden="true"><span>Skill</span><span>Runs</span><span>Tokens</span></div><ul class="ranklist">';
		rows.forEach((row) => {
			html +=
				'<li><button type="button" class="sk-row" data-skill="' +
				JD.esc(row.name) +
				'"' +
				(row.name === selected ? ' aria-current="true"' : "") +
				' aria-label="' +
				(row.name === selected ? "Clear selection of " : "Read ") +
				JD.esc(row.name) +
				": " +
				row.calls +
				(row.calls === 1 ? " run" : " runs") +
				/* Spelled into the label too, because the `†` below is a `title` and a
				   screen reader is not obliged to announce one. "Inferred" alone would
				   also be the wrong half — the reader has just been told a run count. */
				(row.detection === "heuristic" ? ", inferred, run count is per session" : "") +
				'">' +
				'<span class="sk-name mono" title="' +
				JD.esc(row.name) +
				'">' +
				JD.esc(row.name) +
				(row.plugin ? ' <span class="sk-plugin">' + JD.esc(row.plugin) + "</span>" : "") +
				/* After the plugin chip: the chip is part of the skill's identity and the
				   dagger is a qualifier on the row's figures, so it reads last. */
				(row.detection === "heuristic" ? INFERRED_MARK : "") +
				"</span>" +
				'<span class="num">' +
				row.calls +
				"</span>" +
				'<span class="num sk-tok">' +
				tokenCell(row) +
				"</span>" +
				"</button></li>";
		});
		return html + "</ul>" + inferredFootnoteHtml(rows);
	}

	/**
	 * The paging row, PINNED BELOW THE ROWS rather than inside them.
	 *
	 * IT IS A CONTROL, so it may not be reachable only by scrolling the very rows it
	 * pages — and from the first Show more onwards those rows ARE a capped region, so
	 * inside it that is exactly what it would be. Measured back when the region was
	 * capped from the first paint: at a 1440x900 viewport the list showed 7 of 23 rows
	 * and the row sat 882px past its fold, while the window itself scrolled 3px, so a
	 * reader spinning the wheel over the page never moved the list at all. The first
	 * screenful no longer has that problem (nothing is capped until a click), but the
	 * click that creates the cap is the same click that needs this button again, so the
	 * placement is what keeps it in reach. The head and the coverage foot are pinned for
	 * this same reason; this belongs with them, and the region keeps only the rows and
	 * their footnote.
	 *
	 * NOTHING AT ALL on an empty column, which is what a row inside `listHtml` got for
	 * free from its early return: `Showing 0 of 0 skills` under a note that already
	 * says there are no invocations is the same sentence twice.
	 */
	function navPagingHtml(rows, usage) {
		if (rows.length === 0) return "";
		return '<div class="sk-paging">' + moreRowHtml(rows, usage) + "</div>";
	}

	/**
	 * `Showing 12 of 40 skills`, plus the button that fetches the next page.
	 *
	 * ALWAYS PRESENT once there is a row, unlike the Stats cards' version which hides
	 * itself until a click has grown the list. That rule exists because those three
	 * cards share one equal-third band and dropping the row resized the card under the
	 * reader; here the row is the last band of a column whose height is its own content,
	 * so keeping it costs one line — and it is the only place the reader is told the
	 * column IS the whole list. Without it a 60-row column and a 60-of-300 column look
	 * identical.
	 *
	 * Same classes and same wording as `stats.js`'s `toolMoreRow`, so the two read as
	 * one control at two zooms rather than two conventions.
	 */
	function moreRowHtml(rows, usage) {
		var shown = rows.length;
		var total = rowsTotal === null ? (usage && usage.skillsTotal) || shown : rowsTotal;
		var count =
			'<span class="more-count">Showing ' +
			shown +
			" of " +
			total +
			(total === 1 ? " skill" : " skills") +
			/* The failure belongs beside the count it stopped from growing: this button
			   still being here IS why it matters. */
			(moreError && !moreLoading ? " — could not load more" : "") +
			"</span>";
		if (shown >= total) return '<div class="more-row is-done">' + count + "</div>";
		var label = moreLoading ? "Loading…" : moreError ? "Try again" : "Show more";
		return (
			'<div class="more-row">' +
			count +
			'<button type="button" class="cta ghost sm" data-skillmore' +
			(moreLoading ? " disabled" : "") +
			">" +
			label +
			"</button></div>"
		);
	}

	/**
	 * The `†` spelled out under the column, and only when a loaded row wears one.
	 *
	 * ON THE ROWS IN HAND, not on a window-wide flag: a footnote explaining a mark that
	 * is nowhere on screen is a reader hunting for something that is not there. So a
	 * Show more click can bring the footnote in, which is correct — the mark arrived
	 * with it.
	 */
	function inferredFootnoteHtml(rows) {
		var marked = rows.some((row) => row.detection === "heuristic");
		if (!marked) return "";
		return '<span class="sk-basis">† ' + INFERRED_TITLE + "</span>";
	}

	/**
	 * The Tokens cell: an em dash where nothing was attributed, `~` on an estimate.
	 *
	 * The dash is load-bearing. Most agents attribute no spend to a skill at all
	 * (measured on one machine: 105 of 116 rows came from Codex, which reports none),
	 * and a `0` there reads as "measured, and it was free".
	 */
	function tokenCell(row) {
		var usage = row.usage;
		if (!usage) return "&mdash;";
		var total = usage.input + usage.output + usage.cached;
		return (usage.confidence === "estimated" ? "~" : "") + JD.fmtTokens(total);
	}

	/**
	 * The coverage denominator, in the grammar the Skills and MCPs cards print: how
	 * many of the window's sessions could be read for tool calls at all. Without it
	 * every figure above reads as if it covered every session.
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
			return '<div class="sk-pane-empty">Select a skill to read how its use, cost and reliability moved over time.</div>';
		}
		if (state.paneError) return '<div class="sk-pane-empty">' + JD.esc(state.paneError) + "</div>";
		var detail = state.pane;
		if (!detail) return '<div class="sk-pane-empty">Loading…</div>';

		var callsTotal = usage.skillCallsTotal || 0;
		var share = callsTotal ? Math.round((detail.calls / callsTotal) * 100) : 0;
		var perSession = detail.sessions ? (detail.calls / detail.sessions).toFixed(1) : "—";

		var html =
			'<div class="sk-panebody"><div class="sk-title mono">' +
			JD.esc(detail.name) +
			(detail.plugin
				? ' <span class="sk-plugin">' + JD.esc(detail.plugin) + "</span>"
				: '<span class="sk-kind">skill</span>') +
			(detail.detection === "heuristic" ? INFERRED_MARK : "") +
			"</div>" +
			'<div class="sk-figs">' +
			fig(detail.calls, "runs") +
			fig(detail.sessions, "sessions") +
			fig(perSession, "runs per session") +
			fig(share + "%", "of all skill runs") +
			"</div>" +
			inferredCaveatHtml(detail);

		/* FIVE SECTIONS, and the mockup's set exactly. `SkillDetail` also carries
		   `commits` and `categories`, and a sixth "What it produced" section rendering
		   them was tried and removed: measured on one machine only 27 of 111 skill rows
		   linked to a commit at all, so the section it produced read "None of this
		   skill's work is committed yet" on three rows in four — and when it did have
		   rows, the churn figures on them were the COMMIT's, not the skill's, on commits
		   that usually carry other work too. The server still computes both fields; they
		   have no reader here on purpose, the way `MemoriesModel.vitals` does. */
		var days = windowDays(usage);
		html += section("How often it ran", cadenceHtml(detail, days, timeZone));
		html += section(costTitle(detail), costHtml(detail, days, timeZone));
		html += section("Run outcomes", outcomeHtml(detail, timeZone));
		html += section("The record", recordHtml(detail, timeZone));
		html += section("Who ran it", agentsHtml(detail));

		html +=
			'<span class="sk-basis">Runs, sessions and the agent split are counted over this window. The two ' +
			"charts above share the day axis the chart at the top of the page uses, so a column is the same day " +
			"in all three; spend is attributed per session and summed per day, never per run. Outcomes are per " +
			"recorded run and carry no date axis.</span>";
		return html + "</div>";
	}

	function fig(value, label) {
		return '<div class="sk-fig"><b class="num">' + JD.esc(String(value)) + "</b><span>" + label + "</span></div>";
	}

	/**
	 * What qualifies the four figures above it, when any entry behind them was inferred
	 * from a file read rather than observed.
	 *
	 * DIRECTLY UNDER THE FIGURES, not folded into `sk-basis` at the foot of the pane.
	 * Three of those four are run counts — `runs`, `runs per session`, `of all skill
	 * runs` — and the count is precisely what the inference changes: an inferred entry
	 * is recorded once per session however many paged reads produced it, so the number
	 * is a floor rather than a measurement. A caveat two screens below the figure it
	 * qualifies is one the reader meets after having already believed the figure.
	 *
	 * "AT LEAST ONE ENTRY", never "this skill" or "this agent". The mark is any-one-taints
	 * across the whole window, so a skill entered properly in one session and inferred in
	 * another carries it — naming the skill or its host would overstate what is known and
	 * be plainly wrong on a row that mixes the two.
	 */
	function inferredCaveatHtml(detail) {
		if (detail.detection !== "heuristic") return "";
		return (
			'<div class="sk-caveat">† At least one entry here was inferred from a command that read the skill ' +
			"file, not from an observed invocation — a person reading that file leaves the same trace, and " +
			"reading it is not the same as using it. Inferred entries are counted once per session however " +
			"many reads produced them, so the run figures above are a floor rather than a count.</div>"
		);
	}

	function section(title, body) {
		return '<div class="sk-sec"><h4>' + title + "</h4>" + body + "</div>";
	}

	function line(label, value, swatch) {
		return (
			'<div class="sk-line">' +
			(swatch ? '<i style="background:' + swatch + '"></i>' : "") +
			"<b>" +
			JD.esc(label) +
			"</b><span>" +
			JD.esc(value) +
			"</span></div>"
		);
	}

	/**
	 * `Aug 17`, from an epoch instant, in the same zone as the server's day buckets.
	 *
	 * ROUTED THROUGH THE DAY KEY rather than formatting the instant directly, so the
	 * record's dates and the charts' axis labels are the same two functions in the same
	 * order. They used to be two independent formatters that happened to agree, and this
	 * pane has already shipped one bug of exactly that shape (see the header: an axis
	 * labelled from a bucket edge beside a record labelled from the data).
	 *
	 * THE ZONE IS A PARAMETER, never read off an enclosing `model`. Everything in this
	 * pane is reached from `draw`, which does hold the model — but `paneHtml` and its
	 * sections took only the data they rendered, so a free `model` here resolved to
	 * nothing at all, and the old `catch` hid it by quietly printing `2026-08-20` where
	 * `Aug 20` belonged. The sibling pages (`stats.js`, `memories.js`, `standup.js`)
	 * thread the zone down the same way.
	 */
	function shortDay(atMs, timeZone) {
		return JD.dayLabel(JD.dayKey(atMs, timeZone));
	}

	/**
	 * The window's local days, taken from the BAND'S OWN series.
	 *
	 * Not recomputed from the range: `buildSkillDays` walks the window with
	 * `addLocalDays` precisely because a fixed 86,400,000 skips or repeats a bucket on
	 * a DST day, and a client-side second implementation of that would disagree with
	 * the band exactly on those days, silently. Reading its keys makes the three charts
	 * share an axis by construction rather than by two calculations agreeing.
	 *
	 * EMPTY IS A REAL ANSWER and the charts fall back to their own data's days — the
	 * band emits a point per day of any window that exists, so this is empty only when
	 * the payload carried no band at all. A chart drawn over its own extent is narrower
	 * than the window but still honest; refusing to draw would lose the reader more.
	 */
	function windowDays(usage) {
		return (usage.skillDays || []).map((point) => point.date);
	}

	/**
	 * Which day keys a pane chart lays out: the window's, or its own points' as the
	 * fallback above describes. De-duplicated and sorted, since a fallback built from
	 * session points has one entry per session rather than per day.
	 */
	function chartDays(days, points, timeZone) {
		if (days.length > 0) return days;
		var seen = Object.create(null);
		points.forEach((point) => {
			seen[JD.dayKey(point.atMs, timeZone)] = true;
		});
		return Object.keys(seen).sort();
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
			   range that is not one — the rule `JD.stackedBars` states for the band. */
			(days.length > 1 ? "<span>" + JD.esc(JD.dayLabel(days[days.length - 1])) + "</span>" : "") +
			"</div>"
		);
	}

	/**
	 * Sessions per day over the window — "was it used more or less".
	 *
	 * Every day of the window is drawn, empty ones included, for the reason the band
	 * walks the window: bars are laid out by index, so dropping a quiet day compresses
	 * the axis and makes a fortnight's gap look like a busy stretch.
	 */
	function cadenceHtml(detail, days, timeZone) {
		var points = detail.sessionSeries || [];
		if (points.length === 0) return '<div class="sk-note">No per-session record survives for this skill.</div>';
		var buckets = chartDays(days, points, timeZone);
		var index = Object.create(null);
		buckets.forEach((day, position) => {
			index[day] = position;
		});
		var counts = buckets.map(() => 0);
		points.forEach((point) => {
			/* A point outside the window is dropped, never clamped onto an edge bucket —
			   `buildSkillDays` states the same rule for the same reason: the SQL filters on
			   epoch bounds while these buckets are local day keys, so the only points this
			   can reject are the boundary's own rounding, and filing one under a day it did
			   not happen on would be worse than leaving it out. */
			var position = index[JD.dayKey(point.atMs, timeZone)];
			if (position !== undefined) counts[position]++;
		});
		return barsHtml(buckets, counts, "Sessions per day", (n) => n + (n === 1 ? " session" : " sessions"));
	}

	function costTitle(detail) {
		if (!detail.usage) return "What it cost";
		return detail.usage.confidence === "estimated" ? "What it cost (estimated)" : "What it cost";
	}

	/**
	 * Tokens per DAY over the window — the "did it get cheaper" read, on the cadence
	 * chart's own axis so the two can be read against each other.
	 *
	 * SPEND IS STILL ATTRIBUTED PER SESSION and this does not claim otherwise: a day's
	 * bar is the sum of the sessions that landed in it, which is an aggregate of the
	 * grain the record holds rather than a subdivision of it. A per-RUN curve remains
	 * the thing that does not exist to draw.
	 *
	 * IT DRAWS FROM THE PRICED POINTS ONLY, which is why the gap sentence below exists.
	 * Most agents attribute no spend to a skill at all, so a session with no `tokens`
	 * cannot enter this chart — filling it with a zero would claim the session was free.
	 * Before the two charts shared an axis that omission was invisible and showed up
	 * only as two axes disagreeing; on one axis it is a run of empty days at the left
	 * that the cadence chart above fills, so the count is stated in words.
	 */
	function costHtml(detail, days, timeZone) {
		if (!detail.usage) {
			return '<div class="sk-note">This agent cannot attribute spend to a skill. No figure is shown rather than a zero.</div>';
		}
		var usage = detail.usage;
		var mark = usage.confidence === "estimated" ? "~" : "";
		var points = detail.sessionSeries || [];
		var priced = points.filter((point) => point.tokens != null);
		var chart = "";
		/* ONE priced session is now enough, where the per-session version needed two.
		   That rule existed because a lone bar has no slope to read — true of a chart
		   whose x-axis was just "the points, in order", and false of one whose x-axis is
		   the window: a single bar against 30 dated days says WHEN the spend happened,
		   which is a reading the old chart could not offer. */
		if (priced.length > 0) {
			/* The CADENCE chart's buckets, not the priced points' own: the whole point is
			   that a column means the same day in both. The fallback extent is likewise
			   taken from every session rather than from the priced ones. */
			var buckets = chartDays(days, points, timeZone);
			var index = Object.create(null);
			buckets.forEach((day, position) => {
				index[day] = position;
			});
			var totals = buckets.map(() => 0);
			priced.forEach((point) => {
				var position = index[JD.dayKey(point.atMs, timeZone)];
				if (position !== undefined) totals[position] += point.tokens;
			});
			chart = barsHtml(buckets, totals, "Tokens per day", (n) => mark + JD.fmtTokens(n));
		}
		var unpriced = points.length - priced.length;
		var total = usage.input + usage.output + usage.cached;
		return (
			chart +
			/* Beside the chart it qualifies, not folded into the coverage line below: that
			   line is a fraction of SESSIONS while this explains why the bars start where
			   they do. Only when the chart is actually drawn — with no chart there is
			   nothing for it to be about, and the coverage line already carries the count. */
			(chart && unpriced > 0
				? '<div class="sk-note">' +
					unpriced +
					(unpriced === 1
						? " session attributed no spend, so it is"
						: " sessions attributed no spend, so they are") +
					" not in this chart — a quiet day here may still be a busy one above.</div>"
				: "") +
			line("Total", mark + JD.fmtTokens(total)) +
			'<div class="sk-note">' +
			mark +
			JD.fmtTokens(usage.input) +
			" in · " +
			mark +
			JD.fmtTokens(usage.output) +
			" out · " +
			mark +
			JD.fmtTokens(usage.cached) +
			" cached · " +
			usage.sessions +
			" of " +
			detail.sessions +
			" sessions carry usage</div>"
		);
	}

	/**
	 * The recorded runs as ticks, oldest first, plus the counts.
	 *
	 * EVERY entry is drawn, because every entry is a run that happened, in the mockup's
	 * TWO colours: red for a measured failure, quiet green for everything else. Drawing
	 * only the measured ones used to empty this entire section on the common machine,
	 * where nearly every Claude skill is entered by slash command — runs that were fully
	 * on record, described to the reader as nothing.
	 *
	 * A run whose result the agent never wrote down (three of the six entry mechanisms
	 * write none, so their stored `ok: true` is the absence of a failure report rather
	 * than a report of success) takes the same green tick and is named in WORDS below.
	 * A grey third state was tried for it and read as "empty" rather than "unmeasured",
	 * which is the wrong signal on a skill where every run is in that class. The hover
	 * title still says "outcome not recorded" per tick.
	 *
	 * The percentage stays over `measured` alone and the unknowable runs are stated in
	 * words instead. A rate computed over both would read as "nothing failed" about runs
	 * nobody can speak for, which is the one sentence this data cannot support.
	 */
	function outcomeHtml(detail, timeZone) {
		/* Absent outcomes means "no entry row at all" — an archived commit's merged count,
		   or a transcript the agent pruned — not "the result was unknowable", which is the
		   case the `assumed` sentence below covers. */
		if (!detail.outcomes) {
			return '<div class="sk-note">No per-entry record survives for this skill, so no run outcome is shown.</div>';
		}
		var measured = detail.outcomes.measured;
		var failed = detail.outcomes.failed;
		var assumed = detail.outcomes.assumed || 0;
		var invocations = detail.invocations || [];
		var ticks = invocations
			.map(
				(inv) =>
					'<i class="' +
					(inv.outcomeKnown && !inv.ok ? "bad" : "") +
					'" title="' +
					JD.esc(JD.dayKey(inv.atMs, timeZone)) +
					(inv.args ? " · " + JD.esc(inv.args) : "") +
					" · " +
					(inv.outcomeKnown ? (inv.ok ? "ok" : "failed") : "outcome not recorded") +
					'"></i>',
			)
			.join("");
		var strip = ticks
			? '<div class="sk-ticks" role="img" aria-label="Recorded runs, oldest to newest">' + ticks + "</div>"
			: "";
		/* Empty when nothing was measured, rather than "0 runs failed": with no reading
		   there is no denominator, and the sentence below is the whole answer. */
		var counts = "";
		if (measured > 0) {
			counts =
				failed > 0
					? line(failed + " of " + measured + (measured === 1 ? " run failed" : " runs failed"), Math.round((failed / measured) * 100) + "%")
					: '<div class="sk-note">' + measured + (measured === 1 ? " run" : " runs") + " recorded an outcome; none failed.</div>";
		}
		/* Phrased as what the record is missing, never as "N succeeded". Where nothing at
		   all was measured the mechanism is named as the reason, so the reader learns this
		   is a property of how the skill was entered rather than a gap in their own data. */
		var unknown = "";
		if (assumed > 0) {
			unknown =
				'<div class="sk-note">' +
				(measured > 0
					? assumed +
						(assumed === 1 ? " further run" : " further runs") +
						" recorded no outcome, so success or failure is unknown for those."
					: assumed +
						(assumed === 1 ? " run is" : " runs are") +
						" on record, but this skill's entry mechanism writes no result, so success or failure is unknown.") +
				"</div>";
		}
		/* Against `calls`, the exact total — not against the strip, which is capped and
		   would overstate the gap on a busy skill. BOTH counted classes come off it, so
		   what remains is the runs that left no entry row at all. */
		var unrecorded = detail.calls - measured - assumed;
		var gap =
			unrecorded > 0
				? '<div class="sk-note">' +
					unrecorded +
					(unrecorded === 1 ? " further run" : " further runs") +
					" left no per-entry record.</div>"
				: "";
		/* Both classes again: the strip draws every entry now, so the cap is against the
		   entry total rather than against the measured ones. */
		var entries = measured + assumed;
		var capped =
			invocations.length > 0 && entries > invocations.length
				? '<div class="sk-note">Ticks are the ' +
					invocations.length +
					" most recent of " +
					entries +
					" recorded runs; the counts above stay exact.</div>"
				: "";
		return strip + counts + unknown + gap + capped;
	}

	/** Everything that is a fact rather than a trend, in one two-column grid. */
	function recordHtml(detail, timeZone) {
		var rows = "";
		var entered = enteredBy(detail.entryPaths);
		if (entered) rows += line("Entered by", entered);
		/* Chars, not tokens — this is a body length. `fmtTokens` is reused only as the
		   compact-number formatter both surfaces share. */
		if (detail.bodyChars != null) rows += line("Skill body", JD.fmtTokens(detail.bodyChars) + " chars");
		if (detail.firstCallAtMs) rows += line("First used", shortDay(detail.firstCallAtMs, timeZone));
		if (detail.lastCallAtMs) rows += line("Last used", shortDay(detail.lastCallAtMs, timeZone));
		if ((detail.repos || []).length > 0) rows += line("Ran in", detail.repos.join(", "));
		if (!rows) return '<div class="sk-note">No per-entry record survives for this skill.</div>';
		return '<div class="sk-facts">' + rows + "</div>";
	}

	/**
	 * `the agent`, `you`, or both — the entry mechanisms in the reader's terms.
	 *
	 * `tool` is the agent deciding to invoke a skill, `command` is a person asking for
	 * it by name. Named after who reached for it rather than after the transcript
	 * mechanism, which would put the schema on screen.
	 */
	function enteredBy(paths) {
		var list = paths || [];
		var tool = list.indexOf("tool") !== -1;
		var command = list.indexOf("command") !== -1;
		if (tool && command) return "the agent and you";
		if (tool) return "the agent";
		return command ? "you" : null;
	}

	/** Per-agent runs, most first. The swatch is the agent's colour, page-wide. */
	function agentsHtml(detail) {
		var agents = (detail.agents || []).slice().sort((a, b) => b.calls - a.calls);
		if (agents.length === 0) return '<div class="sk-note">No agent recorded against this skill.</div>';
		return agents
			.map((agent) =>
				line(
					agent.source,
					agent.calls + (agent.calls === 1 ? " run" : " runs"),
					JD.seriesColor(JD.sourceIndex(agent.source)),
				),
			)
			.join("");
	}

	// ── Interaction ─────────────────────────────────────────────────────────────

	/**
	 * One binder for the list rows AND the band's key: both carry `data-skill`, and a
	 * click on either toggles, so the empty pane stays reachable once something has
	 * been opened.
	 */
	function bindSelection(app, model) {
		Array.prototype.forEach.call(app.querySelectorAll("[data-skill]"), (element) => {
			element.onclick = () => {
				var name = element.getAttribute("data-skill");
				var next = state.paneName === name ? null : name;
				/* The reader has now answered "which skill" themselves, so the default pick
				   must not run again — otherwise the click that closes the pane re-opens the
				   top row on the very next render. */
				defaultAnswered = true;
				setSelectedSkill(next);
				state.paneName = next;
				state.pane = null;
				state.paneError = null;
				renderSkills(model);
			};
		});
	}

	/** The paging button. Absent on a fully-loaded column, so this binds nothing. */
	function bindMore(app, model) {
		var button = app.querySelector("[data-skillmore]");
		if (button) button.onclick = () => loadMoreRows(app, model);
	}

	JD.renderSkills = renderSkills;
})(window.JD);
