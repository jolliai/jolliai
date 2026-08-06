/**
 * PlanPaths — filesystem locations for Claude Code plan files.
 *
 * A LEAF module on purpose, and it must stay one. `getPlansDir` is needed by
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
 * Returns the machine-global plans directory (`~/.claude/plans/`).
 *
 * Machine-global, not per-project: every project's plans land here, which is why
 * attribution is `isPlanFromCurrentProject`'s job and never the caller's.
 */
export function getPlansDir(): string {
	return join(homedir(), ".claude", "plans");
}
