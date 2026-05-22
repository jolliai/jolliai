import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { errMsg } from "../../../cli/src/Logger.js";
import type {
	TranscriptEntry,
	TranscriptSource,
} from "../../../cli/src/Types.js";
import { log } from "../util/Logger.js";
import { buildConversationDetailsHtml } from "./ConversationDetailsHtmlBuilder.js";

export interface ShowOptions {
	readonly extensionUri: vscode.Uri;
	readonly sessionId: string;
	readonly source: TranscriptSource;
	readonly transcriptPath: string;
	/**
	 * The label string from the CONVERSATIONS row, already fallback-resolved
	 * on the webview side (`item.title || '(untitled)'`). Used verbatim for
	 * the VS Code tab title and the in-panel header so the panel cannot drift
	 * from the row.
	 */
	readonly title: string;
	/**
	 * Project root for resolving overlay storage at
	 * `<projectDir>/.jolli/jollimemory/conversation-edits/`. When undefined
	 * (no workspace open) the panel is forced into read-only mode: deletions
	 * and edits cannot be persisted because there is nowhere to put them.
	 */
	readonly projectDir?: string;
	/**
	 * Invoked after the panel persists a save that leaves the merged transcript
	 * empty (Mark All as Deleted, or piecewise deletion of every entry). The
	 * panel writes to HiddenConversationsStore on its own; the callback is
	 * purely so the sidebar can re-pull CONVERSATIONS and drop the row. The
	 * panel disposes itself before invoking the callback.
	 */
	readonly onSessionHidden?: (sessionId: string) => void;
	/**
	 * Invoked after any successful persisted edit/delete save so list surfaces
	 * (like the sidebar CONVERSATIONS row) can refresh badges/counts.
	 */
	readonly onSessionChanged?: (sessionId: string) => void;
}

/**
 * Incoming saveOverrides message from the webview. The panel sends
 * display-list indices (positions in the most-recently-rendered list).
 * The host re-derives the source-entry identity from those indices to build
 * identity-based overlay rules — see `handleSaveOverrides` below.
 */
interface SaveOverridesPayload {
	readonly deletedIndices: ReadonlyArray<number>;
	readonly edits: Readonly<Record<string, string>>;
}

/**
 * Runtime type-guard for `saveOverrides` messages from the webview. The
 * trust-boundary pattern matches `SidebarWebviewProvider.isOutbound` —
 * even though the webview is normally well-behaved, a corrupted message
 * (deletedIndices: null, edits: "bad") would otherwise reach
 * `Object.entries(payload.edits)` or `for (const idx of payload.deletedIndices)`
 * and throw at the file-system layer with no clean recovery path.
 *
 * Exported for direct unit testing: the only production call site
 * (`handleMessage`) pre-filters with `!raw || typeof raw !== "object"`,
 * which makes the inner non-object guard structurally unreachable
 * end-to-end. Direct calls let the guard's full contract — including the
 * trust-boundary checks the production filter currently shadows — stay
 * pinned by tests against future caller refactors.
 */
export function isSaveOverridesPayload(
	value: unknown,
): value is SaveOverridesPayload {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!Array.isArray(v.deletedIndices)) return false;
	for (const idx of v.deletedIndices) {
		if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0)
			return false;
	}
	if (!v.edits || typeof v.edits !== "object" || Array.isArray(v.edits))
		return false;
	for (const [k, val] of Object.entries(v.edits as Record<string, unknown>)) {
		if (typeof k !== "string" || typeof val !== "string") return false;
	}
	return true;
}

/**
 * Wire shape sent to the webview. `displayIndex` is the position in the
 * post-overlay list used as the key for `SaveOverridesPayload`.
 */
interface DisplayEntry extends TranscriptEntry {
	readonly displayIndex: number;
}

export class ConversationDetailsPanel {
	// Keyed by `${source}:${sessionId}` — sessionId alone is not unique
	// across sources (Claude's UUIDs and Cursor's hashes share a namespace
	// in this Map otherwise). Same separator HiddenConversationsStore uses,
	// and TranscriptSource values cannot contain a colon, so the key is
	// unambiguous.
	private static readonly panels = new Map<string, ConversationDetailsPanel>();
	private readonly panel: vscode.WebviewPanel;
	private readonly sessionId: string;
	private readonly source: TranscriptSource;
	private readonly transcriptPath: string;
	private readonly projectDir: string | undefined;
	private readonly onSessionHidden: ((sessionId: string) => void) | undefined;
	private readonly onSessionChanged: ((sessionId: string) => void) | undefined;

	private constructor(opts: ShowOptions) {
		this.sessionId = opts.sessionId;
		this.source = opts.source;
		this.transcriptPath = opts.transcriptPath;
		this.projectDir = opts.projectDir;
		this.onSessionHidden = opts.onSessionHidden;
		this.onSessionChanged = opts.onSessionChanged;
		this.panel = vscode.window.createWebviewPanel(
			"jollimemory.conversationDetails",
			opts.title,
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [opts.extensionUri],
				retainContextWhenHidden: true,
			},
		);
		const nonce = randomBytes(16).toString("hex");
		const codiconCssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(
				opts.extensionUri,
				"assets",
				"codicons",
				"codicon.css",
			),
		);
		this.panel.webview.html = buildConversationDetailsHtml({
			nonce,
			sessionId: opts.sessionId,
			source: opts.source,
			transcriptPath: opts.transcriptPath,
			title: opts.title,
			readOnly: this.projectDir === undefined,
			cspSource: this.panel.webview.cspSource,
			codiconCssUri: codiconCssUri.toString(),
		});
		this.panel.onDidDispose(() => {
			ConversationDetailsPanel.panels.delete(
				panelKey(this.source, this.sessionId),
			);
		});
		// Return the promise so tests can `await` the handler. VS Code itself
		// ignores the return value; production behavior is identical.
		this.panel.webview.onDidReceiveMessage((raw) => this.handleMessage(raw));
	}

	static show(opts: ShowOptions): void {
		const key = panelKey(opts.source, opts.sessionId);
		const existing = ConversationDetailsPanel.panels.get(key);
		if (existing) {
			// Refresh tab title in case the row's title was resolved later
			// (e.g. Claude's ai-title line was written after the first click).
			// The in-panel <span class="title"> stays at first-render value;
			// that is intentional for MVP and matches All Conversations.
			existing.panel.title = opts.title;
			existing.panel.reveal(vscode.ViewColumn.Active);
			// retainContextWhenHidden keeps the webview's DOM alive across
			// hide/show, but the script only pulled the transcript once on
			// first load — so a stale view would persist while the sidebar
			// polling advertises fresh unread content. Nudge the webview to
			// re-fetch. The webview is responsible for skipping the refresh
			// when the user has pending edits/deletes so unsaved work is not
			// silently discarded.
			void existing.panel.webview.postMessage({ type: "panelReshown" });
			return;
		}
		const created = new ConversationDetailsPanel(opts);
		ConversationDetailsPanel.panels.set(key, created);
	}

	static disposeAll(): void {
		for (const p of ConversationDetailsPanel.panels.values()) {
			p.panel.dispose();
		}
		ConversationDetailsPanel.panels.clear();
	}

	private async handleMessage(raw: unknown): Promise<void> {
		if (!raw || typeof raw !== "object") return;
		const msg = raw as { type?: string };
		if (msg.type === "requestTranscript") {
			await this.sendTranscript();
			return;
		}
		if (msg.type === "saveOverrides") {
			if (!isSaveOverridesPayload(raw)) {
				void this.panel.webview.postMessage({
					type: "overridesSaveError",
					message: "Invalid save payload",
				});
				return;
			}
			await this.handleSaveOverrides(raw);
			return;
		}
	}

	/**
	 * Loads the cursor-trimmed transcript plus the saved overlay and returns
	 * two views of the same length and order:
	 *   - `displayed`  — what the user sees in the panel (deletes applied,
	 *                    edits applied).
	 *   - `rawByIndex` — the same entries but with deletes applied only
	 *                    (edits NOT applied). The Nth entry here is the
	 *                    original source row that produced the Nth entry of
	 *                    `displayed`, with its untouched content/timestamp.
	 *
	 * The base load is **cursor-aware** (`loadUnreadTranscript`) so the
	 * panel shows the same unread slice the active-conversations row already
	 * advertises. Turns previously consumed into a commit summary live
	 * before the cursor and are intentionally hidden — the user expects the
	 * detail view to match the row, not balloon back to the full session.
	 * The fallback when `projectDir` is missing (no workspace) is the full
	 * transcript, mirroring the list path.
	 *
	 * `rawByIndex` is what `handleSaveOverrides` derives identity tuples
	 * from. Using the displayed-and-edited view there would anchor the new
	 * rule to the previous edit's `newContent`, breaking subsequent edits
	 * for the same row (the rule would never match the raw source again).
	 */
	private async loadEntriesForView(): Promise<{
		readonly displayed: ReadonlyArray<TranscriptEntry>;
		readonly rawByIndex: ReadonlyArray<TranscriptEntry>;
		readonly isEdited: boolean;
	}> {
		const { loadUnreadTranscript } = await import(
			"../../../cli/src/core/TranscriptMessageCounter.js"
		);
		const { loadOverlay, applyOverlay, applyDeletes, hasOverlayChanges } = await import(
			"../../../cli/src/core/ConversationOverlayStore.js"
		);
		const raw = await loadUnreadTranscript(
			this.source,
			this.transcriptPath,
			this.projectDir,
		);
		// Without a project root the panel is read-only; skip the overlay
		// lookup entirely so a Save attempt later (it shouldn't happen — the
		// UI hides the button) cannot accidentally pick up some stale file.
		const overlay = this.projectDir
			? await loadOverlay({
					projectDir: this.projectDir,
					source: this.source,
					sessionId: this.sessionId,
				})
			: null;
		return {
			displayed: applyOverlay(raw, overlay),
			rawByIndex: applyDeletes(raw, overlay),
			isEdited: hasOverlayChanges(overlay),
		};
	}

	private async sendTranscript(): Promise<void> {
		const { displayed, isEdited } = await this.loadEntriesForView();
		const wireEntries: DisplayEntry[] = displayed.map((entry, displayIndex) => ({
			...entry,
			displayIndex,
		}));
		void this.panel.webview.postMessage({
			type: "transcriptLoaded",
			entries: wireEntries,
			isEdited,
		});
	}

	private async handleSaveOverrides(
		payload: SaveOverridesPayload,
	): Promise<void> {
		if (!this.projectDir) {
			// Defensive — the Save button is hidden in read-only mode, but if
			// the webview were spoofed into posting saveOverrides we still
			// must not silently succeed.
			void this.panel.webview.postMessage({
				type: "overridesSaveError",
				message: "No workspace open — conversation edits cannot be saved.",
			});
			return;
		}
		try {
			const { loadOverlay, mergeOverlay, saveOverlay } = await import(
				"../../../cli/src/core/ConversationOverlayStore.js"
			);
			// New identity tuples must anchor to the *raw* source content,
			// not to the post-edit view the user is looking at. `rawByIndex`
			// is positionally aligned with the displayed list (same deletes
			// applied, but without overlaying edits) so a displayIndex from
			// the client picks the original (role, content, timestamp) tuple
			// here. Deriving identity from the edited view would key the new
			// rule on the previous edit's newContent — the rule would never
			// match the raw source again and chained edits would silently
			// disappear after save+reload.
			const { rawByIndex } = await this.loadEntriesForView();
			const newDeletes: Array<{
				role: "human" | "assistant";
				content: string;
				timestamp?: string;
			}> = [];
			for (const idx of payload.deletedIndices) {
				const entry = rawByIndex[idx];
				if (!entry) continue; // race: source entry no longer in the merged view
				newDeletes.push(toIdentity(entry));
			}
			const newEdits: Array<{
				role: "human" | "assistant";
				content: string;
				timestamp?: string;
				newContent: string;
			}> = [];
			for (const [key, newContent] of Object.entries(payload.edits)) {
				const idx = Number.parseInt(key, 10);
				if (!Number.isInteger(idx)) continue;
				const entry = rawByIndex[idx];
				if (!entry) continue;
				newEdits.push({ ...toIdentity(entry), newContent });
			}
			const existing = await loadOverlay({
				projectDir: this.projectDir,
				source: this.source,
				sessionId: this.sessionId,
			});
			const merged = mergeOverlay(existing, {
				deletes: newDeletes,
				edits: newEdits,
			});
			await saveOverlay(
				{
					projectDir: this.projectDir,
					source: this.source,
					sessionId: this.sessionId,
				},
				merged,
			);
			void this.panel.webview.postMessage({ type: "overridesSaved" });
			// Re-fetch the merged view so the panel reflects the persisted
			// state and surfaces any new entries appended by the source app
			// since the last load.
			const afterView = await this.loadEntriesForView();
			void this.panel.webview.postMessage({
				type: "transcriptLoaded",
				entries: afterView.displayed.map((entry, displayIndex) => ({
					...entry,
					displayIndex,
				})),
				isEdited: afterView.isEdited,
			});

			// If the user emptied the merged transcript (Mark All as Deleted, or
			// piecewise deletion of every entry), persist a list-level hide and
			// dispose the panel — the row in CONVERSATIONS will disappear on the
			// next pushConversations() triggered by onSessionHidden.
			if (afterView.displayed.length === 0) {
				const { hideConversation } = await import(
					"../../../cli/src/core/HiddenConversationsStore.js"
				);
				await hideConversation(this.projectDir, this.source, this.sessionId);
				const cb = this.onSessionHidden;
				const changeCb = this.onSessionChanged;
				const sid = this.sessionId;
				this.panel.dispose();
				if (changeCb) changeCb(sid);
				if (cb) cb(sid);
			} else if (this.onSessionChanged) {
				this.onSessionChanged(this.sessionId);
			}
		} catch (err) {
			// User-visible banner via postMessage, plus an extension-log
			// trace so triage of "my edits don't persist" has somewhere to
			// look. The webview cannot show stack traces and the only other
			// signal a user can produce is "the save button didn't stick".
			const message = errMsg(err);
			log.error(
				"ConversationDetailsPanel",
				`handleSaveOverrides failed for ${this.source}/${this.sessionId}`,
				message,
			);
			void this.panel.webview.postMessage({
				type: "overridesSaveError",
				message,
			});
		}
	}
}

function toIdentity(entry: TranscriptEntry): {
	role: "human" | "assistant";
	content: string;
	timestamp?: string;
} {
	return {
		role: entry.role,
		content: entry.content,
		...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
	};
}

// The colon separator matches HiddenConversationsStore.hiddenKey and is
// safe because TranscriptSource values are a closed enum that never
// contain a colon.
function panelKey(source: TranscriptSource, sessionId: string): string {
	return `${source}:${sessionId}`;
}
