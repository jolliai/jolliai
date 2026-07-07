/**
 * Edge-path tests for SidebarWebviewProvider — the degraded / fallback branches
 * that the mainline suite doesn't reach: telemetry flush on the conversations
 * tick, PR lookups that resolve empty, evidence projection fallbacks for
 * malformed or failing sources, branch token-stat posting, and the
 * next-memory selection projection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarInboundMsg, SidebarOutboundMsg, SidebarState } from "./SidebarMessages";
import type { SidebarWebviewDeps } from "./SidebarWebviewProvider";
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
	badge: { value: number; tooltip: string } | undefined;
}

const mockExtensionUri = {
	fsPath: "/mock/extension",
	scheme: "file",
	toString: () => "file:///mock/extension",
};

// Mutable slots the vscode mock reads through getters, so each test can flip
// workspace / telemetry state without re-mocking the module.
const mockWorkspaceFolders: Array<{ uri: { fsPath: string } }> = [];
const telemetryState = { enabled: true };
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
	env: {
		get isTelemetryEnabled() {
			return telemetryState.enabled;
		},
	},
}));

// The 60s tick piggybacks a telemetry flush — stub it so tests can assert the
// cwd / platform-opt-out wiring without touching the real telemetry buffer.
const flushTelemetryMock = vi.fn();
vi.mock("../TelemetryActivation.js", () => ({
	flushExtensionTelemetry: (...args: unknown[]) => flushTelemetryMock(...args),
}));

// Stub the panel so archived-conversation opens can be asserted on their args.
const showMock = vi.fn();
vi.mock("./ConversationDetailsPanel.js", () => ({
	ConversationDetailsPanel: {
		show: (...args: unknown[]) => showMock(...args),
	},
}));

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

function makeProvider(extra: Partial<SidebarWebviewDeps> = {}): SidebarWebviewProvider {
	return new SidebarWebviewProvider({
		executeCommand: vi.fn().mockResolvedValue(undefined) as never,
		getInitialState: (): SidebarState => ({
			enabled: true,
			authenticated: false,
			activeTab: "kb",
			kbMode: "memories",
			branchName: "main",
			detached: false,
		}),
		extensionUri: mockExtensionUri as unknown as never,
		...extra,
	});
}

/** Polls the posted messages until one of `type` shows up (handlers span multiple async turns). */
async function flushUntilMessage(view: MockWebviewView, type: string, maxTicks = 50): Promise<SidebarInboundMsg[]> {
	for (let i = 0; i < maxTicks; i++) {
		const sent = view.webview.postMessage.mock.calls.map((c) => c[0] as SidebarInboundMsg);
		if (sent.some((m) => m.type === type)) return sent;
		await new Promise((r) => setTimeout(r, 0));
	}
	return view.webview.postMessage.mock.calls.map((c) => c[0] as SidebarInboundMsg);
}

function findMsg<T extends SidebarInboundMsg["type"]>(
	msgs: ReadonlyArray<SidebarInboundMsg>,
	type: T,
): Extract<SidebarInboundMsg, { type: T }> | undefined {
	return msgs.find((m): m is Extract<SidebarInboundMsg, { type: T }> => m.type === type);
}

const stubDisposable = () => ({ dispose: () => {} });

beforeEach(() => {
	flushTelemetryMock.mockReset();
	showMock.mockReset();
	mockWorkspaceFolders.length = 0;
	telemetryState.enabled = true;
});

describe("SidebarWebviewProvider edge paths", () => {
	describe("telemetry flush on the conversations tick", () => {
		it("flushes buffered telemetry with the workspace cwd and inverted platform consent", async () => {
			vi.useFakeTimers();
			try {
				mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } });
				const listWithDiagnostics = vi.fn().mockResolvedValue({ items: [], failedSources: [] });
				const provider = makeProvider({
					activeSessionsProvider: { listWithDiagnostics } as unknown as never,
				});
				const view = makeMockView();
				provider.resolveWebviewView(view as unknown as never);
				// First tick: platform telemetry enabled → platformDisabled false.
				await vi.advanceTimersByTimeAsync(60_000);
				expect(flushTelemetryMock).toHaveBeenCalledTimes(1);
				expect(flushTelemetryMock).toHaveBeenCalledWith("/proj", false);
				// The opt-out is read live per tick: flipping the VS Code toggle off
				// must arrive as platformDisabled=true on the next flush.
				telemetryState.enabled = false;
				await vi.advanceTimersByTimeAsync(60_000);
				expect(flushTelemetryMock).toHaveBeenCalledTimes(2);
				expect(flushTelemetryMock).toHaveBeenLastCalledWith("/proj", true);
				provider.dispose();
			} finally {
				vi.useRealTimers();
			}
		});

		it("skips the flush when no workspace folder is open", async () => {
			vi.useFakeTimers();
			try {
				const listWithDiagnostics = vi.fn().mockResolvedValue({ items: [], failedSources: [] });
				const provider = makeProvider({
					activeSessionsProvider: { listWithDiagnostics } as unknown as never,
				});
				const view = makeMockView();
				provider.resolveWebviewView(view as unknown as never);
				await vi.advanceTimersByTimeAsync(60_000);
				// The conversations refresh still ran; only the telemetry flush is gated on cwd.
				expect(listWithDiagnostics).toHaveBeenCalled();
				expect(flushTelemetryMock).not.toHaveBeenCalled();
				provider.dispose();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("kb:requestPrStatus with no open PR", () => {
		it("posts pr:null when findOpenPrForBranch resolves undefined", async () => {
			const findOpenPrForBranch = vi.fn().mockResolvedValue(undefined);
			const provider = makeProvider({ findOpenPrForBranch });
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({ type: "kb:requestPrStatus", branch: "feat/none" });
			const sent = await flushUntilMessage(view, "kb:prStatus");
			const msg = findMsg(sent, "kb:prStatus");
			expect(findOpenPrForBranch).toHaveBeenCalledWith("feat/none");
			expect(msg?.branch).toBe("feat/none");
			// "no PR found" (undefined) is normalized to the explicit null the client renders.
			expect(msg?.pr).toBeNull();
		});
	});

	describe("kb:expandMemory file fallback on non-Error rejection", () => {
		it("falls back to topic paths when listCommitFiles rejects with a non-Error value", async () => {
			const summary = {
				version: 5,
				commitHash: "str1234",
				commitMessage: "feat: fallback",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: [],
				topics: [{ title: "t", trigger: "x", response: "y", decisions: "z", filesAffected: ["src/a.ts"] }],
			};
			// Rejecting with a plain string exercises the String(err) side of the
			// warn formatting — the git bridge is not guaranteed to throw Errors.
			const listCommitFiles = vi.fn().mockRejectedValue("diff-tree exploded");
			const provider = makeProvider({
				getSummaryByHash: vi.fn().mockResolvedValue(summary),
				listCommitFiles,
			});
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "str1234" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const ev = findMsg(sent, "kb:memoryEvidence");
			expect(listCommitFiles).toHaveBeenCalledWith("str1234");
			// The failure degrades to the path-only topic projection, not an error post.
			expect(ev?.evidence.files).toEqual([
				{ kind: "file", id: "src/a.ts", title: "src/a.ts", relativePath: "src/a.ts" },
			]);
		});
	});

	describe("archived session slice ordering by timestamp", () => {
		it("orders a multi-transcript session's slices by their first parseable timestamp", async () => {
			const summary = {
				version: 5,
				commitHash: "tsx1234",
				commitMessage: "feat: ts ordering",
				commitAuthor: "Dev",
				commitDate: "2024-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2024-01-01T00:01:00Z",
				transcripts: ["tid-1", "tid-2"],
				topics: [],
			};
			// One session spanning two transcripts. tid-2's slice has a parseable
			// timestamp (sliceStartTime returns via `Number.isFinite(ms)` → the finite
			// arm), while tid-1's slice has an UNPARSEABLE timestamp — present, so it
			// passes the `=== undefined` skip, but Date.parse → NaN, so it falls
			// through the `Number.isFinite` check (the non-finite arm) and returns
			// undefined. Together the two slices exercise both arms of that branch.
			const sliceFor = (tid: string) => ({
				sessions: [
					{
						sessionId: "sess-ts",
						source: "claude" as const,
						transcriptPath: "/tmp/ts.jsonl",
						entries:
							tid === "tid-1"
								? [{ role: "assistant" as const, content: "unparseable", timestamp: "not-a-real-timestamp" }]
								: [{ role: "human" as const, content: "earlier", timestamp: "2024-01-01T00:00:00Z" }],
					},
				],
			});
			const provider = makeProvider({
				getSummaryByHash: vi.fn().mockResolvedValue(summary),
				readTranscriptById: vi.fn().mockImplementation((tid: string) => Promise.resolve(sliceFor(tid))),
			});
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			view.webview.postMessage.mockClear();
			view.webview.triggerMessage({ type: "kb:expandMemory", commitHash: "tsx1234" });
			const sent = await flushUntilMessage(view, "kb:memoryEvidence");
			const ev = findMsg(sent, "kb:memoryEvidence");
			// The two slices collapse into one conversation row, merged across transcripts.
			expect(ev?.evidence.conversations).toHaveLength(1);
			expect(ev?.evidence.conversations[0]).toMatchObject({ id: "sess-ts", messageCount: 2 });
		});
	});

	describe("kb:openEvidenceConversation via the source-aware summary lookup", () => {
		const provenanceSummary = {
			version: 5,
			commitHash: "prov1234",
			commitMessage: "feat: provenance",
			commitAuthor: "Dev",
			commitDate: "2024-01-01T00:00:00Z",
			branch: "main",
			generatedAt: "2024-01-01T00:01:00Z",
			transcripts: ["t1"],
			topics: [],
		};

		it("opens the panel for a source-less stored session (claude default) with an empty transcriptPath", async () => {
			const getSummaryAnyRepoWithSource = vi.fn().mockResolvedValue({
				summary: provenanceSummary,
				sourceRepoName: null,
				sourceRemoteUrl: null,
			});
			// Legacy stored session: neither `source` nor `transcriptPath` present —
			// the match must default to "claude" and the panel must get "".
			const readTranscriptById = vi.fn().mockResolvedValue({
				sessions: [{ sessionId: "sess-p", entries: [{ role: "human", content: "hi" }] }],
			});
			const provider = makeProvider({ getSummaryAnyRepoWithSource, readTranscriptById });
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({
				type: "kb:openEvidenceConversation",
				commitHash: "prov1234",
				sessionId: "sess-p",
				source: "claude",
				title: "hi",
			});
			await new Promise((r) => setTimeout(r, 0));
			expect(getSummaryAnyRepoWithSource).toHaveBeenCalledWith("prov1234");
			expect(showMock).toHaveBeenCalledTimes(1);
			const call = showMock.mock.calls[0][0] as {
				sessionId: string;
				source: string;
				transcriptPath: string;
				archivedEntries: unknown;
			};
			expect(call.sessionId).toBe("sess-p");
			expect(call.source).toBe("claude");
			expect(call.transcriptPath).toBe("");
			expect(call.archivedEntries).toEqual([{ role: "human", content: "hi" }]);
		});

		it.each([
			["an Error", new Error("storage offline")],
			["a non-Error value", "storage offline (string)"],
		])("swallows a summary lookup rejecting with %s without opening a panel", async (_label, reason) => {
			const getSummaryAnyRepoWithSource = vi.fn().mockRejectedValue(reason);
			const provider = makeProvider({ getSummaryAnyRepoWithSource });
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			expect(() =>
				view.webview.triggerMessage({
					type: "kb:openEvidenceConversation",
					commitHash: "prov1234",
					sessionId: "sess-p",
					source: "claude",
					title: "hi",
				}),
			).not.toThrow();
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			expect(getSummaryAnyRepoWithSource).toHaveBeenCalledWith("prov1234");
			expect(showMock).not.toHaveBeenCalled();
		});
	});

	describe("branch token stats alongside pushCommits", () => {
		function makeHistoryProvider() {
			return {
				serialize: vi.fn().mockResolvedValue([]),
				onDidChangeTreeData: vi.fn(stubDisposable),
				getMode: () => "multi" as const,
			};
		}

		it("posts branch:tokenStats with the reconciled total when the branch has usage", async () => {
			const getBranchTokenStats = vi.fn().mockResolvedValue({
				input: 100,
				output: 40,
				cached: 10,
				// Scalar branch total (Σ aggregateConversationTokens) — a required field of
				// the dep contract; here it equals input+output+cached, its minimum.
				total: 150,
				reporting: 2,
				memories: 3,
			});
			const provider = makeProvider({
				historyProvider: makeHistoryProvider(),
				getBranchTokenStats,
			});
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({ type: "ready" });
			const sent = await flushUntilMessage(view, "branch:tokenStats");
			const msg = findMsg(sent, "branch:tokenStats");
			expect(msg).toMatchObject({
				input: 100,
				output: 40,
				cached: 10,
				// cached counts toward the total so input + output + cached reconcile.
				total: 150,
				reporting: 2,
				memories: 3,
				scope: "branch",
			});
		});

		it("posts a zero-total token stats message so an empty branch clears any stale bar", async () => {
			const getBranchTokenStats = vi.fn().mockResolvedValue({
				input: 0,
				output: 0,
				cached: 0,
				total: 0,
				reporting: 0,
				memories: 0,
			});
			const provider = makeProvider({
				historyProvider: makeHistoryProvider(),
				getBranchTokenStats,
			});
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({ type: "ready" });
			const sent = await flushUntilMessage(view, "branch:commitsData");
			// Commits data went out and the stats promise settled…
			expect(findMsg(sent, "branch:commitsData")).toBeDefined();
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			expect(getBranchTokenStats).toHaveBeenCalled();
			// …and a zero aggregate MUST still be posted (total 0) — the webview
			// hides the bar itself, but only if it receives the reset. Withholding
			// the message strands the previous branch's bar on the empty branch.
			const all = view.webview.postMessage.mock.calls.map((c) => c[0] as SidebarInboundMsg);
			const msg = findMsg(all, "branch:tokenStats") as { total?: number } | undefined;
			expect(msg).toBeDefined();
			expect(msg?.total).toBe(0);
		});

		it("degrades silently when getBranchTokenStats rejects", async () => {
			const getBranchTokenStats = vi.fn().mockRejectedValue(new Error("stats unavailable"));
			const provider = makeProvider({
				historyProvider: makeHistoryProvider(),
				getBranchTokenStats,
			});
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			view.webview.triggerMessage({ type: "ready" });
			const sent = await flushUntilMessage(view, "branch:commitsData");
			expect(findMsg(sent, "branch:commitsData")).toBeDefined();
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			expect(getBranchTokenStats).toHaveBeenCalled();
			const all = view.webview.postMessage.mock.calls.map((c) => c[0] as SidebarInboundMsg);
			expect(findMsg(all, "branch:tokenStats")).toBeUndefined();
		});
	});

	describe("branch watcher pin re-push gating", () => {
		it("skips the pin re-push on a HEAD change while a foreign branch is selected via the breadcrumb", () => {
			let branchHandler: ((name: string, detached: boolean) => void) | undefined;
			const provider = makeProvider({
				branchWatcher: {
					current: () => ({ name: "main", detached: false }),
					onChange: (cb: (name: string, detached: boolean) => void) => {
						branchHandler = cb;
						return { dispose: () => {} };
					},
				} as unknown as never,
				// `selection` need only be present for the branchName request path to
				// set selectedBranchName (it doesn't consult listRepos/listBranches here).
				selection: { listRepos: () => [], listBranches: () => [] } as unknown as never,
			});
			const view = makeMockView();
			provider.resolveWebviewView(view as unknown as never);
			// Pick a foreign branch via the breadcrumb → selectedBranchName is now set.
			view.webview.triggerMessage({ type: "selection:request", branchName: "feature/foreign" });
			view.webview.postMessage.mockClear();
			// A workspace HEAD change fires the watcher; because a foreign branch is
			// selected, the pin re-push is skipped (the `=== undefined` guard is false).
			branchHandler?.("feature/other", false);
			const msgs = view.webview.postMessage.mock.calls.map((c) => c[0] as SidebarInboundMsg);
			// The branch:branchName post still goes out (it precedes the pin gate)…
			expect(msgs.some((m) => m.type === "branch:branchName")).toBe(true);
			// …but no fresh pins were pushed while a foreign selection is active.
			expect(msgs.some((m) => m.type === "branch:pinsData")).toBe(false);
		});
	});

	describe("snapshot accessors (Next Memory review panel)", () => {
		it("getPlansSnapshot returns the plans provider's serialized items", () => {
			const items = [{ id: "p1", label: "Plan A", contextValue: "plan", isSelected: true }];
			const provider = makeProvider({
				plansProvider: {
					serialize: () => items,
					onDidChangeTreeData: vi.fn(stubDisposable),
				} as unknown as never,
			});
			expect(provider.getPlansSnapshot()).toEqual(items);
		});

		it("getPlansSnapshot returns an empty array when there is no plans provider", () => {
			const provider = makeProvider();
			expect(provider.getPlansSnapshot()).toEqual([]);
		});

		it("getConversationsSnapshot returns the active sessions provider's items", async () => {
			const items = [
				{
					source: "claude",
					sessionId: "s1",
					title: "t",
					messageCount: 1,
					updatedAt: "2026-01-01",
					transcriptPath: "/x",
					isEdited: false,
					isSelected: true,
				},
			];
			const provider = makeProvider({
				activeSessionsProvider: {
					listWithDiagnostics: async () => ({ items, failedSources: [] }),
				} as unknown as never,
			});
			expect(await provider.getConversationsSnapshot()).toEqual(items);
		});

		it("getConversationsSnapshot returns an empty array when there is no active sessions provider", async () => {
			const provider = makeProvider();
			expect(await provider.getConversationsSnapshot()).toEqual([]);
		});
	});
});
