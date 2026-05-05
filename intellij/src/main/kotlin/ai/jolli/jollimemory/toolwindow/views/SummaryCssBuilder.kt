package ai.jolli.jollimemory.toolwindow.views

/**
 * SummaryCssBuilder — Kotlin port of SummaryCssBuilder.ts
 *
 * Returns the full CSS stylesheet for the Notion-like webview.
 * Uses a `isDark` boolean to emit hardcoded theme colours instead of
 * VS Code CSS custom properties (`var(--vscode-*)`).
 *
 * Custom properties (--callout-trigger-bg, etc.) are still used internally
 * but defined in a `:root` block so the rest of the stylesheet can
 * reference them without conditional logic.
 */
object SummaryCssBuilder {

    /** Font stack used in place of `var(--vscode-font-family)`. */
    private const val FONT_FAMILY =
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

    /** Monospace font stack used in place of `var(--vscode-editor-font-family)`. */
    private const val MONO_FONT_FAMILY =
        "'JetBrains Mono', Menlo, Consolas, 'Courier New', monospace"

    /** Returns the complete CSS stylesheet for the summary webview. */
    fun buildCss(isDark: Boolean): String {
        val rootVars = buildRootVars(isDark)
        return """
  /* ── Theme variables ── */
  :root {
$rootVars
  }

  /* ── Base ── */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .hidden { display: none !important; }
  body {
    font-family: $FONT_FAMILY;
    font-size: 14px;
    color: var(--text-primary);
    background: var(--bg);
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Page container ── */
  .page {
    max-width: 900px;
    margin: 0 auto;
    padding: 36px 28px 48px;
  }

  /* ── Private Zone (All Conversations) ── */
  .private-zone {
    position: relative;
    overflow: hidden;
    border: 1px dashed var(--private-zone-border);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 20px;
    background: var(--private-zone-bg);
  }
  .private-zone-watermark {
    position: absolute;
    bottom: -4px;
    right: 12px;
    font-size: 2.2em;
    font-weight: 800;
    letter-spacing: 0.12em;
    opacity: 0.06;
    pointer-events: none;
    white-space: nowrap;
    user-select: none;
    color: var(--text-primary);
  }
  .private-zone .section-header,
  .private-zone .conversations-description,
  .private-zone .conversations-privacy {
    position: relative;
    z-index: 1;
  }
  .stats-loading {
    opacity: 0.5;
    font-style: italic;
  }

  /* ── Header: title + action bar ── */
  .page-title {
    font-size: 1.35em;
    font-weight: 600;
    line-height: 1.35;
    margin: 0 0 10px 0;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }
  .header-actions {
    display: flex;
    gap: 6px;
    margin-bottom: 16px;
  }
  .action-btn {
    font-family: $FONT_FAMILY;
    font-size: 0.8em;
    padding: 5px 14px;
    border-radius: 5px;
    border: 1px solid var(--btn-border);
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.1s ease, color 0.1s ease;
  }
  .action-btn:hover {
    background: var(--btn-secondary-hover-bg);
    color: var(--text-primary);
  }
  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }
  .action-btn.primary {
    background: var(--btn-primary-bg);
    color: var(--btn-primary-fg);
    border-color: var(--btn-primary-bg);
  }
  .action-btn.primary:hover {
    background: var(--btn-primary-hover-bg);
    color: var(--btn-primary-fg);
  }

  /* ── Plans Section ── */
  .plan-item {
    padding: 6px 0;
  }
  .plan-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }
  .plan-icon { font-size: 1.1em; }
  .plan-title {
    font-weight: 600;
    font-size: 0.95em;
    color: var(--text-primary);
    flex: 1;
  }
  .plan-header-actions {
    display: flex;
    gap: 2px;
  }
  .plan-meta {
    font-size: 0.85em;
    color: var(--description-fg);
    padding-left: 2px;
  }
  .plan-remove-btn:hover { color: var(--error-fg); }
  .plan-translate-btn.translating {
    opacity: 0.5;
    cursor: wait;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 0.2; }
  }
  .plan-title-link {
    color: var(--text-primary);
    text-decoration: none;
    cursor: pointer;
  }
  .plan-title-link:hover {
    color: var(--link-fg);
    text-decoration: underline;
  }
  .plan-edit-area {
    display: none;
    margin-top: 8px;
  }
  .plan-item.editing .plan-edit-area {
    display: block;
  }
  .associate-plan-btn {
    margin-top: 8px;
  }
  .plan-edit-textarea {
    width: 100%;
    min-height: 300px;
    font-family: $MONO_FONT_FAMILY;
    font-size: 13px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    padding: 8px;
    resize: vertical;
    tab-size: 2;
  }
  .plan-edit-actions {
    margin-top: 6px;
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .plan-item.editing .plan-header-actions {
    display: none;
  }

  /* ── Empty-state placeholder text (E2E Test Guide, Quick recap) ── */
  .e2e-placeholder,
  .recap-placeholder {
    color: var(--description-fg);
    font-size: 0.92em;
    line-height: 1.5;
    margin: 4px 0 12px;
  }

  /* ── Quick Recap ── */
  .recap-body p {
    margin: 0 0 8px;
    line-height: 1.6;
  }
  .recap-body p:last-child {
    margin-bottom: 0;
  }
  .recap-edit-area {
    width: 100%;
    min-height: 120px;
    font-family: $MONO_FONT_FAMILY;
    font-size: 0.92em;
    padding: 8px 10px;
    border: 1px solid var(--input-border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--fg);
    resize: vertical;
    box-sizing: border-box;
    line-height: 1.5;
  }
  .recap-edit-area:focus {
    outline: none;
    border-color: var(--focus-border);
  }
  .recap-edit-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
  .recap-section.recap-editing .recap-body,
  .recap-section.recap-editing .topic-actions {
    display: none;
  }
  .e2e-scenario .callout.preconditions { background: var(--callout-trigger-bg); }
  .e2e-scenario .callout.preconditions .callout-label { color: var(--callout-trigger-label); }
  .e2e-scenario .callout.steps { background: var(--callout-response-bg); }
  .e2e-scenario .callout.steps .callout-label { color: var(--callout-response-label); }
  .e2e-scenario .callout.expected { background: var(--callout-decisions-bg); }
  .e2e-scenario .callout.expected .callout-label { color: var(--callout-decisions-label); }
  .e2e-scenario .callout ol {
    margin: 0; padding-left: 1.4em;
  }
  .e2e-scenario .callout ul {
    margin: 0; padding-left: 1.4em;
  }
  .e2e-scenario .callout li {
    margin-bottom: 4px; line-height: 1.45;
  }
  .e2e-edit-area {
    width: 100%;
    min-height: 200px;
    font-family: $MONO_FONT_FAMILY;
    font-size: 0.9em;
    line-height: 1.5;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    padding: 10px;
    resize: vertical;
    box-sizing: border-box;
  }
  .e2e-edit-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    justify-content: flex-end;
  }

  /* ── Properties table (Notion-style key-value rows) ── */
  .properties {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0;
    font-size: 0.93em;
    margin-bottom: 4px;
  }
  .prop-row {
    display: contents;
  }
  .prop-label {
    padding: 5px 16px 5px 0;
    color: var(--prop-label);
    font-weight: 400;
    white-space: nowrap;
    border-bottom: 1px solid var(--border-light);
  }
  .prop-value {
    padding: 5px 0;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border-light);
    word-break: break-word;
  }
  .prop-row:last-child .prop-label,
  .prop-row:last-child .prop-value {
    border-bottom: none;
  }

  /* ── Inline badges ── */
  .hash {
    font-family: $MONO_FONT_FAMILY;
    font-size: 0.92em;
    color: var(--link-fg);
  }
  .hash-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 5px;
    padding: 0 4px;
    height: 16px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.82em;
    line-height: 1;
    vertical-align: middle;
    transition: background 0.1s ease, color 0.1s ease;
  }
  .hash-copy:hover {
    background: var(--surface-hover);
    color: var(--link-fg);
  }
  .hash-copy.copied { color: var(--callout-todo-dot); }
  .date-relative { color: var(--text-primary); }
  .date-full { color: var(--text-secondary); }
  .pill {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 3px;
    font-size: 0.85em;
    background: var(--pill-bg);
    color: var(--pill-text);
  }

  /* ── Separator ── */
  .separator {
    border: none;
    border-top: 1px solid var(--border-light);
    margin: 20px 0;
  }

  /* ── Sections ── */
  .section { margin-bottom: 8px; }
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .section-title {
    font-size: 0.82em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
    margin-bottom: 0;
  }
  .section-count {
    font-weight: 400;
    color: var(--text-tertiary);
    margin-left: 4px;
  }
  .toggle-all-btn {
    font-family: $FONT_FAMILY;
    font-size: 0.75em;
    padding: 2px 10px;
    border-radius: 3px;
    border: 1px solid var(--border-light);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.1s ease, color 0.1s ease;
  }
  .toggle-all-btn:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }

  /* ── Source Commits list ── */
  .commit-list { margin-bottom: 4px; }
  .commit-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 0;
    font-size: 0.93em;
    border-bottom: 1px solid var(--border-light);
  }
  .commit-row:last-child { border-bottom: none; }
  .commit-row .hash { color: var(--text-secondary); }
  .commit-msg {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .commit-meta {
    flex-shrink: 0;
    color: var(--text-tertiary);
    font-size: 0.9em;
    white-space: nowrap;
  }

  /* ── Toggle (collapsible memory block) ── */
  .toggle { margin-bottom: 4px; }
  .toggle-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    font-weight: 500;
    font-size: 0.95em;
    transition: background 0.1s ease;
  }
  .toggle-header:hover { background: var(--surface-hover); }
  .toggle-header .arrow {
    font-size: 0.7em;
    color: var(--text-secondary);
    transition: transform 0.2s ease;
    flex-shrink: 0;
    display: inline-block;
    width: 12px;
    text-align: center;
  }
  .toggle.collapsed .arrow { transform: rotate(-90deg); }
  .toggle-num {
    color: var(--text-tertiary);
    font-size: 0.82em;
    font-weight: 400;
    margin-right: 2px;
  }

  /* ── Toggle content with smooth expand/collapse ── */
  .toggle-content {
    overflow: hidden;
    max-height: 800px;
    opacity: 1;
    transition: max-height 0.25s ease, opacity 0.2s ease, padding 0.25s ease;
    padding: 4px 10px 12px 30px;
  }
  .toggle.collapsed .toggle-content {
    max-height: 0;
    opacity: 0;
    padding-top: 0;
    padding-bottom: 0;
  }

  /* ── Callout blocks (Notion-style field display) ── */
  .callout {
    border-radius: 5px;
    padding: 10px 14px;
    margin-bottom: 8px;
    line-height: 1.55;
  }
  .callout-body { flex: 1; min-width: 0; }
  .callout-label {
    font-size: 0.76em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 3px;
  }
  .callout-text {
    font-size: 0.95em;
    color: var(--text-primary);
    word-break: break-word;
  }
  .callout-text ul {
    margin: 4px 0 0 0;
    padding-left: 1.4em;
  }
  .callout-text li {
    margin-bottom: 2px;
  }

  /* ── Callout color variants ── */
  .callout.trigger  { background: var(--callout-trigger-bg); }
  .callout.trigger  .callout-label { color: var(--callout-trigger-label); }

  .callout.decisions { background: var(--callout-decisions-bg); }
  .callout.decisions .callout-label { color: var(--callout-decisions-label); }

  /* Detail fields — neutral gray (collapsed by default) */
  .callout.response { background: var(--callout-detail-bg); }
  .callout.response .callout-label { color: var(--callout-detail-label); }

  .callout.todo { background: var(--callout-detail-bg); }
  .callout.todo .callout-label { color: var(--callout-detail-label); }

  .callout.files { background: var(--callout-detail-bg); }
  .callout.files .callout-label { color: var(--callout-detail-label); }

  /* ── Collapsible callouts (detail fields: response, todo, files) ── */
  .callout.collapsible .callout-label {
    cursor: pointer;
    user-select: none;
  }
  .callout.collapsible .callout-label::before {
    content: "\25BC";
    font-size: 0.7em;
    display: inline-block;
    margin-right: 5px;
    transition: transform 0.2s ease;
  }
  .callout.collapsible.callout-collapsed .callout-label::before {
    transform: rotate(-90deg);
  }
  .callout.collapsible .callout-text {
    overflow: hidden;
    max-height: 600px;
    opacity: 1;
    transition: max-height 0.25s ease, opacity 0.2s ease, margin 0.25s ease;
  }
  .callout.collapsible.callout-collapsed .callout-text {
    max-height: 0;
    opacity: 0;
    margin: 0;
  }

  /* ── Memory action buttons (edit / delete) — always visible ── */
  .topic-actions {
    margin-left: auto;
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .topic-action-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1em;
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--text-secondary);
    transition: background 0.1s ease, color 0.1s ease;
  }
  .topic-action-btn:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .topic-delete-btn:hover { color: var(--error-fg); }

  /* ── Inline edit mode ── */
  .toggle.editing .toggle-content {
    max-height: none;
    overflow: visible;
  }
  .toggle.editing .topic-actions { display: none; }
  .toggle.editing .toggle-header { pointer-events: none; }
  .edit-title-input {
    font-size: 0.95em;
    font-weight: 500;
    padding: 2px 6px;
    margin: 0;
    border: 1px solid var(--input-border);
    border-radius: 3px;
    background: var(--input-bg);
    color: var(--input-fg);
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
  }
  .edit-textarea {
    width: 100%;
    min-height: 60px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 0.92em;
    line-height: 1.5;
    border: 1px solid var(--input-border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--input-fg);
    resize: vertical;
    box-sizing: border-box;
  }
  .edit-textarea:focus, .edit-title-input:focus {
    outline: none;
    border-color: var(--focus-border);
  }
  .edit-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 10px;
    padding-bottom: 4px;
  }
  .edit-actions button {
    padding: 5px 16px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    font-size: 0.88em;
    font-weight: 500;
  }
  .edit-save-btn {
    background: var(--btn-primary-bg);
    color: var(--btn-primary-fg);
  }
  .edit-save-btn:hover:not(:disabled) { background: var(--btn-primary-hover-bg); }
  .edit-save-btn:disabled, .edit-cancel-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }
  .callout.files-affected-edit {
    background: var(--surface-hover);
  }
  .callout.files-affected-edit .callout-label {
    color: var(--text-secondary);
  }
  .edit-cancel-btn {
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
  }
  .edit-cancel-btn:hover { background: var(--btn-secondary-hover-bg); }

  /* ── Diff stat colors ── */
  .stat-add { color: var(--stat-add); }
  .stat-del { color: var(--stat-del); }
  .stat-turns {
    color: var(--stat-turns);
    background: var(--stat-turns-bg);
    padding: 1px 7px;
    border-radius: 10px;
    font-weight: 500;
  }

  /* ── Footer ── */
  .page-footer {
    margin-top: 32px;
    padding-top: 14px;
    border-top: 1px solid var(--border-light);
  }
  .footer-generated {
    font-size: 0.8em;
    color: var(--text-tertiary);
    letter-spacing: 0.01em;
  }

  /* ── Category pills ── */
  .cat-pill {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 3px;
    font-size: 0.75em;
    font-weight: 400;
    letter-spacing: 0.02em;
    margin-left: 8px;
    vertical-align: middle;
  }
  .cat-feature { background: var(--cat-feature-bg); color: var(--cat-feature-text); }
  .cat-bugfix  { background: var(--cat-bugfix-bg);  color: var(--cat-bugfix-text); }
  .cat-refactor { background: var(--cat-refactor-bg); color: var(--cat-refactor-text); }
  .cat-infra   { background: var(--cat-infra-bg);   color: var(--cat-infra-text); }
  .cat-docs    { background: var(--cat-docs-bg);    color: var(--cat-docs-text); }

  /* ── Minor importance: lighter toggle header ── */
  .toggle-header.minor {
    font-weight: 400;
    color: var(--text-secondary);
  }
  .toggle-header.minor .toggle-num { color: var(--text-tertiary); }

  /* ── Files affected list ── */
  .files-affected-item {
    font-family: $MONO_FONT_FAMILY;
    font-size: 0.88em;
    color: var(--text-secondary);
    padding: 1px 0;
  }
  .files-affected-item::before {
    content: "\2022\00a0";
    color: var(--text-tertiary);
  }

  /* ── Timeline (date-grouped memories for multi-day squash) ── */
  .timeline {
    position: relative;
  }
  .timeline::before {
    content: '';
    position: absolute;
    left: -15px;
    top: 12px;
    bottom: 12px;
    width: 2px;
    background: var(--border-light);
    border-radius: 1px;
  }
  .timeline-group {
    position: relative;
    margin-bottom: 4px;
  }
  .timeline-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    cursor: pointer;
    user-select: none;
    font-size: 0.9em;
    border-radius: 4px;
    transition: background 0.1s ease;
  }
  .timeline-header:hover { background: var(--surface-hover); }
  .timeline-dot {
    position: absolute;
    left: -19px;
    top: 12px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-tertiary);
    border: 2px solid var(--bg);
    z-index: 1;
  }
  .timeline-arrow {
    font-size: 0.7em;
    color: var(--text-secondary);
    transition: transform 0.2s ease;
    flex-shrink: 0;
    display: inline-block;
    width: 12px;
    text-align: center;
  }
  .timeline-group.collapsed .timeline-arrow { transform: rotate(-90deg); }
  .timeline-date {
    font-weight: 600;
    color: var(--text-primary);
  }
  .timeline-count {
    color: var(--text-tertiary);
    font-weight: 400;
    font-size: 0.85em;
  }
  .timeline-content {
    overflow: hidden;
    max-height: 4000px;
    opacity: 1;
    transition: max-height 0.3s ease, opacity 0.2s ease, padding 0.3s ease;
    padding: 2px 0 8px 20px;
  }
  .timeline-group.collapsed .timeline-content {
    max-height: 0;
    opacity: 0;
    padding-top: 0;
    padding-bottom: 0;
  }

  /* ── Jolli article link ── */
  .jolli-link {
    color: var(--link-fg);
    text-decoration: none;
    font-size: 0.92em;
  }
  .jolli-link:hover { text-decoration: underline; }

  .jolli-plans-block {
    margin-top: 10px;
  }
  .jolli-plans-label {
    font-size: 0.88em;
    color: var(--description-fg);
    font-weight: 600;
    display: block;
    margin-bottom: 4px;
  }
  .jolli-plan-item {
    margin-top: 2px;
  }

  /* ── Empty state ── */
  .empty {
    color: var(--text-secondary);
    font-style: italic;
    font-size: 0.9em;
    padding: 8px 0;
  }

  /* ── Transcript Modal ── */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: none;
    align-items: center;
    justify-content: center;
  }
  .modal-overlay.visible {
    display: flex;
  }
  .modal-container {
    background: var(--bg);
    border: 1px solid var(--widget-border);
    border-radius: 8px;
    width: 95%;
    max-width: 1100px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 20px;
  }
  .modal-title {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .modal-title > span:first-child {
    font-size: 1.05em;
    font-weight: 600;
  }
  .modal-subtitle {
    font-size: 0.8em;
    color: var(--description-fg);
  }
  .modal-close-btn {
    background: none;
    border: none;
    color: var(--text-primary);
    font-size: 1.4em;
    cursor: pointer;
    padding: 0 4px;
    opacity: 0.7;
  }
  .modal-close-btn:hover { opacity: 1; }
  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }
  .modal-loading {
    color: var(--description-fg);
    font-style: italic;
    padding: 40px 0;
    text-align: center;
  }
  .modal-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    border-top: 1px solid var(--widget-border);
  }
  .modal-footer-right {
    display: flex;
    gap: 8px;
  }

  /* ── Conversations description, stats & privacy ── */
  .conversations-description {
    font-size: 0.92em;
    color: var(--description-fg);
    margin: 6px 0 4px;
    line-height: 1.4;
  }
  .conversations-stats {
    font-size: 0.92em;
    color: var(--description-fg);
    margin: 4px 0;
    line-height: 1.4;
  }
  .conversations-privacy {
    font-size: 0.92em;
    color: var(--description-fg);
    margin: 16px 0 0;
    line-height: 1.4;
  }

  /* ── Tab bar ── */
  .modal-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--widget-border);
    padding: 0 20px;
    overflow-x: auto;
    flex-shrink: 0;
  }
  .modal-tab {
    padding: 6px 10px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.85em;
    color: var(--description-fg);
    border-bottom: 2px solid transparent;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s;
  }
  .modal-tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--link-fg);
    font-weight: 600;
  }
  .modal-tab:hover {
    color: var(--text-primary);
  }
  .modal-tab .session-delete-btn {
    margin-left: 8px;
    opacity: 0;
    transition: opacity 0.15s;
    font-size: 1em;
    cursor: pointer;
    color: var(--error-fg);
  }
  .modal-tab:hover .session-delete-btn { opacity: 0.7; }
  .modal-tab .session-delete-btn:hover { opacity: 1; }
  .modal-tab.session-deleted {
    text-decoration: line-through;
    opacity: 0.5;
  }
  .modal-tab.session-deleted .session-delete-btn {
    opacity: 1;
    color: var(--link-fg);
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* ── Transcript sessions & entries ── */
  .transcript-session {
    margin-bottom: 8px;
  }

  .transcript-entry {
    position: relative;
    padding: 8px 12px;
    margin-bottom: 6px;
    border-radius: 6px;
    border-left: 3px solid transparent;
    transition: background 0.15s;
    cursor: text;
  }
  .transcript-entry:hover .entry-content {
    background: var(--list-hover-bg);
    border-radius: 4px;
  }
  .transcript-entry.modified {
    border-left-color: var(--link-fg);
  }
  .transcript-entry.deleted {
    opacity: 0.4;
    cursor: default;
  }
  .transcript-entry.deleted .entry-content {
    text-decoration: line-through;
    pointer-events: none;
  }
  .transcript-entry.deleted .entry-delete-btn {
    opacity: 0.7;
    pointer-events: auto;
    color: var(--link-fg);
  }
  .transcript-entry.editing {
    background: var(--bg);
    cursor: default;
  }
  .entry-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 0.8em;
  }
  .entry-role {
    font-weight: 600;
    color: var(--text-primary);
  }
  .entry-time {
    color: var(--description-fg);
  }
  .entry-delete-btn {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1em;
    opacity: 0;
    transition: opacity 0.15s;
    color: var(--error-fg);
  }
  .transcript-entry:hover .entry-delete-btn { opacity: 0.7; }
  .entry-delete-btn:hover { opacity: 1 !important; }

  .entry-content {
    font-size: 0.9em;
    line-height: 1.5;
    word-break: break-word;
    color: var(--text-primary);
    padding: 2px 4px;
    border-radius: 4px;
    transition: background 0.15s;
  }

  /* ── Markdown styles in entry content ── */
  .entry-content .md-code-block {
    background: var(--code-block-bg);
    border-radius: 4px;
    padding: 8px 12px;
    margin: 6px 0;
    overflow-x: auto;
    font-family: $MONO_FONT_FAMILY;
    font-size: 0.9em;
    line-height: 1.4;
    white-space: pre-wrap;
  }
  .entry-content .md-inline-code {
    background: var(--code-block-bg);
    border-radius: 3px;
    padding: 1px 4px;
    font-family: $MONO_FONT_FAMILY;
    font-size: 0.9em;
  }
  .entry-content .md-heading {
    margin: 8px 0 4px;
    font-weight: 600;
    line-height: 1.3;
  }
  .entry-content h2.md-heading { font-size: 1.1em; }
  .entry-content h3.md-heading { font-size: 1em; }
  .entry-content h4.md-heading { font-size: 0.95em; }
  .entry-content h5.md-heading { font-size: 0.9em; }
  .entry-content .md-list {
    margin: 4px 0;
    padding-left: 20px;
  }
  .entry-content .md-list li {
    margin: 2px 0;
  }
  .entry-content .md-link {
    color: var(--link-fg);
    text-decoration: none;
  }
  .entry-content .md-link:hover {
    text-decoration: underline;
  }
  .entry-content .md-blank {
    height: 0.5em;
  }

  .entry-edit-textarea {
    width: 100%;
    min-height: 60px;
    padding: 8px;
    font-family: $MONO_FONT_FAMILY;
    font-size: 0.9em;
    line-height: 1.5;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    resize: vertical;
    outline: none;
  }
  .entry-edit-textarea:focus {
    border-color: var(--focus-border);
  }

  /* ── Danger button ── */
  .action-btn.danger {
    color: var(--error-fg);
    border-color: var(--error-fg);
  }
  .action-btn.danger:hover {
    background: var(--error-fg);
    color: #fff;
  }

  /* ── PR Section ── */
  .pr-hidden {
    display: none;
  }
  .pr-icon {
    vertical-align: -2px;
    margin-right: 4px;
  }
  .pr-status-text {
    color: var(--description-fg);
    font-size: 0.92em;
    line-height: 1.5;
    margin: 4px 0 8px;
  }
  .pr-link-row {
    margin: 4px 0 10px;
  }
  .pr-link-row a {
    color: var(--link-fg);
    text-decoration: none;
    font-weight: 500;
  }
  .pr-link-row a:hover {
    text-decoration: underline;
  }
  .pr-actions {
    margin: 8px 0 4px;
  }
  /* ── PR Create Form ── */
  .pr-form {
    margin-top: 10px;
  }
  .pr-form-label {
    display: block;
    font-size: 0.88em;
    font-weight: 600;
    color: var(--text-primary);
    margin: 8px 0 4px;
  }
  .pr-form-input {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 10px;
    font-size: 0.92em;
    font-family: $FONT_FAMILY;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
  }
  .pr-form-textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 360px;
    font-family: $MONO_FONT_FAMILY;
    font-size: 0.88em;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    padding: 10px;
    resize: vertical;
  }
  .pr-form-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    justify-content: flex-end;
  }
"""
    }

    // ── Theme variable definitions ───────────────────────────────────────────

    /**
     * Builds the `:root` custom property declarations for the chosen theme.
     * Every VS Code token (`--vscode-*`) is replaced with a self-defined
     * `--var` name whose concrete value depends on [isDark].
     */
    private fun buildRootVars(isDark: Boolean): String {
        return if (isDark) buildDarkVars() else buildLightVars()
    }

    /** Dark theme variable block (matches `body.vscode-dark` values). */
    private fun buildDarkVars(): String = """
    /* ── Core palette ── */
    --bg: #1e1e1e;
    --text-primary: #e0e0e0;
    --description-fg: #969696;
    --link-fg: #3794ff;
    --error-fg: #f44;
    --focus-border: #007acc;
    --widget-border: rgba(128, 128, 128, 0.3);
    --list-hover-bg: rgba(128, 128, 128, 0.08);
    --code-block-bg: rgba(128, 128, 128, 0.1);

    /* ── Input fields ── */
    --input-bg: #1e1e1e;
    --input-fg: #ccc;
    --input-border: #444;

    /* ── Buttons ── */
    --btn-primary-bg: #0e639c;
    --btn-primary-fg: #fff;
    --btn-primary-hover-bg: #1177bb;
    --btn-secondary-bg: #3a3d41;
    --btn-secondary-fg: #fff;
    --btn-secondary-hover-bg: #45494e;
    --btn-border: rgba(255, 255, 255, 0.06);

    /* ── Callout palette ── */
    --callout-trigger-bg: rgba(76, 206, 141, 0.07);
    --callout-trigger-label: #4ece8d;
    --callout-response-bg: rgba(82, 156, 237, 0.07);
    --callout-response-label: #6eaaef;
    --callout-decisions-bg: rgba(163, 122, 237, 0.07);
    --callout-decisions-label: #b494f0;
    --callout-todo-bg: rgba(255, 196, 54, 0.07);
    --callout-todo-dot: #e0ac2b;
    --callout-todo-label: #e0ac2b;
    --callout-detail-bg: rgba(255, 255, 255, 0.04);
    --callout-detail-label: rgba(255, 255, 255, 0.50);

    /* ── Surface / borders ── */
    --surface-hover: rgba(255, 255, 255, 0.035);
    --border-light: rgba(255, 255, 255, 0.06);
    --text-secondary: rgba(255, 255, 255, 0.45);
    --text-tertiary: rgba(255, 255, 255, 0.30);
    --prop-label: rgba(255, 255, 255, 0.40);
    --pill-bg: rgba(255, 255, 255, 0.08);
    --pill-text: rgba(255, 255, 255, 0.60);

    /* ── Stats ── */
    --stat-add: #4ece8d;
    --stat-del: #f47067;
    --stat-turns: #a78bfa;
    --stat-turns-bg: rgba(167, 139, 250, 0.10);

    /* ── Private zone ── */
    --private-zone-bg: rgba(76, 206, 141, 0.05);
    --private-zone-border: rgba(76, 206, 141, 0.2);

    /* ── Category pills ── */
    --cat-feature-bg: rgba(82, 156, 237, 0.10);
    --cat-feature-text: #6eaaef;
    --cat-bugfix-bg: rgba(244, 112, 103, 0.10);
    --cat-bugfix-text: #f47067;
    --cat-refactor-bg: rgba(163, 122, 237, 0.10);
    --cat-refactor-text: #b494f0;
    --cat-infra-bg: rgba(255, 255, 255, 0.06);
    --cat-infra-text: rgba(255, 255, 255, 0.50);
    --cat-docs-bg: rgba(76, 206, 141, 0.10);
    --cat-docs-text: #4ece8d;"""

    /** Light theme variable block (matches `body.vscode-light` values). */
    private fun buildLightVars(): String = """
    /* ── Core palette ── */
    --bg: #ffffff;
    --text-primary: #1e1e1e;
    --description-fg: #6e6e6e;
    --link-fg: #0066bf;
    --error-fg: #f44;
    --focus-border: #007acc;
    --widget-border: rgba(128, 128, 128, 0.3);
    --list-hover-bg: rgba(128, 128, 128, 0.08);
    --code-block-bg: rgba(128, 128, 128, 0.1);

    /* ── Input fields ── */
    --input-bg: #ffffff;
    --input-fg: #1e1e1e;
    --input-border: #cecece;

    /* ── Buttons ── */
    --btn-primary-bg: #007acc;
    --btn-primary-fg: #fff;
    --btn-primary-hover-bg: #0062a3;
    --btn-secondary-bg: #e8e8e8;
    --btn-secondary-fg: #444;
    --btn-secondary-hover-bg: #d6d6d6;
    --btn-border: rgba(0, 0, 0, 0.06);

    /* ── Callout palette ── */
    --callout-trigger-bg: rgba(68, 176, 124, 0.10);
    --callout-trigger-label: #1b6340;
    --callout-response-bg: rgba(68, 131, 207, 0.10);
    --callout-response-label: #1f5a91;
    --callout-decisions-bg: rgba(144, 101, 206, 0.10);
    --callout-decisions-label: #5c35a0;
    --callout-todo-bg: rgba(227, 171, 59, 0.10);
    --callout-todo-dot: #b17d1a;
    --callout-todo-label: #96680e;
    --callout-detail-bg: rgba(0, 0, 0, 0.04);
    --callout-detail-label: rgba(0, 0, 0, 0.50);

    /* ── Surface / borders ── */
    --surface-hover: rgba(0, 0, 0, 0.028);
    --border-light: rgba(0, 0, 0, 0.06);
    --text-secondary: rgba(0, 0, 0, 0.45);
    --text-tertiary: rgba(0, 0, 0, 0.32);
    --prop-label: rgba(0, 0, 0, 0.42);
    --pill-bg: rgba(0, 0, 0, 0.06);
    --pill-text: rgba(0, 0, 0, 0.55);

    /* ── Stats ── */
    --stat-add: #267f3f;
    --stat-del: #c0392b;
    --stat-turns: #6366f1;
    --stat-turns-bg: rgba(99, 102, 241, 0.08);

    /* ── Private zone ── */
    --private-zone-bg: rgba(34, 139, 34, 0.04);
    --private-zone-border: rgba(34, 139, 34, 0.2);

    /* ── Category pills ── */
    --cat-feature-bg: rgba(56, 132, 217, 0.10);
    --cat-feature-text: #2462a3;
    --cat-bugfix-bg: rgba(207, 68, 68, 0.10);
    --cat-bugfix-text: #a33030;
    --cat-refactor-bg: rgba(144, 101, 206, 0.10);
    --cat-refactor-text: #5c35a0;
    --cat-infra-bg: rgba(0, 0, 0, 0.05);
    --cat-infra-text: rgba(0, 0, 0, 0.50);
    --cat-docs-bg: rgba(68, 176, 124, 0.10);
    --cat-docs-text: #1b6340;"""
}
