/**
 * SlackNormalize — parse the `slack_read_thread` result blob into a canonical
 * object the `slack` SourceDefinition can read with plain `path` ops.
 *
 * The MCP result is human-readable text (`=== THREAD PARENT MESSAGE ===`,
 * `Message TS: …`, `--- Reply N of M ---`), NOT structured JSON, and carries
 * neither a url nor the channel id. The url (from the pasted permalink) and the
 * channel id (from the tool_use input) are threaded in via `ctx`.
 *
 * Defensive by contract: any shape we can't parse returns null (the caller
 * voids the reference), never throws — the blob format is defined by the MCP
 * wrapper's presentation layer, not a stable API, so it may drift.
 */

export interface SlackCanonical {
	readonly channelId: string;
	readonly parentTs: string;
	readonly title: string;
	readonly text: string;
	readonly replyCount: number;
	readonly url?: string;
}

const PARENT_TS_RE = /Message TS:\s*(\d{7,}\.\d+)/;
const REPLY_MARKER = "=== THREAD REPLIES";
const REPLY_COUNT_RE = /=== THREAD REPLIES \((\d+) total\) ===/;
/**
 * First non-empty line after the parent's `Message TS:` line → title. Applied
 * ONLY to the parent segment (everything before the first `=== THREAD REPLIES`
 * marker): a parent message with no text body (e.g. a file-only post) must fall
 * back to `Slack thread <ts>`, never borrow a reply's body as the title.
 */
const PARENT_BODY_RE = /Message TS:\s*\d{7,}\.\d+\r?\n([^\r\n]+)/;

function readMessages(rawResult: unknown): string | undefined {
	if (typeof rawResult !== "object" || rawResult === null) return undefined;
	const m = (rawResult as { messages?: unknown }).messages;
	return typeof m === "string" ? m : undefined;
}

export function normalizeSlackThread(
	rawResult: unknown,
	ctx: { channelId: string; url?: string },
): SlackCanonical | null {
	const blob = readMessages(rawResult);
	if (blob === undefined) return null;

	const tsMatch = PARENT_TS_RE.exec(blob);
	if (tsMatch === null) return null; // no parent ts → not a usable thread

	const parentTs = tsMatch[1];
	// Confine title extraction to the parent block so an empty-bodied parent
	// can't pick up the first reply's text as the title.
	const replyIdx = blob.indexOf(REPLY_MARKER);
	const parentSegment = replyIdx === -1 ? blob : blob.slice(0, replyIdx);
	const titleMatch = PARENT_BODY_RE.exec(parentSegment);
	const title = titleMatch !== null ? titleMatch[1].trim() : `Slack thread ${parentTs}`;
	const replyMatch = REPLY_COUNT_RE.exec(blob);
	const replyCount = replyMatch !== null ? Number(replyMatch[1]) : 0;

	return {
		channelId: ctx.channelId,
		parentTs,
		title,
		text: blob.trim(),
		replyCount,
		...(ctx.url !== undefined ? { url: ctx.url } : {}),
	};
}
