/**
 * ActiveStorageHeal — keeps a long-lived process's process-global storage
 * override honest across a cutover it did not witness.
 *
 * `createStorage` routing only decides which backend a NEWLY created storage
 * object binds to. A long-lived process (the per-worktree MCP daemon; the VS
 * Code host) calls `setActiveStorage` ONCE at startup and then holds that object
 * for its whole life. If the repo cuts over afterwards, the override is a
 * pre-cutover `DualWriteStorage(orphan, folder)` — and because the override
 * short-circuits `resolveStorage` / `resolveReadStorage` (SummaryStore), the
 * `sotFallback` that would otherwise resolve the current system of record never
 * runs. Two failures follow, and the second is the worse one:
 *
 *   1. A write (e.g. the lazy catalog rebuild `getCatalogWithLazyBuild` runs on
 *      the `search` / `recall` read path) reaches `OrphanBranchStorage.writeFiles`,
 *      which re-reads the fence and throws "orphan branch is frozen". Loud, but a
 *      restart is the only cure.
 *   2. Reads come off the FROZEN orphan branch — silently missing every memory
 *      written to SQLite since the cutover. Stale-but-successful, which the
 *      cutover contract names as worse than no data at all.
 *
 * The heal closes both: before a repo-scoped tool runs, swap the override back
 * to whatever `createStorage` builds for the CURRENT route. The throttle,
 * coalescing and one-way latch all live in the shared {@link CutoverHealGate};
 * this module only wires that gate to THIS host's apply step (swap the process
 * global) and its fast-path predicate ({@link readsFromOrphanBranch}). The VS
 * Code host wires the same gate to its own apply step (drop cached storage).
 */

import { createLogger, errMsg } from "../Logger.js";
import { CutoverHealGate, ROUTE_PROBE_THROTTLE_MS } from "./CutoverHealGate.js";
import { DualWriteStorage } from "./DualWriteStorage.js";
import { createStorage } from "./StorageFactory.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getActiveStorage, setActiveStorage } from "./SummaryStore.js";

const log = createLogger("ActiveStorageHeal");

// Re-exported so the VS Code bridge and the daemon tests keep importing the
// throttle constant from here; the value itself is owned by CutoverHealGate.
export { ROUTE_PROBE_THROTTLE_MS };

/**
 * True when reads from this provider come off the (freezable) orphan branch —
 * i.e. it is a pre-cutover object. `DualWriteStorage` reports `kind:"dual-write"`
 * both before and after a cutover, so the primary's kind is the only thing that
 * distinguishes an orphan-backed one from a SQLite-backed one.
 *
 * The dual-write case reaches `.primary` through an `instanceof` narrow, NOT a
 * structural cast: `dual-write` is the DEFAULT storage mode, so a rename of the
 * `primary` field under a structural probe would make this return `false` for
 * every real dual-write object — the whole heal silently no-ops on the common
 * path — and tsc would not catch it. `instanceof` makes that rename a compile
 * error here.
 */
function readsFromOrphanBranch(storage: StorageProvider | undefined): boolean {
	if (!storage) return false;
	if (storage.kind === "orphan-branch") return true;
	if (storage instanceof DualWriteStorage) {
		return storage.primary.kind === "orphan-branch";
	}
	return false;
}

/**
 * One {@link CutoverHealGate} per cwd. A daemon only ever has one, but the key
 * keeps the module general and lets a test isolate cwds. Dropping the whole entry
 * (rather than resetting a field) is what makes {@link resetActiveStorageHealThrottle}
 * clear the throttle AND any in-flight probe together.
 */
const gates = new Map<string, CutoverHealGate>();

function gateFor(cwd: string): CutoverHealGate {
	let gate = gates.get(cwd);
	if (!gate) {
		gate = new CutoverHealGate({
			cwd,
			// The override reads the system of record once it is no longer
			// orphan-backed; that is both the fast path and the racing re-check.
			isHealed: () => !readsFromOrphanBranch(getActiveStorage()),
			applyHeal: async (route) => {
				setActiveStorage(await createStorage(cwd, cwd));
				log.info(
					"Rebuilt active storage after cutover (route=%s); reads/writes now route to the database. cwd=%s",
					route.state,
					cwd,
				);
			},
			onProbeError: (err) =>
				log.debug("cutover-route probe failed during storage heal (%s) — leaving storage as-is", String(err)),
			onApplyError: (err) =>
				log.warn(
					"rebuild after cutover failed (%s) — leaving storage as-is, will retry. cwd=%s",
					errMsg(err),
					cwd,
				),
		});
		gates.set(cwd, gate);
	}
	return gate;
}

/**
 * Rebuilds the process-global active storage if the repo has cut over since it
 * was set. A no-op on the fast path (override already reads the system of record,
 * or there is none). Never throws — see {@link CutoverHealGate.ensure}.
 */
export function ensureActiveStorageMatchesRoute(cwd: string): Promise<void> {
	// Fast path: skip creating a gate at all when there is nothing orphan-backed
	// to heal (no active storage, or it already reads SQLite).
	if (!readsFromOrphanBranch(getActiveStorage())) return Promise.resolve();
	return gateFor(cwd).ensure();
}

/**
 * Test seam: drops every gate so a case reusing a cwd starts clean. Dropping the
 * gate clears both its throttle back-off and any in-flight probe (a lingering
 * in-flight promise from a prior case would otherwise be coalesced onto).
 */
export function resetActiveStorageHealThrottle(): void {
	gates.clear();
}

/**
 * Forget the throttle back-off for ONE cwd so the very next
 * {@link ensureActiveStorageMatchesRoute} re-probes the route instead of trusting
 * the window. Called when a tool hit "orphan branch is frozen": that throw proves
 * a cutover landed inside the current back-off window, so waiting out the wall
 * clock would let a self-retrying agent strike the frozen branch twice.
 */
export function clearActiveStorageHealThrottle(cwd: string): void {
	gates.get(cwd)?.forgetBackOff();
}
