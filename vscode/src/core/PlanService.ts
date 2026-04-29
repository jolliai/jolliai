/**
 * PlanService
 *
 * Central service for all plan management operations:
 * - Discovery: Plans are discovered by the StopHook (in jollimemory) which
 *   incrementally scans transcripts and writes to plans.json. This service
 *   only reads plans.json — no transcript scanning happens here.
 * - Registry: plans.json CRUD (load, save, ignore, add)
 * - Resolution: Resolving editable file paths for committed/uncommitted plans
 * - Listing: Available plans for QuickPick selection
 * - Filtering: Branch-aware visibility, archive guards, ignored entries
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync as fsReadFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	loadAllSessions,
	loadPlansRegistry,
	savePlansRegistry,
} from "../../../cli/src/core/SessionTracker.js";
import { storePlans } from "../../../cli/src/core/SummaryStore.js";
import type { PlanReference } from "../../../cli/src/Types.js";
import type { PlanEntry, PlanInfo } from "../Types.js";
import { log } from "../util/Logger.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the global plans directory path (~/.claude/plans/) */
export function getPlansDir(): string {
	return join(homedir(), ".claude", "plans");
}

/**
 * Reads plans.json and returns a filtered, sorted list of PlanInfo.
 *
 * This function does NOT discover new plans from the filesystem — that is the
 * job of (a) the StopHook at turn end (scans transcripts) and (b) the
 * plans-dir watcher's onDidCreate callback wiring `registerNewPlan` in
 * Extension.ts. Scanning the directory here would surface historical plans
 * from other projects/sessions (since ~/.claude/plans/ is global), polluting
 * the per-project panel.
 *
 * The pass also cleans up orphaned entries (uncommitted, file deleted) — a
 * one-shot convergence: a subsequent call with no orphans performs no writes.
 */
export async function detectPlans(cwd: string): Promise<Array<PlanInfo>> {
	const registry = await loadPlansRegistry(cwd);
	const registryPlans = { ...registry.plans };

	// Clean up orphaned entries (source file deleted, uncommitted, not a guard)
	let cleaned = false;
	for (const [slug, entry] of Object.entries(registryPlans)) {
		if (
			entry.commitHash === null &&
			!entry.contentHashAtCommit &&
			!entry.ignored &&
			!existsSync(entry.sourcePath)
		) {
			delete registryPlans[slug];
			cleaned = true;
		}
	}
	if (cleaned) {
		await savePlansRegistry({ ...registry, plans: registryPlans }, cwd);
	}

	const branch = getCurrentBranch(cwd);
	const plans = buildPlanInfoList(registryPlans, branch);
	log.info(
		"plans",
		`detectPlans found ${plans.length} plans (${Object.keys(registryPlans).length} in registry)`,
	);
	return plans;
}

/** Converts registry entries into a sorted PlanInfo array, filtering out invisible entries. */
function buildPlanInfoList(
	registryPlans: Record<string, PlanEntry>,
	currentBranch?: string,
): Array<PlanInfo> {
	const plans: Array<PlanInfo> = [];
	for (const entry of Object.values(registryPlans)) {
		const info = toPlanInfo(entry, currentBranch);
		if (info) {
			plans.push(info);
		}
	}
	plans.sort(
		(a, b) =>
			new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
	);
	return plans;
}

/** Converts a single PlanEntry to PlanInfo, returning null if the entry should be hidden. */
function toPlanInfo(entry: PlanEntry, currentBranch?: string): PlanInfo | null {
	if (entry.ignored) {
		return null;
	}

	// Skip entries from other branches
	if (currentBranch && entry.branch && entry.branch !== currentBranch) {
		return null;
	}

	// Skip archive guards (source file unchanged)
	if (entry.contentHashAtCommit) {
		const planFile = join(getPlansDir(), `${entry.slug}.md`);
		if (
			!existsSync(planFile) ||
			hashFileContent(planFile) === entry.contentHashAtCommit
		) {
			return null;
		}
	}

	// Skip committed snapshot copies (slug-<shortHash> entries created by archivePlanForCommit).
	// These exist only for orphan branch storage / Summary WebView, not for the sidebar panel.
	if (entry.commitHash !== null && !entry.contentHashAtCommit) {
		return null;
	}

	// Skip uncommitted plans whose source file was deleted
	if (entry.commitHash === null && !existsSync(entry.sourcePath)) {
		return null;
	}

	const filePath = entry.commitHash === null ? entry.sourcePath : "";

	let title = entry.title;
	if (entry.commitHash === null && existsSync(entry.sourcePath)) {
		title = extractTitle(entry.sourcePath);
	}

	let lastModified = entry.updatedAt;
	if (entry.commitHash === null && existsSync(entry.sourcePath)) {
		try {
			lastModified = statSync(entry.sourcePath).mtime.toISOString();
		} catch {
			/* ignore — stat failure is non-critical */
		}
	}

	return {
		slug: entry.slug,
		filename: `${entry.slug}.md`,
		filePath,
		title,
		lastModified,
		addedAt: entry.addedAt,
		updatedAt: entry.updatedAt,
		branch: entry.branch,
		editCount: entry.editCount,
		commitHash: entry.commitHash,
	};
}

/**
 * Marks a plan as ignored in plans.json (hidden from PLANS panel).
 * Does not delete the entry — detectPlans() will skip it.
 */
export async function ignorePlan(slug: string, cwd: string): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const entry = registry.plans[slug];
	if (!entry) {
		return;
	}
	await savePlansRegistry(
		{
			...registry,
			plans: { ...registry.plans, [slug]: { ...entry, ignored: true } },
		},
		cwd,
	);
}

/**
 * Adds a plan from ~/.claude/plans/ to the registry as an uncommitted entry.
 * Clears the `ignored` flag if previously set.
 */
export async function addPlanToRegistry(
	slug: string,
	cwd: string,
): Promise<void> {
	const planFile = join(getPlansDir(), `${slug}.md`);
	if (!existsSync(planFile)) {
		return;
	}

	const registry = await loadPlansRegistry(cwd);
	const existing = registry.plans[slug];
	const now = new Date().toISOString();

	// Always reset to a fresh uncommitted entry — clears ignored, contentHashAtCommit,
	// and commitHash so the plan becomes visible and editable again.
	const entry: PlanEntry = {
		slug,
		title: extractTitle(planFile),
		sourcePath: planFile,
		addedAt: existing?.addedAt ?? now,
		updatedAt: now,
		branch: getCurrentBranch(cwd),
		commitHash: null,
		editCount: existing?.editCount ?? 0,
	};

	await savePlansRegistry(
		{
			...registry,
			plans: { ...registry.plans, [slug]: entry },
		},
		cwd,
	);
}

/**
 * Registers a plan slug into plans.json iff it isn't already tracked.
 *
 * - If the slug exists (even as an ignored entry), this is a no-op — the
 *   user's explicit Ignore state is preserved. Recreating the same filename
 *   does not resurrect a previously-ignored plan.
 * - Otherwise delegates to `addPlanToRegistry()` to create a fresh
 *   uncommitted entry.
 *
 * Designed to be called from the plans-dir watcher's `onDidCreate` callback:
 * the OS only fires create events for files appearing after the watcher is
 * subscribed, so historical plans from other projects/sessions in
 * ~/.claude/plans/ never reach this function.
 */
export async function registerNewPlan(
	slug: string,
	cwd: string,
): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	if (slug in registry.plans) {
		return;
	}
	await addPlanToRegistry(slug, cwd);
}

/**
 * Returns true iff the given plan file's absolute path appears in one of the
 * transcripts belonging to the current project.
 *
 * Why: `~/.claude/plans/` is global across projects. When multiple VS Code
 * instances are open on different workspaces, the OS delivers a single
 * `onDidCreate` event to every subscriber watching that directory. Without a
 * project-affinity check, a plan created by project B's Claude session would
 * get registered into project A's plans.json as well. This helper restores
 * the attribution that the StopHook path has always had (it only scans the
 * current project's transcripts).
 *
 * Matching strategy: we look for the absolute path as a substring in the raw
 * transcript text. Claude Code records Write/Edit `tool_use` entries with
 * `"file_path":"<absPath>"`. Because transcripts are JSON-escaped, backslashes
 * on Windows appear doubled (`\\`), so we compare against the escaped form.
 */
export async function isPlanFromCurrentProject(
	absPath: string,
	cwd: string,
): Promise<boolean> {
	const sessions = await loadAllSessions(cwd);
	if (sessions.length === 0) {
		return false;
	}
	// JSON-escaped form of the path, matching how Claude Code writes file_path
	// values into transcript JSONL lines.
	const needle = absPath.replace(/\\/g, "\\\\");
	for (const session of sessions) {
		try {
			const content = await readFile(session.transcriptPath, "utf-8");
			if (content.includes(needle)) {
				return true;
			}
		} catch {
			// Transcript missing or unreadable (rotated, permission issue) —
			// skip; attribution just falls through to StopHook later.
		}
	}
	return false;
}

/**
 * Lists all plan files in ~/.claude/plans/ that are NOT in the exclude set.
 * Returns { slug, title, mtime } sorted by modification time (newest first).
 */
export function listAvailablePlans(
	excludeSlugs: ReadonlySet<string>,
): ReadonlyArray<{ slug: string; title: string; mtimeMs: number }> {
	if (!existsSync(getPlansDir())) {
		return [];
	}

	const files = readdirSync(getPlansDir()).filter((f) => f.endsWith(".md"));
	const available: Array<{ slug: string; title: string; mtimeMs: number }> = [];

	for (const file of files) {
		const slug = file.replace(/\.md$/, "");
		if (excludeSlugs.has(slug)) {
			continue;
		}
		const filePath = join(getPlansDir(), file);
		try {
			const mtime = statSync(filePath).mtimeMs;
			available.push({ slug, title: extractTitle(filePath), mtimeMs: mtime });
		} catch {
			available.push({ slug, title: extractTitle(filePath), mtimeMs: 0 });
		}
	}

	return available.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ─── WebView plan operations ──────────────────────────────────────────────────

/**
 * Archives a plan and associates it with a commit (called from WebView "+ Associate Plan").
 * Mirrors PostCommitHook's archive logic: renames slug to slug-hash, sets archive guard
 * on original slug (contentHashAtCommit), stores plan file in orphan branch.
 *
 * @returns PlanReference for inclusion in CommitSummary.plans
 */
export async function archivePlanForCommit(
	slug: string,
	commitHash: string,
	cwd: string,
): Promise<PlanReference | null> {
	const registry = await loadPlansRegistry(cwd);
	let entry = registry.plans[slug];

	// If slug is not in the registry (e.g., picked from ~/.claude/plans/ directory but
	// never auto-discovered from transcript), create a fresh entry first.
	if (!entry) {
		const planFile = join(getPlansDir(), `${slug}.md`);
		if (!existsSync(planFile)) {
			return null;
		}
		entry = {
			slug,
			title: extractTitle(planFile),
			sourcePath: planFile,
			addedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			branch: getCurrentBranch(cwd),
			commitHash: null,
			editCount: 0,
		};
	}

	const now = new Date().toISOString();
	const shortHash = commitHash.substring(0, 8);
	const newSlug = `${slug}-${shortHash}`;

	// Compute content hash for archive guard
	let contentHashAtCommit: string | undefined;
	if (existsSync(entry.sourcePath)) {
		contentHashAtCommit = hashFileContent(entry.sourcePath);
	}

	// Update plans.json: original slug becomes guard, new slug is the committed entry
	await savePlansRegistry(
		{
			...registry,
			plans: {
				...registry.plans,
				[slug]: {
					...entry,
					commitHash,
					updatedAt: now,
					contentHashAtCommit,
					ignored: undefined,
				},
				[newSlug]: {
					slug: newSlug,
					title: entry.title,
					sourcePath: entry.sourcePath,
					addedAt: entry.addedAt,
					updatedAt: now,
					branch: entry.branch,
					commitHash,
					editCount: entry.editCount,
				},
			},
		},
		cwd,
	);

	// Store plan file in orphan branch under new slug
	const planFile = join(getPlansDir(), `${slug}.md`);
	if (existsSync(planFile)) {
		const content = fsReadFileSync(planFile, "utf-8");
		await storePlans(
			[{ slug: newSlug, content }],
			`Associate plan ${newSlug} with commit ${shortHash}`,
			cwd,
		);
	}

	log.info(
		"plans",
		`Archived plan ${slug} → ${newSlug} for commit ${shortHash}`,
	);

	return {
		slug: newSlug,
		title: entry.title,
		editCount: entry.editCount,
		addedAt: entry.addedAt,
		updatedAt: now,
	};
}

/**
 * Removes a plan's association with a commit (called from WebView "Remove" button).
 * Clears commitHash in plans.json so the plan becomes unassociated.
 */
export async function unassociatePlanFromCommit(
	slug: string,
	cwd: string,
): Promise<void> {
	const registry = await loadPlansRegistry(cwd);
	const entry = registry.plans[slug];
	if (!entry) {
		return;
	}

	await savePlansRegistry(
		{
			...registry,
			plans: {
				...registry.plans,
				[slug]: { ...entry, commitHash: null },
			},
		},
		cwd,
	);

	log.info("plans", `Unassociated plan ${slug} from commit`);
}

/**
 * Lists unassociated plans from plans.json for WebView QuickPick.
 * Includes ignored plans (so users can restore them via Associate).
 */
export async function listUnassociatedPlans(
	cwd: string,
): Promise<ReadonlyArray<{ slug: string; title: string }>> {
	const registry = await loadPlansRegistry(cwd);
	return Object.values(registry.plans)
		.filter((p) => p.commitHash === null)
		.map((p) => ({ slug: p.slug, title: p.title }));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Extracts the first # heading from a markdown file, falling back to the filename. */
export function extractTitle(filePath: string): string {
	const filename = filePath.split(/[/\\]/).pop() as string;
	try {
		const content = fsReadFileSync(filePath, "utf-8");
		const match = /^#\s+(.+)/m.exec(content);
		return match?.[1]?.trim() ?? filename;
	} catch {
		return filename;
	}
}

function hashFileContent(filePath: string): string {
	return createHash("sha256")
		.update(fsReadFileSync(filePath, "utf-8"))
		.digest("hex");
}

export function getCurrentBranch(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "unknown";
	}
}
