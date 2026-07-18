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

interface CodexUserLine {
	payload?: { type?: unknown; role?: unknown; content?: unknown; message?: unknown };
}

/**
 * Codex counterpart of {@link scanUserPermalinks}. A Codex rollout carries the
 * user's pasted permalink in one of two `payload`-nested shapes (both observed
 * in a real 2026-07-18 rollout):
 *   - a `message` response_item (`role:"user"`) whose content blocks are
 *     `{type:"input_text", text}` — NOT Claude's `text`; and
 *   - a `user_message` event whose `message` is a bare string.
 * Both are scanned; the `<channel>:<parentTs>` key dedupes the same thread that
 * appears in both line types. Non-user lines (including the tool result blob,
 * which never contains the permalink) are ignored so no thread is double-sourced.
 */
export function scanCodexUserPermalinks(lines: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of lines) {
		if (!line.includes(".slack.com/archives/")) continue;
		let parsed: CodexUserLine;
		try {
			parsed = JSON.parse(line) as CodexUserLine;
		} catch {
			continue;
		}
		const p = parsed.payload;
		if (p === undefined || p === null) continue;
		const texts: string[] = [];
		if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
			for (const block of p.content) {
				if (typeof block !== "object" || block === null) continue;
				const b = block as { type?: unknown; text?: unknown };
				if (b.type === "input_text" && typeof b.text === "string") texts.push(b.text);
			}
		} else if (p.type === "user_message" && typeof p.message === "string") {
			texts.push(p.message);
		}
		for (const text of texts) {
			const link = parseSlackPermalink(text);
			if (link !== null) out.set(`${link.channel}:${link.parentTs}`, link.url);
		}
	}
	return out;
}
