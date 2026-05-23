/**
 * Vault identity marker — proves that `<memoryBankRoot>/.git/` belongs to the
 * Jolli sync engine and points at the personal-space repo we expect.
 *
 * **Why this exists.** Before the marker, `SyncEngine.fetchOrCloneWithRetry`
 * treated any directory containing `.git/` as a Jolli vault and walked
 * straight into `fetch` → `stageAll` → `commit` → `push`. If the user picked
 * an existing source-code repository as their Memory Bank folder (e.g. by
 * mistake in the Settings UI), the sync round would happily rewrite that
 * repo and push to its own `origin`. The marker closes that hole.
 *
 * **Two layers of defense.** Every steady-state round runs both checks
 * before any write:
 *
 *   1. **Marker file present** — `.git/jolli-vault-identity.json` is written
 *      by the engine after clone / init succeeds. A foreign repo never has
 *      it. Lives inside `.git/` so it never escapes the local clone (no
 *      commit, no push, no pull-rebase interaction).
 *   2. **Remote URL matches credentials** — even if a stray marker file
 *      ended up in a foreign repo somehow (user copied a vault elsewhere
 *      then re-pointed origin, or a buggy older client), the remote URL
 *      stamped on disk must normalize to the URL the backend just minted
 *      credentials for.
 *
 * Mismatch is treated as a terminal failure (`code: "vault_mismatch"`) so
 * the user must intervene — auto-retry would just keep failing, and the
 * whole point is to refuse to write.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { GitCredentials } from "./SyncTypes.js";

const log = createLogger("Sync:VaultMarker");

/** Path of the marker relative to `<memoryBankRoot>`. Inside `.git/` on purpose. */
export const VAULT_MARKER_REL_PATH = join(".git", "jolli-vault-identity.json");

/**
 * On-disk shape of the marker. `version` is bumped only on breaking layout
 * changes — readers must tolerate unknown future fields, writers must keep
 * the existing ones populated.
 */
export interface VaultMarker {
	readonly kind: "jolli-memory-bank";
	readonly version: 1;
	/** ISO8601. Informational; not used for verification. */
	readonly createdAt: string;
	/** Normalized expected remote URL (no auth, no trailing `.git`, lower-host). */
	readonly gitUrl: string;
	/** `jolli-vaults/<user-slug>` — informational; not used for verification. */
	readonly repoFullName: string;
	/** Backend-declared default branch at write time. Informational. */
	readonly defaultBranch: string;
}

/**
 * Hosts whose `owner/repo` path GitHub-style forges treat as
 * case-insensitive — owner/repo renames at GitHub change the canonical
 * case but old URLs still resolve, and the backend may emit either form.
 * Without lowercasing the path on these hosts, a case drift between the
 * mint response and `.git/config` triggers terminal `vault_mismatch` with
 * no auto-recovery (I3).
 *
 * Self-hosted Git servers (Gitea on Linux, Gogs, …) are NOT in this list:
 * their paths CAN be case-sensitive depending on filesystem and config.
 * Falling back to "preserve case" is the safe default.
 */
const CASE_INSENSITIVE_PATH_HOSTS: ReadonlySet<string> = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

/**
 * Normalizes a git URL for safe comparison. Strips:
 *
 *   - any `user[:pwd]@` segment (askpass injects `x-access-token@`)
 *   - trailing `.git`
 *   - trailing slash
 *
 * Lowercases the host always; lowercases the path only for forges whose
 * owner/repo namespace is case-insensitive (GitHub, GitLab, Bitbucket).
 *
 * Returns the input unchanged when the URL doesn't parse as `https://…`.
 * Non-HTTPS URLs aren't in scope (Jolli always mints `https://github.com/…`),
 * but we leave them alone rather than throw — the comparison will then be
 * exact-match, which still rejects an unexpected URL safely.
 */
export function normalizeGitUrl(url: string): string {
	const match = /^(https:\/\/)(?:[^@/]+@)?([^/]+)(\/.*?)\/?$/i.exec(url.trim());
	if (!match) return url.trim();
	const scheme = match[1].toLowerCase();
	const host = match[2].toLowerCase();
	let path = match[3];
	if (path.toLowerCase().endsWith(".git")) {
		path = path.slice(0, -4);
	}
	if (CASE_INSENSITIVE_PATH_HOSTS.has(host)) {
		path = path.toLowerCase();
	}
	return `${scheme}${host}${path}`;
}

/**
 * Writes (or rewrites) the marker for `memoryBankRoot`. Idempotent — called
 * unconditionally after clone / init, and tolerates being called again with
 * the same creds.
 *
 * `gitUrl` is stored already-normalized so reads don't need to re-derive
 * the comparison form on every round.
 */
export async function writeVaultMarker(memoryBankRoot: string, creds: GitCredentials): Promise<void> {
	const path = join(memoryBankRoot, VAULT_MARKER_REL_PATH);
	const marker: VaultMarker = {
		kind: "jolli-memory-bank",
		version: 1,
		createdAt: new Date().toISOString(),
		gitUrl: normalizeGitUrl(creds.gitUrl),
		repoFullName: creds.repoFullName,
		defaultBranch: creds.defaultBranch,
	};
	// `.git/` exists by the time we get here (post-clone or post-init), but
	// `mkdir recursive:true` is cheap and tolerates the already-exists case.
	await mkdir(join(memoryBankRoot, ".git"), { recursive: true });
	await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
	log.debug("Wrote vault identity marker at %s", path);
}

/**
 * Reads the marker if present and well-formed. Returns `null` for any
 * read error, missing file, or shape mismatch — callers must treat all
 * three identically (refuse to write to this folder).
 */
export async function readVaultMarker(memoryBankRoot: string): Promise<VaultMarker | null> {
	try {
		const raw = await readFile(join(memoryBankRoot, VAULT_MARKER_REL_PATH), "utf-8");
		const parsed = JSON.parse(raw) as Partial<VaultMarker>;
		if (parsed.kind !== "jolli-memory-bank" || parsed.version !== 1) return null;
		if (typeof parsed.gitUrl !== "string" || parsed.gitUrl.length === 0) return null;
		// Other fields are informational — missing values shouldn't cause a
		// reject, but we coerce to safe defaults for the return shape.
		return {
			kind: "jolli-memory-bank",
			version: 1,
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
			gitUrl: parsed.gitUrl,
			repoFullName: typeof parsed.repoFullName === "string" ? parsed.repoFullName : "",
			defaultBranch: typeof parsed.defaultBranch === "string" ? parsed.defaultBranch : "",
		};
	} catch {
		return null;
	}
}

/** Verdict returned by `verifyVaultMarker`. */
export type VaultVerdict =
	| {
			readonly ok: true;
			/**
			 * `true` when the on-disk marker matches credentials only AFTER
			 * re-running `normalizeGitUrl` on its stored `gitUrl` — i.e. the
			 * marker was written by an older client that didn't lower-case
			 * GitHub paths. The engine MUST rewrite the marker on `true`
			 * so subsequent rounds take the cheap byte-equality path and
			 * later normalization tweaks don't reopen the same diff.
			 */
			readonly needsRewrite?: boolean;
	  }
	| { readonly ok: false; readonly reason: "missing_marker" | "url_mismatch"; readonly message: string };

/**
 * Verifies that `<memoryBankRoot>` carries a marker that matches the freshly-
 * minted credentials. Caller supplies the actual `origin` URL read from
 * `.git/config` (typically via `GitClient.getOriginUrl`) so this module
 * doesn't have to spawn git itself.
 *
 *   - `originUrl === null`: treat as `url_mismatch` (a real Jolli vault always
 *     has an origin URL — its absence is as strong a signal as a foreign URL).
 *   - marker absent OR malformed: `missing_marker`.
 *   - both present but URLs disagree post-normalization: `url_mismatch`.
 *
 * The marker's stored `gitUrl` and the live `originUrl` must BOTH match the
 * credentials. Comparing only one would let a stale marker or a re-pointed
 * origin slip through.
 */
export async function verifyVaultMarker(
	memoryBankRoot: string,
	originUrl: string | null,
	creds: GitCredentials,
): Promise<VaultVerdict> {
	const marker = await readVaultMarker(memoryBankRoot);
	if (marker === null) {
		return {
			ok: false,
			reason: "missing_marker",
			message: `${memoryBankRoot} already contains a .git directory but no Jolli vault marker. Refusing to write — pick a different Memory Bank folder.`,
		};
	}
	const expected = normalizeGitUrl(creds.gitUrl);
	// Re-normalize the STORED marker URL so a marker written by an older
	// client (e.g. before path-lowercasing was added in 541d00e for
	// `CASE_INSENSITIVE_PATH_HOSTS`) is transparently accepted instead of
	// triggering a one-shot `vault_mismatch` for every existing install.
	// The asymmetric byte-compare was the bug; this is the canonical fix
	// — every future tweak to `normalizeGitUrl` only has to be backward-
	// compatible with itself, not with every prior serialized form.
	const storedNormalized = normalizeGitUrl(marker.gitUrl);
	if (storedNormalized !== expected) {
		return {
			ok: false,
			reason: "url_mismatch",
			message: `Vault marker remembers ${marker.gitUrl} but credentials point at ${expected}. Refusing to write — the Memory Bank folder appears to have moved to a different personal space.`,
		};
	}
	// Marker bytes don't match the current normalized form — accepted via
	// re-normalization above, but flag so the engine rewrites the file
	// and stops paying the re-normalize cost (and stops carrying the
	// historical form across upgrades).
	const needsRewrite = storedNormalized !== marker.gitUrl;
	if (originUrl === null) {
		return {
			ok: false,
			reason: "url_mismatch",
			message: `Vault at ${memoryBankRoot} has no origin remote configured. Refusing to write — the working tree is in an inconsistent state.`,
		};
	}
	const actual = normalizeGitUrl(originUrl);
	if (actual !== expected) {
		return {
			ok: false,
			reason: "url_mismatch",
			message: `Vault origin remote is ${actual} but credentials point at ${expected}. Refusing to write — pick a different Memory Bank folder.`,
		};
	}
	return needsRewrite ? { ok: true, needsRewrite: true } : { ok: true };
}
