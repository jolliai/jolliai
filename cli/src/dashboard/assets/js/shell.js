window.JD = window.JD || {};

((JD) => {
	/* Query string carrying the current repo scope, range and series dimension.
	   Built in one place so navigation, the range control and the refresh loop
	   cannot drift on which params survive a click. */
	JD.query = (model, over) => {
		var o = over || {};
		var repo =
			"repo" in o ? o.repo : model.scope && model.scope.kind === "repo" ? model.scope.repoIdentity : undefined;
		var ranged = JD.ranged(model);
		var range = "range" in o ? o.range : ranged ? ranged.range : undefined;
		/* Falls back to the dimension the SERVER says it used, not to undefined.
		   `JD.dimension` is only ever set by a chip click, so before the first click
		   a deep-linked `?dimension=branch` was absent from every rebuilt URL and
		   the 30 s poll silently re-asked for the default — the chart axis changed
		   under the reader. */
		var served = model.stats && model.stats.seriesDimension;
		var dimension = "dimension" in o ? o.dimension : JD.dimension || served;
		/* Bounds ride along ONLY with range=custom, so switching to a preset drops
		   them in the same click rather than leaving a stale pair in the URL. */
		var from = "from" in o ? o.from : ranged ? ranged.rangeFrom : undefined;
		var to = "to" in o ? o.to : ranged ? ranged.rangeTo : undefined;
		var parts = [];
		if (repo) parts.push("repo=" + encodeURIComponent(JD.repoToken(model, repo)));
		/* Emitted whenever known — never "omitted because it equals the default".
		   Both omissions were wrong about what the default IS: the server's is
		   `month`/`model`, while this dropped `2w` and `model`, so a bookmarked
		   `?range=2w` silently became 30 days on the first rebuild of the URL. A
		   shorter query string is not worth a client-side copy of a server default. */
		if (range) parts.push("range=" + encodeURIComponent(range));
		if (range === "custom" && from && to) {
			parts.push("from=" + encodeURIComponent(from));
			parts.push("to=" + encodeURIComponent(to));
		}
		if (dimension) parts.push("dimension=" + encodeURIComponent(dimension));
		return parts.length > 0 ? "?" + parts.join("&") : "";
	};

	/* The view payload that carries a time window, whichever page this is. The
	   standup board is a fixed yesterday/today pair and deliberately has none,
	   which is what hides the range control there. */
	JD.ranged = (model) => model.stats || null;

	/* One page-level tooltip (#tip in index.html), positioned above-left of the
	   pointer and clamped to the viewport — ported from the mockup's showTip so a
	   hover readout on this page lands where it does there. Callers pass HTML they
	   have already escaped. */
	JD.showTip = (html, x, y) => {
		var tip = document.getElementById("tip");
		if (!tip) return;
		tip.innerHTML = html;
		tip.style.display = "block";
		var box = tip.getBoundingClientRect();
		tip.style.left = Math.min(x + 14, window.innerWidth - box.width - 10) + "px";
		tip.style.top = Math.max(8, y - box.height - 12) + "px";
	};

	JD.hideTip = () => {
		var tip = document.getElementById("tip");
		if (tip) tip.style.display = "none";
	};

	/* Shortest URL token that still names one repo unambiguously.
	   The server accepts a repo name as well as a full identity, so a link reads
	   `?repo=jolliai` rather than a URL-encoded remote. The name is only used when
	   exactly one repo carries it — with two same-named clones the identity is the
	   only honest token, and the server would refuse to guess anyway. */
	JD.repoToken = (model, identity) => {
		var options = (model && model.repos) || [];
		var mine = options.filter((r) => r.repoIdentity === identity)[0];
		if (!mine) return identity;
		var sameName = options.filter((r) => r.repoName === mine.repoName);
		return sameName.length === 1 ? mine.repoName : identity;
	};

	/* Append page-specific params to a `JD.query` result, picking `?` or `&` by
	   whether that result is already non-empty. One helper because getting the
	   separator wrong produces a URL that silently loses the page scope. */
	JD.withParams = (query, params) => {
		var parts = Object.keys(params)
			.filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
			.map((key) => key + "=" + encodeURIComponent(params[key]));
		if (parts.length === 0) return query;
		return (query ? query + "&" : "?") + parts.join("&");
	};

	/* Back-compat alias — some callers only care about the repo scope. */
	JD.scopeQuery = (scope) =>
		scope && scope.kind === "repo" && scope.repoIdentity ? "?repo=" + encodeURIComponent(scope.repoIdentity) : "";

	/** How often the whole page refetches its model. */
	var PAGE_REFRESH_MS = 30_000;

	/* Page title/subtitle per view — every view the server can render. Decisions
	   is retired: its view token, page and nav row are all gone (folded into
	   Memories' per-topic Decisions callout). */
	var DASHBOARDS = [
		{ view: "stats", label: "My Dashboard", sub: "individual · local" },
		{ view: "standup", label: "Daily Standup", sub: "sprint · local" },
		{ view: "repositories", label: "Repositories", sub: "enable · pause" },
		{ view: "memories", label: "Memories", sub: "browse · per-commit" },
		{ view: "settings", label: "Settings", sub: "agents · summary · memory bank" },
	];

	/* Canonical URL for a view token. `stats`/`standup` live at /dashboard(/standup)
	   under the new nav, not at their own name — everything else's path matches
	   its view token 1:1. One place this can diverge, so nav links, the range
	   control and the repo filter cannot disagree on where a view lives. */
	var VIEW_PATH = {
		stats: "/dashboard",
		standup: "/dashboard/standup",
		repositories: "/repositories",
		memories: "/memories",
		settings: "/settings",
	};
	JD.viewPath = (view) => VIEW_PATH[view] || "/" + view;

	/* The nav list:
	   Dashboard/Memories are gated until a repo is enabled (mirrors
	   DashboardServer's GATED_PATHS, so a disabled row and a 302 never
	   disagree); Repositories sits right under Memories, never gated — it is
	   the row that opens the gate, so it must stay reachable with zero repos.
	   Dashboard's two children render flat under a group label rather than
	   behind an expand/collapse toggle — that interaction is a later polish
	   pass, not a routing concern.

	   Knowledge, Graph and Settings have no nav row AND no route: v1 releases
	   none of the three, so DashboardServer's VIEW_PATHS omits them and a
	   direct visit 404s. Restoring one needs the server-side route, view token
	   and model payload back as well — a nav row on its own is not enough. */
	var NAV_MIDDLE = [
		{
			label: "Dashboard",
			gated: true,
			kids: [
				{ view: "stats", path: "/dashboard", label: "My Dashboard" },
				{ view: "standup", path: "/dashboard/standup", label: "Daily Standup" },
			],
		},
		{ view: "memories", path: "/memories", label: "Memories", gated: true },
		{ view: "repositories", path: "/repositories", label: "Repositories" },
	];
	/* Settings is pinned to the sidebar's bottom edge (its reserved slot), not in
	   the scrollable menu list — a persistent destination rather than the last
	   nav row. Never gated: agents/summary/privacy are meaningful with zero repos. */
	var NAV_BOTTOM = { view: "settings", path: "/settings", label: "Settings" };

	/* The sidebar uses the same compact Lucide-style outlines as the mockup.
	   Keeping the paths here makes the navigation self-contained and avoids a
	   dependency on an icon font at dashboard start-up. */
	var NAV_ICONS = {
		foldergit:
			'<path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3"/><circle cx="13" cy="12" r="2"/><path d="M18 19c-2.8 0-5-2.2-5-5v8"/><circle cx="20" cy="19" r="2"/>',
		dashboard:
			'<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
		database:
			'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
		chevron: '<path d="m6 9 6 6 6-6"/>',
		settings:
			'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
	};
	var navIcon = (name, extraClass) =>
		'<span class="sb-icon' +
		(extraClass ? " " + extraClass : "") +
		'"><svg viewBox="0 0 24 24" aria-hidden="true">' +
		NAV_ICONS[name] +
		"</svg></span>";
	var navIconFor = (view) =>
		({ repositories: "foldergit", stats: "dashboard", memories: "database", settings: "settings" })[view];

	/* Tier → the `data-tier` the stylesheet keys its chips and locked previews off. */
	var TIER_INDEX = { installed: 0, memory: 1, space: 2 };

	/* The one live `document`-level Escape handler for the range calendar.
	   renderShell runs on every page load, 30s auto-refresh tick, and local
	   re-render triggered anywhere in the app, so without tracking this across
	   calls a fresh listener would stack on `document` every time and never be
	   removed — an unbounded leak for the life of the tab. */
	var calendarKeydownHandler = null;
	/* The custom-range popover's in-progress selection, or null when it is closed.
	   Module scope, not a renderShell local: renderShell also runs on the 30 s
	   poll, so a local would be re-seeded from the server-backed range and the
	   half-picked window would vanish under the user mid-click. Its presence is
	   also what keeps the popover open across a refresh. */
	var calendarPending = null;

	JD.renderShell = (model) => {
		var esc = JD.esc;
		var current = DASHBOARDS.filter((d) => d.view === model.view)[0] || DASHBOARDS[0];

		document.title = "jolli — " + current.label;
		document.getElementById("jdRoot").setAttribute("data-tier", String(TIER_INDEX[model.tier] || 0));
		document.getElementById("pageTitle").textContent = current.label;
		document.getElementById("pageSub").textContent = current.sub;

		/* Sidebar — the nav list (plus an empty pinned bottom slot). `gateOpen`
		   mirrors DashboardServer's GATED_PATHS check: at least one enabled repo,
		   or the gated rows disable instead of dead-ending on a redirect. */
		var gateOpen = (model.repos || []).length > 0;
		var navRow = (item, active, disabled) =>
			'<button type="button" class="sb-item' +
			(item.child ? " child" : "") +
			'" data-nav-path="' +
			item.path +
			'" data-nav-view="' +
			(item.view || "") +
			'"' +
			(active ? ' aria-current="page"' : "") +
			(disabled ? ' aria-disabled="true" title="Available once a repository is enabled"' : "") +
			'>' +
			(item.child ? "" : navIcon(navIconFor(item.view))) +
			'<span class="name">' +
			esc(item.label) +
			"</span></button>";
		var nav = "";
		NAV_MIDDLE.forEach((item) => {
			var disabled = item.gated && !gateOpen;
			if (item.kids) {
				nav +=
				'<div class="sb-group-label">' +
				navIcon("dashboard") +
				'<span>' +
				esc(item.label) +
				"</span>" +
				navIcon("chevron", "sb-group-chevron") +
				"</div>";
				item.kids.forEach((kid) => {
					nav += navRow({ ...kid, child: true }, model.view === kid.view, disabled);
				});
				return;
			}
			nav += navRow(item, model.view === item.view, disabled);
		});
		document.getElementById("sbNav").innerHTML = nav;
		/* The bottom slot is pinned to the sidebar's bottom edge, outside the
		   scrollable menu list — that separate slot (rather than a trailing nav
		   row) is what makes it read as a persistent destination instead of the
		   last item in a list. It holds Settings (`NAV_BOTTOM`); if that were ever
		   nulled the slot hides itself rather than rendering border/padding around
		   nothing. */
		var sbBottom = document.getElementById("sbBottom");
		sbBottom.hidden = !NAV_BOTTOM;
		sbBottom.innerHTML = NAV_BOTTOM ? navRow(NAV_BOTTOM, model.view === NAV_BOTTOM.view, false) : "";

		/* Topbar — time range. Standup is always a fixed yesterday/today board, so
		   the control applies to the ranged views and is hidden on standup. */
		var rangeSeg = document.getElementById("rangeSeg");
		var custom = document.getElementById("rangeCustom");
		var ranged = JD.ranged(model);
		var activeRange = ranged ? ranged.range : null;
		rangeSeg.hidden = !activeRange;
		/* The picker is a calendar popover. It starts at the selected window (or
		   the 30-day preset), always shows two adjacent months, and does not alter
		   the server-backed range until Apply is clicked.
		   Closed only when no selection is in progress. renderShell also runs on the
		   30 s poll, and closing it unconditionally there yanked the popover shut
		   mid-selection — the user picks a start date, the timer fires, the calendar
		   is gone. An open picker is unsaved user input; a background refresh has no
		   business discarding it. */
		if (!calendarPending) custom.hidden = true;
		var pad = (n) => String(n).padStart(2, "0");
		/* Day keys come from a Date's own Y/M/D fields — the very label the user
		   sees on the cell. `today` MUST be derived the same way: deriving it via
		   JD.dayKey (which projects into model.timeZone) while the cells stayed
		   browser-local put the `key > today` disable off by a day whenever the
		   viewer's zone differed from the server's — a remote/WSL host, or a
		   laptop that travelled — so either today was disabled or tomorrow was
		   selectable, and the server then clamped it silently. */
		var keyFor = (date) => date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
		var today = ranged ? keyFor(new Date(model.generatedAtMs)) : "";
		var selectedFrom = calendarPending ? calendarPending.from : ranged ? ranged.rangeFrom : "";
		var selectedTo = calendarPending ? calendarPending.to : ranged ? ranged.rangeTo : "";
		var shown = selectedTo || today;
		var monthCursor = new Date(shown + "T12:00:00");
		monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1);
		var monthTitle = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
		var calendarMonths = document.getElementById("rangeCalendarMonths");
		var selectionLabel = document.getElementById("rangeSelection");
		var renderCalendar = () => {
			var html = "";
			for (var offset = 0; offset < 2; offset++) {
				var month = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + offset, 1);
				var first = new Date(month.getFullYear(), month.getMonth(), 1);
				var last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
				html += '<div class="range-month"><div class="range-month-title">' + monthTitle.format(month) + '</div><div class="range-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div><div class="range-days">';
				for (var blank = 0; blank < first.getDay(); blank++) html += '<span aria-hidden="true"></span>';
				for (var day = 1; day <= last.getDate(); day++) {
					var key = keyFor(new Date(month.getFullYear(), month.getMonth(), day));
					var classes = "range-day";
					if (selectedFrom && selectedTo && key >= selectedFrom && key <= selectedTo) classes += " in-range";
					if (key === selectedFrom) classes += " range-start";
					if (key === selectedTo) classes += " range-end";
					html += '<button type="button" class="' + classes + '" data-date="' + key + '"' + (key > today ? " disabled" : "") + ">" + day + "</button>";
				}
				html += "</div></div>";
			}
			calendarMonths.innerHTML = html;
			var count = selectedFrom && selectedTo ? Math.round((new Date(selectedTo + "T12:00:00") - new Date(selectedFrom + "T12:00:00")) / 86400000) + 1 : 0;
			selectionLabel.textContent = count ? count + (count === 1 ? " day selected" : " days selected") : "Select a start and end date";
			Array.prototype.forEach.call(calendarMonths.querySelectorAll("[data-date]"), (button) => {
				button.onclick = () => {
					var key = button.getAttribute("data-date");
					if (!selectedFrom || selectedTo || key < selectedFrom) { selectedFrom = key; selectedTo = ""; }
					else selectedTo = key;
					calendarPending = { from: selectedFrom, to: selectedTo };
					renderCalendar();
				};
			});
		};
		var openCalendar = () => {
			calendarPending = { from: selectedFrom, to: selectedTo };
			custom.hidden = false;
			rangeSeg.querySelector('[data-range="custom"]').setAttribute("aria-expanded", "true");
			var control = rangeSeg.querySelector('[data-range="custom"]').getBoundingClientRect();
			custom.style.top = Math.min(control.bottom + 8, window.innerHeight - 520) + "px";
			custom.style.left = Math.max(16, Math.min(control.left, window.innerWidth - custom.offsetWidth - 16)) + "px";
			renderCalendar();
		};
		var closeCalendar = () => {
			calendarPending = null;
			custom.hidden = true;
			rangeSeg.querySelector('[data-range="custom"]').setAttribute("aria-expanded", "false");
		};
		Array.prototype.forEach.call(rangeSeg.querySelectorAll("button"), (button) => {
			var value = button.getAttribute("data-range");
			button.setAttribute("aria-pressed", String(value === activeRange));
			if (value === "custom") {
				button.onclick = () => custom.hidden ? openCalendar() : closeCalendar();
				return;
			}
			button.onclick = () => {
				/* Only a real change is a change: clicking the already-active range
				   must not emit range_changed. Emit the user-facing label token
				   (7d/30d/90d), not the internal DashboardRange token (week/month/3m),
				   so the discriminator matches the registry doc and the button labels.
				   `custom` is handled by its own branch above and reported on Apply. */
				if (value !== activeRange) {
					JD.track("range_changed", { range: { week: "7d", month: "30d", "3m": "90d" }[value] || value });
				}
				window.location.href = JD.viewPath(model.view) + JD.query(model, { range: value });
			};
		});

		if (ranged) {
			custom.onsubmit = (event) => {
				event.preventDefault();
				if (!selectedFrom || !selectedTo) return;
				JD.track("range_changed", { range: "custom" });
				window.location.href =
					JD.viewPath(model.view) +
					JD.query(model, { range: "custom", from: selectedFrom, to: selectedTo });
			};
			document.getElementById("rangePrevious").onclick = () => { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1); renderCalendar(); };
			document.getElementById("rangeNext").onclick = () => { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1); renderCalendar(); };
			document.getElementById("rangeCancel").onclick = closeCalendar;
			if (calendarKeydownHandler) document.removeEventListener("keydown", calendarKeydownHandler);
			calendarKeydownHandler = (event) => { if (event.key === "Escape") closeCalendar(); };
			document.addEventListener("keydown", calendarKeydownHandler);
			/* An open popover must be re-rendered, not just left alone. Everything
			   above rebinds to THIS closure, while the day buttons already in the DOM
			   still call the PREVIOUS one — so after a 30 s refresh tick a click
			   updated the old closure's selectedFrom/To (and calendarPending) while
			   Apply read this closure's copies, frozen at tick time: it navigated to
			   the pre-tick window, or silently returned when `to` was still empty.
			   Re-rendering rebinds the buttons and re-reads calendarPending, which is
			   why that state is module-scoped in the first place. */
			if (calendarPending) renderCalendar();
		}

		/* Navigation. Real links (not client-side swaps) so a view is deep-linkable
		   and reload-safe; the server renders each page with its data inlined.
		   A gated row's own 302 is the enforcement — disabling the click here is
		   just so it does not visibly bounce through a redirect on the way.

		   The repo scope is dropped alongside the range: the sidebar changes
		   PAGE, and every page's default is all repos. A single-repo scope is
		   only ever established by an explicit act on one repo — Repositories'
		   per-row Dashboard button, or a memory deep link — and carrying it
		   through the sidebar made it permanent, since nothing on the page
		   offers a way back to all repos. */
		Array.prototype.forEach.call(document.querySelectorAll("#sbNav .sb-item, #sbBottom .sb-item"), (button) => {
			if (button.getAttribute("aria-disabled") === "true") return;
			var path = button.getAttribute("data-nav-path");
			var navView = button.getAttribute("data-nav-view");
			button.onclick = () => {
				// Settings is a MODAL over the current page, not a navigation — open it
				// in place rather than routing away (like the Claude settings dialog).
				if (navView === "settings" && JD.openSettings) {
					JD.openSettings();
					return;
				}
				if (navView && navView !== model.view) JD.track("dashboard_view_switched", { view: navView });
				window.location.href = path + JD.query(model, { range: undefined, repo: undefined });
			};
		});
		document.getElementById("machinesChip").hidden = model.tier !== "space";
		/* textContent, so no esc(): escaping first would render a message
		   containing & < > " as the literal &amp; / &lt; / &quot;. */
		var coverageNote = document.getElementById("coverageNote");
		coverageNote.textContent = (model.coverage || []).map((note) => note.message).join(" · ");
		/* Hidden when there is nothing to say. `.footer-note` carries `margin: 18px
		   auto 0` plus padding, so an empty div still pushed dead space under the
		   grid — visible on Repositories and Memories, which now carry no note. */
		coverageNote.hidden = coverageNote.textContent.length === 0;
	};

	/* What each gate actually unlocks, and what the reader would have to do about it.
	   The gate is a parameter because getting it wrong is a lie the card tells at
	   full confidence: the Team board needs a Space, and offering "Enable Jolli
	   Memory" under it sends someone to switch on a feature they already have. */
	var GATES = {
		memory: {
			why: "Unlocks with Jolli Memory — decisions, tickets and per-commit context read from your commits.",
			cta: "Enable Jolli Memory",
		},
		space: {
			why: "Unlocks with a Jolli Space — teammates push their memories to it, and this reads what they shared.",
			cta: "Connect a Space",
		},
	};

	/* A locked feature card — the memory/space upsell placeholder. `gate` defaults
	   to "memory"; pass "space" for anything that needs teammates. */
	JD.lockedCard = (title, why, span, gate) => {
		var unlock = GATES[gate || "memory"];
		return (
			'<section class="card ' +
			(span || "") +
			'"><div class="card-head"><div><h2>' +
			JD.esc(title) +
			"</h2></div></div>" +
			'<div class="locked-panel"><p>' +
			JD.esc(why) +
			"</p>" +
			'<div class="why">' +
			unlock.why +
			"</div>" +
			'<button type="button" class="cta ghost" disabled>' +
			unlock.cta +
			"</button></div></section>"
		);
	};

	/* How many rows a long list renders before it asks. Shared so the feed and the
	   corpus cut at the same place — a reader who learns the rule on one page
	   should not have to relearn it on the other. */
	JD.PAGE_SIZE = 10;

	/* Footer for a list rendered collapsed: how much is on screen, and the button
	   that opens the rest. Purely a view control — the server already sent every
	   row, so expanding costs no round trip. The counts are spelled out because a
	   bare "More" does not say whether 2 or 200 are hidden.

	   Callers render this only when `total` exceeds {@link JD.PAGE_SIZE}; the
	   expanded state is inferred from `shown` rather than passed, so the label and
	   the list can never disagree about which state is on screen. */
	JD.moreToggle = (id, shown, total, noun) => {
		var expanded = shown >= total;
		return (
			'<div class="more-row"><span class="more-count">Showing ' +
			shown +
			" of " +
			total +
			" " +
			JD.esc(noun) +
			'</span><button type="button" class="cta ghost sm" id="' +
			id +
			'" aria-expanded="' +
			String(expanded) +
			'">' +
			(expanded ? "Show fewer" : "Show all " + total) +
			"</button></div>"
		);
	};

	/* Leading glyph per row kind. Shared rather than per-page: the standup board
	   and Memories' detail pane both render commit/session/insight rows, and one
	   kind reading as two different marks depending on the page is the drift
	   worth preventing. The first three keys have no insight equivalent — they
	   are standup-only row types. */
	JD.glyph = {
		commit: '<span class="glyph commit">◆</span>',
		session: '<span class="glyph done">✓</span>',
		workspace: '<span class="glyph next">▸</span>',
		blocker: '<span class="glyph todo">■</span>',
		question: '<span class="glyph todo">?</span>',
		gotcha: '<span class="glyph todo">!</span>',
		todo: '<span class="glyph todo">□</span>',
		decision: '<span class="glyph done">★</span>',
	};

	/* Session row shared by both pages. */
	JD.sessionRow = (session, model) => {
		var esc = JD.esc;
		return (
			'<div class="sess-row">' +
			'<span class="tag"><i style="background:' +
			JD.seriesColor(JD.sourceIndex(session.source)) +
			'"></i>' +
			esc(session.source) +
			"</span>" +
			'<span class="t">' +
			esc(session.title) +
			"</span>" +
			(session.isLive ? '<span class="tag live">live</span>' : "") +
			'<span class="tag">' +
			session.messageCount +
			" messages</span>" +
			'<span class="tag">' +
			esc(session.repoName) +
			"</span>" +
			'<span class="when">' +
			esc(JD.relTime(session.updatedAtMs, model.generatedAtMs)) +
			"</span>" +
			"</div>"
		);
	};

	/* Short range names for the card-head scope chip — the mockup's `RANGES.short`,
	   which reads as a phrase ("this month") rather than the card subtitle's
	   duration ("Last 30 days"). */
	var RANGE_SHORT = { today: "today", week: "this week", "2w": "2 weeks", month: "this month" };

	/* Card-head scope badge: `<repo or "all repos"> · <range>`.
	   It names the repo rather than saying "this repo" — under a single-repo scope
	   the literal restates what the sidebar already shows, while the name plus the
	   window says which slice of which project the card covers. A custom range has
	   no short name, so it states its resolved bounds. */
	JD.scopeChip = (model) => {
		var ranged = JD.ranged(model);
		var scoped = model.scope && model.scope.kind === "repo" ? model.scope.repoIdentity : "";
		/* The model carries identities, not display names — resolve through the
		   repo list the sidebar renders from, so the chip and the sidebar cannot
		   disagree. An identity with no matching option (a repo disabled since the
		   page was rendered) falls back to the identity rather than going blank. */
		var option = scoped ? model.repos.filter((r) => r.repoIdentity === scoped)[0] : null;
		var where = scoped ? (option ? option.repoName : scoped) : "all repos";
		var when = ranged ? RANGE_SHORT[ranged.range] || ranged.rangeFrom + " – " + ranged.rangeTo : "";
		return '<span class="chip" style="cursor:default">' + JD.esc(when ? where + " · " + when : where) + "</span>";
	};

	var SOURCE_ORDER = ["claude", "codex", "cursor", "copilot", "gemini", "opencode", "devin", "cline", "antigravity"];
	JD.sourceIndex = (source) => {
		var index = SOURCE_ORDER.indexOf(String(source).split("-")[0]);
		return index >= 0 ? index : SOURCE_ORDER.length;
	};

	/* The `/api/model` URL for the params the page was rendered with. */
	JD.modelUrl = (model) => {
		var query = JD.query(model, {});
		return "/api/model" + (query ? query + "&" : "?") + "view=" + model.view;
	};

	/**
	 * Token-aware fetch helpers for the write surface (Repositories' enable/
	 * disable/resume, Settings' hook reinstall, the folder browser and repo
	 * probe). `window.__JOLLI_DASHBOARD_TOKEN__` is inlined only into the
	 * page that needs it — see `DashboardServer.ts`'s module header for why the
	 * header carries it and a query string never does.
	 */
	/**
	 * Fire-and-forget UI telemetry beacon → POST /api/telemetry (the server
	 * stamps it with the `web-local` surface). Content-free: pass only bucketed
	 * values and fixed discriminators, never raw counts or user text. Prefers
	 * `navigator.sendBeacon` so the event survives the full-page navigation a
	 * nav/range click triggers, falling back to keepalive fetch. Never throws,
	 * and needs no token — the endpoint sits ahead of the mutation-token gate
	 * (see DashboardServer.handleTelemetry).
	 */
	JD.track = (event, properties) => {
		try {
			var body = JSON.stringify({ event: event, properties: properties || {} });
			if (navigator.sendBeacon) {
				navigator.sendBeacon("/api/telemetry", new Blob([body], { type: "application/json" }));
				return;
			}
			fetch("/api/telemetry", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: body,
				keepalive: true,
			}).catch(function () {});
		} catch (e) {
			/* telemetry must never break the UI */
		}
	};

	JD.post = (path, body) =>
		fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json", "X-Jolli-Dashboard-Token": window.__JOLLI_DASHBOARD_TOKEN__ || "" },
			body: JSON.stringify(body || {}),
		}).then(async (res) => {
			var data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || "request failed (" + res.status + ")");
			return data;
		});

	JD.getJson = (path) =>
		fetch(path, { headers: { "X-Jolli-Dashboard-Token": window.__JOLLI_DASHBOARD_TOKEN__ || "" } }).then(
			async (res) => {
				var data = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(data.error || "request failed (" + res.status + ")");
				return data;
			},
		);

	/* One model re-fetch (same params the page was rendered with).

	   Carries the token like JD.getJson does, even though /api/model answers
	   without one: the token is what tells the server this is our own page
	   rather than a cross-site GET, and a token-free answer omits the parts
	   that cost model budget (the Decisions gist). Without it a poll would
	   silently drop the gist the page was rendered with. */
	JD.refreshNow = (render) => {
		var model = window.__JOLLI_DASHBOARD__;
		fetch(JD.modelUrl(model), { headers: { "X-Jolli-Dashboard-Token": window.__JOLLI_DASHBOARD_TOKEN__ || "" } })
			.then((res) => {
				if (!res.ok) throw new Error("refresh failed: " + res.status);
				return res.json();
			})
			.then((fresh) => {
				/* A tab left open across a CLI upgrade is talking to a server whose
				   view/payload shapes may have moved on (e.g. Decisions' retirement
				   dropped a view token entirely) — a client-side re-render could try
				   to read a shape this old page was never built to handle. A full
				   reload re-fetches the current HTML/JS/CSS instead of patching an
				   old page in place. */
				if (fresh.schemaVersion !== model.schemaVersion) {
					window.location.reload();
					return;
				}
				window.__JOLLI_DASHBOARD__ = fresh;
				render(fresh);
			})
			.catch(() => {
				/* Transient — keep the last data, but still REPAINT it. Callers clear
				   local UI state before calling this and depend on the re-render to
				   show it: repoAction sets `busyRepo = null` and then hands the
				   repaint to us, so swallowing this silently left the row stuck on
				   "Working…" with no buttons until a manual reload. Only Stats has a
				   poll to recover on the next tick; every other view calls this once,
				   on a user action. Re-rendering the same model is idempotent. */
				render(window.__JOLLI_DASHBOARD__);
			});
	};

	/* Refresh loop: re-fetch the model and re-render — My Dashboard ONLY.
	   That page is the one that reads like a live instrument (sessions, tokens,
	   Memory Activity), and it is also the page a user leaves open. Everywhere
	   else the poll only cost: Standup is a draft you edit before posting and a
	   re-render underneath you is actively hostile, Repositories and Memories
	   change on a user action that already refreshes them (`JD.refreshNow` is
	   still called explicitly there). Every view keeps the manual path — only
	   the timer is scoped. */
	JD.startRefresh = (render) => {
		if ((window.__JOLLI_DASHBOARD__ || {}).view !== "stats") return;
		setInterval(() => JD.refreshNow(render), PAGE_REFRESH_MS);
	};
})(window.JD);
