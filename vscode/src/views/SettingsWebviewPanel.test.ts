import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { info, error: logError } = vi.hoisted(() => ({
	info: vi.fn(),
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

vi.mock("vscode", () => ({
	window: {
		createWebviewPanel,
		showOpenDialog: mockShowOpenDialog,
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
} = vi.hoisted(() => ({
	mockInstallClaudeHook: vi.fn().mockResolvedValue({}),
	mockRemoveClaudeHook: vi.fn().mockResolvedValue({}),
	mockInstallGeminiHook: vi.fn().mockResolvedValue({}),
	mockRemoveGeminiHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../cli/src/install/Installer.js", () => ({
	installClaudeHook: mockInstallClaudeHook,
	removeClaudeHook: mockRemoveClaudeHook,
	installGeminiHook: mockInstallGeminiHook,
	removeGeminiHook: mockRemoveGeminiHook,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, error: logError },
}));

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
				"Failed to sync Claude hook for %s: %s",
				"/workspace",
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
				"Failed to sync Claude hook for %s: %s",
				"/workspace",
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
				"Failed to sync Gemini hook for %s: %s",
				"/workspace",
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
				"Failed to sync Gemini hook for %s: %s",
				"/workspace",
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
	// pushAction was removed in 2026-04 along with the "Default Push Action"
	// fieldset; these tests track the surviving localFolder behavior.

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

		it("does not include pushAction in the saved config (field removed)", async () => {
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
					localFolder: "/some/path",
					excludePatterns: "",
				},
			});
			await flushPromises();

			const savedArg = mockSaveConfigScoped.mock.calls.at(-1)?.[0] as
				| Record<string, unknown>
				| undefined;
			expect(savedArg).toBeDefined();
			expect(savedArg).not.toHaveProperty("pushAction");
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

		it("does not include pushAction in the loaded payload (field removed)", async () => {
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

			const settingsLoadedCall = postMessage.mock.calls.find(
				(c: unknown[]) =>
					(c[0] as { command?: string }).command === "settingsLoaded",
			);
			expect(settingsLoadedCall).toBeDefined();
			const settings = (
				settingsLoadedCall?.[0] as { settings: Record<string, unknown> }
			).settings;
			expect(settings).not.toHaveProperty("pushAction");
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
});
