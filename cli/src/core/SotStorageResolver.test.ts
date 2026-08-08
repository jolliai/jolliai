import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../dashboard/CutoverRouter.js", () => ({
	resolveCutoverRoute: vi.fn().mockResolvedValue({ state: "uncutover" }),
}));

vi.mock("../dashboard/RepoRegistry.js", () => ({
	resolveRepoIdentityForCwd: vi.fn().mockResolvedValue({ identity: "https://github.com/test/repo.git" }),
}));

vi.mock("./SqliteStorage.js", () => {
	const SqliteStorage = vi.fn();
	SqliteStorage.prototype.type = "sqlite";
	return { SqliteStorage };
});

vi.mock("./OrphanBranchStorage.js", () => {
	const OrphanBranchStorage = vi.fn();
	OrphanBranchStorage.prototype.type = "orphan";
	return { OrphanBranchStorage };
});

import { resolveCutoverRoute } from "../dashboard/CutoverRouter.js";
import { resolveRepoIdentityForCwd } from "../dashboard/RepoRegistry.js";
import { OrphanBranchStorage } from "./OrphanBranchStorage.js";
import { invalidateSotRouteCache, resolveSotBackend, resolveSotStorage } from "./SotStorageResolver.js";
import { SqliteStorage } from "./SqliteStorage.js";

const CUTOVER_ROUTE = {
	state: "cutover" as const,
	record: { tips: {}, cutoverVersion: 1, committedAt: "t", schemaVersion: 1 },
};

/** Distinct cwd per case so one test's memo cannot serve the next. */
let counter = 0;
const freshCwd = (): string => `/project/path-${++counter}`;

beforeEach(() => {
	vi.clearAllMocks();
	invalidateSotRouteCache();
	vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "uncutover" });
	vi.mocked(resolveRepoIdentityForCwd).mockResolvedValue({ identity: "https://github.com/test/repo.git" });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("resolveSotStorage", () => {
	it("un-cutover resolves to the orphan branch — it is still the truth there", async () => {
		const storage = await resolveSotStorage(freshCwd());
		expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
		expect(SqliteStorage).not.toHaveBeenCalled();
	});

	it("returns a live backend instance, not a spread copy", async () => {
		// A `{...instance}` would drop the prototype and every method with it,
		// which typechecks fine and fails at the first readFile.
		const storage = await resolveSotStorage(freshCwd());
		expect(storage).toBeInstanceOf(OrphanBranchStorage);
	});

	for (const route of [{ state: "legacy-fenced" as const }, CUTOVER_ROUTE]) {
		it(`${route.state} resolves to SQLite keyed by the repo identity`, async () => {
			vi.mocked(resolveCutoverRoute).mockResolvedValue(route);
			const storage = await resolveSotStorage(freshCwd());
			expect((storage as unknown as Record<string, unknown>).type).toBe("sqlite");
			expect(SqliteStorage).toHaveBeenCalledWith("https://github.com/test/repo.git");
			expect(OrphanBranchStorage).not.toHaveBeenCalled();
		});
	}

	it("blocked throws rather than degrading to the frozen branch", async () => {
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "blocked", reason: "schema v9 is newer" });
		await expect(resolveSotStorage(freshCwd())).rejects.toThrow(/schema v9 is newer/);
		expect(OrphanBranchStorage).not.toHaveBeenCalled();
	});
});

describe("resolveSotBackend", () => {
	it("reports the state alongside the storage", async () => {
		vi.mocked(resolveCutoverRoute).mockResolvedValue(CUTOVER_ROUTE);
		const backend = await resolveSotBackend(freshCwd());
		expect(backend.ok).toBe(true);
		if (backend.ok) expect(backend.state).toBe("cutover");
	});

	it("keeps blocked as data so diagnostics can print it", async () => {
		vi.mocked(resolveCutoverRoute).mockResolvedValue({ state: "blocked", reason: "database file missing" });
		const backend = await resolveSotBackend(freshCwd());
		expect(backend).toEqual({ ok: false, reason: "database file missing" });
	});

	it("degrades an unexpected routing failure to a reason instead of throwing", async () => {
		vi.mocked(resolveCutoverRoute).mockRejectedValue(new Error("profile lock timeout"));
		await expect(resolveSotBackend(freshCwd())).resolves.toEqual({ ok: false, reason: "profile lock timeout" });
	});

	it("degrades a failure to build the backend too", async () => {
		vi.mocked(resolveCutoverRoute).mockResolvedValue(CUTOVER_ROUTE);
		vi.mocked(resolveRepoIdentityForCwd).mockRejectedValue(new Error("not a git worktree"));
		await expect(resolveSotBackend(freshCwd())).resolves.toEqual({ ok: false, reason: "not a git worktree" });
	});
});

describe("route cache", () => {
	it("resolves the route once for repeated calls on the same cwd", async () => {
		const cwd = freshCwd();
		await resolveSotStorage(cwd);
		await resolveSotStorage(cwd);
		await resolveSotBackend(cwd);
		expect(resolveCutoverRoute).toHaveBeenCalledTimes(1);
	});

	it("keys by cwd, so a second repo is resolved on its own", async () => {
		await resolveSotStorage(freshCwd());
		await resolveSotStorage(freshCwd());
		expect(resolveCutoverRoute).toHaveBeenCalledTimes(2);
	});

	it("re-resolves once the TTL lapses — a long-lived host must see a cutover", async () => {
		vi.useFakeTimers();
		const cwd = freshCwd();
		await resolveSotStorage(cwd);
		vi.advanceTimersByTime(3_001);
		vi.mocked(resolveCutoverRoute).mockResolvedValue(CUTOVER_ROUTE);
		const after = await resolveSotStorage(cwd);
		expect(resolveCutoverRoute).toHaveBeenCalledTimes(2);
		expect((after as unknown as Record<string, unknown>).type).toBe("sqlite");
	});

	it("invalidating one cwd leaves the others memoized", async () => {
		const kept = freshCwd();
		const dropped = freshCwd();
		await resolveSotStorage(kept);
		await resolveSotStorage(dropped);
		invalidateSotRouteCache(dropped);
		await resolveSotStorage(kept);
		await resolveSotStorage(dropped);
		expect(resolveCutoverRoute).toHaveBeenCalledTimes(3);
	});

	it("stays on orphan when an un-cutover repo's database is unreadable", async () => {
		vi.mocked(resolveCutoverRoute).mockResolvedValue({
			state: "uncutover",
			warning: "database file does not exist",
		});
		const storage = await resolveSotStorage(freshCwd());
		expect((storage as unknown as Record<string, unknown>).type).toBe("orphan");
	});
});
