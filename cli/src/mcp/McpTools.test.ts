import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/SearchIndex.js", () => ({
	SearchIndex: { openCached: vi.fn() },
}));
vi.mock("../core/ContextCompiler.js", () => ({
	compileTaskContext: vi.fn(),
	buildRecallPayload: vi.fn(),
	listBranchCatalog: vi.fn(),
	DEFAULT_TOKEN_BUDGET: 80000,
}));
vi.mock("../core/TopicPageStore.js", () => ({ readTopicPage: vi.fn() }));
vi.mock("../core/SummaryStore.js", () => ({ getActiveStorage: vi.fn() }));
vi.mock("../core/PrDescription.js", () => ({ buildPrDescription: vi.fn() }));
vi.mock("../util/Subprocess.js", () => ({ execFileSyncHidden: vi.fn() }));
vi.mock("../core/JolliMemoryPushOrchestrator.js", () => ({
	pushBranchToJolli: vi.fn(),
	resolveSpaceId: vi.fn(),
}));
vi.mock("../core/JolliMemoryPushClient.js", async () => {
	const actual = await vi.importActual<typeof import("../core/JolliMemoryPushClient.js")>(
		"../core/JolliMemoryPushClient.js",
	);
	return { ...actual, JolliMemoryPushClient: vi.fn() };
});
// Mocked so these tests never touch a real `.jolli/jollimemory/space-binding.json`.
vi.mock("../core/SpaceBindingCache.js", () => ({
	clearSpaceBindingCache: vi.fn(),
	loadSpaceBindingDisplay: vi.fn(),
}));
vi.mock("../core/GitRemoteUtils.js", () => ({
	getCanonicalRepoUrl: vi.fn(),
	deriveRepoNameFromUrl: vi.fn(),
}));
// Partial mocks: `runStatus` needs these three overridden, but the real
// `QueueStatus`/`SourceTimeline` handlers exercised elsewhere in this file still
// need the other `SessionTracker` exports, so preserve them via importOriginal.
vi.mock("../install/Installer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../install/Installer.js")>()),
	getStatus: vi.fn(),
}));
vi.mock("../core/SessionTracker.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/SessionTracker.js")>()),
	loadConfigFromDir: vi.fn(),
	getGlobalConfigDir: vi.fn(),
}));
vi.mock("../auth/AuthConfig.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../auth/AuthConfig.js")>()),
	loadAuthToken: vi.fn(),
}));

import { loadAuthToken } from "../auth/AuthConfig.js";
import { VERSION } from "../commands/CliUtils.js";
import { buildRecallPayload, compileTaskContext, listBranchCatalog } from "../core/ContextCompiler.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import { BindingAlreadyExistsError, JolliMemoryPushClient } from "../core/JolliMemoryPushClient.js";
import { pushBranchToJolli, resolveSpaceId } from "../core/JolliMemoryPushOrchestrator.js";
import { buildPrDescription } from "../core/PrDescription.js";
import { SearchIndex } from "../core/SearchIndex.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import { clearSpaceBindingCache, loadSpaceBindingDisplay } from "../core/SpaceBindingCache.js";
import { getActiveStorage } from "../core/SummaryStore.js";
import { readTopicPage } from "../core/TopicPageStore.js";
import { getStatus } from "../install/Installer.js";
import type { StatusInfo } from "../Types.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
import {
	buildStatusSummary,
	runBindSpace,
	runDecisionTimeline,
	runGetPrDescription,
	runListBranches,
	runListSpaces,
	runPushMemory,
	runQueueStatus,
	runRecall,
	runSearch,
	runStatus,
} from "./McpTools.js";

const MockClient = vi.mocked(JolliMemoryPushClient);

/**
 * `new JolliMemoryPushClient()` requires the mock implementation to be a real
 * constructible function — an arrow function throws "is not a constructor"
 * when invoked with `new`. `mockImplementation(function () {...})` sidesteps
 * that; this helper keeps call sites reading like a plain stub swap.
 */
function setClientStub(stub: Partial<JolliMemoryPushClient>): void {
	MockClient.mockImplementation(function (this: unknown) {
		return stub;
	} as unknown as typeof JolliMemoryPushClient);
}

let tempDir: string;

beforeEach(async () => {
	tempDir = join(tmpdir(), `mcptools-${process.pid}-${Math.floor(Date.now() % 1e9)}`);
	await mkdir(tempDir, { recursive: true });
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("runSearch", () => {
	it("delegates to SearchIndex.search and returns hits", async () => {
		const search = vi.fn().mockResolvedValue([{ id: "topic:x", type: "topic", title: "X", score: 1 }]);
		vi.mocked(SearchIndex.openCached).mockResolvedValue({ search } as never);
		const out = await runSearch("/repo", { query: "auth", limit: 5 });
		expect(search).toHaveBeenCalledWith({ query: "auth", limit: 5, branch: undefined, type: undefined });
		expect(out.hits).toHaveLength(1);
	});

	it("rejects an empty query with a structured error", async () => {
		await expect(runSearch("/repo", { query: "" })).rejects.toThrow(/query/i);
	});

	it("threads the active storage into openCached so the index dir matches the compile warm-up", async () => {
		// Folder/dual-write users: the index lives at `<kbRoot>/.jolli/jollimemory/`,
		// resolved from storage.kbRoot. Without passing storage, openCached falls back
		// to cwd and never sees the warm index. Pin that storage is forwarded.
		const storage = { kbRoot: "/vault/repo" } as never;
		vi.mocked(getActiveStorage).mockReturnValue(storage);
		const search = vi.fn().mockResolvedValue([]);
		vi.mocked(SearchIndex.openCached).mockResolvedValue({ search } as never);
		await runSearch("/repo", { query: "auth" });
		expect(SearchIndex.openCached).toHaveBeenCalledWith("/repo", storage);
	});
});

describe("runRecall", () => {
	it("defaults to the current branch when none given", async () => {
		vi.mocked(execFileSyncHidden).mockReturnValue("feature/auth\n");
		vi.mocked(listBranchCatalog).mockResolvedValue({
			type: "catalog",
			branches: [{ branch: "feature/auth", commitCount: 1, period: { start: "2026-01-01", end: "2026-01-01" } }],
		} as never);
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: "feature/auth", commitCount: 1 } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: "feature/auth" } as never);
		const out = await runRecall("/repo", {});
		expect(out.type).toBe("recall");
		if (out.type === "recall") expect(out.branch).toBe("feature/auth");
	});

	it("uses the explicit branch when provided", async () => {
		vi.mocked(listBranchCatalog).mockResolvedValue({
			type: "catalog",
			branches: [{ branch: "main", commitCount: 1, period: { start: "2026-01-01", end: "2026-01-01" } }],
		} as never);
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: "main", commitCount: 1 } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: "main" } as never);
		await runRecall("/repo", { branch: "main" });
		expect(compileTaskContext).toHaveBeenCalledWith(expect.objectContaining({ branch: "main" }), "/repo");
	});

	it("returns type:catalog for a non-matching branch fragment", async () => {
		vi.mocked(listBranchCatalog).mockResolvedValue({
			type: "catalog",
			branches: [{ branch: "main", commitCount: 1, period: { start: "2026-01-01", end: "2026-01-01" } }],
		} as never);
		const r = await runRecall("/repo", { branch: "no-such-frag" });
		expect(r.type).toBe("catalog");
	});

	it("returns type:recall for an exact branch", async () => {
		const seededBranch = "feature/seeded";
		vi.mocked(listBranchCatalog).mockResolvedValue({
			type: "catalog",
			branches: [{ branch: seededBranch, commitCount: 2, period: { start: "2026-01-01", end: "2026-01-02" } }],
		} as never);
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: seededBranch, commitCount: 2 } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: seededBranch } as never);
		const r = await runRecall("/repo", { branch: seededBranch });
		expect(r.type).toBe("recall");
	});
});

describe("runDecisionTimeline", () => {
	it("sorts a topic's sourceRefs chronologically", async () => {
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Auth",
			sourceRefs: [
				{ type: "summary", id: "b", timestamp: "2026-02-01T00:00:00Z", branch: "x" },
				{ type: "summary", id: "a", timestamp: "2026-01-01T00:00:00Z", branch: "x" },
			],
		} as never);
		const out = await runDecisionTimeline("/repo", { slug: "auth" });
		expect(out.timeline.map((t) => t.sourceId)).toEqual(["a", "b"]);
	});

	it("orders mixed-timezone timestamps by instant, not lexically", async () => {
		// '…+09:00' is the SAME instant as '…Z' minus 9h; a string localeCompare
		// would order them by suffix and get this wrong. The first ref is the
		// later instant despite sorting earlier as a raw string.
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Auth",
			sourceRefs: [
				{ type: "summary", id: "late", timestamp: "2026-01-01T10:00:00+09:00", branch: "x" },
				{ type: "summary", id: "early", timestamp: "2026-01-01T00:30:00Z", branch: "x" },
			],
		} as never);
		const out = await runDecisionTimeline("/repo", { slug: "auth" });
		// 00:30Z (=09:30+09:00) is earlier than 10:00+09:00, so "early" comes first.
		expect(out.timeline.map((t) => t.sourceId)).toEqual(["early", "late"]);
	});

	it("throws when the topic does not exist", async () => {
		vi.mocked(readTopicPage).mockResolvedValue(null);
		await expect(runDecisionTimeline("/repo", { slug: "missing" })).rejects.toThrow(/not found/i);
	});

	it("rejects an empty slug", async () => {
		await expect(runDecisionTimeline("/repo", { slug: "  " })).rejects.toThrow(/slug` is required/i);
	});

	it("defaults a missing ref branch to an empty string", async () => {
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Auth",
			sourceRefs: [{ type: "summary", id: "a", timestamp: "2026-01-01T00:00:00Z" }],
		} as never);
		const out = await runDecisionTimeline("/repo", { slug: "auth" });
		expect(out.timeline[0].branch).toBe("");
	});
});

describe("runListBranches", () => {
	it("returns the branch catalog", async () => {
		vi.mocked(listBranchCatalog).mockResolvedValue({ type: "catalog", branches: [{ branch: "main" }] } as never);
		const out = await runListBranches("/repo");
		expect(out.branches).toHaveLength(1);
	});
});

describe("runGetPrDescription", () => {
	it("forwards args to buildPrDescription and returns its result", async () => {
		const fakeResult = {
			type: "pr_description",
			branch: "feature/x",
			baseBranch: "main",
			title: "Add feature",
			body: "<!-- jollimemory-summary-start -->\nbody\n<!-- jollimemory-summary-end -->",
			commitCount: 2,
			summaryCount: 2,
			missingCount: 0,
		} as never;
		vi.mocked(buildPrDescription).mockResolvedValue(fakeResult);
		const out = await runGetPrDescription("/repo", {
			baseBranch: "main",
			includeMarkers: true,
		});
		expect(buildPrDescription).toHaveBeenCalledWith("/repo", {
			baseBranch: "main",
			includeMarkers: true,
		});
		expect(out).toBe(fakeResult);
	});

	it("propagates the 'no summaries' error from buildPrDescription", async () => {
		vi.mocked(buildPrDescription).mockRejectedValue(
			new Error('No JolliMemory summaries found on branch "empty" (base "main").'),
		);
		await expect(runGetPrDescription("/repo", {})).rejects.toThrow(/No JolliMemory summaries/);
	});
});

describe("runQueueStatus", () => {
	it("returns drained for an empty queue", async () => {
		const r = await runQueueStatus(tempDir, {});
		expect(r).toMatchObject({ active: 0, drained: true });
	});

	it("returns waitedMs when wait is requested", async () => {
		const r = await runQueueStatus(tempDir, { wait: true, timeoutMs: 20 });
		expect(r).toHaveProperty("waitedMs");
	});
});

describe("runPushMemory", () => {
	afterEach(() => {
		vi.mocked(pushBranchToJolli).mockReset();
	});

	it("delegates to pushBranchToJolli and returns a pushed result", async () => {
		vi.mocked(pushBranchToJolli).mockResolvedValue({
			type: "pushed",
			pushed: 2,
			skipped: 0,
			urls: ["https://jolli.ai/articles?doc=1"],
		});
		const out = await runPushMemory("/repo", { baseBranch: "main", space: "acme" });
		expect(pushBranchToJolli).toHaveBeenCalledWith({ cwd: "/repo", baseBranch: "main", space: "acme" });
		expect(out).toEqual({ type: "pushed", pushed: 2, skipped: 0, urls: ["https://jolli.ai/articles?doc=1"] });
	});

	it("returns the binding_required union member unchanged", async () => {
		vi.mocked(pushBranchToJolli).mockResolvedValue({
			type: "binding_required",
			repoUrl: "https://github.com/acme/widgets",
			spaces: [{ id: 1, name: "Acme", slug: "acme" }],
			defaultSpaceId: 1,
		});
		const out = await runPushMemory("/repo", {});
		expect(pushBranchToJolli).toHaveBeenCalledWith({ cwd: "/repo", baseBranch: undefined, space: undefined });
		expect(out.type).toBe("binding_required");
	});
});

describe("runListSpaces", () => {
	afterEach(() => {
		MockClient.mockReset();
	});

	it("returns the spaces and default space id from the client", async () => {
		const spaces = [
			{ id: 1, name: "Acme", slug: "acme" },
			{ id: 2, name: "Widgets", slug: "widgets" },
		];
		setClientStub({ listSpaces: vi.fn(async () => ({ spaces, defaultSpaceId: 2 })) });
		const out = await runListSpaces("/repo");
		expect(out).toEqual({ spaces, defaultSpaceId: 2 });
	});
});

describe("runBindSpace", () => {
	afterEach(() => {
		MockClient.mockReset();
		vi.mocked(getCanonicalRepoUrl).mockReset();
		vi.mocked(deriveRepoNameFromUrl).mockReset();
		vi.mocked(resolveSpaceId).mockReset();
		vi.mocked(clearSpaceBindingCache).mockReset();
	});

	it("resolves the repo + space and returns the bound result", async () => {
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("https://github.com/acme/widgets");
		vi.mocked(deriveRepoNameFromUrl).mockReturnValue("widgets");
		vi.mocked(resolveSpaceId).mockResolvedValue(2);
		const createBinding = vi.fn(async () => ({ bindingId: 9, jmSpaceId: 2, repoName: "widgets" }));
		setClientStub({ createBinding });
		const out = await runBindSpace("/repo", { space: "widgets" });
		expect(createBinding).toHaveBeenCalledWith({
			repoUrl: "https://github.com/acme/widgets",
			repoName: "widgets",
			jmSpaceId: 2,
		});
		expect(out).toEqual({ type: "bound", bindingId: 9, jmSpaceId: 2, repoName: "widgets" });
		// Bind-only entry point: the local binding cache is dropped so the next
		// probe (or push echo) rebuilds it authoritatively.
		expect(clearSpaceBindingCache).toHaveBeenCalledWith("/repo");
	});

	it("returns type:already_bound instead of throwing when the repo is already bound", async () => {
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("https://github.com/acme/widgets");
		vi.mocked(deriveRepoNameFromUrl).mockReturnValue("widgets");
		vi.mocked(resolveSpaceId).mockResolvedValue(1);
		const createBinding = vi.fn(async () => {
			throw new BindingAlreadyExistsError("binding_already_exists");
		});
		setClientStub({ createBinding });
		const out = await runBindSpace("/repo", { space: "acme" });
		expect(out).toEqual({ type: "already_bound", message: "binding_already_exists" });
		// The binding did not change, so the cache is left untouched.
		expect(clearSpaceBindingCache).not.toHaveBeenCalled();
	});

	it("rejects an empty space", async () => {
		await expect(runBindSpace("/repo", { space: "  " })).rejects.toThrow(/space` is required/i);
	});

	it("propagates a non-BindingAlreadyExistsError from createBinding", async () => {
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("https://github.com/acme/widgets");
		vi.mocked(deriveRepoNameFromUrl).mockReturnValue("widgets");
		vi.mocked(resolveSpaceId).mockResolvedValue(1);
		const createBinding = vi.fn(async () => {
			throw new Error("HTTP 500");
		});
		setClientStub({ createBinding });
		await expect(runBindSpace("/repo", { space: "acme" })).rejects.toThrow("HTTP 500");
	});
});

/** Builds a StatusInfo fixture; override only the fields a case cares about. */
function makeStatus(over: Partial<StatusInfo> = {}): StatusInfo {
	return {
		enabled: true,
		claudeHookInstalled: false,
		gitHookInstalled: false,
		geminiHookInstalled: false,
		activeSessions: 0,
		mostRecentSession: null,
		summaryCount: 0,
		orphanBranch: "jollimemory/summaries/v3",
		...over,
	};
}

describe("buildStatusSummary", () => {
	const account = {
		signedIn: true,
		jolliApiKeyConfigured: true,
		anthropicKeyConfigured: true,
		aiProvider: "jolli" as const,
		site: "https://acme.jolli.ai",
		diskBacked: true,
		claudeEnabled: true,
	};

	it("summarises a full install (5 Git, runtime, migrated, disk-backed site, one integration)", () => {
		const r = buildStatusSummary(
			makeStatus({
				gitHookInstalled: true,
				prePushHookInstalled: true,
				claudeHookInstalled: true,
				geminiHookInstalled: true,
				claudeDetected: true,
				hookSource: "cli",
				hookVersion: "1.0.0",
				schemaV5: "completed",
				activeSessions: 3,
				summaryCount: 42,
				sessionsBySource: { claude: 3 },
			}),
			{ version: "9.9.9", account, isClaudePlugin: false },
		);
		expect(r.version).toBe("9.9.9");
		expect(r.hooks).toEqual({
			summary: "5 Git + 2 Claude + 1 Gemini CLI",
			git: true,
			prePush: true,
			claude: true,
			gemini: true,
			runtime: "cli@1.0.0",
		});
		expect(r.dataMigration).toBe("Up to date (v5)");
		expect(r.account).toEqual({
			signedIn: true,
			jolliApiKeyConfigured: true,
			anthropicKeyConfigured: true,
			aiProvider: "jolli",
			site: "acme.jolli.ai",
			siteLabel: "Jolli Site",
		});
		expect(r.integrations).toEqual([
			// The count lives ONLY inside the `status` string (no separate bare number).
			{ name: "Claude", detected: true, status: "hook installed (3 sessions)" },
		]);
		expect(r.sessions).toBe(3);
		expect(r.storedMemories).toBe(42);
		expect(r.orphanBranch).toBe("jollimemory/summaries/v3");
		// No `space` in ctx → null (repo not bound / binding unknown).
		expect(r.space).toBeNull();
	});

	it("carries a bound Space name through when ctx.space is provided", () => {
		const r = buildStatusSummary(makeStatus(), {
			version: "1",
			account,
			isClaudePlugin: true,
			space: { name: "Shared Memory" },
		});
		expect(r.space).toEqual({ name: "Shared Memory" });
	});

	it("renders 4 Git, drops the @version for an unknown runtime, and labels a non-disk-backed site", () => {
		const r = buildStatusSummary(
			makeStatus({
				gitHookInstalled: true,
				prePushHookInstalled: false,
				hookSource: "cli",
				hookVersion: "unknown",
			}),
			{
				version: "1",
				account: { ...account, diskBacked: false, site: "https://x.jolli.dev" },
				isClaudePlugin: false,
			},
		);
		expect(r.hooks.summary).toBe("4 Git");
		expect(r.hooks.runtime).toBe("cli");
		// schemaV5 omitted → pending
		expect(r.dataMigration).toBe("Not migrated — run jolli migrate");
		expect(r.account.site).toBe("x.jolli.dev");
		expect(r.account.siteLabel).toBe("Last signed-in site");
	});

	it("reports no hooks, no runtime, no site, and no integrations", () => {
		const r = buildStatusSummary(makeStatus({ enabled: false }), {
			version: "1",
			account: { ...account, site: null, diskBacked: false },
			isClaudePlugin: false,
		});
		expect(r.enabled).toBe(false);
		expect(r.hooks.summary).toBe("none installed");
		expect(r.hooks.runtime).toBeNull();
		expect(r.account.site).toBeNull();
		expect(r.account.siteLabel).toBeNull();
		expect(r.integrations).toEqual([]);
	});

	it("treats the Claude hook as active in plugin mode even when settings.json has no hook", () => {
		// Claude Code plugin: hooks come from the manifest, so claudeHookInstalled
		// (a settings-file probe) is false — but isClaudePlugin flips it to active.
		const r = buildStatusSummary(
			makeStatus({
				gitHookInstalled: true,
				prePushHookInstalled: true,
				claudeHookInstalled: false,
				claudeDetected: true,
				sessionsBySource: { claude: 4 },
			}),
			{ version: "1", account, isClaudePlugin: true },
		);
		expect(r.hooks.summary).toBe("5 Git + 2 Claude");
		expect(r.hooks.claude).toBe(true);
		expect(r.integrations).toEqual([{ name: "Claude", detected: true, status: "hook installed (4 sessions)" }]);
	});

	it("describes each detected integration and combines Copilot CLI + Chat session counts", () => {
		const r = buildStatusSummary(
			makeStatus({
				claudeDetected: true, // enabled, hook not installed
				codexDetected: true,
				codexEnabled: false, // detected but disabled
				geminiDetected: true, // enabled, hook not installed
				openCodeDetected: true,
				openCodeScanError: { kind: "corrupt", message: "bad db" }, // unavailable
				cursorDetected: true, // enabled, no hook concept, 0 sessions
				copilotChatDetected: true, // Copilot row via Chat only
				sessionsBySource: { copilot: 2, "copilot-chat": 3 },
			}),
			{ version: "1", account, isClaudePlugin: false },
		);
		expect(r.integrations).toEqual([
			{ name: "Claude", detected: true, status: "hook not installed" },
			{ name: "Codex", detected: true, status: "detected but disabled" },
			{ name: "Gemini", detected: true, status: "hook not installed" },
			{ name: "OpenCode", detected: true, status: "unavailable — corrupt" },
			{ name: "Cursor", detected: true, status: "detected & enabled" },
			{ name: "Copilot", detected: true, status: "detected & enabled (5 sessions)" },
		]);
	});
});

describe("runStatus", () => {
	beforeEach(() => {
		// Clear any stale return values set by earlier tests (e.g. runSearch stubs
		// getActiveStorage) so each case controls its own inputs.
		vi.mocked(getStatus).mockReset();
		vi.mocked(loadConfigFromDir).mockReset();
		vi.mocked(getGlobalConfigDir).mockReset();
		vi.mocked(loadAuthToken).mockReset();
		vi.mocked(getActiveStorage)
			.mockReset()
			.mockReturnValue(undefined as never);
		// Default: repo not bound to a Space (cases that care override this).
		vi.mocked(loadSpaceBindingDisplay).mockReset().mockResolvedValue(null);
	});

	it("wires getStatus + global config + auth token into a summary", async () => {
		vi.mocked(getStatus).mockResolvedValue(
			makeStatus({ summaryCount: 7, hookSource: "cli", hookVersion: "2.0.0", schemaV5: "completed" }),
		);
		vi.mocked(getGlobalConfigDir).mockReturnValue("/glob");
		vi.mocked(loadConfigFromDir).mockResolvedValue({
			jolliApiKey: "sk-jol-x",
			apiKey: "anthropic-key",
			jolliUrl: "https://acme.jolli.ai",
			authToken: "tok",
			claudeEnabled: true,
		});
		vi.mocked(loadAuthToken).mockResolvedValue("authtok");

		const r = await runStatus("/repo");

		// getActiveStorage() is mocked (undefined) → getStatus reads via the default backend.
		expect(getStatus).toHaveBeenCalledWith("/repo", undefined);
		expect(loadConfigFromDir).toHaveBeenCalledWith("/glob");
		expect(r.version).toBe(VERSION);
		expect(r.storedMemories).toBe(7);
		expect(r.account).toEqual({
			signedIn: true,
			jolliApiKeyConfigured: true,
			anthropicKeyConfigured: true,
			aiProvider: null, // config had no explicit choice
			site: "acme.jolli.ai",
			siteLabel: "Jolli Site",
		});
		// Not bound (default mock) → no Space in the snapshot.
		expect(r.space).toBeNull();
	});

	it("surfaces the bound Space name from the local binding cache", async () => {
		vi.mocked(getStatus).mockResolvedValue(makeStatus({ summaryCount: 153 }));
		vi.mocked(getGlobalConfigDir).mockReturnValue("/glob");
		vi.mocked(loadConfigFromDir).mockResolvedValue({ jolliUrl: "https://acme.jolli.ai", authToken: "tok" });
		vi.mocked(loadAuthToken).mockResolvedValue("authtok");
		vi.mocked(loadSpaceBindingDisplay).mockResolvedValue({ spaceName: "Shared Memory", canPush: true });

		const r = await runStatus("/repo");

		expect(loadSpaceBindingDisplay).toHaveBeenCalledWith("/repo");
		expect(r.space).toEqual({ name: "Shared Memory" });
	});

	it("falls back to ANTHROPIC_API_KEY and reports an empty config as unconfigured", async () => {
		const prev = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "env-key";
		try {
			vi.mocked(getStatus).mockResolvedValue(makeStatus());
			vi.mocked(getGlobalConfigDir).mockReturnValue("/glob");
			vi.mocked(loadConfigFromDir).mockResolvedValue({});
			vi.mocked(loadAuthToken).mockResolvedValue(undefined);

			const r = await runStatus("/repo");

			expect(r.account.signedIn).toBe(false);
			expect(r.account.jolliApiKeyConfigured).toBe(false);
			expect(r.account.anthropicKeyConfigured).toBe(true); // from the env var
			expect(r.account.site).toBeNull();
			expect(r.account.siteLabel).toBeNull();
		} finally {
			if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prev;
		}
	});

	it("treats a disabled Claude and a key-only (no anthropic) config correctly", async () => {
		const prev = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			vi.mocked(getStatus).mockResolvedValue(makeStatus({ claudeDetected: true }));
			vi.mocked(getGlobalConfigDir).mockReturnValue("/glob");
			// jolliApiKey present but no authToken → diskBacked via the API key; claudeEnabled false.
			vi.mocked(loadConfigFromDir).mockResolvedValue({ jolliApiKey: "sk-jol-x", claudeEnabled: false });
			vi.mocked(loadAuthToken).mockResolvedValue(undefined);

			const r = await runStatus("/repo");

			expect(r.account.anthropicKeyConfigured).toBe(false);
			expect(r.account.jolliApiKeyConfigured).toBe(true);
			expect(r.integrations).toEqual([{ name: "Claude", detected: true, status: "detected but disabled" }]);
		} finally {
			if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prev;
		}
	});

	it("surfaces aiProvider=local-agent so callers know memory generation needs no key", async () => {
		// The Claude Code plugin defaults to local-agent: no Jolli/Anthropic key,
		// not signed in, yet memories generate fine via the local `claude`. The
		// status account must carry the provider so status.md doesn't misreport
		// "no credential → disabled".
		const prev = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			vi.mocked(getStatus).mockResolvedValue(makeStatus());
			vi.mocked(getGlobalConfigDir).mockReturnValue("/glob");
			vi.mocked(loadConfigFromDir).mockResolvedValue({
				aiProvider: "local-agent",
				localAgentTool: "claude-code",
			});
			vi.mocked(loadAuthToken).mockResolvedValue(undefined);

			const r = await runStatus("/repo");

			expect(r.account.aiProvider).toBe("local-agent");
			expect(r.account.signedIn).toBe(false);
			expect(r.account.jolliApiKeyConfigured).toBe(false);
			expect(r.account.anthropicKeyConfigured).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prev;
		}
	});
});
