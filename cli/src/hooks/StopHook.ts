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
 *   3. Incrementally scans the transcript for Linear MCP issue references
 *      (mcp__linear__* tool_use → tool_result pairs), writes per-issue
 *      markdown to .jolli/jollimemory/linear-issues/, and upserts the
 *      linearIssues registry inside plans.json so the same PLANS panel can
 *      show them alongside plans and notes.
 *
 * This hook runs with { "async": true } so it doesn't block Claude Code.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { extractLinearIssuesFromTranscript } from "../core/LinearIssueExtractor.js";
import { writeLinearIssueMarkdown } from "../core/LinearIssueStore.js";
import { normalizePathForCompare } from "../core/PathUtils.js";
import {
	loadConfig,
	loadCursorForTranscript,
	loadPlansRegistry,
	saveCursor,
	savePlansRegistry,
	saveSession,
	upsertLinearIssueEntry,
} from "../core/SessionTracker.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { ClaudeHookInput, PlanEntry, SessionInfo } from "../Types.js";
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

	// Incrementally scan transcript for Linear MCP issue references → write
	// markdown files + plans.json.linearIssues
	try {
		await discoverLinearIssuesFromTranscript(sessionInfo, projectDir);
	} catch (error: unknown) {
		log.error("Linear issue discovery failed: %s", (error as Error).message);
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
 * Fallback regex: matches any Write/Edit tool_use file_path ending in .md.
 * Runs only when PLANS_PATH_SLUG_REGEX misses, so ~/.claude/plans/ stays
 * handled by the original slug-keyed code path.
 */
const ANY_MD_PATH_REGEX = /"file_path":"([^"]+\.md)"/;

/**
 * Path segments excluded from external plan detection. Case-insensitive (`i`
 * flag) so Windows/macOS variants like `Node_Modules/` or `.GitHub/` are also
 * filtered — matches the case-insensitive basename check below.
 */
const EXTERNAL_EXCLUDE_SEGMENTS = [/[/\\]\.claude[/\\]/i, /[/\\]node_modules[/\\]/i, /[/\\]\.github[/\\]/i];

/** Basenames excluded — stored lowercase, compared after toLowerCase() on input. */
const EXTERNAL_EXCLUDE_BASENAMES = new Set([
	"claude.md",
	"claude.local.md",
	"agents.md",
	"readme.md",
	"changelog.md",
	"contributing.md",
	"license.md",
	"security.md",
	"code_of_conduct.md",
]);

/**
 * Decide whether an external .md path is a plan candidate. Excludes any path
 * under `.claude/`, `node_modules/`, or `.github/`, plus common non-plan
 * filenames (README.md, CLAUDE.md, etc.) at any depth.
 */
function isExternalPlanCandidate(absPath: string): boolean {
	if (EXTERNAL_EXCLUDE_SEGMENTS.some((re) => re.test(absPath))) return false;
	const base = (absPath.split(/[/\\]/).pop() ?? "").toLowerCase();
	return !EXTERNAL_EXCLUDE_BASENAMES.has(base);
}

/**
 * Platform-agnostic basename + extension stripping. node:path.basename is
 * locked to the runtime platform's separator — on POSIX it doesn't recognize
 * `\` as a separator, so a Windows-style transcript path parsed on Linux CI
 * yields `E:\jm-docs\some-plan` instead of `some-plan`. Splitting on both
 * separators avoids that.
 */
function basenameNoExt(absPath: string, ext: string): string {
	const last = absPath.split(/[/\\]/).pop() ?? "";
	return last.endsWith(ext) ? last.slice(0, -ext.length) : last;
}

/**
 * Returns a unique registry slug for a given absolute path.
 *
 * Resolution order:
 *   1. SourcePath reverse-lookup: scan all entries, return the slug whose
 *      sourcePath normalize-equals absPath. Idempotent — same file always
 *      resolves to the same slug, including when the base slug entry has
 *      been cleaned up but a hash-suffixed entry remains.
 *   2. Base slug free: no entry at baseSlug → use baseSlug.
 *   3. Base slug taken by a different file → `<baseSlug>-<pathHash8>`
 *      (sha256(normalized absPath) first 8 hex chars).
 *
 * Existing entries are never renamed — backward-compatible across upgrades.
 */
function resolveUniqueSlug(baseSlug: string, absPath: string, plans: Record<string, PlanEntry>): string {
	const targetNorm = normalizePathForCompare(absPath);
	for (const [slug, entry] of Object.entries(plans)) {
		if (normalizePathForCompare(entry.sourcePath) === targetNorm) return slug;
	}
	if (!plans[baseSlug]) return baseSlug;
	const shortHash = createHash("sha256").update(targetNorm).digest("hex").slice(0, 8);
	return `${baseSlug}-${shortHash}`;
}

/**
 * Incrementally scans the transcript for plan file references and updates plans.json.
 *
 * Uses a dedicated cursor (prefixed with "plan:") in cursors.json to track
 * how far the transcript has been scanned, so each StopHook invocation only
 * reads the newly appended lines.
 *
 * Detection covers three scenarios:
 *   1. Plan mode: the transcript contains a "slug":"xxx" field
 *   2. Direct write to ~/.claude/plans/: Write/Edit tool call hits the canonical dir
 *   3. External .md files (e.g. docs/foo.md, E:\jm-docs\bar.md): Write/Edit tool
 *      call on any .md path not excluded by isExternalPlanCandidate — slug is
 *      derived from basename via resolveUniqueSlug for cross-path collisions.
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

	// Scan transcript from startLine, collecting discovered slugs / external paths
	const { slugs, externalPlans, totalLines } = await scanTranscriptForPlans(transcriptPath, startLine);

	if (slugs.size === 0 && externalPlans.size === 0) {
		// Nothing found, but still update cursor to avoid re-scanning
		if (totalLines > startLine) {
			await saveCursor(
				{ transcriptPath: cursorKey, lineNumber: totalLines, updatedAt: new Date().toISOString() },
				cwd,
			);
		}
		return;
	}

	// Upsert into plans.json. Re-read registry right before writing to
	// minimize race window with PostCommitHook.
	const registry = await loadPlansRegistry(cwd);
	const plans = { ...registry.plans };
	const now = new Date().toISOString();
	let branch: string | undefined;
	let changed = false;
	// Tracks slugs we actually modified in this run. Used at writeback time to
	// merge our changes onto the freshest registry snapshot per-slug rather
	// than overwriting the whole plans map — without this, any slug a sibling
	// pipeline (QueueWorker archive, extension ignore, parallel StopHook) wrote
	// between our load and save would be silently dropped.
	const touchedSlugs = new Set<string>();

	const upsertEntry = (slug: string, planFile: string, editCount: number): void => {
		const existing = plans[slug];
		if (existing?.contentHashAtCommit) {
			// Archived guard — never resurrect if user explicitly removed it
			if (existing.ignored) {
				return;
			}
			const currentHash = createHash("sha256").update(readFileSync(planFile, "utf-8")).digest("hex");
			if (currentHash !== existing.contentHashAtCommit) {
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
				touchedSlugs.add(slug);
				log.info("Plan discovery: archived plan %s file changed — creating new entry", slug);
			}
		} else if (existing) {
			if (existing.commitHash === null && !existing.ignored) {
				plans[slug] = { ...existing, editCount: existing.editCount + editCount, updatedAt: now };
				changed = true;
				touchedSlugs.add(slug);
			}
		} else {
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
			touchedSlugs.add(slug);
		}
	};

	// Build a Set of normalized paths that already belong to a markdown note
	// on the current branch. Markdown notes added via "Add Markdown File" can
	// point at arbitrary user .md files (NoteService allows
	// `sourcePath = <user-picked path>`). If the AI later edits that same file,
	// we must NOT also register it as a plan — it would shadow the user's
	// explicit note semantics, double-archive into the orphan branch, and
	// surface the same file twice in the panel (plans + notes are merged
	// without sourcePath dedup downstream).
	//
	// Branch scoping: notes are branch-filtered in NoteService.toNoteInfo, so a
	// note on `main` is invisible on `feature/x`. The guard must mirror that
	// scope, otherwise a hidden cross-branch note silently suppresses plan
	// auto-registration on the current branch.
	const noteSourcePaths = new Set<string>();
	const notesArr = Object.values(registry.notes ?? {});
	if (notesArr.length > 0) {
		branch ??= getCurrentBranch(cwd);
		for (const note of notesArr) {
			if (note.branch && note.branch !== branch) continue;
			if (note.sourcePath) noteSourcePaths.add(normalizePathForCompare(note.sourcePath));
		}
	}

	// 1. Canonical ~/.claude/plans/ slugs. We still route through
	//    resolveUniqueSlug so that if an external entry was registered first
	//    under the same slug (e.g. docs/foo.md → "foo"), the canonical
	//    ~/.claude/plans/foo.md gets a hash-suffixed slug rather than silently
	//    overwriting the external entry's sourcePath via upsertEntry.
	//
	//    Note guard is applied here too: a user may have added
	//    `~/.claude/plans/foo.md` as a note via "Add Markdown File" (file
	//    picker is unrestricted), so the same dedup applies.
	for (const [rawSlug, editCount] of slugs) {
		const planFile = join(homedir(), ".claude", "plans", `${rawSlug}.md`);
		if (!existsSync(planFile)) continue;
		if (noteSourcePaths.has(normalizePathForCompare(planFile))) {
			log.info("Plan discovery: %s already a note — skipping plan registration", planFile);
			continue;
		}
		const slug = resolveUniqueSlug(rawSlug, planFile, plans);
		upsertEntry(slug, planFile, editCount);
	}

	// 2. External .md paths — slug resolved against current plans snapshot.
	//    basenameNoExt is platform-agnostic so a Windows-style path parsed on
	//    POSIX CI still yields a clean filename slug.
	for (const [absPath, editCount] of externalPlans) {
		if (!existsSync(absPath)) continue;
		if (noteSourcePaths.has(normalizePathForCompare(absPath))) {
			log.info("Plan discovery: %s already a note — skipping plan registration", absPath);
			continue;
		}
		const baseSlug = basenameNoExt(absPath, ".md");
		const slug = resolveUniqueSlug(baseSlug, absPath, plans);
		upsertEntry(slug, absPath, editCount);
	}

	if (changed) {
		// Re-read once more and merge per-slug onto the freshest snapshot.
		//
		// Why not just write our local `plans`: between our initial load and
		// this save, sibling pipelines may have written to plans.json:
		//   - QueueWorker may have added a `<slug>-<commitHash8>` archive entry
		//     and upgraded the original slug into an archive guard
		//   - Another StopHook (parallel session) may have added a new slug
		//   - The extension may have flipped `ignored` on an entry
		//
		// Strategy: start with freshRegistry.plans as the baseline (preserves
		// every concurrent write), then layer ONLY the slugs we explicitly
		// touched on top. For each touched slug, also pull through any
		// concurrent commitHash update (the PostCommitHook race already
		// covered by the prior implementation).
		const freshRegistry = await loadPlansRegistry(cwd);
		const merged: Record<string, PlanEntry> = { ...freshRegistry.plans };
		for (const slug of touchedSlugs) {
			const ours = plans[slug];
			if (!ours) continue;
			const fresh = freshRegistry.plans[slug];
			const freshCommitHash = fresh?.commitHash;
			const originalCommitHash = registry.plans[slug]?.commitHash ?? null;
			if (fresh && freshCommitHash && freshCommitHash !== originalCommitHash) {
				// A sibling writer (typically QueueWorker) transitioned this slug
				// from uncommitted to archived between our load and save: it set
				// both `commitHash` AND `contentHashAtCommit` (the archive-guard
				// pair). Use the fresh entry wholesale rather than overlaying one
				// field on ours — otherwise `contentHashAtCommit` is dropped, the
				// entry trips the snapshot-copy filter in PlanService.toPlanInfo
				// (vanishes from the panel), and the upsertEntry archive-guard
				// revive branch can never fire again (because it gates on
				// `existing.contentHashAtCommit`).
				//
				// Our local editCount increment is intentionally dropped: once
				// archived, editCount is invisible to the panel; the next
				// Write/Edit will resurrect a fresh uncommitted entry with the
				// correct count via the archive-guard branch in upsertEntry.
				merged[slug] = fresh;
			} else {
				merged[slug] = ours;
			}
		}
		// Spread freshRegistry first to preserve notes / linearIssues — otherwise
		// any sibling pipeline that wrote them between our load and save (e.g.
		// the note service from the extension, the Linear discovery loop below)
		// loses its work.
		await savePlansRegistry({ ...freshRegistry, version: 1, plans: merged }, cwd);
		log.info(
			"Plan discovery: upserted %d slug(s) + %d external path(s) into plans.json",
			slugs.size,
			externalPlans.size,
		);
	}

	// Update cursor so next invocation starts where we left off
	await saveCursor({ transcriptPath: cursorKey, lineNumber: totalLines, updatedAt: new Date().toISOString() }, cwd);
}

/**
 * Scans a transcript JSONL file starting from a given line, looking for plan references.
 *
 * Returns two maps:
 *   - `slugs`: slug → editCount for plans in ~/.claude/plans/ (slug-keyed)
 *   - `externalPlans`: absPath → editCount for .md files outside ~/.claude/plans/
 *     (slug resolution deferred to the upsert phase, which has the registry snapshot)
 */
function scanTranscriptForPlans(
	transcriptPath: string,
	startLine: number,
): Promise<{ slugs: Map<string, number>; externalPlans: Map<string, number>; totalLines: number }> {
	return new Promise((resolve) => {
		const slugs = new Map<string, number>();
		const externalPlans = new Map<string, number>();
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

			// Detect Write/Edit tool calls. First try the slug-keyed
			// ~/.claude/plans/ path; only fall back to the generic .md regex
			// when that misses, so existing behavior is preserved.
			if (line.includes('"type":"tool_use"') && WRITE_EDIT_REGEX.test(line)) {
				const pathMatch = PLANS_PATH_SLUG_REGEX.exec(line);
				if (pathMatch?.[1]) {
					const slug = pathMatch[1];
					slugs.set(slug, (slugs.get(slug) ?? 0) + 1);
				} else {
					const extMatch = ANY_MD_PATH_REGEX.exec(line);
					if (extMatch?.[1]) {
						// Transcripts are JSONL: the captured substring lives inside a JSON
						// string literal, so all of `\\`, `\"`, `\n`, `\uXXXX` etc. are
						// possible. Decode via JSON.parse to handle every escape uniformly
						// — a simple `replace(/\\\\/g, "\\")` misses unicode-escaped
						// non-ASCII filenames and any other valid JSON escape.
						let absPath: string | null = null;
						try {
							absPath = JSON.parse(`"${extMatch[1]}"`) as string;
						} catch {
							// Malformed escape sequence — treat as non-candidate.
						}
						if (absPath && isExternalPlanCandidate(absPath)) {
							externalPlans.set(absPath, (externalPlans.get(absPath) ?? 0) + 1);
						}
					}
				}
			}
		});

		rl.on("close", () => resolve({ slugs, externalPlans, totalLines: lineNumber }));
		/* v8 ignore start - defensive: readline error handler for rare stream failures */
		rl.on("error", () => resolve({ slugs, externalPlans, totalLines: lineNumber }));
		/* v8 ignore stop */
	});
}

// ─── Linear Issue Discovery ─────────────────────────────────────────────────

/** Cursor key prefix for Linear issue scan position, parallel to PLAN_CURSOR_PREFIX. */
const LINEAR_CURSOR_PREFIX = "linear:";

/**
 * Incrementally scans the transcript for Linear MCP tool_use/tool_result pairs
 * and persists discovered issues:
 *   1. extractLinearIssuesFromTranscript with cursor → LinearIssueRef[]
 *   2. For each ref:
 *        - writeLinearIssueMarkdown → .jolli/jollimemory/linear-issues/<ticketId>.md
 *        - upsertLinearIssueEntry → plans.json.linearIssues
 *   3. Persist cursor advance.
 *
 * Each StopHook invocation only reads newly appended JSONL lines. The cursor
 * for this scan is independent of plan-discovery's cursor (different prefix).
 */
async function discoverLinearIssuesFromTranscript(sessionInfo: SessionInfo, cwd: string): Promise<void> {
	const transcriptPath = sessionInfo.transcriptPath;
	if (!existsSync(transcriptPath)) return;

	const cursorKey = `${LINEAR_CURSOR_PREFIX}${transcriptPath}`;
	const cursor = await loadCursorForTranscript(cursorKey, cwd);
	const fromLineNumber = cursor?.lineNumber ?? 0;

	const { issues, lastLineNumberScanned } = await extractLinearIssuesFromTranscript(transcriptPath, {
		fromLineNumber,
	});

	if (issues.length === 0) {
		// Even with no issues, advance the cursor so we don't re-scan the same lines next time.
		if (lastLineNumberScanned > fromLineNumber) {
			await saveCursor(
				{ transcriptPath: cursorKey, lineNumber: lastLineNumberScanned, updatedAt: new Date().toISOString() },
				cwd,
			);
		}
		return;
	}

	const branch = getCurrentBranch(cwd);
	const upserted: string[] = [];
	const failed: string[] = [];
	for (const ref of issues) {
		// Per-iteration try/catch: a single bad ticket (e.g. permission error
		// writing markdown, or a transient plans.json write contention) must
		// not abort the batch — otherwise subsequent refs are lost AND the
		// cursor save below is skipped, so the next StopHook re-processes the
		// same refs and hits the same failure in a loop.
		try {
			const { sourcePath, contentHash } = await writeLinearIssueMarkdown(ref, cwd);
			await upsertLinearIssueEntry(ref, sourcePath, contentHash, branch, cwd);
			upserted.push(ref.ticketId);
		} catch (err) {
			log.error(
				"Linear issue discovery: failed to persist %s: %s — continuing with rest of batch",
				ref.ticketId,
				(err as Error).message,
			);
			failed.push(ref.ticketId);
		}
	}
	log.info(
		"Linear issue discovery: upserted %d of %d ref(s): [%s]%s",
		upserted.length,
		issues.length,
		upserted.join(", "),
		failed.length > 0 ? ` (failed: [${failed.join(", ")}])` : "",
	);

	await saveCursor(
		{ transcriptPath: cursorKey, lineNumber: lastLineNumberScanned, updatedAt: new Date().toISOString() },
		cwd,
	);
}

/** Extracts the first # heading from a markdown file. */
function extractPlanTitle(filePath: string): string {
	// Use a platform-agnostic basename for the fallback: node:path.basename
	// only recognizes the current platform's separator, so a Windows path
	// processed on POSIX would degrade into the entire path string.
	const fallback = filePath.split(/[/\\]/).pop() ?? filePath;
	try {
		const content = readFileSync(filePath, "utf-8");
		const match = /^#\s+(.+)/m.exec(content);
		return match?.[1]?.trim() ?? fallback;
	} catch {
		return fallback;
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
