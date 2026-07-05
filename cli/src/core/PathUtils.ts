/**
 * Shared path utilities used across the CLI hook pipeline and the VS Code
 * extension. The extension inline-bundles `cli/src/**` at esbuild time (see
 * CLAUDE.md "VS Code extension bundles the CLI"), so importing this module
 * from `vscode/src/**` via the relative path is supported by design.
 */

/**
 * Normalizes a filesystem path for equality comparison.
 *
 * Handles three sources of spurious inequality:
 *   1. Mixed separators (`\` vs `/`) — Windows freely mixes both.
 *   2. Case differences — Windows and macOS (default APFS) filesystems are
 *      case-insensitive, so `C:\Users` and `c:\users` refer to the same file.
 *   3. Trailing slashes.
 *
 * Deliberately does NOT call `path.resolve` because on Windows, POSIX-absolute
 * paths like `/home/user/foo.md` (which Claude transcripts can produce when
 * running under WSL or via cross-platform tooling) are treated as relative and
 * resolved against the runtime cwd. All callers pass absolute paths, so
 * separator + case normalization is sufficient.
 *
 * NOT resolved: symlinks and `..` segments. `realpath` would require extra I/O
 * and could mask legitimate upgrades if either endpoint is a stale symlink.
 */
export function normalizePathForCompare(p: string): string {
	const unified = stripTrailingSlashes(p.replace(/\\/g, "/"));
	return process.platform === "win32" || process.platform === "darwin" ? unified.toLowerCase() : unified;
}

/**
 * Removes any trailing `/` characters from a forward-slash path.
 *
 * Uses a bounded loop rather than the obvious `s.replace(/\/+$/, "")`. That
 * regex is linear-time in practice, but its unbounded `+` quantifier anchored
 * at `$` trips CodeQL's `js/polynomial-redos` rule whenever the input is
 * library-controlled (e.g. a git remote URL). The loop form is provably O(n)
 * and carries no such flag, so it is the canonical way to strip trailing
 * slashes across the CLI — do NOT reintroduce the `/\/+$/` regex on untrusted
 * input. Backslashes are not handled here; convert with {@link toForwardSlash}
 * first if the input may contain them.
 */
export function stripTrailingSlashes(p: string): string {
	let end = p.length;
	while (end > 0 && p[end - 1] === "/") end--;
	return end === p.length ? p : p.slice(0, end);
}

/**
 * Returns true iff `child` is `parent` itself or a path nested inside it.
 *
 * Both endpoints run through {@link normalizePathForCompare} (separator + case
 * folding on Windows/macOS), then a directory-boundary check so that
 * `.jolli/jollimemoryX` is NOT treated as inside `.jolli/jollimemory`.
 *
 * Used to decide whether a registry entry's `sourcePath` lives inside the
 * per-project `.jolli/jollimemory/` directory: hard-delete the backing file
 * only for inside paths; external files (e.g. `~/.claude/plans/foo.md`) keep
 * their file and lose only the registry row. Like `normalizePathForCompare`
 * it does NOT call `path.resolve` (WSL POSIX-absolute rationale) — callers
 * pass absolute paths.
 */
export function isPathInside(child: string, parent: string): boolean {
	const c = normalizePathForCompare(child);
	const p = normalizePathForCompare(parent);
	return c === p || c.startsWith(`${p}/`);
}

/**
 * Converts a filesystem path to forward-slash form (POSIX-style).
 *
 * Single-purpose helper: replaces `\` with `/`, does NOT touch case, does NOT
 * strip trailing slashes, does NOT resolve `..`. Use this when the path will
 * be matched against a forward-slash literal (regex, string prefix, sidebar
 * key, manifest entry), so the matcher does not have to know the host OS.
 *
 * Why a dedicated helper instead of inlining `.replace(/\\/g, "/")`:
 *   - The repo accumulated 15+ private copies of that one-liner; a shared
 *     name makes the intent ("normalize for forward-slash matching") explicit
 *     and gives a single grep target if the contract ever needs to change.
 *   - {@link normalizePathForCompare} also strips trailing slashes AND lower-
 *     cases on case-insensitive platforms, so it must NOT be used here — both
 *     side-effects would corrupt the path before downstream consumers (e.g.
 *     `getTranscriptHashes`, manifest map values) see it.
 *
 * Real-world bug this prevents: `FolderStorage.walkDir` once returned
 * `transcripts\<hash>.json` on Windows, which broke every downstream regex
 * that hard-coded `transcripts/`. Forcing all path emitters through this
 * helper turns the contract into a single grep + a single function body.
 */
export function toForwardSlash(p: string): string {
	return p.replace(/\\/g, "/");
}
