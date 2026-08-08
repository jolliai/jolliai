/**
 * Full-coverage test suite for IdeBridgeCommand.ts.
 *
 * Structure:
 *   1. Small exported helpers (IdeBridgeConflictUi, IDE_BRIDGE_PROTOCOL,
 *      writeServeLine, computeServeResponse) — no I/O.
 *   2. runIdeBridgeAction — the giant dispatcher. One describe() per action
 *      (and one per sub-operation for the multi-op actions). Modules that hit
 *      disk / network are mocked at file scope.
 *   3. executeIdeBridgeCommand — one-shot stdin/stdout envelope mode.
 *   4. runIdeBridgeServe — long-lived NDJSON server, plus the private
 *      startRefreshWatchers retry loop reached through it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- module mocks (hoisted by vitest to top-of-file) ----------

const daemonWatcherInstances: Array<{
	opts: {
		path: string;
		onTrigger: (names: ReadonlySet<string>) => void;
		debounceMs: number;
		ensureDir?: boolean;
		filter?: (name: string) => boolean;
	};
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
}> = [];

// Only `computeWatchTargets` is stubbed — the target list would otherwise shell
// out to git and read the real `~/.claude/plans/`. `buildRefreshParams` stays
// REAL so this suite asserts the payload shape the host actually receives
// rather than a second copy of that rule maintained here.
vi.mock("../daemon/DaemonServer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../daemon/DaemonServer.js")>()),
	computeWatchTargets: vi.fn((cwd: string) => [
		{ kind: "queue", path: `${cwd}/queue`, ensureDir: true },
		{ kind: "orphan-ref", path: `${cwd}/refs`, ensureDir: false },
	]),
}));

vi.mock("../daemon/DaemonWatcher.js", () => ({
	DaemonWatcher: vi.fn().mockImplementation(function DaemonWatcherMock(
		this: unknown,
		opts: {
			path: string;
			onTrigger: (names: ReadonlySet<string>) => void;
			debounceMs: number;
			ensureDir?: boolean;
			filter?: (name: string) => boolean;
		},
	) {
		const start = vi.fn().mockReturnValue(true);
		const stop = vi.fn();
		const instance = { opts, start, stop };
		daemonWatcherInstances.push(instance);
		Object.assign(this as object, instance);
	}),
}));

// Shared logger stub used by any code that calls `createLogger("...")` — one
// instance so tests can inspect the same warn-call history the SUT wrote to.
// Wrapped in `vi.hoisted` because vi.mock's factory is hoisted to the top of
// the file BEFORE plain const initializers run; a top-level const would trip
// a "Cannot access before initialization" ReferenceError inside the factory.
const _mockedLoggerCalls = vi.hoisted(() => ({
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../Logger.js", () => ({
	setLogDir: vi.fn(),
	createLogger: () => _mockedLoggerCalls,
	getJolliMemoryDir: (cwd: string) => `${cwd}/.jolli/jollimemory`,
	errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
	isManuallyDisabled: () => false,
}));

vi.mock("../core/MemoryBankMigration.js", () => ({
	runMemoryBankMigration: vi.fn(async () => ({ status: "completed", totalEntries: 0, migratedEntries: 0 })),
}));
vi.mock("../core/StorageFactory.js", () => ({
	createStorage: vi.fn(),
}));

vi.mock("../core/HiddenConversationsStore.js", () => ({
	hideConversation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/ConversationOverlayStore.js", () => ({
	loadOverlay: vi.fn(),
	saveOverlay: vi.fn(),
	applyOverlay: vi.fn(),
	applyDeletes: vi.fn(),
	mergeOverlay: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({
	getGlobalConfigDir: vi.fn().mockReturnValue("/global/config"),
	loadConfigFromDir: vi.fn(),
	loadConfig: vi.fn().mockResolvedValue({}),
	saveConfigScoped: vi.fn().mockResolvedValue(undefined),
	loadPlansRegistry: vi.fn().mockResolvedValue({}),
	savePlansRegistry: vi.fn().mockResolvedValue(undefined),
	savePluginSource: vi.fn().mockResolvedValue(undefined),
	saveSquashPending: vi.fn().mockResolvedValue(undefined),
	getOrCreateInstallId: vi.fn().mockResolvedValue({ installId: "install-1", created: false }),
	detectActivePlansForBranch: vi.fn().mockResolvedValue([]),
	detectActiveNotesForBranch: vi.fn().mockResolvedValue([]),
	detectUncommittedReferenceIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/PlanService.js", () => ({
	detectPlans: vi.fn().mockResolvedValue([]),
	listAvailablePlans: vi.fn().mockReturnValue([]),
	addPlanToRegistry: vi.fn().mockResolvedValue(undefined),
	removePlan: vi.fn().mockResolvedValue(undefined),
	renamePlanTitle: vi.fn().mockResolvedValue(undefined),
	archivePlanForCommit: vi.fn().mockResolvedValue(null),
	// `getPlansDir` is pointed at a scratch dir by the plans-register-new suite;
	// the default keeps every other test away from the real `~/.claude/plans/`.
	getPlansDir: vi.fn().mockReturnValue("/nonexistent/claude/plans"),
	isPlanFromCurrentProject: vi.fn().mockResolvedValue(true),
	registerNewPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/NoteService.js", () => ({
	detectNotes: vi.fn().mockResolvedValue([]),
	saveNote: vi.fn().mockResolvedValue(null),
	removeNote: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/references/ReferenceService.js", () => ({
	removeReference: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/Locks.js", () => ({
	getWorkerBusyState: vi.fn().mockResolvedValue({ held: false, blocking: false }),
	// Constants consumed by the acquire-lock / release-lock bridge cases. Kept
	// as plain literals here so the tests are decoupled from any future
	// re-tuning of the real defaults in Locks.ts.
	PLANS_LOCK_FILE: "plans.lock",
	DEFAULT_PLANS_LOCK_TIMEOUT_MS: 5000,
	DEFAULT_PLANS_LOCK_POLL_MS: 25,
	// Serialises `sync-agent-hooks` against Installer's enable/disable — see the
	// case in [IdeBridgeCommand.ts]. Default happy-path returns a handle whose
	// release is a no-op; a per-test `mockResolvedValueOnce(null)` covers the
	// contention branch that throws.
	acquireRepoHooksLock: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("../core/LockPrimitives.js", () => ({
	acquireWithPoll: vi.fn(),
	releaseIfOwned: vi.fn(),
}));

vi.mock("node:fs/promises", async (importActual) => {
	// Only mkdir needs stubbing (the acquire-lock case ensures the lock dir
	// exists). Every other fs function keeps its real behavior so unrelated
	// paths in the bridge aren't disturbed.
	const actual = await importActual<typeof import("node:fs/promises")>();
	return {
		...actual,
		mkdir: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock("../auth/AuthConfig.js", () => ({
	getJolliUrl: vi.fn().mockReturnValue("https://jolli.ai"),
	loadAuthToken: vi.fn().mockResolvedValue(undefined),
	saveAuthCredentials: vi.fn().mockResolvedValue(undefined),
	clearAuthCredentials: vi.fn().mockResolvedValue(undefined),
	shouldRequestFreshApiKey: vi.fn().mockReturnValue(false),
	resolveSignInJolliUrl: vi.fn((_apiKey: string | undefined, url: string) => url),
}));

vi.mock("../auth/CliExchange.js", () => ({
	exchangeCliCode: vi.fn(),
}));

// Pinned so `device_name` assertions don't depend on the CI runner's hostname
// (`getDeviceLabel()` sanitizes it and returns undefined when nothing survives).
vi.mock("../auth/DeviceLabel.js", () => ({
	getDeviceLabel: vi.fn().mockReturnValue("test-box"),
}));

vi.mock("../core/JolliApiUtils.js", () => ({
	parseJolliApiKey: vi.fn().mockReturnValue({ u: "https://jolli.ai" }),
	validateJolliApiKey: vi.fn(),
	assertJolliOriginAllowed: vi.fn(),
	deriveJolliBackendKey: vi.fn().mockReturnValue("prod"),
}));

vi.mock("../core/JolliMemoryPushClient.js", () => {
	const push = vi.fn().mockResolvedValue({ ok: true });
	const deleteDoc = vi.fn().mockResolvedValue(undefined);
	const listSpaces = vi.fn().mockResolvedValue({ spaces: [], defaultSpaceId: null });
	const createBinding = vi.fn().mockResolvedValue({ ok: true });
	// vi.fn() constructs the mock as callable+constructable; the impl MUST be a
	// non-arrow function so `new fn()` finds [[Construct]] and its object
	// return supplants the fresh `this`. Arrow functions have no [[Construct]]
	// and throw "is not a constructor".
	const JolliMemoryPushClient = vi.fn().mockImplementation(function JolliMemoryPushClientMock() {
		return { push, deleteDoc, listSpaces, createBinding };
	});
	return { JolliMemoryPushClient };
});

vi.mock("../core/JolliShareClient.js", () => {
	const create = vi.fn().mockResolvedValue({ shareId: "s1" });
	const update = vi.fn().mockResolvedValue({ ok: true });
	const revoke = vi.fn().mockResolvedValue(undefined);
	const invite = vi.fn().mockResolvedValue({ invited: 1 });
	const listOrgMembers = vi.fn().mockResolvedValue([{ id: 1 }]);
	const JolliShareClient = vi.fn().mockImplementation(function JolliShareClientMock() {
		return { create, update, revoke, invite, listOrgMembers };
	});
	return { JolliShareClient };
});

vi.mock("../core/JolliMemoryPushOrchestrator.js", () => ({
	serializeSummaryJson: vi.fn().mockReturnValue('{"summary":true}'),
	planBaseKey: vi.fn((slug: string) => `plan:${slug}`),
	latestPlanPerName: vi.fn((plans: unknown[]) => plans),
}));

vi.mock("../core/GitRemoteUtils.js", () => ({
	getCanonicalRepoUrl: vi.fn().mockResolvedValue("git@github.com:acme/repo.git"),
	deriveRepoNameFromUrl: vi.fn().mockReturnValue("repo"),
	normalizeRemoteUrl: vi.fn().mockReturnValue("git@github.com:acme/repo.git"),
	sanitizeBranchSlug: vi.fn().mockReturnValue("main-slug"),
}));

vi.mock("../core/GitOps.js", () => ({
	execGit: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
	getProjectRootDir: vi.fn().mockResolvedValue("/repo/root"),
	getCurrentBranch: vi.fn().mockResolvedValue("main"),
	// The sync-agent-hooks case enumerates worktrees. Default to the repo root
	// so tests that don't care about multi-worktree paths still cover one
	// iteration; individual tests override with `.mockResolvedValueOnce([...])`
	// when they need the branching two-worktree behaviour.
	listWorktrees: vi.fn().mockResolvedValue(["/repo/root"]),
}));

vi.mock("../core/PinStore.js", () => ({
	listPins: vi.fn().mockResolvedValue([]),
	addPin: vi.fn().mockResolvedValue(undefined),
	removePin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/CommitSelectionStore.js", () => ({
	readExclusions: vi.fn().mockResolvedValue({
		conversations: [],
		plans: [],
		notes: [],
		references: [],
	}),
	conversationKey: vi.fn().mockReturnValue("k"),
	setExcluded: vi.fn().mockResolvedValue(undefined),
	setAllExcluded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/BranchShareStore.js", () => ({
	putBranchShare: vi.fn().mockResolvedValue(undefined),
	removeShare: vi.fn().mockResolvedValue(undefined),
	getShare: vi.fn().mockResolvedValue(null),
}));

vi.mock("../core/PushPendingStore.js", () => ({
	loadPushPending: vi.fn().mockResolvedValue({ entries: { hashA: 1, hashB: 2 } }),
}));

vi.mock("../core/RepoProfile.js", () => ({
	readRepoProfile: vi.fn().mockResolvedValue({ backfillDismissed: false, manuallyDisabled: false }),
	updateRepoProfile: vi.fn().mockResolvedValue(undefined),
	// sync-agent-hooks gates on the repo-wide manual-disable flag exactly like
	// VS Code's syncHooks; a per-test `.mockResolvedValueOnce(true)` covers the
	// manually-disabled early-return branch.
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
	writeManualDisableFlag: vi.fn().mockResolvedValue(undefined),
}));

// Spreads the real module on purpose: the jolli-api push/delete gate constructs
// the REAL `PushDisabledError`, whose `name` is the ide-bridge wire contract the
// IntelliJ side dispatches on. A bare factory omitting it makes the destructured
// binding `undefined`, so the gate dies with "not a constructor" instead of
// refusing the push — and a class re-declared here would make the name assertions
// below vacuous. The three functions are still fully stubbed.
vi.mock("../core/PushControl.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/PushControl.js")>()),
	applyPushDisabled: vi.fn().mockResolvedValue(true),
	isOutboundPushAllowed: vi.fn().mockResolvedValue(true),
	readPushDisabledState: vi.fn().mockResolvedValue({ disabled: false }),
}));

vi.mock("../core/SummaryMarkdownBuilder.js", () => ({
	buildMarkdown: vi.fn().mockReturnValue("# md"),
	buildReferencePushMarkdown: vi.fn().mockReturnValue("# ref"),
}));

vi.mock("../core/SummaryPrMarkdownBuilder.js", () => ({
	buildPrMarkdown: vi.fn().mockReturnValue("# pr md"),
}));

vi.mock("../core/PrDescription.js", () => ({
	wrapWithMarkers: vi.fn((md: string) => `<!--start-->${md}<!--end-->`),
	replaceSummaryInBody: vi.fn((body: string) => `${body}[patched]`),
	buildPrDescription: vi.fn().mockResolvedValue({ title: "T", body: "B" }),
}));

vi.mock("../core/SummaryFormat.js", () => ({
	buildReferencePushTitle: vi.fn().mockReturnValue("Ref Title"),
}));

vi.mock("../core/references/ReferenceStore.js", () => ({
	readReferenceMarkdown: vi.fn().mockResolvedValue({ source: "src", archivedKey: "k", content: "c" }),
	readReferenceMarkdownFromString: vi.fn().mockReturnValue({ description: "desc" }),
}));

vi.mock("../core/SummaryStore.js", () => ({
	// Pass-through: the must-land D6 lock wrapper's own behavior is covered in
	// SummaryStore/Locks tests; here only "the write happens under it" matters.
	// It lives on THIS mock, not on Locks' — the two bridge write actions take the
	// must-land budget (30 s), not the background one, because `ide-bridge-serve`
	// dispatches request lines concurrently and a competing write must wait rather
	// than fail unretried.
	withRequiredOrphanWriteLock: vi.fn(async (_cwd: string | undefined, _label: string, fn: () => Promise<unknown>) =>
		fn(),
	),
	getIndex: vi.fn(),
	getSummary: vi.fn().mockResolvedValue({ commitHash: "abc" }),
	listSummaries: vi.fn().mockResolvedValue([]),
	getSummaryCount: vi.fn().mockResolvedValue(0),
	scanTreeHashAliases: vi.fn().mockResolvedValue(false),
	storeSummary: vi.fn().mockResolvedValue(undefined),
	readPlanProgress: vi.fn().mockResolvedValue([]),
	readPlanFromBranch: vi.fn().mockResolvedValue("plan-content"),
	storePlans: vi.fn().mockResolvedValue(undefined),
	deletePlanVisibleArtifact: vi.fn().mockResolvedValue(undefined),
	readReferenceFromBranch: vi.fn().mockResolvedValue("ref-content"),
	storeReferences: vi.fn().mockResolvedValue(undefined),
	getTranscriptHashes: vi.fn().mockResolvedValue(new Set<string>(["h1", "h2"])),
	readTranscript: vi.fn().mockResolvedValue({ entries: [] }),
	saveTranscriptsBatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/SummaryTree.js", () => ({
	isUnifiedHoistFormat: vi.fn().mockReturnValue(true),
	collectAllTopics: vi.fn().mockReturnValue([]),
	collectDisplayTopics: vi.fn().mockReturnValue([]),
	aggregateStats: vi.fn().mockReturnValue({ files: 0, insertions: 0, deletions: 0 }),
	aggregateTurns: vi.fn().mockReturnValue(1),
	aggregateConversationTokens: vi.fn().mockReturnValue(2),
	aggregateConversationTokenBreakdown: vi.fn().mockReturnValue({ input: 1, output: 1 }),
	aggregateEstimatedCost: vi.fn().mockReturnValue(0.01),
	countTopics: vi.fn().mockReturnValue(3),
	collectSourceNodes: vi.fn().mockReturnValue([]),
	isLeafNode: vi.fn().mockReturnValue(true),
	computeDurationDays: vi.fn().mockReturnValue(1),
	formatDurationLabel: vi.fn().mockReturnValue("1d"),
	getTranscriptIds: vi.fn().mockReturnValue(["t-1"]),
	updateTopicInTree: vi.fn().mockReturnValue({ updated: true }),
	deleteTopicInTree: vi.fn().mockReturnValue({ deleted: true }),
}));

vi.mock("../core/KBPathResolver.js", () => ({
	resolveKBPath: vi.fn().mockReturnValue("/kb"),
	initializeKBFolder: vi.fn(),
	findRepoFolders: vi.fn().mockReturnValue([]),
	findFreshKBPath: vi.fn().mockReturnValue("/kb-fresh"),
	archiveKBFolder: vi.fn().mockReturnValue("/kb-archive"),
	extractRepoName: vi.fn().mockReturnValue("repo"),
	getRemoteUrl: vi.fn().mockReturnValue("git@github.com:acme/repo.git"),
}));

vi.mock("../core/KBRepoDiscoverer.js", () => ({
	discoverRepos: vi.fn().mockReturnValue([]),
}));

vi.mock("../core/MetadataManager.js", () => {
	const ensure = vi.fn();
	const readManifest = vi.fn().mockReturnValue({ files: [] });
	const readIndex = vi.fn().mockReturnValue({ version: 1, entries: [] });
	const readConfig = vi.fn().mockReturnValue({});
	const findByPath = vi.fn().mockReturnValue({ fileId: "id" });
	const updatePath = vi.fn().mockReturnValue(true);
	const renameBranchFolder = vi.fn().mockReturnValue(3);
	const removeBranchFolder = vi.fn().mockReturnValue(2);
	const removeFromManifest = vi.fn().mockReturnValue(true);
	const reconcile = vi.fn().mockReturnValue(1);
	const saveMigrationState = vi.fn();
	const MetadataManager = vi.fn().mockImplementation(function MetadataManagerMock() {
		return {
			ensure,
			readManifest,
			readIndex,
			readConfig,
			findByPath,
			updatePath,
			renameBranchFolder,
			removeBranchFolder,
			removeFromManifest,
			reconcile,
			saveMigrationState,
		};
	});
	return { MetadataManager };
});

vi.mock("../core/FolderStorage.js", () => {
	const healMissingVisibleMarkdown = vi.fn().mockResolvedValue({ healed: 0, skipped: 0, failed: 0 });
	const FolderStorage = vi.fn().mockImplementation(function FolderStorageMock() {
		return { healMissingVisibleMarkdown };
	});
	return { FolderStorage };
});

vi.mock("../core/ActiveSessionAggregator.js", () => ({
	listActiveConversationsWithDiagnostics: vi.fn().mockResolvedValue({ conversations: [], diagnostics: {} }),
}));

vi.mock("../core/TranscriptMessageCounter.js", () => ({
	loadUnreadTranscript: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/TranscriptLoader.js", () => ({
	loadTranscript: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/MultiRepoCompile.js", () => ({
	compileAllRepos: vi.fn().mockResolvedValue({ repos: [] }),
}));

vi.mock("../install/Installer.js", () => ({
	getStatus: vi.fn().mockResolvedValue({ installed: true }),
	// Hook installers driven by the sync-agent-hooks action. Default happy
	// path: all four resolve; a per-test override injects failures to cover
	// the failures[] shape.
	installClaudeHook: vi.fn().mockResolvedValue({ ok: true }),
	removeClaudeHook: vi.fn().mockResolvedValue({ ok: true }),
	installGeminiHook: vi.fn().mockResolvedValue({ ok: true }),
	removeGeminiHook: vi.fn().mockResolvedValue(undefined),
	// Install / uninstall bridge actions. Default happy path returns a
	// successful InstallResult; per-test overrides inject failure or
	// non-empty warnings.
	install: vi.fn().mockResolvedValue({ success: true, message: "installed", warnings: [] }),
	uninstall: vi.fn().mockResolvedValue({ success: true, message: "uninstalled", warnings: [] }),
}));

vi.mock("./SyncCommand.js", () => ({
	ensureKBInitAndMigrated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../sync/SyncBootstrap.js", () => ({
	buildSyncEngine: vi.fn().mockResolvedValue(null),
}));

vi.mock("../core/TokenCost.js", () => ({
	estimateConversationCostUsd: vi.fn().mockReturnValue(0.5),
}));

vi.mock("../core/Pricing.js", () => ({
	MODEL_PRICES: { "gpt-4": { provider: "openai" } },
	estimateModelCostUsd: vi.fn().mockReturnValue(0.25),
	estimateCostUsd: vi.fn().mockReturnValue({ totalUsd: 1.5 }),
}));

vi.mock("../core/TelemetryStartup.js", () => ({
	bootstrapTelemetry: vi.fn().mockResolvedValue(undefined),
	flushTelemetryNow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/Telemetry.js", () => ({
	track: vi.fn(),
	bucket: vi.fn((n: number) => `bucket-${n}`),
}));

vi.mock("../core/TelemetryConsent.js", () => ({
	shouldShowTelemetryNotice: vi.fn().mockReturnValue(false),
}));

vi.mock("../core/localagent/DetectAgents.js", () => ({
	isLocalAgentUsable: vi.fn(),
	// The override return value is opaque to the bridge — `isLocalAgentUsable`
	// is the only thing that reads it, and this file mocks that too. A plain
	// stub keeps the tests decoupled from the real config shape.
	localAgentOverrideFrom: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./CliUtils.js", async (importActual) => {
	// Only readStdin needs to be stubbed (test scaffolding pipes raw JSON via
	// runIdeBridgeAction, not via stdin). Every other export — including the
	// `IDE_BRIDGE_STDIN_MAX_BYTES` constant that the ide-bridge entry point
	// imports at the top of IdeBridgeCommand.ts — passes through unchanged, so
	// the mock can't drift from the source value if the constant is later
	// resized.
	const actual = await importActual<typeof import("./CliUtils.js")>();
	return {
		...actual,
		readStdin: vi.fn(),
	};
});

// ---------- module under test (import AFTER vi.mock declarations) ----------

import {
	computeServeResponse,
	executeIdeBridgeCommand,
	IDE_BRIDGE_PROTOCOL,
	IdeBridgeConflictUi,
	runIdeBridgeAction,
	runIdeBridgeServe,
	writeServeLine,
} from "./IdeBridgeCommand.js";

// ---------- shared helpers ----------

/**
 * Spies on stdout / stderr / console.log so their output can be inspected but
 * never leaks to the terminal during a real test run.
 */
function captureConsole(): { stdout: string[]; stderr: string[]; consoleLog: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const consoleLog: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		stdout.push(typeof chunk === "string" ? chunk : String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		stderr.push(typeof chunk === "string" ? chunk : String(chunk));
		return true;
	});
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		consoleLog.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	return { stdout, stderr, consoleLog };
}

beforeEach(async () => {
	daemonWatcherInstances.length = 0;
	process.exitCode = undefined;
	// afterEach's restoreAllMocks strips the factory default, and the jolli-api
	// push/delete gate (spec 306) now reads this predicate — reset it to allowed so
	// each test starts from a known state; the gate tests override it explicitly.
	const { isOutboundPushAllowed } = await import("../core/PushControl.js");
	vi.mocked(isOutboundPushAllowed).mockResolvedValue(true);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

// ---------- 1. small exported helpers ----------

describe("IdeBridgeConflictUi", () => {
	it("records unresolved conflict content and skips the first bridge round", async () => {
		const ui = new IdeBridgeConflictUi({});
		await expect(ui.promptBinaryPick("repo/file.md", "mine", "remote")).resolves.toBe("skip");
		expect(ui.details).toEqual([{ path: "repo/file.md", ours: "mine", theirs: "remote" }]);
	});

	it("replays an IDE 'mine' choice without recording another prompt", async () => {
		const ui = new IdeBridgeConflictUi({ "repo/file.md": "mine" });
		await expect(ui.promptBinaryPick("repo/file.md", "mine", "remote")).resolves.toBe("mine");
		expect(ui.details).toEqual([]);
	});

	it("replays an IDE 'theirs' choice without recording another prompt", async () => {
		const ui = new IdeBridgeConflictUi({ "repo/file.md": "theirs" });
		await expect(ui.promptBinaryPick("repo/file.md", "mine", "remote")).resolves.toBe("theirs");
		expect(ui.details).toEqual([]);
	});

	it("deduplicates the same path across multiple unresolved prompts in one round", async () => {
		const ui = new IdeBridgeConflictUi({});
		await ui.promptBinaryPick("dup.md", "x", "y");
		await ui.promptBinaryPick("dup.md", "x", "y");
		expect(ui.details).toEqual([{ path: "dup.md", ours: "x", theirs: "y" }]);
	});
});

describe("IDE_BRIDGE_PROTOCOL", () => {
	it("advertises the pinned wire protocol name — matches the Kotlin CliDaemonClient constant", () => {
		expect(IDE_BRIDGE_PROTOCOL).toBe("jolli-ide-bridge-jsonrpc-v1");
	});
});

describe("writeServeLine — stringify fallback", () => {
	function capture(fn: () => void): string {
		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : String(chunk));
			return true;
		});
		fn();
		return chunks.join("");
	}

	it("emits a serialisable object verbatim", () => {
		const payload = { jsonrpc: "2.0", id: 1, result: { ok: true } };
		expect(capture(() => writeServeLine(payload))).toBe(`${JSON.stringify(payload)}\n`);
	});

	it("emits a minimal JSON-RPC error envelope when the response contains a bigint", () => {
		const out = capture(() => writeServeLine({ jsonrpc: "2.0", id: 42, result: { big: 9007199254740993n } }));
		const parsed = JSON.parse(out.trimEnd());
		expect(parsed).toMatchObject({
			jsonrpc: "2.0",
			id: 42,
			error: {
				code: -32603,
				message: expect.stringContaining("response not serialisable"),
				data: { errorName: "SerializationError" },
			},
		});
	});

	it("emits a minimal error envelope when the response contains a circular reference", () => {
		const obj: Record<string, unknown> = { jsonrpc: "2.0", id: "call-7" };
		const self: Record<string, unknown> = {};
		self.self = self;
		obj.result = self;
		const out = capture(() => writeServeLine(obj));
		const parsed = JSON.parse(out.trimEnd());
		expect(parsed).toMatchObject({
			jsonrpc: "2.0",
			id: "call-7",
			error: { code: -32603, data: { errorName: "SerializationError" } },
		});
	});

	it("passes through a null id when the failing response had no usable id", () => {
		const out = capture(() => writeServeLine({ jsonrpc: "2.0", method: "ready", params: { pid: 12345n } }));
		const parsed = JSON.parse(out.trimEnd());
		expect(parsed.id).toBeNull();
		expect(parsed).toMatchObject({ jsonrpc: "2.0", error: { code: -32603 } });
	});

	it("falls back to id=null when the failing response carries a boolean id", () => {
		const out = capture(() => writeServeLine({ jsonrpc: "2.0", id: true, params: { pid: 1n } }));
		const parsed = JSON.parse(out.trimEnd());
		expect(parsed.id).toBeNull();
	});

	it("stringifies the error itself with String() when it is not an Error instance", () => {
		// throw a non-Error primitive from JSON.stringify by using a getter
		const bad = {
			jsonrpc: "2.0",
			id: 5,
			get result() {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw "raw-string-error";
			},
		};
		const out = capture(() => writeServeLine(bad));
		const parsed = JSON.parse(out.trimEnd());
		expect(parsed.error.message).toContain("raw-string-error");
	});
});

describe("computeServeResponse", () => {
	// plan-grouping is a pure handler with no external I/O — the mock stubs
	// planBaseKey directly so the envelope is deterministic.
	const validLine = JSON.stringify({
		jsonrpc: "2.0",
		id: 42,
		method: "plan-grouping",
		params: { cwd: "/repo", request: { operation: "base-key", slug: "s" } },
	});

	it("wraps the handler result in a JSON-RPC 2.0 envelope", async () => {
		const envelope = await computeServeResponse(validLine, "/fallback");
		expect(envelope).toMatchObject({ jsonrpc: "2.0", id: 42, result: { key: "plan:s" } });
	});

	it("uses params.cwd over the default", async () => {
		const envelope = await computeServeResponse(validLine, "/never-used");
		expect(envelope).toMatchObject({ jsonrpc: "2.0", id: 42 });
	});

	it("falls back to the default cwd when params.cwd is missing", async () => {
		const line = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "plan-grouping",
			params: { request: { operation: "base-key", slug: "s" } },
		});
		const envelope = await computeServeResponse(line, "/default");
		expect(envelope).toMatchObject({ id: 1, result: { key: "plan:s" } });
	});

	it("falls back to the default cwd when params.cwd is an empty string", async () => {
		const line = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "plan-grouping",
			params: { cwd: "", request: { operation: "base-key", slug: "s" } },
		});
		const envelope = await computeServeResponse(line, "/default");
		expect(envelope).toMatchObject({ id: 1, result: { key: "plan:s" } });
	});

	it("returns a paired error envelope for an unknown method", async () => {
		const envelope = await computeServeResponse(
			JSON.stringify({ jsonrpc: "2.0", id: 7, method: "no-such-action", params: {} }),
			"/x",
		);
		expect(envelope).toMatchObject({
			jsonrpc: "2.0",
			id: 7,
			error: { code: -32000, message: expect.stringContaining("Unknown IDE bridge action") },
		});
	});

	it("returns id:null with an error for a malformed JSON line", async () => {
		const envelope = await computeServeResponse("this is not json {", "/x");
		expect(envelope.id).toBeNull();
		expect(envelope).toMatchObject({
			jsonrpc: "2.0",
			error: { code: -32000, message: expect.any(String) },
		});
	});

	it("rejects a non-object top-level value with an id-less error", async () => {
		const envelope = await computeServeResponse("[1,2,3]", "/x");
		expect(envelope).toMatchObject({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32000, message: expect.stringContaining("Request must be a JSON object.") },
		});
	});

	it("rejects a request without a method field but preserves the id", async () => {
		const envelope = await computeServeResponse(JSON.stringify({ jsonrpc: "2.0", id: 3 }), "/x");
		expect(envelope).toMatchObject({
			jsonrpc: "2.0",
			id: 3,
			error: { code: -32000, message: expect.stringContaining('"method"') },
		});
	});

	it("accepts params.traceId and still dispatches the action normally", async () => {
		// A well-formed 32-hex traceId is adopted via runWithTrace so the
		// dispatched handler's outbound HTTP calls carry the IDE-scoped
		// x-jolli-trace value instead of a fresh CLI-only one.
		const envelope = await computeServeResponse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 9,
				method: "plan-grouping",
				params: {
					cwd: "/repo",
					request: { operation: "base-key", slug: "s" },
					traceId: "abc123def4567890abc123def4567890",
				},
			}),
			"/fallback",
		);
		expect(envelope).toMatchObject({ jsonrpc: "2.0", id: 9, result: { key: "plan:s" } });
	});

	it("rejects a non-string params.traceId with a paired error envelope", async () => {
		const envelope = await computeServeResponse(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 10,
				method: "plan-grouping",
				params: { cwd: "/repo", request: {}, traceId: 12345 },
			}),
			"/fallback",
		);
		expect(envelope).toMatchObject({
			jsonrpc: "2.0",
			id: 10,
			error: { code: -32000, message: expect.stringContaining("traceId") },
		});
	});

	it("rejects a request whose method field is an empty string", async () => {
		const envelope = await computeServeResponse(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "" }), "/x");
		expect(envelope).toMatchObject({ error: { message: expect.stringContaining('"method"') } });
	});

	it("rejects a request whose params is not a JSON object", async () => {
		const envelope = await computeServeResponse(
			JSON.stringify({ jsonrpc: "2.0", id: 3, method: "x", params: [1, 2, 3] }),
			"/x",
		);
		expect(envelope).toMatchObject({ error: { message: expect.stringContaining('"params"') } });
	});

	it("rejects a request whose params.cwd is not a string", async () => {
		const envelope = await computeServeResponse(
			JSON.stringify({ jsonrpc: "2.0", id: 3, method: "x", params: { cwd: 123 } }),
			"/x",
		);
		expect(envelope).toMatchObject({ error: { message: expect.stringContaining('"params.cwd"') } });
	});

	it("rejects a request whose params.request is not a JSON object", async () => {
		const envelope = await computeServeResponse(
			JSON.stringify({ jsonrpc: "2.0", id: 3, method: "x", params: { request: [1] } }),
			"/x",
		);
		expect(envelope).toMatchObject({ error: { message: expect.stringContaining('"params.request"') } });
	});

	it("accepts a missing params body — handler decides what to do", async () => {
		const envelope = await computeServeResponse(
			JSON.stringify({ jsonrpc: "2.0", id: 99, method: "plan-grouping" }),
			"/x",
		);
		expect(envelope.id).toBe(99);
		// plan-grouping needs an operation; the handler throws its own error.
		expect(envelope).toMatchObject({ error: { code: -32000 } });
	});

	it("passes a string id back verbatim", async () => {
		const line = JSON.stringify({
			jsonrpc: "2.0",
			id: "call-a1",
			method: "plan-grouping",
			params: { cwd: "/x", request: { operation: "base-key", slug: "x" } },
		});
		const envelope = await computeServeResponse(line, "/x");
		expect(envelope).toMatchObject({ jsonrpc: "2.0", id: "call-a1" });
	});

	it("preserves errorName in error.data for named errors", async () => {
		const envelope = await computeServeResponse(
			JSON.stringify({ jsonrpc: "2.0", id: 11, method: "no-such-action" }),
			"/x",
		);
		expect(envelope).toMatchObject({
			jsonrpc: "2.0",
			id: 11,
			error: { code: -32000, data: { errorName: "Error" } },
		});
	});
});

// ---------- 2. runIdeBridgeAction — per-action coverage ----------

describe("runIdeBridgeAction — migrate-memory-bank", () => {
	it("delegates to runMemoryBankMigration with the caller's cwd", async () => {
		const { runMemoryBankMigration } = await import("../core/MemoryBankMigration.js");
		vi.mocked(runMemoryBankMigration).mockResolvedValue({
			status: "completed",
			totalEntries: 4,
			migratedEntries: 4,
		});
		const result = await runIdeBridgeAction("migrate-memory-bank", "/repo", {});
		expect(runMemoryBankMigration).toHaveBeenCalledWith("/repo");
		expect(result).toMatchObject({ status: "completed", totalEntries: 4, migratedEntries: 4 });
	});
});

describe("runIdeBridgeAction — sync-agent-hooks", () => {
	beforeEach(async () => {
		// afterEach's restoreAllMocks strips the factory defaults set at
		// top-of-file, so re-establish the happy-path baseline that every test
		// below either accepts or overrides via mock*Once. Kept local to this
		// describe so tests for other actions aren't affected.
		const { listWorktrees, getProjectRootDir } = await import("../core/GitOps.js");
		const { readManualDisableFlag } = await import("../core/RepoProfile.js");
		const { installClaudeHook, removeClaudeHook, installGeminiHook, removeGeminiHook } = await import(
			"../install/Installer.js"
		);
		const { acquireRepoHooksLock } = await import("../core/Locks.js");
		vi.mocked(listWorktrees).mockResolvedValue(["/repo/root"]);
		vi.mocked(getProjectRootDir).mockResolvedValue("/repo/root");
		vi.mocked(readManualDisableFlag).mockResolvedValue(false);
		vi.mocked(installClaudeHook).mockResolvedValue({ ok: true } as never);
		vi.mocked(removeClaudeHook).mockResolvedValue({ ok: true } as never);
		vi.mocked(installGeminiHook).mockResolvedValue({ ok: true } as never);
		vi.mocked(removeGeminiHook).mockResolvedValue(undefined as never);
		vi.mocked(acquireRepoHooksLock).mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) });
	});

	it("installs Claude and Gemini per-worktree when both toggles are on", async () => {
		const { listWorktrees } = await import("../core/GitOps.js");
		const { installClaudeHook, installGeminiHook, removeClaudeHook, removeGeminiHook } = await import(
			"../install/Installer.js"
		);
		vi.mocked(listWorktrees).mockResolvedValueOnce(["/repo/root", "/repo/root-feature"]);

		const result = await runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
			claudeEnabled: true,
			geminiEnabled: true,
		});

		expect(installClaudeHook).toHaveBeenCalledTimes(2);
		expect(installClaudeHook).toHaveBeenCalledWith("/repo/root");
		expect(installClaudeHook).toHaveBeenCalledWith("/repo/root-feature");
		expect(installGeminiHook).toHaveBeenCalledTimes(2);
		expect(removeClaudeHook).not.toHaveBeenCalled();
		expect(removeGeminiHook).not.toHaveBeenCalled();
		expect(result).toEqual({
			manuallyDisabled: false,
			worktrees: ["/repo/root", "/repo/root-feature"],
			failures: [],
		});
	});

	it("removes hooks per-worktree when the toggles are off", async () => {
		const { installClaudeHook, installGeminiHook, removeClaudeHook, removeGeminiHook } = await import(
			"../install/Installer.js"
		);
		const result = await runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
			claudeEnabled: false,
			geminiEnabled: false,
		});
		expect(removeClaudeHook).toHaveBeenCalledWith("/repo/root");
		expect(removeGeminiHook).toHaveBeenCalledWith("/repo/root");
		expect(installClaudeHook).not.toHaveBeenCalled();
		expect(installGeminiHook).not.toHaveBeenCalled();
		expect(result).toMatchObject({ manuallyDisabled: false, failures: [] });
	});

	it("mixes install/remove per-integration based on each flag", async () => {
		const { installClaudeHook, installGeminiHook, removeClaudeHook, removeGeminiHook } = await import(
			"../install/Installer.js"
		);
		await runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
			claudeEnabled: true,
			geminiEnabled: false,
		});
		expect(installClaudeHook).toHaveBeenCalledWith("/repo/root");
		expect(removeGeminiHook).toHaveBeenCalledWith("/repo/root");
		expect(removeClaudeHook).not.toHaveBeenCalled();
		expect(installGeminiHook).not.toHaveBeenCalled();
	});

	it("early-returns without touching hooks when the repo is manually disabled", async () => {
		const { readManualDisableFlag } = await import("../core/RepoProfile.js");
		const { installClaudeHook, installGeminiHook, removeClaudeHook, removeGeminiHook } = await import(
			"../install/Installer.js"
		);
		vi.mocked(readManualDisableFlag).mockResolvedValueOnce(true);
		const result = await runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
			claudeEnabled: true,
			geminiEnabled: true,
		});
		expect(installClaudeHook).not.toHaveBeenCalled();
		expect(installGeminiHook).not.toHaveBeenCalled();
		expect(removeClaudeHook).not.toHaveBeenCalled();
		expect(removeGeminiHook).not.toHaveBeenCalled();
		expect(result).toEqual({ manuallyDisabled: true, worktrees: [], failures: [] });
	});

	it("collects per-worktree per-integration failures without aborting the loop", async () => {
		const { listWorktrees } = await import("../core/GitOps.js");
		const { installClaudeHook, installGeminiHook } = await import("../install/Installer.js");
		vi.mocked(listWorktrees).mockResolvedValueOnce(["/repo/root", "/repo/root-feature"]);
		// First worktree fails on Claude, second one fails on Gemini — verifies
		// that both failures land in the same `failures` array and that later
		// iterations still ran (i.e. no exception escaped the loop).
		vi.mocked(installClaudeHook).mockRejectedValueOnce(new Error("boom-claude"));
		vi.mocked(installGeminiHook)
			.mockResolvedValueOnce({ ok: true } as never)
			.mockRejectedValueOnce(new Error("boom-gemini"));

		const result = (await runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
			claudeEnabled: true,
			geminiEnabled: true,
		})) as { failures: Array<{ worktree: string; integration: string; message: string }> };

		expect(result.failures).toEqual([
			{ worktree: "/repo/root", integration: "Claude", message: "boom-claude" },
			{ worktree: "/repo/root-feature", integration: "Gemini", message: "boom-gemini" },
		]);
	});

	it("falls back to the repo root when listWorktrees throws", async () => {
		const { listWorktrees } = await import("../core/GitOps.js");
		const { installClaudeHook } = await import("../install/Installer.js");
		vi.mocked(listWorktrees).mockRejectedValueOnce(new Error("not a git dir"));
		const result = (await runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
			claudeEnabled: true,
			geminiEnabled: true,
		})) as { worktrees: string[] };
		// getProjectRootDir mock resolves to "/repo/root" (see top-of-file mock),
		// so that's what the fallback iteration hits.
		expect(installClaudeHook).toHaveBeenCalledWith("/repo/root");
		expect(result.worktrees).toEqual(["/repo/root"]);
	});

	it("rejects non-boolean toggle fields", async () => {
		await expect(
			runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
				claudeEnabled: "yes",
				geminiEnabled: true,
			} as never),
		).rejects.toThrow(/must be booleans/);
	});

	it("acquires and releases the repo-hooks lock around the per-worktree writes", async () => {
		const { acquireRepoHooksLock } = await import("../core/Locks.js");
		const { installClaudeHook } = await import("../install/Installer.js");
		const release = vi.fn().mockResolvedValue(undefined);
		vi.mocked(acquireRepoHooksLock).mockResolvedValueOnce({ release });

		await runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
			claudeEnabled: true,
			geminiEnabled: true,
		});

		expect(acquireRepoHooksLock).toHaveBeenCalledWith("/repo/root");
		// Serialised against enable/disable — the SAME lock Installer takes in
		// [install]/[uninstall]. Verified via a matching release; without the
		// lock, the IntelliJ startup auto-install could race with a Settings
		// Apply and clobber each other's `.claude/settings.local.json` writes.
		expect(release).toHaveBeenCalledTimes(1);
		expect(installClaudeHook).toHaveBeenCalledWith("/repo/root");
	});

	it("throws when the repo-hooks lock is already held (contention)", async () => {
		const { acquireRepoHooksLock } = await import("../core/Locks.js");
		const { installClaudeHook, installGeminiHook } = await import("../install/Installer.js");
		vi.mocked(acquireRepoHooksLock).mockResolvedValueOnce(null);

		// Lock timeout MUST surface as a bridge error — the IntelliJ caller's
		// outer catch renders a "click Apply again" balloon, which is the
		// correct recovery for a transient enable/disable race. Silently
		// falling through to unlocked writes is what the lock exists to prevent.
		await expect(
			runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
				claudeEnabled: true,
				geminiEnabled: true,
			}),
		).rejects.toThrow(/Another Jolli enable\/disable/);
		expect(installClaudeHook).not.toHaveBeenCalled();
		expect(installGeminiHook).not.toHaveBeenCalled();
	});

	it("still short-circuits on manual-disable without taking the lock", async () => {
		const { readManualDisableFlag } = await import("../core/RepoProfile.js");
		const { acquireRepoHooksLock } = await import("../core/Locks.js");
		vi.mocked(readManualDisableFlag).mockResolvedValueOnce(true);

		const result = await runIdeBridgeAction("sync-agent-hooks", "/repo/root", {
			claudeEnabled: true,
			geminiEnabled: true,
		});
		// The manual-disable flag is a stable per-repo opt-out; taking the
		// enable/disable lock just to check it (and return without writing
		// anything) would make a common no-op case contend with a real enable.
		expect(acquireRepoHooksLock).not.toHaveBeenCalled();
		expect(result).toEqual({ manuallyDisabled: true, worktrees: [], failures: [] });
	});
});

describe("runIdeBridgeAction — disable", () => {
	beforeEach(async () => {
		// afterEach's restoreAllMocks strips the factory defaults; re-establish
		// the happy-path uninstall() so each test either accepts it or overrides
		// with a mockResolvedValueOnce.
		const { uninstall } = await import("../install/Installer.js");
		vi.mocked(uninstall).mockResolvedValue({
			success: true,
			message: "disabled",
			warnings: [],
		});
	});

	it("defaults to a full disable with persistManualDisable=true and preserveMenu=true", async () => {
		const { uninstall } = await import("../install/Installer.js");
		const result = await runIdeBridgeAction("disable", "/repo/root", {});
		expect(uninstall).toHaveBeenCalledWith("/repo/root", {
			integrationsOnly: false,
			persistManualDisable: true,
			preserveMenu: true,
		});
		expect(result).toEqual({ success: true, message: "disabled", warnings: [] });
	});

	it("integrations-only disable flips preserveMenu and persistManualDisable to false", async () => {
		const { uninstall } = await import("../install/Installer.js");
		await runIdeBridgeAction("disable", "/repo/root", { integrationsOnly: true });
		expect(uninstall).toHaveBeenCalledWith("/repo/root", {
			integrationsOnly: true,
			persistManualDisable: false,
			preserveMenu: false,
		});
	});

	it("honors an explicit persistManualDisable=false override on a full disable", async () => {
		const { uninstall } = await import("../install/Installer.js");
		await runIdeBridgeAction("disable", "/repo/root", { persistManualDisable: false });
		expect(uninstall).toHaveBeenCalledWith("/repo/root", {
			integrationsOnly: false,
			persistManualDisable: false,
			preserveMenu: true,
		});
	});

	it("propagates a failing uninstall result verbatim (success:false + message)", async () => {
		const { uninstall } = await import("../install/Installer.js");
		vi.mocked(uninstall).mockResolvedValueOnce({
			success: false,
			message: "Another Jolli enable/disable operation is still running; retry shortly",
			warnings: [],
		});
		const result = await runIdeBridgeAction("disable", "/repo/root", {});
		expect(result).toEqual({
			success: false,
			message: "Another Jolli enable/disable operation is still running; retry shortly",
			warnings: [],
		});
	});

	it("copies warnings out of the uninstall result", async () => {
		const { uninstall } = await import("../install/Installer.js");
		vi.mocked(uninstall).mockResolvedValueOnce({
			success: true,
			message: "disabled",
			warnings: ["mcp entry not removed for cline (best-effort)"],
		});
		const result = (await runIdeBridgeAction("disable", "/repo/root", {})) as {
			warnings: string[];
		};
		expect(result.warnings).toEqual(["mcp entry not removed for cline (best-effort)"]);
	});
});

describe("runIdeBridgeAction — active-conversations", () => {
	it("delegates to listActiveConversationsWithDiagnostics with a default 48h window", async () => {
		const { listActiveConversationsWithDiagnostics } = await import("../core/ActiveSessionAggregator.js");
		vi.mocked(listActiveConversationsWithDiagnostics).mockResolvedValue({
			conversations: [{ id: "a" }],
			diagnostics: { c: 1 },
		} as never);
		const result = await runIdeBridgeAction("active-conversations", "/repo", {});
		expect(listActiveConversationsWithDiagnostics).toHaveBeenCalledWith({
			cwd: "/repo",
			windowMs: 2 * 24 * 60 * 60 * 1000,
		});
		expect(result).toMatchObject({ conversations: [{ id: "a" }] });
	});

	it("honours a numeric windowMs override", async () => {
		const { listActiveConversationsWithDiagnostics } = await import("../core/ActiveSessionAggregator.js");
		await runIdeBridgeAction("active-conversations", "/repo", { windowMs: 1234 });
		expect(listActiveConversationsWithDiagnostics).toHaveBeenCalledWith({ cwd: "/repo", windowMs: 1234 });
	});
});

describe("runIdeBridgeAction — per-repo push control (spec 306)", () => {
	it("outbound-push-allowed returns the predicate for the cwd", async () => {
		const { isOutboundPushAllowed } = await import("../core/PushControl.js");
		vi.mocked(isOutboundPushAllowed).mockResolvedValue(false);
		const result = await runIdeBridgeAction("outbound-push-allowed", "/repo", {});
		expect(isOutboundPushAllowed).toHaveBeenCalledWith("/repo");
		expect(result).toEqual({ allowed: false });
	});

	it("push-control-set toggles the current repo (cwd) and echoes the flag", async () => {
		const { applyPushDisabled } = await import("../core/PushControl.js");
		const result = await runIdeBridgeAction("push-control-set", "/repo", { disabled: true });
		expect(applyPushDisabled).toHaveBeenCalledWith("/repo", true, "intellij");
		expect(result).toEqual({ pushDisabled: true });
	});

	it("push-control-get returns the pure push-disabled flag for the cwd", async () => {
		const { readPushDisabledState } = await import("../core/PushControl.js");
		vi.mocked(readPushDisabledState).mockResolvedValue({ disabled: true });
		const result = await runIdeBridgeAction("push-control-get", "/repo", {});
		expect(readPushDisabledState).toHaveBeenCalledWith("/repo");
		// No `pushDisabledError` key at all when the store read succeeded — its mere
		// presence is what tells the host "this is not the user's choice".
		expect(result).toEqual({ pushDisabled: true });
	});

	// The reporting-surface half of spec 306: an unreadable store fails closed to
	// `disabled: true` for EVERY repo on the machine, so the boolean alone would have
	// the IntelliJ Settings checkbox claim the user turned THIS repo off. The error
	// (carrying the store's path) must reach the host so it can render "unknown".
	it("push-control-get carries the fail-closed reason when the store is unreadable", async () => {
		const { readPushDisabledState } = await import("../core/PushControl.js");
		vi.mocked(readPushDisabledState).mockResolvedValue({
			disabled: true,
			error: "unreadable: /home/u/.jolli/jollimemory/push-control.json",
		});
		const result = await runIdeBridgeAction("push-control-get", "/repo", {});
		expect(result).toEqual({
			pushDisabled: true,
			pushDisabledError: "unreadable: /home/u/.jolli/jollimemory/push-control.json",
		});
	});
});

describe("runIdeBridgeAction — unread-transcript", () => {
	it("dispatches to loadUnreadTranscript for a known source", async () => {
		const { loadUnreadTranscript } = await import("../core/TranscriptMessageCounter.js");
		vi.mocked(loadUnreadTranscript).mockResolvedValue([{ text: "hi" }] as never);
		const result = await runIdeBridgeAction("unread-transcript", "/r", {
			source: "claude",
			transcriptPath: "/tmp/t.jsonl",
		});
		expect(loadUnreadTranscript).toHaveBeenCalledWith("claude", "/tmp/t.jsonl", "/r");
		expect(result).toEqual({ entries: [{ text: "hi" }] });
	});

	it("rejects an unknown transcript source", async () => {
		await expect(
			runIdeBridgeAction("unread-transcript", "/r", { source: "nope", transcriptPath: "/t" }),
		).rejects.toThrow(/Unknown transcript source/);
	});
});

describe("runIdeBridgeAction — transcript", () => {
	it("dispatches to loadTranscript for a known source", async () => {
		const { loadTranscript } = await import("../core/TranscriptLoader.js");
		vi.mocked(loadTranscript).mockResolvedValue([{ text: "row" }] as never);
		const result = await runIdeBridgeAction("transcript", "/r", { source: "codex", transcriptPath: "/t" });
		expect(loadTranscript).toHaveBeenCalledWith({ source: "codex", transcriptPath: "/t" });
		expect(result).toEqual({ entries: [{ text: "row" }] });
	});

	it("rejects an unknown transcript source", async () => {
		await expect(runIdeBridgeAction("transcript", "/r", { source: "nope", transcriptPath: "/t" })).rejects.toThrow(
			/Unknown transcript source/,
		);
	});
});

describe("runIdeBridgeAction — compile", () => {
	it("compiles using the config-provided localFolder when the request omits it", async () => {
		const { compileAllRepos } = await import("../core/MultiRepoCompile.js");
		vi.mocked(compileAllRepos).mockResolvedValue({ repos: ["r1"] } as never);
		const config = { localFolder: "/bank" };
		const result = await runIdeBridgeAction("compile", "/r", { config });
		expect(compileAllRepos).toHaveBeenCalledWith("/bank", config);
		expect(result).toEqual({ repos: ["r1"] });
	});

	it("prefers the request-provided localFolder over config.localFolder", async () => {
		const { compileAllRepos } = await import("../core/MultiRepoCompile.js");
		await runIdeBridgeAction("compile", "/r", { config: { localFolder: "/config" }, localFolder: "/override" });
		expect(compileAllRepos).toHaveBeenCalledWith("/override", expect.anything());
	});

	it("rejects when the request has no config object", async () => {
		await expect(runIdeBridgeAction("compile", "/r", {})).rejects.toThrow(/"config"/);
	});

	it("rejects when there is no folder configured anywhere", async () => {
		await expect(runIdeBridgeAction("compile", "/r", { config: {} })).rejects.toThrow(/No Memory Bank folder/);
	});
});

describe("runIdeBridgeAction — folder-heal-visible-markdown", () => {
	it("delegates to FolderStorage.healMissingVisibleMarkdown with dropOrphans default false", async () => {
		const { FolderStorage } = await import("../core/FolderStorage.js");
		const { MetadataManager } = await import("../core/MetadataManager.js");
		const result = await runIdeBridgeAction("folder-heal-visible-markdown", "/r", { kbRoot: "/bank/repo" });
		expect(MetadataManager).toHaveBeenCalledWith(join("/bank/repo", ".jolli"));
		expect(FolderStorage).toHaveBeenCalled();
		const instance = vi.mocked(FolderStorage).mock.results[0]?.value as {
			healMissingVisibleMarkdown: ReturnType<typeof vi.fn>;
		};
		expect(instance.healMissingVisibleMarkdown).toHaveBeenCalledWith({ dropOrphanedManifestEntries: false });
		expect(result).toEqual({ healed: 0, skipped: 0, failed: 0 });
	});

	it("forwards dropOrphanedManifestEntries when explicitly true", async () => {
		const { FolderStorage } = await import("../core/FolderStorage.js");
		vi.mocked(FolderStorage).mockClear();
		await runIdeBridgeAction("folder-heal-visible-markdown", "/r", {
			kbRoot: "/bank/repo",
			dropOrphanedManifestEntries: true,
		});
		const instance = vi.mocked(FolderStorage).mock.results[0]?.value as {
			healMissingVisibleMarkdown: ReturnType<typeof vi.fn>;
		};
		expect(instance.healMissingVisibleMarkdown).toHaveBeenCalledWith({ dropOrphanedManifestEntries: true });
	});

	it("rejects when kbRoot is missing", async () => {
		await expect(runIdeBridgeAction("folder-heal-visible-markdown", "/r", {})).rejects.toThrow(/"kbRoot"/);
	});
});

describe("runIdeBridgeAction — local-agent-tools", () => {
	it("returns every entry of LOCAL_AGENT_TOOLS with id/label/loginHint", async () => {
		const { LOCAL_AGENT_TOOLS } = await import("../core/localagent/ToolMeta.js");
		const result = (await runIdeBridgeAction("local-agent-tools", "/r", {})) as {
			tools: Array<{ id: string; label: string; loginHint: string }>;
		};
		const expected = Object.entries(LOCAL_AGENT_TOOLS).map(([id, meta]) => ({
			id,
			label: meta.label,
			loginHint: meta.loginHint,
		}));
		expect(result.tools).toEqual(expected);
	});
});

describe("runIdeBridgeAction — local-agent-usable", () => {
	beforeEach(async () => {
		const { isLocalAgentUsable } = await import("../core/localagent/DetectAgents.js");
		vi.mocked(isLocalAgentUsable).mockReset();
	});

	it("throws loudly on an unknown tool id (allow-list contract)", async () => {
		await expect(runIdeBridgeAction("local-agent-usable", "/r", { tool: "not-a-tool" })).rejects.toThrow(
			/Unknown local agent tool "not-a-tool"/,
		);
	});

	it("rejects prototype-chain keys — hasOwnProperty guards the allow-list", async () => {
		// Prototype-chain keys ("toString", "__proto__", "constructor") are
		// truthy under naive `LOCAL_AGENT_TOOLS[tool]` indexing but must fail
		// the allow-list. Regression guard for the L6 finding.
		await expect(runIdeBridgeAction("local-agent-usable", "/r", { tool: "toString" })).rejects.toThrow(
			/Unknown local agent tool "toString"/,
		);
	});

	it("passes through `isLocalAgentUsable` and returns { available: true }", async () => {
		const { isLocalAgentUsable } = await import("../core/localagent/DetectAgents.js");
		vi.mocked(isLocalAgentUsable).mockResolvedValue(true);
		const result = await runIdeBridgeAction("local-agent-usable", "/r", {
			tool: "claude-code",
		});
		expect(result).toEqual({ available: true });
		expect(vi.mocked(isLocalAgentUsable)).toHaveBeenCalledWith("claude-code", {
			override: undefined,
		});
	});

	it("forwards a foreign-tool override verbatim — filtering is isLocalAgentUsable's job", async () => {
		// The bridge must NOT drop a mismatched override on the caller's behalf:
		// the tool/path pairing check lives inside `isLocalAgentUsable`
		// (`opts.override?.tool === tool`), so what the bridge forwards must be
		// the untouched value `localAgentOverrideFrom` returned. Without this
		// test the default mock (`localAgentOverrideFrom → undefined`) used by
		// every other case in this file would make a mistaken drop-in-the-bridge
		// invisible.
		const detect = await import("../core/localagent/DetectAgents.js");
		const foreignOverride = { tool: "codex" as const, path: "/opt/codex" };
		vi.mocked(detect.localAgentOverrideFrom).mockReturnValueOnce(foreignOverride);
		vi.mocked(detect.isLocalAgentUsable).mockResolvedValue(false);
		const result = await runIdeBridgeAction("local-agent-usable", "/r", {
			tool: "claude-code",
		});
		// Bridge answers with whatever `isLocalAgentUsable` returned; the
		// mismatched override doesn't change that.
		expect(result).toEqual({ available: false });
		// Critical assertion: the bridge forwarded the override verbatim.
		expect(vi.mocked(detect.isLocalAgentUsable)).toHaveBeenCalledWith("claude-code", {
			override: foreignOverride,
		});
	});

	it("swallows a discovery throw and answers { available: false }", async () => {
		// UI contract: "unknown ≡ not usable". A crashing detector must never
		// leak to the caller as an unhandled promise rejection — the settings
		// dialog would show a red banner instead of a clean "not found" line.
		const { isLocalAgentUsable } = await import("../core/localagent/DetectAgents.js");
		vi.mocked(isLocalAgentUsable).mockRejectedValue(new Error("detector crashed"));
		const result = await runIdeBridgeAction("local-agent-usable", "/r", {
			tool: "codex",
		});
		expect(result).toEqual({ available: false });
	});
});

describe("runIdeBridgeAction — pr-description", () => {
	it("passes through baseBranch and includeMarkers to buildPrDescription", async () => {
		const { buildPrDescription } = await import("../core/PrDescription.js");
		vi.mocked(buildPrDescription).mockResolvedValue({ title: "T", body: "B" } as never);
		const result = await runIdeBridgeAction("pr-description", "/r", {
			baseBranch: "main",
			includeMarkers: false,
		});
		expect(buildPrDescription).toHaveBeenCalledWith("/r", { baseBranch: "main", includeMarkers: false });
		expect(result).toEqual({ title: "T", body: "B" });
	});

	it("defaults includeMarkers to true when not explicitly set to false", async () => {
		const { buildPrDescription } = await import("../core/PrDescription.js");
		await runIdeBridgeAction("pr-description", "/r", {});
		expect(buildPrDescription).toHaveBeenCalledWith("/r", { baseBranch: undefined, includeMarkers: true });
	});
});

describe("runIdeBridgeAction — status", () => {
	it("delegates to Installer.getStatus with the created storage", async () => {
		const { getStatus } = await import("../install/Installer.js");
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ tag: "storage" } as never);
		vi.mocked(getStatus).mockResolvedValue({ installed: false } as never);
		const result = await runIdeBridgeAction("status", "/r", {});
		expect(getStatus).toHaveBeenCalledWith("/r", { tag: "storage" });
		expect(result).toEqual({ installed: false });
	});
});

describe("runIdeBridgeAction — sync", () => {
	it("throws when config has no jolliApiKey", async () => {
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({} as never);
		await expect(runIdeBridgeAction("sync", "/r", {})).rejects.toThrow(/Sync requires a Jolli sign-in\./);
	});

	it("throws when buildSyncEngine returns null", async () => {
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk" } as never);
		const { buildSyncEngine } = await import("../sync/SyncBootstrap.js");
		vi.mocked(buildSyncEngine).mockResolvedValue(null);
		await expect(runIdeBridgeAction("sync", "/r", {})).rejects.toThrow(/Sync requires a Jolli sign-in\./);
	});

	it("throws for an unknown sync reason", async () => {
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk" } as never);
		const { buildSyncEngine } = await import("../sync/SyncBootstrap.js");
		vi.mocked(buildSyncEngine).mockResolvedValue({ runRound: vi.fn() } as never);
		await expect(runIdeBridgeAction("sync", "/r", { reason: "bogus" })).rejects.toThrow(/Unknown sync reason/);
	});

	it("runs a full sync round with the resolved reason and merges conflictDetails", async () => {
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({
			jolliApiKey: "sk",
			localFolder: "/bank",
			syncTranscripts: false,
		} as never);
		const { buildSyncEngine } = await import("../sync/SyncBootstrap.js");
		const runRound = vi.fn().mockResolvedValue({ pushed: 1 });
		vi.mocked(buildSyncEngine).mockResolvedValue({ runRound } as never);
		const result = await runIdeBridgeAction("sync", "/r", {
			reason: "post-commit",
			transcripts: true,
			conflictChoices: { "a/b.md": "mine" },
		});
		expect(runRound).toHaveBeenCalledWith({ cwd: "/r", reason: "post-commit", transcripts: true });
		expect(result).toMatchObject({ pushed: 1, conflictDetails: [] });
	});

	it("defaults sync reason to 'manual' when omitted and honours config.syncTranscripts", async () => {
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({
			jolliApiKey: "sk",
			syncTranscripts: true,
		} as never);
		const { buildSyncEngine } = await import("../sync/SyncBootstrap.js");
		const runRound = vi.fn().mockResolvedValue({ pushed: 0 });
		vi.mocked(buildSyncEngine).mockResolvedValue({ runRound } as never);
		await runIdeBridgeAction("sync", "/r", {});
		expect(runRound).toHaveBeenCalledWith({ cwd: "/r", reason: "manual", transcripts: true });
	});

	it("rejects an invalid conflictChoices value with a specific error", async () => {
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk" } as never);
		await expect(runIdeBridgeAction("sync", "/r", { conflictChoices: { "a.md": "sideways" } })).rejects.toThrow(
			/Conflict choice for "a\.md" must be/,
		);
	});

	it("rejects a non-object conflictChoices value", async () => {
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk" } as never);
		await expect(runIdeBridgeAction("sync", "/r", { conflictChoices: [1, 2] })).rejects.toThrow(
			/"conflictChoices"/,
		);
	});
});

describe("runIdeBridgeAction — conversation-overlay", () => {
	it("hides a conversation on the 'hide' operation", async () => {
		const { hideConversation } = await import("../core/HiddenConversationsStore.js");
		const result = await runIdeBridgeAction("conversation-overlay", "/r", {
			operation: "hide",
			source: "claude",
			sessionId: "sess-1",
		});
		expect(hideConversation).toHaveBeenCalledWith("/r", "claude", "sess-1");
		expect(result).toEqual({ ok: true });
	});

	it("returns overlay + displayed + rawWithDeletesOnly on 'view'", async () => {
		const overlayStore = await import("../core/ConversationOverlayStore.js");
		vi.mocked(overlayStore.loadOverlay).mockResolvedValue({ deletes: [], edits: [] } as never);
		vi.mocked(overlayStore.applyOverlay).mockReturnValue(["disp"] as never);
		vi.mocked(overlayStore.applyDeletes).mockReturnValue(["raw"] as never);
		const result = await runIdeBridgeAction("conversation-overlay", "/r", {
			operation: "view",
			source: "claude",
			sessionId: "s",
			entries: [{ id: "e1" }],
		});
		expect(result).toMatchObject({ displayed: ["disp"], rawWithDeletesOnly: ["raw"] });
	});

	it("rejects 'view' when entries is not an array", async () => {
		await expect(
			runIdeBridgeAction("conversation-overlay", "/r", {
				operation: "view",
				source: "claude",
				sessionId: "s",
			}),
		).rejects.toThrow(/"entries"/);
	});

	it("merges and saves on 'merge-save'", async () => {
		const overlayStore = await import("../core/ConversationOverlayStore.js");
		vi.mocked(overlayStore.loadOverlay).mockResolvedValue({ deletes: [], edits: [] } as never);
		vi.mocked(overlayStore.mergeOverlay).mockReturnValue({ deletes: ["d"], edits: [] } as never);
		vi.mocked(overlayStore.saveOverlay).mockResolvedValue({ deletes: ["d"], edits: [] } as never);
		const result = await runIdeBridgeAction("conversation-overlay", "/r", {
			operation: "merge-save",
			source: "claude",
			sessionId: "s",
			deletes: [{ id: "d" }],
			edits: [],
		});
		expect(overlayStore.saveOverlay).toHaveBeenCalled();
		expect(result).toMatchObject({ deletes: ["d"] });
	});

	it("rejects 'merge-save' when deletes/edits are not arrays", async () => {
		await expect(
			runIdeBridgeAction("conversation-overlay", "/r", {
				operation: "merge-save",
				source: "claude",
				sessionId: "s",
				deletes: "no",
				edits: [],
			}),
		).rejects.toThrow(/"deletes" and "edits"/);
	});

	it("rejects an unknown conversation-overlay operation", async () => {
		await expect(
			runIdeBridgeAction("conversation-overlay", "/r", {
				operation: "shred",
				source: "claude",
				sessionId: "s",
			}),
		).rejects.toThrow(/Unknown conversation-overlay operation/);
	});

	it("rejects an unknown transcript source at the conversation-overlay entry", async () => {
		await expect(
			runIdeBridgeAction("conversation-overlay", "/r", {
				operation: "view",
				source: "nope",
				sessionId: "s",
				entries: [],
			}),
		).rejects.toThrow(/Unknown transcript source/);
	});
});

describe("runIdeBridgeAction — working-context", () => {
	it("plans-detect returns the CLI's filtered plan list", async () => {
		const { detectPlans } = await import("../core/PlanService.js");
		vi.mocked(detectPlans).mockResolvedValue([{ slug: "p1" }] as never);
		const result = await runIdeBridgeAction("working-context", "/r", { operation: "plans-detect" });
		expect(detectPlans).toHaveBeenCalledWith("/r");
		expect(result).toEqual({ plans: [{ slug: "p1" }] });
	});

	it("plans-list-available forwards excludeSlugs as a Set", async () => {
		const { listAvailablePlans } = await import("../core/PlanService.js");
		vi.mocked(listAvailablePlans).mockReturnValue([{ slug: "a", title: "A", mtimeMs: 1 }]);
		const result = await runIdeBridgeAction("working-context", "/r", {
			operation: "plans-list-available",
			excludeSlugs: ["taken"],
		});
		expect(listAvailablePlans).toHaveBeenCalledWith(new Set(["taken"]));
		expect(result).toEqual({ plans: [{ slug: "a", title: "A", mtimeMs: 1 }] });
	});

	it("plans-add delegates to addPlanToRegistry", async () => {
		const { addPlanToRegistry } = await import("../core/PlanService.js");
		await runIdeBridgeAction("working-context", "/r", { operation: "plans-add", slug: "p1" });
		expect(addPlanToRegistry).toHaveBeenCalledWith("p1", "/r");
	});

	describe("plans-register-new", () => {
		// `existsSync` is deliberately NOT mocked in this file, so the stale-name
		// guard is exercised against a real directory rather than a stub.
		let plansDir: string;

		beforeEach(async () => {
			plansDir = mkdtempSync(join(tmpdir(), "ide-bridge-plans-"));
			const { getPlansDir, isPlanFromCurrentProject, registerNewPlan } = await import("../core/PlanService.js");
			const { loadPlansRegistry } = await import("../core/SessionTracker.js");
			vi.mocked(getPlansDir).mockReturnValue(plansDir);
			vi.mocked(isPlanFromCurrentProject).mockResolvedValue(true);
			// Empty registry by default: the handler skips already-tracked slugs
			// before the (expensive) attribution call, so the fixture has to say
			// which slugs are tracked. Set explicitly rather than relying on the
			// module-factory default — another test overrides this same mock.
			vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
			// The file-level afterEach only restores `vi.spyOn` spies, so call
			// history on a module-factory `vi.fn()` survives into the next test —
			// and every negative assertion below ("must not register") would then
			// read the previous test's calls.
			vi.mocked(registerNewPlan).mockClear();
			vi.mocked(isPlanFromCurrentProject).mockClear();
		});

		afterEach(() => {
			rmSync(plansDir, { recursive: true, force: true });
		});

		it("derives the slug from each name and registers it, reporting what it accepted", async () => {
			writeFileSync(join(plansDir, "add-dark-mode.md"), "# Add dark mode");
			writeFileSync(join(plansDir, "fix-login.md"), "# Fix login");
			const { registerNewPlan } = await import("../core/PlanService.js");

			const result = await runIdeBridgeAction("working-context", "/r", {
				operation: "plans-register-new",
				names: ["add-dark-mode.md", "fix-login.md"],
			});

			expect(registerNewPlan).toHaveBeenCalledWith("add-dark-mode", "/r");
			expect(registerNewPlan).toHaveBeenCalledWith("fix-login", "/r");
			expect(result).toEqual({ accepted: ["add-dark-mode", "fix-login"] });
		});

		it("skips a name whose file is gone — fs.watch reports deletes as the same event as creates", async () => {
			const { registerNewPlan } = await import("../core/PlanService.js");

			const result = await runIdeBridgeAction("working-context", "/r", {
				operation: "plans-register-new",
				names: ["just-deleted.md"],
			});

			expect(registerNewPlan).not.toHaveBeenCalled();
			expect(result).toEqual({ accepted: [] });
		});

		it("skips non-markdown entries", async () => {
			writeFileSync(join(plansDir, "scratch.txt"), "x");
			writeFileSync(join(plansDir, ".md"), "x");
			const { registerNewPlan } = await import("../core/PlanService.js");

			const result = await runIdeBridgeAction("working-context", "/r", {
				operation: "plans-register-new",
				// `.md` alone would derive an empty slug.
				names: ["scratch.txt", ".md"],
			});

			expect(registerNewPlan).not.toHaveBeenCalled();
			expect(result).toEqual({ accepted: [] });
		});

		// `~/.claude/plans/` is machine-global: a plan another project's session
		// wrote lands in the same directory and reaches every project's daemon.
		it("skips a plan that does not belong to this project", async () => {
			writeFileSync(join(plansDir, "someone-elses.md"), "# Theirs");
			const { isPlanFromCurrentProject, registerNewPlan } = await import("../core/PlanService.js");
			vi.mocked(isPlanFromCurrentProject).mockResolvedValue(false);

			const result = await runIdeBridgeAction("working-context", "/r", {
				operation: "plans-register-new",
				names: ["someone-elses.md"],
			});

			expect(isPlanFromCurrentProject).toHaveBeenCalledWith(join(plansDir, "someone-elses.md"), "/r");
			expect(registerNewPlan).not.toHaveBeenCalled();
			expect(result).toEqual({ accepted: [] });
		});

		// The operation is reachable over the bridge, so a name is untrusted input
		// even though the watcher that normally supplies it only reports direct
		// children. Anything with a path component is dropped before the join.
		it("drops a name carrying a path component instead of joining it", async () => {
			const { registerNewPlan } = await import("../core/PlanService.js");

			const result = await runIdeBridgeAction("working-context", "/r", {
				operation: "plans-register-new",
				names: ["../../etc/evil.md", "sub/dir.md"],
			});

			expect(registerNewPlan).not.toHaveBeenCalled();
			expect(result).toEqual({ accepted: [] });
		});

		it("returns an empty result for an empty burst", async () => {
			const result = await runIdeBridgeAction("working-context", "/r", {
				operation: "plans-register-new",
				names: [],
			});
			expect(result).toEqual({ accepted: [] });
		});

		// `fs.watch` fires on content edits too, not just creates, so a user
		// iterating on one plan replays its name on every save. Attribution reads
		// every active transcript in full to substring-match the path, so it must
		// not run for a slug the registry already has — registerNewPlan would
		// no-op on it anyway.
		it("skips the attribution scan entirely for a slug the registry already tracks", async () => {
			writeFileSync(join(plansDir, "already-known.md"), "# Known");
			const { isPlanFromCurrentProject, registerNewPlan } = await import("../core/PlanService.js");
			const { loadPlansRegistry } = await import("../core/SessionTracker.js");
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {
					"already-known": {
						slug: "already-known",
						title: "Known",
						sourcePath: join(plansDir, "already-known.md"),
						addedAt: "x",
						updatedAt: "x",
						commitHash: null,
					},
				},
			});

			const result = await runIdeBridgeAction("working-context", "/r", {
				operation: "plans-register-new",
				names: ["already-known.md"],
			});

			expect(isPlanFromCurrentProject).not.toHaveBeenCalled();
			expect(registerNewPlan).not.toHaveBeenCalled();
			expect(result).toEqual({ accepted: [] });
		});

		// A rename + a change for one file is one burst with the name twice; the
		// second occurrence must not buy a second plans.lock acquisition.
		it("registers a repeated name only once within a burst", async () => {
			writeFileSync(join(plansDir, "add-dark-mode.md"), "# Add dark mode");
			const { registerNewPlan } = await import("../core/PlanService.js");

			const result = await runIdeBridgeAction("working-context", "/r", {
				operation: "plans-register-new",
				names: ["add-dark-mode.md", "add-dark-mode.md"],
			});

			expect(registerNewPlan).toHaveBeenCalledTimes(1);
			expect(result).toEqual({ accepted: ["add-dark-mode"] });
		});
	});

	it("plans-remove passes expectedCommitHash through when present", async () => {
		const { removePlan } = await import("../core/PlanService.js");
		await runIdeBridgeAction("working-context", "/r", {
			operation: "plans-remove",
			slug: "p1",
			expectedCommitHash: "abc123",
		});
		expect(removePlan).toHaveBeenCalledWith("p1", "/r", "abc123");
	});

	// Sidebar removal deletes unconditionally; the commit gate only applies when
	// the caller names a commit, so an omitted field must stay undefined.
	it("plans-remove leaves expectedCommitHash undefined when omitted", async () => {
		const { removePlan } = await import("../core/PlanService.js");
		await runIdeBridgeAction("working-context", "/r", { operation: "plans-remove", slug: "p1" });
		expect(removePlan).toHaveBeenCalledWith("p1", "/r", undefined);
	});

	it("plans-rename-title delegates to renamePlanTitle", async () => {
		const { renamePlanTitle } = await import("../core/PlanService.js");
		await runIdeBridgeAction("working-context", "/r", {
			operation: "plans-rename-title",
			slug: "p1",
			title: "New",
		});
		expect(renamePlanTitle).toHaveBeenCalledWith("p1", "New", "/r");
	});

	it("plans-archive-for-commit returns the PlanReference under `reference`", async () => {
		const [{ archivePlanForCommit }, { createStorage }] = await Promise.all([
			import("../core/PlanService.js"),
			import("../core/StorageFactory.js"),
		]);
		vi.mocked(archivePlanForCommit).mockResolvedValue({ slug: "p1-abc12345" } as never);
		vi.mocked(createStorage).mockResolvedValue({ tag: "storage" } as never);
		const result = await runIdeBridgeAction("working-context", "/r", {
			operation: "plans-archive-for-commit",
			slug: "p1",
			commitHash: "abc1234567",
		});
		// The 4th argument is the point of this assertion, not incidental detail.
		// `resolveStorage` fails safe: with storage omitted it silently falls back to a
		// bare OrphanBranchStorage, so a folder-mode user loses the Memory Bank copy
		// with only a debug.log warn. A three-argument expectation here previously
		// pinned that bug in place as the contract — keep storage in the assertion.
		expect(archivePlanForCommit).toHaveBeenCalledWith("p1", "abc1234567", "/r", { tag: "storage" });
		expect(result).toEqual({ reference: { slug: "p1-abc12345" } });
	});

	it("plans-cleanup-visible deletes the visible artifact with threaded storage", async () => {
		const [{ deletePlanVisibleArtifact }, { createStorage }] = await Promise.all([
			import("../core/SummaryStore.js"),
			import("../core/StorageFactory.js"),
		]);
		vi.mocked(createStorage).mockResolvedValue({ tag: "storage" } as never);
		const result = await runIdeBridgeAction("working-context", "/r", {
			operation: "plans-cleanup-visible",
			slug: "p1",
			branch: "feature/x",
		});
		expect(deletePlanVisibleArtifact).toHaveBeenCalledWith("p1", "feature/x", "/r", { tag: "storage" });
		expect(result).toEqual({ ok: true });
	});

	it("notes-detect returns the CLI's filtered note list", async () => {
		const { detectNotes } = await import("../core/NoteService.js");
		vi.mocked(detectNotes).mockResolvedValue([{ id: "n1" }] as never);
		const result = await runIdeBridgeAction("working-context", "/r", { operation: "notes-detect" });
		expect(result).toEqual({ notes: [{ id: "n1" }] });
	});

	it("notes-save forwards a create (no id) with its format", async () => {
		const { saveNote } = await import("../core/NoteService.js");
		vi.mocked(saveNote).mockResolvedValue({ id: "n1" } as never);
		const result = await runIdeBridgeAction("working-context", "/r", {
			operation: "notes-save",
			title: "T",
			content: "body",
			format: "snippet",
		});
		expect(saveNote).toHaveBeenCalledWith(undefined, "T", "body", "snippet", "/r");
		expect(result).toEqual({ note: { id: "n1" } });
	});

	it("notes-save forwards an update when an id is given", async () => {
		const { saveNote } = await import("../core/NoteService.js");
		vi.mocked(saveNote).mockResolvedValue({ id: "n1" } as never);
		await runIdeBridgeAction("working-context", "/r", {
			operation: "notes-save",
			id: "n1",
			title: "T",
			content: "/abs/path.md",
			format: "markdown",
		});
		expect(saveNote).toHaveBeenCalledWith("n1", "T", "/abs/path.md", "markdown", "/r");
	});

	// A bad format would otherwise reach saveNote and be persisted verbatim,
	// producing a row no reader can classify.
	it("notes-save rejects a format outside markdown/snippet", async () => {
		await expect(
			runIdeBridgeAction("working-context", "/r", {
				operation: "notes-save",
				title: "T",
				content: "c",
				format: "pdf",
			}),
		).rejects.toThrow(/must be "markdown" or "snippet"/);
	});

	it("notes-remove passes expectedCommitHash through", async () => {
		const { removeNote } = await import("../core/NoteService.js");
		await runIdeBridgeAction("working-context", "/r", {
			operation: "notes-remove",
			id: "n1",
			expectedCommitHash: "abc123",
		});
		expect(removeNote).toHaveBeenCalledWith("n1", "/r", "abc123");
	});

	it("references-remove delegates to removeReference", async () => {
		const { removeReference } = await import("../core/references/ReferenceService.js");
		await runIdeBridgeAction("working-context", "/r", {
			operation: "references-remove",
			mapKey: "jira:KAN-5",
		});
		expect(removeReference).toHaveBeenCalledWith("/r", "jira:KAN-5");
	});

	describe("context-list", () => {
		it("returns the four things the CONTEXT panel needs in one payload", async () => {
			const { detectPlans } = await import("../core/PlanService.js");
			const { detectNotes } = await import("../core/NoteService.js");
			const { loadPlansRegistry } = await import("../core/SessionTracker.js");
			const { readExclusions } = await import("../core/CommitSelectionStore.js");
			vi.mocked(detectPlans).mockResolvedValue([{ slug: "p1" }] as never);
			vi.mocked(detectNotes).mockResolvedValue([{ id: "n1" }] as never);
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				references: { "jira:KAN-5": { source: "jira" } },
			} as never);
			vi.mocked(readExclusions).mockResolvedValue({
				conversations: new Set(["c1"]),
				plans: new Set(["p1"]),
				notes: new Set<string>(),
				references: new Set<string>(),
				skills: new Set(["claude:brainstorming"]),
			});

			const result = await runIdeBridgeAction("working-context", "/r", { operation: "context-list" });

			expect(result).toEqual({
				plans: [{ slug: "p1" }],
				notes: [{ id: "n1" }],
				references: { "jira:KAN-5": { source: "jira" } },
				exclusions: {
					conversations: ["c1"],
					plans: ["p1"],
					notes: [],
					references: [],
					skills: ["claude:brainstorming"],
				},
			});
		});

		// A registry written before multi-source references existed has no such
		// field; the panel must get `{}`, not a missing key Gson turns into null.
		it("returns an empty references map when the registry omits the field", async () => {
			const { loadPlansRegistry } = await import("../core/SessionTracker.js");
			vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} } as never);
			const result = (await runIdeBridgeAction("working-context", "/r", { operation: "context-list" })) as {
				references: unknown;
			};
			expect(result.references).toEqual({});
		});

		// `skills` postdates the persisted shape. Absent on disk must still arrive
		// as [] — a Kotlin `Set` field left null throws on first use.
		it("materialises an absent skills exclude set as an empty array", async () => {
			const { readExclusions } = await import("../core/CommitSelectionStore.js");
			vi.mocked(readExclusions).mockResolvedValue({
				conversations: new Set<string>(),
				plans: new Set<string>(),
				notes: new Set<string>(),
				references: new Set<string>(),
			});
			const result = (await runIdeBridgeAction("working-context", "/r", { operation: "context-list" })) as {
				exclusions: { skills: unknown };
			};
			expect(result.exclusions.skills).toEqual([]);
		});
	});

	it("active-for-commit returns all three kinds plus the exclude set in one payload", async () => {
		const tracker = await import("../core/SessionTracker.js");
		const { readExclusions } = await import("../core/CommitSelectionStore.js");
		vi.mocked(tracker.detectActivePlansForBranch).mockResolvedValue([{ slug: "p1" }] as never);
		vi.mocked(tracker.detectActiveNotesForBranch).mockResolvedValue([{ id: "n1" }] as never);
		vi.mocked(tracker.detectUncommittedReferenceIds).mockResolvedValue([
			{ mapKey: "jira:KAN-5", source: "jira", sourcePath: "/p/KAN-5.md" },
		] as never);
		// The title is joined from the registry here so a host never re-reads
		// plans.json to label a row.
		vi.mocked(tracker.loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {},
			references: { "jira:KAN-5": { title: "Fix it" } },
		} as never);
		vi.mocked(readExclusions).mockResolvedValue({
			conversations: new Set<string>(),
			plans: new Set(["p1"]),
			notes: new Set<string>(),
			references: new Set<string>(),
		});

		const result = await runIdeBridgeAction("working-context", "/r", { operation: "active-for-commit" });

		expect(result).toEqual({
			plans: [{ slug: "p1" }],
			notes: [{ id: "n1" }],
			references: [{ mapKey: "jira:KAN-5", source: "jira", sourcePath: "/p/KAN-5.md", title: "Fix it" }],
			exclusions: {
				conversations: [],
				plans: ["p1"],
				notes: [],
				references: [],
				// Absent on disk must still arrive as [] — see context-list.
				skills: [],
			},
		});
	});

	// The branch argument is vestigial in all three CLI functions (working-area
	// context is not branch-scoped), but it must still be a string.
	it("active-for-commit defaults the vestigial branch argument to an empty string", async () => {
		const tracker = await import("../core/SessionTracker.js");
		await runIdeBridgeAction("working-context", "/r", { operation: "active-for-commit" });
		expect(tracker.detectActivePlansForBranch).toHaveBeenCalledWith("/r", "");
	});

	it("rejects an unknown operation", async () => {
		await expect(runIdeBridgeAction("working-context", "/r", { operation: "nope" })).rejects.toThrow(
			/Unknown working-context operation "nope"/,
		);
	});
});

describe("runIdeBridgeAction — session-state", () => {
	it("returns the global-config-dir", async () => {
		const result = await runIdeBridgeAction("session-state", "/r", { operation: "global-config-dir" });
		expect(result).toEqual({ path: "/global/config" });
	});

	it("builds a notes-dir under the jolli memory dir", async () => {
		const result = await runIdeBridgeAction("session-state", "/r", { operation: "notes-dir" });
		expect(result).toEqual({ path: join("/r", ".jolli", "jollimemory", "notes") });
	});

	it("loads config from a specific dir when dir is provided", async () => {
		const { loadConfigFromDir } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfigFromDir).mockResolvedValue({ jolliUrl: "x" } as never);
		const result = await runIdeBridgeAction("session-state", "/r", { operation: "config-load", dir: "/scoped" });
		expect(loadConfigFromDir).toHaveBeenCalledWith("/scoped");
		expect(result).toMatchObject({ jolliUrl: "x" });
	});

	it("loads the global config when no dir is given", async () => {
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({ jolliUrl: "y" } as never);
		const result = await runIdeBridgeAction("session-state", "/r", { operation: "config-load" });
		expect(loadConfig).toHaveBeenCalled();
		expect(result).toMatchObject({ jolliUrl: "y" });
	});

	it("saves config to a specific dir when dir is provided", async () => {
		const { saveConfigScoped } = await import("../core/SessionTracker.js");
		await runIdeBridgeAction("session-state", "/r", {
			operation: "config-save",
			config: { jolliUrl: "z" },
			dir: "/scoped",
		});
		expect(saveConfigScoped).toHaveBeenCalledWith({ jolliUrl: "z" }, "/scoped");
	});

	it("saves config to the global dir when dir is omitted", async () => {
		const { saveConfigScoped, getGlobalConfigDir } = await import("../core/SessionTracker.js");
		vi.mocked(getGlobalConfigDir).mockReturnValue("/global/config");
		await runIdeBridgeAction("session-state", "/r", { operation: "config-save", config: { x: 1 } });
		expect(saveConfigScoped).toHaveBeenCalledWith({ x: 1 }, "/global/config");
	});

	it("rejects config-save with a non-object config", async () => {
		await expect(
			runIdeBridgeAction("session-state", "/r", { operation: "config-save", config: "no" }),
		).rejects.toThrow(/"config"/);
	});

	it("loads plans registry on plans-load", async () => {
		const { loadPlansRegistry } = await import("../core/SessionTracker.js");
		vi.mocked(loadPlansRegistry).mockResolvedValue({ plans: [] } as never);
		const result = await runIdeBridgeAction("session-state", "/r", { operation: "plans-load" });
		expect(result).toEqual({ plans: [] });
	});

	it("saves plans registry on plans-save", async () => {
		const { savePlansRegistry } = await import("../core/SessionTracker.js");
		const registry = { plans: [{ slug: "a" }] };
		await runIdeBridgeAction("session-state", "/r", { operation: "plans-save", registry });
		expect(savePlansRegistry).toHaveBeenCalledWith(registry, "/r");
	});

	it("returns worker-busy state", async () => {
		const { getWorkerBusyState } = await import("../core/Locks.js");
		vi.mocked(getWorkerBusyState).mockResolvedValue({ held: true, blocking: false } as never);
		const result = await runIdeBridgeAction("session-state", "/r", { operation: "worker-busy" });
		expect(result).toEqual({ held: true, blocking: false });
	});

	it("records save-plugin-source", async () => {
		const { savePluginSource } = await import("../core/SessionTracker.js");
		await runIdeBridgeAction("session-state", "/r", { operation: "save-plugin-source" });
		expect(savePluginSource).toHaveBeenCalledWith("/r");
	});

	it("records save-squash-pending with hashes and parent", async () => {
		const { saveSquashPending } = await import("../core/SessionTracker.js");
		await runIdeBridgeAction("session-state", "/r", {
			operation: "save-squash-pending",
			sourceHashes: ["a", "b"],
			expectedParentHash: "p",
		});
		expect(saveSquashPending).toHaveBeenCalledWith(["a", "b"], "p", "/r");
	});

	it("rejects an unknown session-state operation", async () => {
		await expect(runIdeBridgeAction("session-state", "/r", { operation: "wat" })).rejects.toThrow(
			/Unknown session-state operation/,
		);
	});

	it("acquires plans.lock via the LockPrimitives.acquireWithPoll primitive", async () => {
		const { acquireWithPoll } = await import("../core/LockPrimitives.js");
		vi.mocked(acquireWithPoll).mockResolvedValue(true);
		const result = await runIdeBridgeAction("session-state", "/r", { operation: "acquire-lock" });
		expect(result).toEqual({ acquired: true });
		// The daemon must acquire against the per-worktree plans.lock path — a
		// wrong path (e.g. hitting the shared orphan-write dir) would silently
		// bypass every other plans.json writer.
		expect(vi.mocked(acquireWithPoll)).toHaveBeenCalledWith(join("/r", ".jolli", "jollimemory", "plans.lock"), {
			timeoutMs: 5000,
			pollMs: 25,
		});
	});

	it("reports acquired=false when the lock cannot be taken within the poll budget", async () => {
		const { acquireWithPoll } = await import("../core/LockPrimitives.js");
		vi.mocked(acquireWithPoll).mockResolvedValue(false);
		const result = await runIdeBridgeAction("session-state", "/r", { operation: "acquire-lock" });
		// A false return tells the IDE caller to skip or fall back to
		// best-effort — it must NOT be treated as a swallowed success.
		expect(result).toEqual({ acquired: false });
	});

	it("honours caller-supplied timeoutMs / pollMs on acquire-lock", async () => {
		const { acquireWithPoll } = await import("../core/LockPrimitives.js");
		vi.mocked(acquireWithPoll).mockResolvedValue(true);
		await runIdeBridgeAction("session-state", "/r", {
			operation: "acquire-lock",
			timeoutMs: 200,
			pollMs: 10,
		});
		expect(vi.mocked(acquireWithPoll)).toHaveBeenLastCalledWith(join("/r", ".jolli", "jollimemory", "plans.lock"), {
			timeoutMs: 200,
			pollMs: 10,
		});
	});

	it("releases plans.lock via LockPrimitives.releaseIfOwned (PID-checked)", async () => {
		// releaseIfOwned is deliberately a no-op when the on-disk PID does not
		// match the daemon's — the bridge just forwards the request; the
		// primitive is what enforces the safety check.
		const { releaseIfOwned } = await import("../core/LockPrimitives.js");
		const result = await runIdeBridgeAction("session-state", "/r", { operation: "release-lock" });
		expect(result).toEqual({ ok: true });
		expect(vi.mocked(releaseIfOwned)).toHaveBeenCalledWith(
			join("/r", ".jolli", "jollimemory", "plans.lock"),
			"plans.lock",
		);
	});
});

describe("runIdeBridgeAction — install / uninstall", () => {
	it("install forwards the full option surface to Installer.install", async () => {
		const { install } = await import("../install/Installer.js");
		vi.mocked(install).mockResolvedValueOnce({
			success: true,
			message: "ok",
			warnings: ["w1"],
		});
		const result = await runIdeBridgeAction("install", "/r", {
			source: "cli",
			sourceTag: "intellij",
			integrationsOnly: false,
			repoHooksOnly: false,
			respectManualDisable: false,
			clearManualDisableOnSuccess: true,
			automatic: false,
		});
		expect(install).toHaveBeenCalledWith("/r", {
			source: "cli",
			sourceTag: "intellij",
			integrationsOnly: false,
			repoHooksOnly: false,
			respectManualDisable: false,
			clearManualDisableOnSuccess: true,
			automatic: false,
		});
		expect(result).toEqual({ success: true, message: "ok", warnings: ["w1"] });
	});

	it("install coerces missing/non-boolean flags to false — a malformed request must NEVER accidentally opt into a mode", async () => {
		const { install } = await import("../install/Installer.js");
		vi.mocked(install).mockResolvedValueOnce({ success: true, message: "ok", warnings: [] });
		await runIdeBridgeAction("install", "/r", {
			source: "cli",
			sourceTag: "intellij",
			// integrationsOnly deliberately omitted — must land as false, not undefined
			respectManualDisable: "true", // non-boolean must NOT be treated as true
		});
		expect(install).toHaveBeenLastCalledWith("/r", {
			source: "cli",
			sourceTag: "intellij",
			integrationsOnly: false,
			repoHooksOnly: false,
			respectManualDisable: false,
			clearManualDisableOnSuccess: false,
			automatic: false,
		});
	});

	it("install rejects unknown source values, falling back to 'cli' — the source string feeds dist-path identity, so smuggling a novel value would fork the registry", async () => {
		const { install } = await import("../install/Installer.js");
		vi.mocked(install).mockResolvedValueOnce({ success: true, message: "ok", warnings: [] });
		await runIdeBridgeAction("install", "/r", { source: "windsurf-extension" });
		expect(install).toHaveBeenLastCalledWith("/r", expect.objectContaining({ source: "cli" }));
	});

	it("install propagates Installer.install's failure envelope verbatim so the caller can distinguish lock-contention from a hard error", async () => {
		const { install } = await import("../install/Installer.js");
		vi.mocked(install).mockResolvedValueOnce({
			success: false,
			message: "Another Jolli enable/disable operation is still running; retry shortly",
			warnings: [],
		});
		const result = await runIdeBridgeAction("install", "/r", { source: "cli", sourceTag: "intellij" });
		expect(result).toMatchObject({ success: false, message: expect.stringContaining("still running") });
	});

	// `distDir` decides what lands in `dist-paths/<tag>` — the path `run-hook` execs on
	// the blocking git path. `install`'s default is the running bundle's own directory,
	// which is correct in-process but wrong inside the daemon: it is launched from
	// `<IDE config>/plugins/**/cli-dist`, so the plugin would register a directory that
	// dies on uninstall or an IDE major upgrade, and `run-hook` exits silently by design.
	// These pin the forwarding, since nothing else in the suite covers where the entry
	// points — which is exactly how the regression got in.
	it("install forwards an explicit distDir to Installer.install", async () => {
		const { install } = await import("../install/Installer.js");
		vi.mocked(install).mockResolvedValueOnce({ success: true, message: "ok", warnings: [] });
		// A real directory: the bridge rejects a path that does not exist.
		await runIdeBridgeAction("install", "/r", { source: "cli", sourceTag: "intellij", distDir: tmpdir() });
		expect(install).toHaveBeenCalledWith("/r", expect.objectContaining({ distDir: tmpdir() }));
	});

	it("install leaves distDir undefined when omitted (in-process callers keep the old default)", async () => {
		const { install } = await import("../install/Installer.js");
		vi.mocked(install).mockResolvedValueOnce({ success: true, message: "ok", warnings: [] });
		await runIdeBridgeAction("install", "/r", { source: "cli", sourceTag: "cli" });
		expect(install).toHaveBeenCalledWith("/r", expect.objectContaining({ distDir: undefined }));
	});

	it("install rejects a relative distDir", async () => {
		// Relative would resolve against whatever cwd the hook happens to run in.
		const { install } = await import("../install/Installer.js");
		await expect(
			runIdeBridgeAction("install", "/r", { source: "cli", sourceTag: "intellij", distDir: "relative/dist" }),
		).rejects.toThrow(/"distDir" must be an absolute path/);
		expect(install).not.toHaveBeenCalled();
	});

	it("install rejects a distDir that does not exist", async () => {
		// A dead entry fails silently at hook time — reject it at the write boundary.
		const { install } = await import("../install/Installer.js");
		await expect(
			runIdeBridgeAction("install", "/r", {
				source: "cli",
				sourceTag: "intellij",
				distDir: join(tmpdir(), "jolli-definitely-not-here-12345"),
			}),
		).rejects.toThrow(/"distDir" does not exist/);
		expect(install).not.toHaveBeenCalled();
	});

	it("uninstall forwards the full option surface to Installer.uninstall", async () => {
		const { uninstall } = await import("../install/Installer.js");
		vi.mocked(uninstall).mockResolvedValueOnce({ success: true, message: "removed", warnings: [] });
		const result = await runIdeBridgeAction("uninstall", "/r", {
			integrationsOnly: false,
			preserveMenu: true,
			persistManualDisable: true,
		});
		expect(uninstall).toHaveBeenCalledWith("/r", {
			integrationsOnly: false,
			preserveMenu: true,
			persistManualDisable: true,
		});
		expect(result).toEqual({ success: true, message: "removed", warnings: [] });
	});

	// preserveMenu / persistManualDisable DERIVE from !integrationsOnly instead of
	// strict-casting like every other flag on this action. Omitting them used to mean
	// `false`, i.e. "a bare {} full disable also deletes the /jolli umbrella skill and
	// strips the jolli section from .git/info/exclude, and does NOT record that the user
	// asked for it" — so the next start silently reinstalled the hooks. The sibling
	// `case "disable"` has always derived; the two wrap the same uninstall() and must
	// not disagree.
	it("uninstall defaults an omitted full disable to preserveMenu + persistManualDisable", async () => {
		const { uninstall } = await import("../install/Installer.js");
		vi.mocked(uninstall).mockResolvedValueOnce({ success: true, message: "ok", warnings: [] });
		await runIdeBridgeAction("uninstall", "/r", {}); // all fields omitted
		expect(uninstall).toHaveBeenLastCalledWith("/r", {
			integrationsOnly: false,
			preserveMenu: true,
			persistManualDisable: true,
		});
	});

	it("uninstall derives both flags to false for an integrations-only teardown", async () => {
		const { uninstall } = await import("../install/Installer.js");
		vi.mocked(uninstall).mockResolvedValueOnce({ success: true, message: "ok", warnings: [] });
		await runIdeBridgeAction("uninstall", "/r", { integrationsOnly: true });
		expect(uninstall).toHaveBeenLastCalledWith("/r", {
			integrationsOnly: true,
			preserveMenu: false,
			persistManualDisable: false,
		});
	});

	it("uninstall honors an explicit false override on a full disable", async () => {
		// Deriving must not become "always true" — an explicit boolean still wins, which
		// is what keeps this action a plain adapter for callers that mean it.
		const { uninstall } = await import("../install/Installer.js");
		vi.mocked(uninstall).mockResolvedValueOnce({ success: true, message: "ok", warnings: [] });
		await runIdeBridgeAction("uninstall", "/r", { preserveMenu: false, persistManualDisable: false });
		expect(uninstall).toHaveBeenLastCalledWith("/r", {
			integrationsOnly: false,
			preserveMenu: false,
			persistManualDisable: false,
		});
	});

	it("uninstall ignores a non-boolean flag and falls back to the derived default", async () => {
		const { uninstall } = await import("../install/Installer.js");
		vi.mocked(uninstall).mockResolvedValueOnce({ success: true, message: "ok", warnings: [] });
		await runIdeBridgeAction("uninstall", "/r", { preserveMenu: "yes", persistManualDisable: 1 });
		expect(uninstall).toHaveBeenLastCalledWith("/r", {
			integrationsOnly: false,
			preserveMenu: true,
			persistManualDisable: true,
		});
	});
});

describe("runIdeBridgeAction — repo-profile", () => {
	it("reads the manual-disable flag through RepoProfile.readManualDisableFlag", async () => {
		const { readManualDisableFlag } = await import("../core/RepoProfile.js");
		// `…Once`, not `mockResolvedValue`: the suite runs with `clearMocks` only
		// (`restoreMocks` is deliberately omitted — see vite.config.ts), so history is
		// cleared between tests but a persistent implementation is NOT. A sticky `true`
		// here would silently become the default for every later test in this file.
		vi.mocked(readManualDisableFlag).mockResolvedValueOnce(true);
		const result = await runIdeBridgeAction("repo-profile", "/r", { operation: "read-manual-disable" });
		expect(readManualDisableFlag).toHaveBeenCalledWith("/r");
		expect(result).toEqual({ disabled: true });
	});

	it("writes the manual-disable flag through RepoProfile.writeManualDisableFlag", async () => {
		const { writeManualDisableFlag } = await import("../core/RepoProfile.js");
		const result = await runIdeBridgeAction("repo-profile", "/r", {
			operation: "write-manual-disable",
			disabled: true,
		});
		expect(writeManualDisableFlag).toHaveBeenCalledWith("/r", true);
		expect(result).toEqual({ ok: true });
	});

	// `disabled` is required, not coerced. This used to default to `false`, guarding
	// "an omitted field must never accidentally SET the opt-out" — but that trades the
	// visible, recoverable failure for the silent one: an accidental `true` shows the
	// DisabledPanel and is one click from undone, whereas an accidental `false` resumes
	// capture in a repo the user turned off AND erases the record of that intent, with
	// no UI signal anywhere. That is precisely the silent re-enable spec 306 exists to
	// prevent. Neither default is right for a field that IS the write's payload, so a
	// malformed request fails loudly and writes nothing — which preserves the original
	// property (never accidentally disables) and closes the one it missed.
	it("write-manual-disable rejects a missing `disabled` instead of coercing it", async () => {
		const { writeManualDisableFlag } = await import("../core/RepoProfile.js");
		await expect(runIdeBridgeAction("repo-profile", "/r", { operation: "write-manual-disable" })).rejects.toThrow(
			/"disabled" must be a boolean/,
		);
		expect(writeManualDisableFlag).not.toHaveBeenCalled();
	});

	it("write-manual-disable rejects a non-boolean `disabled` instead of coercing it", async () => {
		const { writeManualDisableFlag } = await import("../core/RepoProfile.js");
		await expect(
			runIdeBridgeAction("repo-profile", "/r", { operation: "write-manual-disable", disabled: "true" }),
		).rejects.toThrow(/"disabled" must be a boolean/);
		expect(writeManualDisableFlag).not.toHaveBeenCalled();
	});

	it("write-manual-disable forwards an explicit false (the re-enable path still works)", async () => {
		const { writeManualDisableFlag } = await import("../core/RepoProfile.js");
		const result = await runIdeBridgeAction("repo-profile", "/r", {
			operation: "write-manual-disable",
			disabled: false,
		});
		expect(writeManualDisableFlag).toHaveBeenCalledWith("/r", false);
		expect(result).toEqual({ ok: true });
	});

	it("rejects an unknown repo-profile operation", async () => {
		await expect(runIdeBridgeAction("repo-profile", "/r", { operation: "wat" })).rejects.toThrow(
			/Unknown repo-profile operation/,
		);
	});
});

describe("runIdeBridgeAction — auth", () => {
	it("returns the site url", async () => {
		expect(await runIdeBridgeAction("auth", "/r", { operation: "site-url" })).toEqual({ url: "https://jolli.ai" });
	});

	it("reports signed-in true when an auth token is present", async () => {
		const auth = await import("../auth/AuthConfig.js");
		vi.mocked(auth.loadAuthToken).mockResolvedValue("tok");
		expect(await runIdeBridgeAction("auth", "/r", { operation: "is-signed-in" })).toEqual({ signedIn: true });
	});

	it("reports signed-in false when no auth token is present", async () => {
		const auth = await import("../auth/AuthConfig.js");
		vi.mocked(auth.loadAuthToken).mockResolvedValue(undefined);
		expect(await runIdeBridgeAction("auth", "/r", { operation: "is-signed-in" })).toEqual({ signedIn: false });
	});

	it("parses an API key and returns meta", async () => {
		const { parseJolliApiKey } = await import("../core/JolliApiUtils.js");
		vi.mocked(parseJolliApiKey).mockReturnValue({ u: "u" } as never);
		const result = await runIdeBridgeAction("auth", "/r", { operation: "parse-api-key", apiKey: "sk-jol-x" });
		expect(result).toEqual({ meta: { u: "u" } });
	});

	it("validates an API key", async () => {
		expect(await runIdeBridgeAction("auth", "/r", { operation: "validate-api-key", apiKey: "sk" })).toEqual({
			ok: true,
		});
	});

	it("asserts an origin is allowed", async () => {
		expect(
			await runIdeBridgeAction("auth", "/r", { operation: "assert-origin", origin: "https://jolli.ai" }),
		).toEqual({ ok: true });
	});

	it("reports should-request-fresh based on config", async () => {
		const auth = await import("../auth/AuthConfig.js");
		vi.mocked(auth.shouldRequestFreshApiKey).mockReturnValue(true);
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "should-request-fresh",
			existingKey: undefined,
			jolliUrl: "https://jolli.ai",
		});
		expect(result).toEqual({ fresh: true });
	});

	it("builds a login url with all optional fields", async () => {
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli.ai",
			callbackUrl: "http://localhost:1/cb",
			clientVersion: "1.0.0",
			generateApiKey: true,
			installId: "abc",
		});
		expect(typeof (result as { url: string }).url).toBe("string");
		const url = new URL((result as { url: string }).url);
		expect(url.pathname).toBe("/login");
		expect(url.searchParams.get("client")).toBe("intellij");
		expect(url.searchParams.get("generate_api_key")).toBe("true");
		expect(url.searchParams.get("install_id")).toBe("abc");
	});

	it("omits generate_api_key when not truthy and skips install_id when absent", async () => {
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli.ai",
			callbackUrl: "http://localhost:1/cb",
			clientVersion: "1.0.0",
		});
		const url = new URL((result as { url: string }).url);
		expect(url.searchParams.has("generate_api_key")).toBe(false);
		expect(url.searchParams.has("install_id")).toBe(false);
	});

	it("exchanges and saves credentials, forwarding the api key when returned", async () => {
		const { exchangeCliCode } = await import("../auth/CliExchange.js");
		const auth = await import("../auth/AuthConfig.js");
		vi.mocked(exchangeCliCode).mockResolvedValue({ token: "tok", jolliApiKey: "sk-jol-x" } as never);
		vi.mocked(auth.resolveSignInJolliUrl).mockReturnValue("https://jolli.ai");
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "exchange-and-save",
			jolliUrl: "https://jolli.ai",
			code: "code",
		});
		expect(auth.saveAuthCredentials).toHaveBeenCalledWith({
			token: "tok",
			jolliUrl: "https://jolli.ai",
			jolliApiKey: "sk-jol-x",
		});
		expect(result).toEqual({ token: "tok", jolliApiKey: "sk-jol-x" });
	});

	it("exchanges without an api key when the server does not return one", async () => {
		const { exchangeCliCode } = await import("../auth/CliExchange.js");
		const auth = await import("../auth/AuthConfig.js");
		vi.mocked(exchangeCliCode).mockResolvedValue({ token: "tok" } as never);
		vi.mocked(auth.resolveSignInJolliUrl).mockReturnValue("https://jolli.ai");
		await runIdeBridgeAction("auth", "/r", {
			operation: "exchange-and-save",
			jolliUrl: "https://jolli.ai",
			code: "c",
		});
		expect(auth.saveAuthCredentials).toHaveBeenCalledWith({ token: "tok", jolliUrl: "https://jolli.ai" });
	});

	it("signs out", async () => {
		const auth = await import("../auth/AuthConfig.js");
		await runIdeBridgeAction("auth", "/r", { operation: "sign-out" });
		expect(auth.clearAuthCredentials).toHaveBeenCalled();
	});

	it("builds a login url carrying the top-level CSRF state param", async () => {
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli.ai",
			callbackUrl: "http://localhost:1/cb",
			state: "abc123",
			clientVersion: "1.0.0",
		});
		const url = new URL((result as { url: string }).url);
		expect(url.searchParams.get("state")).toBe("abc123");
	});

	it("omits state when not provided", async () => {
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli.ai",
			callbackUrl: "http://localhost:1/cb",
			clientVersion: "1.0.0",
		});
		expect(new URL((result as { url: string }).url).searchParams.has("state")).toBe(false);
	});

	it("keeps a path-based tenant prefix in the login url", async () => {
		// `new URL("/login", "https://jolli-local.me/dev")` drops `/dev` — a
		// root-relative path resolves against the origin. Path-based tenants
		// would 404 on their own login page.
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli-local.me/dev",
			callbackUrl: "http://localhost:1/cb",
			clientVersion: "1.0.0",
		});
		expect(new URL((result as { url: string }).url).pathname).toBe("/dev/login");
	});

	it("pins the login url param order, sharing VS Code's leading six", async () => {
		// A pinned order keeps the surfaces' URLs visually comparable in captures
		// and server logs, and protects against silent drift when one surface is
		// refactored in isolation. The first six match VS Code verbatim;
		// `install_id` is appended last because VS Code sends none. The CLI emits
		// the same params but puts `install_id` BEFORE `generate_api_key`, so
		// this is not a three-way byte-identical order — see the note in
		// `IdeBridgeCommand.ts`'s `build-login-url` branch before "fixing" it.
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli.ai",
			callbackUrl: "http://localhost:1/cb",
			state: "st",
			clientVersion: "1.0.0",
			generateApiKey: true,
			installId: "inst",
		});
		expect([...new URL((result as { url: string }).url).searchParams.keys()]).toEqual([
			"cli_callback",
			"state",
			"client",
			"client_version",
			"generate_api_key",
			"device_name",
			"install_id",
		]);
	});

	it("pairs device_name with generate_api_key so a second machine keeps its own key", async () => {
		// The server scopes its per-user idempotency key by device_name. Without
		// it, signing in from a second machine invalidates the first machine's
		// auto-minted API key. Only sent when we're asking for a fresh key —
		// on a plain re-auth there is no key being minted to scope.
		const withKey = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli.ai",
			callbackUrl: "http://localhost:1/cb",
			clientVersion: "1.0.0",
			generateApiKey: true,
		});
		expect(new URL((withKey as { url: string }).url).searchParams.get("device_name")).toBe("test-box");

		const withoutKey = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli.ai",
			callbackUrl: "http://localhost:1/cb",
			clientVersion: "1.0.0",
		});
		expect(new URL((withoutKey as { url: string }).url).searchParams.has("device_name")).toBe(false);
	});

	it("omits device_name when the hostname sanitizes to nothing", async () => {
		const { getDeviceLabel } = await import("../auth/DeviceLabel.js");
		vi.mocked(getDeviceLabel).mockReturnValueOnce(undefined);
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli.ai",
			callbackUrl: "http://localhost:1/cb",
			clientVersion: "1.0.0",
			generateApiKey: true,
		});
		expect(new URL((result as { url: string }).url).searchParams.has("device_name")).toBe(false);
	});

	it("percent-encodes an unusual client_version defensively", async () => {
		// Normal semver and the "0.0.0" sentinel are URL-safe, but a pre-release
		// tag with `+` or whitespace would otherwise be lost in transit.
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "build-login-url",
			jolliUrl: "https://jolli.ai",
			callbackUrl: "http://localhost:1/cb",
			clientVersion: "1.4.2+build 7",
		});
		expect((result as { url: string }).url).toContain("client_version=1.4.2%2Bbuild+7");
	});

	it("handle-auth-callback: succeeds via code exchange", async () => {
		const { exchangeCliCode } = await import("../auth/CliExchange.js");
		const auth = await import("../auth/AuthConfig.js");
		vi.mocked(exchangeCliCode).mockResolvedValue({
			token: "tok",
			jolliApiKey: "sk-jol-x",
			space: "sp",
		} as never);
		vi.mocked(auth.resolveSignInJolliUrl).mockReturnValue("https://jolli.ai");
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli.ai",
			queryString: "state=s1&code=c1",
			expectedState: "s1",
		});
		expect(result).toEqual({
			success: true,
			redirectUrl: "https://jolli.ai/cli-complete",
			token: "tok",
			space: "sp",
			jolliApiKey: "sk-jol-x",
		});
		expect(auth.saveAuthCredentials).toHaveBeenCalledWith({
			token: "tok",
			jolliUrl: "https://jolli.ai",
			jolliApiKey: "sk-jol-x",
		});
	});

	it("handle-auth-callback: accepts the legacy ?token= shape without a CSRF check", async () => {
		// Mirrors main CLI / VS Code: pre-code-exchange servers never echo
		// `state`, so demanding it on the legacy branch would lock those
		// tenants out of sign-in. The code-branch CSRF check is still there
		// (covered by other tests) — this one just verifies the legacy branch
		// is accepted end-to-end.
		const auth = await import("../auth/AuthConfig.js");
		vi.mocked(auth.resolveSignInJolliUrl).mockReturnValue("https://jolli.ai");
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli.ai",
			queryString: "token=legacy-tok&jolli_api_key=sk-jol-y&space=sp2",
			expectedState: "s1",
		});
		expect(result).toEqual({
			success: true,
			redirectUrl: "https://jolli.ai/cli-complete",
			token: "legacy-tok",
			space: "sp2",
			jolliApiKey: "sk-jol-y",
		});
		expect(auth.saveAuthCredentials).toHaveBeenCalledWith({
			token: "legacy-tok",
			jolliUrl: "https://jolli.ai",
			jolliApiKey: "sk-jol-y",
		});
	});

	it("handle-auth-callback: names the caller's own retry path on user_denied", async () => {
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli.ai",
			queryString: "error=user_denied",
			expectedState: "s1",
			retryHint: "You can try again from Settings.",
		});
		expect(result).toMatchObject({
			errorMessage: "Sign-in was cancelled. You can try again from Settings.",
		});
	});

	it("handle-auth-callback: reports a server error code even when no state comes back", async () => {
		// The `?error=` redirect carries no `state` either — a state check ahead
		// of it would report a plain user cancellation as a CSRF attack.
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli.ai",
			queryString: "error=user_denied",
			expectedState: "s1",
		});
		expect(result).toEqual({
			success: false,
			redirectUrl: "https://jolli.ai/cli-complete?error=user_denied",
			errorCode: "user_denied",
			// A code, not a sentence, is what the IDE balloon used to show.
			errorMessage: "Sign-in was cancelled. You can try again.",
		});
	});

	it("handle-auth-callback: rejects a code callback whose state does not match", async () => {
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli.ai",
			queryString: "state=wrong&code=c1",
			expectedState: "expected",
		});
		expect(result).toEqual({
			success: false,
			redirectUrl: "https://jolli.ai/cli-complete?error=invalid_callback",
			errorCode: "invalid_callback",
			errorMessage: "Invalid sign-in callback (state mismatch). Please try again.",
		});
	});

	it("handle-auth-callback: rejects a code callback with no state at all", async () => {
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli.ai",
			queryString: "code=c1",
			expectedState: "expected",
		});
		expect(result).toMatchObject({ success: false, errorCode: "invalid_callback" });
	});

	it("handle-auth-callback: fails when neither code nor token is present", async () => {
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli.ai",
			queryString: "state=s1",
			expectedState: "s1",
		});
		expect(result).toEqual({
			success: false,
			redirectUrl: "https://jolli.ai/cli-complete?error=invalid_callback",
			errorCode: "invalid_callback",
			errorMessage: "No authorization code or token received",
		});
	});

	it("handle-auth-callback: keeps a path-based tenant prefix on both redirect targets", async () => {
		const { exchangeCliCode } = await import("../auth/CliExchange.js");
		const auth = await import("../auth/AuthConfig.js");
		vi.mocked(exchangeCliCode).mockResolvedValueOnce({ token: "tok" } as never);
		vi.mocked(auth.resolveSignInJolliUrl).mockReturnValue("https://jolli-local.me/dev");
		const ok = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli-local.me/dev",
			queryString: "state=s1&code=c1",
			expectedState: "s1",
		});
		expect(ok).toMatchObject({ redirectUrl: "https://jolli-local.me/dev/cli-complete" });
		const failed = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli-local.me/dev/",
			queryString: "state=s1",
			expectedState: "s1",
		});
		expect(failed).toMatchObject({
			redirectUrl: "https://jolli-local.me/dev/cli-complete?error=invalid_callback",
		});
	});

	it("handle-auth-callback: reports a failed credential write instead of throwing", async () => {
		// saveAuthCredentials rejects a malformed key, an off-allowlist origin,
		// and a key minted for a different tenant. Those must come back as a
		// structured failure, not as a bridge-level exception.
		const { exchangeCliCode } = await import("../auth/CliExchange.js");
		const auth = await import("../auth/AuthConfig.js");
		vi.mocked(exchangeCliCode).mockResolvedValueOnce({
			token: "tok",
			jolliApiKey: "sk-jol-other-tenant",
		} as never);
		vi.mocked(auth.resolveSignInJolliUrl).mockReturnValue("https://jolli.ai");
		vi.mocked(auth.saveAuthCredentials).mockRejectedValueOnce(new Error("Server returned a Jolli API key…"));
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli.ai",
			queryString: "state=s1&code=c1",
			expectedState: "s1",
		});
		expect(result).toEqual({
			success: false,
			redirectUrl: "https://jolli.ai/cli-complete?error=failed_to_get_token",
			errorCode: "failed_to_get_token",
			errorMessage: "Server returned a Jolli API key…",
		});
	});

	it("handle-auth-callback: returns failed_to_get_token when code exchange throws", async () => {
		const { exchangeCliCode } = await import("../auth/CliExchange.js");
		vi.mocked(exchangeCliCode).mockRejectedValue(new Error("Sign-in code expired or already used"));
		const result = await runIdeBridgeAction("auth", "/r", {
			operation: "handle-auth-callback",
			jolliUrl: "https://jolli.ai",
			queryString: "state=s1&code=bad",
			expectedState: "s1",
		});
		expect(result).toEqual({
			success: false,
			redirectUrl: "https://jolli.ai/cli-complete?error=failed_to_get_token",
			errorCode: "failed_to_get_token",
			errorMessage: "Sign-in code expired or already used",
		});
	});

	it("rejects an unknown auth operation", async () => {
		await expect(runIdeBridgeAction("auth", "/r", { operation: "bogus" })).rejects.toThrow(
			/Unknown auth operation/,
		);
	});
});

describe("runIdeBridgeAction — jolli-api", () => {
	// `_mockedLoggerCalls` is `vi.hoisted` and shared across every jolli-api test
	// (createLogger returns the same object every call). Without this reset a
	// warn recorded by an earlier test would leak into a later one's
	// "does NOT emit the drift warning" assertion — a silent false negative that
	// still passes locally but flakes under different test ordering. beforeEach
	// makes the reset unconditional and removes the burden from each test.
	beforeEach(() => {
		_mockedLoggerCalls.warn.mockClear();
		_mockedLoggerCalls.info.mockClear();
		_mockedLoggerCalls.debug.mockClear();
		_mockedLoggerCalls.error.mockClear();
	});

	it("serializes a summary to JSON", async () => {
		const { serializeSummaryJson } = await import("../core/JolliMemoryPushOrchestrator.js");
		vi.mocked(serializeSummaryJson).mockReturnValue('{"s":1}');
		const result = await runIdeBridgeAction("jolli-api", "/r", { operation: "serialize-summary", summary: {} });
		expect(result).toEqual({ json: '{"s":1}' });
	});

	it("returns json:null when serializer returns undefined", async () => {
		const { serializeSummaryJson } = await import("../core/JolliMemoryPushOrchestrator.js");
		vi.mocked(serializeSummaryJson).mockReturnValue(undefined);
		const result = await runIdeBridgeAction("jolli-api", "/r", { operation: "serialize-summary", summary: {} });
		expect(result).toEqual({ json: null });
	});

	it("pushes a payload via JolliMemoryPushClient", async () => {
		const result = await runIdeBridgeAction("jolli-api", "/r", {
			operation: "push",
			apiKey: "sk",
			baseUrl: "https://api",
			payload: { a: 1 },
		});
		expect(result).toEqual({ ok: true });
	});

	it("deletes a doc via JolliMemoryPushClient", async () => {
		expect(await runIdeBridgeAction("jolli-api", "/r", { operation: "delete", apiKey: "sk", docId: 7 })).toEqual({
			ok: true,
		});
	});

	it("blocks push and delete when outbound push is disabled for the repo (spec 306)", async () => {
		const { isOutboundPushAllowed } = await import("../core/PushControl.js");
		vi.mocked(isOutboundPushAllowed).mockResolvedValue(false);
		await expect(
			runIdeBridgeAction("jolli-api", "/repo", { operation: "push", apiKey: "sk", payload: { a: 1 } }),
		).rejects.toThrow(/Outbound push is disabled/);
		await expect(
			runIdeBridgeAction("jolli-api", "/repo", { operation: "delete", apiKey: "sk", docId: 7 }),
		).rejects.toThrow(/Outbound push is disabled/);
		expect(isOutboundPushAllowed).toHaveBeenCalledWith("/repo");
	});

	// The refusal crosses the bridge as `data.errorName` (see
	// `copyPrimitiveErrorFields`), and IntelliJ's `remapBridgeException` keys off
	// that exact string to reach its quiet "re-enable to push" handling. A bare
	// `Error` here (name "Error") falls through to the host's generic
	// RuntimeException, mislabelling a user opt-out as a push failure.
	it.each(["push", "delete"] as const)(
		"names the %s refusal PushDisabledError so IDE hosts can map it",
		async (operation) => {
			const { isOutboundPushAllowed } = await import("../core/PushControl.js");
			vi.mocked(isOutboundPushAllowed).mockResolvedValue(false);
			const request = operation === "push" ? { payload: { a: 1 } } : { docId: 7 };
			const error = await runIdeBridgeAction("jolli-api", "/repo", {
				operation,
				apiKey: "sk",
				...request,
			}).catch((e: unknown) => e);
			expect((error as Error).name).toBe("PushDisabledError");
		},
	);

	it("still allows non-push reads (list-spaces) when push is disabled", async () => {
		const { isOutboundPushAllowed } = await import("../core/PushControl.js");
		vi.mocked(isOutboundPushAllowed).mockResolvedValue(false);
		expect(await runIdeBridgeAction("jolli-api", "/repo", { operation: "list-spaces", apiKey: "sk" })).toEqual({
			spaces: [],
			defaultSpaceId: null,
		});
	});

	it("lists spaces", async () => {
		expect(await runIdeBridgeAction("jolli-api", "/r", { operation: "list-spaces", apiKey: "sk" })).toEqual({
			spaces: [],
			defaultSpaceId: null,
		});
	});

	it("creates a binding", async () => {
		expect(
			await runIdeBridgeAction("jolli-api", "/r", {
				operation: "create-binding",
				apiKey: "sk",
				repoUrl: "u",
				repoName: "n",
				jmSpaceId: 3,
			}),
		).toEqual({ ok: true });
	});

	it("creates a live share", async () => {
		expect(
			await runIdeBridgeAction("jolli-api", "/r", { operation: "create-share", apiKey: "sk", payload: {} }),
		).toEqual({ shareId: "s1" });
	});

	it("updates a live share", async () => {
		expect(
			await runIdeBridgeAction("jolli-api", "/r", {
				operation: "update-share",
				apiKey: "sk",
				shareId: "s1",
				patch: {},
			}),
		).toEqual({ ok: true });
	});

	it("revokes a live share", async () => {
		expect(
			await runIdeBridgeAction("jolli-api", "/r", { operation: "revoke-share", apiKey: "sk", shareId: "s1" }),
		).toEqual({ ok: true });
	});

	it("invites to a live share with a message", async () => {
		expect(
			await runIdeBridgeAction("jolli-api", "/r", {
				operation: "invite-share",
				apiKey: "sk",
				shareId: "s1",
				recipients: ["a@x", "b@x"],
				message: "hi",
			}),
		).toEqual({ invited: 1 });
	});

	it("invites to a live share without a message", async () => {
		expect(
			await runIdeBridgeAction("jolli-api", "/r", {
				operation: "invite-share",
				apiKey: "sk",
				shareId: "s1",
				recipients: [],
			}),
		).toEqual({ invited: 1 });
	});

	it("lists org members", async () => {
		expect(await runIdeBridgeAction("jolli-api", "/r", { operation: "list-org-members", apiKey: "sk" })).toEqual({
			members: [{ id: 1 }],
		});
	});

	it("rejects an unknown jolli-api operation", async () => {
		await expect(runIdeBridgeAction("jolli-api", "/r", { operation: "wat", apiKey: "sk" })).rejects.toThrow(
			/Unknown Jolli API operation/,
		);
	});

	it("threads clientHeader into JolliMemoryPushClient's clientHeaderOverride", async () => {
		// IntelliJ / VS Code stamp the plugin's own `x-jolli-client` value on
		// each jolli-api request so their HTTP identifies as
		// `intellij-plugin/<plugin-version>` rather than the bundled CLI's
		// `cli/<cli-version>`. This asserts the runJolliApiAction wiring — a
		// silent drop here reroutes surface identity across the whole plugin.
		const { JolliMemoryPushClient } = await import("../core/JolliMemoryPushClient.js");
		const mock = vi.mocked(JolliMemoryPushClient);
		mock.mockClear();
		await runIdeBridgeAction("jolli-api", "/r", {
			operation: "list-spaces",
			apiKey: "sk",
			clientHeader: "intellij-plugin/0.99.4",
		});
		expect(mock).toHaveBeenCalledWith(expect.objectContaining({ clientHeaderOverride: "intellij-plugin/0.99.4" }));
	});

	it("threads clientHeader into JolliShareClient's clientHeaderOverride opt", async () => {
		const { JolliShareClient } = await import("../core/JolliShareClient.js");
		const mock = vi.mocked(JolliShareClient);
		mock.mockClear();
		await runIdeBridgeAction("jolli-api", "/r", {
			operation: "revoke-share",
			apiKey: "sk",
			shareId: "s1",
			clientHeader: "intellij-plugin/0.99.4",
		});
		expect(mock).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: "sk", clientHeaderOverride: "intellij-plugin/0.99.4" }),
		);
	});

	it("omits clientHeaderOverride when the caller sends no clientHeader (CLI-initiated call)", async () => {
		// Bare `jolli` (no plugin) hits this same code path when we surface the
		// jolli-api operations directly in the future. Absent → the client's
		// default JOLLI_CLIENT_HEADER wins.
		const { JolliMemoryPushClient } = await import("../core/JolliMemoryPushClient.js");
		const mock = vi.mocked(JolliMemoryPushClient);
		mock.mockClear();
		await runIdeBridgeAction("jolli-api", "/r", { operation: "list-spaces", apiKey: "sk" });
		const call = mock.mock.calls[0]?.[0] ?? {};
		expect(call).not.toHaveProperty("clientHeaderOverride");
	});

	it("logs a drift warning when a network jolli-api op arrives without a clientHeader", async () => {
		// Catches a future IDE-surface caller that forgets to stamp its plugin
		// identity — the CLI would otherwise silently misidentify as the bundled
		// build, evading per-surface min-version gates + skewing API attribution.
		await runIdeBridgeAction("jolli-api", "/r", { operation: "list-spaces", apiKey: "sk" });
		const messages = _mockedLoggerCalls.warn.mock.calls.map((c) => String(c[0]));
		expect(messages.some((m) => m.includes("no clientHeader provided"))).toBe(true);
	});

	it("does NOT emit the drift warning for the local-only serialize-summary op", async () => {
		// serialize-summary never hits the network — logging a warning there
		// would false-positive on every push-preview refresh.
		await runIdeBridgeAction("jolli-api", "/r", { operation: "serialize-summary", summary: {} });
		const messages = _mockedLoggerCalls.warn.mock.calls.map((c) => String(c[0]));
		expect(messages.some((m) => m.includes("no clientHeader provided"))).toBe(false);
	});

	it("does NOT emit the drift warning when clientHeader is present", async () => {
		await runIdeBridgeAction("jolli-api", "/r", {
			operation: "list-spaces",
			apiKey: "sk",
			clientHeader: "intellij-plugin/0.99.4",
		});
		const messages = _mockedLoggerCalls.warn.mock.calls.map((c) => String(c[0]));
		expect(messages.some((m) => m.includes("no clientHeader provided"))).toBe(false);
	});
});

describe("runIdeBridgeAction — pricing", () => {
	it("computes a sonnet cost estimate", async () => {
		const { estimateConversationCostUsd } = await import("../core/TokenCost.js");
		vi.mocked(estimateConversationCostUsd).mockReturnValue(0.75);
		const result = await runIdeBridgeAction("pricing", "/r", {
			operation: "sonnet-cost",
			breakdown: {},
			totalTokens: 1000,
		});
		expect(result).toEqual({ costUsd: 0.75 });
	});

	it("reports the provider for a known model", async () => {
		expect(await runIdeBridgeAction("pricing", "/r", { operation: "provider", model: "gpt-4" })).toEqual({
			provider: "openai",
		});
	});

	it("falls back to 'unknown' for an unknown model", async () => {
		expect(await runIdeBridgeAction("pricing", "/r", { operation: "provider", model: "not-a-model" })).toEqual({
			provider: "unknown",
		});
	});

	it("computes a model cost estimate", async () => {
		expect(
			await runIdeBridgeAction("pricing", "/r", { operation: "model-cost", usage: { model: "gpt-4" } }),
		).toEqual({ costUsd: 0.25 });
	});

	it("computes a total cost across usages", async () => {
		expect(await runIdeBridgeAction("pricing", "/r", { operation: "total-cost", usages: [] })).toEqual({
			totalUsd: 1.5,
		});
	});

	it("rejects an unknown pricing operation", async () => {
		await expect(runIdeBridgeAction("pricing", "/r", { operation: "guess" })).rejects.toThrow(
			/Unknown pricing operation/,
		);
	});
});

describe("runIdeBridgeAction — shared-store", () => {
	// pins-*, selection-*, branch-share-*, push-pending-hashes, repo-profile-*,
	// summary-markdown, summary-pr-markdown, pr-wrap-markdown, pr-replace-markdown,
	// reference-push-presentation.

	it("reads pins", async () => {
		const { listPins } = await import("../core/PinStore.js");
		vi.mocked(listPins).mockResolvedValue([{ id: "p" }] as never);
		expect(await runIdeBridgeAction("shared-store", "/r", { operation: "pins-read" })).toEqual({
			pins: [{ id: "p" }],
		});
	});

	it("adds a conversation pin, mapping the plural kind + carrying badge as source", async () => {
		const { addPin } = await import("../core/PinStore.js");
		await runIdeBridgeAction("shared-store", "/r", {
			operation: "pins-add",
			kind: "conversations",
			key: "id-1",
			title: "T",
			badge: "codex",
		});
		expect(addPin).toHaveBeenCalledWith(
			"/r",
			"repo",
			"main",
			expect.objectContaining({ kind: "conversation", id: "id-1", title: "T", badge: "codex", source: "codex" }),
		);
	});

	it("adds a plan pin without a source field when badge is absent", async () => {
		const { addPin } = await import("../core/PinStore.js");
		await runIdeBridgeAction("shared-store", "/r", {
			operation: "pins-add",
			kind: "plans",
			key: "p",
			title: "Plan",
		});
		const arg = vi.mocked(addPin).mock.calls[0][3];
		expect(arg.source).toBeUndefined();
	});

	it("removes a pin", async () => {
		const { removePin } = await import("../core/PinStore.js");
		await runIdeBridgeAction("shared-store", "/r", {
			operation: "pins-remove",
			kind: "notes",
			key: "n",
		});
		expect(removePin).toHaveBeenCalledWith("/r", "repo", "main", "note", "n");
	});

	it("accepts every valid singular pin kind", async () => {
		const { addPin } = await import("../core/PinStore.js");
		for (const kind of ["conversation", "plan", "note", "memory", "reference"] as const) {
			await runIdeBridgeAction("shared-store", "/r", {
				operation: "pins-add",
				kind,
				key: `k-${kind}`,
				title: "T",
			});
		}
		expect(addPin).toHaveBeenCalledTimes(5);
	});

	it("rejects an unknown pin kind", async () => {
		await expect(
			runIdeBridgeAction("shared-store", "/r", { operation: "pins-add", kind: "wat", key: "k", title: "t" }),
		).rejects.toThrow(/Unknown pin kind/);
	});

	it("falls back to the project root basename when there is no remote URL", async () => {
		const { addPin } = await import("../core/PinStore.js");
		const { getCanonicalRepoUrl, getProjectRootDir } = await Promise.all([
			import("../core/GitRemoteUtils.js"),
			import("../core/GitOps.js"),
		]).then(([r, o]) => ({
			getCanonicalRepoUrl: r.getCanonicalRepoUrl,
			getProjectRootDir: o.getProjectRootDir,
		}));
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("");
		vi.mocked(getProjectRootDir).mockResolvedValue("/my/project");
		await runIdeBridgeAction("shared-store", "/r", { operation: "pins-add", kind: "plan", key: "k", title: "t" });
		expect(addPin).toHaveBeenCalledWith(
			"/r",
			"project", // basename of /my/project
			"main",
			expect.anything(),
		);
	});

	it("falls back to cwd basename when getProjectRootDir throws", async () => {
		const { addPin } = await import("../core/PinStore.js");
		const { getCanonicalRepoUrl } = await import("../core/GitRemoteUtils.js");
		const { getProjectRootDir } = await import("../core/GitOps.js");
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("");
		vi.mocked(getProjectRootDir).mockRejectedValue(new Error("no git"));
		await runIdeBridgeAction("shared-store", "/repo-fallback", {
			operation: "pins-add",
			kind: "plan",
			key: "k",
			title: "t",
		});
		expect(addPin).toHaveBeenCalledWith("/repo-fallback", "repo-fallback", "main", expect.anything());
	});

	// `skills` is absent from the mocked value on purpose: it postdates the persisted
	// shape, so `readExclusions` omits it for a selection file written before skills
	// were selectable. The response must still carry the key as an empty array — a
	// caller that saw it vanish could not tell "nothing excluded" from "this CLI is
	// too old to know about skills".
	it("reads selection exclusions as arrays, defaulting an absent skills set to empty", async () => {
		const { readExclusions } = await import("../core/CommitSelectionStore.js");
		vi.mocked(readExclusions).mockResolvedValue({
			conversations: new Set(["c"]),
			plans: new Set(),
			notes: new Set(),
			references: new Set(),
		} as never);
		const result = await runIdeBridgeAction("shared-store", "/r", { operation: "selection-read" });
		expect(result).toEqual({ conversations: ["c"], plans: [], notes: [], references: [], skills: [] });
	});

	it("reads an excluded skill key back out of the selection set", async () => {
		const { readExclusions } = await import("../core/CommitSelectionStore.js");
		vi.mocked(readExclusions).mockResolvedValue({
			conversations: new Set(),
			plans: new Set(),
			notes: new Set(),
			references: new Set(),
			skills: new Set(["claude:brainstorming"]),
		} as never);
		const result = await runIdeBridgeAction("shared-store", "/r", { operation: "selection-read" });
		expect(result).toMatchObject({ skills: ["claude:brainstorming"] });
	});

	it("computes a selection key", async () => {
		const { conversationKey } = await import("../core/CommitSelectionStore.js");
		vi.mocked(conversationKey).mockReturnValue("claude#s");
		const result = await runIdeBridgeAction("shared-store", "/r", {
			operation: "selection-key",
			source: "claude",
			sessionId: "s",
		});
		expect(result).toEqual({ key: "claude#s" });
	});

	it("sets a single selection", async () => {
		const { setExcluded } = await import("../core/CommitSelectionStore.js");
		await runIdeBridgeAction("shared-store", "/r", {
			operation: "selection-set",
			kind: "conversations",
			key: "k",
			excluded: true,
		});
		expect(setExcluded).toHaveBeenCalledWith("/r", "conversations", "k", true);
	});

	it("defaults selection-set excluded flag to false when the field is not exactly true", async () => {
		const { setExcluded } = await import("../core/CommitSelectionStore.js");
		await runIdeBridgeAction("shared-store", "/r", {
			operation: "selection-set",
			kind: "conversations",
			key: "k",
			excluded: "yes",
		});
		expect(setExcluded).toHaveBeenCalledWith("/r", "conversations", "k", false);
	});

	it("sets all selections", async () => {
		const { setAllExcluded } = await import("../core/CommitSelectionStore.js");
		await runIdeBridgeAction("shared-store", "/r", {
			operation: "selection-set-all",
			kind: "plans",
			keys: ["a", "b"],
			excluded: true,
		});
		expect(setAllExcluded).toHaveBeenCalledWith("/r", "plans", ["a", "b"], true);
	});

	// ---------- skills-* ----------
	//
	// These four operations are IntelliJ's ONLY skill surface — it renders no skill
	// table of its own by design — so a break here is invisible to the VS Code
	// suite. `SkillsAggregateMarkdown` is deliberately left unmocked: the point of
	// routing IntelliJ through the bridge is that it gets the same renderer the
	// Memory Bank file uses, and a mocked renderer would not prove that.

	const skillRow = (over: Record<string, unknown> = {}) => ({
		source: "claude",
		skill: "brainstorming",
		entryPaths: ["tool"],
		invocations: [],
		invocationCount: 2,
		firstUsedAt: "2026-07-30T06:00:00.000Z",
		lastUsedAt: "2026-07-30T07:00:00.000Z",
		usage: { input: 100, cached: 900, output: 0, confidence: "attributed" },
		sourcePath: "/tmp/x.md",
		commitHash: null,
		...over,
	});

	it("projects the active skills and the summary label that goes with them", async () => {
		const { loadPlansRegistry } = await import("../core/SessionTracker.js");
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			skills: { "claude:brainstorming": skillRow() },
		} as never);

		const result = (await runIdeBridgeAction("shared-store", "/r", { operation: "skills-active" })) as {
			skills: Array<{ mapKey: string; invocationCount: number }>;
			summaryLabel: string;
		};
		expect(result.skills).toHaveLength(1);
		expect(result.skills[0]).toMatchObject({ mapKey: "claude:brainstorming", invocationCount: 2 });
		// The label rides along so the caller needs one round trip, not two.
		expect(result.summaryLabel).toBe("1 skill · 1.0k tokens");
	});

	it("renders the live aggregate table for uncommitted skills", async () => {
		const { loadPlansRegistry } = await import("../core/SessionTracker.js");
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			skills: { "claude:brainstorming": skillRow() },
		} as never);

		const { markdown } = (await runIdeBridgeAction("shared-store", "/r", {
			operation: "skills-live-markdown",
		})) as { markdown: string };
		expect(markdown).toContain("# Skills used — uncommitted");
		expect(markdown).toContain("| brainstorming | 2 | 1.0k |");
	});

	// null rather than an empty table: committing archives every skill, so an empty
	// registry is the normal post-commit state and the caller says so in words.
	it("returns a null live markdown when nothing is captured", async () => {
		const { loadPlansRegistry } = await import("../core/SessionTracker.js");
		vi.mocked(loadPlansRegistry).mockResolvedValue({ skills: {} } as never);

		expect(await runIdeBridgeAction("shared-store", "/r", { operation: "skills-live-markdown" })).toEqual({
			markdown: null,
		});
	});

	// Takes the rows off the request rather than reading the registry: the caller is
	// summarising an ARCHIVED set off a CommitSummary, which the registry no longer holds.
	it("labels an archived skill set passed in by the caller", async () => {
		const result = await runIdeBridgeAction("shared-store", "/r", {
			operation: "skills-label",
			skills: [
				{ skill: "a", invocationCount: 1, usage: { input: 1, cached: 2, output: 3, confidence: "estimated" } },
				{ skill: "b", invocationCount: 2 },
			],
		});
		expect(result).toEqual({ label: "2 skills · ~6 tokens" });
	});

	it("rejects a skills field that is not an array of objects", async () => {
		await expect(
			runIdeBridgeAction("shared-store", "/r", { operation: "skills-label", skills: ["a"] }),
		).rejects.toThrow('Request field "skills" must be an array of objects.');
		await expect(
			runIdeBridgeAction("shared-store", "/r", { operation: "skills-label", skills: "nope" }),
		).rejects.toThrow('Request field "skills" must be an array of objects.');
		await expect(
			runIdeBridgeAction("shared-store", "/r", { operation: "skills-label", skills: [null] }),
		).rejects.toThrow('Request field "skills" must be an array of objects.');
	});

	it("renders a committed memory's skills table from the summary it is given", async () => {
		const { markdown } = (await runIdeBridgeAction("shared-store", "/r", {
			operation: "skills-committed-markdown",
			summary: {
				commitHash: "abcdef1234567890",
				branch: "main",
				generatedAt: "2026-07-30T08:00:00.000Z",
				commitMessage: "do the thing",
				skills: [{ skill: "a", invocationCount: 1 }],
			},
		})) as { markdown: string };
		expect(markdown).toContain("# Skills used — abcdef12");
		expect(markdown).toContain("commitHash: abcdef1234567890");
		// Unattributed rows dash all four cells rather than showing a zero.
		expect(markdown).toContain("| a | 1 | — | — | — | — |");
	});

	it("returns a null committed markdown when the summary archived no skills", async () => {
		expect(
			await runIdeBridgeAction("shared-store", "/r", {
				operation: "skills-committed-markdown",
				summary: { commitHash: "abcdef12", skills: [] },
			}),
		).toEqual({ markdown: null });
		expect(await runIdeBridgeAction("shared-store", "/r", { operation: "skills-committed-markdown" })).toEqual({
			markdown: null,
		});
	});

	// The `skills-` prefix must not swallow an unknown operation into a silent
	// success, and must not pay for a registry read before rejecting it.
	it("rejects an unrecognised skills operation without reading the registry", async () => {
		const { loadPlansRegistry } = await import("../core/SessionTracker.js");
		vi.mocked(loadPlansRegistry).mockClear();
		await expect(runIdeBridgeAction("shared-store", "/r", { operation: "skills-bogus" })).rejects.toThrow(
			'Unknown shared-store operation "skills-bogus".',
		);
		expect(loadPlansRegistry).not.toHaveBeenCalled();
	});

	it("puts a branch share", async () => {
		const { putBranchShare } = await import("../core/BranchShareStore.js");
		await runIdeBridgeAction("shared-store", "/r", {
			operation: "branch-share-put",
			branch: "main",
			commitHash: "abc",
			record: { id: 1 },
		});
		expect(putBranchShare).toHaveBeenCalledWith("/r", "main", { id: 1 }, "abc");
	});

	it("removes a branch share", async () => {
		const { removeShare } = await import("../core/BranchShareStore.js");
		await runIdeBridgeAction("shared-store", "/r", {
			operation: "branch-share-remove",
			branch: "main",
			commitHash: "abc",
		});
		expect(removeShare).toHaveBeenCalledWith("/r", "main", "abc");
	});

	it("gets a branch share (record found)", async () => {
		const { getShare } = await import("../core/BranchShareStore.js");
		vi.mocked(getShare).mockResolvedValue({ id: 42 } as never);
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({ jolliApiKey: "sk-jol-x" } as never);
		const result = await runIdeBridgeAction("shared-store", "/r", {
			operation: "branch-share-get",
			branch: "main",
			commitHash: "abc",
		});
		expect(result).toEqual({ record: { id: 42 } });
	});

	it("gets a branch share (record null; api key absent)", async () => {
		const { loadConfig } = await import("../core/SessionTracker.js");
		vi.mocked(loadConfig).mockResolvedValue({} as never);
		const { getShare } = await import("../core/BranchShareStore.js");
		vi.mocked(getShare).mockResolvedValue(undefined);
		const result = await runIdeBridgeAction("shared-store", "/r", {
			operation: "branch-share-get",
			branch: "main",
		});
		expect(result).toEqual({ record: null });
	});

	it("returns push-pending hashes", async () => {
		expect(await runIdeBridgeAction("shared-store", "/r", { operation: "push-pending-hashes" })).toEqual({
			hashes: ["hashA", "hashB"],
		});
	});

	it("reads the repo profile", async () => {
		const result = await runIdeBridgeAction("shared-store", "/r", { operation: "repo-profile-read" });
		expect(result).toMatchObject({ profile: { backfillDismissed: false } });
	});

	it("sets backfill-dismissed on the repo profile", async () => {
		const { updateRepoProfile } = await import("../core/RepoProfile.js");
		await runIdeBridgeAction("shared-store", "/r", {
			operation: "repo-profile-set-backfill-dismissed",
			dismissed: true,
		});
		expect(updateRepoProfile).toHaveBeenCalledWith("/r", { backfillDismissed: true });
	});

	it("rejects a non-boolean 'dismissed' field on repo-profile-set-backfill-dismissed", async () => {
		await expect(
			runIdeBridgeAction("shared-store", "/r", {
				operation: "repo-profile-set-backfill-dismissed",
				dismissed: 1,
			}),
		).rejects.toThrow(/"dismissed"/);
	});

	it("returns a summary-markdown string", async () => {
		expect(await runIdeBridgeAction("shared-store", "/r", { operation: "summary-markdown", summary: {} })).toEqual({
			markdown: "# md",
		});
	});

	it("returns a summary-pr-markdown string", async () => {
		expect(
			await runIdeBridgeAction("shared-store", "/r", { operation: "summary-pr-markdown", summary: {} }),
		).toEqual({ markdown: "# pr md" });
	});

	it("wraps a markdown with PR markers", async () => {
		const result = await runIdeBridgeAction("shared-store", "/r", {
			operation: "pr-wrap-markdown",
			markdown: "hello",
		});
		expect(result).toMatchObject({ markdown: expect.stringContaining("hello") });
	});

	it("replaces a summary block in a PR body", async () => {
		const result = await runIdeBridgeAction("shared-store", "/r", {
			operation: "pr-replace-markdown",
			currentBody: "body",
			markdown: "md",
		});
		expect(result).toEqual({ body: "body[patched]" });
	});

	it("builds reference push presentation (with a stored markdown carrying a description)", async () => {
		const references = await import("../core/references/ReferenceStore.js");
		// `-Once` so the override doesn't leak into the reference-store 'parse'
		// test that follows (clearMocks: true only wipes call history, not
		// return-value overrides).
		vi.mocked(references.readReferenceMarkdownFromString).mockReturnValueOnce({ description: "d" } as never);
		const result = await runIdeBridgeAction("shared-store", "/r", {
			operation: "reference-push-presentation",
			reference: { source: "s", key: "k" },
			storedMarkdown: "# ref",
		});
		expect(result).toMatchObject({ title: "Ref Title", markdown: "# ref" });
	});

	it("builds reference push presentation (no storedMarkdown)", async () => {
		const result = await runIdeBridgeAction("shared-store", "/r", {
			operation: "reference-push-presentation",
			reference: { source: "s", key: "k" },
		});
		expect(result).toMatchObject({ title: "Ref Title" });
	});

	it("builds reference push presentation when the stored markdown parses to null", async () => {
		const references = await import("../core/references/ReferenceStore.js");
		// `-Once` — see the earlier reference-push-presentation test for why.
		vi.mocked(references.readReferenceMarkdownFromString).mockReturnValueOnce(null);
		const result = await runIdeBridgeAction("shared-store", "/r", {
			operation: "reference-push-presentation",
			reference: { source: "s", key: "k" },
			storedMarkdown: "raw",
		});
		expect(result).toMatchObject({ title: "Ref Title" });
	});

	it("rejects reference-push-presentation with a non-object reference", async () => {
		await expect(
			runIdeBridgeAction("shared-store", "/r", { operation: "reference-push-presentation", reference: "x" }),
		).rejects.toThrow(/"reference"/);
	});

	it("rejects an unknown shared-store operation", async () => {
		await expect(runIdeBridgeAction("shared-store", "/r", { operation: "nothing" })).rejects.toThrow(
			/Unknown shared-store operation/,
		);
	});
});

describe("runIdeBridgeAction — summary-store", () => {
	it("returns the index", async () => {
		const { getIndex } = await import("../core/SummaryStore.js");
		vi.mocked(getIndex).mockResolvedValue({ entries: [] } as never);
		expect(await runIdeBridgeAction("summary-store", "/r", { operation: "index" })).toEqual({ entries: [] });
	});

	it("returns a single summary", async () => {
		expect(await runIdeBridgeAction("summary-store", "/r", { operation: "get", commitHash: "abc" })).toMatchObject({
			commitHash: "abc",
		});
	});

	it("lists summaries with the default count of 10 when count is not given", async () => {
		const { listSummaries } = await import("../core/SummaryStore.js");
		await runIdeBridgeAction("summary-store", "/r", { operation: "list" });
		expect(listSummaries).toHaveBeenCalledWith(10, "/r", expect.anything());
	});

	it("lists summaries with an explicit count", async () => {
		const { listSummaries } = await import("../core/SummaryStore.js");
		await runIdeBridgeAction("summary-store", "/r", { operation: "list", count: 3 });
		expect(listSummaries).toHaveBeenCalledWith(3, "/r", expect.anything());
	});

	it("returns a count", async () => {
		const { getSummaryCount } = await import("../core/SummaryStore.js");
		vi.mocked(getSummaryCount).mockResolvedValue(7);
		expect(await runIdeBridgeAction("summary-store", "/r", { operation: "count" })).toEqual({ count: 7 });
	});

	it("find-root returns null when there is no index", async () => {
		const { getIndex } = await import("../core/SummaryStore.js");
		vi.mocked(getIndex).mockResolvedValue(null);
		expect(await runIdeBridgeAction("summary-store", "/r", { operation: "find-root", commitHash: "x" })).toEqual({
			hash: null,
		});
	});

	it("find-root returns null when the hash is not in the index", async () => {
		const { getIndex } = await import("../core/SummaryStore.js");
		vi.mocked(getIndex).mockResolvedValue({
			entries: [{ commitHash: "root", parentCommitHash: null }],
			commitAliases: {},
		} as never);
		expect(
			await runIdeBridgeAction("summary-store", "/r", { operation: "find-root", commitHash: "missing" }),
		).toEqual({ hash: null });
	});

	it("find-root walks parent pointers to the root", async () => {
		const { getIndex } = await import("../core/SummaryStore.js");
		vi.mocked(getIndex).mockResolvedValue({
			entries: [
				{ commitHash: "root", parentCommitHash: null },
				{ commitHash: "child", parentCommitHash: "root" },
				{ commitHash: "leaf", parentCommitHash: "child" },
			],
			commitAliases: { alias: "leaf" },
		} as never);
		expect(
			await runIdeBridgeAction("summary-store", "/r", { operation: "find-root", commitHash: "alias" }),
		).toEqual({ hash: "root" });
	});

	it("find-root stops when a parent is missing from the index", async () => {
		const { getIndex } = await import("../core/SummaryStore.js");
		vi.mocked(getIndex).mockResolvedValue({
			entries: [{ commitHash: "leaf", parentCommitHash: "gone" }],
			commitAliases: {},
		} as never);
		expect(await runIdeBridgeAction("summary-store", "/r", { operation: "find-root", commitHash: "leaf" })).toEqual(
			{
				hash: "leaf",
			},
		);
	});

	it("filter-hashes returns only hashes present in the index or in aliases", async () => {
		const { getIndex } = await import("../core/SummaryStore.js");
		vi.mocked(getIndex).mockResolvedValue({
			entries: [{ commitHash: "known" }],
			commitAliases: { alt: "known" },
		} as never);
		expect(
			await runIdeBridgeAction("summary-store", "/r", {
				operation: "filter-hashes",
				hashes: ["known", "alt", "missing"],
			}),
		).toEqual({ hashes: ["known", "alt"] });
	});

	it("filter-hashes handles a null index", async () => {
		const { getIndex } = await import("../core/SummaryStore.js");
		vi.mocked(getIndex).mockResolvedValue(null);
		expect(
			await runIdeBridgeAction("summary-store", "/r", {
				operation: "filter-hashes",
				hashes: ["a"],
			}),
		).toEqual({ hashes: [] });
	});

	it("scan-aliases returns the changed flag from the store", async () => {
		const { scanTreeHashAliases } = await import("../core/SummaryStore.js");
		vi.mocked(scanTreeHashAliases).mockResolvedValue(true);
		expect(await runIdeBridgeAction("summary-store", "/r", { operation: "scan-aliases", hashes: ["x"] })).toEqual({
			changed: true,
		});
	});

	it("resolve-alias returns the alias target when present", async () => {
		const { getIndex } = await import("../core/SummaryStore.js");
		vi.mocked(getIndex).mockResolvedValue({ entries: [], commitAliases: { a: "b" } } as never);
		expect(
			await runIdeBridgeAction("summary-store", "/r", { operation: "resolve-alias", commitHash: "a" }),
		).toEqual({ hash: "b" });
	});

	it("resolve-alias returns the original hash when no alias exists", async () => {
		const { getIndex } = await import("../core/SummaryStore.js");
		vi.mocked(getIndex).mockResolvedValue({ entries: [], commitAliases: {} } as never);
		expect(
			await runIdeBridgeAction("summary-store", "/r", { operation: "resolve-alias", commitHash: "z" }),
		).toEqual({ hash: "z" });
	});

	it("store-summary rejects a non-object summary", async () => {
		await expect(
			runIdeBridgeAction("summary-store", "/r", { operation: "store-summary", summary: null }),
		).rejects.toThrow(/"summary"/);
	});

	it("store-summary passes optional transcript / planProgress / referenceFiles", async () => {
		const { storeSummary } = await import("../core/SummaryStore.js");
		const { createStorage } = await import("../core/StorageFactory.js");
		// `…Once`, not `mockResolvedValue`: the suite runs with `clearMocks` only,
		// so a persistent implementation would leak into every later test.
		vi.mocked(createStorage).mockResolvedValueOnce({} as never);
		await runIdeBridgeAction("summary-store", "/r", {
			operation: "store-summary",
			summary: { commitHash: "h" },
			force: true,
			transcript: { entries: [] },
			planProgress: [{ slug: "x" }],
			referenceFiles: [{ path: "p", content: "c" }],
		});
		expect(storeSummary).toHaveBeenCalledWith(
			{ commitHash: "h" },
			"/r",
			true,
			expect.objectContaining({ transcript: expect.any(Object), planProgress: expect.any(Array) }),
			expect.anything(),
		);
	});

	it("store-summary works without any optional extras", async () => {
		const { storeSummary } = await import("../core/SummaryStore.js");
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValueOnce({} as never);
		await runIdeBridgeAction("summary-store", "/r", {
			operation: "store-summary",
			summary: { commitHash: "h" },
		});
		expect(storeSummary).toHaveBeenCalledWith(
			{ commitHash: "h" },
			"/r",
			false,
			expect.any(Object),
			expect.anything(),
		);
	});

	it("reads plan progress", async () => {
		const { readPlanProgress } = await import("../core/SummaryStore.js");
		vi.mocked(readPlanProgress).mockResolvedValue([{ step: 1 }] as never);
		expect(await runIdeBridgeAction("summary-store", "/r", { operation: "read-plan-progress", slug: "s" })).toEqual(
			[{ step: 1 }],
		);
	});

	it("store-files rejects when files is not an array", async () => {
		await expect(
			runIdeBridgeAction("summary-store", "/r", { operation: "store-files", files: "no", message: "m" }),
		).rejects.toThrow(/"files"/);
	});

	it("store-files writes to storage", async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ writeFiles: write } as never);
		await runIdeBridgeAction("summary-store", "/r", {
			operation: "store-files",
			files: [{ path: "p", content: "c" }],
			message: "msg",
		});
		expect(write).toHaveBeenCalledWith([{ path: "p", content: "c" }], "msg");
	});

	it("reads a plan from the branch", async () => {
		expect(await runIdeBridgeAction("summary-store", "/r", { operation: "read-plan", slug: "s" })).toEqual({
			content: "plan-content",
		});
	});

	it("writes a plan", async () => {
		const { storePlans } = await import("../core/SummaryStore.js");
		await runIdeBridgeAction("summary-store", "/r", {
			operation: "write-plan",
			slug: "s",
			content: "c",
			message: "m",
		});
		expect(storePlans).toHaveBeenCalled();
	});

	it("reads a reference from the branch", async () => {
		expect(
			await runIdeBridgeAction("summary-store", "/r", {
				operation: "read-reference",
				source: "claude",
				archivedKey: "k",
			}),
		).toEqual({ content: "ref-content" });
	});

	it("writes a reference", async () => {
		const { storeReferences } = await import("../core/SummaryStore.js");
		await runIdeBridgeAction("summary-store", "/r", {
			operation: "write-reference",
			source: "claude",
			archivedKey: "k",
			content: "c",
			message: "m",
		});
		expect(storeReferences).toHaveBeenCalled();
	});

	it("returns transcript hashes as an array", async () => {
		expect(await runIdeBridgeAction("summary-store", "/r", { operation: "transcript-hashes" })).toEqual({
			hashes: ["h1", "h2"],
		});
	});

	it("reads a transcript", async () => {
		expect(
			await runIdeBridgeAction("summary-store", "/r", {
				operation: "read-transcript",
				commitHash: "h",
			}),
		).toEqual({ entries: [] });
	});

	it("write-transcript-batch rejects when writes is not a plain object", async () => {
		await expect(
			runIdeBridgeAction("summary-store", "/r", {
				operation: "write-transcript-batch",
				writes: [1],
				deletes: [],
			}),
		).rejects.toThrow(/"writes"/);
	});

	it("write-transcript-batch calls saveTranscriptsBatch", async () => {
		const { saveTranscriptsBatch } = await import("../core/SummaryStore.js");
		await runIdeBridgeAction("summary-store", "/r", {
			operation: "write-transcript-batch",
			writes: { h1: { entries: [] } },
			deletes: ["d1"],
		});
		expect(saveTranscriptsBatch).toHaveBeenCalledWith(
			[{ hash: "h1", data: { entries: [] } }],
			["d1"],
			"/r",
			expect.anything(),
		);
	});

	it("rejects an unknown summary-store operation", async () => {
		await expect(runIdeBridgeAction("summary-store", "/r", { operation: "wat" })).rejects.toThrow(
			/Unknown summary-store operation/,
		);
	});
});

describe("runIdeBridgeAction — summary-tree", () => {
	it("analyzes a summary", async () => {
		const result = await runIdeBridgeAction("summary-tree", "/r", { operation: "analyze", summary: {} });
		expect(result).toMatchObject({ unified: true, topicCount: 3, durationLabel: "1d", transcriptIds: ["t-1"] });
	});

	it("updates a topic in the tree", async () => {
		const result = await runIdeBridgeAction("summary-tree", "/r", {
			operation: "update-topic",
			summary: {},
			globalIndex: 0,
			updates: { title: "T" },
		});
		expect(result).toEqual({ updated: true });
	});

	it("update-topic defaults updates to {} when absent", async () => {
		const { updateTopicInTree } = await import("../core/SummaryTree.js");
		await runIdeBridgeAction("summary-tree", "/r", {
			operation: "update-topic",
			summary: {},
			globalIndex: 1,
		});
		expect(updateTopicInTree).toHaveBeenCalledWith({}, 1, {});
	});

	it("deletes a topic from the tree", async () => {
		expect(
			await runIdeBridgeAction("summary-tree", "/r", {
				operation: "delete-topic",
				summary: {},
				globalIndex: 2,
			}),
		).toEqual({ deleted: true });
	});

	it("rejects a summary that is not an object", async () => {
		await expect(runIdeBridgeAction("summary-tree", "/r", { operation: "analyze", summary: null })).rejects.toThrow(
			/"summary"/,
		);
	});

	it("rejects an unknown summary-tree operation", async () => {
		await expect(runIdeBridgeAction("summary-tree", "/r", { operation: "nope", summary: {} })).rejects.toThrow(
			/Unknown summary-tree operation/,
		);
	});
});

describe("runIdeBridgeAction — plan-grouping", () => {
	it("returns a single base key", async () => {
		expect(await runIdeBridgeAction("plan-grouping", "/r", { operation: "base-key", slug: "s" })).toEqual({
			key: "plan:s",
		});
	});

	it("returns a map of base keys per slug", async () => {
		expect(
			await runIdeBridgeAction("plan-grouping", "/r", {
				operation: "base-keys",
				slugs: ["a", "b"],
			}),
		).toEqual({ a: "plan:a", b: "plan:b" });
	});

	it("returns the latest plan per name", async () => {
		const { latestPlanPerName } = await import("../core/JolliMemoryPushOrchestrator.js");
		vi.mocked(latestPlanPerName).mockReturnValue([{ slug: "s" }] as never);
		expect(
			await runIdeBridgeAction("plan-grouping", "/r", { operation: "latest", plans: [{ slug: "s" }] }),
		).toEqual([{ slug: "s" }]);
	});

	it("rejects 'latest' with a non-array plans field", async () => {
		await expect(runIdeBridgeAction("plan-grouping", "/r", { operation: "latest", plans: "no" })).rejects.toThrow(
			/"plans"/,
		);
	});

	it("rejects an unknown plan-grouping operation", async () => {
		await expect(runIdeBridgeAction("plan-grouping", "/r", { operation: "wat" })).rejects.toThrow(
			/Unknown plan-grouping operation/,
		);
	});
});

describe("runIdeBridgeAction — reference-store", () => {
	it("reads a reference markdown from disk", async () => {
		expect(await runIdeBridgeAction("reference-store", "/r", { operation: "read", sourcePath: "/x.md" })).toEqual({
			source: "src",
			archivedKey: "k",
			content: "c",
		});
	});

	it("parses a reference markdown string", async () => {
		expect(await runIdeBridgeAction("reference-store", "/r", { operation: "parse", content: "# ref" })).toEqual({
			description: "desc",
		});
	});

	it("rejects an unknown reference-store operation", async () => {
		await expect(runIdeBridgeAction("reference-store", "/r", { operation: "wat" })).rejects.toThrow(
			/Unknown reference-store operation/,
		);
	});
});

describe("runIdeBridgeAction — kb (path helpers)", () => {
	it("resolves a KB path with a custom parent", async () => {
		expect(
			await runIdeBridgeAction("kb", "/r", {
				operation: "resolve",
				repoName: "n",
				remoteUrl: "u",
				customPath: "/c",
			}),
		).toEqual({ path: "/kb" });
	});

	it("passes a null remoteUrl when the field is missing", async () => {
		const { resolveKBPath } = await import("../core/KBPathResolver.js");
		await runIdeBridgeAction("kb", "/r", { operation: "resolve", repoName: "n" });
		expect(resolveKBPath).toHaveBeenCalledWith("n", null, undefined);
	});

	it("initializes a KB folder", async () => {
		const { initializeKBFolder } = await import("../core/KBPathResolver.js");
		await runIdeBridgeAction("kb", "/r", {
			operation: "initialize",
			kbRoot: "/kb",
			repoName: "n",
			remoteUrl: "u",
		});
		expect(initializeKBFolder).toHaveBeenCalledWith("/kb", "n", "u");
	});

	it("finds repo folders", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "find-repo-folders", repoName: "n" })).toEqual({
			paths: [],
		});
	});

	it("finds fresh kb path", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "find-fresh", repoName: "n" })).toEqual({
			path: "/kb-fresh",
		});
	});

	it("archives a kb folder", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "archive", kbRoot: "/kb" })).toEqual({
			path: "/kb-archive",
		});
	});

	it("extracts a repo name", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "extract-repo-name", projectPath: "/p" })).toEqual({
			value: "repo",
		});
	});

	it("gets a remote url", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "get-remote-url", projectPath: "/p" })).toEqual({
			value: "git@github.com:acme/repo.git",
		});
	});

	it("discovers repos", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "discover" })).toEqual({ repos: [] });
	});
});

describe("runIdeBridgeAction — kb (metadata operations)", () => {
	it("ensures metadata", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "metadata-ensure", jolliDir: "/j" })).toEqual({
			ok: true,
		});
	});

	it("reads the manifest", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "metadata-read-manifest", jolliDir: "/j" })).toEqual({
			files: [],
		});
	});

	it("reads the index", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "metadata-read-index", jolliDir: "/j" })).toEqual({
			version: 1,
			entries: [],
		});
	});

	it("reads the config", async () => {
		expect(await runIdeBridgeAction("kb", "/r", { operation: "metadata-read-config", jolliDir: "/j" })).toEqual({});
	});

	it("finds by path", async () => {
		expect(
			await runIdeBridgeAction("kb", "/r", { operation: "metadata-find-by-path", jolliDir: "/j", path: "p" }),
		).toEqual({ entry: { fileId: "id" } });
	});

	it("updates a path", async () => {
		expect(
			await runIdeBridgeAction("kb", "/r", {
				operation: "metadata-update-path",
				jolliDir: "/j",
				fileId: "id",
				newPath: "p2",
			}),
		).toEqual({ changed: true });
	});

	it("renames a branch folder", async () => {
		expect(
			await runIdeBridgeAction("kb", "/r", {
				operation: "metadata-rename-branch-folder",
				jolliDir: "/j",
				oldFolder: "o",
				newFolder: "n",
			}),
		).toEqual({ count: 3 });
	});

	it("removes a branch folder", async () => {
		expect(
			await runIdeBridgeAction("kb", "/r", {
				operation: "metadata-remove-branch-folder",
				jolliDir: "/j",
				folder: "f",
			}),
		).toEqual({ count: 2 });
	});

	it("removes from the manifest", async () => {
		expect(
			await runIdeBridgeAction("kb", "/r", {
				operation: "metadata-remove-manifest",
				jolliDir: "/j",
				fileId: "id",
			}),
		).toEqual({ changed: true });
	});

	it("reconciles metadata", async () => {
		expect(
			await runIdeBridgeAction("kb", "/r", {
				operation: "metadata-reconcile",
				jolliDir: "/j",
				kbRoot: "/kb",
			}),
		).toEqual({ count: 1 });
	});

	it("saves the migration state", async () => {
		expect(
			await runIdeBridgeAction("kb", "/r", {
				operation: "metadata-save-migration",
				jolliDir: "/j",
				state: { status: "completed", totalEntries: 0, migratedEntries: 0 },
			}),
		).toEqual({ ok: true });
	});

	it("rejects an unknown kb operation", async () => {
		await expect(runIdeBridgeAction("kb", "/r", { operation: "wat", jolliDir: "/j" })).rejects.toThrow(
			/Unknown KB operation/,
		);
	});
});

describe("runIdeBridgeAction — storage", () => {
	it("reads a file", async () => {
		const readFile = vi.fn().mockResolvedValue("content");
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ readFile } as never);
		expect(await runIdeBridgeAction("storage", "/r", { operation: "read", path: "p" })).toEqual({
			content: "content",
		});
	});

	it("lists files", async () => {
		const listFiles = vi.fn().mockResolvedValue(["a", "b"]);
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ listFiles } as never);
		expect(await runIdeBridgeAction("storage", "/r", { operation: "list", prefix: "p/" })).toEqual({
			paths: ["a", "b"],
		});
	});

	it("batch-reads N paths in one round trip, absent paths as null", async () => {
		const batchReadFiles = vi.fn().mockResolvedValue(
			new Map([
				["a.json", "A"],
				["gone.json", null],
			]),
		);
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ batchReadFiles } as never);
		expect(
			await runIdeBridgeAction("storage", "/r", { operation: "batch-read", paths: ["a.json", "gone.json"] }),
		).toEqual({ contents: { "a.json": "A", "gone.json": null } });
		expect(batchReadFiles).toHaveBeenCalledWith(["a.json", "gone.json"]);
		await expect(runIdeBridgeAction("storage", "/r", { operation: "batch-read", paths: "x" })).rejects.toThrow(
			/must be an array/,
		);
	});

	it("batch-read falls back to per-path reads on a provider without the method", async () => {
		const readFile = vi.fn().mockImplementation(async (p: string) => (p === "a.json" ? "A" : null));
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ readFile } as never);
		expect(
			await runIdeBridgeAction("storage", "/r", { operation: "batch-read", paths: ["a.json", "gone.json"] }),
		).toEqual({ contents: { "a.json": "A", "gone.json": null } });
	});

	it("checks existence", async () => {
		const exists = vi.fn().mockResolvedValue(true);
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ exists } as never);
		expect(await runIdeBridgeAction("storage", "/r", { operation: "exists" })).toEqual({ exists: true });
	});

	it("ensures the storage exists", async () => {
		const ensure = vi.fn().mockResolvedValue(undefined);
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ ensure } as never);
		expect(await runIdeBridgeAction("storage", "/r", { operation: "ensure" })).toEqual({ ok: true });
	});

	it("writes files", async () => {
		const writeFiles = vi.fn().mockResolvedValue(undefined);
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ writeFiles } as never);
		expect(
			await runIdeBridgeAction("storage", "/r", {
				operation: "write",
				files: [{ path: "p", content: "c" }],
				message: "m",
			}),
		).toEqual({ ok: true });
	});

	it("rejects a write with non-array files", async () => {
		const writeFiles = vi.fn();
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({ writeFiles } as never);
		await expect(
			runIdeBridgeAction("storage", "/r", { operation: "write", files: "nope", message: "m" }),
		).rejects.toThrow(/"files"/);
	});

	it("rejects an unknown storage operation", async () => {
		const { createStorage } = await import("../core/StorageFactory.js");
		vi.mocked(createStorage).mockResolvedValue({} as never);
		await expect(runIdeBridgeAction("storage", "/r", { operation: "wat" })).rejects.toThrow(
			/Unknown storage operation/,
		);
	});
});

describe("runIdeBridgeAction — git-exec / git-main-worktree-root / git-remote", () => {
	it("executes a git command", async () => {
		const { execGit } = await import("../core/GitOps.js");
		vi.mocked(execGit).mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 } as never);
		expect(await runIdeBridgeAction("git-exec", "/r", { args: ["status"] })).toEqual({
			stdout: "ok",
			stderr: "",
			exitCode: 0,
		});
	});

	it("returns the main worktree root", async () => {
		const { getProjectRootDir } = await import("../core/GitOps.js");
		vi.mocked(getProjectRootDir).mockResolvedValue("/main");
		expect(await runIdeBridgeAction("git-main-worktree-root", "/r", {})).toEqual({ path: "/main" });
	});

	it("gets the canonical repo url", async () => {
		const { getCanonicalRepoUrl } = await import("../core/GitRemoteUtils.js");
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("git@github.com:acme/repo.git");
		expect(await runIdeBridgeAction("git-remote", "/r", { operation: "canonical-url" })).toEqual({
			value: "git@github.com:acme/repo.git",
		});
	});

	it("normalizes a remote url", async () => {
		expect(
			await runIdeBridgeAction("git-remote", "/r", { operation: "normalize-url", remote: "git@github.com:x/y" }),
		).toEqual({ value: "git@github.com:acme/repo.git" });
	});

	it("derives a repo name from a url", async () => {
		expect(
			await runIdeBridgeAction("git-remote", "/r", {
				operation: "derive-name",
				repoUrl: "git@github.com:acme/repo.git",
			}),
		).toEqual({ value: "repo" });
	});

	it("sanitizes a branch slug", async () => {
		expect(
			await runIdeBridgeAction("git-remote", "/r", { operation: "sanitize-branch", branch: "feat/x" }),
		).toEqual({ value: "main-slug" });
	});

	it("rejects an unknown git-remote operation", async () => {
		await expect(runIdeBridgeAction("git-remote", "/r", { operation: "wat" })).rejects.toThrow(
			/Unknown git-remote operation/,
		);
	});
});

describe("runIdeBridgeAction — telemetry", () => {
	it("tracks an event with properties and bucketCounts", async () => {
		const { track, bucket } = await import("../core/Telemetry.js");
		expect(
			await runIdeBridgeAction("telemetry-track", "/r", {
				eventName: "ide.sync",
				properties: { a: 1 },
				bucketCounts: { n: 12 },
				platformDisabled: false,
			}),
		).toEqual({ ok: true });
		expect(bucket).toHaveBeenCalledWith(12);
		expect(track).toHaveBeenCalledWith("ide.sync", expect.objectContaining({ a: 1, n: "bucket-12" }));
	});

	it("tracks an event without bucketCounts", async () => {
		await runIdeBridgeAction("telemetry-track", "/r", { eventName: "ide.sync" });
		const { track } = await import("../core/Telemetry.js");
		expect(track).toHaveBeenCalled();
	});

	it("rejects a non-object bucketCounts", async () => {
		await expect(
			runIdeBridgeAction("telemetry-track", "/r", { eventName: "e", bucketCounts: [1, 2] }),
		).rejects.toThrow(/"bucketCounts"/);
	});

	it("rejects a bucket count that is not a number", async () => {
		await expect(
			runIdeBridgeAction("telemetry-track", "/r", { eventName: "e", bucketCounts: { k: "no" } }),
		).rejects.toThrow(/Bucket count "k"/);
	});

	it("bootstraps telemetry and returns the notice flag", async () => {
		const { shouldShowTelemetryNotice } = await import("../core/TelemetryConsent.js");
		vi.mocked(shouldShowTelemetryNotice).mockReturnValue(true);
		expect(await runIdeBridgeAction("telemetry-bootstrap", "/r", { platformDisabled: true })).toEqual({
			shouldShowNotice: true,
		});
	});

	it("returns a telemetry install id", async () => {
		expect(await runIdeBridgeAction("telemetry-install-id", "/r", {})).toEqual({
			installId: "install-1",
			created: false,
		});
	});

	it("flushes telemetry", async () => {
		expect(await runIdeBridgeAction("telemetry-flush", "/r", { platformDisabled: true })).toEqual({
			ok: true,
		});
	});
});

describe("runIdeBridgeAction — unknown action", () => {
	it("throws for a completely unknown action", async () => {
		await expect(runIdeBridgeAction("nope", "/r", {})).rejects.toThrow(/Unknown IDE bridge action/);
	});
});

// ---------- 3. field validators (through the entry actions) ----------

describe("runIdeBridgeAction — field validators", () => {
	it("stringField rejects a non-string value", async () => {
		await expect(runIdeBridgeAction("summary-store", "/r", { operation: 42 })).rejects.toThrow(/"operation"/);
	});

	it("optionalString accepts undefined and null (both mean 'not set')", async () => {
		// session-state 'config-load' with dir undefined + dir null both pass validation
		await runIdeBridgeAction("session-state", "/r", { operation: "config-load", dir: null });
		await runIdeBridgeAction("session-state", "/r", { operation: "config-load" });
	});

	it("optionalString rejects a non-string value", async () => {
		await expect(runIdeBridgeAction("session-state", "/r", { operation: "config-load", dir: 5 })).rejects.toThrow(
			/"dir"/,
		);
	});

	it("stringArrayField rejects a non-array value", async () => {
		await expect(
			runIdeBridgeAction("summary-store", "/r", { operation: "scan-aliases", hashes: "no" }),
		).rejects.toThrow(/"hashes"/);
	});

	it("stringArrayField rejects an array with non-string values", async () => {
		await expect(
			runIdeBridgeAction("summary-store", "/r", { operation: "scan-aliases", hashes: [1, 2] }),
		).rejects.toThrow(/"hashes"/);
	});
});

// ---------- 4. executeIdeBridgeCommand ----------

describe("executeIdeBridgeCommand", () => {
	it("prints a JSON-RPC result envelope for a successful action", async () => {
		const cli = await import("./CliUtils.js");
		vi.mocked(cli.readStdin).mockResolvedValue(JSON.stringify({ operation: "base-key", slug: "s" }));
		const cap = captureConsole();
		await executeIdeBridgeCommand("plan-grouping", "/r");
		expect(cap.stdout[0]).toContain('"result"');
		expect(cap.stdout[0]).toContain('"key":"plan:s"');
		expect(process.exitCode).not.toBe(1);
	});

	it("prints a JSON-RPC error envelope and sets exit code 1 on failure", async () => {
		const cli = await import("./CliUtils.js");
		vi.mocked(cli.readStdin).mockResolvedValue("{}");
		const cap = captureConsole();
		await executeIdeBridgeCommand("no-such-action", "/r");
		expect(cap.stdout[0]).toContain('"error"');
		expect(process.exitCode).toBe(1);
	});

	it("treats an empty stdin body as an empty request object", async () => {
		const cli = await import("./CliUtils.js");
		vi.mocked(cli.readStdin).mockResolvedValue("");
		const cap = captureConsole();
		await executeIdeBridgeCommand("plan-grouping", "/r");
		// plan-grouping's own error surfaces (operation required)
		expect(cap.stdout[0]).toContain('"error"');
		expect(process.exitCode).toBe(1);
	});

	it("rejects a non-object JSON body", async () => {
		const cli = await import("./CliUtils.js");
		vi.mocked(cli.readStdin).mockResolvedValue("[1,2,3]");
		const cap = captureConsole();
		await executeIdeBridgeCommand("plan-grouping", "/r");
		expect(cap.stdout[0]).toContain("Bridge request must be a JSON object");
	});

	it("stringifies a non-Error thrown value using String()", async () => {
		const cli = await import("./CliUtils.js");
		vi.mocked(cli.readStdin).mockRejectedValue("stdin-fail" as never);
		const cap = captureConsole();
		await executeIdeBridgeCommand("plan-grouping", "/r");
		expect(cap.stdout[0]).toContain("stdin-fail");
	});

	it("copies primitive extras from a thrown Error into error.data", async () => {
		// AmbiguousHashError-like: name + primitive extras copied over.
		class MyErr extends Error {
			readonly code = "E_TEST";
			readonly retry = 3;
			readonly ok = false;
			readonly nested = { x: 1 };
			constructor() {
				super("boom");
				this.name = "MyErr";
			}
		}
		const cli = await import("./CliUtils.js");
		vi.mocked(cli.readStdin).mockResolvedValue("{}");
		const { getStatus } = await import("../install/Installer.js");
		vi.mocked(getStatus).mockRejectedValue(new MyErr());
		const cap = captureConsole();
		await executeIdeBridgeCommand("status", "/r");
		const envelope = JSON.parse(cap.stdout[0]);
		expect(envelope.error.data.errorName).toBe("MyErr");
		expect(envelope.error.data.code).toBe("E_TEST");
		expect(envelope.error.data.retry).toBe(3);
		expect(envelope.error.data.ok).toBe(false);
		// non-primitive fields are skipped
		expect(envelope.error.data.nested).toBeUndefined();
	});

	it("redacts fields whose name or value looks like a credential", async () => {
		class LeakyErr extends Error {
			readonly apiKey = "sk-jol-should-not-leak";
			readonly jolliApiKey = "sk-jol-also-should-not-leak";
			readonly authToken = "abc";
			readonly bearerToken = "xyz";
			readonly password = "hunter2";
			readonly secret = "shh";
			readonly credential = "c";
			readonly api_key = "under-score-variant";
			// Innocent-looking field that happens to hold a Jolli API key.
			readonly note = "sk-jol-still-a-key";
			// A JWT-shape string stashed under a neutral name.
			readonly detail = "eyJhbGciOiJI.eyJzdWIi.signaturepart";
			readonly safeCode = "OK_TO_SHOW";
			constructor() {
				super("boom");
				this.name = "LeakyErr";
			}
		}
		const cli = await import("./CliUtils.js");
		vi.mocked(cli.readStdin).mockResolvedValue("{}");
		const { getStatus } = await import("../install/Installer.js");
		vi.mocked(getStatus).mockRejectedValue(new LeakyErr());
		const cap = captureConsole();
		await executeIdeBridgeCommand("status", "/r");
		const raw = cap.stdout[0];
		expect(raw).not.toContain("sk-jol-");
		expect(raw).not.toContain("hunter2");
		const envelope = JSON.parse(raw);
		expect(envelope.error.data.errorName).toBe("LeakyErr");
		expect(envelope.error.data.safeCode).toBe("OK_TO_SHOW");
		// Every sensitive field is dropped, not stringified as [REDACTED].
		expect(envelope.error.data.apiKey).toBeUndefined();
		expect(envelope.error.data.jolliApiKey).toBeUndefined();
		expect(envelope.error.data.authToken).toBeUndefined();
		expect(envelope.error.data.bearerToken).toBeUndefined();
		expect(envelope.error.data.password).toBeUndefined();
		expect(envelope.error.data.secret).toBeUndefined();
		expect(envelope.error.data.credential).toBeUndefined();
		expect(envelope.error.data.api_key).toBeUndefined();
		// Neutral name, sensitive-looking value → still dropped.
		expect(envelope.error.data.note).toBeUndefined();
		expect(envelope.error.data.detail).toBeUndefined();
	});
});

// ---------- 5. runIdeBridgeServe (long-lived server) ----------

/** Fake stdin that behaves like `process.stdin` enough to satisfy readline. */
function makeFakeStdin(): NodeJS.ReadableStream {
	const stream = new PassThrough();
	return stream;
}

/**
 * A scratch stand-in for the machine-global `~/.claude/plans/`, passed by every
 * `runIdeBridgeServe` call below.
 *
 * Without it the `claude-plans` watch target arms on the developer's REAL plans
 * dir: any Claude Code session on the machine saving a plan while these tests
 * run would land a `refresh` notification on the captured stdout, between the
 * handshake and the response line the assertions index into. Deliberately never
 * created — an absent target just starts the (unref'd) arm-retry loop, which is
 * exactly the "before the user's first plan" path.
 */
const SERVE_PLANS_DIR = join(tmpdir(), "ide-bridge-serve-plans-absent");

/** `runIdeBridgeServe` with the plans-dir override every test needs. See [SERVE_PLANS_DIR]. */
function runServe(cwd: string): Promise<void> {
	return runIdeBridgeServe(cwd, { plansDir: SERVE_PLANS_DIR });
}

describe("runIdeBridgeServe", () => {
	it("writes a handshake, dispatches one request line, and exits on stdin EOF", async () => {
		const stdin = makeFakeStdin();
		const originalStdin = process.stdin;
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		const cap = captureConsole();

		const done = runServe("/repo");
		// Give readline a tick to arm.
		await new Promise((r) => setTimeout(r, 5));

		// One valid request line, then EOF.
		(stdin as PassThrough).write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "plan-grouping",
				params: { cwd: "/repo", request: { operation: "base-key", slug: "s" } },
			})}\n`,
		);
		(stdin as PassThrough).end();

		await done;

		// Restore before assertions to avoid leaking a fake stdin into other tests.
		Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });

		const lines = cap.stdout
			.join("")
			.split("\n")
			.filter((l) => l.length > 0);
		// First line is the handshake (method:"ready"), then a response.
		expect(JSON.parse(lines[0]).method).toBe("ready");
		expect(JSON.parse(lines[1])).toMatchObject({ id: 1, result: { key: "plan:s" } });
	});

	it("ignores blank input lines", async () => {
		const stdin = makeFakeStdin();
		const originalStdin = process.stdin;
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		captureConsole();

		const done = runServe("/repo");
		await new Promise((r) => setTimeout(r, 5));

		(stdin as PassThrough).write("\n   \n\n");
		(stdin as PassThrough).end();

		await done;
		Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
	});

	it("emits an error envelope for a malformed request line and keeps running", async () => {
		const stdin = makeFakeStdin();
		const originalStdin = process.stdin;
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		const cap = captureConsole();

		const done = runServe("/repo");
		await new Promise((r) => setTimeout(r, 5));

		(stdin as PassThrough).write("not-json\n");
		(stdin as PassThrough).end();

		await done;
		Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });

		const lines = cap.stdout
			.join("")
			.split("\n")
			.filter((l) => l.length > 0);
		// Handshake + one error envelope.
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const err = JSON.parse(lines[1]);
		expect(err.error).toBeDefined();
	});

	it("arms watchers via computeWatchTargets and emits refresh notifications when they fire", async () => {
		const stdin = makeFakeStdin();
		const originalStdin = process.stdin;
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		const cap = captureConsole();

		const done = runServe("/repo");
		await new Promise((r) => setTimeout(r, 5));

		// Fire the onTrigger on the queue watcher.
		const queue = daemonWatcherInstances.find((w) => w.opts.path === "/repo/queue");
		queue?.opts.onTrigger(new Set());

		(stdin as PassThrough).end();
		await done;
		Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });

		const refresh = cap.stdout
			.join("")
			.split("\n")
			.filter((l) => l.length > 0)
			.map((l) => JSON.parse(l))
			.find((obj) => obj.method === "refresh");
		expect(refresh).toBeDefined();
		expect(refresh.params.kind).toBe("queue");
	});

	it("arms a setInterval retry when a watcher's initial start() fails, and the retry callback clears itself on success", async () => {
		// Real timers are kept — fake timers would break readline's internal
		// tick machinery and hang the for-await loop below. Instead the retry
		// callback is grabbed off the setInterval spy and invoked directly so
		// its two branches (start=false → keep polling; start=true → clear +
		// splice) are both exercised.
		const setIntervalSpy = vi.spyOn(global, "setInterval");
		const clearIntervalSpy = vi.spyOn(global, "clearInterval");

		const { DaemonWatcher } = await import("../daemon/DaemonWatcher.js");
		// First construction: start() returns false first, then true (used when
		// the retry callback re-invokes it). Second construction (orphan-ref)
		// uses the default mock which returns true, so only ONE retry is armed.
		const startResults = [false, false, true];
		vi.mocked(DaemonWatcher).mockImplementationOnce(function DaemonWatcherRetryMock(this: unknown, opts) {
			const start = vi.fn().mockImplementation(() => startResults.shift() ?? true);
			const stop = vi.fn();
			const instance = { opts, start, stop };
			daemonWatcherInstances.push(instance);
			Object.assign(this as object, instance);
		});

		const stdin = makeFakeStdin();
		const originalStdin = process.stdin;
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		captureConsole();

		const done = runServe("/repo");
		await new Promise((r) => setTimeout(r, 5));

		// The 5000ms retry interval is armed exactly once.
		const retryArm = setIntervalSpy.mock.calls.find(([, delay]) => delay === 5000);
		expect(retryArm).toBeDefined();

		// Invoke the retry callback twice: first with start=false (branch that
		// keeps polling), then with start=true (branch that clears the retry).
		const callback = retryArm?.[0] as () => void;
		callback(); // start() returns false here — no clearInterval
		callback(); // start() returns true — clearInterval fires
		expect(clearIntervalSpy).toHaveBeenCalled();

		(stdin as PassThrough).end();
		await done;

		Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
	});
});

// ---------- 6. process-level guards (uncaughtException / unhandledRejection) ----------

describe("runIdeBridgeServe — process-level guards", () => {
	it("registers uncaughtException and unhandledRejection handlers", async () => {
		// spyOn without mockReturnValue would still register the real listener
		// and leak it across tests. Turn it into a no-op so only the spy sees
		// the call.
		const spy = vi.spyOn(process, "on").mockReturnValue(process);
		const stdin = makeFakeStdin();
		const originalStdin = process.stdin;
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		captureConsole();

		const done = runServe("/repo");
		await new Promise((r) => setTimeout(r, 5));
		(stdin as PassThrough).end();
		await done;
		Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });

		const events = spy.mock.calls.map((c) => c[0]);
		expect(events).toContain("uncaughtException");
		expect(events).toContain("unhandledRejection");
	});
});
