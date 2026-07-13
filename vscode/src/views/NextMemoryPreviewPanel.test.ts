import { afterEach, describe, expect, it, vi } from "vitest";

const { createWebviewPanel, postMessage } = vi.hoisted(() => {
	const postMessage = vi.fn();
	const createWebviewPanel = vi.fn(() => {
		const panel = {
			webview: {
				html: "",
				postMessage,
				messageHandler: undefined as ((msg: unknown) => void) | undefined,
				onDidReceiveMessage(cb: (msg: unknown) => void) {
					panel.webview.messageHandler = cb;
					return { dispose() {} };
				},
				asWebviewUri: (u: unknown) => u,
				cspSource: "vscode-webview://x",
			},
			reveal: vi.fn(),
			onDispose: () => {},
			onDidDispose(cb: () => void) {
				panel.onDispose = cb;
				return { dispose() {} };
			},
		};
		return panel;
	});
	return { createWebviewPanel, postMessage };
});

vi.mock("vscode", () => ({
	ViewColumn: { Active: -1 },
	window: { createWebviewPanel },
	Uri: { joinPath: (...parts: unknown[]) => parts.join("/") },
}));

const { assessMock, detectPlansMock, writeAiMock } = vi.hoisted(() => ({
	assessMock: vi.fn(),
	detectPlansMock: vi.fn(),
	writeAiMock: vi.fn(),
}));
vi.mock("../../../cli/src/core/ContextRelevance.js", () => ({
	assessContextRelevance: assessMock,
	computeChangeFingerprint: () => "fp",
}));
vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadConfig: vi.fn().mockResolvedValue({}),
	detectActivePlansForBranch: detectPlansMock,
	detectActiveNotesForBranch: vi.fn().mockResolvedValue([]),
	getReferenceEntriesForBranch: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../cli/src/core/CommitSelectionStore.js", () => ({
	readExclusions: vi.fn().mockResolvedValue({
		conversations: new Set(),
		plans: new Set(),
		notes: new Set(),
		references: new Set(),
	}),
	writeAiSelection: writeAiMock,
}));

import { NextMemoryPreviewPanel } from "./NextMemoryPreviewPanel.js";

function makeSidebarProvider(overrides: Record<string, unknown> = {}) {
	return {
		registerBroadcastTarget: vi.fn(),
		unregisterBroadcastTarget: vi.fn(),
		handleOutbound: vi.fn(),
		getPlansSnapshot: vi.fn().mockReturnValue([]),
		getFilesSnapshot: vi.fn().mockReturnValue([]),
		getConversationsSnapshot: vi.fn().mockResolvedValue([]),
		pushContextRelevanceToSidebar: vi.fn(),
		...overrides,
	};
}

function makeBridge(overrides: Record<string, unknown> = {}) {
	return {
		generateCommitMessageForFiles: vi.fn().mockResolvedValue("feat: example"),
		getCurrentBranch: vi.fn().mockResolvedValue("feature/demo"),
		...overrides,
	};
}

function lastPanel() {
	const results = createWebviewPanel.mock.results;
	return results[results.length - 1].value;
}

// The preview:* sections are now pushed in response to the panel's `ready`
// handshake (not eagerly from show()), mirroring how branch:*Data is delivered
// and closing the race where a message posted before the webview's listener
// exists is dropped. Drive that handshake, then poll for the async push to land
// (a single microtask tick is not enough — the refresh awaits git + the LLM).
async function openAndReady(bridge: unknown, sidebarProvider: unknown, workspaceRoot = "/repo") {
	await NextMemoryPreviewPanel.show("file:///ext" as never, workspaceRoot, bridge as never, sidebarProvider as never);
	lastPanel().webview.messageHandler({ type: "ready" });
}

// The panel is a module-level singleton (currentPanel persists across show()
// calls). Dispose it after each test so the next test re-creates a fresh
// panel and re-runs the register-on-open path against its own mock provider.
afterEach(() => {
	const results = createWebviewPanel.mock.results;
	const last = results[results.length - 1]?.value as { onDispose?: () => void } | undefined;
	last?.onDispose?.();
	createWebviewPanel.mockClear();
	postMessage.mockClear();
	// The relevance cache is module-scoped, so it survives across tests; clear it so
	// one test's ranking can't be replayed as another's (the mocked fingerprint is a
	// constant, so keys would otherwise collide).
	NextMemoryPreviewPanel.invalidateRelevanceCache();
});

describe("NextMemoryPreviewPanel.show", () => {
	it("creates a scripts-enabled webview panel", async () => {
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, makeSidebarProvider() as never);
		expect(createWebviewPanel).toHaveBeenCalledWith(
			"jollimemory.nextMemoryPreview",
			"Working Memory",
			-1,
			expect.objectContaining({ enableScripts: true }),
		);
	});

	it("reopens a fresh panel after the previous one was disposed", async () => {
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, makeSidebarProvider() as never);
		expect(createWebviewPanel).toHaveBeenCalledTimes(1);
		// Close the panel — onDidDispose must clear the singleton so a re-open works.
		lastPanel().onDispose();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, makeSidebarProvider() as never);
		expect(createWebviewPanel).toHaveBeenCalledTimes(2);
	});

	it("clears the singleton on dispose even when the disposed webview getter throws", async () => {
		// Regression for the real crash (dev-tools log: "Webview is disposed" thrown
		// from onDidDispose). After teardown, reading panel.webview throws; the
		// dispose callback must use the cached webview reference so it neither throws
		// nor leaves a dead panel as the singleton. Otherwise the next Review click
		// reveal()s a disposed webview and silently does nothing.
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, makeSidebarProvider() as never);
		expect(createWebviewPanel).toHaveBeenCalledTimes(1);
		const panel = lastPanel();
		// Emulate VS Code: once disposed, the webview getter throws.
		Object.defineProperty(panel, "webview", {
			get() {
				throw new Error("Webview is disposed");
			},
		});
		expect(() => panel.onDispose()).not.toThrow();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, makeSidebarProvider() as never);
		expect(createWebviewPanel).toHaveBeenCalledTimes(2);
	});

	it("reuses the existing panel on a second show() instead of creating a new one", async () => {
		const bridge = makeBridge();
		const sidebarProvider = makeSidebarProvider();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", bridge as never, sidebarProvider as never);
		expect(createWebviewPanel).toHaveBeenCalledTimes(1);
		const panelInstance = createWebviewPanel.mock.results[0].value;
		// Second show while the singleton is live: the `if (!currentPanel)` guard is
		// false, so no new panel is created — the existing one is revealed and reused.
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", bridge as never, sidebarProvider as never);
		expect(createWebviewPanel).toHaveBeenCalledTimes(1);
		expect(panelInstance.reveal).toHaveBeenCalled();
	});

	it("registers itself as a broadcast target on open and unregisters on dispose", async () => {
		const sidebarProvider = makeSidebarProvider();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, sidebarProvider as never);
		expect(sidebarProvider.registerBroadcastTarget).toHaveBeenCalledTimes(1);

		const panelInstance = createWebviewPanel.mock.results[createWebviewPanel.mock.results.length - 1].value;
		panelInstance.onDispose();
		expect(sidebarProvider.unregisterBroadcastTarget).toHaveBeenCalledTimes(1);
	});

	it("does not push preview:* before the panel signals ready", async () => {
		postMessage.mockClear();
		// show() alone must not push preview:* — the webview's message listener
		// may not be attached yet, so an eager push could be dropped.
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, makeSidebarProvider() as never);
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title" }));
	});

	it("posts preview:title with the generated commit message + branch after ready", async () => {
		postMessage.mockClear();
		await openAndReady(makeBridge(), makeSidebarProvider());
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "preview:title", title: "feat: example", branch: "feature/demo" }),
			),
		);
	});

	it("generates the proposed title over the selected files' RELATIVE paths (never the absolute id)", async () => {
		postMessage.mockClear();
		const bridge = makeBridge();
		const sidebarProvider = makeSidebarProvider({
			getFilesSnapshot: vi.fn().mockReturnValue([
				{ id: "/Users/me/repo/a.ts", description: "src/a.ts", label: "a.ts", isSelected: true },
				{ id: "/Users/me/repo/b.ts", description: "src/b.ts", label: "b.ts", isSelected: false },
			]),
		});
		await openAndReady(bridge, sidebarProvider);
		// Only the selected file is handed to the title generator (the excluded row
		// is filtered out), and as its REPO-RELATIVE path — the absolute id would
		// leak /Users/<name>/… workspace paths + usernames into the LLM request.
		await vi.waitFor(() => expect(bridge.generateCommitMessageForFiles).toHaveBeenCalledWith(["src/a.ts"]));
	});

	it("falls back to the absolute id when a file row carries no relative path", async () => {
		const bridge = makeBridge();
		const sidebarProvider = makeSidebarProvider({
			getFilesSnapshot: vi.fn().mockReturnValue([{ id: "/repo/a.ts", label: "a.ts", isSelected: true }]),
		});
		await openAndReady(bridge, sidebarProvider);
		await vi.waitFor(() => expect(bridge.generateCommitMessageForFiles).toHaveBeenCalledWith(["/repo/a.ts"]));
	});

	it("resolves the current branch only once per refresh (shared by title + diffstat)", async () => {
		const bridge = makeBridge();
		await openAndReady(bridge, makeSidebarProvider());
		// One getCurrentBranch call feeds both preview:title and preview:diffstat —
		// the two pushes no longer each spawn their own git subprocess.
		await vi.waitFor(() => expect(bridge.getCurrentBranch).toHaveBeenCalledTimes(1));
	});

	it("omits the branch key from preview:title and preview:diffstat when branch resolution fails", async () => {
		postMessage.mockClear();
		// getCurrentBranch rejecting drives refreshPreview's `.catch(() => "")`, so
		// the shared branch is "" and both the title and diffstat pushes take the
		// branch-less arm of their `...(branch ? { branch } : {})` spreads.
		const bridge = makeBridge({ getCurrentBranch: vi.fn().mockRejectedValue(new Error("detached HEAD")) });
		await openAndReady(bridge, makeSidebarProvider());
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title", title: "feat: example" })),
		);
		const titleCall = postMessage.mock.calls.find((c) => (c[0] as { type?: string }).type === "preview:title");
		expect(titleCall?.[0]).not.toHaveProperty("branch");
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:diffstat" })),
		);
		const diffstatCall = postMessage.mock.calls.find((c) => (c[0] as { type?: string }).type === "preview:diffstat");
		expect(diffstatCall?.[0]).not.toHaveProperty("branch");
	});

	it("falls back to a blank branch when the standalone regenerate command can't resolve the branch", async () => {
		// The Regenerate command calls pushProposedTitle without a pre-resolved
		// branch, so it resolves one itself — a rejection here exercises the
		// standalone `.catch(() => "")` fallback (distinct from refreshPreview's).
		const bridge = makeBridge({ getCurrentBranch: vi.fn().mockRejectedValue(new Error("detached HEAD")) });
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", bridge as never, makeSidebarProvider() as never);
		const panelInstance = createWebviewPanel.mock.results[createWebviewPanel.mock.results.length - 1].value;

		bridge.generateCommitMessageForFiles.mockClear();
		postMessage.mockClear();
		panelInstance.webview.messageHandler({ type: "command", command: "jollimemory.regenerateNextMemoryTitle" });

		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title", title: "feat: example" })),
		);
		const titleCall = postMessage.mock.calls.find((c) => (c[0] as { type?: string }).type === "preview:title");
		expect(titleCall?.[0]).not.toHaveProperty("branch");
	});

	it("posts a degraded preview:title when title generation throws", async () => {
		postMessage.mockClear();
		const bridge = makeBridge({ generateCommitMessageForFiles: vi.fn().mockRejectedValue(new Error("no API key")) });
		await openAndReady(bridge, makeSidebarProvider());
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title", error: "no API key" })),
		);
	});

	it("stringifies a non-Error rejection from title generation into the preview:title error", async () => {
		postMessage.mockClear();
		// Rejecting with a plain string exercises the String(err) arm of the
		// `err instanceof Error ? err.message : String(err)` ternary.
		const bridge = makeBridge({ generateCommitMessageForFiles: vi.fn().mockRejectedValue("bridge offline") });
		await openAndReady(bridge, makeSidebarProvider());
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title", error: "bridge offline" })),
		);
	});

	it("merges a detected ticket from the plans snapshot into preview:title", async () => {
		postMessage.mockClear();
		const sidebarProvider = makeSidebarProvider({
			getPlansSnapshot: vi.fn().mockReturnValue([
				{ id: "r1", label: "JOLLI-1620 · Sidebar UX redesign", contextValue: "reference", isSelected: true },
			]),
		});
		await openAndReady(makeBridge(), sidebarProvider);
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "preview:title", title: "feat: example", ticket: "JOLLI-1620" }),
			),
		);
	});

	it("posts preview:tokenStats computed from the conversations snapshot", async () => {
		postMessage.mockClear();
		const sidebarProvider = makeSidebarProvider({
			getConversationsSnapshot: vi.fn().mockResolvedValue([
				{ source: "codex", transcriptPath: "/x.jsonl", sessionId: "s1", isSelected: true },
				// Excluded — filtered out before summing, so totalCount stays 1.
				{ source: "claude", transcriptPath: "/y.jsonl", sessionId: "s2", isSelected: false },
			]),
		});
		await openAndReady(makeBridge(), sidebarProvider);
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "preview:tokenStats", input: 0, output: 0, cached: 0, total: 0, reportingCount: 0, totalCount: 1 }),
			),
		);
	});

	it("re-derives the preview when a file selection is toggled (debounced)", async () => {
		const bridge = makeBridge();
		const sidebarProvider = makeSidebarProvider();
		await openAndReady(bridge, sidebarProvider);
		await vi.waitFor(() => expect(bridge.generateCommitMessageForFiles).toHaveBeenCalled());

		bridge.generateCommitMessageForFiles.mockClear();
		const toggle = { type: "branch:toggleFileSelection", filePath: "/repo/a.ts", selected: false };
		lastPanel().webview.messageHandler(toggle);
		// A second rapid file toggle coalesces into the same debounced refresh (the
		// first pending timer is cleared) rather than firing two LLM calls.
		lastPanel().webview.messageHandler({ type: "branch:toggleFileSelection", filePath: "/repo/b.ts", selected: false });
		// The toggles are forwarded to the host so it updates its selection state...
		expect(sidebarProvider.handleOutbound).toHaveBeenCalledWith(toggle);
		// ...and (after the debounce) the preview is recomputed once against the new set.
		await vi.waitFor(() => expect(bridge.generateCommitMessageForFiles).toHaveBeenCalledTimes(1), { timeout: 2000 });
	});

	it("refreshes only the token meter on a conversation toggle — never the LLM title", async () => {
		const bridge = makeBridge();
		const sidebarProvider = makeSidebarProvider();
		await openAndReady(bridge, sidebarProvider);
		await vi.waitFor(() => expect(bridge.generateCommitMessageForFiles).toHaveBeenCalled());

		bridge.generateCommitMessageForFiles.mockClear();
		postMessage.mockClear();
		// Conversations only feed the token meter. Toggling one must not re-run the
		// non-deterministic LLM title over the (unchanged) file set — that would flip
		// the "Proposed title" for an action that never touched the title's input.
		lastPanel().webview.messageHandler({ type: "branch:toggleConversationSelection", source: "claude", sessionId: "s1", selected: false });
		await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:tokenStats" })));
		expect(bridge.generateCommitMessageForFiles).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title" }));
	});

	it("recomputes the detected ticket on a reference toggle via preview:ticket, without the LLM title", async () => {
		const bridge = makeBridge();
		const sidebarProvider = makeSidebarProvider({
			getPlansSnapshot: vi.fn().mockReturnValue([
				{ id: "r1", label: "JOLLI-1620 · Sidebar UX redesign", contextValue: "reference", isSelected: true },
			]),
		});
		await openAndReady(bridge, sidebarProvider);
		await vi.waitFor(() => expect(bridge.generateCommitMessageForFiles).toHaveBeenCalled());

		bridge.generateCommitMessageForFiles.mockClear();
		postMessage.mockClear();
		lastPanel().webview.messageHandler({ type: "branch:toggleReferenceSelection", mapKey: "r1", selected: true });
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:ticket", ticket: "JOLLI-1620" })),
		);
		// The ticket is a cheap lookup — it must not drag the LLM title along.
		expect(bridge.generateCommitMessageForFiles).not.toHaveBeenCalled();
	});

	it("posts preview:ticket with no ticket field when no reference is selected (clears the line)", async () => {
		const sidebarProvider = makeSidebarProvider({
			// A deselected reference is skipped by findTicketInContext, so the ticket
			// resolves to undefined and the message omits the `ticket` key.
			getPlansSnapshot: vi.fn().mockReturnValue([
				{ id: "r1", label: "JOLLI-1620 · Sidebar UX redesign", contextValue: "reference", isSelected: false },
			]),
		});
		await openAndReady(makeBridge(), sidebarProvider);
		postMessage.mockClear();
		lastPanel().webview.messageHandler({ type: "branch:toggleReferenceSelection", mapKey: "r1", selected: false });
		await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:ticket" })));
		const call = postMessage.mock.calls.find((c) => (c[0] as { type?: string }).type === "preview:ticket");
		expect(call?.[0]).not.toHaveProperty("ticket");
	});

	it("clears a pending debounced refresh when the panel is disposed", async () => {
		const bridge = makeBridge();
		const sidebarProvider = makeSidebarProvider();
		await openAndReady(bridge, sidebarProvider);
		await vi.waitFor(() => expect(bridge.generateCommitMessageForFiles).toHaveBeenCalled());
		// Toggle schedules a debounced refresh; disposing before it fires must
		// clear the pending timer (no refresh against a torn-down panel).
		lastPanel().webview.messageHandler({ type: "branch:toggleFileSelection", filePath: "/repo/a.ts", selected: false });
		lastPanel().onDispose();
		expect(sidebarProvider.unregisterBroadcastTarget).toHaveBeenCalled();
	});

	it("intercepts the regenerate command and re-pushes preview:title without forwarding to handleOutbound", async () => {
		const bridge = makeBridge();
		const sidebarProvider = makeSidebarProvider();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", bridge as never, sidebarProvider as never);
		const panelInstance = createWebviewPanel.mock.results[createWebviewPanel.mock.results.length - 1].value;

		bridge.generateCommitMessageForFiles.mockClear();
		postMessage.mockClear();
		panelInstance.webview.messageHandler({ type: "command", command: "jollimemory.regenerateNextMemoryTitle" });

		await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "preview:title" })));
		expect(bridge.generateCommitMessageForFiles).toHaveBeenCalledTimes(1);
		// The regenerate command is intercepted, never forwarded as a generic message.
		expect(sidebarProvider.handleOutbound).not.toHaveBeenCalled();
	});

	it("forwards every other message to the sidebar provider's handleOutbound", async () => {
		const sidebarProvider = makeSidebarProvider();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, sidebarProvider as never);
		const panelInstance = createWebviewPanel.mock.results[createWebviewPanel.mock.results.length - 1].value;

		const toggle = { type: "branch:togglePlanSelection", planId: "p1", selected: false };
		panelInstance.webview.messageHandler(toggle);
		expect(sidebarProvider.handleOutbound).toHaveBeenCalledWith(toggle);
	});
});

describe("NextMemoryPreviewPanel — context relevance overlay", () => {
	it("ranks against selected files, persists the result, and posts context:relevance", async () => {
		postMessage.mockClear();
		detectPlansMock.mockResolvedValue([{ slug: "p1", title: "P1" }]);
		assessMock.mockResolvedValue({
			plans: [],
			notes: [],
			references: [],
			excludedContext: [{ kind: "plan", key: "p1", title: "P1", reason: "unrelated" }],
			results: [
				{ id: "p1", kind: "plan", relevant: false, score: 0.1, tier: "low", reason: "unrelated", rank: 1, autoExclude: true },
			],
		});
		const sidebar = makeSidebarProvider({
			getFilesSnapshot: vi.fn().mockReturnValue([{ id: "f1", description: "src/a.ts", isSelected: true }]),
		});
		await openAndReady(makeBridge(), sidebar);
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "context:relevance",
					items: [expect.objectContaining({ id: "p1", tier: "low", autoExclude: true })],
				}),
			),
		);
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "context:analyzing", analyzing: true }));
		// Persisted for the post-commit worker to reuse — ONE list carrying every
		// item's full verdict (tier + reason + the AI's exclude decision).
		expect(writeAiMock).toHaveBeenCalledWith(
			"/repo",
			[{ kind: "plans", key: "p1", tier: "low", reason: "unrelated", excluded: true }],
			"fp",
		);
		// The overlay is mirrored to the sidebar (view-only push) so its CONTEXT
		// rows strike through in sync.
		expect(sidebar.pushContextRelevanceToSidebar).toHaveBeenCalledWith([
			expect.objectContaining({ id: "p1", autoExclude: true }),
		]);
	});

	it("does not persist fabricated empty-reason verdicts (fail-open keepAll)", async () => {
		postMessage.mockClear();
		writeAiMock.mockClear();
		detectPlansMock.mockResolvedValue([{ slug: "p1", title: "P1" }]);
		// keepAll shape: every item tier:"mid", reason:"", autoExclude:false — not a
		// real verdict (fail-open keeps everything without labeling it).
		assessMock.mockResolvedValue({
			plans: [{ slug: "p1", title: "P1" }],
			notes: [],
			references: [],
			excludedContext: [],
			results: [
				{ id: "p1", kind: "plan", relevant: true, score: 0, tier: "mid", reason: "", rank: 1, autoExclude: false },
			],
		});
		const sidebar = makeSidebarProvider({
			getFilesSnapshot: vi.fn().mockReturnValue([{ id: "f1", description: "src/a.ts", isSelected: true }]),
		});
		await openAndReady(makeBridge(), sidebar);
		await vi.waitFor(() => expect(writeAiMock).toHaveBeenCalled());
		// The fabricated empty-reason KEEP entries are filtered to nothing — the
		// reuse path must not stamp a fabricated tier onto the artifact.
		expect(writeAiMock).toHaveBeenCalledWith("/repo", [], "fp");
	});

	it("persists an auto-excluded item even when its reason is empty (low tier, no reason)", async () => {
		postMessage.mockClear();
		writeAiMock.mockClear();
		detectPlansMock.mockResolvedValue([{ slug: "p1", title: "P1" }]);
		// A real exclude verdict the model gave WITHOUT a reason (tier low +
		// autoExclude, reason ""). It must still persist as excluded — otherwise the
		// reuse path would KEEP an item the fresh (assessContextRelevance) path drops,
		// diverging the two paths' excluded sets. Distinct from the keepAll case
		// above (which is autoExclude:false and correctly filtered out).
		assessMock.mockResolvedValue({
			plans: [],
			notes: [],
			references: [],
			excludedContext: [{ kind: "plan", key: "p1", title: "P1", reason: "" }],
			results: [
				{ id: "p1", kind: "plan", relevant: false, score: 0.2, tier: "low", reason: "", rank: 1, autoExclude: true },
			],
		});
		const sidebar = makeSidebarProvider({
			getFilesSnapshot: vi.fn().mockReturnValue([{ id: "f1", description: "src/a.ts", isSelected: true }]),
		});
		await openAndReady(makeBridge(), sidebar);
		await vi.waitFor(() => expect(writeAiMock).toHaveBeenCalled());
		expect(writeAiMock).toHaveBeenCalledWith(
			"/repo",
			[{ kind: "plans", key: "p1", tier: "low", reason: "", excluded: true }],
			"fp",
		);
	});

	it("getRelevanceCacheItems exposes the cached ranking; dismiss updates it in place", async () => {
		postMessage.mockClear();
		detectPlansMock.mockResolvedValue([{ slug: "p1", title: "P1" }]);
		assessMock.mockResolvedValue({
			plans: [],
			notes: [],
			references: [],
			excludedContext: [{ kind: "plan", key: "p1", title: "P1", reason: "unrelated" }],
			results: [
				{ id: "p1", kind: "plan", relevant: false, score: 0.1, tier: "low", reason: "unrelated", rank: 1, autoExclude: true },
			],
		});
		const sidebar = makeSidebarProvider({
			getFilesSnapshot: vi.fn().mockReturnValue([{ id: "f1", description: "src/a.ts", isSelected: true }]),
		});
		await openAndReady(makeBridge(), sidebar);
		await vi.waitFor(() =>
			expect(NextMemoryPreviewPanel.getRelevanceCacheItems()).toEqual([
				expect.objectContaining({ id: "p1", autoExclude: true }),
			]),
		);
		// The host's dismiss handler reads this to re-push the post-dismiss
		// overlay to both surfaces — it must reflect the dismissal immediately,
		// with the AI's ORIGINAL tier + reason preserved (a dismiss vetoes only
		// the exclude action, never the verdict).
		NextMemoryPreviewPanel.dismissInRelevanceCache("p1");
		expect(NextMemoryPreviewPanel.getRelevanceCacheItems()).toEqual([
			{ id: "p1", tier: "low", reason: "unrelated", autoExclude: false },
		]);
	});

	it("posts an empty context:relevance (no LLM) when no files are selected", async () => {
		postMessage.mockClear();
		assessMock.mockClear();
		const sidebar = makeSidebarProvider();
		await openAndReady(makeBridge(), sidebar);
		await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "context:relevance", items: [] }));
		expect(assessMock).not.toHaveBeenCalled();
		// The sidebar overlay is cleared too.
		expect(sidebar.pushContextRelevanceToSidebar).toHaveBeenCalledWith([]);
	});

	it("reuses the cached ranking on reopen (same files + items) — no second LLM call", async () => {
		postMessage.mockClear();
		assessMock.mockClear();
		detectPlansMock.mockResolvedValue([{ slug: "p1", title: "P1" }]);
		assessMock.mockResolvedValue({
			plans: [],
			notes: [],
			references: [],
			excludedContext: [],
			results: [{ id: "p1", kind: "plan", relevant: true, score: 0.9, tier: "high", reason: "related", rank: 1, autoExclude: false }],
		});
		const sidebar = makeSidebarProvider({
			getFilesSnapshot: vi.fn().mockReturnValue([{ id: "f1", description: "src/a.ts", isSelected: true }]),
		});
		await openAndReady(makeBridge(), sidebar);
		await vi.waitFor(() => expect(assessMock).toHaveBeenCalledTimes(1));
		// Reopen the panel (existed branch → refreshPreview → pushContextRelevance) with
		// the SAME files + items: the ranking is served from cache — no second LLM call,
		// no "Analyzing…" flash.
		assessMock.mockClear();
		postMessage.mockClear();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, sidebar as never);
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "context:relevance",
					items: [expect.objectContaining({ id: "p1", tier: "high" })],
				}),
			),
		);
		expect(assessMock).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "context:analyzing", analyzing: true }));
		// The cache-hit path mirrors to the sidebar too — a reopened panel must not
		// leave the sidebar's strikethroughs stale.
		expect(sidebar.pushContextRelevanceToSidebar).toHaveBeenCalledWith([
			expect.objectContaining({ id: "p1", tier: "high" }),
		]);
	});

	it("dismiss updates the cached ranking in place — reopen keeps it dismissed, no re-rank", async () => {
		postMessage.mockClear();
		assessMock.mockClear();
		detectPlansMock.mockResolvedValue([{ slug: "p1", title: "P1" }]);
		assessMock.mockResolvedValue({
			plans: [],
			notes: [],
			references: [],
			excludedContext: [{ kind: "plan", key: "p1", title: "P1", reason: "unrelated" }],
			results: [{ id: "p1", kind: "plan", relevant: false, score: 0.1, tier: "low", reason: "unrelated", rank: 1, autoExclude: true }],
		});
		const sidebar = makeSidebarProvider({
			getFilesSnapshot: vi.fn().mockReturnValue([{ id: "f1", description: "src/a.ts", isSelected: true }]),
		});
		await openAndReady(makeBridge(), sidebar);
		await vi.waitFor(() => expect(assessMock).toHaveBeenCalledTimes(1));
		// User dismisses p1: the cache is updated IN PLACE (not invalidated), so reopening
		// hits the cache — no re-rank / "Analyzing…" — and p1 comes back non-excluded.
		NextMemoryPreviewPanel.dismissInRelevanceCache("p1");
		assessMock.mockClear();
		postMessage.mockClear();
		await NextMemoryPreviewPanel.show("file:///ext" as never, "/repo", makeBridge() as never, sidebar as never);
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "context:relevance",
					items: [expect.objectContaining({ id: "p1", autoExclude: false })],
				}),
			),
		);
		expect(assessMock).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "context:analyzing", analyzing: true }));
	});
});
