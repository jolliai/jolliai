import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigFromDir, getGlobalConfigDir, parseJolliApiKey } = vi.hoisted(
	() => ({
		loadConfigFromDir: vi.fn(),
		getGlobalConfigDir: vi.fn(() => "/home/user/.jolli/jollimemory"),
		parseJolliApiKey: vi.fn(),
	}),
);

const { executeCommand, TreeItem, ThemeIcon, ThemeColor, EventEmitter } =
	vi.hoisted(() => {
		const executeCommand = vi.fn().mockResolvedValue(undefined);
		class TreeItem {
			label: string;
			collapsibleState: number;
			description?: string;
			iconPath?: unknown;
			contextValue?: string;
			tooltip?: unknown;
			command?: unknown;
			constructor(label: string, collapsibleState: number) {
				this.label = label;
				this.collapsibleState = collapsibleState;
			}
		}
		class ThemeIcon {
			readonly id: string;
			readonly color?: unknown;
			constructor(id: string, color?: unknown) {
				this.id = id;
				this.color = color;
			}
		}
		class ThemeColor {
			readonly id: string;
			constructor(id: string) {
				this.id = id;
			}
		}
		class EventEmitter {
			event = vi.fn();
			fire = vi.fn();
			dispose = vi.fn();
		}
		return { executeCommand, TreeItem, ThemeIcon, ThemeColor, EventEmitter };
	});

vi.mock("vscode", () => ({
	TreeItem,
	TreeItemCollapsibleState: { None: 0 },
	ThemeIcon,
	ThemeColor,
	EventEmitter,
	commands: {
		executeCommand,
	},
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadConfigFromDir,
	getGlobalConfigDir,
}));

vi.mock("../services/JolliPushService.js", () => ({
	parseJolliApiKey,
}));

import { StatusStore } from "../stores/StatusStore.js";
import { StatusTreeProvider } from "./StatusTreeProvider.js";

/**
 * Test facade: real StatusStore + StatusTreeProvider with the legacy shim
 * surface (refresh / setWorkerBusy / setMigrating / etc.) forwarded to the
 * store.  The provider itself no longer carries these methods.
 */
function makeStatusProvider(bridge: unknown, authService?: unknown) {
	const store = new StatusStore(bridge as never, authService as never);
	const provider = new StatusTreeProvider(store);
	return {
		__store: store,
		getTreeItem: provider.getTreeItem.bind(provider),
		getChildren: provider.getChildren.bind(provider),
		onDidChangeTreeData: provider.onDidChangeTreeData,
		dispose: () => provider.dispose(),
		refresh: () => store.refresh(),
		setMigrating: (m: boolean) => store.setMigrating(m),
		setWorkerBusy: (busy: boolean) => store.setWorkerBusy(busy),
		setExtensionOutdated: (outdated: boolean) =>
			store.setExtensionOutdated(outdated),
		setStatus: (status: Parameters<typeof store.setStatus>[0]) =>
			store.setStatus(status),
		/** @deprecated no-op, kept for back-compat with legacy test. */
		setHistoryProvider: () => {},
	};
}

function makeStatus(overrides: Record<string, unknown> = {}) {
	return {
		enabled: true,
		claudeHookInstalled: true,
		gitHookInstalled: true,
		geminiHookInstalled: false,
		activeSessions: 2,
		mostRecentSession: null,
		summaryCount: 5,
		orphanBranch: "jollimemory",
		claudeDetected: true,
		codexDetected: true,
		codexEnabled: true,
		geminiDetected: true,
		geminiEnabled: false,
		...overrides,
	};
}

describe("StatusTreeProvider", () => {
	beforeEach(() => {
		executeCommand.mockClear();
		loadConfigFromDir.mockReset();
		parseJolliApiKey.mockReset();
	});

	it("renders loading, migrating, and disabled states", () => {
		const provider = makeStatusProvider({
			cwd: "/repo",
			getStatus: vi.fn(),
		} as never);

		expect(provider.getChildren().map((item) => item.label)).toEqual([
			"Loading...",
		]);

		provider.setMigrating(true);
		expect(provider.getChildren().map((item) => item.label)).toEqual([
			"Migrating memories...",
		]);

		provider.setMigrating(false);
		provider.setStatus(makeStatus({ enabled: false }) as never);
		expect(provider.getChildren()).toEqual([]);

		// Enabled → shows full status immediately
		provider.setStatus(makeStatus() as never);
		expect(provider.getChildren().length).toBeGreaterThan(0);
	});

	it("setHistoryProvider is a no-op (deprecated)", () => {
		const provider = makeStatusProvider({
			cwd: "/repo",
			getStatus: vi.fn(),
		} as never);

		// Should not throw — the method is a deprecated no-op kept for compatibility
		expect(() => provider.setHistoryProvider()).not.toThrow();
	});

	it("refreshes full status, loads config, and adds optional warning rows", async () => {
		const bridge = { cwd: "/repo", getStatus: vi.fn(async () => makeStatus()) };
		loadConfigFromDir.mockResolvedValue({
			apiKey: undefined,
			jolliApiKey: "jolli-key",
		});
		parseJolliApiKey.mockReturnValue({
			u: "https://acme.jolli.app",
			t: "acme",
		});

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		expect(bridge.getStatus).toHaveBeenCalled();
		expect(loadConfigFromDir).toHaveBeenCalledWith(
			"/home/user/.jolli/jollimemory",
		);

		const items = provider.getChildren();
		expect(items.map((item) => item.label)).toEqual([
			"Hooks",
			"Sessions",
			"Anthropic API Key",
			"Jolli Site",
			"Claude Integration",
			"Codex Integration",
			"Gemini Integration",
		]);
		expect(items[0].description).toBe("3 Git + 2 Claude");
		// Hooks icon is OK because gitHookInstalled is true
		expect((items[0].iconPath as { id: string }).id).toBe("check");
		expect(items[2].command).toEqual({
			command: "jollimemory.openSettings",
			title: "Open Settings",
		});
		expect(items[3].description).toBe("acme.jolli.app");
	});

	it("tracks worker busy state and sign-in prompt when no Jolli credentials", async () => {
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () =>
				makeStatus({ codexEnabled: false, geminiEnabled: true }),
			),
		};
		loadConfigFromDir.mockResolvedValue({
			apiKey: "anthropic",
			jolliApiKey: undefined,
		});

		const provider = makeStatusProvider(bridge as never);

		await provider.refresh();
		provider.setWorkerBusy(true);

		const items = provider.getChildren();
		expect(items.map((item) => item.label)).toContain(
			"AI summary in progress…",
		);
		expect(
			items.find((item) => item.label === "Codex Integration")?.description,
		).toBe("detected but disabled");
		expect(
			items.find((item) => item.label === "Gemini Integration")?.description,
		).toBe("hook not installed");
		// No Jolli credentials → shows sign-in prompt (replaced former "Jolli API Key" warning)
		expect(
			items.find((item) => item.label === "Jolli Account")?.command,
		).toEqual({
			command: "jollimemory.signIn",
			title: "Sign In",
		});
	});

	it("getTreeItem returns the element directly", () => {
		const provider = makeStatusProvider({
			cwd: "/repo",
			getStatus: vi.fn(),
		} as never);
		const items = provider.getChildren();
		const item = items[0]; // "Loading..." item

		expect(provider.getTreeItem(item)).toBe(item);
	});

	it("shows X icon when gitHookInstalled is false even if Claude hooks are present", async () => {
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () =>
				makeStatus({
					claudeHookInstalled: true,
					gitHookInstalled: false,
				}),
			),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "key" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		const hooksItem = items.find((item) => item.label === "Hooks");
		expect(hooksItem?.description).toBe("2 Claude");
		// Hooks icon is X because git hooks are not installed
		expect((hooksItem?.iconPath as { id: string }).id).toBe("x");
	});

	it("shows OK icon when git hooks installed even if Gemini hooks missing", async () => {
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () =>
				makeStatus({
					gitHookInstalled: true,
					claudeHookInstalled: true,
					geminiDetected: true,
					geminiHookInstalled: false,
				}),
			),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "key" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		const hooksItem = items.find((item) => item.label === "Hooks");
		expect(hooksItem?.description).toBe("3 Git + 2 Claude");
		// Hooks icon is OK because git hooks are installed (Gemini hook status doesn't affect it)
		expect((hooksItem?.iconPath as { id: string }).id).toBe("check");
	});

	it("renders singular session tooltip and partial hook states", async () => {
		// Covers the activeSessions === 1 branch (no "s") on line 180,
		// and individual hook installed/not-installed branches on lines 175-178.
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () =>
				makeStatus({
					activeSessions: 1,
					claudeHookInstalled: false,
					gitHookInstalled: true,
				}),
			),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "key", jolliApiKey: "jk" });
		parseJolliApiKey.mockReturnValue(null);

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		const hooksItem = items.find((item) => item.label === "Hooks");
		expect(hooksItem?.description).toBe("3 Git");

		const sessionsItem = items.find((item) => item.label === "Sessions");
		expect(sessionsItem?.description).toBe("1");
	});

	it("shows Jolli Site only when parseJolliApiKey returns a URL with siteUrl", async () => {
		// Covers the siteUrl truthy branch on line 210-211
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () => makeStatus()),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "key", jolliApiKey: "jk" });
		// Return meta without u field — no Jolli Site row
		parseJolliApiKey.mockReturnValue({ t: "acme" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		expect(items.find((item) => item.label === "Jolli Site")).toBeUndefined();
	});

	it("skips config loading when disabled", async () => {
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () => makeStatus({ enabled: false })),
		};
		const provider = makeStatusProvider(bridge as never);

		await provider.refresh();

		expect(loadConfigFromDir).not.toHaveBeenCalled();
		expect(provider.getChildren()).toEqual([]);
	});

	it("includes Gemini CLI in hooks description when geminiHookInstalled is true", async () => {
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () =>
				makeStatus({
					gitHookInstalled: true,
					claudeHookInstalled: true,
					geminiHookInstalled: true,
				}),
			),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "key" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		const hooksItem = items.find((item) => item.label === "Hooks");
		expect(hooksItem?.description).toBe("3 Git + 2 Claude + 1 Gemini CLI");
	});

	it("shows 'none installed' when no hooks are installed", async () => {
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () =>
				makeStatus({
					gitHookInstalled: false,
					claudeHookInstalled: false,
					geminiHookInstalled: false,
				}),
			),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "key" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		const hooksItem = items.find((item) => item.label === "Hooks");
		expect(hooksItem?.description).toBe("none installed");
	});

	it("shows hookRuntime in Hooks tooltip when hookSource is defined", async () => {
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () =>
				makeStatus({ hookSource: "vscode-extension", hookVersion: "1.2.3" }),
			),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "key" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		// Hook runtime should appear in the Hooks tooltip, not as a separate row
		const hooksItem = items.find((item) => item.label === "Hooks");
		expect(String(hooksItem?.tooltip)).toContain("vscode-extension@1.2.3");
		expect(items.find((item) => item.label === "Managed by")).toBeUndefined();
	});

	it("omits version suffix from hookRuntime tooltip when hookVersion is 'unknown'", async () => {
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () =>
				makeStatus({ hookSource: "cli", hookVersion: "unknown" }),
			),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "key" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		const hooksItem = items.find((item) => item.label === "Hooks");
		expect(String(hooksItem?.tooltip)).toContain("Hook runtime: cli");
		expect(String(hooksItem?.tooltip)).not.toContain("cli@");
	});

	it("shows 'Update Available' item when extensionOutdated is true", async () => {
		const bridge = { cwd: "/repo", getStatus: vi.fn(async () => makeStatus()) };
		loadConfigFromDir.mockResolvedValue({ apiKey: "key" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		// setExtensionOutdated fires a tree change
		provider.setExtensionOutdated(true);
		const items = provider.getChildren();
		const updateItem = items.find((item) => item.label === "Update Available");
		expect(updateItem).toBeDefined();
		expect(updateItem?.description).toBe("a newer version is available");
	});

	// ── Auth-aware status rows ────────────────────────────────────────────

	it("shows Jolli Account connected when authToken is present", async () => {
		const bridge = { cwd: "/repo", getStatus: vi.fn(async () => makeStatus()) };
		loadConfigFromDir.mockResolvedValue({
			apiKey: "key",
			authToken: "some-auth-token",
			jolliApiKey: "sk-jol-test",
		});
		parseJolliApiKey.mockReturnValue({
			u: "https://acme.jolli.app",
			t: "acme",
		});

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		const accountItem = items.find((item) => item.label === "Jolli Account");
		expect(accountItem).toBeDefined();
		expect(accountItem?.description).toBe("connected");
		expect((accountItem?.iconPath as { id: string }).id).toBe("check");

		// Also shows Jolli Site when key has metadata
		const siteItem = items.find((item) => item.label === "Jolli Site");
		expect(siteItem).toBeDefined();
		expect(siteItem?.description).toBe("acme.jolli.app");
	});

	it("warns about missing Jolli API Key when authToken is present but jolliApiKey is not", async () => {
		// Partial-auth state: /api/auth/cli-token returned a session token but no
		// jolli_api_key. The panel should still show Jolli Account as connected
		// (sign-in succeeded) AND surface a clickable warning so the user isn't
		// silently left with a broken push setup.
		const bridge = { cwd: "/repo", getStatus: vi.fn(async () => makeStatus()) };
		loadConfigFromDir.mockResolvedValue({
			apiKey: "key",
			authToken: "some-auth-token",
		});

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		const accountItem = items.find((item) => item.label === "Jolli Account");
		expect(accountItem?.description).toBe("connected");

		const keyItem = items.find((item) => item.label === "Jolli API Key");
		expect(keyItem).toBeDefined();
		expect(keyItem?.description).toBe("not issued — pushes disabled");
		expect((keyItem?.iconPath as { id: string }).id).toBe("warning");
		expect(keyItem?.command).toEqual({
			command: "jollimemory.openSettings",
			title: "Open Settings",
		});

		// No Jolli Site row when the API key is absent.
		expect(items.find((item) => item.label === "Jolli Site")).toBeUndefined();
	});

	it("shows Jolli Account sign-in prompt when no credentials", async () => {
		const bridge = { cwd: "/repo", getStatus: vi.fn(async () => makeStatus()) };
		loadConfigFromDir.mockResolvedValue({ apiKey: "key" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		const accountItem = items.find((item) => item.label === "Jolli Account");
		expect(accountItem).toBeDefined();
		expect(accountItem?.description).toBe("not connected — click to sign in");
		expect((accountItem?.iconPath as { id: string }).id).toBe("warning");
		expect(accountItem?.command).toEqual({
			command: "jollimemory.signIn",
			title: "Sign In",
		});
	});

	it("calls authService.refreshContextKey when config is loaded", async () => {
		const mockAuthService = { refreshContextKey: vi.fn() };
		const bridge = { cwd: "/repo", getStatus: vi.fn(async () => makeStatus()) };
		loadConfigFromDir.mockResolvedValue({ apiKey: "key", authToken: "token" });

		const provider = makeStatusProvider(
			bridge as never,
			mockAuthService as never,
		);
		await provider.refresh();

		expect(mockAuthService.refreshContextKey).toHaveBeenCalledWith({
			apiKey: "key",
			authToken: "token",
		});
	});

	it("does not call authService.refreshContextKey when disabled", async () => {
		const mockAuthService = { refreshContextKey: vi.fn() };
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () => makeStatus({ enabled: false })),
		};

		const provider = makeStatusProvider(
			bridge as never,
			mockAuthService as never,
		);
		await provider.refresh();

		expect(mockAuthService.refreshContextKey).not.toHaveBeenCalled();
	});

	it("skips integration row when claudeDetected is false", async () => {
		const bridge = {
			cwd: "/repo",
			getStatus: vi.fn(async () =>
				makeStatus({
					claudeDetected: false,
					codexDetected: false,
					geminiDetected: false,
				}),
			),
		};
		loadConfigFromDir.mockResolvedValue({ apiKey: "key" });

		const provider = makeStatusProvider(bridge as never);
		await provider.refresh();

		const items = provider.getChildren();
		expect(
			items.find((item) => item.label === "Claude Integration"),
		).toBeUndefined();
		expect(
			items.find((item) => item.label === "Codex Integration"),
		).toBeUndefined();
		expect(
			items.find((item) => item.label === "Gemini Integration"),
		).toBeUndefined();
	});
});
