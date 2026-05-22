import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockWebviewPanel {
	webview: {
		html: string;
		onDidReceiveMessage: ReturnType<typeof vi.fn>;
		postMessage: ReturnType<typeof vi.fn>;
		cspSource: string;
		asWebviewUri: ReturnType<typeof vi.fn>;
	};
	onDidDispose: ReturnType<typeof vi.fn>;
	reveal: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	disposed: boolean;
	title: string;
}

interface MockVsCode {
	ViewColumn: { Active: number; One: number };
	window: { createWebviewPanel: ReturnType<typeof vi.fn> };
	Uri: { file: (p: string) => { fsPath: string } };
	__panels: MockWebviewPanel[];
	__createWebviewPanel: ReturnType<typeof vi.fn>;
}

vi.mock("vscode", () => {
	const panels: MockWebviewPanel[] = [];
	const createWebviewPanel = vi.fn((_type: string, title: string) => {
		const p: MockWebviewPanel = {
			webview: {
				html: "",
				onDidReceiveMessage: vi.fn(),
				postMessage: vi.fn(),
				// Stable-but-fake values used by the panel constructor to
				// allowlist + reference the bundled codicon stylesheet from
				// the strict-CSP webview. The HTML builder is exercised by
				// its own suite; here we just need both to be defined so the
				// constructor doesn't reach into undefined.
				cspSource: "vscode-webview://test",
				asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
					toString: () => `https://example/asset${uri.fsPath}`,
				})),
			},
			onDidDispose: vi.fn(),
			reveal: vi.fn(),
			dispose: vi.fn(() => {
				p.disposed = true;
			}),
			disposed: false,
			title,
		};
		panels.push(p);
		return p;
	});
	// Logger.ts lazy-creates an OutputChannel through createOutputChannel.
	// Stubbed so log.error in handleSaveOverrides' catch path doesn't crash
	// the test under the mocked vscode environment.
	const createOutputChannel = vi.fn(() => ({
		appendLine: vi.fn(),
		append: vi.fn(),
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
		name: "Jolli Memory",
		replace: vi.fn(),
		clear: vi.fn(),
	}));
	return {
		ViewColumn: { Active: 1, One: 1 },
		window: { createWebviewPanel, createOutputChannel },
		Uri: {
			file: (p: string) => ({ fsPath: p }),
			// joinPath is used by the panel constructor to resolve the bundled
			// codicon.css asset relative to extensionUri before handing it to
			// asWebviewUri. Mirror the real semantics with a simple POSIX join
			// so the mocked asWebviewUri sees a sensible fsPath.
			joinPath: (
				base: { fsPath: string },
				...segments: string[]
			): { fsPath: string } => ({
				fsPath: [base.fsPath, ...segments].join("/"),
			}),
		},
		__panels: panels,
		__createWebviewPanel: createWebviewPanel,
	};
});

const loadUnreadTranscriptMock = vi.fn();
const loadOverlayMock = vi.fn();
const applyOverlayMock = vi.fn();
const applyDeletesMock = vi.fn();
const mergeOverlayMock = vi.fn();
const saveOverlayMock = vi.fn();
const hideConversationMock = vi.fn();
const hasOverlayChangesMock = vi.fn();

// The panel deliberately reads via TranscriptMessageCounter.loadUnreadTranscript
// (cursor-aware) rather than the full-transcript TranscriptLoader, so the
// detail view shows the same unread slice the CONVERSATIONS row advertises.
// Mocking here pins that wiring — a refactor that silently swaps back to the
// full loader would re-show summary-consumed turns and this mock would go
// uncalled.
vi.mock("../../../cli/src/core/TranscriptMessageCounter.js", () => ({
	loadUnreadTranscript: (...args: unknown[]) =>
		loadUnreadTranscriptMock(...args),
}));

vi.mock("../../../cli/src/core/ConversationOverlayStore.js", () => ({
	loadOverlay: (...args: unknown[]) => loadOverlayMock(...args),
	applyOverlay: (...args: unknown[]) => applyOverlayMock(...args),
	applyDeletes: (...args: unknown[]) => applyDeletesMock(...args),
	mergeOverlay: (...args: unknown[]) => mergeOverlayMock(...args),
	saveOverlay: (...args: unknown[]) => saveOverlayMock(...args),
	hasOverlayChanges: (...args: unknown[]) => hasOverlayChangesMock(...args),
}));

vi.mock("../../../cli/src/core/HiddenConversationsStore.js", () => ({
	hideConversation: (...args: unknown[]) => hideConversationMock(...args),
}));

import * as vscode from "vscode";
import {
	ConversationDetailsPanel,
	isSaveOverridesPayload,
} from "./ConversationDetailsPanel.js";

const mockVsCode = vscode as unknown as MockVsCode;

function lastMessageHandler() {
	const panel = mockVsCode.__panels[0];
	const handler = panel.webview.onDidReceiveMessage.mock.calls[0]?.[0] as
		| ((raw: unknown) => Promise<void> | void)
		| undefined;
	if (!handler) throw new Error("no message handler captured");
	return handler;
}

const baseShowArgs = {
	extensionUri: vscode.Uri.file("/ext"),
	sessionId: "s1",
	source: "claude" as const,
	transcriptPath: "/tmp/s1.jsonl",
	title: "Wire up dark mode",
	projectDir: "/proj",
};

describe("ConversationDetailsPanel", () => {
	beforeEach(() => {
		mockVsCode.__panels.length = 0;
		mockVsCode.__createWebviewPanel.mockClear();
		loadUnreadTranscriptMock.mockReset();
		loadOverlayMock.mockReset();
		applyOverlayMock.mockReset();
		// applyDeletes defaults to identity (no deletes applied) so legacy
		// tests that only configure applyOverlay still get a sensible
		// rawByIndex passthrough for handleSaveOverrides' identity derivation.
		applyDeletesMock
			.mockReset()
			.mockImplementation((entries: unknown) => entries);
		mergeOverlayMock.mockReset();
		saveOverlayMock.mockReset();
		hideConversationMock.mockReset().mockResolvedValue(undefined);
		hasOverlayChangesMock.mockReset().mockReturnValue(false);
		ConversationDetailsPanel.disposeAll();
	});

	it("opens a new panel for an unseen sessionId", () => {
		ConversationDetailsPanel.show(baseShowArgs);
		expect(mockVsCode.__createWebviewPanel).toHaveBeenCalledTimes(1);
	});

	it("reveals (does not recreate) for the same sessionId", () => {
		ConversationDetailsPanel.show(baseShowArgs);
		ConversationDetailsPanel.show(baseShowArgs);
		expect(mockVsCode.__createWebviewPanel).toHaveBeenCalledTimes(1);
		expect(mockVsCode.__panels[0].reveal).toHaveBeenCalledTimes(1);
	});

	// Re-show on an existing panel must nudge the webview to re-fetch the
	// transcript. Without this, the sidebar's 60s polling can advertise fresh
	// unread content while the detail view remains stuck on the first-load
	// snapshot — `retainContextWhenHidden: true` keeps the DOM around and the
	// in-webview script only requests transcript data on initial mount.
	// The webview is responsible for skipping the refresh when pending edits
	// exist; the host only signals "user clicked again".
	it("posts panelReshown to the webview when re-revealing an existing panel", () => {
		ConversationDetailsPanel.show(baseShowArgs);
		const panel = mockVsCode.__panels[0];
		panel.webview.postMessage.mockClear();
		ConversationDetailsPanel.show(baseShowArgs);
		expect(panel.webview.postMessage).toHaveBeenCalledWith({
			type: "panelReshown",
		});
	});

	it("does not post panelReshown on first show (no existing panel)", () => {
		ConversationDetailsPanel.show(baseShowArgs);
		const panel = mockVsCode.__panels[0];
		const calls = panel.webview.postMessage.mock.calls.filter(
			(c) => (c[0] as { type?: string })?.type === "panelReshown",
		);
		expect(calls).toEqual([]);
	});

	it("opens distinct panels for different sessionIds", () => {
		ConversationDetailsPanel.show({ ...baseShowArgs, sessionId: "s1" });
		ConversationDetailsPanel.show({
			...baseShowArgs,
			sessionId: "s2",
			title: "B",
		});
		expect(mockVsCode.__createWebviewPanel).toHaveBeenCalledTimes(2);
	});

	// The panels registry is keyed by `${source}:${sessionId}` because session
	// IDs are only unique inside a single agent's namespace — Claude's UUID
	// generator and Cursor's session-hash scheme can collide at the string
	// level. Keying by sessionId alone would route the second click to the
	// first panel and silently swap which source the user thinks they're
	// looking at.
	it("opens distinct panels when sessionId is shared between sources", () => {
		ConversationDetailsPanel.show({
			...baseShowArgs,
			sessionId: "shared",
			source: "claude",
			title: "Claude side",
		});
		ConversationDetailsPanel.show({
			...baseShowArgs,
			sessionId: "shared",
			source: "cursor",
			title: "Cursor side",
		});
		expect(mockVsCode.__createWebviewPanel).toHaveBeenCalledTimes(2);
		expect(mockVsCode.__panels[0].title).toBe("Claude side");
		expect(mockVsCode.__panels[1].title).toBe("Cursor side");
	});

	// And re-opening with the same (source, sessionId) STILL reveals — proves
	// the new compound key did not over-correct by treating every show as a
	// fresh panel.
	it("reveals the same panel when both source and sessionId match", () => {
		ConversationDetailsPanel.show({
			...baseShowArgs,
			sessionId: "same",
			source: "claude",
		});
		ConversationDetailsPanel.show({
			...baseShowArgs,
			sessionId: "same",
			source: "claude",
			title: "newer title",
		});
		expect(mockVsCode.__createWebviewPanel).toHaveBeenCalledTimes(1);
		expect(mockVsCode.__panels[0].reveal).toHaveBeenCalledTimes(1);
		expect(mockVsCode.__panels[0].title).toBe("newer title");
	});

	// onDidDispose's callback removes the sessionId from the static
	// `panels` map so a subsequent `show()` of the same id opens a fresh
	// panel (rather than revealing the disposed one). Invoke the captured
	// dispose handler directly.
	it("removes the panel from its registry when onDidDispose fires", () => {
		ConversationDetailsPanel.show(baseShowArgs);
		const captured = mockVsCode.__panels[0].onDidDispose.mock.calls[0]?.[0] as
			| (() => void)
			| undefined;
		expect(typeof captured).toBe("function");
		captured?.();
		// Showing again must create a NEW panel (not reveal the old one).
		ConversationDetailsPanel.show(baseShowArgs);
		expect(mockVsCode.__createWebviewPanel).toHaveBeenCalledTimes(2);
	});

	it("uses the row title as the panel tab title", () => {
		ConversationDetailsPanel.show({
			...baseShowArgs,
			title: "Refactor session storage layer",
		});
		expect(mockVsCode.__panels[0].title).toBe("Refactor session storage layer");
	});

	it("renders the row title in the panel header HTML (verbatim, HTML-escaped)", () => {
		ConversationDetailsPanel.show({
			...baseShowArgs,
			title: "Refactor <storage> & friends",
		});
		const html = mockVsCode.__panels[0].webview.html;
		expect(html).toContain(
			'<span class="title" id="title">Refactor &lt;storage&gt; &amp; friends</span>',
		);
	});

	it("updates an existing panel's tab title when re-opened with a fresh title", () => {
		ConversationDetailsPanel.show({ ...baseShowArgs, title: "(untitled)" });
		ConversationDetailsPanel.show({
			...baseShowArgs,
			title: "Native title resolved later",
		});
		expect(mockVsCode.__panels[0].title).toBe("Native title resolved later");
		expect(mockVsCode.__createWebviewPanel).toHaveBeenCalledTimes(1);
	});

	it("renders without footer when projectDir is missing (read-only mode)", () => {
		ConversationDetailsPanel.show({ ...baseShowArgs, projectDir: undefined });
		const html = mockVsCode.__panels[0].webview.html;
		// Footer carries the "hidden" class to suppress display in read-only.
		expect(html).toContain('class="footer hidden"');
	});

	it("renders the Mark All as Deleted button inside the footer", () => {
		// Mark All lives in the footer next to Cancel / Save, so it inherits
		// the same read-only behavior (when projectDir is missing the whole
		// footer hides). The button itself is the entry-point for the "wipe
		// the entire current session" flow — clicking it stages every
		// displayIndex into deletedIndices and lets the existing Save All
		// path translate them to overlay deletes server-side.
		ConversationDetailsPanel.show(baseShowArgs);
		const html = mockVsCode.__panels[0].webview.html;
		expect(html).toContain('id="markAllBtn"');
		expect(html).toContain(">Mark All as Deleted<");
		// And the script wires its click handler — guards against the
		// HTML button shipping without the JS side, which would silently
		// render a dead button.
		expect(html).toContain("markAllBtn.addEventListener('click'");
	});

	describe("requestTranscript message", () => {
		it("loads raw entries, applies overlay, posts transcriptLoaded with displayIndex", async () => {
			const raw = [
				{ role: "human", content: "hi", timestamp: "t0" },
				{ role: "assistant", content: "hello", timestamp: "t1" },
			];
			loadUnreadTranscriptMock.mockResolvedValue(raw);
			loadOverlayMock.mockResolvedValue({ deletes: [], edits: [] });
			applyOverlayMock.mockReturnValue(raw);

			ConversationDetailsPanel.show(baseShowArgs);
			const handler = lastMessageHandler();
			await handler({ type: "requestTranscript" });

			// projectDir is forwarded so the helper can look up cursors.json
			// and trim to the unread slice — mirrors what the active-
			// conversations list does, so the detail panel cannot drift back
			// into showing turns already consumed into a commit summary.
			expect(loadUnreadTranscriptMock).toHaveBeenCalledWith(
				"claude",
				"/tmp/s1.jsonl",
				"/proj",
			);
			expect(loadOverlayMock).toHaveBeenCalledWith({
				projectDir: "/proj",
				source: "claude",
				sessionId: "s1",
			});
			expect(applyOverlayMock).toHaveBeenCalledWith(raw, {
				deletes: [],
				edits: [],
			});

			const postMessage = mockVsCode.__panels[0].webview.postMessage;
			expect(postMessage).toHaveBeenCalledWith({
				type: "transcriptLoaded",
				entries: [
					{ role: "human", content: "hi", timestamp: "t0", displayIndex: 0 },
					{
						role: "assistant",
						content: "hello",
						timestamp: "t1",
						displayIndex: 1,
					},
				],
				isEdited: false,
			});
		});

		it("marks transcriptLoaded as edited when the saved overlay has changes", async () => {
			loadUnreadTranscriptMock.mockResolvedValue([{ role: "human", content: "hi" }]);
			loadOverlayMock.mockResolvedValue({
				deletes: [{ role: "human", content: "hi" }],
				edits: [],
			});
			applyOverlayMock.mockReturnValue([{ role: "human", content: "hi" }]);
			hasOverlayChangesMock.mockReturnValue(true);

			ConversationDetailsPanel.show(baseShowArgs);
			const handler = lastMessageHandler();
			await handler({ type: "requestTranscript" });

			expect(mockVsCode.__panels[0].webview.postMessage).toHaveBeenCalledWith({
				type: "transcriptLoaded",
				entries: [{ role: "human", content: "hi", displayIndex: 0 }],
				isEdited: true,
			});
		});

		it("skips the overlay lookup in read-only mode and still posts entries", async () => {
			loadUnreadTranscriptMock.mockResolvedValue([
				{ role: "human", content: "hi" },
			]);
			applyOverlayMock.mockReturnValue([{ role: "human", content: "hi" }]);

			ConversationDetailsPanel.show({ ...baseShowArgs, projectDir: undefined });
			const handler = lastMessageHandler();
			await handler({ type: "requestTranscript" });

			// projectDir=undefined still reaches loadUnreadTranscript — the
			// helper handles the missing-cursor fallback internally (full-
			// transcript read) so the panel doesn't need a branch.
			expect(loadUnreadTranscriptMock).toHaveBeenCalledWith(
				"claude",
				"/tmp/s1.jsonl",
				undefined,
			);
			expect(loadOverlayMock).not.toHaveBeenCalled();
			expect(applyOverlayMock).toHaveBeenCalledWith(
				[{ role: "human", content: "hi" }],
				null,
			);
		});
	});

	describe("saveOverrides message", () => {
		it("translates display indices to identity rules, merges with existing, saves, and refreshes", async () => {
			const displayedEntries = [
				{ role: "human", content: "hi", timestamp: "t0" },
				{ role: "assistant", content: "hello", timestamp: "t1" },
				{ role: "human", content: "ok", timestamp: "t2" },
			];
			loadUnreadTranscriptMock.mockResolvedValue(displayedEntries);
			loadOverlayMock.mockResolvedValue(null);
			applyOverlayMock.mockImplementation((entries: unknown) => entries);
			mergeOverlayMock.mockReturnValue({
				deletes: [{ role: "human", content: "hi", timestamp: "t0" }],
				edits: [
					{
						role: "assistant",
						content: "hello",
						timestamp: "t1",
						newContent: "Hello there",
					},
				],
			});
			saveOverlayMock.mockResolvedValue(undefined);
			hasOverlayChangesMock.mockReturnValue(true);

			ConversationDetailsPanel.show(baseShowArgs);
			const handler = lastMessageHandler();
			await handler({
				type: "saveOverrides",
				deletedIndices: [0],
				edits: { "1": "Hello there" },
			});

			expect(mergeOverlayMock).toHaveBeenCalledWith(null, {
				deletes: [{ role: "human", content: "hi", timestamp: "t0" }],
				edits: [
					{
						role: "assistant",
						content: "hello",
						timestamp: "t1",
						newContent: "Hello there",
					},
				],
			});
			expect(saveOverlayMock).toHaveBeenCalledWith(
				{ projectDir: "/proj", source: "claude", sessionId: "s1" },
				{
					deletes: [{ role: "human", content: "hi", timestamp: "t0" }],
					edits: [
						{
							role: "assistant",
							content: "hello",
							timestamp: "t1",
							newContent: "Hello there",
						},
					],
				},
			);
			const postMessage = mockVsCode.__panels[0].webview.postMessage;
			const types = postMessage.mock.calls.map(
				(c) => (c[0] as { type: string }).type,
			);
			expect(types).toContain("overridesSaved");
			// And re-fetched the transcript after saving.
			expect(types).toContain("transcriptLoaded");
		});

		it("ignores non-numeric edit keys and missing display entries", async () => {
			loadUnreadTranscriptMock.mockResolvedValue([
				{ role: "human", content: "a" },
			]);
			loadOverlayMock.mockResolvedValue(null);
			applyOverlayMock.mockImplementation((entries: unknown) => entries);
			mergeOverlayMock.mockReturnValue({ deletes: [], edits: [] });
			saveOverlayMock.mockResolvedValue(undefined);

			ConversationDetailsPanel.show(baseShowArgs);
			const handler = lastMessageHandler();
			await handler({
				type: "saveOverrides",
				deletedIndices: [99], // out of bounds — should be skipped
				edits: { abc: "weird key", "0": "edit-here", "42": "out of bounds" },
			});

			expect(mergeOverlayMock).toHaveBeenCalledWith(null, {
				deletes: [],
				edits: [{ role: "human", content: "a", newContent: "edit-here" }],
			});
		});

		it("posts overridesSaveError when projectDir is missing", async () => {
			ConversationDetailsPanel.show({ ...baseShowArgs, projectDir: undefined });
			const handler = lastMessageHandler();
			await handler({
				type: "saveOverrides",
				deletedIndices: [0],
				edits: {},
			});
			const postMessage = mockVsCode.__panels[0].webview.postMessage;
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "overridesSaveError" }),
			);
			expect(saveOverlayMock).not.toHaveBeenCalled();
		});

		// Trust-boundary defense: even though the webview is normally
		// well-behaved, a corrupted message (deletedIndices: null, edits:
		// "bad") would otherwise reach `for (const idx of …)` or
		// `Object.entries(…)` and throw deep inside the fs path with no
		// clean recovery. The new guard rejects them at the dispatch site
		// and surfaces a user-visible banner instead of a silent failure.
		it.each([
			{
				name: "deletedIndices is null",
				payload: { type: "saveOverrides", deletedIndices: null, edits: {} },
			},
			{
				name: "deletedIndices contains non-integer",
				payload: { type: "saveOverrides", deletedIndices: [0.5], edits: {} },
			},
			{
				name: "deletedIndices contains negative",
				payload: { type: "saveOverrides", deletedIndices: [-1], edits: {} },
			},
			{
				name: "edits is a string",
				payload: { type: "saveOverrides", deletedIndices: [], edits: "bad" },
			},
			{
				name: "edits is an array",
				payload: { type: "saveOverrides", deletedIndices: [], edits: [] },
			},
			{
				name: "edits has non-string value",
				payload: {
					type: "saveOverrides",
					deletedIndices: [],
					edits: { "0": 42 },
				},
			},
		])(
			"rejects malformed saveOverrides payload ($name)",
			async ({ payload }) => {
				ConversationDetailsPanel.show(baseShowArgs);
				const handler = lastMessageHandler();
				await handler(payload);
				const postMessage = mockVsCode.__panels[0].webview.postMessage;
				expect(postMessage).toHaveBeenCalledWith(
					expect.objectContaining({ type: "overridesSaveError" }),
				);
				expect(saveOverlayMock).not.toHaveBeenCalled();
			},
		);

		it("hides the session and disposes without firing onSessionHidden when callback is undefined", async () => {
			// Caller may omit onSessionHidden (the sidebar wires it but a
			// standalone host could open the panel without it). The hide +
			// dispose path must complete cleanly even with no callback.
			loadUnreadTranscriptMock.mockResolvedValue([
				{ role: "human", content: "bye", timestamp: "t0" },
			]);
			loadOverlayMock.mockResolvedValue(null);
			applyOverlayMock
				.mockImplementationOnce((entries: unknown) => entries)
				.mockImplementationOnce(() => []);
			mergeOverlayMock.mockReturnValue({
				deletes: [{ role: "human", content: "bye", timestamp: "t0" }],
				edits: [],
			});
			saveOverlayMock.mockResolvedValue(undefined);

			// onSessionHidden intentionally NOT provided.
			ConversationDetailsPanel.show(baseShowArgs);
			const handler = lastMessageHandler();
			await handler({ type: "saveOverrides", deletedIndices: [0], edits: {} });

			expect(hideConversationMock).toHaveBeenCalled();
			expect(mockVsCode.__panels[0].dispose).toHaveBeenCalled();
		});

		it("hides the session and disposes when the merged view is empty after save", async () => {
			// First load: one entry rendered. Save: delete it.
			// Second load (after save): overlay drops every entry → empty.
			loadUnreadTranscriptMock.mockResolvedValue([
				{ role: "human", content: "bye", timestamp: "t0" },
			]);
			loadOverlayMock.mockResolvedValue(null);
			applyOverlayMock
				.mockImplementationOnce((entries: unknown) => entries)
				.mockImplementationOnce(() => []);
			mergeOverlayMock.mockReturnValue({
				deletes: [{ role: "human", content: "bye", timestamp: "t0" }],
				edits: [],
			});
			saveOverlayMock.mockResolvedValue(undefined);
			const onSessionHidden = vi.fn();

			ConversationDetailsPanel.show({ ...baseShowArgs, onSessionHidden });
			const handler = lastMessageHandler();
			await handler({ type: "saveOverrides", deletedIndices: [0], edits: {} });

			expect(hideConversationMock).toHaveBeenCalledWith(
				"/proj",
				"claude",
				"s1",
			);
			expect(mockVsCode.__panels[0].dispose).toHaveBeenCalled();
			expect(onSessionHidden).toHaveBeenCalledWith("s1");
		});

		// Same hide-and-dispose path as above, but the caller also wires
		// onSessionChanged. After the panel disposes, both callbacks must fire
		// with the sessionId so the sidebar can drop the row AND emit a final
		// changed notification — the order the hide path captures the callbacks
		// matters (panel.dispose() runs before the callbacks).
		it("fires both onSessionChanged and onSessionHidden after hide-on-empty", async () => {
			loadUnreadTranscriptMock.mockResolvedValue([
				{ role: "human", content: "bye", timestamp: "t0" },
			]);
			loadOverlayMock.mockResolvedValue(null);
			applyOverlayMock
				.mockImplementationOnce((entries: unknown) => entries)
				.mockImplementationOnce(() => []);
			mergeOverlayMock.mockReturnValue({
				deletes: [{ role: "human", content: "bye", timestamp: "t0" }],
				edits: [],
			});
			saveOverlayMock.mockResolvedValue(undefined);
			const onSessionHidden = vi.fn();
			const onSessionChanged = vi.fn();

			ConversationDetailsPanel.show({
				...baseShowArgs,
				onSessionHidden,
				onSessionChanged,
			});
			const handler = lastMessageHandler();
			await handler({ type: "saveOverrides", deletedIndices: [0], edits: {} });

			expect(hideConversationMock).toHaveBeenCalledWith(
				"/proj",
				"claude",
				"s1",
			);
			expect(mockVsCode.__panels[0].dispose).toHaveBeenCalled();
			expect(onSessionChanged).toHaveBeenCalledWith("s1");
			expect(onSessionHidden).toHaveBeenCalledWith("s1");
		});

		it("does not hide the session when entries remain after save", async () => {
			loadUnreadTranscriptMock.mockResolvedValue([
				{ role: "human", content: "a" },
				{ role: "assistant", content: "b" },
			]);
			loadOverlayMock.mockResolvedValue(null);
			applyOverlayMock.mockImplementation((entries: unknown) => entries);
			mergeOverlayMock.mockReturnValue({
				deletes: [{ role: "human", content: "a" }],
				edits: [],
			});
			saveOverlayMock.mockResolvedValue(undefined);
			const onSessionHidden = vi.fn();
			const onSessionChanged = vi.fn();

			ConversationDetailsPanel.show({
				...baseShowArgs,
				onSessionHidden,
				onSessionChanged,
			});
			const handler = lastMessageHandler();
			await handler({ type: "saveOverrides", deletedIndices: [0], edits: {} });

			expect(hideConversationMock).not.toHaveBeenCalled();
			expect(mockVsCode.__panels[0].dispose).not.toHaveBeenCalled();
			expect(onSessionHidden).not.toHaveBeenCalled();
			expect(onSessionChanged).toHaveBeenCalledWith("s1");
		});

		it("posts overridesSaveError when saveOverlay throws", async () => {
			loadUnreadTranscriptMock.mockResolvedValue([
				{ role: "human", content: "x" },
			]);
			loadOverlayMock.mockResolvedValue(null);
			applyOverlayMock.mockImplementation((entries: unknown) => entries);
			mergeOverlayMock.mockReturnValue({ deletes: [], edits: [] });
			saveOverlayMock.mockRejectedValue(new Error("disk full"));

			ConversationDetailsPanel.show(baseShowArgs);
			const handler = lastMessageHandler();
			await handler({
				type: "saveOverrides",
				deletedIndices: [],
				edits: {},
			});
			const postMessage = mockVsCode.__panels[0].webview.postMessage;
			expect(postMessage).toHaveBeenCalledWith({
				type: "overridesSaveError",
				message: "disk full",
			});
		});
	});

	it("ignores message types it does not recognize", async () => {
		ConversationDetailsPanel.show(baseShowArgs);
		const handler = lastMessageHandler();
		await handler({ type: "thisIsNotARealType" });
		await handler(null);
		await handler("not an object");
		// No transcript / overlay calls — handler was a no-op for these.
		expect(loadUnreadTranscriptMock).not.toHaveBeenCalled();
		expect(saveOverlayMock).not.toHaveBeenCalled();
	});
});

// Direct unit tests for the exported type-guard. The production call site
// (`handleMessage`) pre-filters non-object values before reaching this
// function, so the inner `!value || typeof value !== "object"` arm is
// unreachable via the message-handler integration tests above. Testing it
// directly pins the trust-boundary contract independently of any caller's
// pre-filter behavior — a refactor that drops the outer filter would still
// hit a correct guard, and these tests would catch a regression that
// weakened the guard itself (e.g. accepting `null` or strings).
describe("isSaveOverridesPayload (direct)", () => {
	it("rejects non-object primitives at the trust boundary", () => {
		expect(isSaveOverridesPayload(null)).toBe(false);
		expect(isSaveOverridesPayload(undefined)).toBe(false);
		expect(isSaveOverridesPayload("not an object")).toBe(false);
		expect(isSaveOverridesPayload(42)).toBe(false);
		expect(isSaveOverridesPayload(true)).toBe(false);
	});

	it("accepts a well-formed payload with mixed-key edits and integer deletes", () => {
		expect(
			isSaveOverridesPayload({
				deletedIndices: [0, 2, 7],
				edits: { "1": "replacement", "3": "other" },
			}),
		).toBe(true);
		// Empty arrays / empty edits are also valid — the guard accepts a
		// payload that asks for no changes (the handler decides whether to
		// no-op or persist an empty overlay).
		expect(isSaveOverridesPayload({ deletedIndices: [], edits: {} })).toBe(
			true,
		);
	});
});
