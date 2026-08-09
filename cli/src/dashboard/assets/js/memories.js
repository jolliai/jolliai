window.JD = window.JD || {};

((JD) => {
	/**
	 * Memories — the repo > branch > memory browser. Folds in what used to be
	 * the standalone Decisions page: each topic's Decisions callout renders
	 * inline in the detail pane below, rather than on a separate corpus view.
	 *
	 * Selecting a memory is a real navigation (`/memories?repo=&hash=`), not a
	 * client-side swap — same discipline the Graph page already uses, and what
	 * makes a memory bookmarkable. The tree's own furniture (Branches/Timeline
	 * tab, collapsed groups, the search box) is pure client state instead —
	 * same choice the Graph page made for its kind filter chips — because the
	 * server already sent every loaded memory; re-navigating to type a letter
	 * would be the wrong trade.
	 */

	/* Persist across re-renders (a 30s refresh tick re-runs renderMemories),
	   not across page loads — mirrors JD.graphHidden / JD.graphSel. */
	JD.memView = JD.memView || "branches";
	JD.memCollapsed = JD.memCollapsed || {};
	JD.memQuery = JD.memQuery || "";

	const MEMORY_ICONS = {
		database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
		copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
		lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
		cloud: '<path d="M17 19H8a5 5 0 1 1 1-9.9A6 6 0 0 1 20 12a3.5 3.5 0 0 1-3 7Z"/>',
		hash: '<path d="M4 9h16M4 15h16M10 3 8 21m8-18-2 18"/>',
		branch: '<path d="M6 3v12"/><circle cx="6" cy="3" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8h5a7 7 0 0 0 7-7"/>',
		file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/>',
		message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
		link: '<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>',
		document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
		checks: '<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
		bulb: '<path d="M9 18h6M10 22h4M8.5 14c-.2-1-.7-1.7-1.4-2.4A6 6 0 1 1 16.9 11.6c-.7.7-1.2 1.4-1.4 2.4"/>',
	};

	function memoryIcon(name, className) {
		return '<svg class="mem-icon' + (className ? " " + className : "") + '" viewBox="0 0 24 24" aria-hidden="true">' + MEMORY_ICONS[name] + "</svg>";
	}

	function repoBranchGroups(items) {
		var repoOrder = [];
		var byRepo = new Map();
		items.forEach((item) => {
			/* Keyed on repoIdentity, NOT repoName. Identity is the normalized remote,
			   and the dashboard deliberately supports two clones of one project — but
			   also two DIFFERENT projects whose directories happen to share a name, and
			   grouping those by name merged them into one node whose `repoIdentity`
			   (taken from whichever arrived first) then pointed every row in the group
			   at the wrong repo. */
			var repoGroup = byRepo.get(item.repoIdentity);
			if (!repoGroup) {
				repoGroup = { repoIdentity: item.repoIdentity, repoName: item.repoName, items: [], branches: [] };
				byRepo.set(item.repoIdentity, repoGroup);
				repoOrder.push(repoGroup);
			}
			repoGroup.items.push(item);
			var branchLabel = item.branch || "(no branch)";
			var branchGroup = repoGroup.branches.filter((b) => b.branch === branchLabel)[0];
			if (!branchGroup) {
				branchGroup = { branch: branchLabel, items: [] };
				repoGroup.branches.push(branchGroup);
			}
			branchGroup.items.push(item);
		});
		return repoOrder;
	}

	function matchesQuery(item, lowerQuery) {
		if (!lowerQuery) return true;
		var hay = [item.title, item.shortHash, item.commitHash, item.ticketId, item.branch, item.category, item.repoName]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		return hay.indexOf(lowerQuery) >= 0;
	}

	function groupHead(key, label, count, extraClass) {
		var esc = JD.esc;
		var collapsed = !!JD.memCollapsed[key];
		var icon = extraClass === "mem-repo-head"
			? '<svg class="tree-kind" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3"/><circle cx="13" cy="12" r="2"/><path d="M18 19c-2.8 0-5-2.2-5-5v8"/><circle cx="20" cy="19" r="2"/></svg>'
			: '<svg class="tree-kind" viewBox="0 0 24 24" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
		return (
			'<div class="mem-group-head' +
			(extraClass ? " " + extraClass : "") +
			'" data-toggle="' +
			esc(key) +
			'" role="button" tabindex="0" aria-expanded="' +
			String(!collapsed) +
			'"><span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></span>' +
			icon +
			// Truncated by .lbl's ellipsis when the repo/branch name is long — the
			// title is how the rest of it stays reachable.
			'<span class="lbl" title="' +
			esc(label) +
			'">' +
			esc(label) +
			'</span><span class="cnt">' +
			count +
			"</span></div>"
		);
	}

	function treeRow(model, item, selected, showRepoTag) {
		var esc = JD.esc;
		var chips = "";
		if (showRepoTag) chips += '<span class="tag">' + esc(item.repoName) + "</span>";
		if (item.category) chips += '<span class="tag">' + esc(item.category) + "</span>";
		if (item.ticketId) chips += '<span class="tag">' + esc(item.ticketId) + "</span>";
		if (item.synced) chips += '<span class="tag">synced</span>';
		return (
			'<div class="item" data-repo="' +
			esc(item.repoIdentity) +
			'" data-hash="' +
			esc(item.commitHash) +
			'"' +
			(selected ? ' aria-current="true"' : "") +
			' role="button" tabindex="0">' +
			'<div class="r1"><span class="glyph">' +
			JD.glyph.commit +
			"</span>" +
			(item.memoryRefId ? '<span class="tree-short-hash mono">' + esc(item.memoryRefId) + "</span>" : "") +
			'<span class="t" title="' +
			esc(item.title || "(no message)") +
			'">' +
			esc(item.title || "(no message)") +
			'</span><span class="when">' +
			esc(JD.relTime(item.committedAtMs, model.generatedAtMs)) +
			"</span></div>" +
			'<div class="meta"><span class="tag mono">' +
			esc(item.shortHash) +
			"</span>" +
			(item.branch && !showRepoTag ? '<span class="tag">' + esc(item.branch) + "</span>" : "") +
			chips +
			"</div></div>"
		);
	}

	/**
	 * The tree's footer: how much of the corpus is loaded, and the button that
	 * fetches the next page.
	 *
	 * Deliberately NOT {@link JD.moreToggle}, which the detail pane's lists use:
	 * that one only expands rows the server already sent, so its label can
	 * promise "Show all N". This button costs a round trip per click, so it says
	 * what it will actually do and never claims to finish the list in one.
	 *
	 * Nothing at all once everything is loaded — a footer that only ever reads
	 * "N of N" is noise on the far more common small-corpus page.
	 */
	function loadMoreRow(memories) {
		var loaded = (memories.items || []).length;
		if (!loaded || loaded >= memories.totalCount) return "";
		var label = memories.loadingPage ? "Loading…" : memories.loadError ? "Try again" : "Load more";
		return (
			'<div class="more-row"><span class="more-count">' +
			loaded +
			" of " +
			memories.totalCount +
			" memories loaded" +
			/* The failure is stated in the footer rather than a toast: it is the
			   reason this button is still here, and it belongs next to the count it
			   stopped from growing. */
			(memories.loadError && !memories.loadingPage ? " — could not load more" : "") +
			'</span><button type="button" class="cta ghost sm" id="memLoadMore"' +
			(memories.loadingPage ? " disabled" : "") +
			">" +
			label +
			"</button></div>"
		);
	}

	/** The tree body only — toolbar (tabs + search) is rendered once and left alone,
	    so re-filtering on every keystroke never steals focus from the search input. */
	function renderTreeBody(model) {
		var memories = model.memories || {};
		var items = memories.items || [];
		if (!items.length) {
			return (
				'<p class="empty-note">Nothing has been captured on this machine yet. Enable a repository, then ' +
				"commit (or run <code>jolli backfill</code> for past commits) and its memories land here.</p>"
			);
		}
		var lowerQuery = JD.memQuery.trim().toLowerCase();
		var filtered = items.filter((item) => matchesQuery(item, lowerQuery));
		var selectedHash = memories.selected ? memories.selected.commitHash : null;
		var html = "";
		if (!filtered.length) {
			html = '<p class="empty-note">No memories match “' + JD.esc(JD.memQuery.trim()) + '”.</p>';
		} else if (JD.memView === "timeline") {
			repoBranchGroups(filtered).forEach((repoGroup) => {
				var repoKey = "repo:" + repoGroup.repoIdentity;
				html += groupHead(repoKey, repoGroup.repoName, repoGroup.items.length, "mem-repo-head");
				if (JD.memCollapsed[repoKey]) return;
				repoGroup.items.forEach((item) => {
					html += treeRow(model, item, item.commitHash === selectedHash, false);
				});
			});
		} else {
			repoBranchGroups(filtered).forEach((repoGroup) => {
				var repoKey = "repo:" + repoGroup.repoIdentity;
				html += groupHead(repoKey, repoGroup.repoName, repoGroup.items.length, "mem-repo-head");
				if (JD.memCollapsed[repoKey]) return;
				repoGroup.branches.forEach((branchGroup) => {
					var branchKey = repoKey + "/" + branchGroup.branch;
					html += groupHead(branchKey, branchGroup.branch, branchGroup.items.length, "mem-branch-head");
					if (JD.memCollapsed[branchKey]) return;
					branchGroup.items.forEach((item) => {
						html += treeRow(model, item, item.commitHash === selectedHash, false);
					});
				});
			});
		}
		/* Never merged into one count with the footer below: the filter ran over what
		   is LOADED, so both of its numbers are client-side, while the footer compares
		   two server-side figures. Pairing "showing N" with `totalCount` would state a
		   match count against a set the filter never saw — and until every page is in,
		   those two sets genuinely differ. Skipped when nothing matched; that branch
		   already says so. */
		if (filtered.length && filtered.length !== items.length) {
			html +=
				'<p class="empty-note">Showing ' +
				filtered.length +
				" of " +
				items.length +
				" loaded memories matching the filter.</p>";
		}
		html += loadMoreRow(memories);
		return html;
	}

	function wireTree(model) {
		Array.prototype.forEach.call(document.querySelectorAll("#memTree .item"), (row) => {
			row.onclick = () => {
				var repo = row.getAttribute("data-repo");
				var hash = row.getAttribute("data-hash");
				window.location.href =
					"/memories?repo=" + encodeURIComponent(JD.repoToken(model, repo)) + "&hash=" + encodeURIComponent(hash);
			};
			row.onkeydown = (event) => {
				if (event.key === "Enter" || event.key === " ") row.onclick();
			};
		});
		Array.prototype.forEach.call(document.querySelectorAll("#memTree .mem-group-head"), (head) => {
			var toggle = () => {
				var key = head.getAttribute("data-toggle");
				if (JD.memCollapsed[key]) delete JD.memCollapsed[key];
				else JD.memCollapsed[key] = true;
				refreshTree(model);
			};
			head.onclick = toggle;
			head.onkeydown = (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					toggle();
				}
			};
		});
		/* Rebound on every tree repaint, including the one `loadMoreMemories`
		   itself triggers — the footer is part of the tree body, so each page
		   replaces this element rather than updating it. */
		var loadMore = document.getElementById("memLoadMore");
		if (loadMore) loadMore.onclick = () => loadMoreMemories(model);
	}

	function refreshTree(model) {
		document.getElementById("memTree").innerHTML = renderTreeBody(model);
		wireTree(model);
	}

	function renderToolbar(model) {
		var memories = model.memories || {};
		if (!(memories.items || []).length) return "";
		return (
			'<div class="mem-toolbar">' +
			'<div class="seg seg-sm" id="memViewSeg">' +
			'<button type="button" data-view="branches" aria-pressed="' +
			String(JD.memView === "branches") +
			'">Branches</button>' +
			'<button type="button" data-view="timeline" aria-pressed="' +
			String(JD.memView === "timeline") +
			'">Timeline</button>' +
			"</div>" +
			'<div class="dx-input"><span class="pfx">⌕</span><input type="text" id="memSearch" placeholder="Search memories…" value="' +
			JD.esc(JD.memQuery) +
			'" /></div>' +
			"</div>"
		);
	}

	function wireToolbar(model) {
		var seg = document.getElementById("memViewSeg");
		if (seg) {
			Array.prototype.forEach.call(seg.querySelectorAll("button"), (button) => {
				button.onclick = () => {
					JD.memView = button.getAttribute("data-view");
					Array.prototype.forEach.call(seg.querySelectorAll("button"), (b) =>
						b.setAttribute("aria-pressed", String(b === button)),
					);
					refreshTree(model);
				};
			});
		}
		var search = document.getElementById("memSearch");
		if (search) {
			search.oninput = () => {
				JD.memQuery = search.value;
				refreshTree(model);
			};
		}
	}

	function tokenMeter(tokens) {
		if (!tokens) return "";
		var total = tokens.input + tokens.output + tokens.cached;
		var esc = JD.esc;
		var seg = (n, color) => (total > 0 ? '<i style="width:' + (n / total) * 100 + '%;background:' + color + '"></i>' : "");
		var cost = tokens.costUsd != null ? " · " + JD.fmtUsd(tokens.costUsd) : "";
		var asOf = tokens.pricesAsOf ? " (est. at " + esc(tokens.pricesAsOf) + " prices)" : "";
		return (
			'<div class="mem-token-meter">' +
			'<div class="gd-sec">Conversation tokens</div>' +
			'<div class="gd-row"><b class="num">' +
			JD.fmtTokens(total) +
			"</b>" +
			cost +
			asOf +
			"</div>" +
			'<div class="tok-bar">' +
			seg(tokens.input, "var(--s1)") +
			seg(tokens.output, "var(--s4)") +
			seg(tokens.cached, "var(--baseline)") +
			"</div>" +
			'<div class="dist-labels"><span><i style="background:var(--s1)"></i>Input ' +
			JD.fmtTokens(tokens.input) +
			'</span><span><i style="background:var(--s4)"></i>Output ' +
			JD.fmtTokens(tokens.output) +
			'</span><span><i style="background:var(--baseline)"></i>Cached ' +
			JD.fmtTokens(tokens.cached) +
			"</span></div></div>"
		);
	}

	function rows(list, render, emptyText) {
		if (!list || !list.length) return emptyText ? '<div class="gd-empty">' + JD.esc(emptyText) + "</div>" : "";
		return '<div class="gd-links">' + list.map(render).join("") + "</div>";
	}

	function conversationsSection(detail) {
		var esc = JD.esc;
		var body = rows(
			detail.conversations,
			(c) =>
				'<div class="gd-row"><span class="mem-row-icon">' +
				memoryIcon("message") +
				'</span><span class="mem-row-title">' +
				esc(c.title || "(untitled)") +
				'</span><span class="mem-row-meta">' + esc(c.source) + '</span><span class="mem-row-meta">' + c.messageCount + " msgs</span></div>",
			"No conversations linked yet.",
		);
		return (
			'<section class="mem-section mem-conversations"><div class="mem-section-head"><div class="gd-sec">' +
			memoryIcon("message") +
			"Conversations · " +
			detail.conversations.length +
			'</div><span class="mem-private">' +
			memoryIcon("lock") +
			"Private to you</span></div>" +
			body +
			"</section>"
		);
	}

	// No Activity section here. A raw tool-call tally (`Bash ×615`) read as noise
	// on a page about ONE memory; the aggregate view lives on the Skills / MCP
	// cards in `stats.js`. `detail.activity` / `detail.activityUncoveredSources`
	// stay in the payload, so restoring it is a render change only.

	function referencesAndContext(detail) {
		var esc = JD.esc;
		var refRows = detail.references.map(
			(r) =>
				'<div class="gd-row"><span class="mem-row-icon">' +
				memoryIcon("link") +
				'</span><span class="mem-row-meta mono">' +
				esc(r.nativeId) +
				'</span><span class="mem-row-title">' +
				esc(r.title) +
				'</span><span class="mem-row-meta">' +
				esc(r.source) +
				"</span></div>",
		);
		// Plans and notes are openable: the body lives in the dashboard database
		// (`context.body_md`), so the row is a button that fetches it into the
		// viewer dialog rather than a dead label. A reference stays a plain row —
		// its content is an external system's, not ours to render.
		var ctxRows = detail.context.map(
			(c) =>
				'<div class="gd-row gd-row-open" role="button" tabindex="0" data-context-kind="' +
				esc(c.kind) +
				'" data-context-key="' +
				esc(c.contextKey) +
				'"><span class="mem-row-icon">' +
				memoryIcon("document") +
				'</span><span class="mem-row-meta">' +
				esc(c.kind.toUpperCase()) +
				'</span><span class="mem-row-title">' +
				esc(c.title) +
				'</span><span class="mem-row-meta">Open →</span></div>',
		);
		var all = refRows.concat(ctxRows);
		var body = all.length ? '<div class="gd-links">' + all.join("") + "</div>" : '<div class="gd-empty">None.</div>';
		var excluded = detail.excluded.length
			? '<div class="gd-sec">Automatically set aside</div><div class="gd-links">' +
				detail.excluded
					.map((e) => '<div class="gd-row"><span>' + esc(e.title) + " — " + esc(e.reason) + "</span></div>")
					.join("") +
				"</div>"
			: "";
		return '<section class="mem-section mem-context"><div class="gd-sec">' + memoryIcon("link") + "Context · " + all.length + "</div>" + body + excluded + "</section>";
	}

	function topicsSection(detail) {
		var esc = JD.esc;
		if (!detail.topics.length) return "";
		return (
			'<section class="mem-section mem-topics"><div class="gd-sec">What changed and why</div><div class="mem-topic-list">' +
			detail.topics
				.map((t) => {
					var decisions = t.decisions.length
						? '<div class="decide"><div class="decide-title">' +
							memoryIcon("bulb") +
							"Decisions</div><ul>" +
							t.decisions.map((d) => "<li>" + JD.mdInline(esc(d)) + "</li>").join("") +
							"</ul></div>"
						: "";
					var files = t.files.length
						? '<div class="fchips">' +
							t.files
								.map((f) => '<span class="fchip">' + memoryIcon("file") + esc(f) + "</span>")
								.join("") +
							"</div>"
						: "";
					var todo = t.todo
						? '<div class="topic-block"><div class="gd-sec">Future enhancements</div><div class="prose">' +
							JD.mdText(t.todo) +
							"</div></div>"
						: "";
					return (
						'<article class="topic"><div class="topic-head"><h3>' +
						esc(t.title) +
						"</h3>" +
						(t.category ? '<span class="tag">' + esc(t.category) + "</span>" : "") +
						'</div><div class="topic-trigger prose">' +
						JD.mdText(t.trigger) +
						"</div>" +
						decisions +
						'<div class="topic-block"><div class="gd-sec">What was implemented</div><div class="prose">' +
						JD.mdText(t.response) +
						"</div></div>" +
						todo +
						files +
						"</article>"
					);
				})
				.join("") +
			"</div></section>"
		);
	}

	function filesSection(detail) {
		if (!detail.files.length) return "";
		var esc = JD.esc;
		return (
			'<section class="mem-section mem-files"><div class="gd-sec">' +
			memoryIcon("file") +
			"Files changed · " +
			detail.files.length +
			"</div>" +
			'<ul class="filelist">' +
			detail.files
				.map((f) => {
					var parts = [];
					if (f.insertions != null) parts.push("+" + f.insertions);
					if (f.deletions != null) parts.push("-" + f.deletions);
					return (
						'<li><span class="mem-file-icon">' +
						memoryIcon("file") +
						'</span><span class="p mono">' +
						esc(f.path) +
						'</span><span class="mem-file-diff">' +
						esc(parts.join(" ")) +
						"</span></li>"
					);
				})
				.join("") +
			"</ul></section>"
		);
	}

	function e2eSection(detail) {
		if (!detail.e2e.length) return "";
		var esc = JD.esc;
		return (
			'<section class="mem-section mem-e2e"><div class="gd-sec">' +
			memoryIcon("checks") +
			"E2E test guide · " +
			detail.e2e.length +
			"</div>" +
			detail.e2e
				.map(
					(s) =>
						'<div class="e2e"><h3>' +
						esc(s.title) +
						"</h3>" +
						(s.preconditions ? "<div class=\"gd-row\">" + esc(s.preconditions) + "</div>" : "") +
						"<div class=\"gd-sec\">Steps</div><ol>" +
						s.steps.map((step) => "<li>" + esc(step) + "</li>").join("") +
						"</ol><div class=\"gd-sec\">Expected</div><ul>" +
						s.expectedResults.map((r) => "<li>" + esc(r) + "</li>").join("") +
						"</ul></div>",
				)
				.join("")
			+ "</section>"
		);
	}

	function renderDetail(model) {
		var esc = JD.esc;
		var detail = model.memories && model.memories.selected;
		if (!detail) {
			return '<div class="gd-empty">Pick a memory on the left — this pane shows its full detail: conversations, context, and what it decided.</div>';
		}
		var meta =
			'<span>' +
			memoryIcon("hash") +
			'<span class="mono">' +
			esc(detail.shortHash) +
			"</span></span>" +
			(detail.branch
				? '<span>' + memoryIcon("branch") + "<span>" + esc(detail.branch) + "</span></span>"
				: "") +
			(detail.author ? "<span>" + esc(detail.author) + "</span>" : "") +
			"<span>Captured " +
			esc(JD.weekdayDate(detail.committedAtMs, model.timeZone)) +
			"</span>" +
			(detail.filesChanged != null
				? '<span>' +
					memoryIcon("file") +
					"<span>" +
					detail.filesChanged +
					" files" +
					(detail.insertions != null ? ' <b class="mem-pos">+' + detail.insertions + "</b>" : "") +
					(detail.deletions != null ? ' <b class="mem-neg">-' + detail.deletions + "</b>" : "") +
					"</span></span>"
				: "");

		var eyebrow =
			'<div class="gd-chips mem-eyebrow">' +
			(detail.category ? '<span class="tag">' + esc(detail.category) + "</span>" : "") +
			(detail.ticketId ? '<span class="tag">' + esc(detail.ticketId) + "</span>" : "") +
			'<span class="tag mem-sync">' +
			memoryIcon(detail.synced ? "cloud" : "document") +
			(detail.synced ? "Synced" : "Local") +
			"</span></div>";

		var counts =
			'<div class="gd-row mem-counts">' +
			detail.conversations.length +
			" conversations, " +
			(detail.references.length + detail.context.length) +
			" context, " +
			detail.files.length +
			" files" +
			(detail.summarizedBy
				? " · Summary by " + esc(detail.summarizedBy.model) + " · " + JD.fmtTokens(detail.summarizedBy.tokens) + " tokens to write it"
				: "") +
			"</div>";

		return (
			'<div class="mem-detail-head"><button class="mem-recall-copy" id="memRecallCopy" type="button">' +
			memoryIcon("copy") +
			"Copy Recall Prompt</button></div>" +
			eyebrow +
			'<div class="mem-title"><span class="mem-title-mark">' +
			memoryIcon("database") +
			'</span><div><span class="mem-short-hash mono">' +
			esc(detail.shortHash) +
			'</span><div class="gd-title">' +
			esc(detail.title) +
			"</div></div></div>" +
			'<div class="gd-row mem-meta">' +
			meta +
			"</div>" +
			tokenMeter(detail.tokens) +
			counts +
			(detail.recap ? '<div class="mem-recap">' + JD.mdParagraphs(detail.recap) + "</div>" : "") +
			'<div class="mem-detail-sections">' +
			conversationsSection(detail) +
			referencesAndContext(detail) +
			topicsSection(detail) +
			filesSection(detail) +
			e2eSection(detail) +
			"</div>"
		);
	}

	/* The Context viewer. One shared dialog for every plan/note on the page —
	   the body is fetched on click rather than shipped with the detail payload,
	   because a memory can carry several full markdown files the reader usually
	   never opens. Rendered as preformatted text, not HTML: this page has no
	   markdown renderer, and inventing one that injects a document written by an
	   agent into the DOM is not a corner worth cutting. */
	function openContextDialog(detail, kind, key) {
		var overlay = document.getElementById("ovContext");
		var title = document.getElementById("ctxTitle");
		var sub = document.getElementById("ctxSub");
		var body = document.getElementById("ctxBody");
		if (!overlay || !title || !sub || !body) return;
		title.textContent = kind === "plan" ? "Plan" : "Note";
		sub.textContent = "Loading…";
		body.textContent = "";
		overlay.classList.add("open");
		var url =
			"/api/context?repo=" +
			encodeURIComponent(detail.repoIdentity) +
			"&kind=" +
			encodeURIComponent(kind) +
			"&key=" +
			encodeURIComponent(key);
		fetch(url)
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
			.then((doc) => {
				title.textContent = doc.title;
				sub.textContent = doc.kind === "plan" ? "Plan" : "Note";
				body.textContent = doc.bodyMd;
			})
			.catch((err) => {
				/* Never leave the dialog on "Loading…". The status is part of the
				   message on purpose: a server started before this endpoint existed
				   answers the same 404 as a genuinely missing document, and "restart
				   the dashboard" is the fix for one and not the other. */
				sub.textContent =
					"Could not load this document (" +
					(err && err.message ? "HTTP " + err.message : "request failed") +
					"). If the dashboard has been running a while, restart it — this viewer needs a current server.";
			});
	}

	function wireContextRows(model) {
		var detail = model.memories && model.memories.selected;
		if (!detail) return;
		var overlay = document.getElementById("ovContext");
		var close = document.getElementById("ctxClose");
		if (close) close.onclick = () => overlay.classList.remove("open");
		if (overlay) {
			overlay.onclick = (e) => {
				if (e.target === overlay) overlay.classList.remove("open");
			};
		}
		document.querySelectorAll("[data-context-key]").forEach((row) => {
			var open = () =>
				openContextDialog(detail, row.getAttribute("data-context-kind"), row.getAttribute("data-context-key"));
			row.onclick = open;
			row.onkeydown = (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			};
		});
	}

	function wireDetail(model) {
		wireContextRows(model);
		var copy = document.getElementById("memRecallCopy");
		var detail = model.memories && model.memories.selected;
		if (!copy || !detail) return;
		copy.onclick = async () => {
			var prompt = [
				"Recall the following Jolli memory:",
				detail.title,
				detail.recap || "",
				detail.branch ? "Branch: " + detail.branch : "",
				detail.commitHash ? "Commit: " + detail.commitHash : "",
			]
				.filter(Boolean)
				.join("\n");
			try {
				await navigator.clipboard.writeText(prompt);
				copy.innerHTML = memoryIcon("copy") + "Copied";
				setTimeout(() => {
					copy.innerHTML = memoryIcon("copy") + "Copy Recall Prompt";
				}, 1600);
			} catch {
				copy.innerHTML = memoryIcon("copy") + "Copy unavailable";
			}
		};
	}

	/**
	 * Fetches ONE more page and appends it — the "Load more" button's handler,
	 * and the only thing that grows the loaded set.
	 *
	 * Never chained or auto-fired. A render-driven chain (each arriving page
	 * re-rendering, which then asks for the next) reads as jank: the tree grows
	 * and reflows under the reader's cursor mid-click, and it spends a request
	 * per page on history the reader may never scroll into. The inlined first
	 * page is already a working tree; anything past it earns its round trip only
	 * when asked for.
	 *
	 * Repaints the tree ONLY, through `refreshTree` rather than
	 * `JD.renderMemories`: the toolbar keeps its focus and caret, and the detail
	 * pane — a full memory read that has nothing to do with this list — is left
	 * alone instead of being rebuilt under the reader.
	 *
	 * All the paging state lives ON `memories`, never on JD: a `/api/model`
	 * refresh replaces that object with a fresh one from the server, which then
	 * starts again from its own first page. Module-level flags would survive the
	 * swap and either strand the new model at page 1 or append its pages onto
	 * the old one's items.
	 */
	function loadMoreMemories(model) {
		var memories = model.memories;
		if (!memories || memories.loadingPage) return;
		var items = memories.items || [];
		if (items.length >= memories.totalCount) return;
		memories.loadingPage = true;
		memories.loadError = false;
		refreshTree(model);
		/* A cursor, not an offset: the server pages over the memories git still
		   reaches, so a rebase mid-browse shortens that list and an offset would
		   step over whichever row moved onto the boundary — a gap the client
		   cannot even detect. "Continue after this exact memory" survives rows
		   appearing or vanishing on either side of it. */
		var last = items[items.length - 1];
		var query = JD.query(model, {});
		JD.getJson(
			"/api/memories" +
				(query ? query + "&" : "?") +
				"afterRepo=" +
				encodeURIComponent(last.repoIdentity) +
				"&afterHash=" +
				encodeURIComponent(last.commitHash),
		)
			.then((page) => {
				memories.loadingPage = false;
				/* An empty page while `items.length < totalCount` means those two
				   disagree — the total moved under us. Believe the page: there is
				   nothing after this cursor, so retire the footer rather than leave a
				   button that answers every click with nothing. */
				if (!page.items || !page.items.length) {
					memories.totalCount = items.length;
					refreshTree(model);
					return;
				}
				if (page.cursorMissing) {
					/* The memory we were paging from is gone (a rebase during the
					   session), so the server answered with the first page instead.
					   REPLACE rather than append: appending would re-add rows the dedupe
					   then drops, and the next click would send the same dead cursor
					   again — a button that does nothing forever. Re-seating on page 1
					   is exactly what a reload would give, and paging works from there. */
					memories.items = page.items;
				} else {
					/* Deduped even so: rows can shift under a commit landing between two
					   clicks, and a repeat is cheap to drop where a gap would be
					   invisible. */
					var seen = new Set(items.map((item) => item.repoIdentity + " " + item.commitHash));
					memories.items = items.concat(
						page.items.filter((item) => !seen.has(item.repoIdentity + " " + item.commitHash)),
					);
				}
				/* Adopted from the page, not left at the value the HTML was rendered
				   with: it is what the footer states and what decides whether there is
				   more to ask for, and a commit (or a rebase) moves it. */
				memories.totalCount = page.totalCount;
				refreshTree(model);
			})
			.catch(() => {
				/* Kept, not cleared: every page that did arrive stays usable, and the
				   footer turns into a retry instead of a dead end. */
				memories.loadingPage = false;
				memories.loadError = true;
				refreshTree(model);
			});
	}

	JD.renderMemories = (model) => {
		/* The 30s page tick calls this again. Rebuilding the whole page then
		   replaces the live #memSearch input, so a user mid-filter silently
		   loses focus and caret every 30 seconds (the text itself survives in
		   JD.memQuery). The toolbar's own comment already promised it is
		   "rendered once and left alone" — that held only for keystroke-driven
		   refreshTree, not for this path. So on a re-render into an existing
		   page, refresh the data regions and leave the toolbar in place. */
		var existingTree = document.getElementById("memTree");
		if (existingTree && document.getElementById("memSearch")) {
			existingTree.innerHTML = renderTreeBody(model);
			var detail = document.getElementById("memDetail");
			if (detail) detail.innerHTML = '<div class="mem-read-inner">' + renderDetail(model) + "</div>";
			wireTree(model);
			wireDetail(model);
				return;
		}
		document.getElementById("app").innerHTML =
			'<section class="memories-page"><aside class="mem-navigator" aria-label="Memory browser">' +
			renderToolbar(model) +
			'<div class="mem-tree" id="memTree">' +
			renderTreeBody(model) +
			'</div></aside><article class="mem-detail" id="memDetail" aria-label="Memory detail"><div class="mem-read-inner">' +
			renderDetail(model) +
			"</div></article></section>";
		wireToolbar(model);
		wireTree(model);
		wireDetail(model);
	};
})(window.JD);
