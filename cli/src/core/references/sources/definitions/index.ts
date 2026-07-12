/**
 * Registry of built-in `SourceDefinition`s, driven by `SourceEngine`.
 *
 * Order matches the pre-migration adapter registry's list (linear, jira,
 * github, notion) — preserved for continuity with `SourceDefinitionRegistry`
 * consumers that pin this order (e.g. `CLAUDE_TOOL_PREFIXES`). `slack`,
 * `zoom-meeting` and `zoom-doc` are appended after the migrated four.
 *
 * `confluence` is inserted BEFORE `jira` deliberately: both share the
 * `mcp__claude_ai_Atlassian__` tool prefix, jira's `match.claude` is a
 * prefix-only catch-all, and the registry returns the first array match — so
 * confluence's narrower `acceptSuffix` must be checked first or every
 * Confluence tool call would silently resolve to jira.
 */

import { asanaDefinition } from "./asana.js";
import { confluenceDefinition } from "./confluence.js";
import { githubDefinition } from "./github.js";
import { jiraDefinition } from "./jira.js";
import { linearDefinition } from "./linear.js";
import { notionDefinition } from "./notion.js";
import { slackDefinition } from "./slack.js";
import { zoomDocDefinition } from "./zoom-doc.js";
import { zoomMeetingDefinition } from "./zoom-meeting.js";

export const BUILTIN_DEFINITIONS = [
	linearDefinition,
	confluenceDefinition,
	jiraDefinition,
	githubDefinition,
	notionDefinition,
	slackDefinition,
	zoomMeetingDefinition,
	zoomDocDefinition,
	asanaDefinition,
] as const;
