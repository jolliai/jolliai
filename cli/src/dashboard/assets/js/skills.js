/* Skills page — a chart band, a chooser column, and a reading pane.
 *
 * THE SELECTION LIVES IN THE URL (`?skill=`), not in a module variable. It survives
 * an explicit model refresh for free, it can be shared and reloaded, and it is what the Stats
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
 * THE COLUMN HOLDS EVERY SKILL, and it gets there without being asked. The model
 * carries only the Stats card's first page, so anything past it is fetched as soon as
 * the page is drawn — there is no "Show more" here any more. The button was removed
 * because this view IS the skills view: a reader who opened it has already said which
 * list they want, and making them click through it a page at a time hid the tail of
 * their own corpus behind a control that answers a question they had already answered.
 * The Stats card keeps its button (`stats.js`), where the list is one of three sharing
 * a band and the reader came for something else.
 *
 * THE ROWS STILL LIVE IN A WINDOW, and it is now the page's ONLY one. The whole view is
 * a fixed frame — the page does not scroll, the two columns are the same height, and the
 * reading pane holds its whole skill without scrolling — so the rows are the one region
 * with a scrollbar. `main.css`'s `.browser-page` header owns that rule and the measurements
 * behind it; what matters here is that the height comes from a flex chain rather than from
 * anything this file computes. The MEASURED inline cap that used to create the window
 * (`listCapPx`, read off the first page) is gone with it.
 *
 * WHY THE ROWS AND NOT THE PANE: the corpus is unbounded while a skill's detail is not.
 * A machine can hold hundreds of skills, but the server caps the outcome strip at 50
 * entries, `agents` is an enum, and `The record` is five fixed fields — so the pane's
 * height has a ceiling that the frame can be sized against, and the column's does not.
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
 * (`buildDayPoints` walks the window, not the data) — and `windowDays` hands its day
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

	/* Series kept in the band before the rest rolls into "Other". FIVE is the whole
	   reason: the categorical ramp holds five CVD-validated colours, so four plus
	   Other is what can be told apart. */
	var BAND_SERIES = 4;
	/* A failed tail read retries without opting the whole Skills page into the global
	   model poll. That poll intentionally belongs to My Dashboard only; repainting this
	   page underneath a reader would also re-fetch the open detail pane. */
	var REST_RETRY_MS = 30000;
	/* An absolute backstop for a server whose total grows at least as fast as pages can
	   be consumed. Real reads stop on offset/total equality; this prevents a corrupt or
	   adversarial response stream from keeping the browser in an unbounded request loop. */
	var MAX_LIST_REQUESTS = 1000;

	/* The `†` a row takes when any entry behind it was inferred rather than observed,
	   and the sentence that spells it out.

	   ONE SENTENCE, THREE PLACES, and that is the point: it rides in the dagger's
	   `title` on every marked row, is printed once under the column, and is stated
	   again in the pane. `core/SkillsAggregateMarkdown.ts` makes the same split
	   between its `†` and its footnote, and `buildSkillsSummaryLabel` leaves the
	   marker to its caller for the same reason — a dagger where a footnote is in
	   reach, words where it is not. Here the footnote IS in reach: it sits at the end of
	   the rows, which on a corpus small enough to need no window is the page's own
	   scroll and on any larger one is the bottom of the rows' own window — either way,
	   the scroll that reaches the last row reaches it. So the column gets both. The
	   loading line is NOT in there — a reader waiting on the rest of the list may not
	   have to scroll the half that arrived to find out more is coming; see
	   `navPagingHtml`.

	   IT NAMES THE COUNT, not just the inference. A reader who learns only "this was
	   inferred" still reads `47 runs` as 47 runs; the count is the figure the
	   heuristic actually changes, since Codex CLI reports one entry per session however
	   many paged reads produced it. That is the half worth the characters. */
	var INFERRED_TITLE =
		"Inferred from a file read rather than an observed invocation: a person reading the skill file " +
		"looks the same, and the run count is per session rather than per call.";
	var INFERRED_MARK = ' <span class="sk-inferred" title="' + INFERRED_TITLE + '">†</span>';

	/* Everything an async answer can land in, so the two fetches below do not have to
	   re-render each other's half. Module-scoped because an explicit model refresh can
	   re-enter `renderSkills`, and a local would be re-seeded from the payload — dropping
	   a pane the reader is in the middle of. */
	var state = { rows: null, paneName: null, pane: null, paneError: null };

	/* Which render is current — the staleness guard for THE PANE'S detail fetch, and only
	   that one. An answer for a skill the reader has since navigated away from must not
	   paint over the one they are looking at.

	   The list read next door is staled by a new PAYLOAD instead (`collectRows` records
	   why): a render is not the same event as a refresh, and opening a skill is a render. */
	var seq = 0;

	/* The freshest total belongs to the latest page response. A newly refreshed model
	   resets it before that model's expanded list is verified. */
	var rowsTotal = null;
	var renderedModel = null;

	/* The model whose full list has already been asked for — the guard that keeps the
	   automatic read to ONE per payload.

	   It is the model OBJECT, not a row count, because two different things re-enter
	   `renderSkills` and only one of them wants a fresh read. An explicit refresh hands
	   over a new payload and must re-read the tail; a row click re-renders the SAME payload
	   to open a pane, and re-reading the whole list on every click would spend a request
	   per click for rows already in hand.
	   A count cannot tell those apart — both see the same short first page.

	   NOT RESET ON FAILURE, deliberately. The retry timer below owns another attempt;
	   clearing it here would instead make every click on a failed column fire the failing
	   request again. */
	var fetchedModel = null;
	/* The loading line's state. `restError` is what keeps a short column honest: while
	   it is set, the column is missing rows and says so rather than reading as the
	   whole list. */
	var restLoading = false;
	var restError = false;
	/* The one pending retry for the current payload. Cleared on success and whenever a
	   different payload takes ownership, so an old timer cannot wake a stale read. */
	var restRetryTimer = null;

	/* Whether each of the pane's two long fixed paragraphs is open.
	 *
	 * BOTH DEFAULT TO OPEN, matching the MCPs pane next door (`mcps.js`) and the mockup. A
	 * first-time reader needs to see what the page is claiming without a click, and the
	 * caveat is the stronger case of the two: it qualifies the four figures directly above
	 * it, so folded to a single line it is met only once the reader has already believed
	 * the number it limits — the very failure `inferredCaveatHtml` places it there to
	 * avoid. A click still collapses either back.
	 *
	 * MODULE STATE, not DOM state, because every path in this file repaints the WHOLE pane
	 * — a row click, that row's detail landing, the tail of the list arriving, a refresh —
	 * so an `aria-expanded` left on the node would be discarded moments after the click
	 * that set it. Keyed by the block's own class name, which is what `bindProse` below
	 * reads back off the event target.
	 *
	 * DELIBERATELY NOT PER SKILL. The two paragraphs are FIXED text (the inferred caveat
	 * and the basis line say the same thing on every skill), so a collapse is a fact about
	 * the reader, not about the row — resetting it per selection would make them re-close
	 * the same sentence on every skill they looked at. */
	var openProse = { "sk-caveat": true, "sk-basis": true };

	/* Whether "the address names no skill" has already been answered for this page
	   load — see the header. Nav is a full page reload, so this starts false on every
	   arrival; it is set by the default pick AND by any click, because a click is the
	   reader answering the same question themselves. */
	var defaultAnswered = false;

	/* The skill the column has already been scrolled to, so a selection is revealed ONCE
	   rather than on every repaint — see `revealSelectedRow`. */
	var scrolledToSkill = null;

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
	 * The rows the column is showing: the fetched list once it lands, else the first
	 * page the model already carries (`skills` view shares the Stats payload, so the
	 * first paint is never empty for a window that has data — and on a corpus that fits
	 * in one page it is also the last).
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
	 * Named rather than inlined because TWO callers ask different questions of it: the
	 * fallback above ("what do I draw before the fetch lands") and the fetch guard in
	 * `renderSkills` ("is there anything past this page to read"). The second is what keeps
	 * a corpus that fits in one page at zero requests.
	 *
	 * There was a third, `isExpanded`, asking "has the tail landed, so the rows region needs
	 * its measured cap". The fixed frame retired both it and the cap — see `listOpenTag`.
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

	/**
	 * Extracted from `renderSkills` so the row-click handler can trigger a new detail
	 * fetch without going through the full render (which would tear the whole frame
	 * down). `seq` is bumped here so a click that lands its detail late is invalidated
	 * by a newer click the same way — the staleness rule is identical whether the fetch
	 * was started by a render or by a selection change. */
	function fetchDetail(app, model) {
		var selected = state.paneName;
		if (!selected) return;
		var mine = ++seq;
		JD.getJson(
			JD.withParams("/api/skill-detail" + JD.query(model, {}), {
				name: selected,
				nowMs: model.generatedAtMs,
			}),
		)
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
				/* `drawPane`, NOT `draw`: the detail landing changes only the reading pane. */
				if (changed) drawPane(app, model);
			});
	}

	function renderSkills(model) {
		var app = document.getElementById("app");
		if (!app) return;
		if (renderedModel !== model) {
			cancelRowsRetry();
			renderedModel = model;
			var freshUsage = (model.stats && model.stats.toolUsage) || {};
			rowsTotal = freshUsage.skillsTotal || 0;
			restLoading = false;
			restError = false;
		}
		var selected = selectedSkill();
		if (!selected) selected = defaultSelection(model);
		/* A different skill invalidates the cached pane, so the reader never sees the
		   previous skill's figures under the new skill's name. */
		if (state.paneName !== selected) state = { rows: state.rows, paneName: selected, pane: null, paneError: null };

		/* THE REST OF THE LIST, on nobody's ask — this is what replaced the Show more
		   button. Skipped entirely when the model's first page already IS every skill,
		   which is the common small-corpus case and costs no request at all.
		 *
		 * The flags move BEFORE the draw below, so the loading line is on screen for the
		 * whole flight rather than appearing one repaint late. */
		var needsRest = skillTotal(model) > modelFirstPage(model).length && fetchedModel !== model;
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
	 * ALWAYS FROM ZERO AND ALWAYS TO THE END — there is no caller-supplied width any
	 * more, because every caller wants the same thing. Several requests are still the
	 * normal case: `/api/tool-usage` clamps a page at 200 rows, so a short response
	 * advances `offset` and the next request finishes the job.
	 *
	 * THE STOP IS THE SERVER'S POSITION, not a row count fixed when the read began. That
	 * is the difference the button's removal forced: a width decided up front silently
	 * lost whatever the window gained mid-read, which was invisible but harmless while a
	 * click had asked for exactly one page, and is a short list presented as the complete
	 * one now that nothing else will ask. `total` is therefore re-read from every
	 * response and the loop keeps going while `offset` trails it.
	 *
	 * Progress is measured in raw server rows while identity is measured by skill name.
	 * A row shifting across a page boundary can therefore make two offsets return the same
	 * skill and skip the row it displaced. Such a pass is discarded and restarted from
	 * zero; shrinking the total to the deduped count would present the skipped row as if it
	 * had never existed.
	 *
	 * WHAT MAKES THIS READ STALE IS A NEW PAYLOAD, never the render counter `seq`. Those
	 * are different questions and the distinction became load-bearing when the button
	 * went: opening a skill re-renders and bumps `seq`, so a `seq` test would void a read
	 * that is still perfectly current — and with nothing left to press, nothing would
	 * ever start it again. The column would sit at the model's first page, still saying
	 * "loading the rest…", for as long as the payload lived. `seq` stays where it belongs,
	 * guarding the pane's own detail fetch, whose answer really is per selection.
	 */
	function collectRows(model) {
		var rows = [];
		var names = Object.create(null);
		var offset = 0;
		var total = skillTotal(model);
		/* Two clean re-reads are enough to recover from a rank shift without turning an
		   actively changing database into a tight loop. Exhaustion is a failed/incomplete
		   read, never a smaller invented total; the retry timer starts a fresh attempt. */
		var restartsLeft = 2;
		/* Scales with the corpus the model announced, using its small first page as a
		   deliberately conservative width, so a legitimate list far beyond 5,000 rows is
		   not cut off by the old fixed 25-request ceiling. The absolute cap above only owns
		   the pathological case where the target runs away while it is being read. */
		var requestBudget = Math.min(
			MAX_LIST_REQUESTS,
			Math.max(25, Math.ceil(total / Math.max(1, modelFirstPage(model).length)) * (restartsLeft + 1)),
		);

		function restart() {
			if (restartsLeft <= 0) return Promise.reject(new Error("skill list changed while it was being read"));
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
			if (requestBudget <= 0) return Promise.reject(new Error("skill list kept growing while it was being read"));
			requestBudget--;
			return JD.getJson(
				JD.withParams("/api/tool-usage" + JD.query(model, {}), {
					list: "skill",
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
					if (!names[row.name]) {
						names[row.name] = true;
						rows.push(row);
					} else repeated = true;
				});
				offset += incoming.length;
				/* A repeated identity proves this offset partition moved. An empty page while
				   positions remain is the same inconsistency in another shape. Start from the
				   latest total rather than finalising a partial set. */
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
				/* Two callbacks, for the reason `renderSkills` states: under a trailing
				   `.catch` a throw from the repaint would land here and paint "could not
				   load the rest" over a list that had just arrived intact. */
				() => {
					if (renderedModel !== model) return false;
					/* THE ROWS ARE LEFT ALONE — a list that empties itself over one failed
					   fetch is worse than a short one. Only the loading line moves, and the
					   page-owned timer retries this same payload without re-fetching its pane. */
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

	function skillTotal(model) {
		if (rowsTotal !== null) return rowsTotal;
		var usage = (model.stats && model.stats.toolUsage) || {};
		return usage.skillsTotal || 0;
	}

	/**
	 * What to tell the reader when the detail could not be loaded.
	 *
	 * These failures need different advice, and they used to be reported as one:
	 *
	 *   - **No `status`** — `fetch` itself rejected, so nothing reached a server. Its
	 *     message is the browser's own "Failed to fetch", which said nothing about a
	 *     server having gone away and read as "HTTP Failed to fetch" once a caller
	 *     labelled it. The dashboard is not running any more; start it again.
	 *   - **404** — the dashboard answered that this skill has no calls in the window.
	 *     That is normal for a shared link opened under a different time range.
	 *   - **Another `status`** — a server answered and refused; bringing that server up
	 *     to date may help.
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
		if (err && err.status === 404) return "No captured calls for this skill in this window.";
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
	 * The rows region's opening tag.
	 *
	 * NOTHING TO DECIDE ANY MORE, and that is the point. This used to choose between an
	 * uncapped region and one carrying a MEASURED inline `max-height` (plus an `sk-scroll`
	 * marker class), because the page was what scrolled and the rows had to earn a window
	 * of their own by outgrowing the model's first page. The page is now a fixed frame and
	 * `.sk-list` takes its height from the flex chain, so the region is always the same
	 * shape and there is no pixel value for JS to measure. `isExpanded` went with it — its
	 * only reader was the branch here.
	 *
	 * Kept as a function rather than inlined into `draw`'s template so the region stays one
	 * named thing that `main.css` and this file can be read against together.
	 */
	function listOpenTag() {
		return '<div class="sk-list">';
	}

	/**
	 * Whether the current row is already somewhere the reader can see it.
	 *
	 * TWO BOXES, and each answers for a different layout. The rows live in a scroll region,
	 * so a row can be far outside it while the page looks fine — that is the common case,
	 * since the column holds every skill. The viewport check then covers the case where the
	 * region ITSELF is off screen, which is what the ≤899px breakpoint produces: there the
	 * fixed frame comes off, the columns stack and the page scrolls again, so the list can
	 * sit an arbitrary distance below the fold. Inside the desktop frame the second check is
	 * always satisfied — the region cannot leave a viewport the frame is pinned to — and it
	 * is kept rather than dropped because that is true of the frame, not of the page.
	 * It also used to be load-bearing on the desktop, when the band was ~450px tall and a
	 * row "visible" in the panel could still be under the fold.
	 *
	 * A HOST THAT CANNOT MEASURE gets `true` — do not scroll. Every branch here degrades
	 * that way on purpose: without layout there is nothing to be outside of, and a
	 * scroll computed from zeroes is a jump to an arbitrary place rather than a fix.
	 */
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
	 * Brings the selected row into view, ONCE per selection.
	 *
	 * WHY AT ALL: the Stats card's rows link in here with `?skill=`, so a reader can
	 * arrive with the 25th skill selected — the pane opens on it correctly while the
	 * column sits at row 1, with the highlighted row 1,222px down a 504px window
	 * (measured). Nothing on screen connects the two, and the reader has no reason to
	 * think the list is scrollable at all. The band's key does the same thing to any
	 * skill outside its top four.
	 *
	 * ONCE PER SELECTION, which is what `scrolledToSkill` buys and what makes this safe
	 * to run from `draw`. Every path here repaints the whole page — an explicit refresh among
	 * them — so scrolling on each repaint would drag a reader browsing the list back to
	 * the selected row twice a minute. The one thing that MAY move the column is the
	 * reader changing what is selected.
	 *
	 * NOT RECORDED WHEN THE ROW IS ABSENT, for the reason `memories.js` states about its
	 * anchor: the selection can name a skill sitting in the tail of the list, which is
	 * fetched a moment after the first paint, and recording here would spend the single
	 * chance to reveal it on a paint where it did not exist. The arriving tail repaints,
	 * and that is the paint that scrolls.
	 *
	 * ALREADY-VISIBLE ROWS ARE LEFT ALONE, unlike `memories.js`'s unconditional centring.
	 * The high-frequency action on this page is clicking a row in the list — a row that
	 * is on screen by definition, since the reader just clicked it — and centring it
	 * would slide the column under the pointer for no reason. The selection is still
	 * recorded, so this stays once-per-selection either way.
	 *
	 * CENTRED when it does move: the neighbours above and below say where in the ranking
	 * the skill sits, which top-alignment throws away. `scrollIntoView` also walks every
	 * scrollable ancestor, so it fixes the viewport half of `isRowRevealed` in the same
	 * call — on a window tall enough for the panel, the page does not move at all.
	 */
	function revealSelectedRow(app, list) {
		var name = state.paneName;
		/* Closing the pane forgets the scroll, so re-opening the same skill later — from
		   the band's key, after the reader has scrolled elsewhere — reveals it again. */
		if (!name) {
			scrolledToSkill = null;
			return;
		}
		if (scrolledToSkill === name) return;
		var row = app.querySelector('.sk-row[aria-current="true"]');
		if (!row) return;
		scrolledToSkill = name;
		if (isRowRevealed(list, row)) return;
		if (row.scrollIntoView) row.scrollIntoView({ block: "center" });
	}

	/**
	 * Rewrites ONLY the reading pane, leaving the band chart's SVG, the row column and its
	 * scroll offset untouched. Used when the detail fetch lands for the currently selected
	 * skill — at that point nothing above the pane has changed, and rebuilding the band and
	 * the list was where the visible flicker came from on every row click (the SVG was torn
	 * down and re-rasterised for a state it never left). Falls back to the full `draw` when
	 * the pane node is missing (a shape only reachable if the frame was never rendered on
	 * this page — nothing does that today, but the fallback is what keeps this helper safe
	 * to add without auditing every future caller). Prose handlers are re-bound because the
	 * clamped paragraphs live inside the pane and their listeners rode the old nodes down. */
	function drawPane(app, model) {
		var pane = app.querySelector(".sk-pane");
		if (!pane) {
			draw(app, model);
			return;
		}
		var usage = (model.stats && model.stats.toolUsage) || {};
		pane.innerHTML = paneHtml(usage, model.timeZone);
		bindProse(app);
	}

	/**
	 * Marks the bar rects that match the current selection with `data-active` so the CSS
	 * rule in `main.css` keeps them at full opacity while the others fade — the visual half
	 * of the chart/list linking. Rewritten on every band render and on every selection
	 * change, so the invariant "at most one series has `data-active` at a time" is enforced
	 * by iteration rather than by tracking which rect had it before. Cheap: a 30-day band
	 * with five series holds ~150 rects. */
	function applyBandActive(app) {
		var name = state.paneName || "";
		var rects = app.querySelectorAll(".sk-band .sk-bandbars rect[data-series]");
		Array.prototype.forEach.call(rects, (rect) => {
			if (name && rect.getAttribute("data-series") === name) rect.setAttribute("data-active", "");
			else rect.removeAttribute("data-active");
		});
	}

	/**
	 * Redraws ONLY the `.sk-band` element (chart + legend), leaving the nav column and the
	 * pane in place. Used from the selection click handler because the band's kept-set can
	 * shift with the selection (a skill outside the top four swaps into the fourth slot),
	 * so the SVG itself has to be regenerated — a pure attribute toggle would leave that
	 * case wrong. Re-binds selection because the legend buttons ride the new band, and
	 * calls `applyBandActive` so the freshly-rendered rects come up with the highlight
	 * already applied. `<template>` unwrap because `outerHTML` on the target node would
	 * lose the reference to the newly-inserted `.sk-band`. */
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

	/** Restores keyboard focus after `drawBand` replaces the legend buttons. Names are
	 *  compared as attributes instead of interpolated into selectors because skill names
	 *  are user-authored. If deselection drops an out-of-band legend, its list row is the
	 *  stable fallback. */
	function restoreSelectionFocus(app, name) {
		var legend = null;
		var row = null;
		Array.prototype.forEach.call(app.querySelectorAll("[data-skill]"), (element) => {
			if (element.getAttribute("data-skill") !== name) return;
			if (element.classList && element.classList.contains("sk-legend")) legend = element;
			else if (element.classList && element.classList.contains("sk-row")) row = element;
		});
		var target = legend || row;
		if (target && target.focus) target.focus();
	}

	/**
	 * The selection-only repaint. Called from the row-click handler in place of the old
	 * full `renderSkills(model)` — same visible outcome without tearing down the whole
	 * `.browser-page` section, which is what made the row click flash every SVG in the
	 * frame. Three targeted updates: `aria-current` on the list rows (a plain attribute
	 * toggle, no DOM churn), `drawBand` for the chart and its legend (their kept-set can
	 * shift with the selection), and `drawPane` for the reading pane. The detail fetch is
	 * started separately by the click handler through `fetchDetail`. */
	function updateSelection(app, model, focusedLegendName) {
		var name = state.paneName;
		Array.prototype.forEach.call(app.querySelectorAll(".sk-row"), (row) => {
			if (row.getAttribute("data-skill") === name) row.setAttribute("aria-current", "true");
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
		/* THE ROWS' OFFSET IS CARRIED ACROSS BY HAND, because the write below replaces the
		   node that holds it — and only that node scrolls, so this is the whole of it.
		 *
		 * Every path here that reaches THIS function repaints the WHOLE page — a row click,
		 * the tail of the list arriving, an explicit refresh — so without this the column
		 * snapped back to its first row on each of them. Clicking the 18th skill scrolled the
		 * list away from the row that was just clicked, which also takes the `aria-current`
		 * row off screen; and a refresh did it unprompted, mid-read. The FOURTH path that used
		 * to reach here — the detail fetch landing — now goes through `drawPane` above, which
		 * leaves the list node in place and so needs no carry-across at all.
		 *
		 * A whole-page repaint is what this view is built on (`renderSkills` re-reads the
		 * address on every render), so restoring the offset is the fix that fits it —
		 * repainting only the changed region, as `memories.js` does, is a bigger change
		 * for the same outcome here. */
		var previous = app.querySelector(".sk-list");
		var offset = previous ? previous.scrollTop : 0;
		app.innerHTML =
			/* `browser-page` is the FRAME, shared with the MCPs page — `main.css`'s
			   "Skills and MCPs pages" block owns it and explains why it is named after
			   the shape rather than after either page. No `skills-page` beside it: this
			   page has no rule of its own, and a class no stylesheet matches is a hook
			   the next reader has to prove is dead. */
			'<section class="browser-page">' +
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
		/* Addresses the NEW node. The restore is conditional because assigning 0 to a fresh
		   render is a no-op that would still cost a layout write. A shrunk list (a refresh
		   returning fewer rows) is clamped by the browser, so this cannot leave the column
		   past its own content.
		 *
		 * There used to be a MEASUREMENT here too, reading the uncapped region's height back
		 * to use as its own cap. The flex chain supplies that height now — see `listOpenTag`. */
		var list = app.querySelector(".sk-list");
		if (list) {
			if (offset > 0) list.scrollTop = offset;
			/* AFTER the restore, never before: this measures where the row actually sits,
			   and it is the one thing allowed to overrule the carried-across offset — a
			   new selection is the reader asking to look somewhere else. */
			revealSelectedRow(app, list);
		}
		bindSelection(app, model);
		bindProse(app);
		applyBandActive(app);
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

		var totals = Object.create(null);
		series.forEach((point) => {
			Object.keys(point.bySeries || {}).forEach((name) => {
				totals[name] = (totals[name] || 0) + point.bySeries[name];
			});
		});
		var names = Object.keys(totals);
		var selected = state.paneName && totals[state.paneName] !== undefined ? state.paneName : null;
		/* `data-selected` on the band is what the CSS keys off to dim non-active rects in
		   the SVG — the highlight that links the chart to the chooser row so a click reads
		   at both ends. Empty when nothing is selected, so the `:not([data-selected=""])`
		   guard in `main.css` keeps every rect at full opacity for the default view.
		   Computed BEFORE the head is written because the attribute has to sit on the
		   `.sk-band` open tag, not on a nested element. */
		var head =
			'<div class="sk-band" data-selected="' +
			(selected ? JD.esc(selected) : "") +
			'"><div class="sk-nav-head" style="padding:0 0 10px;border-bottom:0">' +
			"<b>All skills, day by day</b> · sessions that reached for each skill · " +
			"a session using several skills counts once per skill</div>";

		/* THE EMPTY TEST IS "no series", NOT "no points". `skillDays` carries one point
		   per day of the window whether or not anything ran, so it is never empty once
		   a window exists — a `series.length` test (what the week buckets needed, since
		   they were derived from the data's own range) would draw an axis, four
		   gridlines and an empty legend for a window with no skill use at all. */
		if (names.length === 0) {
			return head + '<div class="empty-note">No skill invocations recorded in this window.</div></div>';
		}
		var ranked = names.slice().sort((a, b) => totals[b] - totals[a] || (a < b ? -1 : a > b ? 1 : 0));
		var kept = ranked.slice(0, BAND_SERIES);
		if (selected && kept.indexOf(selected) === -1) kept = kept.slice(0, BAND_SERIES - 1).concat([selected]);
		var keptSet = Object.create(null);
		kept.forEach((name) => {
			keptSet[name] = true;
		});

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
		var otherLabel = "Other (" + otherNames.length + (otherNames.length === 1 ? " skill)" : " skills)");

		var legend = keys
			.map((key, index) => {
				var value = key === otherKey ? otherTotal : totals[key];
				var label = key === otherKey ? otherLabel : key;
				var body =
					'<i style="background:' + JD.seriesColor(index) + '"></i><b>' + JD.esc(label) + "</b> " + value;
				/* Other is a span, not a button: an aggregate of several skills is not a
				   subject a reader can open. */
				if (key === otherKey)
					return '<span class="sk-legend' + (selected ? " sk-dim" : "") + '">' + body + "</span>";
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

		/* `stackedBarsFrame`, NOT `stackedBars`: this chart's height is a budget (the pane
		   below it needs the rest of the window), and the plain entry point can only be
		   bounded through its WIDTH — its axis text lives in the viewBox, so the whole box
		   scales uniformly. That coupling is what used to pin this chart to a width derived
		   from the window's height, leaving a wide browser with a 477px chart and a
		   1280x800 one with 240px of chart and 5px axis labels. The frame hands back a
		   text-free plot that CSS pins by height, so the width is free to follow the page.
		   `charts.js` carries the full reasoning.
		 *
		   An integer formatter, not the default `fmtTokens`: "0.5" on an axis counting
		   sessions is a claim the unit cannot make. */
		var frame = JD.stackedBarsFrame(rolled, keys, "skill sessions", (n) => String(Math.round(n)));
		/* The ticks come from the frame rather than being derived here, so the labels and
		   the bars cannot be scaled by two different bounds. */
		var ticks = frame.ticks.map((tick) => "<span>" + JD.esc(tick) + "</span>").join("");
		/* The endpoint labels sit INSIDE `.sk-bandmain`, beside the plot and not beside the
		   tick column, so `space-between` lines them up with the plot's own edges — the
		   same thing `stackedBars` achieved by anchoring them to its plot bounds. A
		   single-day window prints one, matching the pane's small charts. */
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
	 * control. That rule survived the loss of its first reason: while these rows were one
	 * page of a ranked list, a client-side re-sort by tokens would name a "heaviest" that
	 * might sit unloaded on the next page. The column now holds every skill, so the same
	 * re-sort would usually be right — but only usually, since the tail is still absent
	 * while it is in flight and after a failed read, and a header that silently sorts a
	 * partial list is the same lie arriving less often.
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
	 * The loading line's band, PINNED BELOW THE ROWS rather than inside them.
	 *
	 * IT SAYS THE COLUMN IS INCOMPLETE, so it may not be reachable only by scrolling the
	 * very rows that are missing their tail — and on any corpus that can show this line
	 * those rows ARE a capped region, so inside it that is exactly what it would be.
	 * Measured back when the region was capped from the first paint: at a 1440x900
	 * viewport the list showed 7 of 23 rows and the row sat 882px past its fold, while
	 * the window itself scrolled 3px, so a reader spinning the wheel over the page never
	 * moved the list at all. The head and the coverage foot are pinned for this same
	 * reason; this belongs with them, and the region keeps only the rows and their
	 * footnote.
	 *
	 * NOTHING AT ALL on a complete column — which is the steady state, so the band is
	 * normally absent. It used to be permanent, carrying `Showing 12 of 40 skills`
	 * because that was the only place the reader learnt the column was NOT the whole
	 * list. Now it always is, `navHeadHtml` already prints the skill count, and a
	 * permanent `Showing 25 of 25 skills` under a header reading `25 skills` is the same
	 * sentence twice. Nothing on an empty column either, for the same reason its
	 * predecessor said nothing there.
	 */
	function navPagingHtml(rows, usage) {
		if (rows.length === 0) return "";
		var body = restStatusHtml(rows, usage);
		return body ? '<div class="sk-paging">' + body + "</div>" : "";
	}

	/**
	 * `Showing 8 of 25 skills — loading the rest…`, and only while that is true.
	 *
	 * TWO STATES, NO BUTTON. The reader is not being asked for anything: the rest of the
	 * list is already on its way, and on a failure this page's 30 s timer asks again — so
	 * a `Try again` control here would duplicate a retry that happens automatically, on the one
	 * page whose entire point is that the reader does not click to see their own skills.
	 * The failure still has to be SAID, because a column short of its total is otherwise
	 * indistinguishable from a reader who owns eight skills.
	 *
	 * The count and its classes are `stats.js`'s `toolMoreRow`'s, so the two lines read
	 * as one convention at two zooms even though only one of them still has a button.
	 */
	function restStatusHtml(rows, usage) {
		if (!restLoading && !restError) return "";
		var shown = rows.length;
		var total = rowsTotal === null ? (usage && usage.skillsTotal) || shown : rowsTotal;
		/* A total the column already meets has nothing left to report, whichever flag is
		   still up — a stale `restError` beside a full list would call it short. */
		if (shown >= total) return "";
		return (
			'<div class="more-row"><span class="more-count">Showing ' +
			shown +
			" of " +
			total +
			(total === 1 ? " skill" : " skills") +
			(restLoading ? " — loading the rest…" : " — could not load the rest; retrying shortly") +
			"</span></div>"
		);
	}

	/**
	 * The `†` spelled out under the column, and only when a loaded row wears one.
	 *
	 * ON THE ROWS IN HAND, not on a window-wide flag: a footnote explaining a mark that
	 * is nowhere on screen is a reader hunting for something that is not there. So the
	 * tail of the list landing can bring the footnote in, which is correct — the mark
	 * arrived with it.
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

		html += proseBlock(
			"sk-basis",
			"Runs, sessions and the agent split are counted over this window. The two " +
				"charts above share the day axis the chart at the top of the page uses, so a column is the same day " +
				"in all three; spend is attributed per session and summed per day, never per run. Outcomes are per " +
				"recorded run and carry no date axis.",
		);
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
		return proseBlock(
			"sk-caveat",
			"† At least one entry here was inferred from a command that read the skill " +
				"file, not from an observed invocation — a person reading that file leaves the same trace, and " +
				"reading it is not the same as using it. Inferred entries are counted once per session however " +
				"many reads produced them, so the run figures above are a floor rather than a count.",
		);
	}

	/**
	 * One of the pane's two long fixed paragraphs, shown in full and collapsible to a single
	 * line with a click.
	 *
	 * WHY ONLY THESE TWO MAY BE COLLAPSED AT ALL: they are ~4 lines each and 82px of the
	 * pane's height budget between them (measured), and they are the only blocks here whose
	 * text is FIXED rather than a measurement. Clamping a data row would destroy a count;
	 * clamping these hides a qualifier one click brings back. They still START open (see
	 * `openProse`) — the height is the reader's to reclaim, not this pane's to take on their
	 * behalf. `main.css`'s `.sk-clamp` owns the visual side.
	 *
	 * TEXT ONLY, NEVER MARKUP. The whole string is repeated into `title` (so a pointer user
	 * gets it without clicking) and `JD.esc` there would mangle any tags — so callers pass
	 * prose, and the one non-ASCII character in it, the inferred dagger, is a literal.
	 *
	 * `role="button"` + `tabindex="0"` rather than a real `<button>`: the clickable thing IS
	 * the paragraph, and a button element would inherit type/appearance resets and take the
	 * text out of the reading flow for a screen reader. `aria-expanded` is what makes the
	 * collapsed state audible rather than merely visual, and `main.css` keys the open state
	 * off that same attribute so there is ONE source of truth on the node.
	 */
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

	function line(label, value, swatch) {
		/* `title="value"` on the span: the value cell is `white-space: nowrap` + `overflow:
		   hidden` in `.sk-facts` (see `main.css`), so a long value ("the agent and you" at
		   100px in a 100px column) truncates without any way to read the full string —
		   hover was the missing recovery. Title is the same string the cell shows, so
		   short values that fit still show their tooltip, matching every other truncatable
		   row on this page. */
		return (
			'<div class="sk-line">' +
			(swatch ? '<i style="background:' + swatch + '"></i>' : "") +
			"<b>" +
			JD.esc(label) +
			'</b><span title="' +
			JD.esc(value) +
			'">' +
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
	 * Not recomputed from the range: `buildDayPoints` walks the window with
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
			   `buildDayPoints` states the same rule for the same reason: the SQL filters on
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

	/**
	 * Rows of the agent split shown in full before the rest are rolled into one line.
	 *
	 * THE ONLY UNBOUNDED-ENOUGH LIST IN THE PANE. Every other section has a ceiling the
	 * fixed frame can be sized against — the outcome strip is capped at 50 ticks by the
	 * server, `The record` is five fixed fields — but this one is one row per agent that
	 * ran the skill, and the product recognises a dozen-odd of them. Measured with 12 rows
	 * at 1440x900 the pane overflowed its frame by 54px; capped at 5 it fits with room.
	 *
	 * FIVE, not three: a skill genuinely shared between the agents on a machine is the
	 * interesting case, and a cap that rolls up the third one stops answering the question
	 * the section exists for. Five covers every real row measured on this machine, so the
	 * roll-up is a guard rather than something a reader meets day to day.
	 */
	var AGENT_ROWS_SHOWN = 5;

	/** Per-agent runs, most first. The swatch is the agent's colour, page-wide. */
	function agentsHtml(detail) {
		var agents = (detail.agents || []).slice().sort((a, b) => b.calls - a.calls);
		if (agents.length === 0) return '<div class="sk-note">No agent recorded against this skill.</div>';
		var html = agents
			.slice(0, AGENT_ROWS_SHOWN)
			.map((agent) =>
				line(
					agent.source,
					agent.calls + (agent.calls === 1 ? " run" : " runs"),
					JD.seriesColor(JD.sourceIndex(agent.source)),
				),
			)
			.join("");
		var rest = agents.slice(AGENT_ROWS_SHOWN);
		if (rest.length === 0) return html;
		/* The rolled-up line carries its own RUN TOTAL, not just a count of agents — the
		   section is a split of the runs, so "3 further agents" alone would drop runs out of
		   a total the four figures above still count in full. Same rule the outcome strip's
		   own capped note follows: the cap changes what is drawn, never what is claimed. */
		var restCalls = rest.reduce((sum, agent) => sum + agent.calls, 0);
		return (
			html +
			'<div class="sk-note">' +
			rest.length +
			(rest.length === 1 ? " further agent ran it, " : " further agents ran it, ") +
			restCalls +
			(restCalls === 1 ? " run" : " runs") +
			" between them.</div>"
		);
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
				var focusedLegendName =
					document.activeElement === element &&
					element.classList &&
					element.classList.contains("sk-legend")
						? name
						: null;
				var next = state.paneName === name ? null : name;
				/* The reader has now answered "which skill" themselves, so the default pick
				   must not run again — otherwise the click that closes the pane re-opens the
				   top row on the very next render. */
				defaultAnswered = true;
				setSelectedSkill(next);
				state.paneName = next;
				state.pane = null;
				state.paneError = null;
				/* Targeted repaint plus the detail refetch — NOT `renderSkills(model)`,
				   which would tear down the whole `.browser-page` section on every click
				   (the visible flicker readers reported, plus the loss of the nav column's
				   scroll position). `updateSelection` walks the band, list highlights and
				   pane; `fetchDetail` starts the new detail request whose `.then` calls
				   `drawPane` a second time when it lands. */
				updateSelection(app, model, focusedLegendName);
				fetchDetail(app, model);
			};
		});
	}

	/**
	 * Wires the two clamped paragraphs (see `proseBlock`).
	 *
	 * IT TOGGLES THE ATTRIBUTE AND DOES NOT RE-RENDER, which is the opposite of every other
	 * interaction on this page. Opening a sentence is not a change of what the page is
	 * about: a repaint would cost the rows their scroll offset and the pane its own, for a
	 * result CSS reaches from `aria-expanded` alone. `openProse` is updated in step so the
	 * next repaint — driven by something else — still renders it open.
	 *
	 * SPACE IS PREVENTED, Enter is not. On a `role="button"` element the browser supplies
	 * neither activation, so both are handled here; Space would otherwise also scroll the
	 * nearest scrollable ancestor, which on this page is a column the reader is reading.
	 */
	function bindProse(app) {
		Array.prototype.forEach.call(app.querySelectorAll(".sk-clamp"), (element) => {
			/* Read back off the node rather than closed over, so one binder serves both
			   blocks and the key cannot drift from the class the stylesheet matches. */
			var key = element.classList.contains("sk-caveat") ? "sk-caveat" : "sk-basis";
			var toggle = () => {
				openProse[key] = openProse[key] !== true;
				element.setAttribute("aria-expanded", openProse[key] ? "true" : "false");
			};
			element.onclick = toggle;
			element.onkeydown = (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				toggle();
			};
		});
	}

	JD.renderSkills = renderSkills;
})(window.JD);
