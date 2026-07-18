/**
 * Codex producer normalizer registry — resolves a `SourceId` (already matched by
 * the `SourceDefinitionRegistry`) to its {@link CodexNormalizer}. Match identity
 * (`namespaceSuffix`/`functionCallNames`/`invocationTools`) lives in
 * `SourceDefinition.match.codex` and is resolved by `registry.match()` before
 * either lookup here ever runs — see {@link getCodexNormalizer}, called with
 * `def.id` from `CodexEnvelopeParser` to look up a binding's
 * normalize/recover/canonicalToolName. Adding a source = one entry here plus its
 * binding file (+ its `def.match.codex` in the source definition).
 */

import type { SourceId } from "../../../../Types.js";
import { asanaCodexBinding } from "./CodexAsanaBinding.js";
import type { CodexNormalizer } from "./CodexBinding.js";
import { confluenceCodexBinding } from "./CodexConfluenceBinding.js";
import { githubCodexBinding } from "./CodexGitHubBinding.js";
import { jiraCodexBinding } from "./CodexJiraBinding.js";
import { linearCodexBinding } from "./CodexLinearBinding.js";
import { mondayCodexBinding } from "./CodexMondayBinding.js";
import { notionCodexBinding } from "./CodexNotionBinding.js";
import { slackCodexBinding } from "./CodexSlackBinding.js";
import { zoomMeetingCodexBinding } from "./CodexZoomMeetingBinding.js";

/** `mcp__codex_apps__` — the shared connector namespace prefix for all sources. */
export const CODEX_APPS_NAMESPACE_PREFIX = "mcp__codex_apps__";

const CODEX_NORMALIZERS: readonly CodexNormalizer[] = [
	linearCodexBinding,
	notionCodexBinding,
	githubCodexBinding,
	jiraCodexBinding,
	zoomMeetingCodexBinding,
	confluenceCodexBinding,
	asanaCodexBinding,
	mondayCodexBinding,
	slackCodexBinding,
];

const BY_ID: ReadonlyMap<SourceId, CodexNormalizer> = new Map(CODEX_NORMALIZERS.map((n) => [n.id, n]));

/**
 * Looks up a Codex source's normalize/recover/canonicalToolName by `SourceId`,
 * once the `SourceDefinitionRegistry` has already resolved the def. Called with
 * `def.id` after `registry.match()`.
 */
export function getCodexNormalizer(id: string): CodexNormalizer | undefined {
	return BY_ID.get(id as SourceId);
}

export type { CodexNormalizer } from "./CodexBinding.js";
