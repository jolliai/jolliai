/**
 * Global `git` AND home-directory isolation for every test file in the
 * monorepo. Wired in via `test.setupFiles` in all three vitest configs —
 * `cli/vite.config.ts`, `cli/vitest.acceptance.config.ts` and
 * `vscode/vitest.config.ts` — so it runs before each test module regardless of
 * whether that module remembers to isolate itself. It lives at the repo root
 * rather than under `cli/` precisely because all three need it: the vscode
 * suite drives real `git init` / `commit` in
 * `JolliMemoryBridge.integration.test.ts`, and the acceptance suite drives
 * real bare repos + clones.
 *
 * ## Why this outranks a per-invocation `git -c …` prologue
 *
 * `cli/test/sync-acceptance/_helpers.ts` hardens every git call it *issues*
 * (`SAFE_GIT_OPTS`), which is strictly better than nothing but only covers the
 * command lines the test itself assembles. The git subprocesses spawned by the
 * production code under test — e.g. `GitClient.commit()`, which passes an
 * identity but no `commit.gpgsign=false` — inherit the developer's config
 * untouched. Environment variables are inherited by those children too, which
 * is the whole point of doing it here: this reaches where `-c` cannot.
 *
 * ~13 CLI test files under `src/` spawn real `git` subprocesses (`sync/GitClient`,
 * `sync/BootstrapMerge`, `install/GitExclude`, `core/BranchCommitLister`,
 * `core/KBPathResolver`, `core/RepoProfile`, `core/Locks`, …). Each one used to
 * repeat its own isolation prologue, and they had already drifted apart —
 * `BootstrapMerge` neutralized the XDG excludes file while `GitClient` did not.
 * Centralizing here is what stops that drift: a new real-git test is hermetic
 * by construction, with nothing to remember.
 *
 * ## What is neutralized, and why each one bites
 *
 * - `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` → `/dev/null`. A developer's
 *   `commit.gpgsign=true` + gitsign signer, or a `core.hooksPath` pointing at
 *   husky/lefthook, makes every `git commit` in a temp fixture block on an
 *   external process. That surfaces as a vitest hook/test timeout, which reads
 *   as a flaky test rather than as the machine-config problem it is.
 * - `GIT_TERMINAL_PROMPT=0`. Never let a fixture stop to ask for credentials.
 * - `core.excludesFile` → `/dev/null`. The XDG default excludes file
 *   (`~/.config/git/ignore`) is a git built-in path, NOT read from config, so
 *   the two variables above do not cover it. `jolli impact init` adds a
 *   `.jolli/` line there, which makes `git add .` silently skip every seeded
 *   `.jolli/...` fixture: origin never receives them, and conflict resolution
 *   then scores a pure-local-addition (local-wins) instead of remote-wins.
 *   `git add <explicit path>` is unaffected — only `git add .` steps on it.
 *
 * ## What is deliberately NOT set: an author identity
 *
 * Tempting, since a few real-git files commit without configuring one — but
 * wrong. `GIT_CONFIG_COUNT` entries are treated as if passed via `git -c`,
 * which is the HIGHEST precedence layer: above repo-local config, not below it.
 * It is an override, not a fallback. `core/BranchCommitLister.test.ts` sets a
 * local `user.name` to the empty string on purpose so it deterministically
 * shadows any global value; injecting an identity here would win over that and
 * break the test's premise. Every real-git committer in this suite already
 * passes its own `-c user.email=…`, so there is nothing to back-fill.
 *
 * Corollary for that same test: with the global config neutralized, its "no
 * global user.name" precondition is now guaranteed rather than machine-dependent.
 *
 * ## Extending this
 *
 * `GIT_CONFIG_COUNT` is a single numbered channel shared process-wide. A test
 * that needs another injected key must start at index 1 and bump the count —
 * reusing index 0 silently replaces the excludes-file neutralization. Prefer
 * per-invocation `git -c key=value` in the test itself; reach for the env
 * channel only when the git call is several layers down inside production code.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setIsolatedHome } from "../cli/src/testUtils/isolatedHome.js";
import { SCRATCH_HOME_ROOT_VAR } from "./scratchHome.js";

/**
 * ## Home isolation: the default, not an opt-in
 *
 * Everything machine-global resolves through `os.homedir()` — `~/.jolli/`
 * (config.json, `jollimemory.db`, `dashboard-repos.json`, `dist-paths/`) and
 * every MCP host registry `jolli enable` writes: `~/.codex/config.toml`,
 * `~/.gemini/settings.json`, `~/.config/opencode/opencode.json`,
 * `~/.copilot/mcp-config.json`, `~/.kimi-code/mcp.json`, … So a test that
 * reaches a default path does not fail; it silently edits the DEVELOPER'S OWN
 * install, and the damage outlives the run.
 *
 * `setIsolatedHome` already existed for this and is documented with a real
 * incident (permanent dead rows in `dashboard-repos.json`), but it was opt-in —
 * 6 test files of ~450 called it, so the rule held exactly where someone had
 * already been burned. It has now been paid for twice: a `DashboardServer`
 * write-surface test with no `dbPath` projected its fixture registry into the
 * real `~/.jolli/jollimemory/jollimemory.db`, and a repo named `acme-api` at
 * `/tmp/acme-api` showed up in the dashboard's repo picker as a real repo.
 * Nothing failed — the test asserts the exact body a SUCCESSFUL projection
 * returns — and `repos_no_delete` (DashboardDb.ts) then refuses any DELETE, so
 * the cleanup is a manual `disabled_at` stamp against a live database.
 *
 * Hence: applied here, to every file, so a test is hermetic by construction with
 * nothing to remember — the same reasoning as the git isolation below.
 *
 * The scratch home is per test FILE, and that is what the pool makes it: the CLI
 * config pins `pool: "forks"` and takes vitest's default `isolate: true`, so every
 * file gets a fresh process. An earlier version of this block described the home
 * as per WORKER and used `process.env.JOLLI_TEST_HOME` as its "already made one"
 * flag, on the reading that a setup module re-evaluates inside a REUSED process.
 * Under `isolate: true` nothing survives to be found, so the flag was never set on
 * entry and the guard never once fired.
 *
 * Per-file is the right granularity anyway — files run concurrently and
 * `~/.jolli/jollimemory/` is a single machine-global path — so what changed is
 * only WHERE they go: inside this run's root from `test/scratchHome.ts`, whose
 * `teardown` removes the lot. Directly under `os.tmpdir()` nothing ever removed
 * them, because no worker knows whether it is the last; 2708 had piled up in one
 * developer's `%TEMP%` before that was noticed.
 *
 * The fallback matters for anyone running vitest with a config that forgot the
 * `globalSetup`: a home is still isolated (the dangerous half), it just goes back
 * to accumulating.
 *
 * The six files that call `setIsolatedHome` themselves keep working and are
 * still worth keeping: they need a home they can inspect, and their `restore()`
 * now returns to THIS scratch home rather than the real one.
 */
if (!process.env.JOLLI_TEST_HOME) {
	const root = process.env[SCRATCH_HOME_ROOT_VAR];
	process.env.JOLLI_TEST_HOME = root
		? mkdtempSync(join(root, "home-"))
		: mkdtempSync(join(tmpdir(), "jolli-test-home-"));
}
setIsolatedHome(process.env.JOLLI_TEST_HOME);

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_TERMINAL_PROMPT = "0";

process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.excludesFile";
process.env.GIT_CONFIG_VALUE_0 = "/dev/null";
