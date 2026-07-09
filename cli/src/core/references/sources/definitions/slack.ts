/**
 * Slack built-in source definition. Operates on the POST-normalize canonical
 * object from `SlackNormalize.normalizeSlackThread` (channelId + parentTs +
 * title + text + replyCount + url), NOT the raw MCP blob. `url` is REQUIRED:
 * a thread whose url could not be resolved (no permalink pasted AND no
 * `slack.workspaceUrl` configured — e.g. the user pasted a bare channel URL,
 * which carries no message ts) is voided by `extractRef` and never stored,
 * since a linkless reference has nothing to jump to.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

export const slackDefinition: SourceDefinition = {
	id: "slack",
	label: "Slack",
	icon: "comment-discussion",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Slack__"], acceptSuffix: "slack_read_thread" },
		codex: {
			namespaceSuffix: "slack",
			functionCallNames: ["_read_thread"],
			invocationTools: ["slack_read_thread"],
		},
	},
	wrapperKeys: [],
	reference: {
		nativeId: {
			pipe: [
				{
					op: "template",
					template: "{c}-{t}",
					from: { c: [{ op: "path", path: "channelId" }], t: [{ op: "path", path: "parentTs" }] },
				},
			],
			require: "^[A-Z0-9]+-\\d{7,}\\.\\d+$",
		},
		title: { pipe: [{ op: "path", path: "title" }], require: ".+" },
		url: { pipe: [{ op: "path", path: "url" }], require: "^https://" },
		description: { pipe: [{ op: "path", path: "text" }], optional: true },
	},
	fields: [
		{ key: "entity-type", label: "Type", icon: "comment-discussion", pipe: [{ op: "const", value: "thread" }] },
		{ key: "replies", label: "Replies", icon: "reply", pipe: [{ op: "path", path: "replyCount" }] },
		{ key: "channel", label: "Channel", icon: "symbol-namespace", pipe: [{ op: "path", path: "channelId" }] },
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "slack-threads",
		itemTag: "thread",
		bodyTag: "messages",
		fieldAttrs: true,
		maxCharsPerReference: 8000,
		maxTotalChars: 40000,
	},
};
