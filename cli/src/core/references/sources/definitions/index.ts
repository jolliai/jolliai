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
 *
 * ─── The JVM host may lag this list, but only ON THE RECORD ──────────────────
 *
 * Registering a definition here wires the CLI and (because it bundles `cli/src/**`)
 * VS Code. It does NOT wire IntelliJ: `SourceId` in
 * `intellij/.../core/references/ReferenceTypes.kt` is a closed Kotlin enum, and
 * `SourceIds.parse` answers null for an id it does not list. So until the enum is
 * extended, a row from a newer source renders as a neutral `R` / "Reference" in the
 * uncommitted CONTEXT panel and is dropped outright from a committed memory's list
 * (`CommitsPanel` does `val src = ref.source ?: return@forEach`).
 *
 * Letting the Kotlin ship separately is deliberate policy, not an oversight, and
 * the trade is accepted: `intellij/` is an independent Gradle build that the root
 * `npm run all` does not cover, so bundling two lines of Kotlin into a PR that is
 * otherwise one language and one gate widens both the review surface and the
 * verification story. The Kotlin side may therefore ship in its own follow-up PR,
 * where the `when` in `SourceIds`/`SourceDisplay` is exhaustive and the compiler
 * enforces completeness.
 *
 * What is NOT accepted any more is the gap being invisible. `vercel`, `figma` and
 * `sentry` each sat here as prose for weeks and each was re-reported as a bug by a
 * reviewer, because a comment cannot fail. `SourceLabelsLockstep.test.ts` now holds
 * the two sides together and carries a `KNOWN_JVM_SOURCE_GAPS` list — currently
 * EMPTY, all three having landed — so deferring a source costs one review-visible
 * line instead of a note nobody can act on, and the entry has to be deleted in the
 * PR that closes the gap. Everything the enum DOES declare is held to strict
 * equality on letter, label, hue, wire name and `nativeIdPathSafe`.
 */

import { asanaDefinition } from "./asana.js";
import { confluenceDefinition } from "./confluence.js";
import { context7Definition } from "./context7.js";
import { figmaDefinition } from "./figma.js";
import { githubDefinition } from "./github.js";
import { jiraDefinition } from "./jira.js";
import { jolliMemoryDefinition } from "./jollimemory.js";
import { linearDefinition } from "./linear.js";
import { mondayDefinition } from "./monday.js";
import { notionDefinition } from "./notion.js";
import { sentryDefinition } from "./sentry.js";
import { slackDefinition } from "./slack.js";
import { vercelDefinition } from "./vercel.js";
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
	mondayDefinition,
	context7Definition,
	jolliMemoryDefinition,
	// Appended: both Claude prefixes are unique to it, so it can neither shadow
	// another definition nor be shadowed by one — its position is continuity, not a
	// correctness constraint (unlike confluence-before-jira above).
	vercelDefinition,
	// Appended: both `mcp__Figma__` / `mcp__figma__` prefixes are unique to it, so it
	// can neither shadow another definition nor be shadowed — its position is
	// continuity, not a correctness constraint (unlike confluence-before-jira above).
	figmaDefinition,
	// Appended: both `mcp__Sentry__` / `mcp__sentry__` prefixes are unique to it, so it
	// can neither shadow another definition nor be shadowed — its position is
	// continuity, not a correctness constraint (unlike confluence-before-jira above).
	sentryDefinition,
] as const;
