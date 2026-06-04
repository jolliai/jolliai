/**
 * UpdateCheck — outward freshness detection for the host CLI and its plugins.
 *
 * The dist-path registry ({@link ../install/DistPathResolver}) only answers
 * "which locally-installed surface is newest" — it never consults npm. This
 * module fills that gap: it caches the `latest` published version of the CLI
 * and each installed plugin in `~/.jolli/jollimemory/update-check.json` and
 * surfaces an upgrade hint when the running version trails it.
 *
 * Design (see "111. DESIGN — Version Detection & Upgrade Management"):
 *   - **Foreground reads the cache only** — never blocks, never hits the network.
 *   - When the cache is older than its TTL, the foreground spawns a *detached*
 *     refresh process (a re-invocation of the CLI with the hidden
 *     `{@link REFRESH_COMMAND}` subcommand) and returns immediately. This mirrors
 *     the post-commit → QueueWorker spawn pattern.
 *   - The cache stores only the registry `latest`. The locally-installed version
 *     is always read live (CLI = `VERSION`, plugin = its `package.json`) so the
 *     cache can never drift from what is actually installed.
 *   - Every failure (missing/corrupt cache, npm query failure, write failure)
 *     degrades silently — the version check must never block CLI execution.
 *
 * VSCode does not use this module: the extension is upgraded by the Marketplace.
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareSemver } from "../install/DistPathResolver.js";
import { createLogger } from "../Logger.js";
import { runNpmCommand, spawnHidden } from "../util/Subprocess.js";
import { getGlobalConfigDir } from "./SessionTracker.js";

const log = createLogger("UpdateCheck");

/** npm package name of the host CLI — the always-tracked package. */
export const CLI_PACKAGE_NAME = "@jolli.ai/cli";

/** Hidden subcommand the detached refresh process is invoked with. */
export const REFRESH_COMMAND = "__refresh-update-cache";

/** Default freshness window. A day is long enough to never feel like polling. */
export const DEFAULT_TTL_HOURS = 24;

/**
 * Freshness window applied when a refresh is *incomplete* — i.e. at least one
 * requested package ended with no `latest` at all (a transient `npm view`
 * failure on a fresh install or a just-installed plugin that has no prior-cached
 * value to fall back on). Such a cache is recorded with this shortened TTL
 * instead of {@link DEFAULT_TTL_HOURS} so the next command retries soon rather
 * than being suppressed for a full day. A permanently-unresolvable package
 * (renamed / unpublished) therefore costs at most one background refresh per
 * this window, not one per command.
 */
export const RETRY_TTL_HOURS = 1;

/** Hard timeout for a single `npm view` query, so a broken registry never hangs the refresh. */
const NPM_VIEW_TIMEOUT_MS = 10_000;

/**
 * Debounce window for spawning the detached refresh. The cache's `checkedAt`
 * only advances when a refresh *finishes*, so several commands run back-to-back
 * just after the TTL expires would each see a stale cache and each spawn their
 * own `npm view` process before the first one lands. A short-lived attempt
 * marker (see {@link claimRefreshSpawn}) collapses that burst to one spawn,
 * generously longer than {@link NPM_VIEW_TIMEOUT_MS} so an in-flight refresh is
 * given time to complete and rewrite the cache.
 */
export const REFRESH_DEBOUNCE_MS = 60_000;

/**
 * On-disk shape of `update-check.json`. Only the registry `latest` per package
 * is cached; installed versions are read live by callers.
 */
export interface UpdateCache {
	/** ISO timestamp of the last successful refresh. */
	checkedAt: string;
	/** Freshness window in hours; a refresh is triggered once the cache exceeds it. */
	ttlHours: number;
	/** Registry `latest` keyed by npm package name. */
	packages: Record<string, { latest: string }>;
}

/** Queries the registry `latest` for one package. Returns null on any failure. */
export type NpmViewFn = (packageName: string) => Promise<string | null>;

/** Default cache file location: `~/.jolli/jollimemory/update-check.json`. */
function getCacheFile(): string {
	return join(getGlobalConfigDir(), "update-check.json");
}

/** True when `value` is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and validate the cache. Returns null when the file is absent, unreadable,
 * unparseable, or structurally invalid — callers treat null as "no info" and
 * fall back to local-only comparison.
 */
export async function readUpdateCache(file?: string): Promise<UpdateCache | null> {
	try {
		const raw = await readFile(file ?? getCacheFile(), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) return null;
		if (typeof parsed.checkedAt !== "string") return null;
		// `> 0` also rejects 0 / negative / NaN — a non-positive TTL would make
		// every read look stale and trigger a refresh on (almost) every command.
		if (typeof parsed.ttlHours !== "number" || !(parsed.ttlHours > 0)) return null;
		if (!isPlainObject(parsed.packages)) return null;
		// Validate the leaf shape too, not just the container: `compareSemver`
		// (the sole consumer of `latest`) calls `.includes("-")`, which throws a
		// TypeError on a non-string `latest`. A hand-edited or half-written entry
		// like `{ latest: 110 }` must be treated as "no info" (→ refresh) rather
		// than crashing any caller that isn't wrapped in a try/catch.
		for (const entry of Object.values(parsed.packages)) {
			if (!isPlainObject(entry) || typeof entry.latest !== "string") return null;
		}
		return parsed as unknown as UpdateCache;
	} catch {
		return null;
	}
}

/**
 * True when the cache is missing, has an unparseable `checkedAt`, or is older
 * than its own `ttlHours` relative to `now` (ms epoch).
 */
export function isCacheStale(cache: UpdateCache | null, now: number): boolean {
	if (!cache) return true;
	const checkedAt = Date.parse(cache.checkedAt);
	if (Number.isNaN(checkedAt)) return true;
	const ageHours = (now - checkedAt) / 3_600_000;
	return ageHours >= cache.ttlHours;
}

/** Marker file recording the last detached-refresh spawn attempt. */
function getRefreshSentinelFile(): string {
	return join(getGlobalConfigDir(), "update-check.refresh");
}

/**
 * Pure: true when a refresh was attempted within the debounce window and a new
 * spawn should be suppressed. A null `lastAttemptMs` (no prior attempt) is never
 * debounced.
 */
export function isRefreshDebounced(lastAttemptMs: number | null, now: number, windowMs = REFRESH_DEBOUNCE_MS): boolean {
	return lastAttemptMs !== null && now - lastAttemptMs < windowMs;
}

/**
 * Claim the right to spawn a detached refresh. Returns false (suppress the
 * spawn) when a prior attempt is still within {@link REFRESH_DEBOUNCE_MS};
 * otherwise records this attempt via the sentinel mtime and returns true.
 *
 * Collapses a burst of near-simultaneous invocations to a single refresh
 * (see {@link REFRESH_DEBOUNCE_MS}). The claim is made *atomically* so that the
 * collapse actually holds across concurrent processes — a plain `stat`-then-
 * `writeFile` is not atomic, and every racer that read "no recent attempt"
 * would each write and each return true, defeating the debounce:
 *
 *   - **Absent sentinel** (the common burst) — an `O_EXCL` create lets exactly
 *     one of N simultaneous callers win; the rest get `EEXIST` and fall through
 *     to the freshness check, where the just-written sentinel reads as recent.
 *   - **Stale sentinel** — taken over via `rename`, which removes the source, so
 *     exactly one stale racer succeeds and the rest get `ENOENT`. A racer that
 *     re-creates in the sub-millisecond gap between the rename and the rewrite
 *     could double-claim; that residual race is accepted — the only cost is one
 *     extra detached `npm view`, and the burst is still collapsed from N to ~1.
 *
 * Best-effort: a non-`EEXIST` I/O failure (read-only / broken dir) resolves to
 * `true` so a sentinel that can never be written can never permanently suppress
 * refreshing.
 */
export async function claimRefreshSpawn(opts?: { file?: string; now?: number; windowMs?: number }): Promise<boolean> {
	const file = opts?.file ?? getRefreshSentinelFile();
	const now = opts?.now ?? Date.now();
	const stamp = new Date(now).toISOString();

	// Atomic claim for the absent-sentinel burst: only one O_EXCL create wins.
	try {
		await mkdir(dirname(file), { recursive: true });
		const handle = await open(file, "wx");
		try {
			await handle.writeFile(stamp, "utf-8");
		} finally {
			await handle.close();
		}
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
			// Could not create the sentinel for a reason other than "already there"
			// (read-only / broken dir). Allow this spawn rather than risk
			// suppressing refreshes forever on a sentinel we can never write.
			return true;
		}
	}

	// Sentinel already exists — back off if a recent attempt is still recorded.
	let lastAttemptMs: number;
	try {
		lastAttemptMs = (await stat(file)).mtimeMs;
	} catch {
		/* v8 ignore next 2 -- sentinel removed concurrently between the EEXIST and the stat; another process is actively managing it, so back off */
		return false;
	}
	if (isRefreshDebounced(lastAttemptMs, now, opts?.windowMs)) return false;

	// Stale sentinel: take it over atomically. Only one rename of the source can
	// succeed; the losers see ENOENT and back off.
	const claim = `${file}.claim-${process.pid}-${now}`;
	try {
		await rename(file, claim);
	} catch {
		/* v8 ignore next -- lost the takeover race (another process renamed the stale sentinel first); back off */
		return false;
	}
	try {
		await writeFile(file, stamp, "utf-8");
	} catch {
		/* v8 ignore next 2 -- won the claim but could not rewrite the stamp; still proceed with the spawn */
	}
	await unlink(claim).catch(() => undefined);
	return true;
}

/**
 * Query the registry `latest` for each package and write a fresh cache file.
 * The new cache is seeded from the existing one, so a package whose query fails
 * this round keeps its previously-cached `latest` instead of being evicted — a
 * transient registry failure must not silently suppress a known update notice.
 * Returns the computed cache even when the write fails, so the detached process
 * can still log what it found.
 */
export async function refreshUpdateCache(
	packageNames: ReadonlyArray<string>,
	opts?: { file?: string; runNpmView?: NpmViewFn; now?: number; ttlHours?: number },
): Promise<UpdateCache> {
	const runNpmView = opts?.runNpmView ?? defaultNpmView;
	const file = opts?.file ?? getCacheFile();

	// Seed from the prior cache so a failed query (null) preserves that package's
	// last-known `latest` rather than dropping it on a wholesale overwrite.
	const existing = await readUpdateCache(file);
	const packages: Record<string, { latest: string }> = { ...(existing?.packages ?? {}) };
	// Query every package concurrently — each lookup is independent and capped by
	// its own NPM_VIEW_TIMEOUT_MS, so serial `await`s would stack those timeouts
	// (3 packages × 10s could approach the refresh debounce window). `allSettled`
	// keeps a single rejected/failed lookup from discarding the rest; a null or
	// rejected result simply leaves that package's prior-cached `latest` in place.
	const results = await Promise.allSettled(packageNames.map((name) => runNpmView(name)));
	results.forEach((result, i) => {
		const latest = result.status === "fulfilled" ? result.value : null;
		if (latest) packages[packageNames[i]] = { latest };
	});

	// A refresh is "complete" only when every *requested* package now resolves to
	// a `latest` (freshly fetched this round or preserved from the prior cache).
	// An incomplete refresh must not be recorded as fresh for the full TTL, or a
	// package left with no data at all (fresh install / just-added plugin whose
	// query failed) gets no update info and no retry until the window elapses.
	// `Math.min` keeps the retry window from ever exceeding the configured TTL.
	const fullTtl = opts?.ttlHours ?? DEFAULT_TTL_HOURS;
	const complete = packageNames.every((name) => packages[name] !== undefined);
	const cache: UpdateCache = {
		checkedAt: new Date(opts?.now ?? Date.now()).toISOString(),
		ttlHours: complete ? fullTtl : Math.min(RETRY_TTL_HOURS, fullTtl),
		packages,
	};

	try {
		await mkdir(dirname(file), { recursive: true });
		// Atomic write: a concurrent detached refresh (no cross-process lock here)
		// could otherwise interleave two `writeFile`s into the same path and leave
		// a corrupt half-written JSON that the next `readUpdateCache` rejects. A
		// per-pid temp file plus `rename` makes the swap atomic on POSIX; on a
		// rename failure we best-effort unlink the temp so it can't accumulate.
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(tmp, JSON.stringify(cache, null, 2), "utf-8");
		try {
			await rename(tmp, file);
		} catch (err) {
			await unlink(tmp).catch(() => undefined);
			throw err;
		}
	} catch (err) {
		log.debug("failed to write update-check cache: %s", (err as Error).message);
	}
	return cache;
}

/**
 * Decide the host-CLI upgrade notice. Pure: compares the running version against
 * the npm registry `latest` cached in `update-check.json`. Returns the one-line
 * notice, or null when nothing newer is known.
 *
 * Deliberately ignores local `dist-paths/<surface>` versions. The CLI and the
 * IDE extensions are independent release lines, and a surface's dist-path version
 * is that surface's *own* release number — not a comparable `@jolli.ai/cli`
 * version. Feeding it in produced a phantom notice that reported, say, the VSCode
 * extension's version as a "newer @jolli.ai/cli". The npm registry is the only
 * authoritative source for whether a newer `@jolli.ai/cli` has been published.
 */
export function computeCliUpdateNotice(args: { currentVersion: string; registryLatest?: string }): string | null {
	const latest = args.registryLatest;
	if (!latest || compareSemver(latest, args.currentVersion) <= 0) return null;
	return `A newer version of ${CLI_PACKAGE_NAME} is available (${latest} → you have ${args.currentVersion}). Upgrade: npm update -g ${CLI_PACKAGE_NAME}`;
}

/**
 * Decide per-plugin upgrade notices. Pure: for each installed plugin with a
 * known installed version, compare against the cached registry latest and emit
 * a notice when it trails. Plugins absent from the cache, missing an installed
 * version, or already current produce nothing.
 */
export function computePluginUpdateNotices(
	plugins: ReadonlyArray<{ packageName: string; installedVersion?: string; installHint: string }>,
	cache: UpdateCache | null,
): string[] {
	if (!cache) return [];
	const notices: string[] = [];
	for (const p of plugins) {
		const latest = cache.packages[p.packageName]?.latest;
		if (!latest || !p.installedVersion) continue;
		if (compareSemver(latest, p.installedVersion) > 0) {
			notices.push(
				`A newer version of ${p.packageName} is available (${latest} → you have ${p.installedVersion}). Upgrade: ${p.installHint}`,
			);
		}
	}
	return notices;
}

/**
 * Spawn the detached refresh process: re-invokes this CLI with the hidden
 * {@link REFRESH_COMMAND} and the package list, then unrefs so the foreground
 * exits immediately. Best-effort — a spawn failure is swallowed.
 *
 * Coverage-ignored: the only effect is launching a child process, which can't
 * be unit-tested deterministically without a fake node on PATH. Same rationale
 * as PluginLoader's `runNpmRootGlobal` / QueueWorker's `launchWorker`. The work
 * it performs ({@link refreshUpdateCache}) is tested directly.
 */
/* v8 ignore start */
export function spawnDetachedRefresh(packageNames: ReadonlyArray<string>, cliEntry?: string): void {
	try {
		const entry = cliEntry ?? process.argv[1];
		if (!entry) return;
		const child = spawnHidden(process.execPath, [entry, REFRESH_COMMAND, ...packageNames], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		log.info("Spawned detached update-check refresh (PID: %d)", child.pid ?? -1);
	} catch (err) {
		log.debug("failed to spawn update-check refresh: %s", (err as Error).message);
	}
}

/**
 * Default `npm view <pkg> version` runner. Returns null on any failure.
 * Delegates to {@link runNpmCommand} so the cross-platform (win32 shell) npm
 * invocation lives in one place.
 */
async function defaultNpmView(packageName: string): Promise<string | null> {
	return runNpmCommand(["view", packageName, "version"], { timeout: NPM_VIEW_TIMEOUT_MS });
}
/* v8 ignore stop */
