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
 *      registered SourceAdapter (Linear / Jira / GitHub / Notion / …) via the
 *      generic `extractReferencesFromTranscript` loop. Each ref is persisted via
 *      `upsertReferenceEntry` into the `plans.json.references` map and rendered
 *      to per-reference markdown by `ReferenceStore`, so the VSCode panel surfaces
 *      them alongside plans and notes.
 *
 * This hook runs with { "async": true } so it doesn't block Claude Code.
 */

import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanPlansFrom } from "../core/plans/TranscriptPlanDiscovery.js";
import { scanReferencesFrom } from "../core/references/TranscriptReferenceDiscovery.js";
import {
	loadConfig,
	loadDiscoveryCursor,
	migrateDiscoveryCursors,
	saveDiscoveryCursor,
	saveSession,
} from "../core/SessionTracker.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { ClaudeHookInput, SessionInfo } from "../Types.js";
import { readStdin } from "./HookUtils.js";

const log = createLogger("StopHook");

/**
 * Main handler for the Stop hook.
 * Reads stdin, parses the hook payload, and saves session info.
 */
export async function handleStopHook(): Promise<void> {
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
	await discoverFromTranscript(sessionInfo, projectDir);
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
	handleStopHook().catch((error: unknown) => {
		console.error("[StopHook] Fatal error:", error);
		process.exit(1);
	});
}
/* v8 ignore stop */
