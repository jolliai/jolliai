/**
 * WikiRebuildMode — the single polarity check for whether a git operation should
 * auto-trigger a wiki/graph (topic KB) rebuild.
 *
 * Kept as a dependency-free leaf module (only a type import) so the git-hook
 * bundles that gate their `enqueueIngestOperation` calls on it — PostCommit,
 * PostMerge, Backfill — don't drag storage / source-timeline code in.
 *
 * The polarity is deliberately `=== "auto"`: an ABSENT `wikiRebuild` key (every
 * install that predates this change) means MANUAL. Never spell this `!== "manual"`
 * — that would flip undefined to auto and re-enable the very auto-ingest this
 * feature removes.
 */

import type { JolliMemoryConfig } from "../Types.js";

/** True iff wiki/graph rebuild should auto-trigger on git operations. Default (absent key) = manual. */
export function wikiRebuildIsAuto(config: Pick<JolliMemoryConfig, "wikiRebuild">): boolean {
	return config.wikiRebuild === "auto";
}
