/**
 * Skill Installer
 *
 * Manages the installation, update, and cleanup of Jolli skill files for
 * Claude Code (`.claude/skills/<name>/SKILL.md`).
 *
 * Each skill is upserted **independently** by hash of its template content
 * compared with the version recorded in the file. This avoids the trap where
 * a single skill's version match short-circuits the whole installer and
 * prevents a newer skill (e.g. `jolli-search`) from ever being installed on
 * projects whose `jolli-recall` already matches the current version.
 *
 * Future extensions: MCP server registration for Codex CLI / Gemini CLI /
 * Cursor / Windsurf — added by appending a new entry to {@link SKILLS}.
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

/** Each registered skill: directory name and template builder. */
interface SkillRegistration {
	readonly name: string;
	readonly build: () => string;
}

/**
 * Registry of skills installed by `jolli enable`. Adding a new skill is
 * append-only — order in this array determines install order on first run.
 */
const SKILLS: ReadonlyArray<SkillRegistration> = [
	{ name: "jolli-recall", build: buildRecallSkillTemplate },
	{ name: "jolli-search", build: buildSearchSkillTemplate },
];

/**
 * Installs or updates Jolli skill files in the project's `.claude/skills/`
 * directory. Cleans up legacy directory names from prior versions.
 *
 * Each skill is checked and upserted independently, so installing a new skill
 * (or updating one of several) is not blocked by another skill's version
 * matching the running CLI.
 */
export async function updateSkillsIfNeeded(projectDir: string): Promise<void> {
	// Clean up legacy skill directories from previous versions
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

	for (const skill of SKILLS) {
		await upsertSkill(projectDir, skill.name, skill.build());
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
export async function updateSkillIfNeeded(projectDir: string): Promise<void> {
	return updateSkillsIfNeeded(projectDir);
}

/**
 * Writes one skill's SKILL.md file when its content version differs from
 * what's on disk. Idempotent.
 */
async function upsertSkill(projectDir: string, name: string, content: string): Promise<void> {
	const skillDir = join(projectDir, ".claude", "skills", name);
	const skillPath = join(skillDir, "SKILL.md");

	try {
		const existing = await readFile(skillPath, "utf-8");
		const versionMatch = existing.match(/(?:jolli-skill-version|jollimemory-version):\s*(.+)/);
		/* v8 ignore start -- version match: SKILL_VERSION is always "dev" in tests */
		if (versionMatch && versionMatch[1].trim() === SKILL_VERSION) {
			return; // Up to date
		}
		/* v8 ignore stop */
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
 * Recall skill template.
 *
 * **SECURITY NOTE**: every `${...}` placeholder substituted by the agent host
 * MUST be wrapped in double quotes when interpolated into a shell command.
 * Without quotes, user-supplied query text containing shell metacharacters
 * (`;`, `|`, `&`, backticks, etc.) executes as additional commands. The
 * `\${ARGUMENTS}` below sits inside `"..."` for that reason. CI should
 * enforce this with a lint check on this file.
 */
function buildRecallSkillTemplate(): string {
	return `---
name: jolli-recall
description: Recall prior development context from Jolli for the current branch
argument-hint: "[branch or keyword]"
user-invocable: true
jolli-skill-version: ${SKILL_VERSION}
---

# Jolli Recall

> Every commit deserves a Memory. Every memory deserves a Recall.

Load the structured development context for a branch — commits with their
distilled topics (trigger / response / decisions / files), plus any plans
and notes that the work referenced. Synthesize a grounded answer to the
user's prompt about that branch.

## Step 1: Parse the argument

The user's input is either a branch name (exact or fragment) or empty (use
the current git branch). Quote it when constructing bash to prevent shell
injection.

## Step 2: Run the CLI

\`\`\`
"$HOME/.jolli/jollimemory/run-cli" recall "\${ARGUMENTS}" --format json
\`\`\`

If \`~/.jolli/jollimemory/run-cli\` does not exist, tell the user:
"Jolli not installed. Please install via \`npm install -g @jolli.ai/cli && jolli enable\` or install the Jolli VS Code extension."
Do not attempt further processing.

## Step 3: Handle the response

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
    \`category?\`, \`importance?\`. \`trigger\` and \`response\` may be dropped by
    budget trimming; \`decisions\` is never dropped from a kept commit (if the
    budget can't fit it, the whole commit is omitted from \`commits[]\`).
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
- \`truncated: true\`: budget enforcement dropped fields or commits. Mention
  it with a one-liner if the user asks for deeper detail; otherwise stay
  silent.

### type: "catalog" — branch lookup needed

Returned when no exact branch match was found. Has a \`branches[]\` array
with \`branch\`, \`commitCount\`, \`period\`, \`commitMessages\`, \`topicTitles?\`.
If a \`query\` field is present, semantic-match the user's input against
\`branch\`, \`commitMessages\`, and \`topicTitles\` (the highest-signal source);
support cross-language matching and time-relative queries.

- One match: re-run \`"$HOME/.jolli/jollimemory/run-cli" recall "<branch>" --format json\`
  and continue from Step 3.
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
 * Search skill template.
 *
 * Two-phase pattern: catalog scan → hash-targeted detail load. The chat LLM
 * does all semantic work (matching the user's query against catalog content);
 * the CLI is purely a deterministic data source.
 *
 * **SECURITY NOTE**: same shell-injection caveat as recall — every `${...}`
 * placeholder must be wrapped in double quotes when interpolated into Bash.
 */
function buildSearchSkillTemplate(): string {
	return `---
name: jolli-search
description: Search structured commit memories across all branches — decisions, topics, files
argument-hint: "<keyword> [--since 2w]"
user-invocable: true
jolli-skill-version: ${SKILL_VERSION}
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

- Need full context of a known branch → \`/jolli-recall <branch>\`.
- Looking at the current code → grep / read files directly.

## Step 1: Parse \${ARGUMENTS} into query + flags

The user can include flags inline, e.g. \`/jolli-search auth --since 2w\`. Before
invoking the CLI, split the argument string into two parts:

1. **Query**: the user's keyword / sentence (everything that is NOT a CLI flag).
   The query may be in any human language and contain natural punctuation
   (\`?\`, \`#\`, \`(\`, etc.).
2. **Flags**: any of \`--since <date>\`, \`--limit <n>\`, \`--budget <tokens>\`,
   \`--output <path>\`. Pass these through verbatim. Ignore any other token starting
   with \`--\`.

Quote ONLY the query when constructing bash; pass flags as separate unquoted
tokens. Examples:

| User input                                  | Bash you should run                                                                                |
|---------------------------------------------|----------------------------------------------------------------------------------------------------|
| \`auth\`                                    | \`"$HOME/.jolli/jollimemory/run-cli" search "auth" --format json\`                                |
| \`auth --since 2w\`                         | \`"$HOME/.jolli/jollimemory/run-cli" search "auth" --since 2w --format json\`                     |
| \`why did we choose X over Y? --since 1m\`  | \`"$HOME/.jolli/jollimemory/run-cli" search "why did we choose X over Y?" --since 1m --format json\` |

Always include \`--format json\`. Never put flags inside the query quotes.

## Step 2: Get the catalog

Run the bash command you constructed in Step 1.

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

Construct the Phase 2 bash with the same query quoting + flag separation rule
from Step 1, plus \`--hashes <fullHash1,fullHash2,fullHash3>\`:

\`\`\`
"$HOME/.jolli/jollimemory/run-cli" search "<the query>" --hashes <fullHash1>,<fullHash2>,<fullHash3> --format json
\`\`\`

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
