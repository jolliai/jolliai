import { describe, expect, it, vi } from "vitest";

const { TreeItem, ThemeIcon } = vi.hoisted(() => {
	class TreeItem {
		label: unknown;
		collapsibleState: number;
		resourceUri?: { fsPath: string };
		description?: string;
		contextValue?: string;
		tooltip?: unknown;
		command?: unknown;
		iconPath?: unknown;

		constructor(label: unknown, collapsibleState = 0) {
			this.label = label;
			this.collapsibleState = collapsibleState;
		}
	}

	class ThemeIcon {
		id: string;
		color?: { id?: string; _id?: string };
		constructor(id: string, color?: { id?: string; _id?: string }) {
			this.id = id;
			this.color = color;
		}
	}

	return { TreeItem, ThemeIcon };
});

vi.mock("vscode", () => ({
	TreeItem,
	ThemeIcon,
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
}));

import { treeItemToSerialized } from "./SidebarSerialize.js";

describe("treeItemToSerialized", () => {
	it("default behavior unchanged for items without gitStatus or isSelected hints", () => {
		const item = new TreeItem("hello");
		item.contextValue = "plan";
		const out = treeItemToSerialized(item as never);
		expect(out.label).toBe("hello");
		expect((out as { gitStatus?: string }).gitStatus).toBeUndefined();
		expect((out as { isSelected?: boolean }).isSelected).toBeUndefined();
	});

	// VSCode tree providers idiomatically set `this.command.arguments = [this]`
	// so VSCode delivers the TreeItem instance to the command handler. That
	// pattern is fine for native tree views but fatal for the sidebar webview:
	// the message goes through JSON serialization, and `[this]` creates a
	// circular reference (`item.command.arguments[0] === item`). JSON.stringify
	// throws "Converting circular structure to JSON" → postMessage silently
	// drops the entire commitsData payload → panel renders the empty-state.
	// Strip command.arguments here so the serialized payload stays JSON-safe.
	// The webview never reads command.arguments anyway: it builds its own args
	// from data-id attributes on click (see SidebarScriptBuilder click delegation).
	it("does not propagate circular command.arguments containing the item itself", () => {
		const item = new TreeItem("hello") as unknown as Parameters<
			typeof treeItemToSerialized
		>[0];
		item.command = {
			command: "jollimemory.editPlan",
			title: "Edit Plan",
			arguments: [item],
		};
		const out = treeItemToSerialized(item as never);
		// JSON.stringify must not throw — the whole point of this serialization.
		expect(() => JSON.stringify(out)).not.toThrow();
		expect(out.command?.command).toBe("jollimemory.editPlan");
		expect(out.command?.args).toBeUndefined();
	});

	// label can be a TreeItemLabel object ({ label, highlights }). The serializer
	// must dig out the inner string rather than coercing the whole object.
	it("extracts the inner string from a TreeItemLabel object", () => {
		const item = new TreeItem({ label: "from-object" });
		const out = treeItemToSerialized(item as never);
		expect(out.label).toBe("from-object");
	});

	// Defensive fallback when the label object has no `.label` field.
	it("falls back to empty string when the label object has no inner label", () => {
		const item = new TreeItem({});
		const out = treeItemToSerialized(item as never);
		expect(out.label).toBe("");
	});

	it("maps Collapsed and Expanded collapsibleState values", () => {
		const collapsed = new TreeItem("c", 1);
		const expanded = new TreeItem("e", 2);
		expect(treeItemToSerialized(collapsed as never).collapsibleState).toBe(
			"collapsed",
		);
		expect(treeItemToSerialized(expanded as never).collapsibleState).toBe(
			"expanded",
		);
	});

	// Non-ThemeIcon iconPath (e.g. URI or {light, dark} object) → no icon key/color.
	it("returns no icon info when iconPath is not a ThemeIcon", () => {
		const item = new TreeItem("x");
		item.iconPath = { fsPath: "/foo/icon.svg" };
		const out = treeItemToSerialized(item as never);
		expect(out.iconKey).toBeUndefined();
		expect(out.iconColor).toBeUndefined();
	});

	it("preserves iconKey and iconColor from a ThemeIcon (public id)", () => {
		const item = new TreeItem("x");
		item.iconPath = new ThemeIcon("file", { id: "charts.green" });
		const out = treeItemToSerialized(item as never);
		expect(out.iconKey).toBe("file");
		expect(out.iconColor).toBe("charts.green");
	});

	// Some VSCode runtimes keep the color id only in `_id` — the helper must
	// fall back to that private field rather than dropping the color.
	it("falls back to _id when ThemeIcon color exposes only the private id", () => {
		const item = new TreeItem("x");
		item.iconPath = new ThemeIcon("warning", { _id: "charts.red" });
		const out = treeItemToSerialized(item as never);
		expect(out.iconColor).toBe("charts.red");
	});

	it("returns iconColor undefined when ThemeIcon has no color", () => {
		const item = new TreeItem("x");
		item.iconPath = new ThemeIcon("info");
		const out = treeItemToSerialized(item as never);
		expect(out.iconKey).toBe("info");
		expect(out.iconColor).toBeUndefined();
	});

	// MarkdownString-like tooltips have a `.value` field; extractTooltip must
	// pull the string out instead of dropping it.
	it("extracts tooltip text from a MarkdownString-like object", () => {
		const item = new TreeItem("x");
		item.tooltip = { value: "MD tooltip" };
		const out = treeItemToSerialized(item as never);
		expect(out.tooltip).toBe("MD tooltip");
	});

	it("returns undefined tooltip for unknown tooltip shapes", () => {
		const item = new TreeItem("x");
		item.tooltip = { value: 42 }; // value is not a string
		const out = treeItemToSerialized(item as never);
		expect(out.tooltip).toBeUndefined();
	});

	it("preserves a plain-string tooltip", () => {
		const item = new TreeItem("x");
		item.tooltip = "plain";
		const out = treeItemToSerialized(item as never);
		expect(out.tooltip).toBe("plain");
	});

	// Non-string description must be normalized to undefined.
	it("drops non-string description", () => {
		const item = new TreeItem("x");
		item.description = { something: "else" } as unknown as string;
		const out = treeItemToSerialized(item as never);
		expect(out.description).toBeUndefined();
	});

	it("uses idHint when provided in place of label:description", () => {
		const item = new TreeItem("hello");
		item.description = "world";
		const out = treeItemToSerialized(item as never, "explicit-id");
		expect(out.id).toBe("explicit-id");
	});

	it("falls back to label:description when no idHint is supplied", () => {
		const item = new TreeItem("hello");
		item.description = "world";
		const out = treeItemToSerialized(item as never);
		expect(out.id).toBe("hello:world");
	});
});
