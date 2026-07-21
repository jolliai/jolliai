/**
 * SpaceBindingCache — persisted snapshot of the repo→Space binding.
 *
 * File shape (`<main-worktree-root>/.jolli/jollimemory/space-binding.json`):
 *
 *   {
 *     "version": 1,
 *     "repoUrl": "https://github.com/acme/widgets",
 *     "origin": "https://acme.jolli.ai",
 *     "jmSpaceId": 7,
 *     "spaceName": "Acme Core",
 *     "canPush": true | null,
 *     "boundAt": "ISO-8601",     // first confirmed by this client
 *     "checkedAt": "ISO-8601"    // last confirmed against the server; TTL runs off this
 *   }
 *
 * Only the HEALTHY bound state is ever cached (canPush !== false, spaceName
 * present). Degraded bindings, unbound, no_spaces, and every error state stay
 * uncached so warnings are always served live from the server. The server
 * remains the authority on binding state — push routing never consults this
 * file; the cache only saves the display/probe round-trip on the common path
 * (`jolli status`, bare `jolli`) and records when the binding was confirmed.
 *
 * Writers: the front-door probes (StatusCommand, SpaceSyncStep) on a healthy
 * `bound` answer, the interactive bind/rebind flows on success, and every push
 * path when a 2xx response carries the server's `jmSpace` echo. Clearers: a
 * front-door `unbound`/`no_spaces`/degraded answer, a push rejected with
 * 412/401/403, and the bind-only entry points (`jolli bind`, MCP `bind_space`,
 * `jolli push --space`) whose next probe rebuilds the file authoritatively.
 *
 * Worktrees: the file is anchored to the MAIN worktree root (same anchoring as
 * RepoProfile, resolved via `git rev-parse --git-common-dir`) — the binding is
 * repo-wide, keyed by the remote URL every `git worktree` checkout shares, so
 * all worktrees read and write ONE file: a bind confirmed in one worktree warms
 * the cache for all of them, and a clear (rejected push, unbound answer) drops
 * the stale entry everywhere at once. Outside a git repo the path falls back to
 * `<cwd>/.jolli/jollimemory/` — the cache is best-effort and never requires
 * git. No-remote edge: `repoUrl` falls back to `file://<worktree-root>`, so
 * worktrees of a remote-less repo write the shared file under different keys
 * and miss each other's entry — an extra live probe, never a wrong answer.
 *
 * Concurrency: single-value file written via `atomicWriteFile` — last writer
 * wins; no lock needed (unlike push-pending.json there is no lost-update).
 * Cross-worktree sharing doesn't change this: every write stores a
 * server-confirmed state for the same repo+tenant key, so racing writers
 * converge.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createLogger, getJolliMemoryDir, isEnoent } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { execGit } from "./GitOps.js";
import { parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils.js";

const log = createLogger("SpaceBindingCache");

/** File name under `.jolli/jollimemory/`. */
export const SPACE_BINDING_CACHE_FILE = "space-binding.json";

/**
 * Lazy read-time expiry for the cached binding. Aligned with
 * `PUSH_PENDING_STALE_MS` (7 d, the repo-wide stale-prune convention). A long
 * TTL is safe here because the cache never lies for long in practice: any
 * rejected push (412/401/403) clears it immediately, a front-door
 * `unbound`/`no_spaces` answer clears it too, and `jolli status --refresh`
 * forces a live re-check on demand.
 */
export const SPACE_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SpaceBindingCacheEntry {
	readonly version: 1;
	/** Canonical repo URL the binding belongs to — a mismatch on read is a miss. */
	readonly repoUrl: string;
	/** Tenant origin from the api key at write time — a key/tenant swap is a miss. */
	readonly origin: string;
	readonly jmSpaceId: number | null;
	readonly spaceName: string;
	/** Only `true` or `null` (older server, unknown) is ever written — `false` is never cached. */
	readonly canPush: true | null;
	/** ISO-8601 — when this client first confirmed the binding to the current Space. */
	readonly boundAt: string;
	/** ISO-8601 — when the binding was last confirmed against the server. */
	readonly checkedAt: string;
}

/** Inputs a cache read must present for the entry to be trusted. */
export interface SpaceBindingCacheKey {
	readonly repoUrl: string;
	readonly origin: string;
}

/**
 * Tenant origin for the given jolliApiKey, or null when the key carries no
 * resolvable URL. Same origin the push client routes requests to, so cache
 * reads can never cross tenants.
 */
export function tenantOriginForKey(apiKey: string): string | null {
	const rawBase = parseJolliApiKey(apiKey)?.u;
	if (!rawBase) {
		return null;
	}
	try {
		return parseBaseUrl(rawBase).origin;
	} catch {
		return null;
	}
}

/**
 * Directory holding the cache file — `<main-worktree-root>/.jolli/jollimemory`
 * (mirrors RepoProfile's main-worktree anchoring, submodule caveat included).
 * `--git-common-dir` points at the shared `.git` from any worktree and any
 * depth inside it, so every checkout of the repo resolves to the same file.
 * Falls back to `<cwd>/.jolli/jollimemory` when `cwd` is not inside a git repo
 * — the cache is best-effort and never requires git.
 */
async function resolveCacheDir(cwd: string): Promise<string> {
	const res = await execGit(["rev-parse", "--git-common-dir"], cwd);
	const raw = res.exitCode === 0 ? res.stdout.trim() : "";
	if (!raw) {
		return getJolliMemoryDir(cwd);
	}
	const commonDir = isAbsolute(raw) ? raw : join(cwd, raw);
	return getJolliMemoryDir(dirname(commonDir));
}

async function cachePath(cwd: string): Promise<string> {
	return join(await resolveCacheDir(cwd), SPACE_BINDING_CACHE_FILE);
}

function isValidEntry(value: unknown): value is SpaceBindingCacheEntry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const e = value as Partial<SpaceBindingCacheEntry>;
	return (
		e.version === 1 &&
		typeof e.repoUrl === "string" &&
		typeof e.origin === "string" &&
		(typeof e.jmSpaceId === "number" || e.jmSpaceId === null) &&
		typeof e.spaceName === "string" &&
		e.spaceName.length > 0 &&
		(e.canPush === true || e.canPush === null) &&
		typeof e.boundAt === "string" &&
		typeof e.checkedAt === "string"
	);
}

/**
 * Loads the cached binding when it is fresh AND matches the caller's repo and
 * tenant. Every other outcome — missing file, malformed JSON, shape drift,
 * repo/tenant mismatch, expired TTL — resolves to null; a malformed file is
 * best-effort deleted so it cannot shadow future writes.
 */
export async function loadSpaceBindingCache(
	cwd: string,
	key: SpaceBindingCacheKey,
): Promise<SpaceBindingCacheEntry | null> {
	const path = await cachePath(cwd);
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		if (!isEnoent(err)) {
			log.debug(`binding cache read failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		await removeCacheFile(path);
		return null;
	}
	if (!isValidEntry(parsed)) {
		await removeCacheFile(path);
		return null;
	}
	if (parsed.repoUrl !== key.repoUrl || parsed.origin !== key.origin) {
		return null;
	}
	const age = Date.now() - new Date(parsed.checkedAt).getTime();
	if (!Number.isFinite(age) || age < 0 || age > SPACE_BINDING_TTL_MS) {
		return null;
	}
	return parsed;
}

/**
 * Display-only read of the cached Space binding for a status snapshot — returns
 * the bound Space's `spaceName` WITHOUT the tenant-origin / repoUrl match that
 * {@link loadSpaceBindingCache} performs before a push.
 *
 * Origin matching requires decoding the API key ({@link tenantOriginForKey}),
 * which the `status` path deliberately avoids so it stays clear of CodeQL's
 * clear-text-logging taint. The space name is a plain user-visible label (not
 * secret, not key-derived), and a stale name after a tenant swap is a harmless
 * display blemish that the next rejected push clears — so skipping the origin
 * check here is safe. Shape validation and the same TTL still apply; a malformed
 * file is left in place (the authoritative {@link loadSpaceBindingCache} prunes
 * it). Returns null when absent, unparseable, or expired.
 */
export async function loadSpaceBindingDisplay(cwd: string): Promise<{ spaceName: string; canPush: boolean } | null> {
	const path = await cachePath(cwd);
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		/* v8 ignore next 2 -- defensive: only non-ENOENT read errors log; both return null */
		if (!isEnoent(err))
			log.debug(`binding display read failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isValidEntry(parsed)) return null;
	const age = Date.now() - new Date(parsed.checkedAt).getTime();
	if (!Number.isFinite(age) || age < 0 || age > SPACE_BINDING_TTL_MS) return null;
	// Only a healthy binding is ever written (canPush is `true | null`); a `null`
	// (older server, unknown) is treated as pushable, matching loadSpaceBindingCache.
	return { spaceName: parsed.spaceName, canPush: parsed.canPush ?? true };
}

/** What a save records — timestamps are stamped inside {@link saveSpaceBindingCache}. */
export interface SpaceBindingSaveArgs {
	readonly repoUrl: string;
	readonly origin: string;
	readonly jmSpaceId: number | null;
	readonly spaceName: string;
	readonly canPush: true | null;
}

/**
 * Persists a healthy bound state. `checkedAt` is always now; `boundAt` is
 * preserved from an existing entry for the SAME Space and tenant (a
 * re-confirmation is not a re-bind) and reset to now otherwise. Best-effort:
 * a write failure is logged and swallowed — the cache is an optimization,
 * never a gate.
 */
export async function saveSpaceBindingCache(cwd: string, args: SpaceBindingSaveArgs): Promise<void> {
	const path = await cachePath(cwd);
	const now = new Date().toISOString();
	let boundAt = now;
	try {
		const existing: unknown = JSON.parse(await readFile(path, "utf-8"));
		if (isValidEntry(existing) && existing.jmSpaceId === args.jmSpaceId && existing.origin === args.origin) {
			boundAt = existing.boundAt;
		}
	} catch {
		// No prior entry (or unreadable) — boundAt stays now.
	}
	const entry: SpaceBindingCacheEntry = { version: 1, ...args, boundAt, checkedAt: now };
	try {
		await mkdir(dirname(path), { recursive: true });
		await atomicWriteFile(path, JSON.stringify(entry, null, "\t"));
	} catch (err) {
		log.debug(`binding cache write failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Removes the cache file. A missing file is fine; other failures are logged and swallowed. */
export async function clearSpaceBindingCache(cwd: string): Promise<void> {
	await removeCacheFile(await cachePath(cwd));
}

/** Removal on an already-resolved path — shared by {@link clearSpaceBindingCache} and load's corrupt-file paths. */
async function removeCacheFile(path: string): Promise<void> {
	try {
		await rm(path);
	} catch (err) {
		if (!isEnoent(err)) {
			log.debug(`binding cache clear failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
