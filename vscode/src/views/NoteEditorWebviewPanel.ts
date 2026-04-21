/**
 * NoteEditorWebviewPanel
 *
 * Opens a webview for creating a new Text Snippet note.
 * Singleton pattern — only one note editor can be open at a time.
 *
 * Flow:
 * 1. User clicks "Add Text Snippet" from the unified "+" dropdown
 * 2. WebView shows Title (optional) + Content textarea + Save button
 * 3. On save, content is written to a .md file in the notes directory
 * 4. The file opens in the editor for further editing
 * 5. Panel closes after successful save
 */

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { log } from "../util/Logger.js";
import { buildNoteEditorHtml } from "./NoteEditorHtmlBuilder.js";

/** Messages sent from the webview to the extension host. */
type NoteEditorMessage = {
	command: "saveNote";
	title: string;
	content: string;
};

/** Callback invoked after a note is successfully saved. */
type OnSavedCallback = () => void;

export class NoteEditorWebviewPanel {
	private static currentPanel: NoteEditorWebviewPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly bridge: JolliMemoryBridge;
	private onSavedCallback: OnSavedCallback | undefined;

	private constructor(
		extensionUri: vscode.Uri,
		bridge: JolliMemoryBridge,
		onSaved?: OnSavedCallback,
	) {
		this.bridge = bridge;
		this.onSavedCallback = onSaved;
		this.panel = vscode.window.createWebviewPanel(
			"jollimemory.noteEditor",
			"Add Text Snippet",
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
			},
		);

		const nonce = randomBytes(16).toString("hex");
		this.panel.webview.html = buildNoteEditorHtml(nonce);

		this.panel.onDidDispose(() => {
			NoteEditorWebviewPanel.currentPanel = undefined;
		});

		this.panel.webview.onDidReceiveMessage((message: NoteEditorMessage) => {
			this.handleMessage(message);
		});
	}

	/** Opens the Note Editor panel (creates or reveals existing). */
	static show(
		extensionUri: vscode.Uri,
		bridge: JolliMemoryBridge,
		onSaved?: OnSavedCallback,
	): void {
		if (NoteEditorWebviewPanel.currentPanel) {
			if (onSaved) {
				NoteEditorWebviewPanel.currentPanel.onSavedCallback = onSaved;
			}
			NoteEditorWebviewPanel.currentPanel.panel.reveal(
				vscode.ViewColumn.Active,
			);
			return;
		}
		NoteEditorWebviewPanel.currentPanel = new NoteEditorWebviewPanel(
			extensionUri,
			bridge,
			onSaved,
		);
	}

	/** Disposes the current panel (used in tests for singleton reset). */
	static dispose(): void {
		if (NoteEditorWebviewPanel.currentPanel) {
			NoteEditorWebviewPanel.currentPanel.panel.dispose();
			NoteEditorWebviewPanel.currentPanel = undefined;
		}
	}

	private handleMessage(message: NoteEditorMessage): void {
		if (message.command === "saveNote") {
			this.handleSaveNote(message.title, message.content).catch(
				(err: unknown) => {
					log.error("NoteEditorPanel", `Save failed: ${err}`);
					this.postError("Failed to save note");
				},
			);
		}
	}

	private async handleSaveNote(title: string, content: string): Promise<void> {
		const noteInfo = await this.bridge.saveNote(
			undefined,
			title,
			content,
			"snippet",
		);
		log.info("NoteEditorPanel", `Created snippet note: ${noteInfo.id}`);

		this.panel.webview.postMessage({ command: "noteSaved" });
		this.onSavedCallback?.();

		// Open the saved file for editing and close the webview
		if (noteInfo.filePath) {
			const doc = await vscode.workspace.openTextDocument(noteInfo.filePath);
			await vscode.window.showTextDocument(doc);
		}
		this.panel.dispose();
	}

	private postError(message: string): void {
		this.panel.webview.postMessage({ command: "noteError", message });
	}
}
