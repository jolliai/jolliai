# Contributing to Jolli Memory

Thank you for your interest in contributing to Jolli Memory! This document explains how to get involved.

## Getting Started

1. Fork the repository and clone your fork locally.
2. Create a new branch from `main` for your work.
3. Make your changes, ensuring all tests pass.
4. Submit a pull request back to the `main` branch.

## Development Setup

This is an npm workspaces monorepo containing the CLI (`cli/`) and the VS Code extension (`vscode/`).

```bash
# Clone your fork
git clone https://github.com/<your-username>/jollimemory.git
cd jollimemory

# Install dependencies for all workspaces
npm ci

# Clean, build, lint, and test the full monorepo
npm run all
```

For CLI-only development (running from source, package layout, release notes, etc.), see [cli/DEVELOPMENT.md](cli/DEVELOPMENT.md). Per-workspace scripts like `npm run build:cli`, `npm run test:vscode`, and `npm run lint:fix` are listed in the root [package.json](package.json).

## Reporting Issues

Before opening a new issue, please search existing issues to avoid duplicates.

When filing a bug report, include:

- A clear description of the problem
- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Your environment (OS, language/runtime version, relevant dependency versions)

For feature requests, describe the use case and why existing functionality doesn't cover it.

## Pull Requests

- Keep PRs focused. One logical change per PR is easier to review and merge.
- Write clear commit messages that explain *why*, not just *what*.
- Add or update tests for any new functionality or bug fixes.
- Update documentation if your change affects the public API.
- Make sure CI passes before requesting review.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) to certify that contributors have the right to submit their work under the project's Apache 2.0 license.

By making a contribution, you certify that you have the right to submit it under the open source license used by this project.

All commits must include a `Signed-off-by` line with your real name and email address. Git makes this easy:

```bash
git commit -s -m "Your commit message"
```

This adds a line like:

```
Signed-off-by: Your Name <your.email@example.com>
```

If you've already made commits without the sign-off, you can amend them:

```bash
# Amend the most recent commit
git commit --amend -s --no-edit

# Or rebase to sign off multiple commits
git rebase --signoff HEAD~<number-of-commits>
```

Commits without a valid `Signed-off-by` line will not be accepted.

## Code Style

- Follow the existing conventions in the codebase.
- Write code for readability. Clear is better than clever.
- Comment *why* when the reason isn't obvious from the code itself.

## Code Review

All submissions require review before merging. Reviewers may ask for changes — this is a normal and collaborative part of the process, not a judgment on the quality of your work.

## Questions?

If something in this guide is unclear or you're unsure how to approach a contribution, open an issue and ask. We'd rather help you contribute than have you get stuck in silence.
