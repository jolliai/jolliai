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

	it("is always source-neutral", () => {
		expect(buildHookCommand("post-commit")).not.toContain("JOLLI_DIST_PREFER_SOURCE");
	});
});
