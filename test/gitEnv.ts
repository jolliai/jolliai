/**
 * Global `git` isolation for every test file in the monorepo. Wired in via
 * `test.setupFiles` in all three vitest configs — `cli/vite.config.ts`,
 * `cli/vitest.acceptance.config.ts` and `vscode/vitest.config.ts` — so it runs
 * before each test module regardless of whether that module remembers to
 * isolate itself. It lives at the repo root rather than under `cli/` precisely
 * because all three need it: the vscode suite drives real `git init` / `commit`
 * in `JolliMemoryBridge.integration.test.ts`, and the acceptance suite drives
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

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_TERMINAL_PROMPT = "0";

process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.excludesFile";
process.env.GIT_CONFIG_VALUE_0 = "/dev/null";
