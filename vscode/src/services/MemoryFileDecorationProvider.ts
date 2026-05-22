import * as vscode from "vscode";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";

/**
 * Decorates Memory Bank `.md` files that have been edited on disk and now
 * diverge from the orphan-branch system view. VS Code calls
 * `provideFileDecoration` for every file URI shown in any file UI (the
 * Explorer, the Memory Bank sidebar tree, the quick-open list, etc.), so
 * registering this provider once at activate() time covers all surfaces.
 *
 * Divergence is detected by `bridge.isMemoryFileDivergedOnDisk(absPath)`,
 * which compares the on-disk md against the canonical hidden JSON. Non-`.md`
 * URIs short-circuit before touching the bridge to keep the file UI cheap.
 */
export class MemoryFileDecorationProvider
	implements vscode.FileDecorationProvider
{
	private readonly emitter = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[] | undefined
	>();
	readonly onDidChangeFileDecorations = this.emitter.event;

	constructor(private readonly bridge: JolliMemoryBridge) {}

	async provideFileDecoration(
		uri: vscode.Uri,
	): Promise<vscode.FileDecoration | undefined> {
		if (!uri.fsPath.toLowerCase().endsWith(".md")) return undefined;
		const diverged = await this.bridge.isMemoryFileDivergedOnDisk(uri.fsPath);
		if (!diverged) return undefined;
		return {
			badge: "✎",
			tooltip: "Edited on disk — system view unavailable",
			propagate: false,
		};
	}

	/**
	 * Notify VS Code that the decoration for a specific URI may have
	 * changed. Called by the revert command and by KbFoldersService when
	 * a manifest write completes.
	 */
	refreshUri(uri: vscode.Uri): void {
		this.emitter.fire(uri);
	}

	/**
	 * Notify VS Code that all decorations may have changed. Used when
	 * the bridge re-discovers repos (kbRoot list churns).
	 */
	refreshAll(): void {
		this.emitter.fire(undefined);
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
