/**
 * NextMemoryPreviewPanel
 *
 * Editable pop-out previewing what the next Commit Memory will capture, at
 * parity with the committed-memory detail panel (meta strip, ship bar, Summary,
 * E2E, the three grouped sections, Private Transcripts) — but the sections that
 * only exist after a commit (Summary text, PR, Jolli share, E2E guide) render as
 * placeholders, and the Conversations / Context / Files rows are editable: an
 * include checkbox per row routes through the SAME exclusion path the sidebar
 * checkboxes use (the `onExclude` callback the provider wires to its apply*
 * deps), so the sidebar's Working Memory card stays in sync. The Commit Memory
 * button runs the existing jollimemory.commitAI command and closes the panel.
 *
 * Singleton: re-opening reveals/refreshes the existing panel with fresh data.
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export type PreviewExclude =
	| { readonly kind: "file"; readonly relPath: string; readonly selected: boolean }
	| { readonly kind: "conversation"; readonly source: string; readonly sessionId: string; readonly selected: boolean }
	| { readonly kind: "context"; readonly contextValue: string; readonly id: string; readonly selected: boolean };

export interface NextMemoryPreviewData {
	readonly files: ReadonlyArray<{ readonly label: string; readonly relPath: string }>;
	readonly conversations: ReadonlyArray<{
		readonly title: string;
		readonly source: string;
		readonly sessionId: string;
	}>;
	readonly context: ReadonlyArray<{
		readonly label: string;
		readonly contextValue: string;
		readonly id: string;
	}>;
	/** Toggle an item's inclusion — routed by the provider to its apply* deps. */
	readonly onExclude: (e: PreviewExclude) => void;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Short source label for the conversation badge (mirrors the sidebar). */
function sourceLabel(source: string): string {
	switch (source) {
		case "claude":
			return "Claude";
		case "codex":
			return "Codex";
		case "cursor":
			return "Cursor";
		case "gemini":
			return "Gemini";
		case "opencode":
			return "OpenCode";
		case "copilot":
			return "Copilot";
		case "copilot-chat":
			return "Copilot Chat";
		default:
			return source || "AI";
	}
}

/** Single-letter context tag (Plan / Note / reference Link). */
function contextTag(contextValue: string): string {
	if (contextValue === "note") return "N";
	if (contextValue === "reference") return "L";
	return "P";
}

export class NextMemoryPreviewPanel {
	private static current: NextMemoryPreviewPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private onExclude: (e: PreviewExclude) => void;

	private constructor(data: NextMemoryPreviewData) {
		this.onExclude = data.onExclude;
		this.panel = vscode.window.createWebviewPanel(
			"jollimemory.nextMemoryPreview",
			"Preview Memory",
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this.panel.webview.html = NextMemoryPreviewPanel.buildHtml(this.panel.webview.cspSource, data);
		this.panel.webview.onDidReceiveMessage((raw) => this.handleMessage(raw));
		this.panel.onDidDispose(() => {
			NextMemoryPreviewPanel.current = undefined;
		});
	}

	static show(data: NextMemoryPreviewData): void {
		if (NextMemoryPreviewPanel.current) {
			NextMemoryPreviewPanel.current.onExclude = data.onExclude;
			NextMemoryPreviewPanel.current.panel.webview.html = NextMemoryPreviewPanel.buildHtml(
				NextMemoryPreviewPanel.current.panel.webview.cspSource,
				data,
			);
			NextMemoryPreviewPanel.current.panel.reveal(vscode.ViewColumn.Active);
			return;
		}
		NextMemoryPreviewPanel.current = new NextMemoryPreviewPanel(data);
	}

	/** Trust boundary: the webview posts {type:'exclude', ...} or {type:'commit'}. */
	private handleMessage(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		const m = raw as Record<string, unknown>;
		if (m.type === "commit") {
			void vscode.commands.executeCommand("jollimemory.commitAI");
			// Don't auto-close — the summary is generated asynchronously by the
			// queue worker, so flip to a confirmation state instead. (Auto-opening
			// the generated memory once it's ready is future work.)
			this.panel.webview.html = NextMemoryPreviewPanel.buildCommittedHtml(this.panel.webview.cspSource);
			return;
		}
		if (m.type === "close") {
			this.panel.dispose();
			return;
		}
		if (m.type !== "exclude") return;
		const str = (v: unknown): string => (typeof v === "string" ? v : "");
		const selected = m.selected === true;
		if (m.kind === "file") {
			this.onExclude({ kind: "file", relPath: str(m.relPath), selected });
		} else if (m.kind === "conversation") {
			this.onExclude({ kind: "conversation", source: str(m.source), sessionId: str(m.sessionId), selected });
		} else if (m.kind === "context") {
			this.onExclude({ kind: "context", contextValue: str(m.contextValue), id: str(m.id), selected });
		}
	}

	/** Post-commit confirmation — the panel stays open instead of auto-closing. */
	private static buildCommittedHtml(cspSource: string): string {
		const nonce = randomBytes(16).toString("hex");
		const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp}
  <title>Memory committed</title>
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 40px 30px; max-width: 620px; }
    .check { font-size: 30px; color: var(--vscode-testing-iconPassed, #89d185); }
    h1 { font-size: 18px; font-weight: 650; margin: 12px 0 8px; }
    p { color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.6; margin: 0 0 18px; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 18px; border: none; border-radius: 7px; cursor: pointer; font-size: 12.5px; font-weight: 600; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  </style>
</head>
<body>
  <div class="check">✓</div>
  <h1>Memory committed</h1>
  <p>Your commit is in. The AI summary is being written in the background — once it's ready the memory appears under <strong>Committed Memories</strong> in the sidebar, where you can open it.</p>
  <button class="btn" id="closeBtn">Close</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('closeBtn').addEventListener('click', function () { vscode.postMessage({ type: 'close' }); });
  </script>
</body>
</html>`;
	}

	private static buildHtml(cspSource: string, data: NextMemoryPreviewData): string {
		const nonce = randomBytes(16).toString("hex");
		const fileCount = data.files.length;
		const convCount = data.conversations.length;
		const ctxCount = data.context.length;
		const empty = fileCount === 0 && convCount === 0 && ctxCount === 0;

		// data-* attributes carry the ids the host needs to route the exclusion.
		const rowEl = (label: string, lead: string, tail: string, attrs: Record<string, string>): string => {
			const dataAttrs = Object.entries(attrs)
				.map(([k, v]) => `data-${k}="${escapeHtml(v)}"`)
				.join(" ");
			return `<label class="item"><input type="checkbox" class="inc" checked ${dataAttrs} />${lead}<span class="lbl">${escapeHtml(label) || "(untitled)"}</span><span class="excl-tag">excluded</span>${tail}</label>`;
		};

		const convRows = data.conversations
			.map((c) =>
				rowEl(c.title, `<span class="badge">${escapeHtml(sourceLabel(c.source))}</span>`, "", {
					kind: "conversation",
					source: c.source,
					sessionid: c.sessionId,
				}),
			)
			.join("");
		const ctxRows = data.context
			.map((c) =>
				rowEl(c.label, `<span class="kbtag">${contextTag(c.contextValue)}</span>`, "", {
					kind: "context",
					contextvalue: c.contextValue,
					id: c.id,
				}),
			)
			.join("");
		const fileRows = data.files
			.map((f) => rowEl(f.label, "", "", { kind: "file", relpath: f.relPath }))
			.join("");

		const panel = (title: string, count: string, rows: string): string =>
			!rows
				? ""
				: `<div class="panel"><div class="panel-header"><span class="panel-title">${title}</span><span class="count">${count}</span></div>${rows}</div>`;

		const groups = empty
			? `<div class="panel"><p class="zero">Nothing selected yet — check files, conversations or context in the sidebar.</p></div>`
			: `${panel("Conversations", String(convCount), convRows)}${panel("Context", String(ctxCount), ctxRows)}${panel("Files", String(fileCount), fileRows)}`;

		const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp}
  <title>Preview Memory</title>
  <style nonce="${nonce}">
    :root { --bd: var(--vscode-widget-border, rgba(128,128,128,0.25)); --muted: var(--vscode-descriptionForeground); }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 22px 30px 40px; max-width: 820px; }
    h1 { font-size: 18px; font-weight: 650; margin: 0 0 8px; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 9px; font-size: 11.5px; color: var(--muted); margin-bottom: 8px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; font-weight: 650; letter-spacing: 0.02em; padding: 2px 9px; border-radius: 11px; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); color: var(--muted); }
    .chip .led { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
    .intro { color: var(--muted); font-size: 12.5px; line-height: 1.5; margin: 0 0 18px; }
    .ship-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .ship-card { border: 1px solid var(--bd); border-radius: 11px; padding: 13px 15px; }
    .ship-head { display: flex; align-items: center; gap: 8px; font-weight: 650; font-size: 12.5px; margin-bottom: 6px; }
    .ship-head .chip { margin-left: auto; }
    .ship-sub { font-size: 11.5px; color: var(--muted); line-height: 1.45; }
    .panel { border: 1px solid var(--bd); border-radius: 12px; padding: 14px 16px; margin-bottom: 16px; }
    .panel-header { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; margin-bottom: 8px; border-bottom: 1px solid var(--bd); }
    .panel-title { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); }
    .panel-header .count { margin-left: auto; font-size: 11px; color: var(--muted); }
    .recap { font-size: 12.5px; line-height: 1.55; color: var(--muted); }
    .item { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 4px 0; cursor: pointer; }
    .item input { accent-color: var(--vscode-focusBorder); flex-shrink: 0; }
    .item .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item.excluded .lbl { text-decoration: line-through; opacity: 0.55; }
    .badge { font-size: 10px; border: 1px solid var(--muted); border-radius: 4px; padding: 0 6px; line-height: 16px; flex-shrink: 0; }
    .kbtag { width: 15px; height: 15px; border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 700; color: #fff; background: var(--vscode-charts-blue, #2f7adc); flex-shrink: 0; }
    .excl-tag { font-size: 9px; font-weight: 700; letter-spacing: 0.05em; color: var(--muted); border: 1px solid var(--bd); border-radius: 4px; padding: 0 5px; flex-shrink: 0; }
    .item:not(.excluded) .excl-tag { display: none; }
    .drawer { border: 1px dashed var(--bd); border-radius: 10px; padding: 11px 14px; display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--muted); margin-bottom: 16px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 18px; border: none; border-radius: 7px; cursor: pointer; font-size: 12.5px; font-weight: 600; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
    .btn.block { width: 100%; }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .note { color: var(--muted); font-size: 12px; margin-top: 10px; line-height: 1.5; }
    .zero { color: var(--muted); margin: 0; }
  </style>
</head>
<body>
  <h1>Preview Memory</h1>
  <div class="meta">
    <span class="chip"><span class="led"></span>NOT COMMITTED</span>
    <span>${fileCount} file${fileCount === 1 ? "" : "s"} · ${convCount} conversation${convCount === 1 ? "" : "s"} · ${ctxCount} context</span>
  </div>
  <p class="intro">This is what your next <strong>Commit Memory</strong> will capture — same shape as a committed memory, but editable. Uncheck anything you don't want in this memory.</p>

  <div class="ship-bar">
    <div class="ship-card">
      <div class="ship-head"><span>⇧</span><span>Pull Request</span><span class="chip">AFTER COMMIT</span></div>
      <div class="ship-sub">No PR yet — create one once this memory is committed.</div>
    </div>
    <div class="ship-card">
      <div class="ship-head"><span>⇅</span><span>Jolli</span><span class="chip"><span class="led"></span>LOCAL</span></div>
      <div class="ship-sub">Not shared. Share to your Jolli Space after commit.</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-header"><span class="panel-title">Summary</span><span class="count">generated at commit</span></div>
    <div class="recap">The AI writes the recap and topic decisions from your staged diff and the attached conversations when you commit. This is a placeholder until then.</div>
  </div>

  <div class="panel">
    <div class="panel-header"><span class="panel-title">E2E Test Guide</span><span class="count">after commit</span></div>
    <div class="recap">Reviewer test scenarios are generated from the memory once it exists.</div>
  </div>

  ${groups}

  <div class="drawer">🔒 Private Transcripts (${convCount}) — full logs of the attached conversations, stored in your repo, never in shared exports.</div>

  <button class="btn block" id="commitBtn"${empty ? " disabled" : ""}>✦ Commit Memory</button>
  <p class="note">Editable until commit: uncheck here to leave items out of this memory — the same include/exclude state the sidebar's Working Memory card uses.</p>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('change', function (e) {
      const cb = e.target;
      if (!cb || !cb.classList || !cb.classList.contains('inc')) return;
      const kind = cb.getAttribute('data-kind');
      const msg = { type: 'exclude', kind: kind, selected: !!cb.checked };
      if (kind === 'file') msg.relPath = cb.getAttribute('data-relpath');
      else if (kind === 'conversation') { msg.source = cb.getAttribute('data-source'); msg.sessionId = cb.getAttribute('data-sessionid'); }
      else if (kind === 'context') { msg.contextValue = cb.getAttribute('data-contextvalue'); msg.id = cb.getAttribute('data-id'); }
      vscode.postMessage(msg);
      const label = cb.closest('.item');
      if (label) label.classList.toggle('excluded', !cb.checked);
    });
    const commitBtn = document.getElementById('commitBtn');
    if (commitBtn) commitBtn.addEventListener('click', function () { vscode.postMessage({ type: 'commit' }); });
  </script>
</body>
</html>`;
	}
}
