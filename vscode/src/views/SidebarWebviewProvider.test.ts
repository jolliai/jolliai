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
	/** Activity-bar badge field — same shape as vscode.WebviewView.badge. */
	badge: { value: number; tooltip: string } | undefined;
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
//
// `workspace.workspaceFolders` is also referenced from `branch:openConversation`'s
// happy path (`vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` becomes the
// `projectDir` passed to ConversationDetailsPanel.show). The mock value is an
// array so tests can mutate the first slot per-case without re-mocking.
const mockWorkspaceFolders: Array<{ uri: { fsPath: string } }> = [];
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
	workspace: {
		get workspaceFolders() {
			return mockWorkspaceFolders.length > 0 ? mockWorkspaceFolders : undefined;
		},
	},
}));

// Stub ConversationDetailsPanel.show so happy-path branch:openConversation
// tests can assert how the host wires its arguments — and grab the
// `onSessionHidden` callback so we can invoke it and prove pushConversations
// fires when the panel reports a list-level hide.
const showMock = vi.fn();
vi.mock("./ConversationDetailsPanel.js", () => ({
	ConversationDetailsPanel: {
		show: (...args: unknown[]) => showMock(...args),
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
		badge: undefined,
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
						repoName: "p",
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

	it("forwards branch:openLinearIssue via jollimemory.openLinearIssue", () => {
		// Sidebar row-click → open Linear issue in browser. Pins the
		// case-branch added for the panel's Linear Issues row type.
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
			type: "branch:openLinearIssue",
			mapKey: "PROJ-1528",
		});
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.openLinearIssue",
			"PROJ-1528",
		);
	});

	it("forwards branch:openLinearIssueMarkdown via jollimemory.openLinearIssueMarkdown", () => {
		// Context-menu "Open Markdown" path — opens the on-disk markdown copy
		// rather than the browser URL. Distinct command from openLinearIssue.
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
			type: "branch:openLinearIssueMarkdown",
			mapKey: "PROJ-1528",
		});
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.openLinearIssueMarkdown",
			"PROJ-1528",
		);
	});

	it("forwards branch:ignoreLinearIssue via jollimemory.ignoreLinearIssue", () => {
		// Trash-button path — hides the Linear issue from the panel. Mirrors
		// the existing Plan/Note ignore wiring.
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
			type: "branch:ignoreLinearIssue",
			mapKey: "PROJ-1528",
		});
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.ignoreLinearIssue",
			"PROJ-1528",
		);
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
		//
		// indexStatus + worktreeStatus must travel through — bridge.discardFiles
		// dispatches on the raw porcelain v1 columns, NOT on the collapsed
		// statusCode letter. Dropping them previously routed every file to the
		// `git restore --staged --worktree` branch, which silently failed for
		// untracked files (pathspec unknown to git) and left the activity-bar
		// badge showing the pre-discard count.
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
			indexStatus: " ",
			worktreeStatus: "M",
		});
		expect(exec).toHaveBeenCalledWith("jollimemory.discardFileChanges", {
			fileStatus: {
				absolutePath: "/repo/src/App.ts",
				relativePath: "src/App.ts",
				statusCode: "M",
				indexStatus: " ",
				worktreeStatus: "M",
			},
		});
	});

	it("forwards branch:discardFile with originalPath for rename rows", () => {
		// Rename rows need the source path so the bridge can unstage both
		// the old and the new path in one shot. Non-rename rows are tested
		// above; their originalPath stays undefined and the host omits it.
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
			filePath: "/repo/new.ts",
			relativePath: "new.ts",
			statusCode: "R",
			indexStatus: "R",
			worktreeStatus: " ",
			originalPath: "old.ts",
		});
		expect(exec).toHaveBeenCalledWith("jollimemory.discardFileChanges", {
			fileStatus: {
				absolutePath: "/repo/new.ts",
				relativePath: "new.ts",
				statusCode: "R",
				indexStatus: "R",
				worktreeStatus: " ",
				originalPath: "old.ts",
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

	it("rejects branch:openConversation with an unknown source (TranscriptSource allow-list)", () => {
		// `source` arrives from the webview message bus; static typing alone
		// is not a boundary check. A crafted payload with a value outside
		// the closed TranscriptSource enum must be dropped silently and
		// must NOT call into ConversationDetailsPanel.show.
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
			type: "branch:openConversation",
			sessionId: "s1",
			source: "../../etc/passwd",
			transcriptPath: "/tmp/x.jsonl",
			title: "spoofed",
		});
		// No command dispatched, no panel created (we trust the dispatcher
		// returned without invoking ConversationDetailsPanel.show).
		expect(exec).not.toHaveBeenCalled();
	});

	// Source goes through `isTranscriptSource`, but the rest of the payload
	// is just trusted today. Defence in depth: sessionId / transcriptPath /
	// title each cross a trust boundary into either the file system
	// (createReadStream(transcriptPath)) or the panel DOM (escapeHtml(title))
	// or the panel registry key. Anything that isn't a non-empty string
	// must be dropped at the dispatcher rather than forwarded.
	it.each([
		[
			"sessionId is missing",
			{ source: "claude", transcriptPath: "/t.jsonl", title: "ok" },
		],
		[
			"sessionId is empty",
			{
				sessionId: "",
				source: "claude",
				transcriptPath: "/t.jsonl",
				title: "ok",
			},
		],
		[
			"sessionId is a number",
			{
				sessionId: 42,
				source: "claude",
				transcriptPath: "/t.jsonl",
				title: "ok",
			},
		],
		[
			"transcriptPath is missing",
			{ sessionId: "s1", source: "claude", title: "ok" },
		],
		[
			"transcriptPath is empty",
			{ sessionId: "s1", source: "claude", transcriptPath: "", title: "ok" },
		],
		[
			"transcriptPath is a boolean",
			{ sessionId: "s1", source: "claude", transcriptPath: true, title: "ok" },
		],
		[
			"title is missing",
			{ sessionId: "s1", source: "claude", transcriptPath: "/t.jsonl" },
		],
		[
			"title is empty",
			{
				sessionId: "s1",
				source: "claude",
				transcriptPath: "/t.jsonl",
				title: "",
			},
		],
		[
			"title is an object",
			{
				sessionId: "s1",
				source: "claude",
				transcriptPath: "/t.jsonl",
				title: { x: 1 },
			},
		],
	])("rejects branch:openConversation when %s", (_label, badFields) => {
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
			type: "branch:openConversation",
			...badFields,
		});
		// Dispatcher must short-circuit before any host-side side-effect.
		expect(exec).not.toHaveBeenCalled();
	});

	// Happy-path: a well-formed `branch:openConversation` reaches
	// ConversationDetailsPanel.show with the workspace folder threaded through
	// as `projectDir`. The onSessionChanged callback the host hands the panel
	// must, when invoked, kick a re-pull of conversations so edited badges /
	// counts and hidden-state removals show up immediately after save.
	it("dispatches branch:openConversation to ConversationDetailsPanel.show with projectDir threaded and onSessionChanged re-pulls", () => {
		showMock.mockReset();
		mockWorkspaceFolders.length = 0;
		mockWorkspaceFolders.push({ uri: { fsPath: "/abs/proj" } });
		try {
			const view = makeMockView();
			const listWithDiagnostics = vi
				.fn()
				.mockResolvedValue({ items: [], failedSources: [] });
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn() as never,
				getInitialState: () => ({
					enabled: true,
					authenticated: false,
					configured: true,
					activeTab: "branch",
					kbMode: "folders",
					branchName: "main",
					detached: false,
				}),
				extensionUri: { fsPath: "/mock", with: () => ({}) } as never,
				activeSessionsProvider: { listWithDiagnostics } as unknown as never,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({
				type: "branch:openConversation",
				sessionId: "claude-sess-1",
				source: "claude",
				transcriptPath: "/tmp/sess.jsonl",
				title: "Wire dark mode",
			});
			expect(showMock).toHaveBeenCalledTimes(1);
			const call = showMock.mock.calls[0][0] as {
				sessionId: string;
				source: string;
				transcriptPath: string;
				title: string;
				projectDir: string;
				onSessionChanged: () => void;
			};
			expect(call.sessionId).toBe("claude-sess-1");
			expect(call.source).toBe("claude");
			expect(call.transcriptPath).toBe("/tmp/sess.jsonl");
			expect(call.title).toBe("Wire dark mode");
			// workspaceFolders[0].uri.fsPath flowed through as projectDir —
			// the panel uses it to resolve the conversation-edits overlay
			// directory. A missing/empty workspace would have left this
			// undefined; the mock pushes a folder so the happy branch runs.
			expect(call.projectDir).toBe("/abs/proj");

			// Invoking the captured onSessionChanged simulates the panel
			// finishing a save. The arrow is what re-pulls conversations so
			// the sidebar immediately reflects edited badges, counts, or a
			// hidden row disappearing from the CONVERSATIONS list. Without
			// this assertion the closure stays uncovered by v8 (the arrow
			// counts as its own function).
			listWithDiagnostics.mockClear();
			call.onSessionChanged();
			expect(listWithDiagnostics).toHaveBeenCalled();
		} finally {
			mockWorkspaceFolders.length = 0;
		}
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

	it("notifyApiKeySaveError posts apikey:saveError with the supplied message", () => {
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
		provider.notifyApiKeySaveError("disk full");
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			sent.some(
				(m) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: unknown }).type === "apikey:saveError" &&
					(m as { message?: unknown }).message === "disk full",
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
		expect(() => provider.notifyApiKeySaveError("anything")).not.toThrow();
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

	it("dispatches branch:toggleConversationSelection to applyConversationCheckbox", () => {
		const view = makeMockView();
		const applyConversationCheckbox = vi.fn();
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
			applyConversationCheckbox,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:toggleConversationSelection",
			source: "claude",
			sessionId: "abc",
			selected: false,
		});
		expect(applyConversationCheckbox).toHaveBeenCalledWith(
			"claude",
			"abc",
			false,
		);
	});

	it("rejects branch:toggleConversationSelection with an unknown source", () => {
		const view = makeMockView();
		const applyConversationCheckbox = vi.fn();
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
			applyConversationCheckbox,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:toggleConversationSelection",
			source: "../../etc/passwd",
			sessionId: "abc",
			selected: false,
		});
		expect(applyConversationCheckbox).not.toHaveBeenCalled();
	});

	it("dispatches branch:togglePlanSelection to applyPlanCheckbox", () => {
		const view = makeMockView();
		const applyPlanCheckbox = vi.fn();
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
			applyPlanCheckbox,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:togglePlanSelection",
			planId: "plan-slug",
			selected: false,
		});
		expect(applyPlanCheckbox).toHaveBeenCalledWith("plan-slug", false);
	});

	it("dispatches branch:toggleNoteSelection to applyNoteCheckbox", () => {
		const view = makeMockView();
		const applyNoteCheckbox = vi.fn();
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
			applyNoteCheckbox,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:toggleNoteSelection",
			noteId: "note-id",
			selected: false,
		});
		expect(applyNoteCheckbox).toHaveBeenCalledWith("note-id", false);
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

	it("refreshKnowledgeBaseFolders posts kb:foldersReset and re-lists root", async () => {
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
		provider.refreshKnowledgeBaseFolders();
		await new Promise((r) => setTimeout(r, 0));
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		const reset = sent.find(
			(m) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: unknown }).type === "kb:foldersReset",
		);
		expect(reset).toBeDefined();
		// kb:foldersReset is intentionally payload-free now — the next root
		// listing carries `isCurrentRepo` on every repo node, so callers don't
		// need to thread the new anchor name through the message.
		expect(Object.keys(reset as object)).toEqual(["type"]);
		expect(kbFolders.listChildren).toHaveBeenCalledWith("");
	});

	it("refreshKnowledgeBaseFolders invalidates the kbFolders cleanRepos memo", async () => {
		// Regression: refreshKnowledgeBaseFolders posted kb:foldersReset and
		// re-fetched the root, but the kbFoldersService.cleanRepos memo lived
		// for the whole session. After the first clean pass, manual Refresh /
		// settings save / external file deletion (iCloud eviction) all
		// short-circuited reconcile + heal and the deleted file was never
		// restored. Pinning notifyDirty() on this path keeps every refresh
		// entrypoint re-armed.
		const view = makeMockView();
		const tree = { name: "", relPath: "", isDirectory: true, children: [] };
		const notifyDirty = vi.fn();
		const kbFolders = {
			listChildren: vi.fn().mockResolvedValue(tree),
			notifyDirty,
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
		notifyDirty.mockClear();
		provider.refreshKnowledgeBaseFolders();
		await new Promise((r) => setTimeout(r, 0));
		expect(notifyDirty).toHaveBeenCalledTimes(1);
	});

	// setBadge re-attaches the activity-bar badge surface that the legacy
	// TreeView-based sidebar provided. WebviewView shares the `.badge` API
	// with TreeView — these tests pin the contract that (a) badges set
	// after resolve apply immediately and (b) badges set before resolve
	// are cached and re-applied on resolve, so callers don't need to know
	// whether the user has opened the sidebar yet.

	it("setBadge writes to view.badge after resolveWebviewView", () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		provider.setBadge({ value: 3, tooltip: "3 changed files, 0 selected" });
		expect(view.badge).toEqual({
			value: 3,
			tooltip: "3 changed files, 0 selected",
		});
		provider.setBadge(undefined);
		expect(view.badge).toBeUndefined();
	});

	it("setBadge before resolveWebviewView caches and applies on resolve", () => {
		// filesStore.onChange may fire during activate, before VS Code has
		// resolved the WebviewView. Without caching, that very first badge
		// would silently disappear and the icon would stay unbadged for the
		// rest of the session — caching makes the wiring order independent.
		provider.setBadge({ value: 7, tooltip: "7 changed files, 2 selected" });
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		expect(view.badge).toEqual({
			value: 7,
			tooltip: "7 changed files, 2 selected",
		});
	});

	it("setBadge replaces an earlier cached badge before resolve", () => {
		// Multiple filesStore.onChange firings before resolve must collapse
		// to the latest value, not the first — otherwise a stale count from
		// the initial empty snapshot would win over the post-refresh count.
		provider.setBadge({ value: 1, tooltip: "stale" });
		provider.setBadge({ value: 9, tooltip: "fresh" });
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		expect(view.badge).toEqual({ value: 9, tooltip: "fresh" });
	});

	it("setBadge cycles through value:0 before clearing a previously-set badge", () => {
		// WebviewView.badge's setter does not always repaint the activity-bar
		// counter when assigned `undefined` after a non-undefined ViewBadge —
		// observed as a stuck count (e.g. user reverts the only changed file:
		// visibleCount 1 → 0 but the icon kept "1"). The fix is a value:0
		// sentinel between the two states, which VS Code suppresses visually
		// but is guaranteed to trigger the setter. This test instruments the
		// mock view with a property accessor to capture every assignment so
		// the workaround stays observable — `view.badge` alone only retains
		// the final value.
		const assignments: Array<typeof view._stored> = [];
		const view = makeMockView() as MockWebviewView & {
			_stored: { value: number; tooltip: string } | undefined;
		};
		view._stored = undefined;
		Object.defineProperty(view, "badge", {
			configurable: true,
			get() {
				return view._stored;
			},
			set(v: { value: number; tooltip: string } | undefined) {
				view._stored = v;
				assignments.push(v);
			},
		});
		provider.resolveWebviewView(view as unknown as never);
		provider.setBadge({ value: 5, tooltip: "5 changed, 0 selected" });
		provider.setBadge(undefined);
		// resolve writes the cached (undefined) badge once, then setBadge({…})
		// writes once, then the clearing call writes value:0 then undefined.
		expect(assignments).toEqual([
			undefined,
			{ value: 5, tooltip: "5 changed, 0 selected" },
			{ value: 0, tooltip: "" },
			undefined,
		]);
	});

	it("setBadge does not cycle when clearing an already-empty badge", () => {
		// Avoid an unnecessary repaint when the badge is already unset — the
		// value:0 sentinel is only needed to dislodge a stuck count.
		const assignments: Array<typeof view._stored> = [];
		const view = makeMockView() as MockWebviewView & {
			_stored: { value: number; tooltip: string } | undefined;
		};
		view._stored = undefined;
		Object.defineProperty(view, "badge", {
			configurable: true,
			get() {
				return view._stored;
			},
			set(v: { value: number; tooltip: string } | undefined) {
				view._stored = v;
				assignments.push(v);
			},
		});
		provider.resolveWebviewView(view as unknown as never);
		provider.setBadge(undefined);
		provider.setBadge(undefined);
		// resolve writes the cached (undefined) badge once; both setBadge
		// calls then assign undefined directly without the sentinel cycle.
		expect(assignments).toEqual([undefined, undefined, undefined]);
	});

	// ── Breadcrumb selection (selection:repos / selection:branches / selection:request) ──
	// These tests verify the host-side wiring of the breadcrumb dropdowns —
	// the previous gap (UI built, host wiring missing) is what made the repo
	// segment render as `(workspace)` and both chevrons stay hidden.

	function makeSelectionProvider(opts: {
		listRepos: ReturnType<typeof vi.fn>;
		listBranches: ReturnType<typeof vi.fn>;
		listBranchMemories?: ReturnType<typeof vi.fn>;
		currentRepoName?: string;
	}): SidebarWebviewProvider {
		return new SidebarWebviewProvider({
			executeCommand: vi.fn().mockResolvedValue(undefined) as never,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
				currentRepoName: opts.currentRepoName ?? "workspace-repo",
			}),
			extensionUri: mockExtensionUri as unknown as never,
			selection: {
				listRepos: opts.listRepos,
				listBranches: opts.listBranches,
				// Default to an empty-result stub so callers that only care
				// about listRepos/listBranches keep working — the
				// `selection:requestBranchMemories` tests configure their own.
				listBranchMemories:
					opts.listBranchMemories ?? vi.fn().mockResolvedValue([]),
			},
		});
	}

	it("pushes selection:repos and selection:branches for the current repo on ready", async () => {
		const view = makeMockView();
		const listRepos = vi.fn().mockReturnValue([
			{ repoName: "workspace-repo", isCurrent: true },
			{ repoName: "other-repo", isCurrent: false, remoteUrl: "git@x:y" },
		]);
		const listBranches = vi
			.fn()
			.mockImplementation((r: string) =>
				r === "workspace-repo" ? ["main", "feature-x"] : ["topic"],
			);
		const provider = makeSelectionProvider({ listRepos, listBranches });
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as SidebarInboundMsg[];
		expect(sent).toContainEqual({
			type: "selection:repos",
			repos: [
				{ repoName: "workspace-repo", isCurrent: true },
				{ repoName: "other-repo", isCurrent: false, remoteUrl: "git@x:y" },
			],
		});
		// listBranches is consulted only for the workspace repo at ready-time;
		// foreign-repo branches are lazy-loaded when the user picks the repo.
		expect(listBranches).toHaveBeenCalledTimes(1);
		expect(listBranches).toHaveBeenCalledWith("workspace-repo");
		expect(sent).toContainEqual({
			type: "selection:branches",
			repoName: "workspace-repo",
			branches: ["main", "feature-x"],
		});
	});

	it("init carries currentRepoName so the breadcrumb shows the real repo name (not (workspace))", async () => {
		const view = makeMockView();
		const provider = makeSelectionProvider({
			listRepos: vi.fn().mockReturnValue([]),
			listBranches: vi.fn().mockReturnValue([]),
			currentRepoName: "jollimemory",
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const init = view.webview.postMessage.mock.calls
			.map((c) => c[0] as SidebarInboundMsg)
			.find(
				(m): m is SidebarInboundMsg & { type: "init" } => m.type === "init",
			);
		expect(init).toBeDefined();
		expect((init as { state: SidebarState }).state.currentRepoName).toBe(
			"jollimemory",
		);
	});

	it("selection:request with repoName pushes selection:branches and selection:set with auto-picked branch", () => {
		const view = makeMockView();
		const listRepos = vi.fn().mockReturnValue([
			{ repoName: "workspace-repo", isCurrent: true },
			{ repoName: "other-repo", isCurrent: false },
		]);
		const listBranches = vi
			.fn()
			.mockImplementation((r: string) =>
				r === "other-repo" ? ["release", "draft"] : [],
			);
		const provider = makeSelectionProvider({ listRepos, listBranches });
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		view.webview.triggerMessage({
			type: "selection:request",
			repoName: "other-repo",
		});
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as SidebarInboundMsg[];
		expect(sent).toContainEqual({
			type: "selection:branches",
			repoName: "other-repo",
			branches: ["release", "draft"],
		});
		expect(sent).toContainEqual({
			type: "selection:set",
			repoName: "other-repo",
			branchName: "release",
		});
	});

	it("selection:request with only branchName posts selection:set without re-listing branches", () => {
		const view = makeMockView();
		const listRepos = vi.fn().mockReturnValue([
			{ repoName: "workspace-repo", isCurrent: true },
			{ repoName: "other-repo", isCurrent: false },
		]);
		const listBranches = vi
			.fn()
			.mockImplementation((r: string) =>
				r === "other-repo" ? ["release", "draft"] : ["main"],
			);
		const provider = makeSelectionProvider({ listRepos, listBranches });
		provider.resolveWebviewView(view as unknown as never);
		// First land on a foreign repo so selectedRepoName is populated.
		view.webview.triggerMessage({
			type: "selection:request",
			repoName: "other-repo",
		});
		view.webview.postMessage.mockClear();
		listBranches.mockClear();
		view.webview.triggerMessage({
			type: "selection:request",
			branchName: "draft",
		});
		expect(listBranches).not.toHaveBeenCalled();
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as SidebarInboundMsg[];
		expect(sent).toEqual([
			{
				type: "selection:set",
				repoName: "other-repo",
				branchName: "draft",
			},
		]);
	});

	it("selection:request for an unknown repo is a no-op (no messages, no state mutation)", () => {
		const view = makeMockView();
		const listRepos = vi
			.fn()
			.mockReturnValue([{ repoName: "workspace-repo", isCurrent: true }]);
		const listBranches = vi.fn().mockReturnValue([]);
		const provider = makeSelectionProvider({ listRepos, listBranches });
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		view.webview.triggerMessage({
			type: "selection:request",
			repoName: "ghost-repo",
		});
		expect(view.webview.postMessage).not.toHaveBeenCalled();
		expect(listBranches).not.toHaveBeenCalled();
	});

	it("selection:request is silently ignored when the selection dep is absent", () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn().mockResolvedValue(undefined) as never,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
				currentRepoName: "workspace-repo",
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		expect(() =>
			view.webview.triggerMessage({
				type: "selection:request",
				repoName: "anything",
			}),
		).not.toThrow();
		// No selection:* messages posted because the dep isn't wired.
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => (c[0] as SidebarInboundMsg).type,
		);
		expect(sent.filter((t) => t.startsWith("selection:"))).toEqual([]);
	});

	// ── selection:requestBranchMemories lazy-data channel ──────────────────
	// The Branch tab's "Memories" section is lazy-loaded: when the user picks
	// a foreign repo/branch, the webview sends `selection:requestBranchMemories`
	// and the host replies with `selection:branchMemories`. The response MUST
	// echo back the requested repoName+branchName so the webview can match it
	// against its cache key — a faster newer request may have overwritten the
	// in-flight selection state by the time the response lands.

	it("selection:requestBranchMemories posts branch memories on success", async () => {
		const view = makeMockView();
		const items = [
			{
				commitHash: "abc123",
				title: "Wire up dark mode",
				branch: "feature-x",
				repoName: "other-repo",
				timestamp: 1_700_000_000_000,
			},
		];
		const listBranchMemories = vi.fn().mockResolvedValue(items);
		const provider = makeSelectionProvider({
			listRepos: vi.fn().mockReturnValue([]),
			listBranches: vi.fn().mockReturnValue([]),
			listBranchMemories,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		view.webview.triggerMessage({
			type: "selection:requestBranchMemories",
			repoName: "other-repo",
			branchName: "feature-x",
		});
		// handleBranchMemoriesRequest is async; let the microtask queue drain
		// so the post-await postMessage runs before we inspect the calls.
		await Promise.resolve();
		await Promise.resolve();
		expect(listBranchMemories).toHaveBeenCalledWith("other-repo", "feature-x");
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as SidebarInboundMsg[];
		expect(sent).toContainEqual({
			type: "selection:branchMemories",
			repoName: "other-repo",
			branchName: "feature-x",
			items,
		});
	});

	it("selection:requestBranchMemories posts empty items when listBranchMemories throws", async () => {
		const view = makeMockView();
		const listBranchMemories = vi
			.fn()
			.mockRejectedValue(new Error("kbRoot unreadable"));
		const provider = makeSelectionProvider({
			listRepos: vi.fn().mockReturnValue([]),
			listBranches: vi.fn().mockReturnValue([]),
			listBranchMemories,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		view.webview.triggerMessage({
			type: "selection:requestBranchMemories",
			repoName: "foreign",
			branchName: "topic",
		});
		// Two microtask flushes: one for the await on listBranchMemories
		// (rejection), one for the catch-arm postMessage.
		await Promise.resolve();
		await Promise.resolve();
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as SidebarInboundMsg[];
		// The catch arm still posts a response — empty items — so the webview
		// can resolve its Loading state instead of spinning forever. The
		// repoName/branchName echo is preserved so cache keys still match.
		expect(sent).toContainEqual({
			type: "selection:branchMemories",
			repoName: "foreign",
			branchName: "topic",
			items: [],
		});
	});

	it("selection:requestBranchMemories survives a non-Error rejection from listBranchMemories", async () => {
		// The catch arm reads `err instanceof Error ? err.message : String(err)`.
		// Rejections from native handlers / older runtimes sometimes throw
		// non-Error values; the `String(err)` fallback path stays uncovered
		// unless we throw a string here, which would otherwise leave a
		// subtle log-format regression undetected by tests.
		const view = makeMockView();
		const listBranchMemories = vi.fn().mockRejectedValue("not-an-error");
		const provider = makeSelectionProvider({
			listRepos: vi.fn().mockReturnValue([]),
			listBranches: vi.fn().mockReturnValue([]),
			listBranchMemories,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		view.webview.triggerMessage({
			type: "selection:requestBranchMemories",
			repoName: "foreign",
			branchName: "topic",
		});
		await Promise.resolve();
		await Promise.resolve();
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as SidebarInboundMsg[];
		expect(sent).toContainEqual({
			type: "selection:branchMemories",
			repoName: "foreign",
			branchName: "topic",
			items: [],
		});
	});

	it("selection:requestBranchMemories is silently ignored when the selection dep is absent", async () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn().mockResolvedValue(undefined) as never,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				configured: true,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
				currentRepoName: "workspace-repo",
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		view.webview.triggerMessage({
			type: "selection:requestBranchMemories",
			repoName: "anything",
			branchName: "any-branch",
		});
		await Promise.resolve();
		await Promise.resolve();
		// No selection:branchMemories was posted because the dep isn't wired.
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => (c[0] as SidebarInboundMsg).type,
		);
		expect(sent).not.toContain("selection:branchMemories");
	});

	// ── Active Conversations failedSources plumbing ─────────────────────────
	// pushConversations must use listWithDiagnostics() (not list()) so the
	// webview can render a partial-data hint when some discoverers fail. The
	// previous wiring called list() and dropped failedSources on the floor.
	it("pushConversations forwards failedSources from activeSessionsProvider.listWithDiagnostics", async () => {
		const view = makeMockView();
		const listWithDiagnostics = vi.fn().mockResolvedValue({
			items: [
				{
					sessionId: "s1",
					source: "cursor",
					title: "Cursor session",
					messageCount: 4,
					updatedAt: "2026-05-17T10:00:00.000Z",
					transcriptPath: "/state.vscdb#s1",
				},
			],
			failedSources: ["opencode", "copilot"],
		});
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn().mockResolvedValue(undefined) as never,
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
			activeSessionsProvider: { listWithDiagnostics } as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const conv = view.webview.postMessage.mock.calls
			.map((c) => c[0] as SidebarInboundMsg)
			.find(
				(m): m is SidebarInboundMsg & { type: "branch:conversationsData" } =>
					m.type === "branch:conversationsData",
			);
		expect(conv).toBeDefined();
		expect(listWithDiagnostics).toHaveBeenCalled();
		expect(
			(conv as { failedSources?: readonly string[] }).failedSources,
		).toEqual(["opencode", "copilot"]);
		expect((conv as { items: readonly unknown[] }).items).toHaveLength(1);
	});

	it("pushConversations posts empty failedSources when listWithDiagnostics throws", async () => {
		const view = makeMockView();
		const listWithDiagnostics = vi
			.fn()
			.mockRejectedValue(new Error("provider down"));
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn().mockResolvedValue(undefined) as never,
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
			activeSessionsProvider: { listWithDiagnostics } as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const conv = view.webview.postMessage.mock.calls
			.map((c) => c[0] as SidebarInboundMsg)
			.find(
				(m): m is SidebarInboundMsg & { type: "branch:conversationsData" } =>
					m.type === "branch:conversationsData",
			);
		expect(conv).toBeDefined();
		expect((conv as { items: readonly unknown[] }).items).toEqual([]);
		expect(
			(conv as { failedSources?: readonly string[] }).failedSources,
		).toEqual([]);
	});

	// Mirrors the Error-rejection test above but throws a non-Error value to
	// pin the `err instanceof Error ? err.message : err` ternary in the catch
	// arm of pushConversations. Without this case the log-format fallback
	// branch stays uncovered and a regression that always assumed Error
	// shape would slip past the suite.
	it("pushConversations still recovers when listWithDiagnostics rejects with a non-Error", async () => {
		const view = makeMockView();
		const listWithDiagnostics = vi.fn().mockRejectedValue("plain-string");
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn().mockResolvedValue(undefined) as never,
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
			activeSessionsProvider: { listWithDiagnostics } as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const conv = view.webview.postMessage.mock.calls
			.map((c) => c[0] as SidebarInboundMsg)
			.find(
				(m): m is SidebarInboundMsg & { type: "branch:conversationsData" } =>
					m.type === "branch:conversationsData",
			);
		expect(conv).toBeDefined();
		expect((conv as { items: readonly unknown[] }).items).toEqual([]);
		expect(
			(conv as { failedSources?: readonly string[] }).failedSources,
		).toEqual([]);
	});

	// ── Active Conversations periodic refresh (1-minute timer) ──────────────
	// The five no-hook AI sources have no host-side watcher, so the sidebar
	// polls them on a fixed cadence. These tests pin: (a) the timer fires
	// the aggregator on top of the initial ready-push, (b) ticks while the
	// view is hidden short-circuit before doing any work, and (c) disposing
	// the provider stops further ticks.
	it("polls listWithDiagnostics every 60s after view resolves", async () => {
		vi.useFakeTimers();
		try {
			const view = makeMockView();
			const listWithDiagnostics = vi
				.fn()
				.mockResolvedValue({ items: [], failedSources: [] });
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn().mockResolvedValue(undefined) as never,
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
				activeSessionsProvider: { listWithDiagnostics } as unknown as never,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({ type: "ready" });
			await flushReady();
			// Initial handleReady push.
			expect(listWithDiagnostics).toHaveBeenCalledTimes(1);
			// One tick.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(listWithDiagnostics).toHaveBeenCalledTimes(2);
			// Two more ticks confirm the timer keeps firing (not a one-shot).
			await vi.advanceTimersByTimeAsync(120_000);
			expect(listWithDiagnostics).toHaveBeenCalledTimes(4);
			provider.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("skips refresh ticks while the sidebar view is hidden", async () => {
		vi.useFakeTimers();
		try {
			const view = makeMockView();
			view.visible = false;
			const listWithDiagnostics = vi
				.fn()
				.mockResolvedValue({ items: [], failedSources: [] });
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn().mockResolvedValue(undefined) as never,
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
				activeSessionsProvider: { listWithDiagnostics } as unknown as never,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({ type: "ready" });
			await flushReady();
			// Initial handleReady push still happens (handleReady ignores visibility).
			expect(listWithDiagnostics).toHaveBeenCalledTimes(1);
			// Timer fires but tick short-circuits because view.visible === false.
			await vi.advanceTimersByTimeAsync(180_000);
			expect(listWithDiagnostics).toHaveBeenCalledTimes(1);
			// Flipping visibility back on lets subsequent ticks proceed.
			view.visible = true;
			await vi.advanceTimersByTimeAsync(60_000);
			expect(listWithDiagnostics).toHaveBeenCalledTimes(2);
			provider.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops the refresh timer on dispose", async () => {
		vi.useFakeTimers();
		try {
			const view = makeMockView();
			const listWithDiagnostics = vi
				.fn()
				.mockResolvedValue({ items: [], failedSources: [] });
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn().mockResolvedValue(undefined) as never,
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
				activeSessionsProvider: { listWithDiagnostics } as unknown as never,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({ type: "ready" });
			await flushReady();
			expect(listWithDiagnostics).toHaveBeenCalledTimes(1);
			provider.dispose();
			await vi.advanceTimersByTimeAsync(300_000);
			expect(listWithDiagnostics).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("skips installing the refresh timer when activeSessionsProvider is missing", async () => {
		vi.useFakeTimers();
		try {
			const view = makeMockView();
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn().mockResolvedValue(undefined) as never,
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
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({ type: "ready" });
			await flushReady();
			// No throw, no posted conversation message, and dispose is a no-op
			// even though the provider never registered a timer.
			await vi.advanceTimersByTimeAsync(180_000);
			const convCalls = view.webview.postMessage.mock.calls
				.map((c) => c[0] as SidebarInboundMsg)
				.filter((m) => m.type === "branch:conversationsData");
			expect(convCalls).toEqual([]);
			expect(() => provider.dispose()).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});
});
