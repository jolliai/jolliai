import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CutoverRoute } from "../dashboard/CutoverRouter.js";
import { DualWriteStorage } from "./DualWriteStorage.js";
import type { StorageProvider } from "./StorageProvider.js";

// getActiveStorage / setActiveStorage are backed by a closure var so a heal that
// swaps the override is observable across calls, exactly as the process global is.
const { store } = vi.hoisted(() => ({ store: { current: undefined as StorageProvider | undefined } }));
vi.mock("./SummaryStore.js", () => ({
	getActiveStorage: () => store.current,
	setActiveStorage: (s: StorageProvider | undefined) => {
		store.current = s;
	},
}));

const { createStorageMock } = vi.hoisted(() => ({ createStorageMock: vi.fn() }));
vi.mock("./StorageFactory.js", () => ({ createStorage: createStorageMock }));

const { resolveRouteMock } = vi.hoisted(() => ({ resolveRouteMock: vi.fn() }));
// Keep the REAL `routeMovesOffOrphanBranch` (a pure classifier the heal shares
// with the VS Code bridge) so these cases exercise the shipped predicate, and
// stub only the DB-touching `resolveCutoverRoute`.
vi.mock("../dashboard/CutoverRouter.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../dashboard/CutoverRouter.js")>()),
	resolveCutoverRoute: resolveRouteMock,
}));

import {
	clearActiveStorageHealThrottle,
	ensureActiveStorageMatchesRoute,
	ROUTE_PROBE_THROTTLE_MS,
	resetActiveStorageHealThrottle,
} from "./ActiveStorageHeal.js";

/** A storage that reads off the orphan branch — the pre-cutover shape. */
const orphan = { kind: "orphan-branch" } as unknown as StorageProvider;
const orphanPrimary = { kind: "orphan-branch" } as unknown as StorageProvider;
const sqlitePrimary = { kind: "sqlite" } as unknown as StorageProvider;
const folderShadow = { kind: "folder" } as unknown as StorageProvider;
// REAL DualWriteStorage instances, not `{kind:"dual-write"}` literals: the heal
// now unwraps the primary through `instanceof DualWriteStorage`, so a structural
// double would fail the check and silently make the default (dual-write) storage
// mode un-healable — the exact regression this shape guards against.
/** A pre-cutover dual-write: reads come from its orphan primary. */
const dualOrphan = new DualWriteStorage(orphanPrimary, folderShadow);
/** What createStorage returns post-cutover: dual-write over a SQLite primary. */
const dualSqlite = new DualWriteStorage(sqlitePrimary, folderShadow);

function route(state: CutoverRoute["state"]): CutoverRoute {
	if (state === "cutover") {
		return { state, record: { tips: {}, cutoverVersion: 1, committedAt: "", schemaVersion: 1 } };
	}
	if (state === "blocked") return { state, reason: "db down" };
	return { state } as CutoverRoute;
}

beforeEach(() => {
	store.current = undefined;
	resetActiveStorageHealThrottle();
	createStorageMock.mockReset().mockResolvedValue(dualSqlite);
	resolveRouteMock.mockReset().mockResolvedValue(route("uncutover"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ensureActiveStorageMatchesRoute", () => {
	it("does nothing when there is no active storage", async () => {
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).not.toHaveBeenCalled();
		expect(createStorageMock).not.toHaveBeenCalled();
	});

	it("fast-paths without a route lookup when the active storage already reads SQLite", async () => {
		store.current = dualSqlite;
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).not.toHaveBeenCalled();
		expect(store.current).toBe(dualSqlite);
	});

	it("fast-paths for a bare SQLite storage (a non-claimable cut-over project)", async () => {
		store.current = { kind: "sqlite" } as unknown as StorageProvider;
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).not.toHaveBeenCalled();
	});

	it("leaves an orphan-backed storage alone while the repo is uncutover", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).toHaveBeenCalledWith("/repo");
		expect(createStorageMock).not.toHaveBeenCalled();
		expect(store.current).toBe(orphan);
	});

	it("leaves an orphan-backed storage alone when the DB is blocked (readable-but-stale beats a hard throw)", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("blocked"));
		await ensureActiveStorageMatchesRoute("/repo");
		expect(createStorageMock).not.toHaveBeenCalled();
		expect(store.current).toBe(orphan);
	});

	it("rebuilds the storage once the repo is cut over", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("cutover"));
		await ensureActiveStorageMatchesRoute("/repo");
		expect(createStorageMock).toHaveBeenCalledWith("/repo", "/repo");
		expect(store.current).toBe(dualSqlite);
	});

	it("rebuilds the storage while the repo is fenced but not yet committed", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("legacy-fenced"));
		await ensureActiveStorageMatchesRoute("/repo");
		expect(createStorageMock).toHaveBeenCalledTimes(1);
		expect(store.current).toBe(dualSqlite);
	});

	it("rebuilds a pre-cutover dual-write object (orphan primary)", async () => {
		store.current = dualOrphan;
		resolveRouteMock.mockResolvedValue(route("cutover"));
		await ensureActiveStorageMatchesRoute("/repo");
		expect(createStorageMock).toHaveBeenCalledTimes(1);
		expect(store.current).toBe(dualSqlite);
	});

	it("stops checking on later calls once rebuilt (cutover is one-way)", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("cutover"));
		await ensureActiveStorageMatchesRoute("/repo");
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).toHaveBeenCalledTimes(1);
		expect(createStorageMock).toHaveBeenCalledTimes(1);
	});

	it("yields to a heal that swapped the storage while the route was being probed", async () => {
		store.current = orphan;
		resolveRouteMock.mockImplementation(async () => {
			// Something else installed the post-cutover storage while we probed.
			store.current = dualSqlite;
			return route("cutover");
		});
		await ensureActiveStorageMatchesRoute("/repo");
		expect(createStorageMock).not.toHaveBeenCalled();
		expect(store.current).toBe(dualSqlite);
	});

	it("swallows a route-resolution failure and leaves the storage as-is", async () => {
		store.current = orphan;
		resolveRouteMock.mockRejectedValue(new Error("boom"));
		await ensureActiveStorageMatchesRoute("/repo");
		expect(createStorageMock).not.toHaveBeenCalled();
		expect(store.current).toBe(orphan);
	});

	it("coalesces concurrent heals into a single rebuild", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("cutover"));
		await Promise.all([ensureActiveStorageMatchesRoute("/repo"), ensureActiveStorageMatchesRoute("/repo")]);
		expect(createStorageMock).toHaveBeenCalledTimes(1);
		expect(store.current).toBe(dualSqlite);
	});

	it("throttles the route probe for a still-uncutover repo within the window", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await ensureActiveStorageMatchesRoute("/repo");
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).toHaveBeenCalledTimes(1);
		expect(store.current).toBe(orphan);
	});

	it("re-probes the route once the throttle window has elapsed", async () => {
		vi.useFakeTimers();
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await ensureActiveStorageMatchesRoute("/repo");
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(ROUTE_PROBE_THROTTLE_MS + 1);
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).toHaveBeenCalledTimes(2);
	});

	it("throttles the next probe after a probe failure too", async () => {
		store.current = orphan;
		resolveRouteMock.mockRejectedValue(new Error("boom"));
		await ensureActiveStorageMatchesRoute("/repo");
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).toHaveBeenCalledTimes(1);
		expect(store.current).toBe(orphan);
	});

	it("does not throw and leaves the storage as-is when createStorage fails after a cutover", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("cutover"));
		createStorageMock.mockRejectedValue(new Error("sqlite locked"));
		await expect(ensureActiveStorageMatchesRoute("/repo")).resolves.toBeUndefined();
		expect(store.current).toBe(orphan);
	});

	it("retries the rebuild on a later call after a transient createStorage failure", async () => {
		vi.useFakeTimers();
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("cutover"));
		createStorageMock.mockRejectedValueOnce(new Error("sqlite locked")).mockResolvedValue(dualSqlite);
		await ensureActiveStorageMatchesRoute("/repo");
		expect(store.current).toBe(orphan);
		vi.advanceTimersByTime(ROUTE_PROBE_THROTTLE_MS + 1);
		await ensureActiveStorageMatchesRoute("/repo");
		expect(store.current).toBe(dualSqlite);
	});

	it("clearActiveStorageHealThrottle forces an immediate re-probe inside the window", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await ensureActiveStorageMatchesRoute("/repo");
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).toHaveBeenCalledTimes(1); // throttled

		// A frozen-error caller clears the back-off so the next call re-probes without
		// waiting out the window; now the route reads cut over and the storage rebuilds.
		clearActiveStorageHealThrottle("/repo");
		resolveRouteMock.mockResolvedValue(route("cutover"));
		await ensureActiveStorageMatchesRoute("/repo");
		expect(resolveRouteMock).toHaveBeenCalledTimes(2);
		expect(store.current).toBe(dualSqlite);
	});

	it("clearActiveStorageHealThrottle is scoped to one cwd", async () => {
		store.current = orphan;
		resolveRouteMock.mockResolvedValue(route("uncutover"));
		await ensureActiveStorageMatchesRoute("/repo-a");
		await ensureActiveStorageMatchesRoute("/repo-b");
		expect(resolveRouteMock).toHaveBeenCalledTimes(2);

		clearActiveStorageHealThrottle("/repo-a");
		await ensureActiveStorageMatchesRoute("/repo-a"); // re-probes
		await ensureActiveStorageMatchesRoute("/repo-b"); // still throttled
		expect(resolveRouteMock).toHaveBeenCalledTimes(3);
	});
});
