import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handleCreatePr: vi.fn().mockResolvedValue(undefined),
	handleUpdatePrWithPush: vi.fn().mockResolvedValue(undefined),
	findOpenPrForBranch: vi.fn().mockResolvedValue(undefined),
	isWorkerBlockingBusy: vi.fn().mockResolvedValue(false),
	buildCreatePrViewModel: vi.fn().mockResolvedValue({
		branch: "feature/x", mainBranch: "main", memoryCount: 1, missingCount: 0,
		insertions: 1, deletions: 0, filesChanged: 1, title: "feat: x", bodyMarkdown: "B",
		memories: [{ hash: "h", title: "t" }], files: [], e2eScenarios: [],
	}),
}));

const created: Array<{
	html: string;
	onMsg: (m: unknown) => void;
	onDispose: () => void;
	reveal: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	webview: { html: string; postMessage: ReturnType<typeof vi.fn>; onDidReceiveMessage: (cb: (m: unknown) => void) => { dispose: () => void } };
}> = [];
vi.mock("vscode", () => ({
	ViewColumn: { One: 1, Active: -1 },
	Uri: {
		file: (p: string) => ({ scheme: "file", fsPath: p, toString: () => `file://${p}` }),
		parse: (s: string) => ({ scheme: "https", toString: () => s, value: s }),
		joinPath: (base: { fsPath: string }, ...segs: Array<string>) => {
			const fsPath = [base.fsPath.replace(/\/$/, ""), ...segs].join("/");
			return { scheme: "file", fsPath, toString: () => `file://${fsPath}` };
		},
	},
	env: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() },
	window: {
		createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		createWebviewPanel: vi.fn(() => {
			const rec = {
				html: "",
				reveal: vi.fn(),
				dispose: vi.fn(),
				onMsg: (_: unknown) => {},
				onDispose: () => {},
				webview: {
					html: "",
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
}));

vi.mock("../services/PrCommentService.js", () => ({
	handleCreatePr: mocks.handleCreatePr,
	handleUpdatePrWithPush: mocks.handleUpdatePrWithPush,
	findOpenPrForBranch: mocks.findOpenPrForBranch,
}));
vi.mock("./CreatePrData", () => ({ buildCreatePrViewModel: mocks.buildCreatePrViewModel }));
vi.mock("../util/LockUtils.js", () => ({ isWorkerBlockingBusy: mocks.isWorkerBlockingBusy }));
vi.mock("../util/Logger.js", () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), show: vi.fn(), dispose: vi.fn() },
	initLogger: vi.fn(),
}));

import { CreatePrWebviewPanel } from "./CreatePrWebviewPanel.js";

const bridge = { getCurrentBranch: vi.fn().mockResolvedValue("feature/x"), getCwd: () => "/repo" } as never;

beforeEach(() => {
	created.length = 0;
	CreatePrWebviewPanel.dispose();
	vi.clearAllMocks();
	mocks.isWorkerBlockingBusy.mockResolvedValue(false);
	mocks.handleCreatePr.mockResolvedValue(undefined);
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

	it("openDiff: executes vscode.open with a Uri for the given path", async () => {
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "vscode/src/a.ts" });
		await Promise.resolve();
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			// Repo-relative path resolved against the workspace root ("/repo").
			expect.objectContaining({ fsPath: "/repo/vscode/src/a.ts" }),
		);
	});

	it("openDiff: rejects a path that escapes the workspace via ../ and never opens it", async () => {
		const vscode = await import("vscode");
		const logMod = await import("../util/Logger.js");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "../../etc/passwd" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
			"vscode.open",
			expect.anything(),
		);
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
		expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
			"vscode.open",
			expect.anything(),
		);
	});

	it("openDiff: swallows Error instances via the rejection handler without re-throwing", async () => {
		const vscode = await import("vscode");
		const logMod = await import("../util/Logger.js");
		(vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("file not found"),
		);
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openDiff", path: "missing/file.ts" });
		// Drain all microtasks until the rejection handler has run.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			expect.objectContaining({ fsPath: "/repo/missing/file.ts" }),
		);
		expect((logMod.log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			"CreatePrPanel",
			expect.stringContaining("file not found"),
		);
	});

	it("openDiff: swallows non-Error rejections via the rejection handler", async () => {
		const vscode = await import("vscode");
		const logMod = await import("../util/Logger.js");
		// Reject with a plain string (not an Error) to cover the String(e) branch.
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

	it("openPr: opens the PR url externally", async () => {
		const vscode = await import("vscode");
		await CreatePrWebviewPanel.show({ fsPath: "/ext" } as never, "/repo", bridge, "main");
		created[0].onMsg({ command: "openPr", url: "https://gh/pr/7" });
		await Promise.resolve();
		expect(vscode.env.openExternal).toHaveBeenCalled();
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
