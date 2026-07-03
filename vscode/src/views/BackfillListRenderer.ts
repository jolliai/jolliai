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

const s = (n: number): string => (n === 1 ? "" : "s");

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
  }`;
}
