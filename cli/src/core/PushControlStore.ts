/**
 * PushControlStore — the machine-global, repo-identity-keyed record of which
 * repositories have OUTBOUND push to a Jolli Space turned off (spec 306).
 *
 * Lives at `~/.jolli/jollimemory/push-control.json`. Keyed by a repo's canonical
 * identity (its `getCanonicalRepoUrl`) rather than a working-tree path, so:
 *   - the machine-wide control view (sourced from the Memory Bank, which knows
 *     repos by identity) and the per-repo gate (which resolves its own canonical
 *     URL) share one key, and
 *   - a repo checked out in several worktrees shares one decision.
 *
 * Absent from the file = push allowed (the default; a restriction is always an
 * explicit opt-in). The file stores only the DISABLED repos, each as a
 * self-describing entry — the canonical `identity` (the key everything looks up
 * by) plus a human-readable `repo` name, the `disabledAt` timestamp, and the
 * `trigger` surface that flipped it — so a hand-inspection of the file explains
 * itself. The extra fields are display-only: `loadDisabledRepos` reads back the
 * identities and nothing else.
 */
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { deriveRepoNameFromUrl } from "./GitRemoteUtils.js";
import { withPushControlLock } from "./Locks.js";
import { getGlobalConfigDir } from "./SessionTracker.js";

const log = createLogger("PushControlStore");

export const PUSH_CONTROL_FILE = "push-control.json";
export const PUSH_CONTROL_VERSION = 1;

/** One disabled repo, self-describing so the on-disk file reads on its own. */
export interface DisabledRepoEntry {
	/** Human-readable repo name, derived from the identity. Display only. */
	readonly repo: string;
	/** Canonical repo identity — the store key and the toggle target. */
	readonly identity: string;
	/** ISO timestamp of when push was last disabled for this repo. Display only. */
	readonly disabledAt: string;
	/** The surface that disabled it (`cli` | `vscode` | `intellij`). Display only. */
	readonly trigger: string;
}

interface PushControlFile {
	readonly version: number;
	readonly disabled: DisabledRepoEntry[];
}

/** Options for a toggle write. `globalDir` is a test-injection seam. */
export interface SetRepoPushDisabledOptions {
	readonly trigger?: string;
	readonly globalDir?: string;
}

/**
 * Outcome of a toggle write.
 *
 * `recoveredFromCorrupt` is the load-bearing half: it is true only on the ENABLE
 * path when the store could not be parsed, so the write rebuilt it from an empty
 * set and **every other repo's opt-out was dropped**. Callers MUST surface that —
 * a bare "Enabled ✓" after silently resetting the whole machine's settings is the
 * one outcome this store must never produce quietly. The unreadable file itself is
 * preserved next to the store (see {@link CORRUPT_SUFFIX}) so the opt-outs can be
 * recovered by hand.
 */
export interface SetRepoPushDisabledResult {
	readonly disabled: boolean;
	readonly recoveredFromCorrupt: boolean;
	/** Absolute path the unreadable store was moved to, when one was preserved. */
	readonly preservedAt?: string;
}

/** Infix for the backup an enable-path recovery leaves behind. */
export const CORRUPT_SUFFIX = ".corrupt-";

/**
 * The store was written by a newer schema than this build understands.
 *
 * Distinct from a corrupt/unreadable store because the recovery differs: an
 * unparseable file is garbage and the enable path may rebuild it, but a
 * newer-version file is *valid data this build cannot interpret*. Rebuilding it
 * would destroy real opt-outs (and reading it with v1 rules could drop the ones
 * whose shape changed — a fail-OPEN leak). The only correct answer is to refuse
 * and tell the user to upgrade, so the enable path rethrows this instead of
 * recovering from it.
 */
export class PushControlStoreTooNewError extends Error {
	constructor(
		readonly path: string,
		readonly foundVersion: number,
	) {
		super(
			`Push-control store at ${path} was written by a newer version of Jolli Memory (schema ${foundVersion} > ${PUSH_CONTROL_VERSION}). Upgrade to read or change it.`,
		);
		this.name = "PushControlStoreTooNewError";
	}
}

/** Absolute path of the store under the machine-global config dir. */
export function getPushControlPath(globalDir?: string): string {
	return join(globalDir ?? getGlobalConfigDir(), PUSH_CONTROL_FILE);
}

/**
 * Reads the disabled entries as an identity→entry map.
 *
 * A **missing** file is the legitimate default — no repo disabled — and returns
 * an empty map (push allowed). But a file that EXISTS yet can't be read or
 * parsed (EACCES, EIO, truncated/corrupt JSON) is NOT the same as "nothing
 * disabled": it is a real fault, so it **propagates**. That lets the outbound
 * gate ({@link isRepoPushDisabled} → `isOutboundPushAllowed`) fail CLOSED on an
 * unreadable store rather than silently treating every push-disabled repo as
 * allowed and leaking memory outbound. A parseable-but-odd shape (e.g. a
 * non-array `disabled`, or malformed elements) is tolerated as empty — it is
 * readable, just carries nothing actionable.
 */
async function loadEntries(globalDir?: string): Promise<Map<string, DisabledRepoEntry>> {
	const entries = new Map<string, DisabledRepoEntry>();
	const path = getPushControlPath(globalDir);
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return entries; // missing = allowed default
		// EACCES / EIO / … — a real read fault; let the gate fail closed. Name the
		// absolute path so a human (and the `jolli push-control` error) can find the file.
		throw new Error(`Push-control store at ${path} could not be read: ${(e as Error).message}`);
	}
	// Parse errors propagate for the same reason (a corrupt store is not "empty"),
	// again carrying the path so the failure points at the file that must be fixed.
	let parsed: Partial<PushControlFile>;
	try {
		parsed = JSON.parse(text) as Partial<PushControlFile>;
	} catch (e) {
		throw new Error(`Push-control store at ${path} is corrupt and could not be parsed: ${(e as Error).message}`);
	}
	if (!parsed) return entries;
	// A store written by a NEWER schema must not be read with these rules. Its
	// `disabled` array could carry entries this build cannot interpret (a different
	// key field, a nested shape, negative entries), and silently reading it as
	// "these are the only disabled repos" would drop every opt-out it doesn't
	// understand — a fail-OPEN leak in the one place this module is fail-closed
	// everywhere else. So treat it like an unreadable file and propagate. An OLDER
	// or absent version is fine: v1 is the only format shipped, and a missing field
	// simply predates the check.
	if (typeof parsed.version === "number" && parsed.version > PUSH_CONTROL_VERSION) {
		throw new PushControlStoreTooNewError(path, parsed.version);
	}
	if (!Array.isArray(parsed.disabled)) return entries;
	for (const raw of parsed.disabled) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Partial<DisabledRepoEntry>;
		if (typeof entry.identity !== "string" || entry.identity.length === 0) continue;
		entries.set(entry.identity, {
			repo: typeof entry.repo === "string" ? entry.repo : deriveRepoNameFromUrl(entry.identity),
			identity: entry.identity,
			disabledAt: typeof entry.disabledAt === "string" ? entry.disabledAt : "",
			trigger: typeof entry.trigger === "string" ? entry.trigger : "",
		});
	}
	return entries;
}

/**
 * Reads the set of disabled identities. A **missing** file yields an empty set
 * (push allowed); a **corrupt/unreadable** file propagates (see {@link loadEntries})
 * so the read gate fails CLOSED rather than silently allowing every repo.
 */
export async function loadDisabledRepos(globalDir?: string): Promise<Set<string>> {
	return new Set((await loadEntries(globalDir)).keys());
}

/** True iff `repoIdentity` is recorded as push-disabled. */
export async function isRepoPushDisabled(repoIdentity: string, globalDir?: string): Promise<boolean> {
	return (await loadDisabledRepos(globalDir)).has(repoIdentity);
}

/**
 * Adds or removes `repoIdentity` from the disabled set under the shared
 * push-control lock (a serialized read-modify-write, so a CLI toggle and a VS
 * Code toggle of different repos can't lose-update each other). On disable the
 * entry is (re)stamped with a derived repo name, the current time, and the
 * `trigger`; on enable the entry is dropped. A lock timeout falls back to a
 * best-effort unlocked write rather than dropping the user's toggle.
 *
 * Returns {@link SetRepoPushDisabledResult}; see `recoveredFromCorrupt` for the
 * one outcome callers must not report as a plain success.
 *
 * @throws Error when `repoIdentity` is empty — see the guard below.
 */
export async function setRepoPushDisabled(
	repoIdentity: string,
	disabled: boolean,
	options: SetRepoPushDisabledOptions = {},
): Promise<SetRepoPushDisabledResult> {
	// An empty identity is never a legitimate key, and writing one is WORSE than
	// refusing: `loadEntries` skips entries whose identity is empty, so the write
	// would land on disk, be reported as a success, and then read back as "not
	// disabled" — a toggle that silently does nothing, which is the single most
	// confusing failure this store can produce. Fail loudly instead so a caller
	// passing through a blank identity (an unparseable remote, a row rendered from
	// a degraded list) finds out at the write rather than at the next gate read.
	if (repoIdentity.length === 0) {
		throw new Error("Push-control identity must not be empty.");
	}
	// Resolve the dir once so the lock file and the store file are colocated
	// (and both honor a test-injected global dir).
	const dir = options.globalDir ?? getGlobalConfigDir();
	let recoveredFromCorrupt = false;
	let preservedAt: string | undefined;
	const write = async (): Promise<void> => {
		// Enabling ("allow this repo to push") must succeed even when the store is
		// corrupt/unreadable: it is the documented recovery (`jolli push-control
		// --enable`), so it cannot itself throw on a bad file. Fall back to an empty
		// set — that can only LOOSEN (drop opt-outs), never silently keep a repo
		// disabled the user just asked to allow. Disabling stays STRICT: a corrupt
		// store must fail rather than blow away other repos' opt-outs while ADDING a
		// restriction (fail-closed, consistent with the read gate).
		let current: Map<string, DisabledRepoEntry>;
		try {
			current = await loadEntries(dir);
		} catch (error) {
			if (disabled) throw error;
			// A newer-schema store is valid data, not garbage — rebuilding it would
			// destroy real opt-outs, so the enable-path recovery does NOT apply.
			if (error instanceof PushControlStoreTooNewError) throw error;
			// Rebuilding from empty drops EVERY other repo's opt-out, and this path is
			// one GUI checkbox click away — so move the unreadable file aside instead
			// of overwriting it, and report the fact so the caller can say so. Without
			// the copy the user's only record of which repos were opted out is gone;
			// without the flag the UI would print "Enabled ✓" over a silent reset.
			const path = getPushControlPath(dir);
			const backup = `${path}${CORRUPT_SUFFIX}${Date.now()}`;
			try {
				await rename(path, backup);
				preservedAt = backup;
			} catch (renameError) {
				// Best-effort: the rebuild must still proceed (the user asked to enable),
				// we just can't preserve the evidence. Say so in the log.
				log.warn(
					"setRepoPushDisabled: could not preserve the unreadable store at %s: %s",
					path,
					renameError instanceof Error ? renameError.message : String(renameError),
				);
			}
			log.warn(
				"setRepoPushDisabled: push-control store was unreadable (%s) — rebuilding from empty on the enable path; every other repo's opt-out is dropped%s",
				error instanceof Error ? error.message : String(error),
				preservedAt ? ` (previous file kept at ${preservedAt})` : "",
			);
			recoveredFromCorrupt = true;
			current = new Map();
		}
		if (disabled) {
			current.set(repoIdentity, {
				repo: deriveRepoNameFromUrl(repoIdentity),
				identity: repoIdentity,
				disabledAt: new Date().toISOString(),
				trigger: options.trigger ?? "",
			});
		} else {
			current.delete(repoIdentity);
		}
		// Code-point order, NOT localeCompare: this is the on-disk byte order, so it
		// must not depend on the ambient ICU locale (the display sort in
		// `listPushControlRepos` pins "en" for the same reason). Identities are also
		// case-sensitive keys — a collator with `sensitivity: "base"` would call two
		// distinct identities equal and leave their relative order unstable.
		const disabledList = [...current.values()].sort((a, b) =>
			a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0,
		);
		const file: PushControlFile = { version: PUSH_CONTROL_VERSION, disabled: disabledList };
		await atomicWriteFile(getPushControlPath(dir), `${JSON.stringify(file, null, "\t")}\n`);
	};
	const result = await withPushControlLock(write, { globalDir: dir });
	if (!result.acquired) await write(); // best-effort: never silently drop a toggle
	return { disabled, recoveredFromCorrupt, ...(preservedAt ? { preservedAt } : {}) };
}
