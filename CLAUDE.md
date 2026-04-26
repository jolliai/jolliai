# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Monorepo with three deliverables that share the same product model and storage (a git orphan branch `jollimemory/summaries/v3`):

- `cli/` — `@jolli.ai/cli` (npm workspace, Node 22.5+, ESM, Vite multi-entry lib build). Standalone command-line tool plus all git/agent hook scripts.
- `vscode/` — `jollimemory-vscode` extension (npm workspace, esbuild → CJS). Bundles the CLI and hook scripts into its own `dist/` so it has **no dependency on a global CLI install**.
- `intellij/` — separate Gradle/Kotlin project (JDK 21). Independent build, but installs the same git/agent hooks and writes to the same orphan branch + `~/.jolli/jollimemory/` state.

Root `package.json` only coordinates the two npm workspaces; it does not touch `intellij/`. Use `.nvmrc` (currently `24.10.0`) for the Node version.

**Names you'll see (all refer to the same product):**

- **`jollimemory`** — product name; orphan branch prefix (`jollimemory/summaries/v3`).
- **`jolliai`** — current GitHub org / repo namespace (`github.com/jolliai/jolliai`).
- **`@jolli.ai/cli`** — npm scope and package name for the CLI workspace.
- **`jollimemory-vscode`** — `package.json` `name` of the VS Code extension. Root npm scripts reference it via the **workspace path** `vscode` (e.g. `npm run test -w vscode`), not by package name.

## Common commands

From the repo root (npm workspace; coordinates `cli` + `vscode`):

```bash
npm install            # install workspaces
npm run build          # build cli, then vscode (vscode esbuild bundle inlines cli/src/**)
npm run typecheck      # tsc --noEmit in both
npm run lint           # biome check --error-on-warnings (tab indent, 120 line width)
npm run lint:fix       # biome check --write
npm run test           # vitest run --coverage in both (cli enforces 97% threshold)
npm run all            # clean → build → lint → test (use this before committing)
```

Per-workspace variants exist for every script: `npm run build:cli`, `npm run test:vscode`, `npm run typecheck:cli`, etc.

Running a single test (Vitest):

```bash
# cli — vitest is the test script directly
npm run test -w @jolli.ai/cli -- src/core/SummaryStore.test.ts -t "merges children"

# vscode — same flags, but tests are launched via scripts/run-vitest.mjs
npm run test:vscode -- src/services/JolliPushService.test.ts -t "rejects http"
```

Iterating on the CLI without rebuilding: `npm run cli -- <command>` (uses `tsx` on the source). For end-to-end testing of the actual built artifact, do `cd cli && npm run build && npm install -g .` once — the global symlink keeps pointing to local `dist/`, so subsequent `npm run build` runs are picked up immediately by the global `jolli` binary.

VS Code extension iteration: `cd vscode && npm run deploy` bumps patch version → builds → packages → installs the VSIX. Then **Developer: Reload Window** in VS Code. If you also changed `cli/src/**`, run `cd cli && npm run build` first because the extension bundles the CLI at build time.

IntelliJ plugin: `cd intellij && ./gradlew build` (or `runIde` for a sandbox). See [`intellij/DEVELOPMENT.md`](intellij/DEVELOPMENT.md).

## Architecture you can't infer from one file

### Two-layer hook model

The product is built on a hook pipeline that runs in the user's project, not in this repo:

1. **AI agent hooks** (Claude `StopHook` / `SessionStartHook`, Gemini `AfterAgent`) only record session metadata to `~/.jolli/jollimemory/sessions.json`. They do not read transcripts, do not call the LLM, and run with `async: true` so they never block the agent. Codex and OpenCode have no hook — they're discovered by scanning `~/.codex/sessions/` or reading `~/.local/share/opencode/opencode.db` (Node 22.5+ `node:sqlite`, lazy-imported and feature-gated; the VSCode bundle targets Node 18 and tolerates the missing module).

2. **Git hooks** drive a unified queue under `.jolli/jollimemory/git-op-queue/`. `post-commit` is synchronous (<5 ms) and only enqueues + spawns a detached `QueueWorker`; the worker holds a 5-min file lock, drains entries in timestamp order, runs the LLM where needed, and chain-spawns a successor if new entries appear after it finishes. Squash and rebase entries skip the LLM and just merge/migrate existing summaries. `prepare-commit-msg` writes `squash-pending.json` so the worker recognizes squash before deciding whether to call the LLM. See [`cli/DEVELOPMENT.md`](cli/DEVELOPMENT.md) for the queue rationale (each op gets its own file precisely because the previous single-slot pending files lost summaries during rapid amend/rebase sequences).

### Storage: orphan branch + `~/.jolli/jollimemory/`

Summaries live on the git orphan branch `jollimemory/summaries/v3` in the user's repo and are written via plumbing only — the branch is **never checked out**. Read with `git show <branch>:<path>`; write with `hash-object` + `mktree` + `commit-tree` + `update-ref`. Local non-summary state (sessions, cursors, config, locks, queue, dist-path indirection) lives under `~/.jolli/jollimemory/`.

### VS Code extension bundles the CLI

`vscode/esbuild.config.mjs` produces two CJS bundles in `dist/`: `Extension.js` (with `vscode` external) and `Cli.js` plus each hook script (`PostCommitHook.js`, `StopHook.js`, …). Both bundles inline modules from `cli/src/**` directly. Consequences:

- VS Code source frequently imports across packages with paths like `../../../cli/src/core/JolliApiUtils.js` — these resolve at bundle time. Don't try to "clean these up" into a published-package import.
- `import.meta.url` in `cli/src/install/Installer.ts` is replaced with a real `__filename` expression by esbuild so the Installer can locate hook scripts relative to the bundle at runtime.
- jollimemory core is pure ESM, but the VS Code extension host requires CJS — esbuild handles the bridging.

Hook installation uses dist-path indirection: hooks call `node "$($HOME/.jolli/jollimemory/resolve-dist-path)/PostCommitHook.js"`, where `resolve-dist-path` reads the `~/.jolli/jollimemory/dist-path` file. CLI vs extension write the same version-tagged dist-path (e.g. `source=cli@1.0.0\n/abs/path/to/dist`), so whichever surface was enabled most recently wins, and version comparisons work across surfaces.

### Auth & origin allowlist

`jolliApiKey` (`sk-jol-…`) is a plain or JWT-shaped token whose payload encodes the tenant URL in a base64url-decoded segment. Three places consume it: CLI (`cli/src/core/JolliApiUtils.ts`, canonical `parseJolliApiKey` + `assertJolliOriginAllowed`), VS Code extension (which imports the canonical CLI helpers via the bundled path), and the IntelliJ plugin (Kotlin port). The allowlist is `jolli.ai`, `jolli.dev`, `jolli-local.me`, HTTPS-only, with a suffix-boundary check (`host === h || host.endsWith("." + h)`). Validation is **save-time** (OAuth callback, `configure --set`, settings UI, `JOLLI_URL` env at read time) — request paths trust the saved value. Keep the three implementations in lockstep.

## Project conventions worth knowing

- **Biome** is the formatter and linter (config: [`cli/biome.json`](cli/biome.json)). Tabs, 4-wide, 120 column limit. Rules of note: `noExplicitAny: error`, `noUnusedImports/Variables: error`, `useImportType: warn`. CI runs `biome check --error-on-warnings` — warnings fail.
- **Test coverage** in `cli/` is enforced at 97% statements / 96% branches / 97% functions / 97% lines (see [`cli/vite.config.ts`](cli/vite.config.ts)). New code under `cli/src/` should not regress coverage.
- **DCO sign-off is required** on every commit (`git commit -s`). PRs without a `Signed-off-by:` line will be rejected. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **Worktree-aware**: hooks and summaries work across `git worktree` checkouts. Don't write code that assumes a single working tree.
