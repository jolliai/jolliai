/**
 * Prompt Templates -- Single Source of Truth
 *
 * All LLM prompt templates used by Jolli Memory live here as {{placeholder}}
 * strings. Both direct mode (Anthropic SDK) and proxy mode (Jolli backend)
 * consume these templates via the same fillTemplate() function.
 *
 * All text is pure ASCII to avoid encoding issues on Windows consoles.
 *
 * The manager's V1_0Defaults.ts re-exports TEMPLATES for DB seeding.
 * The backend's LlmProxyRouter reads templates from the DB at runtime.
 */

// -- Template engine ----------------------------------------------------------

/**
 * Replaces all `{{key}}` placeholders in the template with corresponding
 * values from the params object. Whitespace around the key name is trimmed
 * (e.g. `{{ key }}` works the same as `{{key}}`).
 *
 * Unrecognised placeholders (no matching key in params) are left as-is
 * so that missing substitutions are visible in the output rather than
 * silently producing empty strings.
 */
export function fillTemplate(template: string, params: Readonly<Record<string, string>>): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
		return key in params ? params[key] : match;
	});
}

/**
 * Returns all placeholder keys in the template that were not supplied in params.
 * Used to emit a warning when the caller's params don't fully cover the template.
 */
export function findUnfilledPlaceholders(
	template: string,
	params: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
	const missing = new Set<string>();
	for (const match of template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
		const key = match[1];
		if (!(key in params)) {
			missing.add(key);
		}
	}
	return [...missing];
}

// -- Summarize template builder -----------------------------------------------

/** Builds the summarize template with workSize-specific topic count rules. */
function buildSummarizeTemplate(topicCountRule: string, singlePurposeRule: string): string {
	return `You are Jolli Memory, an AI development process documentation tool. Your job is to analyze a development session (human-AI conversation + code changes) and produce a structured summary.

## Input

### Commit Information
- Hash: {{commitHash}}
- Message: {{commitMessage}}
- Author: {{commitAuthor}}
- Date: {{commitDate}}

### Development Session Transcript (conversation context)
{{conversation}}

### Code Changes (git diff -- for verification)
\`\`\`diff
{{diff}}
\`\`\`

## Instructions

Identify the distinct problems or tasks worked on during this session. Each independent user goal should be its own topic. Order topics by conversation timeline (most recent first, like git log). When multiple topics start at roughly the same point in the conversation, order them by importance (most significant first).

Return your response using the following delimited plain-text format. Each topic starts with ===TOPIC=== on its own line, and each field starts with ---FIELDNAME--- on its own line. Multi-line content is allowed naturally between field delimiters. Do NOT use JSON.

Before the first topic, output the ticket identifier if one exists:

---TICKETID---
PROJ-123

===TOPIC===
---TITLE---
8-15 word concrete and searchable label for this topic
---TRIGGER---
1-2 sentences: the problem, bug, or need that prompted this work. Write from the user's perspective in plain language -- no code identifiers.
---RESPONSE---
What was implemented or fixed -- this is a detail field, so technical precision is welcome. Name files, functions, and systems changed. Use a bulleted list (- item) whenever there are 2+ distinct points. A single sentence is fine for trivial changes. Never exceed 6 points or 150 words.
---DECISIONS---
Why THIS approach was chosen over alternatives. ALWAYS use a bulleted list (- **Bold label**: explanation) when there are 2+ decisions -- each bullet is one decision with a concise rationale. Prioritize insights from the conversation: alternatives considered, constraints, trade-offs. Explain in plain language using impact dimensions (speed, safety, complexity, UX, maintainability) -- no code identifiers. Write so a teammate unfamiliar with this codebase area can follow. Keep each bullet to 1-2 sentences. Never exceed 5 bullets or 120 words total.
---TODO---
Tech debt, deferred work, or follow-up items. Omit this field entirely when there is nothing to follow up on -- do NOT write "None", "N/A", or any placeholder.
---FILESAFFECTED---
src/Auth.ts, src/Middleware.ts
---CATEGORY---
feature
---IMPORTANCE---
major

## Rules
1. The summary has two audiences. The **narrative fields** (title, trigger, decisions) are read by everyone -- write them for a developer who was NOT present in the session. Use plain language: no file paths, no function/class/variable names, no code snippets, no CLI flags. The **detail fields** (response, todo, filesAffected) are collapsed by default and read on-demand -- they MAY use technical identifiers (file names, function names, specific APIs) to describe implementation precisely.
2. decisions is the most valuable field -- it captures reasoning that cannot be reconstructed from the diff alone. ALWAYS use a bulleted list (- **Label**: rationale) when there are 2+ decisions. Express each in terms of IMPACT and TRADE-OFFS, not code architecture. Keep each bullet to 1-2 sentences. A single prose sentence is acceptable only when there is exactly one decision. Never exceed 5 bullets or 120 words.
3. trigger should remain concise (1-2 sentences); it is context, not the primary record.
4. response is a detail field -- be specific and technical. Name the files, functions, or systems changed. ALWAYS use a bulleted list (- item) when there are 2 or more distinct points. A single sentence is acceptable only for trivial single-point changes. Never exceed 6 points or 150 words.
5. title must use plain language (no code identifiers) while remaining concrete and searchable.
${topicCountRule}
${singlePurposeRule}
8. If the conversation is empty or uninformative, infer topics from the diff and commit message. Conversely, when the conversation IS rich, lean heavily on it for trigger and decisions -- the diff should only confirm what was implemented, not drive the narrative.
9. todo: only include when deferred work was EXPLICITLY discussed in the conversation or commit message. "Verify that..." or "Ensure that..." is NOT a valid todo -- those are testing steps, not deferred work. If there is nothing to follow up on, omit the ---TODO--- field entirely -- never write "None", "N/A", or similar.
10. The conversation transcript is the PRIMARY source -- it contains reasoning, trade-offs, and context that cannot be reconstructed later. The diff is the SECONDARY source -- use it to verify what was actually implemented, to fill gaps when the conversation is sparse, and to write the response field accurately. Do not speculate beyond what these sources contain.
11. When the conversation IS rich, extract these high-value elements for trigger and decisions: the user's original problem statement, alternatives that were discussed and discarded, moments where the approach changed direction, explicit rationale given for a choice, and any concerns or risks mentioned. These are the unique value of Jolli Memory -- the diff alone cannot provide them.
12. Return ONLY the delimited text using ===TOPIC=== and ---FIELDNAME--- markers. No JSON, no markdown fences, no other wrapping.
13. filesAffected: list the 2-6 most important files changed in this topic as comma-separated paths (relative to repo root). Focus on business logic and entry points. Exclude test files (*.test.ts, *.spec.ts, *.test.tsx, etc.), boilerplate (lockfiles, config snapshots), and generated files. If the topic touches only 1 non-test file, list just that file.
14. category: pick exactly one from the following: feature, bugfix, refactor, tech-debt, performance, security, test, docs, ux, devops.
15. importance: "major" for topics that add features, fix user-facing bugs, make architectural decisions, or change system behavior. "minor" for routine cleanup, formatting, config tweaks, version bumps, or documentation-only changes.
16. If a change has no meaningful decision behind it (e.g. version bumps, config tweaks, formatting), do NOT create a topic for it -- omit it entirely. Every topic MUST have a substantive decisions field. Never write "No design decisions recorded" or similar placeholders. If rule 16 causes ALL topics to be omitted (the entire commit has no substantive decisions), output exactly:
===NO_TOPICS===
You MAY include a ---TICKETID--- field before ===NO_TOPICS=== if a ticket ID exists. Do NOT write any prose explanation.
17. ticketId: extract the project ticket or issue identifier from the commit message, branch name, or conversation (e.g. "PROJ-123", "FEAT-456", "#789"). Output the canonical uppercase form (e.g. "proj-123" -> "PROJ-123"). If no ticket is referenced anywhere, omit the ---TICKETID--- field entirely.
18. NEVER use the literal strings ===TOPIC=== or ---FIELDNAME--- (e.g. ---TITLE---, ---RESPONSE---) inside your content. If you need to reference delimiters or field markers, describe them in words (e.g. "topic separator marker" or "field delimiter tags") or use a different notation.`;
}

// -- Individual templates -----------------------------------------------------

const SUMMARIZE_SMALL = buildSummarizeTemplate(
	"6. Focused, lightweight change. Return 1-3 topics. Consolidate closely related sub-tasks.",
	"7. If the entire commit clearly addresses one purpose, a single topic is preferred.",
);

const SUMMARIZE_MEDIUM = buildSummarizeTemplate(
	"6. Moderate work. Return 2-6 topics. Each topic should represent a distinct user goal.",
	"7. Do not over-split minor sub-tasks that belong to the same goal; merge them into one topic.",
);

const SUMMARIZE_LARGE = buildSummarizeTemplate(
	"6. Substantial, wide-ranging work. Return 2-12 topics, splitting distinct goals into separate entries.",
	"7. Do not over-split minor sub-tasks that belong to the same goal; merge them into one topic.",
);

const COMMIT_MESSAGE = `You are Jolli Memory, an AI development assistant. Generate a concise git commit message for the staged changes below.

## Branch Name
{{branch}}

## Staged Files
{{fileList}}

## Staged Diff
\`\`\`diff
{{stagedDiff}}
\`\`\`

## Instructions

Write a single-line commit message (50-72 characters) that clearly describes WHAT was changed, based on the diff.

Rules:
1. Return ONLY the commit message -- no explanation, no quotes, no markdown.
2. Use imperative mood ("Add", "Fix", "Refactor", not "Added" or "Fixing").
3. Be specific: name the key component or file changed rather than speaking in abstractions.
4. Do NOT include multi-line bodies -- just the single subject line.
5. Ticket prefix: examine the branch name above. If it contains a recognizable ticket pattern (e.g. "proj-123", "FEAT-456", or a bare number like "fix/42-login"), extract the ticket identifier, uppercase the project prefix, and prefix the commit message with "Part of <TICKET>: ". Examples: branch "feature/proj-123-foo" -> "Part of PROJ-123: ...", branch "fix/FEAT-42-bar" -> "Part of FEAT-42: ...". If no ticket number is found in the branch name, do not add any prefix.`;

const SQUASH_MESSAGE = `You are Jolli Memory, an AI development assistant. Generate a concise git commit message that summarizes the following commits being squashed into one.

## Ticket
{{ticketLine}}

## Commits Being Squashed
{{commitsBlock}}

## Squash Scope
{{scopeLine}}

## Instructions

Write a single-line commit message (50-72 characters) that summarizes the combined work.

Rules:
1. Return ONLY the commit message -- no explanation, no quotes, no markdown.
2. Use imperative mood ("Add", "Fix", "Refactor").
3. Summarize the overall intent using the topic titles and triggers as context. Focus on WHAT was achieved and WHY.
4. Do NOT list individual changes -- synthesize into one clear description.
5. Ticket prefix:
   - Full squash: prefix with "Closes <TICKET>: " (or "Fixes" if the commits are bug fixes).
   - Partial squash: prefix with "Part of <TICKET>: ".
   - No ticket: no prefix.
6. Do NOT include multi-line bodies -- just the single subject line.`;

const E2E_TEST = `You are Jolli Memory, an AI development process documentation tool. Your task is to generate step-by-step E2E testing instructions for PR reviewers who need to manually verify this commit's changes.

## Commit Message
{{commitMessage}}

## Summary of Changes
{{topicsSummary}}

## Code Diff
\`\`\`diff
{{diff}}
\`\`\`

## Instructions

Generate one test scenario for each user-facing feature or bug fix. Skip topics that are purely internal refactoring, documentation, devops, or config changes -- only generate scenarios for changes a user or reviewer can visually verify in the application.

Return your response using the following delimited plain-text format. Each scenario starts with ===SCENARIO=== on its own line, and each field starts with ---FIELDNAME--- on its own line.

===SCENARIO===
---TITLE---
Short label for this test scenario (e.g. "Article reordering" or "Login timeout fix")
---PRECONDITIONS---
What the reviewer needs to have ready before testing (e.g. "Have a Space with 3+ articles"). Omit this field entirely if no special setup is needed.
---STEPS---
1. Open the app and navigate to...
2. Click on...
3. Type "..." in the search box
4. Verify that...
---EXPECTED---
- The page should display...
- The confirmation message should appear
- The item should move to the new position

## Rules
1. Write for a NON-TECHNICAL person -- no code, no file paths, no API names, no developer jargon.
2. Use everyday verbs: "open", "click", "type", "check", "scroll", "wait", "refresh".
3. Steps must be SPECIFIC and ACTIONABLE -- not "test the feature" but "type 'hello' in the search box and press Enter".
4. Expected results must be VERIFIABLE -- not "should work correctly" but "the page should display 3 search results".
5. Include boundary cases when relevant (e.g. "repeat with an empty list to verify the empty state message").
6. Each feature or bug fix gets its own ===SCENARIO=== block. Do NOT merge unrelated features into one scenario.
7. If a topic is minor refactoring, docs-only, devops, or has no user-visible impact, skip it entirely -- do not generate a scenario.
8. Return ONLY the delimited text. No JSON, no markdown fences, no other wrapping.
9. NEVER use the literal strings ===SCENARIO=== or ---FIELDNAME--- inside your content.
10. The preconditions field is OPTIONAL -- omit ---PRECONDITIONS--- entirely when no special setup is needed.
11. Keep each scenario to 6 steps or fewer. If a flow requires more, split it into two scenarios or combine minor sub-steps.
12. Generate at most {{maxScenarios}} scenarios total. Focus on the most important user-facing changes. If there are more features than the limit, prioritize major features and user-visible bug fixes over minor improvements.`;

const PLAN_PROGRESS = `You are JolliMemory, an AI development process documentation tool. Your task is to evaluate how much progress a developer made on a plan during a single coding session, based on the code diff, conversation summary topics, and the raw conversation transcript.

## Plan (Markdown)
{{planContent}}

## Code Changes (git diff)
\`\`\`diff
{{diff}}
\`\`\`

## Conversation Summary Topics
{{topics}}

## Conversation Transcript
{{conversation}}

## Instructions

Analyze the plan above and determine which steps moved forward in this session. You MUST:

1. Produce a brief "summary" (1-2 sentences) of what the developer was working on overall in this session.
2. For EVERY step in the plan, determine its status based on the diff:
   - "completed" -- the diff fully implements this step
   - "in_progress" -- the diff partially addresses this step
   - "not_started" -- no evidence of progress on this step in the diff
3. For steps that are "completed" or "in_progress", write a rationale-rich note:
   - Cite specific decisions and trade-offs from the conversation topics (not just file names)
   - Reference what triggered the work and any alternatives considered
   - Scan the conversation transcript for human-flagged signals: things to revisit, questions to ask someone, concerns raised, deferred ideas -- and surface them in the relevant step note
4. For steps that are "not_started", set note to null.

## Output Format

Return a single JSON object (no markdown fences, no explanation):

{
  "summary": "1-2 sentence summary of what the developer worked on",
  "steps": [
    { "id": "1", "description": "Step description from plan", "status": "completed", "note": "Rationale..." },
    { "id": "2", "description": "Step description from plan", "status": "not_started", "note": null }
  ]
}

## Rules
1. Discover step IDs and descriptions directly from the plan markdown. Steps may be numbered (1, 2, 3), lettered (a, b, c), use headings (## Step 1), or checkboxes (- [ ]). Assign IDs in the order they appear.
2. The diff is the PRIMARY evidence for status -- do not mark a step as "completed" unless the code changes clearly implement it.
3. The topics and transcript provide CONTEXT for notes -- cite decisions, trade-offs, and reasoning that cannot be reconstructed from code alone.
4. Keep notes concise (1-3 sentences each). Focus on the "why" and any flagged signals, not on restating what the code does.
5. Return ONLY the JSON object. No surrounding text, no markdown fences.`;

const TRANSLATE = `Translate the following Markdown document into English.

Rules:
- Preserve ALL Markdown formatting exactly (headings, lists, code blocks, tables, links, bold/italic).
- Do NOT translate content inside code blocks (\`\`\` ... \`\`\` or inline \`...\`).
- Keep technical terms, file paths, function names, and variable names unchanged.
- Do NOT add, remove, or reorder any content -- only translate natural-language text.
- Output ONLY the translated Markdown, with no wrapping or commentary.

---

{{content}}`;

// -- Exported map -------------------------------------------------------------

/**
 * All prompt templates keyed by action name.
 *
 * Used by:
 * - LlmClient (direct mode): resolves template + fillTemplate before calling Anthropic SDK
 * - Manager V1_0Defaults: re-exports for DB seeding
 * - CLI export-prompt: prints templates to stdout
 */
export const TEMPLATES: ReadonlyMap<string, string> = new Map<string, string>([
	["summarize:small", SUMMARIZE_SMALL],
	["summarize:medium", SUMMARIZE_MEDIUM],
	["summarize:large", SUMMARIZE_LARGE],
	["commit-message", COMMIT_MESSAGE],
	["squash-message", SQUASH_MESSAGE],
	["e2e-test", E2E_TEST],
	["plan-progress", PLAN_PROGRESS],
	["translate", TRANSLATE],
]);
