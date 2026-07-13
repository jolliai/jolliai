import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	loadAuthToken: vi.fn(),
	loadConfig: vi.fn(),
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
	saveConfigScoped: vi.fn(),
	getGlobalConfigDir: vi.fn(),
}));

vi.mock("../auth/AuthConfig.js", () => ({ loadAuthToken: h.loadAuthToken }));
vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: h.loadConfig,
	saveConfigScoped: h.saveConfigScoped,
	getGlobalConfigDir: h.getGlobalConfigDir,
}));
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
		h.getGlobalConfigDir.mockReturnValue("/global/config");
		h.saveConfigScoped.mockResolvedValue(undefined);
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliUrl: "https://acme.jolli.ai", jolliApiKey: "sk-jol-default" });
		h.isGitHookInstalled.mockResolvedValue(true);
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
		expect(out()).toContain("Jolli API key set (not signed in to Jolli)");
		expect(out()).not.toContain("signed in ·");
		expect(out()).toContain("Jolli is listening");
		// Has a jolliApiKey (can already sync) → must NOT nudge sign-in.
		expect(out()).not.toContain("sync memories to a Space");
	});

	it("ANTHROPIC_API_KEY env counts as a credential", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({});
		process.env.ANTHROPIC_API_KEY = "sk-ant-x";
		try {
			await runGuidedFrontDoor();
			expect(h.promptSetup).not.toHaveBeenCalled();
			expect(out()).toContain("Anthropic API key set (not signed in to Jolli)");
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

	it("just enabled a fresh repo (no memories yet) → 0 memories", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("y");
		h.getSummaryCount.mockResolvedValue(0); // fresh repo, empty index
		await runGuidedFrontDoor();
		expect(h.install).toHaveBeenCalled();
		expect(h.getSummaryCount).toHaveBeenCalled();
		expect(out()).toContain("0 memories");
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

	it("config.apiKey alone (no Jolli credential) → generates locally + nudges sign-in", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x" });
		await runGuidedFrontDoor();
		expect(h.promptSetup).not.toHaveBeenCalled();
		expect(out()).toContain("Anthropic API key set (not signed in to Jolli)");
		expect(out()).toContain("Jolli is listening");
		// Pure-Anthropic user with no Jolli credential — soft nudge to sign in.
		expect(out()).toContain("sync memories to a Space");
	});

	it("not enabled + empty answer (Enter) defaults to Yes → installs", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("");
		await runGuidedFrontDoor();
		expect(h.install).toHaveBeenCalledWith("/repo", { source: "cli" });
	});

	it("signed in but no usable key → offers a fix, no false 'listening'", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliUrl: "https://acme.jolli.ai" }); // no key at all
		h.promptText.mockResolvedValue(""); // menu default → enter key → empty → skip
		await runGuidedFrontDoor();
		expect(out()).toContain("signed in");
		expect(out()).not.toContain("Jolli is listening");
		expect(out()).toContain("no usable key");
	});

	it("choose 'switch to Jolli' → saves aiProvider jolli; listening reflects existing memory count", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", aiProvider: "anthropic" });
		h.getSummaryCount.mockResolvedValue(163); // returning repo with history
		h.promptText.mockResolvedValue("2");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).toHaveBeenCalledWith({ aiProvider: "jolli" }, "/global/config");
		expect(out()).toContain("switched to Jolli");
		// Must NOT claim "first memory" when the repo already has memories.
		expect(out()).toContain("last memory saved");
		expect(out()).not.toContain("first memory");
	});

	it("choose 'enter Anthropic key' → saves apiKey + provider anthropic; listening reflects memory count", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", aiProvider: "anthropic" });
		h.getSummaryCount.mockResolvedValue(163);
		h.promptText.mockResolvedValueOnce("1").mockResolvedValueOnce("sk-ant-new");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			{ apiKey: "sk-ant-new", aiProvider: "anthropic" },
			"/global/config",
		);
		expect(out()).toContain("Anthropic key saved");
		expect(out()).toContain("last memory saved");
		expect(out()).not.toContain("first memory");
	});

	it("provider=anthropic + jolliApiKey, press Enter at menu → defaults to entering an Anthropic key", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", aiProvider: "anthropic" });
		h.promptText.mockResolvedValueOnce("").mockResolvedValueOnce("sk-ant-y");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			{ apiKey: "sk-ant-y", aiProvider: "anthropic" },
			"/global/config",
		);
	});

	it("provider=anthropic + jolliApiKey, choose 'skip' → no config change", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", aiProvider: "anthropic" });
		h.promptText.mockResolvedValue("3");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
		expect(out()).not.toContain("Jolli is listening");
	});

	it("no jolliApiKey path: enter Anthropic key → saved", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ aiProvider: "anthropic" }); // no jolliApiKey
		h.promptText.mockResolvedValueOnce("1").mockResolvedValueOnce("sk-ant-x");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			{ apiKey: "sk-ant-x", aiProvider: "anthropic" },
			"/global/config",
		);
	});

	it("no jolliApiKey path: skip → no change", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ aiProvider: "anthropic" });
		h.promptText.mockResolvedValue("2"); // skip in the no-Jolli menu
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
	});

	it("enter Anthropic key but press Enter (empty) → skipped, no save", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ aiProvider: "anthropic" });
		h.promptText.mockResolvedValueOnce("1").mockResolvedValueOnce("");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
	});

	describe("getGuidedFrontDoorStatus", () => {
		it("counts summaries from the active storage", async () => {
			h.isGitHookInstalled.mockResolvedValue(false);
			h.getSummaryCount.mockResolvedValue(7);
			const status = await getGuidedFrontDoorStatus("/repo");
			expect(status).toEqual({ enabled: false, summaryCount: 7 });
		});

		it("folder-only repo with no orphan branch still reports its memories", async () => {
			// Regression: previously gated on orphanBranchExists, so folder-mode
			// repos (memories on disk, no orphan branch) wrongly reported 0.
			h.isGitHookInstalled.mockResolvedValue(true);
			h.getSummaryCount.mockResolvedValue(4);
			const status = await getGuidedFrontDoorStatus("/repo");
			expect(status).toEqual({ enabled: true, summaryCount: 4 });
		});

		it("empty index → 0 memories", async () => {
			h.isGitHookInstalled.mockResolvedValue(true);
			h.getSummaryCount.mockResolvedValue(0);
			const status = await getGuidedFrontDoorStatus("/repo");
			expect(status).toEqual({ enabled: true, summaryCount: 0 });
		});
	});
});
