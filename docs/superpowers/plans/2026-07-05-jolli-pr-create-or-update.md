# jolli-pr create-or-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `jolli-pr` skill create a PR when the branch has none and update the existing open PR (title + body) when one exists.

**Architecture:** Prompt-only change to the `jolli-pr` skill template returned by `buildPrSkillTemplate()` in `cli/src/install/SkillInstaller.ts`. A new detection step (`gh pr list`) is inserted before the description is generated so update mode can compute the description against the existing PR's actual base; all later steps are renumbered. The final `gh` step branches between `gh pr create` and `gh pr edit`. Tests in `SkillInstaller.test.ts` are updated for the renumbering and new content.

**Tech Stack:** TypeScript template literal (ESM), Vitest, Biome. `gh` CLI recipes inside the prompt.

## Global Constraints

- DCO sign-off on every commit — `git commit -s`. No `Co-Authored-By: Claude` trailer or "🤖 Generated with" footer.
- `npm run all` must pass before commit (clean → build → lint → test).
- Do not regress CLI coverage: 97% statements / 96% branches / 97% functions / 97% lines. (This change adds only string content inside an existing function — no new branches/functions — so coverage is structurally unaffected.)
- The skill template is a JS template literal: every literal backtick inside it MUST stay escaped as `` \` `` (backtick-in-template-literal trap). Do not introduce an unescaped backtick.
- The template must contain no CJK characters (a "No CJK leakage" test enforces this) — all added prose is English.
- Source of truth is `buildPrSkillTemplate()` in `SkillInstaller.ts`; the on-disk `.claude/skills/jolli-pr/SKILL.md` is a git-excluded generated artifact and must NOT be hand-edited.

---

## File Structure

- `cli/src/install/SkillInstaller.ts` — modify `buildPrSkillTemplate()` (currently lines ~494–736). Single responsibility: returns the `jolli-pr` SKILL.md text.
- `cli/src/install/SkillInstaller.test.ts` — modify the two step-number-sensitive assertions and add assertions for the new detection step and update path.

These two files change together and form one review gate, split into a test task and an implementation task for TDD ordering.

---

### Task 1: Update tests for create-or-update (test-first)

**Files:**
- Test: `cli/src/install/SkillInstaller.test.ts`

**Interfaces:**
- Consumes: `readPr()` helper (already in the file) returning the rendered `jolli-pr` SKILL.md string; `updateSkillsIfNeeded(tempDir)`.
- Produces: assertions that Task 2's template must satisfy.

- [ ] **Step 1: Renumber the "push memory" step assertion to Step 6**

In `cli/src/install/SkillInstaller.test.ts`, replace the existing test (currently lines 623–630):

```typescript
	it("Step 5 offers to push memory to Jolli and handles space binding", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toContain("## Step 5: Push memory to Jolli");
		expect(pr).toContain("push_memory");
		expect(pr).toContain("binding_required");
		expect(pr.indexOf("## Step 4")).toBeLessThan(pr.indexOf("## Step 5"));
	});
```

with:

```typescript
	it("Step 6 offers to push memory to Jolli and handles space binding", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toContain("## Step 6: Push memory to Jolli");
		expect(pr).toContain("push_memory");
		expect(pr).toContain("binding_required");
		// Report-URL (Step 5) precedes push-memory (Step 6).
		expect(pr.indexOf("## Step 5")).toBeLessThan(pr.indexOf("## Step 6"));
	});
```

- [ ] **Step 2: Add a test for the new detection step (Step 1) and create/update branching**

Insert this test immediately after the block edited in Step 1 (before the closing `});` of the `describe` at line 631):

```typescript
	it("Step 1 detects an existing open PR before building the description", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toContain("## Step 1: Detect");
		expect(pr).toMatch(/gh pr list --head/);
		expect(pr).toMatch(/--state open/);
		// Detection (Step 1) must precede description generation (Step 2).
		expect(pr.indexOf("## Step 1")).toBeLessThan(pr.indexOf("## Step 2: Get the PR description"));
	});

	it("Step 4 creates a new PR or updates the existing one", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		expect(pr).toContain("## Step 4: Create or update the PR");
		// Create path still uses gh pr create; update path uses gh pr edit.
		expect(pr).toMatch(/gh pr create/);
		expect(pr).toMatch(/gh pr edit/);
	});

	it("update mode feeds the existing PR's base into the description", async () => {
		await updateSkillsIfNeeded(tempDir);
		const pr = readPr();
		// Step 1 captures baseRefName; Step 2 passes it so the diff range matches
		// the PR being updated.
		expect(pr).toMatch(/baseRefName/);
	});
```

*(No run/commit step here — verification and commit are batched in Task 3.)*

---

### Task 2: Rewrite `buildPrSkillTemplate()` for create-or-update

**Files:**
- Modify: `cli/src/install/SkillInstaller.ts` — `buildPrSkillTemplate()` (~lines 494–736)

**Interfaces:**
- Consumes: `SKILL_VERSION`, `heredocInvocation("pr-description", " --format json")` (unchanged).
- Produces: template text satisfying Task 1's assertions.

Apply the following five targeted edits to the template string. Each `old`
block appears exactly once inside `buildPrSkillTemplate()`. Keep every backtick
escaped as `` \` ``.

- [ ] **Step 1: Insert the new detection step after Step 0**

Find the end of Step 0 (the paragraph that ends the queue-status section):

```
\`active\` counts only memory-summary work — Memory Bank wiki/graph rendering is
intentionally excluded, so this never blocks on wiki generation.

## Step 1: Get the PR description
```

Replace with (inserts Step 1 detection, renumbers description to Step 2):

```
\`active\` counts only memory-summary work — Memory Bank wiki/graph rendering is
intentionally excluded, so this never blocks on wiki generation.

## Step 1: Detect whether an open PR already exists

This skill both creates and updates. First find out which: does the current
branch already have an **open** PR?

\`\`\`bash
gh pr list --head "$(git branch --show-current)" --state open --json number,url,baseRefName
\`\`\`

This is the first \`gh\` command, so if \`gh\` is not installed, tell the user:
"The GitHub CLI (\`gh\`) is required. Install it from https://cli.github.com/
and authenticate with \`gh auth login\`, then retry." — then STOP.

Read the JSON array it prints:

- **Empty (\`[]\`)** → **create mode**. No existing PR; you will create one.
- **One or more entries** → **update mode**. Take the first entry and remember
  its \`number\`, \`url\`, and \`baseRefName\`. (Within a single repo a branch can
  have at most one open PR; "take the first" only matters for the rare
  cross-fork case.)

Carry the chosen mode — and, in update mode, the \`number\` and \`baseRefName\` —
through the remaining steps.

## Step 2: Get the PR description
```

- [ ] **Step 2: Make description base-branch handling mode-aware (MCP paragraph)**

Find:

```
\`get_pr_description\` under the \`jollimemory\` MCP server. Call it with no
arguments — it describes the current branch and compares against the
repository's default branch (origin/HEAD). If this PR targets a different base,
pass \`baseBranch\` (e.g. \`{"baseBranch": "develop"}\`).
```

Replace with:

```
\`get_pr_description\` under the \`jollimemory\` MCP server. It describes the
current branch and compares against a base branch, defaulting to the
repository's default branch (origin/HEAD).

- **Create mode:** if the user asked for a non-default base, pass \`baseBranch\`
  (e.g. \`{"baseBranch": "develop"}\`); otherwise call with no arguments.
- **Update mode:** pass the existing PR's base from Step 1 —
  \`{"baseBranch": "<baseRefName>"}\` — so the description's diff range matches the
  PR you are about to update.
```

- [ ] **Step 3: Scope the "remember the base branch" note to create mode**

Find:

```
Here \`<user-arg>\` is the base branch name (e.g. \`develop\`). If you take this
path, remember the base branch — Step 3 must pass the same value to
\`gh pr create --base\`.
```

Replace with:

```
Here \`<user-arg>\` is the base branch name — in create mode the user-supplied
base (e.g. \`develop\`), in update mode the \`baseRefName\` from Step 1. In create
mode, remember it — Step 4 must pass the same value to \`gh pr create --base\`.
In update mode the base is not passed to \`gh\`; an existing PR's target branch
is left unchanged.
```

Then find the single remaining forward-reference:

```
Then continue to Step 2.
```

Replace with:

```
Then continue to Step 3.
```

- [ ] **Step 4: Renumber "Push the branch" to Step 3**

Find:

```
## Step 2: Push the branch
```

Replace with:

```
## Step 3: Push the branch
```

- [ ] **Step 5: Rewrite the create step as create-or-update (Step 4) and the report/push steps (Step 5, Step 6)**

Find the entire block from the old Step 3 header through the old Step 5 header line:

```
## Step 3: Create the PR

Write the \`body\` field from the tool response to a temporary file and pass it
via \`--body-file\`. Using \`--body-file\` instead of \`--body\` is required so
multi-line Markdown survives shell quoting intact.

The body is generated from commit memory, which is user-controlled text. To stop
a body line from prematurely closing the here-doc (which would let the shell
interpret the rest of the body), generate a fresh random 16-character hex string
(the "delimiter token") for this invocation — e.g. \`3f8a9b2c5d7e1f4a\`. Scan the
body: if it contains a line that is exactly \`JOLLI_PR_BODY_<delimiter token>_END\`,
regenerate the token and re-check.

Then run this Bash, replacing the two \`<DELIM>\` occurrences with your delimiter
token and pasting the full body string verbatim between them:

\`\`\`bash
JOLLI_PR_BODY_FILE=$(mktemp)
cat > "$JOLLI_PR_BODY_FILE" <<'JOLLI_PR_BODY_<DELIM>_END'
<paste the full body string from the tool here>
JOLLI_PR_BODY_<DELIM>_END

gh pr create --title "<title from tool>" --body-file "$JOLLI_PR_BODY_FILE"
rm -f "$JOLLI_PR_BODY_FILE"
\`\`\`

If you passed a \`baseBranch\` to the tool in Step 1 (the PR targets a non-default
base), add the same value as \`--base <baseBranch>\` to \`gh pr create\`. Otherwise
\`gh\` defaults to the repository's default branch, and the PR would target a
different base than the description was computed against:

\`\`\`bash
gh pr create --base <baseBranch> --title "<title from tool>" --body-file "$JOLLI_PR_BODY_FILE"
\`\`\`

If the user explicitly asked to adjust the title, substitute their revised
wording for the \`--title\` value only — leave \`--body-file\` unchanged.

## Step 4: Report the URL

\`gh pr create\` prints the new PR URL on success. Relay that URL to the user.

If \`gh\` is not installed, tell the user:
"The GitHub CLI (\`gh\`) is required. Install it from https://cli.github.com/
and authenticate with \`gh auth login\`, then retry."

## Step 5: Push memory to Jolli (optional)
```

Replace with:

```
## Step 4: Create or update the PR

Write the \`body\` field from the tool response to a temporary file and pass it
via \`--body-file\`. Using \`--body-file\` instead of \`--body\` is required so
multi-line Markdown survives shell quoting intact. The same temp file is used
whether you create or update.

The body is generated from commit memory, which is user-controlled text. To stop
a body line from prematurely closing the here-doc (which would let the shell
interpret the rest of the body), generate a fresh random 16-character hex string
(the "delimiter token") for this invocation — e.g. \`3f8a9b2c5d7e1f4a\`. Scan the
body: if it contains a line that is exactly \`JOLLI_PR_BODY_<delimiter token>_END\`,
regenerate the token and re-check.

Then run this Bash, replacing the two \`<DELIM>\` occurrences with your delimiter
token and pasting the full body string verbatim between them:

\`\`\`bash
JOLLI_PR_BODY_FILE=$(mktemp)
cat > "$JOLLI_PR_BODY_FILE" <<'JOLLI_PR_BODY_<DELIM>_END'
<paste the full body string from the tool here>
JOLLI_PR_BODY_<DELIM>_END
\`\`\`

**Create mode** — open a new PR:

\`\`\`bash
gh pr create --title "<title from tool>" --body-file "$JOLLI_PR_BODY_FILE"
rm -f "$JOLLI_PR_BODY_FILE"
\`\`\`

If you passed a \`baseBranch\` to the tool in Step 2 (the PR targets a non-default
base), add the same value as \`--base <baseBranch>\` to \`gh pr create\`. Otherwise
\`gh\` defaults to the repository's default branch, and the PR would target a
different base than the description was computed against:

\`\`\`bash
gh pr create --base <baseBranch> --title "<title from tool>" --body-file "$JOLLI_PR_BODY_FILE"
rm -f "$JOLLI_PR_BODY_FILE"
\`\`\`

**Update mode** — overwrite the existing PR's title and body with the freshly
generated description, using the \`number\` remembered in Step 1:

\`\`\`bash
gh pr edit <number> --title "<title from tool>" --body-file "$JOLLI_PR_BODY_FILE"
rm -f "$JOLLI_PR_BODY_FILE"
\`\`\`

Do NOT pass \`--base\` in update mode — the existing PR's target branch is left
unchanged. This overwrites the current title and body outright (including any
manual edits), which is intended: the description must come from Jolli Memory.

If the user explicitly asked to adjust the title, substitute their revised
wording for the \`--title\` value only — leave \`--body-file\` unchanged. This
applies to both create and update.

## Step 5: Report the URL

Both \`gh pr create\` and \`gh pr edit\` print the PR URL on success. Relay that
URL to the user. (The \`gh\`-not-installed check happened in Step 1.)

## Step 6: Push memory to Jolli (optional)
```

*(No run/commit step here — batched in Task 3.)*

---

### Task 3: Verify and commit

**Files:** none (verification + commit only)

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all pass; `SkillInstaller.test.ts` green, including the three new tests and the renumbered one; CLI coverage still ≥ thresholds.

If the "No CJK leakage" test fails, an added line contains a non-ASCII character — replace it with ASCII. If a step-order or content assertion fails, re-check the corresponding edit in Task 2 against Task 1's expected strings.

- [ ] **Step 2: Commit (single commit for the whole change)**

```bash
git add cli/src/install/SkillInstaller.ts cli/src/install/SkillInstaller.test.ts
git commit -s -m "feat(skills): jolli-pr updates an existing open PR instead of failing"
```

---

## Self-Review

**Spec coverage:**
- "Update overwrites both title and body" → Task 2 Step 5 update-mode `gh pr edit --title --body-file`. ✓
- "No overwrite protection / no confirmation" → update-mode block goes straight to `gh pr edit`; no confirmation prose added. ✓
- "Detection front-loaded (Approach A)" → Task 2 Step 1 inserts Step 1 before description; Task 1 asserts ordering. ✓
- "Update mode feeds baseRefName into description" → Task 2 Step 2 MCP paragraph; Task 1 `baseRefName` assertion. ✓
- "Update mode does not retarget base" → Task 2 Step 5 "Do NOT pass `--base`". ✓
- "gh-not-installed guidance moves to Step 1" → Task 2 Step 1 includes it; Step 5 references it. Existing test (line 606) still passes (`cli.github.com` + `gh auth login` still present). ✓
- Step renumbering (Steps 2–6) → Task 2 Steps 1,4,5 renumber headers and forward-refs; Task 1 updates the Step 6 assertion. ✓
- Out of scope (no base retarget, no confirmation, no CLI/MCP change) → nothing in the plan touches those. ✓

**Placeholder scan:** No TBD/TODO; all edits show complete old/new text. ✓

**Type/string consistency:** Header strings used in Task 1 assertions match Task 2 edits exactly — "## Step 1: Detect…", "## Step 2: Get the PR description", "## Step 4: Create or update the PR", "## Step 6: Push memory to Jolli"; `gh pr list --head`, `--state open`, `gh pr edit`, `gh pr create`, `baseRefName` all appear verbatim in Task 2. ✓
