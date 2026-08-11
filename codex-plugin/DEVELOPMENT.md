# Jolli Memory Codex plugin — development

How to build, test, distribute, and release the Codex plugin. For end-user
installation and the list of user-facing capabilities, see [README.md](README.md).

The plugin is both a consumption surface and a repository bootstrap. Its
`SessionStart` hook reconciles the source-neutral repository hooks that capture
development context from git activity, and registers the bundled runtime's MCP
server with Codex (globally — see [MCP registration](#mcp-registration) for why it
is not in the plugin manifest). The plugin is self-contained; users do not need a
separate `jolli` CLI installation.

## Layout

```text
codex-plugin/
├── .agents/plugins/marketplace.json        # marketplace catalog
├── README.md                               # end-user documentation
├── LICENSE                                 # Apache-2.0, mirrored into every release
├── DEVELOPMENT.md                          # this file
├── scripts/
│   ├── _publish-lib.sh                     # shared build, validation, sync, and release logic
│   ├── publish-local.sh                    # clean local marketplace mirror
│   ├── publish-dev.sh                      # private marketplace release
│   ├── publish-prod.sh                     # public marketplace release
│   └── publish-zip.sh                      # marketplace archive
└── plugins/jolli/
    ├── .codex-plugin/plugin.json           # plugin manifest and independent version
    ├── LICENSE                             # same text again — this dir is the installed unit
    ├── hooks/hooks.json                    # single SessionStart bootstrap hook
    │                                       # (no .mcp.json — see "MCP registration")
    ├── skills/                             # bare-named dirs; Codex shows them as $jolli:*
    ├── scripts/
    │   ├── build.mjs                       # esbuild -> dist/
    │   └── generate-skills.ts              # regenerate committed SKILL.md files
    └── dist/                               # built bundles; gitignored in this monorepo
```

## Architecture

### SessionStart bootstrap

Codex loads one manifest hook:

```text
SessionStart -> dist/CodexPluginBootstrapHook.js
```

The bootstrap:

1. resolves the active git worktree root;
2. respects the repository-wide manual-disable flag;
3. installs or reconciles the shared git runtime and hooks;
4. sweeps retired skill names out of `.agents/skills/` (retired names only — it never
   removes an active skill from that shared cross-platform directory);
5. selects Codex as the default local summarization agent when no provider has
   already won the first-write race;
6. injects a branch briefing into the new session.

It deliberately does not write `.claude/**`, install Claude agent hooks, or record
Claude-style session metadata. Codex transcripts are discovered by the Codex
session discoverer during post-commit processing.

Codex requires new or changed command hooks to be reviewed. A local test is not
complete until the developer opens `/hooks`, reviews the Jolli SessionStart hook,
and trusts it.

### MCP registration

**This plugin ships no `.mcp.json`, and must not.** The MCP server is registered
into the global `~/.codex/config.toml` by the same `enable --repo-hooks-only` the
bootstrap and `jolli:init` run. Codex reads MCP registrations at session start, so
the server appears from the session *after* install; the skills' documented
`run-cli` fallback covers that first session.

The reason is the working directory. Codex does not expand `${PLUGIN_ROOT}` inside
an MCP entry, so a plugin entry must use a relative command plus `cwd: "."` — the
shape both stdio plugins OpenAI ships use — and Codex resolves that relative cwd
against the **plugin root**. Every Jolli memory tool derives the repository it
serves from its cwd, so a plugin-launched server answers `recall` / `search` /
`status` for the plugin's own cache directory: empty results that look successful,
plus a placeholder Memory Bank repo named after the bundle's version directory.

Measured on codex-cli 0.146.0 with a probe plugin:

| | plugin `.mcp.json` (`cwd: "."`) | global `config.toml` (no cwd) |
|---|---|---|
| server `process.cwd()` | `~/.codex/plugins/cache/<mp>/<plugin>/<version>` | the session directory |
| client `roots` capability | not declared (`roots/list` → `{"roots": []}`) | same |
| env passed to the server | `HOME LOGNAME PATH SHELL TMPDIR USER __CF_USER_TEXT_ENCODING` | same |

Nothing in that env or protocol surface names the workspace, so a plugin-launched
server cannot recover it. `startMcpServer` therefore refuses to run when its cwd is
inside a plugin bundle, so reintroducing a manifest entry fails loudly instead of
silently serving the wrong repository.

`dist/McpLauncher.js` survives for a narrower job: on Windows the global entry
cannot use the extensionless `run-cli` script, so it spawns `node <launcher>`, which
re-resolves the winning distribution on every MCP start instead of freezing the
version resolved at registration time. POSIX keeps `run-cli` and needs no launcher.

### Runtime completeness

Every competing Jolli distribution must be able to serve the shared repository
hooks, including hooks used by another host. Therefore the Codex bundle includes
all of the following even though its manifest registers only the bootstrap:

- `Cli.js`
- `CodexPluginBootstrapHook.js`
- `McpLauncher.js`
- `StopHook.js` and `SessionStartHook.js`
- `PostCommitHook.js`, `PostMergeHook.js`, `PostRewriteHook.js`,
  `PrepareMsgHook.js`, and `PrePushHook.js`
- `QueueWorker.js` and `PrePushWorker.js`
- `DashboardServerEntry.js` plus its `dashboard-assets/` tree — this dist can win
  dist-paths arbitration, and `jolli dashboard` spawns that entry by name from its
  own directory

The build and publish scripts assert this exact inventory. Omitting a git hook or
worker can turn a user's git operation into `node <missing-file>` and block it.

## Prerequisites

From a fresh clone, install the root npm workspaces first:

```bash
npm install
```

The plugin has no independent `node_modules`. Its build resolves esbuild and the
CLI runtime dependencies from the monorepo workspaces/root installation.

For runtime testing:

- Node.js must be available on `PATH`, or recorded by a supported Jolli IDE
  integration.
- Codex must be installed and signed in (`codex login`) for the default local-agent
  provider.
- `rsync` is required by the marketplace mirror scripts.
- `zip` is required only by `publish-zip.sh`.
- Windows workflow runs require Git Bash; WSL and WindowsApps bash do not share the
  expected Jolli home directory.

## Build

From the monorepo root:

```bash
npm run build:codex-plugin
```

Equivalent direct command:

```bash
node codex-plugin/plugins/jolli/scripts/build.mjs
```

For an iterative build loop:

```bash
node codex-plugin/plugins/jolli/scripts/build.mjs --watch
```

The build:

- reads the plugin version from `plugins/jolli/.codex-plugin/plugin.json`;
- reads the embedded core version from `cli/package.json`;
- bundles `cli/src/**` as CommonJS with esbuild target `node22` (the runtime floor, matching the CLI's `engines.node`);
- identifies network requests as `codex-plugin/<plugin-version>`;
- validates that `hooks.json` contains exactly one SessionStart bootstrap;
- validates the exact 13-entry output inventory;
- removes the old `dist/` before a non-watch build to prevent stale bundles.

## Skills

Skill bundle directories carry BARE names (`recall`, not `jolli-recall`), matching
the Claude plugin's `skills/recall/` layout. Codex prefixes a plugin's skills with
the plugin's own name, so the model — and the user — see:

```text
$jolli
$jolli:init
$jolli:login
$jolli:logout
$jolli:status
$jolli:recall
$jolli:search
$jolli:timeline
$jolli:push
$jolli:local-run
$jolli:remote-run
```

Canonical templates live in `cli/src/install/CodexPluginSkills.ts` and shared
builders in `cli/src/install/SkillInstaller.ts`. The committed plugin copies are
generated files. After changing a template, regenerate them from the repository
root:

```bash
npx tsx codex-plugin/plugins/jolli/scripts/generate-skills.ts
```

Then run `CodexPluginSkills.test.ts`; it checks byte-for-byte agreement between
the templates and committed `SKILL.md` files.

The four shared builders (`recall`, `search`, `local-run`, `remote-run`) are authored
for the CLI's `.agents/skills/`, which has no namespace, so they declare the prefixed
`jolli-recall` name and refer to each other that way. `renderCodexPluginSkill`
re-heads the bundled copy with the bare directory name and re-points those sibling
references at `jolli:<name>` — a bundled copy telling the model to "run jolli-recall"
would name a skill that does not exist on a plugin-only install.

When editing a shared skill body in `SkillInstaller.ts`, follow the repository
rule in `AGENTS.md`: bump its `metadata.revision` and update the pinned fingerprint
in the same change. The Codex renderer strips the metadata block from the bundled
copy, but the source template's revision still controls installed CLI copies.

## Local end-to-end testing

### Recommended: clean marketplace mirror

Run:

```bash
bash codex-plugin/scripts/publish-local.sh
```

By default this builds the plugin and mirrors a consumer-clean marketplace tree
to:

```text
../codex-plugin-marketplace-local
```

The mirror excludes development-only scripts, this file, `.gitignore`, and other
monorepo scaffolding. This is preferable to testing the source tree directly
because it catches files that were accidentally available only in the monorepo.

Install the mirror using the commands printed by the script:

```text
codex plugin marketplace add /absolute/path/to/codex-plugin-marketplace-local
codex plugin add jolli@jolli-marketplace
```

Codex caches installed plugins under `~/.codex/plugins/cache/`. After rebuilding
or republishing the same local version, reinstall the plugin so the cached copy is
refreshed:

```text
codex plugin remove jolli@jolli-marketplace
codex plugin add jolli@jolli-marketplace
```

Start a new session, open `/hooks`, and trust the Jolli SessionStart hook.

### Fast source-tree iteration

Codex can also read the in-repository marketplace at the absolute path to:

```text
<repo>/codex-plugin
```

Build `dist/` first. Use this only for a tight edit loop; perform the final local
rehearsal against the clean `publish-local.sh` mirror.

### Local acceptance checklist

Verify at least the following in a disposable git repository or worktree:

1. The marketplace and plugin install successfully.
2. All 11 skills appear, and appear under the `jolli:` namespace — the bare `$jolli`
   front door plus `$jolli:init` … `$jolli:remote-run`. A stuttering `$jolli:jolli-…`
   means a bundle directory regained its `jolli-` prefix.
3. The SessionStart hook can be reviewed and trusted.
4. A new session installs/reconciles repository hooks and shows a branch briefing.
5. In the session AFTER the first one, the `jollimemory` MCP server starts and
   exposes its tools — and `$jolli:status` (or the `status` tool) reports the
   USER'S repository, not a path under `~/.codex/plugins/cache/`. Getting the cache
   directory back means an MCP entry is being launched from the plugin bundle.
6. `$jolli:status` reports Codex discovery and the local-agent provider correctly.
7. A commit is queued and processed without blocking git.
8. `$jolli:recall`, `$jolli:search`, and `$jolli:timeline` return expected data.
9. Manual disable prevents automatic reconciliation.
10. Claude and Codex plugins can coexist without Codex modifying `.claude/**`.
11. If workflow integrations are available, test one local or remote workflow in a
    non-production Space.

## Automated tests

Run the Codex-specific manifest, bootstrap, and skill tests from the monorepo root:

```bash
npx vitest run --config cli/vite.config.ts \
  cli/src/hooks/CodexPluginManifest.test.ts \
  cli/src/hooks/CodexPluginBootstrapHook.test.ts \
  cli/src/install/CodexPluginSkills.test.ts
```

Before committing any repository change, run the required full verification:

```bash
npm run all
```

`npm run all` performs clean, build, typecheck, lint, unit tests, coverage checks,
and acceptance tests. The repository requires this command to pass before commit.

## Publish scripts

All publish scripts live in `codex-plugin/scripts/` and share
`_publish-lib.sh`. Each path builds `dist/`, verifies the exact runtime and skill
inventories, and validates critical manifest/configuration files before producing
an artifact.

| Script | Default output | Git operation | Use case |
|---|---|---|---|
| `publish-local.sh` | `../codex-plugin-marketplace-local` | None | Recommended local end-to-end rehearsal |
| `publish-dev.sh` | `../jolli-chatgpt-plugin-dev` | Commit and push | Dev/rehearsal release; no version guard, so one version can be republished repeatedly |
| `publish-prod.sh` | `../jolli-chatgpt-plugin` | Commit and push | Marketplace release users install from |
| `publish-zip.sh` | `~/Desktop/jolli-chatgpt-plugin-marketplace.zip` | None | Review or offline marketplace transfer |

The two git destinations are:

| Stage | Repository | Default checkout |
|---|---|---|
| dev | `jolli-plugin-dev/jolli-chatgpt-plugin` | `../jolli-chatgpt-plugin-dev` |
| prod | `jolliai/jolli-chatgpt-plugin` | `../jolli-chatgpt-plugin` |

The distribution repositories are named **`jolli-chatgpt-plugin`** while this
directory is `codex-plugin/` — the repository name is user-facing (Codex ships
inside ChatGPT), the directory name follows the Codex plugin protocol it
implements. Both stages use the SAME repository name in different orgs, which is
why the dev checkout carries a `-dev` suffix locally; nothing but the local
directory name differs.

Because both stages share a repository name, the install command a reader should
type differs per target while the source tree has only one README. `README.md`
therefore keeps a neutral `<marketplace-source>` placeholder in its
`codex plugin marketplace add` line, and every publish script resolves it on the
**mirrored copy** (`publish_readme_source` in `_publish-lib.sh`) — the dev org slug,
the prod org slug, the local directory, or a generic absolute path for the zip. The
placeholder must survive in the source README: publishing fails loudly if it is
missing, because the alternative is shipping users a command that cannot work.

Clone them once before the first git-backed publish:

```bash
git clone git@github.com:jolli-plugin-dev/jolli-chatgpt-plugin.git ../jolli-chatgpt-plugin-dev
git clone git@github.com:jolliai/jolli-chatgpt-plugin.git ../jolli-chatgpt-plugin
```

Examples:

```bash
bash codex-plugin/scripts/publish-local.sh
bash codex-plugin/scripts/publish-local.sh /tmp/jolli-codex-marketplace
NO_PUSH=1 bash codex-plugin/scripts/publish-dev.sh
bash codex-plugin/scripts/publish-prod.sh /path/to/jolli-chatgpt-plugin
bash codex-plugin/scripts/publish-zip.sh /tmp/jolli-chatgpt-plugin-marketplace.zip
```

For git-backed releases:

- The destination must already be a git checkout.
- The publish script mirrors with `rsync --delete`; its destination safety guard
  accepts only an empty directory or an existing Codex marketplace checkout.
- `JOLLI_PUBLISH_FORCE=1` overrides the safe-destination and version guards; use it
  only for an intentional operation.
- `NO_PUSH=1` creates the signed release commit but leaves it unpushed for review.
- Release commits use DCO sign-off automatically.
- **The version guard applies to `publish-prod.sh` only.** If content changed, a prod
  publish stops unless the plugin version is strictly higher than the last release in
  that repository — an equal version strands installed users on "up to date", and a
  lower one does the same while still reading as a release.
- **`publish-dev.sh` skips it deliberately**, by passing `dev` as the third argument
  to `publish_git_repo` (the only behavioural difference between the two scripts). A
  rehearsal republishes the same build repeatedly, and bumping per rehearsal is how
  the Claude dev marketplace ran to 1.0.5 while prod was on 1.0.1 — after which the
  guard began refusing legitimate releases on the rehearsal target. The cost: a
  same-version dev republish leaves the version-stamped copy under
  `~/.codex/plugins/cache/` untouched, so testers must remove + re-add rather than
  update; and a green dev run no longer proves prod will accept the version.

Typical release progression:

```text
publish-local.sh -> publish-dev.sh -> publish-prod.sh
```

`publish-zip.sh` is an independent review/offline channel, not a substitute for
the git marketplace release flow.

## Versioning

The Codex plugin version lives in:

```text
codex-plugin/plugins/jolli/.codex-plugin/plugin.json
```

It is independent of `cli/package.json`. The plugin version identifies the
marketplace release and is injected into its client identity. The CLI version is
the embedded core version used by cross-distribution runtime selection.

A CLI change reaches plugin-only users only after the Codex plugin is rebuilt and
republished. Therefore, bump the plugin version whenever publishing changed plugin
content or a new embedded CLI snapshot **to production** — the guard enforces it
there. Rehearsals on the dev marketplace do not need a bump and should not get one:
the version is a release decision, and inflating it per rehearsal is what pushed the
Claude dev repo past prod and made the guard refuse real releases.

## Release checklist

1. Confirm the intended version in `.codex-plugin/plugin.json`.
2. Regenerate skills if any canonical skill template changed.
3. Run `npm run all`.
4. Run `publish-local.sh` and complete the local acceptance checklist.
5. Confirm the `codex-plugin` client kind is accepted by the server version targeted
   by the release.
6. Publish to the private marketplace with `NO_PUSH=1` if an inspectable rehearsal
   is needed.
7. Inspect the target checkout and confirm all 13 `dist/*.js` files, the
   `dist/dashboard-assets/` tree, 11 skills, marketplace manifest, plugin manifest,
   hook configuration, README, and both `LICENSE` copies (repo root and
   `plugins/jolli/`) are present — and that no `.mcp.json` has reappeared.
8. Publish the production marketplace.
9. Install the released version from the public marketplace in a clean Codex
   environment and repeat a smoke test.

## Troubleshooting

### Skills or MCP tools appear, but bootstrap behavior does not run

Open `/hooks`, review the Jolli SessionStart hook, trust it, and start a new
session. Codex does not execute new or changed command hooks before trust is
granted.

### A rebuild is not visible after reinstalling the marketplace

Remove and add the plugin again. Updating the marketplace alone may leave the
version-stamped copy under `~/.codex/plugins/cache/` unchanged.

### Build cannot resolve `esbuild`

Run `npm install` at the monorepo root. Do not install dependencies inside
`codex-plugin/`.

### Published marketplace is missing a skill or runtime file

Do not hand-copy the tree. Use the publish scripts; `_publish-lib.sh` validates the
exact expected inventory and reports the missing path. If a skill template changed,
regenerate the committed copies before publishing.

### Workflow run prerequisites fail

Local and remote workflow skills rely on optional `@jolli.ai/workflow-cli`; local
runs additionally require `@jolli.ai/space-cli` and an already-cloned git-backed
Space. On Windows, run workflow shell steps from Git Bash.
