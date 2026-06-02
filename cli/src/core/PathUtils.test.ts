import { describe, expect, it } from "vitest";
import { withPlatform } from "../testUtils/withPlatform.js";
import { isPathInside, normalizePathForCompare, toForwardSlash } from "./PathUtils.js";

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

// Platform-agnostic tests for toForwardSlash. The FolderStorage and
// SummaryStore integration tests that exercise this helper through walkDir
// are no-ops on Linux CI (node:path emits forward slashes there natively),
// so the regression net for the 2026-05-26 Windows path bug needs at least
// one host-OS-independent assertion. These tests are it.
describe("toForwardSlash", () => {
	it("returns an empty string unchanged", () => {
		expect(toForwardSlash("")).toBe("");
	});

	it("returns a forward-slash path unchanged (idempotent on POSIX form)", () => {
		expect(toForwardSlash("transcripts/abc.json")).toBe("transcripts/abc.json");
		expect(toForwardSlash("a/b/c/d.txt")).toBe("a/b/c/d.txt");
	});

	it("converts a Windows-style backslash path to forward slashes", () => {
		expect(toForwardSlash("transcripts\\abc.json")).toBe("transcripts/abc.json");
		expect(toForwardSlash("a\\b\\c\\d.txt")).toBe("a/b/c/d.txt");
	});

	it("converts mixed separators to forward slashes", () => {
		expect(toForwardSlash("a\\b/c\\d")).toBe("a/b/c/d");
	});

	it("does not strip trailing or leading separators (unlike normalizePathForCompare)", () => {
		expect(toForwardSlash("\\a\\b\\")).toBe("/a/b/");
		expect(toForwardSlash("/a/b/")).toBe("/a/b/");
	});

	it("does not change case (unlike normalizePathForCompare)", () => {
		expect(toForwardSlash("C:\\Users\\Sanshi\\AppData")).toBe("C:/Users/Sanshi/AppData");
	});

	it("handles a single backslash", () => {
		expect(toForwardSlash("\\")).toBe("/");
	});

	it("handles a path with no separators", () => {
		expect(toForwardSlash("file.txt")).toBe("file.txt");
	});
});

describe("isPathInside", () => {
	it("returns true when child equals parent", () => {
		withPlatform("linux", () => {
			expect(isPathInside("/repo/.jolli/jollimemory", "/repo/.jolli/jollimemory")).toBe(true);
		});
	});

	it("returns true for a nested child", () => {
		withPlatform("linux", () => {
			expect(isPathInside("/repo/.jolli/jollimemory/notes/x.md", "/repo/.jolli/jollimemory")).toBe(true);
		});
	});

	it("returns false at a directory-name boundary (jollimemoryX is NOT inside jollimemory)", () => {
		withPlatform("linux", () => {
			expect(isPathInside("/repo/.jolli/jollimemoryX/y.md", "/repo/.jolli/jollimemory")).toBe(false);
		});
	});

	it("returns false for an external path", () => {
		withPlatform("linux", () => {
			expect(isPathInside("/home/user/.claude/plans/p.md", "/repo/.jolli/jollimemory")).toBe(false);
		});
	});

	it("returns false when the candidate parent is actually deeper than the child", () => {
		withPlatform("linux", () => {
			expect(isPathInside("/repo/.jolli", "/repo/.jolli/jollimemory")).toBe(false);
		});
	});

	it("folds case and separators on Windows", () => {
		withPlatform("win32", () => {
			expect(isPathInside("C:\\Repo\\.jolli\\jollimemory\\Notes\\x.md", "c:/repo/.jolli/jollimemory")).toBe(true);
		});
	});

	it("is case-sensitive on Linux (different case is not inside)", () => {
		withPlatform("linux", () => {
			expect(isPathInside("/Repo/.jolli/jollimemory/x.md", "/repo/.jolli/jollimemory")).toBe(false);
		});
	});
});
