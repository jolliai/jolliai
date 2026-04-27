# Release process

This document describes the release process for **the CLI and VS Code extension** — two artifacts that share one flow:

- **CLI** — `@jolli.ai/cli` on npm. Tag prefix: `release-cli-v<version>`. Workflow: [`publish-cli.yaml`](.github/workflows/publish-cli.yaml).
- **VS Code extension** — `jolli.jollimemory-vscode` on the VS Code Marketplace and Open VSX. Tag prefix: `release-vscode-v<version>`. Workflow: [`publish-vscode.yaml`](.github/workflows/publish-vscode.yaml).

Each artifact has its own workflow but they share the branch model, signing requirements, and procedural shape below. The two artifacts can release at independent versions and on independent cadences.

> **Out of scope: IntelliJ plugin.** The `intellij/` deliverable currently uses its own legacy [`publish-intellij.yaml`](.github/workflows/publish-intellij.yaml) workflow (Gradle-based JetBrains Marketplace publish, no maintenance branches, no sigstore tag signing). It is **not** covered by this document. Migrating it to the same model is a separate piece of work.

## Branch model

```
main                ─●─●─●─●─●─●─●─●─●→  trunk; each artifact's package.json equals
                     \           \         "what main would publish today" for that artifact
release/1.5.x         ●─●─●         long-lived per-minor branch
release/1.6.x                ●─●─●  every release-cli-v* AND release-vscode-v*
                              ↑     tag must be reachable from a release/<minor>.x branch
```

- **`main`** is the trunk. `cli/package.json` and `vscode/package.json` each represent "what main would publish *for that artifact* today" — i.e. the latest version that *could* ship for it from the current main HEAD if all in-flight work were ready. Neither is a global "latest published" tracker.
- **`release/<minor>.x`** is created on first publish for each minor and is long-lived. Both CLI and VS Code releases for the same minor cycle are cut from this same branch, using their respective tag prefixes. It is the **only** kind of branch from which tags may be cut.
- **Hotfixes** for either artifact happen on `release/<minor>.x` and are forward-ported to main as needed.

## Prerequisites

- **`gitsign` installed and configured locally** for every maintainer who signs release tags. Both publish workflows verify signatures via [sigstore](https://github.com/sigstore/gitsign) — no long-lived signing key to manage. `gitsign` uses your GitHub OAuth identity to obtain a short-lived certificate from Fulcio, signs the tag, and records the signature in the Rekor transparency log. One-time per-machine setup:

    ```bash
    brew install sigstore/tap/gitsign        # or download from github.com/sigstore/gitsign/releases
    git config --global gpg.x509.program gitsign
    git config --global gpg.format x509
    git config --global gitsign.connectorID https://github.com/login/oauth
    git config --global tag.gpgsign true     # auto-sign all tags; commit signing is optional
    ```

    Your first `git tag -s` opens a browser for GitHub OAuth — authorize once. Subsequent tags reuse the cached OIDC session until it expires.

- Membership in the `Production` GitHub Environment (manual approval gate; both workflows use the same environment).
- For CLI: npm trusted publishing is configured for `@jolli.ai/cli` against `jolliai/jolliai` + `publish-cli.yaml` + the `Production` environment. No `NPM_TOKEN` is required.
- For VS Code: long-lived PATs in repo secrets (`JOLLIMEMORY_VSCE_PAT` for VS Code Marketplace, `JOLLIMEMORY_OVSX_PAT` for Open VSX). Neither marketplace currently supports OIDC trusted publishing.
- Permission to push tags matching `release-cli-v*` and/or `release-vscode-v*`.

## Trigger

Both workflows run **only** via `workflow_dispatch`. There is no tag-push trigger — pushing a `release-<artifact>-v*` tag does not by itself start a release. After signing and pushing the tag, you must explicitly start the corresponding workflow from the GitHub Actions UI and pass the tag name as input.

This keeps "tag exists in git" and "release has been requested" as two distinct events. An accidental or automated tag push cannot publish on its own; a human must always make the second decision in the Actions UI. The `Production` environment approval gate then layers a third decision on top of that.

## Procedures

> The procedures below use `<artifact>` as a placeholder for `cli` or `vscode`. Substitute the appropriate one — `<artifact>/package.json`, tag prefix `release-<artifact>-v`, and the corresponding workflow ("Publish CLI to NPM" or "Publish VS Code Extension to Marketplaces") — for the artifact you are releasing.
>
> Both artifacts can be released independently from the same `release/<minor>.x` branch using their respective tags. To release both at once, do step 1 for both `cli/` and `vscode/` in one PR (or two PRs), then sign and push both tags and trigger both workflows.

### A. Regular minor or major (e.g. 1.5.x → 1.6.0)

Use when main is in a shippable state.

```bash
# 1. Bump version on main via PR
git checkout main && git pull
# Edit <artifact>/package.json: version → 1.6.0
# Edit <artifact>/CHANGELOG.md: add 1.6.0 section
npm install                                  # refresh package-lock.json
git add <artifact>/package.json package-lock.json <artifact>/CHANGELOG.md
git commit -s -m "release: <artifact> 1.6.0"
# Push, open PR, get review, merge to main

# 2. Cut release/1.6.x from the merged main commit (skip if it already exists)
git checkout main && git pull
git checkout -b release/1.6.x
git push -u origin release/1.6.x

# 3. Sign and push the tag, then trigger the workflow manually
git tag -s release-<artifact>-v1.6.0 -m "<artifact> 1.6.0"
git push origin release-<artifact>-v1.6.0
# GitHub → Actions → corresponding workflow → Run workflow → tag: release-<artifact>-v1.6.0
```

### B. Regular patch (main shippable, e.g. 1.6.0 → 1.6.1)

Use when main has no in-flight unshippable work.

```bash
# 1. Bump version on main via PR (same shape as A.1)
# Edit: <artifact>/package.json 1.6.0 → 1.6.1, CHANGELOG, refresh lockfile
git commit -s -m "release: <artifact> 1.6.1"
# PR, merge

# 2. Fast-forward release/1.6.x to main
git checkout release/1.6.x && git pull
git merge --ff-only origin/main              # if this fails, you are actually in scenario C
git push

# 3. Sign and push the tag, then trigger the workflow manually
git tag -s release-<artifact>-v1.6.1 -m "<artifact> 1.6.1"
git push origin release-<artifact>-v1.6.1
# GitHub → Actions → corresponding workflow → Run workflow → tag: release-<artifact>-v1.6.1
```

### C. Hotfix (main has unshippable work, 1.6.0 already shipped, 1.6.1 needed urgently)

This is the scenario the maintenance-branch model exists for. **Read the asymmetry note below before starting.**

```bash
# 1. Apply the fix on the maintenance branch
git checkout release/1.6.x && git pull
git cherry-pick <fix-commit-from-main>       # or write the fix directly on this branch

# 2. Bump version on release/1.6.x ONLY (do NOT bump main's version)
# Edit on release/1.6.x: <artifact>/package.json 1.6.0 → 1.6.1, CHANGELOG
npm install
git add <artifact>/package.json package-lock.json <artifact>/CHANGELOG.md
git commit -s -m "release: <artifact> 1.6.1"
git push

# 3. Sign and push the tag, then trigger the workflow manually
git tag -s release-<artifact>-v1.6.1 -m "<artifact> 1.6.1 (hotfix)"
git push origin release-<artifact>-v1.6.1
# GitHub → Actions → corresponding workflow → Run workflow → tag: release-<artifact>-v1.6.1

# 4. Forward-port the FIX (not the version bump) to main
git checkout main && git pull
git cherry-pick <fix-commit-only>            # exclude the "release: <artifact> 1.6.1" bump commit
git push                                     # or open a PR
```

**Why main's version doesn't move during a hotfix.** Main's `<artifact>/package.json` represents "what main would publish today" for that artifact. After a hotfix lands on `release/1.6.x`, main still carries the in-flight feature work that made it unshippable in the first place — it cannot publish 1.6.1 from its own HEAD. The next release cut from main will bump to 1.6.2 or 1.7.0 in its own PR.

If you also bump main's `<artifact>/package.json` to 1.6.1, you create a state where main claims "publishing 1.6.1" while actually containing more code than what shipped as 1.6.1 — that drift is exactly what the maintenance-branch model is supposed to prevent.

Note that since CLI and VS Code each have their own version, hotfixing one artifact does not require touching the other's `package.json`.

### D. Re-running a failed publish

Both workflows are designed for idempotent retries:

- **CLI**: a pre-check rejects the run if the version is already on npm. If `npm publish` failed before completing, just re-launch the workflow with the same tag name.
- **VS Code**: each marketplace publish step has its own pre-check that **skips (does not fail)** if the version is already on that marketplace. So if the VS Code Marketplace step succeeded but Open VSX failed, retrying the workflow will skip the first and re-attempt the second.

For both:

1. Confirm in the relevant marketplace UI (npmjs.com / marketplace.visualstudio.com / open-vsx.org) what was actually published.
2. GitHub Actions → corresponding workflow → **Run workflow** → re-enter the existing tag name.

If a publish *did* succeed but a downstream step failed (e.g. tag-attestation upload), the version is already public and immutable on the registry — there is nothing to rerun. Address the breakage and ship the next patch.

### E. Dry run before a real release

Both workflows accept an optional `dry_run` boolean input. When `dry_run=true`:

- All verification steps still run (tag format, sigstore signature, reachable-from-`release/*.x`, version match, marketplace pre-checks).
- `npm ci` + `npm run all` + `npm run package` (vscode) still run.
- The actual publish step(s) are **skipped** and a "would have published" notice is written to the run logs.

Use a dry run when:

- It's the first publish from a freshly-cut `release/<minor>.x` and you want to validate the whole chain (gitsign signing, OIDC, CI build/test) before committing.
- You've upgraded `GITSIGN_VERSION` or changed `IDENTITY_REGEX` and want to confirm the new config works.
- You've rotated a marketplace PAT and want to sanity-check it without burning a version number.

How to run:

GitHub → Actions → corresponding workflow → **Run workflow** → enter the tag name → toggle `dry_run` ON → Run.

After a successful dry run, re-launch the **same workflow with the same tag** and `dry_run` left OFF to perform the actual publish. The dry run does not write to git or any registry, so the real run starts from an identical state.

## What CI enforces

Both publish workflows reject the run if:

- The tag does not match the expected pattern (`release-cli-v<semver>` or `release-vscode-v<semver>`).
- The tag is not signed via sigstore by an allowed OIDC identity (`gitsign verify` fails).
- The tag's commit is not reachable from any `origin/release/*.x` branch.
- The corresponding `<artifact>/package.json` at the tag's commit does not match the version embedded in the tag name.

Workflow-specific:

- `publish-cli.yaml` additionally rejects if the version is already published on the npm registry.
- `publish-vscode.yaml` additionally **skips (not fails)** the publish step for any marketplace that already has the version, so partially-failed runs resume cleanly on retry.

These checks are intentionally redundant with the human procedure above, so any single mistake (wrong branch, wrong version, unsigned tag) fails fast with a clear error rather than producing a bad release.
