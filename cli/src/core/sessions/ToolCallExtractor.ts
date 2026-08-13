/**
 * ToolCallExtractor — every tool call one conversation made, however its agent
 * spells a tool name.
 *
 * Covers builtin calls, MCP calls and the tool-shaped half of skill invocations
 * in ONE pass, because those are three classifications of a single record rather
 * than three kinds of record — see {@link SessionSignalExtractor}'s header. The
 * classification itself belongs to `ToolNameClassify` and each source's parser or
 * reader; nothing about it is repeated here.
 *
 * ## What decides which agents this answers for
 *
 * {@link TOOL_RECORDING_SOURCES}, and deliberately nothing else. That set is half
 * probed (a parser either implements `parseToolUse` or does not) and half
 * hand-maintained against real captures, and it already carries the rule that
 * matters: a source joins it only once its reader has been written against a real
 * transcript from that host. Restating the list here would be a second copy of a
 * decision that is deliberately conservative — and the failure would be silent,
 * because a source wrongly included reports `toolUse: []`, which every consumer
 * reads as the positive claim "this agent called no tools".
 *
 * That is also why absence is preserved: a source outside the set contributes no
 * `tools` field at all, never an empty one. "Cannot express tool calls" and
 * "expressed none" are different facts and the dashboard renders them
 * differently.
 */

import { errMsg } from "../../Logger.js";
import type { TranscriptSource } from "../../Types.js";
import { TOOL_RECORDING_SOURCES } from "../TranscriptParser.js";
import type { SessionSignalExtractor, SessionSignalInput, SessionSignals } from "./SessionSignalExtractor.js";

export const toolCallExtractor: SessionSignalExtractor = {
	id: "tool-calls",
	supports: (source: TranscriptSource) => TOOL_RECORDING_SOURCES.has(source),
	extract: async (input: SessionSignalInput): Promise<SessionSignals> => {
		try {
			const read = await input.content.read();
			// Forwarded only when the reader actually produced it. An empty array means
			// "called no tools" and is worth storing; absence means this slice could not
			// say, and the two must not collapse.
			return read.toolUse ? { tools: read.toolUse } : {};
		} catch (err) {
			// Rethrown with the session named, NOT swallowed: an unreadable transcript
			// and a transcript with no tool calls are different facts, and returning `{}`
			// here would spell them the same way. The caller is what decides the
			// consequence — it logs this and keeps the session row built from what the
			// discoverer already knew, so a conversation that cannot be parsed still
			// counts as a conversation.
			throw new Error(`tool-call extraction failed for ${input.source}/${input.sessionId}: ${errMsg(err)}`);
		}
	},
};
