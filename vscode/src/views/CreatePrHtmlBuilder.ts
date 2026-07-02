/**
 * CreatePrHtmlBuilder
 *
 * Builds the complete HTML document for the "Create PR" webview pane.
 * Follows the same document skeleton, CSP, and nonce pattern as
 * NoteEditorHtmlBuilder — style-src and script-src are nonce-gated;
 * no inline `style=""` attributes and no inline event handlers (CSP forbids
 * both).
 *
 * Markdown rendering: `bodyMarkdown` is rendered to formatted HTML server-side
 * by {@link renderPrBodyMarkdown} (headings, bold, lists, code, quotes, plus
 * native `<details>` folding), so the body reads like the memory detail view
 * instead of raw monospace text.
 */

import type { CreatePrViewModel } from "./CreatePrData.js";
import { renderPrBodyMarkdown } from "./CreatePrBodyMarkdown.js";
// Reuse the shared attribute escaper rather than a private copy — both escape
// the same five chars (&, ", ', <, >), & first to avoid double-escaping.
import { escAttr as esc } from "./SummaryUtils.js";

function buildMetaStrip(vm: CreatePrViewModel): string {
	const countLabel = vm.memoryCount === 1 ? "memory" : "memories";
	const fileLabel = vm.filesChanged === 1 ? "file" : "files";
	// When an open PR already exists, show a clickable "PR #N" pill that opens
	// it on GitHub (wired via addEventListener in buildScript — CSP forbids
	// inline handlers). data-pr-url carries the target so the script needn't
	// reconstruct it.
	const prLink = vm.existingPr
		? `<span class="meta-sep">·</span>` +
			`<span class="pr-open-link" id="pr-open-link" role="link" tabindex="0" ` +
			`data-pr-url="${esc(vm.existingPr.url)}">PR #${vm.existingPr.number}</span>`
		: "";
	return (
		`<div class="meta-strip">` +
		`<span class="meta-branch">${esc(vm.branch)}</span>` +
		`<span class="meta-sep">→</span>` +
		`<span class="meta-branch">${esc(vm.mainBranch)}</span>` +
		prLink +
		`<span class="meta-sep">·</span>` +
		`<span>drafted from ${vm.memoryCount} ${countLabel}</span>` +
		`<span class="meta-sep">·</span>` +
		`<span class="ship-status">+${vm.insertions} −${vm.deletions} · ${vm.filesChanged} ${fileLabel}</span>` +
		`</div>`
	);
}

function buildMemoryRows(vm: CreatePrViewModel): string {
	return vm.memories
		.map(
			(m) =>
				`<div class="row" data-hash="${esc(m.hash)}">` +
				`<span class="mem-ico">▤</span>` +
				`<div class="r-main">` +
				`<div class="r-title">${esc(m.title)}</div>` +
				`<div class="r-sub">` +
				`<span class="meta-hash">${esc(m.hash.slice(0, 8))}</span>` +
				(m.prNumber !== undefined ? ` · PR #${m.prNumber}` : "") +
				`</div>` +
				`</div>` +
				`</div>`,
		)
		.join("");
}

function buildFileRows(vm: CreatePrViewModel): string {
	return vm.files
		.map((f) => {
			const fname = f.path.split("/").pop() ?? f.path;
			return (
				`<div class="row" data-path="${esc(f.path)}">` +
				`<div class="r-main">` +
				`<div class="r-title fname-${esc(f.status)}">${esc(fname)}</div>` +
				`<div class="r-sub">${esc(f.dir)}</div>` +
				`</div>` +
				`<span class="gs gs-${esc(f.status)}">${esc(f.status)}</span>` +
				`</div>`
			);
		})
		.join("");
}

function buildE2ePanel(vm: CreatePrViewModel): string {
	// `e2eScenarios` is typed as a required array, but this summary is
	// deserialized from orphan-branch JSON with no read-time schema validation —
	// an older schema, a hand-edited file, or a partial write can leave it a
	// non-array (or an individual field below undefined/non-array). Guard at BOTH
	// levels so a malformed summary degrades to empty instead of throwing: the
	// container spread/`.length` here would throw BEFORE the per-scenario guard
	// runs, and in this single synchronous build with no render try/catch that
	// TypeError would white-screen the entire Create-PR panel and block opening
	// any PR.
	// Annotate the element type explicitly: `Array.isArray` narrows a readonly
	// array to `any[]`, which would infect the `.map` callback params with `any`
	// (noExplicitAny is a biome error). The view model's own type restores it.
	const scenarios: CreatePrViewModel["e2eScenarios"] = Array.isArray(vm.e2eScenarios) ? vm.e2eScenarios : [];
	if (scenarios.length === 0) return "";
	const scenarioLabel = scenarios.length === 1 ? "SCENARIO" : "SCENARIOS";
	const scenarioHtml = scenarios
		.map((s) => {
			const steps = Array.isArray(s.steps) ? s.steps : [];
			const expected = Array.isArray(s.expectedResults) ? s.expectedResults : [];
			// `esc` (escAttr) calls `.replace` with no coercion, so any non-string
			// value from the same malformed-JSON class throws. Coerce the title AND
			// every step / expectedResult element (`[null]`, `[42]` etc.) to a string.
			return (
				`<p><b>${esc(String(s.title ?? ""))}</b></p>` +
				`<ol>${steps.map((st) => `<li>${esc(String(st ?? ""))}</li>`).join("")}</ol>` +
				`<p><i>Expect:</i> ${expected.map((ex) => esc(String(ex ?? ""))).join("; ")}</p>`
			);
		})
		.join("");
	return (
		`<div class="panel">` +
		`<div class="panel-header">` +
		`<span class="panel-title">E2E Test Guide</span>` +
		`<span class="ship-status is-ok">${scenarios.length} ${scenarioLabel}</span>` +
		`</div>` +
		`<div class="md-mock">${scenarioHtml}</div>` +
		`</div>`
	);
}

function buildCss(nonce: string): string {
	return `<style nonce="${nonce}">
  /* ── Design tokens (light) ── */
  body.vscode-light {
    --surface-hover: rgba(0,0,0,0.028);
    --border-light: rgba(0,0,0,0.06);
    --text-secondary: rgba(0,0,0,0.45);
    --text-tertiary: rgba(0,0,0,0.32);
    --pill-bg: rgba(0,0,0,0.06);
    --pill-text: rgba(0,0,0,0.55);
    --panel-bg: rgba(0,0,0,0.012);
    --panel-inner: rgba(0,0,0,0.03);
    --ship-ok: #267f3f;
    --ship-warn: #b17d1a;
  }
  /* ── Design tokens (dark) ── */
  body.vscode-dark, body.vscode-high-contrast {
    --surface-hover: rgba(255,255,255,0.035);
    --border-light: rgba(255,255,255,0.06);
    --text-secondary: rgba(255,255,255,0.45);
    --text-tertiary: rgba(255,255,255,0.30);
    --pill-bg: rgba(255,255,255,0.08);
    --pill-text: rgba(255,255,255,0.60);
    --panel-bg: rgba(255,255,255,0.018);
    --panel-inner: rgba(255,255,255,0.045);
    --ship-ok: #4ece8d;
    --ship-warn: #e0ac2b;
  }
  /* ── Base ── */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .hidden { display: none !important; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 14px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  /* ── Pane container ── */
  .pane { max-width: 820px; padding: 22px 18px 48px; }
  h1 { font-size: 1.4em; font-weight: 700; margin-bottom: 10px; }
  /* ── Meta strip ── */
  .meta-strip {
    display: flex; flex-wrap: wrap; align-items: center; gap: 5px 9px;
    font-size: 0.86em; color: var(--text-secondary); margin-bottom: 16px;
  }
  .meta-strip .meta-sep { color: var(--text-tertiary); opacity: 0.55; }
  .meta-strip .meta-hash { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); }
  .meta-branch {
    display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; vertical-align: bottom;
    padding: 1px 8px; border-radius: 5px; background: var(--pill-bg); color: var(--pill-text); font-size: 0.92em;
  }
  .pr-open-link {
    cursor: pointer; color: var(--vscode-textLink-foreground); font-weight: 600;
  }
  .pr-open-link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
  /* ── Status chip ── */
  .ship-status {
    margin-left: auto; display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
    font-size: 0.72em; font-weight: 650; letter-spacing: 0.02em; padding: 2px 9px;
    border-radius: 11px; background: var(--surface-hover); color: var(--text-secondary);
  }
  .ship-status.is-ok { color: var(--ship-ok); }
  /* ── Panels ── */
  .panel {
    border: 1px solid var(--border-light); border-radius: 12px;
    background: var(--panel-bg); padding: 16px; margin-bottom: 20px;
  }
  .panel-header {
    display: flex; align-items: center; gap: 8px;
    padding-bottom: 8px; margin-bottom: 12px; border-bottom: 1px solid var(--border-light);
  }
  .panel-title { font-size: 0.78em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em; color: var(--text-secondary); }
  .sec-count {
    margin-left: auto; font-size: 0.78em; font-weight: 600; color: var(--text-tertiary);
  }
  /* ── Rows (memories + files) ── */
  .row {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 4px; border-radius: 6px; cursor: pointer;
  }
  .row:hover { background: var(--surface-hover); }
  .mem-ico { font-size: 1em; opacity: 0.5; flex-shrink: 0; }
  .r-main { flex: 1; min-width: 0; }
  .r-title { font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-sub { font-size: 0.78em; color: var(--text-secondary); }
  .meta-hash { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); }
  /* ── Git-status letter badge ── */
  .gs {
    flex-shrink: 0; font-size: 0.75em; font-weight: 700; width: 16px; text-align: center;
  }
  .gs-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .gs-A { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .gs-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .gs-R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
  .gs-U { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
  .gs-C { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
  /* ── Body markdown (rendered like the memory detail view) ── */
  .md-body { font-size: 0.9em; line-height: 1.6; color: var(--vscode-foreground); word-break: break-word; }
  .md-body .md-heading {
    font-size: 0.82em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-secondary); margin: 14px 0 6px;
  }
  .md-body .md-heading:first-child { margin-top: 0; }
  .md-body .md-line { margin: 2px 0; }
  .md-body .md-blank { height: 8px; }
  .md-body .md-list { margin: 4px 0 8px 20px; }
  .md-body .md-list li { margin: 2px 0; }
  .md-body strong { font-weight: 650; }
  .md-body .md-link { color: var(--vscode-textLink-foreground); }
  .md-body .md-hr { border: none; border-top: 1px solid var(--border-light); margin: 14px 0; }
  .md-body .md-inline-code, .md-body code {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
    background: var(--panel-inner); padding: 1px 5px; border-radius: 4px;
  }
  .md-body .md-code-block {
    background: var(--panel-inner); border-radius: 6px; padding: 10px 12px;
    overflow-x: auto; margin: 8px 0; font-size: 0.9em; line-height: 1.5;
  }
  .md-body .md-code-block code { background: none; padding: 0; }
  .md-body blockquote {
    border-left: 2px solid var(--border-light); margin: 8px 0;
    padding: 2px 0 2px 12px; color: var(--text-secondary);
  }
  .md-body details { margin: 6px 0; }
  .md-body summary { cursor: pointer; padding: 3px 0; }
  .md-body summary:hover { color: var(--vscode-foreground); }
  /* ── E2E guide content ── */
  .md-mock p { margin: 6px 0; }
  .md-mock ol { margin: 4px 0 8px 20px; }
  .md-mock li { margin: 2px 0; }
  /* ── Actions row ── */
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .btn {
    font-family: var(--vscode-font-family); font-size: 0.88em;
    display: inline-flex; align-items: center; gap: 5px;
    padding: 5px 14px; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, var(--border-light));
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  /* codicon.css pins .codicon to font: 16px with (0,2,0) specificity; this rule
     matches that specificity and — loading after the linked stylesheet — wins on
     source order, sizing the pull-request glyph to the button label. */
  .btn .codicon { font-size: 1em; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary {
    background: var(--vscode-button-secondaryBackground, var(--surface-hover));
    color: var(--vscode-button-secondaryForeground, var(--text-secondary));
    border-color: var(--vscode-button-border, var(--border-light));
  }
  .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--surface-hover)); color: var(--vscode-foreground); }
  /* ── Edit form (revealed by the Edit button) ── */
  /* Mirrors the pr-form-input/pr-form-textarea styling in PrCommentService's
     buildPrSectionCss: theme input bg/fg, full width, comfortable padding. */
  .edit-form { display: flex; flex-direction: column; gap: 16px; margin-top: 4px; }
  .edit-form .field { display: flex; flex-direction: column; gap: 6px; }
  /* Field labels reuse the panel-title treatment so the form reads as part of
     the same visual system as the read-only panels it replaces. */
  .edit-form .field-label {
    font-size: 0.78em; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.09em; color: var(--text-secondary);
  }
  .edit-form .actions { margin-top: 0; }
  .pr-input {
    width: 100%; box-sizing: border-box; padding: 6px 10px;
    font-size: 0.92em; font-family: var(--vscode-font-family);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--border-light)); border-radius: 4px;
  }
  .pr-textarea {
    width: 100%; box-sizing: border-box; min-height: 240px; resize: vertical; padding: 10px;
    font-size: 0.88em; font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--border-light)); border-radius: 4px;
  }
  .pr-input:focus, .pr-textarea:focus {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
  }
</style>`;
}

function buildScript(nonce: string): string {
	return `<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  // Submit buttons that kick off a push + create/update. Both are guarded so a
  // double-click (or a click while the host is still working) can't fire two
  // createPr messages — each would run its own pushBranch + create/update,
  // producing a second force-push prompt and a duplicate PR.
  const submitButtons = ['cmd-create-pr', 'cmd-create-edited']
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);
  var inFlight = false;
  function setInFlight(on) {
    inFlight = on;
    submitButtons.forEach(function (b) { b.disabled = on; });
  }
  function submit(payload) {
    if (inFlight) return;
    setInFlight(true);
    vscode.postMessage(payload);
  }
  // The host posts these back as the create/update progresses. Without a
  // listener the webview would never re-enable its buttons after a failure or
  // a cross-branch block, leaving the panel permanently stuck on first click.
  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    switch (msg.command) {
      case 'prCreating':
        setInFlight(true);
        break;
      case 'prCreateFailed':
      case 'prCreateBlockedCrossBranch':
      case 'prStatus':
        // Failure, block, or the post-op status refresh (success) — the
        // operation has settled, so let the user act again. The host-side
        // guards now route an existing PR to update, so a re-click is safe.
        setInFlight(false);
        break;
    }
  });
  document.getElementById('cmd-create-pr').addEventListener('click', function () {
    submit({ command: 'createPr' });
  });
  // Edit is a full mode switch: hide the read-only view (meta, panels, primary
  // actions) and reveal the title/body form with its own Create + Cancel row.
  // Cancel returns to the view without submitting; input values are retained.
  document.getElementById('cmd-edit').addEventListener('click', function () {
    document.getElementById('view-mode').classList.add('hidden');
    document.getElementById('edit-form').classList.remove('hidden');
  });
  document.getElementById('cmd-cancel').addEventListener('click', function () {
    document.getElementById('edit-form').classList.add('hidden');
    document.getElementById('view-mode').classList.remove('hidden');
  });
  document.getElementById('cmd-copy-body').addEventListener('click', function () {
    vscode.postMessage({ command: 'copyBody' });
  });
  document.getElementById('cmd-create-edited').addEventListener('click', function () {
    submit({
      command: 'createPr',
      title: document.getElementById('prTitleInput').value,
      body: document.getElementById('prBodyInput').value,
    });
  });
  document.querySelectorAll('.row[data-hash]').forEach(function (r) {
    r.addEventListener('click', function () {
      vscode.postMessage({ command: 'openMemory', hash: r.getAttribute('data-hash') });
    });
  });
  document.querySelectorAll('.row[data-path]').forEach(function (r) {
    r.addEventListener('click', function () {
      vscode.postMessage({ command: 'openDiff', path: r.getAttribute('data-path') });
    });
  });
  var prLink = document.getElementById('pr-open-link');
  if (prLink) {
    var openExisting = function () {
      vscode.postMessage({ command: 'openPr', url: prLink.getAttribute('data-pr-url') });
    };
    prLink.addEventListener('click', openExisting);
    prLink.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openExisting(); }
    });
  }
})();
</script>`;
}

/**
 * Bundled-asset URIs the pane needs beyond the nonce.
 *
 * Optional so unit tests can call `buildCreatePrHtml(vm, nonce)` without a
 * webview: when omitted the pane renders no codicon glyph and keeps the
 * nonce-only CSP (so an inline-style/JS regression still fails loudly). The
 * panel always supplies it in production.
 */
export interface CreatePrAssets {
	/** `webview.cspSource` — allowlists the bundled codicon stylesheet + font. */
	cspSource: string;
	/** `asWebviewUri(extensionUri/assets/codicons/codicon.css)` result. */
	codiconCssUri: string;
}

/**
 * Builds the full HTML document for the Create PR webview pane.
 *
 * @param vm - The view-model assembled by buildCreatePrViewModel.
 * @param nonce - CSP nonce injected by the VS Code extension host.
 * @param assets - Bundled codicon stylesheet URI + `cspSource`. When present the
 *   submit buttons render a git-pull-request glyph (matching the design mockup)
 *   and the CSP allowlists the codicon font. Omit in tests to render icon-free.
 * @returns A complete `<!DOCTYPE html>` document string.
 */
export function buildCreatePrHtml(vm: CreatePrViewModel, nonce: string, assets?: CreatePrAssets): string {
	// With codicons the CSP must allowlist the bundled stylesheet (style-src) and
	// its font file (font-src) from the extension asset origin; without assets we
	// keep the tighter nonce-only CSP.
	const csp = assets
		? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${assets.cspSource} 'nonce-${nonce}'; font-src ${assets.cspSource}; script-src 'nonce-${nonce}';" />`
		: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />`;
	// Linked before buildCss so the inline .btn .codicon size override wins on
	// source order (see buildCss). Empty when icon-free.
	const codiconLink = assets ? `<link rel="stylesheet" href="${assets.codiconCssUri}" />` : "";
	const prIcon = assets ? `<span class="codicon codicon-git-pull-request"></span>` : "";
	// Update mode when an open PR already exists on the branch: the button
	// pushes the latest commits and syncs this draft into PR #N instead of
	// creating a duplicate (which GitHub rejects).
	const isUpdate = vm.existingPr !== undefined;
	const heading = isUpdate ? "Update Pull Request" : "Create Pull Request";
	const primaryLabel = isUpdate ? "Update PR" : "Create PR";

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp}
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${heading}</title>
  ${codiconLink}
  ${buildCss(nonce)}
</head>
<body>
<div class="pane" id="pane-pr">
  <h1>${heading}</h1>
  <div id="view-mode">
    ${buildMetaStrip(vm)}
    <div class="panel">
      <div class="panel-header"><span class="panel-title">Title</span></div>
      <p>${esc(vm.title)}</p>
    </div>
    <div class="panel">
      <div class="panel-header"><span class="panel-title">Body: drafted from this branch&#39;s memories</span></div>
      <div class="md-body">${renderPrBodyMarkdown(vm.bodyMarkdown)}</div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Memories included</span>
        <span class="sec-count">${vm.memoryCount}</span>
      </div>
      ${buildMemoryRows(vm)}
    </div>
    ${buildE2ePanel(vm)}
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Files changed</span>
        <span class="sec-count">${vm.filesChanged}</span>
      </div>
      ${buildFileRows(vm)}
    </div>
    <div class="actions">
      <button class="btn" id="cmd-create-pr">${prIcon}${primaryLabel}</button>
      <button class="btn secondary" id="cmd-edit">Edit</button>
      <button class="btn secondary" id="cmd-copy-body">Copy body</button>
    </div>
  </div>
  <div class="edit-form hidden" id="edit-form">
    <div class="field">
      <label class="field-label" for="prTitleInput">Title</label>
      <input id="prTitleInput" class="pr-input" value="${esc(vm.title)}" />
    </div>
    <div class="field">
      <label class="field-label" for="prBodyInput">Body</label>
      <textarea id="prBodyInput" class="pr-textarea" rows="12">${esc(vm.bodyMarkdown)}</textarea>
    </div>
    <div class="actions">
      <button class="btn" id="cmd-create-edited">${prIcon}${primaryLabel}</button>
      <button class="btn secondary" id="cmd-cancel">Cancel</button>
    </div>
  </div>
</div>
${buildScript(nonce)}
</body>
</html>`;
}
