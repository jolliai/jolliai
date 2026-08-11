window.JD = window.JD || {};

((JD) => {
	/**
	 * Repositories — the nav's last row, under Memories; never gated. Lists repos
	 * already registered (server-rendered `model.repositories.repos`) and manages
	 * each one: Pause / Resume, or jump to its dashboard. v1 does not release
	 * ADDING a repo from here — `jolli enable` (run inside the target repo) is the
	 * v1 way; it lands in `dashboard-repos.json`, which is what populates this
	 * list. (A folder-browser add flow used to live here behind a hidden button;
	 * it was removed along with its `/api/browse` + `Browse.ts` backend when the
	 * Settings folder picker became a validated text input. The `/api/repo-probe`
	 * and `/api/repos/enable` endpoints still exist and are tested, so re-adding
	 * an "add from here" UI means rebuilding the front end against them.)
	 *
	 * Nothing here starts a backfill. Pause/resume are single POSTs that finish
	 * within the request, so this page polls no job and shows no generation
	 * progress — summarizing existing commits is the CLI's job (see
	 * `DashboardServer.ts`'s header).
	 */

	var state = {
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

		html += renderCard(repos);
		if (repos.length) html += renderAddedList(repos);
		document.getElementById("app").innerHTML =
			'<section class="card"><div class="card-head"><div><h2>Repositories</h2><div class="sub">' +
			"Which repos this server records, and where its memory comes from.</div></div></div>" +
			html +
			"</section>";
		wire(model);
	}

	function renderCard(repos) {
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
