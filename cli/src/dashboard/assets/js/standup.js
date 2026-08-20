window.JD = window.JD || {};

((JD) => {
	/* Glyph per row kind — the mockup's leading column. Shared with the decisions
	   corpus; see JD.glyph in shell.js. */
	var GLYPH = JD.glyph;

	/* No insight kind is routed into this page any more, for two independent
	   reasons that landed together.

	   `todo` is unrouted because Today states what LANDED today, and a TODO is by
	   definition work that has not happened — putting one there made the column
	   assert something the board cannot know (JOLLI-2201). `decision` is unrouted
	   because the Decisions card owns it.

	   The third column — Risks · Blockers · Questions — is gone because its kinds
	   can never exist: `TOPIC_INSIGHTS_CTE` in DashboardQuery.ts derives insights
	   from each memory topic's own `decisions`/`todo` text, so `decision` and
	   `todo` are the only kinds the payload can ever hold (DashboardCollector.ts
	   says so outright, and calls it deliberate — a blocker is not guessed from
	   prose). The column therefore always rendered "Nothing flagged in this
	   window." at the memory tier and an upsell for a feature that would not fill
	   it below. Reinstating it means teaching the SUMMARIZER to record those kinds
	   first; a filter on its own has nothing to select.

	   `standup.insights` survives only as the memory-tier flag — see `memory` in
	   renderStandup. */

	/* ---- rows ---------------------------------------------------------------

	   ONE row shape for both day columns, and it is the stats page's Memory Activity
	   row restated in this page's markup. The two surfaces answer the same question
	   for the same day out of the same commits, so a reader comparing them must not
	   have to work out whether a difference in wording is a difference in data.

	   They are NOT the same query, and the gap is worth knowing: Memory Activity
	   lists `memories` rows for the window with no author filter, while these
	   columns list author-filtered `commits`. On a normal machine the two coincide,
	   because a memory only exists for a commit this machine summarized — measured
	   18 = 18, fully overlapping, over a two-day window with seven distinct commit
	   authors in the table. They come apart in two directions: a commit of yours
	   that never got a memory shows HERE only, and a teammate's commit that somehow
	   did shows THERE only. Keeping the author filter is deliberate — the board is
	   read out as your own work — so treat the alignment as "same fields, same
	   labels", not as an invariant that the two lists are equal. */

	function commitRow(commit, model, memory) {
		var esc = JD.esc;
		var metas = "";
		/* Same four fields Memory Activity's row carries, in its order: category,
		   turns, branch, repo. The category chip takes its colour from the shared
		   JD.categoryColor, so `bugfix` cannot be one colour here and another there. */
		if (commit.workCategory) {
			metas +=
				'<span class="mem-activity-category" style="color:' +
				JD.categoryColor(commit.workCategory) +
				'">' +
				esc(commit.workCategory) +
				"</span>";
		}
		if (commit.turns != null) {
			metas += '<span class="tag metric num">' + esc(commit.turns) + " turns</span>";
		}
		/* Below the memory tier neither category nor turns exists, so an aligned row
		   would be a bare title. The hash and the diff size are what git alone can
		   say, and they keep the raw column readable without claiming enrichment it
		   does not have. */
		if (!memory) {
			metas += '<span class="tag mono">' + esc(commit.hash.slice(0, 7)) + "</span>";
			if (commit.insertions != null || commit.deletions != null) {
				metas +=
					'<span class="tag">+' + (commit.insertions || 0) + " −" + (commit.deletions || 0) + "</span>";
			}
		}
		if (commit.branch) metas += '<span class="tag mono">' + esc(commit.branch) + "</span>";
		/* Suppressed on a single-repo page for the same reason Memory Activity
		   suppresses it: every row would carry the identical chip, and the topbar
		   picker already states it. `!== 1` and not `scope.kind !== "repo"` — the
		   scope now holds an ARRAY of identities, so a two-repo selection is still
		   `kind === "repo"` while its rows do need telling apart. */
		if (JD.scopeIdentities(model).length !== 1) metas += '<span class="tag">' + esc(commit.repoName) + "</span>";
		return (
			'<div class="item"><div class="r1">' +
			GLYPH.commit +
			'<span class="t">' +
			esc(commit.message) +
			'</span><span class="when">' +
			esc(JD.timeOfDay(commit.committedAtMs, model.timeZone)) +
			"</span></div>" +
			(metas ? '<div class="meta">' + metas + "</div>" : "") +
			"</div>"
		);
	}

	function dayColumn(commits, model, memory) {
		return commits.map((commit) => commitRow(commit, model, memory)).join("");
	}

	/* ---- sprint context ---------------------------------------------------- */

	/* The mockup's ctx-strip chips. Its own version reads `Sprint 14 · day 7 of 10`
	   and `JOL-142 · 4/7 steps · ● on track`; sprint numbering and plan-step
	   progress do not exist locally (plan enumeration is a known gap), so the chips
	   carry only the part that does — the tickets the window's commits actually
	   name — rather than inventing a status. */
	function sprintChips(standup, model) {
		if (!standup.insights) {
			return (
				'<span class="schip" style="border-style:dashed">sprint context appears with memory — tickets are ' +
				"read from your commits</span>"
			);
		}
		/* Prototype-less: ticket ids come from commit messages, across the whole window. */
		var counts = Object.create(null);
		(standup.days || []).forEach((entry) => {
			(entry.commits || []).forEach((commit) => {
				if (commit.ticketId) counts[commit.ticketId] = (counts[commit.ticketId] || 0) + 1;
			});
		});
		var tickets = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
		if (tickets.length === 0) {
			return (
				'<span class="schip" style="border-style:dashed">no ticket in this window — ' +
				"chips appear when a commit names one</span>"
			);
		}
		return tickets
			.slice(0, 3)
			.map(
				(ticket) =>
					'<span class="schip"><span class="mono">' +
					JD.esc(ticket) +
					"</span> " +
					counts[ticket] +
					(counts[ticket] === 1 ? " commit" : " commits") +
					"</span>",
			)
			.join("");
	}

	/* Whose commits the board is showing. Stated either way, and never silently:
	   the columns feed a draft the user posts as their own work, so "filtered to
	   you" and "could not tell who you are, showing everyone" have to be
	   distinguishable before the paste, not after. */
	function authorChip(standup) {
		if (standup.authoredBy) {
			return '<span class="schip">yours only · <span class="mono">' + JD.esc(standup.authoredBy) + "</span></span>";
		}
		return (
			'<span class="schip" style="border-style:dashed">every author — no git identity configured, ' +
			"so this is not filtered to you</span>"
		);
	}

	/* ---- columns ----------------------------------------------------------- */

	var plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

	/* Column title. Today and Yesterday keep their named titles; every other day is
	   its own short weekday date. The key is a bare local `YYYY-MM-DD` the server
	   already computed in the model's zone, so it is formatted in UTC — reading it
	   back through the local zone could shift the calendar day. Locale is pinned to
	   en-US so the whole board reads in one language (the Today/Yesterday titles are
	   English), rather than mixing them with a viewer's localized month names. */
	var dayTitleFormat = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
	function dayTitle(dayKey, standup) {
		if (dayKey === standup.today) return "Today";
		if (dayKey === standup.yesterday) return "Yesterday";
		return dayTitleFormat.format(new Date(dayKey + "T00:00:00Z"));
	}

	/* One day's column. COMMITS ONLY, flat, and identical in shape to the stats
	   page's Memory Activity rows for the same day — only how many FIELDS a row can
	   show varies with tier, which is the row's own business (see commitRow). No
	   `.sub` caption: the heading and count already say what the column holds, and
	   an empty one would hold its bottom margin open. A quiet day is still a column,
	   so the grid stays a stable seven wide.

	   A named `<section>` is a region landmark, so its aria-label is what a screen
	   reader announces and lists this column by — it must be the human-readable
	   title ("Today", "Yesterday", "Wed, Jul 30"), not a bare ISO date. The ISO day
	   rides on `data-day` instead: a stable, locale-independent handle for the asset
	   test that never reaches the accessibility tree. The title format is en-US
	   pinned (see dayTitle), so the aria-label stays locale-independent too. */
	function dayCard(entry, standup, model, memory) {
		var commits = entry.commits || [];
		var body = commits.length ? dayColumn(commits, model, memory) : '<div class="empty-note">No commits.</div>';
		return (
			'<section class="card col" data-day="' +
			JD.esc(entry.day) +
			'" aria-label="' +
			JD.esc(dayTitle(entry.day, standup)) +
			'"><h2><span class="day-title">' +
			JD.esc(dayTitle(entry.day, standup)) +
			'</span><span class="cnt">· ' +
			JD.esc(plural(commits.length, "commit")) +
			"</span></h2>" +
			'<div class="col-list">' +
			body +
			"</div></section>"
		);
	}

	JD.renderStandup = (model) => {
		var standup = model.standup;
		var memory = !!standup.insights;

		/* Context strip: the author disclosure and sprint chips. The window's date
		   range is stated by the pager in the topbar (see shell.js), not here. */
		var html =
			'<div class="ctx"><span class="sprint-chips">' + authorChip(standup) + sprintChips(standup, model) + "</span></div>";

		/* One column per day, in the server's newest-first order — Today leftmost,
		   the week trailing off to the right, horizontally scrollable. The third
		   Risks · Blockers · Questions column is gone; see the note at the top of
		   this file for why it could never fill. */
		html += '<div class="cols standup-days">';
		(standup.days || []).forEach((entry) => {
			html += dayCard(entry, standup, model, memory);
		});
		html += "</div>";

		document.getElementById("app").innerHTML = html;
	};
})(window.JD);
