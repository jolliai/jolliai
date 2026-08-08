window.JD = window.JD || {};

((JD) => {
	/**
	 * Repositories — the nav's last row, under Memories; never gated. Manages repos
	 * already registered (server-rendered `model.repositories.repos`); v1
	 * does not release adding one from here — same scope call as Knowledge/
	 * Graph/Settings' hidden nav rows, not an incompleteness signal. `jolli
	 * enable` (run inside the target repo) is the v1 way to add one; it lands
	 * in `dashboard-repos.json`, which is exactly what populates this list.
	 *
	 * The folder-browser add flow below (`renderBrowser`/`renderPendingCard`/
	 * `pickFolder`/`enable`) is dead code with the button gone — kept rather
	 * than deleted so re-adding the button is the entire unhide, no rebuild of
	 * the flow needed.
	 *
	 * Nothing here starts a backfill. Enable/pause/resume are single POSTs that
	 * finish within the request, so this page polls no job and shows no
	 * generation progress — summarizing existing commits is the CLI's job (see
	 * `DashboardServer.ts`'s header).
	 */

	var state = {
		browsing: false,
		browsePath: null,
		browseEntries: null,
		browseError: null,
		pending: null, // { path, probe }
		enableState: "idle", // idle | running | done | error
		enableError: null,
		error: null,
		busyRepo: null, // repoIdentity mid pause/resume
	};

	function render(model) {
		var esc = JD.esc;
		var repos = (model.repositories && model.repositories.repos) || [];
		var html = "";

		if (state.error) {
			html += '<div class="callout" style="margin-bottom:12px">' + esc(state.error) + "</div>";
		}

		html += renderCard(model, repos);
		if (repos.length) html += renderAddedList(repos);
		document.getElementById("app").innerHTML =
			'<section class="card"><div class="card-head"><div><h2>Repositories</h2><div class="sub">' +
			"Which repos this server records, and where its memory comes from.</div></div></div>" +
			html +
			"</section>";
		wire(model);
	}

	function renderCard(model, repos) {
		if (state.browsing) return renderBrowser();
		if (state.pending) return renderPendingCard(model, state.pending);
		if (!repos.length) {
			return (
				'<div class="empty"><div class="inner"><div class="chip">◆</div>' +
				"<h2>No repositories yet</h2><p>Jolli attaches memory to your commits. Run <code>jolli enable</code> " +
				"inside the repository you want to start with — it appears here once enabled.</p>" +
				"</div></div>"
			);
		}
		return "";
	}

	function renderBrowser() {
		var esc = JD.esc;
		if (state.browseError) {
			return (
				'<div class="callout">' +
				esc(state.browseError) +
				'</div><div class="cardact" style="margin-top:10px"><button type="button" class="cta ghost" id="btnCancelBrowse">Cancel</button></div>'
			);
		}
		var entries = state.browseEntries || [];
		var rows = entries
			.map(
				(e) =>
					'<div class="item" data-dir="' +
					esc(e.name) +
					'"' +
					(e.isGitRepo ? ' data-repo="1"' : "") +
					' role="button" tabindex="0"><div class="r1"><span class="glyph">' +
					(e.isGitRepo ? "◆" : "▸") +
					"</span><span class=\"t\">" +
					esc(e.name) +
					"</span>" +
					(e.isGitRepo ? '<span class="tag outc">git repo</span>' : "") +
					"</div></div>",
			)
			.join("");
		return (
			'<div class="gd-row mono">' +
			esc(state.browsePath || "") +
			"</div>" +
			'<div class="cardact" style="margin:6px 0"><button type="button" class="cta ghost sm" id="btnBrowseUp">↑ Up</button></div>' +
			'<div class="col-list">' +
			(rows || '<p class="empty-note">No subfolders here.</p>') +
			"</div>" +
			'<div class="cardact" style="margin-top:10px"><button type="button" class="cta ghost" id="btnCancelBrowse">Cancel</button></div>'
		);
	}

	function renderPendingCard(model, pending) {
		var esc = JD.esc;
		var probe = pending.probe;
		if (!probe) return '<div class="empty-note">Loading…</div>';
		if (!probe.isGitRepo) {
			return (
				'<div class="callout">That folder is not a git repository, so there is no history to attach ' +
				'memory to.</div><div class="cardact" style="margin-top:10px"><button type="button" class="cta ghost" id="btnAddRepo">Pick another folder</button></div>'
			);
		}
		if (probe.alreadyAdded) {
			return (
				'<div class="callout">' +
				esc(probe.name || pending.path) +
				" is already added.</div>" +
				'<div class="cardact" style="margin-top:10px"><button type="button" class="cta ghost" id="btnAddRepo">Pick another folder</button></div>'
			);
		}

		if (state.enableState === "running" || state.enableState === "done" || state.enableState === "error") {
			return renderEnableReceipt(probe.name, state.enableState, state.enableError);
		}

		var withoutMemory = probe.withoutMemoryYet || 0;
		return (
			'<div class="rh"><div class="g"><div class="nm">' +
			esc(probe.name || pending.path) +
			"</div>" +
			'<div class="where mono">' +
			esc(pending.path) +
			(probe.branch ? " on " + esc(probe.branch) : "") +
			(probe.remote ? " · " + esc(probe.remote) : "") +
			"</div>" +
			'<div class="where plain">' +
			(probe.commits || 0) +
			" commits, " +
			withoutMemory +
			" without a memory yet</div></div>" +
			'<div class="acts"><button type="button" class="cta ghost sm" id="btnAddRepo">Change</button></div></div>' +
			/* No backfill option here on purpose: summarizing existing commits is a
			   real model call per commit, so it stays an explicit CLI action
			   (`jolli backfill`) rather than something a browser tab can start. */
			'<div class="footnote" style="margin-top:14px">Enabling records commits from now on. To summarize the ' +
			withoutMemory +
			" commits already behind you, run <code>jolli backfill</code> in the repo — each one is a real model " +
			"call, so it stays a deliberate step.</div>" +
			'<div class="footnote">Enabling installs four local hooks and a memory branch in ' +
			esc(probe.name || pending.path) +
			". All data stays local to this machine except what is sent to your chosen summarizer.</div>" +
			'<div class="cardact" style="margin-top:14px"><button type="button" class="cta" id="btnEnable">Enable</button></div>'
		);
	}

	/* Enable is one POST that installs hooks and registers the repo, so its
	   receipt has three states and no progress: nothing long-running is started
	   from here any more. */
	function renderEnableReceipt(repoName, kind, error) {
		var esc = JD.esc;
		if (kind === "error") {
			return (
				'<div class="callout">Enabling ' +
				esc(repoName || "") +
				" failed: " +
				esc(error || "unknown error") +
				"</div>" +
				'<div class="cardact" style="margin-top:10px"><button type="button" class="cta ghost" id="btnAddRepo">Try again</button></div>'
			);
		}
		if (kind === "done") {
			return (
				'<div class="cardact"><span class="okmark">✓</span>&nbsp;Recording ' +
				esc(repoName || "") +
				'.</div><div class="cardact" style="margin-top:10px">' +
				'<button type="button" class="cta" id="btnDone">Done</button></div>'
			);
		}
		return (
			'<div class="cardact"><span class="spin">↻</span>&nbsp;Enabling</div>' +
			'<div class="gd-row" aria-live="polite">Installing hooks in ' +
			esc(repoName || "") +
			"…</div>"
		);
	}

	function renderAddedList(repos) {
		var esc = JD.esc;
		return (
			'<div class="col-list" style="margin-top:16px">' +
			repos
				.map((r) => {
					var busy = state.busyRepo === r.repoIdentity;
					var badge = r.enabled
						? r.memories > 0
							? '<span class="tag outc">' + r.memories + " memories</span>"
							: '<span class="tag">No history yet</span>'
						: '<span class="tag">Paused</span>';
					/* A repo that already has memory has nothing left for this row to
					   manage — it already reads real activity, so the row collapses to
					   the one action that matters (go look at it). Pause is a setup-phase
					   action that only makes sense before that point. Filling in history
					   is not an action here at all: backfill runs from the CLI. */
					var actions = busy
						? '<span class="tag">Working…</span>'
						: r.enabled && r.memories > 0
							? '<button type="button" class="cta ghost sm" data-action="dashboard" data-repo="' +
								esc(r.repoIdentity) +
								'">Go to dashboard</button>'
							: r.enabled
								? '<button type="button" class="cta ghost sm" data-action="disable" data-repo="' +
									esc(r.repoIdentity) +
									'">Pause</button>'
								: '<button type="button" class="cta ghost sm" data-action="resume" data-repo="' +
									esc(r.repoIdentity) +
									'">Resume</button>';
					return (
						'<div class="item"><div class="r1"><span class="t">' +
						esc(r.repoName) +
						"</span>" +
						badge +
						'<span class="when">' +
						actions +
						"</span></div>" +
						'<div class="meta">' +
						(r.remoteUrl ? '<span class="tag mono">' + esc(r.remoteUrl) + "</span>" : "") +
						'<span class="tag mono">' +
						esc(r.worktreeRoot) +
						"</span></div></div>"
					);
				})
				.join("") +
			"</div>"
		);
	}

	// ── Actions ────────────────────────────────────────────────────────────

	function openBrowser(model, path) {
		state.browsing = true;
		state.browseError = null;
		render(model);
		JD.getJson("/api/browse" + (path ? "?path=" + encodeURIComponent(path) : ""))
			.then((res) => {
				state.browsePath = res.path;
				state.browseEntries = res.entries;
				render(model);
			})
			.catch((err) => {
				state.browseError = err.message;
				render(model);
			});
	}

	function pickFolder(model, name) {
		var path = (state.browsePath || "").replace(/\/$/, "") + "/" + name;
		state.browsing = false;
		state.pending = { path: path, probe: null };
		state.enableState = "idle";
		render(model);
		JD.getJson("/api/repo-probe?path=" + encodeURIComponent(path))
			.then((probe) => {
				state.pending.probe = probe;
				render(model);
			})
			.catch((err) => {
				state.error = err.message;
				state.pending = null;
				render(model);
			});
	}

	function enable(model) {
		if (!state.pending || !state.pending.probe) return;
		state.enableState = "running";
		state.enableError = null;
		render(model);
		JD.post("/api/repos/enable", { path: state.pending.path })
			.then(() => {
				state.enableState = "done";
				render(model);
			})
			.catch((err) => {
				state.enableState = "error";
				state.enableError = err.message;
				render(model);
			});
	}

	function repoAction(model, action, repoIdentity) {
		state.busyRepo = repoIdentity;
		render(model);
		JD.post(action === "disable" ? "/api/repos/disable" : "/api/repos/resume", { repoIdentity: repoIdentity })
			.then(() => {
				state.busyRepo = null;
				JD.refreshNow(JD.renderPage);
			})
			.catch((err) => {
				state.busyRepo = null;
				state.error = err.message;
				render(model);
			});
	}

	function wire(model) {
		var byId = (id) => document.getElementById(id);
		if (byId("btnAddRepo")) {
			byId("btnAddRepo").onclick = () => {
				state.pending = null;
				state.error = null;
				openBrowser(model, null);
			};
		}
		if (byId("btnCancelBrowse")) byId("btnCancelBrowse").onclick = () => {
			state.browsing = false;
			render(model);
		};
		if (byId("btnBrowseUp")) byId("btnBrowseUp").onclick = () => openBrowser(model, (state.browsePath || "") + "/..");
		if (byId("btnEnable")) byId("btnEnable").onclick = () => enable(model);
		if (byId("btnDone")) byId("btnDone").onclick = () => {
			state.pending = null;
			state.enableState = "idle";
			JD.refreshNow(JD.renderPage);
		};
		Array.prototype.forEach.call(document.querySelectorAll("#app .item[data-dir]"), (row) => {
			row.onclick = () => {
				if (row.getAttribute("data-repo") === "1") pickFolder(model, row.getAttribute("data-dir"));
			};
		});
		Array.prototype.forEach.call(document.querySelectorAll("#app [data-action]"), (btn) => {
			btn.onclick = () => {
				var action = btn.getAttribute("data-action");
				var repoIdentity = btn.getAttribute("data-repo");
				if (action === "dashboard") {
					window.location.href = JD.viewPath("stats") + JD.query(model, { repo: repoIdentity });
					return;
				}
				repoAction(model, action, repoIdentity);
			};
		});
	}

	JD.renderRepositories = (model) => render(model);
})(window.JD);
