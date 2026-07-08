/**
 * SlackPermalink — parse a Slack thread permalink and harvest permalinks from a
 * transcript's role:user text blocks. The permalink is the capture anchor for
 * Slack references: it carries the workspace subdomain (absent from every MCP
 * payload) plus the channel + parent ts, so it supplies the authoritative url.
 *
 * We scan ONLY role:user `message.content` text blocks — not "last-prompt"
 * metadata lines and not tool_result content — because the same permalink can
 * appear in several line types, which would otherwise double-count one thread.
 */

/** `.../archives/<channel>/p<16 digits>` — the dotless ts (16 digits: 10-digit seconds + 6-digit microseconds) becomes `<10>.<6>`. */
const PERMALINK_RE = /https:\/\/([a-z0-9][a-z0-9-]*)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{16})/;

export interface SlackPermalink {
	readonly workspace: string;
	readonly channel: string;
	readonly parentTs: string;
	readonly url: string;
}

/** Insert the decimal point 6 digits from the end (Slack ts format). */
function dottedTs(pDigits: string): string {
	return `${pDigits.slice(0, pDigits.length - 6)}.${pDigits.slice(pDigits.length - 6)}`;
}

export function parseSlackPermalink(raw: string): SlackPermalink | null {
	const m = PERMALINK_RE.exec(raw);
	if (m === null) return null;
	return { workspace: m[1], channel: m[2], parentTs: dottedTs(m[3]), url: m[0] };
}

interface UserTextLine {
	message?: { role?: unknown; content?: unknown };
}

/** Map keyed by `<channel>:<parentTs>` → permalink url, from role:user text only. */
export function scanUserPermalinks(lines: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of lines) {
		if (!line.includes(".slack.com/archives/")) continue;
		let parsed: UserTextLine;
		try {
			parsed = JSON.parse(line) as UserTextLine;
		} catch {
			continue;
		}
		const msg = parsed.message;
		if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (typeof block !== "object" || block === null) continue;
			const b = block as { type?: unknown; text?: unknown };
			if (b.type !== "text" || typeof b.text !== "string") continue;
			const link = parseSlackPermalink(b.text);
			if (link !== null) out.set(`${link.channel}:${link.parentTs}`, link.url);
		}
	}
	return out;
}
