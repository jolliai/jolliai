(() => {
	/* Per-view renderer, and whether it wants the 12-column card grid. Standup
	   is the mockup's three-column board and supplies its own `.cols` grid, so
	   it must not sit inside another one. */
	var VIEWS = {
		stats: { render: (model) => window.JD.renderStats(model), grid: true },
		standup: { render: (model) => window.JD.renderStandup(model), grid: false },
		memories: { render: (model) => window.JD.renderMemories(model), grid: false },
		knowledge: { render: (model) => window.JD.renderKnowledge(model), grid: false },
		graph: { render: (model) => window.JD.renderGraph(model), grid: false },
		// Settings has no page entry — it opens as a modal over the current page
		// (JD.openSettings, wired to the pinned bottom nav row in shell.js).
	};

	function render(model) {
		window.JD.renderShell(model);
		var view = VIEWS[model.view] || VIEWS.stats;
		document.getElementById("app").className = view.grid ? "grid" : "";
		view.render(model);
	}
	window.JD.renderPage = render;
	var model = window.__JOLLI_DASHBOARD__;
	if (model) {
		render(model);
		window.JD.startRefresh(render);
		/* Fire once per browser SESSION — nav is a full page reload, so a naive
		   call would re-fire on every page. `first_run` is the first-ever open in
		   this browser profile: a content-free proxy for a fresh install. */
		try {
			if (window.JD.track && !sessionStorage.getItem("jdOpened")) {
				sessionStorage.setItem("jdOpened", "1");
				var everOpened = !!localStorage.getItem("jdEverOpened");
				localStorage.setItem("jdEverOpened", "1");
				window.JD.track("dashboard_opened", { first_run: !everOpened });
			}
		} catch (e) {
			/* storage blocked (private mode) — skip; telemetry never breaks boot */
		}
	}
})();
