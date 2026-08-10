/**
 * PlanPaths — filesystem locations for Claude Code plan files.
 *
 * A LEAF module on purpose, and it must stay one. `getClaudePlansDir` is needed by
 * `DaemonServer.computeWatchTargets`, and `DaemonServer` is one of the few
 * static value imports in [`IdeBridgeCommand.ts`](../commands/IdeBridgeCommand.ts) —
 * a file that keeps its top-level imports to types and leaf modules and does
 * every handler's work behind `await import(...)`, precisely because a cold
 * one-shot `jolli ide-bridge` spawn pays for the whole eager dependency graph
 * before it reads its first request.
 *
 * Importing this function from `PlanService` instead makes that module's chain
 * eager for every such process: `SummaryStore` → `OrphanBranchStorage` /
 * `GitOps`, plus `SessionTracker`, `ReferenceStore` and `Locks`. Measured under
 * tsx: ~4 ms for DaemonServer's leaf-only imports, ~28 ms with `PlanService`
 * pulled in. Irrelevant once a daemon is bound (a call is ~5-20 ms against a
 * live process), but the cold-spawn fallback's budget is where it lands.
 *
 * So: no imports here beyond `node:os` / `node:path`, and nothing that reads or
 * writes the registry. The `"cold-start import graph"` suite in
 * [`DaemonServer.test.ts`](../daemon/DaemonServer.test.ts) pins the import list
 * that depends on this staying true — it is a source-shape assertion, because a
 * new static import there would typecheck, lint and leave every test green while
 * silently costing the cold spawn its budget.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns Claude Code's plan-mode directory (`~/.claude/plans/`).
 *
 * This is Claude-SPECIFIC, and it is NOT a universal plan store. Only plans that
 * Claude Code's plan mode writes live here; every other discovered plan — an
 * in-repo `.md`, a file the agent wrote elsewhere, or another agent's plan —
 * keeps its real path in `plans.json` via `PlanEntry.sourcePath` and is never
 * copied into this directory. So "get the plans dir" means "get Claude's
 * plan-mode dir", not "the place all plans go".
 *
 * Machine-global within that one channel: all of Claude's plan-mode files (from
 * every project) share this single directory, which is why attribution is
 * `isPlanFromCurrentProject`'s job and never the caller's.
 *
 * `home` defaults to the real `homedir()`; it is a parameter only so callers that
 * must stay testable with an injected home (the containment classifier) can pass
 * one instead of reading the machine's actual `$HOME`.
 */
export function getClaudePlansDir(home: string = homedir()): string {
	return join(home, ".claude", "plans");
}

/**
 * The canonical, machine-global plan directories that legitimately live OUTSIDE
 * a worktree. Consumed by the containment classifier
 * ({@link file://./plans/PlanContainment.ts}), which whitelists them so a plan
 * here is never mistaken for a foreign-repo file when `$HOME` happens to sit
 * inside an unrelated git repo. Today that is only Claude's `~/.claude/plans/`.
 *
 * This is the classifier's whitelist, NOT a registry every consumer reads. The
 * registration, discovery and watch paths (`PlanService`, `TranscriptPlanDiscovery`,
 * `DaemonServer`) each target `getClaudePlansDir()` directly — they write/scan ONE
 * dir plus a slug and cannot consume a list. So adding a dir here whitelists it
 * for classification only; it does not make anything register or scan that dir.
 */
export function canonicalPlanDirs(home: string = homedir()): string[] {
	return [getClaudePlansDir(home)];
}
