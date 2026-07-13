import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	loadAuthToken: vi.fn(),
	loadConfig: vi.fn(),
	orphanBranchExists: vi.fn(),
	getSummaryCount: vi.fn(),
	track: vi.fn(),
	triggerPendingPushRetry: vi.fn(),
	isGitHookInstalled: vi.fn(),
	install: vi.fn(),
	promptText: vi.fn(),
	resolveProjectDir: vi.fn(),
	promptSetup: vi.fn(),
	runSpaceSyncStep: vi.fn(),
	createStorage: vi.fn(),
	setActiveStorage: vi.fn(),
}));

vi.mock("../auth/AuthConfig.js", () => ({ loadAuthToken: h.loadAuthToken }));
vi.mock("../core/SessionTracker.js", () => ({ loadConfig: h.loadConfig }));
vi.mock("../core/GitOps.js", () => ({ orphanBranchExists: h.orphanBranchExists }));
vi.mock("../core/StorageFactory.js", () => ({ createStorage: h.createStorage }));
vi.mock("../core/SummaryStore.js", () => ({
	getSummaryCount: h.getSummaryCount,
	setActiveStorage: h.setActiveStorage,
}));
vi.mock("../core/Telemetry.js", () => ({ track: h.track }));
vi.mock("../hooks/PushCompensation.js", () => ({ triggerPendingPushRetry: h.triggerPendingPushRetry }));
vi.mock("../install/GitHookInstaller.js", () => ({ isGitHookInstalled: h.isGitHookInstalled }));
vi.mock("../install/Installer.js", () => ({ install: h.install }));
vi.mock("./EnableCommand.js", () => ({ promptSetup: h.promptSetup }));
vi.mock("./SpaceSyncStep.js", () => ({ runSpaceSyncStep: h.runSpaceSyncStep }));
vi.mock("./CliUtils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./CliUtils.js")>();
	return { ...actual, promptText: h.promptText, resolveProjectDir: h.resolveProjectDir };
});

import { getGuidedFrontDoorStatus, runGuidedFrontDoor } from "./GuidedFrontDoor.js";

const PRIOR_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

describe("GuidedFrontDoor", () => {
	let logs: string[];
	let errors: string[];
	let warns: string[];

	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = undefined;
		// The host env may set ANTHROPIC_API_KEY, which would count as a credential
		// and skip the sign-in guide. Remove it so "no credential" cases are honest.
		delete process.env.ANTHROPIC_API_KEY;

		logs = [];
		errors = [];
		warns = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			errors.push(a.map(String).join(" "));
		});
		vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
			warns.push(a.map(String).join(" "));
		});

		// Defaults: signed in via OAuth, enabled, no memories yet.
		h.resolveProjectDir.mockReturnValue("/repo");
		h.createStorage.mockResolvedValue({});
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliUrl: "https://acme.jolli.ai", jolliApiKey: "sk-jol-default" });
		h.isGitHookInstalled.mockResolvedValue(true);
		h.orphanBranchExists.mockResolvedValue(true);
		h.getSummaryCount.mockResolvedValue(0);
		h.install.mockResolvedValue({ success: true, warnings: [] });
		h.promptText.mockResolvedValue("");
		h.triggerPendingPushRetry.mockResolvedValue(undefined);
		h.runSpaceSyncStep.mockResolvedValue(undefined);
		h.promptSetup.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	afterAll(() => {
		if (PRIOR_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = PRIOR_ANTHROPIC;
	});

	const out = (): string => logs.join("\n");

	it("returning user (signed in + enabled): status line + delegates, no install", async () => {
		h.getSummaryCount.mockResolvedValue(3);
		await runGuidedFrontDoor();

		expect(h.install).not.toHaveBeenCalled();
		expect(h.triggerPendingPushRetry).toHaveBeenCalledWith("/repo");
		expect(h.runSpaceSyncStep).toHaveBeenCalledWith("/repo");
		expect(out()).toContain("signed in · acme.jolli.ai");
		expect(out()).toContain("3 memories");
		expect(out()).toContain("last memory saved");
	});

	it("no credential → runs promptSetup", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({});
		await runGuidedFrontDoor();
		expect(h.promptSetup).toHaveBeenCalledTimes(1);
	});

	it("still no credential after promptSetup → no success/listening line", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({});
		await runGuidedFrontDoor();
		expect(out()).toContain("not signed in");
		expect(out()).not.toContain("Jolli is listening");
	});

	it("manual jolliApiKey (no OAuth) → shows 'configured', not 'signed in'", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		await runGuidedFrontDoor();
		expect(h.promptSetup).not.toHaveBeenCalled();
		expect(out()).toContain("configured (not signed in via OAuth)");
		expect(out()).not.toContain("signed in ·");
		expect(out()).toContain("Jolli is listening");
	});

	it("ANTHROPIC_API_KEY env counts as a credential", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({});
		process.env.ANTHROPIC_API_KEY = "sk-ant-x";
		try {
			await runGuidedFrontDoor();
			expect(h.promptSetup).not.toHaveBeenCalled();
			expect(out()).toContain("configured (not signed in via OAuth)");
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it("not enabled + [Y/n]=y → install + track + push retry + delegate", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("y");
		h.getSummaryCount.mockResolvedValue(5);
		await runGuidedFrontDoor();

		expect(h.install).toHaveBeenCalledWith("/repo", { source: "cli" });
		expect(h.track).toHaveBeenCalledWith("surface_enabled", { trigger: "cli" });
		expect(h.triggerPendingPushRetry).toHaveBeenCalledWith("/repo");
		expect(h.runSpaceSyncStep).toHaveBeenCalledWith("/repo");
		expect(out()).toContain("5 memories");
		expect(out()).toContain("signed in");
		expect(out()).toContain("Restart your AI agent session");
	});

	it("not enabled + [Y/n]=n → no install, early return", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("n");
		await runGuidedFrontDoor();

		expect(h.install).not.toHaveBeenCalled();
		expect(h.runSpaceSyncStep).not.toHaveBeenCalled();
		expect(out()).toContain("Not enabled");
	});

	it("install failure → error + exitCode 1 + no track + no delegate", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("y");
		h.install.mockResolvedValue({ success: false, message: "boom", warnings: ["w1"] });
		await runGuidedFrontDoor();

		expect(errors.join("\n")).toContain("boom");
		expect(warns.join("\n")).toContain("w1");
		expect(h.track).not.toHaveBeenCalled();
		expect(h.runSpaceSyncStep).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("install success with warnings → warnings printed", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("y");
		h.install.mockResolvedValue({ success: true, warnings: ["heads up"] });
		await runGuidedFrontDoor();
		expect(warns.join("\n")).toContain("heads up");
	});

	it("first-run copy when summaryCount is 0", async () => {
		h.getSummaryCount.mockResolvedValue(0);
		await runGuidedFrontDoor();
		expect(out()).toContain("your next commit is your first memory");
	});

	it("singular 'memory' when summaryCount is 1", async () => {
		h.getSummaryCount.mockResolvedValue(1);
		await runGuidedFrontDoor();
		expect(out()).toContain("1 memory");
		expect(out()).not.toContain("1 memories");
	});

	it("invalid jolliUrl → plain 'signed in' without a host", async () => {
		h.loadConfig.mockResolvedValue({ jolliUrl: "not a url" });
		await runGuidedFrontDoor();
		expect(out()).toContain("signed in");
		expect(out()).not.toContain("signed in ·");
	});

	it("missing jolliUrl → plain 'signed in'", async () => {
		h.loadConfig.mockResolvedValue({});
		await runGuidedFrontDoor();
		expect(out()).not.toContain("signed in ·");
	});

	it("promptSetup turns no-credential into signed in + listening, and pushes backlog", async () => {
		// Enabled returning repo, but the user has no credential until they sign in
		// now. The enable branch is skipped, yet backlog catch-up must still fire.
		h.loadAuthToken.mockResolvedValueOnce(undefined).mockResolvedValueOnce("new-token");
		h.loadConfig.mockResolvedValueOnce({}).mockResolvedValueOnce({ jolliApiKey: "sk-jol-new" });
		await runGuidedFrontDoor();

		expect(h.promptSetup).toHaveBeenCalledTimes(1);
		expect(out()).toContain("signed in");
		expect(out()).toContain("Jolli is listening");
		expect(h.triggerPendingPushRetry).toHaveBeenCalledWith("/repo");
	});

	it("config.apiKey alone counts as a credential", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x" });
		await runGuidedFrontDoor();
		expect(h.promptSetup).not.toHaveBeenCalled();
		expect(out()).toContain("configured (not signed in via OAuth)");
		expect(out()).toContain("Jolli is listening");
	});

	it("not enabled + empty answer (Enter) defaults to Yes → installs", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("");
		await runGuidedFrontDoor();
		expect(h.install).toHaveBeenCalledWith("/repo", { source: "cli" });
	});

	it("signed in via OAuth but no LLM credential → no 'listening', prompts to configure a key", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliUrl: "https://acme.jolli.ai" }); // no jolliApiKey / apiKey
		await runGuidedFrontDoor();
		expect(out()).toContain("signed in");
		expect(out()).not.toContain("Jolli is listening");
		expect(out()).toContain("Configure an API key");
	});

	describe("getGuidedFrontDoorStatus", () => {
		it("no orphan branch → summaryCount 0, does not call getSummaryCount", async () => {
			h.isGitHookInstalled.mockResolvedValue(true);
			h.orphanBranchExists.mockResolvedValue(false);
			const status = await getGuidedFrontDoorStatus("/repo");
			expect(status).toEqual({ enabled: true, summaryCount: 0 });
			expect(h.getSummaryCount).not.toHaveBeenCalled();
		});

		it("orphan branch exists → counts summaries", async () => {
			h.isGitHookInstalled.mockResolvedValue(false);
			h.orphanBranchExists.mockResolvedValue(true);
			h.getSummaryCount.mockResolvedValue(7);
			const status = await getGuidedFrontDoorStatus("/repo");
			expect(status).toEqual({ enabled: false, summaryCount: 7 });
		});
	});
});
