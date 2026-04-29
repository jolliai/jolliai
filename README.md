# Jolli Memory

> *Every commit deserves a Memory. Every memory deserves a Recall.*

**Jolli Memory** automatically turns your AI coding sessions into structured development documentation attached to every commit, without any extra effort.

When you work with AI agents like Claude Code, Codex, Gemini CLI, or OpenCode, the reasoning behind every decision lives in the conversation — *why this approach was chosen, what alternatives were considered, what problems came up along the way*. The moment you commit, that context is gone. Jolli Memory captures it automatically.

---

## This repository

Monorepo hosting three deliverables that share the same product model and storage (a git orphan branch `jollimemory/summaries/v3`):

| Surface | Directory | What it's for |
| -- | -- | -- |
| **CLI** — `@jolli.ai/cli` | [`cli/`](cli/) | Standalone command-line tool. Installs the git hooks, generates summaries on commit, and offers `view` / `export` / `recall` / `configure` / `doctor` commands. Works independent of any IDE. |
| **VS Code extension** — Jolli Memory | [`vscode/`](vscode/) | Sidebar UI with panels for Status, Memories, Plans & Notes, Changes, Commits. Bundles the CLI internally; works whether or not the CLI is also installed globally. |
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
- **Multi-agent** — works with Claude Code, Codex CLI, Gemini CLI, and OpenCode. Sessions are picked up automatically via agent hooks or filesystem/DB scanning.
- **Local-first** — summaries and raw transcripts stay on your machine in a git orphan branch. Opt-in **Push to Jolli** shares summaries (not transcripts) with your team.
- **Structured format** — v3 tree with topics, triggers, decisions, and todos; correctly handles amend / squash / cherry-pick / rebase.
- **Privacy-respecting** — see the *Privacy* section in each surface's README for the exact data flow. The Jolli LLM proxy does not persist transcripts or diffs, and does not log them.

---

## Repository layout

```
jollimemory/
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

## Site generation

The CLI includes a built-in site generator powered by [Nextra](https://nextra.site). Create documentation or blog sites from the command line:

```bash
# Install the CLI
npm install -g @jolli.ai/cli

# Scaffold a docs site (starter kit is the default)
jolli new my-docs

# Scaffold a minimal docs site
jolli new my-docs --template minimal

# Start the dev server
cd my-docs
jolli dev

# Build for production
jolli build
```

**Templates:**

| Template | Description |
|----------|-------------|
| `starter` (default) | Jolli Starter Kit — getting started guide, customization docs, deployment guide, Petstore OpenAPI spec with Scalar API reference, Jolli favicon, best-practice navigation |
| `minimal` | Bare-bones Nextra docs site |

Template files live in `cli/templates/` as real, editable files. To customize a template, edit the files directly and rebuild the CLI.

## Support

- **Issues & feature requests** — [GitHub Issues](https://github.com/jolliai/jolliai/issues)
- **Jolli Space onboarding / enterprise** — support@jolli.ai

## License

[Apache License 2.0](LICENSE)
