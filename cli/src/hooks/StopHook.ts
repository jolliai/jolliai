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

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { normalizePathForCompare } from "../core/PathUtils.js";
import { extractReferencesFromTranscript } from "../core/references/ReferenceExtractor.js";
import { ALL_ADAPTERS } from "../core/references/sources/index.js";
import {
	loadConfig,
	loadDiscoveryCursor,
	loadPlansRegistry,
	migrateDiscoveryCursors,
	saveDiscoveryCursor,
	savePlansRegistry,
	saveSession,
	upsertReferenceEntry,
} from "../core/SessionTracker.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { ClaudeHookInput, PlanEntry, SessionInfo } from "../Types.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
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
 * transcriptPath). Each scan swallows its own errors and the cursor advances to
 * the furthest line any scan reached, so a transient failure in one discovery
 * discards that window (no re-scan) without blocking the other.
 */
async function discoverFromTranscript(sessionInfo: SessionInfo, cwd: string): Promise<void> {
	const transcriptPath = sessionInfo.transcriptPath;
	if (!existsSync(transcriptPath)) return;

	await migrateDiscoveryCursors(cwd); // idempotent fold of legacy plan:/linear: cursors
	const fromLine = (await loadDiscoveryCursor(transcriptPath, cwd))?.lineNumber ?? 0;

	let lastScanned = fromLine;
	try {
		lastScanned = await scanPlansFrom(transcriptPath, fromLine, cwd);
	} catch (error: unknown) {
		log.error("Plan discovery failed: %s", (error as Error).message);
	}
	try {
		// Both scans start from the same line and read to EOF, so the reference
		// scan's return value is the authoritative furthest-scanned line.
		lastScanned = await scanReferencesFrom(transcriptPath, fromLine, cwd);
	} catch (error: unknown) {
		log.error("Reference discovery failed: %s", (error as Error).message);
	}

	if (lastScanned > fromLine) {
		await saveDiscoveryCursor(
			{ transcriptPath, lineNumber: lastScanned, updatedAt: new Date().toISOString() },
			cwd,
		);
	}
}

// ─── Plan Discovery ─────────────────────────────────────────────────────────

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
	// `split` on a non-empty string always returns ≥1 element, so `pop()` is
	// never undefined here. The non-null assertion drops the dead `?? ""`
	// fallback that v8 otherwise counts as an uncovered branch arm.
	// biome-ignore lint/style/noNonNullAssertion: split-then-pop is provably non-null
	const base = absPath.split(/[/\\]/).pop()!.toLowerCase();
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
	// split-then-pop never yields undefined on a non-empty string; the
	// non-null assertion removes the dead `?? ""` branch.
	// biome-ignore lint/style/noNonNullAssertion: split-then-pop is provably non-null
	const last = absPath.split(/[/\\]/).pop()!;
	/* v8 ignore next -- defensive: only callers pass paths matching `ext` (currently `.md`); the false arm exists for future general-purpose use */
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
 * Scans the transcript for plan file references from `fromLine` and upserts them
 * into plans.json. Pure scan + upsert — the caller (discoverFromTranscript) owns
 * the merged discovery cursor. Returns the furthest line scanned (EOF).
 *
 * Detection covers three scenarios:
 *   1. Plan mode: the transcript contains a "slug":"xxx" field
 *   2. Direct write to ~/.claude/plans/: Write/Edit tool call hits the canonical dir
 *   3. External .md files (e.g. docs/foo.md, E:\jm-docs\bar.md): Write/Edit tool
 *      call on any .md path not excluded by isExternalPlanCandidate — slug is
 *      derived from basename via resolveUniqueSlug for cross-path collisions.
 */
async function scanPlansFrom(transcriptPath: string, fromLine: number, cwd: string): Promise<number> {
	// Scan from fromLine, collecting discovered slugs / external paths.
	const { slugs, externalPlans, totalLines } = await scanTranscriptForPlans(transcriptPath, fromLine);

	if (slugs.size === 0 && externalPlans.size === 0) {
		return totalLines;
	}

	// Upsert into plans.json. Re-read registry right before writing to
	// minimize race window with PostCommitHook.
	const registry = await loadPlansRegistry(cwd);
	const plans = { ...registry.plans };
	const now = new Date().toISOString();
	let changed = false;
	// Tracks slugs we actually modified in this run. Used at writeback time to
	// merge our changes onto the freshest registry snapshot per-slug rather
	// than overwriting the whole plans map — without this, any slug a sibling
	// pipeline (QueueWorker archive, extension ignore, parallel StopHook) wrote
	// between our load and save would be silently dropped.
	const touchedSlugs = new Set<string>();

	const upsertEntry = (slug: string, planFile: string): void => {
		const existing = plans[slug];
		if (existing?.contentHashAtCommit) {
			// Archived guard: revive when the source file diverged from the guard hash.
			const currentHash = createHash("sha256").update(readFileSync(planFile, "utf-8")).digest("hex");
			if (currentHash !== existing.contentHashAtCommit) {
				plans[slug] = {
					slug,
					title: extractPlanTitle(planFile),
					sourcePath: planFile,
					addedAt: now,
					updatedAt: now,
					commitHash: null,
				};
				changed = true;
				touchedSlugs.add(slug);
				log.info("Plan discovery: archived plan %s file changed — creating new entry", slug);
			}
		} else if (existing) {
			if (existing.commitHash === null) {
				plans[slug] = { ...existing, updatedAt: now };
				changed = true;
				touchedSlugs.add(slug);
			}
		} else {
			plans[slug] = {
				slug,
				title: extractPlanTitle(planFile),
				sourcePath: planFile,
				addedAt: now,
				updatedAt: now,
				commitHash: null,
			};
			changed = true;
			touchedSlugs.add(slug);
		}
	};

	// Build a Set of normalized paths that already belong to a markdown note.
	// Markdown notes added via "Add Markdown File" can point at arbitrary user
	// .md files (NoteService allows `sourcePath = <user-picked path>`). If the AI
	// later edits that same file, we must NOT also register it as a plan — it
	// would shadow the user's explicit note semantics, double-archive into the
	// orphan branch, and surface the same file twice in the panel (plans + notes
	// are merged without sourcePath dedup downstream). Notes are no longer
	// branch-scoped, so any note's sourcePath suppresses plan auto-registration.
	const noteSourcePaths = new Set<string>();
	for (const note of Object.values(registry.notes ?? {})) {
		if (note.sourcePath) noteSourcePaths.add(normalizePathForCompare(note.sourcePath));
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
	for (const rawSlug of slugs) {
		const planFile = join(homedir(), ".claude", "plans", `${rawSlug}.md`);
		if (!existsSync(planFile)) continue;
		if (noteSourcePaths.has(normalizePathForCompare(planFile))) {
			log.info("Plan discovery: %s already a note — skipping plan registration", planFile);
			continue;
		}
		const slug = resolveUniqueSlug(rawSlug, planFile, plans);
		upsertEntry(slug, planFile);
	}

	// 2. External .md paths — slug resolved against current plans snapshot.
	//    basenameNoExt is platform-agnostic so a Windows-style path parsed on
	//    POSIX CI still yields a clean filename slug.
	for (const absPath of externalPlans) {
		if (!existsSync(absPath)) continue;
		if (noteSourcePaths.has(normalizePathForCompare(absPath))) {
			log.info("Plan discovery: %s already a note — skipping plan registration", absPath);
			continue;
		}
		const baseSlug = basenameNoExt(absPath, ".md");
		const slug = resolveUniqueSlug(baseSlug, absPath, plans);
		upsertEntry(slug, absPath);
	}

	if (changed) {
		// Re-read once more and merge per-slug onto the freshest snapshot.
		//
		// Why not just write our local `plans`: between our initial load and
		// this save, sibling pipelines may have written to plans.json:
		//   - QueueWorker may have added a `<slug>-<commitHash8>` archive entry
		//     and upgraded the original slug into an archive guard
		//   - Another StopHook (parallel session) may have added a new slug
		//   - The extension may have removed an entry (hard delete)
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
				merged[slug] = fresh;
			} else {
				merged[slug] = ours;
			}
		}
		// Spread freshRegistry first to preserve notes / references — otherwise
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

	return totalLines;
}

/**
 * Scans a transcript JSONL file starting from a given line, looking for plan references.
 *
 * Returns two sets:
 *   - `slugs`: slugs for plans in ~/.claude/plans/ (slug-keyed)
 *   - `externalPlans`: absPaths for .md files outside ~/.claude/plans/
 *     (slug resolution deferred to the upsert phase, which has the registry snapshot)
 */
function scanTranscriptForPlans(
	transcriptPath: string,
	startLine: number,
): Promise<{ slugs: Set<string>; externalPlans: Set<string>; totalLines: number }> {
	return new Promise((resolve) => {
		const slugs = new Set<string>();
		const externalPlans = new Set<string>();
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
					slugs.add(match[1]);
				}
			}

			// Detect Write/Edit tool calls. First try the slug-keyed
			// ~/.claude/plans/ path; only fall back to the generic .md regex
			// when that misses, so existing behavior is preserved.
			if (line.includes('"type":"tool_use"') && WRITE_EDIT_REGEX.test(line)) {
				const pathMatch = PLANS_PATH_SLUG_REGEX.exec(line);
				if (pathMatch?.[1]) {
					slugs.add(pathMatch[1]);
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
							externalPlans.add(absPath);
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

// ─── Reference Discovery (multi-source) ─────────────────────────────────────

/**
 * Scans the transcript for ALL registered source adapters (Linear / Jira /
 * GitHub / Notion / …) from `fromLine` and persists discovered references:
 *   1. extractReferencesFromTranscript(transcriptPath, ALL_ADAPTERS, …) → Reference[]
 *   2. For each ref: upsertReferenceEntry routes the row into plans.json.references
 *      and writes per-reference markdown via ReferenceStore.writeReferenceMarkdown.
 *
 * Pure scan + upsert — the caller (discoverFromTranscript) owns the merged
 * discovery cursor. Returns the furthest line scanned (EOF).
 */
async function scanReferencesFrom(transcriptPath: string, fromLine: number, cwd: string): Promise<number> {
	const { references, lastLineNumberScanned } = await extractReferencesFromTranscript(transcriptPath, ALL_ADAPTERS, {
		fromLineNumber: fromLine,
	});

	if (references.length === 0) {
		return lastLineNumberScanned;
	}

	const branch = getCurrentBranch(cwd);
	const upserted: string[] = [];
	const failed: string[] = [];
	for (const ref of references) {
		// Per-iteration try/catch: a single bad ref (e.g. permission error
		// writing markdown, or a transient plans.json write contention) must
		// not abort the batch — otherwise subsequent refs are lost AND the
		// cursor save below is skipped, so the next StopHook re-processes the
		// same refs and hits the same failure in a loop.
		try {
			await upsertReferenceEntry(ref, cwd, branch);
			upserted.push(ref.mapKey);
		} catch (err) {
			log.warn(
				"Reference discovery: failed to persist %s: %s — continuing with rest of batch",
				ref.mapKey,
				(err as Error).message,
			);
			failed.push(ref.mapKey);
		}
	}
	log.info(
		"Reference discovery: upserted %d of %d ref(s)%s",
		upserted.length,
		references.length,
		failed.length > 0 ? ` (failed: [${failed.join(", ")}])` : "",
	);

	return lastLineNumberScanned;
}

/** Extracts the first # heading from a markdown file. */
function extractPlanTitle(filePath: string): string {
	// Use a platform-agnostic basename for the fallback: node:path.basename
	// only recognizes the current platform's separator, so a Windows path
	// processed on POSIX would degrade into the entire path string. split-
	// then-pop never returns undefined on a non-empty string, so the non-null
	// assertion replaces the dead `?? filePath` branch v8 would otherwise count.
	// biome-ignore lint/style/noNonNullAssertion: split-then-pop is provably non-null
	const fallback = filePath.split(/[/\\]/).pop()!;
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
		return execFileSyncHidden("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
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
