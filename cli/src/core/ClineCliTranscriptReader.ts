import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { ToolCallCount, TranscriptCursor, TranscriptReadResult } from "../Types.js";
import {
	buildClineReadResult,
	emptyClineReadResult,
	mapClineRole,
	type NormalizedMessage,
} from "./ClineTranscriptShared.js";
import { classifyToolName, ToolUseTally } from "./ToolNameClassify.js";

const log = createLogger("ClineCliReader");

interface ClineCliBlock {
	readonly type: string;
	readonly text?: string;
	/** Anthropic-block `tool_use` fields — present only on `type:"tool_use"` blocks. */
	readonly id?: string;
	readonly name?: string;
}
interface ClineCliMessage {
	readonly role?: string;
	readonly content?: ReadonlyArray<ClineCliBlock>;
	readonly ts?: number;
}
interface ClineCliFile {
	readonly messages?: ReadonlyArray<ClineCliMessage>;
}

const USER_INPUT_RE = /<user_input\b[^>]*>([\s\S]*?)<\/user_input>/i;

function unwrapUserInput(text: string): string {
	const m = USER_INPUT_RE.exec(text);
	return (m ? m[1] : text).trim();
}

function extractText(msg: ClineCliMessage): string {
	const parts: string[] = [];
	for (const block of msg.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/**
 * The message's `tool_use` blocks, classified.
 *
 * The Cline CLI stores `messages[].content` as Anthropic content blocks (the
 * same array `extractText` walks for `type:"text"`), so a tool call is a
 * `type:"tool_use"` block carrying `name` and a `toolu_…` `id`, and MCP tools
 * are named `mcp__<server>__<tool>`. Deduped on the block id within the message
 * — `tool_result` blocks are the same call's answer and are not counted.
 */
function extractTools(msg: ClineCliMessage): ToolCallCount[] {
	const tally = new ToolUseTally();
	for (const block of msg.content ?? []) {
		if (block.type !== "tool_use" || typeof block.name !== "string" || block.name.length === 0) continue;
		tally.addOnce(typeof block.id === "string" ? block.id : undefined, classifyToolName(block.name));
	}
	return tally.values();
}

export async function readClineCliTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	let parsed: ClineCliFile;
	try {
		parsed = JSON.parse(await readFile(transcriptPath, "utf8")) as ClineCliFile;
	} catch (error: unknown) {
		log.error("Failed to read Cline CLI transcript %s: %s", transcriptPath, (error as Error).message);
		return emptyClineReadResult(transcriptPath, cursor);
	}
	const messages: NormalizedMessage[] = (Array.isArray(parsed.messages) ? parsed.messages : []).map((msg) => {
		const role = mapClineRole(msg.role);
		const raw = extractText(msg);
		return {
			role,
			content: role === "human" ? unwrapUserInput(raw) : raw,
			ts: msg.ts,
			tools: extractTools(msg),
		};
	});
	return buildClineReadResult(transcriptPath, messages, cursor, beforeTimestamp, { recordsTools: true });
}
