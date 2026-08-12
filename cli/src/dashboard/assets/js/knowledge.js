window.JD = window.JD || {};

((JD) => {
	/**
	 * Knowledge — the Memory Bank `_wiki` browser. Two panes: a searchable,
	 * per-repo file list (left) and the selected page rendered as markdown (right).
	 *
	 * The list comes from `model.knowledge.repos` (read off disk by the server, not
	 * the DB). A page's body is NOT in the model — clicking a file points the right
	 * pane's iframe at `/wiki-viewer?kb=…&file=…`, which renders it with the
	 * vendored `marked`. That iframe is `sandbox="allow-scripts"` WITHOUT
	 * `allow-same-origin`, so any HTML the wiki markdown produces runs in an opaque
	 * origin and cannot reach this page's mutation token — the isolation the whole
	 * split-document design exists for.
	 *
	 * `kb` is the Memory Bank folder's directory name (server resolves it back to a
	 * path via `discoverRepos`), NOT a dashboard `repoIdentity`.
	 */

	var state = { query: "", selected: null, collapsed: {} };

	var CHEVRON = '<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></span>';

	// Inline "graph" glyph (Lucide network) for the per-repo link — an icon, not text.
	var GRAPH_ICON =
		'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" ' +
		'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/>' +
		'<rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4"/><path d="M5 16v-2h14v2"/></svg>';

	function allRepos(model) {
		return (model.knowledge && model.knowledge.repos) || [];
	}

	/** Repos with their files narrowed by the search box (case-insensitive on title). */
	function matchedGroups(model) {
		var q = state.query.trim().toLowerCase();
		return allRepos(model)
			.map((r) => ({ repo: r, files: q ? r.files.filter((f) => f.title.toLowerCase().indexOf(q) >= 0) : r.files }))
			.filter((g) => !q || g.files.length > 0);
	}

	function listHtml(model) {
		var esc = JD.esc;
		if (!allRepos(model).length) {
			return (
				'<div class="empty"><div class="inner"><div class="chip">◆</div><h2>No knowledge yet</h2>' +
				"<p>Knowledge pages are generated from your commits. Run <code>jolli compile</code> in a repository " +
				"with a Memory Bank folder, and its wiki appears here.</p></div></div>"
			);
		}
		var groups = matchedGroups(model);
		if (!groups.length) {
			return '<div class="kn-empty">No pages match “' + esc(state.query) + "”.</div>";
		}
		return groups
			.map((g) => {
				var r = g.repo;
				var graphLink = r.graphAvailable
					? '<a class="kn-graph-link" title="Open graph" aria-label="Open graph" href="/graph?kb=' +
						encodeURIComponent(r.kb) +
						'">' +
						GRAPH_ICON +
						"</a>"
					: '<span class="kn-graph-link disabled" title="No graph yet — run jolli compile" aria-label="No graph">' +
						GRAPH_ICON +
						"</span>";
				// While searching, groups render expanded so matches are visible;
				// otherwise the per-repo collapse state (click the head) applies.
				var collapsed = state.query.trim() ? false : !!state.collapsed[r.kb];
				var rows = g.files.length
					? g.files
							.map((f) => {
								var sel = state.selected && state.selected.kb === r.kb && state.selected.file === f.file;
								return (
									'<button type="button" class="kn-row' +
									(sel ? " active" : "") +
									'" data-kb="' +
									esc(r.kb) +
									'" data-file="' +
									esc(f.file) +
									'">' +
									esc(f.title) +
									"</button>"
								);
							})
							.join("")
					: '<div class="kn-empty">No pages yet.</div>';
				return (
					'<div class="kn-group"><div class="kn-group-head" data-kb="' +
					esc(r.kb) +
					'" role="button" tabindex="0" aria-expanded="' +
					String(!collapsed) +
					'">' +
					CHEVRON +
					'<span class="kn-repo" title="' +
					esc(r.repoName) +
					'">' +
					esc(r.repoName) +
					"</span>" +
					graphLink +
					"</div>" +
					(collapsed ? "" : rows) +
					"</div>"
				);
			})
			.join("");
	}

	function detailHtml(sel) {
		if (!sel) return '<div class="kn-placeholder">Select a page to read it.</div>';
		return (
			'<iframe class="kn-frame" sandbox="allow-scripts" title="Wiki page" src="/wiki-viewer?kb=' +
			encodeURIComponent(sel.kb) +
			"&file=" +
			encodeURIComponent(sel.file) +
			'"></iframe>'
		);
	}

	function redrawList(model) {
		var list = document.getElementById("knList");
		if (list) list.innerHTML = listHtml(model);
		wireList(model);
	}

	function wireList(model) {
		Array.prototype.forEach.call(document.querySelectorAll("#knList .kn-row"), (btn) => {
			btn.onclick = () => {
				state.selected = { kb: btn.getAttribute("data-kb"), file: btn.getAttribute("data-file") };
				var detail = document.getElementById("knDetail");
				if (detail) detail.innerHTML = detailHtml(state.selected);
				redrawList(model);
			};
		});
		Array.prototype.forEach.call(document.querySelectorAll("#knList .kn-group-head"), (head) => {
			var toggle = (e) => {
				// A click on the graph link navigates — never collapse in that case.
				if (e && e.target && e.target.closest && e.target.closest(".kn-graph-link")) return;
				var kb = head.getAttribute("data-kb");
				if (state.collapsed[kb]) delete state.collapsed[kb];
				else state.collapsed[kb] = true;
				redrawList(model);
			};
			head.onclick = toggle;
			head.onkeydown = (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					toggle(e);
				}
			};
		});
	}

	function render(model) {
		var esc = JD.esc;
		document.getElementById("app").innerHTML =
			'<section class="knowledge-page">' +
			'<div class="kn-side">' +
			'<input id="knSearch" class="kn-search" type="search" placeholder="Search pages…" value="' +
			esc(state.query) +
			'" />' +
			'<div id="knList" class="kn-list"></div>' +
			"</div>" +
			'<div id="knDetail" class="kn-detail"></div>' +
			"</section>";
		document.getElementById("knList").innerHTML = listHtml(model);
		document.getElementById("knDetail").innerHTML = detailHtml(state.selected);
		var search = document.getElementById("knSearch");
		search.oninput = () => {
			state.query = search.value;
			redrawList(model);
		};
		wireList(model);
	}

	JD.renderKnowledge = (model) => render(model);
})(window.JD);
