/**
 * Skill Installer
 *
 * Manages the installation, update, and cleanup of Jolli skill files
 * for Claude Code (.claude/skills/ SKILL.md files).
 *
 * Future extensions:
 * - Additional skills (jolli-search, jolli-digest, etc.)
 * - MCP server registration for Codex CLI, Gemini CLI, Cursor, Windsurf
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
 * Writes or updates the /jolli-recall SKILL.md file.
 * Also removes legacy skill directories from previous versions.
 *
 * Uses a version guard: only writes when the version in frontmatter differs
 * from SKILL_VERSION, or when the file doesn't exist yet.
 */
export async function updateSkillIfNeeded(projectDir: string): Promise<void> {
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

	const skillDir = join(projectDir, ".claude", "skills", "jolli-recall");
	const skillPath = join(skillDir, "SKILL.md");

	// Check existing version (handle both current and legacy version keys)
	try {
		const existing = await readFile(skillPath, "utf-8");
		const versionMatch = existing.match(/(?:jolli-skill-version|jollimemory-version):\s*(.+)/);
		/* v8 ignore start -- version match: SKILL_VERSION is always "dev" in tests */
		if (versionMatch && versionMatch[1].trim() === SKILL_VERSION) {
			return; // Version matches — no update needed
		}
		/* v8 ignore stop */
	} catch {
		// File doesn't exist — will create
	}

	const template = buildRecallSkillTemplate();

	try {
		await mkdir(skillDir, { recursive: true });
		await writeFile(skillPath, template, "utf-8");
		log.info("Wrote SKILL.md (version %s) to %s", SKILL_VERSION, skillPath);
		/* v8 ignore start - defensive: mkdir/writeFile failure on read-only filesystem */
	} catch (error: unknown) {
		log.warn("Failed to write SKILL.md: %s", (error as Error).message);
	}
	/* v8 ignore stop */
}

// ─── Skill Templates ────────────────────────────────────────────────────────

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
"$HOME/.jolli/jollimemory/run-cli" recall \${ARGUMENTS} --budget 30000 --format json
\`\`\`

If the file \`~/.jolli/jollimemory/run-cli\` does not exist, tell the user:
"Jolli not installed. Please install via \`npm install -g @jolli/cli && jolli enable\` or install the Jolli VS Code extension."
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
branch names and commit messages:
- Match across languages: e.g. CJK keywords should match English branch names/messages
- Match by time: e.g. "last week" or date-related queries should match by date range
- One match: load it with Bash: \`"$HOME/.jolli/jollimemory/run-cli" recall "<branch>" --budget 30000 --format json\`, then output the full report above
- Multiple matches: show candidates, ask user to choose
- No matches: show full catalog, ask user to clarify

If no "query" field (user ran without arguments and current branch has no records):
- Show the branch catalog in a friendly format
- Ask which branch they want to recall
`;
}
