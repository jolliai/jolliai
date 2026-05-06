/**
 * BindingChooserScriptBuilder
 *
 * Returns the JavaScript embedded in the BindingChooserWebviewPanel webview.
 *
 * Responsibilities (UI-only — all HTTP I/O happens in the extension host):
 * - Render the spaces list once `init` arrives from the host.
 * - Validate the selected existing space.
 * - On 409 race-winner banner, replace the form area and offer "OK, push now".
 */

export function buildBindingChooserScript(): string {
	return `
const vscode = acquireVsCodeApi();

// ── DOM refs ──
const repoUrlDisplay   = document.getElementById('repoUrlDisplay');
const repoHint         = document.getElementById('repoHint');
const banner           = document.getElementById('banner');
const bannerText       = document.getElementById('bannerText');
const bannerOkBtn      = document.getElementById('bannerOkBtn');

const paneExisting     = document.getElementById('paneExisting');

const spacesListEl     = document.getElementById('spacesList');
const existingErr      = document.getElementById('existing-error');

const generalError     = document.getElementById('generalError');
const confirmBtn       = document.getElementById('confirmBtn');
const cancelBtn        = document.getElementById('cancelBtn');

// ── State ──
let spaces = [];
let pendingWinner = null;

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clearAllErrors() {
  existingErr.textContent = '';
  generalError.textContent = '';
}

function renderSpaces() {
  if (!spaces || spaces.length === 0) {
    spacesListEl.innerHTML = '<div class="spaces-empty">No Memory spaces available. Create one on jolli.ai, then try Push again.</div>';
    return;
  }
  spacesListEl.innerHTML = spaces.map(function(s) {
    var id = 'choiceExisting_' + s.id;
    return '<label class="space-row">' +
      '<input type="radio" name="existingSpace" value="' + s.id + '" id="' + id + '" />' +
      '<span class="space-name">' + escHtml(s.name) + '</span>' +
      '<span class="space-slug">/' + escHtml(s.slug) + '</span>' +
      '</label>';
  }).join('');
}

function selectedExistingSpaceId() {
  var radios = document.getElementsByName('existingSpace');
  for (var i = 0; i < radios.length; i++) {
    if (radios[i].checked) {
      var n = parseInt(radios[i].value, 10);
      return isNaN(n) ? null : n;
    }
  }
  return null;
}

function validate() {
  clearAllErrors();
  var ok = true;
  if (selectedExistingSpaceId() == null) {
    existingErr.textContent = 'Please pick a Memory space.';
    ok = false;
  }
  return ok;
}

function setBusy(b) {
  confirmBtn.disabled = b || spaces.length === 0;
  cancelBtn.disabled  = b;
  Array.prototype.forEach.call(document.getElementsByName('existingSpace'), function(r) { r.disabled = b; });
}

// ── Event wiring ──
document.addEventListener('change', function(e) {
  if (e.target && e.target.name === 'existingSpace') {
    existingErr.textContent = '';
    generalError.textContent = '';
  }
});

cancelBtn.addEventListener('click', function() {
  vscode.postMessage({ command: 'cancel' });
});

confirmBtn.addEventListener('click', function() {
  if (!validate()) return;
  setBusy(true);
  vscode.postMessage({
    command: 'confirm',
    jmSpaceId: selectedExistingSpaceId(),
  });
});

bannerOkBtn.addEventListener('click', function() {
  if (pendingWinner) {
    vscode.postMessage({ command: 'acceptWinner', winner: pendingWinner });
  }
});

// ── Host → webview messages ──
window.addEventListener('message', function(event) {
  var msg = event.data;
  if (!msg || !msg.command) return;
  if (msg.command === 'init') {
    repoUrlDisplay.textContent = msg.repoUrl || '';
    if (msg.repoUrl && msg.repoUrl.indexOf('file://') === 0) {
      repoHint.textContent = 'No git remote configured — this binding is local to this workspace path.';
      repoHint.classList.remove('hidden');
    } else {
      repoHint.classList.add('hidden');
    }
    spaces = msg.spaces || [];
    renderSpaces();
    // Pre-select ONLY the server-designated default space. If the server did
    // not nominate one (or nominated an id we did not receive), leave every
    // radio unchecked so the user must explicitly pick — auto-selecting
    // spaces[0] would silently bind the repo to whichever space happened to
    // be returned first, and the list endpoint does not guarantee order.
    var defaultId = (typeof msg.defaultSpaceId === 'number') ? msg.defaultSpaceId : null;
    if (defaultId != null) {
      for (var i = 0; i < spaces.length; i++) {
        if (spaces[i].id === defaultId) {
          var preselectEl = document.getElementById('choiceExisting_' + defaultId);
          if (preselectEl) preselectEl.checked = true;
          break;
        }
      }
    }
    setBusy(false);
  } else if (msg.command === 'error') {
    setBusy(false);
    generalError.textContent = msg.message || 'Something went wrong.';
  } else if (msg.command === 'winnerOnRace') {
    pendingWinner = msg.winner;
    var name = (msg.winner && msg.winner.jmSpaceName) || 'another space';
    bannerText.innerHTML =
      'Another teammate just bound this repo to <strong>' + escHtml(name) + '</strong>. Using that one.';
    // Replace the form area and primary action.
    paneExisting.classList.add('hidden');
    generalError.textContent = '';
    banner.classList.remove('hidden');
    setBusy(false);
    confirmBtn.classList.add('hidden');
  } else if (msg.command === 'done') {
    // Host disposes the panel; nothing to do here.
  }
});

// Tell host we're ready to receive init.
vscode.postMessage({ command: 'ready' });
`;
}
