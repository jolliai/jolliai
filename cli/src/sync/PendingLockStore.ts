/**
 * Persists the most recent `lockOwnerToken` returned by
 * `POST /api/mb-sync/credentials` so the engine can decide, on a later
 * 423 vault_locked, whether the lock is **self-held** (this device's
 * previous round acquired the backend write-lock and never released it
 * via `notifyPush` / `completeMigration`) vs **peer-held** (some other
 * device is mid-round).
 *
 * Why a separate file rather than a field on `sync-state.json`:
 *
 *   - `sync-state.json` is keyed by `userSlug`, which the engine doesn't
 *     know until after a successful mint. The whole point of this store
 *     is to look up state BEFORE mint, while debugging a 423. Keying by a
 *     hash of the `jolliApiKey` works without a successful mint.
 *   - Read/write is on the 423-retry hot path. Keeping it a tiny, single-
 *     entry file (a few hundred bytes) avoids touching the larger
 *     state file on every mint.
 *
 * Lifetime invariants:
 *
 *   - **Written** once per successful `mintGitCredentials` (initial mint
 *     and recovery `tryRemint`). Overwrites any prior entry — only the
 *     most recent token is tracked, since a fresh successful mint proves
 *     the previous lock has been released.
 *   - **Cleared** once per successful `notifyPush` / `completeMigration`
 *     (the two backend calls that explicitly release the lock).
 *   - **Stale** when older than `SELF_LOCK_TTL_GRACE_MS` (see
 *     `SyncEngine.ts`). A stale entry is treated as "lock has timed out
 *     on the backend, no longer self-held" — the heuristic that lets us
 *     distinguish self vs peer without a backend-side echo of the holder
 *     token.
 *   - **Scoped** by `pbkdf2(jolliApiKey)`-prefix so an account switch on
 *     the same machine invalidates the entry automatically (a different
 *     user's previous lock is irrelevant to this user's 423). PBKDF2
 *     output is memoized per-process so the hash cost is paid once per
 *     key, not once per 423-retry attempt.
 *
 * NOT cross-process locked. Concurrent writes from two engine instances
 * targeting the same machine produce a "last write wins" — fine because
 * the only consumer is a read-once-per-mint heuristic and the persisted
 * value is a strict superset of any reader's expectation (it can't
 * resurrect a token the backend has actually released).
 */

import { pbkdf2Sync } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("Sync:PendingLock");

const STATE_VERSION = 1 as const;

/**
 * PBKDF2 parameters for the account-switch scoping hash. The hash is
 * local-only and never crosses the wire, but the input IS a credential
 * (`sk-jol-…`), so we use a slow KDF to remove the CodeQL "insecure hash
 * of a password" alert and to make brute-force inference of which API
 * key produced a given file genuinely expensive. 210k iterations matches
 * OWASP 2023 for PBKDF2-HMAC-SHA256.
 *
 * The result is *truncated* to 32 hex chars after hashing — sufficient
 * entropy (128 bits) to distinguish API keys without leaking the full
 * hash, and unchanged on the wire/file format.
 */
const KEY_HASH_SALT = "jolli:pending-lock:key-hash:v1";
const KEY_HASH_ITERATIONS = 210_000;
const KEY_HASH_BYTES = 32;
const KEY_HASH_DIGEST = "sha256";

interface PendingLockEntry {
	readonly version: typeof STATE_VERSION;
	/** First 32 chars of pbkdf2(jolliApiKey). Account-switch invalidates the entry. */
	readonly keyHash: string;
	readonly lockOwnerToken: string;
	/** Epoch ms of the successful mint that produced this token. */
	readonly mintedAt: number;
}

export interface ReadPendingLockResult {
	readonly lockOwnerToken: string;
	readonly mintedAt: number;
}

/** Resolved at import time — every helper joins onto this. */
function getPath(): string {
	return join(homedir(), ".jolli", "jollimemory", "pending-lock.json");
}

/**
 * Per-process memoization. `hashKey` is called on every mint and every
 * 423-retry attempt; without this cache, each call would pay the full
 * 210k-iter PBKDF2 cost (~50-100 ms). The api key rarely changes during
 * a process lifetime, so one slow hash per key is the right tradeoff.
 *
 * Keyed by the raw api key, which lives in process memory anyway (the
 * BackendClient already has it for the Authorization header) — the cache
 * doesn't widen the secret's exposure. Bounded at a single entry per
 * account switch since the engine only ever holds one jolliApiKey at a
 * time; we evict the previous entry whenever a new key is hashed.
 */
const hashCache = new Map<string, string>();

function hashKey(jolliApiKey: string): string {
	const cached = hashCache.get(jolliApiKey);
	if (cached !== undefined) return cached;
	const digest = pbkdf2Sync(jolliApiKey, KEY_HASH_SALT, KEY_HASH_ITERATIONS, KEY_HASH_BYTES, KEY_HASH_DIGEST)
		.toString("hex")
		.slice(0, 32);
	// One entry per account-switch: clear the prior entry before storing
	// the new one so the cache can't grow without bound across long-
	// running processes that see multiple keys (account switch, test
	// fixtures that iterate over many keys, …).
	if (hashCache.size > 0) hashCache.clear();
	hashCache.set(jolliApiKey, digest);
	return digest;
}

/**
 * Returns the persisted entry iff it matches the supplied `jolliApiKey`
 * (account-switch guard) and the file is well-formed. Any error
 * (missing, corrupt, version mismatch, wrong key) returns `null` —
 * callers treat absence as "no pending self-lock evidence", which is
 * the safe default.
 */
export async function readPendingLock(jolliApiKey: string): Promise<ReadPendingLockResult | null> {
	const path = getPath();
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return null;
		/* v8 ignore next -- `err.code ?? "unknown"` fallback: every `NodeJS.ErrnoException` carries a code on real platforms; the fallback is defensive for stub Error objects from test mocks */
		log.warn("Failed to read pending-lock.json (%s): %s — treating as absent", err.code ?? "unknown", err.message);
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const entry = parsed as Partial<PendingLockEntry>;
	if (entry.version !== STATE_VERSION) return null;
	if (
		typeof entry.keyHash !== "string" ||
		typeof entry.lockOwnerToken !== "string" ||
		typeof entry.mintedAt !== "number" ||
		!Number.isFinite(entry.mintedAt)
	) {
		return null;
	}
	if (entry.keyHash !== hashKey(jolliApiKey)) return null;
	return { lockOwnerToken: entry.lockOwnerToken, mintedAt: entry.mintedAt };
}

/**
 * Atomic write (tmp+rename) so a crashed write never leaves a corrupt
 * JSON visible to readers. Tightens to `0600` on POSIX — the file
 * doesn't carry the api key itself but does carry a hash prefix, and
 * keeping it owner-readable matches `sync-state.json`'s posture.
 */
export async function writePendingLock(
	jolliApiKey: string,
	lockOwnerToken: string,
	mintedAtMs: number = Date.now(),
): Promise<void> {
	const path = getPath();
	await mkdir(dirname(path), { recursive: true });
	const entry: PendingLockEntry = {
		version: STATE_VERSION,
		keyHash: hashKey(jolliApiKey),
		lockOwnerToken,
		mintedAt: mintedAtMs,
	};
	const tmp = `${path}.${process.pid}.tmp`;
	// `mode: 0o600` closes the world-readable window between tmp-write and the
	// post-rename chmod. `open()` applies `mode & ~umask`, and `0o600` survives
	// every common umask (022 / 077 / 002), so the on-disk perms match the
	// chmod's final state from the moment the file exists. The chmod below is
	// kept as a safety net for the (rare) case where the tmp inode was reused
	// from a same-PID-crashed predecessor and writeFile took the O_TRUNC path
	// without resetting perms.
	await writeFile(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
	await rename(tmp, path);
	/* v8 ignore next -- platform branch: tests run on Linux/macOS so the `!== "win32"` arm is the only one exercised; the Windows skip is correct by construction */
	if (platform() !== "win32") {
		await chmod(path, 0o600).catch((e) => {
			/* v8 ignore start -- chmod failure is non-fatal log-only; only realistic trigger is a hostile filesystem that the test fixture can't reliably reproduce */
			log.warn("chmod 0600 on pending-lock.json failed: %s", (e as Error).message);
			/* v8 ignore stop */
		});
	}
}

/** Removes the persisted entry. No-op when the file is already absent. */
export async function clearPendingLock(): Promise<void> {
	const path = getPath();
	try {
		await unlink(path);
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return;
		log.warn("Failed to clear pending-lock.json (%s): %s", err.code ?? "unknown", err.message);
	}
}
