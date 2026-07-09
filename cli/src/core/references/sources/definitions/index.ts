/**
 * Registry of built-in `SourceDefinition`s, driven by `SourceEngine`.
 *
 * Order matches the pre-migration adapter registry's list (linear, jira,
 * github, notion) — preserved for continuity with `SourceDefinitionRegistry`
 * consumers that pin this order (e.g. `CLAUDE_TOOL_PREFIXES`). `slack`,
 * `zoom-meeting` and `zoom-doc` are appended after the migrated four.
 */

import { githubDefinition } from "./github.js";
import { jiraDefinition } from "./jira.js";
import { linearDefinition } from "./linear.js";
import { notionDefinition } from "./notion.js";
import { slackDefinition } from "./slack.js";
import { zoomDocDefinition } from "./zoom-doc.js";
import { zoomMeetingDefinition } from "./zoom-meeting.js";

export const BUILTIN_DEFINITIONS = [
	linearDefinition,
	jiraDefinition,
	githubDefinition,
	notionDefinition,
	slackDefinition,
	zoomMeetingDefinition,
	zoomDocDefinition,
] as const;
