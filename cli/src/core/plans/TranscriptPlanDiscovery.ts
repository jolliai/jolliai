/**
 * TranscriptPlanDiscovery — source-aware plan scan + persist.
 *
 * Extracted from StopHook so both the Claude Stop path and the Codex polling
 * path drive the same upsert logic. `scanPlansFrom` is a pure scan + upsert: it
 * runs the per-agent plan scanner (picked by `source`), applies the shared
 * external-plan exclusion policy, then upserts each surviving plan into
 * plans.json (archive guard, note dedup, resolveUniqueSlug, concurrent merge).
 * It does NOT own the discovery cursor — the caller persists the line target.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../Logger.js";
import type { PlanEntry, TranscriptSource } from "../../Types.js";
import { getCurrentBranchSafe } from "../GitBranch.js";
import { withPlansLock } from "../Locks.js";
import { normalizePathForCompare } from "../PathUtils.js";
import { loadPlansRegistry, savePlansRegistry } from "../SessionTracker.js";
import { getPlanScanner } from "./PlanTranscriptScanner.js";

const log = createLogger("PlanDiscovery");

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
	// Case-insensitive: both scanners admit `.md` case-insensitively (Codex sees
	// `*** Add File: Plan.MD`), so strip the extension regardless of case to keep
	// a clean slug. Both scanners guarantee the path ends in `ext`, so the false
	// arm is dead — guarded so it doesn't eat the branch budget.
	/* v8 ignore next -- defensive: scanners guarantee a path ending in `ext`; false arm is unreachable */
	if (!last.toLowerCase().endsWith(ext.toLowerCase())) return last;
	return last.slice(0, -ext.length);
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

/**
 * Scans the transcript for plan file references from `fromLine` (exclusive) up to
 * `toLine` (inclusive, default EOF) and upserts them into plans.json. Pure scan +
 * upsert — the caller owns the merged discovery cursor. Returns the furthest line
 * scanned.
 *
 * The per-agent scanner (`getPlanScanner(source)`) handles HOW each transcript
 * announces a plan write; this driver is source-agnostic from there on.
 *
 * Detection covers three scenarios (Claude; Codex emits only external paths):
 *   1. Plan mode: the transcript contains a "slug":"xxx" field
 *   2. Direct write to ~/.claude/plans/: Write/Edit tool call hits the canonical dir
 *   3. External .md files (e.g. docs/foo.md, E:\jm-docs\bar.md) not excluded by
 *      isExternalPlanCandidate — slug derived from basename via resolveUniqueSlug.
 */
export async function scanPlansFrom(
	transcriptPath: string,
	fromLine: number,
	cwd: string,
	source: TranscriptSource,
	toLine: number = Number.POSITIVE_INFINITY,
): Promise<number> {
	// Scan from fromLine, collecting discovered slugs / external paths.
	const { slugs, externalPlans, totalLines } = await getPlanScanner(source).scan(
		transcriptPath,
		fromLine,
		cwd,
		toLine,
	);

	// Apply the shared external-plan exclusion policy here (not in the scanner) so
	// every source inherits the same README/AGENTS.md/etc. filter. Filter BEFORE
	// the early-exit so "only excluded files were touched" still skips the registry
	// read — byte-equivalent to the pre-refactor Claude behaviour.
	const filteredExternal = new Set([...externalPlans].filter(isExternalPlanCandidate));

	if (slugs.size === 0 && filteredExternal.size === 0) {
		return totalLines;
	}

	// Upsert into plans.json. Re-read registry right before writing to
	// minimize race window with PostCommitHook.
	const registry = await loadPlansRegistry(cwd);
	const plans = { ...registry.plans };
	const now = new Date().toISOString();
	// Stamp the branch on newly-created rows so the IntelliJ plugin (which shares
	// this plans.json) can branch-scope its CONTEXT view. Omit on an "unknown" git
	// lookup so the row stays branch-less (visible everywhere) rather than scoped
	// to a non-existent branch. The CLI itself does not filter on it.
	const discoveredBranch = getCurrentBranchSafe(cwd);
	const branchField = discoveredBranch && discoveredBranch !== "unknown" ? { branch: discoveredBranch } : {};
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
					...branchField,
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
				...branchField,
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

	// 2. External .md paths — already filtered to candidates. Slug resolved
	//    against current plans snapshot. basenameNoExt is platform-agnostic so a
	//    Windows-style path parsed on POSIX CI still yields a clean filename slug.
	//
	//    existsSync is the ONLY success gate, and that is INTENTIONAL — not a bug.
	//    Scanners read the write REQUEST (Claude's Write/Edit tool_use, Codex's
	//    apply_patch input), never the tool result, so we don't know if a given
	//    edit actually applied. "Is there a real .md on disk?" is the contract:
	//      - A failed/undone *Add File* leaves no file → existsSync false → skipped.
	//      - A failed/undone *Update File* to a PRE-EXISTING .md leaves the file in
	//        place → existsSync true → registered. This registers an .md the AI was
	//        editing even though that particular edit didn't land — accepted as a
	//        benign true-ish positive, and identical to the long-standing Claude
	//        behaviour (a failed Edit to an existing .md registers the same way).
	for (const absPath of filteredExternal) {
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
		// plans.lock serialises this reload→save against other plans.json writers
		// (QueueWorker archival, the Codex-discovery tick, a parallel StopHook).
		// The fresh reread happens INSIDE the lock, so the per-slug merge layers
		// our touched slugs onto a baseline no one can clobber before we save.
		await withPlansLock(cwd, async () => {
			const freshRegistry = await loadPlansRegistry(cwd);
			const merged: Record<string, PlanEntry> = { ...freshRegistry.plans };
			for (const slug of touchedSlugs) {
				const ours = plans[slug];
				// touchedSlugs only ever holds slugs upsertEntry assigned into `plans`,
				// so `ours` is always defined — the guard is defensive/unreachable.
				/* v8 ignore next -- defensive: every touched slug exists in `plans` */
				if (!ours) continue;
				const fresh = freshRegistry.plans[slug];
				const freshCommitHash = fresh?.commitHash;
				const existedAtLoad = registry.plans[slug] !== undefined;
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
				} else if (fresh !== undefined || !existedAtLoad) {
					// Write our version — UNLESS it was concurrently hard-deleted (the
					// branch below). A slug we created THIS run is always written
					// (`!existedAtLoad`); a slug still present in the fresh re-read is
					// written too (`fresh !== undefined`).
					merged[slug] = ours;
				}
				// else: fresh === undefined && existedAtLoad → CONCURRENT HARD DELETE.
				// The slug was present at our outside-lock load but a sibling (sidebar
				// "Remove" → removePlan) deleted it before our in-lock re-read. Leave
				// `merged` without it (its baseline is freshRegistry.plans, which
				// already omits it) so the explicit delete wins over our racing
				// auto-registration. This is the "hard delete" case the strategy
				// comment above promises to preserve.
			}
			// Spread freshRegistry first to preserve notes / references — otherwise
			// any sibling pipeline that wrote them between our load and save (e.g.
			// the note service from the extension, or the reference discovery scan
			// that runs alongside this plan scan) loses its work.
			await savePlansRegistry({ ...freshRegistry, version: 1, plans: merged }, cwd);
		});
		log.info(
			"Plan discovery: upserted %d slug(s) + %d external path(s) into plans.json",
			slugs.size,
			filteredExternal.size,
		);
	}

	return totalLines;
}
