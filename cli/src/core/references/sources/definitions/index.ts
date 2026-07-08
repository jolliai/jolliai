/**
 * Registry of built-in `SourceDefinition`s, driven by `SourceEngine`.
 *
 * Order matches the pre-migration adapter registry's list (linear, jira,
 * github, notion) — preserved here even though nothing currently depends on
 * definition order, for continuity with `SourceDefinitionRegistry` consumers
 * that pin this order (e.g. `CLAUDE_TOOL_PREFIXES`).
 */

import { githubDefinition } from "./github.js";
import { jiraDefinition } from "./jira.js";
import { linearDefinition } from "./linear.js";
import { notionDefinition } from "./notion.js";

export const BUILTIN_DEFINITIONS = [linearDefinition, jiraDefinition, githubDefinition, notionDefinition] as const;
