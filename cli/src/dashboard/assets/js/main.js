(() => {
	/* Per-view renderer, and whether it wants the 12-column card grid. Standup
	   is the mockup's three-column board and supplies its own `.cols` grid, so
	   it must not sit inside another one. */
	var VIEWS = {
		stats: { render: (model) => window.JD.renderStats(model), grid: true },
		standup: { render: (model) => window.JD.renderStandup(model), grid: false },
		repositories: { render: (model) => window.JD.renderRepositories(model), grid: false },
		memories: { render: (model) => window.JD.renderMemories(model), grid: false },
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
	}
})();
