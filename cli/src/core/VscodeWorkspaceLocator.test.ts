import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VscodeFlavor } from "./VscodeWorkspaceLocator.js";

/**
 * Converts a POSIX-style absolute path to a file:// URI valid on the current
 * host. On Windows, `fileURLToPath` rejects URIs without a drive letter, so we
 * go through `pathToFileURL(resolve(...))` to get a proper drive-prefixed URI.
 */
function toFileUri(posixPath: string): string {
	return pathToFileURL(resolve(posixPath)).href;
}

/**
 * Returns the native absolute path for a POSIX-style absolute path. On Windows
 * `/Users/test/myproject` becomes e.g. `D:\Users\test\myproject`.
 */
function toNativePath(posixPath: string): string {
	return resolve(posixPath);
}

const { mockHomedir, mockPlatform } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue("/Users/test"),
	mockPlatform: vi.fn().mockReturnValue("darwin"),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir, platform: mockPlatform };
});

describe("getVscodeUserDataDir", () => {
	it("returns ~/Library/Application Support/Code on darwin", async () => {
		mockPlatform.mockReturnValue("darwin");
		const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeUserDataDir("Code")).toBe(join("/Users/test", "Library", "Application Support", "Code"));
	});

	it("returns ~/Library/Application Support/Cursor on darwin for Cursor flavor", async () => {
		mockPlatform.mockReturnValue("darwin");
		const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeUserDataDir("Cursor")).toBe(join("/Users/test", "Library", "Application Support", "Cursor"));
	});

	it("returns %APPDATA%/Code on win32", async () => {
		mockPlatform.mockReturnValue("win32");
		mockHomedir.mockReturnValue("C:\\Users\\test");
		const prev = process.env.APPDATA;
		process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
		try {
			const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
			expect(getVscodeUserDataDir("Code")).toBe(join("C:\\Users\\test\\AppData\\Roaming", "Code"));
		} finally {
			if (prev === undefined) delete process.env.APPDATA;
			else process.env.APPDATA = prev;
		}
	});

	it("falls back to ~/AppData/Roaming/Code on win32 when APPDATA is unset", async () => {
		mockPlatform.mockReturnValue("win32");
		mockHomedir.mockReturnValue("C:\\Users\\test");
		const prev = process.env.APPDATA;
		delete process.env.APPDATA;
		try {
			const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
			expect(getVscodeUserDataDir("Code")).toBe(join("C:\\Users\\test", "AppData", "Roaming", "Code"));
		} finally {
			if (prev !== undefined) process.env.APPDATA = prev;
		}
	});

	it("returns ~/.config/Code on linux and other unix-like platforms", async () => {
		mockPlatform.mockReturnValue("linux");
		mockHomedir.mockReturnValue("/Users/test");
		const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeUserDataDir("Code")).toBe(join("/Users/test", ".config", "Code"));
	});

	it("respects an explicit home override", async () => {
		mockPlatform.mockReturnValue("darwin");
		const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeUserDataDir("Code", "/custom/home")).toBe(
			join("/custom/home", "Library", "Application Support", "Code"),
		);
	});
});

describe("getVscodeWorkspaceStorageDir", () => {
	it("appends User/workspaceStorage to the user data dir", async () => {
		mockPlatform.mockReturnValue("darwin");
		mockHomedir.mockReturnValue("/Users/test");
		const { getVscodeWorkspaceStorageDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeWorkspaceStorageDir("Code")).toBe(
			join("/Users/test", "Library", "Application Support", "Code", "User", "workspaceStorage"),
		);
	});
});

describe("normalizePathForMatch", () => {
	it("strips trailing slashes", async () => {
		mockPlatform.mockReturnValue("linux");
		const { normalizePathForMatch } = await import("./VscodeWorkspaceLocator.js");
		expect(normalizePathForMatch("/a/b/c/")).toBe("/a/b/c");
		expect(normalizePathForMatch("/a/b/c////")).toBe("/a/b/c");
		expect(normalizePathForMatch("/a/b/c")).toBe("/a/b/c");
	});

	it("lowercases on darwin", async () => {
		mockPlatform.mockReturnValue("darwin");
		const { normalizePathForMatch } = await import("./VscodeWorkspaceLocator.js");
		expect(normalizePathForMatch("/Users/Foo/Bar")).toBe("/users/foo/bar");
	});

	it("lowercases on win32 (and converts backslashes to forward slashes)", async () => {
		mockPlatform.mockReturnValue("win32");
		const { normalizePathForMatch } = await import("./VscodeWorkspaceLocator.js");
		expect(normalizePathForMatch("C:\\Users\\Test")).toBe("c:/users/test");
	});

	it("preserves case on linux", async () => {
		mockPlatform.mockReturnValue("linux");
		const { normalizePathForMatch } = await import("./VscodeWorkspaceLocator.js");
		expect(normalizePathForMatch("/Users/Foo")).toBe("/Users/Foo");
	});

	// Regression guard: fileURLToPath returns `\`-separated paths on Windows and
	// callers may pass `/`-style paths; without this conversion the two would
	// silently fail to match. Lost in the refactor from CursorSessionDiscoverer
	// (a288e94) into VscodeWorkspaceLocator and restored.
	it("converts backslashes to forward slashes before comparison", async () => {
		mockPlatform.mockReturnValue("win32");
		const { normalizePathForMatch } = await import("./VscodeWorkspaceLocator.js");
		expect(normalizePathForMatch("C:\\Users\\Test\\Proj")).toBe("c:/users/test/proj");
		expect(normalizePathForMatch("\\Users\\Test\\Proj")).toBe("/users/test/proj");
	});
});

describe("findVscodeWorkspaceHash", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "vscode-locator-"));
		mockPlatform.mockReturnValue("darwin");
		mockHomedir.mockReturnValue(tmpRoot);
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function makeWorkspaceEntry(flavor: VscodeFlavor, wsHash: string, content: object | null): void {
		const dir = join(tmpRoot, "Library", "Application Support", flavor, "User", "workspaceStorage", wsHash);
		mkdirSync(dir, { recursive: true });
		if (content !== null) {
			writeFileSync(join(dir, "workspace.json"), JSON.stringify(content));
		}
	}

	it("returns the hash for a single-folder workspace whose folder URI matches projectDir", async () => {
		makeWorkspaceEntry("Code", "abc123", { folder: toFileUri("/Users/test/myproject") });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", toNativePath("/Users/test/myproject"))).toBe("abc123");
	});

	it("matches case-insensitively on darwin", async () => {
		makeWorkspaceEntry("Code", "abc123", { folder: toFileUri("/Users/Test/MyProject") });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", toNativePath("/users/test/myproject"))).toBe("abc123");
	});

	it("returns null when no workspace.json folder URI matches projectDir", async () => {
		makeWorkspaceEntry("Code", "abc123", { folder: toFileUri("/Users/test/other") });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", toNativePath("/Users/test/myproject"))).toBeNull();
	});

	it("skips entries whose workspace.json has a multi-root `workspace` URI instead of a `folder` URI", async () => {
		makeWorkspaceEntry("Code", "multi", { workspace: toFileUri("/Users/test/x.code-workspace") });
		makeWorkspaceEntry("Code", "single", { folder: toFileUri("/Users/test/myproject") });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", toNativePath("/Users/test/myproject"))).toBe("single");
	});

	it("skips entries with no workspace.json", async () => {
		makeWorkspaceEntry("Code", "empty", null);
		makeWorkspaceEntry("Code", "single", { folder: toFileUri("/Users/test/myproject") });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", toNativePath("/Users/test/myproject"))).toBe("single");
	});

	it("skips entries whose folder URI is unparseable", async () => {
		makeWorkspaceEntry("Code", "bad", { folder: "garbage:///not-a-uri" });
		makeWorkspaceEntry("Code", "good", { folder: toFileUri("/Users/test/myproject") });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", toNativePath("/Users/test/myproject"))).toBe("good");
	});

	it("skips entries whose folder URI starts with file:// but fails fileURLToPath parsing", async () => {
		// `file://%` is rejected by `new URL()` (invalid percent-encoding) and bubbles up
		// from `fileURLToPath`, exercising the catch branch of `findVscodeWorkspaceHash`.
		// Only the throwing entry is created so the loop must process it (readdir order is
		// filesystem-dependent — adding a "good" entry could short-circuit before the throw).
		makeWorkspaceEntry("Code", "throws", { folder: "file://%" });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", toNativePath("/Users/test/myproject"))).toBeNull();
	});

	it("returns null when workspaceStorage dir doesn't exist", async () => {
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", toNativePath("/Users/test/myproject"))).toBeNull();
	});

	it("isolates flavors — a Cursor entry doesn't match a Code lookup", async () => {
		makeWorkspaceEntry("Cursor", "cursor1", { folder: toFileUri("/Users/test/myproject") });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", toNativePath("/Users/test/myproject"))).toBeNull();
		expect(await findVscodeWorkspaceHash("Cursor", toNativePath("/Users/test/myproject"))).toBe("cursor1");
	});
});
