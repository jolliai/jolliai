import { describe, expect, it } from "vitest";
import { matchCliCommand } from "./index.js";

describe("matchCliCommand", () => {
	it("resolves a gh issue view --json command to the github CLI binding", () => {
		const binding = matchCliCommand("gh issue view 959 --repo o/r --json number,title");
		expect(binding?.id).toBe("github");
		expect(binding?.canonicalToolName).toBe("mcp__github__issue_read");
	});

	it("returns null for a non-matching command", () => {
		expect(matchCliCommand("gh pr view 1 --json")).toBeNull();
		expect(matchCliCommand("npm test")).toBeNull();
	});

	it("returns null for an empty command", () => {
		expect(matchCliCommand("")).toBeNull();
	});
});
