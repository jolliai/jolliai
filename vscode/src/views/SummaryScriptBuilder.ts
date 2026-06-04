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
import { buildContextMenuGuardScript } from "./ContextMenuGuard.js";
import { buildTranscriptEntriesScript } from "./TranscriptEntryRenderer.js";

/** Returns the JavaScript for toggle interactions and the Copy Markdown button. */
export function buildScript(): string {
	return `
  ${buildContextMenuGuardScript()}

  const vscode = acquireVsCodeApi();

  // Toggle expand/collapse for individual memory sections (skip clicks on action buttons).
  // Idempotent so attachE2eHandlers can safely revisit headers after section replacement.
  function attachToggleHeader(header) {
    if (header._toggleAttached) { return; }
    header._toggleAttached = true;
    header.addEventListener('click', function(e) {
      if (e.target.closest('.topic-actions')) { return; }
      header.parentElement.classList.toggle('collapsed');
    });
  }
  document.querySelectorAll('.toggle-header').forEach(attachToggleHeader);

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

  // Push button (Jolli only — local push pathway was removed in 2026-05).
  var pushBtn = document.getElementById('pushJolliBtn');
  if (pushBtn) {
    pushBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'push' });
    });
  }

  // Stale-readonly banner: "Open new commit's summary" button. The live
  // root hash is rendered into data-target-hash by buildHtml; the
  // extension routes the message to jollimemory.viewSummary.
  var staleOpenBtn = document.getElementById('staleOpenNewBtn');
  if (staleOpenBtn) {
    staleOpenBtn.addEventListener('click', function() {
      var hash = staleOpenBtn.getAttribute('data-target-hash');
      if (hash) {
        vscode.postMessage({ command: 'openRewrittenCommit', hash: hash });
      }
    });
  }
${buildPrSectionScript()}

  // Listen for messages from the extension (push + topic edit status updates).
  // The push button is disabled on 'pushStarted' and re-enabled on
  // 'pushToJolliResult'. Success/failure feedback comes via vscode
  // notifications and the panel re-render on success — the button label
  // itself is never changed mid-push.
  window.addEventListener('message', function(event) {
    var msg = event.data;

    // ── Push status ──
    if (pushBtn && msg.command === 'pushStarted') {
      pushBtn.disabled = true;
    }
    if (pushBtn && msg.command === 'pushToJolliResult') {
      pushBtn.disabled = false;
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
        // Preserve the collapsed state across the re-render. Topics collapse via
        // the "collapsed" class ("open" is for dropdown menus / the snippet form),
        // so the prior "open" snapshot here was a no-op that silently dropped the
        // collapse state on every single-topic edit.
        var wasCollapsed = oldToggle.classList.contains('collapsed');
        // Replace with server-rendered HTML
        var wrapper = document.createElement('div');
        wrapper.innerHTML = msg.html;
        var newToggle = wrapper.firstElementChild;
        if (newToggle) {
          oldToggle.replaceWith(newToggle);
          if (wasCollapsed) { newToggle.classList.add('collapsed'); }
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

    // ── Topics whole-section replace (after a topic delete) ──
    // Topic edit/delete buttons carry positional treeIndex values; deleting one
    // shifts every later index, so we rebuild the whole #topicsSection rather
    // than removing a single node. But a blind rebuild would re-expand the
    // topics the user had collapsed, so we snapshot each surviving topic's
    // collapsed state — keyed by its data-topic payload, which is stable across
    // the treeIndex renumbering (the topic-<index> id is NOT) — and restore it
    // after the replace, then recompute allCollapsed so the #toggleAllBtn label
    // stays accurate. Editing ESC handlers are also cleaned up before the nodes
    // are discarded (partial replace keeps the JS context, so a leaked global
    // keydown would accumulate).
    if (msg.command === 'topicsUpdated' && typeof msg.html === 'string') {
      var oldTopicsSec = document.getElementById('topicsSection');
      var collapseByTopic = {};
      if (oldTopicsSec) {
        oldTopicsSec.querySelectorAll('.toggle').forEach(function(t) {
          var key = t.getAttribute('data-topic');
          if (key) collapseByTopic[key] = t.classList.contains('collapsed');
          if (t.classList.contains('editing') && t._escHandler) {
            document.removeEventListener('keydown', t._escHandler);
          }
        });
      }
      replaceSection('topicsSection', msg.html);
      var newTopicsSec = document.getElementById('topicsSection');
      var topicCount = 0;
      var everyCollapsed = true;
      if (newTopicsSec) {
        attachTopicHandlers(newTopicsSec);
        newTopicsSec.querySelectorAll('.toggle-header').forEach(attachToggleHeader);
        newTopicsSec.querySelectorAll('.toggle').forEach(function(t) {
          topicCount++;
          var key = t.getAttribute('data-topic');
          if (key && collapseByTopic[key]) t.classList.add('collapsed');
          if (!t.classList.contains('collapsed')) everyCollapsed = false;
        });
      }
      allCollapsed = topicCount > 0 && everyCollapsed;
      attachToggleAllBtnHandler();
    }

    // ── Recap edit / generate status ──
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
          // Reattach BOTH handlers: edit (state-2 only) and generate/regen
          // (state-1 has only Generate button, state-2 has only Regenerate).
          // Both attach functions internally null-check the buttons so calling
          // them in either state is safe.
          attachEditRecapHandler();
          attachGenerateRecapHandler();
        }
      }
    } else if (msg.command === 'recapUpdateError') {
      // Edit-mode failure — restore Save/Cancel button state.
      var editingRecap = document.querySelector('.recap-section.recap-editing');
      if (editingRecap) {
        var rSave = editingRecap.querySelector('.recap-edit-actions .primary');
        var rCancel = editingRecap.querySelector('.recap-edit-actions .action-btn');
        if (rSave) { rSave.textContent = 'Save'; rSave.disabled = false; }
        if (rCancel) { rCancel.disabled = false; }
      }
      // Generate-mode failure — restore button labels and clear the
      // .generating spinning state on the regen icon. The section is
      // never simultaneously editing and generating, so this is independent.
      var genBtn2 = document.getElementById('generateRecapBtn');
      var regenBtn2 = document.getElementById('regenerateRecapBtn');
      if (genBtn2) {
        genBtn2.textContent = '\\u2728 Generate';
        genBtn2.disabled = false;
      }
      if (regenBtn2) {
        regenBtn2.classList.remove('generating');
        regenBtn2.title = 'Regenerate';
        regenBtn2.disabled = false;
      }
    }

    // ── Regenerate summary status ──
    // Lifecycle:
    //   summaryRegenerating  → enter regenerating-readonly mode (CSS hides
    //                          every action button via the foreign-safe
    //                          allow-list), insert the top-of-page banner
    //   summaryRegenerated   → swap in new topics/recap HTML, leave
    //                          regenerating-readonly mode, remove banner
    //   summaryRegenerateError → leave regenerating-readonly mode, remove
    //                          banner; topics/recap DOM untouched
    if (msg.command === 'summaryRegenerating') {
      enterRegeneratingReadonly();
      return;
    }
    if (msg.command === 'summaryRegenerated') {
      if (msg.topicsHtml) replaceSection('topicsSection', msg.topicsHtml);
      if (msg.recapHtml) replaceSection('recapSection', msg.recapHtml);
      // Banner replace/remove: empty string → remove existing banner;
      // non-empty → replace existing (outerHTML) or insert at top of .page.
      // The click delegate (attachRegenerateSummaryDelegate) is bound on
      // .page so any newly-inserted #summaryErrorRegenerateBtn is picked
      // up without re-binding.
      if (typeof msg.summaryErrorBannerHtml === 'string') {
        var existingBanner = document.querySelector('.summary-error-banner');
        if (msg.summaryErrorBannerHtml === '') {
          if (existingBanner) existingBanner.remove();
        } else if (existingBanner) {
          existingBanner.outerHTML = msg.summaryErrorBannerHtml;
        } else {
          var pageRoot = document.querySelector('.page');
          if (pageRoot) pageRoot.insertAdjacentHTML('afterbegin', msg.summaryErrorBannerHtml);
        }
      }
      leaveRegeneratingReadonly();
      // Re-attach handlers on the NEW DOM nodes inside topics + recap.
      // NOTE: the Regenerate buttons (#regenerateSummaryBtn in the
      // Conversations card AND #summaryErrorRegenerateBtn in the banner)
      // are reached via an event delegate on .page (see
      // attachRegenerateSummaryDelegate), so they keep working through
      // DOM replacement without any re-binding.
      attachEditRecapHandler();
      attachGenerateRecapHandler();
      var newTopicsRoot = document.getElementById('topicsSection');
      if (newTopicsRoot) {
        attachTopicHandlers(newTopicsRoot);
        // attachTopicHandlers wires edit/delete inside .toggle but NOT the
        // toggle-header expand/collapse click — re-attach explicitly on
        // the new headers. The function is idempotent (_toggleAttached).
        newTopicsRoot.querySelectorAll('.toggle-header').forEach(attachToggleHeader);
      }
      // Fresh topicsSection brings a NEW #toggleAllBtn whose click listener
      // doesn't carry over from the old DOM. Reset allCollapsed because the
      // new topics are always rendered uncollapsed, then re-bind.
      allCollapsed = false;
      attachToggleAllBtnHandler();
      return;
    }
    if (msg.command === 'summaryRegenerateError') {
      leaveRegeneratingReadonly();
      return;
    }
  });

  // Toggle All: expand / collapse all topic toggles and timeline groups.
  // Scoped to topics — explicitly excludes .e2e-scenario so the E2E section
  // has its own independent #toggleAllE2eBtn.
  //
  // allCollapsed lives in the buildScript closure so the state survives a
  // regenerate re-render. The handler is only called twice in the lifecycle:
  // once at page load, and once after summaryRegenerated swaps in a brand-new
  // #toggleAllBtn element (the old element is gone, so the new one needs its
  // own listener — not a re-bind on the same node).
  var allCollapsed = false;
  function attachToggleAllBtnHandler() {
    var toggleAllBtn = document.getElementById('toggleAllBtn');
    if (!toggleAllBtn) return;
    // Sync the button label with allCollapsed so a regenerate's freshly-
    // rendered topics (always uncollapsed) and the button text agree.
    toggleAllBtn.textContent = allCollapsed ? 'Expand All' : 'Collapse All';
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
  attachToggleAllBtnHandler();

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

    // Re-bind toggle-header click on freshly-rendered scenarios — the page-level
    // attach pass runs once on script load and misses elements inserted later.
    root.querySelectorAll('.toggle-header').forEach(attachToggleHeader);

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

  // ── Recap generate / regenerate handler ────────────────────────────────
  // Both buttons post the same 'generateRecap' command; the extension
  // decides whether this is a first-time generate or a regenerate based on
  // whether summary.recap is already set. Loading state is reflected on
  // whichever button is in the DOM.
  function attachGenerateRecapHandler() {
    var ids = ['generateRecapBtn', 'regenerateRecapBtn'];
    ids.forEach(function(id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        vscode.postMessage({ command: 'generateRecap' });
      });
    });
  }
  attachGenerateRecapHandler();

  // ── Regenerate-summary shared request + delegated click handlers ────────
  // Drives the end-to-end re-run from either entry point:
  //   - The Conversations card's #regenerateSummaryBtn (in the initial DOM)
  //   - The top-of-page #summaryErrorRegenerateBtn (banner; may be inserted
  //     dynamically by the summaryRegenerated handler — event delegation
  //     means we don't need to re-bind after DOM replacement)
  // Both go through the same guards (unsaved edits + in-flight LLM) so the
  // banner button can't bypass them. The actual confirm dialog + LLM call
  // lives on the extension host; this side only gates the click and
  // renders progress state.
  function requestRegenerateSummary(btn) {
    if (btn && btn.disabled) return;
    // Block when user has unsaved edits in topics or recap — otherwise a
    // 30-second LLM call would silently overwrite in-progress work.
    if (document.querySelector('#topicsSection .toggle.editing, #recapSection.recap-editing')) {
      alert('You have unsaved edits in topics or recap. Save or cancel them before regenerating.');
      return;
    }
    // Block when another LLM action is already in flight.
    if (document.querySelector('.generating')) {
      alert('Another action is in progress. Please wait for it to finish.');
      return;
    }
    vscode.postMessage({ command: 'regenerateSummary' });
  }

  function attachRegenerateSummaryDelegate() {
    var page = document.querySelector('.page');
    if (!page) return;
    page.addEventListener('click', function(e) {
      var target = e.target;
      if (!target || typeof target.closest !== 'function') return;
      var btn = target.closest('#regenerateSummaryBtn, #summaryErrorRegenerateBtn');
      if (!btn) return;
      e.stopPropagation();
      requestRegenerateSummary(btn);
    });
  }
  attachRegenerateSummaryDelegate();

  // Toggle the page into / out of regenerating-readonly mode. CSS
  // (.page.regenerating-readonly button:not([data-foreign-safe])) takes
  // care of hiding every action button; the banner explains why. The
  // host's dispatchWebviewMessage adds a second-layer guard against any
  // postMessage that slips through (e.g. from a tab still on the old
  // pre-readonly DOM).
  function enterRegeneratingReadonly() {
    var page = document.querySelector('.page');
    if (page) page.classList.add('regenerating-readonly');
    insertRegeneratingBanner();
  }

  function leaveRegeneratingReadonly() {
    var page = document.querySelector('.page');
    if (page) page.classList.remove('regenerating-readonly');
    removeRegeneratingBanner();
  }

  function insertRegeneratingBanner() {
    if (document.getElementById('regeneratingBanner')) return;
    var page = document.querySelector('.page');
    if (!page) return;
    var banner = document.createElement('div');
    banner.id = 'regeneratingBanner';
    banner.className = 'regenerating-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML =
      '<span class="regenerating-banner-spinner" aria-hidden="true">\\u21BB</span>' +
      '<span class="regenerating-banner-text">Regenerating summary\\u2026 Other actions are temporarily disabled.</span>';
    page.insertBefore(banner, page.firstChild);
  }

  function removeRegeneratingBanner() {
    var banner = document.getElementById('regeneratingBanner');
    if (banner) banner.remove();
  }

  // CONTRACT: callers pass section HTML from SummaryHtmlBuilder.ts. Two shapes
  // exist and both are handled by the trailing-<hr> logic below:
  //   - "<div id='…'>…</div><hr class='separator'/>" (two siblings) —
  //     buildRecapSection, buildE2eTestSection, buildPlansAndNotesSection.
  //   - "<div id='…'>…</div>" (single node, no trailing <hr>) —
  //     buildTopicsSection (last content section before the footer).
  // Used by summaryRegenerated (recap+topics), topicsUpdated, and
  // plansAndNotesUpdated. If any of those builders' trailing-separator shape
  // changes, update the logic below in the same commit — otherwise the partial
  // refresh leaves stacked or missing <hr class="separator">.
  function replaceSection(id, html) {
    var old = document.getElementById(id);
    if (!old) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    var nodes = Array.prototype.slice.call(wrap.childNodes).filter(function(n) { return n.nodeType === 1; });
    if (nodes.length === 0) return;
    // If the NEW html ends with its own <hr class="separator"> sibling, drop the
    // OLD node's trailing <hr> first so we don't stack two separators. The
    // recap / e2e / plansAndNotes sections all emit a "<div>…</div><hr/>" pair;
    // topicsSection ends in "</div>" (no trailing <hr>), so the guard is a
    // no-op there. Generalized from the former recap-only special case so the
    // same helper serves topicsUpdated / plansAndNotesUpdated too.
    var lastNew = nodes[nodes.length - 1];
    var sep = old.nextElementSibling;
    if (lastNew && lastNew.tagName === 'HR' && sep && sep.tagName === 'HR') sep.remove();
    old.replaceWith.apply(old, nodes);
  }

  // Recap status messages — generation flow only. The 'recapUpdated' /
  // 'recapUpdateError' messages are handled in the top-level message
  // listener above and reused here; we only add the generating-loading
  // state here so the button reflects in-flight work.
  // Mirrors the E2E regenerate UX: regen icon button gets the .generating
  // class (spinning animation + opacity dim + wait cursor); the larger
  // Generate text button just changes its label to "Generating...".
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.command === 'recapGenerating') {
      var genBtn = document.getElementById('generateRecapBtn');
      var regenBtn = document.getElementById('regenerateRecapBtn');
      if (genBtn) {
        genBtn.textContent = 'Generating...';
        genBtn.disabled = true;
      }
      if (regenBtn) {
        regenBtn.classList.add('generating');
        regenBtn.title = 'Generating...';
        regenBtn.disabled = true;
      }
    }
  });

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
          btn.textContent = '\\u2728 Generate';
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

  // ── Plans & Notes whole-section replace ──
  // After a plan/note/reference add/remove/save/translate the host re-renders
  // the whole #plansAndNotesSection (keeps the count badge + empty-state in
  // sync). data-action buttons are document-delegated so they survive the
  // replace; the snippet form's per-element input listeners do NOT, so
  // bindPlansAndNotesSection re-binds them.
  if (msg.command === 'plansAndNotesUpdated' && typeof msg.html === 'string') {
    replaceSection('plansAndNotesSection', msg.html);
    bindPlansAndNotesSection();
  }

  // ── Header Jolli row (published Plans & Notes link list) ──
  // Sent alongside plansAndNotesUpdated because #jolliRow embeds that link list.
  // Replace if present; remove if the new html is empty; ignore if absent
  // (#jolliRow only exists after the commit is pushed, and push takes the
  // full-rebuild path).
  if (msg.command === 'jolliRowUpdated' && typeof msg.html === 'string') {
    var oldJolliRow = document.getElementById('jolliRow');
    if (oldJolliRow) {
      if (msg.html.trim().length === 0) {
        oldJolliRow.remove();
      } else {
        var jolliWrap = document.createElement('div');
        jolliWrap.innerHTML = msg.html;
        var newJolliRow = jolliWrap.firstElementChild;
        if (newJolliRow) oldJolliRow.replaceWith(newJolliRow);
      }
    }
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

  // ── Reference inline edit messages (mirrors plan/note) ──
  if (msg.command === 'referenceContentLoaded' && msg.archivedKey && msg.source && msg.content !== undefined) {
    // DOM id strips '<source>:' prefix uniformly across all sources so the id
    // is 'reference-<source>-<bareKey>' — matches SummaryHtmlBuilder.buildReferenceRow.
    var refLePrefix = msg.source + ':';
    var refLeKey = msg.archivedKey.indexOf(refLePrefix) === 0 ? msg.archivedKey.slice(refLePrefix.length) : msg.archivedKey;
    var referenceEl = document.getElementById('reference-' + msg.source + '-' + refLeKey);
    if (referenceEl) {
      var referenceEditArea = referenceEl.querySelector('.plan-edit-area');
      var referenceTextareaIn = referenceEl.querySelector('.plan-edit-textarea');
      if (referenceEditArea && referenceTextareaIn) {
        referenceTextareaIn.value = msg.content;
        referenceEl.classList.add('editing');
        referenceTextareaIn.focus();
      }
    }
  }

  if (msg.command === 'referenceSaved' && msg.archivedKey && msg.source) {
    var refSavedPrefix = msg.source + ':';
    var refSavedDomKey = msg.archivedKey.indexOf(refSavedPrefix) === 0 ? msg.archivedKey.slice(refSavedPrefix.length) : msg.archivedKey;
    var referenceEl2 = document.getElementById('reference-' + msg.source + '-' + refSavedDomKey);
    if (referenceEl2) {
      referenceEl2.classList.remove('editing');
    }
  }

  // ── Reference translation status ──
  if (msg.command === 'referenceTranslating' && msg.archivedKey) {
    var refTransBtn = document.querySelector('.reference-translate-btn[data-reference-key="' + msg.archivedKey + '"]');
    if (refTransBtn) {
      refTransBtn.disabled = true;
      refTransBtn.classList.add('translating');
      refTransBtn.setAttribute('title', 'Translating...');
    }
  }
  if (msg.command === 'referenceTranslateError' && msg.archivedKey) {
    var refTransBtn2 = document.querySelector('.reference-translate-btn[data-reference-key="' + msg.archivedKey + '"]');
    if (refTransBtn2) {
      refTransBtn2.disabled = false;
      refTransBtn2.classList.remove('translating');
      refTransBtn2.setAttribute('title', 'Translate to English');
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
      case 'previewReference': {
        // Title click -> host opens read-only webview rendering the archived
        // markdown for this reference. archivedKey carries the source prefix
        // so the host dispatches without re-parsing the source.
        e.preventDefault();
        var pevKey = target.getAttribute('data-reference-key') || '';
        var pevSource = target.getAttribute('data-reference-source') || '';
        var pevNativeId = target.getAttribute('data-reference-native-id') || '';
        var pevTitle = target.getAttribute('data-reference-title') || '';
        vscode.postMessage({ command: 'previewReference', archivedKey: pevKey, source: pevSource, nativeId: pevNativeId, title: pevTitle });
        break;
      }
      case 'openReferenceExternal': {
        // 🌍 → host opens reference.url in the default browser. URL is round-
        // tripped via data-reference-url so the host doesn't need to re-query
        // the orphan branch summary — the row already has it.
        var oeUrl = target.getAttribute('data-reference-url') || '';
        vscode.postMessage({ command: 'openReferenceExternal', url: oeUrl });
        break;
      }
      case 'translateReference': {
        // 🌐 → host calls the same translation pipeline plans use; result
        // stored in the same translation cache keyed by archivedKey.
        var teKey = target.getAttribute('data-reference-key') || '';
        var teSource = target.getAttribute('data-reference-source') || '';
        vscode.postMessage({ command: 'translateReference', archivedKey: teKey, source: teSource });
        break;
      }
      case 'loadReferenceContent': {
        // ✎ → host reads the archived markdown body and sends it back via
        // referenceContentLoaded; the webview then opens the inline textarea.
        var leKey = target.getAttribute('data-reference-key') || '';
        var leSource = target.getAttribute('data-reference-source') || '';
        vscode.postMessage({ command: 'loadReferenceContent', archivedKey: leKey, source: leSource });
        break;
      }
      case 'saveReferenceEdit': {
        // Save -> host writes back to orphan branch under references/source/.
        var seKey = target.getAttribute('data-reference-key') || '';
        var seSource = target.getAttribute('data-reference-source') || '';
        // buildReferenceRow's id strips the "<source>:" prefix for ALL sources
        // (stripSourcePrefix), so replicate that for every source — not just
        // Linear — or the textarea lookup misses on jira/github/notion rows.
        var seDomKey = (seKey.indexOf(seSource + ':') === 0) ? seKey.slice((seSource + ':').length) : seKey;
        var referenceItem = document.getElementById('reference-' + seSource + '-' + seDomKey);
        if (!referenceItem) break;
        var referenceTextarea = referenceItem.querySelector('.plan-edit-textarea');
        if (!referenceTextarea) break;
        vscode.postMessage({ command: 'saveReferenceEdit', archivedKey: seKey, source: seSource, content: referenceTextarea.value });
        break;
      }
      case 'cancelReferenceEdit': {
        var ceKey = target.getAttribute('data-reference-key') || '';
        var ceSource = target.getAttribute('data-reference-source') || '';
        var ceDomKey = (ceKey.indexOf(ceSource + ':') === 0) ? ceKey.slice((ceSource + ':').length) : ceKey;
        var ceReferenceEl = document.getElementById('reference-' + ceSource + '-' + ceDomKey);
        if (!ceReferenceEl) break;
        ceReferenceEl.classList.remove('editing');
        break;
      }
      case 'removeReference': {
        var reKey = target.getAttribute('data-reference-key') || '';
        var reSource = target.getAttribute('data-reference-source') || '';
        var reNativeId = target.getAttribute('data-reference-native-id') || '';
        var reTitle = target.getAttribute('data-reference-title') || '';
        vscode.postMessage({ command: 'removeReference', archivedKey: reKey, source: reSource, nativeId: reNativeId, title: reTitle });
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
      form.classList.remove('hidden');
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
      form.classList.add('hidden');
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
  // Enable/disable Save button based on title and content. The snippet form
  // lives inside #plansAndNotesSection, so these per-element input listeners are
  // lost when that section is replaced (plansAndNotesUpdated). bindPlansAndNotesSection
  // re-grabs + re-binds them; it runs at init AND after each section replace.
  // (The plan/note/reference data-action buttons are document-delegated, so
  // they need no re-bind.)
  function bindPlansAndNotesSection() {
    var snippetTitleEl = document.getElementById('snippetTitle');
    var snippetContentEl = document.getElementById('snippetContent');
    if (snippetTitleEl) {
      snippetTitleEl.addEventListener('input', updateSaveSnippetBtn);
    }
    if (snippetContentEl) {
      snippetContentEl.addEventListener('input', updateSaveSnippetBtn);
    }
  }
  bindPlansAndNotesSection();

  // ── Transcript Stats (async load for section description) ───────────────
  // Reassigned by bindConversationsSection after a section replace; the
  // transcriptStatsLoaded handler fills whatever it points at. The initial (and
  // post-refresh) stats load is kicked off from bindConversationsSection().
  var conversationsStats = document.getElementById('conversationsStats');

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
    // Clear any error banner from a previous failed save/delete attempt so
    // the new session starts clean.
    var prevErr = document.getElementById('modalErrorBanner');
    if (prevErr) prevErr.style.display = 'none';
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

${buildTranscriptEntriesScript()}

  function attachEntryClickHandler(entryEl) {
    var contentEl = entryEl.querySelector('.entry-content');
    if (!contentEl) return;
    contentEl.addEventListener('click', function() {
      if (entryEl.classList.contains('deleted')) return;
      if (entryEl.classList.contains('editing')) return;
      // Readonly modes (foreign repo, stale commit, in-flight regenerate) hide
      // the entry-delete and modal Save/Cancel buttons via CSS, but the click-
      // to-edit affordance is an event handler — CSS can't suppress it. Without
      // this guard a click in cross-repo "View" mode would still pop a textarea
      // the user can type into and immediately lose on blur (no projectDir to
      // persist the overlay).
      if (document.querySelector('.page.foreign-readonly, .page.stale-readonly, .page.regenerating-readonly')) return;

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

  // ── Conversations section binding (init + after conversationsUpdated) ────
  // After conversationsUpdated replaces #allConversationsSection the old modal +
  // button nodes are discarded, so we re-grab every ref (reassigning the closure
  // vars that openModal/closeModal/renderTranscriptEntries/the message listener
  // all read) and re-wire the per-element button listeners. The GLOBAL keydown +
  // message listeners are registered ONCE, below, outside this function — they
  // read the reassignable refs, so they keep working against the new modal
  // without piling up duplicate registrations on every refresh.
  function bindConversationsSection() {
    transcriptModal = document.getElementById('transcriptModal');
    modalTabs = document.getElementById('modalTabs');
    modalBody = document.getElementById('modalBody');
    modalLoading = document.getElementById('modalLoading');
    modalSubtitle = document.getElementById('modalSubtitle');
    modalSaveBtn = document.getElementById('modalSaveBtn');
    modalCancelBtn = document.getElementById('modalCancelBtn');
    modalCloseBtn = document.getElementById('modalCloseBtn');
    deleteTranscriptsBtn = document.getElementById('deleteTranscriptsBtn');
    openTranscriptsBtn = document.getElementById('openTranscriptsBtn');
    conversationsStats = document.getElementById('conversationsStats');

    if (openTranscriptsBtn) openTranscriptsBtn.addEventListener('click', openModal);
    if (modalCloseBtn) modalCloseBtn.addEventListener('click', function() { closeModal(); });
    if (modalCancelBtn) modalCancelBtn.addEventListener('click', function() { closeModal(); });
    if (transcriptModal) {
      transcriptModal.addEventListener('click', function(e) {
        if (e.target === transcriptModal) closeModal();
      });
    }
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

    // Kick off / refresh the async stats line for the (possibly new) element.
    if (conversationsStats) vscode.postMessage({ command: 'loadTranscriptStats' });
  }
  bindConversationsSection();

  // GLOBAL listener — registered ONCE (NOT inside bindConversationsSection, or
  // every refresh would stack another). Reads the reassignable transcriptModal
  // ref + closure closeModal fn, so it stays valid across section rebuilds.
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && transcriptModal && transcriptModal.classList.contains('visible')) {
      closeModal();
    }
  });

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
    // Success: the host re-renders the whole #allConversationsSection, which
    // discards the open modal (closing it) and refreshes the stats / empty
    // state. bindConversationsSection re-grabs refs + re-wires the new buttons.
    if (msg.command === 'conversationsUpdated' && typeof msg.html === 'string') {
      replaceSection('allConversationsSection', msg.html);
      bindConversationsSection();
    }
    // transcriptsSaved / transcriptsDeleted are still posted by the host (kept
    // for existing assertions), but intentionally do NO DOM work here: closing +
    // refresh is owned by conversationsUpdated above. The former closeModal()
    // was removed so it doesn't double-handle / race the rebuild.
    // Failure paths (added 2026-05-22 for v5): backend posts these when summary
    // update or transcript file batch failed. Without handling them, the Save
    // button would stay stuck in "Saving..." disabled state forever (the user
    // would have to reload the webview to continue). Re-enable the button and
    // surface a non-blocking notification with the backend-provided detail.
    if (msg.command === 'transcriptsSaveFailed' || msg.command === 'transcriptsDeleteFailed') {
      if (modalSaveBtn) {
        modalSaveBtn.disabled = false;
        modalSaveBtn.textContent = 'Save All';
      }
      var errBanner = document.getElementById('modalErrorBanner');
      if (errBanner) {
        var defaultMsg = msg.command === 'transcriptsSaveFailed' ? 'Save failed. See logs.' : 'Delete failed. See logs.';
        errBanner.textContent = msg.message || defaultMsg;
        errBanner.style.display = 'block';
      }
    }
    if (msg.command === 'transcriptsLoading') {
      if (modalLoading) modalLoading.style.display = 'block';
    }
    if (msg.command === 'transcriptStatsLoaded') {
      if (conversationsStats) {
        var sessionCounts = msg.sessionCounts || {};
        var parts = [];
        var sourceOrder = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'copilot-chat'];
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
