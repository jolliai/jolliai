import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	loadAuthToken: vi.fn(),
	getJolliUrl: vi.fn(),
	browserLogin: vi.fn(),
	validateJolliApiKey: vi.fn(),
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
	runBackfillFrontDoorStep: vi.fn(),
	createStorage: vi.fn(),
	setActiveStorage: vi.fn(),
	saveConfigScoped: vi.fn(),
	getGlobalConfigDir: vi.fn(),
	loadUserProfile: vi.fn(),
	saveUserProfile: vi.fn(),
	isInsideGitWorkTree: vi.fn(),
	isClaudeCodeUsable: vi.fn(),
}));

vi.mock("../auth/AuthConfig.js", () => ({ loadAuthToken: h.loadAuthToken, getJolliUrl: h.getJolliUrl }));
vi.mock("../auth/Login.js", () => ({ browserLogin: h.browserLogin }));
vi.mock("../core/JolliApiUtils.js", () => ({ validateJolliApiKey: h.validateJolliApiKey }));
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
vi.mock("../core/UserProfile.js", () => ({
	loadUserProfile: h.loadUserProfile,
	saveUserProfile: h.saveUserProfile,
}));
vi.mock("../hooks/PushCompensation.js", () => ({ triggerPendingPushRetry: h.triggerPendingPushRetry }));
vi.mock("../install/GitHookInstaller.js", () => ({ isGitHookInstalled: h.isGitHookInstalled }));
vi.mock("../install/Installer.js", () => ({ install: h.install }));
vi.mock("./EnableCommand.js", () => ({ promptSetup: h.promptSetup }));
vi.mock("./SpaceSyncStep.js", () => ({ runSpaceSyncStep: h.runSpaceSyncStep }));
vi.mock("./BackfillFrontDoorStep.js", () => ({ runBackfillFrontDoorStep: h.runBackfillFrontDoorStep }));
vi.mock("./CliUtils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./CliUtils.js")>();
	return {
		...actual,
		promptText: h.promptText,
		resolveProjectDir: h.resolveProjectDir,
		isInsideGitWorkTree: h.isInsideGitWorkTree,
	};
});
vi.mock("../core/localagent/ClaudeExecutableResolver.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/localagent/ClaudeExecutableResolver.js")>();
	return { ...actual, isClaudeCodeUsable: h.isClaudeCodeUsable };
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

		// Defaults: signed in via OAuth, enabled, no memories yet, no prior decline.
		h.resolveProjectDir.mockReturnValue("/repo");
		h.createStorage.mockResolvedValue({});
		h.getGlobalConfigDir.mockReturnValue("/global/config");
		h.saveConfigScoped.mockResolvedValue(undefined);
		h.getJolliUrl.mockReturnValue("https://acme.jolli.ai");
		h.browserLogin.mockResolvedValue(undefined);
		h.validateJolliApiKey.mockReturnValue(undefined);
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliUrl: "https://acme.jolli.ai", jolliApiKey: "sk-jol-default" });
		h.isGitHookInstalled.mockResolvedValue(true);
		h.getSummaryCount.mockResolvedValue(0);
		h.install.mockResolvedValue({ success: true, warnings: [] });
		h.promptText.mockResolvedValue("");
		h.triggerPendingPushRetry.mockResolvedValue(undefined);
		h.runSpaceSyncStep.mockResolvedValue(undefined);
		h.runBackfillFrontDoorStep.mockResolvedValue(undefined);
		h.promptSetup.mockResolvedValue(undefined);
		h.loadUserProfile.mockResolvedValue({});
		h.saveUserProfile.mockResolvedValue(undefined);
		h.isInsideGitWorkTree.mockReturnValue(true);
		h.isClaudeCodeUsable.mockReturnValue(true);
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

	// ── Steady state / status line ──

	it("returning user (signed in + enabled): status line + delegates, no install", async () => {
		h.getSummaryCount.mockResolvedValue(3);
		await runGuidedFrontDoor();

		expect(h.install).not.toHaveBeenCalled();
		expect(h.triggerPendingPushRetry).toHaveBeenCalledWith("/repo", "cli-front-door");
		expect(h.runSpaceSyncStep).toHaveBeenCalledWith("/repo");
		expect(h.runBackfillFrontDoorStep).toHaveBeenCalledWith("/repo");
		expect(out()).toContain("signed in · acme.jolli.ai");
		expect(out()).toContain("3 memories");
		expect(out()).toContain("last memory saved");
	});

	it("offers cold-start back-fill then re-reads the count so 'listening' reflects new memories", async () => {
		// Status line reads 0 memories; the back-fill step builds some; the re-read
		// after it returns 2, so the listening line no longer says "first memory".
		h.getSummaryCount.mockResolvedValueOnce(0).mockResolvedValue(2);
		await runGuidedFrontDoor();
		expect(h.runBackfillFrontDoorStep).toHaveBeenCalledWith("/repo");
		expect(out()).toContain("last memory saved");
		expect(out()).not.toContain("first memory");
	});

	it("binds the Space before retrying pending pushes", async () => {
		let completeSpaceSync!: () => void;
		h.runSpaceSyncStep.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					completeSpaceSync = resolve;
				}),
		);

		const frontDoor = runGuidedFrontDoor();
		await vi.waitFor(() => expect(h.runSpaceSyncStep).toHaveBeenCalledWith("/repo"));
		expect(h.triggerPendingPushRetry).not.toHaveBeenCalled();

		completeSpaceSync();
		await frontDoor;

		expect(h.triggerPendingPushRetry).toHaveBeenCalledWith("/repo", "cli-front-door");
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
		h.loadConfig.mockResolvedValue({ jolliUrl: "not a url", jolliApiKey: "sk-jol-x" });
		await runGuidedFrontDoor();
		expect(out()).toContain("signed in");
		expect(out()).not.toContain("signed in ·");
	});

	it("missing jolliUrl → plain 'signed in'", async () => {
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		await runGuidedFrontDoor();
		expect(out()).not.toContain("signed in ·");
	});

	it("manual jolliApiKey (no OAuth) → 'Jolli API key set', can already sync so no nudge", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x" });
		await runGuidedFrontDoor();
		expect(h.promptSetup).not.toHaveBeenCalled();
		expect(out()).toContain("Jolli API key set (not signed in to Jolli)");
		expect(out()).not.toContain("signed in ·");
		expect(out()).toContain("Jolli is listening");
		expect(h.browserLogin).not.toHaveBeenCalled();
		expect(h.promptText).not.toHaveBeenCalledWith(expect.stringContaining("Sign in to Jolli to sync"));
	});

	it("ANTHROPIC_API_KEY env counts as a credential (status line names Anthropic)", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({});
		h.loadUserProfile.mockResolvedValue({ signInPromptDeclined: true }); // suppress the nudge
		process.env.ANTHROPIC_API_KEY = "sk-ant-x";
		try {
			await runGuidedFrontDoor();
			expect(h.promptSetup).not.toHaveBeenCalled();
			expect(out()).toContain("Anthropic API key set (not signed in to Jolli)");
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	it("provider=local-agent with no key/token means no promptSetup, 'local agent set', still listening", async () => {
		// Local Agent is a self-sufficient generation path (its own login), so the
		// front door must not nag a local-agent user to sign in or enter a key.
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ aiProvider: "local-agent" });
		h.loadUserProfile.mockResolvedValue({ signInPromptDeclined: true }); // suppress the sync nudge
		await runGuidedFrontDoor();
		expect(h.promptSetup).not.toHaveBeenCalled();
		expect(out()).toContain("local agent set (not signed in to Jolli)");
		expect(out()).toContain("Jolli is listening");
	});

	it("both keys, not signed in, provider=anthropic → Anthropic label, no nudge", async () => {
		// The status-line label follows credSource (the key that would actually be
		// used), so it names Anthropic even though a jolliApiKey is also present;
		// and canSync is true via that jolliApiKey, so no sign-in nudge fires.
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x", jolliApiKey: "sk-jol-x", aiProvider: "anthropic" });
		await runGuidedFrontDoor();
		expect(out()).toContain("Anthropic API key set (not signed in to Jolli)");
		expect(h.promptText).not.toHaveBeenCalledWith(expect.stringContaining("Sign in to Jolli to sync"));
		expect(h.browserLogin).not.toHaveBeenCalled();
		expect(out()).toContain("Jolli is listening");
	});

	// ── Enable axis ──

	it("not enabled + [Y/n]=y → install + track + push retry + delegate", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("y");
		h.getSummaryCount.mockResolvedValue(5);
		await runGuidedFrontDoor();

		expect(h.install).toHaveBeenCalledWith("/repo", { source: "cli", clearManualDisableOnSuccess: true });
		expect(h.track).toHaveBeenCalledWith("surface_enabled", { trigger: "cli" });
		expect(h.triggerPendingPushRetry).toHaveBeenCalledWith("/repo", "cli-front-door");
		expect(h.runSpaceSyncStep).toHaveBeenCalledWith("/repo");
		expect(out()).toContain("5 memories");
		expect(out()).toContain("signed in");
		expect(out()).toContain("Restart your AI agent session");
		// Concise install confirmation (repo basename of the mocked "/repo").
		expect(out()).toContain("Git hooks added");
		expect(out()).toContain("Agent hooks + MCP server added");
		expect(out()).toContain("Jolli Memory enabled in repo");
	});

	it("front-door enable that FAILS does not clear the manual-disable opt-out", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("y");
		h.install.mockResolvedValue({ success: false, message: "boom", warnings: [] });
		await runGuidedFrontDoor();
		expect(h.install).toHaveBeenCalledWith("/repo", { source: "cli", clearManualDisableOnSuccess: true });
	});

	it("just enabled a fresh repo (no memories yet) → 0 memories", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("y");
		h.getSummaryCount.mockResolvedValue(0);
		await runGuidedFrontDoor();
		expect(h.install).toHaveBeenCalled();
		expect(out()).toContain("0 memories");
	});

	it("not enabled + empty answer (Enter) defaults to Yes → installs", async () => {
		h.isGitHookInstalled.mockResolvedValue(false);
		h.promptText.mockResolvedValue("");
		await runGuidedFrontDoor();
		expect(h.install).toHaveBeenCalledWith("/repo", { source: "cli", clearManualDisableOnSuccess: true });
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

	// ── Fresh onboarding (promptSetup) ──

	it("no credential → runs promptSetup", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({});
		await runGuidedFrontDoor();
		expect(h.promptSetup).toHaveBeenCalledTimes(1);
	});

	it("skipped setup (still nothing) → 'not signed in', no listening, no re-ask", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({});
		await runGuidedFrontDoor();
		expect(out()).toContain("not signed in");
		expect(out()).not.toContain("Jolli is listening");
		// Fresh user with nothing must not be re-prompted by the repair rung.
		expect(out()).not.toContain("no Anthropic key is available");
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
	});

	it("promptSetup turns no-credential into signed in + listening, and pushes backlog", async () => {
		h.loadAuthToken.mockResolvedValueOnce(undefined).mockResolvedValueOnce("new-token");
		h.loadConfig.mockResolvedValueOnce({}).mockResolvedValueOnce({ jolliApiKey: "sk-jol-new" });
		await runGuidedFrontDoor();

		expect(h.promptSetup).toHaveBeenCalledTimes(1);
		expect(out()).toContain("signed in");
		expect(out()).toContain("Jolli is listening");
		expect(h.triggerPendingPushRetry).toHaveBeenCalledWith("/repo", "cli-front-door");
	});

	// ── Rung 2: optional sign-in nudge (local key, cannot sync) ──

	it("local Anthropic key, Enter (default Yes) → browser login, sync confirmation, listening", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x" });
		h.getSummaryCount.mockResolvedValue(2);
		h.promptText.mockResolvedValue(""); // Enter → default Yes
		await runGuidedFrontDoor();

		expect(out()).toContain("Anthropic API key set (not signed in to Jolli)");
		expect(h.promptText).toHaveBeenCalledWith(
			expect.stringContaining("Sign in to Jolli to sync memories to a Space"),
		);
		expect(h.browserLogin).toHaveBeenCalledWith("https://acme.jolli.ai");
		expect(out()).toContain("memories will sync to your Space");
		expect(h.saveUserProfile).not.toHaveBeenCalled();
		expect(out()).toContain("last memory saved");
	});

	it("local Anthropic key, answer 'n' → records the decline, no login, still listening", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x" });
		h.promptText.mockResolvedValue("n");
		await runGuidedFrontDoor();

		expect(h.browserLogin).not.toHaveBeenCalled();
		expect(h.saveUserProfile).toHaveBeenCalledWith({ signInPromptDeclined: true });
		expect(out()).toContain("You can sign in anytime");
		expect(out()).toContain("Jolli is listening");
	});

	it("local Anthropic key, login fails → error, no decline recorded, still listening", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x" });
		h.promptText.mockResolvedValue(""); // Enter → Yes → browserLogin
		h.browserLogin.mockRejectedValue(new Error("network down"));
		await runGuidedFrontDoor();

		expect(errors.join("\n")).toContain("network down");
		expect(out()).toContain("try again with");
		expect(h.saveUserProfile).not.toHaveBeenCalled();
		expect(out()).toContain("Jolli is listening");
	});

	it("local Anthropic key, decline but persisting the flag fails → swallowed, front door still finishes", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x" });
		h.promptText.mockResolvedValue("n");
		h.saveUserProfile.mockRejectedValue(new Error("EACCES: read-only home"));
		await runGuidedFrontDoor();

		expect(h.saveUserProfile).toHaveBeenCalledWith({ signInPromptDeclined: true });
		expect(out()).toContain("You can sign in anytime");
		expect(out()).toContain("Jolli is listening");
	});

	it("local Anthropic key, login rejects with a non-Error value → still reported", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x" });
		h.promptText.mockResolvedValue("");
		h.browserLogin.mockRejectedValue("odd failure");
		await runGuidedFrontDoor();

		expect(errors.join("\n")).toContain("odd failure");
		expect(out()).toContain("try again with");
	});

	it("local Anthropic key but sign-in previously declined → nudge suppressed", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x" });
		h.loadUserProfile.mockResolvedValue({ signInPromptDeclined: true });
		await runGuidedFrontDoor();

		expect(h.promptText).not.toHaveBeenCalledWith(expect.stringContaining("Sign in to Jolli to sync"));
		expect(h.browserLogin).not.toHaveBeenCalled();
		expect(h.saveUserProfile).not.toHaveBeenCalled();
		expect(out()).toContain("Jolli is listening");
	});

	// ── Rung 1: provider/key mismatch repair ──

	it("signed in but no usable key → repair menu, no false 'listening' when skipped", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliUrl: "https://acme.jolli.ai" }); // no key at all
		h.promptText.mockResolvedValue(""); // menu default → enter key → empty → skip
		await runGuidedFrontDoor();
		expect(out()).toContain("signed in");
		expect(out()).toContain("no Anthropic key is available");
		expect(out()).not.toContain("Jolli is listening");
		// Not generatable (fix declined) → the back-fill offer is skipped this run.
		expect(h.runBackfillFrontDoorStep).not.toHaveBeenCalled();
	});

	it("provider=anthropic + jolliApiKey, choose 'switch to Jolli' → saves aiProvider, listening reflects count", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		// First read is the pre-switch config (anthropic, no anthropic key → can't
		// generate → repair). The reload after the switch reflects the persisted
		// aiProvider=jolli, so the recomputed canGenerate becomes true (jolli-proxy).
		h.loadConfig
			.mockResolvedValueOnce({
				jolliApiKey: "sk-jol-x",
				aiProvider: "anthropic",
				jolliUrl: "https://acme.jolli.ai",
			})
			.mockResolvedValue({ jolliApiKey: "sk-jol-x", aiProvider: "jolli", jolliUrl: "https://acme.jolli.ai" });
		h.getSummaryCount.mockResolvedValue(163);
		h.promptText.mockResolvedValue("1");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).toHaveBeenCalledWith({ aiProvider: "jolli" }, "/global/config");
		expect(out()).toContain("switched to Jolli");
		expect(out()).toContain("last memory saved");
		expect(out()).not.toContain("first memory");
	});

	it("provider=anthropic + jolliApiKey, Enter at menu → defaults to 'switch to Jolli'", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", aiProvider: "anthropic" });
		h.promptText.mockResolvedValue(""); // Enter → default [1] = switch
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).toHaveBeenCalledWith({ aiProvider: "jolli" }, "/global/config");
	});

	it("provider=anthropic + jolliApiKey, choose 'enter Anthropic key' → saves apiKey + provider", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", aiProvider: "anthropic" });
		h.promptText.mockResolvedValueOnce("2").mockResolvedValueOnce("sk-ant-new");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			{ apiKey: "sk-ant-new", aiProvider: "anthropic" },
			"/global/config",
		);
		expect(out()).toContain("Anthropic key saved");
	});

	it("provider=anthropic + jolliApiKey, choose 'skip' → no config change, no listening", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-x", aiProvider: "anthropic" });
		h.promptText.mockResolvedValue("3");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
		expect(out()).not.toContain("Jolli is listening");
	});

	it("provider=anthropic, no other key: enter Anthropic key → saved", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ aiProvider: "anthropic", jolliUrl: "https://acme.jolli.ai" });
		h.promptText.mockResolvedValueOnce("1").mockResolvedValueOnce("sk-ant-x");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			{ apiKey: "sk-ant-x", aiProvider: "anthropic" },
			"/global/config",
		);
	});

	it("provider=anthropic, no other key: skip → no change", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ aiProvider: "anthropic", jolliUrl: "https://acme.jolli.ai" });
		h.promptText.mockResolvedValue("2"); // skip in the 2-option menu
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
	});

	it("enter Anthropic key but press Enter (empty) → skipped, no save", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ aiProvider: "anthropic", jolliUrl: "https://acme.jolli.ai" });
		h.promptText.mockResolvedValueOnce("1").mockResolvedValueOnce("");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
	});

	it("provider=jolli, only an Anthropic key → 'switch to Anthropic', then offers sign-in", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		// Second load reflects the just-written aiProvider switch (rung 1 reloads config).
		h.loadConfig
			.mockResolvedValueOnce({ apiKey: "sk-ant-x", aiProvider: "jolli" })
			.mockResolvedValueOnce({ apiKey: "sk-ant-x", aiProvider: "anthropic" });
		h.getSummaryCount.mockResolvedValue(3);
		h.promptText.mockResolvedValueOnce("1").mockResolvedValueOnce("n"); // switch, then decline login
		await runGuidedFrontDoor();
		expect(out()).toContain("no Jolli key is available");
		expect(h.saveConfigScoped).toHaveBeenCalledWith({ aiProvider: "anthropic" }, "/global/config");
		expect(out()).toContain("switched to Anthropic");
		expect(h.saveUserProfile).toHaveBeenCalledWith({ signInPromptDeclined: true });
		expect(out()).toContain("last memory saved");
	});

	it("provider=jolli, only an Anthropic key, choose 'enter a Jolli key' → validated + saved", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig
			.mockResolvedValueOnce({ apiKey: "sk-ant-x", aiProvider: "jolli" })
			.mockResolvedValueOnce({ apiKey: "sk-ant-x", jolliApiKey: "sk-jol-new", aiProvider: "jolli" });
		h.promptText.mockResolvedValueOnce("2").mockResolvedValueOnce("sk-jol-new");
		await runGuidedFrontDoor();
		expect(h.validateJolliApiKey).toHaveBeenCalledWith("sk-jol-new");
		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			{ jolliApiKey: "sk-jol-new", aiProvider: "jolli" },
			"/global/config",
		);
		expect(out()).toContain("Jolli key saved");
		// jolliApiKey now present → can sync → no sign-in nudge.
		expect(h.browserLogin).not.toHaveBeenCalled();
	});

	it("enter a Jolli key that fails validation → error, no save, no listening", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x", aiProvider: "jolli" });
		h.promptText.mockResolvedValueOnce("2").mockResolvedValueOnce("bad-key");
		h.validateJolliApiKey.mockImplementation(() => {
			throw new Error("invalid key");
		});
		await runGuidedFrontDoor();
		expect(errors.join("\n")).toContain("invalid key");
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
		expect(out()).not.toContain("Jolli is listening");
	});

	it("enter a Jolli key but press Enter (empty) → skipped, no save", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ apiKey: "sk-ant-x", aiProvider: "jolli" });
		h.promptText.mockResolvedValueOnce("2").mockResolvedValueOnce("");
		await runGuidedFrontDoor();
		expect(h.validateJolliApiKey).not.toHaveBeenCalled();
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
	});

	// ── Repo gate (not a git working tree) ──

	it("not a git repo → dead end, exitCode 1, no storage / onboarding", async () => {
		h.isInsideGitWorkTree.mockReturnValue(false);
		await runGuidedFrontDoor();
		expect(out()).toContain("not a git repository");
		expect(out()).toContain("Change into a repo");
		expect(process.exitCode).toBe(1);
		expect(h.createStorage).not.toHaveBeenCalled();
		expect(h.setActiveStorage).not.toHaveBeenCalled();
		expect(h.promptSetup).not.toHaveBeenCalled();
		// The dead-end keeps its own header but must NOT print the positive
		// repo-confirmation line reserved for the happy path.
		expect(out()).toContain("Jolli guided setup");
		expect(out()).not.toContain("✓ Git repository");
	});

	it("inside a git repo → prints the guided-setup header + repo confirmation", async () => {
		await runGuidedFrontDoor();
		expect(out()).toContain("Jolli guided setup");
		expect(out()).toContain("✓ Git repository /repo");
	});

	// ── M1: signed in + local agent → engine suffix on the status line ──

	it("signed in with local-agent provider → status line names the engine", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliUrl: "https://acme.jolli.ai", aiProvider: "local-agent" });
		h.getSummaryCount.mockResolvedValue(9);
		await runGuidedFrontDoor();
		expect(out()).toContain("signed in · acme.jolli.ai · summaries via Claude Code");
		expect(out()).toContain("Jolli is listening");
	});

	// ── R3: local-agent configured but `claude` not usable ──

	it("R3: local agent broken + skip → repair menu, no false listening", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ aiProvider: "local-agent" });
		h.isClaudeCodeUsable.mockReturnValue(false);
		h.promptText.mockResolvedValue("4"); // skip
		await runGuidedFrontDoor();
		expect(out()).toContain("no usable `claude` was found");
		expect(out()).toContain("Skipped");
		expect(out()).not.toContain("Jolli is listening");
		expect(h.runBackfillFrontDoorStep).not.toHaveBeenCalled();
	});

	it("R3: retry succeeds (claude now usable) → generation restored, listening", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliUrl: "https://acme.jolli.ai", aiProvider: "local-agent" });
		h.getSummaryCount.mockResolvedValue(1);
		h.isClaudeCodeUsable.mockReturnValueOnce(false).mockReturnValue(true);
		h.promptText.mockResolvedValue("1"); // retry
		await runGuidedFrontDoor();
		expect(out()).toContain("Claude Code is working now");
		expect(out()).toContain("Jolli is listening");
	});

	it("R3: retry still broken → stops, no listening", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ aiProvider: "local-agent" });
		h.isClaudeCodeUsable.mockReturnValue(false);
		h.promptText.mockResolvedValue("1"); // retry, still broken
		await runGuidedFrontDoor();
		expect(out()).toContain("Still no usable `claude`");
		expect(out()).not.toContain("Jolli is listening");
	});

	it("R3: switch to Jolli → browser login + provider set to jolli", async () => {
		h.loadAuthToken.mockResolvedValueOnce(undefined).mockResolvedValue("new-token");
		h.loadConfig
			.mockResolvedValueOnce({ aiProvider: "local-agent" })
			.mockResolvedValue({ aiProvider: "jolli", jolliApiKey: "sk-jol-new", jolliUrl: "https://acme.jolli.ai" });
		h.isClaudeCodeUsable.mockReturnValue(false);
		h.promptText.mockResolvedValue("2"); // switch to Jolli
		await runGuidedFrontDoor();
		expect(h.browserLogin).toHaveBeenCalledWith("https://acme.jolli.ai");
		expect(h.saveConfigScoped).toHaveBeenCalledWith({ aiProvider: "jolli" }, "/global/config");
		expect(out()).toContain("switched to Jolli");
	});

	it("R3: switch to Jolli but login fails → no provider change, no listening", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ aiProvider: "local-agent" });
		h.isClaudeCodeUsable.mockReturnValue(false);
		h.promptText.mockResolvedValue("2");
		h.browserLogin.mockRejectedValue(new Error("network down"));
		await runGuidedFrontDoor();
		expect(errors.join("\n")).toContain("network down");
		expect(h.saveConfigScoped).not.toHaveBeenCalled();
		expect(out()).not.toContain("Jolli is listening");
	});

	it("R3: enter an Anthropic key → saved with provider anthropic", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ jolliUrl: "https://acme.jolli.ai", aiProvider: "local-agent" });
		h.isClaudeCodeUsable.mockReturnValue(false);
		h.promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("sk-ant-new");
		await runGuidedFrontDoor();
		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			{ apiKey: "sk-ant-new", aiProvider: "anthropic" },
			"/global/config",
		);
		expect(out()).toContain("Anthropic key saved");
	});

	it("R3: Enter at the repair menu defaults to Retry", async () => {
		h.loadAuthToken.mockResolvedValue("oauth-token");
		h.loadConfig.mockResolvedValue({ aiProvider: "local-agent" });
		h.isClaudeCodeUsable.mockReturnValue(false); // broken; retry re-probes, still broken
		h.promptText.mockResolvedValue(""); // Enter → default [1] = Retry
		await runGuidedFrontDoor();
		expect(out()).toContain("Still no usable `claude`");
		expect(out()).not.toContain("Jolli is listening");
	});

	it("R3: switch to Jolli, login rejects with a non-Error value → still reported", async () => {
		h.loadAuthToken.mockResolvedValue(undefined);
		h.loadConfig.mockResolvedValue({ aiProvider: "local-agent" });
		h.isClaudeCodeUsable.mockReturnValue(false);
		h.promptText.mockResolvedValue("2"); // switch to Jolli
		h.browserLogin.mockRejectedValue("odd failure"); // non-Error rejection
		await runGuidedFrontDoor();
		expect(errors.join("\n")).toContain("odd failure");
		expect(out()).not.toContain("Jolli is listening");
	});

	// ── Next steps: only on a fresh first-run setup ──

	it("fresh onboarding that becomes usable → prints Next steps", async () => {
		h.loadAuthToken.mockResolvedValueOnce(undefined).mockResolvedValue("new-token");
		h.loadConfig.mockResolvedValueOnce({}).mockResolvedValue({ jolliApiKey: "sk-jol-new" });
		await runGuidedFrontDoor();
		expect(h.promptSetup).toHaveBeenCalledTimes(1);
		expect(out()).toContain("Next steps");
		expect(out()).toContain("jolli recall");
	});

	it("returning user (already had a credential) → no Next steps", async () => {
		h.getSummaryCount.mockResolvedValue(3);
		await runGuidedFrontDoor();
		expect(out()).not.toContain("Next steps");
	});

	describe("getGuidedFrontDoorStatus", () => {
		it("counts summaries from the active storage", async () => {
			h.isGitHookInstalled.mockResolvedValue(false);
			h.getSummaryCount.mockResolvedValue(7);
			const status = await getGuidedFrontDoorStatus("/repo");
			expect(status).toEqual({ enabled: false, summaryCount: 7 });
		});

		it("folder-only repo with no orphan branch still reports its memories", async () => {
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
