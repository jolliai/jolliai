/**
 * TicketId — whitelist validation + canonicalisation for the summary `ticketId`
 * field. Deliberately a dependency-free leaf module: it is consumed at both the
 * ingest boundary (Summarizer.parseTopLevelFields) and the read/display boundary
 * (SummaryFormat.buildPanelTitle, SummaryProjection.buildHit). Keeping it free
 * of imports avoids pulling the heavy Summarizer↔LlmClient graph into those
 * display modules (which would form an import cycle).
 */

/**
 * Whole-string ticket forms accepted as a valid `ticketId`:
 *   - Jira/Linear style `PREFIX-123` (letter-led prefix, ≥2 chars, digit suffix)
 *   - bare issue reference `#123`
 * Anchored on purpose: the failure mode is the LLM emitting an entire non-ticket
 * blob (a 40-char SHA, a date-led plan slug like
 * "2026-07-02-memory-detail-panel", or placeholder prose like "(none
 * referenced)") after `---TICKETID---`. Anchoring rejects those wholesale and
 * avoids mis-extracting a ticket-shaped fragment out of prose.
 */
const TICKET_JIRA_RE = /^[A-Za-z][A-Za-z0-9]+-\d+$/;
const TICKET_HASH_RE = /^#\d+$/;

/**
 * Validates and canonicalizes a candidate `ticketId`. Returns the canonical
 * uppercase form for `PREFIX-123` inputs, the value as-is for `#123`, or
 * `undefined` when the candidate is empty or not a recognisable ticket.
 *
 * This is the single whitelist guarding the `ticketId` field. It runs at two
 * boundaries: ingest (`parseTopLevelFields`, so the LLM can never write a bad
 * value) and read/display (`buildPanelTitle`, `buildHit`, so legacy bad values
 * already persisted are neutralised without rewriting history). The squash
 * selection chain also uses it so a bad per-source value is skipped rather than
 * chosen over a good one.
 */
export function normalizeTicketId(raw?: string): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return undefined;
	}
	if (TICKET_JIRA_RE.test(trimmed)) {
		return trimmed.toUpperCase();
	}
	if (TICKET_HASH_RE.test(trimmed)) {
		return trimmed;
	}
	return undefined;
}
