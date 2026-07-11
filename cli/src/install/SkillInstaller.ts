/**
 * Skill Installer
 *
 * Writes one byte-identical SKILL.md per skill to **both** target directories:
 *
 *   - `<projectDir>/.claude/skills/<name>/SKILL.md`  — for Claude Code
 *   - `<projectDir>/.agents/skills/<name>/SKILL.md`  — for the cross-platform
 *     Agent Skills standard, picked up by Codex CLI, Cursor 2.4+, Windsurf,
 *     OpenCode, Gemini CLI, GitHub Copilot.
 *
 * Frontmatter is spec-compliant only (`name`, `description`, `metadata`) —
 * no Claude-private fields (`argument-hint`, `user-invocable`) — so the same
 * file passes `skills-ref validate` and runs on every host.
 *
 * **SECURITY — shell injection defense**: skill templates instruct the host
 * LLM to invoke `jolli recall --arg-stdin` / `jolli search --arg-stdin` and
 * feed the user's argument through a here-doc with a **fresh, LLM-generated
 * 16-char hex delimiter** per invocation. The single-quoted delimiter token
 * (`<<'JOLLI_ARG_<DELIM>_END'`) is POSIX's only here-doc form that suppresses
 * every metacharacter (`$()`, backticks, `${VAR}`, `\`). Per-invocation high-
 * entropy delimiters defeat prompt-injection attempts that pre-compute the
 * delimiter into a payload. Known residual risks (the LLM not following the
 * recipe, a 1-in-2^64 delimiter collision, a host that strips here-docs from
 * the command before execution) are accepted trade-offs of this design.
 *
 * Each skill is upserted **independently** by hash of its template content
 * compared with the version recorded in the file. This avoids the trap where
 * a single skill's version match short-circuits the whole installer and
 * prevents a newer skill (e.g. `jolli-search`) from ever being installed on
 * projects whose `jolli-recall` already matches the current version.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("SkillInstaller");

/**
 * Skill template version — derived from the package version so that every
 * npm release automatically triggers a SKILL.md rewrite on `jolli enable`.
 * Falls back to "dev" in test / non-bundled environments.
 */
/* v8 ignore start -- compile-time ternary: always "dev" in tests */
const SKILL_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";
/* v8 ignore stop */

/** Legacy skill directory names from previous versions (v1 and v2) */
const LEGACY_SKILL_DIRS = ["jollimemory-recall", "jolli-memory-recall"];

/**
 * A Skill registration: directory name + template builder. Template content is
 * host-agnostic — the same string is written into every target directory.
 */
interface SkillRegistration {
	readonly name: string;
	readonly build: () => string;
}

/**
 * A target directory family for skill writes.
 *
 * - `host` is a stable identifier used in logs / tests.
 * - `relativeDir` is the path under `<projectDir>` where SKILL.md files live.
 * - `enabled` decides whether to write into this target for the given config.
 *   `.claude/skills/` is gated on `config.claudeEnabled !== false`. The
 *   `.agents/skills/` cross-platform target is unconditional today — splitting
 *   it across a per-host detector list (`isCodexInstalled || isGeminiInstalled
 *   || …`) would miss Cursor / OpenCode / Copilot-only users, and the cost is
 *   ~10 KB of two SKILL.md files that `.git/info/exclude` keeps out of `git
 *   status`.
 */
export interface SkillTarget {
	readonly host: "claude-code" | "agents-std";
	readonly relativeDir: ReadonlyArray<string>;
	readonly enabled: (config: { claudeEnabled?: boolean }) => boolean;
}

/**
 * Where `jolli enable` writes SKILL.md files. Order is preserved so logs and
 * tests can rely on a stable iteration order.
 */
export const SKILL_TARGETS: ReadonlyArray<SkillTarget> = [
	{
		host: "claude-code",
		relativeDir: [".claude", "skills"],
		enabled: (config) => config.claudeEnabled !== false,
	},
	{
		host: "agents-std",
		relativeDir: [".agents", "skills"],
		// Always-on. See SkillTarget JSDoc for the rationale.
		enabled: () => true,
	},
];

/**
 * Registry of skills installed by `jolli enable`. Adding a new skill is
 * append-only — order in this array determines install order on first run.
 */
const SKILLS: ReadonlyArray<SkillRegistration> = [
	{ name: "jolli-recall", build: buildRecallSkillTemplate },
	{ name: "jolli-search", build: buildSearchSkillTemplate },
	{ name: "jolli-pr", build: buildPrSkillTemplate },
	{ name: "jolli", build: buildJolliMenuSkillTemplate },
];

/**
 * Skill paths recorded in `.git/info/exclude` so they don't pollute
 * `git status` in user repositories. Always 8 entries: 4 skills × 2 targets.
 * Path format follows git's gitignore syntax — leading `/` anchors to the
 * repo root, trailing `/` matches the directory and its contents.
 */
export const SKILL_GIT_EXCLUDE_PATHS: ReadonlyArray<string> = SKILL_TARGETS.flatMap((target) =>
	SKILLS.map((skill) => `/${target.relativeDir.join("/")}/${skill.name}/`),
);

/**
 * Installs or updates Jolli skill files. The same byte-identical SKILL.md is
 * written into each enabled target directory under {@link SKILL_TARGETS}; the
 * Claude Code target is gated on `config.claudeEnabled !== false`, the
 * cross-platform `.agents/skills/` target is unconditional.
 *
 * Cleans up legacy directory names from prior versions. Each skill is checked
 * and upserted independently, so installing a new skill (or updating one of
 * several) is not blocked by another skill's version matching the running CLI.
 */
export async function updateSkillsIfNeeded(
	projectDir: string,
	config: { claudeEnabled?: boolean } = {},
): Promise<void> {
	// Clean up legacy skill directories from previous versions. These only
	// ever lived under `.claude/skills/` — `.agents/skills/` is a new target.
	for (const legacyName of LEGACY_SKILL_DIRS) {
		const legacyDir = join(projectDir, ".claude", "skills", legacyName);
		try {
			await rm(legacyDir, { recursive: true, force: true });
			/* v8 ignore start -- defensive: rm with force:true rarely throws */
		} catch {
			// Ignore — directory may not exist or already removed
		}
		/* v8 ignore stop */
	}

	for (const target of SKILL_TARGETS) {
		if (!target.enabled(config)) continue;
		const targetDir = join(projectDir, ...target.relativeDir);
		for (const skill of SKILLS) {
			await upsertSkill(targetDir, skill.name, skill.build());
		}
	}
}

/**
 * Backward-compatible alias for callers that still import the old name.
 *
 * Existing installer code calls `updateSkillIfNeeded(projectDir)` (singular).
 * Newly written code should call {@link updateSkillsIfNeeded} (plural). The
 * old name is kept as a thin wrapper to avoid touching every call site in
 * one PR.
 */
export async function updateSkillIfNeeded(projectDir: string, config: { claudeEnabled?: boolean } = {}): Promise<void> {
	return updateSkillsIfNeeded(projectDir, config);
}

/**
 * Matches the version line in a SKILL.md frontmatter. Accepts:
 *   - `metadata.version: "x.y.z"` (current — spec compliant, nested under
 *     `metadata:` two-space-indented block).
 *   - Legacy top-level `jolli-skill-version: x.y.z` /
 *     `jollimemory-version: x.y.z` (kept so an old SKILL.md on disk is still
 *     recognized as "up-to-date" and not needlessly rewritten on every install).
 *
 * Multi-line mode so `^  version:` matches the nested form. Captured group is
 * the version string with surrounding whitespace and quotes trimmed downstream.
 */
const SKILL_VERSION_LINE = /(?:^|\n)(?:[ \t]+version|jolli-skill-version|jollimemory-version):\s*([^\r\n]+)/;

/**
 * Writes one skill's SKILL.md file when its content version differs from
 * what's on disk. Idempotent.
 */
async function upsertSkill(skillsDir: string, name: string, content: string): Promise<void> {
	const skillDir = join(skillsDir, name);
	const skillPath = join(skillDir, "SKILL.md");

	try {
		const existing = await readFile(skillPath, "utf-8");
		const versionMatch = existing.match(SKILL_VERSION_LINE);
		if (versionMatch) {
			const found = versionMatch[1].trim().replace(/^["']|["']$/g, "");
			if (found === SKILL_VERSION) {
				return; // Up to date
			}
		}
	} catch {
		// File doesn't exist — will create
	}

	try {
		await mkdir(skillDir, { recursive: true });
		await writeFile(skillPath, content, "utf-8");
		log.info("Wrote SKILL.md (version %s) to %s", SKILL_VERSION, skillPath);
		/* v8 ignore start - defensive: mkdir/writeFile failure on read-only filesystem */
	} catch (error: unknown) {
		log.warn("Failed to write %s SKILL.md: %s", name, (error as Error).message);
	}
	/* v8 ignore stop */
}

// ─── Skill Templates ────────────────────────────────────────────────────────

/**
 * Shared Step-1 preamble — instructs the LLM to invoke the CLI via a here-doc
 * with a freshly-generated 16-char hex delimiter, and to STOP if the host
 * can't support that recipe rather than fall back to an `argv` interpolation
 * that would re-open the shell-injection door.
 *
 * Also pins the shell choice on Windows: Git Bash, not WSL bash and not
 * PowerShell. The Jolli entry script is written via Windows Node's
 * `os.homedir()` to `%USERPROFILE%\\.jolli\\jollimemory\\run-cli`. Only Git
 * Bash's `$HOME` aligns with `%USERPROFILE%`; WSL bash sees a separate Linux
 * home and would miss the script even when it is correctly installed.
 *
 * The literal `<DELIM>` placeholder is intentional: the LLM is the one that
 * generates the random value each invocation, which is what makes pre-computed
 * prompt-injection payloads useless.
 */
function heredocInvocation(subcommand: "recall" | "search" | "pr-description", flagSuffix: string): string {
	return `### Shell prerequisite

This block requires a POSIX bash shell. On Linux/macOS the system bash works.
**On Windows, use Git Bash** (the bash bundled with Git for Windows). Other
Windows "bash" options — \`C:\\Windows\\System32\\bash.exe\`, the WindowsApps
alias, or any WSL bash — see a separate Linux home directory and will not
find the Jolli entry script that lives under \`%USERPROFILE%\`.

If Git Bash is not available on Windows, STOP and tell the user:
"Jolli skill needs Git Bash on Windows. Install Git for Windows from
https://git-scm.com/download/win and retry."

Do NOT fall back to \`npm run\`, \`npx\`, \`node\` directly, PowerShell-native
commands, WSL bash, or any workspace-local script — those bypass the
security recipe and the dist resolver and will not produce valid output.

### Invocation

Generate a fresh random 16-character hex string (the "delimiter token") for
this invocation — e.g. \`3f8a9b2c5d7e1f4a\`. Quickly scan the user's argument:
if the argument text contains a line that is exactly \`JOLLI_ARG_<delimiter
token>_END\`, regenerate the delimiter token and re-check.

Then run this Bash, replacing the two \`<DELIM>\` occurrences with your
delimiter token and replacing \`<user-arg>\` with the user's input verbatim:

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" ${subcommand} --arg-stdin${flagSuffix} <<'JOLLI_ARG_<DELIM>_END'
<user-arg>
JOLLI_ARG_<DELIM>_END
\`\`\`

If you cannot follow the above structure (e.g., your environment doesn't
support here-docs), STOP and tell the user "Jolli skill cannot run safely
in this environment." DO NOT attempt to interpolate the argument into argv
or any double-quoted shell string — that path has a known shell injection
vector.`;
}

/**
 * Recall skill template — describes the multi-step recall workflow to the
 * host LLM. Byte-identical across every {@link SKILL_TARGETS} entry, so the
 * file passes `skills-ref validate` and works on Claude Code, Codex, Cursor,
 * Windsurf, OpenCode, and Gemini without per-host divergence.
 */
export function buildRecallSkillTemplate(): string {
	return `---
name: jolli-recall
description: Recall prior development context from Jolli for the current branch. Use when the user wants to recall, remember, or resume prior work on a branch.
metadata:
  version: "${SKILL_VERSION}"
  vendor: "jolli.ai"
---

# Jolli Recall

> Every commit deserves a Memory. Every memory deserves a Recall.

Load the structured development context for a branch — commits with their
distilled topics (trigger / response / decisions / files), plus any plans
and notes that the work referenced. Synthesize a grounded answer to the
user's prompt about that branch.

## Step 1: Load the recall result

\`<user-arg>\` is a branch name (exact or fragment) or empty (current branch).

### Preferred: MCP tool

If \`mcp__jollimemory__recall\` is available, call it with \`{ "branch": "<user-arg>" }\`
(omit \`branch\` when \`<user-arg>\` is empty). It returns a \`type\`-tagged object —
\`recall\` / \`catalog\` / \`error\` — identical to the CLI fallback below.

### Fallback: CLI here-doc

If no such tool is available, use:

${heredocInvocation("recall", " --format json")}

If \`~/.jolli/jollimemory/run-cli\` does not exist, tell the user:
"Jolli not installed. Please install via \`npm install -g @jolli.ai/cli && jolli enable\` or install the Jolli VS Code extension."
Do not attempt further processing.

Both the MCP tool and the CLI fallback return the same \`type\`-tagged union.
Handle the result using Step 2 regardless of which path was used.

## Step 2: Handle the result by \`type\`

The result (from either the MCP tool or the CLI) is a \`type\`-tagged object:

- \`type:"recall"\` → render Part A + Part B below.
- \`type:"catalog"\` → semantic-match \`<user-arg>\` against \`branches[].branch\` /
  \`commitMessages\` / \`topicTitles\`. One match → repeat Step 1 with that branch.
  Many → list and ask. None → show catalog, ask to clarify.
- \`type:"error"\` → surface \`message\` verbatim (translated); for "no records",
  suggest \`jolli enable\`. Never fabricate.

### type: "recall" — full payload returned

You have a \`RecallPayload\` with these fields:

- \`branch\`, \`period: { start, end }\`, \`commitCount\`, \`totalFilesChanged\`,
  \`totalInsertions\`, \`totalDeletions\` — branch-level facts.
- \`commits[]\` — per-commit projection. Each carries:
  - identity (always present): \`hash\` (8-char display), \`fullHash\`, \`branch\`,
    \`commitDate\`, \`commitAuthor\`, \`commitMessage\`; optional \`commitType?\`,
    \`ticketId?\`.
  - \`diffStats?\` — \`{ filesChanged, insertions, deletions }\`.
  - \`recap?\` — 1-3 paragraphs of plain-English narrative.
  - \`topics[]\` — each with **always present**: \`title\`, **\`decisions\` (★)**;
    **may be absent**: \`trigger?\`, \`response?\`, \`todo?\`, \`filesAffected?\`,
    \`category?\`, \`importance?\`. Trimming rules differ by field:
    - \`response\` is **policy-trimmed unconditionally** when the branch
      ships more than 8 kept commits — raising \`--budget\` will not bring
      it back. Additionally, on tight budgets it may be dropped
      oldest-first on shorter branches.
    - \`trigger\` is only dropped by \`--budget\` (oldest-first); raising
      \`--budget\` can restore it.
    - \`decisions\` is never dropped from a kept commit (if the budget
      can't fit it, the whole commit is omitted from \`commits[]\`).
  - \`plans?\` — \`{ slug, title }[]\` refs only; \`slug\` is the **normalized
    base slug** that always resolves to an entry in payload-level \`plans\`.
  - \`notes?\` — \`{ id, title }[]\` refs only; \`id\` always resolves to an
    entry in payload-level \`notes\`. (Notes use \`id\`, not \`slug\` — they
    have no archive-suffix mechanism.)
- \`plans[]\` — branch-deduplicated plan bodies: \`{ slug, title, content? }\`.
  \`content\` may be absent under tight budget — when absent, the entry is
  still a valid grounding anchor but you can't quote from it.
- \`notes[]\` — same shape and trimming rule as plans.
- \`stats\`, \`estimatedTokens\`, \`truncated?\`.

Render in two parts (in order):

#### Part A — Forced fact opener (no paraphrase, no interpretation)

Render the loaded confirmation as a heading + bullet block (not a prose
line). **Facts only — do not interpret what the branch is "about" here.**
The mandated shape:

\`\`\`markdown
### Loaded \`feature/auth\`

- **Period:** 2026-04-10 → 2026-04-15 (5 days)
- **Commits:** 8 (+312 −89, 24 files)
- **Captured:** 12 topics, 5 key decisions, 2 plans, 3 notes
\`\`\`

The heading + bullet shape is required — a single prose line blends into
the synthesis below and the user loses the visual anchor for verification.
Save interpretation for Part B.

#### Part B — Free-form synthesis

Pick whatever shape best serves the user's prompt: prose narrative,
chronological timeline, decision-focused bullet list, per-theme
\`###\` sections, side-by-side comparison, mixed. When multiple
distinct themes emerge across the commits, prefer \`###\` per theme —
inline-bold paragraph prefixes blend into a wall under markdown
rendering. The principles below are the only constraints.

#### Universal principles (apply regardless of shape)

1. **Lead with the answer.** No "Let me analyze..." or "Found N commits..."
   preamble.

2. **Ground every concrete claim** to a hash and/or file. Use \`(abc12345)\`
   for hashes and \`[middleware/auth.ts](middleware/auth.ts)\` for files.

3. **Synthesize, don't dump — but DO use verbatim quotes from stored
   data.** Read everything; fold into coherent prose or bullets.
   Whenever a phrase from \`decisions\` / \`recap\` / \`plans[].content\` /
   \`notes[].content\` captures the answer more compactly than your
   paraphrase, quote it verbatim in **bold** with attribution.

   Quote **complete clauses (typically 10-30 words)** — not 2-3 word
   fragments that depend on your surrounding paraphrase to mean
   anything. The reader should be able to skim the bold quote alone
   and understand its claim. Format, embedded in narrative:

   *The design chose JWT because* **"the stateless model lets us scale
   horizontally without a shared session store across regions"**
   *(decisions, abc12345)*; *per the auth-redesign plan,* **"all session
   tokens must be opaque, with no client-readable claims, so rotation
   never breaks the API"** *(plan: auth-redesign)*.

   **Bold = verbatim from stored data.** Never use bold for general
   emphasis. Quotes belong inside running prose or bullets that carry
   their own narrative — never as bare bullets stripped of context.
   Stringing bare quotes is the wall-of-fragments failure mode.

4. **Reply in the user's language.** Template is English; user-visible
   output matches the user.

5. **Don't expose machinery.** No "RecallPayload" / "commits array" /
   "JSON field" / "SearchHit" mentions.

6. **Brief by default — synthesize, don't dump every commit.** Skip
   routine commits and merge overlapping themes; aim for ~500 words
   on a typical branch, but favor section structure over compression.
   Never collapse \`###\` themes into inline-bold paragraph prefixes
   just to hit a word count — that produces a wall and defeats the
   structure's purpose. Branches with many distinct themes may
   legitimately run longer; a "deep dive" on a specific theme is
   opt-in.

#### Plan / note stubs on commits

When a commit carries \`plans?\` / \`notes?\` stubs, use the stub title as a
grounding anchor for narrative ("the auth-redesign plan guides this work").

**To quote from a plan or note body**, look up the matching entry in the
top-level \`plans\` / \`notes\` array by its \`slug\` (plans) or \`id\` (notes):

- If the entry has \`content\`: quote verbatim with \`(plan: <slug>)\` /
  \`(note: <id>)\` attribution if relevant to the user's prompt.
- If \`content\` is absent (budget trimming dropped the body): use **only**
  the title as a citation anchor — never fabricate a quote from a body
  you cannot see.

#### Empty / partial handling

- Empty \`commits\`: tell the user no records were found; suggest running
  \`jolli enable\` if they expected records.
- \`truncated: true\`: policy trims or budget enforcement dropped fields
  or commits. Policy trims drop \`importance: "minor"\` topics (and any
  commit whose every topic is minor) and drop \`topic.response\` when the
  branch ships more than 8 commits; budget trims drop oldest-first
  \`response\` / \`trigger\` / plan / note content. Mention it with a
  one-liner if the user asks for deeper detail; otherwise stay silent.

### type: "catalog" — branch lookup needed

Returned when no exact branch match was found. Has a \`branches[]\` array
with \`branch\`, \`commitCount\`, \`period\`, \`commitMessages\`, \`topicTitles?\`.
If a \`query\` field is present, semantic-match the user's input against
\`branch\`, \`commitMessages\`, and \`topicTitles\` (the highest-signal source);
support cross-language matching and time-relative queries.

- One match: re-run Step 1 with the chosen branch as the user-arg and
  continue from Step 2.
- Multiple matches: list candidates, ask user to choose.
- No matches: show the catalog, ask user to clarify.

### type: "error" — CLI returned a hard error

Has a \`message\` string. Common cases:

- Branch matched but its summaries failed to load.
- No records in the repo at all.
- Invalid argument or internal failure.

Surface the message verbatim to the user (translated into their language if
non-English). For "no records in this repo" specifically, suggest running
\`jolli enable\` if they expected records. Do NOT retry or fabricate a recall
payload from nothing.
`;
}

/**
 * PR-description skill template — instructs the host LLM to call the
 * `get_pr_description` MCP tool (exposed as `mcp__jollimemory__get_pr_description`
 * on Claude Code) and then create the PR via `gh`, without rewriting the
 * tool-returned body from the diff. Byte-identical across every
 * {@link SKILL_TARGETS} entry, spec-compliant frontmatter only.
 */
function buildPrSkillTemplate(): string {
	return `---
name: jolli-pr
description: Create or update a pull request using a Jolli Memory-generated description. Detects whether the branch already has an open PR, calls the get_pr_description MCP tool, then runs gh to open or update the PR.
metadata:
  version: "${SKILL_VERSION}"
  vendor: "jolli.ai"
---

# Jolli PR

Create a pull request whose title and body come from Jolli Memory's structured
commit history — not from re-reading the diff. Every sentence in the description
is grounded in the distilled decisions and topics that were recorded when the
commits were made.

## Hard rule (read this first)

The title and body MUST come from the PR-description data (the \`get_pr_description\`
MCP tool, or its CLI fallback below — both return the identical shape).

**Do NOT rewrite or replace the body from the diff.** Doing so loses the
structured decisions and rationale that Jolli Memory captured. You MAY adjust
only the title, and only if the user explicitly asks. Do NOT add a
\`Co-Authored-By: Claude\` trailer or a "Generated with Claude" footer — the
body's own "Generated by Jolli Memory" footer is the product signature and must
remain unchanged.

## Step 0: Wait for pending memory

A freshly-committed change is summarized by a detached background worker that
can take tens of seconds. If you build the PR before it finishes, those commits
land in the "skipped" footnote instead of the body. So first make sure memory
generation is idle.

### Probe the queue

Preferred (MCP): call the \`queue_status\` tool (on Claude Code
\`mcp__jollimemory__queue_status\`) with no arguments.

Fallback (CLI):

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" queue-status --format json
\`\`\`

Both return a status object:

\`\`\`json
{ "active": 2, "workerBlocking": true, "drained": false }
\`\`\`

- If \`drained\` is \`true\` → skip straight to Step 1.
- Otherwise tell the user "N memory summaries are still generating — waiting…"
  (N = \`active\`), then wait for it to finish:

  Preferred (MCP): call \`queue_status\` with \`{"wait": true, "timeoutMs": 120000}\`.

  Fallback (CLI):

  \`\`\`bash
  "$HOME/.jolli/jollimemory/run-cli" queue-status --wait --timeout 120 --format json
  \`\`\`

- The wait call returns \`drained: true\` → continue to Step 1.
- It returns \`drained: false\` (timed out) → **STOP and ask the user**:
  "Memory is still generating after 120s. Keep waiting, or create the PR now
  with what's ready?" Continue only when they answer; if they choose to keep
  waiting, repeat the wait call.

\`active\` counts only memory-summary work — Memory Bank wiki/graph rendering is
intentionally excluded, so this never blocks on wiki generation.

The wait only covers work already enqueued when you probe. If you just made a
commit, give the \`post-commit\` hook a moment to enqueue it before probing (or
re-probe once) so the just-committed change isn't missed by a too-early \`drained\`.

## Step 1: Detect whether an open PR already exists

This skill both creates and updates. First find out which: does the current
branch already have an **open** PR?

\`\`\`bash
BRANCH="$(git branch --show-current)"
[ -z "$BRANCH" ] && { echo "detached HEAD — check out a branch before creating a PR"; exit 1; }
gh pr list --head "$BRANCH" --state open --json number,url,baseRefName
\`\`\`

If the block prints the detached-HEAD message (empty \`BRANCH\`), STOP and tell the
user to check out a branch first — a PR can't be opened from a detached HEAD.

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

### Preferred: MCP tool

If the \`get_pr_description\` tool is available, call it. On Claude Code it is
named \`mcp__jollimemory__get_pr_description\`; on other hosts it appears as
\`get_pr_description\` under the \`jollimemory\` MCP server. It describes the
current branch and compares against a base branch, defaulting to the
repository's default branch (origin/HEAD).

- **Create mode:** if the user asked for a non-default base, pass \`baseBranch\`
  (e.g. \`{"baseBranch": "develop"}\`); otherwise call with no arguments.
- **Update mode:** pass the existing PR's base from Step 1 —
  \`{"baseBranch": "<baseRefName>"}\` — so the description's diff range matches the
  PR you are about to update.

### Fallback: CLI here-doc

If no such tool is available, run the \`pr-description\` CLI command instead. It
wraps the exact same engine and returns the identical JSON shape.

**Common case (PR targets the default branch)** — no user input, so no here-doc
is needed:

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" pr-description --format json
\`\`\`

**Non-default base** — the base branch is user-supplied text, so pass it on
stdin via the same injection-safe here-doc recipe the other Jolli skills use,
NOT interpolated into argv:

${heredocInvocation("pr-description", " --format json")}

Here \`<user-arg>\` is the base branch name — in create mode the user-supplied
base (e.g. \`develop\`), in update mode the \`baseRefName\` from Step 1. In create
mode, remember it — Step 4 must pass the same value to \`gh pr create --base\`.
In update mode the base is not passed to \`gh\`; an existing PR's target branch
is left unchanged.

Do NOT fall back to \`npm run\`, \`npx\`, \`node\` directly, PowerShell-native
commands, WSL bash, or any workspace-local script.

**Failure handling**:
- If \`~/.jolli/jollimemory/run-cli\` does not exist: tell the user
  "Jolli not installed. Please install via \`npm install -g @jolli.ai/cli && jolli enable\`
  or install the Jolli VS Code extension." Do not attempt further processing.
- If the command output starts with \`error:\` or contains \`unknown command 'pr-description'\`:
  the installed CLI is older than this skill. Tell the user
  "Your installed Jolli CLI is older than this skill — please run
  \`npm update -g @jolli.ai/cli\` (or update your VS Code extension), then retry."
  Do not attempt further processing.

### The result (both paths return this shape)

Both the MCP tool and the CLI fallback return the same JSON object:

\`\`\`json
{
  "title": "feat(auth): add JWT refresh-token rotation",
  "body": "## Summary\\n...",
  "missingCount": 2,
  "summaryCount": 8,
  "commitCount": 10
}
\`\`\`

### Error: no summaries

If the call errors with a message containing "No JolliMemory summaries" (or
any equivalent indicating the branch has no committed memory) — for the CLI
fallback this arrives as \`{"type":"error","message":"…"}\` — tell the user:

> "This branch has no Jolli Memory yet. Commit some changes with Jolli enabled
> and then retry."

**STOP — do not proceed.**

### Warning: some commits missing memory

If \`missingCount > 0\`, tell the user before proceeding:

> "N of this branch's commits have no Jolli Memory. The description already
> includes a footnote listing the skipped commits."

Then continue to Step 3.

## Step 3: Push the branch

Check whether the current branch already has an upstream tracking branch:

\`\`\`bash
git rev-parse --abbrev-ref --symbolic-full-name @{u}
\`\`\`

- **If it prints an upstream** (e.g. \`origin/<branch>\`) and there are unpushed
  commits, push to that existing upstream — do NOT re-point it or assume
  \`origin\`, which would rewire tracking or push to the wrong remote:

  \`\`\`bash
  git push
  \`\`\`

- **If it errors** with "no upstream configured", create one on \`origin\`:

  \`\`\`bash
  git push -u origin "$(git branch --show-current)"
  \`\`\`

If the push fails (e.g. protected branch, no remote), surface the error to the
user and STOP.

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

Pick the ONE block below that matches your mode and run it **as a single shell
invocation** — the \`mktemp\` temp file lives only for that one invocation, so the
write, the \`gh\` call, and the cleanup must stay in the same block. In each,
replace the two \`<DELIM>\` occurrences with your delimiter token and paste the
full body string verbatim between them.

**Create mode** — open a new PR:

\`\`\`bash
JOLLI_PR_BODY_FILE=$(mktemp)
cat > "$JOLLI_PR_BODY_FILE" <<'JOLLI_PR_BODY_<DELIM>_END'
<paste the full body string from the tool here>
JOLLI_PR_BODY_<DELIM>_END
gh pr create --title "<title from tool>" --body-file "$JOLLI_PR_BODY_FILE"
rm -f "$JOLLI_PR_BODY_FILE"
\`\`\`

If you passed a \`baseBranch\` to the tool in Step 2 (the PR targets a non-default
base), add the same value as \`--base <baseBranch>\` to \`gh pr create\`. Otherwise
\`gh\` defaults to the repository's default branch, and the PR would target a
different base than the description was computed against:

\`\`\`bash
JOLLI_PR_BODY_FILE=$(mktemp)
cat > "$JOLLI_PR_BODY_FILE" <<'JOLLI_PR_BODY_<DELIM>_END'
<paste the full body string from the tool here>
JOLLI_PR_BODY_<DELIM>_END
gh pr create --base <baseBranch> --title "<title from tool>" --body-file "$JOLLI_PR_BODY_FILE"
rm -f "$JOLLI_PR_BODY_FILE"
\`\`\`

**Update mode** — overwrite the existing PR's title and body with the freshly
generated description, using the \`number\` remembered in Step 1:

\`\`\`bash
JOLLI_PR_BODY_FILE=$(mktemp)
cat > "$JOLLI_PR_BODY_FILE" <<'JOLLI_PR_BODY_<DELIM>_END'
<paste the full body string from the tool here>
JOLLI_PR_BODY_<DELIM>_END
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

After reporting the PR URL, ask the user: "Push this branch's memory to Jolli?"
Only proceed if they say yes.

Preferred (MCP): call \`push_memory\` (on Claude Code \`mcp__jollimemory__push_memory\`),
optionally \`{"space": "<name-or-id>"}\` if the user named a space, else \`{}\`.
Fallback (CLI): \`"$HOME/.jolli/jollimemory/run-cli" push --format json\` (add \`--space <id|slug>\` if named).

- \`{ "type": "pushed", "pushed": N, "urls": [...] }\` → tell the user N memories were pushed; share the article URLs.
- \`{ "type": "binding_required", "repoUrl": "...", "spaces": [ { "id", "name", "slug" } ], "defaultSpaceId": N }\`
  → this repo isn't linked to a Jolli memory space yet. Present the \`spaces\` list and let the user pick one
  (or use the space they already named). Then bind + retry:
  MCP: \`bind_space\` with \`{"space": "<id-or-slug>"}\`, then call \`push_memory\` again.
  CLI: \`"$HOME/.jolli/jollimemory/run-cli" bind --space <id|slug>\`, then \`... push --format json\`.
  The binding is remembered server-side per repo, so future pushes won't ask again.
- \`{ "type": "error", "message": "..." }\` → relay it (e.g. not signed in → sign in / \`jolli auth login\`; outdated → update). Do not retry blindly.
`;
}

/**
 * Search skill template — describes the single-phase lightweight BM25 search
 * workflow to the host LLM. Byte-identical across every {@link SKILL_TARGETS}
 * entry, same spec-compliant frontmatter as recall.
 *
 * Preferred path: call \`mcp__jollimemory__search\` directly (returns lightweight
 * \`{ hits }\` — no two-phase catalog/detail load). Fallback: CLI here-doc with
 * the same \`{ hits }\` envelope.
 */
export function buildSearchSkillTemplate(): string {
	return `---
name: jolli-search
description: Search structured commit memories across all branches — decisions, topics, files. Use when the user wants to find prior decisions, related commits, or how a topic was handled before.
metadata:
  version: "${SKILL_VERSION}"
  vendor: "jolli.ai"
---

# Jolli Search

Search structured commit memories across every branch in this repo.
Lightweight BM25 index returns relevance-ranked hits — no two-phase catalog
scan required. For full context of a known branch, use jolli-recall instead.

## When to use

- "Has anyone dealt with X before?" / "How have we handled Y previously?"
- Looking for a past decision: "why did we choose X over Y?"
- Finding the commit related to a half-remembered ticket / file / topic.

## When NOT to use

- Need full context of a known branch → run jolli-recall.
- Looking at the current code → grep / read files directly.
- Need deep rationale/decisions for a specific branch → run jolli-recall on
  that branch (search hits are lightweight; full decisions live in recall).

## Step 1: Parse the query

Extract the natural-language query (any language). Optional: \`limit\` (integer,
default 20). Note: time/budget filters (\`--since\`, \`--budget\`) are not supported
on the search path — point users at jolli-recall for a full branch when they
need depth.

## Step 2: Get hits

### Preferred: MCP tool

If \`mcp__jollimemory__search\` is available, call it with:

\`\`\`json
{ "query": "<query>", "limit": 20 }
\`\`\`

Returns \`{ "hits": [ { type, title, snippet, branch, commitDate, slug, hash, score } ] }\`,
relevance-ranked (BM25). Proceed to Step 3 with these hits.

### Fallback: CLI here-doc

If no such tool is available, use:

${heredocInvocation("search", " --format json")}

The CLI returns the same \`{ hits }\` envelope as the MCP tool.

**Failure handling**:
- If \`~/.jolli/jollimemory/run-cli\` does not exist: tell the user
  "Jolli not installed. Please install via \`npm install -g @jolli.ai/cli && jolli enable\`
  or install the Jolli VS Code extension." Do not attempt further processing.
- If the command output starts with \`error:\` or contains \`unknown command 'search'\`:
  the installed CLI is older than this skill. Tell the user
  "Your installed Jolli CLI is older than this skill — please run
  \`npm update -g @jolli.ai/cli\` (or update your VS Code extension), then retry."
  Do not attempt further processing.

Both paths produce the same \`{ hits }\` shape. Proceed to Step 3 regardless of
which path was used.

## Step 3: Render

\`hits\` are lightweight — no full decisions/recap per hit. For each relevant
hit you have:

- \`type\` — \`"commit"\` or \`"topic"\`
- \`title\` — one-sentence label
- \`snippet\` — short excerpt from the matching content
- \`branch\` — branch the hit belongs to
- \`commitDate\` — ISO 8601 date
- \`slug\` — human-readable identifier (for topics)
- \`hash\` — 8-char short SHA (for commits)
- \`score\` — BM25 relevance score (internal; do not expose to the user)

**Universal principles** (apply regardless of shape):

1. **Lead with the answer.** No "Let me analyze..." or "Found N commits..." preamble.

2. **Ground every concrete claim** to its \`hash\` (commit hits) or \`slug\` +
   \`branch\` (topic hits). Use \`(abc12345)\` for hashes.

3. **Synthesize, don't dump — but DO use verbatim quotes from stored data.**
   Read everything; fold into coherent prose or bullets. Whenever a phrase from
   \`snippet\` captures the answer more compactly than your paraphrase, quote it
   verbatim in **bold** with attribution.

   Quote **complete clauses (typically 10-30 words)** — not 2-3 word fragments
   that depend on your surrounding paraphrase to mean anything. The reader
   should be able to skim the bold quote alone and understand its claim.
   Format, embedded in narrative: *the design chose JWT because*
   **"the stateless model lets us scale horizontally without a shared session store across regions"**
   *(snippet, abc12345)*.

   **Bold = verbatim from stored data.** Never use bold for general emphasis.
   Quotes belong inside running prose or bullets that carry their own narrative
   — never as bare bullets stripped of context. Stringing bare quotes is the
   wall-of-fragments failure mode.

4. **Reply in the user's language.** Template is English; user-visible output
   matches the user.

5. **Don't expose machinery.** No "BM25" / "SearchHit" / "hits array" / "score"
   mentions. Don't expose \`slug\` or internal field names either.

6. **Output shape is entirely your call.** Prose, compact list, timeline,
   per-theme sections — pick whatever serves the query. Every concrete claim
   must be groundable to a hash or branch.

7. **If the user needs the full decisions/rationale behind a hit**, tell them
   to run jolli-recall on that hit's \`branch\`.

**Empty hits** → tell the user nothing matched; suggest broader keywords or a
different phrasing. Do NOT mention BM25 or index internals.
`;
}

/**
 * The `jolli` umbrella-menu skill — surfaces as a bare `/jolli` and acts as the
 * single friendly front door over the sibling Jolli skills plus whatever
 * `mcp__jollimemory__*` tools are registered in the session. It only steers the
 * agent to invoke an already-existing skill or tool; it is never a second
 * execution path for any action, and it does NOT re-derive the backend's curated
 * `menu` metadata (a static SKILL.md cannot fetch the manifest — curation of which
 * platform tools belong in the menu stays authoritative in the server-side MCP
 * `jolli` prompt). Byte-identical across every {@link SKILL_TARGETS} entry, with
 * spec-compliant frontmatter only.
 *
 * The menu-interaction contract mirrors the MCP `jolli` prompt (see
 * `cli/src/mcp/JolliMenu.ts`): argument provided → match to one action and invoke
 * it directly, asking only when ambiguous or unmatched; argument absent → present
 * the menu via an interactive single-select tool where the host provides one (e.g.
 * Claude Code's AskUserQuestion), otherwise a plain-text list, then invoke the
 * chosen action. Host-agnostic by design — the AskUserQuestion mention is only an
 * example and the text-list fallback keeps `/jolli` usable on every host.
 */
export function buildJolliMenuSkillTemplate(): string {
	return `---
name: jolli
description: The Jolli action menu — a single front door that lists the Jolli skills (recall, search, pr) plus the Jolli MCP tools registered in this session, then routes your choice to the right one. Use when the user types /jolli or asks for the Jolli menu.
metadata:
  version: "${SKILL_VERSION}"
  vendor: "jolli.ai"
---

# Jolli

The single umbrella action menu for Jolli. It ties together the standalone Jolli
skills and whatever Jolli MCP tools are registered in this session, and routes the
user's choice to the right one. It is a friendly front door — it **never**
re-implements any action, it only invokes an existing skill or an existing MCP
tool. The standalone \`/jolli-recall\`, \`/jolli-search\`, \`/jolli-pr\` commands and
the \`/mcp__jollimemory__jolli\` prompt all keep working unchanged; this is layered
on top of them, not a replacement.

## Step 1 — build the unified menu

Assemble ONE combined list of actions from two sources.

### Local Jolli skills (always present)

- **jolli-recall** — Recall prior development context for the current branch.
  Route by invoking the \`jolli-recall\` skill.
- **jolli-search** — Search structured commit memories across branches
  (decisions, topics, files). Route by invoking the \`jolli-search\` skill.
- **jolli-pr** — Create or update a pull request using a Jolli Memory-generated
  description. Route by invoking the \`jolli-pr\` skill.

Route a local choice by invoking that skill through your host's skill-invocation
mechanism (for example, the Skill tool in Claude Code).

### Jolli MCP tools (whatever is registered this session)

Surface every tool whose name starts with \`mcp__jollimemory__\` that is available
in the current session — for example \`recall\`, \`search\`, \`get_pr_description\`,
\`queue_status\`, and any manifest-driven platform tools (workflow, space, article,
and the like). Route a choice by calling the matching \`mcp__jollimemory__*\` tool.

Do NOT assume a fixed list — enumerate the Jolli MCP tools that are actually
registered right now. Do NOT try to fetch or re-derive any backend "menu"
curation; a skill cannot read the manifest, so simply surface the Jolli MCP tools
present in the session. If no Jolli MCP tools are registered, present just the
local skills above.

## Step 2 — route the request

This skill takes one optional free-text argument.

- **Argument provided** → match it to exactly one menu action and invoke that
  action directly (invoke the skill, or call the MCP tool). Only ask the user to
  choose if the request is ambiguous or matches no menu action.
- **Argument absent** → present the unified menu and let the user pick one, using
  an interactive single-select tool if your host provides one (for example
  AskUserQuestion in Claude Code); otherwise list the options as plain text and
  ask the user to choose. After the user selects, invoke the corresponding skill
  or MCP tool.

Host-agnostic by design: the AskUserQuestion mention is only an example; the
text-list fallback keeps \`/jolli\` usable on every host that loads skills.
`;
}
