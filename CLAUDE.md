# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical rules

These rules affect whether a change can ship at all. They override any other guidance below.

- **DCO sign-off on every commit** — `git commit -s`. CI rejects PRs without `Signed-off-by:`.
- **No `Co-Authored-By: Claude …` trailer or `🤖 Generated with …` footer.** Commit messages and PR descriptions stay human-authored; only the DCO `Signed-off-by:` trailer belongs there.
- **`npm run all` must pass before commit** (clean → build → lint → test). CI runs the same chain.
- **Do not regress CLI test coverage.** New code under `cli/src/` is held to 97% statements / 96% branches / 97% functions / 97% lines (see [`cli/vite.config.ts`](cli/vite.config.ts)).
- **Three implementations of the API key parser stay in lockstep.** `parseJolliApiKey` / `assertJolliOriginAllowed` live in [`cli/src/core/JolliApiUtils.ts`](cli/src/core/JolliApiUtils.ts), are bundled into the VS Code extension verbatim, and have a Kotlin port in `intellij/`. Updating one without the others is a known-bad pattern.
- **Cross-package imports in `vscode/src/**` are intentional.** Paths like `../../../cli/src/core/JolliApiUtils.js` resolve at esbuild bundle time. Don't refactor them into a published-package import — VS Code currently bundles the CLI inline.
- **Worktree-aware code only.** Hooks, summary storage, and lock files must work across `git worktree` checkouts. Don't assume a single working tree.
- **Suspected vulnerabilities go through [`SECURITY.md`](SECURITY.md)**, not public issues or PRs.
- **Workflow injection hygiene.** Inside `.github/workflows/*.yaml`, any `${{ … }}` expression derived from a user-controlled context — `github.event.*`, `inputs.*`, `github.head_ref`, the commit author/message fields, etc. — must be funnelled through `env:` before reaching a `run:` block or the `with:` of an untrusted action. Direct interpolation is the injection pattern. The existing publish workflows already follow this for both `inputs.tag` and `github.event.release.tag_name`.

## Repository layout

Monorepo with three deliverables that share the same product model and storage. By default (0.99.0+) every memory is dual-written to **both** the git orphan branch `jollimemory/summaries/v3` (system of record) and the user-pickable **Memory Bank** folder on disk. The Memory Bank folder has two layers: a hidden `<localFolder>/<repo>/.jolli/` directory holding canonical JSON (`summaries/<hash>.json`, `transcripts/<hash>.json`, `index.json`) for programmatic access, and a visible `<localFolder>/<repo>/<branch>/<slug>-<hash8>.md` layer holding human-browsable Markdown for the user. Reads come from the orphan branch:

- `cli/` — `@jolli.ai/cli` (npm workspace, Node 22.5+, ESM, Vite multi-entry lib build). Standalone command-line tool plus all git/agent hook scripts.
- `vscode/` — `jollimemory-vscode` extension (npm workspace, esbuild → CJS). Bundles the CLI and hook scripts into its own `dist/` so it has **no dependency on a global CLI install**.
- `intellij/` — separate Gradle/Kotlin project (JDK 21). Independent build, but installs the same git/agent hooks and writes to the same shared state: the orphan branch, the Memory Bank folder, the machine-global `~/.jolli/jollimemory/` (config + hook entry scripts), and the per-project `<projectDir>/.jolli/jollimemory/` (sessions, cursors, queue, …).

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

1. **AI agent hooks** (Claude `StopHook` / `SessionStartHook`, Gemini `AfterAgent`) only record session metadata to `<projectDir>/.jolli/jollimemory/sessions.json`. They do not read transcripts, do not call the LLM, and run with `async: true` so they never block the agent. Codex, OpenCode, Cursor (Composer), GitHub Copilot CLI, and VS Code Copilot Chat have **no hook** — each has a per-source detector + session discoverer + transcript reader triplet under `cli/src/core/` that runs at post-commit time. The OpenCode reader uses Node 22.5+ `node:sqlite` and is lazy-imported + feature-gated so the VSCode bundle (which targets Node 18) tolerates the missing module; the Cursor and Copilot triplets follow the same lazy-import pattern. Copilot CLI and Copilot Chat share a single `copilotEnabled` config flag — splitting them was rejected because users want them together.

2. **Git hooks** drive a unified queue under `.jolli/jollimemory/git-op-queue/`. `post-commit` is synchronous (<5 ms) and only enqueues + spawns a detached `QueueWorker`; the worker holds a 5-min file lock, drains entries in timestamp order, runs the LLM where needed, and chain-spawns a successor if new entries appear after it finishes. Squash entries (and rebase-squash) now go through the LLM-driven `generateSquashConsolidation` pipeline (`cli/src/hooks/QueueWorker.ts runSquashPipeline`) — the old "skip LLM, mechanical merge only" behavior is now the **fallback** when the consolidation call fails. Rebase-pick entries skip the LLM and just migrate hashes 1:1. `prepare-commit-msg` writes `squash-pending.json` so the worker recognizes squash before picking a consolidation strategy. See [`cli/DEVELOPMENT.md`](cli/DEVELOPMENT.md) for the queue rationale (each op gets its own file precisely because the previous single-slot pending files lost summaries during rapid amend/rebase sequences).

### Storage: orphan branch + pluggable `StorageProvider` + two `.jolli/jollimemory/` dirs

Summaries live on the git orphan branch `jollimemory/summaries/v3` in the user's repo and are written via plumbing only — the branch is **never checked out**. Read with `git show <branch>:<path>`; write with `hash-object` + `mktree` + `commit-tree` + `update-ref`.

The orphan branch I/O is wrapped behind a `StorageProvider` interface (`cli/src/core/StorageProvider.ts`). Three backends ship today, picked by `StorageFactory` and swapped in at runtime via `setActiveStorage()` in `SummaryStore.ts`:

- `OrphanBranchStorage` — orphan-branch-only, the legacy mode (the only mode in 0.98.0 and earlier).
- `FolderStorage` — folder-only.
- `DualWriteStorage` — **the default in 0.99.0** (`storageMode` defaults to `"dual-write"` in `StorageFactory.createStorage`). Writes go to both the orphan branch (system of record) and the Memory Bank folder. `<localFolder>` is the user's `localFolder` config — one Memory Bank root can host multiple repos, each in its own `<repo>/` subfolder. The folder has two layers (FolderStorage docstring is the source of truth):
  - Hidden `<localFolder>/<repo>/.jolli/` — canonical JSON for programmatic access: `summaries/<commitHash>.json`, `transcripts/<commitHash>.json`, `plans/...`, `notes/...`, `index.json`, `shadow-status.json`.
  - Visible `<localFolder>/<repo>/<branch>/...` — human-browsable Markdown auto-generated from the JSON: `<slug>-<hash8>.md` for summaries, `plan--<slug>.md` for plans, plus visible note copies. The slug is derived from the commit message via `FolderStorage.slugify()`.

  Reads come from the orphan branch (the visible Markdown layer is generated, never read back).

  **Code-side note:** the `kbRoot` variable in `KBPathResolver` / `FolderStorage` is the return value of `resolveKBPath(repoName, remoteUrl, customPath)` — already concatenated to `<localFolder>/<repoName>`, i.e. **already includes** the `<repo>` segment. So in code, `kbRoot` = per-repo path; in user-facing docs the path is written `<localFolder>/<repo>/...`. Same disk location, different naming layers. The `KB`-prefixed module names (`KBPathResolver`, `KBTypes`) and the `kbRoot` variable are legacy identifiers from when the feature was internally called "Knowledge Base"; the user-facing label is "Memory Bank".

The VS Code extension's `activate()` (and the IntelliJ plugin's equivalent) checks `MetadataManager.readMigrationState()` on every start: if the orphan branch has data but migration has not completed (fresh install, or the user wiped the folder), `MigrationEngine.runMigration()` runs automatically. There is no opt-in — Memory Bank is on by default. The Settings → **Memory Bank** tab is the user-facing entry point for re-targeting the folder; clicking **Migrate to Memory Bank** re-runs migration into a fresh `-N`-suffixed folder and archives the previous folder's repo identity (content files are untouched).

Display and write paths in `SummaryStore.ts` / `LocalSearchProvider.ts` go through the active provider, so adding a fourth backend (e.g. SQLite, S3) is a single new class plus a factory wiring change. Existing code that hard-coded git plumbing is gone — don't reintroduce it.

Local non-summary state is split across **two** `.jolli/jollimemory/` directories — don't conflate them:

- `~/.jolli/jollimemory/` — **machine-global**: `config.json` (authToken / apiKey), `dist-paths/` (per-source dist-path indirection), `run-hook` / `run-cli` / `resolve-dist-path` hook entry scripts. Resolved by `getGlobalConfigDir()`.
- `<projectDir>/.jolli/jollimemory/` — **per-project, gitignored**: `sessions.json`, `cursors.json`, `git-op-queue/`, `notes/`, `plans.json`, `briefing-cache.json`, `debug.log`, and the manual-disable marker (VS Code, written by `ManualDisableFlag` — durable per-repo opt-out from auto-enable; once set, never auto-cleared by anything other than an explicit re-enable). Resolved by `getJolliMemoryDir(cwd)` in [`cli/src/Logger.ts`](cli/src/Logger.ts).

### VS Code extension bundles the CLI

`vscode/esbuild.config.mjs` produces two CJS bundles in `dist/`: `Extension.js` (with `vscode` external) and `Cli.js` plus each hook script (`PostCommitHook.js`, `StopHook.js`, …). Both bundles inline modules from `cli/src/**` directly. Consequences:

- VS Code source frequently imports across packages with paths like `../../../cli/src/core/JolliApiUtils.js` — these resolve at bundle time. Don't try to "clean these up" into a published-package import.
- `import.meta.url` in `cli/src/install/Installer.ts` is replaced with a real `__filename` expression by esbuild so the Installer can locate hook scripts relative to the bundle at runtime.
- jollimemory core is pure ESM, but the VS Code extension host requires CJS — esbuild handles the bridging.

Hook installation uses dist-path indirection: hooks call `node "$($HOME/.jolli/jollimemory/resolve-dist-path)/PostCommitHook.js"`, where `resolve-dist-path` reads the `~/.jolli/jollimemory/dist-path` file. CLI vs extension write the same version-tagged dist-path (e.g. `source=cli@1.0.0\n/abs/path/to/dist`), so whichever surface was enabled most recently wins, and version comparisons work across surfaces.

### Site generation: OpenAPI rich pipeline

The `jolli new` / `build` / `start` / `dev` commands generate a Nextra v4 docs site from a `Content_Folder`. The OpenAPI surface is split in two so a future Fumadocs / Docusaurus emitter doesn't have to reimplement parsing:

1. **Framework-agnostic IR** at `cli/src/site/openapi/` — `SpecLoader` / `SpecParser` / `RefResolver` / `CodeSampleGenerator` / `SchemaExample` / `Slug` / `Escape` / `OpenApiPipeline`. Output is data structures only. `parseFullSpec` walks `paths × HTTP_METHODS` in declaration order, follows `$ref` with RFC 6901 `~1`/`~0` escapes, and **throws** on `(tag, operationId)` collisions (silently dropping an endpoint would be worse).

2. **Renderer-specific emitter** at `cli/src/site/renderer/nextra/` — consumes the IR and returns `TemplateFile[]`. Per spec: an overview MDX, a `_refs.ts` schema map, per-endpoint MDX shims, per-operation JSON sidecars, and `_meta.ts` sidebar files. Plus 8 React components (`Endpoint`, `TryIt`, `SchemaBlock`, `CodeSwitcher`, `EndpointMeta`, `ParamTable`, `ResponseBlock`, `AuthRequirements`) and a shared `describeType` utility, all enumerated by `Components.ts generateApiComponents()`, plus a single `styles/api.css`. Components and CSS are written once at `initProject` time and imported via the `@/*` tsconfig alias declared in the generated `tsconfig.json`.

The bridge is `SiteRenderer.renderOpenApiSpecs(contentDir, publicDir, specs)` in `cli/src/site/renderer/SiteRenderer.ts`. `StartCommand` builds the `OpenApiSpecInput[]` from `MirrorResult.openapiDocs` (the parsed-once-cached AST from `ContentMirror`) via `buildPipeline`. The legacy `swagger-ui-react` MDX shim is gone — that dependency is no longer in `NEXTRA_DEPENDENCIES`. See [`cli/DEVELOPMENT.md`](cli/DEVELOPMENT.md) for module-by-module detail and the full file-flow diagram.

### Site generation: layout, navbar, and footer architecture

The CLI's Nextra layouts are deliberately thin — `<Navbar logo={<SiteLogo />}><ThemeSwitch /></Navbar>` for Forge, `<Navbar logo={<SiteLogo />} />` for Atlas / default. **No `<a>` or `<details>` JSX is spliced into the navbar.** Page tabs (Documentation, API Reference, customer-supplied `header.items`) flow through:

1. `MetaGenerator.generateMetaFiles(contentDir, sidebar, rootInjection)` writes the **root `content/_meta.js`** with auto-injected `__documentation` + `__api-reference` keys (single-spec direct link vs multi-spec dropdown shape) plus customer `header.items` materialised as slug-keyed page-tab entries. URLs flow through `Sanitize.sanitizeUrl` so `javascript:` / `data:` / `vbscript:` are clamped to `"#"`.
2. Nextra's `<Navbar>` reads the page-map and renders the entries natively (chevron, hover, mobile drawer all come for free).
3. Layouts wrap content in `<ScopedNextraLayout>` (emitted to `<buildDir>/components/ScopedNextraLayout.tsx` from the `scopePageMap` filter in `cli/src/site/ScopePageMap.ts`) so the sidebar scopes cleanly when the user is inside `/api-{slug}/…`.

Pack footers (Forge / Atlas) emit semantic class names targeted by the pack stylesheets — `themes/Footer.ts` builds the JSX with `.{prefix}-footer-columns`, `.{prefix}-footer-col`, `.{prefix}-footer-bottom`, `.{prefix}-footer-copyright`, `.{prefix}-footer-social`, `.{prefix}-footer-powered` so the pack CSS does the layout. The default theme has no pack stylesheet so it keeps the inline-style footer fallback.

Schema aliasing happens at site.json read time — `SiteJsonReader.coerceBrandingToTheme` maps the deprecated nested `branding.*` block into the canonical `theme.*` (and `footer.social` → `footer.socialLinks`). Downstream code only ever reads the canonical shape.

URL/HTML escaping is consolidated in `cli/src/site/Sanitize.ts` — every layout, footer renderer, and `_meta.js` writer imports from there so a future tightening of the allow-list happens in one place.

### Auth & origin allowlist

`jolliApiKey` (`sk-jol-…`) is a plain or JWT-shaped token whose payload encodes the tenant URL in a base64url-decoded segment. Three places consume it: CLI (`cli/src/core/JolliApiUtils.ts`, canonical `parseJolliApiKey` + `assertJolliOriginAllowed`), VS Code extension (which imports the canonical CLI helpers via the bundled path), and the IntelliJ plugin (Kotlin port). The allowlist is `jolli.ai`, `jolli.dev`, `jolli.cloud`, `jolli-local.me`, HTTPS-only, with a suffix-boundary check (`host === h || host.endsWith("." + h)`). Validation is **save-time** (OAuth callback, `configure --set`, settings UI, `JOLLI_URL` env at read time) — request paths trust the saved value. Keep the three implementations in lockstep.

## Project conventions worth knowing

- **Biome** is the formatter and linter (config: [`cli/biome.json`](cli/biome.json)). Tabs, 4-wide, 120 column limit. Rules of note: `noExplicitAny: error`, `noUnusedImports/Variables: error`, `useImportType: warn`. CI runs `biome check --error-on-warnings` — warnings fail.
- **Never include AI/Claude co-author information in commit messages.** No `Co-Authored-By: Claude …` trailers, no "🤖 Generated with …" footers — for either commits or PR descriptions. The repo is going open-source and history should read as human-authored work; only `Signed-off-by:` is required.

(The DCO sign-off, `npm run all` gate, CLI coverage floor, and worktree-aware requirement are stated as critical rules at the top of this file; they are not repeated here to keep this file as a single source of truth.)

## Release flow

Releases for both **CLI** (`@jolli.ai/cli` on npm, tag prefix `release-cli-v`) and **VS Code extension** (`jolli.jollimemory-vscode` on VS Code Marketplace + Open VSX, tag prefix `release-vscode-v`) follow the same model. Each is triggered by manually running its publish workflow ([`publish-cli.yaml`](.github/workflows/publish-cli.yaml) / [`publish-vscode.yaml`](.github/workflows/publish-vscode.yaml)) with an existing signed tag as input — pushing the tag alone does not publish. Each minor has a long-lived `release/<minor>.x` branch shared by both artifacts; tags must be reachable from such a branch. Step-by-step commands and the full set of CI checks are in [`RELEASE.md`](RELEASE.md). Four things aren't obvious from the workflow files:

- **Hotfixes do not bump main's version for the affected artifact.** When fixing a shipped version while main carries unfinished features, edit `<artifact>/package.json` only on `release/<minor>.x`. Main's `package.json` represents "what main would publish today" for that artifact — it stays at the previous version until main re-enters a shippable state. CLI and VS Code versions are independent, so hotfixing one does not require touching the other.
- **Cherry-picking a hotfix back to main excludes the version-bump commit.** Pick only the fix commit. Picking the `release: <artifact> <version>` bump commit too will drift main's version past what main can actually publish.
- **Tags must be signed via sigstore** (`git tag -s release-<artifact>-v…`, with [`gitsign`](https://github.com/sigstore/gitsign) configured as the git signer — no long-lived key required). Both workflows verify with `gitsign verify` against an allowlist of OIDC identities. This is independent of, and in addition to, the DCO sign-off requirement on commits.
- **VS Code marketplace publishes are idempotent on retry.** `publish-vscode.yaml` checks each marketplace (VS Code, Open VSX) before publishing and **skips** the step if the version is already there. A run that succeeded on one marketplace and failed on the other can be retried with the same tag — the already-published one will be skipped, only the missing one will be attempted.
