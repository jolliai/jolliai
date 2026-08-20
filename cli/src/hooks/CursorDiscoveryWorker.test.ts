import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	discoverCursorConversations: vi.fn().mockResolvedValue(undefined),
	resolveStateRoot: vi.fn((cwd: string) => cwd),
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
	loadConfig: vi.fn().mockResolvedValue({}),
	isGitHookInstalled: vi.fn().mockResolvedValue(true),
	setLogDir: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../core/CursorDiscovery.js", () => ({
	discoverCursorConversations: mocks.discoverCursorConversations,
}));
vi.mock("../core/GitOps.js", () => ({ resolveStateRoot: mocks.resolveStateRoot }));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: mocks.readManualDisableFlag }));
vi.mock("../core/SessionTracker.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../install/GitHookInstaller.js", () => ({ isGitHookInstalled: mocks.isGitHookInstalled }));
vi.mock("../Logger.js", () => ({
	createLogger: () => ({ info: mocks.info, debug: mocks.debug, error: mocks.error }),
	setLogDir: mocks.setLogDir,
}));

const { runCursorDiscoveryWorker } = await import("./CursorDiscoveryWorker.js");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveStateRoot.mockImplementation((cwd: string) => cwd);
	mocks.readManualDisableFlag.mockResolvedValue(false);
	mocks.loadConfig.mockResolvedValue({});
	mocks.isGitHookInstalled.mockResolvedValue(true);
	mocks.discoverCursorConversations.mockResolvedValue(undefined);
});

describe("runCursorDiscoveryWorker", () => {
	it("anchors to the worktree and runs one discovery pass", async () => {
		mocks.resolveStateRoot.mockReturnValue("/repo");
		await runCursorDiscoveryWorker("/repo/packages/web");

		expect(mocks.setLogDir).toHaveBeenCalledWith("/repo");
		expect(mocks.isGitHookInstalled).toHaveBeenCalledWith("/repo");
		expect(mocks.readManualDisableFlag).toHaveBeenCalledWith("/repo");
		expect(mocks.discoverCursorConversations).toHaveBeenCalledWith("/repo");
	});

	it("rechecks repository opt-in after the detached child starts", async () => {
		mocks.isGitHookInstalled.mockResolvedValue(false);
		await runCursorDiscoveryWorker("/repo");

		expect(mocks.readManualDisableFlag).not.toHaveBeenCalled();
		expect(mocks.discoverCursorConversations).not.toHaveBeenCalled();
	});

	it("rechecks manual disablement after the detached child starts", async () => {
		mocks.readManualDisableFlag.mockResolvedValue(true);
		await runCursorDiscoveryWorker("/repo");

		expect(mocks.loadConfig).not.toHaveBeenCalled();
		expect(mocks.discoverCursorConversations).not.toHaveBeenCalled();
	});

	it("rechecks the Cursor integration toggle after the detached child starts", async () => {
		mocks.loadConfig.mockResolvedValue({ cursorEnabled: false });
		await runCursorDiscoveryWorker("/repo");

		expect(mocks.discoverCursorConversations).not.toHaveBeenCalled();
	});
});
