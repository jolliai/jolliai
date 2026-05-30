/**
 * Source adapter registry.
 *
 * `ALL_ADAPTERS` is the canonical list driven by the extractor main loop in
 * `cli/src/core/references/ReferenceExtractor.ts` (`extractReferencesFromTranscript`).
 * Adding a new source = implementing a `SourceAdapter` and appending it here.
 * Order is irrelevant for correctness — each adapter has a unique `mcpPrefix`
 * + `id` and dispatch is keyed off the recorded prefix at extraction time.
 */

import { GitHubAdapter } from "./GitHubAdapter.js";
import { JiraAdapter } from "./JiraAdapter.js";
import { LinearAdapter } from "./LinearAdapter.js";
import { NotionAdapter } from "./NotionAdapter.js";
import type { SourceAdapter } from "./SourceAdapter.js";

export const ALL_ADAPTERS: ReadonlyArray<SourceAdapter> = [LinearAdapter, JiraAdapter, GitHubAdapter, NotionAdapter];
