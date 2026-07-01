/**
 * BranchShareStore
 *
 * Per-project record of the public shares this machine has created, stored in
 * `<projectDir>/.jolli/jollimemory/branch-shares.json` (gitignored).
 *
 * Records are keyed by *share subject*: a branch share keys on the bare branch
 * name; a commit share keys on `<branch>\0<commitHash>` (see `recordKey`). The
 * NUL separator can't appear in a git ref or hash, so the two namespaces never
 * collide.
 *
 * Two jobs:
 *  - Remember the issued share per subject so the Share modal can re-open to the
 *    same link, drive Revoke, and detect "branch moved since I shared" (the
 *    stored `headCommitHash` differs from the branch tip → offer re-share).
 *  - Remember that the user acknowledged the one-time "this is a PUBLIC link"
 *    confirmation. Confirmation is tracked **per branch** (keyed on the bare
 *    branch name) and intentionally covers both branch and commit shares on that
 *    branch — once you've accepted public links for a branch, commit shares on it
 *    don't re-prompt.
 *
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
// v2: live Space-backed shares (visibility/recipients/ref); v1 snapshot records
// are dropped on read (the snapshot share was never released, so no migration).
const SHARES_VERSION = 2 as const;

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
	 * Access level: `public` (anyone-with-link bearer), `org` (auth-gated to the org),
	 * or `people` (auth-gated to the `recipients` allowlist).
	 */
	readonly visibility: "public" | "org" | "people";
	/**
	 * The `people` access allowlist (lowercased emails). For `people` shares this is
	 * **server-authoritative** (sent on the audience PATCH, echoed back, gated on the
	 * view route); cached here for re-open. Absent/empty for public/org.
	 */
	readonly recipients?: ReadonlyArray<string>;
	/** Reference to the live Space content this share renders from. */
	readonly ref?: LiveRef;
	/**
	 * First 8 chars of the bearer token — enough to display/build the deep link, not
	 * the secret. Optional: `org` shares are auth-gated and have no token.
	 */
	readonly token8?: string;
	/**
	 * The subject's tip at create time (still sent to the server; backs the NOT-NULL
	 * column + idempotency index). Optional in the cache — a live share renders current
	 * membership, so it's not used for a client-side staleness check.
	 */
	readonly headCommitHash?: string;
	readonly expiresAt: string;
	/** Decision (topic) count captured at share time — drives the modal preview on reuse. */
	readonly decisionCount: number;
	/** A few decision titles captured at share time — teaser for share copy. */
	readonly titles?: ReadonlyArray<string>;
	/** Set on a commit-share record so the kind is recoverable from the cache alone. */
	readonly commitHash?: string;
	/** Set once the user acknowledged the public-link confirmation for this branch. */
	readonly confirmedPublic?: boolean;
}

/**
 * Map key for a share subject. Branch share → bare branch; commit share →
 * `<branch>\0<commitHash>` (NUL can't occur in a ref/hash, so no collision).
 */
function recordKey(branch: string, commitHash?: string): string {
	return commitHash ? `${branch}\u0000${commitHash}` : branch;
}

interface PersistedShape {
	readonly version: typeof SHARES_VERSION;
	readonly branches: Readonly<Record<string, BranchShareRecord>>;
}

function sharesPath(projectDir: string): string {
	return join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, SHARES_FILE);
}

function emptyShape(): PersistedShape {
	return { version: SHARES_VERSION, branches: {} };
}

async function readAll(projectDir: string): Promise<PersistedShape> {
	let raw: string;
	try {
		raw = await readFile(sharesPath(projectDir), "utf8");
	} catch (err) {
		if (!isEnoent(err)) log.warn("readAll read failed: %s", errMsg(err));
		return emptyShape();
	}
	let parsed: Partial<PersistedShape>;
	try {
		parsed = JSON.parse(raw) as Partial<PersistedShape>;
	} catch (err) {
		log.warn("readAll JSON parse failed: %s", errMsg(err));
		return emptyShape();
	}
	if (parsed.version !== SHARES_VERSION || typeof parsed.branches !== "object" || parsed.branches === null) {
		log.warn("readAll version/shape mismatch (got %s) — ignoring file", String(parsed.version));
		return emptyShape();
	}
	return { version: SHARES_VERSION, branches: parsed.branches };
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
 * Returns the stored share record for a subject, or undefined. Pass `commitHash`
 * for a commit share; omit it for a branch share.
 */
export async function getBranchShare(
	projectDir: string,
	branch: string,
	commitHash?: string,
): Promise<BranchShareRecord | undefined> {
	const all = await readAll(projectDir);
	return all.branches[recordKey(branch, commitHash)];
}

/** Upserts a subject's share record (preserves the existing `confirmedPublic` flag). */
export async function putBranchShare(
	projectDir: string,
	branch: string,
	record: Omit<BranchShareRecord, "confirmedPublic">,
	commitHash?: string,
): Promise<void> {
	const key = recordKey(branch, commitHash);
	return serialize(projectDir, async () => {
		const all = await readAll(projectDir);
		const prev = all.branches[key];
		const branches = { ...all.branches, [key]: { ...record, confirmedPublic: prev?.confirmedPublic } };
		await writeAll(projectDir, { version: SHARES_VERSION, branches });
	});
}

/**
 * Removes a subject's share record (e.g. after revoke). Idempotent.
 *
 * The one-time public-link confirmation (`confirmedPublic`) is independent of the
 * share's lifecycle, so revoking a share must NOT make the user re-confirm next
 * time. When the dropped record carried `confirmedPublic`, we keep a blank
 * placeholder that preserves only that flag rather than deleting the entry.
 */
export async function removeBranchShare(projectDir: string, branch: string, commitHash?: string): Promise<void> {
	const key = recordKey(branch, commitHash);
	return serialize(projectDir, async () => {
		const all = await readAll(projectDir);
		const prev = all.branches[key];
		if (!prev) return;
		if (prev.confirmedPublic) {
			const branches = { ...all.branches, [key]: { ...blankRecord(), confirmedPublic: true } };
			await writeAll(projectDir, { version: SHARES_VERSION, branches });
			return;
		}
		const { [key]: _drop, ...rest } = all.branches;
		await writeAll(projectDir, { version: SHARES_VERSION, branches: rest });
	});
}

/** Whether the user has acknowledged the public-link confirmation for this branch. */
export async function isPublicConfirmed(projectDir: string, branch: string): Promise<boolean> {
	const all = await readAll(projectDir);
	return all.branches[branch]?.confirmedPublic === true;
}

/** Records that the user acknowledged the public-link confirmation for this branch. */
export async function markPublicConfirmed(projectDir: string, branch: string): Promise<void> {
	return serialize(projectDir, async () => {
		const all = await readAll(projectDir);
		const prev = all.branches[branch];
		const branches = { ...all.branches, [branch]: { ...(prev ?? blankRecord()), confirmedPublic: true } };
		await writeAll(projectDir, { version: SHARES_VERSION, branches });
	});
}

/** A placeholder record for a branch confirmed-public before any share exists. */
function blankRecord(): BranchShareRecord {
	return { shareId: "", shareUrl: "", visibility: "public", expiresAt: "", decisionCount: 0 };
}
