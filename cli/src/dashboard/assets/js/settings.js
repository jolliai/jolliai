window.JD = window.JD || {};

((JD) => {
	/**
	 * Settings — opened as a MODAL over any page (like the Claude settings dialog),
	 * not a routed page. `JD.openSettings()` fetches the settings model via
	 * `/api/model?view=settings`, then renders a left section rail + content into
	 * the modal body. Five of the six sections mirror the VS Code settings panel's
	 * tabs, and every label / hint / placeholder / button text in those five is
	 * aligned to that panel verbatim (SettingsHtmlBuilder.ts) so the two surfaces
	 * read identically. `advanced` is the exception and has NO VS Code counterpart:
	 * it configures this dashboard's own sidebar, which that panel does not render.
	 *
	 * Editable fields are a CONTROLLED FORM: every value lives in `state.form`
	 * (seeded once from the payload), the renderers read from it, and every edit
	 * writes straight back to it — so switching sections keeps unsaved edits and a
	 * batched "Apply Changes" saves them all. The masked API keys are the only key
	 * material on the page; the full key stays server-side.
	 */

	var MOUNT = "settingsModalBody";

	var SECTIONS = [
		{ id: "agents", label: "AI Agents" },
		{ id: "summary", label: "AI Summary" },
		{ id: "sync", label: "Sync to Jolli" },
		{ id: "bank", label: "Memory Bank" },
		{ id: "others", label: "Others" },
		{ id: "advanced", label: "Advanced" },
	];

	// Per-section leading glyphs — the same compact Lucide-style outlines the
	// sidebar nav uses (fill:none, stroke:currentColor), so the modal rail reads
	// as a peer of the sidebar rather than a bare text list.
	var SECTION_ICONS = {
		agents: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
		summary:
			'<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/>',
		sync: '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>',
		bank: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
		others: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
		advanced: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
	};

	function sectionIcon(id) {
		return (
			'<span class="set-rail-icon"><svg viewBox="0 0 24 24" aria-hidden="true">' +
			(SECTION_ICONS[id] || "") +
			"</svg></span>"
		);
	}

	// [id, label, hint] — labels + hints copied verbatim from the VS Code panel.
	var AGENTS = [
		["claudeEnabled", "Claude Code", "Session tracking via Stop hook"],
		["codexEnabled", "Codex", "Session discovery via filesystem scan"],
		["geminiEnabled", "Gemini", "Session tracking via AfterAgent hook"],
		["openCodeEnabled", "OpenCode", "Session discovery via ~/.local/share/opencode/opencode.db"],
		[
			"cursorEnabled",
			"Cursor",
			"Session discovery for Cursor's Composer IDE (local SQLite store) and the cursor-agent CLI (~/.cursor/chats + agent-transcripts JSONL)",
		],
		["devinEnabled", "Devin", "Session discovery via Devin CLI's global SQLite store (~/.local/share/devin/cli/sessions.db)"],
		[
			"copilotEnabled",
			"Copilot",
			"Session discovery for GitHub Copilot CLI (~/.copilot/session-store.db) and VS Code Copilot Chat (workspace storage)",
		],
		[
			"clineEnabled",
			"Cline",
			"Session discovery for the Cline CLI (~/.cline/data/sessions) and the Cline VS Code extension (globalStorage)",
		],
		["antigravityEnabled", "Antigravity", "Session discovery via Antigravity's per-conversation store (~/.gemini/antigravity*)"],
		["kimiEnabled", "Kimi Code", "Session discovery via Kimi Code CLI's store (~/.kimi-code/sessions)"],
		["hermesEnabled", "Hermes", "Session discovery via Hermes Agent's state database (~/.hermes/state.db)"],
	];

	var GLOBAL_INSTRUCTIONS_HINT =
		"Let your AI assistants use Jolli's memory automatically? This adds a small skill-preference block to your global instruction files (~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md, ~/.codex/AGENTS.md) so your AI reaches for Jolli when you search past decisions or recall a branch's history — no need to ask each time.";

	// Folder Path verdicts from /api/settings/check-folder → [severity class, text].
	// Advisory only; the server's save gate is the real guard. "empty" shows nothing.
	var FOLDER_STATUS = {
		checking: ["", "Checking…"],
		ok: ["ok", "✓ Folder found."],
		missing: ["warn", "⚠ This folder doesn't exist yet — create it first, then save."],
		relative: ["err", "⚠ Enter an absolute path."],
		"not-a-dir": ["err", "⚠ That path is a file, not a folder."],
		"not-writable": ["err", "⚠ That folder isn't writable."],
	};

	var state = {
		section: "agents",
		form: null,
		initialForm: null,
		originalGi: "default",
		folderStatus: null,
		pushRepos: null,
		pushError: null,
		pushStatus: null, // { repoIdentity, text, kind } — last per-repo toggle result
		// JOLLI-2152: per-repo Jolli Space column, mirroring the VS Code panel.
		// null = not yet fetched (renders "Checking…"); once fetched, an object
		// (possibly empty) keyed by repoIdentity → {state,label,title,degraded}.
		spaceBindings: null,
		spaceBindingsSignedOut: false,
		spaceBindingsError: null,
		// Stale-reply guard for loadSpaceBindings(): doSignIn/doSignOut reset
		// spaceBindings to null and re-trigger a fresh fetch while an earlier
		// fetch (from before the sign-in/out) can still be in flight. Each call
		// captures the incremented value and only applies its result while it
		// still matches, so the earlier, now-stale reply can't land after the
		// newer one and overwrite it with outdated Space data.
		spaceBindingsRequestSeq: 0,
		// Coalescing guard: wire()'s `spaceBindings === null` re-fires
		// loadSpaceBindings() on every render while a fetch is in flight (same
		// shape as loadPushRepos' own render->wire loop below), and a rapid
		// sign-in/sign-out sequence resets spaceBindings to null again before the
		// PREVIOUS fetch (from before that toggle) has resolved. Without this,
		// each toggle starts its own redundant network fan-out even though only
		// the latest one's result is ever kept (spaceBindingsRequestSeq already
		// discards the rest). A skipped call sets spaceBindingsFetchQueued so the
		// in-flight one's own completion starts exactly one more fetch — without
		// that, a skipped call that turns out to be the stale one (seq mismatch)
		// leaves spaceBindings stuck at null with nothing left to ever fetch it.
		spaceBindingsFetchInFlight: false,
		spaceBindingsFetchQueued: false,
		// The machine-wide session-statistics switch. NOT part of `form`: like the
		// per-repo toggles beside it, it writes on change instead of on Apply, so
		// it must not count towards the form's dirty state.
		syncSessions: true,
		syncStatus: null, // { text, kind } — last session-statistics toggle result
		missing: undefined,
		notice: null,
		error: null,
		busy: null,
		probeResult: null,
		loadError: null,
	};

	function esc(s) {
		return JD.esc(String(s == null ? "" : s));
	}

	// Takes the WHOLE model, not just `model.settings`: the Advanced rows are
	// driven by `model.menus`, which lives at the top of the payload because the
	// sidebar reads it on every view (see `DashboardMenus`). One fact, one place.
	function initForm(model) {
		var s = model.settings || {};
		var menus = model.menus || {};
		var a = s.agents || {};
		var sum = s.summary || {};
		var mb = s.memoryBank || {};
		var syncCfg = s.sync || {};
		var others = s.others || {};
		var form = {
			globalInstructions: a.globalInstructions || "default",
			aiProvider: sum.aiProvider || "anthropic",
			model: sum.model || "sonnet",
			maxTokens: sum.maxTokens != null ? String(sum.maxTokens) : "",
			apiKey: sum.apiKeyMasked || "",
			jolliApiKey: sum.jolliApiKeyMasked || "",
			localAgentTool: sum.localAgentTool || "claude-code",
			// No `|| ""` fallback: the server sends the EFFECTIVE id, and "" matches
			// no option, so it would leave the form holding a value the picker never
			// shows. `localAgentCard` resolves an unusable value to the marked
			// default instead.
			localAgentModel: sum.localAgentModel,
			localFolder: mb.localFolder || "",
			compileExcludeFolders: mb.compileExcludeFolders || "",
			syncTranscripts: mb.syncTranscripts === true,
			dcoSignoff: others.dcoSignoff === true,
			excludePatterns: others.excludePatterns || "",
			// `=== true`, matching the config polarity: an absent flag is HIDDEN, so
			// a payload without `menus` cannot render a row as switched on.
			dashboardKnowledgeMenuEnabled: menus.knowledge === true,
			dashboardGraphMenuEnabled: menus.graph === true,
		};
		AGENTS.forEach((pair) => {
			form[pair[0]] = a[pair[0]] !== false;
		});
		state.originalGi = a.globalInstructions || "default";
		// Immediate switch, so it is seeded beside the form rather than inside it.
		state.syncSessions = syncCfg.syncSessions !== false;
		return form;
	}

	// ── Modal open/close ───────────────────────────────────────────────────────
	function modalEl() {
		return document.getElementById("settingsModal");
	}

	// The fixed close-band that sits at the top of the content column — the ✕ lives
	// here (right-aligned), and the section content scrolls in a sibling BELOW it,
	// so the scrollbar never reaches the corner. Same band in every state (loading,
	// error, content), so the ✕ is always in the identical spot.
	function closeBand() {
		return (
			'<div class="set-content-head"><button type="button" class="set-modal-close" id="settingsClose" aria-label="Close settings">✕</button></div>'
		);
	}

	function loadingHtml() {
		return (
			'<div class="set-content">' +
			closeBand() +
			'<div class="set-loading" role="status" aria-live="polite">' +
			'<span class="set-spinner" aria-hidden="true"></span>' +
			"<span>Loading settings…</span></div></div>"
		);
	}

	function errorHtml(msg) {
		return (
			'<div class="set-content">' +
			closeBand() +
			'<div class="set-loading set-loading-error" role="alert">' +
			'<span class="set-loading-icon" aria-hidden="true">!</span>' +
			'<span class="set-loading-title">Couldn’t load settings</span>' +
			'<span class="set-loading-sub">' +
			esc(msg) +
			"</span>" +
			'<button type="button" class="cta ghost sm" id="settingsRetry">Try again</button></div></div>'
		);
	}

	JD.openSettings = () => {
		var modal = modalEl();
		if (modal) modal.hidden = false;
		document.getElementById(MOUNT).innerHTML = loadingHtml();
		wireModalChrome();
		state.loadError = null;
		JD.getJson("/api/model?view=settings")
			.then((model) => {
				JD.__settingsModel = model;
				state.form = null;
				render(model);
			})
			.catch((err) => {
				state.loadError = err.message || "Could not load settings.";
				document.getElementById(MOUNT).innerHTML = errorHtml(state.loadError);
				wireClose();
				var retry = document.getElementById("settingsRetry");
				if (retry) retry.onclick = () => JD.openSettings();
			});
	};

	JD.closeSettings = () => {
		var modal = modalEl();
		if (modal) modal.hidden = true;
	};

	// Re-fetch the model and re-render (after sign-in/out or a save, the server
	// is authoritative — reseed the form from the fresh payload).
	function refreshSettings() {
		JD.getJson("/api/model?view=settings")
			.then((model) => {
				JD.__settingsModel = model;
				state.form = null;
				render(model);
			})
			.catch(() => {
				if (JD.__settingsModel) render(JD.__settingsModel);
			});
	}

	// The ✕ is re-created on every innerHTML write (loading, error, and each
	// render), so it must be re-wired each time rather than once at open.
	function wireClose() {
		var close = document.getElementById("settingsClose");
		if (close) close.onclick = () => JD.closeSettings();
	}

	function wireModalChrome() {
		wireClose();
		var modal = modalEl();
		if (modal)
			modal.onclick = (e) => {
				if (e.target === modal) JD.closeSettings();
			};
	}

	// ── Render ───────────────────────────────────────────────────────────────
	function render(model) {
		var s = model.settings || {};
		if (!state.form) {
			state.form = initForm(model);
			// Baseline for dirty-tracking: Apply stays disabled until the form diverges.
			state.initialForm = JSON.stringify(state.form);
			state.folderStatus = null;
		}
		var f = state.form;

		var rail = SECTIONS.map(
			(sec) =>
				'<button type="button" class="set-rail-item' +
				(state.section === sec.id ? " active" : "") +
				'" data-section="' +
				sec.id +
				'"' +
				(state.section === sec.id ? ' aria-current="page"' : "") +
				">" +
				sectionIcon(sec.id) +
				'<span class="set-rail-label">' +
				esc(sec.label) +
				"</span></button>",
		).join("");

		var body = sectionBody(state.section, s, f);

		document.getElementById(MOUNT).innerHTML =
			'<div class="set-layout"><nav class="set-rail" aria-label="Settings sections">' +
			rail +
			'</nav><div class="set-content">' +
			closeBand() +
			'<div class="set-content-scroll">' +
			body +
			"</div>" +
			footBar() +
			"</div></div>";

		wire(model);
	}

	// True once the controlled form diverges from the baseline captured at load —
	// gates the global Apply button so an unchanged form can't fire the (expensive,
	// all-repos) save on a stray click.
	function isDirty() {
		return JSON.stringify(state.form) !== state.initialForm;
	}

	// The persistent action bar pinned to the bottom of the content column: one
	// Apply button shared by every section (it saves the whole form, not just the
	// visible tab), plus the save/validation feedback beside it. Present on ALL
	// sections — hiding it on one tab would strand edits made on another.
	function footBar() {
		var msg = state.error || state.notice || "";
		var cls = state.error ? " err" : state.notice ? " ok" : "";
		return (
			'<div class="set-content-foot">' +
			'<span class="set-foot-msg' +
			cls +
			'" id="settingsFootMsg" role="status">' +
			esc(msg) +
			"</span>" +
			'<span class="set-foot-spacer"></span>' +
			'<button type="button" class="cta" id="applyBtn"' +
			(state.busy === "apply" || !isDirty() ? " disabled" : "") +
			">" +
			(state.busy === "apply" ? "Applying…" : "Apply Changes") +
			"</button></div>"
		);
	}

	// Live-updates the Apply button's enabled state (and clears a stale save
	// banner) on each edit — cheaper than a full re-render, and it keeps text
	// inputs from losing focus mid-type.
	function updateApplyState() {
		if (state.notice || state.error) {
			state.notice = null;
			state.error = null;
			var msgEl = document.getElementById("settingsFootMsg");
			if (msgEl) {
				msgEl.textContent = "";
				msgEl.className = "set-foot-msg";
			}
		}
		var btn = document.getElementById("applyBtn");
		if (btn) btn.disabled = state.busy === "apply" || !isDirty();
	}

	function sectionBody(section, s, f) {
		if (section === "agents") return agentsSection(f);
		if (section === "summary") return summarySection(s.summary || {}, f);
		if (section === "sync") return syncSection(s.summary || {});
		if (section === "bank") return bankSection(s.memoryBank || {}, f);
		if (section === "others") return othersSection(f);
		if (section === "advanced") return advancedSection(f);
		return "";
	}

	// A toggle row: label + hint on the left, switch on the right. `hint` is raw
	// HTML (static literals aligned to the VS Code panel; may carry <code>/<strong>).
	function toggleRow(id, label, checked, hint) {
		return (
			'<label class="set-toggle-row"><span class="set-toggle-text"><span class="set-toggle-label">' +
			esc(label) +
			'</span><span class="set-hint">' +
			(hint || "") +
			'</span></span><input type="checkbox" class="set-switch" data-field="' +
			id +
			'"' +
			(checked ? " checked" : "") +
			"/></label>"
		);
	}

	// A titled block — a bold heading over one area of a multi-area section (the
	// Claude settings-dialog grammar). Panels with a single area skip this.
	function block(title, html) {
		return '<section class="set-block"><h3 class="set-block-h">' + esc(title) + "</h3>" + html + "</section>";
	}

	function agentsSection(f) {
		var rows = AGENTS.map((p) => toggleRow(p[0], p[1], f[p[0]] === true, esc(p[2]))).join("");
		return (
			block(
				"Tracked agents",
				'<p class="section-hint">Choose which AI agents to track.</p>' +
					'<div class="set-group">' +
					rows +
					"</div>" +
					'<div class="set-note err" id="agentsError"></div>',
			) +
			block(
				"Global preferences",
				toggleRow(
					"globalInstructions",
					"Global Instructions",
					f.globalInstructions === "enabled",
					esc(GLOBAL_INSTRUCTIONS_HINT),
				),
			)
		);
	}

	function summarySection(sum, f) {
		var provider = f.aiProvider || "anthropic";
		var providerSelect =
			'<div class="set-row"><label class="set-label" for="aiProvider">Provider</label>' +
			'<select class="set-input" id="aiProvider" data-field="aiProvider">' +
			opt("anthropic", "Anthropic", provider) +
			opt("jolli", "Jolli", provider) +
			opt("local-agent", "Local Agent", provider) +
			"</select></div>" +
			'<p class="section-hint">Choose how AI summaries are generated for each commit.</p>';
		var card = provider === "anthropic" ? anthropicCard(f) : provider === "jolli" ? jolliCard(sum, f) : localAgentCard(sum, f);
		return block("Summarization", providerSelect + '<div class="set-subcard">' + card + "</div>");
	}

	function anthropicCard(f) {
		var model = f.model || "sonnet";
		// A configured full model id (e.g. "claude-opus-4-8") matches none of the three
		// preset aliases, so the browser would silently show the first option ("Haiku")
		// as if the config had changed. Surface the real value as its own selected
		// option instead; leaving the field untouched still submits it verbatim.
		var customModelOpt = model && ["haiku", "sonnet", "opus"].indexOf(model) === -1 ? opt(model, model, model) : "";
		var warn =
			f.apiKey === ""
				? '<div class="set-status warn"><span>⚠</span> API key is empty. AI summaries won\'t work without it.</div>'
				: "";
		return (
			warn +
			'<p class="section-hint">Calls go directly to Anthropic.</p>' +
			'<div class="set-row"><label class="set-label" for="apiKey">API Key' +
			'<span class="set-hint">Stored in ~/.jolli/jollimemory/config.json</span></label>' +
			'<input class="set-input" type="text" id="apiKey" data-field="apiKey" spellcheck="false" autocomplete="off" value="' +
			esc(f.apiKey) +
			'" placeholder="sk-ant-..."/></div>' +
			'<div class="set-row"><label class="set-label" for="model">Model</label>' +
			'<select class="set-input" id="model" data-field="model">' +
			customModelOpt +
			opt("haiku", "Haiku — fastest", model) +
			opt("sonnet", "Sonnet — balanced (default)", model) +
			opt("opus", "Opus — most capable", model) +
			"</select></div>" +
			'<div class="set-row"><label class="set-label" for="maxTokens">Max Output Tokens' +
			'<span class="set-hint">Default: 8192</span></label>' +
			'<input class="set-input" type="number" id="maxTokens" data-field="maxTokens" min="1" step="1" value="' +
			esc(f.maxTokens) +
			'" placeholder="8192"/></div>'
		);
	}

	function jolliCard(sum, f) {
		var status;
		if (sum.signedIn && sum.hasJolliKey) {
			status =
				'<div class="set-status ok"><span>✓</span> ' +
				esc(sum.jolliSiteLabel || "Using Jolli to generate summaries") +
				"</div>" +
				'<div class="set-row"><label class="set-label" for="jolliApiKey">Jolli API Key' +
				'<span class="set-hint">sk-jol-… — auto-filled on sign-in, or paste a new one</span></label>' +
				'<input class="set-input" type="text" id="jolliApiKey" data-field="jolliApiKey" spellcheck="false" autocomplete="off" value="' +
				esc(f.jolliApiKey) +
				'" placeholder="sk-jol-..."/></div>';
		} else if (sum.signedIn) {
			status =
				'<div class="set-status warn"><span>⚠</span> Signed in but Jolli API Key is missing.<br/>Re-login to get the key automatically, or enter it manually below.</div>' +
				'<button type="button" class="cta ghost sm" data-action="signout">Sign Out &amp; Re-login</button>' +
				'<div class="set-row"><label class="set-label" for="jolliApiKey">Jolli API Key<span class="set-hint">sk-jol-…</span></label>' +
				'<input class="set-input" type="text" id="jolliApiKey" data-field="jolliApiKey" spellcheck="false" autocomplete="off" value="' +
				esc(f.jolliApiKey) +
				'" placeholder="sk-jol-..."/></div>';
		} else {
			status =
				'<p class="section-hint">Sign in to use Jolli for AI summarization.</p>' +
				'<button type="button" class="cta sm" data-action="signin"' +
				(state.busy === "signin" ? " disabled" : "") +
				">" +
				(state.busy === "signin" ? "Waiting for browser…" : "Sign In to Jolli") +
				"</button>";
		}
		return status;
	}

	function localAgentCard(sum, f) {
		var tools = sum.localAgentTools || [];
		var current = f.localAgentTool || "claude-code";
		var options = tools.map((t) => opt(t.id, t.label, current)).join("");
		// Model row only for a tool jollimemory pins a model for. Keyed lookup, not
		// a "claude-code" string test: the server sends the map so the set of pinned
		// tools stays a server-side fact.
		var models = (sum.localAgentModels || {})[current] || [];
		// Resolve for DISPLAY only. `opt()` marks selected by strict equality, so a
		// value matching no option (an empty string from a payload without the
		// field, or a model belonging to the tool we just switched away from)
		// selects nothing and the browser silently shows the FIRST option — which
		// is the cheapest model, since every list (claude-code's and codex's alike)
		// is ordered by capability with its default in the middle. Resolve to the
		// server-marked default instead.
		//
		// Deliberately NOT written back into `f`. The form state is what gets
		// SUBMITTED, and the server stores it: writing the resolved value there
		// made merely visiting another tool in the picker overwrite a pin the user
		// never edited — pick codex and change your mind, and claude-code's `opus`
		// came back as `sonnet`. Worse for a tool that pins nothing, where the row
		// is hidden and there was nothing on screen to show it happening. The
		// server sends the RAW stored value for exactly this reason, so leaving `f`
		// alone makes an untouched save a no-op.
		var selected = f.localAgentModel;
		if (models.length > 0 && !models.some((m) => m.id === selected)) {
			var fallback = models.find((m) => m.isDefault) || models[0];
			selected = fallback.id;
		}
		var modelRow =
			models.length === 0
				? ""
				: '<div class="set-row"><label class="set-label" for="localAgentModel">Model</label>' +
					'<select class="set-input" id="localAgentModel" data-field="localAgentModel">' +
					models.map((m) => opt(m.id, m.label, selected)).join("") +
					"</select></div>";
		return (
			'<div class="set-row"><label class="set-label" for="localAgentTool">Agent tool</label>' +
			'<select class="set-input" id="localAgentTool" data-field="localAgentTool">' +
			options +
			"</select></div>" +
			modelRow +
			'<div class="set-row set-row-inline"><button type="button" class="cta ghost sm" data-action="probe"' +
			(state.busy === "probe" ? " disabled" : "") +
			">" +
			(state.busy === "probe" ? "Checking…" : "Check availability") +
			'</button><span class="set-status" id="probeStatus">' +
			esc(state.probeResult || "") +
			"</span></div>" +
			'<p class="section-hint">Uses your local agent\'s own login (subscription/BYOK). Sign in with that tool\'s CLI if prompted.</p>'
		);
	}

	// JOLLI-2152: the per-repo Jolli Space cell, rendered between the repo's
	// identity text and its push toggle. All state→text/class mapping happens
	// server-side (describeSpaceBindingColumn, reached via /api/settings/space-bindings)
	// — this only renders the already-formatted fields, mirroring the VS Code
	// webview's renderPushControl() so the two surfaces can't drift on wording.
	function spaceCellHtml(r) {
		if (state.spaceBindingsSignedOut) {
			return '<span class="set-space set-space-unknown" title="Sign in to Jolli to see which Space this repo pushes into.">—</span>';
		}
		var binding = state.spaceBindings && state.spaceBindings[r.repoIdentity];
		if (binding) {
			var cls = "set-space set-space-" + binding.state + (binding.degraded ? " set-space-degraded" : "");
			return (
				'<span class="' + cls + '"' + (binding.title ? ' title="' + esc(binding.title) + '"' : "") + ">" + esc(binding.label) + "</span>"
			);
		}
		if (state.spaceBindings === null) {
			return '<span class="set-space set-space-pending">Checking…</span>';
		}
		// spaceBindings has settled (object, possibly {}) but this repoIdentity
		// has no entry — never leave the cell silently blank.
		return '<span class="set-space set-space-unknown">Not checked</span>';
	}

	function syncSection(sum) {
		// Both outbound streams are named in the sign-in verdict — the line that says
		// what being signed in is FOR. It used to say "ready to push memories",
		// which names one of the two and reads as a denial of the other. What each
		// stream IS, and how far its switch reaches, is left to the two blocks
		// below: restating it here only put the same sentence on screen twice.
		var head = sum.signedIn
			? '<div class="set-status ok"><span>✓</span> Signed in — ready to push session statistics and memories</div>' +
				'<div class="set-row set-row-inline"><button type="button" class="cta ghost sm" data-action="signout">Sign Out</button></div>'
			: '<p class="section-hint">Sign in to push session statistics and memories to Jolli cloud. Nothing leaves this machine until you do.</p>' +
				'<div class="set-row set-row-inline"><button type="button" class="cta sm" data-action="signin"' +
				(state.busy === "signin" ? " disabled" : "") +
				">" +
				(state.busy === "signin" ? "Waiting for browser…" : "Sign In to Jolli") +
				"</button></div>";

		var list;
		if (state.pushError) list = '<div class="callout err">' + esc(state.pushError) + "</div>";
		else if (state.pushRepos === null) list = '<div class="set-hint">Loading…</div>';
		else if (state.pushRepos.length === 0)
			list = '<div class="set-hint">No repositories with a git remote are tracked on this machine yet.</div>';
		else
			list =
				(state.spaceBindingsSignedOut
					? '<p class="set-hint">Sign in to see which Jolli Space each repo pushes into.</p>'
					: "") +
				'<div class="set-group">' +
				state.pushRepos
					.map((r) => {
						// Per-repo result of the last immediate toggle, shown right under
						// its row (prominent, next to the switch) — matches the VS Code
						// panel, which renders the status here rather than in a far footer.
						var st =
							state.pushStatus && state.pushStatus.repoIdentity === r.repoIdentity
								? '<div class="set-push-status ' + state.pushStatus.kind + '">' + esc(state.pushStatus.text) + "</div>"
								: "";
						return (
							'<label class="set-toggle-row"><span class="set-toggle-text"><span class="set-toggle-label">' +
							esc(r.repoName) +
							(r.isCurrentRepo ? ' <span class="set-tag">this repo</span>' : "") +
							'</span><span class="set-hint">' +
							esc(r.repoIdentity) +
							"</span></span>" +
							spaceCellHtml(r) +
							'<input type="checkbox" class="set-switch" data-push="' +
							esc(r.repoIdentity) +
							'"' +
							(r.pushDisabled ? "" : " checked") +
							(r.isCurrentRepo ? ' data-current="1"' : "") +
							"/></label>" +
							st
						);
					})
					.join("") +
				"</div>";

		return (
			block("Account", head) +
			// Machine-wide, so it sits ABOVE the per-repo list rather than under it:
			// this switch is not one of the repos, and burying it below a list that
			// grows with every tracked repo is what made it hard to find in Others.
			block(
				"Session statistics — for the whole machine",
				// Immediate, like the per-repo switches below: this tab used to hold
				// one switch that waited for "Apply Changes" and a list of
				// identical-looking ones that did not, which is a difference no row
				// on screen can show. Both write on change now, and both report the
				// result on a status line under the row they belong to.
				'<label class="set-toggle-row"><span class="set-toggle-text"><span class="set-toggle-label">Sync session statistics</span><span class="set-hint">' +
					"Sends usage — tokens, cost, and which AI tools ran — to your Jolli organization, so the web" +
					" dashboard can chart it. <strong>Covers every repository Jolli is enabled in on this machine</strong>," +
					" connected to a Space or not, whatever the per-repository switches below say — a repository you turned" +
					" off with <code>jolli disable</code> is left out, and stays out: what it recorded before you turned it" +
					" off is not uploaded later either. <strong>Conversation text is never sent</strong> — but" +
					" session <em>titles</em> are, and many AI tools use your first message as the title; tool names include" +
					" any MCP servers you use. Your <em>memory search queries</em> are sent too — the words you type into" +
					" <code>jolli search</code>, or your agent types for you — because the dashboard's Top Search Terms" +
					" card is built from them." +
					'</span></span><input type="checkbox" class="set-switch" data-sync-sessions="1"' +
					(state.syncSessions !== false ? " checked" : "") +
					"/></label>" +
					(state.syncStatus
						? '<div class="set-push-status ' + state.syncStatus.kind + '">' + esc(state.syncStatus.text) + "</div>"
						: ""),
			) +
			block(
				"Memories — per repository",
				'<p class="section-hint">Turning a repository <strong>off</strong> keeps capturing its memories locally and blocks only the outbound sync — automatic and manual alike. Turn it back on and the retained backlog goes up on that repo’s next activity, right away for the repo you’re in now.</p>' +
					'<p class="section-hint">Every repository Jolli tracks on this machine is listed here, and a new one is allowed by default. A repo with no git remote is local-only and is managed from inside the repo instead.</p>' +
					list,
			)
		);
	}

	// Inline Folder Path verdict line, rendered from state.folderStatus (seeded in
	// the section markup, then live-updated by updateFolderStatusEl on blur/edit).
	function folderStatusHtml() {
		var e = state.folderStatus && FOLDER_STATUS[state.folderStatus];
		return (
			'<div class="set-folder-status' +
			(e && e[0] ? " " + e[0] : "") +
			'" id="localFolderStatus">' +
			(e ? esc(e[1]) : "") +
			"</div>"
		);
	}

	// Targeted DOM update (no full re-render → the input keeps focus while typing).
	function updateFolderStatusEl() {
		var el = document.getElementById("localFolderStatus");
		if (!el) return;
		var e = state.folderStatus && FOLDER_STATUS[state.folderStatus];
		el.className = "set-folder-status" + (e && e[0] ? " " + e[0] : "");
		el.textContent = e ? e[1] : "";
	}

	// Blur handler: ask the server whether the typed path exists / is usable. Purely
	// advisory (the save gate re-checks server-side); never creates anything. The
	// value re-read in .then guards against a reply landing after the user edited on.
	function checkFolder() {
		var input = document.getElementById("localFolder");
		if (!input) return;
		var path = input.value.trim();
		if (!path) {
			state.folderStatus = null;
			updateFolderStatusEl();
			return;
		}
		state.folderStatus = "checking";
		updateFolderStatusEl();
		JD.getJson("/api/settings/check-folder?path=" + encodeURIComponent(path))
			.then((data) => {
				if (input.value.trim() === path) {
					state.folderStatus = data.status;
					updateFolderStatusEl();
				}
			})
			.catch(() => {
				state.folderStatus = null;
				updateFolderStatusEl();
			});
	}

	function bankSection(mb, f) {
		// Migrate / Generate act on the LAUNCH repo (serverCwd), not whichever repo
		// the dashboard is currently scoped to — so name it (same label as the
		// section's state tag) rather than a bare "this repo", falling back to the
		// generic phrase when the launch repo isn't resolvable.
		var launchName = mb.repoLabel ? '<span class="set-hl">' + esc(mb.repoLabel) + "</span>" : "";
		// Effective Memory Bank verdict for the launch repo — a ✓/⚠/○ line per
		// severity (matches the VS Code panel). "ok" names the resolved per-repo
		// folder (where memories land); the repo tag names which repo it's for.
		var stateIcon = mb.state && (mb.state.severity === "warn" ? "⚠" : mb.state.severity === "off" ? "○" : "✓");
		var stateLine = mb.state
			? '<div class="set-status ' +
				(mb.state.severity === "warn" ? "warn" : mb.state.severity === "off" ? "off" : "ok") +
				'"><span aria-hidden="true">' +
				stateIcon +
				"</span> " +
				esc(mb.state.text) +
				(mb.repoLabel ? ' <span class="set-tag">' + esc(mb.repoLabel) + "</span>" : "") +
				"</div>"
			: "";
		// Count line names the current repo (highlighted) and mirrors the VS Code
		// wording. `where` falls back to "this repository" when the repo name is
		// absent (older payload / not resolvable).
		var missing;
		if (state.missing === undefined) {
			missing = "Checking for commits without a summary…";
		} else if (state.missing && state.missing.missing != null) {
			var where = state.missing.repoName
				? ' in <span class="set-hl">' + esc(state.missing.repoName) + "</span>"
				: " in this repository";
			missing =
				state.missing.missing === 0
					? "All your commits" + where + " already have summaries."
					: esc(state.missing.missing) + " of your commits" + where + " still need summaries.";
		} else {
			missing = "";
		}

		return (
			block(
				"Memory Bank folder",
				'<div class="set-row"><label class="set-label" for="localFolder">Folder Path' +
					'<span class="set-hint">Absolute path to the Memory Bank root on disk — the folder must already exist (create it first if it\'s new). Each repo gets its own subfolder.</span></label>' +
					'<div class="set-folder-row"><input class="set-input" type="text" id="localFolder" data-field="localFolder" spellcheck="false" autocomplete="off" value="' +
					esc(f.localFolder) +
					'" placeholder="Absolute folder path"/>' +
					folderStatusHtml() +
					"</div></div>" +
					(stateLine ? '<div class="set-row">' + stateLine + "</div>" : "") +
					'<div class="set-row"><label class="set-label" for="compileExcludeFolders">Compile Exclude Folders' +
					'<span class="set-hint">Repo subfolders under the Memory Bank to skip during multi-repo <code>jolli compile</code>. Comma-separated names; exact match or <code>*</code> glob, e.g. <code>archive</code>, <code>tmp-*</code>.</span></label>' +
					'<input class="set-input" type="text" id="compileExcludeFolders" data-field="compileExcludeFolders" spellcheck="false" value="' +
					esc(f.compileExcludeFolders) +
					'" placeholder="archive, experiments-*"/></div>',
			) +
			block(
				"Migration & sync",
				'<div class="set-row set-row-inline"><button type="button" class="cta ghost sm" data-action="migrate"' +
					(state.busy === "migrate" ? " disabled" : "") +
					">" +
					(state.busy === "migrate" ? "Migrating…" : "Migrate to Memory Bank") +
					"</button></div>" +
					'<div class="set-hint">Re-migrate ' +
					(launchName || "this repo") +
					' from the orphan branch into a fresh Memory Bank folder. The existing folder is preserved (a new <code>-2</code>-suffixed folder is created and the repo registry is repointed).</div>' +
					'<div class="set-row set-row-inline"><button type="button" class="cta ghost sm" data-action="syncNow"' +
					(state.busy === "syncNow" ? " disabled" : "") +
					">" +
					(state.busy === "syncNow" ? "Syncing…" : "Sync to Personal Space Now") +
					"</button><span class=\"set-hint\">Push " +
					(launchName ? launchName + "’s" : "this") +
					" Memory Bank to your <strong>private</strong> Personal Space. Requires Jolli sign-in.</span></div>" +
					toggleRow(
						"syncTranscripts",
						"Include transcripts (raw AI conversation logs)",
						f.syncTranscripts === true,
						"Off by default. Transcripts may include pasted code, tokens, or sensitive snippets. Applies to both manual and auto-sync.",
					) +
					'<div class="set-row"><div class="warning-banner">⚠ Pick a <code>localFolder</code> only Jolli writes to. Sharing it with iCloud / Dropbox / Syncthing races on the same files — and turning off auto-sync isn\'t enough, since manual sync still writes.</div></div>',
			) +
			block(
				"Backfill",
				'<div class="set-row set-row-inline"><button type="button" class="cta ghost sm" data-action="generate"' +
					(state.busy === "generate" ? " disabled" : "") +
					">" +
					(state.busy === "generate" ? "Generating…" : "Generate Missing Summaries") +
					"</button></div>" +
					'<div class="set-hint"><span>' +
					missing +
					"</span> Generates summaries for your own past commits in " +
					(launchName || "this repository") +
					" that don't have one yet — using the Claude Code conversation behind each commit when it can be found, otherwise summarizing the code change alone. Runs one AI call per commit, so it may take a while.</div>",
			)
		);
	}

	function othersSection(f) {
		return (
			block(
				"Commits",
				toggleRow(
					"dcoSignoff",
					"Sign commits with DCO",
					f.dcoSignoff === true,
					"Adds a <code>Signed-off-by</code> trailer (<code>git commit -s</code>) to commits made by Jolli Memory (commit / amend / squash). Required by many open-source projects' CI.",
				),
			) +
			block(
				"Files",
				'<div class="set-row"><label class="set-label" for="excludePatterns">Exclude Patterns' +
					'<span class="set-hint">Hide files from the Changes panel and AI commits. Comma-separated globs, e.g. <code>**/*.vsix</code>, <code>dist/**</code>, <code>node_modules/*</code>.</span></label>' +
					'<input class="set-input" type="text" id="excludePatterns" data-field="excludePatterns" spellcheck="false" value="' +
					esc(f.excludePatterns) +
					'" placeholder="**/*.vsix, docs/*.md"/></div>',
			)
		);
	}

	// The sidebar's two optional rows. Hidden by default, so this section is the
	// only place a reader finds out those pages exist at all — which is why each
	// hint describes what the page IS and what it is for, rather than how it is
	// produced. Three things are deliberately absent from this copy. "Memory Bank"
	// is the VS Code panel's name for the folder and means nothing on this surface,
	// so Knowledge is described by what it shows. `jolli compile` is the command
	// that builds both, and a reader deciding whether to show a menu row does not
	// need it (the pages' own empty states name it, which is where it matters). And
	// the row-only scope stays in the section hint rather than being repeated per
	// row: it is one fact about both switches.
	function advancedSection(f) {
		return block(
			"Sidebar menu",
			'<p class="section-hint">Extra pages for the left menu, off by default. Switching one off just hides its row — nothing stops being generated, and the page stays reachable by URL.</p>' +
				'<div class="set-group">' +
				toggleRow(
					"dashboardKnowledgeMenuEnabled",
					"Show Knowledge",
					f.dashboardKnowledgeMenuEnabled === true,
					// "Source Commits" is the literal heading `WikiMarkdownBuilder` writes
					// at the foot of every topic page, and those links are the ones the
					// wiki viewer rewrites into memory jumps — so this names the real
					// affordance rather than implying every sentence is a link.
					"A reading view over the knowledge distilled from your commits. Search topic pages across your repositories, open one in the side pane, and follow its <strong>Source Commits</strong> list back to the memories it was built from.",
				) +
				toggleRow(
					"dashboardGraphMenuEnabled",
					"Show Graph",
					f.dashboardGraphMenuEnabled === true,
					"The visual companion to Knowledge: the same distilled decisions and gotchas drawn as a graph, so you can follow the relationships between them — and spot the clusters a list never shows.",
				) +
				"</div>",
		);
	}

	function opt(value, label, current) {
		return '<option value="' + esc(value) + '"' + (value === current ? " selected" : "") + ">" + esc(label) + "</option>";
	}

	// ── Controlled form ────────────────────────────────────────────────────────
	function captureField(el) {
		var field = el.getAttribute("data-field");
		if (!field) return;
		if (field === "globalInstructions") {
			state.form.globalInstructions = el.checked ? "enabled" : state.originalGi === "default" ? "default" : "disabled";
			return;
		}
		state.form[field] = el.type === "checkbox" ? el.checked === true : el.value;
	}

	function collect() {
		var f = state.form;
		var out = {
			globalInstructions: f.globalInstructions,
			aiProvider: f.aiProvider,
			model: f.model,
			apiKey: f.apiKey,
			jolliApiKey: f.jolliApiKey,
			localAgentTool: f.localAgentTool,
			localAgentModel: f.localAgentModel,
			localFolder: f.localFolder,
			compileExcludeFolders: f.compileExcludeFolders,
			syncTranscripts: f.syncTranscripts === true,
			// `syncSessions` is deliberately absent: it has its own immediate endpoint,
			// and the server leaves an unmentioned value alone. Submitting the field
			// here would let a batched Apply undo a toggle made after the page loaded.
			dcoSignoff: f.dcoSignoff === true,
			excludePatterns: f.excludePatterns,
			dashboardKnowledgeMenuEnabled: f.dashboardKnowledgeMenuEnabled === true,
			dashboardGraphMenuEnabled: f.dashboardGraphMenuEnabled === true,
		};
		AGENTS.forEach((pair) => {
			out[pair[0]] = f[pair[0]] === true;
		});
		if (String(f.maxTokens) !== "" && !Number.isNaN(Number(f.maxTokens))) out.maxTokens = Number(f.maxTokens);
		return out;
	}

	// ── Wiring ────────────────────────────────────────────────────────────────
	function wire(model) {
		wireClose();
		Array.prototype.forEach.call(document.querySelectorAll("#" + MOUNT + " .set-rail-item"), (btn) => {
			btn.onclick = () => {
				state.section = btn.getAttribute("data-section");
				state.notice = null;
				state.error = null;
				// Clear a prior push-list load failure so re-entering Sync retries it
				// (the wire() guard skips the fetch while pushError is set), and drop a
				// stale per-row toggle status.
				state.pushError = null;
				state.pushStatus = null;
				state.syncStatus = null;
				state.spaceBindingsError = null;
				render(model);
			};
		});

		Array.prototype.forEach.call(document.querySelectorAll("#" + MOUNT + " [data-field]"), (el) => {
			var field = el.getAttribute("data-field");
			// The Agent tool re-renders too: the Model row is derived from the
			// selected tool, so without this it keeps showing the previous tool's
			// options — offering models for a tool that pins none, or hiding the
			// row for one that does — until an unrelated provider toggle happens
			// to re-render. This is the whole reason localAgentModels is keyed by
			// tool rather than scoped to the stored one.
			var rerender = field === "aiProvider" || field === "localAgentTool";
			var isFolder = field === "localFolder";
			el.onchange = () => {
				captureField(el);
				if (rerender) render(model);
				else updateApplyState();
			};
			el.oninput = () => {
				captureField(el);
				updateApplyState();
				// A fresh edit invalidates the last folder verdict; re-checked on blur.
				if (isFolder && state.folderStatus) {
					state.folderStatus = null;
					updateFolderStatusEl();
				}
			};
			// Advisory existence check when focus leaves the Folder Path field.
			if (isFolder) el.onblur = () => checkFolder();
		});

		var apply = document.getElementById("applyBtn");
		if (apply) apply.onclick = () => doApply(model);

		Array.prototype.forEach.call(document.querySelectorAll("#" + MOUNT + " [data-action]"), (btn) => {
			btn.onclick = () => doAction(model, btn.getAttribute("data-action"));
		});

		var syncBox = document.querySelector("#" + MOUNT + " [data-sync-sessions]");
		if (syncBox) syncBox.onchange = () => toggleSyncSessions(model, syncBox.checked === true);

		Array.prototype.forEach.call(document.querySelectorAll("#" + MOUNT + " [data-push]"), (box) => {
			box.onchange = () =>
				togglePush(model, box.getAttribute("data-push"), !box.checked, box.getAttribute("data-current") === "1");
		});

		// `!state.pushError` is load-bearing: on a failed load `pushRepos` stays null,
		// and render() → wire() would otherwise re-fire loadPushRepos on every render,
		// hammering a 500ing endpoint forever. The error render sets pushError, which
		// closes the guard until the user retries (a rail switch clears it).
		if (state.section === "sync" && state.pushRepos === null && !state.pushError) loadPushRepos(model);
		// Same shape, independent endpoint (JOLLI-2152) — a failed push-repos load
		// must not also block the Space column from loading, and vice versa.
		if (state.section === "sync" && state.spaceBindings === null && !state.spaceBindingsError) loadSpaceBindings(model);
		if (state.section === "bank" && state.missing === undefined) loadMissing(model);
	}

	function doApply(model) {
		// At least one agent must be enabled (matches the VS Code validation).
		var f = state.form;
		if (!AGENTS.some((p) => f[p[0]] === true)) {
			state.error = "At least one AI agent must be enabled";
			render(model);
			return;
		}
		state.busy = "apply";
		state.error = null;
		state.notice = null;
		var payload = collect();
		// Whether the SIDEBAR now needs repainting. `refreshSettings` refetches the
		// settings payload into the modal, which cannot touch the sidebar — that is
		// rendered from `window.__JOLLI_DASHBOARD__` by the page — so an Advanced
		// change needs a page-level refresh too, or the row the user just switched on
		// stays absent until they reload. Conditional because that refresh repaints
		// the whole page under the modal (on /graph that rebuilds the iframe and
		// loses its pan/zoom): worth it when the nav moved, gratuitous on every
		// other save.
		//
		// Compared against the PAGE's model, never the modal's own: the question is
		// "does what the sidebar is showing still match what we just saved?", and the
		// sidebar was rendered from that payload. Asking the modal's copy instead got
		// it exactly backwards whenever the two had drifted — another tab switching a
		// row off moves the page model (the 30 s poll on My Dashboard picks it up)
		// while the open modal still holds the old value, so re-saving from here
		// would look unchanged and skip the repaint that was now most needed.
		var menus = (window.__JOLLI_DASHBOARD__ || {}).menus || {};
		var menusChanged =
			payload.dashboardKnowledgeMenuEnabled !== (menus.knowledge === true) ||
			payload.dashboardGraphMenuEnabled !== (menus.graph === true);
		render(model);
		JD.post("/api/settings/apply", payload)
			.then((data) => {
				state.busy = null;
				var failures = (data && data.hookFailures) || [];
				state.notice = failures.length
					? "Settings saved. " + failures.length + " repo hook(s) could not be synced — see the server log."
					: "Settings saved";
				refreshSettings();
				// Two independent refetches, and the order they LAND in does not matter:
				// this one rewrites the sidebar, the topbar and `#app`, while
				// refreshSettings rewrites `#settingsModalBody` — a sibling of `#app`,
				// not a child (see index.html), so neither can overwrite the other.
				// `JD.renderPage` is assigned by main.js, which loads after this module —
				// guarded for the same load-order reason `window.JD` itself is, not
				// because it is expected to be missing at click time.
				if (menusChanged && JD.refreshNow && JD.renderPage) JD.refreshNow(JD.renderPage);
			})
			.catch((err) => {
				state.busy = null;
				state.error = err.message || "Could not save settings.";
				render(model);
			});
	}

	function doAction(model, action) {
		if (action === "signin") return doSignIn(model);
		if (action === "signout") return doSignOut(model);
		if (action === "probe") return doProbe(model);
		if (action === "migrate") return doSimpleAction(model, "migrate", "/api/settings/migrate", "Migrated.");
		if (action === "syncNow") return doSimpleAction(model, "syncNow", "/api/settings/sync-now", "Synced to Personal Space.");
		if (action === "generate") return doGenerate(model);
	}

	function doSimpleAction(model, busy, path, okMsg) {
		state.busy = busy;
		state.error = null;
		state.notice = null;
		render(model);
		JD.post(path, {})
			.then((data) => {
				state.busy = null;
				state.notice = (data && data.message) || okMsg;
				render(model);
			})
			.catch((err) => {
				state.busy = null;
				state.error = err.message || "Action failed.";
				render(model);
			});
	}

	function doGenerate(model) {
		state.busy = "generate";
		state.error = null;
		state.notice = null;
		render(model);
		JD.post("/api/settings/generate-missing", {})
			.then((data) => {
				state.busy = null;
				state.notice =
					"Generated " + (data.generated || 0) + " summaries" + (data.errors ? ", " + data.errors + " failed" : "") + ".";
				state.missing = undefined;
				render(model);
			})
			.catch((err) => {
				state.busy = null;
				state.error = err.message || "Could not generate summaries.";
				render(model);
			});
	}

	function doSignIn(model) {
		state.busy = "signin";
		state.error = null;
		state.notice = "A browser tab has opened — complete sign-in there.";
		render(model);
		JD.post("/api/settings/signin", {})
			.then(() => {
				state.busy = null;
				state.notice = null;
				state.form = null;
				// JOLLI-2152: otherwise the Space column stays stuck on whatever it
				// showed before sign-in (the "sign in to see Spaces" hint) forever,
				// since nothing else re-fetches it mid-session — same fix as the VS
				// Code panel's postAuthState(). spaceBindingsSignedOut must be cleared
				// here too, not just spaceBindings/spaceBindingsError: spaceCellHtml
				// checks it first, so leaving it true renders "Sign in to see…" for
				// the render(s) between this success callback and the moment
				// loadSpaceBindings's own response lands.
				state.spaceBindings = null;
				state.spaceBindingsSignedOut = false;
				state.spaceBindingsError = null;
				// Bump here, not just inside loadSpaceBindings(): an old in-flight
				// fetch from before sign-in can still land after this reset but
				// before wire() re-triggers a fresh load. Without bumping now, that
				// stale reply's captured seq still matches state.spaceBindingsRequestSeq
				// and it briefly renders the pre-sign-in Space for one frame.
				state.spaceBindingsRequestSeq++;
				refreshSettings();
			})
			.catch((err) => {
				state.busy = null;
				state.notice = null;
				state.error = err.message || "Sign-in failed.";
				render(model);
			});
	}

	function doSignOut(model) {
		state.busy = "signout";
		render(model);
		JD.post("/api/settings/signout", {})
			.then(() => {
				state.busy = null;
				state.form = null;
				// Same reasoning as doSignIn: a stale BOUND Space must not keep
				// displaying after the user has actually signed out — including the
				// requestSeq bump, so an old in-flight fetch from before sign-out
				// can't render for one frame before wire() corrects it.
				state.spaceBindings = null;
				state.spaceBindingsError = null;
				state.spaceBindingsRequestSeq++;
				refreshSettings();
			})
			.catch((err) => {
				state.busy = null;
				state.error = err.message || "Could not sign out.";
				render(model);
			});
	}

	function doProbe(model) {
		state.busy = "probe";
		state.probeResult = null;
		render(model);
		var el = document.getElementById("localAgentTool");
		var tool = el ? el.value : "claude-code";
		JD.post("/api/settings/probe-local-agent", { tool: tool })
			.then((data) => {
				state.busy = null;
				state.probeResult = data.usable ? "✓ available" : "not available — check its sign-in";
				render(model);
			})
			.catch((err) => {
				state.busy = null;
				state.error = err.message || "Probe failed.";
				render(model);
			});
	}

	// Per-repo push status wording, matched verbatim to the VS Code panel
	// (SettingsWebviewPanel.handleSetPushDisabled) so the two surfaces read
	// identically. `recovered` = the store was corrupt and was rebuilt from empty
	// (the dashboard endpoint reports no `preservedAt`, so that clause is omitted).
	function pushStatusText(disabled, isCurrent, recovered) {
		if (recovered) {
			return "Enabled ✓ — but the setting file was unreadable and was rebuilt, so every other repository's opt-out was reset to ON.";
		}
		if (disabled) return "Disabled — this repo's memory stays local ✓";
		return isCurrent
			? "Enabled — syncing retained memory now ✓"
			: "Enabled ✓ — backlog will sync on this repo's next activity";
	}

	/**
	 * The machine-wide session-statistics switch — immediate-apply, in the same
	 * shape as `togglePush` below: post, report under the row, and on failure say
	 * plainly that nothing changed and put the checkbox back where it was.
	 */
	function toggleSyncSessions(model, enabled) {
		JD.post("/api/settings/set-sync-sessions", { enabled: enabled })
			.then((data) => {
				state.syncSessions = data.syncSessions !== false;
				state.syncStatus = {
					text: state.syncSessions
						? "Enabled — session statistics upload from every repository on this machine ✓"
						: "Disabled — nothing is uploaded, on any repository ✓",
					kind: "ok",
				};
				render(model);
			})
			.catch(() => {
				state.syncStatus = {
					text: "Couldn't change session-statistics sync — see logs. No change was made.",
					kind: "err",
				};
				render(model);
			});
	}

	function togglePush(model, repoIdentity, disabled, isCurrent) {
		JD.post("/api/settings/set-push", { repoIdentity: repoIdentity, disabled: disabled, isCurrentRepo: isCurrent })
			.then((data) => {
				// Immediate-apply (no "Apply Changes") — report the result on a status
				// line under the toggled row, wording matched to the VS Code panel.
				state.pushStatus = {
					repoIdentity: repoIdentity,
					text: pushStatusText(data.disabled === true, isCurrent, data.recoveredFromCorrupt === true),
					kind: data.recoveredFromCorrupt ? "warn" : "ok",
				};
				if (state.pushRepos) {
					state.pushRepos = state.pushRepos.map((r) =>
						r.repoIdentity === repoIdentity ? Object.assign({}, r, { pushDisabled: data.disabled }) : r,
					);
				}
				render(model);
			})
			.catch(() => {
				// Same as the VS Code panel: show the failure under the row and reload the
				// persisted list so the checkbox snaps back to what was actually stored.
				state.pushStatus = {
					repoIdentity: repoIdentity,
					text: "Couldn't update outbound push — see logs. No change was made.",
					kind: "err",
				};
				loadPushRepos(model);
			});
	}

	function loadPushRepos(model) {
		JD.getJson("/api/settings/push-repos")
			.then((data) => {
				state.pushRepos = data.repos || [];
				state.pushError = null;
				if (state.section === "sync") render(model);
			})
			.catch((err) => {
				state.pushError = err.message || "Could not list repositories.";
				if (state.section === "sync") render(model);
			});
	}

	// JOLLI-2152: off the push-repos list's own first paint (own endpoint,
	// fetched independently — see the server-side route's comment). On failure,
	// spaceBindingsError is set so the wire() guard retries on the next visit to
	// this section, matching loadPushRepos' own retry-on-reentry shape.
	//
	// Re-entrant: doSignIn/doSignOut reset spaceBindings to null and call this
	// again while an earlier call can still be in flight (e.g. sign-out fires
	// while the initial fetch is still resolving). requestSeq guards against
	// the earlier, now-stale reply landing afterwards and overwriting the
	// newer one — see the state field's own comment. spaceBindingsFetchInFlight
	// additionally coalesces the overlapping call into a single queued rerun
	// instead of starting a second, wasted GET — see its own comment. Unlike
	// VS Code's twin (SettingsWebviewPanel.refreshSpaceBindings), there is no
	// fast signed-out short-circuit to protect from the lock: the signed-out
	// answer here still comes from this same endpoint, so it is never faster
	// than the network fan-out it would otherwise queue behind.
	function loadSpaceBindings(model) {
		if (state.spaceBindingsFetchInFlight) {
			state.spaceBindingsFetchQueued = true;
			return;
		}
		state.spaceBindingsFetchInFlight = true;
		var requestSeq = ++state.spaceBindingsRequestSeq;
		JD.getJson("/api/settings/space-bindings")
			.then((data) => {
				finishSpaceBindingsFetch(model, () => {
					if (requestSeq !== state.spaceBindingsRequestSeq) return;
					state.spaceBindings = (data && data.bindings) || {};
					state.spaceBindingsSignedOut = !!(data && data.signedOut);
					state.spaceBindingsError = null;
				});
			})
			.catch(() => {
				finishSpaceBindingsFetch(model, () => {
					if (requestSeq !== state.spaceBindingsRequestSeq) return;
					// Settle spaceBindings to {} as well, not just the error flag.
					// JD.getJson REJECTS on a non-2xx (including this endpoint's own
					// 500), and spaceCellHtml reads `spaceBindings === null` as
					// "still checking" — so leaving it null parks every cell on
					// "Checking…" for ever, while spaceBindingsError closes the
					// wire() retry guard behind it. An empty object falls through to
					// the settled-but-missing branch ("Not checked"), which is what
					// the VS Code panel's own catch already renders.
					state.spaceBindings = {};
					state.spaceBindingsError = "failed";
				});
			});
	}

	// Shared tail for both loadSpaceBindings() branches: apply the result (only
	// while still current — the seq check inside applyResult), clear the
	// in-flight flag, then either immediately start the queued rerun a skipped
	// overlapping call left behind, or render. Draining the queue takes
	// priority over rendering — no point painting a frame that a fetch already
	// waiting to start will just repaint moments later.
	function finishSpaceBindingsFetch(model, applyResult) {
		state.spaceBindingsFetchInFlight = false;
		applyResult();
		if (state.spaceBindingsFetchQueued) {
			state.spaceBindingsFetchQueued = false;
			loadSpaceBindings(model);
			return;
		}
		if (state.section === "sync") render(model);
	}

	function loadMissing(model) {
		JD.getJson("/api/settings/missing-summaries")
			.then((data) => {
				state.missing = data && data.missing != null ? data : null;
				if (state.section === "bank") render(model);
			})
			.catch(() => {
				state.missing = null;
				if (state.section === "bank") render(model);
			});
	}

	// Retained for the asset smoke test, which drives the renderer directly.
	JD.renderSettings = (model) => render(model);
})(window.JD);
