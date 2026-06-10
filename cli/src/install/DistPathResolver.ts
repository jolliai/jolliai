/**
 * DistPathResolver — Per-source dist-path resolution.
 *
 * Each install source (CLI, VS Code, Cursor, Windsurf, etc.) writes its own
 * `~/.jolli/jollimemory/dist-paths/<source>` file. Runtime selection (which
 * source actually runs hooks) is done by the `run-hook` shell script
 * at hook trigger time — picks the highest version whose dist dir exists.
 *
 * This module provides:
 *   - `deriveSourceTag()` — derives a stable source tag from an install path
 *   - `readDistPathInfo()` — parses both new (`dist-paths/<source>`, 2-line)
 *     and legacy (`dist-path`, `source=xxx@ver`) formats
 *   - `traverseDistPaths()` — enumerates all dist-paths/ entries with
 *     availability info
 *   - `pickBestDistPath()` — picks the highest-version available entry
 *   - `compareSemver()` — strict numeric semver comparison (dev/unknown rank lowest)
 *   - `installDistPath()` — writes a per-source `dist-paths/<source>` file
 *   - `migrateLegacyDistPath()` — one-time migration of old `dist-path` single
 *     file to the new `dist-paths/<derived-tag>` form
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { coerce as semverCoerce, compare as semverCompare, valid as semverValid } from "semver";
import { createLogger } from "../Logger.js";
import type { DistPathInfo } from "../Types.js";
import { installDistPath } from "./DistPathWriter.js";

const log = createLogger("DistPathResolver");

/**
 * Known IDE markers — provides stability for popular IDEs by mapping their
 * extension install path to a canonical source tag. The allowlist exists so
 * that path variants (e.g. some IDEs ship multiple extension dirs) collapse to
 * one consistent tag.
 *
 * Order matters: more specific patterns must come first (e.g. `.vscode-oss`
 * before `.vscode`).
 */
const KNOWN_IDE_MARKERS: ReadonlyArray<readonly [pattern: string, tag: string]> = [
	[".cursor/", "cursor"],
	[".windsurf/", "windsurf"],
	[".antigravity/", "antigravity"],
	[".vscode-oss/", "vscodium"],
	[".positron/", "positron"],
	[".trae/", "trae"],
	[".vscode/", "vscode"], // last to avoid matching .vscode-oss
];

/**
 * Derives a stable source tag from an extension installation path.
 *
 * Strategy:
 *   1. Match against known IDE allowlist (stable, handles aliases)
 *   2. Extract from `~/.<ide-name>/extensions/` pattern (auto-supports new IDEs)
 *   3. Hash fallback for non-standard paths (e.g. system-wide installs)
 *
 * Examples:
 *   ~/.vscode/extensions/jolli.../dist      -> "vscode"      (allowlist)
 *   ~/.cursor/extensions/jolli.../dist      -> "cursor"      (allowlist)
 *   ~/.newide/extensions/jolli.../dist      -> "newide"      (auto-extract)
 *   /opt/custom/path/dist                   -> "a1b2c3d4"    (hash fallback)
 */
export function deriveSourceTag(extensionPath: string): string {
	const normalized = extensionPath.replace(/\\/g, "/");

	for (const [marker, tag] of KNOWN_IDE_MARKERS) {
		if (normalized.includes(marker)) return tag;
	}

	const match = normalized.match(/\/\.([a-z][a-z0-9-]*)\/extensions\//i);
	if (match?.[1]) return match[1].toLowerCase();

	return createHash("sha256").update(extensionPath).digest("hex").slice(0, 8);
}

// ─── File I/O ────────────────────────────────────────────────────────────────

/**
 * Parses a dist-path or dist-paths/<source> file.
 *
 * Supports two formats:
 *   - **New** (`dist-paths/<source>`, 2 lines): `<version>\n<absolute-path>`
 *     The source tag comes from the filename; not duplicated inside the file.
 *   - **Legacy** (`dist-path`, 2 lines): `source=<tag>@<version>\n<absolute-path>`
 *     Also supports `source=<tag>` (no version) for backward compat.
 *
 * Returns null if the file doesn't exist, is empty, or has unparseable structure.
 */
export function readDistPathInfo(filePath: string): { source: string; version: string; distDir: string } | null {
	try {
		const content = readFileSync(filePath, "utf-8").trim();
		const lines = content.split("\n").map((l) => l.trim());
		if (lines.length < 2) return null;

		const firstLine = lines[0];
		const distDir = lines[lines.length - 1];
		/* v8 ignore start -- defensive: unreachable after outer .trim() strips trailing empty lines */
		if (!distDir) return null;
		/* v8 ignore stop */

		// Legacy format: `source=tag@ver` or `source=tag`
		if (firstLine.startsWith("source=")) {
			const sourceValue = firstLine.slice("source=".length);
			const atIdx = sourceValue.indexOf("@");
			if (atIdx === -1) {
				return { source: sourceValue, version: "unknown", distDir };
			}
			return {
				source: sourceValue.slice(0, atIdx),
				version: sourceValue.slice(atIdx + 1),
				distDir,
			};
		}

		// New format (dist-paths/<source>): line 1 = version, line 2 = path.
		// Source tag is supplied externally (filename), so `source` is "" here.
		return { source: "", version: firstLine, distDir };
	} catch {
		return null;
	}
}

/**
 * Enumerates all entries in `~/.jolli/jollimemory/dist-paths/`.
 * Returns one DistPathInfo per file, including stale entries (path no longer
 * exists). Callers filter by `.available` as needed.
 */
export function traverseDistPaths(globalDir?: string): DistPathInfo[] {
	const dir = join(globalDir ?? join(homedir(), ".jolli", "jollimemory"), "dist-paths");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}

	const results: DistPathInfo[] = [];
	for (const name of names) {
		const filePath = join(dir, name);
		const parsed = readDistPathInfo(filePath);
		if (!parsed) continue;
		// In dist-paths/ files, source comes from the filename.
		results.push({
			source: name,
			version: parsed.version,
			distDir: parsed.distDir,
			available: existsSync(parsed.distDir),
		});
	}
	return results;
}

// ─── Version comparison ──────────────────────────────────────────────────────

/**
 * Compares two version strings for dist-path selection. Returns:
 *   > 0 if a > b
 *   < 0 if a < b
 *   0   if a === b
 *
 * Three tiers, in order:
 *   1. **Prerelease / build metadata** (`-rc.1`, `+build.5`): when either side
 *      carries such a tag, defer to the `semver` library for both-valid pairs
 *      so a prerelease sorts below its own release (`1.0.0-rc.1` < `1.0.0`) yet
 *      a newer prerelease still beats an older stable (`1.0.0-rc.1` > `0.99.0`)
 *      and build metadata is ignored. A valid semver string beats a non-semver
 *      sentinel (`dev`/`unknown`) on that tagged side.
 *   2. **Plain numeric** (`1.0`, `1.2.3`): loose dotted comparison, filling
 *      missing parts with 0 so `1.0` === `1.0.0`.
 *   3. **Non-numeric sentinels** (`dev`, `unknown`, ``): ranked lowest, two
 *      sentinels compare equal.
 *
 * Divergence from the shell side: `resolve-dist-path` selects with `sort -V`,
 * which ranks `1.0.0-rc.1` ABOVE `1.0.0` (opposite of semver). Matching that in
 * POSIX sh would mean hand-rolling semver prerelease rules — not worth the risk
 * for the rare case of a release and its own prerelease both being registered.
 * This function is the in-process authority; the shell is a best-effort
 * approximation that agrees on every non-prerelease comparison.
 */
export function compareSemver(a: string, b: string): number {
	// Tier 1: prerelease/build metadata needs semver-aware ordering — the loose
	// numeric path below cannot order a `-rc.N` suffix.
	if (a.includes("-") || a.includes("+") || b.includes("-") || b.includes("+")) {
		// Normalize each side to a comparable semver string. A tagged side uses
		// its exact valid form (keeping the prerelease/build tag); a loose dotted
		// numeric like `1.0` is coerced to `1.0.0` so it can be ordered *against*
		// a tagged version (`1.0` > `1.0.0-rc.1`) instead of being mistaken for a
		// non-semver sentinel. Non-numeric sentinels (`dev`/`unknown`) stay null.
		const norm = (v: string): string | null => {
			const exact = semverValid(v);
			if (exact) return exact;
			return /^\d+(\.\d+)*$/.test(v) ? (semverCoerce(v)?.version ?? null) : null;
		};
		const aSem = norm(a);
		const bSem = norm(b);
		if (aSem && bSem) return semverCompare(aSem, bSem);
		if (aSem) return 1; // valid (pre)release beats a non-semver sentinel
		if (bSem) return -1;
		// Neither parses as semver → fall through to the numeric tier, where both
		// rank lowest and compare equal.
	}

	// Tier 2 + 3: loose numeric comparison; non-numeric sentinels rank lowest.
	const aValid = /^\d+(\.\d+)*$/.test(a);
	const bValid = /^\d+(\.\d+)*$/.test(b);
	if (!aValid && !bValid) return 0;
	if (!aValid) return -1;
	if (!bValid) return 1;

	const partsA = a.split(".").map(Number);
	const partsB = b.split(".").map(Number);
	for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
		const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Tie-break preference when multiple sources carry the SAME highest core version.
 * The bundled `@jolli.ai/cli` core is byte-for-byte the same logic at equal
 * versions, so this list only makes the winner DETERMINISTIC and favours the
 * canonical CLI build over an IDE-embedded copy. Sources not listed have no
 * defined order among themselves (the first-seen highest is kept).
 *
 * MUST stay in lockstep with the `for pref in …` list baked into the
 * `resolve-dist-path` shell script — DispatchScripts.ts imports this constant so
 * there is a single source of truth.
 */
export const SOURCE_PREFERENCE_ORDER: ReadonlyArray<string> = ["cli", "vscode", "cursor"];

/**
 * Picks the best entry from a dist-paths list:
 *   1. highest core version, **strict** greater-than (a tie never overwrites, so
 *      enumeration order can't decide a tie), then
 *   2. among sources tied at that version, the first in {@link SOURCE_PREFERENCE_ORDER}.
 * Returns undefined if the list is empty or no entries are available.
 */
export function pickBestDistPath(entries: ReadonlyArray<DistPathInfo>): DistPathInfo | undefined {
	const available = entries.filter((e) => e.available);
	if (available.length === 0) return undefined;
	let best = available[0];
	for (let i = 1; i < available.length; i++) {
		if (compareSemver(available[i].version, best.version) > 0) {
			best = available[i];
		}
	}
	// Tie-break: among the sources sharing the highest version, prefer cli > vscode
	// > cursor. Falls through to the first-seen highest when none are preferred.
	const tied = available.filter((e) => compareSemver(e.version, best.version) === 0);
	for (const pref of SOURCE_PREFERENCE_ORDER) {
		const match = tied.find((e) => e.source === pref);
		if (match) return match;
	}
	return best;
}

// ─── Simplified resolveDistPath ──────────────────────────────────────────────

/**
 * Result returned by the simplified `resolveDistPath()`.
 * Kept for backward compat with existing call sites; previously contained a
 * `candidates: DistPathCandidate[]` array used for version comparison.
 */
export interface ResolveResult {
	readonly distDir: string;
	readonly version: string;
	readonly source: string;
}

/**
 * Returns the caller's own dist info without collecting any candidates.
 *
 * Earlier revisions did "discover global npm install + caller's dist + pick
 * highest version". That responsibility moved to runtime: each source writes
 * its own `dist-paths/<source>` and the `run-hook` shell script picks
 * the best at hook-trigger time. Install-time selection is no longer needed.
 *
 * Kept as a thin shim so existing CLI/VSCode call sites can continue passing
 * the result to `installDistPath()` without restructuring.
 */
export async function resolveDistPath(
	_cwd: string,
	callerDistDir: string,
	callerSource: string,
): Promise<ResolveResult> {
	/* v8 ignore start -- compile-time ternary: __PKG_VERSION__ is always defined in bundled builds */
	const callerVersion = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";
	/* v8 ignore stop */
	return {
		distDir: callerDistDir,
		version: callerVersion,
		source: callerSource,
	};
}

// Re-export installDistPath so consumers that import from DistPathResolver
// continue to work. The actual implementation lives in DistPathWriter.ts.
export { installDistPath };

// ─── Legacy migration ────────────────────────────────────────────────────────

/**
 * One-time migration of the legacy `~/.jolli/jollimemory/dist-path` single file
 * into the new `~/.jolli/jollimemory/dist-paths/<derived-tag>` per-source format.
 *
 * Recovery rules for source tag:
 *   - Legacy `source=cli` → new tag `cli`
 *   - Legacy `source=vscode-extension` → derive real IDE from distDir path:
 *     - `~/.cursor/...` → `cursor`
 *     - `~/.windsurf/...` → `windsurf`
 *     - `~/.vscode/...` → `vscode`
 *     - unrecognized → `vscode` (fallback — most likely origin)
 *
 * After a successful migration the legacy `dist-path` file is **deleted** so
 * that future `install()` runs don't re-trigger migration on every invocation.
 *
 * Why it's safe to delete:
 *   - The current `resolve-dist-path` / `run-hook` / `run-cli` scripts no
 *     longer read `dist-path`; they enumerate `dist-paths/<source>` only.
 *   - Those scripts are rewritten by `installHookScripts()` earlier in the
 *     `install()` flow, so any caller reaching this function is already on
 *     the current scripts.
 *   - Rollback path: if the user reinstalls an older pre-registry version,
 *     its `installDistPath()` recreates the legacy `dist-path` file and
 *     overwrites the shell scripts back to their old `tail -1 dist-path`
 *     form — so the legacy format re-emerges organically, we don't need to
 *     preserve it here.
 *
 * Idempotent — running twice is a no-op the second time (legacy file is gone,
 * `readDistPathInfo()` returns null).
 *
 * @returns `true` if a migration occurred, `false` if no legacy file or already
 *   migrated. The caller can use this to log a one-shot informational message.
 */
export async function migrateLegacyDistPath(): Promise<boolean> {
	const globalDir = join(homedir(), ".jolli", "jollimemory");
	const legacyPath = join(globalDir, "dist-path");
	const info = readDistPathInfo(legacyPath);
	if (!info) return false;

	let derivedTag: string;
	if (info.source === "cli") {
		derivedTag = "cli";
	} else {
		// info.source is "vscode-extension" or any other legacy value
		const candidate = deriveSourceTag(info.distDir);
		// If derive returned a hash (no IDE pattern matched), fall back to "vscode"
		// since that's overwhelmingly the original source for vscode-extension installs.
		derivedTag = /^[a-f0-9]{8}$/.test(candidate) ? "vscode" : candidate;
	}

	/* v8 ignore start -- defensive: deriveSourceTag never returns "vscode-extension"
	   (the legacy tag isn't in KNOWN_IDE_MARKERS or the auto-extract pattern). Kept as
	   a paranoid guard against future changes that might accidentally surface it. */
	if (derivedTag === "vscode-extension") {
		derivedTag = "vscode";
	}
	/* v8 ignore stop */

	await installDistPath(derivedTag, info.distDir, info.version);

	// Delete the legacy file now that its content lives in dist-paths/<derived>.
	// See JSDoc above for the safety argument (current scripts ignore it; rollback
	// reinstall would recreate it). Swallow errors: a stale legacy file is harmless
	// (next install() just re-migrates the same content to the same target).
	/* v8 ignore start -- defensive: catch swallows unlink errors (e.g. already deleted or read-only) */
	await unlink(legacyPath).catch(() => {});
	/* v8 ignore stop */

	log.info(
		"Migrated legacy dist-path -> dist-paths/%s (version=%s, distDir=%s)",
		derivedTag,
		info.version,
		info.distDir,
	);
	return true;
}
