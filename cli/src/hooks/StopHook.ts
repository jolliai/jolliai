#!/usr/bin/env node
/**
 * StopHook — Claude Code Stop Event Handler
 *
 * This script is invoked by Claude Code's hook system when the agent
 * completes a response turn (the "Stop" event).
 *
 * It receives a JSON payload via stdin containing:
 *   - session_id: The current Claude Code session identifier
 *   - transcript_path: Path to the JSONL transcript file
 *   - cwd: The working directory of the project
 *
 * The hook:
 *   1. Saves session info to .jolli/jollimemory/sessions.json (for post-commit hook)
 *   2. Incrementally scans the transcript for plan file references and updates
 *      .jolli/jollimemory/plans.json — so the VSCode PLANS panel can display them
 *      without expensive full-transcript scans.
 *   3. Incrementally scans the transcript for reference refs across every
 *      registered `SourceDefinition` (Linear / Jira / GitHub / Notion / …) via the
 *      generic `extractReferencesFromTranscript` loop. Each ref is persisted via
 *      `upsertReferenceEntry` into the `plans.json.references` map and rendered
 *      to per-reference markdown by `ReferenceStore`, so the VSCode panel surfaces
 *      them alongside plans and notes.
 *
 * This hook runs with { "async": true } so it doesn't block Claude Code.
 */

import { existsSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalAgentChild } from "../core/AgentReentry.js";
import { scanPlansFrom } from "../core/plans/TranscriptPlanDiscovery.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { scanReferencesFrom } from "../core/references/TranscriptReferenceDiscovery.js";
import {
	getGlobalConfigDir,
	loadConfig,
	loadDiscoveryCursor,
	migrateDiscoveryCursors,
	saveDiscoveryCursor,
	saveSession,
} from "../core/SessionTracker.js";
import { flushTelemetryNow } from "../core/TelemetryStartup.js";
import { isClaudeHookInstalled } from "../install/ClaudeHookInstaller.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { ClaudeHookInput, SessionInfo } from "../Types.js";
import { readStdin } from "./HookUtils.js";

const log = createLogger("StopHook");

/**
 * Main handler for the Stop hook.
 * Reads stdin, parses the hook payload, and saves session info.
 */
export async function handleStopHook(): Promise<void> {
	// Skip when this Claude session was itself spawned by jollimemory's
	// local-agent backend — recording a session for its throwaway temp cwd is
	// pure self-recursion noise. See AgentReentry.
	if (isLocalAgentChild()) {
		log.info("Stop hook skipped — running inside a jollimemory-spawned local agent");
		return;
	}
	const envProjectDir = process.env.CLAUDE_PROJECT_DIR;

	// Set log directory early from env var (available before stdin parsing)
	if (envProjectDir) {
		setLogDir(envProjectDir);
	}

	let input: string;
	try {
		input = await readStdin();
	} catch (error: unknown) {
		log.error("Failed to read stdin: %s", (error as Error).message);
		return;
	}

	if (!input.trim()) {
		log.warn("Empty stdin received, skipping");
		return;
	}

	let hookData: ClaudeHookInput;
	try {
		hookData = JSON.parse(input) as ClaudeHookInput;
	} catch (error: unknown) {
		log.error("Failed to parse stdin JSON: %s", (error as Error).message);
		return;
	}

	// Use hookData.cwd as fallback when env var is not available
	const projectDir = envProjectDir ?? hookData.cwd;
	if (!envProjectDir) {
		setLogDir(projectDir);
	}

	log.info("Stop hook triggered (session=%s)", hookData.session_id ?? "unknown");
	if (await readManualDisableFlag(projectDir)) {
		log.info("Stop hook skipped — repository manually disabled");
		return;
	}
	log.info(
		"Hook input — session_id=%s, transcript_path=%s",
		hookData.session_id ?? "(none)",
		hookData.transcript_path ?? "(none)",
	);

	// Skip session tracking when claudeEnabled is explicitly false
	const config = await loadConfig();
	if (config.claudeEnabled === false) {
		log.info("Claude Code integration disabled — skipping session tracking");
		return;
	}

	if (!hookData.session_id || !hookData.transcript_path) {
		log.warn("Missing session_id or transcript_path in hook data");
		return;
	}

	const sessionInfo: SessionInfo = {
		sessionId: hookData.session_id,
		transcriptPath: hookData.transcript_path,
		updatedAt: new Date().toISOString(),
		source: "claude",
	};

	try {
		await saveSession(sessionInfo, projectDir);
		log.info("Session saved successfully");
	} catch (error: unknown) {
		const err = error as NodeJS.ErrnoException;
		log.error("Failed to save session: %s", err.message);
		if (err.code) {
			log.error("  error code: %s", err.code);
		}
		if (err.stack) {
			log.error("  stack: %s", err.stack);
		}
	}

	// Single incremental discovery pass — plan + reference scanning share
	// one discovery-cursors.json line per transcript. Each inner scan swallows
	// its own errors so one failing discovery never blocks the other or the
	// cursor advance.
	//
	// Single-owner gate. When both the CLI/settings Stop hook and the
	// claude-plugin Stop hook are enabled on a repo, Claude Code fires BOTH on
	// every Stop event and they share ONE merged discovery-cursors.json. The
	// plugin hook is pinned to its bundled `${CLAUDE_PLUGIN_ROOT}/dist`, while the
	// CLI hook resolves the newest dist across every source (run-hook →
	// resolve-dist-path). If the (possibly older) plugin hook wins the race and
	// advances the cursor past a tool_use it doesn't recognize — a source added
	// after the plugin build, e.g. context7 — the newer CLI hook starts from that
	// advanced cursor, never re-reads those lines (the cursor only moves forward),
	// and the reference is lost for good. So the plugin-invoked hook defers
	// discovery to the CLI hook whenever one is installed; a plugin-only install
	// (no CLI Stop hook) still runs discovery itself. Session save + telemetry
	// flush are surface-independent and always run.
	//
	// Discriminator — CLAUDE_PLUGIN_ROOT: Claude Code sets it in the environment
	// of a plugin-provided hook's process, and ONLY there (it is not
	// session-global — verified: absent from the parent Claude Code process env).
	// That scoping is what makes the gate safe from a zero-runner deadlock: the
	// CLI/settings hook never sees the var, so it never defers, so at least one
	// hook always runs discovery. A truthy check (not `!== undefined`) so an empty
	// value is never mistaken for a plugin invocation, matching how `envProjectDir`
	// is tested above.
	//
	// `isClaudeHookInstalled` reads the repo's `.claude/settings*.json`. The plugin
	// registers its own Stop hook in the plugin package's `hooks/hooks.json`, never
	// in repo settings, so it can't false-positive here as "the CLI hook". (It
	// matches both the `run-hook` and legacy `StopHook` command markers — both are
	// CLI-install forms.) And this gate degrades gracefully: even if the
	// discriminator ever failed and both hooks ran, the rebuilt plugin dist now
	// understands every source, so a double scan would still extract correctly
	// rather than strand a reference — the gate removes the wasted work and the
	// cross-version race, it is not the sole line of defense.
	//
	// Runner liveness: the settings entry alone is NOT proof that the CLI hook can
	// actually run. A stale `.claude/settings*.json` hook can outlive the global
	// `~/.jolli/jollimemory/run-hook` launcher it invokes (CLI uninstalled, folder
	// wiped) — every CLI-install Stop hook, current or legacy, shells out through
	// that one launcher. Deferring to a launcher that no longer exists would leave
	// NOBODY running discovery, silently stopping plan/reference updates. So we only
	// defer when the launcher is present on disk; if it is gone, the plugin stays the
	// fallback owner and runs discovery itself. (Running when we could have deferred
	// is safe — at worst a redundant idempotent scan; deferring to a dead runner is
	// not.)
	const isPluginInvocation = Boolean(process.env.CLAUDE_PLUGIN_ROOT);
	// Short-circuit order matters: cheap env check → sync launcher probe → async
	// settings read. Only a plugin invocation ever probes the launcher, so a
	// normal CLI-hook run pays nothing extra.
	const deferToCliHook =
		isPluginInvocation &&
		existsSync(join(getGlobalConfigDir(), "run-hook")) &&
		(await isClaudeHookInstalled(projectDir));
	if (deferToCliHook) {
		log.info("Plugin Stop hook: a CLI Stop hook owns transcript discovery — deferring to it");
	} else {
		await discoverFromTranscript(sessionInfo, projectDir);
	}

	// JOLLI-1954: the Stop hook fires on every agent turn end — far more often
	// than commits — so piggyback it to drain the shared telemetry buffer. Covers
	// the "using the agent but not committing" case that the post-commit flush
	// misses. Awaited (not fire-and-forget) so the short-lived hook process does
	// not exit before the POST completes; the hook runs `async: true`, so this
	// never blocks the agent. `flushTelemetryNow` re-gates consent, no-ops on an
	// empty buffer, and never throws. Pass a short per-batch timeout (matching the
	// CLI exit path) so a slow network can't keep the hook process alive on the
	// flusher's 10s default.
	await flushTelemetryNow(projectDir, { timeoutMs: 2_000 });
}

// ─── Discovery orchestration ────────────────────────────────────────────────

/**
 * Single incremental discovery pass for one transcript. Plan + reference
 * scanning share ONE merged cursor in discovery-cursors.json (keyed by the bare
 * transcriptPath). Both scans read the same file to the same EOF, so the
 * reference scan's `lastLineNumberScanned` is the authoritative cursor target.
 *
 * Each scan swallows its own errors. The cursor advances ONLY when the plan
 * scan also completed — a throwing plan scan (e.g. a transient FS error during
 * guard revival) holds the cursor at `fromLine` so its window is retried next
 * time, instead of being skipped forever because the reference scan reached EOF.
 * Re-scanning on retry is safe: both scans are idempotent.
 */
async function discoverFromTranscript(sessionInfo: SessionInfo, cwd: string): Promise<void> {
	const transcriptPath = sessionInfo.transcriptPath;
	if (!existsSync(transcriptPath)) return;

	await migrateDiscoveryCursors(cwd); // idempotent fold of legacy plan:/linear: cursors
	const fromLine = (await loadDiscoveryCursor(transcriptPath, cwd))?.lineNumber ?? 0;

	let planScanCompleted = false;
	let referenceLine = fromLine;
	try {
		// Claude omits toLine → scans to EOF, byte-equivalent to the pre-refactor
		// inline scan. Plan-first order preserved; the cap is a Codex-only concern.
		await scanPlansFrom(transcriptPath, fromLine, cwd, "claude");
		planScanCompleted = true;
	} catch (error: unknown) {
		log.error("Plan discovery failed: %s", (error as Error).message);
	}
	try {
		referenceLine = await scanReferencesFrom(transcriptPath, fromLine, cwd, "claude");
	} catch (error: unknown) {
		log.error("Reference discovery failed: %s", (error as Error).message);
	}

	// Hold the cursor if the plan scan threw: advancing past its window (the
	// reference scan reaching EOF) would lose those lines for plan discovery.
	if (planScanCompleted && referenceLine > fromLine) {
		await saveDiscoveryCursor(
			{ transcriptPath, lineNumber: referenceLine, updatedAt: new Date().toISOString() },
			cwd,
		);
	}
}

// Auto-execute only when run directly (not when imported)
/* v8 ignore start */
function isMainScript(): boolean {
	const scriptPath = fileURLToPath(import.meta.url);
	const argv1 = process.argv[1];
	return !process.env.VITEST && !!argv1 && pathResolve(argv1) === pathResolve(scriptPath);
}

if (isMainScript()) {
	handleStopHook().catch((_error: unknown) => {
		// Log a static message only — never anything derived from the error.
		// In the flush/sync chain an error can carry a jolliApiKey (e.g. in
		// request headers), so nothing error-derived may reach the log sink
		// (CodeQL js/clear-text-logging).
		console.error("[StopHook] Fatal error: stop-hook handler failed.");
		process.exit(1);
	});
}
/* v8 ignore stop */
