/**
 * SettingsScriptBuilder
 *
 * Returns the JavaScript embedded in the Settings webview for:
 * - Form state management and dirty tracking
 * - Real-time validation (API key prefixes, maxTokens)
 * - API key masking detection (unchanged masked value = preserve original)
 * - Apply Changes button and feedback
 *
 * Pure string template — no logic dependencies on other view modules.
 */

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
  const jolliApiKeyInput = document.getElementById('jolliApiKey');
  const claudeEnabledInput = document.getElementById('claudeEnabled');
  const codexEnabledInput = document.getElementById('codexEnabled');
  const geminiEnabledInput = document.getElementById('geminiEnabled');
  const openCodeEnabledInput = document.getElementById('openCodeEnabled');
  const cursorEnabledInput = document.getElementById('cursorEnabled');
  const localFolderInput = document.getElementById('localFolder');
  const browseLocalFolderBtn = document.getElementById('browseLocalFolderBtn');
  const rebuildKbBtn = document.getElementById('rebuildKbBtn');
  const rebuildKbStatus = document.getElementById('rebuildKbStatus');
  const excludePatternsInput = document.getElementById('excludePatterns');
  const applyBtn = document.getElementById('applyBtn');
  const saveFeedback = document.getElementById('saveFeedback');

  // ── State ──
  let maskedApiKey = '';
  let maskedJolliApiKey = '';
  let initialState = {};
  let isDirty = false;
  let hasErrors = false;

  // ── Validation ──
  var ALLOWED_JOLLI_HOSTS = ['jolli.ai', 'jolli.dev', 'jolli.cloud', 'jolli-local.me'];

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
      errorEl.textContent = msg;
    } else {
      input.classList.remove('error');
      errorEl.textContent = '';
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
    valid = validateField(jolliApiKeyInput, 'jolliApiKey-error', validateJolliApiKeyRule) && valid;
    valid = validateField(maxTokensInput, 'maxTokens-error', function(v) {
      if (v.length > 0 && (isNaN(Number(v)) || Number(v) < 1 || !Number.isInteger(Number(v)))) return 'Must be a positive integer';
      return '';
    }) && valid;
    // At least one integration must be enabled
    var intError = document.getElementById('integrations-error');
    if (!claudeEnabledInput.checked && !codexEnabledInput.checked && !geminiEnabledInput.checked && !openCodeEnabledInput.checked && !cursorEnabledInput.checked) {
      intError.textContent = 'At least one integration must be enabled';
      valid = false;
    } else {
      intError.textContent = '';
    }
    hasErrors = !valid;
    updateApplyBtn();
  }

  // ── Local Memory Bank helpers ──
  browseLocalFolderBtn.addEventListener('click', function() {
    vscode.postMessage({ command: 'browseLocalFolder' });
  });

  rebuildKbBtn.addEventListener('click', function() {
    if (rebuildKbBtn.disabled) return;
    rebuildKbBtn.disabled = true;
    rebuildKbStatus.textContent = 'Rebuilding…';
    vscode.postMessage({ command: 'rebuildKnowledgeBase' });
  });

  // ── Dirty tracking ──
  function captureInitialState() {
    initialState = {
      apiKey: apiKeyInput.value,
      model: modelSelect.value,
      maxTokens: maxTokensInput.value,
      jolliApiKey: jolliApiKeyInput.value,
      claudeEnabled: claudeEnabledInput.checked,
      codexEnabled: codexEnabledInput.checked,
      geminiEnabled: geminiEnabledInput.checked,
      openCodeEnabled: openCodeEnabledInput.checked,
      cursorEnabled: cursorEnabledInput.checked,
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
      jolliApiKeyInput.value !== initialState.jolliApiKey ||
      claudeEnabledInput.checked !== initialState.claudeEnabled ||
      codexEnabledInput.checked !== initialState.codexEnabled ||
      geminiEnabledInput.checked !== initialState.geminiEnabled ||
      openCodeEnabledInput.checked !== initialState.openCodeEnabled ||
      cursorEnabledInput.checked !== initialState.cursorEnabled ||
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

  // ── Event listeners for all inputs ──
  [apiKeyInput, jolliApiKeyInput, maxTokensInput, excludePatternsInput].forEach(function(input) {
    input.addEventListener('input', function() { validateAll(); checkDirty(); clearSaveFeedback(); });
  });
  modelSelect.addEventListener('change', function() { checkDirty(); clearSaveFeedback(); });
  [claudeEnabledInput, codexEnabledInput, geminiEnabledInput, openCodeEnabledInput, cursorEnabledInput].forEach(function(input) {
    input.addEventListener('change', function() { validateAll(); checkDirty(); clearSaveFeedback(); });
  });

  // ── Apply Changes ──
  applyBtn.addEventListener('click', function() {
    if (applyBtn.disabled) return;
    // Final client-side pass so inline errors stay in sync even if a field was
    // changed programmatically or before any input event had a chance to fire.
    // Server-side validation runs regardless, but this gives the user the
    // inline red-text field marker immediately.
    validateAll();
    if (hasErrors) {
      saveFeedback.textContent = 'Please fix the highlighted fields before saving';
      saveFeedback.classList.add('error');
      saveFeedback.classList.add('visible');
      return;
    }
    var maxVal = maxTokensInput.value.trim();
    vscode.postMessage({
      command: 'applySettings',
      settings: {
        apiKey: apiKeyInput.value.trim(),
        model: modelSelect.value,
        maxTokens: maxVal.length > 0 ? Number(maxVal) : null,
        jolliApiKey: jolliApiKeyInput.value.trim(),
        claudeEnabled: claudeEnabledInput.checked,
        codexEnabled: codexEnabledInput.checked,
        geminiEnabled: geminiEnabledInput.checked,
        openCodeEnabled: openCodeEnabledInput.checked,
        cursorEnabled: cursorEnabledInput.checked,
        localFolder: localFolderInput.value.trim(),
        excludePatterns: excludePatternsInput.value,
      },
      maskedApiKey: maskedApiKey,
      maskedJolliApiKey: maskedJolliApiKey,
    });
  });

  // ── Messages from extension host ──
  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.command) {
      case 'settingsLoaded':
        apiKeyInput.value = msg.maskedApiKey;
        modelSelect.value = msg.settings.model || 'sonnet';
        maxTokensInput.value = msg.settings.maxTokens != null ? String(msg.settings.maxTokens) : '';
        jolliApiKeyInput.value = msg.maskedJolliApiKey;
        claudeEnabledInput.checked = msg.settings.claudeEnabled;
        codexEnabledInput.checked = msg.settings.codexEnabled;
        geminiEnabledInput.checked = msg.settings.geminiEnabled;
        openCodeEnabledInput.checked = msg.settings.openCodeEnabled;
        cursorEnabledInput.checked = msg.settings.cursorEnabled;
        localFolderInput.value = msg.settings.localFolder || '';
        excludePatternsInput.value = msg.settings.excludePatterns;
        maskedApiKey = msg.maskedApiKey;
        maskedJolliApiKey = msg.maskedJolliApiKey;
        // Clear all validation errors on fresh load
        document.querySelectorAll('.error').forEach(function(el) { el.classList.remove('error'); });
        document.querySelectorAll('.error-message').forEach(function(el) { el.textContent = ''; });
        hasErrors = false;
        captureInitialState();
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
      case 'settingsSaved':
        saveFeedback.textContent = 'Settings saved';
        saveFeedback.classList.remove('error');
        saveFeedback.classList.add('visible');
        setTimeout(function() { saveFeedback.classList.remove('visible'); }, 2000);
        captureInitialState();
        break;
      case 'settingsError':
        // Persistent red banner — stays until the user edits a field (handled
        // by the input listeners above, which clear it via clearSaveFeedback).
        saveFeedback.textContent = msg.message;
        saveFeedback.classList.add('error');
        saveFeedback.classList.add('visible');
        break;
    }
  });

  // ── Initial load ──
  vscode.postMessage({ command: 'loadSettings' });
  `;
}
