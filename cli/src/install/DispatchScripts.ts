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

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";

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
# Outputs the absolute path to the current winning dist directory (highest
# version across all registered sources whose path exists).
#
# Stable public API: run-hook, run-cli, legacy hooks still on disk, and
# third-party tools all rely on this script's "output a path, exit 0/1"
# contract.

DIR="$HOME/.jolli/jollimemory"
BEST_PATH=""
BEST_VER="0.0.0"

if [ -d "$DIR/dist-paths" ]; then
  for f in "$DIR/dist-paths"/*; do
    [ -f "$f" ] || continue
    VER=$(sed -n '1p' "$f")
    CANDIDATE=$(sed -n '2p' "$f")
    [ -z "$VER" ] && continue
    [ -d "$CANDIDATE" ] || continue
    case "$VER" in
      dev|unknown) VER_CMP="0.0.0" ;;
      *)           VER_CMP="$VER" ;;
    esac
    if [ -z "$BEST_PATH" ] || \\
       printf '%s\\n%s' "$BEST_VER" "$VER_CMP" | sort -V | tail -1 | grep -qx "$VER_CMP"; then
      BEST_PATH="$CANDIDATE"
      BEST_VER="$VER_CMP"
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

HOOK_TYPE="$1"
shift

DIST=$("$HOME/.jolli/jollimemory/resolve-dist-path") || exit 0
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node runtime not found. Jolli Memory hooks require Node.js." >&2
  exit 0
fi

case "$HOOK_TYPE" in
  post-commit)        exec node "$DIST/PostCommitHook.js" "$@" ;;
  post-rewrite)       exec node "$DIST/PostRewriteHook.js" "$@" ;;
  prepare-commit-msg) exec node "$DIST/PrepareMsgHook.js" "$@" ;;
  stop)               exec node "$DIST/StopHook.js" "$@" ;;
  session-start)      exec node "$DIST/SessionStartHook.js" "$@" ;;
  gemini-after-agent) exec node "$DIST/GeminiAfterAgentHook.js" "$@" ;;
  *)                  echo "ERROR: unknown hook type '$HOOK_TYPE'" >&2; exit 0 ;;
esac
`;

/**
 * `run-cli` — thin wrapper. Runs any Jolli CLI subcommand (recall/view/doctor/
 * etc.) by execing node on the winning dist's Cli.js. Used by the jolli-recall
 * SKILL.md and by power users / external scripts.
 *
 * Exit policy: exit 1 (not 0) on failure. CLI callers expect real exit codes,
 * unlike hooks that must always succeed silently.
 */
const RUN_CLI_CONTENT = `#!/bin/bash
# JolliMemory CLI runner.
# Execs node on the winning dist's Cli.js with all args passed through.

DIST=$("$HOME/.jolli/jollimemory/resolve-dist-path") || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node runtime not found. Jolli Memory CLI requires Node.js." >&2
  exit 1
fi

exec node "$DIST/Cli.js" "$@"
`;

// ─── Writer ─────────────────────────────────────────────────────────────────

/**
 * Writes the three dispatch scripts to the global config directory:
 *   - resolve-dist-path (public API, outputs winning dist path)
 *   - run-hook         (thin wrapper, execs hook entry)
 *   - run-cli          (thin wrapper, execs Cli.js)
 *
 * Idempotent — safe to call multiple times. All three files are byte-identical
 * regardless of which source (CLI / VSCode / Cursor / etc.) writes them.
 */
export async function installHookScripts(): Promise<boolean> {
	const globalDir = join(homedir(), ".jolli", "jollimemory");

	try {
		await mkdir(globalDir, { recursive: true });

		const resolveDistPath = join(globalDir, "resolve-dist-path");
		await writeFile(resolveDistPath, RESOLVE_DIST_PATH_CONTENT, "utf-8");
		await chmod(resolveDistPath, 0o755);

		const runHookPath = join(globalDir, "run-hook");
		await writeFile(runHookPath, RUN_HOOK_CONTENT, "utf-8");
		await chmod(runHookPath, 0o755);

		const runCliPath = join(globalDir, "run-cli");
		await writeFile(runCliPath, RUN_CLI_CONTENT, "utf-8");
		await chmod(runCliPath, 0o755);

		log.info("Wrote resolve-dist-path, run-hook, and run-cli scripts to %s", globalDir);
		return true;
	} catch (error: unknown) {
		log.warn("Failed to write resolve scripts: %s", (error as Error).message);
		return false;
	}
}
