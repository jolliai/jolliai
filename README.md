# Jolli Memory

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jolliai/jolliai/badge)](https://scorecard.dev/viewer/?uri=github.com/jolliai/jolliai)

> *Every commit deserves a Memory. Every memory deserves a Recall.*

**Jolli Memory** automatically turns your AI coding sessions into structured development documentation attached to every commit, without any extra effort.

When you work with AI agents like Claude Code, Codex, Gemini CLI, OpenCode, Cursor IDE, GitHub Copilot CLI, or VS Code Copilot Chat, the reasoning behind every decision lives in the conversation — *why this approach was chosen, what alternatives were considered, what problems came up along the way*. The moment you commit, that context is gone. Jolli Memory captures it automatically.

---

## This repository

Monorepo hosting three deliverables that share the same product model and storage. Memories are dual-written to **both** the git orphan branch `jollimemory/summaries/v3` (the source of truth) and a **Memory Bank** folder on disk (a plain-Markdown copy you can read or `grep` directly, no extension required):

| Surface | Directory | What it's for |
| -- | -- | -- |
| **CLI** — `@jolli.ai/cli` | [`cli/`](cli/) | Standalone command-line tool. Installs git hooks, generates summaries on commit, and offers `view` / `export` / `recall` / `search` / `configure` / `doctor` commands. Also includes **Jolli Site** (`new` / `dev` / `build` / `start` / `convert`) for generating documentation sites from Markdown + OpenAPI. Works independent of any IDE. |
| **VS Code extension** — Jolli Memory | [`vscode/`](vscode/) | Sidebar with three tabs (Branch / Memory Bank / Status), a 5-tab Settings webview, and a per-commit Summary Webview. Bundles the CLI internally; works whether or not the CLI is also installed globally. |
| **IntelliJ plugin** — Jolli Memory | [`intellij/`](intellij/) | JetBrains IDEs integration (IDEA, PyCharm, WebStorm, GoLand, …) — pure-Kotlin implementation. |

### Which one should I install?

- Using **VS Code** → install the [VS Code extension](vscode/).
- Using a **JetBrains IDE** → install the [IntelliJ plugin](intellij/).
- Using **Vim / Emacs / another editor**, or wiring into CI → install the [CLI](cli/).
- Using **multiple editors** → install the CLI globally plus each editor plugin; they share the same data.

### Documentation

| Surface | README | CHANGELOG |
| -- | -- | -- |
| CLI | [`cli/README.md`](cli/README.md) | [`cli/CHANGELOG.md`](cli/CHANGELOG.md) |
| VS Code extension | [`vscode/README.md`](vscode/README.md) | [`vscode/CHANGELOG.md`](vscode/CHANGELOG.md) |
| IntelliJ plugin | [`intellij/README.md`](intellij/README.md) | [`intellij/CHANGELOG.md`](intellij/CHANGELOG.md) |

---

## Product highlights

- **Automatic** — git hooks run summary generation in a detached background process; your commit returns instantly (the summary appears 10–20 seconds later).
- **Multi-agent** — works with Claude Code, Codex CLI, Gemini CLI, OpenCode, Cursor IDE, GitHub Copilot CLI, and VS Code Copilot Chat. Sessions are picked up automatically via agent hooks or filesystem/DB scanning.
- **Local-first** — every memory is dual-written to **both** a git orphan branch (the source of truth) and a **Memory Bank** folder on disk, so you always have a plain-Markdown copy alongside the canonical orphan-branch entry. Raw AI session transcripts are dual-written the same way (orphan branch + Memory Bank `transcripts/` subfolder), kept as JSON for review and Summary-Webview replay. Opt-in **Push to Jolli** shares summaries (not transcripts) with your team.
- **Structured format** — v3 tree with topics, triggers, decisions, and todos; correctly handles amend / squash / cherry-pick / rebase.
- **Documentation site generator** — the CLI also ships a Nextra-based site generator (`jolli new` / `build` / `start` / `dev`) with theme packs, header / footer config, and an OpenAPI rich-rendering pipeline (per-endpoint MDX, no `swagger-ui-react` runtime).
- **Privacy-respecting** — see the *Privacy* section in each surface's README for the exact data flow. The Jolli LLM proxy does not persist transcripts or diffs, and does not log them.

---

## Jolli Site — documentation from your content folder

The CLI also includes a **site generation** surface that turns a plain folder of Markdown and OpenAPI specs into a polished Nextra v4 documentation site — no framework boilerplate needed.

### Commands

| Command | What it does |
| -- | -- |
| `jolli new [folder]` | Scaffold a new Content_Folder with starter files (`site.json`, sample pages, OpenAPI spec). |
| `jolli dev [source]` | Start a dev server with hot reload. Edits to Markdown/OpenAPI in the source folder are synced and rendered instantly. |
| `jolli build [source]` | Build a static site with full-text search indexing (Pagefind). |
| `jolli start [source]` | Build + serve the static site locally. |
| `jolli convert [source]` | Convert an existing Docusaurus docs folder to Nextra-compatible structure. |

### Quick start

```bash
jolli new my-docs        # creates my-docs/ with starter content
cd my-docs
jolli dev                # live preview at localhost:3000
```

Edit any `.md` file or `site.json` — the dev server picks up changes automatically.

### How it works

1. **Content_Folder** — your Markdown files, images, and OpenAPI specs live in a plain folder. `site.json` at the root configures title, navigation, theme, and footer.
2. **Mirror + Render** — `jolli dev/build/start` mirrors the content into a hidden build directory (`~/.jolli/sites/<hash>/`), renders OpenAPI specs into interactive API docs, generates sidebar navigation from the folder structure, and runs Next.js under the hood.
3. **Theme Packs** — choose from `forge` (clean developer-docs, default), `default` (vanilla Nextra), or `atlas` (editorial, dark serif). Set in `site.json` under `theme.pack`.

### `site.json` structure

```json
{
  "title": "My Docs",
  "description": "Project documentation",
  "nav": [
    { "title": "Home", "href": "/" },
    { "title": "API", "href": "/api/openapi" }
  ],
  "theme": { "pack": "forge" }
}
```

Optional fields: `header` (dropdown navbar), `footer` (copyright, columns, social), `sidebar` (label overrides), `pathMappings` (source → target folder remapping), `favicon`.

### Options

All runtime commands (`dev`, `build`, `start`) accept:
- `--migrate` — re-detect framework config and regenerate `site.json`
- `--verbose` — show detailed build output

`convert` accepts:
- `--output <path>` — output folder (default: convert in-place, with timestamped backup)

---

## Repository layout

```
jolliai/
├── cli/          Node.js CLI (@jolli.ai/cli, npm workspace)
├── vscode/       VS Code extension (npm workspace)
├── intellij/     IntelliJ plugin (Kotlin + Gradle)
├── package.json  Root workspace config (coordinates cli + vscode)
└── .nvmrc        Pinned Node version for development
```

`cli/` and `vscode/` are npm workspaces coordinated from the root `package.json`. `intellij/` is a separate Gradle project.

### Development quick start

**CLI + VS Code extension** (Node.js workspace; requires the Node version in `.nvmrc`, currently 24.10.0):

```bash
npm install
npm run build        # builds both CLI and VS Code
npm run typecheck
npm run lint
npm run test
```

Per-workspace variants are available (`npm run build:cli`, `npm run test:vscode`, etc.). Run `npm run all` for a full clean → build → lint → test cycle.

**IntelliJ plugin** — see [`intellij/DEVELOPMENT.md`](intellij/DEVELOPMENT.md).

---

## Contributing

Contributions welcome. Please read:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow, code style, PR expectations
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — community guidelines

## Support

- **Issues & feature requests** — [GitHub Issues](https://github.com/jolliai/jolliai/issues)
- **Jolli Space onboarding / enterprise** — support@jolli.ai

## License

[Apache License 2.0](LICENSE)
