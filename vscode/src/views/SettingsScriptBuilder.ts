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

/** Returns the JavaScript for the Settings webview interactions. */
export function buildSettingsScript(): string {
	return `
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
  const localFolderInput = document.getElementById('localFolder');
  const browseLocalFolderBtn = document.getElementById('browseLocalFolderBtn');
  const pushActionJolliRadio = document.getElementById('pushActionJolli');
  const pushActionBothRadio = document.getElementById('pushActionBoth');
  const pushActionBothHint = document.getElementById('pushActionBothHint');
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
    valid = validateField(jolliApiKeyInput, 'jolliApiKey-error', function(v) {
      if (v.length > 0 && v !== maskedJolliApiKey) {
        if (!v.startsWith('sk-jol-')) return 'Must start with sk-jol-';
        if (v.length < 20) return 'Key looks incomplete';
      }
      return '';
    }) && valid;
    valid = validateField(maxTokensInput, 'maxTokens-error', function(v) {
      if (v.length > 0 && (isNaN(Number(v)) || Number(v) < 1 || !Number.isInteger(Number(v)))) return 'Must be a positive integer';
      return '';
    }) && valid;
    // At least one integration must be enabled
    var intError = document.getElementById('integrations-error');
    if (!claudeEnabledInput.checked && !codexEnabledInput.checked && !geminiEnabledInput.checked && !openCodeEnabledInput.checked) {
      intError.textContent = 'At least one integration must be enabled';
      valid = false;
    } else {
      intError.textContent = '';
    }
    hasErrors = !valid;
    updateApplyBtn();
  }

  // ── Local Memories helpers ──
  function updatePushActionBothState() {
    var hasFolder = localFolderInput.value.trim().length > 0;
    pushActionBothRadio.disabled = !hasFolder;
    pushActionBothHint.textContent = hasFolder ? '' : '— set a local folder first';
    if (!hasFolder && pushActionBothRadio.checked) {
      pushActionJolliRadio.checked = true;
    }
  }

  browseLocalFolderBtn.addEventListener('click', function() {
    vscode.postMessage({ command: 'browseLocalFolder' });
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
      localFolder: localFolderInput.value,
      pushAction: pushActionBothRadio.checked ? 'both' : 'jolli',
      excludePatterns: excludePatternsInput.value,
    };
    checkDirty();
  }

  function checkDirty() {
    var currentPushAction = pushActionBothRadio.checked ? 'both' : 'jolli';
    isDirty = (
      apiKeyInput.value !== initialState.apiKey ||
      modelSelect.value !== initialState.model ||
      maxTokensInput.value !== initialState.maxTokens ||
      jolliApiKeyInput.value !== initialState.jolliApiKey ||
      claudeEnabledInput.checked !== initialState.claudeEnabled ||
      codexEnabledInput.checked !== initialState.codexEnabled ||
      geminiEnabledInput.checked !== initialState.geminiEnabled ||
      openCodeEnabledInput.checked !== initialState.openCodeEnabled ||
      localFolderInput.value !== initialState.localFolder ||
      currentPushAction !== initialState.pushAction ||
      excludePatternsInput.value !== initialState.excludePatterns
    );
    updateApplyBtn();
  }

  function updateApplyBtn() {
    applyBtn.disabled = !isDirty || hasErrors;
  }

  // ── Event listeners for all inputs ──
  [apiKeyInput, jolliApiKeyInput, maxTokensInput, excludePatternsInput].forEach(function(input) {
    input.addEventListener('input', function() { validateAll(); checkDirty(); });
  });
  modelSelect.addEventListener('change', function() { checkDirty(); });
  [claudeEnabledInput, codexEnabledInput, geminiEnabledInput, openCodeEnabledInput].forEach(function(input) {
    input.addEventListener('change', function() { validateAll(); checkDirty(); });
  });
  [pushActionJolliRadio, pushActionBothRadio].forEach(function(input) {
    input.addEventListener('change', function() { checkDirty(); });
  });

  // ── Apply Changes ──
  applyBtn.addEventListener('click', function() {
    if (applyBtn.disabled) return;
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
        localFolder: localFolderInput.value.trim(),
        pushAction: pushActionBothRadio.checked ? 'both' : 'jolli',
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
        localFolderInput.value = msg.settings.localFolder || '';
        if (msg.settings.pushAction === 'both') {
          pushActionBothRadio.checked = true;
        } else {
          pushActionJolliRadio.checked = true;
        }
        updatePushActionBothState();
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
        updatePushActionBothState();
        checkDirty();
        break;
      case 'settingsSaved':
        saveFeedback.textContent = 'Settings saved';
        saveFeedback.classList.add('visible');
        setTimeout(function() { saveFeedback.classList.remove('visible'); }, 2000);
        captureInitialState();
        break;
      case 'settingsError':
        saveFeedback.textContent = msg.message;
        saveFeedback.classList.add('visible');
        setTimeout(function() {
          saveFeedback.classList.remove('visible');
        }, 3000);
        break;
    }
  });

  // ── Initial load ──
  vscode.postMessage({ command: 'loadSettings' });
  `;
}
