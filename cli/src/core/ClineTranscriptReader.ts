import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptReadResult } from "../Types.js";
import {
	buildClineReadResult,
	emptyClineReadResult,
	mapClineRole,
	type NormalizedMessage,
} from "./ClineTranscriptShared.js";

const log = createLogger("ClineReader");

interface AnthropicBlock {
	readonly type: string;
	readonly text?: string;
}
interface ExtMessage {
	readonly role?: string;
	readonly content?: ReadonlyArray<AnthropicBlock> | string;
	readonly ts?: number;
}

// Cline injects non-human scaffolding into `role:"user"` messages of
// api_conversation_history.json (verified against real captured data 2026-07-18):
//   - a `<environment_details>…</environment_details>` block (open tabs, file
//     tree, timestamps) — pure context, multi-KB, never human-authored;
//   - a `# task_progress RECOMMENDED …` boilerplate block on the first turn;
//   - tool results echoed as plain text blocks like `[execute_command …] Result:`
//     (Cline replays the API conversation, so tool output lands under role "user").
// Real human text is wrapped in `<task>…</task>` (first turn) or `<feedback>…</feedback>`.
// Without stripping, the ~6-char task drowns in ~7 KB of scaffolding and tool
// output is mis-attributed as human speech. Assistant text is kept raw (it may
// carry XML-in-text tool calls from non-Anthropic providers — degrade gracefully).
const ENV_DETAILS_RE = /<environment_details>[\s\S]*?<\/environment_details>/gi;
const TASK_RE = /<task>([\s\S]*?)<\/task>/i;
const FEEDBACK_RE = /<feedback>([\s\S]*?)<\/feedback>/i;
const TASK_PROGRESS_BOILERPLATE_RE = /^#\s*task_progress\b/i;
const TOOL_RESULT_RE = /^\[[^\]\n]+\]\s+Result:/;

/** Reduce one raw text block from a user turn to its human-authored content ("" = drop). */
function normalizeUserBlock(text: string): string {
	const stripped = text.replace(ENV_DETAILS_RE, "").trim();
	if (stripped.length === 0) return "";
	if (TASK_PROGRESS_BOILERPLATE_RE.test(stripped) || TOOL_RESULT_RE.test(stripped)) return "";
	const task = TASK_RE.exec(stripped);
	if (task) return task[1].trim();
	const feedback = FEEDBACK_RE.exec(stripped);
	if (feedback) return feedback[1].trim();
	return stripped;
}

/** Collect the `text` blocks of a message (string content counts as a single block). */
function textBlocks(content: ExtMessage["content"]): string[] {
	if (typeof content === "string") return [content];
	const parts: string[] = [];
	for (const block of content ?? []) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts;
}

function extractText(msg: ExtMessage, role: NormalizedMessage["role"]): string {
	const blocks = textBlocks(msg.content);
	const kept = role === "human" ? blocks.map(normalizeUserBlock).filter((t) => t.length > 0) : blocks;
	return kept.join("\n").trim();
}

export async function readClineTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	let raw: ExtMessage[];
	try {
		const parsed = JSON.parse(await readFile(transcriptPath, "utf8")) as unknown;
		raw = Array.isArray(parsed) ? (parsed as ExtMessage[]) : [];
	} catch (error: unknown) {
		log.error("Failed to read Cline transcript %s: %s", transcriptPath, (error as Error).message);
		return emptyClineReadResult(transcriptPath, cursor);
	}
	const messages: NormalizedMessage[] = raw.map((msg) => {
		const role = mapClineRole(msg.role);
		return { role, content: extractText(msg, role), ts: msg.ts };
	});
	return buildClineReadResult(transcriptPath, messages, cursor, beforeTimestamp);
}
