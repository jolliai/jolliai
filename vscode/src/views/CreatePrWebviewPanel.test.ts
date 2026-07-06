import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handleCreatePr: vi.fn().mockResolvedValue("succeeded"),
	handleUpdatePrWithPush: vi.fn().mockResolvedValue("succeeded"),
	findOpenPrForBranch: vi.fn().mockResolvedValue(undefined),
	isWorkerBlockingBusy: vi.fn().mockResolvedValue(false),
	buildCreatePrViewModel: vi.fn().mockResolvedValue({
		branch: "feature/x", mainBranch: "main", memoryCount: 1, missingCount: 0,
		insertions: 1, deletions: 0, filesChanged: 1, title: "feat: x", bodyMarkdown: "B",
		memories: [{ hash: "h", title: "t" }], files: [], e2eScenarios: [],
	}),
	pushBranchMemories: vi.fn().mockResolvedValue({ pushedCount: 2, attachmentCount: 0, attachmentFailures: [], summaryFailures: [] }),
	openAndAwait: vi.fn().mockResolvedValue({ kind: "selected" }),
	parseJolliApiKey: vi.fn(() => ({ u: "https://acme.jolli.ai" })),
	loadGlobalConfig: vi.fn().mockResolvedValue({ jolliApiKey: "sk-jol-x" }),
}));

/** Awaits pending microtasks (e.g. the fire-and-forget push chained after createPr resolves). */
const flush = () => new Promise((r) => setTimeout(r, 0));

const created: Array<{
	html: string;
	onMsg: (m: unknown) => void;
	onDispose: () => void;
	reveal: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	webview: { html: string; cspSource: string; asWebviewUri: (u: { toString(): string }) => { toString(): string }; postMessage: ReturnType<typeof vi.fn>; onDidReceiveMessage: (cb: (m: unknown) => void) => { dispose: () => void } };
}> = [];
vi.mock("vscode", () => ({
	ViewColumn: { One: 1, Active: -1 },
	Uri: {
		file: (p: string) => ({ scheme: "file", fsPath: p, toString: () => `file://${p}` }),
		parse: (s: string) => ({
			scheme: (s.match(/^([a-z][a-z0-9+.-]*):/i)?.[1] ?? "file").toLowerCase(),
			toString: () => s,
			value: s,
		}),
		joinPath: (base: { fsPath: string }, ...segs: Array<string>) => {
			const fsPath = [base.fsPath.replace(/\/$/, ""), ...segs].join("/");
			return { scheme: "file", fsPath, toString: () => `file://${fsPath}` };
		},
		from: (parts: { scheme: string; path?: string; query?: string }) => ({
			scheme: parts.scheme,
			path: parts.path ?? "",
			query: parts.query ?? "",
			toString: () => `${parts.scheme}:${parts.path ?? ""}${parts.query ? `?${parts.query}` : ""}`,
		}),
	},
	env: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() },
	window: {
		createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		createWebviewPanel: vi.fn(() => {
			const rec = {
				html: "",
				reveal: vi.fn(),
				dispose: vi.fn(),
				onMsg: (_: unknown) => {},
				onDispose: () => {},
				webview: {
					html: "",
					cspSource: "vscode-webview://test",
					asWebviewUri: (u: { toString(): string }) => u,
					postMessage: vi.fn(),
					onDidReceiveMessage: (cb: (m: unknown) => void) => {
						rec.onMsg = cb;
						return { dispose() {} };
					},
				},
				onDidDispose: (cb: () => void) => {
					rec.onDispose = cb;
					return { dispose() {} };
				},
			};
			created.push(rec as never);
			return rec;
		}),
	},
	commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
	workspace: {
		registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
	},
}));

vi.mock("../services/PrCommentService.js", () => ({
	handleCreatePr: mocks.handleCreatePr,
	handleUpdatePrWithPush: mocks.handleUpdatePrWithPush,
	findOpenPrForBranch: mocks.findOpenPrForBranch,
	// The panel's initial load calls this (open PR + closed/merged history);
	// the post-create refresh still uses findOpenPrForBranch. Delegate to the
	// existing findOpenPrForBranch mock so per-test `mockResolvedValueOnce`
	// setups keep driving the open-PR half; history defaults to empty here and
	// is exercised directly in CreatePrHtmlBuilder's tests.
	findPrWithHistoryForBranch: vi.fn(async (cwd: string, branch: string) => {
		const existingPr = await mocks.findOpenPrForBranch(cwd, branch);
		return { existingPr: existingPr ?? undefined, history: [] };
	}),
}));
vi.mock("./CreatePrData", () => ({ buildCreatePrViewModel: mocks.buildCreatePrViewModel }));
vi.mock("../util/LockUtils.js", () => ({ isWorkerBlockingBusy: mocks.isWorkerBlockingBusy }));
vi.mock("../util/Logger.js", () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), show: vi.fn(), dispose: vi.fn() },
	initLogger: vi.fn(),
}));
vi.mock("../services/LiveShareController.js", () => ({ pushBranchMemoriesToSpace: mocks.pushBranchMemories }));
vi.mock("../services/JolliPushOrchestrator.js", () => ({
	ShareBindingError: class ShareBindingError extends Error {
		constructor(readonly outcome: string) {
			super(outcome);
			this.name = "ShareBindingError";
		}
	},
}));
vi.mock("../services/JolliPushService.js", () => ({
	parseJolliApiKey: mocks.parseJolliApiKey,
	PluginOutdatedError: class PluginOutdatedError extends Error {},
}));
vi.mock("../util/WorkspaceUtils.js", () => ({ loadGlobalConfig: mocks.loadGlobalConfig }));
vi.mock("../util/GitRemoteUtils.js", () => ({
	deriveRepoNameFromUrl: () => "repo",
	getCanonicalRepoUrl: vi.fn().mockResolvedValue("https://github.com/acme/repo"),
}));
vi.mock("./BindingChooserWebviewPanel.js", () => ({
	BindingChooserWebviewPanel: { openAndAwait: mocks.openAndAwait, dispose: vi.fn() },
}));

import { CreatePrWebviewPanel } from "./CreatePrWebviewPanel.js";

const uri = { fsPath: "/ext" } as never;
const bridge = {
	getCurrentBranch: vi.fn().mockResolvedValue("feature/x"),
	getCwd: () => "/repo",
	storeSummary: vi.fn(),
	getBranchDiffBase: vi.fn().mockResolvedValue("basehash"),
	readFileAtRef: vi.fn().mockResolvedValue(""),
} as never;

beforeEach(() => {
	created.length = 0;
	CreatePrWebviewPanel.dispose();
	vi.clearAllMocks();
	mocks.isWorkerBlockingBusy.mockResolvedValue(false);
	mocks.handleCreatePr.mockResolvedValue("succeeded");
	mocks.handleUpdatePrWithPush.mockResolvedValue("succeeded");
	mocks.pushBranchMemories.mockResolvedValue({ pushedCount: 2, attachmentCount: 0, attachmentFailures: [], summaryFailures: [] });
	mocks.openAndAwait.mockResolvedValue({ kind: "selected" });
	mocks.parseJolliApiKey.mockReturnValue({ u: "https://acme.jolli.ai" });
	mocks.loadGlobalConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
	mocks.buildCreatePrViewModel.mockResolvedValue({
		branch: "feature/x", mainBranch: "main", memoryCount: 1, missingCount: 0,
		insertions: 1, deletions: 0, filesChanged: 1, title: "feat: x", bodyMarkdown: "B",
		memories: [{ hash: "h", title: "t" }], files: [], e2eScenarios: [],
	});
});

describe("CreatePrWebviewPanel", () => {
	it("opens a panel and renders the Create PR HTML", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created).toHaveLength(1);
		expect(created[0].webview.html).toContain("Create Pull Request");
	});

	it("createPr message routes to handleCreatePr with title+wrapped body", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "createPr" });
		await Promise.resolve(); await Promise.resolve();
		expect(mocks.handleCreatePr).toHaveBeenCalledTimes(1);
		expect(mocks.handleCreatePr.mock.calls[0][0]).toBe("feat: x"); // title
		expect(mocks.handleCreatePr.mock.calls[0][1]).toContain("B"); // wrapped body contains drafted bodyMarkdown
		expect(mocks.handleCreatePr.mock.calls[0][4]).toBe("feature/x"); // branch arg
	});

	it("createPr: the post callback passed to handleCreatePr forwards messages to the webview", async () => {
		// Replace the mock so we can capture and invoke the `post` callback directly.
		mocks.handleCreatePr.mockImplementationOnce(
			async (
				_title: unknown,
				_body: unknown,
				_cwd: unknown,
				postFn: (msg: Record<string, unknown>) => void,
			) => {
				postFn({ command: "prCreated", prUrl: "https://github.com/example/1" });
			},
		);
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "createPr" });
		await Promise.resolve(); await Promise.resolve();
		expect(created[0].webview.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ command: "prCreated" }),
		);
	});

	it("createPr with edited title/body overrides the drafted values", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "createPr", title: "edited title", body: "edited body" });
		await Promise.resolve(); await Promise.resolve();
		expect(mocks.handleCreatePr.mock.calls[0][0]).toBe("edited title");
		expect(mocks.handleCreatePr.mock.calls[0][1]).toContain("edited body");
	});

	it("copyBody writes the wrapped markdown to the clipboard", async () => {
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "copyBody" });
		await Promise.resolve();
		expect((vscode.env.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
	});

	it("is a singleton — second show reveals, not re-creates", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created).toHaveLength(1);
		expect(created[0].reveal).toHaveBeenCalled();
	});

	it("worker-busy guard: shows toast and skips handleCreatePr when worker is blocking", async () => {
		mocks.isWorkerBlockingBusy.mockResolvedValue(true);
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "createPr" });
		await Promise.resolve(); await Promise.resolve();
		expect(mocks.handleCreatePr).not.toHaveBeenCalled();
		expect(vscode.window.showWarningMessage).toHaveBeenCalled();
		// The webview disabled its submit buttons on click; the busy early-return
		// must post a settling message so they re-enable and a retry is possible.
		expect(created[0].webview.postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
	});

	it("worker-busy guard: update path also posts a settling message (buttons re-enable)", async () => {
		mocks.findOpenPrForBranch.mockResolvedValueOnce({ number: 7, url: "https://gh/pr/7" });
		mocks.isWorkerBlockingBusy.mockResolvedValue(true);
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "createPr" });
		await Promise.resolve(); await Promise.resolve();
		expect(mocks.handleUpdatePrWithPush).not.toHaveBeenCalled();
		expect(mocks.handleCreatePr).not.toHaveBeenCalled();
		expect(created[0].webview.postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
	});

	it("empty guard: shows info message and does NOT open panel when VM is empty", async () => {
		mocks.buildCreatePrViewModel.mockResolvedValueOnce({ empty: true });
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created).toHaveLength(0);
		expect(vscode.window.showInformationMessage).toHaveBeenCalled();
	});

	it("openMemory: executes jollimemory.viewMemorySummary with the message hash", async () => {
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openMemory", hash: "abc123def456" });
		await Promise.resolve();
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"jollimemory.viewMemorySummary",
			"abc123def456",
		);
	});

	it("openDiff: opens a base..HEAD diff (base + HEAD virtual URIs) for the given path", async () => {
		const vscode = await import("vscode");
		(bridge as { getBranchDiffBase: ReturnType<typeof vi.fn> }).getBranchDiffBase.mockResolvedValueOnce("basehash");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "vscode/src/a.ts" });
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.diff",
			// Left = base commit, right = HEAD; both jolli-prdiff URIs carrying the path + ref.
			expect.objectContaining({ scheme: "jolli-prdiff", path: "/vscode/src/a.ts", query: "ref=basehash" }),
			expect.objectContaining({ scheme: "jolli-prdiff", path: "/vscode/src/a.ts", query: "ref=HEAD" }),
			expect.stringContaining("a.ts"),
		);
		// The read-only virtual-doc diff never falls back to opening the working-tree file.
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
	});

	it("openDiff: reads the base (left) side from oldPath for a rename, HEAD (right) from the new path", async () => {
		const vscode = await import("vscode");
		(bridge as { getBranchDiffBase: ReturnType<typeof vi.fn> }).getBranchDiffBase.mockResolvedValueOnce("basehash");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "vscode/src/new.ts", oldPath: "vscode/src/old.ts" });
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.diff",
			// Left = base commit at the OLD path (where the content lived), not the new path.
			expect.objectContaining({ scheme: "jolli-prdiff", path: "/vscode/src/old.ts", query: "ref=basehash" }),
			expect.objectContaining({ scheme: "jolli-prdiff", path: "/vscode/src/new.ts", query: "ref=HEAD" }),
			expect.stringContaining("new.ts"),
		);
	});

	it("openDiff: rejects a rename whose oldPath escapes the workspace via ../", async () => {
		const vscode = await import("vscode");
		const logMod = await import("../util/Logger.js");
		// No getBranchDiffBase mock: the traversal guard rejects before it is reached.
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "vscode/src/new.ts", oldPath: "../../etc/passwd" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
			"vscode.diff",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
		expect(logMod.log.warn as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
			"CreatePrPanel",
			expect.stringContaining("oldPath outside workspace"),
		);
	});

	it("registers a jolli-prdiff content provider whose reader delegates to bridge.readFileAtRef", async () => {
		const vscode = await import("vscode");
		(bridge as { readFileAtRef: ReturnType<typeof vi.fn> }).readFileAtRef.mockResolvedValueOnce("BODY");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		const reg = vscode.workspace.registerTextDocumentContentProvider as ReturnType<typeof vi.fn>;
		const [scheme, provider] = reg.mock.calls[0] as [string, { provideTextDocumentContent: (u: unknown) => Promise<string> }];
		expect(scheme).toBe("jolli-prdiff");
		const body = await provider.provideTextDocumentContent({ path: "/vscode/src/a.ts", query: "ref=HEAD" });
		expect(body).toBe("BODY");
		expect((bridge as { readFileAtRef: ReturnType<typeof vi.fn> }).readFileAtRef).toHaveBeenCalledWith("HEAD", "vscode/src/a.ts");
	});

	it("openDiff: falls back to opening the working-tree file when no diff base resolves", async () => {
		const vscode = await import("vscode");
		(bridge as { getBranchDiffBase: ReturnType<typeof vi.fn> }).getBranchDiffBase.mockResolvedValueOnce(undefined);
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "vscode/src/a.ts" });
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			// Repo-relative path resolved against the workspace root ("/repo").
			expect.objectContaining({ fsPath: "/repo/vscode/src/a.ts" }),
		);
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("vscode.diff", expect.anything(), expect.anything(), expect.anything());
	});

	it("openDiff: rejects a path that escapes the workspace via ../ and never opens it", async () => {
		const vscode = await import("vscode");
		const logMod = await import("../util/Logger.js");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "../../etc/passwd" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
			"vscode.diff",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
		expect((logMod.log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			"CreatePrPanel",
			expect.stringContaining("outside workspace"),
		);
	});

	it("openDiff: rejects an absolute path outside the workspace", async () => {
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "/etc/passwd" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("vscode.open", expect.anything());
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
			"vscode.diff",
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it("openDiff: swallows Error instances from vscode.diff via the rejection handler without re-throwing", async () => {
		const vscode = await import("vscode");
		const logMod = await import("../util/Logger.js");
		(bridge as { getBranchDiffBase: ReturnType<typeof vi.fn> }).getBranchDiffBase.mockResolvedValueOnce("basehash");
		(vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("diff failed"),
		);
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "missing/file.ts" });
		// Drain all microtasks until the rejection handler has run.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.diff",
			expect.objectContaining({ scheme: "jolli-prdiff" }),
			expect.objectContaining({ scheme: "jolli-prdiff" }),
			expect.any(String),
		);
		expect((logMod.log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			"CreatePrPanel",
			expect.stringContaining("diff failed"),
		);
	});

	it("openDiff: swallows non-Error rejections from the fallback via the rejection handler", async () => {
		const vscode = await import("vscode");
		const logMod = await import("../util/Logger.js");
		// No diff base → working-tree fallback; reject with a plain string (not an
		// Error) to cover the String(e) branch of the fallback's rejection handler.
		(bridge as { getBranchDiffBase: ReturnType<typeof vi.fn> }).getBranchDiffBase.mockResolvedValueOnce(undefined);
		(vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			"permission denied",
		);
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "another/file.ts" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect((logMod.log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			"CreatePrPanel",
			expect.stringContaining("permission denied"),
		);
	});

	it("update mode: when an open PR exists, the panel renders Update PR and routes to handleUpdatePrWithPush", async () => {
		mocks.findOpenPrForBranch.mockResolvedValueOnce({ number: 7, url: "https://gh/pr/7" });
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created[0].webview.html).toContain("Update Pull Request");
		expect(created[0].webview.html).toContain("PR #7");

		created[0].onMsg({ command: "createPr" });
		await Promise.resolve(); await Promise.resolve();
		expect(mocks.handleUpdatePrWithPush).toHaveBeenCalledTimes(1);
		expect(mocks.handleCreatePr).not.toHaveBeenCalled();
	});

	it("create mode (no open PR): routes to handleCreatePr, not handleUpdatePrWithPush", async () => {
		mocks.findOpenPrForBranch.mockResolvedValueOnce(undefined);
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "createPr" });
		await Promise.resolve(); await Promise.resolve();
		expect(mocks.handleCreatePr).toHaveBeenCalledTimes(1);
		expect(mocks.handleUpdatePrWithPush).not.toHaveBeenCalled();
	});

	it("existing-PR lookup failure: logs a warning and falls back to create mode", async () => {
		const logMod = await import("../util/Logger.js");
		mocks.findOpenPrForBranch.mockRejectedValueOnce(new Error("gh not installed"));
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created[0].webview.html).toContain("Create Pull Request");
		expect((logMod.log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			"CreatePrPanel",
			expect.stringContaining("gh not installed"),
		);
		created[0].onMsg({ command: "createPr" });
		await Promise.resolve(); await Promise.resolve();
		expect(mocks.handleCreatePr).toHaveBeenCalledTimes(1);
	});

	it("existing-PR lookup failure (non-Error): stringifies the reason in the warning and falls back to create mode", async () => {
		const logMod = await import("../util/Logger.js");
		// Reject with a plain string (not an Error) to cover the String(e) arm of
		// the `e instanceof Error ? e.message : String(e)` ternary.
		mocks.findOpenPrForBranch.mockRejectedValueOnce("gh exploded");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created[0].webview.html).toContain("Create Pull Request");
		expect((logMod.log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			"CreatePrPanel",
			expect.stringContaining("gh exploded"),
		);
	});

	it("openPr: opens the PR url externally", async () => {
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openPr", url: "https://gh/pr/7" });
		await Promise.resolve();
		expect(vscode.env.openExternal).toHaveBeenCalled();
	});

	it("openPr: rejects a non-http(s) scheme (file:) and never opens it", async () => {
		const vscode = await import("vscode");
		const logMod = await import("../util/Logger.js");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openPr", url: "file:///etc/passwd" });
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(vscode.env.openExternal).not.toHaveBeenCalled();
		expect((logMod.log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			"CreatePrPanel",
			expect.stringContaining("non-http(s)"),
		);
	});

	it("in-flight guard: a second createPr while the first is still awaiting posts prCreateFailed and does not double-dispatch", async () => {
		// The webview's own inFlight flag is reset by a re-render (re-running the
		// command), so only the host-side lock prevents a concurrent push + duplicate
		// PR. Hold the first handleCreatePr pending, fire a second createPr, and
		// assert it never reaches handleCreatePr a second time.
		let releaseFirst: () => void = () => {};
		const pending = new Promise<void>((resolve) => {
			releaseFirst = () => resolve();
		});
		mocks.handleCreatePr.mockReturnValueOnce(pending);
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "createPr" });
		created[0].onMsg({ command: "createPr" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(mocks.handleCreatePr).toHaveBeenCalledTimes(1);
		expect(created[0].webview.postMessage).toHaveBeenCalledWith({ command: "prCreateFailed" });
		// Release the first call; the lock clears so a later createPr works again.
		releaseFirst();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		created[0].onMsg({ command: "createPr" });
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(mocks.handleCreatePr).toHaveBeenCalledTimes(2);
	});

	it("signIn message: executes the jollimemory.signIn command", async () => {
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "signIn" });
		await Promise.resolve();
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("jollimemory.signIn");
	});

	it("signedIn=true: renders the signed-in confirmation notice (signed-out variant hidden)", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main", true);
		expect(created[0].webview.html).toContain(
			"creating this PR also shares the included memories to your Jolli Space",
		);
		expect(created[0].webview.html).toContain('class="share-signed-out hidden"');
	});

	it("signedIn defaults to false: renders the Sign In link (signed-in variant hidden)", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created[0].webview.html).toContain('id="pr-signin-link"');
		expect(created[0].webview.html).toContain('class="share-signed-in hidden"');
	});

	it("notifyAuthChanged: posts an authChanged message to the open panel", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		CreatePrWebviewPanel.notifyAuthChanged(true);
		expect(created[0].webview.postMessage).toHaveBeenCalledWith({
			command: "authChanged",
			authenticated: true,
		});
	});

	it("notifyAuthChanged: no-op when no panel is open (does not throw)", () => {
		// Singleton was disposed in beforeEach — the optional-chain guard makes this
		// a safe no-op rather than a null dereference.
		expect(() => CreatePrWebviewPanel.notifyAuthChanged(false)).not.toThrow();
	});

	it("onDidDispose: clears the singleton so the next show() creates a new panel", async () => {
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created).toHaveLength(1);
		// Simulate VS Code disposing the panel (e.g. user closes the tab).
		created[0].onDispose();
		// Now show() must create a fresh panel, not reveal the disposed one.
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		expect(created).toHaveLength(2);
	});
});

describe("push memories to Space after a successful submit", () => {
	it("pushes when signed in and the submit succeeds", async () => {
		mocks.handleCreatePr.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ true);
		await created[0].onMsg({ command: "createPr" });
		await flush(); // await microtasks
		expect(mocks.pushBranchMemories).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceRoot: "/repo", apiKey: "sk-jol-x" }),
			"feature/x",
		);
	});

	it("pushes on the update path too (when signed in and the update succeeds)", async () => {
		mocks.findOpenPrForBranch.mockResolvedValueOnce({ number: 7, url: "https://gh/pr/7" });
		mocks.handleUpdatePrWithPush.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ true);
		await created[0].onMsg({ command: "createPr" });
		await flush(); // await microtasks
		expect(mocks.handleUpdatePrWithPush).toHaveBeenCalledTimes(1);
		expect(mocks.pushBranchMemories).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceRoot: "/repo", apiKey: "sk-jol-x" }),
			"feature/x",
		);
	});

	it("does NOT push when signed out", async () => {
		mocks.handleCreatePr.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ false);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(mocks.pushBranchMemories).not.toHaveBeenCalled();
	});

	it("posts a 'Sharing memories' progress line before pushing (keeps buttons disabled through the share)", async () => {
		mocks.handleCreatePr.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(created[0].webview.postMessage).toHaveBeenCalledWith({
			command: "prProgress",
			text: "Sharing memories to your Jolli Space…",
		});
	});

	it("posts prComplete after all steps on the update path (final settle: re-enable + return to view)", async () => {
		mocks.findOpenPrForBranch.mockResolvedValueOnce({ number: 7, url: "https://gh/pr/7" });
		mocks.handleUpdatePrWithPush.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ false);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(created[0].webview.postMessage).toHaveBeenCalledWith({ command: "prComplete" });
	});

	it("does NOT post prComplete when the submit failed (buttons re-enable via prCreateFailed, edit form stays)", async () => {
		mocks.handleCreatePr.mockResolvedValue("failed");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(created[0].webview.postMessage).not.toHaveBeenCalledWith({ command: "prComplete" });
	});

	it("rebuilds the body after the push so freshly-minted memory/context URLs show", async () => {
		// At first render nothing is pushed, so the body has no Jolli Memory link.
		// After the push mints the URLs and persists them, the post-submit refresh
		// rebuilds from storage — buildCreatePrViewModel's second result carries the
		// link, which renderPrBodyMarkdown turns into a clickable <a>.
		const withUrl = {
			branch: "feature/x", mainBranch: "main", memoryCount: 1, missingCount: 0,
			insertions: 1, deletions: 0, filesChanged: 1, title: "feat: x",
			bodyMarkdown: "## Jolli Memory\n\n[https://acme.jolli.ai/articles?doc=99](https://acme.jolli.ai/articles?doc=99)",
			memories: [{ hash: "h", title: "t" }], files: [], e2eScenarios: [],
		};
		mocks.buildCreatePrViewModel
			.mockResolvedValueOnce({ ...withUrl, bodyMarkdown: "B" }) // show(): pre-push, no URL
			.mockResolvedValueOnce(withUrl); // refreshAfterSubmit(): rebuilt with the URL
		mocks.handleCreatePr.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ true);
		expect(created[0].webview.html).not.toContain("articles?doc=99");
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(created[0].webview.html).toContain('href="https://acme.jolli.ai/articles?doc=99"');
	});

	it("re-renders into Update mode after a successful create (flips Create PR → Update PR)", async () => {
		// show() finds no PR (create mode); the post-create refresh finds the new PR.
		mocks.findOpenPrForBranch.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
			number: 42,
			url: "https://gh/pr/42",
		});
		mocks.handleCreatePr.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ false);
		expect(created[0].webview.html).toContain("Create Pull Request");
		await created[0].onMsg({ command: "createPr" });
		await flush();
		// Same singleton panel, HTML re-rendered in Update mode with the PR pill.
		expect(created).toHaveLength(1);
		expect(created[0].webview.html).toContain("Update Pull Request");
		expect(created[0].webview.html).toContain("PR #42");
	});

	it("refreshes the PR pill when an Update falls back to creating a new PR", async () => {
		// show() finds PR #10 → Update mode. If #10 is closed between render and
		// submit, handleUpdatePrWithPush creates a fresh PR and still returns
		// "succeeded". The post-submit refresh must re-resolve and re-render with the
		// NEW PR — the old code gated the refresh on "was this a create?", so the
		// pill stayed pointing at the now-dead #10.
		mocks.findOpenPrForBranch
			.mockResolvedValueOnce({ number: 10, url: "https://gh/pr/10" }) // show() → Update mode
			.mockResolvedValueOnce({ number: 11, url: "https://gh/pr/11" }); // post-submit refresh → new PR
		mocks.handleUpdatePrWithPush.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ false);
		expect(created[0].webview.html).toContain("PR #10");
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(created[0].webview.html).toContain("PR #11");
		expect(created[0].webview.html).not.toContain("PR #10");
	});

	it("stays in Create mode when the post-create PR lookup finds nothing", async () => {
		// Both lookups (show + refresh) return undefined — no re-render into Update.
		mocks.findOpenPrForBranch.mockResolvedValue(undefined);
		mocks.handleCreatePr.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ false);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(created[0].webview.html).toContain("Create Pull Request");
	});

	it("tolerates a failing post-create PR lookup without throwing", async () => {
		// show() succeeds (undefined), the refresh lookup rejects — best-effort:
		// the pane stays as-is and no error escapes.
		mocks.findOpenPrForBranch.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("gh down"));
		mocks.handleCreatePr.mockResolvedValue("succeeded");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", /* signedIn */ false);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(created[0].webview.html).toContain("Create Pull Request");
	});

	it("does NOT push when the submit failed", async () => {
		mocks.handleCreatePr.mockResolvedValue("failed");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(mocks.pushBranchMemories).not.toHaveBeenCalled();
	});

	it("shows a success toast with the pushed count", async () => {
		const vscode = await import("vscode");
		mocks.pushBranchMemories.mockResolvedValue({ pushedCount: 2, attachmentCount: 0, attachmentFailures: [], summaryFailures: [] });
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining("Shared 2 memories to your Jolli Space"),
		);
	});

	it("resolveBinding opens the binding chooser and a selection lets the push proceed", async () => {
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		const deps = mocks.pushBranchMemories.mock.calls[0][0];
		const outcome = await deps.resolveBinding("https://github.com/acme/repo");
		expect(mocks.openAndAwait).toHaveBeenCalled();
		expect(outcome).toEqual({ status: "bound" });
	});

	it("resolveBinding maps the chooser's anotherOpen / cancelled kinds to the matching status", async () => {
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		const deps = mocks.pushBranchMemories.mock.calls[0][0];
		mocks.openAndAwait.mockResolvedValueOnce({ kind: "anotherOpen" });
		expect(await deps.resolveBinding("https://github.com/acme/repo")).toEqual({ status: "anotherOpen" });
		mocks.openAndAwait.mockResolvedValueOnce({ kind: "cancelled" });
		expect(await deps.resolveBinding("https://github.com/acme/repo")).toEqual({ status: "cancelled" });
	});

	it("shows the cancelled-binding error when the push throws ShareBindingError('cancelled')", async () => {
		const vscode = await import("vscode");
		const { ShareBindingError } = await import("../services/JolliPushOrchestrator.js");
		mocks.pushBranchMemories.mockRejectedValue(new ShareBindingError("cancelled"));
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("Push cancelled"),
		);
	});

	it("apiKey-missing guard: warns and does NOT push when no Jolli API Key is configured", async () => {
		const vscode = await import("vscode");
		mocks.loadGlobalConfig.mockResolvedValue({ jolliApiKey: undefined });
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(mocks.pushBranchMemories).not.toHaveBeenCalled();
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("configure your Jolli API Key"),
		);
	});

	it("baseUrl-unresolvable guard: warns and does NOT push when the API key has no site URL", async () => {
		const vscode = await import("vscode");
		mocks.parseJolliApiKey.mockReturnValueOnce(undefined);
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(mocks.pushBranchMemories).not.toHaveBeenCalled();
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("Jolli site URL could not be determined"),
		);
	});

	it("partial attachment failures: shows a modal warning listing the failed attachment", async () => {
		const vscode = await import("vscode");
		mocks.pushBranchMemories.mockResolvedValue({
			pushedCount: 2,
			attachmentCount: 0,
			attachmentFailures: [{ label: 'plan "x"', message: "unreadable" }],
			summaryFailures: [],
		});
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("1 attachment(s) failed to push"),
			expect.objectContaining({ modal: true, detail: expect.stringContaining("unreadable") }),
		);
	});

	it("partial memory failures: reports shared count plus the failed memories in the modal", async () => {
		const vscode = await import("vscode");
		mocks.pushBranchMemories.mockResolvedValue({
			pushedCount: 2,
			attachmentCount: 0,
			attachmentFailures: [],
			summaryFailures: [{ label: 'memory "fix: y"', message: "HTTP 500" }],
		});
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("Shared 2 memories"),
			expect.objectContaining({ modal: true, detail: expect.stringContaining("HTTP 500") }),
		);
	});

	it("shows the another-open info when the push throws ShareBindingError('anotherOpen')", async () => {
		const vscode = await import("vscode");
		const { ShareBindingError } = await import("../services/JolliPushOrchestrator.js");
		mocks.pushBranchMemories.mockRejectedValue(new ShareBindingError("anotherOpen"));
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining("A Memory space chooser is already open"),
		);
	});

	it("shows the bind-failed error when the push throws ShareBindingError('failed')", async () => {
		const vscode = await import("vscode");
		const { ShareBindingError } = await import("../services/JolliPushOrchestrator.js");
		mocks.pushBranchMemories.mockRejectedValue(new ShareBindingError("failed"));
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("could not bind a Memory space"),
		);
	});

	it("shows the outdated-plugin modal error when the push throws PluginOutdatedError", async () => {
		const vscode = await import("vscode");
		const { PluginOutdatedError } = await import("../services/JolliPushService.js");
		mocks.pushBranchMemories.mockRejectedValue(new PluginOutdatedError("stale"));
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("plugin is outdated"),
			expect.objectContaining({ modal: true }),
		);
	});

	it("generic push failure: shows a non-blocking warning with the error message", async () => {
		const vscode = await import("vscode");
		mocks.pushBranchMemories.mockRejectedValue(new Error("boom"));
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("PR is ready, but sharing memories to Jolli Space failed: boom"),
		);
	});

	it("uses the singular noun when exactly one memory is shared", async () => {
		const vscode = await import("vscode");
		mocks.pushBranchMemories.mockResolvedValue({ pushedCount: 1, attachmentCount: 0, attachmentFailures: [], summaryFailures: [] });
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining("Shared 1 memory to your Jolli Space"),
		);
	});

	it("generic non-Error rejection: stringifies the reason in the warning", async () => {
		const vscode = await import("vscode");
		// Reject with a plain string (not an Error) to cover the String(err) arm.
		mocks.pushBranchMemories.mockRejectedValue("kaput");
		await CreatePrWebviewPanel.show(uri, "/repo", bridge, "main", true);
		await created[0].onMsg({ command: "createPr" });
		await flush();
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("PR is ready, but sharing memories to Jolli Space failed: kaput"),
		);
	});
});
