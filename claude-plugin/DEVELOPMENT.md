# Jolli Memory Claude Code plugin — development

How to build, test locally, distribute, and release this plugin. For the
end-user install and the list of what the plugin provides, see
[README.md](README.md).

This is the **consumption + bootstrap** surface. The memory *generation* engine
runs in git hooks (`post-commit` → QueueWorker → LLM), which the Claude Code
plugin model does not cover — so the plugin's `SessionStart` hook shells the
bundled CLI to install those git hooks into the active repo (idempotent).

## Layout

```
claude-plugin/
├── .claude-plugin/marketplace.json     # the marketplace (lists the plugin)
└── plugins/jolli/
    ├── .claude-plugin/plugin.json      # plugin manifest
    ├── .mcp.json                       # jolli MCP server (node dist/Cli.js mcp)
    ├── hooks/hooks.json                # Stop + SessionStart (+ git-hook bootstrap)
    ├── skills/                         # /jolli:recall  /jolli:search  /jolli:pr  /jolli:push
    ├── commands/                       # /jolli:init  /jolli:status  /jolli:timeline  /jolli:login  /jolli:logout
    ├── agents/                         # jolli:pr-writer subagent
    ├── scripts/build.mjs               # esbuild → dist/ (Cli, Stop/SessionStart hooks, 5 git hooks, 2 workers)
    └── dist/                           # built bundles (gitignored)
```

## Build (bundle the CLI into the plugin)

The plugin is self-contained: `scripts/build.mjs` reuses the same esbuild
approach as `vscode/esbuild.config.mjs` to inline `cli/src/**` into
`plugins/jolli/dist/`. Run it after `npm install` at the repo root:

```bash
node claude-plugin/plugins/jolli/scripts/build.mjs
# or, while iterating:
node claude-plugin/plugins/jolli/scripts/build.mjs --watch
```

`esbuild` resolves from `cli/node_modules`, so build the CLI workspace first if
you haven't (`npm install`). The bundle self-identifies on the wire as
`claude-plugin/<version>` — add that client kind to the server allowlist before
release, the same way `vscode-plugin` is handled.

## Local testing

Build `dist/` first (see above), then pick one of four ways to load the plugin.
They differ in whether you type slash commands, whether the choice persists, and
— importantly — **which directory the path points at**:

- **marketplace directory** = `claude-plugin/` (holds `.claude-plugin/marketplace.json`)
- **plugin directory** = `claude-plugin/plugins/jolli/` (holds `.claude-plugin/plugin.json`)

Getting these two mixed up is the most common mistake.

### Option 1 — interactive `/plugin` commands

```
/plugin marketplace add /abs/path/to/claude-plugin
/plugin install jolli@jolli-marketplace
/reload-plugins          # after rebuilding dist/
```

Use an **absolute path** for `marketplace add` — the app's working directory is
not necessarily the repo root, so a relative `./claude-plugin` may not resolve.
`marketplace add` takes the **marketplace directory**.

### Option 2 — `settings.json` (no slash commands; persists; team-shareable)

Declare the marketplace and enable the plugin in settings, and Claude Code loads
it automatically on startup — no `/plugin` commands. This is the recommended way
for the **desktop app** (a GUI can't take a launch flag). Add to one of:

- `~/.claude/settings.json` — user-level, applies everywhere.
- `<repo>/.claude/settings.json` — project-level, checked in, shared with teammates.
- `<repo>/.claude/settings.local.json` — personal override, normally gitignored —
  **best for local testing without touching the repo.**

```json
{
	"extraKnownMarketplaces": {
		"jolli-marketplace": {
			"source": { "source": "directory", "path": "/abs/path/to/claude-plugin" }
		}
	},
	"enabledPlugins": {
		"jolli@jolli-marketplace": true
	}
}
```

- `source.path` points at the **marketplace directory** — same target as Option
  1's `marketplace add`. In a project-level settings file a repo-relative path
  such as `"./claude-plugin"` also works.
- `enabledPlugins` keys are `<plugin>@<marketplace>` → here `jolli@jolli-marketplace`.
- Settings scope precedence, low → high: user → project → local → managed.
- Restart the session (or `/reload-plugins`) to pick up changes.

### Option 3 — `--plugin-dir` launch flag (terminal `claude` only; single session)

The fastest throwaway side-load. Loads and auto-enables the plugin **for that
session only** — no marketplace, no enable step:

```bash
claude --plugin-dir /abs/path/to/claude-plugin/plugins/jolli
```

- The path here is the **plugin directory** — **not** the marketplace root that
  Options 1 and 2 use.
- Repeatable: `--plugin-dir A --plugin-dir B`.
- Terminal `claude` executable only; the desktop app has no launch flag — use
  Option 2 or 4 there.
- Caveat: the official CLI reference doesn't spell out the plugin-dir vs
  marketplace-dir distinction, but its "load **a plugin** … for this session"
  wording indicates a plugin-level path.

### Option 4 — desktop app GUI buttons

The desktop app exposes **Add marketplace** and **Upload plugin** buttons in its
plugin settings. These are **not covered by the official docs yet**, so treat the
following as inferred-and-verify (confirm the field behavior in the UI):

- **Add marketplace** — GUI equivalent of Option 1. Point it at the **marketplace
  directory** `/abs/path/to/claude-plugin`. Registering the marketplace does not
  enable the plugin — enable **Jolli Memory** afterward under **Manage plugins**.
  Best for iterating: it references the local directory, so rebuild `dist/` and
  reload — no re-packaging.
- **Upload plugin** — a single-plugin side-load (akin to `--plugin-dir`). Point it
  at the **plugin directory** `/abs/path/to/claude-plugin/plugins/jolli` —
  one level deeper than Add marketplace. If it accepts only a `.zip`, the
  archive's top level must be the plugin **folder** `jolli/` (so `plugin.json`
  sits at `jolli/.claude-plugin/plugin.json`), and it must include the built
  `dist/`. A flattened zip with `plugin.json` at the archive root is silently
  rejected. Just run `bash claude-plugin/scripts/publish-zip.sh` — it builds
  `dist/` and produces a correctly-laid-out zip. An uploaded zip is a frozen snapshot —
  you re-zip on every change, so prefer Add marketplace for iteration.

Whichever option you use, the MCP tools, `/jolli:*` skills/commands, and the
hooks are then live.

## Distribution (npm)

The plugin ships as an npm package (e.g. `@jolli.ai/claude-plugin`) whose tarball
must include **every runtime file the plugin loads**, not just the build output.
There is no publishing `package.json` here yet; when you add one, a
`prepublishOnly` should run `build.mjs`, and the `files` whitelist must list all of:

- `dist/` — bundled `Cli.js`, the Stop/SessionStart hooks, the five git hooks
  (`PostCommitHook.js` / `PostMergeHook.js` / `PostRewriteHook.js` /
  `PrepareMsgHook.js` / `PrePushHook.js`), and the `QueueWorker.js` /
  `PrePushWorker.js` workers. Omitting any git-hook or worker file turns the
  corresponding git hook into `node <missing file>` and BLOCKS the commit.
- `.claude-plugin/plugin.json` — the manifest.
- `.mcp.json` — the MCP server registration; without it the 10 MCP tools never load.
- `hooks/`, `skills/`, `commands/`, `agents/` — the Stop/SessionStart hooks, the
  `/jolli:*` skills and commands, and the `jolli:pr-writer` subagent.

> ⚠️ **`files: ["dist"]` alone ships a broken plugin** — `dist/` is only the bundled
> CLI; the manifest, `.mcp.json`, hooks, skills, commands, and agent all live outside
> it. Two of these are also `.gitignore`-sensitive: `.mcp.json` is caught by the repo
> root's broad `.mcp.json` rule and `skills/**/SKILL.md` by a global `SKILL.md` rule,
> so both are re-included via `!`-exceptions in the repo root `.gitignore`. Keep those
> exceptions, and mirror the **same full set** in the npm `files` whitelist.

The marketplace entry points at it with an `npm` source:

```json
{ "name": "jolli", "source": { "source": "npm", "package": "@jolli.ai/claude-plugin" } }
```

On install, Claude Code runs `npm install` internally to fetch and extract the
package into `~/.claude/plugins/cache/…`. The end user needs neither npm on PATH
nor registry auth for a public package; the bundled `dist/Cli.js` is present
after extraction. (A Node-free install would mean shipping a standalone compiled
binary — Node SEA / bun / pkg — per platform, deliberately out of scope for now;
`node` itself stays a hard requirement, see [`McpRegistration.ts`](../cli/src/install/McpRegistration.ts).)

`git-subdir` distribution was rejected: it serves only committed files, but
`dist/` is a gitignored build artifact (repo policy — the root `.gitignore`
ignores `**/dist/`), so a git-subdir clone would arrive without the bundled
`Cli.js`. npm carries the artifact in the tarball instead.

**Marketplace hosting.** `/plugin marketplace add owner/repo` only looks for
`.claude-plugin/marketplace.json` at the repo **root**, so the catalog cannot
live in this monorepo subdir as-is. Host it either as a small dedicated
marketplace repo (`jolliai/claude-plugins`; users run `/plugin marketplace add
jolliai/claude-plugins`) or move `marketplace.json` to the monorepo root
`.claude-plugin/`.

## Versioning & releases

The plugin is a **third CLI-bundling surface** alongside the VS Code extension,
and it follows the same rule the repo already applies to VS Code: **bundling
surfaces version and release independently — they are NOT locked to the CLI's
release cadence.**

- **Independent version & release track.** The plugin carries its own semver (in
  `plugin.json` / its npm package) and its own release tag. A CLI hotfix does
  not require a plugin release, and vice versa — exactly as `release-cli-v` and
  `release-vscode-v` are independent today (see `RELEASE.md` / `CLAUDE.md`: "CLI
  and VS Code versions are independent").

- **The only real coupling is a build-time snapshot, not a release lock.**
  `build.mjs` inlines a snapshot of `cli/src/**` frozen at build time (same as
  the VS Code extension). To ship a CLI change to plugin users you rebuild and
  republish the plugin; until you do, the plugin keeps serving its bundled
  snapshot — it lags, it does not break. (`RELEASE.md` already documents this for
  VS Code: rebuild the CLI before packaging because the bundle inlines it.)

- **The plugin soft-prefers its own dist, but competes on version.** The plugin's
  git hooks and CLI commands (`init`/`login`/`logout`/`recall`/`search`/`status`)
  set `JOLLI_DIST_PREFER_SOURCE=claude-plugin`, so `resolve-dist-path` picks the
  `dist-paths/claude-plugin` entry when it is present, complete, and already at the
  top version — winning a version **tie** ahead of the global cli/vscode/cursor
  order. But a strictly-higher-version vscode/cli dist still wins, and a missing /
  incomplete / older plugin dist falls through to normal cross-source selection
  (never a hard fail — the former `JOLLI_DIST_SOURCE` hard pin is gone; all sources
  compete now). The plugin's MCP server and agent hooks still launch their own
  bundle directly via `${CLAUDE_PLUGIN_ROOT}/dist/*` — they are per-host, not
  shared cross-source resources. The `dist-paths/<source>` core version
  (`__CLI_PKG_VERSION__`, injected by `build.mjs` from `cli/package.json`) drives
  cross-source selection for every surface; the plugin's marketing version is
  irrelevant — no lockstep check between `plugin.json` and `cli/package.json` is
  needed. See the soft prefer in
  [`DispatchScripts.ts`](../cli/src/install/DispatchScripts.ts) and
  [`DistPathWriter.ts`](../cli/src/install/DistPathWriter.ts).

Mental model: *the plugin releases independently like the VS Code extension; it
inlines a build-time snapshot of the CLI core, so republishing the plugin is
what propagates CLI changes — a build step, not a version lock.*

## Open items before shipping

- ~~CLI needs a narrow `enable --git-hooks-only` entry for the SessionStart
  bootstrap.~~ **Done** — `jolli enable --git-hooks-only` installs only the git
  hooks (+ dispatch scripts + dist-path entry), skipping MCP/skills/agent hooks,
  and is silent on success. **One addition:** it writes the bare `/jolli` umbrella
  menu into `.claude/skills/jolli/` and git-excludes it — a plugin skill can only
  ever be invoked as `/jolli:<name>`, so the bare `/jolli` front door has to come
  from a non-plugin project skill (the umbrella routes to the plugin's own
  `/jolli:*` skills). It does NOT write `~/.claude/CLAUDE.md`, and it does NOT
  delete any of the user's other skills — one surface must not stomp another's
  state. See `cli/src/install/Installer.ts` (mirror of `--integrations-only`),
  `cli/src/install/SkillInstaller.ts` (`installPluginJolliMenu`), and
  `cli/src/commands/EnableCommand.ts`.
- ~~Verify plugin-namespaced MCP tool ids and align the skill bodies.~~
  **Done** — plugin MCP tools are exposed as `mcp__plugin_jolli_jollimemory__<tool>`;
  the skills reference the tool by capability ("the `recall` tool from the
  jollimemory MCP server"), so the namespaced id resolves without hard-coding.
  Skills are invoked as `/jolli:recall` etc. (plugin namespace is mandatory).
- **Register the `claude-plugin` client kind** on the server allowlist.
- **`parseJolliApiKey` lockstep** (CLAUDE.md): this bundle is a 4th consumer of
  `cli/src/core/JolliApiUtils.ts` alongside CLI / VS Code / IntelliJ.
- **npm `files` whitelist must ship the whole plugin, not just `dist/`.** When the
  publishing `package.json` is added, include `dist/`, `.claude-plugin/plugin.json`,
  `.mcp.json`, `hooks/`, `skills/`, `commands/`, `agents/`. `.mcp.json` and
  `skills/**/SKILL.md` are `.gitignore`-re-included at the repo root (see the
  Distribution section) — the published package needs that same full set, or it
  ships without its MCP server and skills. Verify with `npm pack --dry-run` before
  releasing.
