/**
 * Antigravity Transcript Reader
 *
 * Reads a plaintext `transcript_full.jsonl` written by Antigravity per
 * conversation. Each line is a JSON object with `step_index`, `type`,
 * `created_at` (ISO8601 UTC) and usually `content`; PLANNER_RESPONSE rows may
 * carry `tool_calls: [{ name, args }]`.
 *
 * Line → TranscriptEntry mapping:
 *   USER_INPUT         → human (unwrapped from the <USER_REQUEST> envelope)
 *   PLANNER_RESPONSE   → assistant (content + tool-call summaries)
 *   RUN_COMMAND        → assistant (command output)
 *   CHECKPOINT / CONVERSATION_HISTORY / GENERIC / SYSTEM_MESSAGE /
 *     LIST_DIRECTORY / VIEW_FILE / other → skipped. GENERIC carries only
 *     workspace-access banners (verified against live transcripts); the tool
 *     rows (LIST_DIRECTORY / VIEW_FILE / …) are already represented by the
 *     PLANNER_RESPONSE tool_calls that spawned them.
 *
 * Cursor resume reuses TranscriptCursor.lineNumber (the file is line-oriented).
 */

import { readFile } from "node:fs/promises";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;

/**
 * Unwraps the `<USER_REQUEST>…</USER_REQUEST>` envelope Antigravity wraps around
 * user input, returning the trimmed inner text (or the trimmed whole string when
 * the envelope is absent). Shared with the session discoverer's title reader.
 */
export function unwrapUserRequest(content: string): string {
	const m = USER_REQUEST_RE.exec(content);
	return (m ? m[1] : content).trim();
}

function toolCallSummary(tc: { name?: string; args?: Record<string, unknown> }): string {
	const args = tc.args ?? {};
	const detail =
		typeof args.CommandLine === "string"
			? args.CommandLine
			: typeof args.toolSummary === "string"
				? args.toolSummary
				: "";
	return `↪ ${tc.name ?? "tool"}${detail ? `: ${detail}` : ""}`;
}

export async function readAntigravityTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	let raw: string;
	try {
		raw = await readFile(transcriptPath, "utf8");
	} catch {
		return {
			entries: [],
			newCursor: {
				transcriptPath,
				lineNumber: cursor?.lineNumber ?? 0,
				updatedAt: cursor?.updatedAt ?? new Date().toISOString(),
			},
			totalLinesRead: 0,
		};
	}

	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const startLine = cursor?.lineNumber ?? 0;
	const cutoff = beforeTimestamp ? Date.parse(beforeTimestamp) : Number.POSITIVE_INFINITY;
	const entries: TranscriptEntry[] = [];
	let lastTs = cursor?.updatedAt ?? new Date().toISOString();
	let lineNumber = startLine;

	for (let i = startLine; i < lines.length; i++) {
		lineNumber = i + 1;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const ts = typeof obj.created_at === "string" ? obj.created_at : undefined;
		// The transcript is append-only and chronologically ordered, so we stop at
		// the first line past the cutoff. A line missing `created_at` is consumed:
		// since it precedes this break point it is necessarily before the cutoff.
		if (ts && Date.parse(ts) >= cutoff) {
			lineNumber = i; // this line is not consumed; resume here next time
			break;
		}
		if (ts) lastTs = ts;

		const type = obj.type;
		const content = typeof obj.content === "string" ? obj.content : "";
		if (type === "USER_INPUT") {
			const text = unwrapUserRequest(content);
			if (text) entries.push({ role: "human", content: text, timestamp: ts });
		} else if (type === "PLANNER_RESPONSE") {
			const tcs = Array.isArray(obj.tool_calls)
				? (obj.tool_calls as { name?: string; args?: Record<string, unknown> }[])
				: [];
			const parts = [content, ...tcs.map(toolCallSummary)].filter((p) => p.length > 0);
			if (parts.length) entries.push({ role: "assistant", content: parts.join("\n"), timestamp: ts });
		} else if (type === "RUN_COMMAND") {
			if (content) entries.push({ role: "assistant", content, timestamp: ts });
		}
		// CHECKPOINT / CONVERSATION_HISTORY / GENERIC / tool rows / anything else → skipped
	}

	return {
		entries: mergeConsecutiveEntries(entries),
		newCursor: { transcriptPath, lineNumber, updatedAt: lastTs },
		// Lines actually consumed this pass (matches the other readers' convention);
		// on an early `beforeTimestamp` break `lineNumber` is the unconsumed cutoff line.
		totalLinesRead: lineNumber - startLine,
	};
}
