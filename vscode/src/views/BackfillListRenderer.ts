/**
 * BackfillListRenderer
 *
 * Single source of truth for the human-readable row labels in the back-fill
 * candidate / result lists, shared by BOTH webview script builders (the sidebar
 * cold-start card and the Settings panel) so the wording never diverges.
 *
 * The functions here return **JavaScript source strings** that define row-label
 * helpers inside a webview's inlined `<script>` (these builders emit JS as
 * strings; there is no runtime module import in the webview). The same wording
 * is also exposed as real TS functions ({@link formatBackfillMeta} /
 * {@link formatBackfillResult}) so unit tests can assert on it directly without
 * evaluating the emitted script.
 *
 * Wording (confirmed with product): the preview shows how much real conversation
 * backs each commit — "N session(s) · M turn(s)" — NOT confidence/attribution
 * jargon. `turns` is `conversationTurns` (user-initiated, human-role entries),
 * never `transcriptEntries` (which counts AI/tool lines and reads inflated). A
 * commit with no attributed conversation shows "Code change only".
 */

import { COLD_START_CAP, COLD_START_WINDOW_MS } from "../../../cli/src/backfill/ColdStart.js";

const s = (n: number): string => (n === 1 ? "" : "s");

/**
 * Cold-start scope constants now live in the CLI (`cli/src/backfill/ColdStart.ts`)
 * so the guided front door and this VS Code renderer share one source of truth.
 * Re-exported here so existing VS Code importers (Extension.ts, SidebarScriptBuilder)
 * keep resolving them from this module.
 */
export { COLD_START_CAP, COLD_START_WINDOW_MS };

/** Candidate-row meta: "3 sessions · 12 turns", or "Code change only" when diff-only. */
export function formatBackfillMeta(sessions: number, conversationTurns: number): string {
	if (sessions <= 0) return "Code change only";
	return `${sessions} session${s(sessions)} · ${conversationTurns} turn${s(conversationTurns)}`;
}

/** Result-row meta: "3 sessions · 5 topics", or "5 topics" when diff-only. */
export function formatBackfillResult(sessions: number, topics: number): string {
	if (sessions <= 0) return `${topics} topic${s(topics)}`;
	return `${sessions} session${s(sessions)} · ${topics} topic${s(topics)}`;
}

/**
 * The cold-start card's ✓ note, by variant:
 *   - "empty": repo has zero memories.
 *   - "gaps":  repo has memories but `recentMissingCount` own commits (from the
 *              last month, capped at `cap`) lack one.
 * The copy states the scope explicitly ("last month", "up to `cap`") so a user
 * with a large local backlog understands why only some commits are offered — the
 * rest are reached via the list's "manage all in Settings" link. Verb-free noun
 * phrasing sidesteps singular/plural verb agreement across N. `n >= cap` means
 * the list was capped (there may be more). `cap` is {@link COLD_START_CAP} at the
 * call site, so wording + list cap can never drift.
 */
export function formatColdStartNote(variant: "empty" | "gaps", recentMissingCount: number, cap: number): string {
	if (variant === "gaps") {
		const n = recentMissingCount;
		if (n >= cap) {
			// Capped: the newest `cap` are offered; more (older or beyond the cap) → Settings.
			// `cap` is always > 1 in production, so plural is fine (no singular special-case).
			return `You are set up. The ${cap} most recent commits from the last month without a memory yet — build now, or manage all in Settings (new commits capture automatically).`;
		}
		return `You are set up. ${n} recent commit${s(n)} from the last month (up to ${cap}) without a memory yet — build now, or keep coding (new commits capture automatically).`;
	}
	return "You are set up — this repo has no memories yet. Build them from your recent commits, or just keep coding and they capture automatically.";
}

/**
 * Emits the JS source that defines `formatBackfillMeta` / `formatBackfillResult`
 * inside a webview script scope, mirroring the TS functions above 1:1. Embed the
 * returned string once inside `buildSidebarScript()` / the Settings script.
 */
export function backfillListRendererSource(): string {
	return `
  function __bfPlural(n) { return n === 1 ? '' : 's'; }
  function formatBackfillMeta(sessions, conversationTurns) {
    if (sessions <= 0) return 'Code change only';
    return sessions + ' session' + __bfPlural(sessions) + ' · ' + conversationTurns + ' turn' + __bfPlural(conversationTurns);
  }
  function formatBackfillResult(sessions, topics) {
    if (sessions <= 0) return topics + ' topic' + __bfPlural(topics);
    return sessions + ' session' + __bfPlural(sessions) + ' · ' + topics + ' topic' + __bfPlural(topics);
  }
  function formatColdStartNote(variant, recentMissingCount, cap) {
    if (variant === 'gaps') {
      var n = recentMissingCount;
      if (n >= cap) {
        return 'You are set up. The ' + cap + ' most recent commits from the last month without a memory yet — build now, or manage all in Settings (new commits capture automatically).';
      }
      return 'You are set up. ' + n + ' recent commit' + __bfPlural(n) + ' from the last month (up to ' + cap + ') without a memory yet — build now, or keep coding (new commits capture automatically).';
    }
    return 'You are set up — this repo has no memories yet. Build them from your recent commits, or just keep coding and they capture automatically.';
  }`;
}
