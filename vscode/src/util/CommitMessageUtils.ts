/**
 * Shared utilities for merging commit messages.
 *
 * Used by both Amend (merge HEAD message + new AI message) and
 * Squash (merge N commit messages into one).
 */

/** Ticket pattern: matches Jira-style ticket IDs like "PROJ-123", "FEAT-42" (case-insensitive) */
const TICKET_PATTERN = /[A-Z]+-\d+/i;

/**
 * Finds the longest common prefix across all messages, truncated to the
 * last structural delimiter (": " or ". ") so we only strip meaningful
 * prefixes like "Part of PROJ-123: " rather than coincidental word matches.
 */
function findStructuralPrefix(messages: ReadonlyArray<string>): string {
	const first = messages[0];
	let commonLen = first.length;
	for (let i = 1; i < messages.length; i++) {
		commonLen = Math.min(commonLen, messages[i].length);
		for (let j = 0; j < commonLen; j++) {
			if (first[j] !== messages[i][j]) {
				commonLen = j;
				break;
			}
		}
	}

	const raw = first.substring(0, commonLen);
	const delimIdx = Math.max(raw.lastIndexOf(": "), raw.lastIndexOf(". "));
	if (delimIdx < 0) {
		return "";
	}
	return first.substring(0, delimIdx + 2);
}

/**
 * Extracts a ticket-based prefix from a message.
 * Returns the prefix up to and including the delimiter after the ticket number,
 * or null if no ticket pattern is found.
 *
 * @example
 *   extractTicketPrefix("Part of PROJ-123: Fix hook") → "Part of PROJ-123: "
 *   extractTicketPrefix("Closes PROJ-123. Add tests") → "Closes PROJ-123. "
 *   extractTicketPrefix("Fix typo in README") → null
 */
function extractTicketPrefix(message: string): string | null {
	const match = TICKET_PATTERN.exec(message);
	if (!match) {
		return null;
	}

	const afterTicket = match.index + match[0].length;
	// Look for ": " or ". " immediately after the ticket number
	const rest = message.substring(afterTicket);
	if (rest.startsWith(": ") || rest.startsWith(". ")) {
		return message.substring(0, afterTicket + 2);
	}
	return null;
}

/**
 * Merges multiple commit messages into one by stripping their common prefix.
 *
 * 1. Find the longest common structural prefix (ending with ": " or ". ").
 * 2. If no common prefix found, try ticket-based dedup: when all messages
 *    reference the same ticket (e.g. "PROJ-123"), strip each ticket prefix
 *    and keep the first message's prefix.
 * 3. Keep the prefix once; strip it from each message to get descriptions.
 * 4. Join descriptions with "; ".
 *
 * @example
 *   // Same prefix (common case)
 *   mergeCommitMessages(["Part of PROJ-123: Fix hook", "Part of PROJ-123: Add tests"])
 *   // → "Part of PROJ-123: Fix hook; Add tests"
 *
 *   // Different verbs, same ticket (squash with mixed prefixes)
 *   mergeCommitMessages(["Closes PROJ-123: Fix hook", "Part of PROJ-123: Add tests"])
 *   // → "Closes PROJ-123: Fix hook; Add tests"
 *
 *   // No common prefix or ticket
 *   mergeCommitMessages(["Fix typo in README", "Add dark mode toggle"])
 *   // → "Fix typo in README; Add dark mode toggle"
 */
export function mergeCommitMessages(messages: ReadonlyArray<string>): string {
	if (messages.length === 0) {
		return "";
	}
	if (messages.length === 1) {
		return messages[0];
	}

	// Strategy 1: exact common structural prefix
	const commonPrefix = findStructuralPrefix(messages);
	if (commonPrefix) {
		const descriptions = messages.map((m) =>
			m.substring(commonPrefix.length).trim(),
		);
		return `${commonPrefix.trimEnd()} ${descriptions.join("; ")}`;
	}

	// Strategy 2: same ticket number but different verbs — deduplicate
	const ticketPrefixes = messages.map(extractTicketPrefix);
	if (ticketPrefixes.every(Boolean)) {
		// Extract just the ticket numbers to check they're the same
		const tickets = ticketPrefixes.map((p) =>
			TICKET_PATTERN.exec(p as string)?.[0]?.toUpperCase(),
		);
		const allSameTicket = tickets.every((t) => t === tickets[0]);
		if (allSameTicket) {
			// Use first message's prefix, strip each message's ticket prefix
			const firstPrefix = ticketPrefixes[0] as string;
			const descriptions = messages.map((m, i) =>
				m.substring((ticketPrefixes[i] as string).length).trim(),
			);
			return `${firstPrefix.trimEnd()} ${descriptions.join("; ")}`;
		}
	}

	// Strategy 3: no common structure — just join
	return messages.join("; ");
}
