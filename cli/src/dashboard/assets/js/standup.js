window.JD = window.JD || {};

((JD) => {
	/* Glyph per row kind — the mockup's leading column. Shared with the decisions
	   corpus; see JD.glyph in shell.js. */
	var GLYPH = JD.glyph;

	/* Which insight kinds belong in which column, following the sprint-dashboard
	   mockup: a TODO is what you are going to do next (Today), while blockers,
	   questions and gotchas are what someone has to resolve (Risks). Routing them
	   all into Risks — as this page used to — buries the only column that is
	   supposed to be a to-do list under things nobody can act on today. */
	var TODAY_KINDS = ["todo"];
	var RISK_KINDS = ["blocker", "question", "gotcha"];

	/* ---- rows -------------------------------------------------------------- */

	function itemRow(glyph, title, metas, when, note, mono) {
		var esc = JD.esc;
		var html =
			'<div class="item"><div class="r1">' +
			glyph +
			'<span class="t' +
			(mono ? " mono" : "") +
			'">' +
			esc(title) +
			"</span>" +
			(when ? '<span class="when">' + esc(when) + "</span>" : "") +
			"</div>";
		if (note) html += '<div class="note">' + note + "</div>";
		if (metas && metas.length > 0) {
			html += '<div class="meta">';
			metas.forEach((meta) => {
				html += '<span class="tag">' + esc(meta) + "</span>";
			});
			html += "</div>";
		}
		return html + "</div>";
	}

	function commitItem(commit, model) {
		var stats =
			commit.insertions != null || commit.deletions != null
				? "+" + (commit.insertions || 0) + " −" + (commit.deletions || 0)
				: null;
		var metas = [commit.hash.slice(0, 7)];
		if (stats) metas.push(stats);
		return itemRow(
			GLYPH.commit,
			commit.message,
			metas,
			JD.timeOfDay(commit.committedAtMs, model.timeZone),
			null,
			true,
		);
	}

	function sessionItem(session, model) {
		var metas = [session.source, session.messageCount + " messages"];
		if (session.isLive) metas.unshift("live");
		return itemRow(GLYPH.session, session.title, metas, JD.relTime(session.updatedAtMs, model.generatedAtMs));
	}

	function workspaceItem(workspace) {
		return itemRow(GLYPH.workspace, "Uncommitted on " + (workspace.branch || "detached HEAD"), [
			"+" + workspace.insertions + " −" + workspace.deletions,
			workspace.filesChanged + " files",
			workspace.repoName,
		]);
	}

	/* ---- grouping ---------------------------------------------------------- */

	/* The mockup groups Yesterday: by `repo · branch` when it only has git and
	   session logs, and by `TICKET · topic` once memories give it a ticket. Same
	   function, different key — the point of the group header is "these lines are
	   one piece of work", and which field says so depends on what is known. */
	function groupKey(commit, byTicket) {
		if (byTicket && commit.ticketId) {
			return commit.ticketId + (commit.workCategory ? " · " + commit.workCategory : "");
		}
		return commit.repoName + (commit.branch ? " · " + commit.branch : "");
	}

	function grouped(rows) {
		var order = [];
		/* Prototype-less: the key is `repo · branch`, so a branch called
		   `constructor` or `__proto__` would otherwise read back an inherited
		   value and throw on `.push`, blanking the whole page. */
		var byKey = Object.create(null);
		rows.forEach((row) => {
			if (!byKey[row.key]) {
				byKey[row.key] = [];
				order.push(row.key);
			}
			byKey[row.key].push(row.html);
		});
		var html = "";
		order.forEach((key) => {
			html += '<div class="ghead"><span class="mono">' + JD.esc(key) + "</span></div>" + byKey[key].join("");
		});
		return html;
	}

	/* ---- yesterday --------------------------------------------------------- */

	/* Below the memory tier there are no outcomes to state, so the column is the
	   raw trail: what ran, and what it committed, grouped per branch. */
	function yesterdayRaw(standup, model) {
		var rows = [];
		standup.yesterdayCommits.forEach((commit) => {
			rows.push({ key: groupKey(commit, false), html: commitItem(commit, model) });
		});
		/* Sessions get their own group rather than joining a branch group: nothing
		   records which branch a session was on, and filing it under one would be a
		   guess printed as a header. */
		standup.yesterdaySessions.forEach((session) => {
			rows.push({ key: session.repoName + " · sessions", html: sessionItem(session, model) });
		});
		return grouped(rows);
	}

	/* At the memory tier the column becomes OUTCOMES: one line per commit saying
	   what landed, carrying the decision the memory recorded and what it cost.
	   Session rows drop out here on purpose — the raw session trail is what the
	   stats page's own list is for, and repeating it made this page a duplicate of
	   that one. */
	function yesterdayOutcomes(standup, model) {
		var decisionsByHash = Object.create(null);
		(standup.insights || []).forEach((insight) => {
			if (insight.kind !== "decision") return;
			(decisionsByHash[insight.commitHash] = decisionsByHash[insight.commitHash] || []).push(insight.text);
		});
		var rows = standup.yesterdayCommits.map((commit) => {
			var metas = [];
			if (commit.estCostUsd != null) metas.push(JD.fmtUsd(commit.estCostUsd) + " est");
			if (commit.turns != null) metas.push(commit.turns + (commit.turns === 1 ? " turn" : " turns"));
			if (commit.insertions != null || commit.deletions != null) {
				metas.push("+" + (commit.insertions || 0) + " −" + (commit.deletions || 0));
			}
			if (commit.branch) metas.push(commit.branch);
			var decisions = decisionsByHash[commit.hash] || [];
			var note = decisions.length > 0 ? "<b>Decision:</b> " + JD.mdInline(JD.esc(decisions.join(" · "))) : null;
			return {
				key: groupKey(commit, true),
				html: itemRow(
					GLYPH.session,
					commit.message,
					metas,
					JD.timeOfDay(commit.committedAtMs, model.timeZone),
					note,
				),
			};
		});
		return grouped(rows);
	}

	/* ---- risks ------------------------------------------------------------- */

	/* Age, in the mockup's own tag shape. It reads from the commit the insight came
	   out of, which is the only date on record — an unanswered question is as old as
	   the commit that asked it.
	   No critical/stale variant: the mockup's red 4-day blocker cannot occur here,
	   because buildStandupInsights only selects commits from [yesterday, tomorrow),
	   so this label is bounded at "2 days". Reintroducing a threshold means widening
	   that window first — an unclosed blocker is only interesting once it is old. */
	function ageTag(insight, model) {
		if (insight.committedAtMs == null) return "";
		var days = Math.floor((model.generatedAtMs - insight.committedAtMs) / 86400000);
		var label = days < 1 ? "today" : days === 1 ? "1 day" : days + " days";
		return '<span class="tag age">' + label + "</span>";
	}

	function riskItem(insight, model) {
		var esc = JD.esc;
		return (
			'<div class="item"><div class="r1"><span class="tag kind-' +
			esc(insight.kind) +
			'">' +
			esc(insight.kind) +
			"</span>" +
			(insight.addressedTo
				? '<span class="tag kind-question" style="background:transparent;border:1px dashed var(--accent)">→ ' +
					esc(insight.addressedTo) +
					"</span>"
				: "") +
			'<span class="when"></span></div>' +
			'<div class="note" style="padding-left:2px">' +
			esc(insight.text) +
			"</div>" +
			'<div class="meta" style="padding-left:2px">' +
			ageTag(insight, model) +
			'<span class="tag mono">' +
			esc(insight.commitHash.slice(0, 7)) +
			"</span>" +
			'<span class="tag">' +
			esc(insight.repoName) +
			"</span></div></div>"
		);
	}

	/* ---- sprint context ---------------------------------------------------- */

	/* The mockup's ctx-strip chips. Its own version reads `Sprint 14 · day 7 of 10`
	   and `JOL-142 · 4/7 steps · ● on track`; sprint numbering and plan-step
	   progress do not exist locally (plan enumeration is a known gap), so the chips
	   carry the part that does — the tickets the window's commits actually name —
	   and the last chip states what is missing instead of inventing a status. */
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
		var html = tickets
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
		return html + '<span class="schip" style="border-style:dashed">step progress needs plan enumeration</span>';
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

	/* ---- the drafted standup ----------------------------------------------- */

	/* The markdown the sheet shows and the clipboard gets. Same routing as the
	   board: TODOs sit under Today, and Risks carries blockers, questions and
	   gotchas — a draft that disagreed with the columns above it would be the
	   worse of the two bugs. */
	JD.standupMarkdown = (model) => {
		var standup = model.standup;
		var insights = standup.insights || [];
		var todos = insights.filter((insight) => TODAY_KINDS.indexOf(insight.kind) >= 0);
		var risks = insights.filter((insight) => RISK_KINDS.indexOf(insight.kind) >= 0);
		var decisionsByHash = Object.create(null);
		insights.forEach((insight) => {
			if (insight.kind !== "decision") return;
			(decisionsByHash[insight.commitHash] = decisionsByHash[insight.commitHash] || []).push(insight.text);
		});

		var lines = ["## Standup — " + standup.today, "", "**Yesterday**"];
		/* Built into its own array first, so the "nothing recorded" test asks what
		   this section will ACTUALLY emit. Counting the raw inputs instead was one
		   filter out of date: at the memory tier the session loop below is skipped,
		   so a day with agent sessions but no commits counted as non-empty and then
		   printed nothing — `**Yesterday**` immediately followed by `**Today**`,
		   while the board column correctly said "Nothing recorded." */
		var yesterday = [];
		standup.yesterdayCommits.forEach((commit) => {
			var prefix = commit.ticketId ? commit.ticketId + ": " : "";
			var decisions = decisionsByHash[commit.hash] || [];
			yesterday.push(
				"- " +
					prefix +
					commit.message +
					" (`" +
					commit.hash.slice(0, 7) +
					"`" +
					(commit.branch ? ", " + commit.branch : "") +
					")" +
					(decisions.length > 0 ? " — decision: " + decisions.join("; ") : ""),
			);
		});
		/* Session lines only below the memory tier, mirroring the board: once there
		   are outcomes, the session trail is noise in a standup. */
		if (!standup.insights) {
			standup.yesterdaySessions.forEach((session) => {
				yesterday.push("- [" + session.source + "] " + session.title);
			});
		}
		lines.push(yesterday.length > 0 ? yesterday.join("\n") : "- (nothing recorded)");

		lines.push("", "**Today**");
		/* Same construction as Yesterday, and for the same reason: the session loop
		   drops non-live rows at the memory tier, so the raw counts overstate it. */
		var today = [];
		standup.todayCommits.forEach((commit) => {
			today.push("- " + commit.message + " (`" + commit.hash.slice(0, 7) + "`)");
		});
		standup.todaySessions.forEach((session) => {
			if (standup.insights && !session.isLive) return;
			today.push("- [" + session.source + "] " + session.title + (session.isLive ? " (in progress)" : ""));
		});
		todos.forEach((todo) => {
			today.push("- TODO: " + todo.text + " (`" + todo.commitHash.slice(0, 7) + "`)");
		});
		standup.workspaces.forEach((workspace) => {
			today.push(
				"- Uncommitted on " +
					(workspace.branch || "detached HEAD") +
					" · +" +
					workspace.insertions +
					" −" +
					workspace.deletions +
					" across " +
					workspace.filesChanged +
					" files (" +
					workspace.repoName +
					")",
			);
		});
		lines.push(today.length > 0 ? today.join("\n") : "- (nothing yet)");

		if (risks.length > 0) {
			lines.push("", "**Risks · Blockers · Questions**");
			risks.forEach((insight) => {
				lines.push(
					"- [" +
						insight.kind +
						"] " +
						insight.text +
						" (`" +
						insight.commitHash.slice(0, 7) +
						"`)" +
						(insight.addressedTo ? " → " + insight.addressedTo : ""),
				);
			});
		}
		return lines.join("\n");
	};

	/* ---- columns ----------------------------------------------------------- */

	function column(title, count, sub, bodyHtml) {
		return (
			'<section class="card col" aria-label="' +
			JD.esc(title) +
			'"><h2>' +
			JD.esc(title) +
			'<span class="cnt">' +
			JD.esc(count) +
			"</span></h2>" +
			'<div class="sub">' +
			JD.esc(sub) +
			'</div><div class="col-list">' +
			bodyHtml +
			"</div></section>"
		);
	}

	var plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

	JD.renderStandup = (model) => {
		var esc = JD.esc;
		var standup = model.standup;
		var memory = !!standup.insights;
		var insights = standup.insights || [];
		var todos = insights.filter((insight) => TODAY_KINDS.indexOf(insight.kind) >= 0);
		var risks = insights.filter((insight) => RISK_KINDS.indexOf(insight.kind) >= 0);

		/* Context strip: date, sprint chips, where this goes, and the draft action. */
		var html =
			'<div class="ctx"><span class="date">' +
			esc(JD.weekdayDate(model.generatedAtMs, model.timeZone)) +
			'</span><span class="sprint-chips">' +
			authorChip(standup) +
			sprintChips(standup, model) +
			'</span><div class="spacer"></div>' +
			'<span class="share-note">posts nowhere — copy it where you like</span>' +
			'<button class="copybtn" type="button" id="copyStandup">⧉ Copy as standup</button></div>';

		/* Yesterday. */
		var yBody = memory ? yesterdayOutcomes(standup, model) : yesterdayRaw(standup, model);
		if (!yBody) yBody = '<div class="empty-note">Nothing recorded.</div>';
		var yCount = memory
			? "· " + plural(standup.yesterdayCommits.length, "outcome")
			: "· " +
				plural(standup.yesterdaySessions.length, "session") +
				" · " +
				plural(standup.yesterdayCommits.length, "commit");
		var ySub = memory
			? "From your commit memories — each line carries the commit it came from"
			: "Stitched from session logs + git log — raw but real";

		/* Today. Live sessions stay visible at the memory tier (they are the closest
		   local answer to the mockup's "next plan step, in a session now"); the rest
		   of today's session trail drops out, same reasoning as Yesterday. */
		var tBody = "";
		standup.todayCommits.forEach((commit) => {
			tBody += commitItem(commit, model);
		});
		standup.todaySessions.forEach((session) => {
			if (memory && !session.isLive) return;
			tBody += sessionItem(session, model);
		});
		todos.forEach((todo) => {
			tBody += itemRow(GLYPH.todo, "TODO: " + todo.text, [
				todo.commitHash.slice(0, 7),
				todo.repoName,
			]);
		});
		standup.workspaces.forEach((workspace) => {
			tBody += workspaceItem(workspace);
		});
		if (!tBody) tBody = '<div class="empty-note">Nothing yet.</div>';
		var live = standup.todaySessions.filter((session) => session.isLive).length;
		var tCount = memory
			? "· " + plural(todos.length, "TODO") + (live > 0 ? " · " + live + " live" : "")
			: live > 0
				? "· " + live + " live"
				: "· " + plural(standup.todaySessions.length, "session");
		var tSub = memory
			? "Open TODOs, live sessions and working-tree state — edit before sharing"
			: "Live sessions and working-tree state";

		/* Risks. */
		var rBody = "";
		risks.forEach((insight) => {
			rBody += riskItem(insight, model);
		});
		if (memory && !rBody) rBody = '<div class="empty-note">Nothing flagged in this window.</div>';

		html += '<div class="cols">';
		html += column("Yesterday", yCount, ySub, yBody);
		html += column("Today", tCount, tSub, tBody);
		html += memory
			? column(
					"Risks · Blockers · Questions",
					"· " + risks.length,
					"Blockers, open questions and gotchas from yesterday and today's commit memories",
					rBody,
				)
			: JD.lockedCard(
					"Risks · Blockers · Questions",
					"Blockers and questions live inside your conversations — memory extracts them, with the commit " +
						"each one came from.",
					"col",
				);
		html += "</div>";

		document.getElementById("app").innerHTML = html;

		/* ---- draft sheet --------------------------------------------------- */

		var overlay = document.getElementById("ovStandup");
		var output = document.getElementById("mdOut");
		var toast = document.getElementById("mdToast");
		var copyButton = document.getElementById("copyStandup");

		var flash = () => {
			toast.classList.add("show");
			setTimeout(() => toast.classList.remove("show"), 1600);
		};
		var close = () => {
			overlay.classList.remove("open");
			copyButton.focus();
		};

		copyButton.onclick = () => {
			output.value = JD.standupMarkdown(model);
			/* The unfiltered warning goes FIRST and outranks the tier note: what you
			   are about to paste containing a teammate's commit matters more than
			   where the lines came from. */
			document.getElementById("sheetSub").textContent = !standup.authoredBy
				? "Every author's commits — no git identity configured, so check the lines are yours before posting."
				: memory
					? "From your commit memories. Edit anything before you post it."
					: "From raw sessions + git log. Enable Jolli Memory for decisions, TODOs and blockers.";
			overlay.classList.add("open");
			output.focus();
			/* Copied on open as well as on the button: the one-click path stays as fast
			   as it was, and the sheet is what makes the draft correctable. */
			if (navigator.clipboard) navigator.clipboard.writeText(output.value).then(flash, () => {});
		};
		document.getElementById("copyMd").onclick = () => {
			output.select();
			if (!navigator.clipboard) return;
			navigator.clipboard.writeText(output.value).then(flash, () => {
				toast.textContent = "Copy failed";
				flash();
			});
		};
		document.getElementById("closeOv").onclick = close;
		overlay.onclick = (event) => {
			if (event.target === overlay) close();
		};
		/* Bound on the document, not the sheet: Escape has to work wherever focus
		   sits inside the dialog, textarea included. An assignment rather than
		   addEventListener, so the 30-second re-render replaces this handler instead
		   of stacking another copy of it. */
		document.onkeydown = (event) => {
			if (event.key === "Escape" && overlay.classList.contains("open")) close();
		};
	};
})(window.JD);
