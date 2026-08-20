import { afterEach, describe, expect, it } from "vitest";
import { currentAgentSessionId, isSafeSessionId } from "./AgentSessionEnv.js";

const KEY = "CLAUDE_CODE_SESSION_ID";
const original = process.env[KEY];

afterEach(() => {
	if (original === undefined) delete process.env[KEY];
	else process.env[KEY] = original;
});

describe("currentAgentSessionId", () => {
	it("returns the Claude Code session id when the environment advertises one", () => {
		process.env[KEY] = "4ad551f5-35b5-4331-b807-987843d81113";
		expect(currentAgentSessionId()).toBe("4ad551f5-35b5-4331-b807-987843d81113");
	});

	it("trims surrounding whitespace", () => {
		process.env[KEY] = "  sid-123  ";
		expect(currentAgentSessionId()).toBe("sid-123");
	});

	it("is undefined when the variable is unset (plain terminal, or a host that advertises nothing)", () => {
		delete process.env[KEY];
		expect(currentAgentSessionId()).toBeUndefined();
	});

	it("is undefined for a blank value rather than returning an empty id", () => {
		process.env[KEY] = "   ";
		expect(currentAgentSessionId()).toBeUndefined();
	});

	it("treats a traversal / separator-bearing value as absent rather than carrying it forward", () => {
		// A hostile or malformed value must never become a path segment downstream.
		for (const hostile of ["../../etc/passwd", "a/b", "a\\b", "..", "."]) {
			process.env[KEY] = hostile;
			expect(currentAgentSessionId()).toBeUndefined();
		}
	});
});

describe("isSafeSessionId", () => {
	it("accepts plain producer id tokens (uuid, hyphens, dots, underscores)", () => {
		expect(isSafeSessionId("4ad551f5-35b5-4331-b807-987843d81113")).toBe(true);
		expect(isSafeSessionId("sid_123.v2")).toBe(true);
	});

	it("rejects anything that could escape a directory or is not a plain segment", () => {
		for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "/abs", "with space", "x y"]) {
			expect(isSafeSessionId(bad)).toBe(false);
		}
	});
});
