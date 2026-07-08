import { describe, expect, it } from "vitest";
import { getRegistry } from "../../SourceDefinitionRegistry.js";
import { extractRef } from "../../SourceEngine.js";
import { slackDefinition } from "./slack.js";

// The engine sees the CANONICAL object (post-normalize), not the raw blob.
const CANON = {
	channelId: "C0BFF9UHBD1",
	parentTs: "1783413984.700009",
	title: "Consolidate the existing Linear / Jira / GitHub / Notion …",
	text: "=== THREAD PARENT MESSAGE ===\n…",
	replyCount: 2,
	url: "https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009",
};

describe("slack definition", () => {
	it("is registered and matches slack_read_thread", () => {
		expect(getRegistry().byId("slack")?.id).toBe("slack");
		expect(getRegistry().match("claude", "mcp__claude_ai_Slack__slack_read_thread")?.id).toBe("slack");
	});
	it("extracts a Reference from the canonical object", () => {
		const ref = extractRef(
			slackDefinition,
			CANON,
			"mcp__claude_ai_Slack__slack_read_thread",
			"2026-07-08T00:00:00Z",
		);
		expect(ref).toMatchObject({
			mapKey: "slack:C0BFF9UHBD1-1783413984.700009",
			source: "slack",
			nativeId: "C0BFF9UHBD1-1783413984.700009",
			url: CANON.url,
		});
		expect(ref?.fields?.find((f) => f.key === "channel")?.value).toBe("C0BFF9UHBD1");
	});
});
