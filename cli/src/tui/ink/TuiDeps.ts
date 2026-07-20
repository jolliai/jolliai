/**
 * TuiDeps — the dependency-injection seam for the Ink control-center TUI, the
 * spiritual successor to the old `WatchDeps`. Every side-effecting read/write
 * the screens need is a method here, with `cwd` pre-bound, so components stay
 * pure-ish and tests inject a fake object.
 *
 * `buildTuiDeps` is the production wiring (real modules). Screens and their
 * logic are covered by injecting a fake TuiDeps in `*.test.tsx`; the wiring
 * itself (delegation + the non-trivial `runCommand` / `setEnabled` /
 * `setSkillInstalled` / `installPlugin` bits) is covered by TuiDeps.test.ts.
 */
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getJolliUrl, loadAuthToken } from "../../auth/AuthConfig.js";
import { browserLogin } from "../../auth/Login.js";
import { listMissingCommits, repoHasAnyMemory, runBackfill } from "../../backfill/BackfillEngine.js";
import { COLD_START_CAP, COLD_START_WINDOW_MS } from "../../backfill/ColdStart.js";
import { VERSION } from "../../commands/CliUtils.js";
import { runSpaceSyncStep, type SpaceSyncOutcome } from "../../commands/SpaceSyncStep.js";
import { getCurrentBranch, getProjectRootDir } from "../../core/GitOps.js";
import { getCanonicalRepoUrl } from "../../core/GitRemoteUtils.js";
import { validateJolliApiKey } from "../../core/JolliApiUtils.js";
import { type IngestPhaseLabel, readIngestPhase } from "../../core/LiveStatus.js";
import { resolveLlmCredentialSource } from "../../core/LlmClient.js";
import { getMemoryDetail, listCommittedMemories, type MemoryListItem } from "../../core/MemoryBankModel.js";
import type { QueueStatus } from "../../core/QueueStatus.js";
import { getQueueStatus } from "../../core/QueueStatus.js";
import { readRepoProfile, updateRepoProfile } from "../../core/RepoProfile.js";
import { searchHits } from "../../core/SearchHits.js";
import type { SearchHitResult } from "../../core/SearchIndex.js";
import { getGlobalConfigDir, loadConfig, saveConfigScoped } from "../../core/SessionTracker.js";
import { loadSpaceBindingCache, tenantOriginForKey } from "../../core/SpaceBindingCache.js";
import { track } from "../../core/Telemetry.js";
import { listTopicPageSlugs } from "../../core/TopicPageStore.js";
import { triggerPendingPushRetry } from "../../hooks/PushCompensation.js";
import { disableHost, enableHost, type ToggleableHost } from "../../install/HostToggle.js";
import { getStatus, install, uninstall } from "../../install/Installer.js";
import { type InstalledSkill, installSkill, readInstalledSkills, removeSkill } from "../../install/SkillInstaller.js";
import { getTopicDetail, type TopicDetail } from "../../mcp/McpTools.js";
import type { PluginDiagnostic } from "../../PluginLoader.js";
import { inspectPlugins } from "../../PluginLoader.js";
import { getLastSyncAt } from "../../sync/SyncStateStore.js";
import type { CommitSummary, JolliMemoryConfig, StatusInfo } from "../../Types.js";
import { runNpmCommand, spawnHidden } from "../../util/Subprocess.js";
import { applySetting } from "./SettingsWrite.js";

/** Peak in-memory cap for a captured command's combined stdout+stderr (256 KiB).
 *  The panel only renders the tail, so keeping the last N bytes is lossless for
 *  the user while bounding a verbose/runaway child's memory footprint. */
const MAX_CAPTURED_OUTPUT = 256 * 1024;

export interface TuiIdentity {
	readonly repo: string;
	readonly branch: string;
}

/** The repo's cached Space binding, for the Home dashboard's Sync row. Read from
 *  the local SpaceBindingCache (no network); null when unbound / not yet probed. */
export interface SpaceBinding {
	readonly spaceName: string;
	/** true = can push; null = unknown (older server) — both treated as "syncing". */
	readonly canPush: boolean | null;
}

/** Cold-start back-fill offer for the Home dashboard: the local user's own recent
 *  commits (last {@link COLD_START_WINDOW_MS}, capped at {@link COLD_START_CAP})
 *  that have no memory yet. The dashboard surfaces a "[b] build" affordance when
 *  this is non-null — the TUI-native successor to the old front door's cold-start
 *  prompt (`BackfillFrontDoorStep`). */
export interface BackfillOffer {
	/** Whether the repo already has any memory (false = a brand-new, empty repo). */
	readonly hasMemory: boolean;
	/** The missing commits to offer, newest first. */
	readonly commits: ReadonlyArray<{ readonly hash: string; readonly subject: string }>;
	/** The list hit the cap — there may be older gaps beyond it (`jolli backfill`). */
	readonly capped: boolean;
}

export interface TuiDeps {
	readonly cwd: string;
	/** repo name + current branch for the header. */
	getIdentity(): Promise<TuiIdentity>;
	/** Full install/detection status (hosts, hooks, sessions, dist-paths). */
	getStatus(): Promise<StatusInfo>;
	/** Live summary-generation queue status. */
	getQueueStatus(): Promise<QueueStatus>;
	/** Live wiki/graph ingest phase (for the Queue view). */
	getIngestPhase(): Promise<{ busy: boolean; phase: IngestPhaseLabel }>;
	/** Most recent Space sync (push/fetch) time as ISO, or null if never. */
	getLastSyncAt(): Promise<string | null>;
	/** This repo's cached Space binding (local, no network), or null if unbound. */
	getSpaceBinding(): Promise<SpaceBinding | null>;
	/** Cold-start back-fill offer (own recent commits lacking a memory), or null
	 *  when there is nothing to offer: no LLM credential, a sticky dismiss, no
	 *  gaps, or a detection failure. Best-effort — never throws. */
	getBackfillOffer(): Promise<BackfillOffer | null>;
	/** Sticky, per-repo opt-out: never offer cold-start back-fill here again. */
	dismissBackfill(): Promise<void>;
	/** Build memories for `hashes` (one local LLM call each); `onProgress` gets a
	 *  human line as each commit starts. Resolves with the run's tallies. */
	runColdStartBackfill(
		hashes: string[],
		onProgress?: (msg: string) => void,
	): Promise<{ generated: number; errors: number }>;
	/** Committed memories for the current branch (newest first) — Memories list. */
	listMemories(): Promise<MemoryListItem[]>;
	/** Full summary for one memory, for the Memories detail pane. */
	getMemoryDetail(hash: string): Promise<CommitSummary | null>;
	/** BM25 search over distilled memories (Memories `/` instant search). */
	searchMemories(query: string): Promise<SearchHitResult[]>;
	/** All topic-page slugs (for the Memory Bank topic picker). */
	listTopics(): Promise<ReadonlyArray<string>>;
	/** A topic's readable detail (content + related branches + source timeline) for
	 *  the Memory Bank content pane. Replaces the old refs-only timeline. */
	getTopicDetail(slug: string): Promise<TopicDetail>;
	/** Turn Jolli Memory on/off for this repo (install / uninstall hooks+MCP+skills). */
	setEnabled(on: boolean): Promise<void>;
	/** Auth token (env-first `JOLLI_AUTH_TOKEN`, then config) — drives the Sign-in row. */
	loadAuthToken(): Promise<string | undefined>;
	/** OAuth browser sign-in; `onMessage` receives progress (opened / fallback URL). */
	signInWithBrowser(onMessage?: (msg: string) => void): Promise<void>;
	/** Validate + persist a Jolli API key (`sk-jol-…`). */
	saveJolliApiKey(key: string): Promise<void>;
	/** Persist an Anthropic API key and pin the provider to Anthropic. */
	saveAnthropicKey(key: string): Promise<void>;
	/** Switch the active AI provider (never done silently — only on an explicit step). */
	setAiProvider(provider: "jolli" | "anthropic"): Promise<void>;
	/** Resolve/create the Space binding, sync, and retry pending pushes; `onMessage` for progress.
	 *  Returns the actual outcome so the caller can render a truthful result line. */
	runCloudSync(onMessage?: (msg: string) => void): Promise<SpaceSyncOutcome>;
	/** Per-plugin three-state diagnostics (no install side effect). */
	inspectPlugins(): Promise<PluginDiagnostic[]>;
	/** Install a known plugin globally (`npm install -g <pkg>`); throws on failure. */
	installPlugin(packageName: string): Promise<void>;
	/** Which managed skills are installed, and to which targets. */
	getInstalledSkills(): Promise<InstalledSkill[]>;
	/** Install/remove one skill across both targets (claude-code + agents-std).
	 *  Install skips the claude-code target when the Claude host is disabled, so it
	 *  never re-creates `.claude/skills` behind a "Claude off" toggle; removal always
	 *  clears both. */
	setSkillInstalled(name: string, on: boolean): Promise<void>;
	/** Machine-global config (credentials, toggles, folders). */
	loadConfig(): Promise<JolliMemoryConfig>;
	/** Enable an AI source: flag + on-disk artifacts (hook/repo-MCP/skill). */
	enableHost(host: ToggleableHost): Promise<void>;
	/** Disable an AI source: flag + tear down its on-disk artifacts. */
	disableHost(host: ToggleableHost): Promise<void>;
	/** Persist one config field + run its side effect (see SettingsWrite). */
	applySetting<K extends keyof JolliMemoryConfig>(key: K, value: JolliMemoryConfig[K]): Promise<void>;
	/** Run `jolli <argv>` as a child, CAPTURING combined stdout+stderr (no live
	 *  terminal) so the Home palette can show the result in-panel. Never throws:
	 *  resolves `{ output, exitCode }` (exitCode 0 on success). `signal` lets the
	 *  panel cancel a still-running command. */
	runCommand(argv: string[], signal?: AbortSignal): Promise<{ output: string; exitCode: number }>;
}

export function buildTuiDeps(cwd: string): TuiDeps {
	return {
		cwd,
		getIdentity: async () => ({
			repo: basename(await getProjectRootDir(cwd)),
			branch: await getCurrentBranch(cwd),
		}),
		getStatus: () => getStatus(cwd),
		getQueueStatus: () => getQueueStatus(cwd),
		getIngestPhase: () => readIngestPhase(cwd),
		getLastSyncAt: () => getLastSyncAt(),
		getSpaceBinding: async () => {
			// Cache-first, best-effort: the Home Sync row must never block or throw
			// on cloud/git state. Needs a jolliApiKey (for the tenant origin) and a
			// repo remote (for the cache key); missing either → treat as unbound.
			try {
				const { jolliApiKey } = await loadConfig();
				if (!jolliApiKey) return null;
				const origin = tenantOriginForKey(jolliApiKey);
				if (!origin) return null;
				const repoUrl = await getCanonicalRepoUrl(cwd);
				const entry = await loadSpaceBindingCache(cwd, { repoUrl, origin });
				return entry ? { spaceName: entry.spaceName, canPush: entry.canPush } : null;
			} catch {
				return null;
			}
		},
		getBackfillOffer: async () => {
			// Mirrors the old BackfillFrontDoorStep detection, best-effort: no LLM
			// credential → can't build; a sticky dismiss → never offer; no gaps in the
			// recent window → nothing to do. Any failure returns null (no offer) so the
			// dashboard never blocks or throws on cold-start detection.
			try {
				if (resolveLlmCredentialSource(await loadConfig()) === null) return null;
				if ((await readRepoProfile(cwd)).backfillDismissed === true) return null;
				const missing = await listMissingCommits(cwd, COLD_START_WINDOW_MS, COLD_START_CAP);
				if (missing.length === 0) return null;
				const hasMemory = await repoHasAnyMemory(cwd);
				return {
					hasMemory,
					commits: missing.map((m) => ({ hash: m.commitHash, subject: m.subject })),
					capped: missing.length >= COLD_START_CAP,
				};
			} catch {
				return null;
			}
		},
		dismissBackfill: async () => {
			await updateRepoProfile(cwd, { backfillDismissed: true });
		},
		runColdStartBackfill: async (hashes, onProgress) => {
			// Reuses the shared back-fill engine (one LLM call per commit, stored
			// immediately so a mid-run quit still saves what completed). `onCommitStart`
			// fires as each commit's generation begins, so the dashboard shows live
			// progress instead of a frozen spinner on the first (slow) commit.
			const report = await runBackfill({
				cwd,
				hashes,
				onCommitStart: (index, total, hash, subject) =>
					onProgress?.(`building ${index}/${total} · ${(subject ?? hash).slice(0, 60)}`),
			});
			return { generated: report.generated, errors: report.errors };
		},
		listMemories: async () => listCommittedMemories(cwd, { branch: await getCurrentBranch(cwd) }),
		getMemoryDetail: (hash) => getMemoryDetail(cwd, hash),
		searchMemories: (query) => searchHits(cwd, { query }),
		listTopics: () => listTopicPageSlugs(cwd),
		getTopicDetail: (slug) => getTopicDetail(cwd, slug),
		setEnabled: async (on) => {
			if (on) {
				await install(cwd, { source: "cli" });
				// Keep parity with the old front-door telemetry (GuidedFrontDoor
				// tracked this on enable); TUI-driven enable must not regress it.
				track("surface_enabled", { trigger: "cli" });
			} else {
				await uninstall(cwd);
			}
		},
		loadAuthToken: () => loadAuthToken(),
		signInWithBrowser: (onMessage) => browserLogin(getJolliUrl(), { report: onMessage }),
		saveJolliApiKey: async (key) => {
			validateJolliApiKey(key);
			// Switch the provider to "jolli" alongside the key — mirrors OAuth login
			// (which mints a key AND selects jolli). Without this, a user who had
			// explicitly chosen "anthropic" then pastes a Jolli key stays stuck:
			// resolveLlmCredentialSource honors the explicit "anthropic" and ignores
			// the jolliApiKey, so onboarding never leaves the sign-in step.
			await saveConfigScoped({ jolliApiKey: key, aiProvider: "jolli" }, getGlobalConfigDir());
		},
		saveAnthropicKey: async (key) => {
			await saveConfigScoped({ apiKey: key, aiProvider: "anthropic" }, getGlobalConfigDir());
		},
		setAiProvider: async (provider) => {
			await saveConfigScoped({ aiProvider: provider }, getGlobalConfigDir());
		},
		runCloudSync: async (onMessage) => {
			const outcome = await runSpaceSyncStep(cwd, { nonInteractive: true, report: onMessage });
			triggerPendingPushRetry(cwd, "cli-tui");
			return outcome;
		},
		inspectPlugins: () => inspectPlugins(VERSION),
		installPlugin: async (packageName) => {
			// runNpmCommand validates args against shell metacharacters and returns
			// null on any failure — surface that as an error for the confirm flow.
			const out = await runNpmCommand(["install", "-g", packageName], { timeout: 180_000 });
			if (out === null) throw new Error(`npm install -g ${packageName} failed — try it manually`);
		},
		getInstalledSkills: async () => readInstalledSkills(cwd),
		setSkillInstalled: async (name, on) => {
			// The skills page co-manages both targets, but installing must not
			// resurrect Claude's repo-scoped `.claude/skills` while the Claude host is
			// disabled — AI Agents → Claude off tears those down (disableHost), and
			// re-creating them here would silently contradict that "Claude off" state.
			// Removal stays unconditional on both targets (tearing down is always safe).
			const claudeOff = (await loadConfig()).claudeEnabled === false;
			for (const target of ["claude-code", "agents-std"] as const) {
				if (on) {
					if (target === "claude-code" && claudeOff) continue;
					await installSkill(cwd, name, target);
				} else await removeSkill(cwd, name, target);
			}
		},
		loadConfig: () => loadConfig(),
		enableHost: (host) => enableHost(cwd, host),
		disableHost: (host) => disableHost(cwd, host),
		applySetting: (key, value) => applySetting(key, value),
		runCommand: (argv, signal) =>
			new Promise((resolve) => {
				// Capture (pipe) instead of inherit so nothing hits the raw terminal
				// under Ink; stdin is ignored so any prompt gets EOF and returns fast
				// rather than hanging. NO_COLOR keeps the captured text ANSI-free so
				// Ink's width/layout isn't thrown off.
				// Replay `process.execArgv` so the child re-execs the SAME way this
				// process was launched: empty in production (`node dist/Cli.js`, no-op),
				// but in dev (`tsx src/Cli.ts`) it carries the tsx loader flags — without
				// them the child would be `node src/Cli.ts`, which can't resolve the
				// `.js`-suffixed source imports (ERR_MODULE_NOT_FOUND).
				const child = spawnHidden(process.execPath, [...process.execArgv, process.argv[1], ...argv], {
					// Run against the TUI's selected repo, not the parent shell's cwd —
					// `jolli --cwd <dir>` only binds `cwd` here, it never chdir()s the
					// process, so without this the child would target the launch dir.
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
					signal,
				});
				// Decode across chunk boundaries so a multi-byte UTF-8 sequence split
				// between two `data` events isn't turned into replacement chars.
				const decoder = new StringDecoder("utf8");
				let output = "";
				const absorb = (c: Buffer): void => {
					output += decoder.write(c);
					// Bound peak memory: the panel only ever shows the tail (useCommandRunner
					// caps the transcript too), so a verbose or runaway child can't grow this
					// string without limit while it streams.
					if (output.length > MAX_CAPTURED_OUTPUT) {
						output = output.slice(output.length - MAX_CAPTURED_OUTPUT);
					}
				};
				child.stdout?.on("data", absorb);
				child.stderr?.on("data", absorb);
				child.on("error", (err) => resolve({ output: `${output}${(err as Error).message}`, exitCode: 1 }));
				child.on("close", (code) => resolve({ output: output + decoder.end(), exitCode: code ?? 0 }));
			}),
	};
}
