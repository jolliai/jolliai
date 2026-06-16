import { afterEach, describe, expect, it, vi } from "vitest";

interface MockPanel {
	webview: {
		html: string;
		onDidReceiveMessage: ReturnType<typeof vi.fn>;
		cspSource: string;
	};
	onDidDispose: ReturnType<typeof vi.fn>;
	reveal: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	disposed: boolean;
	title: string;
	__disposeCb?: () => void;
}

interface MockVsCode {
	ViewColumn: { Active: number };
	window: { createWebviewPanel: ReturnType<typeof vi.fn> };
	commands: { executeCommand: ReturnType<typeof vi.fn> };
	__panels: MockPanel[];
	__exec: ReturnType<typeof vi.fn>;
}

vi.mock("vscode", () => {
	const panels: MockPanel[] = [];
	const createWebviewPanel = vi.fn((_type: string, title: string) => {
		const p: MockPanel = {
			webview: {
				html: "",
				onDidReceiveMessage: vi.fn(),
				cspSource: "vscode-webview://test",
			},
			// Capture the dispose callback so dispose() clears the singleton,
			// matching the real onDidDispose wiring.
			onDidDispose: vi.fn((cb: () => void) => {
				p.__disposeCb = cb;
			}),
			reveal: vi.fn(),
			dispose: vi.fn(() => {
				p.disposed = true;
				p.__disposeCb?.();
			}),
			disposed: false,
			title,
		};
		panels.push(p);
		return p;
	});
	const executeCommand = vi.fn();
	return {
		ViewColumn: { Active: 1 },
		window: { createWebviewPanel },
		commands: { executeCommand },
		__panels: panels,
		__exec: executeCommand,
	};
});

import * as vscode from "vscode";
import { NextMemoryPreviewPanel, type PreviewExclude } from "./NextMemoryPreviewPanel.js";

const mock = vscode as unknown as MockVsCode;

function captureHandler(): (raw: unknown) => void {
	const panel = mock.__panels[mock.__panels.length - 1];
	const h = panel.webview.onDidReceiveMessage.mock.calls[0]?.[0] as
		| ((raw: unknown) => void)
		| undefined;
	if (!h) throw new Error("no handler");
	return h;
}

const populated = (onExclude = vi.fn()) => ({
	files: [{ label: "Foo.ts", relPath: "src/Foo.ts" }],
	conversations: [
		{ title: "Redesign", source: "claude", sessionId: "s1" },
		{ title: "Path fix", source: "codex", sessionId: "s2" },
	],
	context: [
		{ label: "Plan A", contextValue: "plan", id: "plan-a" },
		{ label: "Note B", contextValue: "note", id: "note-b" },
		{ label: "JOLLI-1", contextValue: "reference", id: "linear:JOLLI-1" },
	],
	onExclude,
});

afterEach(() => {
	// Dispose any open panel (clears the singleton) and reset captured panels.
	for (const p of mock.__panels) {
		if (!p.disposed) p.dispose();
	}
	mock.__panels.length = 0;
	mock.__exec.mockReset();
	vi.clearAllMocks();
});

describe("NextMemoryPreviewPanel", () => {
	it("renders the detail-parity sections + editable rows", () => {
		NextMemoryPreviewPanel.show(populated());
		const html = mock.__panels[0].webview.html;
		expect(mock.__panels[0].title).toBe("Preview Memory");
		// Detail-panel parity sections.
		expect(html).toContain("NOT COMMITTED");
		expect(html).toContain("Pull Request");
		expect(html).toContain(">Jolli<");
		expect(html).toContain("Summary");
		expect(html).toContain("E2E Test Guide");
		expect(html).toContain("Private Transcripts");
		expect(html).toContain("Commit Memory");
		// Source label + context tag branches.
		expect(html).toContain("Claude");
		expect(html).toContain("Codex");
		// Editable rows carry the toggle ids the host routes on.
		expect(html).toContain('data-kind="file"');
		expect(html).toContain('data-relpath="src/Foo.ts"');
		expect(html).toContain('data-kind="conversation"');
		expect(html).toContain('data-sessionid="s1"');
		expect(html).toContain('data-kind="context"');
		expect(html).toContain('data-contextvalue="reference"');
	});

	it("shows an empty state and disables Commit when nothing is selected", () => {
		NextMemoryPreviewPanel.show({
			files: [],
			conversations: [],
			context: [],
			onExclude: vi.fn(),
		});
		const html = mock.__panels[0].webview.html;
		expect(html).toContain("Nothing selected yet");
		expect(html).toContain('id="commitBtn" disabled');
	});

	it("re-opening reveals + refreshes the existing panel (singleton)", () => {
		NextMemoryPreviewPanel.show(populated());
		NextMemoryPreviewPanel.show(populated());
		expect(mock.__panels.length).toBe(1);
		expect(mock.__panels[0].reveal).toHaveBeenCalled();
	});

	it("commit runs jollimemory.commitAI, stays open, and shows a confirmation", () => {
		NextMemoryPreviewPanel.show(populated());
		const h = captureHandler();
		h({ type: "commit" });
		expect(mock.__exec).toHaveBeenCalledWith("jollimemory.commitAI");
		// Does NOT auto-close; flips to the committed confirmation.
		expect(mock.__panels[0].disposed).toBe(false);
		expect(mock.__panels[0].webview.html).toContain("Memory committed");
		// Close from the confirmation disposes the panel.
		h({ type: "close" });
		expect(mock.__panels[0].disposed).toBe(true);
	});

	it("routes exclude messages to onExclude per kind, carrying selected", () => {
		const onExclude = vi.fn<(e: PreviewExclude) => void>();
		NextMemoryPreviewPanel.show(populated(onExclude));
		const h = captureHandler();
		h({ type: "exclude", kind: "file", relPath: "src/Foo.ts", selected: false });
		h({ type: "exclude", kind: "conversation", source: "claude", sessionId: "s1", selected: true });
		h({ type: "exclude", kind: "context", contextValue: "note", id: "note-b", selected: false });
		expect(onExclude).toHaveBeenNthCalledWith(1, { kind: "file", relPath: "src/Foo.ts", selected: false });
		expect(onExclude).toHaveBeenNthCalledWith(2, {
			kind: "conversation",
			source: "claude",
			sessionId: "s1",
			selected: true,
		});
		expect(onExclude).toHaveBeenNthCalledWith(3, {
			kind: "context",
			contextValue: "note",
			id: "note-b",
			selected: false,
		});
	});

	it("ignores malformed / unknown messages", () => {
		const onExclude = vi.fn();
		NextMemoryPreviewPanel.show(populated(onExclude));
		const h = captureHandler();
		h(null);
		h({ type: "nope" });
		h({ type: "exclude", kind: "mystery" });
		expect(onExclude).not.toHaveBeenCalled();
		expect(mock.__exec).not.toHaveBeenCalled();
	});
});
