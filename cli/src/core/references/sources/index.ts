/**
 * Source adapter registry.
 *
 * `ALL_ADAPTERS` is the canonical list driven by the shared extractor in
 * `cli/src/core/references/ReferenceExtractor.ts`. Adding a new source =
 * implementing a `SourceAdapter` and appending it here.
 *
 * `getAdaptersForSource(source)` returns the adapter set applicable to a
 * transcript source. It deliberately carries NO matcher: which adapter matches a
 * given tool call is decided in the producer bindings (`bindings/claude` via the
 * tool-name prefix, `bindings/codex` via namespace+name), which resolve a
 * `SourceId` the envelope parser maps to an adapter via `adapters.find(a => a.id
 * === id)`. Adapters are source-agnostic, so today both "claude" and "codex" get
 * the same instances.
 */

import type { TranscriptSource } from "../../../Types.js";
import { GitHubAdapter } from "./GitHubAdapter.js";
import { JiraAdapter } from "./JiraAdapter.js";
import { LinearAdapter } from "./LinearAdapter.js";
import { NotionAdapter } from "./NotionAdapter.js";
import type { SourceAdapter } from "./SourceAdapter.js";

export const ALL_ADAPTERS: ReadonlyArray<SourceAdapter> = [LinearAdapter, JiraAdapter, GitHubAdapter, NotionAdapter];

/**
 * Adapters applicable to a transcript source. Same instances for every source
 * today — adapters don't vary by agent; only the envelope (in the parser) does.
 */
export function getAdaptersForSource(_source: TranscriptSource): ReadonlyArray<SourceAdapter> {
	return ALL_ADAPTERS;
}
