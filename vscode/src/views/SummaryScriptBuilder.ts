/**
 * SummaryScriptBuilder
 *
 * Returns the JavaScript embedded in the webview for interactive behaviors:
 * toggle expand/collapse, copy hash, copy markdown, push to Jolli, memory
 * edit/delete, E2E test guide CRUD, and PR section interactions.
 *
 * Pure string template — no logic dependencies on other view modules.
 */

import {
	buildPrMessageScript,
	buildPrSectionScript,
} from "../services/PrCommentService.js";

/** Returns the JavaScript for toggle interactions and the Copy Markdown button. */
export function buildScript(): string {
	return `
  const vscode = acquireVsCodeApi();

  // Toggle expand/collapse for individual memory sections (skip clicks on action buttons)
  document.querySelectorAll('.toggle-header').forEach(function(header) {
    header.addEventListener('click', function(e) {
      if (e.target.closest('.topic-actions')) { return; }
      header.parentElement.classList.toggle('collapsed');
    });
  });

  // Hash copy button: copy full commit hash to clipboard inline
  document.querySelectorAll('.hash-copy').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const hash = btn.dataset.hash || '';
      navigator.clipboard.writeText(hash).then(function() {
        btn.classList.add('copied');
        const original = btn.textContent;
        btn.textContent = '\\u2713';
        setTimeout(function() {
          btn.textContent = original;
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  });

  // Copy Markdown button with brief visual feedback
  var copyBtn = document.getElementById('copyMdBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'copyMarkdown' });
      var original = copyBtn.textContent;
      copyBtn.textContent = 'Copied \\u2713';
      setTimeout(function() { copyBtn.textContent = original; }, 1500);
    });
  }

  // Split-button dropdown toggle (Copy Markdown dropdown menu)
  var dropdownToggle = document.getElementById('copyMdDropdown');
  var dropdownMenu = document.getElementById('copyMdMenu');
  if (dropdownToggle && dropdownMenu) {
    dropdownToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      dropdownMenu.classList.toggle('open');
    });
    // Close dropdown when clicking anywhere else
    document.addEventListener('click', function() {
      dropdownMenu.classList.remove('open');
    });
  }

  // Download .md button
  var downloadBtn = document.getElementById('downloadMdBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'downloadMarkdown' });
      if (dropdownMenu) { dropdownMenu.classList.remove('open'); }
    });
  }

  // Push button (Jolli only, or Jolli + Local depending on pushAction config)
  var pushBtn = document.getElementById('pushJolliBtn');
  var pushAction = pushBtn ? (pushBtn.dataset.pushAction || 'jolli') : 'jolli';
  if (pushBtn) {
    pushBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'push' });
    });
  }
${buildPrSectionScript()}

  // ── Combined push result tracking ──
  // When pushAction is "both", we wait for BOTH pushToJolliResult and
  // pushToLocalResult before re-enabling the button. When pushAction
  // is "jolli", only the Jolli result matters.
  // The button label is never changed during push — disabled/enabled state
  // is the only visual indicator. Success/failure feedback comes via
  // vscode notifications and the panel re-render on success.
  var pendingJolli = null;
  var pendingLocal = null;

  // Listen for messages from the extension (push + topic edit status updates)
  window.addEventListener('message', function(event) {
    var msg = event.data;

    // ── Push status ──
    if (pushBtn && msg.command === 'pushStarted') {
      pushBtn.disabled = true;
      pendingJolli = null;
      pendingLocal = null;
    }

    // Collect push results and re-enable button when all sides are done
    if (msg.command === 'pushToJolliResult') {
      pendingJolli = msg;
    } else if (msg.command === 'pushToLocalResult') {
      pendingLocal = msg;
    }
    if (pendingJolli) {
      var ready = pushAction === 'jolli' ? true : !!pendingLocal;
      if (ready) {
        if (pushBtn) pushBtn.disabled = false;
        pendingJolli = null;
        pendingLocal = null;
      }
    }
${buildPrMessageScript()}

    // ── Memory edit status ──
    if (msg.command === 'topicUpdated' && typeof msg.topicIndex === 'number' && msg.html) {
      var oldToggle = document.getElementById('topic-' + msg.topicIndex);
      if (oldToggle) {
        // Clean up ESC handler if still in edit mode
        if (oldToggle._escHandler) {
          document.removeEventListener('keydown', oldToggle._escHandler);
        }
        // Check if old toggle was expanded
        var wasOpen = oldToggle.classList.contains('open');
        // Replace with server-rendered HTML
        var wrapper = document.createElement('div');
        wrapper.innerHTML = msg.html;
        var newToggle = wrapper.firstElementChild;
        if (newToggle) {
          oldToggle.replaceWith(newToggle);
          // Preserve open/collapsed state
          if (wasOpen) { newToggle.classList.add('open'); }
          // Re-attach edit/delete button handlers on the new element
          attachTopicHandlers(newToggle);
        }
      }
    } else if (msg.command === 'topicUpdateError') {
      // Re-enable save/cancel buttons so the user can retry
      var editingToggle = document.querySelector('.toggle.editing');
      if (editingToggle) {
        var saveBtn = editingToggle.querySelector('.edit-save-btn');
        var cancelBtn = editingToggle.querySelector('.edit-cancel-btn');
        if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        if (cancelBtn) { cancelBtn.disabled = false; }
      }
    }

    // ── Recap edit status ──
    if (msg.command === 'recapUpdated' && msg.html) {
      // Server re-renders the whole recap section so we get the canonical HTML
      // (handles the empty-recap → section-removed case automatically too).
      var oldRecap = document.getElementById('recapSection');
      if (oldRecap) {
        var oldSep = oldRecap.nextElementSibling;
        if (msg.html.trim().length === 0) {
          // Empty recap after edit — remove section + trailing separator.
          if (oldSep && oldSep.tagName === 'HR') oldSep.remove();
          oldRecap.remove();
        } else {
          var recapWrap = document.createElement('div');
          recapWrap.innerHTML = msg.html;
          // The buildRecapSection result contains <div class="section">…</div><hr/>.
          // Replace the old section + its trailing <hr> with the new pair.
          var nodes = Array.prototype.slice.call(recapWrap.childNodes).filter(function(n) { return n.nodeType === 1; });
          if (oldSep && oldSep.tagName === 'HR') oldSep.remove();
          oldRecap.replaceWith.apply(oldRecap, nodes);
          attachEditRecapHandler();
        }
      }
    } else if (msg.command === 'recapUpdateError') {
      var editingRecap = document.querySelector('.recap-section.recap-editing');
      if (editingRecap) {
        var rSave = editingRecap.querySelector('.recap-edit-actions .primary');
        var rCancel = editingRecap.querySelector('.recap-edit-actions .action-btn');
        if (rSave) { rSave.textContent = 'Save'; rSave.disabled = false; }
        if (rCancel) { rCancel.disabled = false; }
      }
    }
  });

  // Toggle All: expand / collapse all topic toggles and timeline groups.
  // Scoped to topics — explicitly excludes .e2e-scenario so the E2E section
  // has its own independent #toggleAllE2eBtn.
  var allCollapsed = false;
  var toggleAllBtn = document.getElementById('toggleAllBtn');
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', function() {
      var items = document.querySelectorAll('.toggle:not(.e2e-scenario), .timeline-group');
      allCollapsed = !allCollapsed;
      items.forEach(function(t) {
        if (allCollapsed) {
          t.classList.add('collapsed');
        } else {
          t.classList.remove('collapsed');
        }
      });
      toggleAllBtn.textContent = allCollapsed ? 'Expand All' : 'Collapse All';
    });
  }

  // ── Attach collapsible callout toggle handlers inside a root element ──
  function attachCollapsibleHandlers(root) {
    root.querySelectorAll('.callout.collapsible .callout-label').forEach(function(label) {
      label.addEventListener('click', function() {
        label.closest('.callout').classList.toggle('callout-collapsed');
      });
    });
  }

  // ── Attach edit/delete handlers to buttons inside a root element ─────
  function attachTopicHandlers(root) {
    attachCollapsibleHandlers(root);
    root.querySelectorAll('.topic-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.dataset.topicIndex, 10);
        var toggle = document.getElementById('topic-' + idx);
        var titleEl = toggle ? toggle.querySelector('.toggle-title') : null;
        var title = titleEl ? titleEl.textContent : '';
        vscode.postMessage({ command: 'deleteTopic', topicIndex: idx, title: title });
      });
    });
    root.querySelectorAll('.topic-edit-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.dataset.topicIndex, 10);
        var toggle = document.getElementById('topic-' + idx);
        if (toggle && !toggle.classList.contains('editing')) {
          enterEditMode(toggle, idx);
        }
      });
    });
  }
  attachTopicHandlers(document);

  // ── Edit memory handler ────────────────────────────────────────────────
  var EDIT_FIELDS = [
    { key: 'trigger',       label: '\\u26A1 Why this change' },
    { key: 'decisions',     label: '\\uD83D\\uDCA1 Decisions behind the code' },
    { key: 'response',      label: '\\u2705 What was implemented' },
    { key: 'todo',          label: '\\uD83D\\uDCCB Future enhancements' },
    { key: 'filesAffected', label: '\\uD83D\\uDCC1 Files' }
  ];

  function autoResize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function enterEditMode(toggle, topicIndex) {
    var data = JSON.parse(toggle.dataset.topic || '{}');
    toggle.classList.add('editing');
    toggle.classList.remove('collapsed');

    // Replace title span with input in the header (in-place)
    var header = toggle.querySelector('.toggle-header');
    var titleSpan = header.querySelector('.toggle-title');
    toggle._originalTitleHtml = titleSpan.outerHTML;
    var titleInput = document.createElement('input');
    titleInput.className = 'edit-title-input';
    titleInput.dataset.editField = 'title';
    titleInput.value = data.title;
    titleInput.style.pointerEvents = 'auto';
    titleInput.addEventListener('click', function(e) { e.stopPropagation(); });
    titleSpan.replaceWith(titleInput);

    // Hide cat pill during edit
    var catPill = header.querySelector('.cat-pill');
    if (catPill) { catPill.style.display = 'none'; }

    var content = toggle.querySelector('.toggle-content');
    // Save original HTML for cancel
    toggle._originalHtml = content.innerHTML;

    // Build edit form (no title input here — it's in the header)
    var html = '';

    for (var i = 0; i < EDIT_FIELDS.length; i++) {
      var f = EDIT_FIELDS[i];
      var val = data[f.key] || '';
      var cls = f.key === 'filesAffected' ? 'files-affected-edit' : f.key;
      html += '<div class="callout ' + cls + '">' +
        '<div class="callout-body">' +
        '<div class="callout-label">' + f.label + '</div>' +
        '<textarea class="edit-textarea" data-edit-field="' + f.key + '"' +
        (f.key === 'filesAffected' ? ' placeholder="One file per line"' : '') +
        '>' +
        val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</textarea></div></div>';
    }

    html += '<div class="edit-actions">' +
      '<button class="edit-cancel-btn">Cancel</button>' +
      '<button class="edit-save-btn">Save</button></div>';

    content.innerHTML = html;

    // Auto-resize all textareas
    content.querySelectorAll('.edit-textarea').forEach(function(ta) {
      autoResize(ta);
      ta.addEventListener('input', function() { autoResize(ta); });
    });

    // Cancel button
    content.querySelector('.edit-cancel-btn').addEventListener('click', function() {
      exitEditMode(toggle);
    });

    // Save button — collect fields from both header (title) and content (other fields)
    var saveBtn = content.querySelector('.edit-save-btn');
    saveBtn.addEventListener('click', function() {
      var updates = {};
      toggle.querySelectorAll('[data-edit-field]').forEach(function(el) {
        var field = el.dataset.editField;
        var value = el.value;
        if (field === 'filesAffected') {
          // Split by newlines, filter empty
          var files = value.split('\\n').map(function(f) { return f.trim(); }).filter(function(f) { return f.length > 0; });
          updates[field] = files;
        } else {
          updates[field] = value;
        }
      });
      // Validate required fields
      if (!updates.title || !updates.title.trim()) {
        var titleInput = toggle.querySelector('[data-edit-field="title"]');
        if (titleInput) { titleInput.focus(); titleInput.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f44)'; }
        return;
      }
      // Disable buttons and show saving state
      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;
      content.querySelector('.edit-cancel-btn').disabled = true;
      vscode.postMessage({ command: 'editTopic', topicIndex: topicIndex, updates: updates });
    });

    // ESC key exits edit mode
    toggle._escHandler = function(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        exitEditMode(toggle);
      }
    };
    document.addEventListener('keydown', toggle._escHandler);
  }

  function exitEditMode(toggle) {
    // Remove ESC handler
    if (toggle._escHandler) {
      document.removeEventListener('keydown', toggle._escHandler);
      delete toggle._escHandler;
    }
    toggle.classList.remove('editing');
    // Restore title span in header
    var titleInput = toggle.querySelector('.edit-title-input');
    if (titleInput && toggle._originalTitleHtml) {
      var temp = document.createElement('div');
      temp.innerHTML = toggle._originalTitleHtml;
      titleInput.replaceWith(temp.firstChild);
      delete toggle._originalTitleHtml;
    }
    // Restore cat pill visibility
    var catPill = toggle.querySelector('.cat-pill');
    if (catPill) { catPill.style.display = ''; }
    // Restore content and reattach collapsible callout handlers
    var content = toggle.querySelector('.toggle-content');
    if (toggle._originalHtml) {
      content.innerHTML = toggle._originalHtml;
      delete toggle._originalHtml;
      attachCollapsibleHandlers(toggle);
    }
  }

  // ── E2E Test Guide ────────────────────────────────────────────────────
  // Mirrors the Topics pattern: each scenario is a .toggle.e2e-scenario
  // with its own edit/delete buttons; the section header has a Collapse-All
  // button. Inline edit replaces title (in header) and content fields with
  // textareas; Save posts editE2eScenario, Cancel restores cached HTML.
  // E2E scenario toggle is handled by the generic .toggle-header handler above.

  var E2E_EDIT_FIELDS = [
    { key: 'preconditions',   label: '📋 Preconditions', placeholder: '' },
    { key: 'steps',           label: '👣 Steps',          placeholder: 'One step per line' },
    { key: 'expectedResults', label: '✅ Expected Results',     placeholder: 'One result per line' }
  ];

  function attachE2eHandlers(root) {
    if (!root) return;

    // Generate / Regenerate (placeholder + section header buttons share command).
    var genBtn = root.querySelector('#generateE2eBtn');
    if (genBtn) genBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'generateE2eTest' });
    });
    var regenBtn = root.querySelector('#regenE2eBtn');
    if (regenBtn) regenBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'generateE2eTest' });
    });

    // Section-level Delete (deletes the whole guide).
    var sectionDelBtn = root.querySelector('#deleteE2eBtn');
    if (sectionDelBtn) sectionDelBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      vscode.postMessage({ command: 'deleteE2eTest' });
    });

    // Collapse-All for E2E (scoped to the e2e section only).
    var toggleAllBtn = root.querySelector('#toggleAllE2eBtn');
    if (toggleAllBtn) toggleAllBtn.addEventListener('click', function() {
      var section = document.getElementById('e2eTestSection');
      if (!section) return;
      var scenarios = section.querySelectorAll('.toggle.e2e-scenario');
      var allCollapsed = scenarios.length > 0 && Array.prototype.every.call(scenarios, function(s) {
        return s.classList.contains('collapsed');
      });
      var collapseNext = !allCollapsed;
      scenarios.forEach(function(s) {
        if (collapseNext) { s.classList.add('collapsed'); }
        else { s.classList.remove('collapsed'); }
      });
      toggleAllBtn.textContent = collapseNext ? 'Expand All' : 'Collapse All';
    });

    // Per-scenario Delete.
    root.querySelectorAll('.e2e-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.dataset.scenarioIndex, 10);
        var scenarioEl = document.getElementById('e2e-scenario-' + idx);
        var titleEl = scenarioEl ? scenarioEl.querySelector('.toggle-title') : null;
        var title = titleEl ? titleEl.textContent : '';
        vscode.postMessage({ command: 'deleteE2eScenario', index: idx, title: title });
      });
    });

    // Per-scenario Edit.
    root.querySelectorAll('.e2e-edit-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(btn.dataset.scenarioIndex, 10);
        var toggle = document.getElementById('e2e-scenario-' + idx);
        if (toggle && !toggle.classList.contains('editing')) {
          enterE2eEditMode(toggle, idx);
        }
      });
    });
  }

  // ── Recap edit handler ─────────────────────────────────────────────────
  function attachEditRecapHandler() {
    var btn = document.getElementById('editRecapBtn');
    if (!btn) return;
    btn.addEventListener('click', function() {
      var section = document.getElementById('recapSection');
      if (!section || section.classList.contains('recap-editing')) return;
      enterRecapEditMode(section);
    });
  }

  function enterRecapEditMode(section) {
    section.classList.add('recap-editing');
    var body = section.querySelector('.recap-body');
    var raw = section.dataset.raw || (body ? body.textContent : '') || '';

    // Stash original HTML so Cancel can restore it verbatim (cheap revert).
    section._originalRecapBody = body ? body.outerHTML : '';

    var ta = document.createElement('textarea');
    ta.className = 'recap-edit-area';
    ta.value = raw;
    if (body) { body.replaceWith(ta); } else { section.appendChild(ta); }

    var actions = document.createElement('div');
    actions.className = 'recap-edit-actions';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'action-btn';
    cancelBtn.textContent = 'Cancel';
    var saveBtn = document.createElement('button');
    saveBtn.className = 'action-btn primary';
    saveBtn.textContent = 'Save';
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    ta.insertAdjacentElement('afterend', actions);

    // Auto-resize and focus.
    ta.style.height = ta.scrollHeight + 'px';
    ta.addEventListener('input', function() {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    });
    ta.focus();

    function exitRecapEditMode() {
      if (section._recapEscHandler) {
        document.removeEventListener('keydown', section._recapEscHandler);
        delete section._recapEscHandler;
      }
      section.classList.remove('recap-editing');
      var ed = section.querySelector('.recap-edit-area');
      if (ed && section._originalRecapBody) {
        // Recreate the original .recap-body element from the stashed HTML.
        var temp = document.createElement('div');
        temp.innerHTML = section._originalRecapBody;
        ed.replaceWith(temp.firstChild);
      }
      var act = section.querySelector('.recap-edit-actions');
      if (act) act.remove();
      delete section._originalRecapBody;
    }

    cancelBtn.addEventListener('click', exitRecapEditMode);

    saveBtn.addEventListener('click', function() {
      var newRecap = ta.value.trim();
      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      vscode.postMessage({ command: 'editRecap', recap: newRecap });
    });

    // ESC cancels
    section._recapEscHandler = function(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelBtn.click();
      }
    };
    document.addEventListener('keydown', section._recapEscHandler);
  }
  attachEditRecapHandler();

  function enterE2eEditMode(toggle, scenarioIndex) {
    var data = JSON.parse(toggle.dataset.scenario || '{}');
    toggle.classList.add('editing');
    toggle.classList.remove('collapsed');

    // Replace title span with input in the header (mirrors topic pattern).
    var header = toggle.querySelector('.toggle-header');
    var titleSpan = header.querySelector('.toggle-title');
    toggle._originalTitleHtml = titleSpan.outerHTML;
    var titleInput = document.createElement('input');
    titleInput.className = 'edit-title-input';
    titleInput.dataset.editField = 'title';
    titleInput.value = data.title || '';
    titleInput.style.pointerEvents = 'auto';
    titleInput.addEventListener('click', function(e) { e.stopPropagation(); });
    titleSpan.replaceWith(titleInput);

    var content = toggle.querySelector('.toggle-content');
    toggle._originalHtml = content.innerHTML;

    var html = '';
    for (var i = 0; i < E2E_EDIT_FIELDS.length; i++) {
      var f = E2E_EDIT_FIELDS[i];
      var val = data[f.key] || '';
      html += '<div class="callout ' + f.key + '">' +
        '<div class="callout-body">' +
        '<div class="callout-label">' + f.label + '</div>' +
        '<textarea class="edit-textarea" data-edit-field="' + f.key + '"' +
        (f.placeholder ? ' placeholder="' + f.placeholder + '"' : '') +
        '>' +
        val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</textarea></div></div>';
    }

    html += '<div class="edit-actions">' +
      '<button class="edit-cancel-btn">Cancel</button>' +
      '<button class="edit-save-btn">Save</button></div>';

    content.innerHTML = html;

    content.querySelectorAll('.edit-textarea').forEach(function(ta) {
      autoResize(ta);
      ta.addEventListener('input', function() { autoResize(ta); });
    });

    content.querySelector('.edit-cancel-btn').addEventListener('click', function() {
      exitE2eEditMode(toggle);
    });

    var saveBtn = content.querySelector('.edit-save-btn');
    saveBtn.addEventListener('click', function() {
      var updates = {};
      var titleEl = toggle.querySelector('[data-edit-field="title"]');
      updates.title = titleEl ? titleEl.value : '';
      content.querySelectorAll('[data-edit-field]').forEach(function(el) {
        var field = el.dataset.editField;
        var value = el.value;
        if (field === 'steps' || field === 'expectedResults') {
          updates[field] = value.split('\\n').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
        } else if (field === 'preconditions') {
          updates[field] = value.trim(); // empty string signals clear to backend
        }
      });
      // Validation: title required.
      if (!updates.title || !updates.title.trim()) {
        var ti = toggle.querySelector('[data-edit-field="title"]');
        if (ti) {
          ti.focus();
          ti.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f44)';
        }
        return;
      }
      // Validation: at least one step required.
      if (!updates.steps || updates.steps.length === 0) {
        var stepsEl = content.querySelector('[data-edit-field="steps"]');
        if (stepsEl) {
          stepsEl.focus();
          stepsEl.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f44)';
        }
        return;
      }
      saveBtn.textContent = 'Saving...';
      saveBtn.disabled = true;
      content.querySelector('.edit-cancel-btn').disabled = true;
      vscode.postMessage({ command: 'editE2eScenario', index: scenarioIndex, updates: updates });
    });

    toggle._escHandler = function(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        exitE2eEditMode(toggle);
      }
    };
    document.addEventListener('keydown', toggle._escHandler);
  }

  function exitE2eEditMode(toggle) {
    if (toggle._escHandler) {
      document.removeEventListener('keydown', toggle._escHandler);
      delete toggle._escHandler;
    }
    toggle.classList.remove('editing');
    var titleInput = toggle.querySelector('.edit-title-input');
    if (titleInput && toggle._originalTitleHtml) {
      var temp = document.createElement('div');
      temp.innerHTML = toggle._originalTitleHtml;
      titleInput.replaceWith(temp.firstChild);
      delete toggle._originalTitleHtml;
    }
    var content = toggle.querySelector('.toggle-content');
    if (toggle._originalHtml) {
      content.innerHTML = toggle._originalHtml;
      delete toggle._originalHtml;
      attachCollapsibleHandlers(toggle);
    }
  }

  attachE2eHandlers(document);

  // Handle E2E status messages from the extension
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.command === 'e2eTestGenerating') {
      var btn = document.getElementById('generateE2eBtn') || document.getElementById('regenE2eBtn');
      if (btn) {
        if (btn.id === 'regenE2eBtn') {
          btn.classList.add('generating');
          btn.title = 'Generating...';
        } else {
          btn.textContent = 'Generating...';
        }
        btn.disabled = true;
      }
    } else if (msg.command === 'e2eTestUpdated' && msg.html) {
      // Whole-section replacement (used by Generate, section-level Delete,
      // and per-scenario Delete since indices shift after removal).
      var section = document.getElementById('e2eTestSection');
      if (section) {
        // Clean up any ESC handlers from scenarios currently in edit mode
        // before the DOM nodes are discarded.
        section.querySelectorAll('.e2e-scenario.editing').forEach(function(t) {
          if (t._escHandler) {
            document.removeEventListener('keydown', t._escHandler);
          }
        });
        var wrapper = document.createElement('div');
        wrapper.innerHTML = msg.html;
        var newSection = wrapper.querySelector('#e2eTestSection');
        if (newSection) {
          var hr = section.nextElementSibling;
          section.replaceWith(newSection);
          var newHr = wrapper.querySelector('hr.separator');
          if (newHr && hr && hr.tagName === 'HR') {
            hr.replaceWith(newHr);
          } else if (newHr && !hr) {
            newSection.insertAdjacentElement('afterend', newHr);
          }
          attachE2eHandlers(newSection);
        }
      }
    } else if (msg.command === 'e2eScenarioUpdated' && typeof msg.scenarioIndex === 'number' && msg.html) {
      // Surgical per-scenario replacement preserves collapsed state of other scenarios.
      var oldToggle = document.getElementById('e2e-scenario-' + msg.scenarioIndex);
      if (oldToggle) {
        if (oldToggle._escHandler) {
          document.removeEventListener('keydown', oldToggle._escHandler);
        }
        var wasCollapsed = oldToggle.classList.contains('collapsed');
        var wrapper = document.createElement('div');
        wrapper.innerHTML = msg.html;
        var newToggle = wrapper.firstElementChild;
        if (newToggle) {
          oldToggle.replaceWith(newToggle);
          if (wasCollapsed) { newToggle.classList.add('collapsed'); }
          attachE2eHandlers(newToggle);
        }
      }
    } else if (msg.command === 'e2eScenarioUpdateError') {
      // Re-enable save/cancel so the user can retry.
      var editing = document.querySelector('.e2e-scenario.editing');
      if (editing) {
        var saveBtn = editing.querySelector('.edit-save-btn');
        var cancelBtn = editing.querySelector('.edit-cancel-btn');
        if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        if (cancelBtn) { cancelBtn.disabled = false; }
      }
    } else if (msg.command === 'e2eTestError') {
      var btn = document.getElementById('generateE2eBtn') || document.getElementById('regenE2eBtn');
      if (btn) {
        if (btn.id === 'regenE2eBtn') {
          btn.classList.remove('generating');
          btn.title = 'Regenerate';
        } else {
          btn.textContent = 'Generate';
        }
        btn.disabled = false;
      }
    }

  // ── Plan inline edit messages ──
  if (msg.command === 'planContentLoaded' && msg.slug && msg.content !== undefined) {
    var planEl = document.getElementById('plan-' + msg.slug);
    if (planEl) {
      var editArea = planEl.querySelector('.plan-edit-area');
      var textarea = planEl.querySelector('.plan-edit-textarea');
      if (editArea && textarea) {
        textarea.value = msg.content;
        planEl.classList.add('editing');
        textarea.focus();
      }
    }
  }

  if (msg.command === 'planSaved' && msg.slug) {
    var planEl2 = document.getElementById('plan-' + msg.slug);
    if (planEl2) {
      planEl2.classList.remove('editing');
    }
  }

  // ── Note inline edit messages ──
  if (msg.command === 'noteContentLoaded' && msg.id && msg.content !== undefined) {
    var noteEl = document.getElementById('note-' + msg.id);
    if (noteEl) {
      var noteEditArea = noteEl.querySelector('.plan-edit-area');
      var noteTextarea = noteEl.querySelector('.plan-edit-textarea');
      if (noteEditArea && noteTextarea) {
        noteTextarea.value = msg.content;
        noteEl.classList.add('editing');
        noteTextarea.focus();
      }
    }
  }

  if (msg.command === 'noteSaved' && msg.id) {
    var noteEl2 = document.getElementById('note-' + msg.id);
    if (noteEl2) {
      noteEl2.classList.remove('editing');
    }
  }

  if (msg.command === 'snippetSaved') {
    hideSnippetForm();
  }

  // ── Plan translation status ──
  if (msg.command === 'planTranslating' && msg.slug) {
    var translateBtn = document.querySelector('.plan-translate-btn[data-plan-slug="' + msg.slug + '"]');
    if (translateBtn) {
      translateBtn.disabled = true;
      translateBtn.classList.add('translating');
      translateBtn.setAttribute('title', 'Translating...');
    }
  }
  if (msg.command === 'planTranslateError' && msg.slug) {
    var translateBtn2 = document.querySelector('.plan-translate-btn[data-plan-slug="' + msg.slug + '"]');
    if (translateBtn2) {
      translateBtn2.disabled = false;
      translateBtn2.classList.remove('translating');
      translateBtn2.setAttribute('title', 'Translate to English');
    }
  }

  // ── Note translation status ──
  if (msg.command === 'noteTranslating' && msg.id) {
    var noteTransBtn = document.querySelector('.note-translate-btn[data-note-id="' + msg.id + '"]');
    if (noteTransBtn) {
      noteTransBtn.disabled = true;
      noteTransBtn.classList.add('translating');
      noteTransBtn.setAttribute('title', 'Translating...');
    }
  }
  if (msg.command === 'noteTranslateError' && msg.id) {
    var noteTransBtn2 = document.querySelector('.note-translate-btn[data-note-id="' + msg.id + '"]');
    if (noteTransBtn2) {
      noteTransBtn2.disabled = false;
      noteTransBtn2.classList.remove('translating');
      noteTransBtn2.setAttribute('title', 'Translate to English');
    }
  }

  });

  // ── Plan & Note actions: event delegation for data-action attributes ──
  // Replaces inline onclick handlers for CSP compliance.
  document.addEventListener('click', function(e) {
    var target = e.target.closest('[data-action]');
    if (!target) return;
    var action = target.getAttribute('data-action');
    var slug = target.getAttribute('data-plan-slug');
    var title = target.getAttribute('data-plan-title') || '';

    switch (action) {
      case 'translatePlan':
        vscode.postMessage({ command: 'translatePlan', slug: slug });
        break;
      case 'previewPlan':
        e.preventDefault();
        vscode.postMessage({ command: 'previewPlan', slug: slug, title: title });
        break;
      case 'loadPlanContent':
        vscode.postMessage({ command: 'loadPlanContent', slug: slug });
        break;
      case 'removePlan':
        vscode.postMessage({ command: 'removePlan', slug: slug, title: title });
        break;
      case 'savePlanEdit': {
        var planItem = document.getElementById('plan-' + slug);
        if (!planItem) break;
        var textarea = planItem.querySelector('.plan-edit-textarea');
        if (!textarea) break;
        vscode.postMessage({ command: 'savePlan', slug: slug, content: textarea.value });
        break;
      }
      case 'cancelPlanEdit': {
        var planEl = document.getElementById('plan-' + slug);
        if (!planEl) break;
        planEl.classList.remove('editing');
        break;
      }
      case 'addPlan':
        closeAddMenu();
        vscode.postMessage({ command: 'addPlan' });
        break;
      case 'addMarkdownNote':
        closeAddMenu();
        vscode.postMessage({ command: 'addMarkdownNote' });
        break;
      case 'addTextSnippet':
        closeAddMenu();
        showSnippetForm();
        break;
      case 'saveSnippet': {
        var sTitle = document.getElementById('snippetTitle');
        var sContent = document.getElementById('snippetContent');
        if (!sContent || !sContent.value.trim()) break;
        vscode.postMessage({ command: 'saveSnippet', title: sTitle ? sTitle.value.trim() : '', content: sContent.value });
        break;
      }
      case 'cancelSnippet':
        hideSnippetForm();
        break;
      case 'toggleAddMenu':
        toggleAddMenu();
        break;
      case 'loadNoteContent': {
        var loadNoteId = target.getAttribute('data-note-id') || '';
        var loadNoteFormat = target.getAttribute('data-note-format') || 'markdown';
        vscode.postMessage({ command: 'loadNoteContent', id: loadNoteId, format: loadNoteFormat });
        break;
      }
      case 'saveNoteEdit': {
        var saveNoteId = target.getAttribute('data-note-id') || '';
        var saveNoteFormat = target.getAttribute('data-note-format') || 'markdown';
        var noteItem = document.getElementById('note-' + saveNoteId);
        if (!noteItem) break;
        var noteTextarea = noteItem.querySelector('.plan-edit-textarea');
        if (!noteTextarea) break;
        vscode.postMessage({ command: 'saveNote', id: saveNoteId, content: noteTextarea.value, format: saveNoteFormat });
        break;
      }
      case 'cancelNoteEdit': {
        var cancelNoteId = target.getAttribute('data-note-id') || '';
        var cancelNoteEl = document.getElementById('note-' + cancelNoteId);
        if (!cancelNoteEl) break;
        cancelNoteEl.classList.remove('editing');
        break;
      }
      case 'previewNote': {
        var previewNoteId = target.getAttribute('data-note-id') || '';
        var previewNoteTitle = target.getAttribute('data-note-title') || '';
        e.preventDefault();
        vscode.postMessage({ command: 'previewNote', id: previewNoteId, title: previewNoteTitle });
        break;
      }
      case 'translateNote': {
        var translateNoteId = target.getAttribute('data-note-id') || '';
        vscode.postMessage({ command: 'translateNote', id: translateNoteId });
        break;
      }
      case 'removeNote': {
        var noteId = target.getAttribute('data-note-id') || '';
        var noteTitle = target.getAttribute('data-note-title') || '';
        vscode.postMessage({ command: 'removeNote', id: noteId, title: noteTitle });
        break;
      }
    }
  });

  // ── Add dropdown helpers ──
  function toggleAddMenu() {
    var menu = document.getElementById('addDropdownMenu');
    if (menu) menu.classList.toggle('open');
  }
  function closeAddMenu() {
    var menu = document.getElementById('addDropdownMenu');
    if (menu) menu.classList.remove('open');
  }
  // Close dropdown when clicking outside
  document.addEventListener('click', function(e) {
    var dropdown = document.getElementById('addDropdown');
    if (dropdown && !dropdown.contains(e.target)) {
      closeAddMenu();
    }
  });

  // ── Inline snippet form helpers ──
  function showSnippetForm() {
    var form = document.getElementById('snippetForm');
    if (form) {
      form.removeAttribute('hidden');
      form.classList.add('open');
      var titleInput = document.getElementById('snippetTitle');
      if (titleInput) titleInput.focus();
    }
    var addBtn = document.getElementById('addDropdown');
    if (addBtn) addBtn.classList.add('hidden');
  }
  function hideSnippetForm() {
    var form = document.getElementById('snippetForm');
    if (form) {
      form.classList.remove('open');
      form.setAttribute('hidden', '');
    }
    var sTitle = document.getElementById('snippetTitle');
    var sContent = document.getElementById('snippetContent');
    if (sTitle) sTitle.value = '';
    if (sContent) sContent.value = '';
    updateSaveSnippetBtn();
    var addBtn = document.getElementById('addDropdown');
    if (addBtn) addBtn.classList.remove('hidden');
  }
  function updateSaveSnippetBtn() {
    var sTitle = document.getElementById('snippetTitle');
    var sContent = document.getElementById('snippetContent');
    var saveBtn = document.getElementById('saveSnippetBtn');
    var hasTitle = sTitle && sTitle.value.trim();
    var hasContent = sContent && sContent.value.trim();
    if (saveBtn) saveBtn.disabled = !(hasTitle && hasContent);
  }
  // Enable/disable Save button based on title and content
  var snippetTitleEl = document.getElementById('snippetTitle');
  var snippetContentEl = document.getElementById('snippetContent');
  if (snippetTitleEl) {
    snippetTitleEl.addEventListener('input', updateSaveSnippetBtn);
  }
  if (snippetContentEl) {
    snippetContentEl.addEventListener('input', updateSaveSnippetBtn);
  }

  // ── Transcript Stats (async load for section description) ───────────────

  var conversationsStats = document.getElementById('conversationsStats');
  if (conversationsStats) {
    vscode.postMessage({ command: 'loadTranscriptStats' });
  }

  // ── Transcript Modal ──────────────────────────────────────────────────────

  var transcriptModal = document.getElementById('transcriptModal');
  var modalTabs = document.getElementById('modalTabs');
  var modalBody = document.getElementById('modalBody');
  var modalLoading = document.getElementById('modalLoading');
  var modalSubtitle = document.getElementById('modalSubtitle');
  var modalSaveBtn = document.getElementById('modalSaveBtn');
  var modalCancelBtn = document.getElementById('modalCancelBtn');
  var modalCloseBtn = document.getElementById('modalCloseBtn');
  var deleteTranscriptsBtn = document.getElementById('deleteTranscriptsBtn');
  var openTranscriptsBtn = document.getElementById('openTranscriptsBtn');

  // State
  var originalTranscripts = []; // full data from extension, preserved for metadata
  var rawContentMap = {}; // entryKey → raw text (avoids data-attribute escaping issues)
  var baseSubtitle = ''; // "147 entries, 4 sessions" — always visible
  var modifiedCount = 0;
  var deletedCount = 0;
  var activeTextarea = null; // only one entry editable at a time

  function openModal() {
    if (!transcriptModal) return;
    transcriptModal.classList.add('visible');
    if (modalLoading) modalLoading.style.display = 'block';
    modifiedCount = 0;
    deletedCount = 0;
    updateChangeCounter();
    vscode.postMessage({ command: 'loadAllTranscripts' });
  }

  function closeModal() {
    if (!transcriptModal) return;
    transcriptModal.classList.remove('visible');
    if (modalBody) modalBody.innerHTML = '<div class="modal-loading" id="modalLoading">Loading transcripts...</div>';
    if (modalTabs) modalTabs.innerHTML = '';
    activeTextarea = null;
    modifiedCount = 0;
    deletedCount = 0;
  }

  function updateChangeCounter() {
    if (modalSubtitle) {
      var parts = [];
      if (modifiedCount > 0) parts.push(modifiedCount + ' modified');
      if (deletedCount > 0) parts.push(deletedCount + ' deleted');
      var changeText = parts.length > 0 ? ' · ' + parts.join(', ') : '';
      modalSubtitle.textContent = baseSubtitle + changeText;
    }
    if (modalSaveBtn) {
      var total = modifiedCount + deletedCount;
      modalSaveBtn.disabled = total === 0;
      modalSaveBtn.textContent = total > 0 ? 'Save All (' + total + ')' : 'Save All';
    }
  }

  function getSourceLabel(source) {
    if (source === 'codex') return 'Codex';
    if (source === 'gemini') return 'Gemini';
    if (source === 'opencode') return 'OpenCode';
    return 'Claude';
  }

  function renderTranscriptEntries(entries) {
    if (!modalBody) return;
    originalTranscripts = entries;

    // Group by source:sessionId
    var groups = {};
    var groupOrder = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var key = (e.source || 'claude') + ':' + e.sessionId;
      if (!groups[key]) {
        groups[key] = { source: e.source || 'claude', sessionId: e.sessionId, entries: [] };
        groupOrder.push(key);
      }
      groups[key].entries.push(e);
    }

    // Sort entries within each group by timestamp
    for (var k = 0; k < groupOrder.length; k++) {
      groups[groupOrder[k]].entries.sort(function(a, b) {
        return (a.timestamp || '').localeCompare(b.timestamp || '');
      });
    }

    // Sort session groups by each group's earliest entry timestamp
    groupOrder.sort(function(a, b) {
      var aFirst = groups[a].entries[0] ? (groups[a].entries[0].timestamp || '') : '';
      var bFirst = groups[b].entries[0] ? (groups[b].entries[0].timestamp || '') : '';
      return aFirst.localeCompare(bFirst);
    });

    // Build tab bar (with delete button on each tab)
    var tabsHtml = '';
    for (var t = 0; t < groupOrder.length; t++) {
      var tabGroup = groups[groupOrder[t]];
      var tabSourceLabel = getSourceLabel(tabGroup.source);
      var tabEntryCount = tabGroup.entries.length;
      var activeClass = t === 0 ? ' active' : '';
      tabsHtml += '<button class="modal-tab' + activeClass + '" data-tab-key="' + groupOrder[t] + '">';
      tabsHtml += tabSourceLabel + ' (' + tabEntryCount + ')';
      tabsHtml += '<span class="session-delete-btn" data-group-key="' + groupOrder[t] + '" title="Delete entire session">&#x1F5D1;</span>';
      tabsHtml += '</button>';
    }
    if (modalTabs) {
      modalTabs.innerHTML = tabsHtml;
      // Hide tab bar if only one session
      modalTabs.style.display = groupOrder.length > 1 ? 'flex' : 'none';
    }

    // Build tab panels and populate rawContentMap
    rawContentMap = {};
    var html = '';
    for (var g = 0; g < groupOrder.length; g++) {
      var group = groups[groupOrder[g]];
      var panelActiveClass = g === 0 ? ' active' : '';
      html += '<div class="tab-panel' + panelActiveClass + '" data-panel-key="' + groupOrder[g] + '">';
      html += '<div class="transcript-session" data-group-key="' + groupOrder[g] + '">';

      for (var j = 0; j < group.entries.length; j++) {
        var entry = group.entries[j];
        var entryKey = esc(entry.commitHash) + ':' + esc(entry.sessionId) + ':' + entry.originalIndex;
        rawContentMap[entryKey] = entry.content;
        var roleIcon = entry.role === 'human' ? '&#x1F464;' : '&#x1F916;';
        var roleLabel = entry.role === 'human' ? 'user' : 'bot';
        var timeStr = entry.timestamp ? formatTime(entry.timestamp) : '';
        html += '<div class="transcript-entry" data-commit="' + esc(entry.commitHash) + '" data-session="' + esc(entry.sessionId) + '" data-source="' + esc(entry.source || 'claude') + '" data-index="' + entry.originalIndex + '" data-timestamp="' + esc(entry.timestamp || '') + '" data-role="' + esc(entry.role) + '">';
        html += '<div class="entry-header">';
        html += '<span class="entry-role">' + roleIcon + ' ' + roleLabel + '</span>';
        html += '<span class="entry-time">' + esc(timeStr) + '</span>';
        html += '<button class="entry-delete-btn" title="Delete entry">&#x1F5D1;</button>';
        html += '</div>';
        html += '<div class="entry-content">' + renderMarkdown(entry.content) + '</div>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    modalBody.innerHTML = html;

    // Attach tab switching
    if (modalTabs) {
      var tabs = modalTabs.querySelectorAll('.modal-tab');
      for (var ti = 0; ti < tabs.length; ti++) {
        tabs[ti].addEventListener('click', function() {
          var key = this.getAttribute('data-tab-key');
          // Deactivate all tabs and panels
          var allTabs = modalTabs.querySelectorAll('.modal-tab');
          for (var a = 0; a < allTabs.length; a++) allTabs[a].classList.remove('active');
          var allPanels = modalBody.querySelectorAll('.tab-panel');
          for (var p = 0; p < allPanels.length; p++) allPanels[p].classList.remove('active');
          // Activate clicked tab and matching panel
          this.classList.add('active');
          var panel = modalBody.querySelector('.tab-panel[data-panel-key="' + key + '"]');
          if (panel) panel.classList.add('active');
        });
      }
    }

    // Attach click-to-edit on entries (across ALL panels so state is preserved)
    var allEntries = modalBody.querySelectorAll('.transcript-entry:not(.deleted)');
    for (var idx = 0; idx < allEntries.length; idx++) {
      attachEntryClickHandler(allEntries[idx]);
    }

    // Attach delete handlers
    var entryDelBtns = modalBody.querySelectorAll('.entry-delete-btn');
    for (var d = 0; d < entryDelBtns.length; d++) {
      attachEntryDeleteHandler(entryDelBtns[d]);
    }

    // Session delete buttons are in the tab bar, not in the body
    var sessionDelBtns = modalTabs ? modalTabs.querySelectorAll('.session-delete-btn') : [];
    for (var s = 0; s < sessionDelBtns.length; s++) {
      attachSessionDeleteHandler(sessionDelBtns[s]);
    }
  }

  function attachEntryClickHandler(entryEl) {
    var contentEl = entryEl.querySelector('.entry-content');
    if (!contentEl) return;
    contentEl.addEventListener('click', function() {
      if (entryEl.classList.contains('deleted')) return;
      if (entryEl.classList.contains('editing')) return;

      // Blur any active textarea first
      if (activeTextarea) activeTextarea.blur();

      var entryKey = entryEl.getAttribute('data-commit') + ':' + entryEl.getAttribute('data-session') + ':' + entryEl.getAttribute('data-index');
      var originalText = rawContentMap[entryKey] || contentEl.textContent;
      var textarea = document.createElement('textarea');
      textarea.className = 'entry-edit-textarea';
      textarea.value = originalText;
      textarea.rows = Math.max(3, originalText.split('\\n').length + 1);

      contentEl.style.display = 'none';
      entryEl.insertBefore(textarea, contentEl.nextSibling);
      entryEl.classList.add('editing');
      textarea.focus();
      activeTextarea = textarea;

      // Auto-resize
      textarea.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = this.scrollHeight + 'px';
      });
      textarea.style.height = textarea.scrollHeight + 'px';

      textarea.addEventListener('blur', function() {
        var newText = textarea.value;
        rawContentMap[entryKey] = newText;
        contentEl.innerHTML = renderMarkdown(newText);
        contentEl.style.display = '';
        textarea.remove();
        entryEl.classList.remove('editing');
        activeTextarea = null;

        if (newText !== originalText) {
          if (!entryEl.classList.contains('modified')) {
            entryEl.classList.add('modified');
            modifiedCount++;
            updateChangeCounter();
          }
        }
      });
    });
  }

  /** Sync tab strikethrough state based on whether all entries in the session are deleted. */
  function syncTabState(sessionEl) {
    if (!sessionEl || !modalTabs) return;
    var groupKey = sessionEl.getAttribute('data-group-key');
    var tabEl = modalTabs.querySelector('.modal-tab[data-tab-key="' + groupKey + '"]');
    if (!tabEl) return;
    var total = sessionEl.querySelectorAll('.transcript-entry').length;
    var deletedInSession = sessionEl.querySelectorAll('.transcript-entry.deleted').length;
    var allDeleted = total > 0 && deletedInSession === total;
    var deleteBtn = tabEl.querySelector('.session-delete-btn');
    if (allDeleted) {
      tabEl.classList.add('session-deleted');
      if (deleteBtn) { deleteBtn.innerHTML = '&#x21A9;'; deleteBtn.title = 'Restore entire session'; }
    } else {
      tabEl.classList.remove('session-deleted');
      if (deleteBtn) { deleteBtn.innerHTML = '&#x1F5D1;'; deleteBtn.title = 'Delete entire session'; }
    }
  }

  function attachEntryDeleteHandler(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var entryEl = btn.closest('.transcript-entry');
      if (!entryEl) return;
      if (entryEl.classList.contains('deleted')) {
        entryEl.classList.remove('deleted');
        btn.innerHTML = '&#x1F5D1;';
        btn.title = 'Delete entry';
        deletedCount--;
      } else {
        entryEl.classList.add('deleted');
        btn.innerHTML = '&#x21A9;';
        btn.title = 'Restore entry';
        deletedCount++;
      }
      // Sync tab state based on session entries
      var sessionEl = entryEl.closest('.transcript-session');
      syncTabState(sessionEl);
      updateChangeCounter();
    });
  }

  function attachSessionDeleteHandler(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var groupKey = btn.getAttribute('data-group-key');
      var tabEl = btn.closest('.modal-tab');
      var sessionEl = modalBody ? modalBody.querySelector('.transcript-session[data-group-key="' + groupKey + '"]') : null;
      if (!sessionEl) return;

      var isDeleted = tabEl && tabEl.classList.contains('session-deleted');
      if (isDeleted) {
        // Restore all entries in session
        if (tabEl) tabEl.classList.remove('session-deleted');
        btn.innerHTML = '&#x1F5D1;';
        btn.title = 'Delete entire session';
        var deletedEntries = sessionEl.querySelectorAll('.transcript-entry.deleted');
        for (var i = 0; i < deletedEntries.length; i++) {
          deletedEntries[i].classList.remove('deleted');
          var entryBtn = deletedEntries[i].querySelector('.entry-delete-btn');
          if (entryBtn) { entryBtn.innerHTML = '&#x1F5D1;'; entryBtn.title = 'Delete entry'; }
          deletedCount--;
        }
      } else {
        // Delete all entries in session
        if (tabEl) tabEl.classList.add('session-deleted');
        btn.innerHTML = '&#x21A9;';
        btn.title = 'Restore entire session';
        var activeEntries = sessionEl.querySelectorAll('.transcript-entry:not(.deleted)');
        for (var j = 0; j < activeEntries.length; j++) {
          activeEntries[j].classList.add('deleted');
          var entryBtn2 = activeEntries[j].querySelector('.entry-delete-btn');
          if (entryBtn2) { entryBtn2.innerHTML = '&#x21A9;'; entryBtn2.title = 'Restore entry'; }
          deletedCount++;
        }
      }
      updateChangeCounter();
    });
  }

  function collectSaveData() {
    if (!modalBody) return [];
    var entries = modalBody.querySelectorAll('.transcript-entry:not(.deleted)');
    var result = [];
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i];
      var contentEl = el.querySelector('.entry-content');
      result.push({
        commitHash: el.getAttribute('data-commit'),
        sessionId: el.getAttribute('data-session'),
        source: el.getAttribute('data-source'),
        originalIndex: parseInt(el.getAttribute('data-index'), 10),
        role: el.getAttribute('data-role') === 'human' ? 'human' : 'assistant',
        content: rawContentMap[el.getAttribute('data-commit') + ':' + el.getAttribute('data-session') + ':' + el.getAttribute('data-index')] || (contentEl ? contentEl.textContent : ''),
        timestamp: el.getAttribute('data-timestamp') || ''
      });
    }
    return result;
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch(e) { return ''; }
  }

  function esc(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /** Lightweight markdown renderer: code blocks, inline code, bold, italic, links, lists, headers. */
  function renderMarkdown(raw) {
    if (!raw) return '';
    var text = esc(raw);

    // Fenced code blocks
    text = text.replace(/\`\`\`[a-zA-Z]*\\n([\\s\\S]*?)\`\`\`/g, function(_, code) {
      return '<pre class="md-code-block"><code>' + code.replace(/\\n$/, '') + '</code></pre>';
    });

    // Split into lines for block-level processing
    var lines = text.split('\\n');
    var out = [];
    var inList = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Skip lines inside code blocks (already handled)
      if (line.indexOf('<pre class="md-code-block">') !== -1) {
        if (inList) { out.push('</ul>'); inList = false; }
        // Collect until </pre>
        var block = line;
        while (block.indexOf('</pre>') === -1 && i + 1 < lines.length) {
          i++;
          block += '\\n' + lines[i];
        }
        out.push(block);
        continue;
      }

      // Headers: # to ####
      var headerMatch = line.match(/^(#{1,4})\\s+(.+)$/);
      if (headerMatch) {
        if (inList) { out.push('</ul>'); inList = false; }
        var level = headerMatch[1].length + 1; // Offset +1 to avoid overly large headers in modal
        out.push('<h' + level + ' class="md-heading">' + applyInline(headerMatch[2]) + '</h' + level + '>');
        continue;
      }

      // Unordered list items: - item or * item
      var listMatch = line.match(/^[\\-\\*]\\s+(.+)$/);
      if (listMatch) {
        if (!inList) { out.push('<ul class="md-list">'); inList = true; }
        out.push('<li>' + applyInline(listMatch[1]) + '</li>');
        continue;
      }

      // Non-list line closes open list
      if (inList) { out.push('</ul>'); inList = false; }

      // Empty line — small vertical gap
      if (line.trim() === '') {
        out.push('<div class="md-blank"></div>');
        continue;
      }

      // Regular paragraph line
      out.push('<div>' + applyInline(line) + '</div>');
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }

  /** Apply inline markdown: bold, italic, inline code, links. */
  function applyInline(text) {
    // Inline code
    text = text.replace(/\`([^\`]+)\`/g, '<code class="md-inline-code">$1</code>');
    // Bold: **text** or __text__
    text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
    // Italic: *text* or _text_ (not inside bold)
    text = text.replace(/(?<!\\*)\\*([^*]+)\\*(?!\\*)/g, '<em>$1</em>');
    text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');
    // Links: [text](url) — only allow http/https URLs
    text = text.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g, '<a href="$2" class="md-link">$1</a>');
    return text;
  }

  // Wire up buttons
  if (openTranscriptsBtn) openTranscriptsBtn.addEventListener('click', openModal);
  if (modalCloseBtn) modalCloseBtn.addEventListener('click', function() { closeModal(); });
  if (modalCancelBtn) modalCancelBtn.addEventListener('click', function() { closeModal(); });
  if (transcriptModal) {
    transcriptModal.addEventListener('click', function(e) {
      if (e.target === transcriptModal) closeModal();
    });
  }
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && transcriptModal && transcriptModal.classList.contains('visible')) {
      closeModal();
    }
  });
  if (modalSaveBtn) {
    modalSaveBtn.addEventListener('click', function() {
      var data = collectSaveData();
      vscode.postMessage({ command: 'saveAllTranscripts', entries: data });
      modalSaveBtn.disabled = true;
      modalSaveBtn.textContent = 'Saving...';
    });
  }
  if (deleteTranscriptsBtn) {
    deleteTranscriptsBtn.addEventListener('click', function() {
      // Mark all entries as deleted across all sessions (same as clicking each tab's delete)
      if (!modalTabs || !modalBody) return;
      var allTabs = modalTabs.querySelectorAll('.modal-tab:not(.session-deleted)');
      for (var t = 0; t < allTabs.length; t++) {
        var tabDeleteBtn = allTabs[t].querySelector('.session-delete-btn');
        if (tabDeleteBtn) tabDeleteBtn.click();
      }
    });
  }

  // Handle transcript messages from extension
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.command === 'allTranscriptsLoaded') {
      if (modalLoading) modalLoading.style.display = 'none';
      renderTranscriptEntries(msg.entries || []);
      var totalEntries = (msg.entries || []).length;
      var sessions = {};
      for (var i = 0; i < (msg.entries || []).length; i++) {
        sessions[(msg.entries[i].source || 'claude') + ':' + msg.entries[i].sessionId] = true;
      }
      var sessionCount = Object.keys(sessions).length;
      baseSubtitle = totalEntries + ' entries, ' + sessionCount + ' session' + (sessionCount !== 1 ? 's' : '');
      if (modalSubtitle) modalSubtitle.textContent = baseSubtitle;
    }
    if (msg.command === 'transcriptsSaved') {
      closeModal();
    }
    if (msg.command === 'transcriptsDeleted') {
      // Modal already closed by deleteTranscriptsBtn handler
    }
    if (msg.command === 'transcriptsLoading') {
      if (modalLoading) modalLoading.style.display = 'block';
    }
    if (msg.command === 'transcriptStatsLoaded') {
      if (conversationsStats) {
        var sessionCounts = msg.sessionCounts || {};
        var parts = [];
        var sourceOrder = ['claude', 'codex', 'gemini', 'opencode'];
        for (var i = 0; i < sourceOrder.length; i++) {
          var source = sourceOrder[i];
          var count = sessionCounts[source] || 0;
          if (count > 0) parts.push('<strong>' + count + '</strong> ' + getSourceLabel(source));
        }
        var totalSessions = 0;
        for (var key in sessionCounts) {
          if (Object.prototype.hasOwnProperty.call(sessionCounts, key)) {
            totalSessions += sessionCounts[key] || 0;
          }
        }
        conversationsStats.innerHTML = '<strong>' + msg.totalEntries + '</strong> entries across <strong>' + totalSessions + '</strong> session' + (totalSessions !== 1 ? 's' : '') + ' (' + parts.join(', ') + ')';
      }
    }
  });

`;
}
