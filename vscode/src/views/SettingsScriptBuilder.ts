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
  // Two Jolli API key inputs (jolli-ok and jolli-nokey cards) — kept in sync.
  const jolliApiKeyInput = document.getElementById('jolliApiKey');
  const jolliApiKeyNoKeyInput = document.getElementById('jolliApiKeyNoKey');
  const jolliSiteLabel = document.getElementById('jolliSiteLabel');
  const claudeEnabledInput = document.getElementById('claudeEnabled');
  const codexEnabledInput = document.getElementById('codexEnabled');
  const geminiEnabledInput = document.getElementById('geminiEnabled');
  const openCodeEnabledInput = document.getElementById('openCodeEnabled');
  const cursorEnabledInput = document.getElementById('cursorEnabled');
  const copilotEnabledInput = document.getElementById('copilotEnabled');
  const localFolderInput = document.getElementById('localFolder');
  const browseLocalFolderBtn = document.getElementById('browseLocalFolderBtn');
  const rebuildKbBtn = document.getElementById('rebuildKbBtn');
  const rebuildKbStatus = document.getElementById('rebuildKbStatus');
  const excludePatternsInput = document.getElementById('excludePatterns');
  const applyBtn = document.getElementById('applyBtn');
  const saveFeedback = document.getElementById('saveFeedback');
  const anthropicMissingWarn = document.getElementById('anthropicMissingWarn');
  const summarySignInBtn = document.getElementById('summarySignInBtn');
  const summaryReLoginBtn = document.getElementById('summaryReLoginBtn');
  const syncSignInBtn = document.getElementById('syncSignInBtn');
  const syncSignOutBtn = document.getElementById('syncSignOutBtn');

  // ── State ──
  let maskedApiKey = '';
  let maskedJolliApiKey = '';
  let initialState = {};
  let isDirty = false;
  let hasErrors = false;
  // Auth state pushed by the extension host (settingsLoaded + authStateChanged).
  let signedIn = false;
  let hasJolliKey = false;
  // Set when the user confirmed "Apply Changes & Migrate" in the dirty-folder
  // dialog. We fire applySettings first, then chain into rebuildKnowledgeBase
  // on settingsSaved (and abort the chain on settingsError so the migrate
  // never runs against unsaved/invalid state).
  let pendingMigrateAfterApply = false;

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
    if (!claudeEnabledInput.checked && !codexEnabledInput.checked && !geminiEnabledInput.checked && !openCodeEnabledInput.checked && !cursorEnabledInput.checked && !copilotEnabledInput.checked) {
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
      jolliApiKey: getActiveJolliApiKeyValue(),
      claudeEnabled: claudeEnabledInput.checked,
      codexEnabled: codexEnabledInput.checked,
      geminiEnabled: geminiEnabledInput.checked,
      openCodeEnabled: openCodeEnabledInput.checked,
      cursorEnabled: cursorEnabledInput.checked,
      copilotEnabled: copilotEnabledInput.checked,
      localFolder: localFolderInput.value,
      excludePatterns: excludePatternsInput.value,
    };
    checkDirty();
  }

  function checkDirty() {
    isDirty = (
      apiKeyInput.value !== initialState.apiKey ||
      modelSelect.value !== initialState.model ||
      maxTokensInput.value !== initialState.maxTokens ||
      aiProviderSelect.value !== initialState.aiProvider ||
      getActiveJolliApiKeyValue() !== initialState.jolliApiKey ||
      claudeEnabledInput.checked !== initialState.claudeEnabled ||
      codexEnabledInput.checked !== initialState.codexEnabled ||
      geminiEnabledInput.checked !== initialState.geminiEnabled ||
      openCodeEnabledInput.checked !== initialState.openCodeEnabled ||
      cursorEnabledInput.checked !== initialState.cursorEnabled ||
      copilotEnabledInput.checked !== initialState.copilotEnabled ||
      localFolderInput.value !== initialState.localFolder ||
      excludePatternsInput.value !== initialState.excludePatterns
    );
    updateApplyBtn();
  }

  function updateApplyBtn() {
    // Gate on both "nothing to save" and "has client-side errors". The click
    // handler also re-runs validateAll() and surfaces a saveFeedback message
    // if a validation error slips through (e.g. programmatic value change),
    // so the user gets explicit feedback rather than a swallowed click.
    applyBtn.disabled = !isDirty || hasErrors;
  }

  function clearSaveFeedback() {
    saveFeedback.classList.remove('visible');
    saveFeedback.classList.remove('error');
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
  [maxTokensInput, excludePatternsInput].forEach(function(input) {
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
  aiProviderSelect.addEventListener('change', function() {
    checkDirty(); clearSaveFeedback(); syncProviderCard();
  });
  [claudeEnabledInput, codexEnabledInput, geminiEnabledInput, openCodeEnabledInput, cursorEnabledInput, copilotEnabledInput].forEach(function(input) {
    input.addEventListener('change', function() { validateAll(); checkDirty(); clearSaveFeedback(); });
  });

  // ── Apply Changes ──
  // Returns true if the apply message was posted, false if a validation error
  // blocked the post. The Migrate-after-Apply chain uses the return value to
  // decide whether to clear pendingMigrateAfterApply on the spot.
  function submitApplySettings() {
    // Final client-side pass so inline errors stay in sync even if a field was
    // changed programmatically or before any input event had a chance to fire.
    validateAll();
    if (hasErrors) {
      saveFeedback.textContent = 'Please fix the highlighted fields before saving';
      saveFeedback.classList.add('error');
      saveFeedback.classList.add('visible');
      return false;
    }
    var maxVal = maxTokensInput.value.trim();
    vscode.postMessage({
      command: 'applySettings',
      settings: {
        apiKey: apiKeyInput.value.trim(),
        model: modelSelect.value,
        maxTokens: maxVal.length > 0 ? Number(maxVal) : null,
        aiProvider: aiProviderSelect.value,
        jolliApiKey: getActiveJolliApiKeyValue().trim(),
        claudeEnabled: claudeEnabledInput.checked,
        codexEnabled: codexEnabledInput.checked,
        geminiEnabled: geminiEnabledInput.checked,
        openCodeEnabled: openCodeEnabledInput.checked,
        cursorEnabled: cursorEnabledInput.checked,
        copilotEnabled: copilotEnabledInput.checked,
        localFolder: localFolderInput.value.trim(),
        excludePatterns: excludePatternsInput.value,
      },
      maskedApiKey: maskedApiKey,
      maskedJolliApiKey: maskedJolliApiKey,
    });
    return true;
  }

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
        jolliApiKeyInput.value = msg.maskedJolliApiKey;
        jolliApiKeyNoKeyInput.value = msg.maskedJolliApiKey;
        claudeEnabledInput.checked = msg.settings.claudeEnabled;
        codexEnabledInput.checked = msg.settings.codexEnabled;
        geminiEnabledInput.checked = msg.settings.geminiEnabled;
        openCodeEnabledInput.checked = msg.settings.openCodeEnabled;
        cursorEnabledInput.checked = msg.settings.cursorEnabled;
        copilotEnabledInput.checked = msg.settings.copilotEnabled;
        localFolderInput.value = msg.settings.localFolder || '';
        excludePatternsInput.value = msg.settings.excludePatterns;
        maskedApiKey = msg.maskedApiKey;
        maskedJolliApiKey = msg.maskedJolliApiKey;
        // Clear all validation errors on fresh load
        document.querySelectorAll('.error').forEach(function(el) { el.classList.remove('error'); });
        document.querySelectorAll('.error-message').forEach(function(el) { el.textContent = ''; });
        hasErrors = false;
        applyAuthState(msg);
        updateAnthropicWarning();
        captureInitialState();
        break;
      case 'authStateChanged':
        // Pushed after sign-in / sign-out so the cards re-render without
        // requiring a full settings reload. Mirror IntelliJ's auth listener.
        applyAuthState(msg);
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
        setTimeout(function() { saveFeedback.classList.remove('visible'); }, 2000);
        captureInitialState();
        if (pendingMigrateAfterApply) {
          pendingMigrateAfterApply = false;
          startRebuild();
        }
        break;
      case 'settingsError':
        // Persistent red banner — stays until the user edits a field (handled
        // by the input listeners above, which clear it via clearSaveFeedback).
        saveFeedback.textContent = msg.message;
        saveFeedback.classList.add('error');
        saveFeedback.classList.add('visible');
        if (pendingMigrateAfterApply) {
          // Host rejected the save (e.g. server-side jolli key validation).
          // Abort the chain so we don't migrate against unsaved state.
          pendingMigrateAfterApply = false;
          rebuildKbStatus.textContent = '';
        }
        break;
    }
  });

  // ── Initial load ──
  vscode.postMessage({ command: 'loadSettings' });
  `;
}
