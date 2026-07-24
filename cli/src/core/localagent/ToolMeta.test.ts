import { describe, expect, it } from "vitest";
import type { LocalAgentToolId } from "../../Types.js";
import { LOCAL_AGENT_TOOLS, localAgentToolLabel, localAgentToolLoginHint } from "./ToolMeta.js";

describe("ToolMeta", () => {
	it("labels every tool with the footer display name", () => {
		expect(localAgentToolLabel("claude-code")).toBe("Claude Code");
		expect(localAgentToolLabel("codex")).toBe("Codex");
		expect(localAgentToolLabel("cursor-agent")).toBe("Cursor");
		expect(localAgentToolLabel("opencode")).toBe("OpenCode");
	});

	it("carries a login hint for every tool", () => {
		for (const id of Object.keys(LOCAL_AGENT_TOOLS) as (keyof typeof LOCAL_AGENT_TOOLS)[]) {
			expect(LOCAL_AGENT_TOOLS[id].loginHint.length).toBeGreaterThan(0);
		}
	});

	// An out-of-enum id reaches these helpers when config.json / persisted
	// summary metadata was written by a newer build (or hand-edited): they must
	// degrade to a generic label / hint, never throw a TypeError that would
	// hard-crash `jolli status` / `jolli doctor` / footer rendering.
	it("degrades gracefully on an unknown tool id instead of throwing", () => {
		const unknown = "future-tool" as LocalAgentToolId;
		expect(localAgentToolLabel(unknown)).toBe("Local agent");
		expect(localAgentToolLoginHint(unknown)).toBe("Sign in to your local agent CLI.");
	});
});
