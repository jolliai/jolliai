import { describe, expect, it } from "vitest";
import { parseSlackPermalink, scanCodexUserPermalinks, scanUserPermalinks } from "./SlackPermalink.js";

const URL = "https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009";

describe("parseSlackPermalink", () => {
	it("parses workspace, channel, and dotted parentTs", () => {
		expect(parseSlackPermalink(URL)).toEqual({
			workspace: "flyer-q4r7867",
			channel: "C0BFF9UHBD1",
			parentTs: "1783413984.700009",
			url: URL,
		});
	});
	it("rejects a non-slack host", () => {
		expect(parseSlackPermalink("https://evil.example/archives/C1/p1")).toBeNull();
	});
	it("rejects a channel message url with no p<ts> segment", () => {
		expect(parseSlackPermalink("https://x.slack.com/archives/C1")).toBeNull();
	});
	it("rejects a permalink with wrong-length ts (not 16 digits)", () => {
		expect(parseSlackPermalink("https://x.slack.com/archives/C1/p123456789012345")).toBeNull();
	});
});

describe("scanUserPermalinks", () => {
	it("reads only role:user message text and keys by channel:ts", () => {
		const lines = [
			JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `see ${URL}` }] } }),
			JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: URL }] } }),
			JSON.stringify({ type: "last-prompt", lastPrompt: URL }),
		];
		const map = scanUserPermalinks(lines);
		expect(map.get("C0BFF9UHBD1:1783413984.700009")).toBe(URL);
		expect(map.size).toBe(1); // assistant text + last-prompt line ignored
	});
	it("ignores tool_result content inside a user message", () => {
		const lines = [JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", content: URL }] } })];
		expect(scanUserPermalinks(lines).size).toBe(0);
	});
	it("ignores invalid JSON lines", () => {
		const lines = [
			'{"message": {"role": "user", "content": [{"type": "text", "text": "https://x.slack.com/archives/C1/p1"}',
		];
		expect(scanUserPermalinks(lines).size).toBe(0);
	});
	it("ignores lines without slack.com/archives/ prefix", () => {
		const lines = [
			JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "https://example.com" }] } }),
		];
		expect(scanUserPermalinks(lines).size).toBe(0);
	});
	it("ignores user messages with non-array content", () => {
		const lines = [
			JSON.stringify({ message: { role: "user", content: "not an array" } }),
			JSON.stringify({ message: { role: "user", content: null } }),
		];
		expect(scanUserPermalinks(lines).size).toBe(0);
	});
	it("ignores content blocks that are null or non-objects", () => {
		const lines = [
			JSON.stringify({
				message: {
					role: "user",
					content: [null, "string", 123, true],
					text: "https://x.slack.com/archives/C1/p1",
				},
			}),
		];
		expect(scanUserPermalinks(lines).size).toBe(0);
	});
	it("ignores blocks without type or non-text types", () => {
		const lines = [
			JSON.stringify({ message: { role: "user", content: [{ text: URL }] } }),
			JSON.stringify({ message: { role: "user", content: [{ type: "image", text: URL }] } }),
		];
		expect(scanUserPermalinks(lines).size).toBe(0);
	});
	it("ignores blocks with non-string text", () => {
		const lines = [
			JSON.stringify({ message: { role: "user", content: [{ type: "text", text: null }] } }),
			JSON.stringify({ message: { role: "user", content: [{ type: "text", text: 123 }] } }),
		];
		expect(scanUserPermalinks(lines).size).toBe(0);
	});
	it("handles multiple blocks in one message", () => {
		const lines = [
			JSON.stringify({
				message: {
					role: "user",
					content: [
						{ type: "text", text: "first block with no link" },
						{ type: "image", url: "https://example.com" },
						{ type: "text", text: `link here: ${URL}` },
						{ type: "text", text: "final block" },
					],
				},
			}),
		];
		const map = scanUserPermalinks(lines);
		expect(map.size).toBe(1);
		expect(map.get("C0BFF9UHBD1:1783413984.700009")).toBe(URL);
	});
	it("ignores lines missing the message key entirely", () => {
		const lines = [JSON.stringify({ someOtherKey: "https://x.slack.com/archives/C1/p1" })];
		expect(scanUserPermalinks(lines).size).toBe(0);
	});
});

describe("scanCodexUserPermalinks", () => {
	it("reads the codex `message` response_item (role:user, input_text blocks)", () => {
		const lines = [
			JSON.stringify({
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: `see ${URL}` }] },
			}),
		];
		expect(scanCodexUserPermalinks(lines).get("C0BFF9UHBD1:1783413984.700009")).toBe(URL);
	});
	it("reads the codex `user_message` event (bare string message)", () => {
		const lines = [JSON.stringify({ payload: { type: "user_message", message: `${URL}\n` } })];
		expect(scanCodexUserPermalinks(lines).get("C0BFF9UHBD1:1783413984.700009")).toBe(URL);
	});
	it("dedupes the same thread appearing in both line shapes", () => {
		const lines = [
			JSON.stringify({
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: URL }] },
			}),
			JSON.stringify({ payload: { type: "user_message", message: URL } }),
		];
		expect(scanCodexUserPermalinks(lines).size).toBe(1);
	});
	it("ignores invalid JSON lines", () => {
		const lines = ['{"payload": {"type": "user_message", "message": "https://x.slack.com/archives/C1/p1"'];
		expect(scanCodexUserPermalinks(lines).size).toBe(0);
	});
	it("ignores lines without slack.com/archives/", () => {
		const lines = [JSON.stringify({ payload: { type: "user_message", message: "https://example.com" } })];
		expect(scanCodexUserPermalinks(lines).size).toBe(0);
	});
	it("ignores lines with a missing/null payload", () => {
		const lines = [
			JSON.stringify({ someKey: "https://x.slack.com/archives/C1/p1" }),
			JSON.stringify({ payload: null, note: "https://x.slack.com/archives/C1/p1" }),
		];
		expect(scanCodexUserPermalinks(lines).size).toBe(0);
	});
	it("ignores an assistant `message` and a non-array content", () => {
		const lines = [
			JSON.stringify({
				payload: { type: "message", role: "assistant", content: [{ type: "input_text", text: URL }] },
			}),
			JSON.stringify({ payload: { type: "message", role: "user", content: "not-array", note: URL } }),
		];
		expect(scanCodexUserPermalinks(lines).size).toBe(0);
	});
	it("ignores non-object blocks and non-input_text / non-string blocks", () => {
		const lines = [
			JSON.stringify({
				payload: {
					type: "message",
					role: "user",
					content: [null, "str", { type: "output_text", text: URL }, { type: "input_text", text: 123 }],
					note: URL,
				},
			}),
		];
		expect(scanCodexUserPermalinks(lines).size).toBe(0);
	});
	it("ignores a user_message whose message is not a string", () => {
		const lines = [JSON.stringify({ payload: { type: "user_message", message: 42, note: URL } })];
		expect(scanCodexUserPermalinks(lines).size).toBe(0);
	});
	it("ignores an archives url that is not a full thread permalink (no p<ts>)", () => {
		const lines = [
			JSON.stringify({ payload: { type: "user_message", message: "https://x.slack.com/archives/C1" } }),
		];
		expect(scanCodexUserPermalinks(lines).size).toBe(0);
	});
});
