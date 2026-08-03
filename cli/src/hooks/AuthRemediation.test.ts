import { describe, expect, it } from "vitest";
import { LOCAL_AGENT_TOOLS } from "../core/localagent/ToolMeta.js";
import type { LocalAgentToolId } from "../Types.js";
import { buildAuthFailureCaptureText, buildAuthFailureReminderText } from "./AuthRemediation.js";

/**
 * Expected copy per tool. Deliberately hand-written rather than derived from
 * LOCAL_AGENT_TOOLS: deriving it would only restate the table back to itself and
 * would pass no matter what the table said. The completeness check below is what
 * keeps the hand-written list honest when a tool is added.
 */
const REMEDY_CASES = [
	["claude-code", "Claude Code", "claude"],
	["codex", "Codex", "codex login"],
	["cursor-agent", "Cursor", "cursor-agent login"],
	["opencode", "OpenCode", "opencode auth login"],
	["kimi", "Kimi Code", "kimi login"],
] as const;

/** Tools whose metadata claims a separate desktop app, and the app each names. */
const WITH_DESKTOP_APP = [
	["claude-code", "Claude Desktop", "the ChatGPT app"],
	["codex", "the ChatGPT app", "Claude Desktop"],
] as const;

const toolIds = Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[];

describe("local-agent authentication remediation", () => {
	// A new backend lands in LOCAL_AGENT_TOOLS without ever touching this file, and
	// nothing else here would fail — the tool would simply go untested, which is how
	// Kimi Code slipped through once. These two guards turn that into a red test
	// naming the omission.
	it("covers every registered local-agent tool", () => {
		expect([...REMEDY_CASES.map(([id]) => id)].sort()).toEqual([...toolIds].sort());
	});

	it("agrees with the metadata about which tools claim a separate desktop app", () => {
		const claimed = toolIds.filter((id) => LOCAL_AGENT_TOOLS[id].separateDesktopApp !== undefined);
		expect([...claimed].sort()).toEqual([...WITH_DESKTOP_APP.map(([id]) => id)].sort());
	});

	it.each(REMEDY_CASES)("renders the correct remedy for %s", (tool, label, hint) => {
		const reminder = buildAuthFailureReminderText(tool);
		const capture = buildAuthFailureCaptureText(tool);

		expect(reminder).toContain(label);
		expect(reminder).toContain(hint);
		expect(reminder).toContain("clears automatically");
		expect(capture).toContain(label);
		expect(capture).toContain(hint);
		expect(capture).not.toContain("clears automatically");
	});

	// The line that makes the message believable: the CLI token expires while the
	// desktop app stays signed in, so without it "authentication expired" reads as
	// false. It must name the tool's OWN app — pointing a Codex user at Claude
	// Desktop is the bug the host-aware rewrite exists to prevent.
	it.each(WITH_DESKTOP_APP)("names %s's own desktop app in the separate-login note", (tool, own, other) => {
		for (const text of [buildAuthFailureReminderText(tool), buildAuthFailureCaptureText(tool)]) {
			expect(text).toContain("SEPARATE");
			expect(text).toContain(own);
			expect(text).not.toContain(other);
		}
	});

	// Silence beats a wrong claim: OpenCode has no desktop app, and the Cursor and
	// Kimi Code IDE/CLI credential relationships are unverified, so none of them
	// asserts a separation. Derived from the metadata so a new tool is covered here
	// the moment it is registered without one.
	const withoutDesktopApp = toolIds.filter((id) => LOCAL_AGENT_TOOLS[id].separateDesktopApp === undefined);
	it.each(withoutDesktopApp)("omits the note for %s rather than inventing one", (tool) => {
		for (const text of [buildAuthFailureReminderText(tool), buildAuthFailureCaptureText(tool)]) {
			expect(text).not.toContain("SEPARATE");
			// Still actionable — the fix lines are what carry it.
			expect(text).toContain("Fix with either");
		}
	});
});
