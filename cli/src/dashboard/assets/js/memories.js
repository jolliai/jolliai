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
	/* The hash we last scrolled the tree to. Landing on /memories?hash=… should
	   bring the selected row into view (centered), but the 30s tick re-renders the
	   same page — scrolling every tick would yank the view back while the user
	   reads. So we scroll only when the selected hash CHANGES. Reset to null on
	   each page load (a fresh module), which is exactly when we DO want to scroll. */
	JD.memLastScrolledHash = JD.memLastScrolledHash || null;
	/* Same one-shot rule as the hash above, for the `#what-changed` anchor the
	   Memory Activity card links at. The browser cannot honour it itself: the
	   detail pane is written into the DOM after navigation, so by the time the
	   element exists the automatic scroll has already happened and been lost. */
	JD.memLastScrolledAnchor = JD.memLastScrolledAnchor || null;

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
				/* `detailRepo`, never `repo`: the owning repo says which memory to
				   open, and `repo` is the PAGE scope — carrying it here collapsed the
				   tree to that one repository on every click, so opening a memory cost
				   the reader every other repo's memories. Whatever scope the page
				   already has rides along through JD.query untouched. */
				window.location.href =
					"/memories" +
					JD.withParams(JD.query(model, {}), {
						hash: hash,
						detailRepo: JD.repoToken(model, repo),
					});
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

	/* Center the selected memory's row in the tree when the selection changes —
	   the landing case for /memories?hash=…&detailRepo=… (e.g. a click from the
	   wiki viewer), where the row is often scrolled out of view. Guarded by
	   memLastScrolledHash so the 30s tick does not fight the user's own scrolling.
	   Only reached from renderMemories, never from refreshTree (collapse toggles /
	   load-more must not reposition the tree). No-op when the row isn't loaded. */
	function scrollSelectedIntoView(model) {
		var detail = model.memories && model.memories.selected;
		var hash = detail ? detail.commitHash : null;
		if (!hash || hash === JD.memLastScrolledHash) return;
		JD.memLastScrolledHash = hash;
		// The tree marks selection by commit hash ALONE, so when the same hash exists
		// in two repos (a cherry-pick) BOTH rows carry aria-current. Center the row
		// whose repo actually OWNS this detail (matched on repoIdentity), not just the
		// first — otherwise the scroll can land on the other repo's row while the
		// detail pane shows this one. Match by data-repo (each row carries it); fall
		// back to the first selected row if none matches (should not happen).
		var selected = document.querySelectorAll('#memTree [aria-current="true"]');
		var row = null;
		for (var i = 0; i < selected.length; i++) {
			if (selected[i].getAttribute("data-repo") === detail.repoIdentity) {
				row = selected[i];
				break;
			}
		}
		if (!row) row = selected[0];
		if (row && row.scrollIntoView) row.scrollIntoView({ block: "center" });
	}

	/* Scrolls to `location.hash` once the element it names actually exists.
	   NOT recorded when the element is missing — the detail pane may still be
	   rendering, or this tick may be showing a different memory, and recording it
	   would burn the one chance to honour the anchor. Recorded on success, so the
	   30s tick cannot keep yanking a reader back to it. */
	function scrollToAnchor() {
		/* `window` is whatever the host injected into this IIFE, so `location` is
		   read defensively — the same reason every DOM touch below is guarded. It
		   always exists in a browser; a host without it must not take the whole
		   page down on the way to an optional scroll. */
		var anchor = ((window.location && window.location.hash) || "").slice(1);
		if (!anchor || anchor === JD.memLastScrolledAnchor) return;
		var target = document.getElementById(anchor);
		if (!target) return;
		JD.memLastScrolledAnchor = anchor;
		if (target.scrollIntoView) target.scrollIntoView({ block: "start" });
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
		/* Headline and bar have DIFFERENT denominators, matching the editor's meter:
		   `total` counts every node's reported usage, while the bar's three widths
		   must fill it exactly, so they divide by the segments' own sum. Dividing
		   the widths by `total` underfills the bar whenever a folded session
		   reported a scalar count with no breakdown. */
		var total = tokens.total;
		var segTotal = tokens.input + tokens.output + tokens.cached;
		var esc = JD.esc;
		var seg = (n, color) =>
			segTotal > 0 ? '<i style="width:' + (n / segTotal) * 100 + '%;background:' + color + '"></i>' : "";
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
				/* The session id is this row's tooltip, and that is what it is in the
				   payload FOR — see MemoryConversationRow. Two conversations from the
				   same source render identically otherwise (same agent mark, and
				   titles that a first-user-message fallback can make near
				   duplicates), so a memory fed by three Claude sessions gave the user no
				   way to tell which row is which, nor to match one against
				   `sessions.json` or a log line. The whole attribute is omitted rather
				   than filled with a placeholder when the archive carries no id: an
				   absent tooltip says nothing, where `Session unknown` says something
				   false about the session.

				   That id is now load-bearing twice over: it is also what OPENS the row.
				   The archive key is `source:sessionId`, so a row without one cannot be
				   looked up and stays inert — the same rule a Context row applies to a
				   missing `contextKey`, and for the same reason: better a plain label
				   than a button that always 404s. There is no trailing "Open →" here
				   either; `.gd-row-open`'s hover state and `role="button"` are the
				   affordance, exactly as in the editor. */
				'<div class="gd-row' +
				(c.sessionId ? " gd-row-open" : "") +
				'"' +
				(c.sessionId
					? ' role="button" tabindex="0" data-session="' +
						esc(c.sessionId) +
						'" data-source="' +
						esc(c.source || "") +
						'" title="Session ' +
						esc(c.sessionId) +
						'"'
					: "") +
				">" +
				/* The row leads with the AGENT's brand mark rather than a generic
				   speech bubble — the same row VS Code's memory detail renders and
				   the same mark IntelliJ's Working Memory panel uses, so one
				   conversation looks like itself on all three surfaces. It also
				   replaces the `c.source` text that used to sit in the meta slot:
				   the mark says the same thing in space the title wants, and the
				   name survives as the mark's tooltip and accessible name. An agent
				   with no mark shipped falls back to its initial there. */
				JD.sourceBadge(c.source, "mem-row-icon") +
				'<span class="mem-row-title">' +
				esc(c.title || "(untitled)") +
				'</span><span class="mem-row-meta">' + c.messageCount + " msgs</span></div>",
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

	/* Per-kind row furniture, mirroring the editor's CONTEXT_ROW_KINDS table
	   (vscode/src/views/ContextRowKinds.ts) — same badge letters, same singular
	   labels. A kind the server adds later falls back to its own initial rather
	   than being mislabelled as one of these.

	   `reference`'s `R` is the FALLBACK letter only, for a row that arrived with
	   no source: a real reference is badged by its source instead
	   (`JD.contextBadge`), as the editor does. `label` is still this table's for
	   every kind — it titles the viewer dialog. */
	const CONTEXT_KIND_META = {
		plan: { letter: "P", label: "Plan" },
		note: { letter: "N", label: "Note" },
		reference: { letter: "R", label: "Reference" },
		skills: { letter: "S", label: "Skills" },
	};

	function contextKindMeta(kind) {
		return CONTEXT_KIND_META[kind] || { letter: (kind || "?").charAt(0).toUpperCase(), label: kind };
	}

	/* The Context section. Order, titles and the one-row skills aggregate all
	   come from the server (`buildContextRows`), which resolves them with the
	   same CLI helpers the editor's Context panel uses — so this renderer holds
	   layout only and cannot re-order or re-title anything.

	   Every row with a `contextKey` is openable: plan / note / reference bodies
	   are archived documents in the dashboard database, and the skills row's
	   table is rendered on demand from the summary. A row without one (a
	   reference whose source has left the registry) renders inert instead of as
	   a button that would always 404.

	   That openness is signalled by `.gd-row-open` alone — pointer cursor, accent
	   hover border, focus ring — and NOT by a trailing "Open →". The editor's
	   rows carry no such label either, and the text sat in the same slot the
	   reference `meta` line wants; the row is a `role="button"`, which is what
	   actually announces it. */
	function contextSection(detail) {
		var esc = JD.esc;
		var rows = detail.context.map((c) => {
			var meta = contextKindMeta(c.kind);
			var openable = !!c.contextKey;
			/* Scheme-checked, not just escaped: the url is a third party's string
			   carried in from an archived MCP reference, and an unnavigable one
			   renders as no link at all rather than as a dead glyph. Already
			   escaped for an attribute — interpolated raw below, never via `esc`. */
			var href = JD.safeHrefAttr(c.url);
			return (
				'<div class="gd-row' +
				(openable ? " gd-row-open" : "") +
				'"' +
				(openable
					? ' role="button" tabindex="0" data-context-kind="' +
						esc(c.kind) +
						'" data-context-key="' +
						esc(c.contextKey) +
						'"'
					: "") +
				">" +
				/* Badged by SOURCE for a reference, by kind for everything else —
				   `JD.contextBadge` owns that split, off the server-inlined
				   `SOURCE_META`. `meta.letter` is the kind letter it falls back to. */
				JD.contextBadge(c.kind, c.source, meta.letter) +
				/* Title and sub-line stack in one column, as the editor's `.r-main`
				   does. They shared a line before, which read well for a tracker's
				   `ENG-1234 (Linear)` and badly for the rest of what this slot
				   carries — `<slug>.md`, `<id>.md`, the skills totals — where the two
				   fought for width and one always ellipsised. */
				'<div class="mem-row-main"><span class="mem-row-title">' +
				esc(c.title) +
				"</span>" +
				(c.meta ? '<span class="mem-row-meta mem-ctx-sub">' + esc(c.meta) + "</span>" : "") +
				"</div>" +
				(href
					? '<a class="mem-ctx-link" href="' +
						href +
						'" target="_blank" rel="noreferrer noopener" title="Open upstream">' +
						memoryIcon("link") +
						"</a>"
					: "") +
				"</div>"
			);
		});
		var body = rows.length ? '<div class="gd-links">' + rows.join("") + "</div>" : '<div class="gd-empty">None.</div>';
		var excluded = detail.excluded.length
			? '<div class="gd-sec">Automatically set aside</div><div class="gd-links">' +
				detail.excluded
					.map((e) => '<div class="gd-row"><span>' + esc(e.title) + " — " + esc(e.reason) + "</span></div>")
					.join("") +
				"</div>"
			: "";
		return (
			'<section class="mem-section mem-context"><div class="gd-sec">' +
			memoryIcon("document") +
			"Context " +
			rows.length +
			"</div>" +
			body +
			excluded +
			"</section>"
		);
	}

	function topicsSection(detail) {
		var esc = JD.esc;
		if (!detail.topics.length) return "";
		/* The deep-link target for both cards that point into a memory's topics —
		   Memory Activity's "N decisions" chip and the Decisions card's Latest title.
		   It sits on the SECTION, so the reader lands on the "What changed and why"
		   header with the first topic below it.

		   It used to be a per-topic id on the first `.decide` block that carried a
		   decision, which put the reader mid-topic: `.decide` renders BELOW the
		   topic's own <h3> and its trigger prose, so aligning it to the top of the
		   pane scrolled past the heading naming the topic the decision belongs to.
		   Landing one level up costs a short scroll and keeps that context.

		   One fixed id rather than a per-topic one, because Memory Activity carries
		   a decision COUNT (`MemoryCard.decisionCount`) and no topic list at all —
		   it could never name a topic to aim at. */
		return (
			'<section class="mem-section mem-topics" id="what-changed"><div class="gd-sec">What changed and why</div><div class="mem-topic-list">' +
			detail.topics
				.map((t, index) => {
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
						'<article class="topic" id="topic-' +
						index +
						'"><div class="topic-head"><h3>' +
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
			// `mem-empty-pane` is what earns the centred 120px treatment — see the
			// rule in main.css. A section's own empty state must NOT carry it.
			return '<div class="gd-empty mem-empty-pane">Pick a memory on the left — this pane shows its full detail: conversations, context, and what it decided.</div>';
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
			detail.context.length +
			" context, " +
			detail.files.length +
			" files" +
			(detail.summarizedBy
				? " · Summary by " + esc(detail.summarizedBy.model || "an unreported model") + " · " + JD.fmtTokens(detail.summarizedBy.tokens) + " tokens to write it"
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
			/* `JM-…:` leads the title, as it does in the editor's page header — the
			   handle a reader cites, present on every memory (hash-derived until the
			   memory syncs to a Space). */
			'</span><div class="gd-title"><span class="mem-title-ref">' +
			esc(detail.memoryRefId) +
			":</span> " +
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
			contextSection(detail) +
			topicsSection(detail) +
			filesSection(detail) +
			e2eSection(detail) +
			"</div>"
		);
	}

	/* The Context viewer. One shared dialog for every plan/note on the page —
	   the body is loaded on click rather than shipped with the detail payload,
	   because a memory can carry several full markdown files the reader usually
	   never opens.

	   The body is a SANDBOXED frame onto /context-viewer, which renders the
	   markdown server-side with the vendored `marked`. It used to be raw source
	   in a <pre>, because the alternative on the table was injecting an
	   agent-written document into THIS document — which inlines the mutation
	   token. The frame is what makes rendering safe: no `allow-same-origin`, so
	   the rendered HTML sits in an opaque origin and cannot reach the token, the
	   model, or the DOM. Same arrangement as the Knowledge page's wiki frame.

	   Header text comes from the clicked ROW rather than from a second fetch —
	   the title is already in the detail payload, so asking the server again
	   would be a round trip for a string the page is holding. */
	function openContextDialog(detail, kind, key) {
		var overlay = document.getElementById("ovContext");
		var title = document.getElementById("ctxTitle");
		var sub = document.getElementById("ctxSub");
		var frame = document.getElementById("ctxFrame");
		if (!overlay || !title || !sub || !frame) return;
		var row = (detail.context || []).filter((c) => c.kind === kind && c.contextKey === key)[0];
		title.textContent = (row && row.title) || contextKindMeta(kind).label;
		sub.textContent = contextKindMeta(kind).label;
		frame.src =
			"/context-viewer?repo=" +
			encodeURIComponent(detail.repoIdentity) +
			"&kind=" +
			encodeURIComponent(kind) +
			"&key=" +
			encodeURIComponent(key) +
			"&theme=" +
			encodeURIComponent(JD.currentTheme());
		overlay.classList.add("open");
	}

	/* Closing resets the frame. Without it the previous document stays loaded and
	   is what the reader sees for the instant before the next one arrives —
	   briefly showing one memory's plan under another's title. */
	function closeContextDialog() {
		var overlay = document.getElementById("ovContext");
		var frame = document.getElementById("ctxFrame");
		if (overlay) overlay.classList.remove("open");
		if (frame) frame.src = "about:blank";
	}

	/* The framed document hands its upstream links up here: it is sandboxed, so a
	   click inside it can navigate nothing on its own (see CONTEXT_LINK_SCRIPT).

	   Two checks before `window.open`, and both are load-bearing. The SOURCE check
	   is what makes this different from the Knowledge page's equivalent handler —
	   that one's payload is a hex-validated commit hash going to a same-origin
	   path, while this one's is a URL going to `window.open`, so any frame on the
	   page (or an embedder) could otherwise aim it. The SCHEME check is
	   `JD.safeHref`'s, since the href came out of a document an agent wrote.
	   Registered once, remove-then-add, so repeated renders do not stack. */
	function wireContextNav() {
		if (JD._ctxNavHandler) window.removeEventListener("message", JD._ctxNavHandler);
		JD._ctxNavHandler = function (ev) {
			var d = ev && ev.data;
			if (!d || d.type !== "jolli-context-nav" || typeof d.href !== "string") return;
			var frame = document.getElementById("ctxFrame");
			if (!frame || !ev.source || ev.source !== frame.contentWindow) return;
			if (!JD.safeHref(d.href)) return;
			/* Parsed and re-serialised here, INLINE, rather than opening the string
			   `JD.safeHref` just approved.

			   Two reasons, and the second is why the apparent duplication stays.
			   First, it is a real second gate on the one irreversible step in this
			   path: `d.href` arrives over postMessage from a document an agent wrote,
			   and `new URL` decides the scheme the way the navigation itself will,
			   rather than by matching the string. Opening `u.href` — the parser's own
			   output — also means no spelling the parser normalises away can reach
			   `window.open`.
			   Second, CodeQL flagged this sink (`js/client-side-unvalidated-url-redirect`)
			   with `JD.safeHref` already in front of it, and was right to: that
			   function is assigned onto the global `JD` object in another asset file,
			   so no static analysis can tie the call to its allowlist. A sanitizer the
			   scanner cannot see is one a future reader cannot rely on either. Keep
			   this check inline and literal; moving it into a helper re-opens the
			   finding even though the runtime behaviour would be identical.

			   http/https only, which is NARROWER than `JD.safeHref` (it also allows
			   `mailto:`) and deliberately matches the frame side: CONTEXT_LINK_SCRIPT
			   only bridges `^https?:` anchors and strips every other scheme to a
			   plain span, so nothing else can arrive here in the first place. The two
			   allowlists are one decision spelled in two places, and this is the one
			   that guards the navigation. */
			var u;
			try {
				u = new URL(d.href, window.location.origin);
			} catch {
				return;
			}
			if (u.protocol !== "https:" && u.protocol !== "http:") return;
			window.open(u.href, "_blank", "noreferrer");
		};
		window.addEventListener("message", JD._ctxNavHandler);
	}

	/* The Conversation viewer — the browser's read-only counterpart to the
	   editor's ConversationDetailsPanel, which is likewise forced read-only when
	   opened from a memory (an archived slice has no live cursor to edit against).
	   So: no edit, no delete, no detach; the same three affordances the editor
	   withholds there.

	   Every turn's body is set with `textContent`, matching that panel exactly.
	   A transcript is not markdown — rendering it would invent structure the
	   agent never wrote — which is also why this needs no sandboxed frame, unlike
	   the Context viewer above. */
	function roleLabel(role) {
		return role === "human" ? "You" : "Assistant";
	}

	function conversationTime(iso, timeZone) {
		if (!iso) return "";
		var ms = Date.parse(iso);
		return Number.isNaN(ms) ? "" : JD.weekdayDate(ms, timeZone);
	}

	function renderConversationEntries(doc, timeZone) {
		var body = document.getElementById("convBody");
		if (!body) return;
		body.replaceChildren();
		if (!doc.entries.length) {
			var empty = document.createElement("div");
			empty.className = "gd-empty";
			// The editor's exact string, so the same archive reads the same either way.
			empty.textContent = "No conversation entries to display.";
			body.appendChild(empty);
			return;
		}
		doc.entries.forEach((entry) => {
			var row = document.createElement("div");
			row.className = "conv-entry";
			row.setAttribute("data-role", entry.role);

			var head = document.createElement("div");
			head.className = "conv-entry-head";
			var role = document.createElement("span");
			role.className = "conv-role";
			role.textContent = roleLabel(entry.role);
			head.appendChild(role);
			var time = document.createElement("span");
			time.className = "conv-time";
			time.textContent = conversationTime(entry.timestamp, timeZone);
			head.appendChild(time);
			row.appendChild(head);

			var text = document.createElement("div");
			text.className = "conv-text";
			text.textContent = entry.content;
			row.appendChild(text);
			body.appendChild(row);
		});
		if (doc.truncated) {
			/* Said out loud, never silent: the server caps a very long conversation
			   and a prefix shown without a word reads as the whole thing.

			   TWO independent caps, and the sentence has to name the one that bit.
			   CONVERSATION_ENTRY_LIMIT drops whole turns; CONVERSATION_CONTENT_LIMIT
			   cuts the body of a single turn and leaves both counts intact. Phrasing
			   the second as the first announced "showing the first 12 of 12 turns" —
			   numbers that say nothing is missing — while the cut characters went
			   unmentioned, which is what a reader would actually have wanted to know.

			   `truncated` stays the gate rather than the wording: the server is what
			   knows whether anything was withheld, so a cap it grows later still
			   produces a note here even before this list learns to describe it. */
			var dropped = (doc.messageCount || 0) - doc.entries.length;
			var clipped = doc.clippedEntries || 0;
			var said = [];
			if (dropped > 0) {
				said.push("showing the first " + doc.entries.length + " of " + doc.messageCount + " turns");
			}
			if (clipped > 0) said.push(clipped === 1 ? "one turn's text cut short" : clipped + " turns' text cut short");
			var note = document.createElement("p");
			note.className = "conv-note";
			note.textContent = "Trimmed for this view" + (said.length ? ": " + said.join("; ") : "") + ".";
			body.appendChild(note);
		}
	}

	/* Which conversation the dialog is currently showing. One overlay serves every
	   row, so the fetch below has to prove it is still the one being awaited before
	   it writes: open A, open B, and A's slower response would otherwise land on
	   B's dialog — title, subtitle and every turn — with nothing on screen saying
	   the wrong conversation is being read. A counter rather than an
	   AbortController because the losing response is not worth cancelling, only
	   worth ignoring, and a closed-then-reopened dialog must invalidate the old
	   request too (which this does: every open takes a new number). */
	var convRequest = 0;

	function openConversationDialog(detail, source, sessionId, timeZone) {
		var overlay = document.getElementById("ovConversation");
		var title = document.getElementById("convTitle");
		var sub = document.getElementById("convSub");
		var body = document.getElementById("convBody");
		if (!overlay || !title || !sub || !body) return;
		var row = (detail.conversations || []).filter((c) => c.source === source && c.sessionId === sessionId)[0];
		var request = ++convRequest;
		title.textContent = (row && row.title) || "Conversation";
		sub.textContent = "Loading…";
		body.replaceChildren();
		overlay.classList.add("open");
		var url =
			"/api/conversation?repo=" +
			encodeURIComponent(detail.repoIdentity) +
			"&hash=" +
			encodeURIComponent(detail.commitHash) +
			"&source=" +
			encodeURIComponent(source) +
			"&session=" +
			encodeURIComponent(sessionId);
		fetch(url)
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
			.then((doc) => {
				if (request !== convRequest) return;
				title.textContent = doc.title || "Conversation";
				sub.textContent = JD.sourceLabel(doc.source) + " · " + doc.messageCount + " msgs";
				renderConversationEntries(doc, timeZone);
			})
			.catch((err) => {
				/* Guarded on the same terms as the success path, and for a sharper
				   reason: an abandoned request that 404s would otherwise paint its
				   failure over a conversation that loaded fine. */
				if (request !== convRequest) return;
				/* Never leave the dialog on "Loading…". The status is part of the
				   message on purpose: a dashboard started before this endpoint existed
				   answers the same 404 as a genuinely missing conversation, and
				   "restart" is the fix for one and not the other. */
				sub.textContent =
					"Could not load this conversation (" +
					(err && err.message ? "HTTP " + err.message : "request failed") +
					"). If the dashboard has been running a while, restart it — this viewer needs a current server.";
			});
	}

	function wireConversationRows(model) {
		var detail = model.memories && model.memories.selected;
		if (!detail) return;
		var overlay = document.getElementById("ovConversation");
		// Two buttons, one behaviour: the footer "Close" and the corner ✕.
		["convClose", "convDismiss"].forEach((id) => {
			var btn = document.getElementById(id);
			if (btn) btn.onclick = () => overlay.classList.remove("open");
		});
		if (overlay) {
			overlay.onclick = (e) => {
				if (e.target === overlay) overlay.classList.remove("open");
			};
		}
		document.querySelectorAll("[data-session]").forEach((row) => {
			var open = () =>
				openConversationDialog(
					detail,
					row.getAttribute("data-source"),
					row.getAttribute("data-session"),
					model.timeZone,
				);
			row.onclick = open;
			// Same keyboard contract as a Context row. No nested link to exempt here:
			// a conversation row has no upstream anchor, only the whole-row button.
			row.onkeydown = (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			};
		});
	}

	function wireContextRows(model) {
		var detail = model.memories && model.memories.selected;
		if (!detail) return;
		var overlay = document.getElementById("ovContext");
		// All three exits — footer "Close", corner ✕, backdrop — go through
		// closeContextDialog, which also blanks the frame. A bare
		// `classList.remove` would leave the last document loaded behind it.
		["ctxClose", "ctxDismiss"].forEach((id) => {
			var btn = document.getElementById(id);
			if (btn) btn.onclick = closeContextDialog;
		});
		if (overlay) {
			overlay.onclick = (e) => {
				if (e.target === overlay) closeContextDialog();
			};
		}
		wireContextNav();
		document.querySelectorAll("[data-context-key]").forEach((row) => {
			var open = () =>
				openContextDialog(detail, row.getAttribute("data-context-kind"), row.getAttribute("data-context-key"));
			/* The upstream-link glyph is a real navigation nested inside a row that
			   is itself a button; without this, activating it would ALSO open the
			   archived snapshot behind the new tab. Both handlers need the exemption,
			   but the keyboard one only for ENTER: that is an <a>'s own activation
			   key, and this row's `preventDefault()` would cancel the navigation and
			   show the dialog instead — the keyboard path is the one that has no
			   other way in.
			   SPACE is deliberately NOT exempted. It does not activate a link at all
			   (the browser scrolls the page), so exempting it traded a working
			   affordance for nothing: with the glyph focused, Space opened the dialog
			   before and would do neither afterwards. */
			var fromLink = (e) => !!(e && e.target && e.target.closest && e.target.closest(".mem-ctx-link"));
			row.onclick = (e) => {
				if (fromLink(e)) return;
				open();
			};
			row.onkeydown = (e) => {
				if (fromLink(e) && e.key === "Enter") return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			};
		});
	}

	function wireDetail(model) {
		wireContextRows(model);
		wireConversationRows(model);
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
				var pageItems = page.items || [];
				/* Checked BEFORE the empty-page branch below, and it must stay that
				   way: the two conditions overlap when the last reachable memory is
				   the one that vanished, and the flag is the more specific answer.
				   Falling into the empty-page branch there kept the dead rows on
				   screen and set the total to their count, so the tree went on
				   listing memories git can no longer reach with no way to notice. */
				if (page.cursorMissing) {
					/* The memory we were paging from is gone (a rebase during the
					   session), so the server answered with the first page instead.
					   REPLACE rather than append: appending would re-add rows the dedupe
					   then drops, and the next click would send the same dead cursor
					   again — a button that does nothing forever. Re-seating on page 1
					   is exactly what a reload would give, and paging works from there.
					   An EMPTY first page is the same answer, not a special case: the
					   scope has no reachable memories left, so the tree empties. */
					memories.items = pageItems;
					memories.totalCount = page.totalCount;
					refreshTree(model);
					return;
				}
				/* An empty page while `items.length < totalCount` means those two
				   disagree — the total moved under us. Believe the page: there is
				   nothing after this cursor, so retire the footer rather than leave a
				   button that answers every click with nothing. */
				if (!pageItems.length) {
					memories.totalCount = items.length;
					refreshTree(model);
					return;
				}
				/* Deduped: rows can shift under a commit landing between two clicks,
				   and a repeat is cheap to drop where a gap would be invisible. */
				var seen = new Set(items.map((item) => item.repoIdentity + " " + item.commitHash));
				memories.items = items.concat(
					pageItems.filter((item) => !seen.has(item.repoIdentity + " " + item.commitHash)),
				);
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
			scrollSelectedIntoView(model);
			scrollToAnchor();
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
		scrollSelectedIntoView(model);
		scrollToAnchor();
	};
})(window.JD);
