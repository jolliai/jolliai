import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
	info,
	warn,
	error: logError,
} = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

const { postMessage, onDidReceiveMessage, onDidDispose, reveal } = vi.hoisted(
	() => ({
		postMessage: vi.fn().mockResolvedValue(true),
		onDidReceiveMessage: vi.fn(),
		onDidDispose: vi.fn(),
		reveal: vi.fn(),
	}),
);

const { createWebviewPanel } = vi.hoisted(() => ({
	createWebviewPanel: vi.fn(() => ({
		webview: {
			postMessage,
			onDidReceiveMessage,
			asWebviewUri: vi.fn((uri: unknown) => uri),
			html: "",
		},
		onDidDispose,
		reveal,
		title: "",
		dispose: vi.fn(),
	})),
}));

const { mockShowOpenDialog } = vi.hoisted(() => ({
	mockShowOpenDialog: vi.fn(),
}));

const { mockShowWarningMessage } = vi.hoisted(() => ({
	mockShowWarningMessage: vi.fn(),
}));

const { mockExecuteCommand } = vi.hoisted(() => ({
	mockExecuteCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("vscode", () => ({
	window: {
		createWebviewPanel,
		showOpenDialog: mockShowOpenDialog,
		showWarningMessage: mockShowWarningMessage,
	},
	commands: {
		executeCommand: mockExecuteCommand,
	},
	ViewColumn: { Active: 1 },
}));

const { mockGetGlobalConfigDir, mockLoadConfigFromDir, mockSaveConfigScoped } =
	vi.hoisted(() => ({
		mockGetGlobalConfigDir: vi.fn().mockReturnValue("/global/.jollimemory"),
		mockLoadConfigFromDir: vi.fn().mockResolvedValue({
			apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234",
			model: "sonnet",
			maxTokens: null,
			jolliApiKey: undefined,
			claudeEnabled: true,
			codexEnabled: false,
			geminiEnabled: true,
			openCodeEnabled: true,
			excludePatterns: ["node_modules"],
		}),
		mockSaveConfigScoped: vi.fn().mockResolvedValue(undefined),
	}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	getGlobalConfigDir: mockGetGlobalConfigDir,
	loadConfigFromDir: mockLoadConfigFromDir,
	saveConfigScoped: mockSaveConfigScoped,
}));

const { mockGetProjectRootDir } = vi.hoisted(() => ({
	mockGetProjectRootDir: vi.fn().mockResolvedValue("/workspace"),
}));

const { mockListWorktrees } = vi.hoisted(() => ({
	mockListWorktrees: vi.fn().mockResolvedValue(["/workspace"]),
}));

vi.mock("../../../cli/src/core/GitOps.js", () => ({
	getProjectRootDir: mockGetProjectRootDir,
	listWorktrees: mockListWorktrees,
}));

const {
	mockInstallClaudeHook,
	mockRemoveClaudeHook,
	mockInstallGeminiHook,
	mockRemoveGeminiHook,
	mockSyncGlobalInstructions,
} = vi.hoisted(() => ({
	mockInstallClaudeHook: vi.fn().mockResolvedValue({}),
	mockRemoveClaudeHook: vi.fn().mockResolvedValue({}),
	mockInstallGeminiHook: vi.fn().mockResolvedValue({}),
	mockRemoveGeminiHook: vi.fn().mockResolvedValue(undefined),
	mockSyncGlobalInstructions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../cli/src/install/Installer.js", () => ({
	installClaudeHook: mockInstallClaudeHook,
	removeClaudeHook: mockRemoveClaudeHook,
	installGeminiHook: mockInstallGeminiHook,
	removeGeminiHook: mockRemoveGeminiHook,
	syncGlobalInstructions: mockSyncGlobalInstructions,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error: logError },
}));

// JolliApiUtils is normally used verbatim (the real parser/validator). We wrap
// `validateJolliApiKey` in a vi.fn that delegates to the real implementation by
// default, so a couple of tests can override it to throw a *non-Error* value —
// the only way to exercise the `err instanceof Error ? … : "Invalid …"` fallback
// arms in handleLoadSettings / handleApplySettings, which the real validator
// (it only ever throws `Error`) cannot reach on its own.
const { mockValidateJolliApiKey, realValidateRef } = vi.hoisted(() => ({
	// biome-ignore lint/suspicious/noExplicitAny: test seam delegates to the real validator
	mockValidateJolliApiKey: vi.fn() as any,
	// biome-ignore lint/suspicious/noExplicitAny: holds the real impl captured at mock time
	realValidateRef: { current: undefined as any },
}));

vi.mock("../../../cli/src/core/JolliApiUtils.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../cli/src/core/JolliApiUtils.js")
		>();
	realValidateRef.current = actual.validateJolliApiKey;
	mockValidateJolliApiKey.mockImplementation(actual.validateJolliApiKey);
	return {
		...actual,
		validateJolliApiKey: mockValidateJolliApiKey,
	};
});

const { mockBuildSettingsHtml } = vi.hoisted(() => ({
	mockBuildSettingsHtml: vi.fn().mockReturnValue("<html>settings</html>"),
}));

vi.mock("./SettingsHtmlBuilder.js", () => ({
	buildSettingsHtml: mockBuildSettingsHtml,
}));

const { mockRandomBytes } = vi.hoisted(() => ({
	mockRandomBytes: vi
		.fn()
		.mockReturnValue({ toString: () => "mocknonce1234567890abcdef" }),
}));

vi.mock("node:crypto", () => ({
	randomBytes: mockRandomBytes,
}));

// refreshMissingSummaryCount dynamic-imports these; mock the count so the
// success/failure branches are deterministic (real countMissingSummaries would
// run git + storage against a non-existent workspace path).
const { mockCountMissingSummaries, mockExtractRepoName } = vi.hoisted(() => ({
	mockCountMissingSummaries: vi.fn().mockResolvedValue({ missing: 0, total: 0 }),
	mockExtractRepoName: vi.fn(() => "myrepo"),
}));

vi.mock("../../../cli/src/backfill/BackfillEngine.js", () => ({
	countMissingSummaries: mockCountMissingSummaries,
}));

vi.mock("../../../cli/src/core/KBPathResolver.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../cli/src/core/KBPathResolver.js")>()),
	extractRepoName: mockExtractRepoName,
}));

// ── Import under test ────────────────────────────────────────────────────────

import { SettingsWebviewPanel } from "./SettingsWebviewPanel.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const extensionUri = { fsPath: "/ext", toString: () => "/ext" } as never;
const workspaceRoot = "/workspace";

/**
 * Captures the onDidReceiveMessage callback registered by the panel constructor
 * and returns a function that dispatches messages to it.
 */
function captureMessageHandler(): (msg: Record<string, unknown>) => void {
	const call =
		onDidReceiveMessage.mock.calls[onDidReceiveMessage.mock.calls.length - 1];
	return call[0] as (msg: Record<string, unknown>) => void;
}

/** Flushes pending promises to let async handlers resolve. */
function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SettingsWebviewPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Restore the validator to delegate to the real implementation; the two
		// non-Error-fallback tests override this and we must not leak that.
		mockValidateJolliApiKey.mockImplementation(realValidateRef.current);
		// Reset singleton
		(
			SettingsWebviewPanel as unknown as { currentPanel: undefined }
		).currentPanel = undefined;

		// Restore default mock implementations
		mockLoadConfigFromDir.mockResolvedValue({
			apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234",
			model: "sonnet",
			maxTokens: null,
			jolliApiKey: undefined,
			claudeEnabled: true,
			codexEnabled: false,
			geminiEnabled: true,
			openCodeEnabled: true,
			excludePatterns: ["node_modules"],
		});
		mockGetGlobalConfigDir.mockReturnValue("/global/.jollimemory");
		mockGetProjectRootDir.mockResolvedValue("/workspace");
		mockSaveConfigScoped.mockResolvedValue(undefined);
		mockListWorktrees.mockResolvedValue(["/workspace"]);
	});

	// ── show() ───────────────────────────────────────────────────────────────

	describe("show()", () => {
		it("creates a new webview panel with correct options", async () => {
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);

			expect(createWebviewPanel).toHaveBeenCalledWith(
				"jollimemory.settings",
				"Jolli Memory Settings",
				1, // ViewColumn.Active
				expect.objectContaining({
					enableScripts: true,
					retainContextWhenHidden: true,
				}),
			);
		});

		it("sets HTML content from buildSettingsHtml", async () => {
			mockBuildSettingsHtml.mockReturnValue("<html>custom settings</html>");
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);

			const panel = createWebviewPanel.mock.results[0].value;
			expect(panel.webview.html).toBe("<html>custom settings</html>");
			expect(mockBuildSettingsHtml).toHaveBeenCalledWith(
				"mocknonce1234567890abcdef",
			);
		});

		it("registers a dispose handler that clears currentPanel", async () => {
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);

			expect(onDidDispose).toHaveBeenCalled();
			const disposeCallback = onDidDispose.mock.calls[0][0] as () => void;
			disposeCallback();

			// After dispose, a new show() should create a new panel
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			expect(createWebviewPanel).toHaveBeenCalledTimes(2);
		});

		it("reveals existing panel on second show() call (singleton behavior)", async () => {
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);

			expect(createWebviewPanel).toHaveBeenCalledTimes(1);
			expect(reveal).toHaveBeenCalledWith(1); // ViewColumn.Active
		});

		it("stores onSaved callback on instance when provided", async () => {
			const onSaved = vi.fn();
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot, onSaved);

			const panel = (
				SettingsWebviewPanel as unknown as {
					currentPanel: { onSavedCallback: unknown };
				}
			).currentPanel;
			expect(panel.onSavedCallback).toBe(onSaved);
		});

		it("updates onSaved callback on instance for subsequent show() calls", async () => {
			const onSaved1 = vi.fn();
			const onSaved2 = vi.fn();

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot, onSaved1);
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot, onSaved2);

			const panel = (
				SettingsWebviewPanel as unknown as {
					currentPanel: { onSavedCallback: unknown };
				}
			).currentPanel;
			expect(panel.onSavedCallback).toBe(onSaved2);
		});
	});

	// ── dispose() ────────────────────────────────────────────────────────────

	describe("dispose()", () => {
		it("disposes the panel and clears the singleton", async () => {
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const panel = createWebviewPanel.mock.results[0].value;

			SettingsWebviewPanel.dispose();

			expect(panel.dispose).toHaveBeenCalled();
			expect(
				(SettingsWebviewPanel as unknown as { currentPanel: unknown })
					.currentPanel,
			).toBeUndefined();
		});

		it("does nothing when no panel is open", () => {
			// Should not throw
			expect(() => SettingsWebviewPanel.dispose()).not.toThrow();
		});
	});

	// ── maskApiKey (tested via loadSettings behavior) ────────────────────────

	describe("maskApiKey logic (via handleLoadSettings)", () => {
		it("sends empty string for undefined api key", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					maskedApiKey: "",
					maskedJolliApiKey: "",
				}),
			);
		});

		it("forwards dcoSignoff: true to settingsLoaded when set on disk", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
				dcoSignoff: true,
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({ dcoSignoff: true }),
				}),
			);
		});

		it("defaults dcoSignoff to false when absent from config", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({ dcoSignoff: false }),
				}),
			);
		});

		it("maps globalInstructions 'enabled' to true, and undecided/'disabled' to false", async () => {
			async function loadWithGlobalInstructions(
				globalInstructions: "enabled" | "disabled" | undefined,
			): Promise<boolean> {
				SettingsWebviewPanel.dispose();
				mockLoadConfigFromDir.mockResolvedValue({
					apiKey: undefined,
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: undefined,
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: [],
					globalInstructions,
				});
				await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
				const dispatch = captureMessageHandler();
				postMessage.mockClear();
				dispatch({ command: "loadSettings" });
				await flushPromises();
				const call = postMessage.mock.calls.find(
					([msg]) => (msg as { command: string }).command === "settingsLoaded",
				);
				const msg = call?.[0] as { settings: { globalInstructions: boolean } };
				return msg.settings.globalInstructions;
			}

			expect(await loadWithGlobalInstructions("enabled")).toBe(true);
			expect(await loadWithGlobalInstructions("disabled")).toBe(false);
			expect(await loadWithGlobalInstructions(undefined)).toBe(false);
		});

		it("returns short key without known prefix as-is", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: "shortkey",
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					maskedApiKey: "shortkey",
				}),
			);
		});

		it("masks short key with known prefix (sk-ant-)", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: "sk-ant-12345",
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			// "sk-ant-12345" (12 chars) → first 8 + **** + last 4
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					maskedApiKey: "sk-ant-1****2345",
				}),
			);
		});

		it("masks long key: first 12 + **** + last 4", async () => {
			// Key is exactly "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234" (43 chars)
			const longKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234";
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: longKey,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			const expectedMask = `${longKey.substring(0, 12)}****${longKey.substring(longKey.length - 4)}`;

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					maskedApiKey: expectedMask,
				}),
			);
		});
	});

	// ── handleLoadSettings ───────────────────────────────────────────────────

	describe("handleLoadSettings", () => {
		it("sends settingsLoaded with correct payload from global config", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234",
				model: "claude-3-5",
				maxTokens: 4096,
				jolliApiKey:
					"sk-jol-eyJ0IjoidGVuYW50IiwidSI6Imh0dHBzOi8vdGVuYW50LmpvbGxpLmFpIn0.secret",
				claudeEnabled: true,
				codexEnabled: false,
				geminiEnabled: true,
				openCodeEnabled: false,
				excludePatterns: ["dist", "node_modules"],
				compileExcludeFolders: ["archive", "tmp-*"],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(mockGetGlobalConfigDir).toHaveBeenCalled();
			expect(mockLoadConfigFromDir).toHaveBeenCalledWith(
				"/global/.jollimemory",
			);

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({
						model: "claude-3-5",
						maxTokens: 4096,
						claudeEnabled: true,
						codexEnabled: false,
						geminiEnabled: true,
						openCodeEnabled: false,
						excludePatterns: "dist, node_modules",
						compileExcludeFolders: "archive, tmp-*",
					}),
				}),
			);
		});

		it("uses model default of 'sonnet' when config has no model", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: undefined,
				maxTokens: undefined,
				jolliApiKey: undefined,
				claudeEnabled: undefined,
				codexEnabled: undefined,
				geminiEnabled: undefined,
				openCodeEnabled: undefined,
				excludePatterns: undefined,
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({
						model: "sonnet",
						maxTokens: null,
						claudeEnabled: true,
						codexEnabled: true,
						geminiEnabled: true,
						openCodeEnabled: true,
						excludePatterns: "",
						compileExcludeFolders: "",
					}),
				}),
			);
		});

		it("posts settingsError when load fails", async () => {
			mockLoadConfigFromDir.mockRejectedValue(new Error("disk error"));

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("Load failed"),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsError",
					message: "Failed to load settings",
				}),
			);
		});
	});

	// ── handleApplySettings ──────────────────────────────────────────────────

	describe("handleApplySettings", () => {
		/** Loads settings to populate fullApiKey / fullJolliApiKey, then returns dispatch fn. */
		async function setupWithLoadedConfig(
			configOverrides?: Record<string, unknown>,
		) {
			const config = {
				apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234",
				model: "sonnet",
				maxTokens: null,
				jolliApiKey:
					"sk-jol-eyJ0IjoidGVuYW50IiwidSI6Imh0dHBzOi8vdGVuYW50LmpvbGxpLmFpIn0.secret",
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				openCodeEnabled: true,
				excludePatterns: [],
				...configOverrides,
			};
			mockLoadConfigFromDir.mockResolvedValue(config);

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();

			// Trigger load to cache fullApiKey / fullJolliApiKey
			dispatch({ command: "loadSettings" });
			await flushPromises();
			postMessage.mockClear();

			return dispatch;
		}

		it("preserves original API key when masked value is unchanged", async () => {
			const originalKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234";
			const dispatch = await setupWithLoadedConfig({ apiKey: originalKey });

			const maskedApiKey = `${originalKey.substring(0, 12)}****${originalKey.substring(originalKey.length - 4)}`;

			dispatch({
				command: "applySettings",
				maskedApiKey,
				maskedJolliApiKey: "",
				settings: {
					apiKey: maskedApiKey, // unchanged masked value
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: originalKey }),
				expect.any(String),
			);
		});

		it("uses new API key when user provides a different value", async () => {
			const dispatch = await setupWithLoadedConfig();
			const newKey = "sk-ant-new-key-12345678901234567890";

			dispatch({
				command: "applySettings",
				maskedApiKey: "sk-ant-api03****1234", // old masked value
				maskedJolliApiKey: "",
				settings: {
					apiKey: newKey, // new unmasked value (different from maskedApiKey)
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: newKey }),
				expect.any(String),
			);
		});

		it("persists local-agent provider + tool to config", async () => {
			const dispatch = await setupWithLoadedConfig();
			dispatch({
				command: "applySettings",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					aiProvider: "local-agent",
					localAgentTool: "claude-code",
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
				maskedApiKey: "",
				maskedJolliApiKey: "",
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ aiProvider: "local-agent", localAgentTool: "claude-code" }),
				expect.any(String),
			);
		});

		it("preserves original jolli API key when masked value is unchanged", async () => {
			const jolliKey =
				"sk-jol-eyJ0IjoidGVuYW50IiwidSI6Imh0dHBzOi8vdGVuYW50LmpvbGxpLmFpIn0.secret";
			const dispatch = await setupWithLoadedConfig({ jolliApiKey: jolliKey });

			const maskedJolliKey = `${jolliKey.substring(0, 12)}****${jolliKey.substring(jolliKey.length - 4)}`;

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: maskedJolliKey,
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: maskedJolliKey, // unchanged masked value
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ jolliApiKey: jolliKey }),
				expect.any(String),
			);
		});

		it("uses new jolli API key when user changes it from the masked value", async () => {
			const jolliKey =
				"sk-jol-eyJ0IjoidGVuYW50IiwidSI6Imh0dHBzOi8vdGVuYW50LmpvbGxpLmFpIn0.secret";
			const dispatch = await setupWithLoadedConfig({ jolliApiKey: jolliKey });

			const maskedJolliKey = `${jolliKey.substring(0, 12)}****${jolliKey.substring(jolliKey.length - 4)}`;
			const newJolliKey =
				"sk-jol-eyJ0IjoidGVuYW50MiIsInUiOiJodHRwczovL3RlbmFudDIuam9sbGkuYWkifQ.secret";

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: maskedJolliKey,
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: newJolliKey, // different from masked → use as-is
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ jolliApiKey: newJolliKey }),
				expect.any(String),
			);
		});

		it("saves undefined apiKey when user clears the API key field", async () => {
			const apiKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234";
			const dispatch = await setupWithLoadedConfig({ apiKey });

			const maskedApiKey = `${apiKey.substring(0, 12)}****${apiKey.substring(apiKey.length - 4)}`;

			dispatch({
				command: "applySettings",
				maskedApiKey,
				maskedJolliApiKey: "",
				settings: {
					apiKey: "", // different from masked → resolvedApiKey is "", length 0 → undefined
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: undefined }),
				expect.any(String),
			);
		});

		it("parses exclude patterns from comma-separated string", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "dist, node_modules, .cache",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({
					excludePatterns: ["dist", "node_modules", ".cache"],
				}),
				expect.any(String),
			);
		});

		it("omits excludePatterns when string is empty", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ excludePatterns: undefined }),
				expect.any(String),
			);
		});

		it("saves compileExcludeFolders as a trimmed array", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
					compileExcludeFolders: "archive, tmp-* , experiments",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({
					compileExcludeFolders: ["archive", "tmp-*", "experiments"],
				}),
				expect.any(String),
			);
		});

		it("omits compileExcludeFolders when string is empty", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
					compileExcludeFolders: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ compileExcludeFolders: undefined }),
				expect.any(String),
			);
		});

		it("tolerates a payload that omits compileExcludeFolders", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ compileExcludeFolders: undefined }),
				expect.any(String),
			);
		});

		it("saves dcoSignoff: true when toggle is on", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
					dcoSignoff: true,
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ dcoSignoff: true }),
				expect.any(String),
			);
		});

		it("omits dcoSignoff (undefined) when toggle is off", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
					dcoSignoff: false,
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ dcoSignoff: undefined }),
				expect.any(String),
			);
		});

		it("saves to global config dir", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.any(Object),
				"/global/.jollimemory",
			);
		});

		it("posts settingsSaved and invokes onSaved callback after save", async () => {
			const onSaved = vi.fn();
			// Show with onSaved callback, then get dispatch
			SettingsWebviewPanel.dispose();
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot, onSaved);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith({ command: "settingsSaved" });
			expect(onSaved).toHaveBeenCalled();
			expect(info).toHaveBeenCalledWith("SettingsPanel", "Settings saved");
		});

		it("rejects a Jolli API key that cannot be decoded (wrong prefix), without saving", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "sf-jol-garbage",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).not.toHaveBeenCalled();
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsError",
					message: expect.stringMatching(/cannot be decoded/),
				}),
			);
		});

		it("rejects a Jolli API key with no embedded meta (legacy-only shape), without saving", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "sk-jol-legacyhex32chars",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).not.toHaveBeenCalled();
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsError",
					message: expect.stringMatching(/cannot be decoded/),
				}),
			);
		});

		it("rejects a Jolli API key whose embedded origin is off the allowlist, without saving", async () => {
			const dispatch = await setupWithLoadedConfig();
			// Build a key whose decoded meta.u points off the allowlist
			const badMeta = { t: "x", u: "https://evil.com" };
			const encoded = Buffer.from(JSON.stringify(badMeta)).toString(
				"base64url",
			);
			const badKey = `sk-jol-${encoded}.secret`;

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: badKey,
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).not.toHaveBeenCalled();
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsError",
					message: expect.stringMatching(/evil\.com/),
				}),
			);
		});

		it("accepts a Jolli API key whose embedded origin is on the allowlist", async () => {
			const dispatch = await setupWithLoadedConfig();
			const goodMeta = { t: "tenant1", u: "https://tenant1.jolli.ai" };
			const encoded = Buffer.from(JSON.stringify(goodMeta)).toString(
				"base64url",
			);
			const goodKey = `sk-jol-${encoded}.secret`;

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: goodKey,
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ jolliApiKey: goodKey }),
				expect.any(String),
			);
		});

		it("posts settingsError when save fails", async () => {
			mockSaveConfigScoped.mockRejectedValue(new Error("write error"));
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("Save failed"),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsError",
					message: "Failed to save settings",
				}),
			);
		});

		it("omits model field when model is 'sonnet' (default)", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ model: undefined }),
				expect.any(String),
			);
		});

		it("saves non-default model value", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "claude-3-opus",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ model: "claude-3-opus" }),
				expect.any(String),
			);
		});

		it("saves false for disabled AI providers", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: false,
					codexEnabled: false,
					geminiEnabled: false,
					openCodeEnabled: false,
					cursorEnabled: false,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({
					claudeEnabled: false,
					codexEnabled: false,
					geminiEnabled: false,
					openCodeEnabled: false,
					cursorEnabled: false,
				}),
				expect.any(String),
			);
		});

		it("omits enabled AI provider flags (saves undefined when enabled)", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					openCodeEnabled: true,
					cursorEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					openCodeEnabled: true,
					cursorEnabled: true,
				}),
				expect.any(String),
			);
		});

		it("loads and saves OpenCode integration state", async () => {
			const dispatch = await setupWithLoadedConfig({ openCodeEnabled: false });

			// Re-trigger load — setupWithLoadedConfig clears postMessage after initial load
			dispatch({ command: "loadSettings", scope: "project" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({ openCodeEnabled: false }),
				}),
			);

			postMessage.mockClear();
			dispatch({
				command: "applySettings",
				scope: "project",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					openCodeEnabled: false,
					cursorEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ openCodeEnabled: false }),
				expect.any(String),
			);
		});

		it("loads and saves Cursor integration state", async () => {
			const dispatch = await setupWithLoadedConfig({ cursorEnabled: false });

			dispatch({ command: "loadSettings", scope: "project" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({ cursorEnabled: false }),
				}),
			);

			postMessage.mockClear();
			dispatch({
				command: "applySettings",
				scope: "project",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					openCodeEnabled: true,
					cursorEnabled: false,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ cursorEnabled: false }),
				expect.any(String),
			);
		});

		it("loads copilotEnabled from config (default true)", async () => {
			// When config has copilotEnabled: false, it should be sent as false
			const dispatch = await setupWithLoadedConfig({ copilotEnabled: false });
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({ copilotEnabled: false }),
				}),
			);

			// When config has no copilotEnabled, it should default to true
			postMessage.mockClear();
			SettingsWebviewPanel.dispose();
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				// copilotEnabled intentionally absent
				excludePatterns: [],
			});
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch2 = captureMessageHandler();
			dispatch2({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({ copilotEnabled: true }),
				}),
			);
		});

		it("persists copilotEnabled when the user submits", async () => {
			const dispatch = await setupWithLoadedConfig({ copilotEnabled: true });

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					openCodeEnabled: true,
					copilotEnabled: false,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ copilotEnabled: false }),
				expect.any(String),
			);
		});

		it("removes Claude and Gemini hooks when disabled", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: false,
					codexEnabled: true,
					geminiEnabled: false,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockRemoveClaudeHook).toHaveBeenCalledWith("/workspace");
			expect(mockRemoveGeminiHook).toHaveBeenCalledWith("/workspace");
			expect(mockInstallClaudeHook).not.toHaveBeenCalled();
			expect(mockInstallGeminiHook).not.toHaveBeenCalled();
		});

		it("installs Claude and Gemini hooks when enabled", async () => {
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockInstallClaudeHook).toHaveBeenCalledWith("/workspace");
			expect(mockInstallGeminiHook).toHaveBeenCalledWith("/workspace");
			expect(mockRemoveClaudeHook).not.toHaveBeenCalled();
			expect(mockRemoveGeminiHook).not.toHaveBeenCalled();
		});

		it("syncs hooks across all worktrees returned by listWorktrees", async () => {
			mockListWorktrees.mockResolvedValue([
				"/workspace",
				"/workspace-wt1",
				"/workspace-wt2",
			]);
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockInstallClaudeHook).toHaveBeenCalledTimes(3);
			expect(mockInstallGeminiHook).toHaveBeenCalledTimes(3);
			expect(mockInstallClaudeHook).toHaveBeenCalledWith("/workspace-wt1");
			expect(mockInstallGeminiHook).toHaveBeenCalledWith("/workspace-wt2");
		});

		it("falls back to repoRoot when listWorktrees throws", async () => {
			mockListWorktrees.mockRejectedValue(new Error("git not found"));
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockInstallClaudeHook).toHaveBeenCalledWith("/workspace");
			expect(mockInstallGeminiHook).toHaveBeenCalledWith("/workspace");
		});

		it("posts settingsError when installClaudeHook throws for a worktree", async () => {
			mockInstallClaudeHook.mockRejectedValue(new Error("permission denied"));
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				"Failed to sync Claude hook for /workspace",
				expect.any(Error),
			);
			expect(mockInstallGeminiHook).toHaveBeenCalledWith("/workspace");
			expect(postMessage).toHaveBeenCalledWith({
				command: "settingsError",
				message: "Failed to save settings",
			});
			// Config must NOT be persisted when hook sync fails
			expect(mockSaveConfigScoped).not.toHaveBeenCalled();
		});

		it("posts settingsError when removeClaudeHook throws for a worktree", async () => {
			mockRemoveClaudeHook.mockRejectedValue(new Error("file locked"));
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: false,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				"Failed to sync Claude hook for /workspace",
				expect.any(Error),
			);
			expect(mockInstallGeminiHook).toHaveBeenCalledWith("/workspace");
			expect(postMessage).toHaveBeenCalledWith({
				command: "settingsError",
				message: "Failed to save settings",
			});
			expect(mockSaveConfigScoped).not.toHaveBeenCalled();
		});

		it("posts settingsError when installGeminiHook throws for a worktree", async () => {
			mockInstallGeminiHook.mockRejectedValue(new Error("disk full"));
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				"Failed to sync Gemini hook for /workspace",
				expect.any(Error),
			);
			expect(mockInstallClaudeHook).toHaveBeenCalledWith("/workspace");
			expect(postMessage).toHaveBeenCalledWith({
				command: "settingsError",
				message: "Failed to save settings",
			});
			expect(mockSaveConfigScoped).not.toHaveBeenCalled();
		});

		it("posts settingsError when removeGeminiHook throws for a worktree", async () => {
			mockRemoveGeminiHook.mockRejectedValue(new Error("no such file"));
			const dispatch = await setupWithLoadedConfig();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: false,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				"Failed to sync Gemini hook for /workspace",
				expect.any(Error),
			);
			expect(mockInstallClaudeHook).toHaveBeenCalledWith("/workspace");
			expect(postMessage).toHaveBeenCalledWith({
				command: "settingsError",
				message: "Failed to save settings",
			});
			expect(mockSaveConfigScoped).not.toHaveBeenCalled();
		});
	});

	// ── applySettings with globalInstructions ───────────────────────────────
	// Tri-state config (undefined | "enabled" | "disabled") behind a binary
	// checkbox. See task-settings-brief.md for the mapping rules: turning the
	// checkbox off must not clobber an "undecided" config value.
	// syncGlobalInstructions runs on a transition in EITHER direction — enabling
	// writes the block, disabling removes it — but not on a no-op re-save.

	describe("applySettings with globalInstructions", () => {
		/** Loads settings to populate cached keys, then returns dispatch fn. */
		async function setupForGlobalInstructions(
			configOverrides?: Record<string, unknown>,
		) {
			const config = {
				apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234",
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: "",
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
				...configOverrides,
			};
			mockLoadConfigFromDir.mockResolvedValue(config);
			mockInstallClaudeHook.mockResolvedValue({});
			mockRemoveClaudeHook.mockResolvedValue({});
			mockInstallGeminiHook.mockResolvedValue({});
			mockRemoveGeminiHook.mockResolvedValue(undefined);

			SettingsWebviewPanel.dispose();
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();

			dispatch({ command: "loadSettings" });
			await flushPromises();
			postMessage.mockClear();

			return dispatch;
		}

		function applyGlobalInstructions(
			dispatch: (msg: Record<string, unknown>) => void,
			globalInstructions: boolean,
		) {
			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
					globalInstructions,
				},
			});
		}

		it("toggle ON from undecided persists 'enabled' and syncs the block once", async () => {
			const dispatch = await setupForGlobalInstructions({ globalInstructions: undefined });

			applyGlobalInstructions(dispatch, true);
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ globalInstructions: "enabled" }),
				expect.any(String),
			);
			expect(mockSyncGlobalInstructions).toHaveBeenCalledTimes(1);
		});

		it("toggle OFF while currently 'enabled' persists 'disabled' and syncs (removal)", async () => {
			const dispatch = await setupForGlobalInstructions({ globalInstructions: "enabled" });

			applyGlobalInstructions(dispatch, false);
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ globalInstructions: "disabled" }),
				expect.any(String),
			);
			// The disable transition must run the sync so the block is actually
			// removed — flipping the flag alone would leave a stale block behind.
			expect(mockSyncGlobalInstructions).toHaveBeenCalledTimes(1);
		});

		it("toggle OFF while undecided omits the field entirely (preserve undecided) and does not sync", async () => {
			const dispatch = await setupForGlobalInstructions({ globalInstructions: undefined });

			applyGlobalInstructions(dispatch, false);
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledTimes(1);
			const [savedUpdate] = mockSaveConfigScoped.mock.calls[0] as [Record<string, unknown>, string];
			expect(Object.hasOwn(savedUpdate, "globalInstructions")).toBe(false);
			expect(mockSyncGlobalInstructions).not.toHaveBeenCalled();
		});

		it("toggle ON while already 'enabled' does not re-sync", async () => {
			const dispatch = await setupForGlobalInstructions({ globalInstructions: "enabled" });

			applyGlobalInstructions(dispatch, true);
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ globalInstructions: "enabled" }),
				expect.any(String),
			);
			expect(mockSyncGlobalInstructions).not.toHaveBeenCalled();
		});
	});

	// ── browseLocalFolder ──────────────────────────────────────────────────────

	describe("browseLocalFolder", () => {
		it("triggers showOpenDialog and posts setLocalFolder back on pick", async () => {
			mockShowOpenDialog.mockResolvedValue([{ fsPath: "/home/user/memories" }]);

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "browseLocalFolder" });
			await flushPromises();

			expect(mockShowOpenDialog).toHaveBeenCalledWith(
				expect.objectContaining({
					canSelectFolders: true,
					canSelectFiles: false,
					canSelectMany: false,
					openLabel: "Select folder for Push to Local",
				}),
			);
			expect(postMessage).toHaveBeenCalledWith({
				command: "setLocalFolder",
				path: "/home/user/memories",
			});
		});

		it("posts nothing when picker is cancelled (returns undefined)", async () => {
			mockShowOpenDialog.mockResolvedValue(undefined);

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "browseLocalFolder" });
			await flushPromises();

			expect(mockShowOpenDialog).toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ command: "setLocalFolder" }),
			);
		});

		it("posts nothing when picker returns empty array", async () => {
			mockShowOpenDialog.mockResolvedValue([]);

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "browseLocalFolder" });
			await flushPromises();

			expect(mockShowOpenDialog).toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ command: "setLocalFolder" }),
			);
		});

		it("logs error when showOpenDialog rejects", async () => {
			mockShowOpenDialog.mockRejectedValue(new Error("dialog crashed"));

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "browseLocalFolder" });
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("Browse failed"),
			);
		});
	});

	// ── applySettings with localFolder ──────────────────────────────────────
	// The legacy "Default Push Action" fieldset and its `pushAction` config
	// field were retired across 2026-04 (UI) and 2026-05 (type + runtime);
	// these tests track the surviving localFolder behavior.

	describe("applySettings with localFolder", () => {
		/** Loads settings to populate cached keys, then returns dispatch fn. */
		async function setupForLocalKnowledgeBase(
			configOverrides?: Record<string, unknown>,
		) {
			const config = {
				apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234",
				model: "sonnet",
				maxTokens: null,
				jolliApiKey:
					"sk-jol-eyJ0IjoidGVuYW50IiwidSI6Imh0dHBzOi8vdGVuYW50LmpvbGxpLmFpIn0.secret",
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				localFolder: undefined,
				excludePatterns: [],
				...configOverrides,
			};
			mockLoadConfigFromDir.mockResolvedValue(config);
			// Restore hook mocks (may have been set to reject by earlier tests)
			mockInstallClaudeHook.mockResolvedValue({});
			mockRemoveClaudeHook.mockResolvedValue({});
			mockInstallGeminiHook.mockResolvedValue({});
			mockRemoveGeminiHook.mockResolvedValue(undefined);

			SettingsWebviewPanel.dispose();
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();

			dispatch({ command: "loadSettings" });
			await flushPromises();
			postMessage.mockClear();

			return dispatch;
		}

		it("persists localFolder when provided", async () => {
			const dispatch = await setupForLocalKnowledgeBase();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					localFolder: "/home/user/kb",
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({
					localFolder: "/home/user/kb",
				}),
				expect.any(String),
			);
		});

		it("persists undefined localFolder when field is empty", async () => {
			const dispatch = await setupForLocalKnowledgeBase();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					localFolder: "",
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({
					localFolder: undefined,
				}),
				expect.any(String),
			);
		});
	});

	// ── handleLoadSettings with localFolder ─────────────────────────────────

	describe("handleLoadSettings with localFolder", () => {
		it("sends localFolder in settingsLoaded payload", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				localFolder: "/saved/folder",
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({
						localFolder: "/saved/folder",
					}),
				}),
			);
		});

		it("defaults localFolder to empty string when not set", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				localFolder: undefined,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({
						localFolder: "",
					}),
				}),
			);
		});
	});

	// ── maskApiKey edge case: key with known prefix shorter than 5 chars total ──

	describe("maskApiKey edge case (via handleLoadSettings)", () => {
		it("masks key with known prefix sk-jol- even when short", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: "sk-jol-x",
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			// "sk-jol-x" is 8 chars, hasKnownPrefix=true, so it enters masking path
			// prefixLen = Math.min(12, 8-4) = 4
			// result = "sk-j" + "****" + "ol-x"
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					maskedApiKey: "sk-j****ol-x",
				}),
			);
		});

		it("returns empty string for empty api key", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: "",
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					maskedApiKey: "",
				}),
			);
		});
	});

	// ── Tabbed-layout additions: aiProvider + auth-state cards ──

	describe("aiProvider + auth state", () => {
		it("settingsLoaded includes signedIn / hasJolliKey / jolliSiteLabel", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					signedIn: false,
					hasJolliKey: false,
					jolliSiteLabel: "Using Jolli to generate summaries",
				}),
			);
		});

		it("derives jolliSiteLabel from the embedded meta.u of the Jolli API key", async () => {
			const meta = { t: "tenant1", u: "https://tenant1.jolli.ai" };
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			const jolliKey = `sk-jol-${encoded}.secret`;

			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: jolliKey,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					hasJolliKey: true,
					jolliSiteLabel:
						"Signed in to tenant1.jolli.ai — using Jolli to generate summaries",
				}),
			);
		});

		it("falls back to config.jolliUrl when jolliApiKey is absent (post-cross-tenant clear)", async () => {
			// Mirrors `jolli status`: when `saveAuthCredentials` cleared a
			// stale per-tenant key but kept the persisted sign-in origin,
			// the panel still has enough info to show the user which site
			// they're signed into. Without the fallback the panel would
			// show the generic "Using Jolli to generate summaries" line
			// while the CLI's `jolli status` displayed the real site.
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				jolliUrl: "https://tenant.jolli.ai",
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					jolliSiteLabel:
						"Signed in to tenant.jolli.ai — using Jolli to generate summaries",
				}),
			);
		});

		it("falls back to config.jolliUrl when jolliApiKey is undecodable (legacy/hand-typed)", async () => {
			// Mirrors the CLI's `StatusCommand` test of the same case. A user
			// who pasted a hand-typed `sk-jol-` key without an embedded `meta.u`
			// (`parseJolliApiKey` returns null) must still see the persisted
			// `jolliUrl` in the panel — otherwise the panel reverts to the
			// generic "Using Jolli to generate summaries" while the CLI shows
			// the real tenant. The nullish-coalesce in `buildJolliSiteLabel`
			// pins this branch; a regression that swapped it for a truthy
			// check would still pass the absent-key test above.
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: "sk-jol-legacy",
				jolliUrl: "https://tenant.jolli.ai",
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					hasJolliKey: true,
					jolliSiteLabel:
						"Signed in to tenant.jolli.ai — using Jolli to generate summaries",
				}),
			);
		});

		it("settingsLoaded.settings.aiProvider defaults to 'anthropic' when unset and not signed in", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({ aiProvider: "anthropic" }),
				}),
			);
		});

		it("settingsLoaded.settings.aiProvider honors an explicit 'jolli' value", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				aiProvider: "jolli",
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({ aiProvider: "jolli" }),
				}),
			);
		});

		it("applySettings persists aiProvider verbatim", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});
			// Reset hook mocks (some earlier tests in this file leave them rejecting).
			mockInstallClaudeHook.mockResolvedValue({});
			mockRemoveClaudeHook.mockResolvedValue({});
			mockInstallGeminiHook.mockResolvedValue({});
			mockRemoveGeminiHook.mockResolvedValue(undefined);

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();
			postMessage.mockClear();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					aiProvider: "jolli",
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					openCodeEnabled: true,
					cursorEnabled: true,
					copilotEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({ aiProvider: "jolli" }),
				expect.any(String),
			);
		});
	});

	describe("signIn / signOut messages", () => {
		it("dispatches the jollimemory.signIn command on a signIn message", async () => {
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "signIn" });
			await flushPromises();

			expect(mockExecuteCommand).toHaveBeenCalledWith("jollimemory.signIn");
		});

		it("dispatches the jollimemory.signOut command on a signOut message", async () => {
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "signOut" });
			await flushPromises();

			expect(mockExecuteCommand).toHaveBeenCalledWith("jollimemory.signOut");
		});

		it("dispatches the jollimemory.syncNow command on a syncNow message", async () => {
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "syncNow" });
			await flushPromises();

			expect(mockExecuteCommand).toHaveBeenCalledWith("jollimemory.syncNow");
		});

		it("logs the rejection (no banner) when jollimemory.syncNow rejects", async () => {
			// Unlike signIn, syncNow's rejection path is log-only — the
			// orchestrator owns user-facing status surface, so a webview
			// banner would double-up. Verifies the catch arm executes.
			mockExecuteCommand.mockImplementation(async (cmd: string) => {
				if (cmd === "jollimemory.syncNow") throw new Error("sync blew up");
				return undefined;
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "syncNow" });
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("sync blew up"),
			);
		});
	});

	describe("notifyAuthChanged", () => {
		it("posts authStateChanged to the open panel with refreshed state", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			postMessage.mockClear();

			// Server has just issued a Jolli API key — notifyAuthChanged should
			// re-read the config and reflect the new state in the next message.
			const meta = { t: "tenant", u: "https://tenant.jolli.ai" };
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			const jolliKey = `sk-jol-${encoded}.secret`;
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: jolliKey,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.notifyAuthChanged();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "authStateChanged",
					hasJolliKey: true,
					jolliSiteLabel: expect.stringContaining("tenant.jolli.ai"),
				}),
			);
		});

		it("is a no-op when no panel is open", async () => {
			SettingsWebviewPanel.dispose();
			postMessage.mockClear();
			await SettingsWebviewPanel.notifyAuthChanged();
			expect(postMessage).not.toHaveBeenCalled();
		});

		it("posts authStateChanged with the resolved aiProvider so the form can re-sync", async () => {
			// Pin: sign-in writes aiProvider:"jolli" on disk via
			// saveAuthCredentials. Without postAuthState relaying that, the
			// open form's dropdown stays stale and the next Apply silently
			// overwrites disk with the user's pre-sign-in choice. Whichever
			// provider is on disk after the auth event has to round-trip into
			// the message.
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				aiProvider: "jolli",
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			postMessage.mockClear();

			await SettingsWebviewPanel.notifyAuthChanged();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "authStateChanged",
					aiProvider: "jolli",
				}),
			);
		});

		it("posts authStateChanged with hasJolliKey=false when config has no Jolli key", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			postMessage.mockClear();

			await SettingsWebviewPanel.notifyAuthChanged();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "authStateChanged",
					hasJolliKey: false,
					jolliSiteLabel: "Using Jolli to generate summaries",
				}),
			);
		});
	});

	describe("rebuildKnowledgeBase message", () => {
		it("forwards the command and posts success result back to the webview", async () => {
			mockExecuteCommand.mockImplementation(async (cmd: string) => {
				if (cmd === "jollimemory.rebuildKnowledgeBase") {
					return { ok: true, message: "Migrated 42 memories" };
				}
				return undefined;
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "rebuildKnowledgeBase" });
			await flushPromises();

			expect(mockExecuteCommand).toHaveBeenCalledWith(
				"jollimemory.rebuildKnowledgeBase",
			);
			expect(postMessage).toHaveBeenCalledWith({
				command: "rebuildKnowledgeBaseDone",
				success: true,
				message: "Migrated 42 memories",
			});
		});

		it("falls back to success=false / empty message when the command returns undefined", async () => {
			mockExecuteCommand.mockResolvedValue(undefined);

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "rebuildKnowledgeBase" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith({
				command: "rebuildKnowledgeBaseDone",
				success: false,
				message: "",
			});
		});

		it("posts the error message back when the command rejects with an Error", async () => {
			mockExecuteCommand.mockRejectedValue(new Error("rebuild boom"));

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "rebuildKnowledgeBase" });
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("rebuild boom"),
			);
			expect(postMessage).toHaveBeenCalledWith({
				command: "rebuildKnowledgeBaseDone",
				success: false,
				message: "rebuild boom",
			});
		});

		it("stringifies non-Error rejections in the failure message", async () => {
			mockExecuteCommand.mockRejectedValue("plain string failure");

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "rebuildKnowledgeBase" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith({
				command: "rebuildKnowledgeBaseDone",
				success: false,
				message: "plain string failure",
			});
		});

		it("bails out of the catch when the panel was disposed before the rebuild rejected", async () => {
			let rejectCmd: (e: unknown) => void = () => {};
			mockExecuteCommand.mockImplementation(() => new Promise((_res, rej) => {
				rejectCmd = rej;
			}));
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "rebuildKnowledgeBase" });
			(SettingsWebviewPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
			rejectCmd(new Error("late rebuild"));
			await flushPromises();

			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ command: "rebuildKnowledgeBaseDone" }),
			);
		});
	});

	describe("generateMissingSummaries message", () => {
		it("forwards the command, posts the result, and refreshes the count", async () => {
			mockCountMissingSummaries.mockResolvedValue({ missing: 3, total: 10 });
			mockExecuteCommand.mockImplementation(async (cmd: string) =>
				cmd === "jollimemory.generateMissingSummaries"
					? { ok: true, generated: 2, total: 2, skipped: 0, message: "done" }
					: undefined,
			);
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "generateMissingSummaries" });
			await flushPromises();
			await flushPromises(); // let refreshMissingSummaryCount's dynamic import resolve

			expect(mockExecuteCommand).toHaveBeenCalledWith("jollimemory.generateMissingSummaries");
			expect(postMessage).toHaveBeenCalledWith({
				command: "generateMissingSummariesDone",
				success: true,
				message: "done",
			});
			expect(postMessage).toHaveBeenCalledWith({
				command: "missingSummaryCountLoaded",
				missingSummaryCount: 3,
				repoName: "myrepo",
			});
		});

		it("falls back to success=false / empty message when the command returns undefined", async () => {
			mockExecuteCommand.mockResolvedValue(undefined);
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "generateMissingSummaries" });
			await flushPromises();
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith({
				command: "generateMissingSummariesDone",
				success: false,
				message: "",
			});
		});

		it("posts the error message back when the command rejects", async () => {
			mockExecuteCommand.mockRejectedValue(new Error("gen boom"));
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "generateMissingSummaries" });
			await flushPromises();

			expect(logError).toHaveBeenCalledWith("SettingsPanel", expect.stringContaining("gen boom"));
			expect(postMessage).toHaveBeenCalledWith({
				command: "generateMissingSummariesDone",
				success: false,
				message: "gen boom",
			});
		});

		it("bails out without posting when the panel was disposed while the command ran", async () => {
			let release: (v: unknown) => void = () => {};
			mockExecuteCommand.mockImplementation(() => new Promise((r) => {
				release = r;
			}));
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "generateMissingSummaries" });
			// Panel disposed/replaced before the command resolves.
			(SettingsWebviewPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
			release({ ok: true, generated: 0, total: 0, skipped: 0, message: "" });
			await flushPromises();

			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ command: "generateMissingSummariesDone" }),
			);
		});

		it("stringifies a non-Error rejection in the failure message", async () => {
			mockExecuteCommand.mockRejectedValue("plain gen failure");
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "generateMissingSummaries" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith({
				command: "generateMissingSummariesDone",
				success: false,
				message: "plain gen failure",
			});
		});

		it("bails out of the catch when the panel was disposed before the command rejected", async () => {
			let rejectCmd: (e: unknown) => void = () => {};
			mockExecuteCommand.mockImplementation(() => new Promise((_res, rej) => {
				rejectCmd = rej;
			}));
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "generateMissingSummaries" });
			(SettingsWebviewPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
			rejectCmd(new Error("late boom"));
			await flushPromises();

			expect(postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ command: "generateMissingSummariesDone" }),
			);
		});
	});

	describe("missing-summary count refresh", () => {
		it("posts the count on success (via loadSettings)", async () => {
			mockCountMissingSummaries.mockResolvedValue({ missing: 5, total: 12 });
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "loadSettings" });
			await flushPromises();
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith({
				command: "missingSummaryCountLoaded",
				missingSummaryCount: 5,
				repoName: "myrepo",
			});
		});

		it("posts an empty count message when the computation fails", async () => {
			mockCountMissingSummaries.mockRejectedValue(new Error("count boom"));
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "loadSettings" });
			await flushPromises();
			await flushPromises();

			expect(warn).toHaveBeenCalledWith("SettingsPanel", expect.stringContaining("count boom"));
			expect(postMessage).toHaveBeenCalledWith({ command: "missingSummaryCountLoaded" });
		});

		it("does not post when the count fails after the panel was disposed", async () => {
			let rejectCount: (e: unknown) => void = () => {};
			mockCountMissingSummaries.mockImplementation(() => new Promise((_res, rej) => {
				rejectCount = rej;
			}));
			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();

			dispatch({ command: "loadSettings" });
			await flushPromises(); // let the dynamic import + countMissingSummaries call start
			postMessage.mockClear();
			(SettingsWebviewPanel as unknown as { currentPanel: undefined }).currentPanel = undefined;
			rejectCount(new Error("count late"));
			await flushPromises();
			await flushPromises();

			expect(postMessage).not.toHaveBeenCalledWith({ command: "missingSummaryCountLoaded" });
		});
	});

	describe("confirmDirtyMigrate message", () => {
		it("shows a modal warning and posts proceed=true when the user picks Apply Changes & Migrate", async () => {
			mockShowWarningMessage.mockResolvedValue("Apply Changes & Migrate");

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "confirmDirtyMigrate" });
			await flushPromises();

			expect(mockShowWarningMessage).toHaveBeenCalledWith(
				"Folder Path has unsaved changes",
				expect.objectContaining({ modal: true }),
				"Apply Changes & Migrate",
			);
			expect(postMessage).toHaveBeenCalledWith({
				command: "confirmDirtyMigrateResult",
				proceed: true,
			});
		});

		it("posts proceed=false when the user dismisses the modal", async () => {
			mockShowWarningMessage.mockResolvedValue(undefined);

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "confirmDirtyMigrate" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith({
				command: "confirmDirtyMigrateResult",
				proceed: false,
			});
		});

		it("falls back to proceed=false when the modal call throws", async () => {
			mockShowWarningMessage.mockRejectedValue(new Error("modal blew up"));

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();

			dispatch({ command: "confirmDirtyMigrate" });
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("modal blew up"),
			);
			expect(postMessage).toHaveBeenCalledWith({
				command: "confirmDirtyMigrateResult",
				proceed: false,
			});
		});
	});

	describe("signIn / signOut command errors", () => {
		it("logs an error and posts a user-visible banner when jollimemory.signIn rejects", async () => {
			mockExecuteCommand.mockImplementation(async (cmd: string) => {
				if (cmd === "jollimemory.signIn") throw new Error("oauth blew up");
				return undefined;
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();
			dispatch({ command: "signIn" });
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("oauth blew up"),
			);
			expect(postMessage).toHaveBeenCalledWith({
				command: "settingsError",
				message: expect.stringContaining("oauth blew up"),
			});
		});

		it("logs an error and posts a user-visible banner when jollimemory.signOut rejects", async () => {
			mockExecuteCommand.mockImplementation(async (cmd: string) => {
				if (cmd === "jollimemory.signOut") throw new Error("signout blew up");
				return undefined;
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();
			dispatch({ command: "signOut" });
			await flushPromises();

			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("signout blew up"),
			);
			expect(postMessage).toHaveBeenCalledWith({
				command: "settingsError",
				message: expect.stringContaining("signout blew up"),
			});
		});

		// Counterparts to the two tests above: same code path with a
		// **non-Error** rejection. The handler uses
		// `err instanceof Error ? err.message : String(err)` to coerce the
		// banner text — earlier tests exercised only the Error arm. Without
		// these, the String(err) fallback would silently regress to printing
		// `[object Object]` for command rejections that don't subclass Error
		// (third-party command implementations can reject with anything,
		// including raw strings or response objects).

		it("stringifies non-Error rejections from jollimemory.signIn into the banner", async () => {
			mockExecuteCommand.mockImplementation(async (cmd: string) => {
				if (cmd === "jollimemory.signIn") throw "raw-string-reject";
				return undefined;
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();
			dispatch({ command: "signIn" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith({
				command: "settingsError",
				message: expect.stringContaining("raw-string-reject"),
			});
		});

		it("stringifies non-Error rejections from jollimemory.signOut into the banner", async () => {
			mockExecuteCommand.mockImplementation(async (cmd: string) => {
				if (cmd === "jollimemory.signOut") throw "raw-signout-reject";
				return undefined;
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			postMessage.mockClear();
			dispatch({ command: "signOut" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith({
				command: "settingsError",
				message: expect.stringContaining("raw-signout-reject"),
			});
		});
	});

	describe("handleLoadSettings — stored Jolli API key validation", () => {
		it("posts a settingsError when the stored Jolli API key fails to decode", async () => {
			// `sk-jol-` prefix with a single segment that isn't valid base64url JSON →
			// parseJolliApiKey returns null → validateJolliApiKey throws.
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: "sk-jol-not.valid",
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsError",
					message: expect.stringMatching(/key currently on disk is invalid/),
				}),
			);
		});
	});

	describe("resolveProvider — auth-derived fallback", () => {
		it("defaults aiProvider to 'jolli' when unset and authService reports signed-in", async () => {
			const meta = { t: "tenant", u: "https://tenant.jolli.ai" };
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			const jolliKey = `sk-jol-${encoded}.secret`;
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: jolliKey,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			const fakeAuth = { isSignedIn: vi.fn().mockReturnValue(true) };

			await SettingsWebviewPanel.show(
				extensionUri,
				workspaceRoot,
				undefined,
				fakeAuth as never,
			);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(fakeAuth.isSignedIn).toHaveBeenCalled();
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					signedIn: true,
					settings: expect.objectContaining({ aiProvider: "jolli" }),
				}),
			);
		});
	});

	// ── sync settings: numeric / boolean-true branches ──────────────────────
	// These pin the truthy arms of the sync-related conditionals that the rest
	// of the suite only ever exercises in their absent/false form.

	describe("sync settings (auto-sync / transcripts / poll interval)", () => {
		it("forwards a numeric syncPollIntervalSec from disk into settingsLoaded", async () => {
			// Exercises the `typeof config.syncPollIntervalSec === "number"` true
			// arm in handleLoadSettings (otherwise always null in this suite).
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
				syncPollIntervalSec: 7200,
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsLoaded",
					settings: expect.objectContaining({ syncPollIntervalSec: 7200 }),
				}),
			);
		});

		it("persists autoSyncEnabled / syncTranscripts true and clamps a numeric poll interval", async () => {
			// Covers the `=== true ? true : undefined` true arms for autoSync &
			// transcripts, plus the numeric `Math.min/max` clamp arm of
			// syncPollIntervalSec in handleApplySettings.
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();
			postMessage.mockClear();

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
					autoSyncEnabled: true,
					syncTranscripts: true,
					// Below the 5400 floor — must clamp up to 5400.
					syncPollIntervalSec: 100,
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).toHaveBeenCalledWith(
				expect.objectContaining({
					autoSyncEnabled: true,
					syncTranscripts: true,
					syncPollIntervalSec: 5400,
				}),
				expect.any(String),
			);
		});
	});

	// ── non-Error validator fallbacks ───────────────────────────────────────
	// validateJolliApiKey only ever throws `Error`, so the `instanceof Error ?
	// … : "Invalid …"` fallback arms in handleLoadSettings / handleApplySettings
	// are unreachable through the real parser. The test seam (see top-of-file
	// mock) lets us throw a non-Error to pin those arms.

	describe("validator non-Error fallbacks", () => {
		it("uses the generic message when a stored Jolli key validation throws a non-Error", async () => {
			mockValidateJolliApiKey.mockImplementation(() => {
				// biome-ignore lint/suspicious/noExplicitAny: deliberately throwing a non-Error
				throw "raw-load-reject" as any;
			});
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: "sk-jol-anything",
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();

			expect(warn).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("Invalid Jolli API Key on file"),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsError",
					message: expect.stringContaining("Invalid Jolli API Key on file"),
				}),
			);
		});

		it("uses the generic message when applySettings validation throws a non-Error", async () => {
			mockLoadConfigFromDir.mockResolvedValue({
				apiKey: undefined,
				model: "sonnet",
				maxTokens: null,
				jolliApiKey: undefined,
				claudeEnabled: true,
				codexEnabled: true,
				geminiEnabled: true,
				excludePatterns: [],
			});

			await SettingsWebviewPanel.show(extensionUri, workspaceRoot);
			const dispatch = captureMessageHandler();
			dispatch({ command: "loadSettings" });
			await flushPromises();
			postMessage.mockClear();

			// Now make the apply-time validation throw a non-Error.
			mockValidateJolliApiKey.mockImplementation(() => {
				// biome-ignore lint/suspicious/noExplicitAny: deliberately throwing a non-Error
				throw "raw-apply-reject" as any;
			});

			dispatch({
				command: "applySettings",
				maskedApiKey: "",
				maskedJolliApiKey: "",
				settings: {
					apiKey: "",
					model: "sonnet",
					maxTokens: null,
					jolliApiKey: "sk-jol-anything",
					claudeEnabled: true,
					codexEnabled: true,
					geminiEnabled: true,
					excludePatterns: "",
				},
			});
			await flushPromises();

			expect(mockSaveConfigScoped).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalledWith(
				"SettingsPanel",
				expect.stringContaining("Invalid Jolli API Key"),
			);
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					command: "settingsError",
					message: "Invalid Jolli API Key",
				}),
			);
		});
	});
});
