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

## Step 1: Load Context

Run this Bash command to load Jolli context data:

\`\`\`
"$HOME/.jolli/jollimemory/run-cli" recall "\${ARGUMENTS}" --budget 30000 --format json
\`\`\`

If the file \`~/.jolli/jollimemory/run-cli\` does not exist, tell the user:
"Jolli not installed. Please install via \`npm install -g @jolli.ai/cli && jolli enable\` or install the Jolli VS Code extension."
Do not attempt further processing.

## Step 2: Process the Result

The command output is JSON with a "type" field. Handle each case:

### type: "recall" — Full context loaded successfully
Generate the loading report:

**Part 1: Loading Confirmation & Statistics**
- Time span, commit count, file change statistics
- Total context size (tokens) and percentage of context window used
- Breakdown by content type: N topics (~X tokens), N plans (~Y tokens), N decisions (~Z tokens)

**Part 2: Understanding Summary**
In your own words, summarize what you understood:
- What this branch is implementing (one sentence)
- Key technical decisions and why they were made
- What was last worked on
- Main files involved

This section is critical for building user trust — the user needs to see that
you accurately understand the prior work.

**Part 3: Next Steps**
Ask: "What would you like to work on next?"

### type: "catalog" — Branch lookup needed
The CLI returned a catalog because no exact branch match was found.
If a "query" field is present, use semantic matching against the catalog's
branch names, commit messages, and topicTitles (LLM-distilled per-commit titles):
- Match across languages: e.g. CJK keywords should match English branch names/messages
- Match by time: e.g. "last week" or date-related queries should match by date range
- Match topicTitles when present — they carry far more signal than commit messages
- One match: load it with Bash: \`"$HOME/.jolli/jollimemory/run-cli" recall "<branch>" --budget 30000 --format json\`, then output the full report above
- Multiple matches: show candidates, ask user to choose
- No matches: show full catalog, ask user to clarify

If no "query" field (user ran without arguments and current branch has no records):
- Show the branch catalog in a friendly format
- Ask which branch they want to recall
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
from Step 1, plus \`--hashes <h1,h2,h3>\`:

\`\`\`
"$HOME/.jolli/jollimemory/run-cli" search "<the query>" --hashes <h1,h2,h3> --format json
\`\`\`

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
- \`diffStats?\` — \`{ files, insertions, deletions }\`

**Narrative**:
- \`recap?\` — 1-3 paragraphs of plain-English narrative. Highest-quality prose; primary source for "what is X" / "explain X".

**Topics** — \`topics: SearchHitTopic[]\` (★ the meat):

  - \`title\` — one-sentence label
  - \`trigger\` — 1-2 sentences, what prompted the work
  - \`response\` — implementation summary, may include code; longest field
  - \`decisions\` ★ **THE STAR FIELD** — design choices + *why*, as markdown bullets. Primary source for "why did we choose X" / "what alternatives" / "rationale". Not in the diff; only here.
  - \`todo?\` — residual work the LLM flagged (rare)
  - \`filesAffected?\` — per-topic file list. Render as markdown links: \`[cli/src/Types.ts](cli/src/Types.ts)\`.
  - \`category?\` — \`feature\` / \`bugfix\` / \`refactor\` / \`tech-debt\` / \`docs\` / \`test\` / \`devops\` / \`ux\`
  - \`importance?\` — \`major\` / \`minor\`

### B. Universal principles (apply regardless of shape)

Non-negotiable. Encoded from past dogfood failures.

1. **Lead with the answer**, not with search mechanics. Never open with "Found N relevant commits out of M". Coverage chatter belongs only in the empty/partial branches below.

2. **Ground every concrete claim** to a hash and/or file. Use \`(abc1234)\` for hashes and \`[cli/src/Types.ts](cli/src/Types.ts)\` for files. Never wrap file paths in backticks alone — markdown-link form stays readable AND becomes clickable.

3. **Synthesize, don't dump — but DO use short verbatim quotes.** Read everything; fold into coherent prose or bullets. **However**, when a single short sentence or phrase from \`recap\` or \`decisions\` captures the answer concisely, quote it verbatim in **bold** with attribution: e.g. *the design chose JWT because* **"stateless, scales horizontally"** *(decisions, abc1234)*. Bold in this skill means "verbatim from stored data" — it builds user confidence that answers come from real recorded decisions, not LLM paraphrase. Use sparingly (1-3 quotes per answer); never wall-of-fragments.

4. **Skip near-duplicates** from amend / squash chains (same \`commitMessage\`, similar topics). One row per logical change.

5. **Reply in the user's language.** Template is English; user-visible output matches the user.

6. **Don't expose search machinery.** No "Phase 1" / "Phase 2" / "catalog" / "SearchHit JSON" mentions.

7. **No \`[Open in IDE](vscode://...)\` links** — chat webview filters non-http(s) clicks (anthropics/claude-code#26952). Use \`jolli view --commit <hash>\` as the per-commit open action.

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
