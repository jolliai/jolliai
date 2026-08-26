/**
 * SettingsScriptBuilder
 *
 * Returns the JavaScript embedded in the Settings webview for:
 *  - Tab switching between AI Agents / AI Summary / Sync to Jolli / Memory Bank / Others
 *  - Provider card switching in AI Summary (Anthropic vs Jolli sub-states)
 *  - Sync to Jolli card switching (signed-in vs signed-out)
 *  - Advanced (Jolli API Key) toggle
 *  - Sign-in / Sign-out wiring (extension host commands)
 *  - Form state management, dirty tracking, validation, masking detection
 *
 * Pure string template — no logic dependencies on other view modules.
 */

import { ALLOWED_JOLLI_HOSTS } from "../../../cli/src/core/JolliApiUtils.js";
import { buildContextMenuGuardScript } from "./ContextMenuGuard.js";

/** Returns the JavaScript for the Settings webview interactions. */
export function buildSettingsScript(): string {
	return `
  ${buildContextMenuGuardScript()}

  const vscode = acquireVsCodeApi();

  // ── DOM references ──
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('model');
  const maxTokensInput = document.getElementById('maxTokens');
  const aiProviderSelect = document.getElementById('aiProvider');
  const localAgentToolSelect = document.getElementById('localAgentTool');
  const localAgentModelSelect = document.getElementById('localAgentModel');
  const localAgentModelRow = document.getElementById('localAgentModelRow');
  // The model the user actually chose, kept SEPARATE from the select's current
  // selection. A tool switch re-points that selection at the new tool's default
  // so the row displays something valid — a presentation decision. But the select
  // is also what a save reads, so submitting it made merely visiting another tool
  // in the picker overwrite a pin the user never edited: pick codex, change your
  // mind, and claude-code's opus saves as sonnet. Worse for a tool that pins
  // nothing, where the row is hidden and nothing on screen showed it happening.
  // Written only by a load and by the user changing the model select.
  var storedLocalAgentModel = '';
  const localAgentStatus = document.getElementById('localAgentStatus');
  // Two Jolli API key inputs (jolli-ok and jolli-nokey cards) — kept in sync.
  const jolliApiKeyInput = document.getElementById('jolliApiKey');
  const jolliApiKeyNoKeyInput = document.getElementById('jolliApiKeyNoKey');
  const jolliSiteLabel = document.getElementById('jolliSiteLabel');
  const claudeEnabledInput = document.getElementById('claudeEnabled');
  const codexEnabledInput = document.getElementById('codexEnabled');
  const geminiEnabledInput = document.getElementById('geminiEnabled');
  const openCodeEnabledInput = document.getElementById('openCodeEnabled');
  const cursorEnabledInput = document.getElementById('cursorEnabled');
  const devinEnabledInput = document.getElementById('devinEnabled');
  const copilotEnabledInput = document.getElementById('copilotEnabled');
  const clineEnabledInput = document.getElementById('clineEnabled');
  const antigravityEnabledInput = document.getElementById('antigravityEnabled');
  const kimiEnabledInput = document.getElementById('kimiEnabled');
  const globalInstructionsInput = document.getElementById('globalInstructions');
  const localFolderInput = document.getElementById('localFolder');
  const memoryBankState = document.getElementById('memoryBankState');
  const memoryBankStateIcon = document.getElementById('memoryBankStateIcon');
  const memoryBankStateText = document.getElementById('memoryBankStateText');
  const browseLocalFolderBtn = document.getElementById('browseLocalFolderBtn');
  const rebuildKbBtn = document.getElementById('rebuildKbBtn');
  const rebuildKbStatus = document.getElementById('rebuildKbStatus');
  const generateSummariesBtn = document.getElementById('generateSummariesBtn');
  const generateSummariesStatus = document.getElementById('generateSummariesStatus');
  const missingSummariesCount = document.getElementById('missingSummariesCount');
  const excludePatternsInput = document.getElementById('excludePatterns');
  const compileExcludeFoldersInput = document.getElementById('compileExcludeFolders');
  const dcoSignoffInput = document.getElementById('dcoSignoff');
  const applyBtn = document.getElementById('applyBtn');
  const saveFeedback = document.getElementById('saveFeedback');
  const anthropicMissingWarn = document.getElementById('anthropicMissingWarn');
  const summarySignInBtn = document.getElementById('summarySignInBtn');
  const summaryReLoginBtn = document.getElementById('summaryReLoginBtn');
  const syncSignInBtn = document.getElementById('syncSignInBtn');
  const syncSignOutBtn = document.getElementById('syncSignOutBtn');
  const autoSyncEnabledInput = document.getElementById('autoSyncEnabled');
  const syncTranscriptsInput = document.getElementById('syncTranscripts');
  const syncPollIntervalMinInput = document.getElementById('syncPollIntervalMin');
  const syncNowBtn = document.getElementById('syncNowBtn');

  // ── State ──
  let maskedApiKey = '';
  let maskedJolliApiKey = '';
  let initialState = {};
  let isDirty = false;
  let hasErrors = false;
  // Availability of the currently-selected agent tool. null = unknown / probe
  // in flight. Only a confirmed false blocks Apply (via localAgentBlocks(),
  // read from updateApplyBtn), so a slow probe never flickers Apply to
  // disabled.
  let localAgentAvailable = null;
  // Which tool the in-flight probe was dispatched for. A reply is applied
  // only when it still matches the current dropdown value, so switching tools
  // before a slow reply lands can't apply a stale result to the new selection.
  let localAgentProbeTool = null;
  // Set when an Apply click landed while a probe was still in flight. The save
  // is HELD (not rejected, not sent) until the reply decides it — see
  // submitApplySettings. Cleared by probeLocalAgent(), so any form edit that
  // dispatches a new probe drops the held save rather than applying a click the
  // user made against a form state that no longer exists.
  let pendingApply = false;
  let pendingApplyTimer = null;
  // Auth state pushed by the extension host (settingsLoaded + authStateChanged).
  let signedIn = false;
  let hasJolliKey = false;
  // Set when the user confirmed "Apply Changes & Migrate" in the dirty-folder
  // dialog. We fire applySettings first, then chain into rebuildKnowledgeBase
  // on settingsSaved (and abort the chain on settingsError so the migrate
  // never runs against unsaved/invalid state).
  let pendingMigrateAfterApply = false;
  // Same pattern as pendingMigrateAfterApply, but for Sync now: when the user
  // clicks while form is dirty we chain Apply -> syncNow on settingsSaved,
  // and abort on settingsError so a rejected save never silently triggers
  // a round against stale config.
  let pendingSyncAfterApply = false;

  // ── Tab switching ──
  // Match by data-tab on the button to data-panel on the section. Use the
  // shared .hidden class so the tab toggle doesn't fight any other display:*
  // declared on the panel (matches the project's webview convention — see
  // CLAUDE.md / feedback memory).
  document.querySelectorAll('.tab-button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var target = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-button').forEach(function(b) {
        b.classList.toggle('tab-active', b === btn);
      });
      document.querySelectorAll('.tab-panel').forEach(function(p) {
        var matches = p.getAttribute('data-panel') === target;
        p.classList.toggle('hidden', !matches);
      });
    });
  });

  // ── Provider / Sync card switching ──
  function syncProviderCard() {
    var provider = aiProviderSelect.value;
    var which;
    if (provider === 'anthropic') {
      which = 'anthropic';
    } else if (provider === 'local-agent') {
      which = 'local-agent';
    } else if (signedIn && hasJolliKey) {
      which = 'jolli-ok';
    } else if (signedIn && !hasJolliKey) {
      which = 'jolli-nokey';
    } else {
      which = 'jolli-signin';
    }
    document.querySelectorAll('[data-card]').forEach(function(c) {
      c.classList.toggle('hidden', c.getAttribute('data-card') !== which);
    });
    if (provider === 'anthropic') {
      // Re-evaluate the missing-key warning whenever the Anthropic card shows.
      updateAnthropicWarning();
    }
  }

  function syncSyncCard() {
    // Sync tab: signed-in if both signedIn AND hasJolliKey (matches IntelliJ
    // CARD_SYNC_SIGNEDIN gating). Otherwise show signed-out — the user signs
    // in (or pastes a key in AI Summary > Advanced) to reach the signed-in
    // state. Keeping a single binary card here avoids a duplicate "no key"
    // surface; AI Summary is where the missing-key recovery flow lives.
    var which = (signedIn && hasJolliKey) ? 'signed-in' : 'signed-out';
    document.querySelectorAll('[data-sync-card]').forEach(function(c) {
      c.classList.toggle('hidden', c.getAttribute('data-sync-card') !== which);
    });
  }

  function updateAnthropicWarning() {
    var hasKey = apiKeyInput.value.trim().length > 0;
    anthropicMissingWarn.classList.toggle('hidden', hasKey);
  }

  // Renders the host's Memory Bank verdict. The severity picks the class the
  // panel already uses for status lines; the row stays hidden if the host sent
  // nothing, so an older host can never leave an empty coloured strip behind.
  // textContent (not innerHTML) because the payload carries a filesystem path.
  function renderMemoryBankState(display) {
    if (!memoryBankState) return;
    if (!display || !display.text) {
      memoryBankState.classList.add('hidden');
      return;
    }
    var severity = display.severity === 'ok' || display.severity === 'warn' ? display.severity : 'off';
    memoryBankState.classList.remove('status-ok', 'status-warn', 'status-off');
    memoryBankState.classList.add('status-' + severity);
    memoryBankStateIcon.textContent = severity === 'ok' ? '✓' : severity === 'warn' ? '⚠' : '○';
    memoryBankStateText.textContent = display.text;
    memoryBankState.classList.remove('hidden');
  }

  // ── Advanced (Jolli API Key) toggles ──
  document.querySelectorAll('.advanced-link').forEach(function(link) {
    link.addEventListener('click', function() {
      var key = link.getAttribute('data-advanced');
      var panel = document.querySelector('[data-advanced-panel="' + key + '"]');
      if (!panel) return;
      var willOpen = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !willOpen);
      link.textContent = willOpen ? 'Hide Advanced' : 'Advanced';
    });
  });

  // ── Per-repo outbound push control (spec 306) ──
  // Space-binding state (JOLLI-2152) arrives via a SEPARATE, later message
  // (spaceBindingsLoaded) than the repo list itself (pushControlLoaded), so
  // both are kept as closure state and renderPushControl() re-renders from
  // whichever one changed — never blocking the repo list's own first paint.
  var pushControlRepos = [];
  var pushControlUnreadable;
  var spaceBindings = {};
  var spaceBindingsSignedOut = false;
  var spaceBindingsPending = true;

  function renderPushControl() {
    var repos = pushControlRepos;
    var unreadable = pushControlUnreadable;
    var list = document.getElementById('pushControlList');
    if (!list) return;
    list.innerHTML = '';
    // The setting file could not be read. The outbound gate fails CLOSED on the
    // same file, so every push is being blocked right now — say that before any
    // row, because the rows below are last-known values and each checkbox would
    // otherwise read as "Push ✓" while nothing can actually push.
    if (unreadable) {
      var bad = document.createElement('div');
      bad.className = 'error-message visible';
      bad.textContent =
        "Can't read the outbound-push setting, so pushing is blocked for every repository until it's fixed. "
        + 'The states below are the last known ones and may be wrong. Detail: ' + unreadable;
      list.appendChild(bad);
    }
    if (!repos || repos.length === 0) {
      if (!unreadable) {
        var empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = 'No tracked repositories yet. Open a repo or generate a memory and it will appear here.';
        list.appendChild(empty);
      }
      return;
    }
    if (spaceBindingsSignedOut) {
      var signInHint = document.createElement('div');
      signInHint.className = 'hint';
      signInHint.textContent = 'Sign in to see which Jolli Space each repo pushes into.';
      list.appendChild(signInHint);
    }
    repos.forEach(function(repo) {
      var rowEl = document.createElement('div');
      rowEl.className = 'push-control-row';
      var meta = document.createElement('div');
      meta.className = 'pc-meta';
      var name = document.createElement('span');
      name.className = 'pc-name';
      name.textContent = repo.repoName + (repo.isCurrentRepo ? ' (this repo)' : '');
      var path = document.createElement('span');
      path.className = 'pc-path';
      path.textContent = repo.repoIdentity;
      meta.appendChild(name);
      meta.appendChild(path);
      var space = document.createElement('span');
      space.className = 'pc-space';
      var binding = spaceBindings[repo.repoIdentity];
      if (spaceBindingsSignedOut) {
        space.classList.add('pc-space--unknown');
        space.textContent = '—';
        space.title = 'Sign in to Jolli to see which Space this repo pushes into.';
      } else if (binding) {
        space.classList.add('pc-space--' + binding.state);
        if (binding.degraded) space.classList.add('pc-space--degraded');
        space.textContent = binding.label;
        if (binding.title) space.title = binding.title;
      } else if (spaceBindingsPending) {
        space.classList.add('pc-space--pending');
        space.textContent = 'Checking…';
      } else {
        // spaceBindingsLoaded arrived but this repoIdentity had no entry —
        // never leave the cell silently blank.
        space.classList.add('pc-space--unknown');
        space.textContent = 'Not checked';
      }
      var toggleWrap = document.createElement('label');
      toggleWrap.className = 'pc-toggle';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !repo.pushDisabled;
      // The visible label is just "Push", which is identical on every row — name
      // the repo for screen readers so the control is distinguishable.
      cb.setAttribute('aria-label', 'Push memories for ' + repo.repoName + ' to its Jolli Space');
      var cbText = document.createElement('span');
      cbText.textContent = 'Push';
      cb.addEventListener('change', function() {
        var disabled = !cb.checked;
        vscode.postMessage({
          command: 'setPushDisabled',
          repoIdentity: repo.repoIdentity,
          disabled: disabled,
          isCurrent: !!repo.isCurrentRepo,
        });
        // Show a PENDING message only — the backend confirms (or reverts) by
        // re-posting the persisted list with a settled status, so we never
        // claim success before the store write actually lands.
        var status = document.getElementById('pushControlStatus');
        if (status) {
          status.textContent = (disabled ? 'Disabling' : 'Enabling') + ' outbound push for ' + repo.repoName + '…';
          status.classList.add('visible');
        }
      });
      toggleWrap.appendChild(cb);
      toggleWrap.appendChild(cbText);
      rowEl.appendChild(meta);
      rowEl.appendChild(space);
      rowEl.appendChild(toggleWrap);
      list.appendChild(rowEl);
    });
  }

  // ── Sign-in / Sign-out buttons ──
  function postSignIn() { vscode.postMessage({ command: 'signIn' }); }
  function postSignOut() { vscode.postMessage({ command: 'signOut' }); }
  if (summarySignInBtn) summarySignInBtn.addEventListener('click', postSignIn);
  if (syncSignInBtn) syncSignInBtn.addEventListener('click', postSignIn);
  if (summaryReLoginBtn) summaryReLoginBtn.addEventListener('click', postSignOut);
  if (syncSignOutBtn) syncSignOutBtn.addEventListener('click', postSignOut);

  // ── Validation ──
  // Sourced from cli/src/core/JolliApiUtils.ts at extension build time so the
  // CLI's authoritative allowlist and the webview's validator can't drift.
  var ALLOWED_JOLLI_HOSTS = ${JSON.stringify(ALLOWED_JOLLI_HOSTS)};

  function decodeBase64url(seg) {
    try {
      var b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      var pad = b64.length % 4;
      if (pad === 2) b64 += '==';
      else if (pad === 3) b64 += '=';
      else if (pad === 1) return null;
      return atob(b64);
    } catch (e) { return null; }
  }

  function checkJolliOriginAllowed(origin) {
    try {
      var u = new URL(origin);
      var host = u.hostname.toLowerCase();
      if (u.protocol !== 'https:' || !host) return false;
      for (var i = 0; i < ALLOWED_JOLLI_HOSTS.length; i++) {
        var h = ALLOWED_JOLLI_HOSTS[i];
        if (host === h || host.slice(-(h.length + 1)) === '.' + h) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  // Inline port of cli/src/core/JolliApiUtils.ts validateJolliApiKey — this
  // runs in the webview's browser context so it can't just import the Node
  // module. Keep in lockstep with the CLI version (and the Kotlin port in
  // intellij/.../JolliApiClient.kt). Runs on every keystroke for inline red
  // feedback; the server-side check in handleApplySettings is authoritative.
  function validateJolliApiKeyRule(v) {
    if (v.length === 0 || v === maskedJolliApiKey) return '';
    if (!v.startsWith('sk-jol-')) return 'Key cannot be decoded. Paste the key exactly as issued by Jolli.';
    var rest = v.slice('sk-jol-'.length);
    if (rest.indexOf('.') < 0) {
      return 'Key cannot be decoded. Paste the key exactly as issued by Jolli.';
    }
    var segments = rest.split('.');
    for (var i = 0; i < segments.length; i++) {
      var json = decodeBase64url(segments[i]);
      if (json === null) continue;
      try {
        var meta = JSON.parse(json);
        if (typeof meta.t === 'string' && typeof meta.u === 'string') {
          if (!checkJolliOriginAllowed(meta.u)) {
            return 'Origin ' + meta.u + ' is not on the Jolli allowlist (only *.jolli.ai, *.jolli.dev, *.jolli.cloud, *.jolli-local.me).';
          }
          return '';
        }
      } catch (e) { /* try next segment */ }
    }
    return 'Key cannot be decoded. Paste the key exactly as issued by Jolli.';
  }

  function validateField(input, errorId, rule) {
    var errorEl = document.getElementById(errorId);
    var value = input.value.trim();
    var msg = rule(value);
    if (msg) {
      input.classList.add('error');
      if (errorEl) errorEl.textContent = msg;
    } else {
      input.classList.remove('error');
      if (errorEl) errorEl.textContent = '';
    }
    return !msg;
  }

  function validateAll() {
    var valid = true;
    valid = validateField(apiKeyInput, 'apiKey-error', function(v) {
      if (v.length > 0 && v !== maskedApiKey) {
        if (!v.startsWith('sk-ant-')) return 'Must start with sk-ant-';
        if (v.length < 20) return 'Key looks incomplete';
      }
      return '';
    }) && valid;
    // Validate only the Jolli key input whose card is currently visible.
    // The two inputs are kept in sync by paired listeners, but in transient
    // states (advanced panel collapsed, programmatic setValue race) one may
    // briefly hold a stale value — running the rule on a hidden input would
    // surface its error in a card the user can't see, blocking Apply with
    // no visible cause. When neither Jolli card is in scope (Anthropic
    // selected, or signed-out) we skip Jolli validation entirely so a
    // residual value can't gate Apply.
    var jolliOkCard = document.querySelector('[data-card="jolli-ok"]');
    var jolliNokeyCard = document.querySelector('[data-card="jolli-nokey"]');
    if (jolliOkCard && !jolliOkCard.classList.contains('hidden')) {
      valid = validateField(jolliApiKeyInput, 'jolliApiKey-error', validateJolliApiKeyRule) && valid;
    } else if (jolliNokeyCard && !jolliNokeyCard.classList.contains('hidden')) {
      valid = validateField(jolliApiKeyNoKeyInput, 'jolliApiKeyNoKey-error', validateJolliApiKeyRule) && valid;
    }
    valid = validateField(maxTokensInput, 'maxTokens-error', function(v) {
      if (v.length > 0 && (isNaN(Number(v)) || Number(v) < 1 || !Number.isInteger(Number(v)))) return 'Must be a positive integer';
      return '';
    }) && valid;
    // At least one integration must be enabled
    var intError = document.getElementById('integrations-error');
    if (!claudeEnabledInput.checked && !codexEnabledInput.checked && !geminiEnabledInput.checked && !openCodeEnabledInput.checked && !cursorEnabledInput.checked && !copilotEnabledInput.checked && !clineEnabledInput.checked && !devinEnabledInput.checked && !antigravityEnabledInput.checked && !kimiEnabledInput.checked) {
      intError.textContent = 'At least one integration must be enabled';
      valid = false;
    } else {
      intError.textContent = '';
    }
    hasErrors = !valid;
    updateApplyBtn();
  }

  // ── Memory Bank helpers ──
  browseLocalFolderBtn.addEventListener('click', function() {
    vscode.postMessage({ command: 'browseLocalFolder' });
  });

  function localFolderDirty() {
    return localFolderInput.value !== initialState.localFolder;
  }

  function startRebuild() {
    rebuildKbBtn.disabled = true;
    rebuildKbStatus.textContent = 'Rebuilding…';
    vscode.postMessage({ command: 'rebuildKnowledgeBase' });
  }

  rebuildKbBtn.addEventListener('click', function() {
    if (rebuildKbBtn.disabled) return;
    if (localFolderDirty()) {
      // Host will show a native modal warning and post back the user's choice
      // via 'confirmDirtyMigrateResult'. Don't disable the button yet so a
      // Cancel leaves the UI exactly as the user left it.
      vscode.postMessage({ command: 'confirmDirtyMigrate' });
      return;
    }
    startRebuild();
  });

  if (generateSummariesBtn) {
    generateSummariesBtn.addEventListener('click', function() {
      if (generateSummariesBtn.disabled) return;
      generateSummariesBtn.disabled = true;
      if (generateSummariesStatus) generateSummariesStatus.textContent = 'Generating… (see notification for progress)';
      vscode.postMessage({ command: 'generateMissingSummaries' });
    });
  }

  // ── Dirty tracking ──
  function getActiveJolliApiKeyValue() {
    // Prefer whichever input's card is currently visible. The two inputs are
    // kept in sync by the input listeners below, so under normal interaction
    // they'll match anyway — this just disambiguates after a programmatic
    // setValue (e.g. on settingsLoaded).
    var okCard = document.querySelector('[data-card="jolli-ok"]');
    if (okCard && !okCard.classList.contains('hidden')) return jolliApiKeyInput.value;
    var nokeyCard = document.querySelector('[data-card="jolli-nokey"]');
    if (nokeyCard && !nokeyCard.classList.contains('hidden')) return jolliApiKeyNoKeyInput.value;
    // Neither advanced card visible — fall back to the last-loaded masked
    // value so dirty tracking sees no change.
    return jolliApiKeyInput.value;
  }

  function captureInitialState() {
    initialState = {
      apiKey: apiKeyInput.value,
      model: modelSelect.value,
      maxTokens: maxTokensInput.value,
      aiProvider: aiProviderSelect.value,
      localAgentTool: localAgentToolSelect.value,
      localAgentModel: storedLocalAgentModel,
      jolliApiKey: getActiveJolliApiKeyValue(),
      claudeEnabled: claudeEnabledInput.checked,
      codexEnabled: codexEnabledInput.checked,
      geminiEnabled: geminiEnabledInput.checked,
      openCodeEnabled: openCodeEnabledInput.checked,
      cursorEnabled: cursorEnabledInput.checked,
      devinEnabled: devinEnabledInput.checked,
      copilotEnabled: copilotEnabledInput.checked,
      clineEnabled: clineEnabledInput.checked,
      antigravityEnabled: antigravityEnabledInput.checked,
      kimiEnabled: kimiEnabledInput.checked,
      globalInstructions: globalInstructionsInput.checked,
      localFolder: localFolderInput.value,
      excludePatterns: excludePatternsInput.value,
      compileExcludeFolders: compileExcludeFoldersInput.value,
      dcoSignoff: dcoSignoffInput.checked,
      autoSyncEnabled: autoSyncEnabledInput ? autoSyncEnabledInput.checked : false,
      syncTranscripts: syncTranscriptsInput ? syncTranscriptsInput.checked : false,
      syncPollIntervalMin: syncPollIntervalMinInput ? syncPollIntervalMinInput.value : '',
    };
    checkDirty();
  }

  function checkDirty() {
    isDirty = (
      apiKeyInput.value !== initialState.apiKey ||
      modelSelect.value !== initialState.model ||
      maxTokensInput.value !== initialState.maxTokens ||
      aiProviderSelect.value !== initialState.aiProvider ||
      localAgentToolSelect.value !== initialState.localAgentTool ||
      storedLocalAgentModel !== initialState.localAgentModel ||
      getActiveJolliApiKeyValue() !== initialState.jolliApiKey ||
      claudeEnabledInput.checked !== initialState.claudeEnabled ||
      codexEnabledInput.checked !== initialState.codexEnabled ||
      geminiEnabledInput.checked !== initialState.geminiEnabled ||
      openCodeEnabledInput.checked !== initialState.openCodeEnabled ||
      cursorEnabledInput.checked !== initialState.cursorEnabled ||
      devinEnabledInput.checked !== initialState.devinEnabled ||
      copilotEnabledInput.checked !== initialState.copilotEnabled ||
      clineEnabledInput.checked !== initialState.clineEnabled ||
      antigravityEnabledInput.checked !== initialState.antigravityEnabled ||
      kimiEnabledInput.checked !== initialState.kimiEnabled ||
      globalInstructionsInput.checked !== initialState.globalInstructions ||
      localFolderInput.value !== initialState.localFolder ||
      excludePatternsInput.value !== initialState.excludePatterns ||
      compileExcludeFoldersInput.value !== initialState.compileExcludeFolders ||
      dcoSignoffInput.checked !== initialState.dcoSignoff ||
      (autoSyncEnabledInput && autoSyncEnabledInput.checked !== initialState.autoSyncEnabled) ||
      (syncTranscriptsInput && syncTranscriptsInput.checked !== initialState.syncTranscripts) ||
      (syncPollIntervalMinInput && syncPollIntervalMinInput.value !== initialState.syncPollIntervalMin)
    );
    updateApplyBtn();
  }

  // Only meaningful when the provider actually reads localAgentTool ("Ignored
  // unless aiProvider === 'local-agent'" — cli/src/Types.ts). Apply is a
  // single global button saving every tab, so an unusable agent tool must not
  // block an unrelated Memory Bank edit. A pending probe (localAgentAvailable
  // === null) never blocks — only a confirmed-unavailable result does.
  function localAgentBlocks() {
    return aiProviderSelect.value === 'local-agent' && localAgentAvailable === false;
  }

  // Shows the model row only for a tool jollimemory pins a model for, and limits
  // the dropdown to THAT tool's options.
  //
  // The document carries every pinned tool's options at once (it is built once,
  // server-side, while the tool picker changes here), so each option is tagged
  // with data-tool and filtered by hiding + disabling. Disabling matters on its
  // own: a hidden-but-enabled option is still selectable by keyboard in some
  // renderers, which would submit a model the chosen tool never offered.
  //
  // Called from three places, and all three are needed: on panel load (the stored
  // tool decides the initial row), on tool change, and on provider change (the
  // whole card is hidden for the other providers, so the row must be correct by
  // the time it reappears).
  function syncLocalAgentModelRow() {
    if (!localAgentModelSelect || !localAgentModelRow) return;
    var tool = localAgentToolSelect.value;
    var visible = 0;
    var selectedStillVisible = false;
    var firstVisibleValue = null;
    var defaultVisibleValue = null;
    for (var i = 0; i < localAgentModelSelect.options.length; i++) {
      var o = localAgentModelSelect.options[i];
      var mine = o.getAttribute('data-tool') === tool;
      o.hidden = !mine;
      o.disabled = !mine;
      if (mine) {
        visible++;
        if (firstVisibleValue === null) firstVisibleValue = o.value;
        if (defaultVisibleValue === null && o.getAttribute('data-default')) defaultVisibleValue = o.value;
        if (o.value === localAgentModelSelect.value) selectedStillVisible = true;
      }
    }
    localAgentModelRow.classList.toggle('hidden', visible === 0);
    // After a tool switch the previously-selected model may belong to the old
    // tool. Fall back to the option MARKED default, never to the first one: the
    // list is ordered by capability with the default in the middle, so position
    // carries no meaning. First-visible survives only for a tool that somehow
    // marks none.
    var target = selectedStillVisible
      ? localAgentModelSelect.value
      : (defaultVisibleValue !== null ? defaultVisibleValue : firstVisibleValue);
    if (visible > 0 && target !== null) selectVisibleModelOption(target);
  }

  // Selects the given value on the option belonging to the CURRENT tool, rather
  // than by assigning to select.value.
  //
  // Every pinned tool offers the inherit choice, so the document really does
  // contain more than one option carrying that value, differing only in data-tool
  // and label. Assigning select.value picks the FIRST match by spec — which is
  // another tool's, now hidden and disabled — so a codex user with inherit stored
  // had the row load reading "Use Claude Code's own setting". The submitted value
  // was right either way, which is exactly why it needed catching here: nothing
  // downstream could notice.
  function selectVisibleModelOption(value) {
    var tool = localAgentToolSelect.value;
    for (var i = 0; i < localAgentModelSelect.options.length; i++) {
      var o = localAgentModelSelect.options[i];
      if (o.value === value && o.getAttribute('data-tool') === tool) {
        localAgentModelSelect.selectedIndex = i;
        return;
      }
    }
  }

  // Looks up a tool's display label by <option value>, never by selectedIndex:
  // selectedIndex is -1 when nothing is selected, and indexing options[-1]
  // throws. Falls back to the raw id so a lookup miss degrades to readable
  // text instead of "undefined".
  function localAgentToolOptionLabel(toolId) {
    for (var i = 0; i < localAgentToolSelect.options.length; i++) {
      if (localAgentToolSelect.options[i].value === toolId) {
        return localAgentToolSelect.options[i].textContent;
      }
    }
    return toolId;
  }

  // Verifies the currently-selected agent tool actually runs on this machine.
  // Dispatched on tool-select change, on switching the provider to
  // local-agent, and once on panel open (settingsLoaded) so an already-
  // unavailable configured tool surfaces immediately.
  function probeLocalAgent() {
    var tool = localAgentToolSelect.value;
    // A new probe means the form moved (tool switched, provider switched, or a
    // fresh load). Whatever Apply click is being held was made against the old
    // state, so drop it instead of silently re-targeting it at the new value.
    // The change handlers call clearSaveFeedback() just before this, so the
    // 'Checking…' line the held save wrote is already gone.
    cancelPendingApply();
    localAgentProbeTool = tool;
    localAgentAvailable = null;
    if (localAgentStatus) {
      localAgentStatus.textContent = 'Checking…';
      localAgentStatus.classList.remove('error');
    }
    updateApplyBtn();
    vscode.postMessage({ command: 'probeLocalAgent', tool: tool });
  }

  function updateApplyBtn() {
    // Gate on "nothing to save", "has client-side errors", and an unusable
    // local-agent tool selection (localAgentBlocks — only live while the
    // provider is local-agent). The click handler also re-runs validateAll()
    // and surfaces a saveFeedback message if a validation error slips through
    // (e.g. programmatic value change), so the user gets explicit feedback
    // rather than a swallowed click.
    applyBtn.disabled = !isDirty || hasErrors || localAgentBlocks();
  }

  function clearSaveFeedback() {
    saveFeedback.classList.remove('visible');
    saveFeedback.classList.remove('error');
  }

  // Drops a held Apply and disarms its watchdog. Idempotent — safe to call when
  // nothing is held, which is the common case.
  function cancelPendingApply() {
    pendingApply = false;
    if (pendingApplyTimer) {
      clearTimeout(pendingApplyTimer);
      pendingApplyTimer = null;
    }
  }

  // ── Event listeners ──
  apiKeyInput.addEventListener('input', function() {
    validateAll(); checkDirty(); clearSaveFeedback();
    updateAnthropicWarning();
  });
  // Keep the two Jolli API key inputs mirrored: editing one updates the other
  // silently so dirty tracking and validation behave identically regardless of
  // which card the user opened. The silent update intentionally skips
  // checkDirty/clearSaveFeedback to avoid double-counting the same edit.
  jolliApiKeyInput.addEventListener('input', function() {
    if (jolliApiKeyNoKeyInput.value !== jolliApiKeyInput.value) {
      jolliApiKeyNoKeyInput.value = jolliApiKeyInput.value;
    }
    validateAll(); checkDirty(); clearSaveFeedback();
  });
  jolliApiKeyNoKeyInput.addEventListener('input', function() {
    if (jolliApiKeyInput.value !== jolliApiKeyNoKeyInput.value) {
      jolliApiKeyInput.value = jolliApiKeyNoKeyInput.value;
    }
    validateAll(); checkDirty(); clearSaveFeedback();
  });
  [maxTokensInput, excludePatternsInput, compileExcludeFoldersInput].forEach(function(input) {
    input.addEventListener('input', function() { validateAll(); checkDirty(); clearSaveFeedback(); });
  });
  // The Memory Bank folder input shares the same dirty/feedback handling as
  // the other text fields. Additionally, editing the path makes any prior
  // "Rebuild complete: ..." banner stale (the message echoes a path that no
  // longer matches the form value), so clear it on input — same UX rule
  // saveFeedback follows when a field is edited after a previous save.
  localFolderInput.addEventListener('input', function() {
    checkDirty();
    clearSaveFeedback();
    rebuildKbStatus.textContent = '';
  });
  modelSelect.addEventListener('change', function() { checkDirty(); clearSaveFeedback(); });
  localAgentToolSelect.addEventListener('change', function() {
    syncLocalAgentModelRow(); checkDirty(); clearSaveFeedback(); probeLocalAgent();
  });
  if (localAgentModelSelect) {
    localAgentModelSelect.addEventListener('change', function() {
      storedLocalAgentModel = localAgentModelSelect.value;
      checkDirty(); clearSaveFeedback();
    });
  }
  aiProviderSelect.addEventListener('change', function() {
    checkDirty(); clearSaveFeedback(); syncProviderCard(); syncLocalAgentModelRow();
    // Re-verify when switching TO local-agent (a stale/never-probed result
    // must not silently pass); switching away is handled by checkDirty()'s
    // updateApplyBtn() call above, since localAgentBlocks() reads the live
    // provider value and clears on its own.
    if (aiProviderSelect.value === 'local-agent') probeLocalAgent();
  });
  [claudeEnabledInput, codexEnabledInput, geminiEnabledInput, openCodeEnabledInput, cursorEnabledInput, copilotEnabledInput, clineEnabledInput, devinEnabledInput, antigravityEnabledInput, kimiEnabledInput, globalInstructionsInput].forEach(function(input) {
    input.addEventListener('change', function() { validateAll(); checkDirty(); clearSaveFeedback(); });
  });
  dcoSignoffInput.addEventListener('change', function() { checkDirty(); clearSaveFeedback(); });

  // Aborts a queued Migrate-after-Apply / SyncNow-after-Apply chain. Called
  // wherever the save those chains are waiting on will definitively not land:
  // the host rejected it (settingsError), a resumed held save hit a validation
  // error, or the probe watchdog gave up. Without a single place doing this, a
  // flag armed by the Sync now / Migrate button can outlive its save and fire
  // against some LATER, unrelated one.
  function abortApplyChains() {
    if (pendingMigrateAfterApply) {
      // Don't migrate against state that was never persisted.
      pendingMigrateAfterApply = false;
      rebuildKbStatus.textContent = '';
    }
    // Same reason: no sync round against config the host never wrote.
    pendingSyncAfterApply = false;
  }

  // ── Apply Changes ──
  // Returns true if the save is under way — either posted now, or HELD behind an
  // in-flight local-agent probe that will re-enter this function. Returns false
  // only when the save definitively will not happen (a validation error, or a
  // confirmed-unavailable agent tool).
  //
  // The Migrate-after-Apply / SyncNow-after-Apply chains read this to decide
  // whether to disarm on the spot, so "held" must be truthy: those chains have
  // to stay armed across the hold and fire on the resumed save's settingsSaved.
  // The resume site is what disarms them if the held save is then rejected.
  function submitApplySettings() {
    // Final client-side pass so inline errors stay in sync even if a field was
    // changed programmatically or before any input event had a chance to fire.
    validateAll();
    // Mirror updateApplyBtn()'s gate here too: the Apply button being disabled
    // only stops a direct click. Migrate-after-Apply and SyncNow-after-Apply
    // call submitApplySettings() directly, bypassing the button entirely, so a
    // confirmed-unavailable local-agent tool must be re-checked at the actual
    // save chokepoint or it can still be persisted through those chains.
    if (hasErrors || localAgentBlocks()) {
      saveFeedback.textContent = hasErrors
        ? 'Please fix the highlighted fields before saving'
        : localAgentToolOptionLabel(localAgentToolSelect.value) +
          " isn't available on this machine. Install it, or pick another tool before saving.";
      saveFeedback.classList.add('error');
      saveFeedback.classList.add('visible');
      return false;
    }
    // An in-flight probe means "unknown", not "usable". localAgentBlocks() above
    // only fires on a CONFIRMED false, by design: Apply is one global button and
    // must not gray out mid-probe for an unrelated tab's edit (rule 2). That
    // leaves a 161-1772 ms window (single-tool probe cost, DetectAgents.ts) in
    // which a click would persist aiProvider: 'local-agent' against a tool
    // nobody has verified — so the race is closed HERE instead, by HOLDING the
    // save until the reply arrives. The localAgentProbeResult handler then
    // re-enters this function, which either posts or reports the tool as
    // unavailable through the branch above.
    if (aiProviderSelect.value === 'local-agent' && localAgentAvailable === null) {
      pendingApply = true;
      saveFeedback.textContent =
        'Checking ' + localAgentToolOptionLabel(localAgentToolSelect.value) + '…';
      saveFeedback.classList.remove('error');
      saveFeedback.classList.add('visible');
      // Watchdog. handleProbeLocalAgent replies on every path a dropdown pick can
      // take, but a held save must not depend on that promise: one lost reply
      // would swallow the click with no save and no error, and the user has no
      // way to tell that from a slow probe. Armed only when a save is actually
      // held (never on an ordinary probe), and set well past the 1772 ms
      // worst-case so a slow-but-live probe still wins.
      if (pendingApplyTimer) clearTimeout(pendingApplyTimer);
      pendingApplyTimer = setTimeout(function() {
        pendingApplyTimer = null;
        if (!pendingApply) return;
        pendingApply = false;
        saveFeedback.textContent =
          "Couldn't verify " + localAgentToolOptionLabel(localAgentToolSelect.value) +
          ' — nothing was saved. Click Apply to try again.';
        saveFeedback.classList.add('error');
        saveFeedback.classList.add('visible');
        abortApplyChains();
      }, 8000);
      // Truthy: the save is queued, not refused. See the docstring — the
      // Migrate/Sync chains must stay armed across the hold.
      return true;
    }
    var maxVal = maxTokensInput.value.trim();
    vscode.postMessage({
      command: 'applySettings',
      settings: {
        apiKey: apiKeyInput.value.trim(),
        model: modelSelect.value,
        maxTokens: maxVal.length > 0 ? Number(maxVal) : null,
        aiProvider: aiProviderSelect.value,
        localAgentTool: localAgentToolSelect.value,
        localAgentModel: storedLocalAgentModel,
        jolliApiKey: getActiveJolliApiKeyValue().trim(),
        claudeEnabled: claudeEnabledInput.checked,
        codexEnabled: codexEnabledInput.checked,
        geminiEnabled: geminiEnabledInput.checked,
        openCodeEnabled: openCodeEnabledInput.checked,
        cursorEnabled: cursorEnabledInput.checked,
        devinEnabled: devinEnabledInput.checked,
        copilotEnabled: copilotEnabledInput.checked,
        clineEnabled: clineEnabledInput.checked,
        antigravityEnabled: antigravityEnabledInput.checked,
        kimiEnabled: kimiEnabledInput.checked,
        globalInstructions: globalInstructionsInput.checked,
        localFolder: localFolderInput.value.trim(),
        excludePatterns: excludePatternsInput.value,
        compileExcludeFolders: compileExcludeFoldersInput.value,
        dcoSignoff: dcoSignoffInput.checked,
        autoSyncEnabled: autoSyncEnabledInput ? autoSyncEnabledInput.checked : false,
        syncTranscripts: syncTranscriptsInput ? syncTranscriptsInput.checked : false,
        // Parse minutes → seconds and clamp on the way out so the host gets a
        // value it can write straight into config.json. The number input's
        // min=90 attribute handles most user mistakes; we clamp defensively
        // for blank / non-numeric edge cases.
        syncPollIntervalSec: (function () {
          if (!syncPollIntervalMinInput) return null;
          const raw = syncPollIntervalMinInput.value.trim();
          if (raw.length === 0) return null;
          const n = Number(raw);
          if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
          const clampedMin = Math.max(90, Math.min(1440, n));
          return clampedMin * 60;
        })(),
      },
      maskedApiKey: maskedApiKey,
      maskedJolliApiKey: maskedJolliApiKey,
    });
    return true;
  }

  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', function() {
      // Pressing "Sync now" implies the user wants the toggle state they're
      // looking at — not whatever was last saved. If the form is dirty,
      // chain Apply -> syncNow via pendingSyncAfterApply so we (a) wait
      // for the host to actually persist before triggering the round and
      // (b) abort cleanly if the save is rejected (settingsError). Same
      // pattern as confirmDirtyMigrateResult -> migrate.
      if (isDirty) {
        pendingSyncAfterApply = true;
        if (!submitApplySettings()) {
          pendingSyncAfterApply = false;
        }
        return;
      }
      vscode.postMessage({ command: 'syncNow' });
    });
  }
  // The interval input is meaningful only when the auto-sync toggle is on
  // (plan §0.7). We don't hide it (avoids layout shift) but disable it so the
  // grayed-out state communicates "this number won't take effect right now".
  function applyAutoIntervalEnabledState() {
    if (!syncPollIntervalMinInput) return;
    const on = !!(autoSyncEnabledInput && autoSyncEnabledInput.checked);
    syncPollIntervalMinInput.disabled = !on;
  }
  if (autoSyncEnabledInput) {
    autoSyncEnabledInput.addEventListener('change', function () {
      applyAutoIntervalEnabledState();
      checkDirty();
    });
  }
  if (syncTranscriptsInput) {
    syncTranscriptsInput.addEventListener('change', checkDirty);
  }
  if (syncPollIntervalMinInput) {
    syncPollIntervalMinInput.addEventListener('input', checkDirty);
    syncPollIntervalMinInput.addEventListener('change', checkDirty);
  }
  // Initial state: keep input disabled until we receive the first settings
  // message (so the user can't twiddle a number that isn't loaded yet).
  applyAutoIntervalEnabledState();

  applyBtn.addEventListener('click', function() {
    if (applyBtn.disabled) return;
    submitApplySettings();
  });

  // ── Messages from extension host ──
  function applyAuthState(msg) {
    signedIn = !!msg.signedIn;
    hasJolliKey = !!msg.hasJolliKey;
    if (jolliSiteLabel && typeof msg.jolliSiteLabel === 'string') {
      jolliSiteLabel.textContent = msg.jolliSiteLabel;
    }
    // Sign-in/sign-out flips aiProvider on disk; mirror that into the open
    // form so the next Apply doesn't clobber disk with a stale dropdown
    // value. Re-baseline initialState.aiProvider and recompute dirty so the
    // user's other unsaved edits keep their dirty bit, but this externally-
    // changed field doesn't show as a phantom user edit.
    if ((msg.aiProvider === 'jolli' || msg.aiProvider === 'anthropic')
        && aiProviderSelect.value !== msg.aiProvider) {
      aiProviderSelect.value = msg.aiProvider;
      initialState.aiProvider = msg.aiProvider;
      checkDirty();
    }
    syncProviderCard();
    syncSyncCard();
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.command) {
      case 'settingsLoaded':
        apiKeyInput.value = msg.maskedApiKey;
        modelSelect.value = msg.settings.model || 'sonnet';
        maxTokensInput.value = msg.settings.maxTokens != null ? String(msg.settings.maxTokens) : '';
        aiProviderSelect.value = msg.settings.aiProvider || 'anthropic';
        localAgentToolSelect.value = msg.settings.localAgentTool || 'claude-code';
        // Assign THEN filter, and the order is load-bearing: assigning a stored
        // model that belongs to a different tool (or no longer exists) leaves the
        // select holding a value this tool cannot accept, and the sync is what
        // corrects it to the tool's own default. Filtering first would instead
        // leave the bad value in place.
        // Seeded unconditionally, empty string included: an absent stored value
        // means "no preference", and leaving whatever the select happened to hold
        // would submit the first option as if the user had chosen it.
        storedLocalAgentModel = msg.settings.localAgentModel || '';
        if (localAgentModelSelect && msg.settings.localAgentModel) {
          localAgentModelSelect.value = msg.settings.localAgentModel;
        }
        syncLocalAgentModelRow();
        jolliApiKeyInput.value = msg.maskedJolliApiKey;
        jolliApiKeyNoKeyInput.value = msg.maskedJolliApiKey;
        claudeEnabledInput.checked = msg.settings.claudeEnabled;
        codexEnabledInput.checked = msg.settings.codexEnabled;
        geminiEnabledInput.checked = msg.settings.geminiEnabled;
        openCodeEnabledInput.checked = msg.settings.openCodeEnabled;
        cursorEnabledInput.checked = msg.settings.cursorEnabled;
        devinEnabledInput.checked = msg.settings.devinEnabled;
        copilotEnabledInput.checked = msg.settings.copilotEnabled;
        clineEnabledInput.checked = msg.settings.clineEnabled;
        antigravityEnabledInput.checked = msg.settings.antigravityEnabled;
        kimiEnabledInput.checked = msg.settings.kimiEnabled;
        globalInstructionsInput.checked = !!msg.settings.globalInstructions;
        localFolderInput.value = msg.settings.localFolder || '';
        renderMemoryBankState(msg.settings.memoryBank);
        excludePatternsInput.value = msg.settings.excludePatterns;
        compileExcludeFoldersInput.value = msg.settings.compileExcludeFolders;
        dcoSignoffInput.checked = !!msg.settings.dcoSignoff;
        if (autoSyncEnabledInput) autoSyncEnabledInput.checked = !!msg.settings.autoSyncEnabled;
        if (syncTranscriptsInput) syncTranscriptsInput.checked = !!msg.settings.syncTranscripts;
        if (syncPollIntervalMinInput) {
          // Host stores seconds; UI shows minutes. Empty → leave blank so the
          // input placeholder ('90') signals the default without forcing a
          // dirty form on every reload.
          const sec = msg.settings.syncPollIntervalSec;
          syncPollIntervalMinInput.value = typeof sec === 'number' && sec > 0 ? String(Math.round(sec / 60)) : '';
        }
        // Sync the interval input's enabled state with the auto toggle after
        // loading settings (so a fresh load with auto=off lands disabled).
        applyAutoIntervalEnabledState();
        maskedApiKey = msg.maskedApiKey;
        maskedJolliApiKey = msg.maskedJolliApiKey;
        // Clear all validation errors on fresh load
        document.querySelectorAll('.error').forEach(function(el) { el.classList.remove('error'); });
        document.querySelectorAll('.error-message').forEach(function(el) { el.textContent = ''; });
        hasErrors = false;
        applyAuthState(msg);
        updateAnthropicWarning();
        // The count arrives separately via 'missingSummaryCountLoaded' (computed
        // off the settings-load critical path). Reset to the pending state here,
        // and keep the button disabled until the count lands so it can't be
        // clicked on an unknown count.
        if (missingSummariesCount) missingSummariesCount.textContent = 'Checking…';
        if (generateSummariesBtn) generateSummariesBtn.disabled = true;
        // Probe on open (not just on dropdown change) so a panel opened with
        // an already-unavailable tool configured shows the problem immediately.
        // Gated on the provider: the local-agent card is hidden for every other
        // provider, so an unconditional probe would spend a 161-1772 ms
        // subprocess producing a status line nobody can see. Switching TO
        // local-agent later re-probes via the aiProvider change handler.
        if (aiProviderSelect.value === 'local-agent') probeLocalAgent();
        captureInitialState();
        break;
      case 'missingSummaryCountLoaded': {
        const n = msg.missingSummaryCount;
        const where = msg.repoName ? ' in ' + msg.repoName : ' in this repository';
        if (missingSummariesCount) {
          missingSummariesCount.textContent = typeof n === 'number'
            ? (n === 0
                ? 'All your commits' + where + ' already have summaries.'
                : n + ' of your commits' + where + ' still need summaries.')
            : '';
        }
        if (generateSummariesBtn) generateSummariesBtn.disabled = n === 0;
        break;
      }
      case 'authStateChanged':
        // Pushed after sign-in / sign-out so the cards re-render without
        // requiring a full settings reload. Mirror IntelliJ's auth listener.
        applyAuthState(msg);
        break;
      case 'localAgentProbeResult':
        // Ignore a stale reply for a tool the user has already moved off —
        // e.g. switched from Cursor to Codex before Cursor's probe returned.
        if (msg.tool !== localAgentProbeTool) break;
        localAgentAvailable = !!msg.available;
        if (localAgentStatus) {
          // Derive the label from localAgentProbeTool (the id the reply is
          // for), not localAgentToolSelect.selectedIndex — selectedIndex is
          // -1 when nothing is selected, and indexing options[-1] throws.
          localAgentStatus.textContent = msg.available
            ? ''
            : localAgentToolOptionLabel(localAgentProbeTool) +
              ' not found on this machine. Install it, or pick another tool.';
          localAgentStatus.classList.toggle('error', !msg.available);
        }
        updateApplyBtn();
        // Resume a save the probe was holding. Reached only past the stale-reply
        // guard above, so the verdict being acted on is the one for the tool
        // currently selected. Re-entering submitApplySettings() (rather than
        // posting from here) keeps ONE save chokepoint: availability is now a
        // definite true/false, so it either posts or takes the
        // localAgentBlocks() error branch with its existing wording.
        if (pendingApply) {
          cancelPendingApply();
          // Disarm the Migrate/Sync chains here if the verdict turned the held
          // save into a rejection — they were deliberately left armed across the
          // hold, so this is the only place that can still catch them.
          if (!submitApplySettings()) abortApplyChains();
        }
        break;
      case 'pushControlLoaded':
        // The machine-wide repo list — pushed after settingsLoaded and again
        // after each toggle so each row reflects the PERSISTED flag (this also
        // reverts an optimistic checkbox when a toggle failed).
        pushControlRepos = msg.repos || [];
        pushControlUnreadable = msg.unreadable;
        renderPushControl();
        if (msg.status) {
          var pcStatus = document.getElementById('pushControlStatus');
          if (pcStatus) {
            pcStatus.textContent = msg.status;
            pcStatus.classList.add('visible');
            // Auto-hide the settled status so it doesn't hang around forever
            // (mirrors saveFeedback). A newer toggle overwrites+re-arms it.
            if (window.__pcStatusTimer) clearTimeout(window.__pcStatusTimer);
            window.__pcStatusTimer = setTimeout(function() { pcStatus.classList.remove('visible'); }, 4000);
          }
        }
        break;
      case 'spaceBindingResolved':
        // Progressive reveal (JOLLI-2152): SettingsWebviewPanel posts one of
        // these the instant EACH row's own probe settles, well before the full
        // batch below — merge just that entry in and re-render now, so a fast
        // row (the current repo, say) isn't held on "Checking…" behind the
        // slowest one in the batch. Deliberately does NOT touch
        // spaceBindingsPending: every other row not yet in spaceBindings must
        // keep reading as "Checking…" (pending), not "Not checked" (settled
        // but missing) — only spaceBindingsLoaded below may flip that.
        //
        // It DOES clear spaceBindingsSignedOut — normally already cleared by the
        // spaceBindingsPending message that opens the pass, but a per-row binding
        // can only come from a signed-in pass, so its arrival is itself the proof
        // and the flag must never be what hides it (renderPushControl checks
        // signed-out FIRST).
        spaceBindingsSignedOut = false;
        spaceBindings[msg.repoIdentity] = msg.binding;
        renderPushControl();
        break;
      case 'spaceBindingsPending':
        // A fresh resolution pass is starting (panel open, or a sign-in/sign-out
        // while it stays open). Drop the previous pass's answers and go back to
        // "Checking…" instead of leaving stale cells — including, after a
        // sign-in, a settled signed-out batch whose "—" cells would otherwise
        // outlive the sign-in for the whole fan-out. Mirrors the dashboard's
        // doSignIn/doSignOut reset of the same three fields.
        spaceBindingsPending = true;
        spaceBindingsSignedOut = false;
        spaceBindings = {};
        renderPushControl();
        break;
      case 'spaceBindingsLoaded':
        // A separate, later follow-up to pushControlLoaded (JOLLI-2152) — never
        // blocks the repo list's own first paint. Re-renders whatever repo list
        // is already known with the newly-resolved Space bindings merged in.
        // Belt-and-suspenders alongside spaceBindingResolved above: authoritative
        // for the signed-out case (no per-row messages exist for it) and for any
        // row an incremental message missed, and is what actually flips
        // spaceBindingsPending so a still-missing row reads "Not checked".
        spaceBindingsPending = false;
        spaceBindingsSignedOut = !!msg.signedOut;
        spaceBindings = msg.bindings || {};
        renderPushControl();
        break;
      case 'setLocalFolder':
        localFolderInput.value = msg.path || '';
        checkDirty();
        break;
      case 'rebuildKnowledgeBaseDone':
        rebuildKbBtn.disabled = false;
        rebuildKbStatus.textContent = msg.success
          ? 'Rebuild complete: ' + (msg.message || '')
          : 'Rebuild failed: ' + (msg.message || 'unknown error');
        break;
      case 'generateMissingSummariesDone':
        if (generateSummariesBtn) generateSummariesBtn.disabled = false;
        if (generateSummariesStatus) {
          generateSummariesStatus.textContent = msg.success
            ? 'Done: ' + (msg.message || '')
            : 'Failed: ' + (msg.message || 'unknown error');
        }
        break;
      case 'confirmDirtyMigrateResult':
        if (!msg.proceed) {
          // User cancelled — leave the form exactly as it was.
          break;
        }
        // User chose "Apply Changes & Migrate". Try to submit the apply; if
        // client-side validation blocks it, the chain is aborted (the same
        // saveFeedback banner the regular Apply path would show is already up).
        rebuildKbStatus.textContent = 'Saving settings…';
        pendingMigrateAfterApply = true;
        if (!submitApplySettings()) {
          pendingMigrateAfterApply = false;
          rebuildKbStatus.textContent = '';
        }
        break;
      case 'settingsSaved':
        saveFeedback.textContent = 'Settings saved';
        saveFeedback.classList.remove('error');
        saveFeedback.classList.add('visible');
        renderMemoryBankState(msg.memoryBank);
        setTimeout(function() { saveFeedback.classList.remove('visible'); }, 2000);
        captureInitialState();
        if (pendingMigrateAfterApply) {
          pendingMigrateAfterApply = false;
          startRebuild();
        }
        if (pendingSyncAfterApply) {
          pendingSyncAfterApply = false;
          vscode.postMessage({ command: 'syncNow' });
        }
        break;
      case 'settingsError':
        // Persistent red banner — stays until the user edits a field (handled
        // by the input listeners above, which clear it via clearSaveFeedback).
        saveFeedback.textContent = msg.message;
        saveFeedback.classList.add('error');
        saveFeedback.classList.add('visible');
        // Host rejected the save (e.g. server-side jolli key validation).
        abortApplyChains();
        // Deliberately does NOT touch pendingApply. This message is about a save
        // that was POSTED; a held save has posted nothing, so an error arriving
        // mid-hold belongs to an earlier submission. Cancelling here would drop
        // the newer held save silently — let it resume and be judged on its own.
        break;
    }
  });

  // ── Initial load ──
  vscode.postMessage({ command: 'loadSettings' });
  `;
}
