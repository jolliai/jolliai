/**
 * Pure path classifier for vault staging.
 *
 * `classifyVaultPath(relPath)` returns the kind of vault-owned content the
 * path represents, or `null` if the path is not a FolderStorage / RepoMapping
 * output. SyncEngine's `stageVault` uses this to decide which untracked /
 * modified paths to `git add -f` (allowlist staging) versus log as
 * `unowned` (canary signal that drift has happened).
 *
 * **Why a pure function** (not a method on `StorageProvider`):
 *
 * Earlier drafts of `sync-allowlist-staging.md` proposed putting `classifyPath`
 * on the storage interface and threading a `StorageProvider` instance into
 * `RoundState`. That broke down because `FolderStorage`'s constructor isn't
 * side-effect free — `createFolderStorage` → `resolveKBPath` creates
 * `<localFolder>/<repoFolder>/.jolli/` and writes a stub `config.json`
 * (StorageFactory.ts:64). Threading the instance into the round-context
 * builder would force engine construction to claim the KB path BEFORE
 * `fetchOrClone`, which `SyncBootstrap.ts:175` explicitly defers (otherwise
 * a fresh vault gets a phantom `<repo>-N` allocated against the wrong
 * identity).
 *
 * Keeping the classifier instance-free dodges that whole ordering trap. The
 * function knows nothing about disk state — given a POSIX-style relative
 * path it inspects the lexical shape and returns the kind.
 *
 * **Vault path layout** (from CLAUDE.md + Phase 0.1 audit):
 *
 *   <vaultRoot>/
 *   ├── .gitignore                              ← root-gitignore
 *   ├── .jolli/
 *   │   └── repos.json                          ← root-repos
 *   └── <repoFolder>/
 *       ├── .jolli/
 *       │   ├── config.json                     ← repo-config
 *       │   ├── index.json                      ← repo-index
 *       │   ├── manifest.json                   ← repo-manifest
 *       │   ├── branches.json                   ← repo-branches
 *       │   ├── catalog.json                    ← repo-catalog
 *       │   ├── migration.json                  ← repo-migration (MigrationEngine state)
 *       │   ├── shadow-status.json              ← REJECTED (per-device, never synced)
 *       │   ├── summaries/<hash>.json           ← summary
 *       │   ├── transcripts/<hash>.json         ← transcript (gated by syncTranscripts)
 *       │   ├── plans/<slug>.md                 ← plan (markdown, not JSON)
 *       │   ├── plan-progress/<slug>.json       ← plan-progress
 *       │   ├── notes/<id>.md                   ← note (markdown)
 *       │   └── graph/graph.json                ← graph (regenerable KB-graph data)
 *       └── <branch>/
 *           ├── <slug>-<hex8>.md                ← visible-summary
 *           ├── plan--<slug>.md                 ← visible-plan
 *           └── note--<id>.md                   ← visible-note
 *
 * **Intentionally NOT classified** (returns `null`):
 *
 *   - `.jolli/quarantine-summaries/...` (engine quarantine, locally gitignored)
 *   - `.jolli-quarantine-corrupt/...`   (engine quarantine, locally gitignored)
 *   - `<repoFolder>/.jolli/quarantine-symlinks/...` (legacy quarantine if any)
 *   - the global `~/.jolli/jollimemory/config.json` (lives outside the vault
 *     entirely; can't appear in `git status` here)
 *   - any path under `.git/`, `.git-rewrite/`, `.gitattributes`, IDE swap
 *     files (`*.swp`, `.DS_Store`, `Thumbs.db`), or anything else outside
 *     the catalogued patterns
 *
 * **Strictness policy** (matches sync-allowlist-staging.md §"Classifier
 * strictness policy"): patterns match the EXACT lexical shape FolderStorage
 * emits, not a loose extension match. A `<slug>-<hex8>.md` regex demands
 * 8 hex chars in the right place; a `summaries/<hash>.json` regex demands
 * 7-64 lowercase hex. Loose patterns turn the canary into noise; tight
 * patterns make drift loud.
 */

import type { OwnedPathKind } from "./OwnedPathKind.js";

export type { OwnedPathKind };

/**
 * Lexical grammars for the variable path segments. Exported so tests AND
 * the round-trip integration test in Phase 2 can build sample paths from
 * the same source of truth that classifyVaultPath uses to validate them.
 */

/** SHA-1 commit hash, lowercase hex, full 40 chars OR partial 7-64. */
export const HASH_FULL_RE = /^[0-9a-f]{40}$/;
/** Summary catalog allows partials per AllowList comment (line 13): 7–64 hex. */
export const HASH_PARTIAL_RE = /^[0-9a-f]{7,64}$/;
/** 8-char hex prefix used in visible-summary basenames. */
export const HASH8_RE = /^[0-9a-f]{8}$/;

/**
 * FolderStorage.slugify output: lowercase a-z0-9 and dashes, max 50 chars,
 * or the literal "untitled" fallback. Empty input also routes to "untitled".
 * Slug never starts or ends with `-` (slugify trims).
 */
export const SUMMARY_SLUG_RE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|untitled)$/;

/**
 * Plan / note ID grammar: more permissive than summary slugs because users
 * supply them via the registry. Allow `[A-Za-z0-9_.-]`, no leading dot or
 * dash, no `..` substring, length cap 200 (cosmetic — git path limit is
 * higher). This is the AllowList file-name policy.
 */
export const PLAN_NOTE_ID_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,200}$/;

/**
 * `<repoFolder>` and `<branch>` segments — accept any non-empty string of
 * filesystem-safe characters. The classifier's job here is "canary, not
 * prison": real git remote / branch names regularly include spaces, `+`,
 * `#`, `&`, `'`, parens, unicode letters, etc. — all of which `extractRepoName`
 * and `transcodeBranchName` preserve. Pre-relaxation the strict
 * `[A-Za-z0-9._-]` class fired a false-positive `unowned` canary for any
 * such name, masking real security signals.
 *
 * Rejects (in this regex AND duplicated as explicit checks at the top of
 * `classifyVaultPath` so a path-escape never reaches the classifier):
 *   - Path separators (`/` is the segment splitter; `\` rejected upstream).
 *   - ASCII NUL and control chars (0x00–0x1F, 0x7F) — these have no business
 *     in any filesystem path and `git status -z` would never emit them.
 *   - Leading `.` (would create a hidden file the engine never writes).
 *   - Leading `-` (could be mis-interpreted as a CLI flag downstream).
 *   - `..` substring (path traversal — also caught at the top of the
 *     classifier; duplicated here for defence-in-depth).
 *   - Trailing `.`, `-`, or whitespace (Windows-unfriendly + git refspec
 *     edge cases).
 *   - Length > 200 chars (cosmetic cap; the OS limit is higher).
 *
 * Everything else, including non-ASCII letters, is allowed. If a name slips
 * through here that the OS later rejects (very long, reserved Windows name
 * like `CON`, etc.), the eventual `git add -f` will fail loudly — the
 * classifier doesn't need to second-guess the filesystem.
 */
// Built via RegExp constructor with String.fromCharCode so the literal NUL
// and DEL bytes aren't in the source — sidesteps `noControlCharactersInRegex`
// without weakening the policy. Pattern semantics: reject leading
// dot/dash/whitespace, no `..` substring, reject any character class member
// from 0x00-0x1F + 0x7F + `/` + `\`, length 1-200, no trailing dot/dash/whitespace.
const SAFE_SEGMENT_RE = new RegExp(
	`^(?![.\\-\\s])(?!.*\\.\\.)[^${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}/\\\\]{1,200}(?<![.\\-\\s])$`,
);

/** Kept as the canonical name for callers; same regex as `<branch>`. */
export const REPO_FOLDER_RE = SAFE_SEGMENT_RE;

/** Kept as the canonical name for callers; same regex as `<repoFolder>`. */
export const BRANCH_FOLDER_RE = SAFE_SEGMENT_RE;

/**
 * Classify a POSIX-style forward-slash-separated relative path from the
 * vault root.
 *
 * Caller contract:
 *   - Forward slashes only. (`git status --porcelain -z` emits POSIX on
 *     every platform; if the caller has Windows-style `\` it must convert
 *     first.)
 *   - No leading `./` or `/`.
 *   - No `..` segments. `..` is a hard NO — classifier rejects with `null`.
 */
export function classifyVaultPath(relPath: string): OwnedPathKind | null {
	const strict = classifyStrict(relPath);
	if (strict !== null) return strict;
	// Fallthrough: any path that survives the structural rejects AND has
	// every segment passing `SAFE_SEGMENT_RE` is treated as `user-content`.
	// Covers acceptance fixtures (`<repo>/hello.md`, `<repo>/notes/a.md`),
	// legacy DB-migration content at root paths (`notes/hello.md`,
	// `cfg.json`), and any peer-committed file that doesn't match a
	// catalogue shape. `unowned` is reserved for paths that fail safety
	// (`..`, `\`, leading dot/dash, control chars, etc.) — those still
	// surface as drift signals.
	return classifyFallthrough(relPath);
}

function classifyStrict(relPath: string): OwnedPathKind | null {
	// Defensive rejects — caller passes garbage / hostile path.
	if (relPath.length === 0) return null;
	if (relPath.startsWith("/") || relPath.startsWith("./")) return null;
	if (relPath.includes("..")) return null;
	if (relPath.includes("\\")) return null; // POSIX only

	// Root-level files — only two are ever recognised by the strict
	// catalogue. (Other safe root-level paths fall through to
	// `user-content` — e.g. legacy-migration drops like `cfg.json`.)
	if (relPath === ".gitignore") return "root-gitignore";
	if (relPath === ".jolli/repos.json") return "root-repos";

	const segments = relPath.split("/");
	if (segments.length < 2) return null;

	const repoFolder = segments[0];
	if (repoFolder === undefined || !REPO_FOLDER_RE.test(repoFolder)) return null;

	// `<repoFolder>/.jolli/...` — per-repo aggregates + content directories.
	if (segments[1] === ".jolli") {
		if (segments.length === 3) {
			const file = segments[2];
			switch (file) {
				case "config.json":
					return "repo-config";
				case "index.json":
					return "repo-index";
				case "manifest.json":
					return "repo-manifest";
				case "branches.json":
					return "repo-branches";
				case "catalog.json":
					return "repo-catalog";
				case "migration.json":
					return "repo-migration";
				// `shadow-status.json` is per-device dirty-write recovery
				// state — NEVER synced. Returning null funnels it through
				// the `unowned` bucket → `stageVault` will `git rm --cached`
				// any stray index entry, and `MemoryBankBootstrap`'s
				// PER_DEVICE_JSON_GLOBS cleanup catches legacy committed
				// copies. The two halves are deliberately redundant: the
				// classifier reject blocks new writes, the bootstrap untrack
				// fixes old repos.
				case "shadow-status.json":
					return null;
				default:
					return null;
			}
		}
		if (segments.length === 4) {
			const dir = segments[2];
			const file = segments[3] ?? "";
			switch (dir) {
				case "summaries": {
					const base = stripExt(file, ".json");
					return base !== null && HASH_PARTIAL_RE.test(base) ? "summary" : null;
				}
				case "transcripts": {
					const base = stripExt(file, ".json");
					return base !== null && HASH_PARTIAL_RE.test(base) ? "transcript" : null;
				}
				case "plans": {
					const base = stripExt(file, ".md");
					return base !== null && PLAN_NOTE_ID_RE.test(base) ? "plan" : null;
				}
				case "plan-progress": {
					const base = stripExt(file, ".json");
					return base !== null && PLAN_NOTE_ID_RE.test(base) ? "plan-progress" : null;
				}
				case "notes": {
					const base = stripExt(file, ".md");
					return base !== null && PLAN_NOTE_ID_RE.test(base) ? "note" : null;
				}
				// `graph/graph.json` — the single regenerable knowledge-graph
				// data file (GraphArtifactStore writes exactly one file here).
				// Only that exact name classifies; any other leaf stays `null`
				// so the canary keeps its strictness.
				case "graph":
					return file === "graph.json" ? "graph" : null;
				default:
					return null;
			}
		}
		// Deeper nesting under `.jolli/` is not part of the catalogue —
		// quarantine subdirs and anything else. Return null so they
		// surface in the `unowned` canary if they ever appear.
		return null;
	}

	// `<repoFolder>/<branch>/<file>` — per-repo visible markdown.
	if (segments.length === 3) {
		const branch = segments[1];
		const file = segments[2];
		if (branch === undefined || file === undefined) return null;
		if (!BRANCH_FOLDER_RE.test(branch)) return null;

		// plan--<slug>.md
		if (file.startsWith("plan--") && file.endsWith(".md")) {
			const slug = file.slice("plan--".length, -".md".length);
			return PLAN_NOTE_ID_RE.test(slug) ? "visible-plan" : null;
		}
		// note--<id>.md
		if (file.startsWith("note--") && file.endsWith(".md")) {
			const id = file.slice("note--".length, -".md".length);
			return PLAN_NOTE_ID_RE.test(id) ? "visible-note" : null;
		}
		// <slug>-<hex8>.md
		if (file.endsWith(".md")) {
			const stem = file.slice(0, -".md".length);
			const dashIdx = stem.lastIndexOf("-");
			if (dashIdx <= 0 || dashIdx >= stem.length - 1) return null;
			const slug = stem.slice(0, dashIdx);
			const hex8 = stem.slice(dashIdx + 1);
			if (!HASH8_RE.test(hex8)) return null;
			if (!SUMMARY_SLUG_RE.test(slug)) return null;
			return "visible-summary";
		}
		return null;
	}

	return null;
}

/**
 * Fallthrough classifier for paths that don't match a catalogue shape but
 * are still safe enough to stage. Returns `"user-content"` iff:
 *
 *   - The path passes the same structural rejects as the strict pass
 *     (`..`, leading `/` or `./`, backslash, empty).
 *   - Every segment passes `SAFE_SEGMENT_RE` (no leading dot/dash/space,
 *     no control chars, length 1-200, no trailing dot/dash/space).
 *
 * Returns `null` otherwise — and those paths surface in `stageVault`'s
 * `unowned` canary as before. The net effect: junk like `.DS_Store`,
 * `.vscode/`, `.idea/`, or any path containing `..` is still rejected
 * (the leading-`.` rule in `SAFE_SEGMENT_RE` catches the hidden-file
 * cases without an extension blocklist), while ordinary user files
 * (`hello.md`, `notes/a.md`, `cfg.json`) are accepted.
 */
function classifyFallthrough(relPath: string): OwnedPathKind | null {
	if (relPath.length === 0) return null;
	if (relPath.startsWith("/") || relPath.startsWith("./")) return null;
	if (relPath.includes("..")) return null;
	if (relPath.includes("\\")) return null;
	const segments = relPath.split("/");
	for (const seg of segments) {
		if (!SAFE_SEGMENT_RE.test(seg)) return null;
	}
	// Per-device JSON still must NEVER sync, even though the segments are
	// "safe" — `<repo>/.jolli/...` is rejected by the leading-dot check on
	// `.jolli`, so this guard is currently redundant, but stays as a
	// defence-in-depth pin so a future relaxation of `SAFE_SEGMENT_RE`
	// (e.g. allowing leading dot) doesn't accidentally start syncing
	// shadow state.
	const leaf = segments[segments.length - 1];
	if (leaf === "shadow-status.json") return null;
	return "user-content";
}

/**
 * Returns `base` with `ext` stripped, or `null` if `name` doesn't end with
 * `ext`. Used so callers can early-exit on extension mismatch before
 * regex testing the bare hash/slug part.
 */
function stripExt(name: string, ext: string): string | null {
	return name.endsWith(ext) ? name.slice(0, -ext.length) : null;
}
