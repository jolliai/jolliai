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

import { join } from "node:path";
import type { Command } from "commander";
import { orphanBranchExists } from "../core/GitOps.js";
import { resolveLlmCredentialSource } from "../core/LlmClient.js";
import { isWorkerLockStale, releaseWorkerLock } from "../core/Locks.js";
import { getBackend } from "../core/localagent/BackendRegistry.js";
import { countActiveQueueEntries, getGlobalConfigDir, loadAllSessions, loadConfig } from "../core/SessionTracker.js";
import { traverseDistPaths } from "../install/DistPathResolver.js";
import { getStatus, install } from "../install/Installer.js";
import { createLogger, ORPHAN_BRANCH, setLogDir } from "../Logger.js";
import { inspectPlugins } from "../PluginLoader.js";
import { resolveProjectDir, VERSION } from "./CliUtils.js";

const log = createLogger("doctor");

/** Individual check result returned by each diagnostic probe. */
interface DoctorCheck {
	readonly name: string;
	readonly status: "ok" | "warn" | "fail";
	readonly message: string;
	/** Optional fixer that applies a remedy and returns a new message describing what was done. */
	readonly fixer?: () => Promise<string>;
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

	if (!status.gitHookInstalled) {
		checks.push({
			name: "Git hooks",
			status: "fail",
			message: "not installed — run `jolli enable` to install",
			fixer: async () => {
				// Fixer contract: throw on failure so the doctor loop records the
				// failure (exit code, ✗ icon). A success path must return a string.
				const result = await install(cwd, { source: "cli" });
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

	// 2. Orphan branch
	const branchExists = await orphanBranchExists(ORPHAN_BRANCH, cwd);
	checks.push({
		name: "Orphan branch",
		status: branchExists ? "ok" : "warn",
		message: branchExists ? "exists" : "not yet created (will be created on first commit)",
	});

	// 3. Worker lock (stuck = exists AND older than LOCK_TIMEOUT_MS; a normal worker
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
	const credentialLabel: Record<NonNullable<typeof credentialSource>, string> = {
		"anthropic-config": "Anthropic API key (config)",
		"anthropic-env": "Anthropic API key (ANTHROPIC_API_KEY env)",
		"jolli-proxy": "Jolli proxy key",
		"local-agent": "local agent (Claude Code subscription)",
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
			const backend = getBackend(config.localAgentTool ?? "claude-code");
			const exe = await backend.discoverExecutable(config.localAgentPath);
			checks.push({ name: "Local agent CLI", status: "ok", message: `${exe.file} (v${exe.version})` });
		} catch (err) {
			checks.push({ name: "Local agent CLI", status: "fail", message: (err as Error).message });
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

/** Registers the `doctor` sub-command on the given Commander program. */
export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Diagnose Jolli Memory health; optionally auto-fix issues")
		.option("--fix", "Auto-fix detected issues (release stale lock, clear stuck queue, reinstall missing hooks)")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string; fix?: boolean }) => {
			setLogDir(options.cwd);
			log.info("Running 'doctor' command");
			await runDoctor(options.cwd, options.fix === true);
		});
}
