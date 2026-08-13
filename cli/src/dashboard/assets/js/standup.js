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
		/* Prototype-less: ticket ids come from commit messages. */
		var counts = Object.create(null);
		standup.yesterdayCommits.concat(standup.todayCommits).forEach((commit) => {
			if (commit.ticketId) counts[commit.ticketId] = (counts[commit.ticketId] || 0) + 1;
		});
		var tickets = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
		if (tickets.length === 0) {
			return (
				'<span class="schip" style="border-style:dashed">no ticket on the last two days of commits — ' +
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

	/* `sub` is optional. The two day columns pass none — their heading and count
	   already say what they hold, and the sentence under them was restating it. An
	   empty string must not render an empty `.sub`: it carries a bottom margin, so
	   the blank div would leave the gap the caption used to occupy. */
	function column(title, count, sub, bodyHtml) {
		return (
			'<section class="card col" aria-label="' +
			JD.esc(title) +
			'"><h2>' +
			JD.esc(title) +
			'<span class="cnt">' +
			JD.esc(count) +
			"</span></h2>" +
			(sub ? '<div class="sub">' + JD.esc(sub) + "</div>" : "") +
			'<div class="col-list">' +
			bodyHtml +
			"</div></section>"
		);
	}

	var plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

	JD.renderStandup = (model) => {
		var esc = JD.esc;
		var standup = model.standup;
		var memory = !!standup.insights;

		/* Context strip: date and sprint chips. The Copy-as-standup button and its
		   "posts nowhere" caption used to close this row (JOLLI-2198); the board is
		   now read directly, so there is nothing to right-align against and the
		   spacer went with them. */
		var html =
			'<div class="ctx"><span class="date">' +
			esc(JD.weekdayDate(model.generatedAtMs, model.timeZone)) +
			'</span><span class="sprint-chips">' +
			authorChip(standup) +
			sprintChips(standup, model) +
			"</span></div>";

		/* The two day columns. Both are COMMITS ONLY, flat, and identical in shape:
		   what was completed that day, which is what Memory Activity lists for the
		   same day on the stats page.

		   Three things used to make them disagree with that card, all removed. Today
		   carried open TODOs, live sessions and uncommitted worktree rows — work in
		   flight under a heading everyone reads as "done" (JOLLI-2201). Yesterday
		   carried session rows below the memory tier, which are not commits at all.
		   And Yesterday grouped its rows under `TICKET · category` / `repo · branch`
		   headers, which Memory Activity has no counterpart for: its grouping IS the
		   day, and here the day is already the column. A group header inside one is a
		   second axis the other page does not have, so two identical lists read as
		   different ones.

		   Neither column splits by tier any more. A commit is a commit without
		   memory; only how many FIELDS a row can show varies, and that is the row's
		   own business (see commitRow). */
		var yBody = dayColumn(standup.yesterdayCommits, model, memory);
		if (!yBody) yBody = '<div class="empty-note">Nothing recorded.</div>';
		var yCount = "· " + plural(standup.yesterdayCommits.length, "commit");

		var tBody = dayColumn(standup.todayCommits, model, memory);
		if (!tBody) tBody = '<div class="empty-note">Nothing yet.</div>';
		var tCount = "· " + plural(standup.todayCommits.length, "commit");

		/* Two columns. The third — Risks · Blockers · Questions — is gone; see the
		   note at the top of this file for why it could never fill. */
		html += '<div class="cols">';
		html += column("Yesterday", yCount, "", yBody);
		html += column("Today", tCount, "", tBody);
		html += "</div>";

		document.getElementById("app").innerHTML = html;
	};
})(window.JD);
