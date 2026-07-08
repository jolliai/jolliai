import { describe, expect, it } from "vitest";
import { normalizeSlackThread } from "./SlackNormalize.js";

const BLOB = `=== THREAD PARENT MESSAGE ===
From: Flyer Li <li.chengbin2008@gmail.com> (U0BGFSM16DN)
Time: 2026-07-07 16:46:24 CST
Message TS: 1783413984.700009
Consolidate the existing Linear / Jira / GitHub / Notion …

=== THREAD REPLIES (2 total) ===

--- Reply 1 of 2 ---
From: Flyer Li <…> (U0BGFSM16DN)
Time: 2026-07-07 17:18:37 CST
Message TS: 1783415917.422609
Config-driven MCP integration

--- Reply 2 of 2 ---
From: Flyer Li <…> (U0BGFSM16DN)
Time: 2026-07-07 17:23:48 CST
Message TS: 1783416228.715669
How to do?
`;

describe("normalizeSlackThread", () => {
	it("extracts parentTs, title, replyCount and threads url/channel through", () => {
		const c = normalizeSlackThread({ messages: BLOB }, { channelId: "C0BFF9UHBD1", url: "https://x" });
		expect(c).toMatchObject({
			channelId: "C0BFF9UHBD1",
			parentTs: "1783413984.700009",
			title: "Consolidate the existing Linear / Jira / GitHub / Notion …",
			replyCount: 2,
			url: "https://x",
		});
		expect(c?.text).toContain("Config-driven MCP integration");
	});
	it("returns null (never throws) on a blob with no parent ts", () => {
		expect(normalizeSlackThread({ messages: "garbage" }, { channelId: "C1" })).toBeNull();
	});
	it("returns null when messages is not a string", () => {
		expect(normalizeSlackThread({ messages: 42 }, { channelId: "C1" })).toBeNull();
	});
	it("omits url when ctx.url is absent", () => {
		const c = normalizeSlackThread({ messages: BLOB }, { channelId: "C0BFF9UHBD1" });
		expect(c?.url).toBeUndefined();
	});
	it("handles blob with no reply section (replyCount defaults to 0)", () => {
		const blobNoReplies = `=== THREAD PARENT MESSAGE ===
From: User <email@example.com> (U123456)
Time: 2026-07-07 16:46:24 CST
Message TS: 1783413984.700009
Test message`;
		const c = normalizeSlackThread({ messages: blobNoReplies }, { channelId: "C1" });
		expect(c).not.toBeNull();
		expect(c?.replyCount).toBe(0);
	});
	it("handles blob with no title line (uses fallback title)", () => {
		const blobNoTitle = `=== THREAD PARENT MESSAGE ===
Message TS: 1783413984.700009`;
		const c = normalizeSlackThread({ messages: blobNoTitle }, { channelId: "C1" });
		expect(c).not.toBeNull();
		expect(c?.title).toBe("Slack thread 1783413984.700009");
	});
	it("returns null when rawResult is not an object", () => {
		expect(normalizeSlackThread("not an object", { channelId: "C1" })).toBeNull();
	});
	it("returns null when rawResult is null", () => {
		expect(normalizeSlackThread(null, { channelId: "C1" })).toBeNull();
	});
	it("returns null when messages property is missing", () => {
		expect(normalizeSlackThread({ other: "data" }, { channelId: "C1" })).toBeNull();
	});
	it("falls back to `Slack thread <ts>` when the parent has no body, never borrowing a reply's text", () => {
		// Parent is a text-less post (Message TS then a blank line into the replies
		// section); the reply DOES have a body. Title must not become the reply's.
		const parentNoBody = `=== THREAD PARENT MESSAGE ===
From: User <email@example.com> (U123456)
Time: 2026-07-07 16:46:24 CST
Message TS: 1783413984.700009

=== THREAD REPLIES (1 total) ===

--- Reply 1 of 1 ---
From: Other (U654321)
Time: 2026-07-07 17:18:37 CST
Message TS: 1783415917.422609
This reply body must not become the title`;
		const c = normalizeSlackThread({ messages: parentNoBody }, { channelId: "C1" });
		expect(c?.title).toBe("Slack thread 1783413984.700009");
		expect(c?.replyCount).toBe(1);
	});
});
