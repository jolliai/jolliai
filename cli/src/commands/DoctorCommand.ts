/**
 * DoctorCommand — Diagnoses Jolli Memory system health and optionally auto-repairs.
 *
 * Scope (vs `clean`): doctor detects FAULTS — conditions that impair functionality.
 * Examples: crashed lock file blocking the Worker, missing hooks, invalid config,
 * unreadable dist-path. `--fix` repairs these faults so the system works again.
 *
 * What doctor does NOT handle: stale sessions, stale Git queue entries, orphan
 * summary/transcript files. These are redundant/expired data — their presence
 * never breaks functionality, only wastes space. Those belong to `clean`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { orphanBranchExists } from "../core/GitOps.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { isWorkerLockStale, releaseWorkerLock } from "../core/Locks.js";
import { getBackend } from "../core/localagent/BackendRegistry.js";
import { describeCandidate } from "../core/localagent/ExecutableResolver.js";
import { localAgentToolLabel, localAgentToolLoginHint } from "../core/localagent/ToolMeta.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { findStrandedRoots } from "../core/repair/StrandedTrees.js";
import {
	countActiveQueueEntries,
	getGlobalConfigDir,
	loadAllSessions,
	loadConfig,
	rewindCodexCursors,
} from "../core/SessionTracker.js";
import { resolveSotBackend } from "../core/SotStorageResolver.js";
import { createStorage } from "../core/StorageFactory.js";
import { listSummaries, setActiveStorage } from "../core/SummaryStore.js";
import { getTranscriptIds } from "../core/SummaryTree.js";
import { repairSummaryTranscripts } from "../core/TranscriptRepair.js";
import { probeGlobalDaemon } from "../daemon/EnsureGlobalDaemon.js";
import type { GlobalDaemonHello } from "../daemon/GlobalDaemonProtocol.js";
import { backupHealthCheck } from "../dashboard/Backup.js";
import {
	canUseDashboardDb,
	findDriftedMigrations,
	getDashboardDbPath,
	inTransaction,
	type MigrationLogRow,
	type MigrationLogState,
	readMigrationLogState,
	recordMigrationAsApplied,
	withReadonlyDashboardDb,
	withRepairDashboardDb,
} from "../dashboard/DashboardDb.js";
import { classifyDbFiles } from "../dashboard/DbDetection.js";
import {
	fillMemoriesFromFrozenOrphans,
	fillMemoriesFromMirrors,
	restoreFromSnapshot,
	surveyRecovery,
} from "../dashboard/Recovery.js";
import { backupRepoRegistry, forgetRepos, type RegistrySurvey, surveyRepoRegistry } from "../dashboard/RepoForget.js";
import { getRepoRegistryPath, type RegistryRepair, repairRegistryEntries } from "../dashboard/RepoRegistry.js";
import { traverseDistPaths } from "../install/DistPathResolver.js";
import { getStatus, install } from "../install/Installer.js";
import { createLogger, errMsg, ORPHAN_BRANCH, setLogDir } from "../Logger.js";
import { inspectPlugins } from "../PluginLoader.js";
import { resolveProjectDir, VERSION } from "./CliUtils.js";

const log = createLogger("doctor");

/** Individual check result returned by each diagnostic probe. */
export interface DoctorCheck {
	readonly name: string;
	readonly status: "ok" | "warn" | "fail";
	readonly message: string;
	/** Optional fixer that applies a remedy and returns a new message describing what was done. */
	readonly fixer?: () => Promise<string>;
}

/**
 * The daemon's row. Exported for tests, and pure so the formatting can be
 * asserted without a live socket.
 *
 * "Not running" is a WARNING, never a failure, and the ordering with the
 * "Database backup" row is the reason: that row reports whether snapshots are
 * actually landing, which is the question that matters. A daemon that is up but
 * has never produced a snapshot is a worse state than no daemon with the
 * opportunistic callers keeping up — so the process must never be presented as
 * evidence that the work is getting done.
 */
export function formatGlobalDaemonCheck(hello: GlobalDaemonHello | undefined, nowMs: number): DoctorCheck {
	if (!hello) {
		return {
			name: "Global daemon",
			status: "warn",
			message: "not running — scheduled work falls back to commit-time triggers",
		};
	}
	const upHours = Math.floor((nowMs - hello.startedAt) / (60 * 60 * 1000));
	return {
		name: "Global daemon",
		status: "ok",
		message: `running (pid ${hello.pid}, v${hello.version}, up ${upHours}h)`,
	};
}

/**
 * The repo-registry row: entries that name a checkout no longer on disk.
 *
 * A `warn`, never a `fail`, and the distinction is this command's own contract —
 * doctor reports FAULTS, and a stale entry breaks nothing. It costs every sweep a
 * pass and puts a dead row in the dashboard's repo picker, which is worth saying
 * and is not worth a non-zero exit on an otherwise healthy machine.
 *
 * The message lists every entry, uncapped. This is a diagnostic the user ran on
 * purpose, `--fix` is irreversible, and the list is the only thing they have to
 * decide with — a summary count plus "see debug.log" is the shape that gets
 * skipped. It also shrinks to nothing after the first fix.
 *
 * Exported and pure-ish (it takes the survey) so the wording can be asserted
 * without a registry on disk.
 */
export function formatRepoRegistryCheck(
	survey: RegistrySurvey,
	repairs: ReadonlyArray<RegistryRepair>,
	fixer: () => Promise<string>,
	opts: { readonly forgetDead?: boolean } = {},
): DoctorCheck {
	const name = "Repo registry";
	const forgetDead = opts.forgetDead === true;
	// `dead` is opt-in — see {@link applyRepoRegistryFix}. It is still REPORTED
	// either way, so the ok branch cannot key off `removable`, which is only what
	// the fixer would act on.
	const removable = [...survey.disposable, ...(forgetDead ? survey.dead : [])];
	const reported = survey.disposable.length + survey.dead.length + survey.unavailable.length + repairs.length;
	if (reported === 0) {
		const n = survey.live.length;
		return { name, status: "ok", message: `${n} repo${n === 1 ? "" : "s"}, every recorded checkout present` };
	}
	const lines: string[] = [];
	for (const repo of survey.disposable) {
		lines.push(`      · ${repo.worktreeRoot}  (temporary checkout — removed automatically)`);
	}
	const deadBy = forgetDead ? "--fix" : "--fix --forget-dead-repos";
	for (const repo of survey.dead) lines.push(`      · ${repo.worktreeRoot}  (folder gone — removed by ${deadBy})`);
	for (const repo of survey.unavailable) {
		// Never in `removable`: an unplugged drive or an unmounted share is a repo
		// the user still expects back, and removing it on this evidence would throw
		// away a registration for a directory that returns. Reported so the silence
		// does not read as health.
		lines.push(`      · ${repo.worktreeRoot}  (drive or share not mounted — left alone)`);
	}
	for (const repair of repairs) {
		const what = [
			repair.droppedPaths.length > 0 ? `${repair.droppedPaths.length} stale temp path(s)` : "",
			repair.collapsedPaths.length > 0 ? `${repair.collapsedPaths.length} duplicate spelling(s)` : "",
			repair.repointedTo !== undefined ? "a dead recorded root" : "",
		].filter(Boolean);
		lines.push(`      · ${repair.repoIdentity}  (${what.join(", ")} — repaired by --fix)`);
	}
	const headline = [
		removable.length > 0 ? `${removable.length} entr${removable.length === 1 ? "y" : "ies"} to remove` : "",
		!forgetDead && survey.dead.length > 0 ? `${survey.dead.length} to forget with --forget-dead-repos` : "",
		repairs.length > 0 ? `${repairs.length} to repair` : "",
		survey.unavailable.length > 0 ? `${survey.unavailable.length} on unavailable volumes` : "",
	]
		.filter(Boolean)
		.join(", ");
	return {
		name,
		status: "warn",
		message: `${headline}\n${lines.join("\n")}`,
		// No fixer when there is nothing this INVOCATION may act on: an unavailable
		// volume is deliberately not repairable, a `dead` entry needs
		// `--forget-dead-repos`, and offering a button that does nothing is worse
		// than offering none. `removable`, not the reported set, is what says so.
		...(removable.length > 0 || repairs.length > 0 ? { fixer } : {}),
	};
}

/**
 * The repo-registry row's remedy: back the registry up, forget what the survey
 * found removable, then apply the path repairs.
 *
 * Exported and taking the survey as an argument for the same reason
 * {@link formatRepoRegistryCheck} is: the fixer is the one half of this row that
 * deletes data, and driving the whole command to reach it would mean running
 * every other fixer too.
 *
 * **`dead` entries need `forgetDead` (`--forget-dead-repos`), and that is the
 * consent this operation could not otherwise obtain.** `--fix` is a bundle — a
 * user runs it to release a stale lock, clear a stuck queue or reinstall hooks —
 * and forgetting a repo is not like the other three: `forgetRepos` deletes twelve
 * child tables, the `repos` row and every unprojected event, none of which
 * {@link backupRepoRegistry} can restore (it copies `dashboard-repos.json`, and
 * that file holds none of it). The evidence is weak in the same direction:
 * `classifyRegistryEntry` documents that an unmounted POSIX mountpoint usually
 * still exists as an empty directory, so `dead` can hold a repo that is merely
 * renamed or temporarily invisible. `disposable` stays in the default set — that
 * class is fixture garbage under `%TEMP%` which the dashboard launch path already
 * prunes unattended, so requiring a flag here would not protect anything.
 *
 * **The dashboard's per-row ✕ removes the same `dead` class on one confirm, and
 * that is not the contradiction it looks like.** What the flag buys is not a
 * second look at the evidence — it is a NAMED TARGET. `--fix` is asked for by a
 * user who wants something else entirely and would sweep whatever the survey
 * happened to classify; the ✕ is attached to one row, in a dialog that says what
 * it deletes, for the repository the user pointed at. `DashboardServer.handleForget`
 * carries the two guards this side cannot express in a flag: it re-asks at action
 * time, because its control is drawn from a payload minutes old, and it refuses
 * `unavailable` unless the request carries a per-row acknowledgement the page only
 * sets after naming the volume in a second dialog. THIS side stays stricter and
 * never removes `unavailable` at all: a sweep has no row to point at and no dialog
 * to show, so there is nothing here for such an acknowledgement to mean. It takes
 * this same backup first, for the same ordering reason, and with the same limit:
 * the file holds no memories, so neither path may treat it as what makes a removal
 * recoverable.
 */
export async function applyRepoRegistryFix(
	survey: RegistrySurvey,
	opts: {
		readonly nowMs?: number;
		readonly configDir?: string;
		readonly dbPath?: string;
		readonly forgetDead?: boolean;
	} = {},
): Promise<string> {
	const done: string[] = [];
	// Backup FIRST: everything below is irreversible, and a backup taken after the
	// first removal is a backup of the damage.
	const saved = backupRepoRegistry(opts.nowMs ?? Date.now(), opts.configDir);
	if (saved) done.push(`backed up the registry to ${saved}`);
	// `unavailable` is deliberately absent: an unplugged drive is a repo the user
	// still expects back, so it is reported and never removed. `dead` is absent
	// unless asked for — see above.
	const removable = [...survey.disposable, ...(opts.forgetDead === true ? survey.dead : [])];
	if (removable.length > 0) {
		const results = await forgetRepos(
			removable.map((repo) => repo.repoIdentity),
			{
				...(opts.configDir ? { configDir: opts.configDir } : {}),
				...(opts.dbPath ? { dbPath: opts.dbPath } : {}),
			},
		);
		const failed = results.filter((r) => r.error !== undefined);
		// Thrown, not counted: the fixer contract is that a throw is what makes the
		// loop print ✗ and set the exit code, and a partial removal reported as
		// success is exactly the state a user would not run doctor again over.
		if (failed.length > 0) {
			throw new Error(`could not forget ${failed.length} of ${results.length} entries — ${failed[0].error}`);
		}
		done.push(`forgot ${results.length} entr${results.length === 1 ? "y" : "ies"}`);
	}
	const applied = await repairRegistryEntries(opts.configDir ? { configDir: opts.configDir } : {});
	if (applied.length > 0) done.push(`repaired ${applied.length} entr${applied.length === 1 ? "y" : "ies"}`);
	return done.length > 0 ? done.join("; ") : "nothing left to do";
}

/**
 * The repo-registry row when the registry could not be READ at all.
 *
 * A `fail` with no fixer, and both halves are deliberate. It is a fault rather
 * than a warning because every writer of this file — `registerRepo`,
 * `ensureWorktreeListed`, `removeReposFromRegistry`, the prune — is a read-modify-write
 * over `readRepoRegistryStrict`, so an unreadable registry means no repo can
 * register on this machine until it is dealt with. And there is no fixer because
 * the remedy is the one thing this command must not do unasked: the file has to be
 * moved aside, which discards every registration it holds.
 */
export function formatRepoRegistryReadFailure(reason: string, path: string): DoctorCheck {
	return {
		name: "Repo registry",
		status: "fail",
		message:
			`unreadable — ${reason}\n` +
			`      · ${path}\n` +
			"      · no repo can register until this is resolved; move the file aside and re-run `jolli enable`\n" +
			"        in each repo to rebuild it (every registration in it is lost)",
	};
}

/** What {@link probeParkedEvents} could establish about the event log. */
type ParkedProbe =
	/** Counted. `stuck` excludes the rows a later build revives by itself. */
	| { readonly kind: "counted"; readonly stuck: number }
	/** No database to ask — below the `node:sqlite` floor, or never opened. */
	| { readonly kind: "absent" }
	/** A database that is there and cannot be read. */
	| { readonly kind: "unreadable"; readonly reason: string };

/**
 * Asks the event log how many parked events need a human, distinguishing the
 * three answers a diagnostic must not conflate.
 *
 * Folding "no database" together with "corrupt database" gets the second one
 * backwards for the one command whose job is to tell them apart. A zero-byte or
 * truncated `jollimemory.db` opens read-only WITHOUT error and throws on the first
 * statement, so it lands in the same silent branch as a machine that has never
 * opened the dashboard — and `jolli doctor` then prints no row at all for the
 * state that permanently disables the daemon's re-scan (`database-unusable`).
 *
 * Absence is decided BEFORE the open, by `existsSync`, not from the error — a
 * read-only open of a missing file throws `ERR_SQLITE_ERROR: unable to open
 * database file` carrying no `ENOENT`, so an error-shape test cannot tell "never
 * created" from "there and broken".
 *
 * Read-only on purpose: `withReadonlyDashboardDb` throws where a writable handle
 * would CREATE the file, and a diagnostic must not drain the log — counting
 * through a writable handle would run `drainPending` and change the answer it is
 * reporting. {@link countStuckEvents} is the count deliberately: it matches the
 * daemon's own `failedEvents` metric (whose log line points here) and the set
 * {@link unparkStuckEvents} `--fix` can actually reach.
 */
async function probeParkedEvents(): Promise<ParkedProbe> {
	if (!canUseDashboardDb()) return { kind: "absent" };
	if (!existsSync(getDashboardDbPath())) return { kind: "absent" };
	try {
		const { countStuckEvents } = await import("../dashboard/StatsWriter.js");
		return { kind: "counted", stuck: await withReadonlyDashboardDb((db) => countStuckEvents(db)) };
	} catch (err) {
		return { kind: "unreadable", reason: errMsg(err) };
	}
}

/**
 * `doctor --fix` for parked events: returns them to the queue AND drains, so the
 * numbers are correct when the command exits.
 *
 * Draining here rather than leaving it to the next natural drain is the point.
 * Un-parking alone is honest but useless as a fix: the next drain is whatever
 * comes first — a commit's QueueWorker or the editor's 60 s tick — so a user who
 * is not committing right now would read `10 event(s) returned to the queue`,
 * see the dashboard unchanged, and reasonably conclude `--fix` did nothing. The
 * cost is that doctor now does projection work while holding the writable
 * handle, contending with hooks for SQLite's single writer; one bounded batch
 * (`DRAIN_BATCH_SIZE`) covers any realistic parked set, and doctor is an
 * interactive command, not a hot path.
 *
 * The projected count is reported alongside the revived one because they can
 * differ, and the difference is the whole answer: an event that fails again is
 * NOT re-parked by this call. Measured: one drain spends exactly ONE attempt, so
 * a still-defective row comes back `pending` with `attempts = 1` and only re-parks
 * after five failed drains. Reporting "1 revived" alone would read as a completed
 * repair when nothing was actually recovered.
 *
 * What is left over is taken from `drainPending`'s own `pending` — a COUNT off
 * the table — never from `revived - projected`. That subtraction was wrong in
 * both directions: the drain is capped at `DRAIN_BATCH_SIZE`, so a large parked
 * set leaves rows this pass never claimed and the difference understates them;
 * and `projected` also counts pending rows that were already queued before the
 * un-park, so it can exceed `revived` and make the difference negative. The
 * table knows the answer, and it is asked.
 *
 * Fixer contract (see the "Git hooks" fixer): THROW on failure so the doctor
 * loop records it; return a string describing what was done on success.
 */
async function repairParkedDashboardEvents(): Promise<string> {
	const { withDashboardDb } = await import("../dashboard/DashboardDb.js");
	const { drainPending, unparkStuckEvents } = await import("../dashboard/StatsWriter.js");
	return await withDashboardDb((db) => {
		const revived = unparkStuckEvents(db);
		// Reachable despite the fixer being attached only when the count is
		// non-zero: the diagnosis read a different, read-only handle, and another
		// doctor may have won the race in between.
		if (revived === 0) return "nothing parked";
		const { projected, pending } = drainPending(db);
		if (pending === 0) return `${revived} revived, ${projected} projected`;
		return `${revived} revived, ${projected} projected, ${pending} still queued (will retry)`;
	});
}

/**
 * Diagnoses system health and optionally auto-repairs failures.
 *
 * Rule of thumb:
 *   doctor → "is Jolli Memory working?"
 *   clean  → "what old data can I safely delete?"
 */
async function runDoctor(cwd: string, fix: boolean, dryRun = false, forgetDead = false): Promise<void> {
	const checks: DoctorCheck[] = [];

	// 1. Installer status (hooks)
	const status = await getStatus(cwd);
	// A manual disable is the user's highest-priority intent: missing hooks are
	// then expected, not a fault. Report it as OK and offer no reinstall fixer, so
	// `doctor --fix` never silently re-enables a repo the user turned off.
	const manuallyDisabled = await readManualDisableFlag(cwd);

	if (manuallyDisabled) {
		checks.push({
			name: "Git hooks",
			status: "ok",
			message: "manually disabled — run `jolli enable` to re-enable",
		});
	} else if (!status.gitHookInstalled) {
		checks.push({
			name: "Git hooks",
			status: "fail",
			message: "not installed — run `jolli enable` to install",
			fixer: async () => {
				// Fixer contract: throw on failure so the doctor loop records the
				// failure (exit code, ✗ icon). A success path must return a string.
				const result = await install(cwd, { source: "cli", respectManualDisable: true });
				if (!result.success) throw new Error(result.message);
				return "reinstalled";
			},
		});
	} else {
		checks.push({ name: "Git hooks", status: "ok", message: "installed" });
	}

	checks.push({
		name: "Claude hook",
		/* v8 ignore next 2 -- ternary: hook presence depends on external installation state */
		status: status.claudeHookInstalled ? "ok" : "warn",
		message: status.claudeHookInstalled ? "installed" : "not installed (optional)",
	});

	checks.push({
		name: "Gemini hook",
		/* v8 ignore start -- ternary: hook presence depends on external installation state */
		status: status.geminiHookInstalled ? "ok" : "warn",
		message: status.geminiHookInstalled ? "installed" : "not installed (optional)",
		/* v8 ignore stop */
	});

	// 2a. System of record — which backend holds this repo's truth, and is it
	// reachable. This is the check that answers "can memories be stored";
	// `resolveSotBackend` is the diagnostic-shaped resolver precisely so a
	// doctor can REPORT `blocked` instead of throwing on the one state a user
	// runs doctor to understand.
	const sot = await resolveSotBackend(cwd);
	checks.push({
		name: "System of record",
		status: sot.ok ? "ok" : "fail",
		message: sot.ok
			? sot.state === "uncutover"
				? `orphan branch (${ORPHAN_BRANCH})`
				: `SQLite (${sot.state})`
			: `unavailable — ${sot.reason}`,
	});

	// 2b. Orphan branch — informational only. Its absence used to be reported as
	// a warning meaning "no memories yet", which is wrong past a cutover: the
	// branch is frozen (or was never cloned) precisely because the database
	// took over, so warning about it sends the user looking for a fault that
	// does not exist. The data question is the check above.
	// `!sot.ok` counts as cut over, not as "unknown": the resolver reports
	// `blocked` only for a repo that IS fenced, so telling that user the branch
	// "will be created on first commit" promises something the fence forbids —
	// and that is precisely the reader who has a broken repo and is looking for
	// the reason. (An un-cutover repo with no database resolves `ok` — verified:
	// the router reports "orphan remains authoritative" and lands here as
	// `uncutover`.)
	const branchExists = await orphanBranchExists(ORPHAN_BRANCH, cwd);
	const cutOver = !sot.ok || sot.state !== "uncutover";
	checks.push({
		name: "Orphan branch",
		status: "ok",
		message: branchExists
			? cutOver
				? "present but frozen (this repo is cut over to SQLite)"
				: "exists"
			: cutOver
				? "absent (expected — this repo is cut over to SQLite)"
				: "not yet created (will be created on first commit)",
	});

	// 2c. Memory tree — a stranded root (one an amend, rebase or squash left
	// under a commit hash the branch no longer has) is reported but never
	// repaired here: `jolli repair-memory` can call the LLM, cost money, take
	// tens of seconds and fail, and every other `--fix` repair in this command
	// is instant, free and idempotent. Folding this one in would make running
	// `doctor --fix` a risky act, so this check carries no `fixer` at all.
	//
	// Detection failure must NOT read as "ok" — this check exists to surface a
	// failure class (a memory tree stranded with nothing reporting it) that was
	// previously invisible, so silently answering "no stranded trees" when
	// detection itself failed (non-git cwd, a storage error, ...) reproduces
	// that exact blind spot inside the tool built to remove it.
	let strandedCheck: DoctorCheck;
	try {
		const stranded = await findStrandedRoots(cwd);
		strandedCheck =
			stranded.length === 0
				? { name: "Memory tree", status: "ok", message: "no stranded trees" }
				: {
						name: "Memory tree",
						status: "warn",
						message: `${stranded.length} stranded tree(s) — run \`jolli repair-memory\` to reattach`,
					};
	} catch (err) {
		strandedCheck = {
			name: "Memory tree",
			status: "warn",
			message: `could not determine — ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	checks.push(strandedCheck);

	// 3. Worker lock (stuck = exists AND older than LOCK_HEARTBEAT_TIMEOUT_MS; a normal worker
	// refreshes mtime every minute, so any age > 5 min implies a crashed worker).
	// `orphan-write.lock` is held only for milliseconds and is not surfaced here —
	// if a stale orphan-write lock ever appears, doctor's `--fix` would release it
	// implicitly via a re-run of the affected operation.
	const workerLockStale = await isWorkerLockStale(cwd);
	if (workerLockStale) {
		checks.push({
			name: "Worker lock",
			status: "fail",
			message: "stuck (older than 5 min — Worker probably crashed) — use --fix to release",
			fixer: async () => {
				await releaseWorkerLock(cwd);
				return "released";
			},
		});
	} else {
		checks.push({ name: "Worker lock", status: "ok", message: "not stuck" });
	}

	// 4. Active sessions (informational; stale entries are cleanup concerns → `clean`)
	const sessions = await loadAllSessions(cwd);
	checks.push({ name: "Sessions", status: "ok", message: `${sessions.length} active` });

	// 5. Active Git queue entries — > 10 active entries indicates a stuck Worker (fault).
	// Stale queue entries (> 7 days) are redundant data and handled by `clean`.
	const activeQueueCount = await countActiveQueueEntries(cwd);
	if (activeQueueCount > 10) {
		checks.push({
			name: "Git queue",
			status: "warn",
			message: `${activeQueueCount} entries (high — Worker may be stuck)`,
		});
	} else {
		checks.push({
			name: "Git queue",
			status: "ok",
			/* v8 ignore next -- ternary: test always takes one path */
			message: activeQueueCount === 0 ? "empty" : `${activeQueueCount} entries`,
		});
	}

	// 6. Config validity — check credential availability using the same precedence
	// rules as the LLM dispatcher, so doctor never disagrees with what callLlm would
	// actually accept (including the documented ANTHROPIC_API_KEY env var fallback).
	const config = await loadConfig();
	const credentialSource = resolveLlmCredentialSource(config);
	const localAgentTool = config.localAgentTool ?? "claude-code";
	const credentialLabel: Record<NonNullable<typeof credentialSource>, string> = {
		"anthropic-config": "Anthropic API key (config)",
		"anthropic-env": "Anthropic API key (ANTHROPIC_API_KEY env)",
		"jolli-proxy": "Jolli proxy key",
		"local-agent": `local agent (${localAgentToolLabel(localAgentTool)})`,
	};
	checks.push({
		name: "Config",
		status: credentialSource ? "ok" : "warn",
		message: credentialSource
			? `credentials found — ${credentialLabel[credentialSource]}`
			: "no credentials — summaries will not be generated",
	});

	// For local-agent the "credential" is an executable, not a stored key — so a
	// green Config check above only means the provider is *selected*. Probe the
	// binary here (the resolver is cheap and verifies it accepts the flags we
	// pass) so doctor doesn't report healthy while every commit silently fails
	// with a setup error because `claude` is missing or off the worker's PATH.
	if (credentialSource === "local-agent") {
		try {
			const backend = getBackend(localAgentTool);
			const exe = await backend.discoverExecutable(config.localAgentPath);
			// describeCandidate, not exe.file: a shim-resolved tool spawns through an
			// interpreter, so the bare file is `…\node.exe` — which reads as doctor
			// having picked the wrong binary entirely.
			checks.push({
				name: "Local agent CLI",
				status: "ok",
				message: `${describeCandidate(exe)} (v${exe.version})`,
			});
		} catch (err) {
			// Append the tool-specific login hint so a not-signed-in user gets
			// actionable guidance instead of just the raw discovery error.
			const loginHint = localAgentToolLoginHint(localAgentTool);
			// An explicit `localAgentPath` short-circuits discovery, so when the probe
			// fails WITH one set, the path itself is the likeliest cause — including
			// the case it was set for a different tool before `saveConfigScoped`
			// started clearing orphans (configs that drifted under an older version
			// heal on the next tool switch, never on their own). Name the escape
			// hatch, because nothing else tells the user discovery was skipped.
			const overrideHint = config.localAgentPath
				? " Discovery was skipped because localAgentPath is set — clear it with `jolli configure --remove localAgentPath` to auto-discover instead."
				: "";
			checks.push({
				name: "Local agent CLI",
				status: "fail",
				message: `${(err as Error).message} — ${loginHint}${overrideHint}`,
			});
		}
	}

	// 7. dist-paths/<source> entries (per-source registry).
	// No legacy `dist-path` probe: every `install()` migrates the legacy file
	// into dist-paths/<derived> and deletes the original, so a healthy system
	// only ever has dist-paths/ entries. An empty registry means the user
	// never ran `jolli enable` on this install.
	const globalDir = getGlobalConfigDir();
	const allSources = traverseDistPaths(globalDir);
	if (allSources.length === 0) {
		checks.push({
			name: "dist-paths",
			status: "fail",
			message: "no sources registered — run `jolli enable`",
		});
	} else {
		for (const entry of allSources) {
			const isStale = !entry.available;
			checks.push({
				name: `dist-paths/${entry.source}`,
				status: isStale ? "warn" : "ok",
				message: isStale
					? `\n      Version: ${entry.version}\n      Path:    ${entry.distDir} (MISSING)`
					: `\n      Version: ${entry.version}\n      Path:    ${entry.distDir}`,
				fixer: isStale
					? async () => {
							const { unlink } = await import("node:fs/promises");
							await unlink(join(globalDir, "dist-paths", entry.source));
							return "removed stale entry";
						}
					: undefined,
			});
		}
	}

	// 8. Known plugins. Only installed plugins are reported — an absent plugin
	// is the normal state for most users (the commands still surface via stubs
	// in `jolli --help`), so listing them here would be noise. An `incompatible`
	// plugin is a warn (not a fail): the CLI keeps working because the stub takes
	// over, but the user should know to upgrade.
	//
	// `inspectPlugins` is a no-load probe: `ok` means "installed and version-
	// compatible", NOT "loaded successfully". A plugin with a broken `main`,
	// failed import, or throwing `register()` is still version-compatible and
	// reads `ok` here — the loader rejects it separately and warns at load time.
	// The row text says "installed, compatible" (not "working") to avoid
	// overstating what this check actually verified.
	for (const p of await inspectPlugins(VERSION)) {
		if (p.state === "absent") continue;
		const version = p.installedVersion ?? "unknown";
		if (p.state === "ok") {
			checks.push({
				name: `plugin ${p.packageName}`,
				status: "ok",
				message: `v${version} (installed, compatible)`,
			});
		} else {
			// `incompatible` implies a declared peer range — isPeerCompatible only
			// returns false when peerRange is present and unsatisfied — so peerRange
			// is always a string here.
			checks.push({
				name: `plugin ${p.packageName}`,
				status: "warn",
				message: `v${version} requires @jolli.ai/cli ${p.peerRange}, but you have ${VERSION} — upgrade the CLI (npm update -g @jolli.ai/cli) or reinstall a compatible plugin (${p.installHint})`,
			});
		}
	}

	// 9. Global daemon — context for the backup row below, never a substitute
	// for it.
	checks.push(formatGlobalDaemonCheck(await probeGlobalDaemon(), Date.now()));

	// 10. Database backup health — the cutover gate's reporting row. An illegal
	// stored folder or week-stale snapshots are failures; "drive unplugged" is
	// a warning that escalates after seven days.
	const backup = await backupHealthCheck(Date.now());
	checks.push({
		name: "Database backup",
		status: backup.status,
		message: backup.message,
		// A `fail` with no fixer is a dead end: `doctor` exits 1 and `doctor --fix`
		// has nothing to run, which is what a week without a commit produced on an
		// otherwise healthy install. Staleness is fixable here and says so; an
		// invalid folder or an unreachable drive is not, and offers no button.
		...(backup.fixable
			? {
					fixer: async (): Promise<string> => {
						const { opportunisticSnapshot } = await import("../dashboard/Backup.js");
						const result = await opportunisticSnapshot();
						if (result.status === "created") return `snapshot written to ${result.path}`;
						return `snapshot not taken: ${result.reason}`;
					},
				}
			: {}),
	});

	// 11. Repo registry — entries whose checkout is gone. Its own row rather than
	// part of the backup one because it is the only check about the machine's LIST
	// of repos rather than about one repo's data, and the only one whose fixer
	// removes something.
	//
	// The repair half is computed with `dryRun`, i.e. by the pass that would apply
	// it, so the preview cannot drift from the fix. The removals come from the
	// survey, which is read-only anyway.
	//
	// Guarded, and the guard covers BOTH calls. `repairRegistryEntries` reads the
	// registry strictly (it is a read-modify-write), so corrupt JSON, an EACCES or a
	// Windows AV hold throws — on precisely the machine this command exists for. An
	// unguarded throw here costs every other check too: nothing has been PRINTED
	// yet, so the user gets `Fatal error:` in place of all ten diagnoses above.
	// `surveyRepoRegistry` is inside the same `try` because it reads fail-open:
	// reporting its answer after the strict read failed would print "0 repos, every
	// recorded checkout present" about a registry that could not be read at all.
	try {
		const registrySurvey = await surveyRepoRegistry();
		const registryRepairs = await repairRegistryEntries({ dryRun: true });
		checks.push(
			formatRepoRegistryCheck(
				registrySurvey,
				registryRepairs,
				() => applyRepoRegistryFix(registrySurvey, { forgetDead }),
				{ forgetDead },
			),
		);
	} catch (err) {
		checks.push(formatRepoRegistryReadFailure(errMsg(err), getRepoRegistryPath()));
	}

	// 12. Parked dashboard events — the ONE fault in this list that is otherwise
	// invisible. An event that never projects is a conversation the dashboard will
	// never show, and nothing else reports one: no projected row to notice missing,
	// no reader that queries `events_raw`, and a prune that only deletes `projected`
	// rows so a failure never even ages out. `warn` rather than `fail`: the memories
	// themselves are safe in the system of record, so this must not make an
	// otherwise-healthy install exit non-zero.
	//
	// The probe has three answers and they need different wording. `counted` uses
	// `countStuckEvents`, which excludes the `unknown-type` rows a later build revives
	// by itself — so a non-zero count really does need a human — and matches BOTH the
	// daemon's `failedEvents` metric (whose log line sends the user here) and the set
	// `--fix` (`unparkStuckEvents`) can actually return to the queue. `unreadable` is
	// its own row because an unreadable database is precisely the state that
	// permanently disables the daemon's re-scan, and doctor used to print nothing at
	// all for it; no fixer, because re-queuing cannot repair a database that will not
	// open.
	const parked = await probeParkedEvents();
	if (parked.kind === "unreadable") {
		checks.push({
			name: "Dashboard events",
			status: "warn",
			message: `dashboard database present but unreadable (${parked.reason}) — the background re-scan is stopped`,
		});
	} else {
		const stuck = parked.kind === "counted" ? parked.stuck : 0;
		checks.push({
			name: "Dashboard events",
			status: stuck > 0 ? "warn" : "ok",
			message:
				stuck > 0
					? `${stuck} event(s) parked after repeated projection failures — dashboard figures are incomplete`
					: "none parked",
			// Attached only when there is something to do, so `--fix` on a healthy
			// machine does not print a line about work it did not need to perform.
			...(stuck > 0 ? { fixer: repairParkedDashboardEvents } : {}),
		});
	}

	// Print results
	console.log("\n  Jolli Memory Doctor");
	console.log("  ──────────────────────────────────────");

	let hasFailures = false;
	const fixesToApply: DoctorCheck[] = [];

	for (const check of checks) {
		const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗";
		console.log(`  ${icon} ${check.name.padEnd(16)} ${check.message}`);
		if (check.status === "fail") hasFailures = true;
		// `--dry-run` collects the same set `--fix` would, so what it lists is what
		// would run rather than a second opinion about it.
		if ((fix || dryRun) && check.fixer) fixesToApply.push(check);
	}

	if (dryRun && fixesToApply.length > 0) {
		console.log("\n  --fix would apply:");
		// The message, not a paraphrase — every fixer's row already names what it
		// found, and restating it here would be a second wording to keep in step.
		for (const check of fixesToApply) console.log(`  → ${check.name}: ${check.message}`);
	}

	// Apply fixes if requested.
	let fixFailures = 0;
	if (fix && !dryRun && fixesToApply.length > 0) {
		console.log("\n  Applying fixes...");
		for (const check of fixesToApply) {
			/* v8 ignore start -- defensive: fixesToApply already filtered by check.fixer existence */
			if (!check.fixer) continue;
			/* v8 ignore stop */
			try {
				const result = await check.fixer();
				console.log(`  ✓ ${check.name}: ${result}`);
			} catch (err) {
				console.log(`  ✗ ${check.name}: fix failed — ${(err as Error).message}`);
				fixFailures++;
			}
		}
		/* v8 ignore start -- defensive: requires fixer to throw during test */
		if (fixFailures > 0) {
			console.log(`\n  ${fixFailures} fix${fixFailures === 1 ? "" : "es"} failed.`);
		}
		/* v8 ignore stop */
	}

	// Decide exit code independently from fix mode. A healthy exit must imply
	// "if I run doctor again, it will still be healthy" — any remaining ✗
	// means non-zero. CI relies on this invariant.
	//   - Non-fix mode: any fail → exit 1 (user needs to know to act).
	//   - Fix mode:     only remaining failures count (fixer threw, or fail
	//                   check has no fixer at all). Successfully-applied
	//                   fixers are assumed to have repaired the condition.
	//   - Dry run:       nothing was repaired, so it exits like a plain report.
	const unfixableFailures = checks.filter((c) => c.status === "fail" && !c.fixer).length;
	if (fix && !dryRun) {
		if (fixFailures > 0 || unfixableFailures > 0) {
			process.exitCode = 1;
		}
	} else if (hasFailures) {
		console.log("\n  Run with --fix to auto-repair issues.");
		process.exitCode = 1;
	}

	console.log("");
}

/**
 * `doctor --recover` — the plan's single disambiguation entry for a missing
 * or damaged database. Lists every candidate source with its identity and
 * age (snapshots carry both in the filename, so one carried in from any
 * drive still matches), states the verdict, and with `--from <snapshot>`
 * performs restore step ① (refuse-by-default over a healthy database;
 * `--fix` is the explicit overwrite consent).
 */
export async function runRecover(fromPath?: string, force?: boolean): Promise<void> {
	const survey = await surveyRecovery({ extraFolder: fromPath ? dirname(fromPath) : undefined });
	console.log(`\nDatabase: ${survey.dbPath}`);
	console.log(`  state: ${survey.fileState}`);
	if (survey.fileState === "absent") {
		console.log(`  identity verdict: ${survey.identity}`);
		console.log(`  registry id: ${survey.registryId ?? "(none)"}  mirror id: ${survey.mirrorId ?? "(none)"}`);
	}
	console.log(`\nSnapshot candidates (${survey.candidates.length}), newest first:`);
	for (const c of survey.candidates) {
		const when = c.takenAtMs !== 0 ? new Date(c.takenAtMs).toISOString() : "(unparsable stamp)";
		console.log(`  ${when}  id=${c.id8}${c.premigration ? "  [pre-migration]" : ""}  ${c.path}`);
	}
	if (survey.candidates.length === 0) {
		console.log(`  (none found — folders scanned: ${survey.foldersScanned.join(", ")})`);
	}
	if (!fromPath) {
		console.log(
			"\nTo restore: jolli doctor --recover --from <snapshot path> (add --fix to overwrite a healthy database)",
		);
		return;
	}
	const result = await restoreFromSnapshot(fromPath, { force });
	if (result.status === "restored") {
		console.log(`\nRestored from ${result.from}.`);
		// Step ② of the fixed order: mirrors fill memory gaps the snapshot
		// predates. catch-up mode never deletes and never touches activity
		// data, so this cannot make the restore worse.
		const filled = await fillMemoriesFromMirrors();
		console.log(
			`Mirror gap-fill: ${filled.nodes} memory node(s) across ${filled.repos} repo mirror(s), ${filled.skipped} skipped.`,
		);
		// Step ③, last resort: fenced repos' frozen orphan branches. Recovers
		// only what existed before the freeze — which is why it ranks below
		// snapshots and mirrors — and leaves those repos legacy-fenced, so
		// 'jolli cutover' finishes their CAS afterwards.
		const frozen = await fillMemoriesFromFrozenOrphans();
		if (frozen.repos > 0) {
			console.log(
				`Frozen-orphan gap-fill: ${frozen.nodes} memory node(s) across ${frozen.repos} fenced repo(s) — run 'jolli cutover' in each to finish the CAS.`,
			);
		}
		console.log("Re-run 'jolli doctor' to verify.");
	} else {
		console.error(`\nRestore ${result.status}: ${result.reason}`);
		process.exitCode = 1;
	}
}

/**
 * `doctor --schema-log` — the "who ran what, when, and how did it go" report, plus
 * the one repair that is still reachable.
 *
 * The listing prints `skipped` / `failed` rows alongside the successful ones, which
 * is the whole reason those outcomes are recorded: a migration that was stepped
 * over, or that threw inside a transaction that then rolled its own trace away, is
 * otherwise invisible to everyone including us. Drifted names are called out at the
 * end — a warning at runtime (see `verifyMigrationLog`), reported here.
 *
 * There is deliberately no `--accept-schema-ddl` any more. It existed to unblock a
 * drift error, and drift no longer blocks anything, so an "accept" would write a
 * row that changes nothing. `--mark-migration` survives because it fixes a
 * different state, and the only one a name key cannot fix by itself: the log lost a
 * row while the column or table that entry created is still in the schema, so the
 * next open would re-run it and die on `duplicate column`. Flyway's `repair` covers
 * the same case.
 */
/**
 * What `--schema-log` found, with a FOURTH answer the storage layer cannot give:
 * the database itself could not be opened or read.
 *
 * That answer has to exist here, because collapsing it into `none` is the same
 * mistake `MigrationLogState` was split to avoid, one level further out. A corrupt
 * file, a permission problem, a sidecars-only recovery state and a locked database
 * all arrive as a thrown open — and reporting those as "this database predates the
 * log — run any Jolli command that writes first" points the reader at the one
 * explanation that is definitely wrong, from the command whose whole job is to
 * diagnose a damaged log.
 *
 * A database that does not exist yet stays `none`, not `open-failed`: that is a
 * normal, non-faulty state, and a readonly open of a missing file throws like any
 * other failure — so the file check is the only thing that tells the two apart.
 *
 * The drifted list rides along on `rows` so the whole report comes out of ONE open.
 * Two opens could disagree (the second one failing left the drift section silently
 * absent, which reads as "no drift").
 */
type SchemaLogRead =
	| (Extract<MigrationLogState, { kind: "rows" }> & { readonly drifted: ReadonlyArray<MigrationLogRow> })
	| Exclude<MigrationLogState, { kind: "rows" }>
	| { readonly kind: "open-failed"; readonly reason: string }
	| { readonly kind: "sidecars-only" };

/** Reads the log, mapping an open/read failure to `open-failed` rather than `none`. */
async function readSchemaLogState(): Promise<SchemaLogRead> {
	try {
		return await withReadonlyDashboardDb((db): SchemaLogRead => {
			const state = readMigrationLogState(db);
			return state.kind === "rows" ? { ...state, drifted: findDriftedMigrations(db) } : state;
		});
	} catch (err) {
		// A failed open has THREE shapes, and only the file combination tells them
		// apart — `existsSync` on the `.db` alone cannot (see DbDetection): an
		// `absent` triplet is the normal pre-log / not-created-yet case (`none`);
		// sidecars without the `.db` is the one recovery alarm and must NOT collapse
		// into `none`; anything else (the file is present but corrupt, locked or
		// permission-denied) is a genuine open fault.
		const files = classifyDbFiles(getDashboardDbPath());
		if (files === "absent") return { kind: "none" };
		if (files === "alarm-sidecars-only") return { kind: "sidecars-only" };
		return { kind: "open-failed", reason: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Why `--mark-migration <name>` recorded nothing. Four answers, and the user can act
 * on the difference between all four — which is the only reason `readSchemaLogState`
 * is re-read after the repair returns false.
 */
function whyNothingWasRecorded(name: string, state: SchemaLogRead): string {
	if (state.kind === "rows") return `\nUnknown migration: ${name} — this build carries no DDL under that name.`;
	if (state.kind === "none")
		return "\nThis database has no migration log yet — run any Jolli command that writes first.";
	if (state.kind === "sidecars-only")
		return (
			"\nThe database file is gone but its -wal/-shm sidecars remain — it was deleted\n" +
			"    out from under a live database. Nothing was recorded; run `jolli doctor --recover`."
		);
	if (state.kind === "unreadable" && state.tableConfirmed) {
		return (
			`\nThe migration log exists but could not be read: ${state.reason}\n` +
			"    This build cannot record into it; the schema_migrations table is damaged."
		);
	}
	return (
		`\nThe database could not be read: ${state.reason}\n` +
		"    Nothing was recorded. This is not a missing log — the file itself is unreadable."
	);
}

export async function runSchemaLog(action: { mark?: string }): Promise<void> {
	if (!canUseDashboardDb()) {
		// The diagnostic could not run at all — a fault from a script's point of view,
		// so exit non-zero like every other "could not read" path. This is NOT the
		// benign `none` case (an empty log the command DID inspect), which stays exit 0.
		console.error(`\nDatabase schema: this runtime (Node ${process.versions.node}) cannot open the database.`);
		process.exitCode = 1;
		return;
	}
	if (action.mark) {
		// Classify by the file COMBINATION first, and never open to create. The repair's
		// open is writable, and a writable `node:sqlite` open CREATES the file — so on a
		// machine that has never run Jolli this command used to manufacture an empty
		// database and then report that there was no log in it. A diagnostic must not
		// create the artifact it is diagnosing. `existsSync` on the `.db` alone cannot
		// tell "nothing has run yet" from the sidecars-only recovery alarm, so use the
		// same file-combination table the report below relies on (see DbDetection).
		const files = classifyDbFiles(getDashboardDbPath());
		if (files === "absent") {
			console.error("\nThis database does not exist yet — run any Jolli command that writes first.");
			process.exitCode = 1;
			return;
		}
		if (files === "alarm-sidecars-only") {
			console.error(whyNothingWasRecorded(action.mark, { kind: "sidecars-only" }));
			process.exitCode = 1;
			return;
		}
		// A writable open that does NOT migrate — running the pass first is exactly
		// what this repair is here to avoid. See `withRepairDashboardDb`. The open
		// itself can still fail (corrupt, locked, permission-denied) on a `.db` that
		// exists: catch it and fall through to the shared diagnosis below, so the
		// reader gets the "database could not be read" guidance instead of a raw throw.
		let marked = false;
		let openError: unknown;
		try {
			marked = await withRepairDashboardDb((db) =>
				inTransaction(db, () => recordMigrationAsApplied(db, action.mark as string)),
			);
		} catch (err) {
			openError = err;
		}
		if (!marked) {
			// Five ways to land here. Four are states `readSchemaLogState` reports (a name
			// this build never carried, no log table to write into, a log table that
			// cannot be read, a database that cannot be read at all). The fifth is a
			// WRITABLE open — or its transaction — that threw: a lock a busy retry could
			// not clear, or a read-only mount. It has to be told apart, because the
			// read-only re-read below can still SUCCEED past a write lock (WAL) or on a
			// read-only file, so `whyNothingWasRecorded` would find a readable log and
			// blame an "Unknown migration" for a name this build plainly carries.
			const state = await readSchemaLogState();
			if (openError !== undefined && state.kind === "rows") {
				const reason = openError instanceof Error ? openError.message : String(openError);
				console.error(
					`\nThe database could not be opened for writing: ${reason}\n` +
						"    Nothing was recorded — another Jolli process may be writing (retry), or the\n" +
						"    database is on a read-only mount. This is not an unknown migration.",
				);
			} else {
				console.error(whyNothingWasRecorded(action.mark, state));
			}
			process.exitCode = 1;
			return;
		}
		console.log(`\nRecorded ${action.mark} as applied.`);
	}
	const state = await readSchemaLogState();
	// The database itself could not be opened, or could not answer at all. Reported as
	// a fault, not as an empty log: corruption, a permission problem, a locked file and
	// a sidecars-only recovery state all land here, and every one of them is something
	// the reader can act on — while "this database predates the log" is the one
	// explanation that is certainly wrong.
	if (state.kind === "open-failed" || (state.kind === "unreadable" && !state.tableConfirmed)) {
		console.error(
			`\nMigration log: UNAVAILABLE — the database could not be read.\n` +
				`  ${state.reason}\n` +
				"  This is NOT a database that predates the log; the file exists and this build\n" +
				"  cannot read it. Try `jolli doctor --recover` to survey what can be rebuilt.",
		);
		process.exitCode = 1;
		return;
	}
	if (state.kind === "sidecars-only") {
		// The one recovery alarm: the `.db` was deleted out from under a live database
		// while its -wal/-shm remain. Reporting it as `none` ("predates the log") is the
		// exact opposite of the recovery path this state should send the reader to.
		console.error(
			"\nMigration log: UNAVAILABLE — the database file is gone but its -wal/-shm\n" +
				"  sidecars remain, so it was deleted out from under a live database.\n" +
				"  Try `jolli doctor --recover` to survey what can be rebuilt.",
		);
		process.exitCode = 1;
		return;
	}
	if (state.kind === "unreadable") {
		// The state this report exists for. Saying "none" here would send the reader
		// looking for a database that predates the log, which this one does not.
		console.error(
			`\nMigration log: PRESENT BUT UNREADABLE — ${state.reason}\n` +
				"  The schema_migrations table is in the schema and this build cannot query it.\n" +
				"  Writes still work: the migration pass falls back to the schema_version stamp\n" +
				"  and records nothing, so drift verification is skipped until the table is fixed.",
		);
		process.exitCode = 1;
		return;
	}
	if (state.kind === "none") {
		console.log("\nMigration log: none — this database predates the log (or does not exist yet).");
		return;
	}
	console.log("\nMigration log (oldest first):");
	for (const row of state.rows) {
		const when = new Date(row.applied_at_ms).toISOString().replace("T", " ").slice(0, 19);
		console.log(
			`  ${String(row.seq).padStart(3)}  slot ${row.slot}  ${row.outcome.padEnd(8)}  ${when}  ` +
				`${row.applied_by}  ${row.name}  (${row.duration_ms} ms)`,
		);
	}
	const drifted = state.drifted;
	if (drifted.length > 0) {
		console.log(
			`\n  ⚠ Applied by a different build than this one: ${drifted.map((r) => r.name).join(", ")}\n` +
				"    The database keeps working; this is a diagnostic, not a fault.",
		);
	}
}

/**
 * Uploads pending session statistics now, bypassing both the throttle and a
 * backend silence.
 *
 * ⚠ This is the documented way out of a silence, and it has to exist for the
 * silence to be defensible. A 403/404/412 stops one backend scope for 24h, which
 * is right while the server is still refusing and wrong the moment the operator
 * fixes it — and the only alternative was hand-editing
 * `session-push-channel.json`. `force` is what turns "wait until tomorrow" into
 * "say so and try again", and the run reports which it did.
 *
 * Lives on `doctor` rather than as a command of its own for the same reason
 * `--mark-migration` does: it is a repair for a state the automatic path cannot
 * argue itself out of, not part of anyone's normal day.
 */
export async function runSessionSyncNow(): Promise<void> {
	const { runSessionSync } = await import("../dashboard/SessionSyncRunner.js");
	// No cwd: the channel is cross-repo, so this run covers the whole machine and
	// withholds the repos `jolli disable` is set on row by row — including the one
	// the user typed this in, if it is one of them.
	const outcome = await runSessionSync({ force: true });
	if (outcome.status === "done") {
		console.log(
			outcome.rows === 0
				? "✓ Session statistics are up to date — nothing new to upload."
				: `✓ Uploaded ${outcome.rows} row(s) in ${outcome.batches} batch(es).`,
		);
		return;
	}
	// Not an exception and not silent: every reason here is either the user's own
	// setting or an answer from the server, and both are things they can act on.
	console.log(`✗ Session statistics were not uploaded: ${outcome.reason}`);
	if (outcome.status === "failed") process.exitCode = 1;
}

/**
 * `doctor --repair-transcripts` — offers, or performs, Task 7's bounded repair
 * for every summary this repo stored with `transcripts: []`.
 *
 * List-then-act, mirroring `--recover`: the bare flag reports what it WOULD do
 * and `--fix` performs it. Repair rewrites a stored memory from local
 * transcript history that may be days old and is pruned on the agent's own
 * schedule — never something a diagnostic command applies on its own. Running
 * the bare flag first lets the user see every candidate's verdict (including
 * the ones the engine will refuse — no owner proof, a vanished transcript, an
 * unbounded window) before anything is written.
 *
 * The candidate filter mirrors `repairSummaryTranscripts`'s own "already
 * present" check exactly, so this list and the engine's per-summary verdicts
 * can never disagree about which summaries are in scope.
 *
 * Per-candidate errors are caught, not propagated: this runs over every
 * candidate in the repo (plausibly hundreds), and `repairSummaryTranscripts`
 * is not throw-free — under `apply: true` it writes through
 * `withRequiredOrphanWriteLock`, which throws `OrphanWriteBusyError` on lock
 * contention with a concurrently-running `QueueWorker`, and a corrupted
 * on-disk summary or ownership ledger can throw earlier still. Letting one
 * such failure abort the loop would deny every remaining candidate a verdict
 * over an error this command is explicitly meant to run past. An error is
 * reported inline and counted separately from both "repaired" and "skipped"
 * — it is not an engine verdict (`RepairOutcome.reason` stays the engine's
 * alone; this runner does not invent a seventh reason for it).
 */
export async function runRepairTranscripts(cwd: string, apply: boolean): Promise<void> {
	const summaries = await listSummaries(Number.MAX_SAFE_INTEGER, cwd);
	const candidates = summaries.filter(
		(s) => s.transcriptsRepairedAt === undefined && getTranscriptIds(s).length === 0,
	);
	if (candidates.length === 0) {
		console.log("No summaries need transcript repair.");
		return;
	}

	let repaired = 0;
	let errored = 0;
	for (const candidate of candidates) {
		const hash = candidate.commitHash.substring(0, 8);
		let outcome: Awaited<ReturnType<typeof repairSummaryTranscripts>>;
		try {
			outcome = await repairSummaryTranscripts(candidate.commitHash, cwd, { apply });
		} catch (err) {
			errored++;
			console.log(`  ${hash}  error — ${errMsg(err)}`);
			continue;
		}
		if (outcome.repaired) {
			repaired++;
			console.log(`  ${hash}  ${apply ? "repaired" : "would repair"} — ${outcome.entries} entries`);
		} else {
			console.log(`  ${hash}  skipped — ${outcome.reason}`);
		}
	}
	console.log(
		(apply
			? `Repaired ${repaired} of ${candidates.length} summaries.`
			: `${repaired} of ${candidates.length} summaries can be repaired. Re-run with --fix to apply.`) +
			(errored > 0 ? ` ${errored} errored — see above.` : ""),
	);
}

/** Registers the `doctor` sub-command on the given Commander program. */
export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Diagnose Jolli Memory health; optionally auto-fix issues")
		.option(
			"--fix",
			"Auto-fix detected issues (release stale lock, clear stuck queue, reinstall missing hooks, repair registry paths)",
		)
		.option(
			"--forget-dead-repos",
			"With --fix: also forget registry entries whose folder is gone — deletes those repos' memories, which no backup here restores",
		)
		.option("--dry-run", "Print what --fix would do and change nothing")
		.option("--recover", "List database recovery candidates (snapshots with identity and age)")
		.option("--from <path>", "With --recover: restore the database from this snapshot file")
		.option("--schema-log", "Print the database's migration log (who ran what, when, and how it went)")
		.option("--mark-migration <name>", "Record one migration as applied by other means (see --schema-log)")
		.option(
			"--sync-sessions",
			"Upload pending session statistics now, ignoring the throttle and any 24h backend silence",
		)
		.option("--repair-transcripts", "Refill summaries written with no conversation from local transcript history")
		.option(
			"--relink-codex",
			"Rewind consumed Codex conversation read-cursors so future commits re-capture those sessions (JOLLI-2240 recovery)",
		)
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(
			async (options: {
				cwd: string;
				fix?: boolean;
				forgetDeadRepos?: boolean;
				dryRun?: boolean;
				recover?: boolean;
				from?: string;
				schemaLog?: boolean;
				markMigration?: string;
				syncSessions?: boolean;
				repairTranscripts?: boolean;
				relinkCodex?: boolean;
			}) => {
				setLogDir(options.cwd);
				log.info("Running 'doctor' command");
				if (options.recover === true) {
					await runRecover(options.from, options.fix === true);
					return;
				}
				if (options.relinkCodex === true) {
					const { rewound, paths } = await rewindCodexCursors(options.cwd);
					console.log(
						`Rewound ${rewound} Codex read-cursor(s). The rollout files on disk are now unconsumed.`,
					);
					if (rewound > 0) {
						console.log("• Future commits will re-capture these Codex sessions automatically.");
						console.log(
							"• To re-attach them to already-committed memories, regenerate the affected commits",
						);
						console.log("  (Regenerate in the IDE, which calls Regenerator.regenerateSummary).");
						// The rewind is unconditional (every Codex cursor, not only the sessions
						// JOLLI-2240 stranded) because a cursor records only a line number, not
						// whether its past read produced entries — a healthy session cannot be told
						// from a broken one here. Say so, so the user opts in knowing the blast radius.
						console.log("• Note: this rewinds ALL Codex cursors, not only the stranded ones —");
						console.log(
							"  a session already captured will be re-captured on the next commit (a duplicate).",
						);
					}
					log.debug("Rewound Codex cursors: %s", paths.join(", "));
					return;
				}
				// The repair implies the report, so `--mark-migration` reaches it on its
				// own — a user who typed it and got silence because they omitted
				// `--schema-log` would reasonably conclude it did nothing.
				if (options.schemaLog === true || options.markMigration) {
					await runSchemaLog({ mark: options.markMigration });
					return;
				}
				if (options.syncSessions === true) {
					await runSessionSyncNow();
					return;
				}
				if (options.repairTranscripts === true) {
					// Route the active storage the way every other summary command does
					// (PrDescriptionCommand, CompileCommand): createStorage consults the
					// cutover state and points at SQLite on a cutover repo. Without this
					// the repair falls back to the frozen system-of-record and silently
					// reads — or on --fix, tries to write — the wrong backend.
					setActiveStorage(await createStorage(options.cwd, options.cwd));
					await runRepairTranscripts(options.cwd, options.fix === true);
					return;
				}
				await runDoctor(
					options.cwd,
					options.fix === true,
					options.dryRun === true,
					options.forgetDeadRepos === true,
				);
			},
		);
}
