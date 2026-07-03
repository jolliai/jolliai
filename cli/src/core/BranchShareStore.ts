/**
 * BranchShareStore
 *
 * Per-project record of the shares this machine has created, stored in
 * `<projectDir>/.jolli/jollimemory/branch-shares.json` (gitignored).
 *
 * Records are keyed by *share subject*: a branch share keys on the bare branch
 * name; a commit share keys on `<branch>:<commitHash>` (see `subjectKey`). A branch
 * name can't contain `:` (git check-ref-format forbids it), so the two namespaces
 * never collide, and the key stays readable (unlike a NUL sentinel).
 *
 * v4: **single-slot** — each subject holds at most ONE share record, whatever its
 * `visibility` (`public` bearer, or the auth-gated member tiers `org`/`people`).
 * Changing access flips that one record's visibility in place; a subject can never
 * carry a public link and a member link at once. This mirrors the server's single
 * unique index per subject (repo+branch, or repo+branch+commit) — the row's tier
 * flips in place, so the old link dies when access is tightened.
 *
 * Two jobs:
 *  - Remember the issued share per subject so the Share modal can re-open to the
 *    same link, drive Copy/Stop, and PATCH the audience (visibility + recipients).
 * This is a local cache, not the system of record — the backend owns share
 * lifecycle. The account-level management view (web dashboard) is the
 * authoritative cross-repo surface; both align on `shareId`.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, isEnoent, JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";

const log = createLogger("BranchShare");

const SHARES_FILE = "branch-shares.json";
// One share record per subject (single-slot). Branch sharing never shipped with an
// older on-disk shape (v2/v3 existed only on unreleased dev builds), so there is no
// migration: a file whose `version` or shape doesn't match is ignored (treated as
// empty) and re-created on the next share. The number stays MONOTONIC past the
// dev-only v2/v3 so an older file is never mistaken for the current shape.
const SHARES_VERSION = 4 as const;

/**
 * Reference to the live Space content a share renders from. Branch shares carry a
 * per-commit allowlist (`covered`) = the current `base..HEAD` docs, so the server
 * renders exactly those; commit shares carry a fixed doc list.
 */
export type LiveRef =
	| {
			readonly kind: "branchCollection";
			readonly relativePath: string;
			readonly covered: ReadonlyArray<{
				readonly commitHash: string;
				readonly summaryDocId: number;
				readonly attachmentDocIds: ReadonlyArray<number>;
			}>;
	  }
	| {
			readonly kind: "commitDocs";
			readonly summaryDocIds: ReadonlyArray<number>;
			readonly attachmentDocIds: ReadonlyArray<number>;
	  };

/** One share record (branch share or single-commit share). Every share is live. */
export interface BranchShareRecord {
	readonly shareId: string;
	readonly shareUrl: string;
	/**
	 * Access level: `public` (anyone-with-link bearer), `org` (auth-gated: any
	 * signed-in member ∪ recipients), or `people` (auth-gated: recipients only).
	 * A subject has one record; changing access flips this field in place.
	 */
	readonly visibility: "public" | "org" | "people";
	/**
	 * The member link's invited-people allowlist (lowercased emails). Server-
	 * authoritative (written by the invite endpoint / audience PATCH, echoed back,
	 * gated on the view route); cached here for re-open. Never set on `public`.
	 */
	readonly recipients?: ReadonlyArray<string>;
	/** Reference to the live Space content this share renders from. */
	readonly ref?: LiveRef;
	/**
	 * The subject's `base..HEAD` tip the share last covered (also sent to the server;
	 * backs the NOT-NULL column + idempotency index). Optional in the cache; when
	 * present it drives `reconcileLiveShare`'s head-staleness short-circuit (skip the
	 * re-push when the current head already matches). A missing value reads as stale.
	 */
	readonly headCommitHash?: string;
	/**
	 * Fingerprint of the shared content (topics/recap + plan/note revisions) at the
	 * last push. `reconcileLiveShare` re-pushes only when this differs from the current
	 * subject's fingerprint — so a memory edit that DOESN'T advance the git HEAD (topic
	 * edit, regenerated summary, plan/note change) is still detected and republished,
	 * while an unchanged subject skips the per-commit re-push. Optional: a record
	 * without it reads as stale and reconciles, repopulating it.
	 */
	readonly contentHash?: string;
	readonly expiresAt: string;
	/**
	 * Decision (topic) count for the subject, captured at share/reconcile time. Cached
	 * here (rather than recomputed on open) so the modal subtitle doesn't reload every
	 * base..HEAD summary just to show "N decisions".
	 */
	readonly decisionCount: number;
}

// A branch/ref name can never contain ":" (git check-ref-format forbids it), so
// "<branch>:<commitHash>" splits unambiguously. Unlike a NUL sentinel it stays
// readable in the JSON file, logs, and editors.
const COMMIT_KEY_SEP = ":";

/**
 * Map key for a share subject. Branch share → bare branch; commit share →
 * `<branch>:<commitHash>` (":" can't occur in a git ref, so no collision).
 */
function subjectKey(branch: string, commitHash?: string): string {
	return commitHash ? `${branch}${COMMIT_KEY_SEP}${commitHash}` : branch;
}

interface PersistedShape {
	readonly version: typeof SHARES_VERSION;
	readonly subjects: Readonly<Record<string, BranchShareRecord>>;
}

function sharesPath(projectDir: string): string {
	return join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, SHARES_FILE);
}

function emptyShape(): PersistedShape {
	return { version: SHARES_VERSION, subjects: {} };
}

async function readAll(projectDir: string): Promise<PersistedShape> {
	let raw: string;
	try {
		raw = await readFile(sharesPath(projectDir), "utf8");
	} catch (err) {
		if (!isEnoent(err)) log.warn("readAll read failed: %s", errMsg(err));
		return emptyShape();
	}
	// Parse loosely and narrow by hand; a shape/version mismatch is ignored, not fatal.
	let parsed: { version?: unknown; subjects?: PersistedShape["subjects"] };
	try {
		parsed = JSON.parse(raw) as typeof parsed;
	} catch (err) {
		log.warn("readAll JSON parse failed: %s", errMsg(err));
		return emptyShape();
	}
	if (parsed.version !== SHARES_VERSION || typeof parsed.subjects !== "object" || parsed.subjects === null) {
		log.warn("readAll version/shape mismatch (got %s) — ignoring file", String(parsed.version));
		return emptyShape();
	}
	return { version: SHARES_VERSION, subjects: parsed.subjects };
}

async function writeAll(projectDir: string, next: PersistedShape): Promise<void> {
	const dir = join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR);
	await mkdir(dir, { recursive: true });
	// Shared atomic write (tmpfile + rename) with the Windows EPERM/EACCES overwrite
	// fallback — rapid Share/Revoke clicks are serialized by writeChains above.
	await atomicWriteFile(sharesPath(projectDir), JSON.stringify(next, null, "\t"));
}

// One read-modify-write chain per projectDir — rapid Share/Revoke clicks must
// not lose updates or collide on the temp filename. Mirrors CommitSelectionStore.
const writeChains = new Map<string, Promise<void>>();

function serialize<T>(projectDir: string, work: () => Promise<T>): Promise<T> {
	const prior = writeChains.get(projectDir) ?? Promise.resolve();
	const next = prior.then(work, work);
	writeChains.set(
		projectDir,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

/**
 * Returns a subject's single share record, or undefined. Pass `commitHash` for a
 * commit share; omit it for a branch share.
 */
export async function getShare(
	projectDir: string,
	branch: string,
	commitHash?: string,
): Promise<BranchShareRecord | undefined> {
	const all = await readAll(projectDir);
	return all.subjects[subjectKey(branch, commitHash)];
}

/**
 * Upserts a subject's single share record (create or in-place flip). Overwrites
 * whatever was there — a subject holds exactly one link.
 */
export async function putBranchShare(
	projectDir: string,
	branch: string,
	record: BranchShareRecord,
	commitHash?: string,
): Promise<void> {
	const key = subjectKey(branch, commitHash);
	return serialize(projectDir, async () => {
		const all = await readAll(projectDir);
		await writeAll(projectDir, { ...all, subjects: { ...all.subjects, [key]: record } });
	});
}

/**
 * Removes a subject's share record (e.g. after a Stop). Idempotent; an absent
 * subject is a no-op and the entry is dropped entirely.
 */
export async function removeShare(projectDir: string, branch: string, commitHash?: string): Promise<void> {
	const key = subjectKey(branch, commitHash);
	return serialize(projectDir, async () => {
		const all = await readAll(projectDir);
		if (!all.subjects[key]) return;
		const { [key]: _drop, ...subjects } = all.subjects;
		await writeAll(projectDir, { ...all, subjects });
	});
}
