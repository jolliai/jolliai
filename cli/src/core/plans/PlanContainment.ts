/**
 * PlanContainment — classify a plan's `sourcePath` as belonging to THIS
 * repository, to a foreign repository, or to neither.
 *
 * Plans are auto-discovered by scanning the agent transcript for `.md` files
 * it read/wrote. A session working in repo A that
 * incidentally touches a `.md` in a sibling checkout of repo B registers B's
 * file as one of A's plans, and it then attaches to A's next commit — polluting
 * the PR-description Context and the summary topics. This module is the
 * deterministic gate that keeps a foreign-repo plan out of the archive, with NO
 * LLM in the loop.
 *
 * The discriminator is git-repository IDENTITY, not directory containment.
 * Claude plan-mode plans legitimately live in `~/.claude/plans/` (outside the
 * worktree), so "outside the worktree ⇒ foreign" would wrongly drop the most
 * important plans. Instead we compare the file's enclosing repo's
 * git-common-dir with the current repo's:
 *   - a file inside the current worktree is `local` (cheap, no git call);
 *   - a file under a canonical agent plan dir (`~/.claude/plans/`) is `local`
 *     (whitelist — independent of any repo that happens to enclose $HOME);
 *   - a file whose enclosing repo differs from the current one is `foreign`;
 *   - a file in a sibling WORKTREE of the same repo shares the common-dir, so
 *     it is `local` (worktree-aware, per the repo's worktree rule);
 *   - a file in no git repo at all (loose temp, deleted dir) is `unknown` and
 *     is KEPT — conservative, since stale temp residue is a separate pruning
 *     concern and "don't drop on uncertainty" is the safe default.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExcludedContextItem, PlanEntry } from "../../Types.js";
import { resolveContainingRepoCommonDir } from "../GitOps.js";
import { isPathInside, normalizePathForCompare } from "../PathUtils.js";
import { canonicalPlanDirs } from "../PlanPaths.js";

/** Classification of a plan's `sourcePath` relative to the current repository. */
export type PlanSourceClass = "local" | "foreign" | "unknown";

/** Human-readable reason recorded on a foreign plan's `excludedContext` entry so
 *  the panel can explain why it was left out (and distinguish it from an
 *  LLM-driven soft-exclude). */
export const FOREIGN_PLAN_EXCLUSION_REASON = "Outside the current repository";

/** Injectable dependencies — real implementations by default, faked in tests so
 *  the branch logic is exercised without spawning `git`. */
export interface PlanContainmentDeps {
	/** Resolve the absolute, normalized git-common-dir of the repo that owns
	 *  `dir`, or null when `dir` is not inside any git repository (or cannot be
	 *  resolved). */
	readonly resolveRepoId: (dir: string) => Promise<string | null>;
	/** Home directory lookup. */
	readonly homeDir: () => string;
}

/** Resolve symlinks in `p` so two spellings of the same location compare equal;
 *  fall back to the input if it cannot be resolved (e.g. it no longer exists). */
function canonicalizePath(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}

async function defaultResolveRepoId(dir: string): Promise<string | null> {
	// resolveContainingRepoCommonDir strips the ambient GIT_DIR/GIT_WORK_TREE the
	// git hook exports — without that, every lookup (foreign dir OR cwd) would
	// resolve to the hook's repo, so a sibling repo's plan would read as local
	// and never get excluded. It returns null (not a repo / missing dir) rather
	// than throwing.
	const common = await resolveContainingRepoCommonDir(dir);
	// Treat any falsy result as "not a repo" — the real resolver returns
	// string|null, but a reset test mock can yield undefined; `!common` handles
	// both without crashing normalizePathForCompare.
	if (!common) return null;
	// git returns the common-dir in two shapes: a path RELATIVE to the queried
	// dir for the main worktree (resolved against `dir`, so it keeps whatever
	// symlink prefix `dir` had), but an ABSOLUTE, often already-realpath'd path
	// for a linked worktree. When the repo sits under a symlinked prefix (macOS
	// /var → /private/var, a symlinked home), the two shapes diverge and a sibling
	// worktree of the SAME repo reads as foreign — the exact worktree-aware case
	// this classifier must preserve. realpath both spellings so they collapse to
	// one identity before comparison.
	return normalizePathForCompare(canonicalizePath(common));
}

/**
 * Builds a classifier bound to `cwd` (the current worktree root). The returned
 * function memoizes git resolution per directory, so classifying N plans that
 * share a handful of directories costs a handful of `git` calls, not N. The
 * classifier is single-run scoped — create a fresh one per pipeline invocation.
 */
export function createPlanSourceClassifier(
	cwd: string,
	deps: Partial<PlanContainmentDeps> = {},
): (sourcePath: string | undefined) => Promise<PlanSourceClass> {
	const resolveRepoId = deps.resolveRepoId ?? defaultResolveRepoId;
	const home = (deps.homeDir ?? homedir)();
	// Shared with plan registration via PlanPaths — the one place the set of
	// legitimate outside-worktree plan dirs is defined.
	const whitelistDirs = canonicalPlanDirs(home);
	// Single-flight per directory: store the in-flight PROMISE, not the resolved
	// value, so a burst of concurrent classify() calls (the prompt side uses
	// Promise.all) sharing a directory all await the same one `git` resolution
	// rather than each spawning their own. defaultResolveRepoId never rejects, so
	// caching the promise cannot memoize a rejection.
	const repoIdByDir = new Map<string, Promise<string | null>>();

	function repoIdOf(dir: string): Promise<string | null> {
		const key = normalizePathForCompare(dir);
		let pending = repoIdByDir.get(key);
		if (pending === undefined) {
			pending = resolveRepoId(dir);
			repoIdByDir.set(key, pending);
		}
		return pending;
	}

	return async function classify(sourcePath: string | undefined): Promise<PlanSourceClass> {
		// Missing sourcePath: nothing to locate → don't drop on uncertainty.
		if (!sourcePath) return "unknown";
		// Inside the current worktree — the common case, resolved without git.
		if (isPathInside(sourcePath, cwd)) return "local";
		// Canonical agent plan dir — legitimately outside the worktree.
		if (whitelistDirs.some((d) => isPathInside(sourcePath, d))) return "local";
		// Otherwise decide by git-repository identity.
		const fileRepoId = await repoIdOf(dirname(sourcePath));
		if (fileRepoId === null) return "unknown";
		const ownRepoId = await repoIdOf(cwd);
		// Defensive: cwd should always be a repo when the pipeline runs. If it is
		// not, we cannot prove foreignness — keep rather than drop.
		if (ownRepoId === null) return "unknown";
		return fileRepoId === ownRepoId ? "local" : "foreign";
	};
}

/** Result of splitting a plan set into the ones to keep and the foreign ones to
 *  surface as soft-exclusions. */
export interface ForeignPlanPartition {
	/** Plans classified local or unknown — kept, and fed to the summarizer. */
	readonly localPlans: PlanEntry[];
	/** One `excludedContext` entry per foreign plan, for panel visibility. */
	readonly foreignExcludedContext: ExcludedContextItem[];
}

/**
 * Splits `plans` into local-kept vs foreign-excluded using `classify`. Foreign
 * plans are turned into `excludedContext` entries (reason
 * {@link FOREIGN_PLAN_EXCLUSION_REASON}) so the panel can show WHY they were left
 * out. Shared by both prompt-side call sites (executePipeline and the amend
 * pipeline) so the split logic is defined — and tested — in exactly one place.
 */
export async function partitionForeignPlans(
	plans: readonly PlanEntry[],
	classify: (sourcePath: string | undefined) => Promise<PlanSourceClass>,
): Promise<ForeignPlanPartition> {
	const classes = await Promise.all(plans.map((p) => classify(p.sourcePath)));
	const localPlans: PlanEntry[] = [];
	const foreignExcludedContext: ExcludedContextItem[] = [];
	plans.forEach((p, i) => {
		if (classes[i] === "foreign") {
			foreignExcludedContext.push({
				kind: "plan",
				key: p.slug,
				title: p.title,
				reason: FOREIGN_PLAN_EXCLUSION_REASON,
				tier: "low",
			});
		} else {
			localPlans.push(p);
		}
	});
	return { localPlans, foreignExcludedContext };
}
