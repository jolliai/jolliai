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
];

/**
 * Skill paths recorded in `.git/info/exclude` so they don't pollute
 * `git status` in user repositories. Always 6 entries: 3 skills × 2 targets.
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
function heredocInvocation(subcommand: "recall" | "search", flagSuffix: string): string {
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
function buildRecallSkillTemplate(): string {
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

## Step 1: Run the CLI

The user's input \`<user-arg>\` is either a branch name (exact or fragment) or
empty (in which case the CLI uses the current git branch).

${heredocInvocation("recall", " --format json")}

If \`~/.jolli/jollimemory/run-cli\` does not exist, tell the user:
"Jolli not installed. Please install via \`npm install -g @jolli.ai/cli && jolli enable\` or install the Jolli VS Code extension."
Do not attempt further processing.

## Step 2: Handle the response

The output is JSON with a \`type\` field. Three cases:

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
description: Create a pull request using a Jolli Memory-generated description. Calls the get_pr_description MCP tool then runs gh to open the PR.
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

The title and body MUST come from the \`get_pr_description\` tool output.

**Do NOT rewrite or replace the body from the diff.** Doing so loses the
structured decisions and rationale that Jolli Memory captured. You MAY adjust
only the title, and only if the user explicitly asks. Do NOT add a
\`Co-Authored-By: Claude\` trailer or a "Generated with Claude" footer — the
body's own "Generated by Jolli Memory" footer is the product signature and must
remain unchanged.

## Step 1: Call the get_pr_description MCP tool

On Claude Code, the tool is named \`mcp__jollimemory__get_pr_description\`.
On other hosts it appears as \`get_pr_description\` under the \`jollimemory\`
MCP server. Call it with no arguments — it describes the current branch and
compares against the repository's default branch (origin/HEAD). If this PR
targets a different base, pass \`baseBranch\` (e.g. \`{"baseBranch": "develop"}\`).

The tool returns a JSON object:

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

If the tool errors with a message containing "No JolliMemory summaries" (or
any equivalent indicating the branch has no committed memory), tell the user:

> "This branch has no Jolli Memory yet. Commit some changes with Jolli enabled
> and then retry."

**STOP — do not proceed.**

### Warning: some commits missing memory

If \`missingCount > 0\`, tell the user before proceeding:

> "N of this branch's commits have no Jolli Memory. The description already
> includes a footnote listing the skipped commits."

Then continue to Step 2.

## Step 2: Push the branch

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
`;
}

/**
 * Search skill template — describes the two-phase catalog/detail search
 * workflow to the host LLM. Byte-identical across every {@link SKILL_TARGETS}
 * entry, same spec-compliant frontmatter as recall.
 *
 * Two-phase pattern: catalog scan → hash-targeted detail load. The chat LLM
 * does all semantic work (matching the user's query against catalog content);
 * the CLI is purely a deterministic data source.
 */
function buildSearchSkillTemplate(): string {
	return `---
name: jolli-search
description: Search structured commit memories across all branches — decisions, topics, files. Use when the user wants to find prior decisions, related commits, or how a topic was handled before.
metadata:
  version: "${SKILL_VERSION}"
  vendor: "jolli.ai"
---

# Jolli Search

Search structured commit memories across every branch in this repo.
Uses LLM-distilled summaries (decisions, topic titles, recap, filesAffected) —
not raw markdown — so semantic / cross-language / synonym matching is a fit
for the chat LLM that runs this skill.

## When to use

- "Has anyone dealt with X before?" / "How have we handled Y previously?"
- Looking for a past decision: "why did we choose X over Y?"
- Finding the commit related to a half-remembered ticket / file / topic.

## When NOT to use

- Need full context of a known branch → run jolli-recall.
- Looking at the current code → grep / read files directly.

## Step 1: Parse the user input into query + flags

The user can include flags inline, e.g. \`auth --since 2w\`. Before invoking
the CLI, split the user's argument into two parts:

1. **Query**: the user's keyword / sentence (everything that is NOT a CLI flag).
   The query may be in any human language and contain natural punctuation
   (\`?\`, \`#\`, \`(\`, etc.).
2. **Flags**: any of \`--since <date>\`, \`--limit <n>\`, \`--budget <tokens>\`,
   \`--output <path>\`. Pass these through verbatim. Ignore any other token starting
   with \`--\`.

The query is delivered to the CLI on stdin via a here-doc, and flags go on
argv as separate tokens. Never put flags inside the here-doc body.

## Step 2: Run the catalog phase

${heredocInvocation("search", " <flags> --format json")}

Replace \`<flags>\` with the parsed flags from Step 1 (e.g. \`--since 2w --limit 30\`)
or remove the placeholder entirely if there are no flags. Always include
\`--format json\`.

Worked examples (the part the LLM has to construct):

| User input                                  | Bash you should run                                                                                |
|---------------------------------------------|----------------------------------------------------------------------------------------------------|
| \`auth\`                                    | \`run-cli search --arg-stdin --format json <<'JOLLI_ARG_<DELIM>_END' …\`                            |
| \`auth --since 2w\`                         | \`run-cli search --arg-stdin --since 2w --format json <<'JOLLI_ARG_<DELIM>_END' …\`                 |
| \`why did we choose X over Y? --since 1m\`  | \`run-cli search --arg-stdin --since 1m --format json <<'JOLLI_ARG_<DELIM>_END' …\`                 |

The \`…\` after \`<<'JOLLI_ARG_<DELIM>_END'\` is the here-doc body containing
the query, followed on a new line by the closing \`JOLLI_ARG_<DELIM>_END\`.

**Failure handling**:
- If \`~/.jolli/jollimemory/run-cli\` does not exist: tell the user
  "Jolli not installed. Please install via \`npm install -g @jolli.ai/cli && jolli enable\`
  or install the Jolli VS Code extension." Do not attempt further processing.
- If the command output starts with \`error:\` or contains \`unknown command 'search'\`:
  the installed CLI is older than this skill. Tell the user
  "Your installed Jolli CLI is older than this skill — please run
  \`npm update -g @jolli.ai/cli\` (or update your VS Code extension), then retry."
  Do not attempt further processing.

The output is a JSON object with \`type: "search-catalog"\` containing one entry per
recent root commit, each with \`branch\`, \`date\`, \`recap\`, \`ticketId\`, and \`topics\`
(title / decisions / category / importance / filesAffected).

### What the output fields mean (don't conflate them)

- \`totalCandidates\`: number of root commits matching the time-window filter
  (i.e. catalog universe size after \`--since\` / \`--limit\`).
- \`entries\`: the actual array you'll scan — usually fewer than \`totalCandidates\`
  because \`--budget\` may have trimmed less-recent ones to fit the token cap.
- \`truncated: true\` means at least one candidate didn't make it into \`entries\`.

**The catalog is NOT pre-filtered by the user's query**. It's a recent-commits
window — your job in Step 3 is to do the semantic filter. Don't be surprised
if many entries look unrelated; that's expected.

## Step 3: Pick relevant commit hashes (semantic, not literal)

**Read each entry's \`title\`, \`recap\`, \`decisions\`, and \`filesAffected\` and judge
semantic relevance to the user's intent.** The query and the entries may be in
different human languages. Cross-language and synonym matching is YOUR job here.

- Pick **5-10** commits whose meaning relates to the query. The Phase 2 payload
  carries full topic content per hit (trigger / response / decisions / files);
  picking more than 10 risks blowing the chat context budget for ambitious
  queries.
- Don't worry if no entry contains the literal query token — that's exactly what
  semantic picking is for.

**If \`truncated\` is \`true\` and the entries you see don't include obvious matches**,
silently retry Step 2 once with \`--budget 50000\` to see more of the corpus before
asking the user to narrow \`--since\`. Only ask the user to narrow time if the
larger budget still doesn't surface relevant commits.

### Internal constraints

- **DO** read the JSON inline from the previous tool result.
- **DO NOT** process programmatically — no temp files, no jq/python/grep
  scoring scripts. Semantic picking by reading is the whole point.

## Step 4: Load full content for the picks

Construct the Phase 2 bash with the same here-doc recipe from Step 2, but add
\`--hashes <fullHash1,fullHash2,fullHash3>\` to the flags:

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" search --arg-stdin --hashes <fullHash1>,<fullHash2>,<fullHash3> --format json <<'JOLLI_ARG_<DELIM>_END'
<the query>
JOLLI_ARG_<DELIM>_END
\`\`\`

(Generate a new \`<DELIM>\` token for this invocation as in Step 2.)

**Use \`hit.fullHash\` (40-char SHA), NOT \`hit.hash\` (8-char display)**. The
CLI rejects abbreviated hashes — the 8-char display \`hash\` is for showing in
your output to the user, but Phase 2 lookup needs the unambiguous full SHA
(otherwise cherry-pick / rebase chains can resolve to the wrong commit silently).

Output is a \`SearchResult\` with \`results: SearchHit[]\`. See Step 5 for the schema and how to render.

## Step 5: Render to the user

The CLI gave you structured data — full distilled content per commit.
**Output shape is entirely your call.** Pick whatever serves the user's
query: prose, table, timeline, side-by-side, mixed. **The principles below
are the only constraints.**

### A. The data you have (per hit)

Each \`results[i]\` is a \`SearchHit\`:

**Identity / provenance**:
- \`hash\` — 8-char short SHA (plain text, no link)
- \`fullHash\` — 40-char full SHA
- \`commitMessage\` — raw subject (fallback for label; \`recap\` is usually better)
- \`commitAuthor\` — for "who worked on X" queries
- \`commitDate\` — ISO 8601
- \`branch\`
- \`commitType?\` — \`"commit"\` / \`"amend"\` / \`"squash"\` / \`"rebase-pick"\` / \`"cherry-pick"\` / \`"revert"\`; helps distinguish routine commits from consolidated ones
- \`ticketId?\` — render as \`[TICKET-1234]\` badge

**Change scale**:
- \`diffStats?\` — \`{ filesChanged, insertions, deletions }\`

**Narrative**:
- \`recap?\` — 1-3 paragraphs of plain-English narrative. Highest-quality prose; primary source for "what is X" / "explain X".

**Topics** — \`topics: SearchHitTopic[]\` (★ the meat):

  - \`title\` — one-sentence label
  - \`trigger?\` — 1-2 sentences, what prompted the work
  - \`response?\` — implementation summary, may include code; longest field
  - \`decisions\` ★ **THE STAR FIELD** — design choices + *why*, as markdown bullets. Primary source for "why did we choose X" / "what alternatives" / "rationale". Not in the diff; only here.
  - \`todo?\` — residual work the LLM flagged (rare)
  - \`filesAffected?\` — per-topic file list. Render as markdown links: \`[cli/src/Types.ts](cli/src/Types.ts)\`.
  - \`category?\` — \`feature\` / \`bugfix\` / \`refactor\` / \`tech-debt\` / \`docs\` / \`test\` / \`devops\` / \`ux\`
  - \`importance?\` — \`major\` / \`minor\`

**Plan / note stubs**:
- \`plans?\` — \`{ slug, title }[]\` — plan refs this commit declared. Search ships only stubs (no plan body); use the title as a grounding anchor in your narrative ("the decision is consistent with the auth-redesign plan referenced by this commit"). **Do NOT promise the user they can navigate to the plan body from search** — search Phase 2 carries no plan content.
- \`notes?\` — \`{ id, title }[]\` — same shape and rule as plans.

### B. Universal principles (apply regardless of shape)

1. **Lead with the answer.** No "Let me analyze..." or "Found N commits..." preamble.

2. **Ground every concrete claim** to a hash and/or file. Use \`(abc1234)\` for hashes and \`[cli/src/Types.ts](cli/src/Types.ts)\` for files.

3. **Synthesize, don't dump — but DO use verbatim quotes from stored data.** Read everything; fold into coherent prose or bullets. Whenever a phrase from \`recap\` or \`decisions\` captures the answer more compactly than your paraphrase, quote it verbatim in **bold** with attribution.

   Quote **complete clauses (typically 10-30 words)** — not 2-3 word fragments that depend on your surrounding paraphrase to mean anything. The reader should be able to skim the bold quote alone and understand its claim. Format, embedded in narrative: *the design chose JWT because* **"the stateless model lets us scale horizontally without a shared session store across regions"** *(decisions, abc1234)*.

   **Bold = verbatim from stored data.** Never use bold for general emphasis. Quotes belong inside running prose or bullets that carry their own narrative — never as bare bullets stripped of context. Stringing bare quotes is the wall-of-fragments failure mode.

4. **Reply in the user's language.** Template is English; user-visible output matches the user.

5. **Don't expose machinery.** No "Phase 1" / "Phase 2" / "catalog" / "SearchCatalog" / "SearchHit" / "JSON field" mentions.

### C. Output shape

Your call. The only hard rule: every concrete claim must be groundable to a hash or file (principle 2). If the picks share an obvious unifying theme (same \`branch\` / \`ticketId\` / initiative), name it.

### D. Empty / partial / failed-hash handling

This is the **only** place where it is appropriate to mention search-machinery
state (catalog size, truncation, hash load failures). Stay silent about it
when results are healthy.

- If \`results\` is empty: tell the user no usable content was found and suggest
  broader keywords or a wider \`--since\`. Coverage chatter is appropriate here:
  *"Scanned N candidates from the last <window>; none matched."*
- If the catalog was truncated (\`truncated: true\` from Phase 1) **and** the
  picks feel thin: *"Catalog hit the token budget; rerun with \`--budget 50000\`
  to widen the search."*
- If \`failedHashes\` is non-empty: mention which picks couldn't be loaded so the
  user knows the search isn't complete.
`;
}
