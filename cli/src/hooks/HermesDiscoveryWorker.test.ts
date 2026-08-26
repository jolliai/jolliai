import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveStateRoot: vi.fn((dir: string) => dir),
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
	loadConfig: vi.fn().mockResolvedValue({}),
	isGitHookInstalled: vi.fn().mockResolvedValue(true),
	discoverHermesConversations: vi.fn().mockResolvedValue(undefined),
	discoverHermesSkills: vi.fn().mockResolvedValue(undefined),
	setLogDir: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../core/GitOps.js", () => ({ resolveStateRoot: mocks.resolveStateRoot }));
vi.mock("../core/HermesDiscovery.js", () => ({ discoverHermesConversations: mocks.discoverHermesConversations }));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: mocks.readManualDisableFlag }));
vi.mock("../core/SessionTracker.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../core/skills/HermesSkillDiscovery.js", () => ({ discoverHermesSkills: mocks.discoverHermesSkills }));
vi.mock("../install/GitHookInstaller.js", () => ({ isGitHookInstalled: mocks.isGitHookInstalled }));
vi.mock("../Logger.js", () => ({
	createLogger: () => ({ info: mocks.info, warn: mocks.warn, error: mocks.error, debug: mocks.debug }),
	setLogDir: mocks.setLogDir,
}));

const { runHermesDiscoveryWorker } = await import("./HermesDiscoveryWorker.js");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveStateRoot.mockImplementation((dir: string) => dir);
	mocks.readManualDisableFlag.mockResolvedValue(false);
	mocks.loadConfig.mockResolvedValue({});
	mocks.isGitHookInstalled.mockResolvedValue(true);
	mocks.discoverHermesConversations.mockResolvedValue(undefined);
	mocks.discoverHermesSkills.mockResolvedValue(undefined);
});

describe("runHermesDiscoveryWorker", () => {
	it("runs both skill AND reference discovery in parallel when the repo is enabled", async () => {
		await runHermesDiscoveryWorker("/repo");
		expect(mocks.discoverHermesSkills).toHaveBeenCalledWith("/repo");
		expect(mocks.discoverHermesConversations).toHaveBeenCalledWith("/repo");
	});

	it("skips both when the repo is not set up — mid-lifetime uninstall race", async () => {
		mocks.isGitHookInstalled.mockResolvedValue(false);
		await runHermesDiscoveryWorker("/repo");
		expect(mocks.discoverHermesSkills).not.toHaveBeenCalled();
		expect(mocks.discoverHermesConversations).not.toHaveBeenCalled();
	});

	it("skips both when the repo has been manually disabled", async () => {
		mocks.readManualDisableFlag.mockResolvedValue(true);
		await runHermesDiscoveryWorker("/repo");
		expect(mocks.discoverHermesSkills).not.toHaveBeenCalled();
		expect(mocks.discoverHermesConversations).not.toHaveBeenCalled();
	});

	it("skips both when Hermes integration is off via config", async () => {
		mocks.loadConfig.mockResolvedValue({ hermesEnabled: false });
		await runHermesDiscoveryWorker("/repo");
		expect(mocks.discoverHermesSkills).not.toHaveBeenCalled();
		expect(mocks.discoverHermesConversations).not.toHaveBeenCalled();
	});

	it("one failing pass does NOT cancel the other — the two write disjoint disk targets", async () => {
		mocks.discoverHermesSkills.mockRejectedValue(new Error("skill scan broken"));
		await runHermesDiscoveryWorker("/repo");
		expect(mocks.discoverHermesConversations).toHaveBeenCalledWith("/repo");
		expect(mocks.warn).toHaveBeenCalled();
	});

	it("uses resolveStateRoot to anchor at the worktree, matching the hook's own resolve", async () => {
		mocks.resolveStateRoot.mockReturnValue("/repo");
		await runHermesDiscoveryWorker("/repo/sub/nested");
		expect(mocks.resolveStateRoot).toHaveBeenCalledWith("/repo/sub/nested");
		expect(mocks.discoverHermesSkills).toHaveBeenCalledWith("/repo");
		expect(mocks.discoverHermesConversations).toHaveBeenCalledWith("/repo");
	});
});
