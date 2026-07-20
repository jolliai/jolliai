import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// All the real modules buildTuiDeps wires together — mocked so we assert the
// wiring (which fn each method delegates to, with cwd pre-bound) without I/O.
const h = vi.hoisted(() => ({
	getJolliUrl: vi.fn(() => "https://acme.jolli.ai"),
	loadAuthToken: vi.fn(async () => "tok"),
	browserLogin: vi.fn(async () => {}),
	VERSION: "9.9.9",
	runSpaceSyncStep: vi.fn(async () => {}),
	getCurrentBranch: vi.fn(async () => "main"),
	getProjectRootDir: vi.fn(async () => "/repo/widgets"),
	validateJolliApiKey: vi.fn(),
	readIngestPhase: vi.fn(async () => ({ busy: false, phase: null })),
	getMemoryDetail: vi.fn(async () => null),
	listCommittedMemories: vi.fn(async () => []),
	getQueueStatus: vi.fn(async () => ({ active: 0 })),
	searchHits: vi.fn(async () => []),
	getGlobalConfigDir: vi.fn(() => "/global"),
	loadConfig: vi.fn(async () => ({})),
	saveConfigScoped: vi.fn(async () => {}),
	track: vi.fn(),
	listTopicPageSlugs: vi.fn(async () => []),
	triggerPendingPushRetry: vi.fn(async () => {}),
	disableHost: vi.fn(async () => {}),
	enableHost: vi.fn(async () => {}),
	getStatus: vi.fn(async () => ({})),
	install: vi.fn(async () => {}),
	uninstall: vi.fn(async () => {}),
	installSkill: vi.fn(async () => {}),
	readInstalledSkills: vi.fn(async () => []),
	removeSkill: vi.fn(async () => {}),
	getTopicDetail: vi.fn(async () => ({
		slug: "s",
		title: "T",
		content: "",
		relatedBranches: [],
		lastUpdatedAt: "",
		timeline: [],
	})),
	inspectPlugins: vi.fn(async () => []),
	getLastSyncAt: vi.fn(async () => null),
	getCanonicalRepoUrl: vi.fn(async () => "https://github.com/acme/widgets"),
	loadSpaceBindingCache: vi.fn(async () => null as null | { spaceName: string; canPush: boolean | null }),
	tenantOriginForKey: vi.fn((): string | null => "https://acme.jolli.ai"),
	runNpmCommand: vi.fn(async (): Promise<string | null> => "ok"),
	spawnHidden: vi.fn(),
	applySetting: vi.fn(async () => {}),
	// Cold-start back-fill wiring.
	listMissingCommits: vi.fn(async (): Promise<Array<{ commitHash: string; subject: string }>> => []),
	repoHasAnyMemory: vi.fn(async () => true),
	runBackfill: vi.fn(
		async (_opts?: {
			onCommitStart?: (index: number, total: number, hash: string, subject?: string) => void;
		}): Promise<{ total: number; generated: number; skipped: number; errors: number; outcomes: never[] }> => ({
			total: 0,
			generated: 0,
			skipped: 0,
			errors: 0,
			outcomes: [],
		}),
	),
	readRepoProfile: vi.fn(async (): Promise<{ backfillDismissed?: boolean }> => ({})),
	updateRepoProfile: vi.fn(async () => {}),
	resolveLlmCredentialSource: vi.fn((): string | null => "anthropic-config"),
}));

vi.mock("../../auth/AuthConfig.js", () => ({ getJolliUrl: h.getJolliUrl, loadAuthToken: h.loadAuthToken }));
vi.mock("../../auth/Login.js", () => ({ browserLogin: h.browserLogin }));
vi.mock("../../backfill/BackfillEngine.js", () => ({
	listMissingCommits: h.listMissingCommits,
	repoHasAnyMemory: h.repoHasAnyMemory,
	runBackfill: h.runBackfill,
}));
vi.mock("../../core/RepoProfile.js", () => ({
	readRepoProfile: h.readRepoProfile,
	updateRepoProfile: h.updateRepoProfile,
}));
vi.mock("../../core/LlmClient.js", () => ({ resolveLlmCredentialSource: h.resolveLlmCredentialSource }));
vi.mock("../../commands/CliUtils.js", () => ({ VERSION: h.VERSION }));
vi.mock("../../commands/SpaceSyncStep.js", () => ({ runSpaceSyncStep: h.runSpaceSyncStep }));
vi.mock("../../core/GitOps.js", () => ({
	getCurrentBranch: h.getCurrentBranch,
	getProjectRootDir: h.getProjectRootDir,
}));
vi.mock("../../core/GitRemoteUtils.js", () => ({ getCanonicalRepoUrl: h.getCanonicalRepoUrl }));
vi.mock("../../core/SpaceBindingCache.js", () => ({
	loadSpaceBindingCache: h.loadSpaceBindingCache,
	tenantOriginForKey: h.tenantOriginForKey,
}));
vi.mock("../../core/JolliApiUtils.js", () => ({ validateJolliApiKey: h.validateJolliApiKey }));
vi.mock("../../core/LiveStatus.js", () => ({ readIngestPhase: h.readIngestPhase }));
vi.mock("../../core/MemoryBankModel.js", () => ({
	getMemoryDetail: h.getMemoryDetail,
	listCommittedMemories: h.listCommittedMemories,
}));
vi.mock("../../core/QueueStatus.js", () => ({ getQueueStatus: h.getQueueStatus }));
vi.mock("../../core/SearchHits.js", () => ({ searchHits: h.searchHits }));
vi.mock("../../core/SessionTracker.js", () => ({
	getGlobalConfigDir: h.getGlobalConfigDir,
	loadConfig: h.loadConfig,
	saveConfigScoped: h.saveConfigScoped,
}));
vi.mock("../../core/Telemetry.js", () => ({ track: h.track }));
vi.mock("../../core/TopicPageStore.js", () => ({ listTopicPageSlugs: h.listTopicPageSlugs }));
vi.mock("../../hooks/PushCompensation.js", () => ({ triggerPendingPushRetry: h.triggerPendingPushRetry }));
vi.mock("../../install/HostToggle.js", () => ({ disableHost: h.disableHost, enableHost: h.enableHost }));
vi.mock("../../install/Installer.js", () => ({ getStatus: h.getStatus, install: h.install, uninstall: h.uninstall }));
vi.mock("../../install/SkillInstaller.js", () => ({
	installSkill: h.installSkill,
	readInstalledSkills: h.readInstalledSkills,
	removeSkill: h.removeSkill,
}));
vi.mock("../../mcp/McpTools.js", () => ({ getTopicDetail: h.getTopicDetail }));
vi.mock("../../PluginLoader.js", () => ({ inspectPlugins: h.inspectPlugins }));
vi.mock("../../sync/SyncStateStore.js", () => ({ getLastSyncAt: h.getLastSyncAt }));
vi.mock("../../util/Subprocess.js", () => ({ runNpmCommand: h.runNpmCommand, spawnHidden: h.spawnHidden }));
vi.mock("./SettingsWrite.js", () => ({ applySetting: h.applySetting }));

import { buildTuiDeps } from "./TuiDeps.js";

const CWD = "/repo/widgets";
const deps = buildTuiDeps(CWD);

beforeEach(() => {
	vi.clearAllMocks();
	h.getProjectRootDir.mockResolvedValue("/repo/widgets");
	h.getCurrentBranch.mockResolvedValue("main");
	h.getJolliUrl.mockReturnValue("https://acme.jolli.ai");
	h.getGlobalConfigDir.mockReturnValue("/global");
	h.runNpmCommand.mockResolvedValue("ok");
});

describe("buildTuiDeps — read delegation (cwd pre-bound)", () => {
	it("derives identity from repo root basename + current branch", async () => {
		expect(await deps.getIdentity()).toEqual({ repo: "widgets", branch: "main" });
	});

	it("delegates the simple reads to their modules with cwd", async () => {
		await deps.getStatus();
		await deps.getQueueStatus();
		await deps.getIngestPhase();
		await deps.getLastSyncAt();
		await deps.getMemoryDetail("abc");
		await deps.searchMemories("q");
		await deps.listTopics();
		await deps.getTopicDetail("slug");
		await deps.inspectPlugins();
		await deps.getInstalledSkills();
		await deps.loadConfig();
		await deps.loadAuthToken();
		expect(h.getStatus).toHaveBeenCalledWith(CWD);
		expect(h.getQueueStatus).toHaveBeenCalledWith(CWD);
		expect(h.readIngestPhase).toHaveBeenCalledWith(CWD);
		expect(h.getMemoryDetail).toHaveBeenCalledWith(CWD, "abc");
		expect(h.searchHits).toHaveBeenCalledWith(CWD, { query: "q" });
		expect(h.listTopicPageSlugs).toHaveBeenCalledWith(CWD);
		expect(h.getTopicDetail).toHaveBeenCalledWith(CWD, "slug");
		expect(h.inspectPlugins).toHaveBeenCalledWith(h.VERSION);
		expect(h.readInstalledSkills).toHaveBeenCalledWith(CWD);
	});

	it("lists memories for the current branch", async () => {
		await deps.listMemories();
		expect(h.listCommittedMemories).toHaveBeenCalledWith(CWD, { branch: "main" });
	});
});

describe("buildTuiDeps — getSpaceBinding (cache-first, best-effort)", () => {
	it("returns null when there is no Jolli API key (nothing to resolve an origin from)", async () => {
		h.loadConfig.mockResolvedValueOnce({});
		expect(await deps.getSpaceBinding()).toBeNull();
		expect(h.loadSpaceBindingCache).not.toHaveBeenCalled();
	});

	it("returns null when the key carries no resolvable tenant origin", async () => {
		h.loadConfig.mockResolvedValueOnce({ jolliApiKey: "sk-jol-x" });
		h.tenantOriginForKey.mockReturnValueOnce(null);
		expect(await deps.getSpaceBinding()).toBeNull();
		expect(h.loadSpaceBindingCache).not.toHaveBeenCalled();
	});

	it("maps a cached entry to the Home Sync row shape", async () => {
		h.loadConfig.mockResolvedValueOnce({ jolliApiKey: "sk-jol-x" });
		h.tenantOriginForKey.mockReturnValueOnce("https://acme.jolli.ai");
		h.loadSpaceBindingCache.mockResolvedValueOnce({ spaceName: "Acme Core", canPush: true });
		expect(await deps.getSpaceBinding()).toEqual({ spaceName: "Acme Core", canPush: true });
		expect(h.loadSpaceBindingCache).toHaveBeenCalledWith(CWD, {
			repoUrl: "https://github.com/acme/widgets",
			origin: "https://acme.jolli.ai",
		});
	});

	it("returns null when the repo is not bound (no cache entry) despite a valid key + origin", async () => {
		h.loadConfig.mockResolvedValueOnce({ jolliApiKey: "sk-jol-x" });
		h.tenantOriginForKey.mockReturnValueOnce("https://acme.jolli.ai");
		h.loadSpaceBindingCache.mockResolvedValueOnce(null);
		expect(await deps.getSpaceBinding()).toBeNull();
	});

	it("swallows a lookup failure and returns null (never blocks the Home row)", async () => {
		h.loadConfig.mockResolvedValueOnce({ jolliApiKey: "sk-jol-x" });
		h.getCanonicalRepoUrl.mockRejectedValueOnce(new Error("not a git repo"));
		expect(await deps.getSpaceBinding()).toBeNull();
	});
});

describe("buildTuiDeps — write / action wiring", () => {
	it("enable installs hooks and records telemetry; disable uninstalls", async () => {
		await deps.setEnabled(true);
		expect(h.install).toHaveBeenCalledWith(CWD, { source: "cli" });
		expect(h.track).toHaveBeenCalledWith("surface_enabled", { trigger: "cli" });
		expect(h.uninstall).not.toHaveBeenCalled();

		await deps.setEnabled(false);
		expect(h.uninstall).toHaveBeenCalledWith(CWD);
	});

	it("validates then persists a Jolli API key AND pins the provider to jolli", async () => {
		await deps.saveJolliApiKey("sk-jol-x");
		expect(h.validateJolliApiKey).toHaveBeenCalledWith("sk-jol-x");
		// aiProvider must flip to "jolli" too, or onboarding stays stuck (the key
		// alone is ignored when a prior explicit provider is set).
		expect(h.saveConfigScoped).toHaveBeenCalledWith({ jolliApiKey: "sk-jol-x", aiProvider: "jolli" }, "/global");
	});

	it("persists an Anthropic key and pins the provider", async () => {
		await deps.saveAnthropicKey("sk-ant-x");
		expect(h.saveConfigScoped).toHaveBeenCalledWith({ apiKey: "sk-ant-x", aiProvider: "anthropic" }, "/global");
	});

	it("switches the AI provider", async () => {
		await deps.setAiProvider("jolli");
		expect(h.saveConfigScoped).toHaveBeenCalledWith({ aiProvider: "jolli" }, "/global");
	});

	it("signs in via the browser against the resolved Jolli URL", async () => {
		const report = vi.fn();
		await deps.signInWithBrowser(report);
		expect(h.browserLogin).toHaveBeenCalledWith("https://acme.jolli.ai", { report });
	});

	it("runs cloud sync non-interactively then fires the pending-push retry", async () => {
		const report = vi.fn();
		await deps.runCloudSync(report);
		expect(h.runSpaceSyncStep).toHaveBeenCalledWith(CWD, { nonInteractive: true, report });
		expect(h.triggerPendingPushRetry).toHaveBeenCalledWith(CWD, "cli-tui");
	});

	it("toggles a host on / off", async () => {
		await deps.enableHost("codex");
		await deps.disableHost("codex");
		expect(h.enableHost).toHaveBeenCalledWith(CWD, "codex");
		expect(h.disableHost).toHaveBeenCalledWith(CWD, "codex");
	});

	it("applies a setting through the settings side-effect map", async () => {
		await deps.applySetting("model", "opus");
		expect(h.applySetting).toHaveBeenCalledWith("model", "opus");
	});

	it("installs/removes a skill across BOTH targets", async () => {
		await deps.setSkillInstalled("jolli-pr", true);
		expect(h.installSkill).toHaveBeenCalledWith(CWD, "jolli-pr", "claude-code");
		expect(h.installSkill).toHaveBeenCalledWith(CWD, "jolli-pr", "agents-std");

		await deps.setSkillInstalled("jolli-pr", false);
		expect(h.removeSkill).toHaveBeenCalledWith(CWD, "jolli-pr", "claude-code");
		expect(h.removeSkill).toHaveBeenCalledWith(CWD, "jolli-pr", "agents-std");
	});

	it("does not re-create .claude/skills on install while Claude is disabled", async () => {
		h.loadConfig.mockResolvedValueOnce({ claudeEnabled: false });
		await deps.setSkillInstalled("jolli-pr", true);
		expect(h.installSkill).toHaveBeenCalledWith(CWD, "jolli-pr", "agents-std");
		expect(h.installSkill).not.toHaveBeenCalledWith(CWD, "jolli-pr", "claude-code");
	});

	it("still clears BOTH targets on remove even when Claude is disabled", async () => {
		h.loadConfig.mockResolvedValueOnce({ claudeEnabled: false });
		await deps.setSkillInstalled("jolli-pr", false);
		expect(h.removeSkill).toHaveBeenCalledWith(CWD, "jolli-pr", "claude-code");
		expect(h.removeSkill).toHaveBeenCalledWith(CWD, "jolli-pr", "agents-std");
	});

	it("installs a plugin globally, and throws when npm fails", async () => {
		await deps.installPlugin("@jolli.ai/site-cli");
		expect(h.runNpmCommand).toHaveBeenCalledWith(["install", "-g", "@jolli.ai/site-cli"], { timeout: 180_000 });

		h.runNpmCommand.mockResolvedValueOnce(null); // null = failure
		await expect(deps.installPlugin("@jolli.ai/bad")).rejects.toThrow(/failed/);
	});
});

describe("buildTuiDeps — runCommand (captured child process)", () => {
	function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		return child;
	}

	it("captures combined stdout+stderr and resolves the exit code", async () => {
		const child = fakeChild();
		h.spawnHidden.mockReturnValue(child);
		const p = deps.runCommand(["doctor"]);
		child.stdout.emit("data", Buffer.from("out "));
		child.stderr.emit("data", Buffer.from("err"));
		child.emit("close", 0);
		expect(await p).toEqual({ output: "out err", exitCode: 0 });
		// Spawned against the TUI's cwd with color stripped so Ink layout stays intact.
		const opts = h.spawnHidden.mock.calls[0][2];
		expect(opts.cwd).toBe(CWD);
		expect(opts.env.NO_COLOR).toBe("1");
	});

	it("resolves exitCode 1 on a spawn error", async () => {
		const child = fakeChild();
		h.spawnHidden.mockReturnValue(child);
		const p = deps.runCommand(["doctor"]);
		child.emit("error", new Error("ENOENT"));
		expect(await p).toEqual({ output: "ENOENT", exitCode: 1 });
	});

	it("maps a null exit code to 0", async () => {
		const child = fakeChild();
		h.spawnHidden.mockReturnValue(child);
		const p = deps.runCommand(["doctor"]);
		child.emit("close", null as unknown as number);
		expect(await p).toEqual({ output: "", exitCode: 0 });
	});

	it("bounds captured output to the trailing 256 KiB so a runaway child can't grow it unbounded", async () => {
		const child = fakeChild();
		h.spawnHidden.mockReturnValue(child);
		const p = deps.runCommand(["doctor"]);
		// Stream well past the cap in several chunks, then a unique tail marker.
		for (let i = 0; i < 4; i++) {
			child.stdout.emit("data", Buffer.from("x".repeat(200 * 1024)));
		}
		child.stdout.emit("data", Buffer.from("TAIL"));
		child.emit("close", 0);
		const { output } = await p;
		expect(output.length).toBe(256 * 1024);
		expect(output.endsWith("TAIL")).toBe(true);
	});

	it("decodes multi-byte UTF-8 sequences split across chunk boundaries", async () => {
		const child = fakeChild();
		h.spawnHidden.mockReturnValue(child);
		const p = deps.runCommand(["doctor"]);
		// "é" is 0xC3 0xA9 — split it across two data events; a naive per-chunk
		// toString() would emit two replacement chars instead of one "é".
		const bytes = Buffer.from("é", "utf8");
		child.stdout.emit("data", bytes.subarray(0, 1));
		child.stdout.emit("data", bytes.subarray(1));
		child.emit("close", 0);
		expect((await p).output).toBe("é");
	});
});

describe("buildTuiDeps — cold-start back-fill", () => {
	it("getBackfillOffer returns null when there is no LLM credential", async () => {
		h.resolveLlmCredentialSource.mockReturnValueOnce(null);
		expect(await deps.getBackfillOffer()).toBeNull();
	});

	it("getBackfillOffer returns null when the repo dismissed the offer", async () => {
		h.readRepoProfile.mockResolvedValueOnce({ backfillDismissed: true });
		expect(await deps.getBackfillOffer()).toBeNull();
	});

	it("getBackfillOffer returns null when there are no gaps", async () => {
		h.listMissingCommits.mockResolvedValueOnce([]);
		expect(await deps.getBackfillOffer()).toBeNull();
	});

	it("getBackfillOffer maps missing commits (capped=false under the cap)", async () => {
		h.listMissingCommits.mockResolvedValueOnce([
			{ commitHash: "a1", subject: "x" },
			{ commitHash: "b2", subject: "y" },
		]);
		h.repoHasAnyMemory.mockResolvedValueOnce(true);
		expect(await deps.getBackfillOffer()).toEqual({
			hasMemory: true,
			commits: [
				{ hash: "a1", subject: "x" },
				{ hash: "b2", subject: "y" },
			],
			capped: false,
		});
	});

	it("getBackfillOffer flags capped when the list hits COLD_START_CAP", async () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ commitHash: `h${i}`, subject: `s${i}` }));
		h.listMissingCommits.mockResolvedValueOnce(many);
		h.repoHasAnyMemory.mockResolvedValueOnce(false);
		const offer = await deps.getBackfillOffer();
		expect(offer?.capped).toBe(true);
		expect(offer?.hasMemory).toBe(false);
		expect(offer?.commits).toHaveLength(10);
	});

	it("getBackfillOffer swallows detection errors and returns null", async () => {
		h.listMissingCommits.mockRejectedValueOnce(new Error("git boom"));
		expect(await deps.getBackfillOffer()).toBeNull();
	});

	it("dismissBackfill writes the sticky per-repo opt-out", async () => {
		await deps.dismissBackfill();
		expect(h.updateRepoProfile).toHaveBeenCalledWith(CWD, { backfillDismissed: true });
	});

	it("runColdStartBackfill runs the engine, maps the report, and forwards progress", async () => {
		const onProgress = vi.fn();
		h.runBackfill.mockImplementationOnce(async (opts) => {
			opts?.onCommitStart?.(1, 2, "abcdef1", "Fix parser");
			return { total: 2, generated: 2, skipped: 0, errors: 1, outcomes: [] };
		});
		const res = await deps.runColdStartBackfill(["a1", "b2"], onProgress);
		expect(h.runBackfill).toHaveBeenCalledWith(expect.objectContaining({ cwd: CWD, hashes: ["a1", "b2"] }));
		expect(res).toEqual({ generated: 2, errors: 1 });
		expect(onProgress).toHaveBeenCalledWith("building 1/2 · Fix parser");
	});
});
