import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Polls the webview's posted messages until one of `type` appears (or the tick
 * budget runs out), returning every message sent so far. A plain single-tick
 * `await setTimeout(0)` is not enough for handlers whose work spans multiple
 * async turns (e.g. pushMemoryEvidence resolves Claude titles by reading the
 * live transcript off disk) — without polling those assertions flake.
 */
async function flushUntilMessage(
	view: MockWebviewView,
	type: string,
	maxTicks = 50,
): Promise<SidebarInboundMsg[]> {
	for (let i = 0; i < maxTicks; i++) {
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0] as SidebarInboundMsg);
		if (sent.some((m) => m.type === type)) return sent;
		await new Promise((r) => setTimeout(r, 0));
	}
	return view.webview.postMessage.mock.calls.map((c) => c[0] as SidebarInboundMsg);
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

	it("blocks a `command` message whose command is not a jollimemory.* command", () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "command",
			command: "workbench.action.terminal.sendSequence",
			args: ["rm -rf ~"],
		} as unknown as SidebarOutboundMsg);
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it("allows the built-in `vscode.open` command the sidebar uses for external links", () => {
		// The "View on Jolli" PR / synced-doc rows dispatch { command: 'vscode.open' }
		// because webviews cannot follow <a href>. The confused-deputy guard must let
		// this specific built-in through (it is on the allowlist), or those links die.
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "command",
			command: "vscode.open",
			args: ["https://jolli.ai/x"],
		} as unknown as SidebarOutboundMsg);
		expect(executeCommand).toHaveBeenCalledWith("vscode.open", "https://jolli.ai/x");
	});

	it("blocks a `vscode.open` command carrying a `command:` scheme URI", () => {
		// The command-name allowlist is not enough: vscode.open resolves ANY URI it
		// is handed. A `command:` URI would run an arbitrary VS Code command with
		// webview-controlled args — the exact confused-deputy hole the name gate
		// was meant to close. A corrupted memory row's href must not reach the host.
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "command",
			command: "vscode.open",
			args: ["command:jollimemory.deleteEverything?%5B%22x%22%5D"],
		} as unknown as SidebarOutboundMsg);
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it("blocks a `vscode.open` command carrying a `file:` scheme URI", () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "command",
			command: "vscode.open",
			args: ["file:///etc/passwd"],
		} as unknown as SidebarOutboundMsg);
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it("blocks a `vscode.open` command whose URI argument is not a string", () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "command",
			command: "vscode.open",
			args: [{ scheme: "command" }],
		} as unknown as SidebarOutboundMsg);
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it("blocks a `vscode.open` command whose argument is not a parseable URL", () => {
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "command",
			command: "vscode.open",
			args: ["not a url"],
		} as unknown as SidebarOutboundMsg);
		expect(executeCommand).not.toHaveBeenCalled();
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
			getHeadShortHash: () => "269d108",
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		// Initial pushStatus on ready: busy=false, and no commit hash attached
		// while idle (the git call is skipped unless busy).
		const initial = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			initial.some(
				(m) =>
					m.type === "worker:busy" &&
					m.busy === false &&
					m.commit === undefined,
			),
		).toBe(true);
		// Flip the flag and re-fire onDidChangeTreeData; expect a follow-up push
		// with busy=true carrying the HEAD short hash for the Summarizing row.
		busyValue = true;
		storedHandler?.();
		const after = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			after.some(
				(m) =>
					m.type === "worker:busy" && m.busy === true && m.commit === "269d108",
			),
		).toBe(true);
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

	it("kb:openFile does nothing when resolveKbAbs rejects the path (traversal escape → undefined)", () => {
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
			// Mirrors the real resolveKbAbs returning undefined for an escaping path.
			resolveKbAbs: () => undefined,
		});
		provider.resolveWebviewView(view as unknown as never);
		expect(() =>
			view.webview.triggerMessage({ type: "kb:openFile", path: "../../etc/passwd" }),
		).not.toThrow();
		expect(exec).not.toHaveBeenCalled();
	});

	it("posts kb:markDiverged when an opened .md is diverged on disk", async () => {
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
			isMemoryFileDivergedOnDisk: vi.fn().mockResolvedValue(true),
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "kb:openFile",
			path: "repo/main/memo.md",
		});
		await flushReady();
		expect(view.webview.postMessage).toHaveBeenCalledWith({
			type: "kb:markDiverged",
			path: "repo/main/memo.md",
		});
	});

	it("posts kb:clearDiverged (not markDiverged) when the opened .md is in sync", async () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
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
			isMemoryFileDivergedOnDisk: vi.fn().mockResolvedValue(false),
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "kb:openFile", path: "repo/main/memo.md" });
		await flushReady();
		// A clean check actively clears the row, so reopening a now-synced file
		// drops a ✎ left by an earlier open instead of leaving it stuck.
		expect(view.webview.postMessage).toHaveBeenCalledWith({
			type: "kb:clearDiverged",
			path: "repo/main/memo.md",
		});
		expect(view.webview.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "kb:markDiverged" }),
		);
	});

	it("lets the latest open win: an older slow diverged check can't re-mark after a newer in-sync check", async () => {
		const view = makeMockView();
		// First open's check is slow and reports diverged; second open's check is
		// immediate and reports in-sync. The stale first result must be dropped.
		let resolveFirst!: (v: boolean) => void;
		const firstCheck = new Promise<boolean>((res) => {
			resolveFirst = res;
		});
		const check = vi
			.fn()
			.mockReturnValueOnce(firstCheck)
			.mockReturnValueOnce(Promise.resolve(false));
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
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
			isMemoryFileDivergedOnDisk: check,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "kb:openFile", path: "repo/main/memo.md" });
		view.webview.triggerMessage({ type: "kb:openFile", path: "repo/main/memo.md" });
		await flushReady();
		// Second (latest) open resolved in-sync → cleared.
		expect(view.webview.postMessage).toHaveBeenCalledWith({
			type: "kb:clearDiverged",
			path: "repo/main/memo.md",
		});
		resolveFirst(true);
		await flushReady();
		// First (stale) open's diverged result must NOT re-light the marker.
		expect(view.webview.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "kb:markDiverged" }),
		);
	});

	it("clearKnowledgeBaseFolderDivergence posts a targeted kb:clearDiverged, not a tree-collapsing reset", () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
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
		provider.clearKnowledgeBaseFolderDivergence("repo/main/memo.md");
		expect(view.webview.postMessage).toHaveBeenCalledWith({
			type: "kb:clearDiverged",
			path: "repo/main/memo.md",
		});
		// A single-file revert must not wipe the client's folderCache — that's
		// what collapsed every expanded branch directory before the fix.
		expect(view.webview.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "kb:foldersReset" }),
		);
	});

	it("drops a stale kb:markDiverged when the row is reverted while the disk check is in flight", async () => {
		const view = makeMockView();
		// Hold the divergence check open so we can revert the same row before it
		// resolves — the bytes we sha'd are now stale, so the mark must be dropped.
		let resolveCheck!: (v: boolean) => void;
		const pending = new Promise<boolean>((res) => {
			resolveCheck = res;
		});
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
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
			isMemoryFileDivergedOnDisk: vi.fn().mockReturnValue(pending),
		});
		provider.resolveWebviewView(view as unknown as never);
		// Open the diverged file: kicks off the in-flight check.
		view.webview.triggerMessage({
			type: "kb:openFile",
			path: "repo/main/memo.md",
		});
		// User reverts the same row before the check resolves.
		provider.clearKnowledgeBaseFolderDivergence("repo/main/memo.md");
		// Now the slow check resolves "diverged" against the pre-revert bytes.
		resolveCheck(true);
		await flushReady();
		expect(view.webview.postMessage).toHaveBeenCalledWith({
			type: "kb:clearDiverged",
			path: "repo/main/memo.md",
		});
		expect(view.webview.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "kb:markDiverged" }),
		);
	});

	it("does not let an unrelated revert suppress a row's kb:markDiverged", async () => {
		const view = makeMockView();
		const provider = new SidebarWebviewProvider({
			executeCommand: vi.fn(),
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
			isMemoryFileDivergedOnDisk: vi.fn().mockResolvedValue(true),
		});
		provider.resolveWebviewView(view as unknown as never);
		// A different row is reverted; the per-path seq is keyed by relPath, so it
		// must not gate the opened file's mark.
		provider.clearKnowledgeBaseFolderDivergence("repo/main/other.md");
		view.webview.triggerMessage({
			type: "kb:openFile",
			path: "repo/main/memo.md",
		});
		await flushReady();
		expect(view.webview.postMessage).toHaveBeenCalledWith({
			type: "kb:markDiverged",
			path: "repo/main/memo.md",
		});
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

	it("forwards branch:openReference via jollimemory.openReferenceInBrowser", () => {
		// Sidebar row-click → open external entity (Linear / Jira / GitHub /
		// Notion) in browser. Pins the case-branch the panel dispatches when
		// the row is an entity row.
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
			type: "branch:openReference",
			mapKey: "linear:PROJ-1528",
		});
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.openReferenceInBrowser",
			"linear:PROJ-1528",
		);
	});

	it("forwards branch:openReferenceMarkdown via jollimemory.openReferenceMarkdown", () => {
		// Context-menu "Edit Markdown" path — opens the on-disk markdown copy
		// in a text editor rather than the browser URL.
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
			type: "branch:openReferenceMarkdown",
			mapKey: "jira:KAN-5",
		});
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.openReferenceMarkdown",
			"jira:KAN-5",
		);
	});

	it("forwards branch:openReferencePreview via jollimemory.openReferenceForPreview", () => {
		// Sidebar row-click path — reference rows preview on click like
		// plan/note rows; the editor path stays on branch:openReferenceMarkdown.
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
			type: "branch:openReferencePreview",
			mapKey: "linear:PROJ-1528",
		});
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.openReferenceForPreview",
			"linear:PROJ-1528",
		);
	});

	it("forwards branch:ignoreReference via jollimemory.ignoreReference", () => {
		// Trash-button path — hides the entity from the panel. Mirrors the
		// existing Plan/Note ignore wiring.
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
			type: "branch:ignoreReference",
			mapKey: "github:owner/repo#42",
		});
		expect(exec).toHaveBeenCalledWith(
			"jollimemory.ignoreReference",
			"github:owner/repo#42",
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

	it("posts the branch token total from stats.total, not the sum of the reported segments", async () => {
		// A branch with a newly amended/squashed root wrapping pre-breakdown history
		// has memories whose row subline (aggregateConversationTokens, scalar) counts
		// legacy child tokens the per-segment breakdown does not carry. If the bar
		// derives its total from input+output+cached it reads LESS than the sum of
		// its own rows. The host must post the scalar-based `total` verbatim so the
		// bar and the rows reconcile; the coloured segments stay a floor.
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
			// Segments sum to 125, but the true scalar branch total is 500 (the extra
			// 375 lives on legacy scalar-only memories with no breakdown).
			getBranchTokenStats: async () => ({
				input: 100,
				output: 20,
				cached: 5,
				total: 500,
				reporting: 1,
				memories: 3,
			}),
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await new Promise((r) => setTimeout(r, 0));
		const msgs = view.webview.postMessage.mock.calls.map((c) => c[0]) as unknown[];
		const statsMsg = msgs.find(
			(m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "branch:tokenStats",
		) as { total?: number } | undefined;
		expect(statsMsg).toBeDefined();
		expect(statsMsg?.total).toBe(500);
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

	it("handles refresh scope='branch-current' by refreshing the draft only (not history)", () => {
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
		view.webview.triggerMessage({ type: "refresh", scope: "branch-current" });
		const cmds = exec.mock.calls.map((c) => c[0]);
		expect(cmds).toContain("jollimemory.refreshPlans");
		expect(cmds).toContain("jollimemory.refreshFiles");
		expect(cmds).not.toContain("jollimemory.refreshHistory");
	});

	it("handles refresh scope='branch-commits' by refreshing history only (not the draft)", () => {
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
		view.webview.triggerMessage({ type: "refresh", scope: "branch-commits" });
		const cmds = exec.mock.calls.map((c) => c[0]);
		expect(cmds).toContain("jollimemory.refreshHistory");
		expect(cmds).not.toContain("jollimemory.refreshPlans");
		expect(cmds).not.toContain("jollimemory.refreshFiles");
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

	it("toggleStatus posts status:toggle", () => {
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
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		provider.toggleStatus();
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(
			sent.some(
				(m) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: unknown }).type === "status:toggle",
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

	it("branch:deselectAllCommits forwards to deps.deselectAllCommits", () => {
		const view = makeMockView();
		const deselectAllCommits = vi.fn();
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
			deselectAllCommits,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "branch:deselectAllCommits" });
		expect(deselectAllCommits).toHaveBeenCalledTimes(1);
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

	it("dispatches branch:toggleReferenceSelection to applyReferenceCheckbox", () => {
		const view = makeMockView();
		const applyReferenceCheckbox = vi.fn();
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
			applyReferenceCheckbox,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({
			type: "branch:toggleReferenceSelection",
			mapKey: "jira:PROJ-1",
			selected: false,
		});
		expect(applyReferenceCheckbox).toHaveBeenCalledWith("jira:PROJ-1", false);
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

	it("refreshKnowledgeBaseFolders re-pushes selection:repos and selection:branches for the current repo", async () => {
		// Regression for the post-sync tree-view bug: a sync round pulls
		// new branch directories onto disk, but the breadcrumb's branch
		// dropdown is populated via `selection:branches` which is only
		// sent at init / repo-switch time. Pre-fix the dropdown stayed
		// frozen until the user manually switched repos. The fix re-pushes
		// both `selection:repos` and `selection:branches` on every
		// refresh, since both `listRepos()` and `listBranches()` read
		// fresh from disk.
		const view = makeMockView();
		const tree = { name: "", relPath: "", isDirectory: true, children: [] };
		const kbFolders = {
			listChildren: vi.fn().mockResolvedValue(tree),
			notifyDirty: vi.fn(),
		};
		const selection = {
			listRepos: vi.fn(() => [
				{ repoName: "alpha", remoteUrl: undefined, isCurrent: false },
				{ repoName: "beta", remoteUrl: undefined, isCurrent: true },
			]),
			listBranches: vi.fn(() => ["main", "feat/x"]),
			listBranchMemories: vi.fn(),
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
			selection,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		selection.listRepos.mockClear();
		selection.listBranches.mockClear();

		provider.refreshKnowledgeBaseFolders();
		await new Promise((r) => setTimeout(r, 0));

		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		const reposMsg = sent.find(
			(m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "selection:repos",
		);
		const branchesMsg = sent.find(
			(m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "selection:branches",
		);
		expect(reposMsg).toBeDefined();
		expect(branchesMsg).toBeDefined();
		// Picks the current repo for branch fetch.
		expect((branchesMsg as { repoName: string }).repoName).toBe("beta");
		expect((branchesMsg as { branches: string[] }).branches).toEqual(["main", "feat/x"]);
		expect(selection.listBranches).toHaveBeenCalledWith("beta");
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

	it("selection:request with only branchName posts selection:set without re-listing branches", async () => {
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
		await new Promise((r) => setTimeout(r, 0));
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => c[0],
		) as SidebarInboundMsg[];
		// selection:set is the primary assertion; branch:pinsData follows (pushPins on branch switch).
		expect(sent).toContainEqual({
			type: "selection:set",
			repoName: "other-repo",
			branchName: "draft",
		});
		expect(sent).toContainEqual({ type: "branch:pinsData", items: [] });
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

	// refreshConversationsPanel is a public re-pull hook (called from
	// Extension.ts after a conversation save outside the panel's own
	// onSessionChanged). It just delegates to pushConversations, so a
	// listWithDiagnostics call is the observable side-effect.
	it("refreshConversationsPanel() re-pulls via listWithDiagnostics", async () => {
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
		listWithDiagnostics.mockClear();
		await provider.refreshConversationsPanel();
		expect(listWithDiagnostics).toHaveBeenCalledTimes(1);
		const conv = view.webview.postMessage.mock.calls
			.map((c) => c[0] as SidebarInboundMsg)
			.find(
				(m): m is SidebarInboundMsg & { type: "branch:conversationsData" } =>
					m.type === "branch:conversationsData",
			);
		expect(conv).toBeDefined();
	});

	// refreshPlansPanel is the public counterpart to refreshConversationsPanel
	// — Extension.ts calls it after an out-of-band plan edit. It delegates to
	// pushPlans, whose observable side-effect is a branch:plansData post built
	// from plansProvider.serialize().
	it("refreshPlansPanel() re-pushes branch:plansData", async () => {
		const view = makeMockView();
		const plansProvider = {
			serialize: vi.fn().mockReturnValue([
				{ id: "p1", label: "Plan A", contextValue: "plan" },
			]),
			onDidChangeTreeData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		};
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
			plansProvider,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		plansProvider.serialize.mockClear();
		await provider.refreshPlansPanel();
		expect(plansProvider.serialize).toHaveBeenCalledTimes(1);
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(sent.some((m) => m.type === "branch:plansData")).toBe(true);
	});

	// pushStatus also pushes a `sync:phase` message when the (optional)
	// getSyncPhase provider method is present. Existing status tests stub only
	// getWorkerBusy, so this case pins the orchestrator per-phase indicator
	// path and asserts the payload travels verbatim.
	it("pushStatus posts sync:phase when statusProvider.getSyncPhase is wired", async () => {
		const view = makeMockView();
		const phase = { label: "uploading…", severity: "info" as const };
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
			statusProvider: {
				serialize: () => [],
				onDidChangeTreeData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				getWorkerBusy: () => false,
				getSyncPhase: () => phase,
			},
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
		expect(sent).toContainEqual({ type: "sync:phase", phase });
	});

	// handleReady calls pushBranches(currentRepoName) when the initial state
	// names a repo. pushBranches still has to no-op gracefully when the
	// `selection` dep was never wired (a host that surfaces a repo name from
	// getInitialState but omits the breadcrumb provider). This pins the guard's
	// early-return so no selection:branches goes out.
	it("handleReady's pushBranches is a no-op when currentRepoName is set but selection dep is absent", async () => {
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
				currentRepoName: "workspace-repo",
			}),
			extensionUri: mockExtensionUri as unknown as never,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.triggerMessage({ type: "ready" });
		await flushReady();
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => (c[0] as SidebarInboundMsg).type,
		);
		// No selection:* messages because the dep isn't wired — pushBranches and
		// pushRepos both hit their `if (!this.deps.selection) return;` guards.
		expect(sent.filter((t) => t.startsWith("selection:"))).toEqual([]);
	});

	// selection:request with neither repoName nor branchName falls through both
	// guarded blocks (repoName branch + branchName branch) to the end of
	// handleSelectionRequest — a malformed request the host must tolerate as a
	// silent no-op rather than throwing or posting a half-formed selection:set.
	it("selection:request with neither repoName nor branchName is a silent no-op", () => {
		const view = makeMockView();
		const listRepos = vi
			.fn()
			.mockReturnValue([{ repoName: "workspace-repo", isCurrent: true }]);
		const listBranches = vi.fn().mockReturnValue(["main"]);
		const provider = makeSelectionProvider({ listRepos, listBranches });
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		view.webview.triggerMessage({ type: "selection:request" });
		expect(view.webview.postMessage).not.toHaveBeenCalled();
	});

	// refreshKnowledgeBaseFolders picks the current repo for the branch re-push
	// via `repos.find(r => r.isCurrent) ?? repos[0]`. When listRepos returns an
	// empty set, both the find and the repos[0] fallback resolve to undefined,
	// so the `if (current)` guard short-circuits and no selection:branches is
	// pushed — the breadcrumb just keeps whatever it had. Pins the empty-Memory
	// -Bank edge (no repos registered) so pushBranches is never called with an
	// undefined repo name.
	it("refreshKnowledgeBaseFolders skips the branch re-push when no repos are registered", async () => {
		const view = makeMockView();
		const tree = { name: "", relPath: "", isDirectory: true, children: [] };
		const kbFolders = {
			listChildren: vi.fn().mockResolvedValue(tree),
			notifyDirty: vi.fn(),
		};
		const selection = {
			listRepos: vi.fn(() => []),
			listBranches: vi.fn(() => ["main"]),
			listBranchMemories: vi.fn().mockResolvedValue([]),
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
			selection,
		});
		provider.resolveWebviewView(view as unknown as never);
		view.webview.postMessage.mockClear();
		selection.listBranches.mockClear();
		provider.refreshKnowledgeBaseFolders();
		await new Promise((r) => setTimeout(r, 0));
		// selection:repos still goes out (pushRepos is unconditional), but the
		// empty repo list means no current repo → no selection:branches.
		expect(selection.listBranches).not.toHaveBeenCalled();
		const sent = view.webview.postMessage.mock.calls.map(
			(c) => (c[0] as SidebarInboundMsg).type,
		);
		expect(sent).toContain("selection:repos");
		expect(sent).not.toContain("selection:branches");
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

	// A manual toolbar refresh on the Branch tab (scope "branch"/"all") must kick
	// the Codex polling-path reference discovery — the same hook `pushConversations`
	// runs on the 60s tick. Locks the wiring so a future handleRefresh refactor
	// can't silently drop it. (scope "kb"/"status" don't refresh conversations, so
	// they deliberately don't trigger it.)
	describe("manual refresh triggers Codex discovery", () => {
		function makeProviderWithCodex(discover: ReturnType<typeof vi.fn>): {
			provider: SidebarWebviewProvider;
			view: MockWebviewView;
		} {
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn().mockResolvedValue(undefined) as never,
				getInitialState: () => ({
					enabled: true,
					authenticated: false,
					activeTab: "branch",
					kbMode: "folders",
					branchName: "main",
					detached: false,
				}),
				extensionUri: mockExtensionUri as unknown as never,
				activeSessionsProvider: {
					listWithDiagnostics: vi.fn().mockResolvedValue({ items: [], failedSources: [] }),
				} as unknown as never,
				codexDiscovery: { discover },
			});
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			return { provider, view };
		}

		it.each(["branch", "all"] as const)("invokes discover() on a %s-scope refresh", (scope) => {
			const discover = vi.fn();
			const { view } = makeProviderWithCodex(discover);
			view.webview.triggerMessage({ type: "refresh", scope } as SidebarOutboundMsg);
			expect(discover).toHaveBeenCalledTimes(1);
		});

		it.each(["kb", "status"] as const)("does NOT invoke discover() on a %s-scope refresh", (scope) => {
			const discover = vi.fn();
			const { view } = makeProviderWithCodex(discover);
			view.webview.triggerMessage({ type: "refresh", scope } as SidebarOutboundMsg);
			expect(discover).not.toHaveBeenCalled();
		});

		it("still pushes the conversation list when discover() throws synchronously", () => {
			const discover = vi.fn(() => {
				throw new Error("discovery wrapper regressed");
			});
			const { view } = makeProviderWithCodex(discover);
			// A throwing background discovery must NOT take down the refresh: the
			// triggerMessage call must not throw and the conversations fetch still runs.
			expect(() =>
				view.webview.triggerMessage({ type: "refresh", scope: "branch" } as SidebarOutboundMsg),
			).not.toThrow();
			expect(discover).toHaveBeenCalledTimes(1);
		});
	});

	describe("kb:expandMemory → kb:memoryEvidence", () => {
		it("posts kb:memoryEvidence with projected conversations/context/files from the summary", async () => {
			const view = makeMockView();
			const fakeSummary = {
				version: 5,
				commitHash: "abc1234",
				commitMessage: "feat: add widget",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: ["tid-1"],
				plans: [{ slug: "plan-a", title: "Plan A", addedAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }],
				notes: [{ id: "note-1", title: "Note 1", format: "markdown" as const, addedAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }],
				references: [{ archivedKey: "linear:PROJ-1", source: "linear" as const, nativeId: "PROJ-1", title: "PROJ-1", url: "https://linear.app/proj-1" }],
				topics: [
					{ title: "Widget", trigger: "x", response: "y", decisions: "z", filesAffected: ["src/widget.ts", "src/index.ts"] },
					{ title: "Tests", trigger: "a", response: "b", decisions: "c", filesAffected: ["src/widget.ts", "src/widget.test.ts"] },
				],
			};
			const fakeTranscript = {
				sessions: [
					{ sessionId: "sess-abc", source: "claude" as const, transcriptPath: "/tmp/claude.jsonl" },
				],
			};
			const getSummaryByHash = vi.fn().mockResolvedValue(fakeSummary);
			const readTranscriptById = vi.fn().mockResolvedValue(fakeTranscript);
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn(),
				getInitialState: () => ({
					enabled: true,
					authenticated: false,
					activeTab: "kb",
					kbMode: "memories",
					branchName: "main",
					detached: false,
					currentRepoName: "myrepo",
				}),
				extensionUri: mockExtensionUri as unknown as never,
				getSummaryByHash,
				readTranscriptById,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "abc1234" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const evidenceMsg = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(evidenceMsg).toBeDefined();
			expect(evidenceMsg.commitHash).toBe("abc1234");
			// conversations: one item from the fake transcript session
			expect(evidenceMsg.evidence.conversations).toHaveLength(1);
			expect(evidenceMsg.evidence.conversations[0]).toMatchObject({
				kind: "conversation",
				id: "sess-abc",
				source: "claude",
				transcriptPath: "/tmp/claude.jsonl",
				// No `entries` on the fake session → archived turn count falls back to 0.
				messageCount: 0,
			});
			// context: plan + note + reference
			expect(evidenceMsg.evidence.context).toHaveLength(3);
			expect(evidenceMsg.evidence.context.find((i: { kind: string }) => i.kind === "plan")?.id).toBe("plan-a");
			expect(evidenceMsg.evidence.context.find((i: { kind: string }) => i.kind === "note")?.id).toBe("note-1");
			const refItem = evidenceMsg.evidence.context.find((i: { kind: string }) => i.kind === "reference");
			expect(refItem?.id).toBe("linear:PROJ-1");
			// `source` must ride along — the Timeline reads the archived reference
			// snapshot by source + archivedKey (the live mapKey path is dead post-commit).
			expect(refItem?.source).toBe("linear");
			// Local memory (getSummaryByHash, no provenance): sourceRepoName is null.
			expect(evidenceMsg.evidence.sourceRepoName).toBeNull();
			// files: deduplicated across topics
			expect(evidenceMsg.evidence.files).toHaveLength(3);
			const filePaths = evidenceMsg.evidence.files.map((f: { relativePath: string }) => f.relativePath);
			expect(filePaths).toContain("src/widget.ts");
			expect(filePaths).toContain("src/index.ts");
			expect(filePaths).toContain("src/widget.test.ts");
		});

		it("dedupes a session spanning multiple transcripts into a single conversation row, merging its entry slices", async () => {
			// A long-running session is captured once per commit it spans: each
			// transcript file holds only the unread turns consumed at THAT commit
			// (disjoint, sequential slices — NOT a full copy). A consolidated /
			// squashed summary references every such transcript, so flattening
			// `stored.sessions` across them used to emit one duplicate row per
			// transcript (observed: 17 identical-title rows for one session). All
			// rows shared `${source}:${sessionId}:${commitHash}`, so the panel
			// registry collapsed them to a single panel — clicking any row past the
			// first only re-revealed the first. Dedupe by (source, sessionId),
			// concatenating slices in first-seen order to reconstruct the full
			// conversation.
			const view = makeMockView();
			const fakeSummary = {
				version: 5,
				commitHash: "dup1234",
				commitMessage: "consolidated work",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: ["tid-1", "tid-2", "tid-3"],
				topics: [],
			};
			// Same (source, sessionId) in every transcript, each carrying a
			// different sequential slice of the conversation.
			const sliceFor = (tid: string) => ({
				sessions: [
					{
						sessionId: "sess-dup",
						source: "claude" as const,
						transcriptPath: "/tmp/dup.jsonl",
						entries:
							tid === "tid-1"
								? [{ role: "human" as const, content: "实现去重逻辑" }]
								: tid === "tid-2"
									? [{ role: "assistant" as const, content: "Task 1 DONE" }]
									: [{ role: "assistant" as const, content: "Task 2 DONE" }],
					},
				],
			});
			const readTranscriptById = vi.fn().mockImplementation((tid: string) => Promise.resolve(sliceFor(tid)));
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
				getSummaryByHash: vi.fn().mockResolvedValue(fakeSummary),
				readTranscriptById,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "dup1234" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const evidenceMsg = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(evidenceMsg).toBeDefined();
			// One row, not three — the session is collapsed across transcripts.
			expect(evidenceMsg.evidence.conversations).toHaveLength(1);
			expect(evidenceMsg.evidence.conversations[0]).toMatchObject({
				kind: "conversation",
				id: "sess-dup",
				source: "claude",
			});
			// Title resolves from the merged first human turn (slice order preserved).
			expect(evidenceMsg.evidence.conversations[0].title).toBe("实现去重逻辑");
			// messageCount counts the merged archived turns across all 3 slices.
			expect(evidenceMsg.evidence.conversations[0].messageCount).toBe(3);
		});

		it("enriches local-memory file evidence with real git status via listCommitFiles (added/renamed diff correctly)", async () => {
			// REGRESSION: file evidence was projected from summary.topics[].filesAffected
			// (path-only), so statusCode defaulted to 'M'. Added/deleted/renamed files
			// then diffed against the parent commit where they don't exist → the editor
			// errored "file was not found". The fix sources files from git truth
			// (listCommitFiles), the same path the Branch-tab commit-file rows use.
			const view = makeMockView();
			const fakeSummary = {
				version: 5,
				commitHash: "fff1234",
				commitMessage: "feat: files",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: [],
				// Topic paths are now ignored when git truth is available — and they
				// deliberately disagree with the commit's real file set below.
				topics: [{ title: "t", trigger: "x", response: "y", decisions: "z", filesAffected: ["src/stale.ts"] }],
			};
			const listCommitFiles = vi.fn().mockResolvedValue([
				{ relativePath: "src/added.ts", statusCode: "A" },
				{ relativePath: "src/mod.ts", statusCode: "M" },
				{ relativePath: "src/new-name.ts", statusCode: "R", oldPath: "src/old-name.ts" },
			]);
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
				getSummaryByHash: vi.fn().mockResolvedValue(fakeSummary),
				listCommitFiles,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "fff1234" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const ev = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(listCommitFiles).toHaveBeenCalledWith("fff1234");
			const files = ev.evidence.files as Array<{ relativePath: string; statusCode?: string; oldPath?: string }>;
			// Files are the commit's real changed set (git truth), not the stale topic path.
			expect(files.map((f) => f.relativePath)).toEqual(["src/added.ts", "src/mod.ts", "src/new-name.ts"]);
			expect(files.find((f) => f.relativePath === "src/added.ts")?.statusCode).toBe("A");
			const renamed = files.find((f) => f.relativePath === "src/new-name.ts");
			expect(renamed?.statusCode).toBe("R");
			expect(renamed?.oldPath).toBe("src/old-name.ts");
		});

		it("falls back to topic file paths when listCommitFiles yields nothing (e.g. unreadable commit)", async () => {
			const view = makeMockView();
			const fakeSummary = {
				version: 5,
				commitHash: "eee1234",
				commitMessage: "feat: x",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: [],
				topics: [{ title: "t", trigger: "x", response: "y", decisions: "z", filesAffected: ["src/a.ts", "src/b.ts"] }],
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
				getSummaryByHash: vi.fn().mockResolvedValue(fakeSummary),
				// Rejects → caught → empty → topic fallback.
				listCommitFiles: vi.fn().mockRejectedValue(new Error("bad object")),
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "eee1234" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const ev = sent.find((m) => m.type === "kb:memoryEvidence");
			const files = ev.evidence.files as Array<{ relativePath: string; statusCode?: string }>;
			expect(files.map((f) => f.relativePath)).toEqual(["src/a.ts", "src/b.ts"]);
			// Path-only fallback carries no statusCode (the row defaults to 'M').
			expect(files[0].statusCode).toBeUndefined();
		});

		it("derives the conversation title from the archived first human turn, not the session UUID (BUG 1)", async () => {
			const view = makeMockView();
			const fakeSummary = {
				version: 5,
				commitHash: "ttl1234",
				commitMessage: "feat: x",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: ["tid-1"],
				topics: [],
			};
			// The archived snapshot carries full `entries`; the first human turn
			// is the title source (matches the working-memory list's label).
			const fakeTranscript = {
				sessions: [
					{
						sessionId: "a8e0d4cc-92c9-4146-9fe0-0fa2e9f7176d",
						source: "claude" as const,
						transcriptPath: "/tmp/claude.jsonl",
						entries: [
							{ role: "assistant" as const, content: "Sure, let me look." },
							{ role: "human" as const, content: "分析迁移统计数据和shard分配" },
						],
					},
				],
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
				getSummaryByHash: vi.fn().mockResolvedValue(fakeSummary),
				readTranscriptById: vi.fn().mockResolvedValue(fakeTranscript),
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "ttl1234" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const evidenceMsg = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(evidenceMsg.evidence.conversations).toHaveLength(1);
			const conv = evidenceMsg.evidence.conversations[0];
			// id stays the UUID (used to re-find the archived session on click);
			// title is the human-readable first turn, NOT the UUID.
			expect(conv.id).toBe("a8e0d4cc-92c9-4146-9fe0-0fa2e9f7176d");
			expect(conv.title).toBe("分析迁移统计数据和shard分配");
			expect(conv.title).not.toBe(conv.id);
		});

		it("uses the Claude ai-title when the live transcript is present, not the raw first turn (parity with working-memory list)", async () => {
			// Repro for the committed-memory CONVERSATIONS list showing raw first
			// turns ("继续", "1", "<task-notification>…") instead of the same
			// human-readable label the working-memory "All Conversations" list
			// shows. The working-memory list resolves titles via
			// resolveSessionTitle, which prefers Claude's `ai-title` row; this
			// surface must too. The `ai-title` row is stripped from the archived
			// `entries`, so it can only be recovered by re-reading the live
			// transcript at session.transcriptPath.
			const dir = mkdtempSync(join(tmpdir(), "jolli-aititle-"));
			const transcriptPath = join(dir, "claude.jsonl");
			writeFileSync(
				transcriptPath,
				[
					'{"type":"user","message":{"content":"继续"}}',
					'{"type":"ai-title","aiTitle":"重新设计 Knowledge 侧边栏","sessionId":"sess-junk"}',
				].join("\n"),
			);
			try {
				const fakeSummary = {
					version: 5,
					commitHash: "ait1234",
					commitMessage: "feat: x",
					commitAuthor: "Dev",
					commitDate: "2024-01-01T00:00:00Z",
					branch: "main",
					generatedAt: "2024-01-01T00:01:00Z",
					transcripts: ["tid-1"],
					topics: [],
				};
				const fakeTranscript = {
					sessions: [
						{
							sessionId: "sess-junk",
							source: "claude" as const,
							transcriptPath,
							// Archived entries: the first human turn is the junk "继续".
							entries: [{ role: "human" as const, content: "继续" }],
						},
					],
				};
				const view = makeMockView();
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
					getSummaryByHash: vi.fn().mockResolvedValue(fakeSummary),
					readTranscriptById: vi.fn().mockResolvedValue(fakeTranscript),
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.postMessage.mockClear();
				view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "ait1234" });
				const sent = await flushUntilMessage(view, "kb:memoryEvidence");
				const evidenceMsg = sent.find((m) => m.type === "kb:memoryEvidence");
				const conv = evidenceMsg.evidence.conversations[0];
				expect(conv.title).toBe("重新设计 Knowledge 侧边栏");
				expect(conv.title).not.toBe("继续");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("posts empty evidence groups when getSummaryByHash returns undefined", async () => {
			const view = makeMockView();
			const getSummaryByHash = vi.fn().mockResolvedValue(undefined);
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
				getSummaryByHash,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "missing123" });
			await new Promise((r) => setTimeout(r, 0));
			const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
			const evidenceMsg = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(evidenceMsg).toBeDefined();
			expect(evidenceMsg.commitHash).toBe("missing123");
			expect(evidenceMsg.evidence.conversations).toHaveLength(0);
			expect(evidenceMsg.evidence.context).toHaveLength(0);
			expect(evidenceMsg.evidence.files).toHaveLength(0);
		});

		it("posts empty evidence when getSummaryByHash rejects (outer catch)", async () => {
			const view = makeMockView();
			const getSummaryByHash = vi.fn().mockRejectedValue(new Error("storage error"));
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
				getSummaryByHash,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "bad456" });
			await new Promise((r) => setTimeout(r, 0));
			const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
			const evidenceMsg = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(evidenceMsg).toBeDefined();
			expect(evidenceMsg.commitHash).toBe("bad456");
			expect(evidenceMsg.evidence.conversations).toHaveLength(0);
			expect(evidenceMsg.evidence.context).toHaveLength(0);
			expect(evidenceMsg.evidence.files).toHaveLength(0);
		});

		it("skips a transcript ID when readTranscriptById rejects (inner catch)", async () => {
			const view = makeMockView();
			const fakeSummary = {
				version: 5,
				commitHash: "abc111",
				commitMessage: "fix: bug",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: ["tid-ok", "tid-bad"],
				plans: [],
				notes: [],
				references: [],
				topics: [],
			};
			const getSummaryByHash = vi.fn().mockResolvedValue(fakeSummary);
			const readTranscriptById = vi.fn()
				.mockResolvedValueOnce({ sessions: [{ sessionId: "s1", source: "claude" as const, transcriptPath: "/tmp/a.jsonl" }] })
				.mockRejectedValueOnce(new Error("read failed"));
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
				getSummaryByHash,
				readTranscriptById,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "abc111" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const evidenceMsg = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(evidenceMsg).toBeDefined();
			// Only the successful transcript contributes; the failing one is silently skipped.
			expect(evidenceMsg.evidence.conversations).toHaveLength(1);
			expect(evidenceMsg.evidence.conversations[0].id).toBe("s1");
		});

		it("posts empty evidence when getSummaryByHash dep is absent", async () => {
			const view = makeMockView();
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
				// getSummaryByHash intentionally absent
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "nodep123" });
			await new Promise((r) => setTimeout(r, 0));
			const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
			const evidenceMsg = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(evidenceMsg).toBeDefined();
			expect(evidenceMsg.evidence.conversations).toHaveLength(0);
			expect(evidenceMsg.evidence.context).toHaveLength(0);
			expect(evidenceMsg.evidence.files).toHaveLength(0);
		});

		it("populates Conversations from foreign-repo storage when sourceRepoName is set", async () => {
			// Memory belongs to "other-repo", not the cwd workspace. The transcript
			// exists in the foreign repo's storage but NOT in the cwd storage. The
			// cwd-only readTranscriptById returns null; readTranscriptForRepo reads
			// from the source-specific storage and must return the transcript.
			const view = makeMockView();
			const foreignSummary = {
				version: 5,
				commitHash: "foreign123",
				commitMessage: "feat: foreign widget",
				commitAuthor: "Dev",
				commitDate: "2024-02-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-02-01T00:01:00Z",
				transcripts: ["foreign-tid-1"],
				plans: [],
				notes: [],
				references: [],
				topics: [{ title: "Widget", trigger: "x", response: "y", decisions: "z", filesAffected: ["src/widget.ts"] }],
			};
			const foreignTranscript = {
				sessions: [
					{ sessionId: "foreign-sess-1", source: "claude" as const, transcriptPath: "/other-repo/claude.jsonl" },
				],
			};
			// getSummaryAnyRepoWithSource returns the summary with sourceRepoName set (foreign repo)
			const getSummaryAnyRepoWithSource = vi.fn().mockResolvedValue({
				summary: foreignSummary,
				sourceRepoName: "other-repo",
				sourceRemoteUrl: "https://github.com/org/other-repo",
			});
			// readTranscriptForRepo returns the transcript when called with the foreign source info,
			// simulating reading from the foreign repo's storage.
			const readTranscriptForRepo = vi.fn().mockImplementation(
				(_id: string, sourceRepoName: string | null, _sourceRemoteUrl: string | null) => {
					// Only the foreign storage has the transcript; cwd (null) would return null.
					return Promise.resolve(sourceRepoName === "other-repo" ? foreignTranscript : null);
				},
			);
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn(),
				getInitialState: () => ({
					enabled: true,
					authenticated: false,
					activeTab: "kb",
					kbMode: "memories",
					branchName: "main",
					detached: false,
					currentRepoName: "my-repo",
				}),
				extensionUri: mockExtensionUri as unknown as never,
				getSummaryAnyRepoWithSource,
				readTranscriptForRepo,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "foreign123" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const evidenceMsg = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(evidenceMsg).toBeDefined();
			expect(evidenceMsg.commitHash).toBe("foreign123");
			// Provenance rides along so note/reference opens route to the foreign
			// storage and file rows render non-interactive in the webview.
			expect(evidenceMsg.evidence.sourceRepoName).toBe("other-repo");
			expect(evidenceMsg.evidence.sourceRemoteUrl).toBe("https://github.com/org/other-repo");
			// Conversations group is POPULATED from the foreign repo's storage
			expect(evidenceMsg.evidence.conversations).toHaveLength(1);
			expect(evidenceMsg.evidence.conversations[0]).toMatchObject({
				kind: "conversation",
				id: "foreign-sess-1",
				source: "claude",
				transcriptPath: "/other-repo/claude.jsonl",
			});
			// readTranscriptForRepo was called with the source provenance, not null
			expect(readTranscriptForRepo).toHaveBeenCalledWith(
				"foreign-tid-1",
				"other-repo",
				"https://github.com/org/other-repo",
			);
			// Files come from summary topics (not transcript-dependent)
			expect(evidenceMsg.evidence.files).toHaveLength(1);
			expect(evidenceMsg.evidence.files[0].relativePath).toBe("src/widget.ts");
		});
	});

	describe("evidence open routing (archived paths)", () => {
		function makeEvidenceProvider() {
			const executeCommand = vi.fn().mockResolvedValue(undefined);
			const view = makeMockView();
			const provider = new SidebarWebviewProvider({
				executeCommand,
				getInitialState: () => ({
					enabled: true,
					authenticated: false,
					activeTab: "kb",
					kbMode: "memories",
					branchName: "main",
					detached: false,
					currentRepoName: "myrepo",
				}),
				extensionUri: mockExtensionUri as unknown as never,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			return { provider, view, executeCommand };
		}

		it("kb:openEvidenceNote routes to orphan-only jollimemory.previewNote with provenance", () => {
			const { view, executeCommand } = makeEvidenceProvider();
			view.webview.triggerMessage({
				type: "kb:openEvidenceNote",
				noteId: "note-7",
				title: "My Note",
				sourceRepoName: "other-repo",
				sourceRemoteUrl: "https://github.com/org/other-repo",
			});
			expect(executeCommand).toHaveBeenCalledWith(
				"jollimemory.previewNote",
				"note-7",
				"My Note",
				"other-repo",
				"https://github.com/org/other-repo",
			);
		});

		it("kb:openEvidencePlan routes to jollimemory.previewCommittedPlan with provenance", () => {
			const { view, executeCommand } = makeEvidenceProvider();
			view.webview.triggerMessage({
				type: "kb:openEvidencePlan",
				planId: "2026-06-22-some-plan",
				title: "Some Plan",
				sourceRepoName: "other-repo",
				sourceRemoteUrl: "https://github.com/org/other-repo",
			});
			expect(executeCommand).toHaveBeenCalledWith(
				"jollimemory.previewCommittedPlan",
				"2026-06-22-some-plan",
				"Some Plan",
				"other-repo",
				"https://github.com/org/other-repo",
			);
		});

		it("kb:openEvidenceReference routes to jollimemory.previewCommittedReference for a known source", () => {
			const { view, executeCommand } = makeEvidenceProvider();
			view.webview.triggerMessage({
				type: "kb:openEvidenceReference",
				archivedKey: "linear:PROJ-1-ab12cd34",
				source: "linear",
				sourceRepoName: null,
				sourceRemoteUrl: null,
			});
			expect(executeCommand).toHaveBeenCalledWith(
				"jollimemory.previewCommittedReference",
				"linear:PROJ-1-ab12cd34",
				"linear",
				null,
				null,
			);
		});

		it("kb:openEvidenceReference drops an unknown source without dispatching", () => {
			const { view, executeCommand } = makeEvidenceProvider();
			view.webview.triggerMessage({
				type: "kb:openEvidenceReference",
				archivedKey: "evil:x",
				source: "evil",
				sourceRepoName: null,
				sourceRemoteUrl: null,
			});
			expect(executeCommand).not.toHaveBeenCalled();
		});

		// BUG 3: a committed-memory conversation row must render the ARCHIVED
		// snapshot, not the live cursor-trimmed transcript (empty once the turns
		// are consumed into the commit). The host re-reads the orphan-branch
		// session by commitHash+sessionId and opens the panel in archived mode.
		const archivedSummary = {
			version: 5,
			commitHash: "arch1234",
			commitMessage: "feat: y",
			commitAuthor: "Dev",
			commitDate: "2024-01-01T00:00:00Z",
			branch: "main",
			generatedAt: "2024-01-01T00:01:00Z",
			transcripts: ["tid-1"],
			topics: [],
		};
		const archivedEntries = [
			{ role: "human" as const, content: "first turn" },
			{ role: "assistant" as const, content: "reply" },
		];
		const archivedTranscript = {
			sessions: [
				{
					sessionId: "sess-x",
					source: "claude" as const,
					transcriptPath: "/tmp/x.jsonl",
					entries: archivedEntries,
				},
			],
		};

		function makeArchivedConvProvider() {
			const view = makeMockView();
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
				getSummaryByHash: vi.fn().mockResolvedValue(archivedSummary),
				readTranscriptById: vi.fn().mockResolvedValue(archivedTranscript),
			});
			provider.resolveWebviewView(view as unknown as never);
			return { provider, view };
		}

		it("kb:openEvidenceConversation opens the archived snapshot read-only via ConversationDetailsPanel.show (BUG 3)", async () => {
			showMock.mockReset();
			const { view } = makeArchivedConvProvider();
			view.webview.triggerMessage({
				type: "kb:openEvidenceConversation",
				commitHash: "arch1234",
				sessionId: "sess-x",
				source: "claude",
				title: "first turn",
			});
			await new Promise((r) => setTimeout(r, 0));
			expect(showMock).toHaveBeenCalledTimes(1);
			const call = showMock.mock.calls[0][0] as {
				sessionId: string;
				source: string;
				title: string;
				commitHash: string;
				archivedEntries: unknown;
			};
			expect(call.sessionId).toBe("sess-x");
			expect(call.source).toBe("claude");
			expect(call.title).toBe("first turn");
			// commitHash discriminates the panel registry key; archivedEntries are
			// the full snapshot the panel renders verbatim (read-only).
			expect(call.commitHash).toBe("arch1234");
			expect(call.archivedEntries).toEqual(archivedEntries);
		});

		it.each([
			["unknown source", { commitHash: "arch1234", sessionId: "sess-x", source: "evil", title: "t" }],
			["empty commitHash", { commitHash: "", sessionId: "sess-x", source: "claude", title: "t" }],
			["empty sessionId", { commitHash: "arch1234", sessionId: "", source: "claude", title: "t" }],
			["empty title", { commitHash: "arch1234", sessionId: "sess-x", source: "claude", title: "" }],
		])("rejects kb:openEvidenceConversation with %s", async (_label, fields) => {
			showMock.mockReset();
			const { view } = makeArchivedConvProvider();
			view.webview.triggerMessage({ type: "kb:openEvidenceConversation", ...fields });
			await new Promise((r) => setTimeout(r, 0));
			expect(showMock).not.toHaveBeenCalled();
		});

		it("orders the merged slices chronologically when the transcripts array is not in time order", async () => {
			// `summary.transcripts` is NOT chronological for a consolidated memory
			// (observed: a later transcript holding turns from an EARLIER commit).
			// Each slice is internally time-ordered and a session's slices occupy
			// disjoint time ranges, so the merge must reorder slices by their start
			// timestamp — otherwise the panel shows 17:18 → 17:20 → 16:33 jumps.
			showMock.mockReset();
			const view = makeMockView();
			const summary = {
				version: 5,
				commitHash: "ord1234",
				commitMessage: "consolidated",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				// t-late lists FIRST but holds the chronologically EARLIER slice.
				transcripts: ["t-late", "t-early"],
				topics: [],
			};
			const sliceFor = (tid: string) => ({
				sessions: [
					{
						sessionId: "sess-o",
						source: "claude" as const,
						transcriptPath: "/tmp/o.jsonl",
						entries:
							tid === "t-late"
								? [{ role: "assistant" as const, content: "later turn", timestamp: "2026-06-21T17:18:00.000Z" }]
								: [{ role: "human" as const, content: "earlier turn", timestamp: "2026-06-21T16:33:00.000Z" }],
					},
				],
			});
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
				getSummaryByHash: vi.fn().mockResolvedValue(summary),
				readTranscriptById: vi.fn().mockImplementation((tid: string) => Promise.resolve(sliceFor(tid))),
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({
				type: "kb:openEvidenceConversation",
				commitHash: "ord1234",
				sessionId: "sess-o",
				source: "claude",
				title: "earlier turn",
			});
			await new Promise((r) => setTimeout(r, 0));
			expect(showMock).toHaveBeenCalledTimes(1);
			const call = showMock.mock.calls[0][0] as { archivedEntries: { content: string }[] };
			// Chronological, NOT transcript-array order.
			expect(call.archivedEntries.map((e) => e.content)).toEqual(["earlier turn", "later turn"]);
		});

		it("kb:openEvidenceConversation merges the session's slices across transcripts into archivedEntries", async () => {
			// Mirror of the evidence-projection dedupe on the opener path: the same
			// session split across three transcripts must open ONE panel rendering
			// the full reconstructed conversation, not just the first matching slice
			// (the old sessions.find returned a single transcript's slice).
			showMock.mockReset();
			const view = makeMockView();
			const summary = {
				version: 5,
				commitHash: "merge123",
				commitMessage: "consolidated",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: ["t1", "t2", "t3"],
				topics: [],
			};
			const sliceFor = (tid: string) => ({
				sessions: [
					{
						sessionId: "sess-m",
						source: "claude" as const,
						transcriptPath: "/tmp/m.jsonl",
						entries:
							tid === "t1"
								? [{ role: "human" as const, content: "turn 1" }]
								: tid === "t2"
									? [{ role: "assistant" as const, content: "turn 2" }]
									: [{ role: "human" as const, content: "turn 3" }],
					},
				],
			});
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
				getSummaryByHash: vi.fn().mockResolvedValue(summary),
				readTranscriptById: vi.fn().mockImplementation((tid: string) => Promise.resolve(sliceFor(tid))),
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({
				type: "kb:openEvidenceConversation",
				commitHash: "merge123",
				sessionId: "sess-m",
				source: "claude",
				title: "turn 1",
			});
			await new Promise((r) => setTimeout(r, 0));
			expect(showMock).toHaveBeenCalledTimes(1);
			const call = showMock.mock.calls[0][0] as { archivedEntries: unknown };
			expect(call.archivedEntries).toEqual([
				{ role: "human", content: "turn 1" },
				{ role: "assistant", content: "turn 2" },
				{ role: "human", content: "turn 3" },
			]);
		});

		it("kb:openEvidenceConversation does not open a panel when no session matches", async () => {
			showMock.mockReset();
			const { view } = makeArchivedConvProvider();
			view.webview.triggerMessage({
				type: "kb:openEvidenceConversation",
				commitHash: "arch1234",
				sessionId: "no-such-session",
				source: "claude",
				title: "t",
			});
			await new Promise((r) => setTimeout(r, 0));
			expect(showMock).not.toHaveBeenCalled();
		});

		it("kb:openEvidenceConversation does not open a panel when the summary is missing", async () => {
			showMock.mockReset();
			const view = makeMockView();
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
				getSummaryByHash: vi.fn().mockResolvedValue(undefined),
				readTranscriptById: vi.fn().mockResolvedValue(archivedTranscript),
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({
				type: "kb:openEvidenceConversation",
				commitHash: "gone9999",
				sessionId: "sess-x",
				source: "claude",
				title: "t",
			});
			await new Promise((r) => setTimeout(r, 0));
			expect(showMock).not.toHaveBeenCalled();
		});
	});

	describe("pin/unpin message handling", () => {
		it("branch:pin calls addPin and re-pushes branch:pinsData", async () => {
			const addPin = vi.fn().mockResolvedValue(undefined);
			const listPins = vi.fn().mockResolvedValue([
				{ kind: "memory" as const, id: "h", title: "T", pinnedAt: 1234 },
			]);
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
				const view = makeMockView();
				const provider = new SidebarWebviewProvider({
					executeCommand: vi.fn(),
					getInitialState: () => ({
						enabled: true,
						authenticated: false,
						activeTab: "branch",
						kbMode: "folders",
						branchName: "feature/x",
						detached: false,
						currentRepoName: "myrepo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					pinStore: { addPin, removePin: vi.fn(), listPins },
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.postMessage.mockClear();
				view.webview.triggerMessage({
					type: "branch:pin",
					kind: "memory",
					id: "h",
					title: "T",
				});
				// allow the async handler to flush
				await new Promise((r) => setTimeout(r, 0));
				expect(addPin).toHaveBeenCalledWith(
					"/proj",
					"myrepo",
					"feature/x",
					expect.objectContaining({ kind: "memory", id: "h", title: "T" }),
				);
				const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
				const pinsMsg = sent.find((m) => m.type === "branch:pinsData");
				expect(pinsMsg).toBeDefined();
				expect(pinsMsg.items).toHaveLength(1);
				expect(pinsMsg.items[0].id).toBe("h");
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("branch:unpin calls removePin and re-pushes branch:pinsData", async () => {
			const removePin = vi.fn().mockResolvedValue(undefined);
			const listPins = vi.fn().mockResolvedValue([]);
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
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
						currentRepoName: "myrepo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					pinStore: { addPin: vi.fn(), removePin, listPins },
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.postMessage.mockClear();
				view.webview.triggerMessage({
					type: "branch:unpin",
					kind: "memory",
					id: "h",
				});
				await new Promise((r) => setTimeout(r, 0));
				expect(removePin).toHaveBeenCalledWith("/proj", "myrepo", "main", "memory", "h");
				const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
				const pinsMsg = sent.find((m) => m.type === "branch:pinsData");
				expect(pinsMsg).toBeDefined();
				expect(pinsMsg.items).toHaveLength(0);
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("re-pushes branch:pinsData for the new branch when the workspace HEAD changes (Bug 2)", async () => {
			// Pins are grouped per branch; a `git checkout` must refresh the
			// Pinned section. Before the fix, branchWatcher.onChange only posted
			// branch:branchName and the stale pins lingered (and pushPins resolved
			// against getInitialState().branchName, which lags the live HEAD).
			const listPins = vi
				.fn()
				.mockImplementation((_dir: string, _repo: string, branch: string) =>
					Promise.resolve(
						branch === "feature/new"
							? [{ kind: "memory" as const, id: "n", title: "N", pinnedAt: 1 }]
							: [],
					),
				);
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			let branchHandler: ((name: string, detached: boolean) => void) | undefined;
			let currentName = "main";
			try {
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
						currentRepoName: "myrepo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					pinStore: { addPin: vi.fn(), removePin: vi.fn(), listPins },
					branchWatcher: {
						current: () => ({ name: currentName, detached: false }),
						onChange: (cb) => {
							branchHandler = cb;
							return { dispose: () => {} };
						},
					},
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.postMessage.mockClear();
				listPins.mockClear();
				// Simulate `git checkout feature/new`.
				currentName = "feature/new";
				branchHandler?.("feature/new", false);
				await new Promise((r) => setTimeout(r, 0));
				// pushPins must resolve pins against the NEW branch, not stale main.
				expect(listPins).toHaveBeenCalledWith("/proj", "myrepo", "feature/new");
				const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
				const pinsMsg = sent.find((m) => m.type === "branch:pinsData");
				expect(pinsMsg).toBeDefined();
				expect(pinsMsg.items).toHaveLength(1);
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("pushPins posts empty items and does not throw when listPins rejects", async () => {
			const listPins = vi.fn().mockRejectedValue(new Error("disk error"));
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
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
						currentRepoName: "myrepo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					pinStore: { addPin: vi.fn(), removePin: vi.fn(), listPins },
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.postMessage.mockClear();
				view.webview.triggerMessage({ type: "ready" });
				await flushReady();
				await new Promise((r) => setTimeout(r, 0));
				const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
				const pinsMsg = sent.find((m) => m.type === "branch:pinsData");
				expect(pinsMsg).toBeDefined();
				expect(pinsMsg.items).toEqual([]);
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("pushPins reads the breadcrumb-selected repo+branch, not workspace HEAD", async () => {
			// When the user has selected a foreign repo+branch via the breadcrumb,
			// pushPins must read pins for the SELECTED repo+branch, not the
			// workspace HEAD (currentRepoName / branchName from getInitialState).
			const listPins = vi.fn().mockResolvedValue([
				{ kind: "memory" as const, id: "x", title: "X", pinnedAt: 9999 },
			]);
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
				const view = makeMockView();
				const provider = new SidebarWebviewProvider({
					executeCommand: vi.fn().mockResolvedValue(undefined) as never,
					getInitialState: () => ({
						enabled: true,
						authenticated: false,
						activeTab: "branch",
						kbMode: "folders",
						branchName: "main",          // workspace HEAD branch
						detached: false,
						currentRepoName: "workspace-repo",  // workspace HEAD repo
					}),
					extensionUri: mockExtensionUri as unknown as never,
					selection: {
						listRepos: vi.fn().mockReturnValue([
							{ repoName: "workspace-repo", isCurrent: true },
							{ repoName: "foreign-repo", isCurrent: false },
						]),
						listBranches: vi.fn().mockImplementation((r: string) =>
							r === "foreign-repo" ? ["topic"] : ["main"],
						),
						listBranchMemories: vi.fn().mockResolvedValue([]),
					},
					pinStore: { addPin: vi.fn(), removePin: vi.fn(), listPins },
				});
				provider.resolveWebviewView(view as unknown as never);

				// Select the foreign repo via breadcrumb — mirrors what handleSelectionRequest does.
				view.webview.triggerMessage({
					type: "selection:request",
					repoName: "foreign-repo",
				});
				await new Promise((r) => setTimeout(r, 0));

				// listPins should have been called with the SELECTED repo+branch,
				// not the workspace "workspace-repo" / "main".
				expect(listPins).toHaveBeenCalledWith("/proj", "foreign-repo", "topic");
				expect(listPins).not.toHaveBeenCalledWith("/proj", "workspace-repo", "main");
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("branch:pin uses breadcrumb-selected repo+branch when a foreign repo is active", async () => {
			const addPin = vi.fn().mockResolvedValue(undefined);
			const listPins = vi.fn().mockResolvedValue([]);
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
				const view = makeMockView();
				const provider = new SidebarWebviewProvider({
					executeCommand: vi.fn().mockResolvedValue(undefined) as never,
					getInitialState: () => ({
						enabled: true,
						authenticated: false,
						activeTab: "branch",
						kbMode: "folders",
						branchName: "main",
						detached: false,
						currentRepoName: "workspace-repo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					selection: {
						listRepos: vi.fn().mockReturnValue([
							{ repoName: "workspace-repo", isCurrent: true },
							{ repoName: "foreign-repo", isCurrent: false },
						]),
						listBranches: vi.fn().mockImplementation((r: string) =>
							r === "foreign-repo" ? ["topic"] : ["main"],
						),
						listBranchMemories: vi.fn().mockResolvedValue([]),
					},
					pinStore: { addPin, removePin: vi.fn(), listPins },
				});
				provider.resolveWebviewView(view as unknown as never);

				// Select the foreign repo via breadcrumb.
				view.webview.triggerMessage({
					type: "selection:request",
					repoName: "foreign-repo",
				});
				await new Promise((r) => setTimeout(r, 0));
				addPin.mockClear();

				view.webview.triggerMessage({
					type: "branch:pin",
					kind: "memory",
					id: "y",
					title: "Y",
				});
				await new Promise((r) => setTimeout(r, 0));

				// addPin must target the SELECTED foreign-repo/topic, not workspace-repo/main.
				expect(addPin).toHaveBeenCalledWith(
					"/proj",
					"foreign-repo",
					"topic",
					expect.objectContaining({ kind: "memory", id: "y" }),
				);
				expect(addPin).not.toHaveBeenCalledWith(
					"/proj",
					"workspace-repo",
					"main",
					expect.anything(),
				);
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("branch:unpin uses breadcrumb-selected repo+branch when a foreign repo is active", async () => {
			const removePin = vi.fn().mockResolvedValue(undefined);
			const listPins = vi.fn().mockResolvedValue([]);
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
				const view = makeMockView();
				const provider = new SidebarWebviewProvider({
					executeCommand: vi.fn().mockResolvedValue(undefined) as never,
					getInitialState: () => ({
						enabled: true,
						authenticated: false,
						activeTab: "branch",
						kbMode: "folders",
						branchName: "main",
						detached: false,
						currentRepoName: "workspace-repo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					selection: {
						listRepos: vi.fn().mockReturnValue([
							{ repoName: "workspace-repo", isCurrent: true },
							{ repoName: "foreign-repo", isCurrent: false },
						]),
						listBranches: vi.fn().mockImplementation((r: string) =>
							r === "foreign-repo" ? ["topic"] : ["main"],
						),
						listBranchMemories: vi.fn().mockResolvedValue([]),
					},
					pinStore: { addPin: vi.fn(), removePin, listPins },
				});
				provider.resolveWebviewView(view as unknown as never);

				// Select the foreign repo via breadcrumb.
				view.webview.triggerMessage({
					type: "selection:request",
					repoName: "foreign-repo",
				});
				await new Promise((r) => setTimeout(r, 0));
				removePin.mockClear();

				view.webview.triggerMessage({
					type: "branch:unpin",
					kind: "memory",
					id: "y",
				});
				await new Promise((r) => setTimeout(r, 0));

				// removePin must target the SELECTED foreign-repo/topic, not workspace-repo/main.
				expect(removePin).toHaveBeenCalledWith("/proj", "foreign-repo", "topic", "memory", "y");
				expect(removePin).not.toHaveBeenCalledWith("/proj", "workspace-repo", "main", "memory", "y");
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("branch:pin for a conversation carries source and transcriptPath into the stored PinEntry", async () => {
			const addPin = vi.fn().mockResolvedValue(undefined);
			const listPins = vi.fn().mockResolvedValue([]);
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
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
						currentRepoName: "myrepo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					pinStore: { addPin, removePin: vi.fn(), listPins },
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.postMessage.mockClear();
				view.webview.triggerMessage({
					type: "branch:pin",
					kind: "conversation",
					id: "sess-abc",
					title: "My chat",
					source: "claude",
					transcriptPath: "/home/user/.claude/projects/foo/session.jsonl",
				});
				await new Promise((r) => setTimeout(r, 0));
				expect(addPin).toHaveBeenCalledWith(
					"/proj",
					"myrepo",
					"main",
					expect.objectContaining({
						kind: "conversation",
						id: "sess-abc",
						title: "My chat",
						source: "claude",
						transcriptPath: "/home/user/.claude/projects/foo/session.jsonl",
					}),
				);
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("branch:pin omits empty source/transcriptPath so no un-openable pin is stored", async () => {
			const addPin = vi.fn().mockResolvedValue(undefined);
			const listPins = vi.fn().mockResolvedValue([]);
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
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
						currentRepoName: "myrepo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					pinStore: { addPin, removePin: vi.fn(), listPins },
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.postMessage.mockClear();
				view.webview.triggerMessage({
					type: "branch:pin",
					kind: "conversation",
					id: "sess-abc",
					title: "My chat",
					source: "",
					transcriptPath: "",
				});
				await new Promise((r) => setTimeout(r, 0));
				const entry = addPin.mock.calls[0]?.[3] as Record<string, unknown>;
				expect(entry).not.toHaveProperty("source");
				expect(entry).not.toHaveProperty("transcriptPath");
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});
	});

	describe("coverage edge cases", () => {
		const baseState = {
			enabled: true,
			authenticated: false,
			activeTab: "kb" as const,
			kbMode: "memories" as const,
			branchName: "main",
			detached: false,
		};

		it("projects empty evidence when summary has no transcript readers and omits context/topic fields", async () => {
			// readFn resolves to null (neither readTranscriptForRepo nor
			// readTranscriptById provided) → the conversation loop is skipped.
			// plans/notes/references/topics are all absent → every `?? []`
			// fallback is taken.
			const view = makeMockView();
			const fakeSummary = {
				version: 5,
				commitHash: "bare1",
				commitMessage: "x",
				commitAuthor: "D",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: ["tid-1"],
			};
			const getSummaryByHash = vi.fn().mockResolvedValue(fakeSummary);
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn(),
				getInitialState: () => ({ ...baseState }),
				extensionUri: mockExtensionUri as unknown as never,
				getSummaryByHash,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "bare1" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const ev = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(ev).toBeDefined();
			expect(ev.evidence.conversations).toEqual([]);
			expect(ev.evidence.context).toEqual([]);
			expect(ev.evidence.files).toEqual([]);
		});

		it("skips null transcript reads, sessions without source/path, and topics without filesAffected", async () => {
			const view = makeMockView();
			const fakeSummary = {
				version: 5,
				commitHash: "mix1",
				commitMessage: "x",
				commitAuthor: "D",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: ["tid-null", "tid-bare"],
				plans: [],
				notes: [],
				references: [],
				topics: [{ title: "T", trigger: "a", response: "b", decisions: "c" }],
			};
			const getSummaryByHash = vi.fn().mockResolvedValue(fakeSummary);
			const readTranscriptById = vi
				.fn()
				.mockResolvedValueOnce(null) // tid-null → !stored → continue
				// no source/transcriptPath; entries drive the derived title
				.mockResolvedValueOnce({
					sessions: [{ sessionId: "bare", entries: [{ role: "human", content: "bare turn" }] }],
				});
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn(),
				getInitialState: () => ({ ...baseState }),
				extensionUri: mockExtensionUri as unknown as never,
				getSummaryByHash,
				readTranscriptById,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "mix1" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const ev = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(ev).toBeDefined();
			// Only the second (non-null) read contributes; its session carries
			// neither source nor transcriptPath, so those keys are omitted. The
			// title is derived from the archived first human turn (BUG 1), not the
			// session id.
			expect(ev.evidence.conversations).toEqual([
				// One archived turn ("bare turn") → messageCount 1.
				{ kind: "conversation", id: "bare", title: "bare turn", messageCount: 1 },
			]);
			// The single topic had no filesAffected → no files.
			expect(ev.evidence.files).toEqual([]);
		});

		it("stringifies a non-Error transcript read failure (inner catch)", async () => {
			const view = makeMockView();
			const fakeSummary = {
				version: 5,
				commitHash: "innr1",
				commitMessage: "x",
				commitAuthor: "D",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: ["tid-x"],
				plans: [],
				notes: [],
				references: [],
				topics: [],
			};
			const getSummaryByHash = vi.fn().mockResolvedValue(fakeSummary);
			const readTranscriptById = vi.fn().mockRejectedValue("string-failure");
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn(),
				getInitialState: () => ({ ...baseState }),
				extensionUri: mockExtensionUri as unknown as never,
				getSummaryByHash,
				readTranscriptById,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "innr1" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const ev = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(ev).toBeDefined();
			expect(ev.evidence.conversations).toEqual([]);
		});

		it("posts empty evidence when the summary lookup rejects with a non-Error (outer catch)", async () => {
			const view = makeMockView();
			const getSummaryByHash = vi.fn().mockRejectedValue("outer-string");
			const provider = new SidebarWebviewProvider({
				executeCommand: vi.fn(),
				getInitialState: () => ({ ...baseState }),
				extensionUri: mockExtensionUri as unknown as never,
				getSummaryByHash,
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "outr1" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const ev = sent.find((m) => m.type === "kb:memoryEvidence");
			expect(ev).toBeDefined();
			expect(ev.evidence.conversations).toHaveLength(0);
			expect(ev.evidence.context).toHaveLength(0);
			expect(ev.evidence.files).toHaveLength(0);
		});

		it("branch:pin is a no-op when no repo resolves", async () => {
			const addPin = vi.fn();
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
				const view = makeMockView();
				const provider = new SidebarWebviewProvider({
					executeCommand: vi.fn(),
					// No currentRepoName / selection → repo resolves to "".
					getInitialState: () => ({
						enabled: true,
						authenticated: false,
						activeTab: "branch",
						kbMode: "folders",
						branchName: "main",
						detached: false,
					}),
					extensionUri: mockExtensionUri as unknown as never,
					pinStore: { addPin, removePin: vi.fn(), listPins: vi.fn().mockResolvedValue([]) },
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.triggerMessage({ type: "branch:pin", kind: "memory", id: "h", title: "T" });
				await new Promise((r) => setTimeout(r, 0));
				expect(addPin).not.toHaveBeenCalled();
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("branch:unpin is a no-op when no repo resolves", async () => {
			const removePin = vi.fn();
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
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
					extensionUri: mockExtensionUri as unknown as never,
					pinStore: { addPin: vi.fn(), removePin, listPins: vi.fn().mockResolvedValue([]) },
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.triggerMessage({ type: "branch:unpin", kind: "memory", id: "h" });
				await new Promise((r) => setTimeout(r, 0));
				expect(removePin).not.toHaveBeenCalled();
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		for (const failure of [new Error("boom"), "boom-string"]) {
			const kindLabel = failure instanceof Error ? "Error" : "non-Error";
			it(`branch:pin swallows an addPin rejection (${kindLabel})`, async () => {
				const addPin = vi.fn().mockRejectedValue(failure);
				mockWorkspaceFolders.length = 0;
				mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
				try {
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
							currentRepoName: "myrepo",
						}),
						extensionUri: mockExtensionUri as unknown as never,
						pinStore: { addPin, removePin: vi.fn(), listPins: vi.fn().mockResolvedValue([]) },
					});
					provider.resolveWebviewView(view as unknown as never);
					view.webview.postMessage.mockClear();
					view.webview.triggerMessage({ type: "branch:pin", kind: "memory", id: "h", title: "T" });
					await new Promise((r) => setTimeout(r, 0));
					expect(addPin).toHaveBeenCalled();
					// addPin rejected → the .then(pushPins) is skipped, so no
					// branch:pinsData follows from this path.
					const pinsMsg = view.webview.postMessage.mock.calls
						.map((c) => c[0])
						.find((m) => m.type === "branch:pinsData");
					expect(pinsMsg).toBeUndefined();
				} finally {
					mockWorkspaceFolders.length = 0;
				}
			});

			it(`branch:unpin swallows a removePin rejection (${kindLabel})`, async () => {
				const removePin = vi.fn().mockRejectedValue(failure);
				mockWorkspaceFolders.length = 0;
				mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
				try {
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
							currentRepoName: "myrepo",
						}),
						extensionUri: mockExtensionUri as unknown as never,
						pinStore: { addPin: vi.fn(), removePin, listPins: vi.fn().mockResolvedValue([]) },
					});
					provider.resolveWebviewView(view as unknown as never);
					view.webview.postMessage.mockClear();
					view.webview.triggerMessage({ type: "branch:unpin", kind: "memory", id: "h" });
					await new Promise((r) => setTimeout(r, 0));
					expect(removePin).toHaveBeenCalled();
					const pinsMsg = view.webview.postMessage.mock.calls
						.map((c) => c[0])
						.find((m) => m.type === "branch:pinsData");
					expect(pinsMsg).toBeUndefined();
				} finally {
					mockWorkspaceFolders.length = 0;
				}
			});
		}

		it("pushPins posts an empty list when a repo resolves but no pinStore is wired", async () => {
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
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
						currentRepoName: "myrepo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					// pinStore intentionally absent → listPins ternary takes `: []`.
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.postMessage.mockClear();
				view.webview.triggerMessage({ type: "ready" });
				await flushReady();
				await new Promise((r) => setTimeout(r, 0));
				const pinsMsg = view.webview.postMessage.mock.calls
					.map((c) => c[0])
					.find((m) => m.type === "branch:pinsData");
				expect(pinsMsg).toBeDefined();
				expect(pinsMsg.items).toEqual([]);
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("pushPins posts an empty list and does not throw when listPins rejects with a non-Error", async () => {
			const listPins = vi.fn().mockRejectedValue("disk-string");
			mockWorkspaceFolders.length = 0;
			mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
			try {
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
						currentRepoName: "myrepo",
					}),
					extensionUri: mockExtensionUri as unknown as never,
					pinStore: { addPin: vi.fn(), removePin: vi.fn(), listPins },
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.postMessage.mockClear();
				view.webview.triggerMessage({ type: "ready" });
				await flushReady();
				await new Promise((r) => setTimeout(r, 0));
				const pinsMsg = view.webview.postMessage.mock.calls
					.map((c) => c[0])
					.find((m) => m.type === "branch:pinsData");
				expect(pinsMsg).toBeDefined();
				expect(pinsMsg.items).toEqual([]);
			} finally {
				mockWorkspaceFolders.length = 0;
			}
		});

		it("posts worker:phase on ready when statusProvider exposes getWorkerPhase", async () => {
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
				extensionUri: mockExtensionUri as unknown as never,
				statusProvider: {
					serialize: () => [],
					onDidChangeTreeData: () => ({ dispose: () => {} }),
					getWorkerBusy: () => false,
					getWorkerPhase: () => "ingest",
				},
			});
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({ type: "ready" });
			await flushReady();
			const phaseMsg = view.webview.postMessage.mock.calls
				.map((c) => c[0])
				.find((m) => m.type === "worker:phase");
			expect(phaseMsg).toBeDefined();
			expect(phaseMsg.phase).toBe("ingest");
		});

		describe("kb:requestPrStatus → kb:prStatus", () => {
			it("posts kb:prStatus with the pr when findOpenPrForBranch resolves", async () => {
				const view = makeMockView();
				const findOpenPrForBranch = vi
					.fn()
					.mockResolvedValue({ number: 214, url: "https://github.com/x/y/pull/214" });
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
					findOpenPrForBranch,
				});
				provider.resolveWebviewView(view as unknown as never);
				view.webview.triggerMessage({ type: "kb:requestPrStatus", branch: "feat/x" });
				await flushUntilMessage(view, "kb:prStatus");
				const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
				const msg = sent.find((m) => m.type === "kb:prStatus");
				expect(msg).toBeDefined();
				expect(msg.branch).toBe("feat/x");
				expect(msg.pr).toEqual({ number: 214, url: "https://github.com/x/y/pull/214" });
				expect(findOpenPrForBranch).toHaveBeenCalledWith("feat/x");
			});

			it("posts kb:prStatus with pr:null when findOpenPrForBranch rejects (never throws)", async () => {
				const view = makeMockView();
				const findOpenPrForBranch = vi.fn().mockRejectedValue(new Error("gh not found"));
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
					findOpenPrForBranch,
				});
				provider.resolveWebviewView(view as unknown as never);
				// Must not throw
				expect(() =>
					view.webview.triggerMessage({ type: "kb:requestPrStatus", branch: "feat/x" }),
				).not.toThrow();
				await flushUntilMessage(view, "kb:prStatus");
				const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
				const msg = sent.find((m) => m.type === "kb:prStatus");
				expect(msg).toBeDefined();
				expect(msg.branch).toBe("feat/x");
				expect(msg.pr).toBeNull();
			});

			it("posts kb:prStatus with pr:null when findOpenPrForBranch dep is absent", async () => {
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
					extensionUri: mockExtensionUri as unknown as never,
					// No findOpenPrForBranch dep wired.
				});
				provider.resolveWebviewView(view as unknown as never);
				expect(() =>
					view.webview.triggerMessage({ type: "kb:requestPrStatus", branch: "feat/x" }),
				).not.toThrow();
				await flushUntilMessage(view, "kb:prStatus");
				const sent = view.webview.postMessage.mock.calls.map((c) => c[0]);
				const msg = sent.find((m) => m.type === "kb:prStatus");
				expect(msg).toBeDefined();
				expect(msg.branch).toBe("feat/x");
				expect(msg.pr).toBeNull();
			});
		});
	});
});

describe("SidebarWebviewProvider — back-fill cold-start handlers", () => {
	function makeProviderWithBackfill(backfill?: {
		listCandidates: ReturnType<typeof vi.fn>;
		run: ReturnType<typeof vi.fn>;
		dismiss: ReturnType<typeof vi.fn>;
	}): { provider: SidebarWebviewProvider; view: MockWebviewView; executeCommand: ReturnType<typeof vi.fn> } {
		const executeCommand = vi.fn().mockResolvedValue(undefined);
		const provider = new SidebarWebviewProvider({
			executeCommand: executeCommand as never,
			getInitialState: () => ({
				enabled: true,
				authenticated: false,
				activeTab: "branch",
				kbMode: "folders",
				branchName: "main",
				detached: false,
			}),
			extensionUri: mockExtensionUri as unknown as never,
			...(backfill ? { backfill: backfill as never } : {}),
		});
		const view = makeMockView();
		provider.resolveWebviewView(view as unknown as never);
		return { provider, view, executeCommand };
	}
	function sentOf(view: MockWebviewView): SidebarInboundMsg[] {
		return view.webview.postMessage.mock.calls.map((c) => c[0] as SidebarInboundMsg);
	}

	it("requestCandidates → calls listCandidates and posts the candidates back", async () => {
		const backfill = {
			listCandidates: vi.fn().mockResolvedValue({
				items: [{ commitHash: "h1", subject: "fix", ts: 1, sessions: 2, conversationTurns: 5 }],
				totalMissing: 7,
			}),
			run: vi.fn(),
			dismiss: vi.fn(),
		};
		const { view } = makeProviderWithBackfill(backfill);
		view.webview.triggerMessage({ type: "backfill:requestCandidates", scope: "recent-month" });
		await flushUntilMessage(view, "backfill:candidates");
		expect(backfill.listCandidates).toHaveBeenCalledWith("recent-month");
		const msg = sentOf(view).find((m) => m.type === "backfill:candidates") as Extract<
			SidebarInboundMsg,
			{ type: "backfill:candidates" }
		>;
		expect(msg.items).toHaveLength(1);
		expect(msg.totalMissing).toBe(7);
		expect(msg.scope).toBe("recent-month");
	});

	it("requestCandidates → posts empty candidates when no backfill dep is wired", async () => {
		const { view } = makeProviderWithBackfill(undefined);
		view.webview.triggerMessage({ type: "backfill:requestCandidates", scope: "recent-month" });
		await flushUntilMessage(view, "backfill:candidates");
		const msg = sentOf(view).find((m) => m.type === "backfill:candidates") as Extract<
			SidebarInboundMsg,
			{ type: "backfill:candidates" }
		>;
		expect(msg.items).toEqual([]);
		expect(msg.totalMissing).toBe(0);
	});

	it("requestCandidates → posts empty candidates when listCandidates throws", async () => {
		const backfill = {
			listCandidates: vi.fn().mockRejectedValue(new Error("boom")),
			run: vi.fn(),
			dismiss: vi.fn(),
		};
		const { view } = makeProviderWithBackfill(backfill);
		view.webview.triggerMessage({ type: "backfill:requestCandidates", scope: "recent-month" });
		await flushUntilMessage(view, "backfill:candidates");
		const msg = sentOf(view).find((m) => m.type === "backfill:candidates") as Extract<
			SidebarInboundMsg,
			{ type: "backfill:candidates" }
		>;
		expect(msg.items).toEqual([]);
	});

	it("run → streams progress and posts done", async () => {
		const backfill = {
			listCandidates: vi.fn(),
			run: vi.fn(async (_hashes: readonly string[], onProgress: (d: number, t: number, s: string, f: boolean) => void) => {
				onProgress(1, 2, "first", false);
				onProgress(2, 2, "second", false);
				return { rows: [{ commitHash: "h1", subject: "fix", sessions: 1, topics: 3, status: "generated" }], generated: 1, skipped: 0, errors: 0 };
			}),
			dismiss: vi.fn(),
		};
		const { view } = makeProviderWithBackfill(backfill);
		view.webview.triggerMessage({ type: "backfill:run", hashes: ["h1", "h2"] });
		await flushUntilMessage(view, "backfill:done");
		expect(backfill.run).toHaveBeenCalledWith(["h1", "h2"], expect.any(Function));
		const sent = sentOf(view);
		const progresses = sent.filter((m) => m.type === "backfill:progress");
		expect(progresses.length).toBe(2);
		const done = sent.find((m) => m.type === "backfill:done") as Extract<SidebarInboundMsg, { type: "backfill:done" }>;
		expect(done.generated).toBe(1);
		expect(done.rows).toHaveLength(1);
	});

	it("run → no-op done for an empty hash list (does not call run)", async () => {
		const backfill = { listCandidates: vi.fn(), run: vi.fn(), dismiss: vi.fn() };
		const { view } = makeProviderWithBackfill(backfill);
		view.webview.triggerMessage({ type: "backfill:run", hashes: [] });
		await flushUntilMessage(view, "backfill:done");
		expect(backfill.run).not.toHaveBeenCalled();
		const done = sentOf(view).find((m) => m.type === "backfill:done") as Extract<
			SidebarInboundMsg,
			{ type: "backfill:done" }
		>;
		expect(done.generated).toBe(0);
	});

	it("run → posts a terminal errored done when run throws", async () => {
		const backfill = {
			listCandidates: vi.fn(),
			run: vi.fn().mockRejectedValue(new Error("llm down")),
			dismiss: vi.fn(),
		};
		const { view } = makeProviderWithBackfill(backfill);
		view.webview.triggerMessage({ type: "backfill:run", hashes: ["h1", "h2"] });
		await flushUntilMessage(view, "backfill:done");
		const done = sentOf(view).find((m) => m.type === "backfill:done") as Extract<
			SidebarInboundMsg,
			{ type: "backfill:done" }
		>;
		expect(done.errors).toBe(2);
		expect(done.rows).toEqual([]);
	});

	it("dismiss → calls the backfill dismiss dep", () => {
		const backfill = { listCandidates: vi.fn(), run: vi.fn(), dismiss: vi.fn() };
		const { view } = makeProviderWithBackfill(backfill);
		view.webview.triggerMessage({ type: "backfill:dismiss" });
		expect(backfill.dismiss).toHaveBeenCalledTimes(1);
	});

	it("openSettings → runs the openSettings command", () => {
		const backfill = { listCandidates: vi.fn(), run: vi.fn(), dismiss: vi.fn() };
		const { view, executeCommand } = makeProviderWithBackfill(backfill);
		view.webview.triggerMessage({ type: "backfill:openSettings" });
		expect(executeCommand).toHaveBeenCalledWith("jollimemory.openSettings");
	});
});
