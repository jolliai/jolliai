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

import { dirname, join } from "node:path";
import type { Command } from "commander";
import { orphanBranchExists } from "../core/GitOps.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { isWorkerLockStale, releaseWorkerLock } from "../core/Locks.js";
import { getBackend } from "../core/localagent/BackendRegistry.js";
import { describeCandidate } from "../core/localagent/ExecutableResolver.js";
import { localAgentToolLabel, localAgentToolLoginHint } from "../core/localagent/ToolMeta.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { countActiveQueueEntries, getGlobalConfigDir, loadAllSessions, loadConfig } from "../core/SessionTracker.js";
import { resolveSotBackend } from "../core/SotStorageResolver.js";
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
import { traverseDistPaths } from "../install/DistPathResolver.js";
import { getStatus, install } from "../install/Installer.js";
import { createLogger, ORPHAN_BRANCH, setLogDir } from "../Logger.js";
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
 * Diagnoses system health and optionally auto-repairs failures.
 *
 * Rule of thumb:
 *   doctor → "is Jolli Memory working?"
 *   clean  → "what old data can I safely delete?"
 */
async function runDoctor(cwd: string, fix: boolean): Promise<void> {
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

	// Print results
	console.log("\n  Jolli Memory Doctor");
	console.log("  ──────────────────────────────────────");

	let hasFailures = false;
	const fixesToApply: DoctorCheck[] = [];

	for (const check of checks) {
		const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗";
		console.log(`  ${icon} ${check.name.padEnd(16)} ${check.message}`);
		if (check.status === "fail") hasFailures = true;
		if (fix && check.fixer) fixesToApply.push(check);
	}

	// Apply fixes if requested.
	let fixFailures = 0;
	if (fix && fixesToApply.length > 0) {
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
	const unfixableFailures = checks.filter((c) => c.status === "fail" && !c.fixer).length;
	if (fix) {
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

/** Registers the `doctor` sub-command on the given Commander program. */
export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Diagnose Jolli Memory health; optionally auto-fix issues")
		.option("--fix", "Auto-fix detected issues (release stale lock, clear stuck queue, reinstall missing hooks)")
		.option("--recover", "List database recovery candidates (snapshots with identity and age)")
		.option("--from <path>", "With --recover: restore the database from this snapshot file")
		.option("--schema-log", "Print the database's migration log (who ran what, when, and how it went)")
		.option("--mark-migration <name>", "Record one migration as applied by other means (see --schema-log)")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(
			async (options: {
				cwd: string;
				fix?: boolean;
				recover?: boolean;
				from?: string;
				schemaLog?: boolean;
				markMigration?: string;
			}) => {
				setLogDir(options.cwd);
				log.info("Running 'doctor' command");
				if (options.recover === true) {
					await runRecover(options.from, options.fix === true);
					return;
				}
				// The repair implies the report, so `--mark-migration` reaches it on its
				// own — a user who typed it and got silence because they omitted
				// `--schema-log` would reasonably conclude it did nothing.
				if (options.schemaLog === true || options.markMigration) {
					await runSchemaLog({ mark: options.markMigration });
					return;
				}
				await runDoctor(options.cwd, options.fix === true);
			},
		);
}
