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
	let unified = p.replace(/\\/g, "/");
	// Strip trailing slashes via a bounded loop rather than `/\/+$/`. The regex
	// is linear-time, but CodeQL flags any unbounded quantifier on input as a
	// polynomial-regex risk; the loop form removes the false positive.
	let end = unified.length;
	while (end > 0 && unified[end - 1] === "/") end--;
	if (end !== unified.length) unified = unified.slice(0, end);
	return process.platform === "win32" || process.platform === "darwin" ? unified.toLowerCase() : unified;
}
