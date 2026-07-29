# STACK

Operational reference for an agent about to change this repo: what the deliverables are, how to
iterate on each, and the exact gate a change must pass. Every value here was read out of a manifest
in this tree — not inferred. Recorded at `18e8c624`.

This is **not** a behavioral spec. Command names, file paths, and version numbers are the point.

---

## 1. Deliverables and workspaces

Three deliverables, one product model, one shared on-disk state.

| Deliverable | Directory | Build system | Coordinated by root? | Version at `18e8c624` |
|---|---|---|---|---|
| `@jolli.ai/cli` | `cli/` | Vite multi-entry lib build + `tsc` declarations | **Yes** — npm workspace | `0.99.9` |
| `jollimemory-vscode` | `vscode/` | esbuild → CJS bundles | **Yes** — npm workspace | `0.99.9` |
| Jolli Memory IntelliJ plugin | `intellij/` | Gradle / Kotlin (`ai.jolli.jollimemory`) | **No** — independent build | `0.99.8` |

Root `package.json` (`"name": "jollimemory"`, `"version": "0.99.0"`, `"private": true`) declares
exactly two workspaces:

```json
"workspaces": ["cli", "vscode"]
```

**`intellij/` is not a workspace and no root script touches it.** `npm run all` at the root does not
build, lint, or test the IntelliJ plugin. It has its own CI workflow
(`.github/workflows/build-intellij.yaml`) and its own gate (§5.4).

A fourth build target exists but is not a workspace: `claude-plugin/plugins/jolli/`, built by
`node claude-plugin/plugins/jolli/scripts/build.mjs`. It is wired into the root `build` chain (§4).

Root version (`0.99.0`) tracks the workspace coordinator, not either shipped artifact. CLI and
VS Code versions move together in practice but are independent by policy; IntelliJ is independent of
both and currently trails at `0.99.8`.

---

## 2. Toolchain versions

**Node** — `.nvmrc` pins `24.10.0`. Use it (`nvm use`). CI resolves Node from `node-version-file:
.nvmrc`. Two lower floors also exist and are enforced at different points:

- `cli/package.json` → `"engines": { "node": ">=22.5.0" }` (the published-package floor; `node:sqlite`
  in the OpenCode reader is why).
- `vscode/scripts/run-vitest.mjs` → `MIN_NODE_MAJOR = 22`; if the invoking `node` is older it hunts
  `~/.nvm/versions/node` for a `>= 22` binary and re-execs vitest under it, erroring out if none.

**VS Code host** — `vscode/package.json` → `"engines": { "vscode": "^1.80.0" }`, `@types/vscode`
`^1.80.0`. The extension host is CJS; jollimemory core is pure ESM — esbuild bridges this.

**JVM / Gradle (IntelliJ only)**

| Thing | Value | Source |
|---|---|---|
| Java source/target compatibility | `21` | `intellij/build.gradle.kts` (`withType<JavaCompile>`) |
| Kotlin `jvmTarget` | `JVM_21` | `intellij/build.gradle.kts` (`withType<KotlinCompile>`) |
| Toolchain launcher for `test` + all `JavaExec` except `runIde` | `JavaLanguageVersion.of(21)` | `intellij/build.gradle.kts` |
| CI JDK | temurin 21 | `.github/workflows/build-intellij.yaml` |
| Gradle wrapper | `gradle-8.13-bin.zip` | `intellij/gradle/wrapper/gradle-wrapper.properties` |
| Gradle daemon heap | `-Xmx2048m` | `intellij/gradle.properties` |

`runIde` is deliberately **excluded** from the forced toolchain launcher so it starts on the
JetBrains Runtime — JCEF (the commit-memory webview) is unavailable on a plain JDK and the panel
degrades to raw markdown.

**Gradle plugins** — `org.jetbrains.kotlin.jvm` `2.1.20`, `org.jetbrains.intellij.platform` `2.5.0`,
`org.jetbrains.kotlinx.kover` `0.9.1`, `org.jetbrains.changelog` `2.2.1`. Platform target:
`intellijIdeaCommunity("2025.1")` (2025.1 is the stated minimum — the non-deprecated
`FileSaverDescriptor(title, description)` + `withExtensionFilter` API only exists from there).
`instrumentCode = false` (100% Kotlin, no `.form` files; also dodges a Windows path-parsing bug in
plugin 2.5.0).

**Formatter / linter** — Biome **2.2.6**. Declared once, as `cli/package.json` →
`devDependencies["@biomejs/biome"]: "2.2.6"` (exact, not caret). `vscode/package.json` declares **no**
Biome dependency — its lint script calls `npx biome`, which resolves the hoisted root
`node_modules` copy. Both `cli/biome.json` and `vscode/biome.json` pin
`$schema: https://biomejs.dev/schemas/2.2.6/schema.json`. Bumping Biome means bumping the CLI
devDependency and both schema URLs together.

**Other notable pins** — TypeScript `^5.7.2` (both workspaces), Vite `^8.0.16` (cli), Vitest
`^4.1.1` (cli) / `^4.1.2` (vscode), `@vitest/coverage-v8` `^4.1.1` / `^4.1.2`, esbuild `^0.28.1`
(vscode) plus esbuild via Vite (cli), `@vscode/vsce` `^3.9.2`, `rimraf` `^6.0.1`, `tsx` `^4.22.4`,
`fast-check` `^3.23.2`. IntelliJ test stack: JUnit Jupiter `5.13.4` (5.12+ required for
`junit.jupiter.extensions.autodetection.exclude`), mockk `1.13.16`, kotest-assertions-core `5.9.1`,
`org.xerial:sqlite-jdbc:3.49.1.0` (also a runtime `implementation` dep).

---

## 3. There are no ports and there is no dev server

**Nothing to start.** This repo ships a CLI, an editor extension, and an IDE plugin. There is no HTTP
server, no frontend dev server, no database, no `docker-compose.yml`, no `Dockerfile`. No
`package.json` in the tree defines a `dev`, `start`, or `serve` script (verified across root, `cli/`,
`vscode/`). Do not look for a port, and do not add a "start the app" step to any workflow that
targets this repo.

Two things are sometimes mistaken for a dev server:

- `vscode/package.json` → `build:watch` (`node esbuild.config.mjs --watch`) — an incremental
  bundler, not a server.
- `cli/package.json` → `test:watch` (`vitest`) — watch-mode tests.

The site-serving commands (`jolli dev` / `jolli start`) live in the separate `@jolli.ai/site-cli`
plugin package, not here; in this repo they exist only as help-text stubs
(`cli/src/commands/SiteCommandStubs.ts`).

The way you "run" this product is: build it, install it, and exercise it against a real git repo
(§4).

---

## 4. Run loop

### 4.1 First time

```bash
nvm use                 # 24.10.0 from .nvmrc
npm install             # installs both workspaces
```

### 4.2 CLI — iterate without a rebuild

```bash
npm run cli -- <command>          # from repo root; = npm run cli -w @jolli.ai/cli
# → tsx src/Cli.ts <command>      # runs TypeScript source, no build step
```

Fast, but it does not exercise the actual build output (bundling, externals, shebang, dist-path
resolution).

### 4.3 CLI — end-to-end against the real artifact

Do the global symlink install **once**:

```bash
cd cli
npm run build
npm install -g .
```

`npm install -g .` symlinks the global `jolli` binary to your local `cli/dist/`, so from then on a
plain `npm run build` (in `cli/`) is enough — the global `jolli` picks it up immediately with no
re-install. `postbuild` chmods `dist/Cli.js` to `0o755`.

`cli` build = `vite build && tsc --project tsconfig.build.json` — the Vite step emits 13 ES entries
(`Cli`, `Api`, `PostInstall`, and the hook/worker entries `StopHook`, `PostCommitHook`,
`PostRewriteHook`, `PrepareMsgHook`, `GeminiAfterAgentHook`, `SessionStartHook`, `PostMergeHook`,
`PrePushHook`, `PrePushWorker`, `QueueWorker`) plus `dist/graph-assets/` (the knowledge-graph viz
runtime, minified here and copied verbatim by every downstream consumer); the `tsc` step emits
declarations. Externals: `@anthropic-ai/sdk`, `commander`, `open`, `semver`, `node:*`.

### 4.4 VS Code extension — deploy and reload

```bash
cd vscode
npm run deploy
# = npm --prefix ../cli run build && npm install -g ../cli && npm run build && npm run package && npm run install:vsix
```

Then **Developer: Reload Window** in VS Code. Note that `deploy` already rebuilds and globally
installs the CLI for you — it is the one command that keeps the bundled CLI and the global CLI in
step. `npm version` is not bumped by `deploy`; the VSIX filename tracks the current
`package.json` version and `install:vsix` installs it with `--force`.

Sub-steps if you need them: `npm run build` (clean → copy codicons → `esbuild.config.mjs` → copy
graph assets), `npm run package` (`vsce package --no-dependencies --allow-missing-repository`),
`npm run install:vsix` (locates the `code` CLI per-platform and `--install-extension … --force`),
`npm run build:watch` for incremental bundling.

If you changed `cli/src/**` and are **not** using `deploy`, rebuild the CLI first — `esbuild.config.mjs`
inlines `cli/src/**` at bundle time, so a stale `cli/` means a stale extension.

### 4.5 IntelliJ plugin — sandbox IDE

```bash
cd intellij
./gradlew runIde        # launches a sandbox IDE with the plugin, on the JetBrains Runtime
./gradlew build         # compile + test + global-state gate
./gradlew buildPlugin   # produce build/distributions/*.zip
```

If you changed `cli/src/**` and want the plugin to pick it up, run the root `npm run build` first —
`build-intellij.yaml` does exactly that ("Build bundled CLI (vscode/dist/*.js)") before invoking
Gradle, because the plugin extracts hook scripts from the bundled CLI output.

### 4.6 Regenerating the local-agent fixtures (manual, not part of any gate)

`scripts/probe-local-agents.mjs` captures **real** headless output from each local-agent CLI into
`cli/src/core/localagent/__fixtures__/<tool>/` (`help.txt`, `meta.json`, `success.json`). It is wired
into **no** npm script, no Gradle task, and no workflow — run it by hand:

```bash
node scripts/probe-local-agents.mjs
```

It requires each tool installed **and logged in** on this machine; a missing or logged-out tool
records that status in its `meta.json` and is skipped rather than failing the run. The fixtures are
therefore recorded observations, not hand-written expectations — regenerate them rather than editing
them by hand. They are excluded from Biome's scope (§6.1).

---

## 5. The verify gate

### 5.1 The command

```bash
npm run all
```

Expands to five stages, in order:

```
npm run clean && npm run build && npm run typecheck && npm run lint && npm run test
```

Each stage fans out across the two npm workspaces:

| Stage | Expansion (root `package.json`) |
|---|---|
| `clean` | `npm run clean -w @jolli.ai/cli && npm run clean -w vscode` |
| `build` | `npm run build -w @jolli.ai/cli && npm run build:claude-plugin && npm run build -w vscode` |
| `typecheck` | `npm run typecheck -w @jolli.ai/cli && npm run typecheck -w vscode` |
| `lint` | `npm run lint -w @jolli.ai/cli && npm run lint -w vscode` |
| `test` | `npm run test -w @jolli.ai/cli && npm run test:acceptance -w @jolli.ai/cli && npm run test -w vscode` |

`build:claude-plugin` = `node claude-plugin/plugins/jolli/scripts/build.mjs`.

This gate is also declared **machine-readably**, in the tree's one committed piece of `.jolli/`:
`.jolli/agents.json` sets `verify.gate: ["npm run all"]`, `verify.scope: "repo-root"`,
`verify.coveragePolicy: "never-lower"`, and
`verify.configFilesOffLimits: ["cli/vite.config.ts", "vscode/vite.config.ts"]`. That file is the
authority for any tool that must *branch* on the gate; this document is the prose around it. Note the
off-limits list is **narrower** than §6.7's rule, which also covers `vscode/vitest.config.ts` and both
`biome.json` files — the prose is the broader constraint. `.gitignore` excludes `.jolli/` entry by
entry precisely so this one file can be committed while the per-developer state beside it is not.

CI runs the identical command: `.github/workflows/build-vscode.yaml` ("CI - CLI + VS Code") does
`npm ci` then `npm run all`, then asserts the IntelliJ bundling contract on `vscode/dist/Cli.js`.

> **⚠ Discrepancy with the repo's own prose.** `AGENTS.md` summarizes the gate as
> **"clean → build → lint → test"**. The actual root script has **five** stages, not four, and two of
> them are broader than the prose implies:
>
> 1. **`typecheck` is a real, separate stage** between `build` and `lint` — `tsc --noEmit` in the CLI
>    and `tsc --noEmit -p tsconfig.build.json` in the extension. It is absent from the prose summary.
>    Neither workspace's own `all` script includes it, so `npm run all -w @jolli.ai/cli` does **not**
>    typecheck; only the root `all` does.
> 2. **`test` has three sub-stages, not two** — the CLI unit suite, then a separate CLI **acceptance**
>    suite (`test:acceptance -w @jolli.ai/cli`, config `cli/vitest.acceptance.config.ts`), then the
>    VS Code suite. The acceptance stage is absent from the prose summary.
> 3. **`build` has three stages, not two** — `build:claude-plugin` sits between the CLI and VS Code
>    builds. The prose summary's "(clean → build → lint → test)" and the layout section's
>    "build cli, then vscode" both predate it.
>
> Consequence for anyone verifying a change: running the two per-workspace `all` scripts is **not**
> equivalent to the root gate. Both per-workspace `all` scripts are `clean && build && lint && test`
> — no typecheck, and the CLI's omits the acceptance suite. Always run the root `npm run all`.

### 5.2 Per-workspace and single-stage variants

Every stage has a per-workspace entry point at the root: `build:cli`, `build:claude-plugin`,
`build:vscode`, `typecheck:cli`, `typecheck:vscode`, `lint:cli`, `lint:vscode`, `lint:fix`,
`test:cli` (unit **+** acceptance), `test:vscode`, `test:acceptance`.

### 5.3 Running a single test — the syntax differs per workspace

**CLI** — `test` is vitest directly, so vitest flags pass straight through:

```bash
npm run test -w @jolli.ai/cli -- src/core/SummaryStore.test.ts -t "merges children"
# → vitest run --coverage src/core/SummaryStore.test.ts -t "merges children"
```

**CLI acceptance suite** — a different config; the include glob is
`test/sync-acceptance/**/*.acceptance.test.ts` and these files are **excluded** from the unit run,
so they can only be reached through:

```bash
npm run test:acceptance -w @jolli.ai/cli -- -t "…"
# → vitest run --config vitest.acceptance.config.ts -t "…"
```

**VS Code** — `test` is not vitest; it is a launcher script
(`node ./scripts/run-vitest.mjs --coverage`) that resolves a `>= 22` Node, then execs
`vitest run --config vitest.config.ts` with your extra args appended:

```bash
npm run test:vscode -- src/services/JolliPushService.test.ts -t "rejects http"
```

**Practical note:** both `test` scripts pass `--coverage`, and both configs carry global thresholds
(§5.5). A single-file run therefore reports a threshold failure on the whole project even when the
selected test passes — read the test result, not the coverage verdict. For a threshold-free loop use
`npm run test:watch -w @jolli.ai/cli` (plain `vitest`, no coverage).

**IntelliJ**

```bash
cd intellij
./gradlew test --tests 'ai.jolli.jollimemory.core.SomeTest'
./gradlew test --info                 # per-test output
```

### 5.4 IntelliJ's gate is separate

`npm run all` does not touch `intellij/`. Its CI gate is:

```bash
./gradlew buildPlugin test verifyPlugin -x buildSearchableOptions
```

`test` `dependsOn` **two** `Exec` tasks — `checkGlobalState` (`bash scripts/check-global-state.sh`,
§6.4) and `checkNoDirectLlmHttp` (`bash scripts/check-no-direct-llm-http.sh`, §6.5) — so both gates
run on every local `./gradlew test` too, with no separate pipeline step. Both are
`onlyIf { !os.name.contains("win") }` (the gates are bash; CI is Linux) and both sit in Gradle's
`verification` group.

### 5.5 Coverage floors and exclusions — quoted

**CLI** (`cli/vite.config.ts`, `test.coverage`) — provider `v8`, reporters `["text", "json-summary"]`:

```ts
exclude: ["src/Types.ts", "vite.config.ts", "test/**", "src/graph/assets/**"],
thresholds: {
    statements: 97,
    branches: 96,
    functions: 97,
    lines: 97,
},
```

The unit run's own file exclusions (`test.exclude`, distinct from coverage exclusions):

```ts
exclude: ["test/sync-acceptance/**", "**/node_modules/**", "**/dist/**"],
```

Other CLI test settings that matter when a test looks flaky: `pool: "forks"` (pinned explicitly —
vitest 4.x's implicit pool resolution fails to inject worker context on Node 24.10 / Windows),
`testTimeout: 45000`, `hookTimeout: 45000`, `clearMocks: true`, `unstubEnvs: true`,
`unstubGlobals: true`, and `restoreMocks` deliberately **omitted** (turning it on breaks ~175 tests
that rely on module-top-level `vi.spyOn`s surviving across `it()` calls).

**CLI acceptance** (`cli/vitest.acceptance.config.ts`) — **no coverage block, no thresholds**.
`testTimeout: 30_000`, `fileParallelism: false` (each test builds its own bare repo + worktrees;
parallel runs race).

**VS Code** — the config the test script actually uses is `vscode/vitest.config.ts` (passed
explicitly as `--config` by `run-vitest.mjs`). Provider `custom` pointing at
`@vitest/coverage-v8/dist/index.js`, reporters `["text", "json-summary", "html"]`, `include:
["src/**/*.test.ts"]`, `environment: "node"`:

```ts
exclude: [
    "vite.config.ts",
    "vitest.config.ts",
    "esbuild.config.mjs",
    "scripts/**",
    "dist/**",
    "assets/**",
],
thresholds: {
    statements: 97,
    branches: 97,
    functions: 97,
    lines: 97,
},
```

Note the **branches floor is 97 here, not 96** — the extension is held one point higher than the CLI
on branches.

A second file, `vscode/vite.config.ts`, also defines a coverage block with the same 97/97/97/97
thresholds plus `clearMocks` / `unstubEnvs` / `unstubGlobals`, and its exclude list additionally
contains `"src/Types.ts"`. It is **not** the config used by `npm run test -w vscode`, which always
passes `--config vitest.config.ts`. If you change one, check whether the other needs the same change.

> **⚠ Second discrepancy with the repo's own prose.** `AGENTS.md`'s critical rules list only
> "**Do not regress CLI test coverage**" with the CLI's 97/96/97/97 figures. The VS Code workspace
> enforces its **own** 97/97/97/97 floor and will fail `npm run all` independently. Treat both as
> gating.

**IntelliJ** — `kover` is applied (`0.9.1`) and configures `reports.filters.excludes.classes(...)`
for UI/IDE-dependent classes (`actions.*`, most of `toolwindow.*`, `settings.*`,
`JolliMemoryIcons*`, `services.JolliMemoryStartupActivity*`, `services.JolliMemoryService*`), but
declares **no verification rule and no percentage threshold**. There is no numeric coverage floor for
the IntelliJ plugin in `build.gradle.kts`.

---

## 6. Conventions that gate a change

### 6.1 Formatting (Biome 2.2.6)

`cli/biome.json`:

```json
"formatter": { "enabled": true, "indentStyle": "tab", "indentWidth": 4, "lineWidth": 120 },
"javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } }
```

Tabs, 4-wide, 120 columns, double quotes, always semicolons. `files.includes` is
`["src/**", "!src/graph/assets", "!src/core/localagent/__fixtures__"]` — both the vendored graph viz
assets and the recorded local-agent CLI fixtures (§4.6) are out of scope; the fixtures are captured
third-party output, so formatting them would corrupt the observation. Import organization runs as an
assist: `assist.actions.source.organizeImports: "on"`.

`vscode/biome.json` is deliberately narrower: **`formatter.enabled: false`** and
**`assist.enabled: false`** — only the linter runs there, over `files.includes: ["src/**"]`.

### 6.2 Lint rules that are errors (not warnings)

CI runs `biome check --error-on-warnings`, so **warnings fail too**. The distinction still matters
for local triage:

| Rule | CLI | VS Code |
|---|---|---|
| `correctness/noUnusedImports` | **error** | recommended default |
| `correctness/noUnusedVariables` | **error** | recommended default |
| `suspicious/noExplicitAny` | **error** | recommended default |
| `style/noRestrictedImports` | **error** | **error** |
| `style/useConst` | warn | — |
| `style/useImportType` | warn | — |
| `style/useNodejsImportProtocol` | warn | — |
| `performance/noDelete` | **off** | — |

**The restricted-import rule** bans `node:child_process` and `child_process` in both workspaces. The
message is the spec:

> Use `src/util/Subprocess.ts` wrappers (`execFileSyncHidden`, `execFileAsyncHidden`, `spawnHidden`,
> `spawnSyncHidden`) instead — they inject `windowsHide:true` so child processes do not flash a
> console window on Windows.

Exemptions, via `overrides` in each config:

- `cli/biome.json` → `includes: ["src/util/Subprocess.ts", "**/*.test.ts"]` — the wrapper module
  itself plus all tests.
- `vscode/biome.json` → `includes: ["**/*.test.ts"]` — **tests only**. There is no
  `vscode/src/util/Subprocess.ts`; VS Code code imports the CLI's wrappers across the package
  boundary.

Note `vscode/scripts/run-vitest.mjs` imports `node:child_process` directly and is legal — `scripts/`
is outside `files.includes`.

The lint scope also differs by invocation: `cli` runs `biome check --error-on-warnings` (scope from
`files.includes`), `vscode` runs `npx biome check --error-on-warnings src/` (explicit path argument).

### 6.3 Path normalization

Use `toForwardSlash` from `cli/src/core/PathUtils.ts` for `\` → `/` conversion. Never inline
`path.replace(/\\/g, "/")` or `.split(sep).join("/")`. Biome cannot lint this, so it is enforced
socially and is a review-blocker. Use `normalizePathForCompare` when you also need lowercasing or a
trailing-slash strip. See `AGENTS.md` for the full exemption list.

### 6.4 The one-JVM parallel-test constraint (IntelliJ)

`intellij/build.gradle.kts` → `test { maxParallelForks = 1; maxHeapSize = "2g" }`. Parallelism lives
**inside** that single JVM, configured by `intellij/src/test/resources/junit-platform.properties`:

```properties
junit.jupiter.execution.parallel.enabled=true
junit.jupiter.execution.parallel.mode.default=same_thread
junit.jupiter.execution.parallel.mode.classes.default=concurrent
junit.jupiter.execution.parallel.config.strategy=dynamic
junit.jupiter.execution.parallel.config.dynamic.factor=1.0
junit.jupiter.execution.timeout.default = 2m
junit.jupiter.extensions.autodetection.enabled=false
junit.jupiter.extensions.autodetection.exclude=com.intellij.*
```

Test **classes** run concurrently on a work-stealing pool; **methods within one class** stay on a
single thread so per-class `@BeforeEach`/`@AfterEach` never interleave. That is only safe while no
test mutates JVM-global state, which is what the ratcheting gate enforces.

**`intellij/scripts/check-global-state.sh`** — two gates, each with a baseline file that may only ever
**shrink**:

| Gate | Scanned pattern | Scope | Baseline |
|---|---|---|---|
| 1 — production globals | `System.(out\|err\|`in`\|getProperty\|setProperty\|getenv)` and bare `println(` | `src/main/**/*.kt`, excluding `core/HookEnv.kt` | `intellij/scripts/main-globals-baseline.txt` |
| 2 — test mutations | `mockkStatic\|mockkObject\|mockkConstructor\|System.set(Property\|Out\|Err\|In)\|System.clearProperty` | `src/test/**/*.kt` | `intellij/scripts/test-mutations-baseline.txt` |

The rules in practice:

- Production code that needs a JVM global takes an `env: HookEnv = HookEnv()` parameter
  (`intellij/src/main/.../core/HookEnv.kt` is the only legal touchpoint).
- Tests build a fake with `fakeHookEnv(...)` from `core/TestEnvs.kt` and pass it in — never
  `System.setProperty`, never `mockkStatic` / `mockkObject` / `mockkConstructor`.
- Legacy offenders are frozen in the baselines and carry `@Isolated`. When you migrate one, drop the
  annotation and regenerate the baseline via the script's `regen` mode
  (`bash intellij/scripts/check-global-state.sh regen`).
- The script sets `export LC_ALL=C` because `comm(1)` needs both inputs sorted under identical
  collation rules — baselines written under one locale misalign under another.

`autodetection.enabled=false` is documented in-file as defence in depth only; the line that actually
holds is `autodetection.exclude=com.intellij.*`, applied at extension-registration time. Both are
also set as system properties in `build.gradle.kts` (which take precedence over the properties file)
and asserted by `JUnitConfigurationGateTest`.

### 6.5 The no-direct-LLM-HTTP gate (IntelliJ)

`intellij/scripts/check-no-direct-llm-http.sh`, wired into `test` alongside the global-state ratchet
(§5.4). It greps `src/main/**/*.kt` for the single alternation
`api\.anthropic\.com|java\.net\.http` and compares the hit set against an inline `ALLOWLIST`.

**It has no baseline, deliberately** — unlike §6.4's two ratchets. The Kotlin LLM stack was deleted
outright, so provider routing now lives in exactly one place (`cli/src/core/LlmClient.ts`) and the
plugin reaches it through the bundled CLI. A hit means fix the code, not baseline it.

The gate is **bidirectional**, and the second half is the easy one to miss:

| Half | Fails when | Required fix |
|---|---|---|
| new offender | a production Kotlin file matches the pattern and is **not** on the allowlist | route the call through the CLI bridge, or extend `ALLOWLIST` with review |
| stale allowlist | an allowlist entry **no longer** matches the pattern | delete the entry, in the same PR that removed the last legitimate use |

`ALLOWLIST` currently holds exactly **one** file:
`src/main/kotlin/ai/jolli/jollimemory/core/telemetry/TelemetryFlusher.kt`. Like §6.4's script it
`export LC_ALL=C`s, because `comm(1)` needs both inputs sorted under identical collation.

> **⚠ Stale prose inside the gate itself.** The script's header comment says production Kotlin must
> not import `java.net.http` "outside the three known Jolli Space / auth / telemetry HTTP consumers,"
> and line 35 repeats "the small set." The allowlist is **one** entry, and one entry is all the tree
> needs — the Jolli Space and auth clients were rewritten onto the CLI bridge in the same migration,
> which is exactly what the stale-allowlist half of the gate would have caught had they not been
> removed from the list. Trust the `ALLOWLIST` array, not the comment above it.

**What the gate does not catch.** The pattern is two literals, so it is a tripwire, not a proof. A new
Kotlin caller passes it by using the older `java.net.URL` / `URLConnection` API, by bundling a
third-party HTTP library, or by talking to a different vendor's host. It also says nothing about
*inbound* HTTP — the plugin's loopback sign-in listener is untouched by it. Read a green gate as
"nobody reintroduced the obvious thing", and review new network code on its merits.

### 6.6 Commit and PR hygiene

- `git commit -s` on every commit. `.github/workflows/verify-dco.yaml` rejects PRs without
  `Signed-off-by:`.
- No `Co-Authored-By: Claude …` trailer, no `🤖 Generated with …` footer, in commits or PR bodies.
  Only `Signed-off-by:` belongs there.
- Release tags are sigstore-signed (`gitsign`) and verified against an OIDC identity allowlist by the
  publish workflows. Independent of, and additional to, the DCO requirement.

### 6.7 Cross-cutting invariants that break silently

- **All LLM traffic routes through the CLI** — `cli/src/core/LlmClient.ts` is the single provider-routing
  implementation, and the CLI, VS Code, and IntelliJ are behavior-identical by construction because
  the other two reach it rather than reimplementing it. On the IntelliJ side this is machine-enforced
  (§6.5); on the VS Code side it follows from the bundle. Do not add a second LLM stack in any
  language.
- **Three implementations of the API key parser stay in lockstep** —
  `cli/src/core/JolliApiUtils.ts` (canonical), the VS Code bundle (imports the canonical file
  verbatim across the package boundary), and the Kotlin port in `intellij/`.
- **Cross-package imports in `vscode/src/**` are intentional** — paths like
  `../../../cli/src/core/JolliApiUtils.js` resolve at esbuild bundle time. Do not "clean them up"
  into a published-package import.
- **Worktree-aware code only** — hooks, summary storage, and lock files must work across
  `git worktree` checkouts.
- **`cli/vite.config.ts`, `vscode/vitest.config.ts`, `vscode/vite.config.ts`, and either
  `biome.json`** — do not change thresholds, coverage exclusions, or lint rules without asking. Do
  not add coverage exclusions.

---

## 7. Where the CI gates live

| Workflow | Trigger | What it runs |
|---|---|---|
| `.github/workflows/build-vscode.yaml` ("CI - CLI + VS Code") | PR / push | `npm ci` → **`npm run all`** → assert the IntelliJ bundling contract on `vscode/dist/Cli.js` |
| `.github/workflows/build-intellij.yaml` ("CI - IntelliJ") | PR / push | JDK 21 (temurin) + Node from `.nvmrc` → `npm ci` → `npm run build` → `./gradlew buildPlugin test verifyPlugin -x buildSearchableOptions` |
| `.github/workflows/verify-dco.yaml` | PR | `Signed-off-by:` presence |
| `.github/workflows/scorecard.yaml` | scheduled | OSSF scorecard |
| `.github/workflows/publish-cli.yaml` | manual, with an existing signed tag | npm publish `@jolli.ai/cli` (tag prefix `release-cli-v`) |
| `.github/workflows/publish-vscode.yaml` | manual, with an existing signed tag | VS Code Marketplace + Open VSX (tag prefix `release-vscode-v`); idempotent per-marketplace on retry |
| `.github/workflows/publish-intellij.yaml` | manual | JetBrains Marketplace |

There is no `build-cli.yaml` — the CLI is gated by `build-vscode.yaml`'s `npm run all`, which covers
both npm workspaces despite the workflow's filename.
