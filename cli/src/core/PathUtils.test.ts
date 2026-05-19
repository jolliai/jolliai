import { describe, expect, it } from "vitest";
import { withPlatform } from "../testUtils/withPlatform.js";
import { normalizePathForCompare } from "./PathUtils.js";

describe("normalizePathForCompare", () => {
	it("unifies backslashes to forward slashes regardless of platform", () => {
		withPlatform("linux", () => {
			expect(normalizePathForCompare("C:\\Users\\foo\\bar.md")).toBe("C:/Users/foo/bar.md");
		});
	});

	it("strips trailing slashes", () => {
		withPlatform("linux", () => {
			expect(normalizePathForCompare("/repo/docs/")).toBe("/repo/docs");
			expect(normalizePathForCompare("/repo/docs///")).toBe("/repo/docs");
		});
	});

	it("lowercases on Windows", () => {
		withPlatform("win32", () => {
			expect(normalizePathForCompare("C:\\Users\\Foo\\Bar.md")).toBe("c:/users/foo/bar.md");
			// Case-only diff collapses to the same string
			expect(normalizePathForCompare("c:\\users\\foo\\bar.md")).toBe(
				normalizePathForCompare("C:\\Users\\Foo\\Bar.md"),
			);
		});
	});

	it("lowercases on macOS (Darwin/APFS default is case-insensitive)", () => {
		withPlatform("darwin", () => {
			expect(normalizePathForCompare("/Users/Flyer/Docs/Plan.md")).toBe("/users/flyer/docs/plan.md");
			// Same file via case-different path normalizes identically
			expect(normalizePathForCompare("/users/flyer/docs/plan.md")).toBe(
				normalizePathForCompare("/Users/Flyer/Docs/Plan.md"),
			);
		});
	});

	it("preserves case on Linux (case-sensitive filesystem)", () => {
		withPlatform("linux", () => {
			expect(normalizePathForCompare("/repo/Docs/Plan.md")).toBe("/repo/Docs/Plan.md");
			expect(normalizePathForCompare("/repo/Docs/Plan.md")).not.toBe(
				normalizePathForCompare("/repo/docs/plan.md"),
			);
		});
	});

	it("treats mixed separators on Windows as the same path", () => {
		withPlatform("win32", () => {
			expect(normalizePathForCompare("C:/Users/foo/bar.md")).toBe(
				normalizePathForCompare("C:\\Users\\foo\\bar.md"),
			);
		});
	});

	it("handles empty input and root-only paths defensively", () => {
		withPlatform("linux", () => {
			expect(normalizePathForCompare("")).toBe("");
			// Single root slash gets stripped — fine because all production callers pass absolute file paths
			expect(normalizePathForCompare("/")).toBe("");
		});
	});
});
