window.JD = window.JD || {};

((JD) => {
	/**
	 * Settings — opened as a MODAL over any page (like the Claude settings dialog),
	 * not a routed page. `JD.openSettings()` fetches the settings model via
	 * `/api/model?view=settings`, then renders a left section rail + content into
	 * the modal body. Five sections mirror the VS Code settings panel's tabs, and
	 * every label / hint / placeholder / button text is aligned to that panel
	 * verbatim (SettingsHtmlBuilder.ts) so the two surfaces read identically.
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

	function initForm(s) {
		var a = s.agents || {};
		var sum = s.summary || {};
		var mb = s.memoryBank || {};
		var others = s.others || {};
		var form = {
			globalInstructions: a.globalInstructions || "default",
			aiProvider: sum.aiProvider || "anthropic",
			model: sum.model || "sonnet",
			maxTokens: sum.maxTokens != null ? String(sum.maxTokens) : "",
			apiKey: sum.apiKeyMasked || "",
			jolliApiKey: sum.jolliApiKeyMasked || "",
			localAgentTool: sum.localAgentTool || "claude-code",
			localAgentModel: sum.localAgentModel || "",
			localFolder: mb.localFolder || "",
			compileExcludeFolders: mb.compileExcludeFolders || "",
			syncTranscripts: mb.syncTranscripts === true,
			dcoSignoff: others.dcoSignoff === true,
			excludePatterns: others.excludePatterns || "",
		};
		AGENTS.forEach((pair) => {
			form[pair[0]] = a[pair[0]] !== false;
		});
		state.originalGi = a.globalInstructions || "default";
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
			state.form = initForm(s);
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
		// tools stays a server-side fact. An empty stored value selects the default
		// entry, which is why the fallback is DEFAULT_LOCAL_AGENT_MODEL's id.
		var models = (sum.localAgentModels || {})[current] || [];
		var modelRow =
			models.length === 0
				? ""
				: '<div class="set-row"><label class="set-label" for="localAgentModel">Model</label>' +
					'<select class="set-input" id="localAgentModel" data-field="localAgentModel">' +
					models.map((m) => opt(m.id, m.label, f.localAgentModel)).join("") +
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

	function syncSection(sum) {
		var head = sum.signedIn
			? '<div class="set-status ok"><span>✓</span> Signed in — ready to push memories</div>' +
				'<div class="set-row set-row-inline"><button type="button" class="cta ghost sm" data-action="signout">Sign Out</button></div>'
			: '<p class="section-hint">Sign in to push memories to Jolli cloud.</p>' +
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
							'</span></span><input type="checkbox" class="set-switch" data-push="' +
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
			block(
				"Outbound push per repo",
				'<p class="section-hint">Every repository on this machine that Jolli tracks. Turning one <strong>off</strong> keeps capturing its memory locally but blocks all outbound sync (auto and manual). New repos are allowed by default. <strong>Each toggle applies immediately</strong> — no “Apply Changes” needed. Re-enabling a repo syncs its retained backlog on that repo’s next activity (right away for the repo you’re currently in). (Local-only repos with no git remote are managed from within the repo instead.)</p>' +
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
			dcoSignoff: f.dcoSignoff === true,
			excludePatterns: f.excludePatterns,
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

		Array.prototype.forEach.call(document.querySelectorAll("#" + MOUNT + " [data-push]"), (box) => {
			box.onchange = () =>
				togglePush(model, box.getAttribute("data-push"), !box.checked, box.getAttribute("data-current") === "1");
		});

		// `!state.pushError` is load-bearing: on a failed load `pushRepos` stays null,
		// and render() → wire() would otherwise re-fire loadPushRepos on every render,
		// hammering a 500ing endpoint forever. The error render sets pushError, which
		// closes the guard until the user retries (a rail switch clears it).
		if (state.section === "sync" && state.pushRepos === null && !state.pushError) loadPushRepos(model);
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
		render(model);
		JD.post("/api/settings/apply", payload)
			.then((data) => {
				state.busy = null;
				var failures = (data && data.hookFailures) || [];
				state.notice = failures.length
					? "Settings saved. " + failures.length + " repo hook(s) could not be synced — see the server log."
					: "Settings saved";
				refreshSettings();
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
