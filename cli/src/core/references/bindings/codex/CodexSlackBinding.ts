/**
 * CodexSlackBinding — Slack `codex_apps` connector normalizer.
 *
 * Reached through `_slack_read_thread` (namespace `mcp__codex_apps__slack`), or
 * the `slack.slack_read_thread` invocation on the fallback path — match identity
 * lives in `slackDefinition.match.codex`. In practice the connector emits the
 * thread ONLY via `mcp_tool_call_end` (no `function_call_output`), so this
 * binding is normally reached on the FALLBACK path.
 *
 * Slack is the one source whose url is in neither the result blob nor the tool
 * arguments — it lives only in the pasted permalink. So, exactly like the Claude
 * slack path, this reads `{channel_id, message_ts}` from the request `arguments`
 * and resolves the url from `env` (the harvested permalink map, else the
 * reconstructable `slackWorkspaceUrl` config), then hands both to the shared
 * `normalizeSlackThread`. A thread whose url cannot be resolved yields a urlless
 * canonical that `SourceEngine.extractRef` voids downstream (url is required).
 */

import { isObject } from "../../guards.js";
import { normalizeSlackThread } from "../../sources/SlackNormalize.js";
import type { CodexNormalizer } from "./CodexBinding.js";

/**
 * `{channel_id, message_ts}` off a Slack `function_call`'s parsed arguments.
 * Returns undefined when the request args are absent or malformed — the codex
 * envelope can reach here with no arguments at all (an `mcp_tool_call_end`
 * event that carries neither `invocation.arguments` nor a paired
 * `function_call`), so both guards are live, not merely defensive.
 */
function readSlackToolInput(input: unknown): { channelId: string; messageTs: string } | undefined {
	if (!isObject(input)) return undefined;
	const channelId = (input as { channel_id?: unknown }).channel_id;
	const messageTs = (input as { message_ts?: unknown }).message_ts;
	if (typeof channelId !== "string" || typeof messageTs !== "string") return undefined;
	return { channelId, messageTs };
}

export const slackCodexBinding: CodexNormalizer = {
	id: "slack",
	// Map to the Claude MCP tool name so both hosts persist the same
	// `sourceToolName` (host-agnostic dedupe — see CodexAsanaBinding).
	canonicalToolName: "mcp__claude_ai_Slack__slack_read_thread",
	normalize: (business, toolInput, env) => {
		const input = readSlackToolInput(toolInput);
		if (input === undefined) return null;
		const { channelId, messageTs } = input;
		const url =
			env?.permalinks.get(`${channelId}:${messageTs}`) ??
			(env?.slackWorkspaceUrl !== undefined
				? `${env.slackWorkspaceUrl}/archives/${channelId}/p${messageTs.replace(".", "")}`
				: undefined);
		return normalizeSlackThread(business, { channelId, url });
	},
};
