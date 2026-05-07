import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	SidebarInboundMsg,
	SidebarOutboundMsg,
	SidebarState,
} from "./SidebarMessages";
import { SidebarWebviewProvider } from "./SidebarWebviewProvider";

interface MockWebview {
	html: string;
	options: unknown;
	cspSource: string;
	postMessage: ReturnType<typeof vi.fn>;
	onDidReceiveMessage: ReturnType<typeof vi.fn>;
	asWebviewUri: ReturnType<typeof vi.fn>;
	triggerMessage(msg: SidebarOutboundMsg): void;
}
interface MockWebviewView {
	webview: MockWebview;
	onDidDispose: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
	visible: boolean;
}

// Minimal mock Uri that satisfies vscode.Uri.joinPath usage in SidebarWebviewProvider.
const mockExtensionUri = {
	fsPath: "/mock/extension",
	scheme: "file",
	toString: () => "file:///mock/extension",
};

// Mock vscode module — Uri.joinPath, Uri.file, and window.createOutputChannel are needed.
// window.createOutputChannel is used by Logger (imported transitively via the log.info calls
// added to pushCommits/pushMemories for diagnostic purposes).
vi.mock("vscode", () => ({
	Uri: {
		joinPath: vi.fn((_base: unknown, ...segments: string[]) => ({
			toString: () => `vscode-resource:/mock/${segments.join("/")}`,
		})),
		file: vi.fn((path: string) => ({
			toString: () => `file://${path}`,
		})),
	},
	window: {
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		})),
	},
}));

// Drains queued microtasks so the async ready handler (which awaits
// deps.initialStateReady before posting init) gets a chance to run.
// Two ticks: one for the await, one for the trailing then-block.
async function flushReady(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function makeMockView(): MockWebviewView {
	let messageHandler: ((msg: SidebarOutboundMsg) => void) | undefined;
	const webview: MockWebview = {
		html: "",
		options: {},
		cspSource: "vscode-resource:",
		postMessage: vi.fn(),
		onDidReceiveMessage: vi.fn((cb: (msg: SidebarOutboundMsg) => void) => {
			messageHandler = cb;
			return { dispose: () => {} };
		}),
		asWebviewUri: vi.fn((u: unknown) => u),
		triggerMessage(msg) {
			messageHandler?.(msg);
		},
	};
	return {
		webview,
		onDidDispose: vi.fn(() => ({ dispose: () => {} })),
		show: vi.fn(),
		visible: true,
	};
}

describe("SidebarWebviewProvider", () => {
	let provider: SidebarWebviewProvider;
	let executeCommand: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		executeCommand = vi.fn().mockResolvedValue(undefined);
		provider = new SidebarWebviewProvider({
			executeCommand: executeCommand as never,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
	});

	it("sets the webview html on resolveWebviewView", () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		expect(view.webview.html).toContain("<!DOCTYPE html>");
		expect(view.webview.html).toContain('id="sidebar-root"');
	});

	it("posts `init` when client sends `ready`", async () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as SidebarInboundMsg[];
		expect(sent.some((m) => m.type === "init")).toBe(true);
	});

	it("forwards `command` outbound messages via executeCommand", () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "command",
			command: "jollimemory.refreshFiles",
			args: ["foo"],
		});
		expect(executeCommand).toHaveBeenCalledWith(
			"jollimemory.refreshFiles",
			"foo",
		);
	});

	it("forwards `command` with no args", () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "command",
			command: "jollimemory.openSettings",
		});
		expect(executeCommand).toHaveBeenCalledWith("jollimemory.openSettings");
	});

	it("ignores malformed outbound messages without throwing", () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		expect(() =>
			view.webview.triggerMessage({} as unknown as SidebarOutboundMsg),
		).not.toThrow();
	});

	it("posts status:data when StatusProvider notifies", () => {
		const view = makeMockView();
		const statusItems = [{ id: "x", label: "Hooks" }];
		let storedHandler: (() => void) | undefined;
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "status",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			statusProvider: {
				serialize: () => statusItems,
				onDidChangeTreeData: (cb: () => void) => {
					storedHandler = cb;
					return { dispose: () => {} };
				},
				getWorkerBusy: () => false,
			},
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		storedHandler?.();
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			sent.some((m) => m.type === "status:data" && m.entries === statusItems),
		).toBe(true);
	});

	it("posts worker:busy alongside status:data so the Branch toolbar can react", async () => {
		const view = makeMockView();
		let busyValue = false;
		let storedHandler: (() => void) | undefined;
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			statusProvider: {
				serialize: () => [],
				onDidChangeTreeData: (cb: () => void) => {
					storedHandler = cb;
					return { dispose: () => {} };
				},
				getWorkerBusy: () => busyValue,
			},
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		// Initial pushStatus on ready: busy=false.
		const initial = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			initial.some((m) => m.type === "worker:busy" && m.busy === false),
		).toBe(true);
		// Flip the flag and re-fire onDidChangeTreeData; expect a follow-up push
		// with busy=true.
		busyValue = true;
		storedHandler?.();
		const after = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(after.some((m) => m.type === "worker:busy" && m.busy === true)).toBe(
			true,
		);
	});

	it("posts an empty-tree kb:foldersData when listChildren rejects (so webview leaves Loading)", async () => {
		const view = makeMockView();
		const kbFolders = {
			listChildren: vi.fn().mockRejectedValue(new Error("ENOENT")),
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			kbFolders,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "kb:expandFolder", path: "" });
		await new Promise((r) => setTimeout(r, 0));
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		const folders = sent.find(
			(m: { type: string }) => m.type === "kb:foldersData",
		);
		expect(folders).toBeDefined();
		expect(folders.tree.relPath).toBe("");
		expect(folders.tree.isDirectory).toBe(true);
		expect(folders.tree.children).toEqual([]);
	});

	it("responds to kb:expandFolder by posting kb:foldersData", async () => {
		const view = makeMockView();
		const tree = {
			name: "projects",
			relPath: "projects",
			isDirectory: true,
			children: [],
		};
		const kbFolders = { listChildren: vi.fn().mockResolvedValue(tree) };
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			kbFolders,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "kb:expandFolder", path: "projects" });
		await new Promise((r) => setTimeout(r, 0));
		expect(kbFolders.listChildren).toHaveBeenCalledWith("projects");
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			sent.some((m) => m.type === "kb:foldersData" && m.tree === tree),
		).toBe(true);
	});

	it("forwards kb:openFile for .md to jollimemory.openMemoryFile", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			resolveKbAbs: (relPath: string) => `/kbroot/${relPath}`,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "kb:openFile", path: "memo.md" });
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.openMemoryFile",
			"/kbroot/memo.md",
		);
	});

	it("forwards kb:openFile for non-md to vscode.open", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			resolveKbAbs: (relPath: string) => `/kbroot/${relPath}`,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "kb:openFile",
			path: "projects/foo.txt",
		});
		expect(exec).toHaveBeenCalledWith("vscode.open", expect.anything());
	});

	it("posts kb:memoriesData on ready and on memoriesProvider change", async () => {
		const view = makeMockView();
		let memHandler: (() => void) | undefined;
		const memProvider = {
			serialize: () => ({
				items: [
					{
						id: "m1",
						title: "t",
						commitHash: "h",
						branch: "b",
						project: "p",
						timestamp: 1,
					},
				],
				hasMore: false,
			}),
			onDidChangeTreeData: (cb: () => void) => {
				memHandler = cb;
				return { dispose: () => {} };
			},
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "memories",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
			memoriesProvider: memProvider,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		memHandler?.();
		const msgs = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			msgs.filter((m) => m.type === "kb:memoriesData").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("forwards kb:search via jollimemory.searchMemories", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "memories",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "kb:search", query: "abc" });
		expect(exec).toHaveBeenCalledWith("jollimemory.searchMemories", "abc");
	});

	it("forwards kb:loadMore via jollimemory.loadMoreMemories", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "memories",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "kb:loadMore" });
		expect(exec).toHaveBeenCalledWith("jollimemory.loadMoreMemories");
	});

	it("forwards kb:openMemory via jollimemory.viewMemorySummary", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "memories",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "kb:openMemory",
			commitHash: "abc123",
		});
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.viewMemorySummary",
			"abc123",
		);
	});

	it("posts branch:branchName when branch changes", () => {
		const view = makeMockView();
		let branchHandler: ((name: string, detached: boolean) => void) | undefined;
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
			branchWatcher: {
				current: () => ({ name: "main", detached: false }),
				onChange: (cb) => {
					branchHandler = cb;
					return { dispose: () => {} };
				},
			},
		});
		provider.resolveWebviewView(view as unknown as never);
		branchHandler?.("feature/x", false);
		const msgs = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			msgs.some(
				(m) => m.type === "branch:branchName" && m.name === "feature/x",
			),
		).toBe(true);
	});

	it("pushes initial branch name on ready", async () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
			branchWatcher: {
				current: () => ({ name: "feature/yyy", detached: false }),
				onChange: () => ({ dispose: () => {} }),
			},
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const msgs = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			msgs.some(
				(m) => m.type === "branch:branchName" && m.name === "feature/yyy",
			),
		).toBe(true);
	});

	it("posts branch:plansData on ready and on plansProvider change", async () => {
		const view = makeMockView();
		let plansHandler: (() => void) | undefined;
		const plansProvider = {
			serialize: () => [{ id: "p1", label: "Plan A", contextValue: "plan" }],
			onDidChangeTreeData: (cb: () => void) => {
				plansHandler = cb;
				return { dispose: () => {} };
			},
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
			plansProvider,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		plansHandler?.();
		const msgs = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			msgs.filter((m) => m.type === "branch:plansData").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("forwards branch:openPlan via jollimemory.openPlanForPreview", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:openPlan",
			planId: "plan-123",
		});
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.openPlanForPreview",
			"plan-123",
		);
	});

	it("posts branch:changesData on ready and on filesProvider change", async () => {
		const view = makeMockView();
		let filesHandler: (() => void) | undefined;
		const filesProvider = {
			serialize: () => [
				{ id: "/repo/a.ts", label: "a.ts", contextValue: "file" },
			],
			onDidChangeTreeData: (cb: () => void) => {
				filesHandler = cb;
				return { dispose: () => {} };
			},
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
			filesProvider,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		filesHandler?.();
		const msgs = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			msgs.filter((m) => m.type === "branch:changesData").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("forwards branch:openChange via jollimemory.openFileChange", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:openChange",
			filePath: "/repo/src/App.ts",
			relativePath: "src/App.ts",
			statusCode: "M",
		});
		// The webview-side handler rebuilds a FileItem-shaped arg so the
		// command handler's `item.fileStatus.absolutePath / relativePath /
		// statusCode` reads keep working without a real TreeItem instance.
		expect(exec).toHaveBeenCalledWith("jollimemory.openFileChange", {
			fileStatus: {
				absolutePath: "/repo/src/App.ts",
				relativePath: "src/App.ts",
				statusCode: "M",
			},
		});
	});

	it("forwards branch:discardFile via jollimemory.discardFileChanges with FileItem-shape", () => {
		// Regression: the inline ↺ button used to post a generic
		// {type:'command', command:'jollimemory.discardFileChanges', args:[id]}
		// where id was just an absolute-path string. The command handler
		// guards on `if (!item?.fileStatus) return;` so the click silently
		// no-op'd. The dedicated branch:discardFile message rebuilds the
		// FileItem-shape on the host so the handler reads what it expects.
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:discardFile",
			filePath: "/repo/src/App.ts",
			relativePath: "src/App.ts",
			statusCode: "M",
		});
		expect(exec).toHaveBeenCalledWith("jollimemory.discardFileChanges", {
			fileStatus: {
				absolutePath: "/repo/src/App.ts",
				relativePath: "src/App.ts",
				statusCode: "M",
			},
		});
	});

	it("posts branch:commitsData on ready and on historyProvider change", async () => {
		const view = makeMockView();
		let histHandler: (() => void) | undefined;
		const histProvider = {
			serialize: async () => [
				{ id: "abc1234", label: "Initial commit", contextValue: "commit" },
			],
			onDidChangeTreeData: (cb: () => void) => {
				histHandler = cb;
				return { dispose: () => {} };
			},
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
			historyProvider: histProvider,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		histHandler?.();
		// Wait for both initial pushCommits + change-event pushCommits to settle.
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
		const msgs = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			msgs.filter((m) => m.type === "branch:commitsData").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("forwards branch:openCommit via jollimemory.viewSummary", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "branch:openCommit", hash: "abc1234" });
		expect(exec).toHaveBeenCalledWith("jollimemory.viewSummary", "abc1234");
	});

	it("forwards branch:toggleFileSelection to deps.applyFileCheckbox", () => {
		const view = makeMockView();
		const applyFileCheckbox = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
			applyFileCheckbox,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:toggleFileSelection",
			filePath: "src/foo.ts",
			selected: true,
		});
		expect(applyFileCheckbox).toHaveBeenCalledWith("src/foo.ts", true);
	});

	it("pushCommits posts branch:commitsData with mode from historyProvider.getMode()", async () => {
		const view = makeMockView();
		const historyProvider = {
			serialize: vi.fn().mockResolvedValue([]),
			onDidChangeTreeData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			getMode: vi.fn().mockReturnValue("single"),
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
			historyProvider,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await new Promise((r) => setTimeout(r, 0));
		const msgs = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as unknown[];
		const commitsMsg = msgs.find(
			(m) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: unknown }).type === "branch:commitsData",
		);
		expect(commitsMsg).toBeDefined();
		expect((commitsMsg as unknown as { mode?: unknown }).mode).toBe("single");
	});

	it("pushCommits posts mode='empty' when historyProvider.getMode is unavailable", async () => {
		const view = makeMockView();
		const historyProvider = {
			serialize: vi.fn().mockResolvedValue([]),
			onDidChangeTreeData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
			historyProvider: historyProvider as unknown as {
				serialize(): Promise<
					ReadonlyArray<{
						readonly id: string;
						readonly label: string;
					}>
				>;
				onDidChangeTreeData: (cb: () => void) => { dispose: () => void };
			},
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await new Promise((r) => setTimeout(r, 0));
		const msgs = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as unknown[];
		const commitsMsg = msgs.find(
			(m) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: unknown }).type === "branch:commitsData",
		);
		expect(commitsMsg).toBeDefined();
		expect((commitsMsg as unknown as { mode?: unknown }).mode).toBe("empty");
	});

	it("handles refresh scope='kb' by re-listing root and refreshing memories", async () => {
		const view = makeMockView();
		const tree = { name: "", relPath: "", isDirectory: true, children: [] };
		const kbFolders = { listChildren: vi.fn().mockResolvedValue(tree) };
		const exec = vi.fn().mockResolvedValue(undefined);
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			kbFolders,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		exec.mockClear();
		view.webview.triggerMessage({ type: "refresh", scope: "kb" });
		await new Promise((r) => setTimeout(r, 0));
		expect(kbFolders.listChildren).toHaveBeenCalledWith("");
		expect(exec).toHaveBeenCalledWith("jollimemory.refreshMemories");
	});

	it("handles refresh scope='branch' by invoking the three branch refresh commands", () => {
		const view = makeMockView();
		const exec = vi.fn().mockResolvedValue(undefined);
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		exec.mockClear();
		view.webview.triggerMessage({ type: "refresh", scope: "branch" });
		expect(exec).toHaveBeenCalledWith("jollimemory.refreshPlans");
		expect(exec).toHaveBeenCalledWith("jollimemory.refreshFiles");
		expect(exec).toHaveBeenCalledWith("jollimemory.refreshHistory");
	});

	it("handles refresh scope='status' by invoking jollimemory.refreshStatus", () => {
		const view = makeMockView();
		const exec = vi.fn().mockResolvedValue(undefined);
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "status",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		exec.mockClear();
		view.webview.triggerMessage({ type: "refresh", scope: "status" });
		expect(exec).toHaveBeenCalledWith("jollimemory.refreshStatus");
	});

	it("handles refresh scope='all' by triggering every scope", async () => {
		const view = makeMockView();
		const tree = { name: "", relPath: "", isDirectory: true, children: [] };
		const kbFolders = { listChildren: vi.fn().mockResolvedValue(tree) };
		const exec = vi.fn().mockResolvedValue(undefined);
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			kbFolders,
		});
		provider.resolveWebviewView(view as unknown as never);
		exec.mockClear();
		view.webview.triggerMessage({ type: "refresh", scope: "all" });
		await new Promise((r) => setTimeout(r, 0));
		const cmds = exec.mock.calls.map((c) => c[0]);
		expect(cmds).toContain("jollimemory.refreshMemories");
		expect(cmds).toContain("jollimemory.refreshPlans");
		expect(cmds).toContain("jollimemory.refreshFiles");
		expect(cmds).toContain("jollimemory.refreshHistory");
		expect(cmds).toContain("jollimemory.refreshStatus");
		expect(kbFolders.listChildren).toHaveBeenCalledWith("");
	});

	it("notifyEnabledChanged posts enabled:changed", () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "status",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		provider.notifyEnabledChanged(false);
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			sent.some(
				(m) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: unknown; enabled?: unknown }).type ===
						"enabled:changed" &&
					(m as { enabled?: unknown }).enabled === false,
			),
		).toBe(true);
	});

	it("notifyAuthChanged posts auth:changed with the new authenticated flag", () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "status",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		provider.notifyAuthChanged(true);
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			sent.some(
				(m) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: unknown }).type === "auth:changed" &&
					(m as { authenticated?: unknown }).authenticated === true,
			),
		).toBe(true);
	});

	it("notifyConfiguredChanged posts configured:changed with the new configured flag", () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: false,
				activeTab: "status",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		provider.notifyConfiguredChanged(true);
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			sent.some(
				(m) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: unknown }).type === "configured:changed" &&
					(m as { configured?: unknown }).configured === true,
			),
		).toBe(true);
	});

	it("init message carries configured field from getInitialState", async () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: false,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		const initMsg = sent.find(
			(m): m is { type: "init"; state: SidebarState } =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: unknown }).type === "init",
		);
		expect(initMsg).toBeDefined();
		expect(initMsg?.state.configured).toBe(false);
	});

	it("waits for initialStateReady before posting init (so reload doesn't flash onboarding)", async () => {
		const view = makeMockView();
		// Construct a deferred we can resolve manually so we can observe the
		// "before-resolve" and "after-resolve" snapshots of postMessage.
		let resolveReady: () => void = () => {};
		const initialStateReady = new Promise<void>((r) => {
			resolveReady = r;
		});
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			initialStateReady,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await Promise.resolve();
		// Before initialStateReady resolves, init must NOT have been posted.
		// This is the gate that prevents the "first paint shows pessimistic
		// configured=false → flicker to tab UI" bug on reload.
		expect(
			view.webview.postMessage.mock.calls.some((c) => {
				const m = c[0] as { type?: unknown };
				return m?.type === "init";
			}),
		).toBe(false);
		resolveReady();
		await flushReady();
		expect(
			view.webview.postMessage.mock.calls.some((c) => {
				const m = c[0] as { type?: unknown };
				return m?.type === "init";
			}),
		).toBe(true);
	});

	// postMessage runs before resolveWebviewView is called → no view handle → must
	// be a silent no-op (the sidebar may receive notifyXxx() calls during startup
	// before the view first becomes visible).
	it("postMessage is a no-op when the view has not been resolved", () => {
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		// Just verify it doesn't throw — there's no view to assert against.
		expect(() => provider.notifyEnabledChanged(false)).not.toThrow();
		expect(() => provider.notifyAuthChanged(true)).not.toThrow();
		expect(() => provider.notifyConfiguredChanged(false)).not.toThrow();
	});

	// onSidebarFirstVisible fires exactly once across multiple `ready` messages —
	// re-resolves of the view (e.g. user toggles the sidebar) must not re-trigger
	// the lazy load.
	it("onSidebarFirstVisible fires only once even across re-readies", async () => {
		const view = makeMockView();
		const onSidebarFirstVisible = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			onSidebarFirstVisible,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		expect(onSidebarFirstVisible).toHaveBeenCalledTimes(1);
	});

	it("kb:setMode → 'memories' triggers a fresh memories push", () => {
		const view = makeMockView();
		const memProvider = {
			serialize: vi.fn().mockReturnValue({ items: [], hasMore: false }),
			onDidChangeTreeData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			memoriesProvider: memProvider,
		});
		provider.resolveWebviewView(view as unknown as never);
		memProvider.serialize.mockClear();
		view.webview.triggerMessage({ type: "kb:setMode", mode: "memories" });
		expect(memProvider.serialize).toHaveBeenCalled();
	});

	it("kb:setMode → 'folders' does not push memories", () => {
		const view = makeMockView();
		const memProvider = {
			serialize: vi.fn().mockReturnValue({ items: [], hasMore: false }),
			onDidChangeTreeData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "memories",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			memoriesProvider: memProvider,
		});
		provider.resolveWebviewView(view as unknown as never);
		memProvider.serialize.mockClear();
		view.webview.triggerMessage({ type: "kb:setMode", mode: "folders" });
		expect(memProvider.serialize).not.toHaveBeenCalled();
	});

	it("kb:clearSearch forwards jollimemory.clearMemoryFilter", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "memories",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "kb:clearSearch" });
		expect(exec).toHaveBeenCalledWith("jollimemory.clearMemoryFilter");
	});

	it("branch:openNote forwards jollimemory.openNoteForPreview", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "branch:openNote", noteId: "note-42" });
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.openNoteForPreview",
			"note-42",
		);
	});

	it("branch:toggleCommitSelection forwards to deps.applyCommitCheckbox", () => {
		const view = makeMockView();
		const applyCommitCheckbox = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			applyCommitCheckbox,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:toggleCommitSelection",
			hash: "abc1234",
			selected: true,
		});
		expect(applyCommitCheckbox).toHaveBeenCalledWith("abc1234", true);
	});

	// switch's `default` arm — message has a string `type` but it isn't one of
	// the handled cases. Must not throw and must not invoke any side effects.
	it("ignores unknown outbound message types via the switch default", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		expect(() =>
			view.webview.triggerMessage({ type: "totally-unknown" } as never),
		).not.toThrow();
		expect(exec).not.toHaveBeenCalled();
		expect(view.webview.postMessage).not.toHaveBeenCalled();
	});

	// pushCommits's catch path: when historyProvider.serialize() rejects, the
	// section must still settle on an empty list rather than staying on
	// "Loading…" forever.
	it("pushCommits posts an empty list when historyProvider.serialize rejects", async () => {
		const view = makeMockView();
		const historyProvider = {
			serialize: vi.fn().mockRejectedValue(new Error("boom")),
			onDidChangeTreeData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			getMode: () => "single" as const,
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			historyProvider,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
		const msgs = view.webview.postMessage.mock.calls.map((c) => c[0]);
		const commits = msgs.find((m) => m.type === "branch:commitsData");
		expect(commits).toBeDefined();
		expect(commits.items).toEqual([]);
		expect(commits.mode).toBe("single");
	});

	// Same path but the rejection value is a non-Error — covers the `String(err)`
	// arm of the `err instanceof Error ? err.message : String(err)` log expression.
	it("pushCommits handles a non-Error rejection from historyProvider.serialize", async () => {
		const view = makeMockView();
		const historyProvider = {
			serialize: vi.fn().mockRejectedValue("string failure"),
			onDidChangeTreeData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			historyProvider: historyProvider as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
		const msgs = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			msgs.some((m) => m.type === "branch:commitsData" && m.items.length === 0),
		).toBe(true);
	});

	// handleExpandFolder is called with `relPath !== ""` so we hit the
	// `split("/").pop()` path in the error fallback.
	it("handleExpandFolder error fallback derives a node name from the deep path", async () => {
		const view = makeMockView();
		const kbFolders = {
			listChildren: vi.fn().mockRejectedValue("plain string error"),
		};
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			kbFolders,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		view.webview.triggerMessage({ type: "kb:expandFolder", path: "a/b/c" });
		await new Promise((r) => setTimeout(r, 0));
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		const folders = sent.find((m) => m.type === "kb:foldersData");
		expect(folders).toBeDefined();
		expect(folders.tree.name).toBe("c");
		expect(folders.tree.relPath).toBe("a/b/c");
		expect(folders.tree.children).toEqual([]);
	});

	// handleExpandFolder when kbFolders is not provided → silently ignored
	// (covered by `if (!this.deps.kbFolders) return;`).
	it("kb:expandFolder is ignored when kbFolders dep is absent", async () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		view.webview.triggerMessage({ type: "kb:expandFolder", path: "anything" });
		await new Promise((r) => setTimeout(r, 0));
		expect(view.webview.postMessage).not.toHaveBeenCalled();
	});

	// handleOpenFile when resolveKbAbs is not provided → silently ignored.
	it("kb:openFile is ignored when resolveKbAbs dep is absent", () => {
		const view = makeMockView();
		const exec = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: exec,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "kb:openFile", path: "foo.md" });
		expect(exec).not.toHaveBeenCalled();
	});

	// dispose() must dispose all subscriptions that were registered. Wires up one
	// of every dependency so each `if (this.xxxSub)` arm fires at least once.
	it("dispose() disposes every active subscription", () => {
		const view = makeMockView();
		const statusDispose = vi.fn();
		const memoriesDispose = vi.fn();
		const branchDispose = vi.fn();
		const plansDispose = vi.fn();
		const filesDispose = vi.fn();
		const historyDispose = vi.fn();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			statusProvider: {
				serialize: () => [],
				onDidChangeTreeData: () => ({ dispose: statusDispose }),
				getWorkerBusy: () => false,
			},
			memoriesProvider: {
				serialize: () => ({ items: [], hasMore: false }),
				onDidChangeTreeData: () => ({ dispose: memoriesDispose }),
			},
			branchWatcher: {
				current: () => ({ name: "main", detached: false }),
				onChange: () => ({ dispose: branchDispose }),
			},
			plansProvider: {
				serialize: () => [],
				onDidChangeTreeData: () => ({ dispose: plansDispose }),
			},
			filesProvider: {
				serialize: () => [],
				onDidChangeTreeData: () => ({ dispose: filesDispose }),
			},
			historyProvider: {
				serialize: async () => [],
				onDidChangeTreeData: () => ({ dispose: historyDispose }),
			},
		});
		provider.resolveWebviewView(view as unknown as never);
		provider.dispose();
		expect(statusDispose).toHaveBeenCalled();
		expect(memoriesDispose).toHaveBeenCalled();
		expect(branchDispose).toHaveBeenCalled();
		expect(plansDispose).toHaveBeenCalled();
		expect(filesDispose).toHaveBeenCalled();
		expect(historyDispose).toHaveBeenCalled();
		// Idempotent: a second dispose() must be a no-op (already-undefined branches).
		expect(() => provider.dispose()).not.toThrow();
	});

	// dispose() with no subscriptions registered (no providers wired) — every
	// `if (this.xxxSub)` arm takes the false branch. Guards against a regression
	// where `dispose()` would call `.dispose()` on undefined.
	it("dispose() is a no-op when no subscriptions were registered", () => {
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		expect(() => provider.dispose()).not.toThrow();
	});

	it("refreshKnowledgeBaseFolders posts kb:foldersReset with new anchor and re-lists root", async () => {
		const view = makeMockView();
		const tree = { name: "", relPath: "", isDirectory: true, children: [] };
		const kbFolders = { listChildren: vi.fn().mockResolvedValue(tree) };
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "kb",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			kbFolders,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		provider.refreshKnowledgeBaseFolders("jolliai-2");
		await new Promise((r) => setTimeout(r, 0));
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		const reset = sent.find(
			(m) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: unknown }).type === "kb:foldersReset",
		);
		expect(reset).toBeDefined();
		expect((reset as { kbRepoFolder?: string }).kbRepoFolder).toBe("jolliai-2");
		expect(kbFolders.listChildren).toHaveBeenCalledWith("");
	});
});
