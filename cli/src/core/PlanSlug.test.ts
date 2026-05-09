import { describe, expect, it } from "vitest";
import { extractBaseSlug } from "./PlanSlug.js";

describe("extractBaseSlug", () => {
	it("strips an 8-char host hash suffix", () => {
		expect(extractBaseSlug("auth-redesign-06d0f729", "06d0f72912345abcdef")).toBe("auth-redesign");
	});

	it("strips a 7-char host hash suffix when no 8-char match", () => {
		expect(extractBaseSlug("auth-redesign-06d0f72", "06d0f72912345abcdef")).toBe("auth-redesign");
	});

	it("returns slug unchanged when no archive suffix matches", () => {
		expect(extractBaseSlug("auth-redesign", "06d0f72912345abcdef")).toBe("auth-redesign");
	});

	it("returns slug unchanged when trailing token doesn't match the host hash", () => {
		// Slug ends with 8 hex chars but they aren't the prefix of `commitHash`.
		// extractBaseSlug must NOT strip — that would corrupt a slug that
		// legitimately includes hex chars in its name.
		expect(extractBaseSlug("auth-redesign-deadbeef", "06d0f72912345abcdef")).toBe("auth-redesign-deadbeef");
	});

	it("prefers 8-char strip when both 7- and 8-char prefixes match", () => {
		// commit "06d0f729..." — slug ends in -06d0f729 (8 chars). The 8-char branch
		// fires first; the 7-char branch is a fallback. Verify the slice length is
		// the 8-char one (not 7).
		expect(extractBaseSlug("topic-06d0f729", "06d0f72912345abcdef")).toBe("topic");
	});
});
