import { describe, expect, it } from "vitest";
import { buildHookCommand } from "./HookSettingsHelper.js";

describe("buildHookCommand", () => {
	it("builds a run-hook line with the hook type and no prefer by default", () => {
		expect(buildHookCommand("post-commit")).toBe('"$HOME/.jolli/jollimemory/run-hook" post-commit');
	});

	it("appends args when provided", () => {
		expect(buildHookCommand("prepare-commit-msg", '"$1" "$2"')).toBe(
			'"$HOME/.jolli/jollimemory/run-hook" prepare-commit-msg "$1" "$2"',
		);
	});

	it("prepends a single-quoted JOLLI_DIST_PREFER_SOURCE for a valid source", () => {
		expect(buildHookCommand("post-commit", "", "claude-plugin")).toBe(
			`JOLLI_DIST_PREFER_SOURCE='claude-plugin' "$HOME/.jolli/jollimemory/run-hook" post-commit`,
		);
	});

	it("throws rather than emit an unsafe hook line for a malformed source", () => {
		expect(() => buildHookCommand("post-commit", "", "bad tag")).toThrow(/unsafe source tag/);
		expect(() => buildHookCommand("post-commit", "", "a'; rm -rf /")).toThrow(/unsafe source tag/);
		expect(() => buildHookCommand("post-commit", "", "../x")).toThrow(/unsafe source tag/);
	});
});
