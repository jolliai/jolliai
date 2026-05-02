/**
 * SidebarSerialize
 *
 * Shared helper to project a vscode.TreeItem into the SerializedTreeItem
 * shape used by the sidebar webview. Each provider's serialize() walks its
 * getChildren() output and maps each item through `treeItemToSerialized`.
 *
 * `idHint` lets callers supply a stronger uniqueness key than the default
 * (label + ":" + description). FilesTreeProvider uses fsPath; HistoryTreeProvider
 * uses commit hash.
 */

import * as vscode from "vscode";
import type { SerializedTreeItem } from "./SidebarMessages.js";

export function treeItemToSerialized(
	item: vscode.TreeItem,
	idHint?: string,
): SerializedTreeItem {
	const labelText =
		typeof item.label === "string"
			? item.label
			: String(item.label?.label ?? "");
	const description =
		typeof item.description === "string" ? item.description : undefined;
	const id = idHint ?? labelText + (description ? `:${description}` : "");
	const icon = extractIcon(item.iconPath);
	let collapsibleState: SerializedTreeItem["collapsibleState"] = "none";
	if (item.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed)
		collapsibleState = "collapsed";
	else if (item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded)
		collapsibleState = "expanded";
	return {
		id,
		label: labelText,
		description,
		iconKey: icon.iconKey,
		iconColor: icon.iconColor,
		tooltip: extractTooltip(item.tooltip),
		contextValue: item.contextValue,
		// Drop command.arguments: VSCode tree providers idiomatically set
		// `command.arguments = [this]` so the native tree view passes the
		// TreeItem instance to the command handler. That creates a circular
		// reference (item.command.arguments[0] === item) which crashes the
		// JSON.stringify inside webview.postMessage and silently drops the
		// whole payload — the panel then renders its empty-state. The
		// webview never reads command.arguments anyway: it builds its own
		// args from data-id attributes (see SidebarScriptBuilder click
		// delegation).
		command: item.command ? { command: item.command.command } : undefined,
		collapsibleState,
	};
}

/**
 * Extracts a plain string tooltip from a TreeItem tooltip value.
 *
 * In some VSCode runtimes, even when the provider assigns a plain string to
 * `this.tooltip`, the underlying `vscode.TreeItem` stores it as a
 * `MarkdownString` instance (which has a `.value` property). The plain
 * `typeof === "string"` check would silently drop such tooltips, leaving the
 * webview with no `title` attribute and therefore no native tooltip.
 */
function extractTooltip(t: vscode.TreeItem["tooltip"]): string | undefined {
	if (typeof t === "string") return t;
	if (
		t &&
		typeof t === "object" &&
		"value" in t &&
		typeof (t as { value: unknown }).value === "string"
	) {
		return (t as { value: string }).value;
	}
	return undefined;
}

function extractIcon(iconPath: vscode.TreeItem["iconPath"]): {
	iconKey?: string;
	iconColor?: string;
} {
	if (!iconPath) return {};
	if (iconPath instanceof vscode.ThemeIcon) {
		const color = iconPath.color as { id?: string; _id?: string } | undefined;
		// Try public `id` first (vscode.d.ts contract), fall back to `_id`
		// (some VSCode runtimes stash the token id as a private field).
		return {
			iconKey: iconPath.id,
			iconColor: color ? (color.id ?? color._id) : undefined,
		};
	}
	return {};
}
