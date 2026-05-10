import type * as vscode from "vscode";
import type { FilesSnapshot } from "../stores/FilesStore.js";

/**
 * Computes the activity-bar badge value for the CHANGES panel.
 *
 * Mirrors `FilesTreeProvider.getChildren`'s gating: when the extension is
 * disabled or a Memory Bank migration is in flight the panel renders empty,
 * but the snapshot may still carry a pre-state `visibleCount`. Without the
 * gate the badge would show e.g. "8" while the panel below says "No changes."
 */
export function computeChangesBadge(
	snap: Pick<
		FilesSnapshot,
		"isEnabled" | "isMigrating" | "visibleCount" | "selectedFiles"
	>,
): vscode.WebviewView["badge"] {
	const visible = snap.isEnabled && !snap.isMigrating ? snap.visibleCount : 0;
	if (visible <= 0) return undefined;
	const selected = snap.selectedFiles.length;
	return {
		value: visible,
		tooltip: `${visible} changed file${visible !== 1 ? "s" : ""}, ${selected} selected`,
	};
}
