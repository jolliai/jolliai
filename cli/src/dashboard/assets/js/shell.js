window.JD = window.JD || {};

((JD) => {
	/* Query string carrying the current repo scope, range and series dimension.
	   Built in one place so navigation, the range control and the refresh loop
	   cannot drift on which params survive a click. */
	JD.query = (model, over) => {
		var o = over || {};
		/* An ARRAY of identities, possibly empty (= all repos). Overriding with
		   `{ repo: [] }` or `{ repo: undefined }` both clear the scope. */
		var repos = "repo" in o ? o.repo || [] : JD.scopeIdentities(model);
		var ranged = JD.ranged(model);
		var range = "range" in o ? o.range : ranged ? ranged.range : undefined;
		/* Falls back to the dimension the SERVER says it used, not to undefined.
		   `JD.dimension` is only set by the Tokens card's split tabs, so for every
		   other axis it is undefined — and a deep-linked `?dimension=branch` was
		   then absent from every rebuilt URL while the 30 s poll silently re-asked
		   for the default, changing the chart axis under the reader. Deep links are
		   the ONLY way to reach the branch/ticket/category axes: the server accepts
		   them (see `parseDimension`) but nothing renders a control for them. */
		var served = model.stats && model.stats.seriesDimension;
		var dimension = "dimension" in o ? o.dimension : JD.dimension || served;
		/* Bounds ride along ONLY with range=custom, so switching to a preset drops
		   them in the same click rather than leaving a stale pair in the URL. */
		var from = "from" in o ? o.from : ranged ? ranged.rangeFrom : undefined;
		var to = "to" in o ? o.to : ranged ? ranged.rangeTo : undefined;
		var parts = [];
		/* One `repo=` per identity — REPEATED params, not a comma-joined list: an
		   identity is a remote URL, so any delimiter is a character one may
		   legitimately contain, and splitting on it would ask for two repos that
		   do not exist instead of the one that does. A single selection therefore
		   still emits exactly the `?repo=jolliai` old links carry. */
		repos.forEach((identity) => {
			parts.push("repo=" + encodeURIComponent(JD.repoToken(model, identity)));
		});
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

	/* The scope's repo identities, always an array — empty means every repo.
	   The ONE place that reads the scope's shape, so a payload change lands here
	   rather than in each of the callers that only want "how many repos is this
	   page showing?" (the picker's label, and the row-level repo tags that are
	   redundant under a single-repo scope). */
	JD.scopeIdentities = (model) => {
		var scope = model && model.scope;
		return scope && scope.kind === "repo" && scope.repoIdentities ? scope.repoIdentities.slice() : [];
	};

	/** How often the whole page refetches its model. */
	var PAGE_REFRESH_MS = 30_000;

	/* Page title/subtitle per view — every view the server can render. Two are
	   retired: Decisions (folded into Memories' per-topic Decisions callout) and
	   Repositories (its list became the topbar picker; its Pause/Resume actions
	   were removed outright). Both lost their view token, page and nav row. */
	var DASHBOARDS = [
		{ view: "stats", label: "My Dashboard", sub: "individual · local" },
		{ view: "standup", label: "Daily Standup", sub: "sprint · local" },
		{ view: "memories", label: "Memories", sub: "browse · per-commit" },
		{ view: "knowledge", label: "Knowledge", sub: "wiki · per-repo" },
		{ view: "graph", label: "Graph", sub: "knowledge graph · per-repo" },
		{ view: "settings", label: "Settings", sub: "agents · summary · memory bank" },
	];

	/* Canonical URL for a view token. `stats`/`standup` live at /dashboard(/standup)
	   under the new nav, not at their own name — everything else's path matches
	   its view token 1:1. One place this can diverge, so nav links, the range
	   control and the repo picker cannot disagree on where a view lives. */
	var VIEW_PATH = {
		stats: "/dashboard",
		standup: "/dashboard/standup",
		memories: "/memories",
		knowledge: "/knowledge",
		graph: "/graph",
		settings: "/settings",
	};
	JD.viewPath = (view) => VIEW_PATH[view] || "/" + view;

	/* The nav list. Dashboard's two children render flat under a group label
	   rather than behind an expand/collapse toggle — that interaction is a later
	   polish pass, not a routing concern.

	   NOTHING IS GATED any more. These rows used to disable themselves until a
	   repo was enabled, mirroring DashboardServer's GATED_PATHS so a dead row and
	   a 302 could not disagree, and Repositories sat below them as the never-gated
	   row that opened the gate. Repositories is gone, so the gate has nowhere to
	   send anyone — a disabled row leading nowhere is worse than a live one that
	   explains itself, and the stats page now carries the enable instruction that
	   page used to.

	   Knowledge and Graph ARE routed (VIEW_PATHS has /knowledge, /graph) and sit
	   below Memories. Settings alone has no scrollable nav row
	   and no page path — it is a modal pinned to the bottom slot (NAV_BOTTOM),
	   opened via JD.openSettings, so a direct visit to /settings 404s. Adding a
	   new page needs its server route, view token and model payload too — a nav
	   row on its own is not enough. */
	var NAV_MIDDLE = [
		{
			label: "Dashboard",
			kids: [
				{ view: "stats", path: "/dashboard", label: "My Dashboard" },
				{ view: "standup", path: "/dashboard/standup", label: "Daily Standup" },
			],
		},
		{ view: "memories", path: "/memories", label: "Memories" },
		/* Knowledge / Graph browse the Memory Bank FOLDER, whose repo set differs
		   from the enabled dashboard repos — they carry their own empty state. */
		{ view: "knowledge", path: "/knowledge", label: "Knowledge" },
		{ view: "graph", path: "/graph", label: "Graph" },
	];
	/* Settings is pinned to the sidebar's bottom edge (its reserved slot), not in
	   the scrollable menu list — a persistent destination rather than the last
	   nav row. */
	var NAV_BOTTOM = { view: "settings", path: "/settings", label: "Settings" };

	/* The sidebar uses the same compact Lucide-style outlines as the mockup.
	   Keeping the paths here makes the navigation self-contained and avoids a
	   dependency on an icon font at dashboard start-up. */
	var NAV_ICONS = {
		dashboard:
			'<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
		database:
			'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
		chevron: '<path d="m6 9 6 6 6-6"/>',
		book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
		network:
			'<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4"/><path d="M5 16v-2h14v2"/>',
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
		({
			stats: "dashboard",
			memories: "database",
			knowledge: "book",
			graph: "network",
			settings: "settings",
		})[view];

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

	/* The repo picker's in-progress tick set (an array of identities), or null
	   when the popover is closed — and its own document-level Escape handler.
	   Module-scoped for exactly the two reasons the calendar's are: renderShell
	   re-runs on the 30 s poll, so a local would be re-seeded from the
	   server-backed scope and discard a half-made selection, and an untracked
	   `keydown` listener would stack a fresh copy on `document` every tick. */
	var repoPending = null;
	var repoKeydownHandler = null;
	/* The row markup currently in `#repoScopeList`, so a render can tell whether the
	   ROWS changed (a repo registered, a session count moved) from whether only the
	   TICKS did. Module-scoped rather than read back off the element: it has to
	   outlive the closure that drew it, and it is compared, never displayed. */
	var repoRowsDrawn = "";

	/* Views the scope actually narrows — which is now every page there is, since
	   Repositories (the one page that listed the whole registry regardless) was
	   removed. Kept as a table rather than collapsed to `true` so a future view
	   that ignores the scope hides the control instead of lying about it; the
	   picker hides rather than disables, same as the range control on standup. */
	var SCOPED_VIEWS = { stats: true, standup: true, memories: true };

	/* Button label for a selection: the repo's name at one, a count past that.
	   Names past one would either truncate or push the range control off the row,
	   and the popover is one click away for the detail. */
	function repoScopeLabel(model, selected) {
		if (selected.length === 0) return "All repos";
		if (selected.length === 1) {
			var option = (model.repos || []).filter((r) => r.repoIdentity === selected[0])[0];
			/* A scope naming a repo that is no longer in the list (paused since the
			   page was rendered) still has to say SOMETHING true — the identity is
			   what the numbers were actually filtered by. */
			return option ? option.repoName : selected[0];
		}
		return selected.length + " repos";
	}

	/* The topbar repository picker: a button plus a checkbox popover.
	   Mirrors the range calendar's lifecycle deliberately — see `repoPending`. */
	function renderRepoPicker(model) {
		var esc = JD.esc;
		var wrap = document.getElementById("repoScopeWrap");
		var button = document.getElementById("repoScopeBtn");
		var popover = document.getElementById("repoScope");
		var list = document.getElementById("repoScopeList");
		var label = document.getElementById("repoScopeLabel");
		var selectionNote = document.getElementById("repoScopeSelection");
		var applyButton = document.getElementById("repoScopeApply");
		var cancelButton = document.getElementById("repoScopeCancel");
		/* All seven or none. Every one of them is static in index.html, so a missing
		   one means the template and this file have gone out of step — and a guard
		   over four of them just moves the resulting TypeError further down, into the
		   render, where it takes the rest of the shell (nav, range control) with it. */
		if (!wrap || !button || !popover || !list || !label || !selectionNote || !applyButton || !cancelButton) return;

		var options = model.repos || [];
		var scoped = JD.scopeIdentities(model);
		var identities = options.map((option) => option.repoIdentity);
		/* The scope split in two: tokens naming a repo that is still registered, and
		   tokens naming nothing at all — a bookmarked `?repo=` for a repo since
		   disabled or removed. The server keeps such a token rather than dropping it
		   (`resolveScope` leaves what it cannot resolve in place, and the query side
		   folds it to a row id that matches nothing) precisely so the page cannot
		   silently widen to every repo. That makes the dead token the client's
		   problem to show a way out of. */
		var live = scoped.filter((id) => identities.indexOf(id) >= 0);
		var stale = scoped.length - live.length;
		/* Nothing to pick between with zero or one repo registered: the control would
		   only ever be able to say what the page already says. EXCEPT with a dead
		   token in the URL — the page is then showing an empty scope nothing on it
		   explains, and every link rebuilds that token into the next URL
		   (`JD.query` re-emits the scope it was handed), so hiding the control leaves
		   no way back short of editing the address bar. With no repo registered at all
		   there is still nothing to offer: every row would be unpickable. */
		var shown = !!SCOPED_VIEWS[model.view] && options.length > 0 && (options.length > 1 || stale > 0);
		wrap.hidden = !shown;
		if (!shown) {
			/* Closed as well as hidden — a pending selection left behind would
			   re-open the popover on the next render of a scoped view, over a
			   control the reader never touched there. */
			repoPending = null;
			popover.hidden = true;
			button.setAttribute("aria-expanded", "false");
			return;
		}
		label.textContent = repoScopeLabel(model, scoped);
		/* The label can be ambiguous where the names are (three clones called
		   `repo`), so the button carries the identities it actually stands for.
		   textContent-set, never markup — these are user-controlled strings. */
		button.setAttribute("title", scoped.length > 0 ? scoped.join("\n") : "Every registered repository");

		/* "All repositories" is a SET question, not a count. A stale or foreign
		   `?repo=` token makes `picked.length` equal `identities.length` while a
		   real repo sits unticked, so a length test drew the master row as
		   fully-checked and Apply collapsed to an empty `?repo=`, silently widening
		   "just A" to every repo. Ask instead whether every enabled identity is
		   present; extra dead tokens do not count toward "all". */
		var everyRepoSelected = (sel) => identities.every((id) => sel.indexOf(id) >= 0);
		/* Ticked set: the in-progress selection when the popover is open, else the
		   scope the server answered with.

		   THE UNSCOPED PAGE SEEDS EVERY BOX TICKED, not none. "All repositories"
		   is stored as an EMPTY `?repo=` — an explicit list of every repo goes
		   stale the moment one is registered, silently excluding it from a scope
		   that reads as "all" — but that is how the selection is spelled in the
		   URL, and it has no business being how it is drawn. Seeding the boxes
		   from the empty list made the widest possible scope look like nothing
		   was selected at all. `pickedToScope` below puts the two back together. */
		/* The COMMITTED selection — what the boxes show when nothing is pending.
		   Only the LIVE half of the scope: a box can only stand for a row that is
		   there, so a dead token draws as nothing rather than padding the ticked
		   count, and Apply drops it from the next URL. When every token is dead this
		   is empty — no row ticked, Apply off until the reader picks one — which is
		   both the honest reading of that scope and the way out of it.
		   A function rather than a value because `close()` has to restore it, and
		   restoring from a captured array would hand the closure a reference the
		   tick-render's own `picked` then mutates. */
		var committed = () => (scoped.length > 0 ? live.slice() : identities.slice());
		var picked = repoPending ? repoPending.slice() : committed();
		popover.hidden = !repoPending;
		button.setAttribute("aria-expanded", String(!popover.hidden));

		/* The ROWS, with no tick state in them at all.
		   Every tick is a DOM property written by `syncMarks` instead, because
		   `list.innerHTML = …` replaces the very checkbox the reader is standing on:
		   with the state in the markup, each toggle had to redraw, and each redraw
		   destroyed the focused element — so keyboard multi-select lost its place
		   after every single row and had to be re-Tabbed to. `checked` has an HTML
		   spelling and `indeterminate` does not, which is what made the split look
		   optional; it never was. */
		var listHtml = () => {
			var html =
				'<label class="repo-scope-row all"><input type="checkbox" data-repo-all="1">' +
				'<span class="name">All repositories</span></label>';
			options.forEach((option) => {
				/* A repo NAME is a directory basename, so several rows can carry the
				   same one — three clones all called `repo` is the ordinary case, not
				   a corner. Identical rows would be a list you cannot choose from, so
				   a duplicated name spends its meta slot on the checkout path (the
				   thing that actually differs) instead of the session count. The full
				   path is the row's tooltip either way. */
				var ambiguous = options.filter((r) => r.repoName === option.repoName).length > 1;
				/* A PAUSED repo stays in the list and stays selectable — its rows are
				   never deleted and it still counts in the aggregate numbers, so its
				   history is worth reaching. The meta slot says so (over the sessions
				   figure or the disambiguating path), and `paused` on the row is what
				   the stylesheet dims it by. */
				var meta = option.disabled
					? "paused"
					: ambiguous
						? esc(option.worktreeRoot || option.repoIdentity)
						: option.sessionsThisWeek + (option.sessionsThisWeek === 1 ? " session" : " sessions") + " · 7d";
				html +=
					'<label class="repo-scope-row' +
					(option.disabled ? " paused" : "") +
					'" title="' +
					esc(option.worktreeRoot || option.repoIdentity) +
					'"><input type="checkbox" data-repo="' +
					esc(option.repoIdentity) +
					'"><span class="name">' +
					esc(option.repoName) +
					'</span><span class="meta' +
					(ambiguous && !option.disabled ? " path" : "") +
					'">' +
					meta +
					"</span></label>";
			});
			return html;
		};

		/* Everything a toggle changes: the ticks, the master row's half-selected
		   mark, the footer sentence and Apply. Takes the box list it was given rather
		   than re-querying, so it writes to the same elements the handlers are bound
		   to even after a rebuild. */
		var syncMarks = (boxes) => {
			var all = everyRepoSelected(picked);
			var none = picked.length === 0;
			Array.prototype.forEach.call(boxes, (box) => {
				if (box.getAttribute("data-repo-all")) {
					box.checked = all;
					/* The half-selected mark. A DOM PROPERTY with no HTML spelling at
					   all, so it can only be written here. Without it the master row
					   reads as plain unchecked while a subset is selected — the one
					   state the tri-state pattern exists to distinguish. */
					box.indeterminate = !all && !none;
					return;
				}
				box.checked = picked.indexOf(box.getAttribute("data-repo")) >= 0;
			});
			/* A scope of zero repositories is not expressible — the server reads an
			   empty `?repo=` as every repo — so rather than silently widening an
			   empty selection back to "all" on Apply, the button says why it is off. */
			selectionNote.textContent = all
				? "All repositories"
				: none
					? "Select at least one repository"
					: picked.length + (picked.length === 1 ? " repository selected" : " repositories selected");
			applyButton.disabled = none;
		};

		var renderList = () => {
			var html = listHtml();
			/* Redrawn ONLY when the rows themselves changed. The tick state is not in
			   this string, so a toggle never reaches here — and neither does the 30 s
			   poll while the numbers hold steady, which is what keeps an open popover
			   from having the row under the pointer replaced mid-selection. */
			if (html !== repoRowsDrawn) {
				list.innerHTML = html;
				repoRowsDrawn = html;
			}
			var boxes = list.querySelectorAll("input[type=checkbox]");
			Array.prototype.forEach.call(boxes, (box) => {
				/* Rebound on every render even when the rows were reused: each render
				   is a new closure over a new `picked`, and a handler left pointing at
				   the previous one would update a set Apply no longer reads. */
				box.onchange = () => {
					if (box.getAttribute("data-repo-all")) {
						/* Standard select-all: already-all clears, anything else
						   selects everything. Clearing is what makes "just these two"
						   two clicks instead of N-2. Recomputed here rather than read
						   from the enclosing render, which may be several ticks old. */
						picked = everyRepoSelected(picked) ? [] : identities.slice();
					} else {
						var identity = box.getAttribute("data-repo");
						var at = picked.indexOf(identity);
						if (at >= 0) picked.splice(at, 1);
						else picked.push(identity);
					}
					repoPending = picked.slice();
					syncMarks(boxes);
				};
			});
			syncMarks(boxes);
		};

		var open = () => {
			repoPending = picked.slice();
			popover.hidden = false;
			button.setAttribute("aria-expanded", "true");
			renderList();
		};
		/* Cancel/Escape DISCARD, they do not merely hide. Clearing `repoPending`
		   alone was only half of it: `open()` re-seeds from this closure's own
		   `picked`, which the checkbox handlers have been mutating, so a re-open
		   before the next render brought back exactly the ticks Cancel threw away.
		   A render in between recomputes `picked` from the server's scope, which is
		   why this looked correct — the discard really happened on the poll tick,
		   up to PAGE_REFRESH_MS later, and only if one ran first. */
		var close = () => {
			repoPending = null;
			picked = committed();
			popover.hidden = true;
			button.setAttribute("aria-expanded", "false");
		};

		button.onclick = () => (popover.hidden ? open() : close());
		cancelButton.onclick = close;
		popover.onsubmit = (event) => {
			event.preventDefault();
			if (picked.length === 0) return;
			/* Every box ticked collapses back to the EMPTY param — the one the
			   server reads as "every repo", including repos registered after this
			   link was made. This is the only place the drawn selection and the
			   stored one are allowed to differ, and it is the whole reason they
			   can: an all-ticked list and an empty list mean the same thing today
			   and only the empty one keeps meaning it tomorrow.

			   The URL is the only place the scope lives, so Apply is a navigation.
			   `repo` is passed explicitly (rather than left to the model's own
			   scope) precisely so an empty array clears it. */
			var next = everyRepoSelected(picked) ? [] : picked;
			window.location.href = JD.viewPath(model.view) + JD.query(model, { repo: next });
		};
		/* Tracked across renders and removed before re-binding, for the same reason
		   the calendar's is: renderShell runs on every poll tick. */
		if (repoKeydownHandler) document.removeEventListener("keydown", repoKeydownHandler);
		repoKeydownHandler = (event) => {
			if (event.key === "Escape" && !popover.hidden) close();
		};
		document.addEventListener("keydown", repoKeydownHandler);
		/* An open popover is RE-rendered on the tick rather than left alone:
		   everything above rebinds to this closure while the checkboxes already in
		   the document still call the previous one, so a click after a tick would
		   update one closure's `picked` while Apply read another's. Rebinding is all
		   this usually does — `renderList` redraws the rows only when they changed,
		   so the reader's focus and the row under the pointer survive the tick. */
		if (repoPending) renderList();
	}

	JD.renderShell = (model) => {
		var esc = JD.esc;
		var current = DASHBOARDS.filter((d) => d.view === model.view)[0] || DASHBOARDS[0];

		document.title = "jolli — " + current.label;
		document.getElementById("jdRoot").setAttribute("data-tier", String(TIER_INDEX[model.tier] || 0));
		document.getElementById("pageTitle").textContent = current.label;
		document.getElementById("pageSub").textContent = current.sub;

		/* Sidebar — the nav list (plus an empty pinned bottom slot). No row is
		   gated: see NAV_MIDDLE for why the zero-repo gate went away with the
		   Repositories page it used to redirect to. */
		var navRow = (item, active) =>
			'<button type="button" class="sb-item' +
			(item.child ? " child" : "") +
			'" data-nav-path="' +
			item.path +
			'" data-nav-view="' +
			(item.view || "") +
			'"' +
			(active ? ' aria-current="page"' : "") +
			'>' +
			(item.child ? "" : navIcon(navIconFor(item.view))) +
			'<span class="name">' +
			esc(item.label) +
			"</span></button>";
		var nav = "";
		NAV_MIDDLE.forEach((item) => {
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
					nav += navRow({ ...kid, child: true }, model.view === kid.view);
				});
				return;
			}
			nav += navRow(item, model.view === item.view);
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
		sbBottom.innerHTML = NAV_BOTTOM ? navRow(NAV_BOTTOM, model.view === NAV_BOTTOM.view) : "";

		/* Topbar — repository scope. */
		renderRepoPicker(model);

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

		   The repo scope SURVIVES the click; only the range is dropped. It used
		   to be dropped too, because a scope could only be set by an explicit act
		   on one repo (the Repositories page's per-row Dashboard button, or a
		   memory deep link) and nothing on any page offered a way back to all
		   repos — so carrying it through the sidebar made it permanent. The topbar
		   picker is that way back, and with it in place dropping the scope is the
		   wrong half of the trade: a reader who narrowed to two repos means it for
		   the page they navigate to as well. */
		Array.prototype.forEach.call(document.querySelectorAll("#sbNav .sb-item, #sbBottom .sb-item"), (button) => {
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
				window.location.href = path + JD.query(model, { range: undefined });
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
	   are standup-only row types.

	   `blocker`/`question`/`gotcha` used to have entries here, for the standup's
	   Risks column. They went with it: those three insight kinds are never
	   produced (see the note at the top of standup.js), so the marks could not be
	   reached from anywhere. */
	JD.glyph = {
		commit: '<span class="glyph commit">◆</span>',
		session: '<span class="glyph done">✓</span>',
		workspace: '<span class="glyph next">▸</span>',
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

	/* `JD.scopeChip` lived here — a NON-interactive `<repo> · <range>` badge in
	   the feed card's head, and the only place the page ever stated its own
	   repository scope. It went with the arrival of the topbar picker: the picker
	   states the scope where the reader can also change it, and a second copy of
	   the same fact one card down is a thing to keep in step for no gain. */

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
