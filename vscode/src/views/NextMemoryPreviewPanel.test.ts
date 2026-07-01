import { describe, expect, it, vi } from "vitest";

// `vscode` is not available in the test environment — provide a minimal stub
// so the module-level `import * as vscode from "vscode"` in NextMemoryPreviewPanel
// does not throw.
const { createWebviewPanel } = vi.hoisted(() => {
	const createWebviewPanel = vi.fn(() => {
		const panel = {
			webview: { html: "" },
			reveal: vi.fn(),
			onDispose: () => {},
			onDidDispose(cb: () => void) {
				panel.onDispose = cb;
				return { dispose() {} };
			},
		};
		return panel;
	});
	return { createWebviewPanel };
});

vi.mock("vscode", () => ({
	ViewColumn: { Active: -1 },
	window: {
		createWebviewPanel,
	},
}));

import { buildNextMemoryHtml } from "./NextMemoryPreviewPanel";

describe("buildNextMemoryHtml", () => {
	it("renders the three selected groups with counts", () => {
		const html = buildNextMemoryHtml({
			conversations: [{ title: "Sidebar redesign" }],
			context: [{ title: "redesign plan" }],
			files: [{ path: "SidebarHtmlBuilder.ts" }],
		});
		expect(html).toContain("Conversations");
		expect(html).toContain("Sidebar redesign");
		expect(html).toContain("Context");
		expect(html).toContain("Files");
		expect(html).toContain("SidebarHtmlBuilder.ts");
	});
	it("shows an empty state when nothing is selected", () => {
		const html = buildNextMemoryHtml({ conversations: [], context: [], files: [] });
		expect(html).toContain("Nothing selected");
	});

	it("includes a strict CSP meta tag (scripts disabled)", () => {
		const html = buildNextMemoryHtml({ conversations: [], context: [], files: [] });
		expect(html).toContain("Content-Security-Policy");
		expect(html).toContain("default-src 'none'");
		expect(html).toContain("script-src 'none'");
	});

	it("defines a rule for the .empty class used by the empty state", () => {
		const html = buildNextMemoryHtml({ conversations: [], context: [], files: [] });
		expect(html).toMatch(/\.empty\s*\{/);
	});
});
