import { describe, expect, it } from "vitest";
import { claudeEnvelopeParser } from "./ClaudeEnvelopeParser.js";

const PERMALINK = "https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009";
const BLOB =
	"=== THREAD PARENT MESSAGE ===\nMessage TS: 1783413984.700009\nConsolidate…\n\n=== THREAD REPLIES (2 total) ===\n";

function lines(): string[] {
	return [
		JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `look ${PERMALINK}` }] } }),
		JSON.stringify({
			message: {
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "mcp__claude_ai_Slack__slack_read_thread",
						input: { channel_id: "C0BFF9UHBD1", message_ts: "1783413984.700009" },
					},
				],
			},
		}),
		JSON.stringify({
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ messages: BLOB }) }],
			},
		}),
	];
}

describe("ClaudeEnvelopeParser slack", () => {
	it("correlates the pasted permalink with the thread result", () => {
		const { results } = claudeEnvelopeParser.parse(lines(), {});
		expect(results).toHaveLength(1);
		const p = results[0].payload as { channelId: string; parentTs: string; url?: string };
		expect(results[0].def.id).toBe("slack");
		expect(p).toMatchObject({ channelId: "C0BFF9UHBD1", parentTs: "1783413984.700009", url: PERMALINK });
	});
	it("reconstructs url from slackWorkspaceUrl when no permalink pasted", () => {
		const noPermalink = lines().slice(1); // drop the user permalink line
		const { results } = claudeEnvelopeParser.parse(noPermalink, {
			slackWorkspaceUrl: "https://flyer-q4r7867.slack.com",
		});
		expect((results[0].payload as { url?: string }).url).toBe(PERMALINK);
	});
	it("emits a urlless canonical when neither permalink nor config present (extractRef voids it downstream)", () => {
		// The parser is a lower layer than extractRef: it still surfaces the
		// canonical thread object with no url. The slack definition marks url
		// required, so `SourceEngine.extractRef` is where this urlless payload
		// is voided (see slack.test.ts / SourceEngine.test.ts) — nothing is stored.
		const { results } = claudeEnvelopeParser.parse(lines().slice(1), {});
		expect((results[0].payload as { url?: string }).url).toBeUndefined();
	});
});
