import { describe, expect, it } from "vitest";
import {
	writeHookCommandRemoval,
	writeHookCommandUpsert,
	writeRemoval,
	writeUpsert,
	type YamlBlockEntry,
} from "./HermesConfigWriter.js";

const JOLLI: YamlBlockEntry = {
	subKey: "jollimemory",
	body: '  jollimemory:\n    command: /Users/zf/.jolli/jollimemory/run-cli\n    args: ["mcp"]\n',
};

describe("HermesConfigWriter.writeUpsert (mcp_servers)", () => {
	it("adds the block when the file is empty", () => {
		expect(writeUpsert("", "mcp_servers", JOLLI)).toBe(
			`mcp_servers:\n  jollimemory:\n    command: /Users/zf/.jolli/jollimemory/run-cli\n    args: ["mcp"]\n`,
		);
	});

	it("replaces the empty `mcp_servers: {}` idiom Hermes ships with", () => {
		const before = `model:\n  default: anthropic/claude-opus-4.6\nmcp_servers: {}\nonboarding:\n  seen: {}\n`;
		const after = writeUpsert(before, "mcp_servers", JOLLI);
		// The block is authored, and the surrounding sections are untouched.
		expect(after).toContain("mcp_servers:\n  jollimemory:\n");
		expect(after.startsWith("model:\n  default: anthropic/claude-opus-4.6\n")).toBe(true);
		expect(after.endsWith("onboarding:\n  seen: {}\n")).toBe(true);
	});

	it("preserves other MCP servers already configured under the same key", () => {
		const before =
			`mcp_servers:\n  linear:\n    command: /usr/local/bin/linear-mcp\n    args: []\n` +
			`  github:\n    command: npx\n    args: ["-y", "gh-mcp"]\n`;
		const after = writeUpsert(before, "mcp_servers", JOLLI);
		expect(after).toContain("linear:");
		expect(after).toContain("github:");
		expect(after).toContain("jollimemory:");
	});

	it("re-registration replaces the entry rather than adding a duplicate", () => {
		const first = writeUpsert("", "mcp_servers", JOLLI);
		const updated: YamlBlockEntry = {
			...JOLLI,
			body: '  jollimemory:\n    command: /new/path\n    args: ["mcp"]\n',
		};
		const second = writeUpsert(first, "mcp_servers", updated);
		// Exactly one `jollimemory:` header on a line, and it points at the new path.
		expect((second.match(/^ {2}jollimemory:$/gm) ?? []).length).toBe(1);
		expect(second).toContain("command: /new/path");
		expect(second).not.toContain("run-cli");
	});

	it("is a byte-stable no-op when the entry already matches", () => {
		const once = writeUpsert("", "mcp_servers", JOLLI);
		expect(writeUpsert(once, "mcp_servers", JOLLI)).toBe(once);
	});

	it("keeps a real-world config's surrounding sections byte-stable", () => {
		// The exact shape of a fresh Hermes config, taken from `hermes setup`.
		const before =
			`model:\n  default: anthropic/claude-opus-4.6\n  provider: openrouter\n` +
			`database:\n  journal_mode: wal\n` +
			`agent:\n  max_turns: 500\n` +
			`custom_providers:\n  - name: sub2api\n    api_key: sk-c8d69c\n` +
			`mcp_servers: {}\n` +
			`onboarding:\n  seen:\n    busy_input_prompt: true\n`;
		const after = writeUpsert(before, "mcp_servers", JOLLI);
		// Every section OTHER than mcp_servers survives byte-for-byte, including
		// the plaintext api_key that must never be touched.
		expect(after).toContain("api_key: sk-c8d69c");
		expect(after).toContain("journal_mode: wal");
		expect(after).toContain("busy_input_prompt: true");
		// And mcp_servers now has the entry.
		expect(after).toContain("mcp_servers:\n  jollimemory:\n");
	});

	it("leaves a non-trivial inline mcp_servers block untouched instead of dropping user data", () => {
		const before =
			`model:\n  default: x\n` +
			`mcp_servers: {linear: {command: /usr/local/bin/linear-mcp, args: []}}\n` +
			`onboarding:\n  seen: {}\n`;
		expect(writeUpsert(before, "mcp_servers", JOLLI)).toBe(before);
	});

	it("treats a trailing YAML comment on the header as an empty (null) value", () => {
		const before = `model:\n  default: x\nmcp_servers: # empty for now\nonboarding:\n  seen: {}\n`;
		const after = writeUpsert(before, "mcp_servers", JOLLI);
		expect(after).toContain("mcp_servers:\n  jollimemory:\n");
		expect(after).toContain("onboarding:\n  seen: {}");
	});

	it("handles CRLF line endings without corrupting the file", () => {
		const before =
			"model:\r\n  default: x\r\nmcp_servers:\r\n  linear:\r\n    command: /usr/local/bin/linear\r\n    args: []\r\nonboarding:\r\n  seen: {}\r\n";
		const after = writeUpsert(before, "mcp_servers", JOLLI);
		expect(after).toContain("linear:");
		expect(after).toContain("jollimemory:");
		expect(after).not.toContain("\r");
	});

	it("preserves sub-entries below a col-0 comment inside the block", () => {
		const before =
			`mcp_servers:\n  linear:\n    command: /usr/local/bin/linear\n    args: []\n` +
			`# note about other servers\n  other:\n    command: /usr/local/bin/other\n    args: []\n`;
		const after = writeUpsert(before, "mcp_servers", JOLLI);
		expect(after).toContain("linear:");
		expect(after).toContain("other:");
		expect(after).toContain("jollimemory:");
		expect(after).toContain("# note about other servers");
	});

	it("does not lose a comment between sub-entries when removing one", () => {
		const before =
			`mcp_servers:\n  jollimemory:\n    command: /old\n    args: ["mcp"]\n` +
			`  # comment about linear\n  linear:\n    command: /usr/local/bin/linear\n    args: []\n`;
		const after = writeRemoval(before, "mcp_servers", "jollimemory");
		expect(after).not.toContain("jollimemory:");
		expect(after).toContain("linear:");
		expect(after).toContain("# comment about linear");
	});

	it("does not mistake a header that only appears inside a comment", () => {
		const before = `# see mcp_servers: for the machine-wide table\nmodel:\n  default: x\n`;
		const after = writeUpsert(before, "mcp_servers", JOLLI);
		// The comment is preserved verbatim.
		expect(after).toContain("# see mcp_servers: for the machine-wide table\n");
		// And a NEW block is appended.
		expect(after).toContain("mcp_servers:\n  jollimemory:\n");
	});

	it("adds a hooks: block without disturbing an existing mcp_servers: block", () => {
		const before =
			`mcp_servers:\n  jollimemory:\n    command: /path/to/run-cli\n    args: ["mcp"]\n` +
			`onboarding:\n  seen: {}\n`;
		const hook: YamlBlockEntry = {
			subKey: "on_session_end",
			body: '  on_session_end:\n    - command: "/Users/zf/.jolli/jollimemory/run-hook hermes-stop"\n      timeout: 30\n',
		};
		const after = writeUpsert(before, "hooks", hook);
		expect(after).toContain("mcp_servers:\n  jollimemory:\n");
		expect(after).toContain("hooks:\n  on_session_end:");
		expect(after).toContain("onboarding:\n  seen: {}");
	});
});

describe("HermesConfigWriter.writeRemoval", () => {
	it("removes just our sub-entry, leaving other MCP servers alone", () => {
		const before = writeUpsert(
			`mcp_servers:\n  linear:\n    command: /usr/local/bin/linear-mcp\n    args: []\n`,
			"mcp_servers",
			JOLLI,
		);
		const after = writeRemoval(before, "mcp_servers", "jollimemory");
		expect(after).toContain("linear:");
		expect(after).not.toContain("jollimemory:");
	});

	it("collapses the block back to `{}` when the last sub-entry is removed", () => {
		const before = writeUpsert("", "mcp_servers", JOLLI);
		expect(writeRemoval(before, "mcp_servers", "jollimemory")).toBe("mcp_servers: {}\n");
	});

	it("is a no-op when the sub-key is absent", () => {
		const before = `mcp_servers:\n  linear:\n    command: x\n    args: []\n`;
		expect(writeRemoval(before, "mcp_servers", "jollimemory")).toBe(before);
	});

	it("is a no-op when the block itself is absent", () => {
		const before = `model:\n  default: x\n`;
		expect(writeRemoval(before, "mcp_servers", "jollimemory")).toBe(before);
	});
});

const JOLLI_HOOK = "/Users/zf/.jolli/jollimemory/run-hook hermes-stop";

describe("HermesConfigWriter hook command transforms", () => {
	it("adds a new hook event when hooks is absent", () => {
		const after = writeHookCommandUpsert("model:\n  default: x\n", "on_session_end", JOLLI_HOOK, 30);
		expect(after).toContain("hooks:\n  on_session_end:\n");
		expect(after).toContain(`    - command: ${JSON.stringify(JOLLI_HOOK)}\n      timeout: 30`);
	});

	it("preserves a user's command in the same event and is idempotent", () => {
		const before =
			`hooks:\n  on_session_end:\n` +
			`    - command: "/user/session-end"\n      timeout: 10\n` +
			`  pre_tool_call:\n    - command: "/user/pre-tool"\n`;
		const once = writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30);
		expect(once).toContain('command: "/user/session-end"');
		expect(once).toContain('command: "/user/pre-tool"');
		expect(once).toContain(JSON.stringify(JOLLI_HOOK));
		expect(writeHookCommandUpsert(once, "on_session_end", JOLLI_HOOK, 30)).toBe(once);
	});

	it("supports PyYAML's indentless sequence style", () => {
		const before = `hooks:\n  on_session_end:\n  - command: /user/session-end\n    timeout: 10\n`;
		const after = writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30);
		expect(after).toContain("  - command: /user/session-end\n");
		expect(after).toContain(`  - command: ${JSON.stringify(JOLLI_HOOK)}\n    timeout: 30`);
	});

	it("uses the existing hooks indentation when adding a new event", () => {
		const before = `hooks:\n    pre_tool_call:\n        - command: /user/pre\n          timeout: 10\n`;
		const after = writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30);
		expect(after).toContain(
			`    on_session_end:\n        - command: ${JSON.stringify(JOLLI_HOOK)}\n          timeout: 30`,
		);
		expect(after).not.toContain(`\n  on_session_end:`);
	});

	it("uses an existing indentless list style for a newly added event", () => {
		const before = `hooks:\n    pre_tool_call:\n    - command: /user/pre\n      timeout: 10\n`;
		const after = writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30);
		expect(after).toContain(`    on_session_end:\n    - command: ${JSON.stringify(JOLLI_HOOK)}\n      timeout: 30`);
	});

	it("replaces stale copies of its own command and collapses duplicates", () => {
		const before =
			`hooks:\n  on_session_end:\n` +
			`    - command: ${JSON.stringify(JOLLI_HOOK)}\n      timeout: 5\n` +
			`    - command: "/user/session-end"\n      timeout: 10\n` +
			`    - command: ${JSON.stringify(JOLLI_HOOK)}\n      timeout: 15\n`;
		const after = writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30);
		expect((after.match(/hermes-stop/g) ?? []).length).toBe(1);
		expect(after).toContain('command: "/user/session-end"');
		expect(after).toContain("timeout: 30");
		expect(after).not.toContain("timeout: 5");
		expect(after).not.toContain("timeout: 15");
	});

	it("replaces an inline empty event value with a list", () => {
		const before = `hooks:\n  on_session_end: []\n  pre_tool_call:\n    - command: /user/pre\n`;
		const after = writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30);
		expect(after).toContain(`  on_session_end:\n    - command: ${JSON.stringify(JOLLI_HOOK)}`);
		expect(after).toContain("  pre_tool_call:\n    - command: /user/pre");
	});

	it("does not duplicate when a sibling command uses a block-scalar marker", () => {
		const before =
			`hooks:\n  on_session_end:\n` +
			`    - command: |\n        /user/complex-hook --flag\n      timeout: 10\n` +
			`    - command: ${JSON.stringify(JOLLI_HOOK)}\n      timeout: 30\n`;
		const after = writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30);
		expect((after.match(/hermes-stop/g) ?? []).length).toBe(1);
	});

	it("handles CRLF line endings in hook upserts", () => {
		const before = `hooks:\r\n  on_session_end:\r\n    - command: "/user/end"\r\n      timeout: 10\r\n`;
		const after = writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30);
		expect(after).toContain('command: "/user/end"');
		expect(after).toContain(JSON.stringify(JOLLI_HOOK));
		expect(after).not.toContain("\r");
	});

	it("leaves a non-empty inline event untouched rather than emitting invalid YAML", () => {
		const before = `hooks:\n  on_session_end: [{command: /user/end, timeout: 10}]\n`;
		expect(writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30)).toBe(before);
	});

	it("leaves a non-trivial inline hooks block untouched instead of dropping user data", () => {
		const before = `hooks: {on_session_end: {command: /user/end, timeout: 10}}\n`;
		expect(writeHookCommandUpsert(before, "on_session_end", JOLLI_HOOK, 30)).toBe(before);
	});

	it("removes only Jolli's command while preserving sibling commands and events", () => {
		const before =
			`hooks:\n  on_session_end:\n` +
			`    - command: "/user/session-end"\n      timeout: 10\n` +
			`    - command: ${JSON.stringify(JOLLI_HOOK)}\n      timeout: 30\n` +
			`  pre_tool_call:\n    - command: "/user/pre-tool"\n`;
		const after = writeHookCommandRemoval(before, "on_session_end", JOLLI_HOOK);
		expect(after).toContain('command: "/user/session-end"');
		expect(after).toContain('command: "/user/pre-tool"');
		expect(after).not.toContain("hermes-stop");
	});

	it("removes plain and single-quoted command scalars", () => {
		const plain = `hooks:\n  on_session_end:\n    - command: /jolli/run-hook hermes-stop\n      timeout: 30\n`;
		expect(writeHookCommandRemoval(plain, "on_session_end", "/jolli/run-hook hermes-stop")).toBe("hooks: {}\n");
		const quoted = `hooks:\n  on_session_end:\n    - command: '/jolli/run-hook hermes-stop'\n      timeout: 30\n`;
		expect(writeHookCommandRemoval(quoted, "on_session_end", "/jolli/run-hook hermes-stop")).toBe("hooks: {}\n");
	});

	it("collapses hooks to the empty idiom when Jolli is the last command", () => {
		const before = writeHookCommandUpsert("hooks: {}\n", "on_session_end", JOLLI_HOOK, 30);
		expect(writeHookCommandRemoval(before, "on_session_end", JOLLI_HOOK)).toBe("hooks: {}\n");
	});

	it("removal is a no-op for absent blocks, events and commands", () => {
		expect(writeHookCommandRemoval("model:\n  default: x\n", "on_session_end", JOLLI_HOOK)).toBe(
			"model:\n  default: x\n",
		);
		expect(writeHookCommandRemoval("hooks: {}\n", "on_session_end", JOLLI_HOOK)).toBe("hooks: {}\n");
		const otherEvent = `hooks:\n  pre_tool_call:\n    - command: /user/pre\n`;
		expect(writeHookCommandRemoval(otherEvent, "on_session_end", JOLLI_HOOK)).toBe(otherEvent);
		const otherCommand = `hooks:\n  on_session_end:\n    - command: /user/end\n`;
		expect(writeHookCommandRemoval(otherCommand, "on_session_end", JOLLI_HOOK)).toBe(otherCommand);
	});
});
