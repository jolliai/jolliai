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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
 */
export function mergeRepoMapping(
	local: RepoMappingFile,
	remote: RepoMappingFile,
): { readonly merged: RepoMappingFile; readonly conflicts: ReadonlyArray<RepoMappingConflict> } {
	// First pass: union by repoIdentity (last-write-wins; remote overrides).
	const byIdentity = new Map<string, RepoMappingEntry>();
	for (const m of local.mappings) byIdentity.set(m.repoIdentity, m);
	for (const m of remote.mappings) byIdentity.set(m.repoIdentity, m);

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
