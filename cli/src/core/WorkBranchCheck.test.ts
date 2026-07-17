import { describe, expect, it } from "vitest";
import { checkPublishBranch } from "./WorkBranchCheck.js";

describe("checkPublishBranch", () => {
	it("matches identical branches", () => {
		expect(checkPublishBranch("jolli-agent-8226c9abc576", "jolli-agent-8226c9abc576")).toEqual({
			match: true,
			expected: "jolli-agent-8226c9abc576",
			actual: "jolli-agent-8226c9abc576",
		});
	});

	it("does NOT match when space-cli published on its own generated branch (the silent-failure case)", () => {
		expect(checkPublishBranch("jolli-agent-8226c9abc576", "jolli-6e3a72e55c22")).toEqual({
			match: false,
			expected: "jolli-agent-8226c9abc576",
			actual: "jolli-6e3a72e55c22",
		});
	});

	it("treats a missing/empty headBranch as an unverifiable non-match", () => {
		expect(checkPublishBranch("jolli-agent-8226c9abc576", "")).toEqual({
			match: false,
			expected: "jolli-agent-8226c9abc576",
			actual: "",
		});
	});

	it("treats an empty expected work branch as a non-match", () => {
		expect(checkPublishBranch("", "jolli-agent-8226c9abc576")).toEqual({
			match: false,
			expected: "",
			actual: "jolli-agent-8226c9abc576",
		});
	});

	it("trims surrounding whitespace before comparing", () => {
		expect(checkPublishBranch("  jolli-agent-abc  ", "jolli-agent-abc\n")).toEqual({
			match: true,
			expected: "jolli-agent-abc",
			actual: "jolli-agent-abc",
		});
	});

	it("does not match two blank inputs", () => {
		expect(checkPublishBranch("   ", "")).toEqual({ match: false, expected: "", actual: "" });
	});
});
