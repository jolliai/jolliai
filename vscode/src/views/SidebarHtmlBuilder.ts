/**
 * SidebarHtmlBuilder
 *
 * Builds the static HTML skeleton for the sidebar webview. The skeleton has:
 *   - A loading panel that takes the full viewport on first paint. The host
 *     pushes `configured` / `enabled` asynchronously (statusStore must spawn
 *     the CLI to derive them), so without this neutral placeholder the
 *     webview would default to onboarding (configured=false) and flicker to
 *     the tab UI when the real values arrive on a reload. The init handler
 *     hides this panel before applying the real configured/enabled flags.
 *   - An onboarding panel rendered before the tab bar, hidden by default.
 *     Shown when `state.configured === false` (no Jolli sign-in and no Anthropic
 *     key). In that mode the tab bar and tab content are hidden; the onboarding
 *     panel takes the entire viewport. The Anthropic API key path is positioned
 *     as the recommended primary option above the secondary Sign in to Jolli card.
 *   - An API key entry panel sibling, hidden by default. Shown when the user
 *     clicks "Configure API Key" from the onboarding panel — replaces the
 *     onboarding cards with a focused input + Save/Back so users can save the
 *     key without opening the full Settings page (which surfaces a dozen
 *     unrelated fields). Successful save flips `configured` to true via
 *     statusStore, which hides this panel through `applyConfigured(true)`.
 *   - A disabled panel sibling, hidden by default. Shown when the user is
 *     configured but has explicitly disabled the extension (`state.enabled ===
 *     false`). It reuses the onboarding header copy + the `.ob-*` styles, but
 *     drops the option cards and shows a single primary "Enable" button. The
 *     legacy disabled-banner inside the Status panel is kept for the degraded
 *     (no-workspace / no-git) fallback only.
 *   - A view-switch row (`#view-switch`) with the 2 primary views — Current
 *     Branch / Memory Bank — as segmented `data-tab` buttons. It
 *     sits directly under the editor's native "JOLLI MEMORY" title bar, above
 *     the breadcrumb row.
 *   - A header bar (`#tab-bar`) holding only the breadcrumb `<repo> / <branch>`
 *     with chevron dropdown affordances. The dropdowns are populated on demand
 *     by the host via `selection:repos` / `selection:branches` messages; when
 *     only one repo or one branch is known, the chevron is suppressed so the
 *     row doesn't dangle a no-op affordance. The breadcrumb text doubles as the
 *     "what am I viewing" indicator — `branchName` lives here now instead of
 *     inside a labeled tab. The Settings (gear) and Status (pulse) actions used
 *     to live in a right-side icon strip here; they are now native `view/title`
 *     contributions in the "JOLLI MEMORY" title bar. Settings runs
 *     `jollimemory.openSettings`; Status runs `jollimemory.toggleStatus`, which
 *     posts `status:toggle` to open the Status overlay (or collapse back to
 *     Branch if it's already showing).
 *   - 3 tab content panels (one shown at a time, the others have the `.hidden` class).
 *     The Branch panel is the persistent default; KB / Status are toggled by
 *     the icon buttons. Renamed user-facing string: "Commits" → "Memories"
 *     (the section is still keyed `commits` internally for back-compat).
 *   - A disabled-state intro rendered inside the Status panel itself, used only
 *     for the degraded fallback (no workspace / no git). The standard
 *     user-disabled state shows the disabled-panel above instead.
 *
 * Visibility convention: every togglable element here uses the `.hidden` class
 * (defined in SidebarCssBuilder as `display: none !important`). We avoid the
 * HTML `hidden` attribute because UA-stylesheet `display: none` loses to
 * author rules like `display: flex` on `.tab-bar` / `.tab-toolbar`, which
 * silently breaks the toggle. Class-based hiding has consistent specificity.
 *
 * All dynamic content is rendered by SidebarScriptBuilder via DOM API.
 * The skeleton contains no user-supplied data.
 */

import { buildSidebarCss } from "./SidebarCssBuilder.js";
import type { SidebarEmptyStrings } from "./SidebarEmptyMessages.js";
import { buildSidebarScript } from "./SidebarScriptBuilder.js";

export function buildSidebarHtml(
	nonce: string,
	cspSource: string,
	codiconCssUri: string,
	strings: SidebarEmptyStrings,
): string {
	const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';" />`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp}
  <title>Jolli Memory</title>
  <link rel="stylesheet" href="${codiconCssUri}" />
  <style nonce="${nonce}">${buildSidebarCss()}</style>
</head>
<body>
  <div class="sidebar-root" id="sidebar-root">
    <div class="loading-panel" id="loading-panel" role="status" aria-live="polite">
      <i class="codicon codicon-loading codicon-modifier-spin loading-icon" aria-hidden="true"></i>
      <span class="loading-text">Loading…</span>
    </div>
    <div class="onboarding-panel hidden" id="onboarding-panel" role="region" aria-label="Get started with Jolli Memory">
      <header class="ob-header">
        <div class="ob-title-row">
          <i class="codicon codicon-sparkle ob-title-icon" aria-hidden="true"></i>
          <h2 class="ob-title">Get started with Jolli Memory</h2>
        </div>
        <p class="ob-subtitle">Jolli Memory automatically captures your work context and surfaces relevant memories as you code. Choose how you'd like to set it up.</p>
      </header>
      <hr class="ob-divider" />
      <section class="ob-card ob-card--recommended">
        <span class="ob-badge">RECOMMENDED</span>
        <div class="ob-card-row">
          <i class="codicon codicon-key ob-card-icon" aria-hidden="true"></i>
          <div class="ob-card-text">
            <h3 class="ob-card-title">Use your Anthropic API key</h3>
            <p class="ob-card-desc">Connect your own Anthropic API key for AI summarization. Memories are stored locally only.</p>
          </div>
        </div>
      </section>
      <button type="button" id="onboarding-apikey-btn" class="ob-btn ob-btn--primary">Configure API Key</button>
      <div class="ob-or"><span>OR</span></div>
      <section class="ob-card">
        <div class="ob-card-row">
          <i class="codicon codicon-cloud ob-card-icon" aria-hidden="true"></i>
          <div class="ob-card-text">
            <h3 class="ob-card-title">Sign in to Jolli</h3>
            <p class="ob-card-desc">Use your Jolli account for AI summarization. Memories are stored locally, with the option to push to Jolli cloud.</p>
          </div>
        </div>
      </section>
      <button type="button" id="onboarding-signin-btn" class="ob-btn ob-btn--secondary">Sign In / Sign Up</button>
    </div>
    <div class="apikey-panel hidden" id="apikey-panel" role="region" aria-label="Configure Anthropic API key">
      <header class="ob-header">
        <div class="ob-title-row">
          <i class="codicon codicon-key ob-title-icon" aria-hidden="true"></i>
          <h2 class="ob-title">Configure your Anthropic API key</h2>
        </div>
        <p class="ob-subtitle">Paste your Anthropic API key. The key is stored locally only.</p>
      </header>
      <label class="apikey-label" for="apikey-input">API key</label>
      <input type="password" id="apikey-input" class="apikey-input" autocomplete="off" spellcheck="false" placeholder="sk-ant-..." />
      <p class="apikey-error hidden" id="apikey-error" role="alert"></p>
      <button type="button" id="apikey-save-btn" class="ob-btn ob-btn--primary" disabled>Save</button>
      <button type="button" id="apikey-back-btn" class="ob-btn ob-btn--secondary">Back</button>
    </div>
    <div class="disabled-panel hidden" id="disabled-panel" role="region" aria-label="Enable Jolli Memory">
      <header class="ob-header">
        <div class="ob-title-row">
          <i class="codicon codicon-sparkle ob-title-icon" aria-hidden="true"></i>
          <h2 class="ob-title">Get started with Jolli Memory</h2>
        </div>
        <p class="ob-subtitle">Jolli Memory automatically captures your work context and surfaces relevant memories as you code. Enable Jolli Memory to get started.</p>
      </header>
      <button type="button" id="disabled-enable-btn" class="ob-btn ob-btn--primary">Enable Jolli Memory</button>
    </div>
    <div class="view-switch hidden" id="view-switch" role="tablist" aria-label="Jolli Memory views">
      <button class="view-tab active" type="button" data-tab="branch" role="tab">Current Branch</button>
      <button class="view-tab" type="button" data-tab="kb" role="tab">Memory Bank</button>
    </div>
    <div class="tab-bar hidden" id="tab-bar" role="toolbar" aria-label="Jolli Memory header">
      <div class="breadcrumb" id="breadcrumb">
        <button class="breadcrumb-seg" type="button" id="breadcrumb-repo-btn" aria-haspopup="menu" aria-expanded="false">
          <i class="codicon codicon-repo breadcrumb-seg-icon" aria-hidden="true"></i>
          <span class="breadcrumb-seg-label" id="breadcrumb-repo-label">(repo)</span>
          <i class="codicon codicon-chevron-down breadcrumb-seg-chevron hidden" aria-hidden="true"></i>
        </button>
        <span class="breadcrumb-sep" aria-hidden="true">/</span>
        <button class="breadcrumb-seg" type="button" id="breadcrumb-branch-btn" aria-haspopup="menu" aria-expanded="false">
          <i class="codicon codicon-git-branch breadcrumb-seg-icon" aria-hidden="true"></i>
          <span class="breadcrumb-seg-label" id="breadcrumb-branch-label">(loading)</span>
          <i class="codicon codicon-chevron-down breadcrumb-seg-chevron hidden" aria-hidden="true"></i>
        </button>
      </div>
      <div class="repo-filter hidden" id="repo-filter">
        <span class="repo-filter-label">Showing</span>
        <button class="breadcrumb-seg" type="button" id="repo-filter-btn" aria-haspopup="menu" aria-expanded="false">
          <span class="breadcrumb-seg-label" id="repo-filter-value">All repos</span>
          <i class="codicon codicon-chevron-down breadcrumb-seg-chevron" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <div class="dropdown-menu hidden" id="breadcrumb-menu" role="menu"></div>
    <div class="tab-toolbar hidden" id="tab-toolbar"></div>
    <div class="tab-content hidden" id="tab-content-kb"><p class="placeholder">Loading...</p></div>
    <div class="tab-content hidden" id="tab-content-branch"><p class="placeholder">Loading...</p></div>
    <div class="tab-content hidden" id="tab-content-status">
      <div class="disabled-banner hidden" id="disabled-banner">
        <p class="disabled-intro">Capture searchable memories from your AI coding sessions and weave them into your git history. Each commit gets an AI-generated summary you can recall later.</p>
        <button type="button" id="enable-btn" class="enable-btn">Enable Jolli Memory</button>
      </div>
      <div class="status-entries" id="status-entries"><p class="placeholder">Loading...</p></div>
    </div>
    <div class="context-menu hidden" id="context-menu"></div>
    <div class="hover-card hidden" id="memory-hover" role="tooltip"></div>
    <div class="text-tip hidden" id="text-tip" role="tooltip"></div>
  </div>
  <script nonce="${nonce}" type="application/json" id="empty-strings">${JSON.stringify(strings)}</script>
  <script nonce="${nonce}">${buildSidebarScript()}</script>
</body>
</html>`;
}
