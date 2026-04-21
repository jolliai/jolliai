#!/usr/bin/env node
/**
 * GeminiAfterAgentHook — Gemini CLI AfterAgent Event Handler
 *
 * This script is invoked by Gemini CLI's hook system after each agent turn
 * (the "AfterAgent" event). It mirrors Claude Code's StopHook behavior.
 *
 * It receives a JSON payload via stdin containing:
 *   - session_id: The current Gemini CLI session identifier
 *   - transcript_path: Path to the session JSON file
 *   - cwd: The working directory of the project
 *
 * The hook saves this information to .jolli/jollimemory/sessions.json
 * with source="gemini" so the post-commit hook knows where to find
 * the transcripts and which parser to use.
 *
 * Unlike Claude Code's Stop hook, Gemini hooks MUST write JSON to stdout.
 * We output an empty object {} (no-op response).
 */

import { resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSession } from "../core/SessionTracker.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { ClaudeHookInput, SessionInfo } from "../Types.js";
import { readStdin } from "./HookUtils.js";

const log = createLogger("GeminiAfterAgentHook");

/**
 * Writes the required JSON response to stdout for Gemini CLI.
 * Gemini hooks must output JSON; we return an empty object (no-op).
 */
function writeStdout(): void {
	process.stdout.write("{}\n");
}

/**
 * Main handler for the Gemini AfterAgent hook.
 * Reads stdin, parses the hook payload, and saves session info with source="gemini".
 */
export async function handleGeminiAfterAgentHook(): Promise<void> {
	const envProjectDir = process.env.GEMINI_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR;

	// Set log directory early from env var (available before stdin parsing)
	if (envProjectDir) {
		setLogDir(envProjectDir);
	}

	let input: string;
	try {
		input = await readStdin();
	} catch (error: unknown) {
		log.error("Failed to read stdin: %s", (error as Error).message);
		writeStdout();
		return;
	}

	if (!input.trim()) {
		log.warn("Empty stdin received, skipping");
		writeStdout();
		return;
	}

	// Gemini CLI sends the same payload format as Claude Code
	let hookData: ClaudeHookInput;
	try {
		hookData = JSON.parse(input) as ClaudeHookInput;
	} catch (error: unknown) {
		log.error("Failed to parse stdin JSON: %s", (error as Error).message);
		writeStdout();
		return;
	}

	// Use hookData.cwd as fallback when env var is not available
	const projectDir = envProjectDir ?? hookData.cwd;
	if (!envProjectDir) {
		setLogDir(projectDir);
	}

	log.info("Gemini AfterAgent hook triggered (session=%s)", hookData.session_id ?? "unknown");

	if (!hookData.session_id || !hookData.transcript_path) {
		log.warn("Missing session_id or transcript_path in hook data");
		writeStdout();
		return;
	}

	const sessionInfo: SessionInfo = {
		sessionId: hookData.session_id,
		transcriptPath: hookData.transcript_path,
		updatedAt: new Date().toISOString(),
		source: "gemini",
	};

	try {
		await saveSession(sessionInfo, projectDir);
		log.info("Gemini session saved successfully");
	} catch (error: unknown) {
		log.error("Failed to save session: %s", (error as Error).message);
	}

	// Always write JSON response — Gemini CLI requires it
	writeStdout();
}

// Auto-execute only when run directly (not when imported)
/* v8 ignore start */
function isMainScript(): boolean {
	const scriptPath = fileURLToPath(import.meta.url);
	const argv1 = process.argv[1];
	return !process.env.VITEST && !!argv1 && pathResolve(argv1) === pathResolve(scriptPath);
}

if (isMainScript()) {
	handleGeminiAfterAgentHook().catch((error: unknown) => {
		console.error("[GeminiAfterAgentHook] Fatal error:", error);
		process.exit(1);
	});
}
/* v8 ignore stop */
