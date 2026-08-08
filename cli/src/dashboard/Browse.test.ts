import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// existsSync is wrapped (not replaced) so every other test in this file keeps
// its real filesystem behavior — only the defaultBrowsePath tests below ever
// override the return value, and only for their own call.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import { existsSync } from "node:fs";
import { BrowseError, browseDirectory, defaultBrowsePath } from "./Browse.js";

describe("browseDirectory", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-browse-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("rejects a relative path", async () => {
		await expect(browseDirectory("relative/path")).rejects.toThrow(BrowseError);
	});

	it("rejects a path that does not exist", async () => {
		await expect(browseDirectory(join(dir, "does-not-exist"))).rejects.toThrow(BrowseError);
	});

	it("rejects a path that is a file, not a directory", async () => {
		const { writeFileSync } = await import("node:fs");
		const filePath = join(dir, "file.txt");
		writeFileSync(filePath, "x");
		await expect(browseDirectory(filePath)).rejects.toThrow(BrowseError);
	});

	it("rejects the forbidden /proc and /sys roots", async () => {
		await expect(browseDirectory("/proc")).rejects.toThrow(BrowseError);
		await expect(browseDirectory("/sys")).rejects.toThrow(BrowseError);
	});

	it("lists only directories, sorted, and marks which ones are git repos", async () => {
		mkdirSync(join(dir, "b-plain"));
		mkdirSync(join(dir, "a-repo", ".git"), { recursive: true });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(dir, "z-a-file.txt"), "x");

		const result = await browseDirectory(dir);
		expect(result.entries).toEqual([
			{ name: "a-repo", isGitRepo: true },
			{ name: "b-plain", isGitRepo: false },
		]);
		expect(result.truncated).toBe(false);
	});

	it("resolves a symlinked path to its real path", async () => {
		const { symlinkSync } = await import("node:fs");
		const target = join(dir, "real");
		mkdirSync(target);
		const link = join(dir, "link");
		symlinkSync(target, link);
		const result = await browseDirectory(link);
		expect(result.path).toBe(target);
	});

	it("reports the parent directory, and null at the filesystem root", async () => {
		const sub = join(dir, "sub");
		mkdirSync(sub);
		const result = await browseDirectory(sub);
		expect(result.parent).toBe(dir);

		const rootResult = await browseDirectory("/");
		expect(rootResult.parent).toBeNull();
	});

	it("truncates past BROWSE_ENTRY_LIMIT and reports it", async () => {
		for (let i = 0; i < 510; i++) mkdirSync(join(dir, `d${i}`));
		const result = await browseDirectory(dir);
		expect(result.truncated).toBe(true);
		expect(result.entries.length).toBe(500);
	});
});

describe("defaultBrowsePath", () => {
	afterEach(() => {
		vi.mocked(existsSync).mockClear();
	});

	it("returns a non-empty absolute path", () => {
		expect(defaultBrowsePath().length).toBeGreaterThan(0);
	});

	it("prefers ~/code when it exists", () => {
		vi.mocked(existsSync).mockReturnValueOnce(true);
		expect(defaultBrowsePath()).toBe(join(homedir(), "code"));
	});

	it("falls back to the home directory when ~/code does not exist", () => {
		vi.mocked(existsSync).mockReturnValueOnce(false);
		expect(defaultBrowsePath()).toBe(homedir());
	});
});
