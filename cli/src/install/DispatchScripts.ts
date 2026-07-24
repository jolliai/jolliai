/**
 * DispatchScripts — Shell script templates and writer for the three global
 * dispatch scripts: `resolve-dist-path`, `run-hook`, and `run-cli`.
 *
 * These scripts live in `~/.jolli/jollimemory/` and are identical regardless
 * of which source (CLI, VS Code, Cursor, …) writes them. Path-selection
 * logic lives only in `resolve-dist-path` so future changes (e.g. a JAR
 * runtime branch) touch one file.
 *
 * Extracted from Installer.ts for single-responsibility.
 */

import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../core/AtomicWrite.js";
import { createLogger } from "../Logger.js";
import { SOURCE_PREFERENCE_ORDER } from "./DistPathResolver.js";

const log = createLogger("DispatchScripts");

// ─── Script templates ───────────────────────────────────────────────────────

/**
 * `resolve-dist-path` — long-term public API for resolving the winning dist.
 *
 * Behavior:
 *   - Iterate `dist-paths/<source>` files; pick the highest version whose
 *     dist directory still exists. dev/unknown versions rank lowest.
 *   - Output the absolute dist path to stdout on success; exit 1 + stderr
 *     diagnostic on failure.
 *
 * NO fallback to legacy single-file `dist-path`. Rationale:
 *   Whenever this script runs on disk, a current `install()` must have written
 *   it — and that same `install()` runs `migrateLegacyDistPath()` which
 *   (a) writes `dist-paths/<derived>` and (b) deletes legacy `dist-path`.
 *   So by the time this script executes, `dist-paths/` is always non-empty and
 *   `dist-path` is always gone. A legacy fallback tier would be dead code.
 *
 *   Rollback to a pre-registry version is still safe: that old `install()`
 *   rewrites this file back to the old `tail -1 dist-path` form AND recreates
 *   `dist-path` itself — so the rollback flow works without us keeping
 *   legacy-reading code alive in the current version.
 *
 * This was originally a simple pass-through (`tail -1`) but is now the
 * canonical resolver that run-hook, run-cli, and external tools use.
 * Kept stable as a public API.
 */
const RESOLVE_DIST_PATH_CONTENT = `#!/bin/bash
# JolliMemory dist-path resolver.
# Outputs the absolute path to the current winning dist directory: the highest
# core version across all registered sources whose path exists. Ties (same core
# version) are broken by a preference list (cli > vscode > cursor > …) because
# the bundled @jolli.ai/cli core is identical at equal versions — the tie-break
# only makes the winner deterministic and favours the canonical CLI build.
#
# When JOLLI_DIST_PREFER_SOURCE is set (for example by Claude Plugin CLI
# commands), that source is SOFT-preferred: it wins a
# version TIE — selected only if present, complete, and already at the top version
# BEST_VER — but never beats a strictly-higher version from another source, and a
# missing / incomplete / older prefer silently falls through to normal cross-source
# selection below. This replaces the former hard pin (resolve-only-that-source-or-
# fail) so every install source competes on version.
#
# Optional arg $1 = a required script filename (e.g. "PrepareMsgHook.js"). When
# given, a candidate dist is eligible ONLY if it actually contains that file, so
# an INCOMPLETE source that wins on version is skipped and resolution falls
# through to the next-best complete source. Without this, a source registered
# with a partial dist (e.g. the Claude Code plugin before it bundled the git-hook
# scripts) would win, and run-hook would 'node <dist>/PrepareMsgHook.js' a
# missing file — non-zero exit that BLOCKS the commit. Callers that don't care
# (run-cli baking, external tools) omit the arg and get the legacy dir-only check.
#
# Stable public API: run-hook, run-cli, legacy hooks still on disk, and
# third-party tools all rely on this script's "output a path, exit 0/1"
# contract.

DIR="$HOME/.jolli/jollimemory"
REQUIRED="$1"
PREFER="$JOLLI_DIST_PREFER_SOURCE"
BEST_PATH=""
BEST_VER="0.0.0"

# has_required <distDir> — true when no file is required, or the required file
# exists inside the candidate dist. Keeps the eligibility test in one place so
# both passes stay in lockstep.
has_required() {
  [ -z "$REQUIRED" ] && return 0
  [ -f "$1/$REQUIRED" ]
}

# Pass 1 — highest core version wins. Selection uses 'sort -V', which agrees with
# the in-process compareSemver (cli/src/install/DistPathResolver.ts) on every
# non-prerelease comparison. The comparison is STRICT greater-than: an equal
# version does NOT overwrite, so enumeration (alphabetical) order never decides a
# tie. (Known sort -V divergence: it ranks 1.0.0-rc.1 ABOVE 1.0.0; compareSemver
# follows semver and ranks it below. Too rare to hand-roll in POSIX sh.)
if [ -d "$DIR/dist-paths" ]; then
  for f in "$DIR/dist-paths"/*; do
    [ -f "$f" ] || continue
    VER=$(sed -n '1p' "$f")
    CANDIDATE=$(sed -n '2p' "$f")
    [ -z "$VER" ] && continue
    [ -d "$CANDIDATE" ] || continue
    has_required "$CANDIDATE" || continue
    case "$VER" in
      dev|unknown) VER_CMP="0.0.0" ;;
      *)           VER_CMP="$VER" ;;
    esac
    if [ -z "$BEST_PATH" ]; then
      BEST_PATH="$CANDIDATE"
      BEST_VER="$VER_CMP"
    elif [ "$VER_CMP" != "$BEST_VER" ] && \\
         printf '%s\\n%s' "$BEST_VER" "$VER_CMP" | sort -V | tail -1 | grep -qxF "$VER_CMP"; then
      BEST_PATH="$CANDIDATE"
      BEST_VER="$VER_CMP"
    fi
  done
fi

# Soft prefer — when JOLLI_DIST_PREFER_SOURCE names a source (the Claude Code
# plugin sets it to "claude-plugin" for its CLI recipes), that source WINS a
# version tie ahead of the global preference order below: it is chosen only if it is
# present, complete, AND already at the top version BEST_VER. A strictly-higher
# version elsewhere has already won BEST_VER in Pass 1, so prefer never overrides it;
# a missing / incomplete / older prefer falls through to Pass 2. This is the soft
# replacement for the former hard pin — every source still competes on version.
if [ -n "$BEST_PATH" ] && [ -n "$PREFER" ]; then
  pf="$DIR/dist-paths/$PREFER"
  if [ -f "$pf" ]; then
    PVER=$(sed -n '1p' "$pf")
    PPATH=$(sed -n '2p' "$pf")
    case "$PVER" in dev|unknown) PVER="0.0.0" ;; esac
    if [ -d "$PPATH" ] && has_required "$PPATH" && [ "$PVER" = "$BEST_VER" ]; then
      echo "$PPATH"
      exit 0
    fi
  fi
fi

# Pass 2 — among sources tied at BEST_VER, prefer the order below (kept in lockstep
# with SOURCE_PREFERENCE_ORDER in DistPathResolver.ts). Only overrides when the
# preferred source carries the same top version AND is itself complete (has the
# required file, if any) — a preferred-but-incomplete source must not displace the
# complete pass-1 winner.
if [ -n "$BEST_PATH" ]; then
  for pref in ${SOURCE_PREFERENCE_ORDER.join(" ")}; do
    pf="$DIR/dist-paths/$pref"
    [ -f "$pf" ] || continue
    PVER=$(sed -n '1p' "$pf")
    PPATH=$(sed -n '2p' "$pf")
    [ -d "$PPATH" ] || continue
    has_required "$PPATH" || continue
    case "$PVER" in dev|unknown) PVER="0.0.0" ;; esac
    if [ "$PVER" = "$BEST_VER" ]; then
      BEST_PATH="$PPATH"
      break
    fi
  done
fi

if [ -n "$BEST_PATH" ]; then
  echo "$BEST_PATH"
else
  echo "ERROR: No valid Jolli Memory dist-path found. Run 'jolli enable' to fix." >&2
  exit 1
fi
`;

/**
 * `run-hook` — thin wrapper. Dispatches hook-type arg to the appropriate
 * `*Hook.js` in the winning dist. Does NOT re-implement path selection;
 * delegates to `resolve-dist-path`.
 *
 * Node resolution is PATH-first with a recorded-runtime fallback: use the
 * caller's `node` when PATH has one (interactive shells keep their own
 * version-manager choice), otherwise fall back to the absolute path in
 * `~/.jolli/jollimemory/node-path` — a plain-text sibling of node-info.json
 * written by IDE detection / manual selection (already version-verified, so
 * an -x check is enough here). GUI git clients launch git with a minimal
 * PATH that lacks nvm/homebrew/volta locations; without the fallback the
 * hook would silently no-op on machines that DO have Node. The fallback is
 * deliberately NOT re-verified with `node --version`: prepare-commit-msg
 * runs on the blocking commit path and must not pay an extra spawn.
 *
 * Exit policy: silent exit 0 on any failure (hooks must never block git,
 * Claude, or Gemini operations). Diagnostics go to stderr.
 *
 * Designed so a future JAR / IntelliJ runtime can be supported by either:
 *   - Upgrading resolve-dist-path's output format (kind + target), or
 *   - Adding a jar branch here and in run-cli.
 * Either way, hook files don't change.
 */
const RUN_HOOK_CONTENT = `#!/bin/bash
# JolliMemory hook runner.
# Takes a hook-type argument; execs the corresponding node hook entry in the
# winning dist (selected by resolve-dist-path).
#
# The hook-type → script name is resolved FIRST, then passed to resolve-dist-path
# so it can skip any winning-but-incomplete dist that lacks this specific script
# and fall through to a complete source. This is what stops a partial source
# (e.g. a plugin bundle missing PrepareMsgHook.js) from turning a commit hook into
# 'node <missing file>' — a non-zero exit that would BLOCK the git operation.

HOOK_TYPE="$1"
shift

case "$HOOK_TYPE" in
  post-commit)        SCRIPT="PostCommitHook.js" ;;
  post-merge)         SCRIPT="PostMergeHook.js" ;;
  post-rewrite)       SCRIPT="PostRewriteHook.js" ;;
  prepare-commit-msg) SCRIPT="PrepareMsgHook.js" ;;
  pre-push)           SCRIPT="PrePushHook.js" ;;
  stop)               SCRIPT="StopHook.js" ;;
  session-start)      SCRIPT="SessionStartHook.js" ;;
  gemini-after-agent) SCRIPT="GeminiAfterAgentHook.js" ;;
  *)                  echo "ERROR: unknown hook type '$HOOK_TYPE'" >&2; exit 0 ;;
esac

DIST=$("$HOME/.jolli/jollimemory/resolve-dist-path" "$SCRIPT") || exit 0

# Resolve a usable node binary. The caller's PATH comes first so interactive
# shells keep their own version-manager choice (nvm/volta/fnm/…). GUI git
# clients launch git with a minimal PATH that lacks those locations, so when
# PATH has no node, fall back to the runtime the IDE detected and recorded in
# node-path (one absolute path per line; its writer already proved the binary
# runs and meets the minimum version, so an -x check is enough here — never
# spawn 'node --version' on this path: prepare-commit-msg is blocking).
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  RECORDED=$(sed -n '1p' "$HOME/.jolli/jollimemory/node-path" 2>/dev/null)
  if [ -n "$RECORDED" ] && [ -x "$RECORDED" ]; then
    NODE_BIN="$RECORDED"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node runtime not found. Jolli Memory hooks require Node.js." >&2
  exit 0
fi

exec "$NODE_BIN" "$DIST/$SCRIPT" "$@"
`;

/**
 * `run-cli` — thin wrapper. Runs any Jolli CLI subcommand (recall/view/doctor/
 * etc.) by execing node on the winning dist's Cli.js. Used by the jolli-recall
 * SKILL.md and by power users / external scripts.
 *
 * Node resolution mirrors run-hook: PATH first, then the recorded runtime in
 * `~/.jolli/jollimemory/node-path` (see the run-hook comment for rationale).
 *
 * Exit policy: exit 1 (not 0) on failure. CLI callers expect real exit codes,
 * unlike hooks that must always succeed silently.
 */
const RUN_CLI_CONTENT = `#!/bin/bash
# JolliMemory CLI runner.
# Execs node on the winning dist's Cli.js with all args passed through.
# Requires the winning dist to actually contain Cli.js (every real dist does),
# so a partial source can't win run-cli either.

DIST=$("$HOME/.jolli/jollimemory/resolve-dist-path" Cli.js) || exit 1

# Node resolution mirrors run-hook: PATH first (respects the user's own
# version-manager choice), then the IDE-recorded runtime for GUI clients
# whose minimal PATH lacks node. See run-hook for the full rationale.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  RECORDED=$(sed -n '1p' "$HOME/.jolli/jollimemory/node-path" 2>/dev/null)
  if [ -n "$RECORDED" ] && [ -x "$RECORDED" ]; then
    NODE_BIN="$RECORDED"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node runtime not found. Jolli Memory CLI requires Node.js." >&2
  exit 1
fi

exec "$NODE_BIN" "$DIST/Cli.js" "$@"
`;

// ─── Writer ─────────────────────────────────────────────────────────────────

/**
 * Writes `content` to `filePath` only when the on-disk content differs, but
 * always (re-)asserts the 0o755 exec bit.
 *
 * Skipping the write when content already matches eliminates the truncation
 * race window: a concurrent `prepare-commit-msg` exec of `run-hook` can never
 * observe a partially-written (or 0-byte) file because we never truncate a file
 * whose content is already correct. The chmod still runs on that path so a
 * re-run of `jolli enable` self-heals a script whose exec bit was stripped
 * (zip/backup restore, `cp` without -p, cloud-sync, AV) even when the content
 * is untouched — chmod is a metadata write with no O_TRUNC, so it stays clear
 * of the very race this write-if-changed guard exists to close.
 */
async function writeIfChanged(filePath: string, content: string): Promise<void> {
	let matches = false;
	try {
		matches = (await readFile(filePath, "utf-8")) === content;
	} catch {
		// File doesn't exist yet — will create.
	}
	if (matches) {
		await chmod(filePath, 0o755);
		return;
	}
	await atomicWriteFile(filePath, content);
	await chmod(filePath, 0o755);
}

/**
 * Writes the three dispatch scripts to the global config directory:
 *   - resolve-dist-path (public API, outputs winning dist path)
 *   - run-hook         (thin wrapper, execs hook entry)
 *   - run-cli          (thin wrapper, execs Cli.js)
 *
 * Idempotent — safe to call multiple times. All three files are byte-identical
 * regardless of which source (CLI / VSCode / Cursor / etc.) writes them.
 * Uses write-if-changed so steady-state calls (scripts already correct) perform
 * no disk write, eliminating the O_TRUNC race that a concurrent prepare-commit-msg
 * exec of run-hook could observe as a partial read → bash syntax error → commit
 * abort.
 */
export async function installHookScripts(): Promise<boolean> {
	const globalDir = join(homedir(), ".jolli", "jollimemory");

	try {
		await mkdir(globalDir, { recursive: true });

		await writeIfChanged(join(globalDir, "resolve-dist-path"), RESOLVE_DIST_PATH_CONTENT);
		await writeIfChanged(join(globalDir, "run-hook"), RUN_HOOK_CONTENT);
		await writeIfChanged(join(globalDir, "run-cli"), RUN_CLI_CONTENT);

		log.info("Wrote resolve-dist-path, run-hook, and run-cli scripts to %s", globalDir);
		return true;
	} catch (error: unknown) {
		log.warn("Failed to write resolve scripts: %s", (error as Error).message);
		return false;
	}
}
