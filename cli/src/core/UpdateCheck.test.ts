/// <reference types="node" />
/**
 * Tests for {@link UpdateCheck} — the outward freshness-detection cache.
 *
 * The cache file (`update-check.json`) and the `npm view` query are both
 * injected so these tests never touch the real `~/.jolli/jollimemory/` dir or
 * spawn npm. The detached refresh spawn and the default `npm view` runner are
 * v8-ignored in the implementation (subprocess side effects), exactly like
 * PluginLoader's `runNpmRootGlobal`.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getGlobalConfigDir` decides the *default* on-disk locations
// (`update-check.json` / `update-check.refresh`). Pin it to a per-test temp dir
// so the no-`file` code paths (`getCacheFile` / `getRefreshSentinelFile`) can be
// exercised without ever touching the real `~/.jolli/jollimemory/`.
let globalConfigDir = "";
vi.mock("./SessionTracker.js", () => ({
	getGlobalConfigDir: () => globalConfigDir,
}));

// `defaultNpmView` (the fallback when no `runNpmView` is injected) delegates to
// `runNpmCommand`. Mock it so the default-runner branch never spawns real npm.
vi.mock("../util/Subprocess.js", () => ({
	runNpmCommand: vi.fn(async () => "9.9.9"),
	spawnHidden: vi.fn(),
}));

// fs/promises is delegated to the real implementation except for `unlink`, which
// a test can force to reject. That covers the two best-effort `.catch(() =>
// undefined)` cleanup callbacks (on `unlink(claim)` and `unlink(tmp)`), whose
// only trigger is the cleanup unlink itself failing — a double-failure path with
// no deterministic on-disk reproduction.
let failUnlink = false;
let failStat = false;
let failRename = false;
vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual<typeof import("node:fs/promises")>();
	return {
		...actual,
		default: actual,
		unlink: (...args: Parameters<typeof actual.unlink>) =>
			failUnlink ? Promise.reject(new Error("forced unlink failure")) : actual.unlink(...args),
		stat: (...args: Parameters<typeof actual.stat>) =>
			failStat ? Promise.reject(new Error("forced stat failure")) : actual.stat(...args),
		rename: (...args: Parameters<typeof actual.rename>) =>
			failRename ? Promise.reject(new Error("forced rename failure")) : actual.rename(...args),
	};
});

import { runNpmCommand } from "../util/Subprocess.js";
import {
	claimRefreshSpawn,
	computeCliUpdateNotice,
	computePluginUpdateNotices,
	isCacheStale,
	isRefreshDebounced,
	REFRESH_DEBOUNCE_MS,
	readUpdateCache,
	refreshUpdateCache,
	type UpdateCache,
} from "./UpdateCheck.js";

const mockRunNpmCommand = vi.mocked(runNpmCommand);

describe("UpdateCheck", () => {
	let tempDir: string;
	let cacheFile: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "update-check-test-"));
		cacheFile = join(tempDir, "update-check.json");
		globalConfigDir = tempDir;
		failUnlink = false;
		failStat = false;
		failRename = false;
		mockRunNpmCommand.mockClear();
		mockRunNpmCommand.mockResolvedValue("9.9.9");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("readUpdateCache", () => {
		it("returns null when the cache file does not exist", async () => {
			expect(await readUpdateCache(cacheFile)).toBeNull();
		});

		it("returns null when the cache file is corrupt", async () => {
			await writeFile(cacheFile, "{ not json", "utf-8");
			expect(await readUpdateCache(cacheFile)).toBeNull();
		});

		it("returns null when the parsed shape is invalid", async () => {
			await writeFile(cacheFile, JSON.stringify({ checkedAt: 123, packages: "nope" }), "utf-8");
			expect(await readUpdateCache(cacheFile)).toBeNull();
		});

		it("returns null when the top-level JSON is not a plain object", async () => {
			// A bare array/number parses fine but is not the cache shape.
			await writeFile(cacheFile, JSON.stringify([1, 2, 3]), "utf-8");
			expect(await readUpdateCache(cacheFile)).toBeNull();
		});

		it("returns null when packages is not a plain object", async () => {
			// Valid checkedAt + ttlHours, but packages is the wrong type — reaches the
			// dedicated packages-container guard rather than bailing earlier.
			await writeFile(
				cacheFile,
				JSON.stringify({ checkedAt: "2026-06-04T09:00:00.000Z", ttlHours: 24, packages: "nope" }),
				"utf-8",
			);
			expect(await readUpdateCache(cacheFile)).toBeNull();
		});

		it("reads from the default cache file when no path is given", async () => {
			// getGlobalConfigDir is mocked to tempDir, so getCacheFile() resolves there.
			const cache: UpdateCache = {
				checkedAt: "2026-06-04T09:00:00.000Z",
				ttlHours: 24,
				packages: { "@jolli.ai/cli": { latest: "1.5.0" } },
			};
			await writeFile(join(tempDir, "update-check.json"), JSON.stringify(cache), "utf-8");
			expect(await readUpdateCache()).toEqual(cache);
		});

		it("returns null when a package entry has a non-string latest", async () => {
			// A hand-edited/half-written `{ latest: 110 }` would make compareSemver
			// throw — treat it as no info (→ refresh) instead.
			await writeFile(
				cacheFile,
				JSON.stringify({
					checkedAt: "2026-06-04T09:00:00.000Z",
					ttlHours: 24,
					packages: { "@jolli.ai/cli": { latest: 110 } },
				}),
				"utf-8",
			);
			expect(await readUpdateCache(cacheFile)).toBeNull();
		});

		it("returns null when ttlHours is not positive", async () => {
			await writeFile(
				cacheFile,
				JSON.stringify({ checkedAt: "2026-06-04T09:00:00.000Z", ttlHours: 0, packages: {} }),
				"utf-8",
			);
			expect(await readUpdateCache(cacheFile)).toBeNull();
		});

		it("parses a well-formed cache", async () => {
			const cache: UpdateCache = {
				checkedAt: "2026-06-04T09:00:00.000Z",
				ttlHours: 24,
				packages: { "@jolli.ai/cli": { latest: "1.1.0" } },
			};
			await writeFile(cacheFile, JSON.stringify(cache), "utf-8");
			expect(await readUpdateCache(cacheFile)).toEqual(cache);
		});
	});

	describe("isCacheStale", () => {
		const fresh: UpdateCache = { checkedAt: "2026-06-04T09:00:00.000Z", ttlHours: 24, packages: {} };

		it("treats a missing cache as stale", () => {
			expect(isCacheStale(null, Date.parse("2026-06-04T09:00:00.000Z"))).toBe(true);
		});

		it("is fresh within the TTL window", () => {
			const now = Date.parse("2026-06-04T20:00:00.000Z"); // 11h later
			expect(isCacheStale(fresh, now)).toBe(false);
		});

		it("is stale once the TTL has elapsed", () => {
			const now = Date.parse("2026-06-05T10:00:00.000Z"); // 25h later
			expect(isCacheStale(fresh, now)).toBe(true);
		});

		it("treats an unparseable checkedAt as stale", () => {
			expect(isCacheStale({ checkedAt: "not-a-date", ttlHours: 24, packages: {} }, Date.now())).toBe(true);
		});
	});

	describe("isRefreshDebounced", () => {
		const last = Date.parse("2026-06-04T09:00:00.000Z");

		it("is not debounced when there was no prior attempt", () => {
			expect(isRefreshDebounced(null, last)).toBe(false);
		});

		it("is debounced within the window", () => {
			expect(isRefreshDebounced(last, last + 30_000, 60_000)).toBe(true);
		});

		it("is not debounced once the window has elapsed", () => {
			expect(isRefreshDebounced(last, last + 60_000, 60_000)).toBe(false);
		});
	});

	describe("claimRefreshSpawn", () => {
		it("claims (returns true) and records the attempt when no sentinel exists", async () => {
			const file = join(tempDir, "refresh-sentinel");
			expect(await claimRefreshSpawn({ file })).toBe(true);
			expect((await readFile(file, "utf-8")).length).toBeGreaterThan(0);
		});

		it("suppresses a second claim within the debounce window", async () => {
			const file = join(tempDir, "refresh-sentinel");
			expect(await claimRefreshSpawn({ file })).toBe(true);
			expect(await claimRefreshSpawn({ file })).toBe(false);
		});

		it("collapses concurrent claims on a missing sentinel to a single winner", async () => {
			// The debounce exists to prevent an npm-view storm when several commands
			// fire at once. A stat()-then-write() check is not atomic across
			// processes: every racer sees "no recent attempt" and every racer claims.
			// An atomic claim must let exactly one of a simultaneous burst through.
			const file = join(tempDir, "refresh-sentinel");
			const results = await Promise.all([
				claimRefreshSpawn({ file }),
				claimRefreshSpawn({ file }),
				claimRefreshSpawn({ file }),
				claimRefreshSpawn({ file }),
			]);
			expect(results.filter(Boolean)).toHaveLength(1);
		});

		it("re-claims once the debounce window has elapsed", async () => {
			const file = join(tempDir, "refresh-sentinel");
			expect(await claimRefreshSpawn({ file })).toBe(true);
			// A `now` far past the window relative to the just-written sentinel mtime.
			expect(await claimRefreshSpawn({ file, now: Date.now() + REFRESH_DEBOUNCE_MS + 10_000 })).toBe(true);
		});

		it("uses the default sentinel path when none is given", async () => {
			// getGlobalConfigDir is mocked to tempDir, so getRefreshSentinelFile()
			// resolves to <tempDir>/update-check.refresh.
			expect(await claimRefreshSpawn()).toBe(true);
			expect((await readFile(join(tempDir, "update-check.refresh"), "utf-8")).length).toBeGreaterThan(0);
		});

		it("takes over a stale sentinel and rewrites the stamp", async () => {
			// First claim writes the sentinel; a far-future `now` makes it stale, so the
			// second claim renames it away, succeeds, rewrites, and unlinks the claim.
			const file = join(tempDir, "refresh-sentinel");
			expect(await claimRefreshSpawn({ file })).toBe(true);
			const future = Date.now() + REFRESH_DEBOUNCE_MS + 10_000;
			expect(await claimRefreshSpawn({ file, now: future })).toBe(true);
			// The rewritten stamp reflects the takeover time, and no `.claim-*` leftover remains.
			expect(await readFile(file, "utf-8")).toBe(new Date(future).toISOString());
		});

		it("still claims when cleaning up the takeover claim file fails", async () => {
			// Same stale-takeover path, but the best-effort `unlink(claim)` rejects.
			// The failure is swallowed (`.catch(() => undefined)`) so the claim still
			// succeeds.
			const file = join(tempDir, "refresh-sentinel");
			expect(await claimRefreshSpawn({ file })).toBe(true);
			failUnlink = true;
			expect(await claimRefreshSpawn({ file, now: Date.now() + REFRESH_DEBOUNCE_MS + 10_000 })).toBe(true);
		});

		it("backs off when the sentinel is removed between the EEXIST and the stat", async () => {
			// Concurrent-removal race: open() sees EEXIST, but stat() then fails because
			// another process deleted the sentinel — back off (return false).
			const file = join(tempDir, "refresh-sentinel");
			expect(await claimRefreshSpawn({ file })).toBe(true);
			failStat = true;
			expect(await claimRefreshSpawn({ file })).toBe(false);
		});

		it("backs off when it loses the stale-sentinel takeover rename", async () => {
			// Stale sentinel, debounce elapsed, but the rename to claim it fails because
			// another process renamed it first — back off (return false).
			const file = join(tempDir, "refresh-sentinel");
			expect(await claimRefreshSpawn({ file })).toBe(true);
			failRename = true;
			expect(await claimRefreshSpawn({ file, now: Date.now() + REFRESH_DEBOUNCE_MS + 10_000 })).toBe(false);
		});

		it("allows the spawn (true) when the sentinel cannot be written", async () => {
			// Parent is a file, so mkdir/writeFile fail — but a broken sentinel must
			// never permanently suppress refreshing.
			const blocker = join(tempDir, "blocker");
			await writeFile(blocker, "x", "utf-8");
			expect(await claimRefreshSpawn({ file: join(blocker, "nested", "sentinel") })).toBe(true);
		});
	});

	describe("refreshUpdateCache", () => {
		it("queries each package and writes a cache file", async () => {
			const now = Date.parse("2026-06-04T09:00:00.000Z");
			const queried: string[] = [];
			const cache = await refreshUpdateCache(["@jolli.ai/cli", "@jolli.ai/site-cli"], {
				file: cacheFile,
				now,
				runNpmView: async (pkg) => {
					queried.push(pkg);
					return pkg === "@jolli.ai/cli" ? "1.2.0" : "0.4.2";
				},
			});

			expect(queried).toEqual(["@jolli.ai/cli", "@jolli.ai/site-cli"]);
			expect(cache.packages).toEqual({
				"@jolli.ai/cli": { latest: "1.2.0" },
				"@jolli.ai/site-cli": { latest: "0.4.2" },
			});
			expect(cache.checkedAt).toBe(new Date(now).toISOString());

			const onDisk = JSON.parse(await readFile(cacheFile, "utf-8"));
			expect(onDisk.packages["@jolli.ai/cli"].latest).toBe("1.2.0");
		});

		it("omits packages whose query returned null", async () => {
			const cache = await refreshUpdateCache(["@jolli.ai/cli", "@jolli.ai/ghost"], {
				file: cacheFile,
				runNpmView: async (pkg) => (pkg === "@jolli.ai/cli" ? "1.0.0" : null),
			});
			expect(cache.packages).toEqual({ "@jolli.ai/cli": { latest: "1.0.0" } });
		});

		it("preserves a previously-cached latest when this round's query fails", async () => {
			const prior: UpdateCache = {
				checkedAt: "2026-06-03T09:00:00.000Z",
				ttlHours: 24,
				packages: { "@jolli.ai/cli": { latest: "1.0.0" }, "@jolli.ai/site-cli": { latest: "0.9.0" } },
			};
			await writeFile(cacheFile, JSON.stringify(prior), "utf-8");

			// cli refreshes to a newer version; site-cli's query fails this round.
			const cache = await refreshUpdateCache(["@jolli.ai/cli", "@jolli.ai/site-cli"], {
				file: cacheFile,
				runNpmView: async (pkg) => (pkg === "@jolli.ai/cli" ? "1.1.0" : null),
			});

			expect(cache.packages).toEqual({
				"@jolli.ai/cli": { latest: "1.1.0" }, // refreshed
				"@jolli.ai/site-cli": { latest: "0.9.0" }, // preserved from the prior cache
			});
		});

		it("tolerates a rejected query without dropping the other packages", async () => {
			// With serial awaits a thrown lookup would reject the whole refresh;
			// allSettled isolates it so the surviving package is still cached.
			const cache = await refreshUpdateCache(["@jolli.ai/cli", "@jolli.ai/site-cli"], {
				file: cacheFile,
				runNpmView: async (pkg) => {
					if (pkg === "@jolli.ai/site-cli") throw new Error("registry timeout");
					return "1.3.0";
				},
			});
			expect(cache.packages).toEqual({ "@jolli.ai/cli": { latest: "1.3.0" } });
		});

		it("does not record an incomplete refresh as fresh for the full TTL", async () => {
			// Fresh install / just-installed plugin: the package has no prior-cached
			// `latest` to fall back on, and its query fails transiently this round.
			// The cli query succeeds. An incomplete refresh must NOT be recorded as
			// fully fresh, or the missing package gets no data and no retry for the
			// full 24h TTL.
			const now = Date.parse("2026-06-04T09:00:00.000Z");
			const cache = await refreshUpdateCache(["@jolli.ai/cli", "@jolli.ai/new-plugin"], {
				file: cacheFile,
				now,
				runNpmView: async (pkg) => (pkg === "@jolli.ai/cli" ? "1.0.0" : null),
			});

			expect(cache.packages["@jolli.ai/new-plugin"]).toBeUndefined();
			// Retried well within the default TTL (here: stale already 2h later).
			expect(isCacheStale(cache, now + 2 * 3_600_000)).toBe(true);

			// And the same must hold for the persisted cache the next process reads.
			const onDisk = await readUpdateCache(cacheFile);
			expect(isCacheStale(onDisk, now + 2 * 3_600_000)).toBe(true);
		});

		it("keeps a complete refresh fresh for the full TTL", async () => {
			// Guard against over-correcting P1: when every requested package resolved,
			// the cache must stay fresh for the normal window (no needless polling).
			const now = Date.parse("2026-06-04T09:00:00.000Z");
			const cache = await refreshUpdateCache(["@jolli.ai/cli"], {
				file: cacheFile,
				now,
				runNpmView: async () => "1.0.0",
			});
			expect(isCacheStale(cache, now + 12 * 3_600_000)).toBe(false);
		});

		it("falls back to the default npm runner and default cache file", async () => {
			// No runNpmView and no file injected: refreshUpdateCache must use
			// defaultNpmView (→ mocked runNpmCommand) and getCacheFile() (→ tempDir).
			const cache = await refreshUpdateCache(["@jolli.ai/cli"]);
			expect(mockRunNpmCommand).toHaveBeenCalledWith(["view", "@jolli.ai/cli", "version"], expect.any(Object));
			expect(cache.packages["@jolli.ai/cli"]).toEqual({ latest: "9.9.9" });
			// Persisted to the default path resolved via getGlobalConfigDir.
			const onDisk = await readUpdateCache();
			expect(onDisk?.packages["@jolli.ai/cli"].latest).toBe("9.9.9");
		});

		it("leaves a package unset when the default npm runner returns null", async () => {
			mockRunNpmCommand.mockResolvedValue(null);
			const cache = await refreshUpdateCache(["@jolli.ai/cli"], { file: cacheFile });
			expect(cache.packages["@jolli.ai/cli"]).toBeUndefined();
		});

		it("tolerates a cache-write failure without throwing", async () => {
			// Point the cache at a path whose parent is a file, so mkdir/writeFile fail.
			const blocker = join(tempDir, "blocker");
			await writeFile(blocker, "x", "utf-8");
			const cache = await refreshUpdateCache(["@jolli.ai/cli"], {
				file: join(blocker, "nested", "update-check.json"),
				runNpmView: async () => "1.0.0",
			});
			// Still returns the computed cache even when persistence fails.
			expect(cache.packages["@jolli.ai/cli"].latest).toBe("1.0.0");
		});

		it("cleans up the temp file when the atomic rename fails", async () => {
			// Make the destination a non-empty directory: mkdir(dirname) and the
			// per-pid temp write both succeed, but rename(tmp, file) fails (can't
			// replace a non-empty dir), exercising the unlink-temp + rethrow branch.
			const { mkdir } = await import("node:fs/promises");
			const target = join(tempDir, "as-dir");
			await mkdir(target, { recursive: true });
			await writeFile(join(target, "child"), "x", "utf-8");

			const cache = await refreshUpdateCache(["@jolli.ai/cli"], {
				file: target,
				runNpmView: async () => "1.0.0",
			});
			// Returns the computed cache; the rename failure is swallowed and the temp
			// file is cleaned up (no `.tmp-*` leftover beside the directory).
			expect(cache.packages["@jolli.ai/cli"].latest).toBe("1.0.0");
			const { readdir } = await import("node:fs/promises");
			const leftovers = (await readdir(tempDir)).filter((n) => n.includes(".tmp-"));
			expect(leftovers).toEqual([]);
		});

		it("swallows a failed temp-file cleanup when the rename fails", async () => {
			// Rename fails (destination is a non-empty dir) AND the best-effort
			// unlink(tmp) cleanup also rejects: both failures are swallowed, the outer
			// catch logs, and the computed cache is still returned.
			const { mkdir } = await import("node:fs/promises");
			const target = join(tempDir, "as-dir-2");
			await mkdir(target, { recursive: true });
			await writeFile(join(target, "child"), "x", "utf-8");

			failUnlink = true;
			const cache = await refreshUpdateCache(["@jolli.ai/cli"], {
				file: target,
				runNpmView: async () => "1.0.0",
			});
			expect(cache.packages["@jolli.ai/cli"].latest).toBe("1.0.0");
		});
	});

	describe("computeCliUpdateNotice", () => {
		it("returns null when the CLI already matches the registry latest", () => {
			expect(computeCliUpdateNotice({ currentVersion: "1.1.0", registryLatest: "1.1.0" })).toBeNull();
		});

		it("flags a newer registry version", () => {
			const notice = computeCliUpdateNotice({ currentVersion: "1.0.0", registryLatest: "1.2.0" });
			expect(notice).toContain("1.2.0");
			expect(notice).toContain("1.0.0");
			expect(notice).toContain("npm update -g @jolli.ai/cli");
		});

		it("returns null when the registry latest is older than the running version", () => {
			expect(computeCliUpdateNotice({ currentVersion: "2.0.0", registryLatest: "1.9.0" })).toBeNull();
		});

		it("returns null when no registry data is known (dist-path surfaces are ignored)", () => {
			expect(computeCliUpdateNotice({ currentVersion: "1.0.0" })).toBeNull();
		});
	});

	describe("computePluginUpdateNotices", () => {
		const cache: UpdateCache = {
			checkedAt: "2026-06-04T09:00:00.000Z",
			ttlHours: 24,
			packages: { "@jolli.ai/site-cli": { latest: "0.5.0" }, "@jolli.ai/space-cli": { latest: "0.2.0" } },
		};

		it("flags a plugin whose installed version trails the registry latest", () => {
			const notices = computePluginUpdateNotices(
				[
					{
						packageName: "@jolli.ai/site-cli",
						installedVersion: "0.4.0",
						installHint: "npm install -g @jolli.ai/site-cli",
					},
				],
				cache,
			);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("@jolli.ai/site-cli");
			expect(notices[0]).toContain("0.5.0");
			expect(notices[0]).toContain("npm install -g @jolli.ai/site-cli");
		});

		it("ignores a plugin that is already current", () => {
			const notices = computePluginUpdateNotices(
				[{ packageName: "@jolli.ai/space-cli", installedVersion: "0.2.0", installHint: "x" }],
				cache,
			);
			expect(notices).toEqual([]);
		});

		it("ignores plugins absent from the cache or without an installed version", () => {
			const notices = computePluginUpdateNotices(
				[
					{ packageName: "@jolli.ai/unknown", installedVersion: "0.1.0", installHint: "x" },
					{ packageName: "@jolli.ai/site-cli", installHint: "x" },
				],
				cache,
			);
			expect(notices).toEqual([]);
		});

		it("returns nothing when there is no cache", () => {
			expect(
				computePluginUpdateNotices(
					[{ packageName: "@jolli.ai/site-cli", installedVersion: "0.1.0", installHint: "x" }],
					null,
				),
			).toEqual([]);
		});
	});
});
