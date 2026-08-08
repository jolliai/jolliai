/**
 * SotStorageResolver — picks the backend that IS this repo's system of record.
 *
 * The sibling of `ReadStorageResolver.createReadStorage`, and deliberately not
 * a replacement for it: the two answer different questions and disagree in the
 * common case.
 *
 *   createReadStorage  → "which backend should I READ from?"
 *   resolveSotStorage  → "which backend holds the TRUTH?"
 *
 * Un-cutover, `createReadStorage` returns `FolderStorage` (the Memory Bank
 * mirror is the view every surface reads), while the truth is still the orphan
 * branch. So a caller that needs the source of truth — a migration source, a
 * "do any memories exist" predicate, a hook reading a summary straight through
 * — must NOT reuse `createReadStorage`. Feeding it to the migration engine in
 * particular turns the run into folder → folder, migrating the destination
 * onto itself.
 *
 * Two exported shapes, because a single failure policy cannot serve both kinds
 * of caller:
 *
 *   resolveSotStorage(cwd)  throws on `blocked`     — write/read paths
 *   resolveSotBackend(cwd)  returns `{ok:false}`    — diagnostics
 *
 * `blocked` means a fenced or cut-over repo whose database is unavailable:
 * there is no safe backend at all, and falling back to the frozen orphan
 * branch is exactly the loss the fence exists to prevent. A write path must
 * fail loudly. But `doctor` exists to REPORT that state, and a doctor that
 * throws is a doctor that is useless precisely when it is needed, so it takes
 * the union shape instead.
 */

import { type CutoverRoute, resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { resolveRepoIdentityForCwd } from "../dashboard/RepoRegistry.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { SqliteStorage } from "./SqliteStorage.js";
import type { StorageProvider } from "./StorageProvider.js";

/** The routing states in which a system of record exists. */
export type SotState = "uncutover" | "legacy-fenced" | "cutover";

/** Diagnostic-shaped answer: never throws, keeps "no safe backend" as data. */
export type SotBackend =
	| { readonly ok: true; readonly state: SotState; readonly storage: StorageProvider }
	| { readonly ok: false; readonly reason: string };

/**
 * Per-process route memo.
 *
 * `resolveCutoverRoute` opens the database on EVERY call (`readCutoverRow`
 * runs even when the local fence is absent), and `CutoverRouter` memoizes only
 * the repo identity, not the route. Since `SummaryStore.resolveStorage` — ~39
 * call sites, several of them inside per-summary loops — now routes through
 * here, an unmemoized resolver would turn a free field read into one database
 * open per call.
 *
 * Short TTL rather than permanent, because permanence is the bug this module
 * exists to remove: `resolveCutoverRoute`'s own contract is that "the answer is
 * per-call so long-lived processes still need the write-time version check". A
 * VS Code host or `ide-bridge-serve` daemon that memoized forever would keep
 * serving the pre-cutover backend after the fence lands — silently, which is
 * the exact failure mode being swept up here. The TTL bounds that window to
 * seconds; `invalidateSotRouteCache` closes it immediately for the callers that
 * know a switch just happened (the cutover's own tail, the VS Code bridge's
 * `reloadStorage`).
 */
const ROUTE_CACHE_TTL_MS = 3_000;

const routeCache = new Map<string, { route: CutoverRoute; at: number }>();

/**
 * Drops memoized routes. No argument clears every entry — used by tests and by
 * anything that just changed a repo's cutover state.
 */
export function invalidateSotRouteCache(cwd?: string): void {
	if (cwd === undefined) routeCache.clear();
	else routeCache.delete(cwd);
}

async function cachedRoute(cwd: string): Promise<CutoverRoute> {
	const now = Date.now();
	const hit = routeCache.get(cwd);
	if (hit && now - hit.at < ROUTE_CACHE_TTL_MS) return hit.route;
	const route = await resolveCutoverRoute(cwd);
	routeCache.set(cwd, { route, at: now });
	return route;
}

/** Both callers reject `blocked` first — narrowing here keeps that a type fact. */
type RoutedSot = Exclude<CutoverRoute, { state: "blocked" }>;

/**
 * `cwd` is threaded to the orphan backend EXACTLY as given, including
 * `undefined`, while `target` (the same value defaulted to `process.cwd()`) is
 * what routing and identity resolution use. The two are not interchangeable:
 * `new OrphanBranchStorage(undefined)` lets each git call pick up the process
 * cwd at call time, whereas baking `process.cwd()` in here would freeze it at
 * resolve time — a real difference for anything that chdirs, and an observable
 * change to every `readFileFromBranch(..., cwd)` argument.
 */
async function storageForRoute(cwd: string | undefined, target: string, route: RoutedSot): Promise<StorageProvider> {
	if (route.state === "legacy-fenced" || route.state === "cutover") {
		const { identity } = await resolveRepoIdentityForCwd(target);
		return new SqliteStorage(identity);
	}
	// `route.warning` is deliberately NOT re-logged here. `resolveCutoverRoute`
	// already warns at the point that knows the reason, and duplicating it would
	// fire on the read path — which a `SummaryStore` test pins as silent, because
	// "no database yet" is the ordinary state of every un-cutover repo and a
	// warning on healthy behaviour is the one people learn to scroll past.
	return new OrphanBranchStorage(cwd);
}

/**
 * Returns the backend that holds this repo's truth, throwing when there is
 * none. Use on any path whose job is to move or read authoritative data.
 */
export async function resolveSotStorage(cwd?: string): Promise<StorageProvider> {
	const target = cwd ?? process.cwd();
	const route = await cachedRoute(target);
	if (route.state === "blocked") {
		throw new Error(
			`storage unavailable: ${route.reason} — this repo's orphan branch is frozen (cutover), ` +
				"so the system of record cannot fall back to it; run 'jolli doctor --recover' or upgrade this surface",
		);
	}
	return storageForRoute(cwd, target, route);
}

/**
 * The diagnostic twin: same routing, but `blocked` comes back as data and any
 * unexpected failure degrades to a reason string rather than propagating.
 */
export async function resolveSotBackend(cwd?: string): Promise<SotBackend> {
	const target = cwd ?? process.cwd();
	let route: CutoverRoute;
	try {
		route = await cachedRoute(target);
	} catch (err) {
		return { ok: false, reason: (err as Error).message };
	}
	if (route.state === "blocked") return { ok: false, reason: route.reason };
	try {
		return { ok: true, state: route.state, storage: await storageForRoute(cwd, target, route) };
	} catch (err) {
		return { ok: false, reason: (err as Error).message };
	}
}
