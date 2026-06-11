/**
 * Vault-side `repoIdentity → folder` directory.
 *
 * Lives at `<memoryBankRoot>/.jolli/repos.json` and records, for cross-device
 * visibility, which subdirectory a given source repo's content lives in.
 *
 * **Local disk is authoritative.** `KBPathResolver.resolveKBPath()` is the
 * sole authority for which folder FolderStorage writes to (including any
 * `-N` legacy collision suffix). The sync engine reads that pick via
 * `defaultResolveContext` and records it in `repos.json` so peer devices
 * see the mapping after `git pull`. `repos.json` does NOT unilaterally
 * rename folders during allocation — that would produce a record that
 * disagrees with the on-disk layout.
 *
 * Resolution flow per sync round:
 *
 *   1. After `clone`/`fetch`, read `<memoryBankRoot>/.jolli/repos.json` (may be
 *      missing on a brand-new vault — treat as empty).
 *   2. Look up the current `repoIdentity`. If present → use the stored
 *      folder. If absent → record the caller-supplied `desiredFolder`
 *      (which is the basename of `KBPathResolver.resolveKBPath()`).
 *   3. If `repos.json` changed, the engine writes it into the working tree
 *      so it ships in the round's `stageVault` + commit.
 *   4. Concurrent edits across devices are reconciled by `mergeRepoMapping`
 *      (dedupe by `repoIdentity`). Folder collisions across different
 *      identities are detected and reported via `findRepoMappingConflicts`,
 *      not auto-renamed — the engine surfaces them to the user (warning
 *      notification in VS Code) for manual disambiguation (P2#3).
 */

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalizeRepoIdentity, repoIdentityFromConfig } from "./RepoIdentity.js";

/** A single `repoIdentity → folder` mapping row. */
export interface RepoMappingEntry {
	readonly repoIdentity: string;
	readonly folder: string;
}

/** Shape of `<memoryBankRoot>/.jolli/repos.json`. */
export interface RepoMappingFile {
	readonly version: 1;
	readonly mappings: ReadonlyArray<RepoMappingEntry>;
}

/** Vault-relative path to the mapping file. */
export const REPO_MAPPING_PATH = ".jolli/repos.json";

/** Empty mapping — caller uses this as the starting state on a fresh vault. */
export function emptyMapping(): RepoMappingFile {
	return { version: 1, mappings: [] };
}

/**
 * Reads `<memoryBankRoot>/.jolli/repos.json` if it exists. Returns an empty
 * mapping for missing / unparseable files (and logs at the call site for the
 * unparseable case — we never crash a round on a corrupted mapping).
 */
export async function loadRepoMapping(memoryBankRoot: string): Promise<RepoMappingFile> {
	const path = join(memoryBankRoot, REPO_MAPPING_PATH);
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return emptyMapping();
	}
	const parsed = parseRepoMapping(raw);
	return parsed ?? emptyMapping();
}

/** Parses an in-memory string into a `RepoMappingFile`, or null on garbage. */
export function parseRepoMapping(raw: string): RepoMappingFile | null {
	try {
		const doc = JSON.parse(raw) as Partial<RepoMappingFile>;
		if (doc.version !== 1) return null;
		if (!Array.isArray(doc.mappings)) return null;
		const cleaned: RepoMappingEntry[] = [];
		for (const m of doc.mappings) {
			if (typeof m?.repoIdentity !== "string") return null;
			if (typeof m.folder !== "string") return null;
			cleaned.push({ repoIdentity: m.repoIdentity, folder: m.folder });
		}
		return { version: 1, mappings: cleaned };
	} catch {
		return null;
	}
}

/** Serializes to the canonical 2-space-indented JSON + trailing newline. */
export function serializeRepoMapping(mapping: RepoMappingFile): string {
	return `${JSON.stringify(mapping, null, 2)}\n`;
}

/**
 * Re-normalizes every row's `repoIdentity` through `canonicalizeRepoIdentity`
 * and collapses rows that fold to the same identity. Heals files written
 * before SSH→https transport folding: the same repo reached via
 * `git@github.com:owner/repo` on one device and `https://github.com/owner/repo`
 * on another got two rows, typically both claiming the same folder — which
 * `findRepoMappingConflicts` then mis-reported as a cross-repo folder
 * collision. When collapsing rows disagree on `folder`, the later row in
 * file order wins — arbitrary but deterministic, and the affected repo's
 * own sync round rewrites the row to the authoritative `KBPathResolver`
 * pick on its next pass anyway (`resolveOrAssignFolder` case 3).
 *
 * Returns the original `mapping` object with `changed: false` when every
 * row was already canonical, so callers can skip the persist (and the
 * commit/push) on steady-state rounds.
 */
export function canonicalizeRepoMapping(mapping: RepoMappingFile): {
	readonly merged: RepoMappingFile;
	readonly changed: boolean;
} {
	const byIdentity = new Map<string, RepoMappingEntry>();
	let changed = false;
	for (const m of mapping.mappings) {
		const identity = canonicalizeRepoIdentity(m.repoIdentity);
		if (identity !== m.repoIdentity || byIdentity.has(identity)) changed = true;
		byIdentity.set(identity, identity === m.repoIdentity ? m : { repoIdentity: identity, folder: m.folder });
	}
	if (!changed) return { merged: mapping, changed: false };
	/* v8 ignore start -- comparator equal-branch (`: 0`) is unreachable: `byIdentity` keys are unique canonical identities */
	const mappings = [...byIdentity.values()].sort((a, b) =>
		a.repoIdentity < b.repoIdentity ? -1 : a.repoIdentity > b.repoIdentity ? 1 : 0,
	);
	/* v8 ignore stop */
	return { merged: { version: 1, mappings }, changed: true };
}

/**
 * Resolves the vault folder for `repoIdentity`. Three cases:
 *
 *   1. No mapping exists → record `args.authoritativeFolder` as the new
 *      mapping for the caller to persist.
 *   2. Mapping exists and matches `args.authoritativeFolder` → return the
 *      stored folder with `updatedMapping: null` (no write needed).
 *   3. Mapping exists but points to a DIFFERENT folder than the local
 *      `KBPathResolver` just picked (cross-device divergence) → **rewrite
 *      the mapping in place to `args.authoritativeFolder`** so `repos.json`
 *      reflects the disk layout this device will actually push.
 *
 * **`args.authoritativeFolder` is authoritative**: callers MUST pass the
 * folder name FolderStorage will actually write to on disk (i.e.
 * `KBPathResolver`'s pick, including any local `-N` legacy suffix). Earlier
 * versions of this function unilaterally reassigned colliding slugs to
 * `<slug>-<hash6>`, which produced a `repos.json` claim that didn't match
 * the actual disk layout — case 3 above is the same hazard re-emerging from
 * a different angle: another device's mapping leaks in via `repos.json` and
 * the engine used to silently honor it even though THIS device's
 * `KBPathResolver` had already committed to a different on-disk folder
 * (e.g. `<slug>-2` because `<slug>` was claimed locally by another repo).
 * Returning the stored folder unchanged left `repos.json` and the disk
 * layout split: FolderStorage kept writing to `<slug>-2`, the engine pushed
 * a working tree containing `<slug>-2/`, but `repos.json` still pointed at
 * `<slug>` — peers pulling that round saw both folders coexist. The
 * cross-device folder collision across different identities still surfaces
 * the same way (via `findRepoMappingConflicts`, P2#3) once both devices
 * push their authoritative mappings: same folder will be claimed by both
 * identities and the user gets a notification to rename one side.
 *
 * Args are an object literal (not positionals) on purpose: a prior signature
 * had a positional `desiredFolder` that looked interchangeable with the
 * earlier "suggested slug" semantics, and the IntelliJ Kotlin port shipped
 * a positional binding that would have silently kept the old "suggest, then
 * hash-suffix-collide-resolve" behavior. The object form forces every
 * out-of-tree consumer to update their call sites when the semantics change.
 */
export function resolveOrAssignFolder(
	mapping: RepoMappingFile,
	args: { repoIdentity: string; authoritativeFolder: string },
): { folder: string; updatedMapping: RepoMappingFile | null } {
	const existing = mapping.mappings.find((m) => m.repoIdentity === args.repoIdentity);
	if (existing) {
		if (existing.folder === args.authoritativeFolder) {
			return { folder: existing.folder, updatedMapping: null };
		}
		const updatedMapping: RepoMappingFile = {
			version: 1,
			mappings: mapping.mappings.map((m) =>
				m.repoIdentity === args.repoIdentity ? { ...m, folder: args.authoritativeFolder } : m,
			),
		};
		return { folder: args.authoritativeFolder, updatedMapping };
	}

	const updatedMapping: RepoMappingFile = {
		version: 1,
		mappings: [...mapping.mappings, { repoIdentity: args.repoIdentity, folder: args.authoritativeFolder }],
	};
	return { folder: args.authoritativeFolder, updatedMapping };
}

/**
 * Describes a folder claimed by two or more `repoIdentity` values after
 * merging local + remote `repos.json`. Surfaced so the engine can notify
 * the user to manually disambiguate — content can't be safely moved by
 * the engine alone because FolderStorage's on-disk layout is driven by
 * `KBPathResolver` (which doesn't read `repos.json`).
 */
export interface RepoMappingConflict {
	readonly folder: string;
	readonly identities: ReadonlyArray<string>;
}

/**
 * Tier 1.5 merge for `repos.json`. Dedupe by `repoIdentity` (union; ties
 * resolved last-write-wins favouring remote). Folder collisions across
 * different identities are **detected but not silently renamed** —
 * previous versions auto-reassigned the loser to `<folder>-<hash6>`, but
 * with the mirror step removed nothing actually moves the on-disk
 * content, so the renamed mapping pointed at an empty directory while
 * real content stayed at the bare name. That divergence is worse than
 * a transient duplicate. The current behavior:
 *
 *   - Both identities keep their original `folder` claim in the merged
 *     output (no rename).
 *   - The conflict is reported back via the return shape; callers
 *     surface it to the user (status bar + UI notification in VS Code,
 *     log warning in CLI) so they can manually rename one side's source
 *     repo or `localFolder` to disambiguate.
 *
 * Cross-device first-bind races on the same `<slug>` (e.g. `alice/foo`
 * vs `bob/foo` on different hosts) are the typical trigger; rare in
 * practice and the warning + manual fix is acceptable.
 *
 * Rows from both sides are canonicalized (`canonicalizeRepoIdentity`) as
 * they enter the union, so an SSH-style row pushed by an older client
 * folds into this client's https-style row for the same repo instead of
 * surviving the merge as a duplicate.
 */
export function mergeRepoMapping(
	local: RepoMappingFile,
	remote: RepoMappingFile,
): { readonly merged: RepoMappingFile; readonly conflicts: ReadonlyArray<RepoMappingConflict> } {
	// First pass: union by canonical repoIdentity (last-write-wins; remote overrides).
	const byIdentity = new Map<string, RepoMappingEntry>();
	for (const m of [...local.mappings, ...remote.mappings]) {
		const identity = canonicalizeRepoIdentity(m.repoIdentity);
		byIdentity.set(identity, identity === m.repoIdentity ? m : { repoIdentity: identity, folder: m.folder });
	}

	// Second pass: detect folder collisions across different identities.
	// Report each colliding folder once; entries themselves are left
	// untouched in `byIdentity`.
	const byFolder = new Map<string, RepoMappingEntry[]>();
	for (const m of byIdentity.values()) {
		const list = byFolder.get(m.folder) ?? [];
		list.push(m);
		byFolder.set(m.folder, list);
	}
	const conflicts: RepoMappingConflict[] = [];
	for (const [folder, entries] of byFolder) {
		if (entries.length <= 1) continue;
		/* v8 ignore start -- equal-case tail (`: 0`) is unreachable: each entry comes from the conflict-set Map whose keys are already unique repoIdentity strings */
		const identities = entries.map((e) => e.repoIdentity).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		/* v8 ignore stop */
		conflicts.push({ folder, identities });
	}

	// Stable output: sort by repoIdentity for byte-stable JSON across devices.
	/* v8 ignore start -- same equal-branch rationale: `byIdentity` is a Map keyed by repoIdentity so duplicate identities can't appear in the sort */
	const merged = [...byIdentity.values()].sort((a, b) =>
		a.repoIdentity < b.repoIdentity ? -1 : a.repoIdentity > b.repoIdentity ? 1 : 0,
	);
	/* v8 ignore stop */
	return { merged: { version: 1, mappings: merged }, conflicts };
}

/**
 * Returns every folder claimed by 2+ different `repoIdentity` values in
 * `mapping`. Engine calls this after `loadRepoMapping` so it can surface
 * cross-device first-bind collisions to the UI (P2#3 fix).
 *
 * Exported separately from `mergeRepoMapping` so callers that hold a
 * fully-written `repos.json` (e.g. after pull-rebase has integrated the
 * merge) can still introspect for conflicts without re-running a merge.
 */
export function findRepoMappingConflicts(mapping: RepoMappingFile): ReadonlyArray<RepoMappingConflict> {
	const byFolder = new Map<string, RepoMappingEntry[]>();
	for (const m of mapping.mappings) {
		const list = byFolder.get(m.folder) ?? [];
		list.push(m);
		byFolder.set(m.folder, list);
	}
	const conflicts: RepoMappingConflict[] = [];
	for (const [folder, entries] of byFolder) {
		if (entries.length <= 1) continue;
		/* v8 ignore start -- same equal-branch rationale as `mergeRepoMapping`'s sorts */
		const identities = entries.map((e) => e.repoIdentity).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		/* v8 ignore stop */
		conflicts.push({ folder, identities });
	}
	return conflicts;
}

/**
 * Writes `<memoryBankRoot>/.jolli/repos.json`. Creates the parent dir if needed
 * (e.g. when the vault has just been cloned and `.jolli/` doesn't exist yet).
 */
export async function saveRepoMapping(memoryBankRoot: string, mapping: RepoMappingFile): Promise<void> {
	const path = join(memoryBankRoot, REPO_MAPPING_PATH);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, serializeRepoMapping(mapping));
}

/** One on-disk Memory Bank repo folder paired with the identity its config carries. */
export interface ScannedFolderIdentity {
	readonly identity: string;
	readonly folder: string;
}

/**
 * Scans `<memoryBankRoot>` for repo folders and derives each one's
 * `repoIdentity` from its persisted `<folder>/.jolli/config.json`.
 *
 * Used by the reconcile pass (`reconcileMappingAdditive`) so `repos.json` can
 * be brought in line with the folders that actually exist on disk — the live
 * sync round only ever writes the row for the repo it is syncing, so a folder
 * whose own first-bind round never reached the mapping-write step stays absent
 * from `repos.json` indefinitely.
 *
 * Skips:
 *   - non-directories
 *   - dot-prefixed entries (`.jolli`, `.git`, `.jolli-bootstrap-stash`, …)
 *   - folders with no readable / parseable `config.json`
 *   - folders whose config carries no derivable identity (neither `remoteUrl`
 *     nor `repoName` — e.g. an identity-stripped archive stub)
 *
 * Returns an empty list (never throws) when `memoryBankRoot` can't be read.
 */
export async function scanFolderIdentities(memoryBankRoot: string): Promise<ScannedFolderIdentity[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(memoryBankRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: ScannedFolderIdentity[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith(".")) continue;
		const configPath = join(memoryBankRoot, entry.name, ".jolli", "config.json");
		let raw: string;
		try {
			raw = await readFile(configPath, "utf-8");
		} catch {
			continue;
		}
		let parsed: { remoteUrl?: unknown; repoName?: unknown };
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		const identity = repoIdentityFromConfig({
			remoteUrl: typeof parsed.remoteUrl === "string" ? parsed.remoteUrl : undefined,
			repoName: typeof parsed.repoName === "string" ? parsed.repoName : undefined,
		});
		if (identity === null) continue;
		out.push({ identity, folder: entry.name });
	}
	return out;
}

/**
 * Brings `mapping` in line with the on-disk folders reported by
 * `scanFolderIdentities` — **additively**:
 *
 *   - Adds a row for every scanned identity that isn't already mapped.
 *   - **Never removes** an existing row. `repos.json` is shared across devices
 *     and clones via git, so a row pointing at a folder absent on THIS device
 *     may belong to a peer — dropping it would corrupt the shared index.
 *   - **Skips identities backed by more than one local folder.** The
 *     migrate-to-fresh-folder flow leaves the old and new `<repo>` /
 *     `<repo>-N` folders sharing one `remoteUrl` (hence one identity); guessing
 *     a row here could point `repos.json` at the stale folder while
 *     FolderStorage writes the new one — the exact mapping↔disk split that
 *     `resolveOrAssignFolder` (with the authoritative `KBPathResolver` pick)
 *     avoids. Those repos are left to their own round's authoritative path.
 *
 * Returns `{ merged, changed: false }` with the original mapping object when
 * nothing was added, so callers can skip the write (and the commit/push) on the
 * steady-state no-op rounds.
 */
export function reconcileMappingAdditive(
	mapping: RepoMappingFile,
	scanned: ReadonlyArray<ScannedFolderIdentity>,
): { readonly merged: RepoMappingFile; readonly changed: boolean } {
	const folderCountByIdentity = new Map<string, number>();
	for (const s of scanned) {
		folderCountByIdentity.set(s.identity, (folderCountByIdentity.get(s.identity) ?? 0) + 1);
	}
	const ambiguous = new Set<string>();
	for (const [identity, count] of folderCountByIdentity) {
		if (count > 1) ambiguous.add(identity);
	}
	const present = new Set(mapping.mappings.map((m) => m.repoIdentity));
	const additions: RepoMappingEntry[] = [];
	for (const s of scanned) {
		if (present.has(s.identity)) continue;
		if (ambiguous.has(s.identity)) continue;
		additions.push({ repoIdentity: s.identity, folder: s.folder });
		// Treat as present so a duplicate scan entry (same identity, ruled in
		// above) can't add the row twice.
		present.add(s.identity);
	}
	if (additions.length === 0) return { merged: mapping, changed: false };
	/* v8 ignore start -- comparator equal-branch (`: 0`) is unreachable: rows are deduped by repoIdentity above */
	const mappings = [...mapping.mappings, ...additions].sort((a, b) =>
		a.repoIdentity < b.repoIdentity ? -1 : a.repoIdentity > b.repoIdentity ? 1 : 0,
	);
	/* v8 ignore stop */
	return { merged: { version: 1, mappings }, changed: true };
}
