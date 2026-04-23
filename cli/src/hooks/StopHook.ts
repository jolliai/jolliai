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
 *
 * This hook runs with { "async": true } so it doesn't block Claude Code.
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	loadConfig,
	loadCursorForTranscript,
	loadPlansRegistry,
	saveCursor,
	savePlansRegistry,
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

	// Incrementally scan transcript for plan file references → write to plans.json
	try {
		await discoverPlansFromTranscript(sessionInfo, projectDir);
	} catch (error: unknown) {
		log.error("Plan discovery failed: %s", (error as Error).message);
	}
}

// ─── Plan Discovery ─────────────────────────────────────────────────────────

/** Cursor key prefix to distinguish plan scan cursors from summarization cursors */
const PLAN_CURSOR_PREFIX = "plan:";

/** Regex to extract slug from plan-mode transcript lines: "slug":"xxx" */
const SLUG_REGEX = /"slug":"([^"]+)"/;

/** Regex to detect Write/Edit tool calls */
const WRITE_EDIT_REGEX = /"name":"(?:Write|Edit)"/;

/**
 * Regex to extract slug from file_path values targeting ~/.claude/plans/.
 * Uses [/\\]{1,2} to handle both raw paths (/) and JSON-escaped Windows paths (\\).
 */
const PLANS_PATH_SLUG_REGEX = /[/\\]{1,2}\.claude[/\\]{1,2}plans[/\\]{1,2}([^/\\.]+)\.md/;

/**
 * Incrementally scans the transcript for plan file references and updates plans.json.
 *
 * Uses a dedicated cursor (prefixed with "plan:") in cursors.json to track
 * how far the transcript has been scanned, so each StopHook invocation only
 * reads the newly appended lines.
 *
 * Detection covers two scenarios:
 *   1. Plan mode: the transcript contains a "slug":"xxx" field
 *   2. Direct write: a Write/Edit tool call targets ~/.claude/plans/xxx.md
 */
async function discoverPlansFromTranscript(sessionInfo: SessionInfo, cwd: string): Promise<void> {
	const transcriptPath = sessionInfo.transcriptPath;
	if (!existsSync(transcriptPath)) {
		return;
	}

	// Load cursor — lineNumber tracks how many lines we've already scanned
	const cursorKey = `${PLAN_CURSOR_PREFIX}${transcriptPath}`;
	const cursor = await loadCursorForTranscript(cursorKey, cwd);
	const startLine = cursor?.lineNumber ?? 0;

	// Scan transcript from startLine, collecting discovered slugs and edit counts
	const { slugs, totalLines } = await scanTranscriptForPlans(transcriptPath, startLine);

	if (slugs.size === 0) {
		// No plans found, but still update cursor to avoid re-scanning
		if (totalLines > startLine) {
			await saveCursor(
				{ transcriptPath: cursorKey, lineNumber: totalLines, updatedAt: new Date().toISOString() },
				cwd,
			);
		}
		return;
	}

	// Upsert discovered slugs into plans.json
	// Re-read registry right before writing to minimize race window with PostCommitHook
	const registry = await loadPlansRegistry(cwd);
	const plans = { ...registry.plans };
	const now = new Date().toISOString();
	let branch: string | undefined;
	let changed = false;

	for (const [slug, editCount] of slugs) {
		const planFile = join(homedir(), ".claude", "plans", `${slug}.md`);
		if (!existsSync(planFile)) {
			continue;
		}

		const existing = plans[slug];
		if (existing?.contentHashAtCommit) {
			// Archived guard — never resurrect if user explicitly removed it
			if (existing.ignored) {
				continue;
			}
			// Check if the source file was overwritten with new content
			const { createHash } = require("node:crypto") as typeof import("node:crypto");
			const currentHash = createHash("sha256").update(readFileSync(planFile, "utf-8")).digest("hex");
			if (currentHash !== existing.contentHashAtCommit) {
				// File overwritten → create fresh uncommitted entry
				branch ??= getCurrentBranch(cwd);
				plans[slug] = {
					slug,
					title: extractPlanTitle(planFile),
					sourcePath: planFile,
					addedAt: now,
					updatedAt: now,
					branch,
					commitHash: null,
					editCount,
				};
				changed = true;
				log.info("Plan discovery: archived plan %s file changed — creating new entry", slug);
			}
			// If unchanged, skip (guard still active)
		} else if (existing) {
			// Increment editCount for uncommitted plans; skip committed/ignored
			if (existing.commitHash === null && !existing.ignored) {
				plans[slug] = { ...existing, editCount: existing.editCount + editCount, updatedAt: now };
				changed = true;
			}
		} else {
			// New plan entry — lazy-evaluate branch only when needed
			branch ??= getCurrentBranch(cwd);
			plans[slug] = {
				slug,
				title: extractPlanTitle(planFile),
				sourcePath: planFile,
				addedAt: now,
				updatedAt: now,
				branch,
				commitHash: null,
				editCount,
			};
			changed = true;
		}
	}

	if (changed) {
		// Re-read once more and preserve any commitHash updates from PostCommitHook.
		// Only apply when the commitHash changed between reads — meaning PostCommitHook
		// wrote it during this window. This avoids restoring a stale commitHash onto
		// archive-guard entries that we deliberately reset to null.
		const freshRegistry = await loadPlansRegistry(cwd);
		for (const [slug, freshEntry] of Object.entries(freshRegistry.plans)) {
			if (!freshEntry.commitHash) continue;
			if (!plans[slug]) continue;
			const originalCommitHash = registry.plans[slug]?.commitHash ?? null;
			if (freshEntry.commitHash !== originalCommitHash) {
				plans[slug] = { ...plans[slug], commitHash: freshEntry.commitHash };
			}
		}
		await savePlansRegistry({ version: 1, plans }, cwd);
		log.info("Plan discovery: upserted %d slug(s) into plans.json: [%s]", slugs.size, [...slugs.keys()].join(", "));
	}

	// Update cursor so next invocation starts where we left off
	await saveCursor({ transcriptPath: cursorKey, lineNumber: totalLines, updatedAt: new Date().toISOString() }, cwd);
}

/**
 * Scans a transcript JSONL file starting from a given line, looking for plan references.
 * Returns a map of slug → editCount for all plans discovered in the new lines.
 */
function scanTranscriptForPlans(
	transcriptPath: string,
	startLine: number,
): Promise<{ slugs: Map<string, number>; totalLines: number }> {
	return new Promise((resolve) => {
		const slugs = new Map<string, number>();
		let lineNumber = 0;

		const stream = createReadStream(transcriptPath, { encoding: "utf-8" });
		const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

		rl.on("line", (line) => {
			lineNumber++;
			if (lineNumber <= startLine) {
				return;
			}

			// Detect plan-mode slug: "slug":"xxx"
			if (line.includes('"slug":"')) {
				const match = SLUG_REGEX.exec(line);
				if (match?.[1]) {
					// Ensure slug is in the map (plan-mode discovery, no editCount increment here)
					if (!slugs.has(match[1])) {
						slugs.set(match[1], 0);
					}
				}
			}

			// Detect Write/Edit to ~/.claude/plans/*.md
			if (line.includes('"type":"tool_use"') && WRITE_EDIT_REGEX.test(line)) {
				const pathMatch = PLANS_PATH_SLUG_REGEX.exec(line);
				if (pathMatch?.[1]) {
					const slug = pathMatch[1];
					slugs.set(slug, (slugs.get(slug) ?? 0) + 1);
				}
			}
		});

		rl.on("close", () => resolve({ slugs, totalLines: lineNumber }));
		/* v8 ignore start - defensive: readline error handler for rare stream failures */
		rl.on("error", () => resolve({ slugs, totalLines: lineNumber }));
		/* v8 ignore stop */
	});
}

/** Extracts the first # heading from a markdown file. */
function extractPlanTitle(filePath: string): string {
	try {
		const content = readFileSync(filePath, "utf-8");
		const match = /^#\s+(.+)/m.exec(content);
		return match?.[1]?.trim() ?? basename(filePath);
	} catch {
		return basename(filePath);
	}
}

/** Returns the current git branch name. */
function getCurrentBranch(cwd: string): string {
	try {
		const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "unknown";
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
