# jolli-pr: create-or-update a PR

## Problem

The `jolli-pr` skill always runs `gh pr create` in its final step. When the
current branch already has an open PR, `gh pr create` fails outright, so the
skill cannot be used to refresh the description of an existing PR after new
commits land. Users want a single skill that **creates** a PR when none exists
and **updates** the existing open PR otherwise.

## Scope

Prompt-only change to the `jolli-pr` skill template, which lives inline in
`buildPrSkillTemplate()` in `cli/src/install/SkillInstaller.ts` (the on-disk
`.claude/skills/jolli-pr/SKILL.md` is a git-excluded generated artifact — the
source of truth is the template function). No change to the CLI, the MCP server,
or the `get_pr_description` engine.

## Decisions

- **Update overwrites both title and body** from the freshly generated
  Jolli Memory description — the whole PR is re-synced to current memory.
- **No overwrite protection / no confirmation** — detecting an open PR goes
  straight to `gh pr edit`. A manually-edited body is intentionally clobbered,
  consistent with the skill's premise that the body must come from Jolli Memory.
- **Detection is front-loaded (Approach A).** A new detection step runs before
  the description is generated so that, in update mode, the description's diff
  range is computed against the existing PR's actual base branch
  (`baseRefName`), not the repository default. This is the correctness win that
  justifies renumbering the later steps.
- **Update mode does not retarget the PR's base.** We read `baseRefName` to feed
  the description engine, but never pass `gh pr edit --base`. A user-supplied
  base argument is only meaningful in create mode.

## New step structure

Steps are renumbered because a detection step is inserted early.

| New # | Title | Relative to today |
|------|-------|-------------------|
| Step 0 | Wait for pending memory | unchanged |
| **Step 1** | **Detect existing open PR** | **new** |
| Step 2 | Get the PR description | was Step 1; update mode feeds the PR's base |
| Step 3 | Push the branch | was Step 2; unchanged |
| Step 4 | Create **or update** the PR | was Step 3; branches on mode |
| Step 5 | Report the URL | was Step 4 |
| Step 6 | Push memory to Jolli | was Step 5; unchanged |

### Step 1 — Detect existing open PR (new)

```bash
gh pr list --head "$(git branch --show-current)" --state open --json number,url,baseRefName
```

- This is the first `gh` invocation, so the `gh`-not-installed guidance (today
  in the report step) moves here: if `gh` is missing, tell the user to install
  it from https://cli.github.com/ and authenticate with `gh auth login`, then
  STOP.
- Output `[]` → **create mode**; no base override.
- Output with ≥1 entry → **update mode**; take the first entry and remember its
  `number`, `url`, and `baseRefName`. (Same-repo same-head cannot have more than
  one open PR; the "take the first" rule only matters for the cross-fork edge
  case.)

### Step 2 — Get the PR description (base depends on mode)

- **Create mode:** unchanged from today — a user-supplied base goes through the
  injection-safe here-doc (CLI) or the `baseBranch` argument (MCP); otherwise the
  engine defaults to `origin/HEAD`.
- **Update mode:** pass the detected `baseRefName` as the base — MCP
  `{"baseBranch": "<baseRefName>"}`, or the CLI here-doc recipe with
  `baseRefName` in the `<user-arg>` slot (same injection-safe channel). The
  description's diff range then aligns with the PR being updated.
- The existing note "remember the base branch — the create step must pass the
  same `--base`" is scoped to **create mode only**; update mode never changes the
  PR's base.

### Step 4 — Create or update the PR (branches on mode)

The injection-safe here-doc that writes the body to a temp file is shared by
both paths. After the temp file is written:

- **Create mode:** `gh pr create --title "<title>" --body-file "$JOLLI_PR_BODY_FILE"`
  (plus optional `--base <baseBranch>`), exactly as today.
- **Update mode:**
  ```bash
  gh pr edit <number> --title "<title from tool>" --body-file "$JOLLI_PR_BODY_FILE"
  ```
  where `<number>` comes from Step 1. Overwrites title + body; no `--base`; no
  confirmation prompt.
- The "if the user explicitly asked to adjust the title, substitute only the
  `--title` value" rule applies to both paths. The Hard rule (body must come from
  the tool; no Claude co-author trailer/footer) is unchanged.

### Step 5 — Report the URL

Both `gh pr create` and `gh pr edit` print the PR URL on success; relay it. The
`gh`-not-installed handling no longer lives here (moved to Step 1).

## Test changes (`cli/src/install/SkillInstaller.test.ts`)

- Update the "Push memory to Jolli" assertion from `## Step 5` to `## Step 6`,
  and update the ordering assertion accordingly.
- Keep the create-path assertions (`gh pr create`, `--body-file`,
  `--base <baseBranch>`) — the create branch still emits them.
- Add assertions for the new behavior: Step 1 contains `gh pr list --head` and
  `--state open`; Step 4 contains `gh pr edit` and "Create or update"; update
  mode is documented to feed `baseRefName` into the description.

## Explicitly out of scope (YAGNI)

- No retargeting an existing PR's base branch.
- No pre-overwrite confirmation or manual-edit protection.
- No change to the CLI, MCP tools, or the `get_pr_description` engine.
