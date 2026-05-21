import { TRANSCRIPT_SOURCE_LABELS } from "../../../cli/src/core/TranscriptSourceLabel.js";

/**
 * Shared client-side renderer for transcript entries.
 *
 * Returns a self-contained JS source string that defines a global
 * function 'renderTranscriptEntries(entries)' (plus the small
 * 'getSourceLabel' helper). The returned string is concatenated into a
 * larger script by both SummaryScriptBuilder (existing transcript modal)
 * and ConversationDetailsScriptBuilder (new dedicated panel, future work).
 *
 * IMPORTANT: this is a pure extraction. Behavior, DOM structure, class
 * names, attributes, and event-listener wiring all match the previous
 * inline implementation in SummaryScriptBuilder.ts exactly. The HTML
 * assembly via 'innerHTML' is preserved verbatim from the original —
 * fields that originate from extension-host data are passed through
 * 'esc()' before interpolation, exactly as before.
 *
 * getSourceLabel BODY is generated from the TS-side TRANSCRIPT_SOURCE_LABELS
 * map so the extension host and the webview always agree on labels (the
 * extension uses the TS helper directly; this file emits the equivalent JS).
 *
 * RUNTIME CONTRACT: the surrounding script must provide these symbols in
 * the enclosing scope (they are NOT params, to keep the call-site
 * signature unchanged):
 *   - Variables (mutable): modalBody, modalTabs, originalTranscripts,
 *     rawContentMap, modifiedCount, deletedCount, activeTextarea
 *   - Helper functions: esc, formatTime, renderMarkdown,
 *     attachEntryClickHandler, attachEntryDeleteHandler,
 *     attachSessionDeleteHandler, updateChangeCounter
 *
 * NO backticks allowed in the returned string body — the result is
 * spliced into a parent template literal, and a stray backtick (even
 * in a comment) would prematurely terminate that literal.
 */
export function buildTranscriptEntriesScript(): string {
	// Generate the `if (source === 'X') return 'Y';` lines for every non-Claude
	// entry from the shared TS map. Claude is the fallback (return at the end).
	const labelBranches = Object.entries(TRANSCRIPT_SOURCE_LABELS)
		.filter(([key]) => key !== "claude")
		.map(([key, label]) => `    if (source === '${key}') return '${label}';`);
	return [
		"  function getSourceLabel(source) {",
		...labelBranches,
		"    return 'Claude';",
		"  }",
		"",
		"  function renderTranscriptEntries(entries) {",
		"    if (!modalBody) return;",
		"    originalTranscripts = entries;",
		"",
		"    // Group by source plus sessionId",
		"    var groups = {};",
		"    var groupOrder = [];",
		"    for (var i = 0; i < entries.length; i++) {",
		"      var e = entries[i];",
		"      var key = (e.source || 'claude') + ':' + e.sessionId;",
		"      if (!groups[key]) {",
		"        groups[key] = { source: e.source || 'claude', sessionId: e.sessionId, entries: [] };",
		"        groupOrder.push(key);",
		"      }",
		"      groups[key].entries.push(e);",
		"    }",
		"",
		"    // Sort entries within each group by timestamp",
		"    for (var k = 0; k < groupOrder.length; k++) {",
		"      groups[groupOrder[k]].entries.sort(function(a, b) {",
		"        return (a.timestamp || '').localeCompare(b.timestamp || '');",
		"      });",
		"    }",
		"",
		"    // Sort session groups by each group's earliest entry timestamp",
		"    groupOrder.sort(function(a, b) {",
		"      var aFirst = groups[a].entries[0] ? (groups[a].entries[0].timestamp || '') : '';",
		"      var bFirst = groups[b].entries[0] ? (groups[b].entries[0].timestamp || '') : '';",
		"      return aFirst.localeCompare(bFirst);",
		"    });",
		"",
		"    // Build tab bar (with delete button on each tab)",
		"    var tabsHtml = '';",
		"    for (var t = 0; t < groupOrder.length; t++) {",
		"      var tabGroup = groups[groupOrder[t]];",
		"      var tabSourceLabel = getSourceLabel(tabGroup.source);",
		"      var tabEntryCount = tabGroup.entries.length;",
		"      var activeClass = t === 0 ? ' active' : '';",
		"      tabsHtml += '<button class=\"modal-tab' + activeClass + '\" data-tab-key=\"' + groupOrder[t] + '\">';",
		"      tabsHtml += tabSourceLabel + ' (' + tabEntryCount + ')';",
		'      tabsHtml += \'<span class="session-delete-btn" data-group-key="\' + groupOrder[t] + \'" title="Delete entire session">&#x1F5D1;</span>\';',
		"      tabsHtml += '</button>';",
		"    }",
		"    if (modalTabs) {",
		"      modalTabs.innerHTML = tabsHtml;",
		"      // Hide tab bar if only one session",
		"      modalTabs.style.display = groupOrder.length > 1 ? 'flex' : 'none';",
		"    }",
		"",
		"    // Build tab panels and populate rawContentMap",
		"    rawContentMap = {};",
		"    var html = '';",
		"    for (var g = 0; g < groupOrder.length; g++) {",
		"      var group = groups[groupOrder[g]];",
		"      var panelActiveClass = g === 0 ? ' active' : '';",
		"      html += '<div class=\"tab-panel' + panelActiveClass + '\" data-panel-key=\"' + groupOrder[g] + '\">';",
		"      html += '<div class=\"transcript-session\" data-group-key=\"' + groupOrder[g] + '\">';",
		"",
		"      for (var j = 0; j < group.entries.length; j++) {",
		"        var entry = group.entries[j];",
		"        var entryKey = esc(entry.commitHash) + ':' + esc(entry.sessionId) + ':' + entry.originalIndex;",
		"        rawContentMap[entryKey] = entry.content;",
		"        var roleIcon = entry.role === 'human' ? '&#x1F464;' : '&#x1F916;';",
		"        var roleLabel = entry.role === 'human' ? 'user' : 'bot';",
		"        var timeStr = entry.timestamp ? formatTime(entry.timestamp) : '';",
		"        html += '<div class=\"transcript-entry\" data-commit=\"' + esc(entry.commitHash) + '\" data-session=\"' + esc(entry.sessionId) + '\" data-source=\"' + esc(entry.source || 'claude') + '\" data-index=\"' + entry.originalIndex + '\" data-timestamp=\"' + esc(entry.timestamp || '') + '\" data-role=\"' + esc(entry.role) + '\">';",
		"        html += '<div class=\"entry-header\">';",
		"        html += '<span class=\"entry-role\">' + roleIcon + ' ' + roleLabel + '</span>';",
		"        html += '<span class=\"entry-time\">' + esc(timeStr) + '</span>';",
		'        html += \'<button class="entry-delete-btn" title="Delete entry">&#x1F5D1;</button>\';',
		"        html += '</div>';",
		"        html += '<div class=\"entry-content\">' + renderMarkdown(entry.content) + '</div>';",
		"        html += '</div>';",
		"      }",
		"      html += '</div>';",
		"      html += '</div>';",
		"    }",
		"",
		"    modalBody.innerHTML = html;",
		"",
		"    // Attach tab switching",
		"    if (modalTabs) {",
		"      var tabs = modalTabs.querySelectorAll('.modal-tab');",
		"      for (var ti = 0; ti < tabs.length; ti++) {",
		"        tabs[ti].addEventListener('click', function() {",
		"          var key = this.getAttribute('data-tab-key');",
		"          // Deactivate all tabs and panels",
		"          var allTabs = modalTabs.querySelectorAll('.modal-tab');",
		"          for (var a = 0; a < allTabs.length; a++) allTabs[a].classList.remove('active');",
		"          var allPanels = modalBody.querySelectorAll('.tab-panel');",
		"          for (var p = 0; p < allPanels.length; p++) allPanels[p].classList.remove('active');",
		"          // Activate clicked tab and matching panel",
		"          this.classList.add('active');",
		"          var panel = modalBody.querySelector('.tab-panel[data-panel-key=\"' + key + '\"]');",
		"          if (panel) panel.classList.add('active');",
		"        });",
		"      }",
		"    }",
		"",
		"    // Attach click-to-edit on entries (across ALL panels so state is preserved)",
		"    var allEntries = modalBody.querySelectorAll('.transcript-entry:not(.deleted)');",
		"    for (var idx = 0; idx < allEntries.length; idx++) {",
		"      attachEntryClickHandler(allEntries[idx]);",
		"    }",
		"",
		"    // Attach delete handlers",
		"    var entryDelBtns = modalBody.querySelectorAll('.entry-delete-btn');",
		"    for (var d = 0; d < entryDelBtns.length; d++) {",
		"      attachEntryDeleteHandler(entryDelBtns[d]);",
		"    }",
		"",
		"    // Session delete buttons are in the tab bar, not in the body",
		"    var sessionDelBtns = modalTabs ? modalTabs.querySelectorAll('.session-delete-btn') : [];",
		"    for (var s = 0; s < sessionDelBtns.length; s++) {",
		"      attachSessionDeleteHandler(sessionDelBtns[s]);",
		"    }",
		"  }",
	].join("\n");
}
